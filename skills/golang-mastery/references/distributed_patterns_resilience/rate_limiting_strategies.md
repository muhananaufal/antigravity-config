# Rate Limiting (Token Bucket / Sliding Window)

> **Berlaku:** Go 1.21+ · Redis 7+ · **Lihat juga:** `observability_resilience/rate_limiting_patterns.md` · `distributed_patterns_resilience/bulkhead_isolation.md` · `caching_strategy/redis_advanced_patterns.md` · `observability_resilience/circuit_breaker_hystrix.md`

## 1. Konsep & Internal

**Rate Limiting** adalah teknik untuk mengontrol laju lalu lintas jaringan yang dikirimkan atau diterima oleh suatu *service*. Jika klien mengirim permintaan (request) melampaui batas yang diizinkan (limit), server akan menolaknya (biasanya dengan HTTP 429 *Too Many Requests*).

Fungsi utama:
1. Mencegah DDOS (Denial of Service) dan *brute force*.
2. Membatasi pengeluaran dana (contoh: batasan hit API pihak ke-3 yang berbayar).
3. Memberlakukan tingkatan harga (*Pricing Tiers*) bagi pengguna API.

### Algoritma Umum

1. **Token Bucket (Standard Industri)**
   Bayangkan sebuah ember yang menampung token. Token diisi ke dalam ember dengan *rate* yang stabil (misal 10 token/detik). Maksimal kapasitas ember adalah (misal 50 token). Setiap request membutuhkan 1 token. Jika ember kosong, request ditolak. Algoritma ini mendukung *burst traffic* (lonjakan mendadak hingga maksimal kapasitas ember).
2. **Sliding Window Log / Counter**
   Melacak *timestamp* akurat dari request. Mencegah masalah *boundary/spike* pada pergantian menit (yang sering terjadi di *Fixed Window*).

### Diagram Alir Token Bucket (ASCII)

```ascii
[ Background Refiller ] --(Tambah 1 Token per 100ms)--> [ EMBER (Kapasitas Maks: 10) ]
                                                               | (Ambil Token)
                                                               v
[ Incoming Request ] --------------------------------> [ Token Tersedia? ]
                                                          /         \
                                                       (Ya)        (Tidak)
                                                       /             \
                                          [ Lanjutkan API ]     [ Tolak HTTP 429 ]
```

## 2. Production-Ready Code (golang.org/x/time/rate)

Bahasa Go secara resmi memiliki implementasi *Token Bucket* yang sangat efisien (menggunakan perhitungan matematika *timestamp*, bukan loop/worker pengisi token) di paket `golang.org/x/time/rate`.

Kode berikut mengimplementasikan Rate Limiter per-IP address untuk Server HTTP.

```go
package ratelimit

import (
	"context"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// IPRateLimiter menyimpan state Rate Limiter untuk setiap IP Address.
type IPRateLimiter struct {
	mu       sync.RWMutex
	visitors map[string]*visitor
	
	// Konfigurasi Token Bucket
	rate  rate.Limit // Kecepatan isi ulang (Token per detik)
	burst int        // Kapasitas ember (Maksimal burst)
}

// visitor melacak limiter per-IP dan waktu akses terakhir untuk memory cleanup.
type visitor struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// NewIPRateLimiter menginisialisasi Rate Limiter Manager.
func NewIPRateLimiter(r rate.Limit, b int) *IPRateLimiter {
	i := &IPRateLimiter{
		visitors: make(map[string]*visitor),
		rate:     r,
		burst:    b,
	}

	// Jalankan background job untuk menghapus IP usang dari memory
	go i.cleanupVisitors()
	return i
}

// GetLimiter mengambil atau membuat limiter baru untuk suatu IP
func (i *IPRateLimiter) GetLimiter(ip string) *rate.Limiter {
	i.mu.RLock()
	v, exists := i.visitors[ip]
	i.mu.RUnlock()

	if exists {
		i.mu.Lock()
		v.lastSeen = time.Now()
		i.mu.Unlock()
		return v.limiter
	}

	// Inisialisasi Limiter baru jika belum ada
	i.mu.Lock()
	defer i.mu.Unlock()

	// Double-check locking
	if v, exists := i.visitors[ip]; exists {
		v.lastSeen = time.Now()
		return v.limiter
	}

	limiter := rate.NewLimiter(i.rate, i.burst)
	i.visitors[ip] = &visitor{
		limiter:  limiter,
		lastSeen: time.Now(),
	}

	return limiter
}

// cleanupVisitors menghapus data IP yang sudah tidak aktif (Garbage Collection).
func (i *IPRateLimiter) cleanupVisitors() {
	for {
		time.Sleep(time.Minute)
		
		i.mu.Lock()
		for ip, v := range i.visitors {
			// Hapus IP yang tidak ada request lebih dari 3 menit
			if time.Since(v.lastSeen) > 3*time.Minute {
				delete(i.visitors, ip)
			}
		}
		i.mu.Unlock()
	}
}

// Middleware menghasilkan HTTP Middleware untuk Rate Limiting.
func (i *IPRateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Dapatkan IP address asli (Abaikan port)
		ip, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			log.Printf("Invalid RemoteAddr: %s", r.RemoteAddr)
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
			return
		}

		// Ambil rate limiter khusus untuk IP ini
		limiter := i.GetLimiter(ip)

		// Evaluasi apakah token masih ada (Allow)
		if !limiter.Allow() {
			http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
			return
		}

		next.ServeHTTP(w, r)
	})
}
```

### Implementasi Terdistribusi (Redis)
Jika menggunakan *load balancer* dan *multiple server pods*, state dari Rate Limiter harus disimpan di basis data pusat seperti Redis, menggunakan algoritma `EVAL` Lua Script agar Atomic.

```go
// Pseudocode Logika Redis Token Bucket
const luaTokenBucket = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local fill_time = capacity / rate
local ttl = math.floor(fill_time * 2)

-- Get current tokens
local last_tokens = tonumber(redis.call("HGET", key, "tokens"))
if last_tokens == nil then
    last_tokens = capacity
end

local last_refreshed = tonumber(redis.call("HGET", key, "timestamp"))
if last_refreshed == nil then
    last_refreshed = 0
end

local delta = math.max(0, now - last_refreshed)
local filled_tokens = math.min(capacity, last_tokens + (delta * rate))

local allowed = filled_tokens >= requested
local new_tokens = filled_tokens

if allowed then
    new_tokens = filled_tokens - requested
end

redis.call("HSET", key, "tokens", new_tokens)
redis.call("HSET", key, "timestamp", now)
redis.call("EXPIRE", key, ttl)

return {allowed, new_tokens}
`
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan Memory Global tanpa Cleanup (OOM Target)
**Masalah**: Developer membuat map global `map[string]*rate.Limiter` tanpa menghapus *entry* IP lama.
```go
// BAD: Memory Leak
var limiters = make(map[string]*rate.Limiter)
func get(ip string) *rate.Limiter {
    if limiters[ip] == nil { limiters[ip] = rate.NewLimiter(...) }
    return limiters[ip]
}
```
**Why dangerous:** Pada aplikasi publik, server dapat menerima hits dari jutaan IP acak (terutama *bot crawler* yang hanya hits 1 kali). Map ini akan membengkak tiada henti memakan Gigabytes RAM hingga server mati (Out of Memory).
**Solusi:** (Lihat implementasi di atas). Anda wajib memiliki *Background Goroutine* yang melakukan pengecekan `lastSeen` dan me-`delete()` kunci-kunci usang. Alternatif modern adalah menggunakan `hashicorp/golang-lru` untuk otomatis membuang yang terlama.

### ❌ Anti-Pattern 2: Fixed Window Counter (Spike Boundary)
**Masalah**: Developer membatasi 100 hit/menit dengan me-reset counter tiap menit persis.
```go
// BAD: Fixed Window Error
count := redis.Incr("ip:" + currentMinuteStr)
if count > 100 { reject() }
```
**Why dangerous:** Jika penyerang mengirim 100 *request* pada detik ke 00:59, dan 100 request lagi di detik 01:00, server Anda menerima 200 *request* hanya dalam jeda 1 detik! Padahal tujuannya adalah meratakan beban ke seluruh menit.
**Solusi:** Gunakan Token Bucket, Sliding Window Log, atau Sliding Window Counter yang bersifat berkelanjutan.

## 4. Edge Cases Spesifik

1. **Proxy dan Spoofed IP Headers**:
   Pada infrastruktur Cloud (AWS/GCP), `r.RemoteAddr` sering kali menampilkan IP dari Load Balancer, bukan Klien asli. Developer biasanya menggunakan *header* `X-Forwarded-For`.
   *Edge Case*: Attacker dapat secara palsu mengirim `X-Forwarded-For: 1.1.1.1` melalui terminal lokal mereka, menembus Rate Limiter atau mencekal (ban) orang lain.
   *Penanganan*: Pastikan Load Balancer Anda dikonfigurasi untuk *menimpa* (override/append valid) header `X-Forwarded-For`, atau percayai IP hanya pada lompatan pertama dari *Trusted Proxy* terdekat.

2. **Wait / Reserve vs Allow**:
   Paket `x/time/rate` di Golang memiliki `limiter.Wait(ctx)`. Jika token kosong, `Wait` akan nge-*block* goroutine (membuat *request HTTP* gantung) sampai token berikutnya jatuh.
   *Penanganan*: Jangan pernah menggunakan `Wait()` pada HTTP Handler sinkron! Hal ini akan menyebabkan jutaan Goroutine menumpuk, menyebabkan *Resource Leak*. Gunakan selalu `limiter.Allow()` yang akan merespons langsung (Fast Fail).

3. **Throttling Skala Terdistribusi Lambat (Redis Latency)**:
   Mengeksekusi *Lua Script* ke Redis untuk setiap hit HTTP akan menambah ~1-3ms latensi ke setiap permintaan. Untuk API berskala ekstrim (100k RPS), ini mahal.
   *Penanganan*: Gunakan arsitektur *Local-Global Sync* (contoh: algortima di balik library Cloudflare / Envoy). Rate limit dicek di memori lokal (sangat cepat), dan sinkronisasi ke Redis dilakukan secara *batch* atau di *background* setiap hitungan tertentu.

## 5. Unit Tests (Behavioral Testing)

```go
package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"golang.org/x/time/rate"
)

func TestIPRateLimiter_AllowsAndRejects(t *testing.T) {
	// Rate = 5 req/second, Burst = 2
	limiter := NewIPRateLimiter(5, 2)

	handler := limiter.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/", nil)
	// Spoof IP yang akan terpotong oleh net.SplitHostPort
	req.RemoteAddr = "192.168.1.5:12345" 

	// Hit 1: Harus diizinkan
	w1 := httptest.NewRecorder()
	handler.ServeHTTP(w1, req)
	if w1.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK, got %v", w1.Code)
	}

	// Hit 2: Harus diizinkan (Karena Burst = 2)
	w2 := httptest.NewRecorder()
	handler.ServeHTTP(w2, req)
	if w2.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK, got %v", w2.Code)
	}

	// Hit 3: Harus Ditolak (Ember kosong, token berikutnya butuh 200ms)
	w3 := httptest.NewRecorder()
	handler.ServeHTTP(w3, req)
	if w3.Code != http.StatusTooManyRequests {
		t.Fatalf("Expected 429 Too Many Requests, got %v", w3.Code)
	}
}

func TestIPRateLimiter_GarbageCollection(t *testing.T) {
	limiter := NewIPRateLimiter(1, 1)

	// Inject IP buatan yang pura-pura last seen sangat lama
	limiter.mu.Lock()
	limiter.visitors["10.0.0.1"] = &visitor{
		limiter:  rate.NewLimiter(1, 1),
		lastSeen: time.Now().Add(-5 * time.Minute), // Kedaluwarsa
	}
	limiter.visitors["10.0.0.2"] = &visitor{
		limiter:  rate.NewLimiter(1, 1),
		lastSeen: time.Now().Add(-1 * time.Minute), // Belum kedaluwarsa
	}
	limiter.mu.Unlock()

	// Panggil GC secara manual untuk test
	// Di sistem asli ini dipanggil via goroutine
	
	// Simulasi GC pass 
	limiter.mu.Lock()
	for ip, v := range limiter.visitors {
		if time.Since(v.lastSeen) > 3*time.Minute {
			delete(limiter.visitors, ip)
		}
	}
	limiter.mu.Unlock()

	// Verifikasi
	limiter.mu.RLock()
	defer limiter.mu.RUnlock()

	if _, exists := limiter.visitors["10.0.0.1"]; exists {
		t.Fatalf("IP 10.0.0.1 should have been cleaned up")
	}

	if _, exists := limiter.visitors["10.0.0.2"]; !exists {
		t.Fatalf("IP 10.0.0.2 should NOT have been cleaned up")
	}
}
```

## Kapan JANGAN Pakai Ini

- **Fixed window untuk batas yang benar-benar ketat.** Klien bisa mengirim dua kali kuota di perbatasan jendela — semuanya di akhir jendela pertama, lalu semuanya lagi di awal jendela kedua. Untuk batas yang harus dijamin, pakai sliding window atau token bucket.
- **Sliding window log pada trafik tinggi.** Ia menyimpan timestamp setiap permintaan; memori dan biaya Redis tumbuh sebanding dengan trafik yang justru sedang ingin Anda batasi.
- **Token bucket dengan burst jauh lebih besar dari laju rata-rata.** Burst besar berarti hilir tetap bisa dihantam sekaligus — persis kejadian yang limiter ini dipasang untuk mencegah.
- **Batas per-IP untuk pengguna yang sudah terautentikasi.** IP dibagi bersama (NAT kantor, operator seluler) dan berpindah-pindah. Untuk pengguna yang login, batasi per identitas.
- **Tanpa jalur khusus untuk trafik internal.** Health check, pemantauan, dan job internal yang ikut kena limit akan menghasilkan alarm palsu tepat saat insiden sedang berlangsung.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Lonjakan `429` menumpuk di perbatasan menit | distribusi waktu penolakan | Fixed window; klien memanfaatkan batas jendela |
| Memori Redis naik sebanding trafik | struktur data limiter | Sliding window log menyimpan tiap timestamp |
| Hilir tetap kebanjiran meski limiter aktif | ukuran burst | Burst terlalu besar dibanding laju rata-rata |
| Satu kantor terblokir seluruhnya | identitas yang dipakai | Batas per-IP untuk pengguna di belakang NAT |
| Health check gagal saat trafik puncak | apakah ada pengecualian internal | Probe ikut kena limit |

```bash
# Penolakan menumpuk di detik-detik tertentu = fixed window
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.status==429) | .waktu' | cut -c15-19 | sort | uniq -c | sort -rn | head

# Struktur limiter dan ongkos memorinya
redis-cli --bigkeys | grep -i ratelimit
redis-cli info memory | grep -E 'used_memory_human|maxmemory_policy'

curl -s localhost:9090/metrics | grep -E 'rate_limit_(allowed|rejected)_total'
```
