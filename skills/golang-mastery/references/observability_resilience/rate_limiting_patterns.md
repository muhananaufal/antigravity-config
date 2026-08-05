# Rate Limiting Patterns untuk API Protection

> **Berlaku:** Go 1.21+ · `golang.org/x/time/rate` · Redis 7+ · **Lihat juga:** `distributed_patterns_resilience/rate_limiting_strategies.md` · `observability_resilience/circuit_breaker_hystrix.md` · `distributed_patterns_resilience/bulkhead_isolation.md` · `caching_strategy/redis_advanced_patterns.md`

Rate limiting melindungi API dari abuse, brute force, dan thundering herd. Pilihan algoritma tergantung pada apakah sistem single-instance atau distributed.

---

## 1. Arsitektur Internal: Token Bucket vs Sliding Window

```
Token Bucket (golang.org/x/time/rate):

  tokens: [●●●●●]  capacity=5, refill=1/sec

  t=0.0s: 3 requests datang → tokens=[●●], allowed=3
  t=0.5s: 1 request → tokens=[●], allowed=1 (refill 0.5 token belum cukup)
  t=1.0s: refill → tokens=[●●], 2 requests → tokens=[], allowed=2
  t=1.5s: 1 request → tokens=[], REJECTED → HTTP 429

Implementasi golang.org/x/time/rate:
  rate.NewLimiter(rate.Limit(10), 50)
    │               │              │
    │               │              └── burst: max tokens saat penuh
    │               └─────────────── 10 tokens/second (refill rate)
    └─────────────────────────────── Limiter instance (per-client)

Distributed (Redis Sliding Window):

  Client ──► Go Service ──► Redis EVAL Lua Script
                              │
                              ├── ZREMRANGEBYSCORE (hapus entry lama)
                              ├── ZADD (tambah timestamp sekarang)
                              ├── ZCARD (hitung entry dalam window)
                              └── EXPIRE (cleanup key)

  Keuntungan: state terpusat → konsisten di semua pod
  Kelemahan: +1 Redis round-trip per request (~0.5ms latency)
```

## Concept/Internals
Sistem yang melayani permintaan ke publik, terutama API berharga tinggi seperti *fintech*, rawan terhadap serangan *Brute Force*, *DDoS*, atau eksploitasi API tanpa sengaja (*infinite loop bot* klien). **Rate Limiting** membatasi seberapa banyak permintaan yang boleh dieksekusi suatu subjek (User ID, API Key, atau IP Address) dalam kurun waktu tertentu.

Empat Algoritma Utama:
1. **Token Bucket**: Bayangkan seember token. Klien mengambil token tiap request. Ember diisi token baru dengan kecepatan konstan (rate). Mendukung lonjakan (burst) tiba-tiba asalkan ember penuh. *Standar industri (didukung `golang.org/x/time/rate`).*
2. **Leaky Bucket**: Request antre, diproses secara konstan seperti tetesan keran. Meratakan arus *traffic*.
3. **Fixed Window**: Menghitung jumlah per blok waktu statis (misal 01:00-01:01). Kelemahan: Lonjakan 2x lipat bisa lolos di persimpangan menit (contoh detik 59 dan 01).
4. **Sliding Window Log/Counter**: Pendekatan mulus namun rakus memori/komputasi di Redis, mendiskon persentase menit sebelumnya.

### Diagram ASCII: Token Bucket Flow

```ascii
[ Capacity: 5 Tokens ] 
[ Refill Rate: 1/sec ]

  T=0s : [ O O O O O ] (5 tokens)  <-- Burst 3 Requests datang
  T=1s : [ O O O ]     (2 tokens) + 1 token refill -> [ O O O ]
  
  ( Jika ember kosong, Request ditolak dengan HTTP 429 Too Many Requests )
  
  [ Client Request ] --> ( Meminta 1 Token )
                             |
                   +---------v---------+
                   | Token Available?  | --> (No)  --> HTTP 429 Retry-After: 5s
                   +---------+---------+
                             | (Yes)
                             v
                   [ Lanjutkan HTTP Handler ]
```

## Production Code

Implementasi Token Bucket per-IP menggunakan library resmi `golang.org/x/time/rate` dan proteksi konkurensi (Mutex). 
*(Catatan: Untuk sistem tersebar (distributed), `rate.Limiter` harus diganti dengan Redis Lua Script, tetapi logika konsepnya ekuivalen).*

```go
package ratelimit

import (
	"context"
	"fmt"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"golang.org/x/time/rate"
)

// klienLimit menyimpan state token bucket untuk satu identitas.
type clientLimit struct {
	limiter *rate.Limiter
	// terlihat disimpan atomik supaya jalur panas cukup memegang kunci BACA.
	// Dengan sync.Mutex biasa, setiap permintaan — termasuk yang identitasnya
	// sudah dikenal — mengambil kunci TULIS hanya untuk memperbarui stempel
	// waktu. Itulah sumber contention di Anti-Pattern 2.
	terlihat atomic.Int64 // UnixNano
}

type Konfig struct {
	Rate  rate.Limit // token per detik
	Burst int        // maksimum token saat ember penuh
	// ProksiTepercaya = jumlah proxy MILIK ANDA di depan layanan ini.
	// 0 berarti X-Forwarded-For diabaikan sepenuhnya. Lihat identitas().
	ProksiTepercaya int
	Reg             prometheus.Registerer
}

type IPRateLimiter struct {
	mu    sync.RWMutex
	klien map[string]*clientLimit
	k     Konfig

	allowed prometheus.Counter
	ditolak   prometheus.Counter
}

func NewIPRateLimiter(ctx context.Context, k Konfig) *IPRateLimiter {
	i := &IPRateLimiter{
		klien: make(map[string]*clientLimit),
		k:     k,
		allowed: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "rate_limit_allowed_total", Help: "Permintaan yang lolos rate limiter."}),
		ditolak: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "rate_limit_rejected_total", Help: "Permintaan yang ditolak rate limiter."}),
	}
	k.Reg.MustRegister(i.allowed, i.ditolak)

	// Sweeper terikat ctx. Bentuk `go i.cleanup()` dengan `for { time.Sleep() }`
	// di dalamnya adalah kebocoran goroutine permanen: tidak ada cara
	// menghentikannya, dan setiap pemanggilan konstruktor menambah satu lagi
	// yang hidup sampai proses mati.
	go i.sapuBasi(ctx, time.Minute, 3*time.Minute)

	return i
}

func (i *IPRateLimiter) limiter(kunci string) *rate.Limiter {
	sekarang := time.Now().UnixNano()

	i.mu.RLock()
	v, ada := i.klien[kunci]
	i.mu.RUnlock()
	if ada {
		v.terlihat.Store(sekarang)
		return v.limiter
	}

	i.mu.Lock()
	defer i.mu.Unlock()
	if v, ada := i.klien[kunci]; ada { // diperiksa ulang: goroutine lain bisa mendahului
		v.terlihat.Store(sekarang)
		return v.limiter
	}
	baru := &clientLimit{limiter: rate.NewLimiter(i.k.Rate, i.k.Burst)}
	baru.terlihat.Store(sekarang)
	i.klien[kunci] = baru
	return baru.limiter
}

func (i *IPRateLimiter) sapuBasi(ctx context.Context, tiap, maxAge time.Duration) {
	t := time.NewTicker(tiap)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			limit := time.Now().Add(-maxAge).UnixNano()
			i.mu.Lock()
			for k, v := range i.klien {
				if v.terlihat.Load() < limit {
					delete(i.klien, k)
				}
			}
			i.mu.Unlock()
		}
	}
}

// identitas menentukan kunci rate limit dari sebuah permintaan.
//
// Inilah bagian yang paling sering salah, dan kedua kesalahannya membatalkan
// seluruh rate limiter TANPA satu pun gejala:
//
//   - `r.RemoteAddr` MEMUAT PORT ("203.0.113.7:54321"). Memakainya apa adanya
//     memberi setiap koneksi baru dari IP yang sama sebuah bucket BARU —
//     limiter tidak membatasi apa pun, dan peta klien tumbuh tanpa batas. Uji
//     tidak akan pernah menangkapnya, karena uji memakai RemoteAddr tetap
//     sementara di produksi port efemeral berganti tiap koneksi.
//   - `X-Forwarded-For` ditulis KLIEN. Membacanya utuh berarti penyerang cukup
//     mengganti isinya tiap permintaan untuk mendapat bucket baru tiap kali —
//     sekaligus menumbuhkan peta klien sesuka hati. Anti-Pattern 3 berubah
//     dari kelalaian menjadi senjata.
//
// Yang boleh dipercaya hanya entri yang DITAMBAHKAN proxy milik Anda sendiri,
// dihitung dari KANAN sebanyak ProksiTepercaya.
func (i *IPRateLimiter) identity(r *http.Request) (string, error) {
	ipSambungan, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ipSambungan = r.RemoteAddr
	}
	direct := func() (string, error) {
		if net.ParseIP(ipSambungan) == nil {
			return "", fmt.Errorf("RemoteAddr bukan alamat IP: %q", r.RemoteAddr)
		}
		return ipSambungan, nil
	}

	if i.k.ProksiTepercaya == 0 {
		return direct()
	}

	var bagian []string
	for _, row := range r.Header.Values("X-Forwarded-For") {
		for _, p := range strings.Split(row, ",") {
			if p = strings.TrimSpace(p); p != "" {
				bagian = append(bagian, p)
			}
		}
	}
	idx := len(bagian) - i.k.ProksiTepercaya
	if idx < 0 {
		// Rantai lebih pendek dari yang seharusnya: proxy tidak menambahkan
		// entri, atau permintaan tidak benar-benar melewatinya. Jangan menebak.
		return direct()
	}
	ip := net.ParseIP(bagian[idx])
	if ip == nil {
		return "", fmt.Errorf("invalid X-Forwarded-For entry: %q", bagian[idx])
	}
	return ip.String(), nil
}

func (i *IPRateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		kunci, err := i.identity(r)
		if err != nil {
			// Identitas tidak dapat ditentukan berarti pembatasan tidak dapat
			// ditegakkan. Menolak lebih aman daripada memberi jalur bebas-limit.
			http.Error(w, "client identity cannot be determined", http.StatusBadRequest)
			return
		}

		lim := i.limiter(kunci)

		// ReserveN, bukan Allow. Allow hanya menjawab ya/tidak; Reserve juga
		// memberi tahu BERAPA LAMA lagi token berikutnya tersedia — dan itulah
		// isi Retry-After yang sesungguhnya. Angka tetap seperti "10" salah di
		// dua arah sekaligus: klien menunggu sia-sia saat token sebenarnya
		// tersedia dalam 0,5 detik, dan mengulang terlalu cepat saat token baru
		// datang 60 detik lagi — persis gejala "429 melonjak setelah 429".
		res := lim.ReserveN(time.Now(), 1)
		if !res.OK() {
			// Burst lebih kecil dari yang diminta: tidak akan pernah terpenuhi.
			i.ditolak.Inc()
			w.Header().Set("Retry-After", "60")
			http.Error(w, "429 Too Many Requests", http.StatusTooManyRequests)
			return
		}
		if tunggu := res.Delay(); tunggu > 0 {
			res.Cancel() // kembalikan token — kita MENOLAK, bukan menunggu
			i.ditolak.Inc()
			i.setQuotaHeader(w, 0, tunggu)
			w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(tunggu.Seconds()))))
			http.Error(w, "429 Too Many Requests", http.StatusTooManyRequests)
			return
		}

		i.allowed.Inc()
		i.setQuotaHeader(w, int(lim.Tokens()), 0)
		next.ServeHTTP(w, r)
	})
}

// pasangHeaderKuota mengirim header kuota gaya draft IETF.
//
// Retry-After memberi tahu klien kapan boleh kembali SETELAH ia ditolak.
// Header ini memberitahunya SEBELUM ia tertolak, sehingga klien yang patuh
// bisa memperlambat diri sendiri dan badai pengulangan tidak pernah terbentuk.
func (i *IPRateLimiter) setQuotaHeader(w http.ResponseWriter, sisa int, reset time.Duration) {
	h := w.Header()
	h.Set("RateLimit-Limit", strconv.Itoa(i.k.Burst))
	h.Set("RateLimit-Remaining", strconv.Itoa(max(sisa, 0)))
	h.Set("RateLimit-Reset", strconv.Itoa(int(math.Ceil(reset.Seconds()))))
}
```

```go
package ratelimit

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"golang.org/x/time/rate"
)

func limiterUji(t *testing.T, k Konfig) http.Handler {
	t.Helper()
	ctx, batal := context.WithCancel(context.Background())
	t.Cleanup(batal) // menghentikan sweeper; tanpa ini tiap uji membocorkan goroutine
	k.Reg = prometheus.NewRegistry()
	rl := NewIPRateLimiter(ctx, k)
	return rl.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
}

// Uji terpenting di berkas ini. Versi lama memakai satu objek request dengan
// RemoteAddr tetap, sehingga port yang ikut terbawa ke dalam kunci tidak
// pernah terlihat. Di produksi port berganti setiap koneksi — dan limiter
// yang tampak bekerja sempurna di uji ternyata tidak membatasi apa pun.
func TestPortEfemeralTidakMembuatBucketBaru(t *testing.T) {
	h := limiterUji(t, Konfig{Rate: 1, Burst: 1})

	kode := make([]int, 0, 3)
	for _, port := range []string{"51001", "51002", "51003"} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "203.0.113.7:" + port
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		kode = append(kode, rec.Code)
	}

	if kode[0] != http.StatusOK {
		t.Fatalf("permintaan 1 = %d, mau 200", kode[0])
	}
	if kode[1] != http.StatusTooManyRequests || kode[2] != http.StatusTooManyRequests {
		t.Fatalf("permintaan 2,3 = %v, mau 429 keduanya — port ikut masuk ke kunci limiter", kode[1:])
	}
}

// Tanpa proxy tepercaya, X-Forwarded-For WAJIB diabaikan sepenuhnya.
func TestXFFDiabaikanTanpaProksiTepercaya(t *testing.T) {
	h := limiterUji(t, Konfig{Rate: 1, Burst: 1, ProksiTepercaya: 0})

	var terakhir int
	for i, fake := range []string{"1.2.3.4", "5.6.7.8", "9.10.11.12"} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "203.0.113.9:40000"
		req.Header.Set("X-Forwarded-For", fake)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if i == 0 && rec.Code != http.StatusOK {
			t.Fatalf("permintaan pertama = %d, mau 200", rec.Code)
		}
		terakhir = rec.Code
	}
	if terakhir != http.StatusTooManyRequests {
		t.Fatalf("last code = %d, want 429 — fake XFF successfully bypassed limit", terakhir)
	}
}

// Dengan satu proxy tepercaya, entri PALING KANAN yang dipakai — itulah yang
// ditambahkan proxy Anda. Entri di kirinya berasal dari klien dan bisa palsu.
func TestSatuProksiTepercayaMemakaiEntriPalingKanan(t *testing.T) {
	h := limiterUji(t, Konfig{Rate: 1, Burst: 1, ProksiTepercaya: 1})

	send := func(xff string) int {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "10.0.0.1:40000" // alamat proxy
		req.Header.Set("X-Forwarded-For", xff)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	// Klien yang sama (198.51.100.5) mencoba menyamar dengan mengubah bagian
	// kiri rantai. Bagian kanan tetap ditulis proxy, jadi keduanya satu bucket.
	if got := send("1.2.3.4, 198.51.100.5"); got != http.StatusOK {
		t.Fatalf("permintaan 1 = %d, mau 200", got)
	}
	if got := send("9.9.9.9, 198.51.100.5"); got != http.StatusTooManyRequests {
		t.Fatalf("permintaan 2 = %d, mau 429 — entri kiri yang dipalsukan ikut dipercaya", got)
	}
}

func TestRetryAfterMencerminkanTungguSebenarnya(t *testing.T) {
	// 1 token per 5 detik: setelah burst habis, tunggu sebenarnya ~5 detik.
	h := limiterUji(t, Konfig{Rate: rate.Every(5 * time.Second), Burst: 1})

	req := func() *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.RemoteAddr = "192.0.2.10:33333"
		return r
	}
	h.ServeHTTP(httptest.NewRecorder(), req())

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req())
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("kode = %d, mau 429", rec.Code)
	}

	ra, err := strconv.Atoi(rec.Header().Get("Retry-After"))
	if err != nil {
		t.Fatalf("Retry-After cannot be read: %v", err)
	}
	// Nilai tetap "10" pada versi lama lolos pemeriksaan "header ada", tapi
	// menyuruh klien menunggu dua kali lebih lama dari yang diperlukan.
	if ra < 4 || ra > 6 {
		t.Fatalf("Retry-After = %d detik, mau ~5", ra)
	}
	if rec.Header().Get("RateLimit-Limit") == "" {
		t.Error("quota header not sent; client has no way to slow down before being rejected")
	}
}
```

## Versi Tersebar: Sliding Window di Redis

Kode di atas membatasi **per pod**. Begitu ada dua replika, batas efektifnya menjadi `batas × jumlah replika` dan berubah setiap kali autoscaler bergerak — itulah alasan bagian "Kapan JANGAN Pakai Ini" menyebut limiter in-memori tidak layak untuk armada. Berikut sisi tersebarnya, yang selama ini hanya digambarkan di §1 tanpa implementasi.

Empat hal yang menentukan benar-tidaknya skrip ini, dan semuanya mudah dilanggar:

```lua
-- KEYS[1] = kunci kuota, ARGV = batas, jendela (mikrodetik), id unik permintaan
local kunci   = KEYS[1]
local batas   = tonumber(ARGV[1])
local jendela = tonumber(ARGV[2])
local id      = ARGV[3]

-- (1) Waktu diambil dari server REDIS, bukan dari jam pod. Jam antar-pod bisa
--     menyimpang beberapa detik, dan dengan jam klien setiap pod praktis
--     memiliki jendelanya sendiri — batas terpusatnya jadi tidak terpusat.
local t = redis.call('TIME')
local sekarang = tonumber(t[1]) * 1000000 + tonumber(t[2])

redis.call('ZREMRANGEBYSCORE', kunci, 0, sekarang - jendela)
local jumlah = redis.call('ZCARD', kunci)

if jumlah >= batas then
  -- (2) Entri TERTUA menentukan kapan satu slot bebas. Inilah Retry-After yang
  --     sesungguhnya; tanpa ini klien hanya bisa menebak.
  local tertua = redis.call('ZRANGE', kunci, 0, 0, 'WITHSCORES')
  local tunggu = 0
  if tertua[2] then
    tunggu = (tonumber(tertua[2]) + jendela - sekarang) / 1000000
  end
  return {0, jumlah, tunggu}
end

-- (3) Entri hanya DITAMBAHKAN bila diizinkan. Menambahkan lebih dulu lalu
--     menolak membuat permintaan yang ditolak ikut memperpanjang jendela:
--     klien yang mengulang terus tidak akan pernah bisa masuk lagi, dan
--     limiter berubah menjadi pemblokiran permanen.
redis.call('ZADD', kunci, sekarang, id)

-- (4) TTL WAJIB. Tanpa PEXPIRE, satu kunci tertinggal untuk SETIAP identitas
--     yang pernah muncul — kebocoran memori yang sama seperti Anti-Pattern 3,
--     hanya berpindah ke Redis.
redis.call('PEXPIRE', kunci, math.ceil(jendela / 1000))
return {1, jumlah + 1, 0}
```

Seluruh urutan berjalan dalam satu `EVAL`, sehingga atomik terhadap pod lain: tidak ada celah baca-lalu-tulis yang membuat dua pod sama-sama mengira masih ada kuota.

```go
// KeputusanKuota adalah hasil satu evaluasi.
type KeputusanKuota struct {
	Diizinkan bool
	Used  int64
	Wait    time.Duration
}

type RedisLimiter struct {
	script   *redis.Script
	rdb     *redis.Client
	limit   int64
	jendela time.Duration
	// gagalTerbuka menentukan perilaku saat Redis tidak dapat dihubungi.
	// Lihat Edge Case 2 — jawabannya BERBEDA untuk kuota kapasitas dan untuk
	// batas keamanan seperti login.
	failOpen bool
}

func (l *RedisLimiter) Izinkan(ctx context.Context, identity, idPermintaan string) (KeputusanKuota, error) {
	result, err := l.script.Run(ctx, l.rdb,
		[]string{"ratelimit:" + identity},
		l.limit, l.jendela.Microseconds(), idPermintaan,
	).Slice()
	if err != nil {
		if l.failOpen {
			return KeputusanKuota{Diizinkan: true}, nil
		}
		return KeputusanKuota{}, fmt.Errorf("evaluasi kuota: %w", err)
	}

	allowed, _ := result[0].(int64)
	used, _ := result[1].(int64)
	waitSec, _ := result[2].(string) // Lua mengembalikan float sebagai string
	detik, _ := strconv.ParseFloat(waitSec, 64)

	return KeputusanKuota{
		Diizinkan: allowed == 1,
		Used:  used,
		Wait:    time.Duration(detik * float64(time.Second)),
	}, nil
}
```

> `idPermintaan` WAJIB unik per permintaan. `ZADD` memakai member sebagai kunci: bila dua permintaan mengirim member yang sama, yang kedua hanya **memperbarui skor** entri pertama alih-alih menambah hitungan — dan kuota terhitung lebih longgar dari yang Anda kira.

---

## Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan X-Forwarded-For Secara Membabi Buta
**Mengapa berbahaya:** Header HTTP `X-Forwarded-For` bisa diselipkan sembarang *string* palsu oleh *Attacker* dari luar jaringan (IP Spoofing). Jika Anda membaca header tersebut mentah-mentah untuk menentukan IP Rate Limit, hacker bisa mengirim 10,000 *request* konstan sambil mengganti (spoofing) string IP di header-nya tiap milidetik, menghindari batasan rate secara fatal.

```go
// BAD: percaya header klien
ip := r.Header.Get("X-Forwarded-For")
// Penyerang mengirim: X-Forwarded-For: 1.2.3.4 (diganti tiap permintaan)
```
```go
// BAD JUGA — dan ini yang jauh lebih sering lolos review:
ip := r.RemoteAddr // "203.0.113.7:54321" — PORT ikut terbawa
```
```go
// GOOD: pisahkan port, lalu ambil entri XFF ke-N dari KANAN sesuai jumlah
// proxy milik Anda sendiri. Lihat identitas() di §Production Code.
host, _, _ := net.SplitHostPort(r.RemoteAddr)
```

Dua kegagalan ini menghasilkan gejala yang **identik** — limiter tidak membatasi apa pun, dan peta klien tumbuh tanpa batas — sehingga sering tertukar saat ditelusuri:

| | Penyebab bucket baru tiap permintaan | Terlihat di uji? |
| :--- | :--- | :--- |
| `X-Forwarded-For` mentah | penyerang mengganti isinya | Tidak — uji jarang mengirim XFF |
| `r.RemoteAddr` dengan port | port efemeral berganti tiap koneksi | **Tidak** — uji memakai RemoteAddr tetap |

Yang kedua lebih berbahaya justru karena tidak butuh penyerang: ia terjadi pada trafik normal, di setiap sistem, sejak hari pertama.

### ❌ Anti-Pattern 2: Kunci Tulis di Jalur Panas

**Mengapa berbahaya:** yang mahal bukan pencarian map-nya — itu puluhan nanodetik dan satu `sync.Mutex` sanggup melayani ratusan ribu permintaan per detik. Yang mahal adalah **memaksa kunci TULIS untuk permintaan yang sebenarnya hanya membaca**. Pola lama mengambil `Lock()` penuh pada setiap permintaan hanya karena stempel waktu `lastSeen` perlu diperbarui, sehingga seluruh trafik diserialkan di satu titik meski 99,99% di antaranya hanya perlu membaca pointer.

```go
// BAD: kunci TULIS untuk setiap permintaan, termasuk yang sudah dikenal
i.mu.Lock()
v := i.clients[ip]
v.lastSeen = time.Now() // satu-satunya alasan kunci ini harus kunci tulis
i.mu.Unlock()
```
```go
// GOOD: stempel waktu dijadikan atomik, sehingga jalur panas cukup RLock.
// Kunci tulis hanya diambil saat identitas benar-benar baru.
i.mu.RLock()
v, ada := i.klien[kunci]
i.mu.RUnlock()
if ada {
    v.terlihat.Store(time.Now().UnixNano())
    return v.limiter
}
```

Sharding map dengan array mutex baru relevan setelah pola di atas pun tidak cukup — dan pada titik itu, yang sebenarnya Anda butuhkan hampir selalu limiter terpusat, bukan limiter in-memori yang lebih cepat.

### ❌ Anti-Pattern 3: Storage Memori Tanpa Pembersihan (Memory Leak)
**Mengapa berbahaya:** Map Go tidak mengecilkan kapasitas memorinya secara instan setelah entri di-*delete*. Bila Anda memantau jutaan IP harian dan menyimpan *rate limiter object* ke map tanpa mekanisme *cleanup* reguler (sweeper) atas IP basi, layanan Anda akan terkena *OOM Killed* dalam hitungan jam.

```go
// BAD: Tidak menghapus entri lama
i.clients[ip] = rate.NewLimiter(...) // Dibiarkan abadi.
```

## Edge Cases & Defensive Programming

1. **Non-Homogenous Request Cost**: Tidak semua API punya 'berat' yang sama. Limit statis (e.g. 100 Req/min) salah sasaran jika `GET /ping` berbiaya nol vs `POST /generate-pdf` yang memakan CPU gila-gilaan. *Defensive:* Hitung token secara dinamis. `limiter.AllowN(now, 50)` di mana API berat memakan 50 token sekaligus, sedangkah ping hanya 1 token.
2. **Fail-Open vs Fail-Closed — jawabannya BERBEDA per jenis batas, bukan satu kebijakan untuk seluruh sistem:** saat Redis tidak dapat dihubungi, "selalu fail-open" adalah nasihat yang benar untuk sebagian batas dan berbahaya untuk sebagian lainnya.

   | Jenis batas | Pilihan | Alasan |
   | :--- | :--- | :--- |
   | Kuota kapasitas (API umum, kuota per-tenant) | **Fail-open** | Sistem yang berpotensi kelebihan beban tetap melayani sebagian besar trafik sah; sistem yang menolak semua orang melayani nol |
   | Batas keamanan (login, OTP, reset kata sandi, verifikasi kartu) | **Fail-closed** | Fail-open di sini berarti penyerang yang berhasil menjatuhkan Redis mendapat **percobaan kata sandi tanpa batas**. Ketersediaan formulir login jauh lebih murah daripada akun yang jebol |

   Berkas ini membuka dengan menyebut *brute force* sebagai motivasi utama rate limiting — dan justru untuk kasus itulah fail-open menjadi pintu belakang. Pisahkan kebijakannya per limiter (field `gagalTerbuka` pada `RedisLimiter` di atas), jangan satu sakelar untuk seluruh aplikasi.
3. **Thundering Herd Reset**: Jika menggunakan *Fixed Window* sederhana (di-reset secara serentak setiap puncak menit `:00`), sistem rentan diledakkan *(burst)* seketika. Seseorang bisa menembak 100 req di detik `01:59` dan 100 req lagi di detik `02:00`. Dalam interval 2 detik, sistem memproses 200 req padahal kapasitas per menit dirancang 100.
4. **Retry-After Header**: HTTP 429 *wajib* disertai header `Retry-After: <detik>`. Jika tidak, mesin *bot* retrier bodoh akan menghujani endpoint Anda jutaan kali dalam status error, membakar *CPU parsing HTTP* dan memakan *bandwidth ingress*.

## Kapan JANGAN Pakai Ini

- **Limiter dalam-memori pada armada banyak pod.** Batas efektifnya menjadi `batas × jumlah pod`, dan berubah setiap kali autoscaler bergerak. Batas yang tidak bisa dinyatakan sebagai satu angka bukanlah batas — hitungannya harus terpusat.
- **`X-Forwarded-For` mentah sebagai identitas.** Header itu bisa diisi siapa saja. Hanya bagian yang **ditambahkan proxy tepercaya milik Anda** yang boleh dipercaya; sisanya adalah masukan penyerang.
- **Rate limiting sebagai perlindungan DDoS.** Serangan volumetrik harus dihentikan di tepi (CDN/WAF). Limiter di aplikasi tetap membayar ongkos menerima koneksi, mem-parsing header, dan mencari kunci.
- **Batas yang sama untuk semua endpoint.** `POST /laporan` yang berat dan `GET /status` yang murah tidak layak berbagi anggaran yang sama.
- **Menolak tanpa memberi tahu kapan boleh mencoba lagi.** Tanpa `Retry-After`, klien akan mengulang segera dan memperparah keadaan — limiter Anda justru menciptakan badai yang ingin dicegah.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Batas tidak pernah tercapai meski trafik tinggi | jumlah replika | Limiter in-memory; batas efektif berlipat sejumlah pod |
| Memori naik terus di layanan | jumlah entri limiter | Entri per-klien tidak pernah dibersihkan |
| Satu klien menjatuhkan semua pengguna | identitas yang dipakai | Semua pengguna di belakang satu proxy dihitung sebagai satu |
| `429` melonjak setelah `429` | apakah `Retry-After` dikirim | Klien mengulang segera dan memperparah keadaan |
| Redis lambat saat trafik puncak | jumlah operasi per permintaan | Limiter terpusat menambah round-trip di jalur panas |
| Batas tidak pernah tercapai walau satu pod | apakah port ikut masuk ke kunci | `r.RemoteAddr` dipakai utuh; tiap koneksi dapat bucket sendiri |
| Klien tetap tertolak walau berhenti mengirim | urutan ZADD vs pemeriksaan batas | Permintaan yang ditolak ikut memperpanjang jendela |
| Percobaan login melonjak saat Redis bermasalah | kebijakan gagal pada limiter auth | Fail-open dipasang pada batas keamanan |

```bash
# Berapa banyak yang ditolak, dan siapa yang paling sering
curl -s localhost:9090/metrics | grep -E 'rate_limit_(allowed|rejected)'
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.status==429) | .klien' | sort | uniq -c | sort -rn | head

# Batas efektif = batas per pod x jumlah replika (bila limiter in-memory)
kubectl get deploy api -o jsonpath='{.status.replicas}'

# Limiter berbasis Redis: kunci menumpuk berarti TTL tidak dipasang
redis-cli --scan --pattern 'ratelimit:*' | wc -l
redis-cli ttl ratelimit:ip:203.0.113.7

# Retry-After benar-benar dikirim?
curl -si localhost:8080/api/v1/kirim | grep -i 'retry-after'
```
