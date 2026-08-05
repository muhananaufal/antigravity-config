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
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"golang.org/x/time/rate"
)

// clientLimit menyimpan state token bucket untuk satu IP/Client.
type clientLimit struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// IPRateLimiter mengatur peta limiter dalam memory.
type IPRateLimiter struct {
	mu      sync.Mutex
	clients map[string]*clientLimit
	r       rate.Limit
	b       int
}

// NewIPRateLimiter: r = token per second, b = max burst tokens.
func NewIPRateLimiter(r rate.Limit, b int) *IPRateLimiter {
	i := &IPRateLimiter{
		clients: make(map[string]*clientLimit),
		r:       r,
		b:       b,
	}

	// Goroutine pembersih background (Garbage Collection untuk memory leak)
	go i.cleanupStaleClients()
	
	return i
}

// getLimiter mengembalikan atau membuat limiter atomik untuk sebuah IP
func (i *IPRateLimiter) getLimiter(ip string) *rate.Limiter {
	i.mu.Lock()
	defer i.mu.Unlock()

	v, exists := i.clients[ip]
	if !exists {
		limiter := rate.NewLimiter(i.r, i.b)
		i.clients[ip] = &clientLimit{limiter: limiter, lastSeen: time.Now()}
		return limiter
	}

	v.lastSeen = time.Now()
	return v.limiter
}

// cleanupStaleClients menghapus IP yang inaktif lebih dari 3 menit
func (i *IPRateLimiter) cleanupStaleClients() {
	for {
		time.Sleep(1 * time.Minute)
		i.mu.Lock()
		for ip, client := range i.clients {
			if time.Since(client.lastSeen) > 3*time.Minute {
				delete(i.clients, ip)
			}
		}
		i.mu.Unlock()
	}
}

// Middleware mengekstrak IP dan mengaplikasikan rate limit.
func (i *IPRateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Mengambil IP asli, mempertimbangkan Load Balancer (Proxy)
		// CATATAN: Ini berisiko jika proxy tidak disetel ketat. Lihat Anti-Pattern 1.
		ip := getRealIP(r)
		
		limiter := i.getLimiter(ip)

		// Evaluasi apakah token tersedia (Non-blocking)
		if !limiter.Allow() {
			w.Header().Set("Retry-After", "10") 
			http.Error(w, "429 Too Many Requests", http.StatusTooManyRequests)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// getRealIP adalah helper sederhana
func getRealIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// Dalam praktiknya, periksa IP valid pertama di XFF chain
		return xff
	}
	return r.RemoteAddr
}

// --- Unit Tests ---

func TestRateLimiting_BurstThenReject(t *testing.T) {
	// 2 token/detik, burst maksimal 2
	rl := NewIPRateLimiter(2, 2)

	handler := rl.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "192.168.1.1:1234"

	// Request 1 & 2: OK (burst terpakai)
	for i, wantCode := range []int{http.StatusOK, http.StatusOK, http.StatusTooManyRequests} {
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		if rr.Code != wantCode {
			t.Errorf("request %d: got %d, want %d", i+1, rr.Code, wantCode)
		}
	}
}

func TestRateLimiting_DifferentIPsIndependent(t *testing.T) {
	// Tiap IP punya limiter sendiri — IP berbeda tidak saling mempengaruhi
	rl := NewIPRateLimiter(1, 1) // hanya 1 token per IP

	handler := rl.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// IP A: request 1 → OK
	reqA := httptest.NewRequest("GET", "/", nil)
	reqA.RemoteAddr = "10.0.0.1:1000"
	rrA := httptest.NewRecorder()
	handler.ServeHTTP(rrA, reqA)
	if rrA.Code != http.StatusOK {
		t.Errorf("IP-A req1: got %d, want 200", rrA.Code)
	}

	// IP B: request 1 → OK (limiter IP B masih penuh)
	reqB := httptest.NewRequest("GET", "/", nil)
	reqB.RemoteAddr = "10.0.0.2:1000"
	rrB := httptest.NewRecorder()
	handler.ServeHTTP(rrB, reqB)
	if rrB.Code != http.StatusOK {
		t.Errorf("IP-B req1: got %d, want 200", rrB.Code)
	}

	// IP A: request 2 → 429 (token habis)
	rrA2 := httptest.NewRecorder()
	handler.ServeHTTP(rrA2, reqA)
	if rrA2.Code != http.StatusTooManyRequests {
		t.Errorf("IP-A req2: got %d, want 429", rrA2.Code)
	}
}

func TestRateLimiting_RetryAfterHeader(t *testing.T) {
	// HTTP 429 harus menyertakan Retry-After header
	rl := NewIPRateLimiter(0, 0) // tidak ada token sama sekali

	handler := rl.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "172.16.0.1:9999"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("got %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("429 response missing Retry-After header")
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan X-Forwarded-For Secara Membabi Buta
**Mengapa berbahaya:** Header HTTP `X-Forwarded-For` bisa diselipkan sembarang *string* palsu oleh *Attacker* dari luar jaringan (IP Spoofing). Jika Anda membaca header tersebut mentah-mentah untuk menentukan IP Rate Limit, hacker bisa mengirim 10,000 *request* konstan sambil mengganti (spoofing) string IP di header-nya tiap milidetik, menghindari batasan rate secara fatal.

```go
// BAD: Percaya header client
ip := r.Header.Get("X-Forwarded-For") 
// Attacker mengirim: X-Forwarded-For: 1.2.3.4 (ganti tiap req)
```
```go
// GOOD: Gunakan IP dari TLS terminator yang diverifikasi, atau setel Ingress Controller 
// (seperti Nginx) untuk ME-REWRITE (bukan *append*) X-Forwarded-For dengan client addr sejati.
ip := r.RemoteAddr // Diandalkan dari koneksi golang ke Nginx, lalu Nginx menanganinya.
```

### ❌ Anti-Pattern 2: Lock Contention di Map Memory
**Mengapa berbahaya:** Menggunakan satu `sync.Mutex` tunggal untuk peta (map) jutaan IP address saat *traffic spike* terjadi menyebabkan *lock contention* yang sangat parah. Ratusan *goroutine* harus mengantre untuk membuka kunci sekadar demi mengecek batas rate. Server Anda tidak akan kolaps karena CPU/Memory, tapi mati seketika akibat *Goroutine Wait/Parking*.

```go
// BAD: Global Mutex di jalur panas (Hot Path)
i.mu.Lock()
limiter := i.clients[ip]
i.mu.Unlock() // Ribuan request berebut masuk ke lorong kecil ini
```
```go
// GOOD: Sharding Map dengan array Mutex (misal berdasarkan Hash dari string IP modulo 256), 
// atau serahkan ke struktur data in-memory eksternal berkinerja tinggi (Redis `EVAL`).
```

### ❌ Anti-Pattern 3: Storage Memori Tanpa Pembersihan (Memory Leak)
**Mengapa berbahaya:** Map Go tidak mengecilkan kapasitas memorinya secara instan setelah entri di-*delete*. Bila Anda memantau jutaan IP harian dan menyimpan *rate limiter object* ke map tanpa mekanisme *cleanup* reguler (sweeper) atas IP basi, layanan Anda akan terkena *OOM Killed* dalam hitungan jam.

```go
// BAD: Tidak menghapus entri lama
i.clients[ip] = rate.NewLimiter(...) // Dibiarkan abadi.
```

## Edge Cases & Defensive Programming

1. **Non-Homogenous Request Cost**: Tidak semua API punya 'berat' yang sama. Limit statis (e.g. 100 Req/min) salah sasaran jika `GET /ping` berbiaya nol vs `POST /generate-pdf` yang memakan CPU gila-gilaan. *Defensive:* Hitung token secara dinamis. `limiter.AllowN(now, 50)` di mana API berat memakan 50 token sekaligus, sedangkah ping hanya 1 token.
2. **Fail-Open vs Fail-Closed**: Jika instance Redis terpusat yang Anda pakai untuk Rate Limiter *down*, apa yang harus aplikasi Go Anda lakukan? 
   - *Fail-Closed*: Anda lempar HTTP 500/429 ke semua orang (seluruh API mati karena rate limiter mati).
   - *Fail-Open*: Anda log "Rate limit down, skipping check", membiarkan *traffic* masuk ke backend.
   Pilih Fail-Open secara *default*, karena sistem lebih baik berpotensi *overload* (masih bisa melayani *traffic* valid 90%) daripada mati mutlak 100% untuk semua pelanggan.
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
