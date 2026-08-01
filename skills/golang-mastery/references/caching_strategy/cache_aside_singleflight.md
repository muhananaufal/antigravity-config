# Panduan Ekstensif dan Definitif: Arsitektur Cache-Aside, Mitigasi Thundering Herd, dan Penerapan Singleflight di Golang

## 1. Anatomi dan Fondasi: Cache-Aside Pattern
Di antara lusinan pola caching (seperti Write-Through, Write-Behind, Refresh-Ahead), **Cache-Aside (atau Lazy Loading)** adalah pola desain paling populer, paling mudah dipahami, sekaligus paling banyak digunakan di industri perangkat lunak modern. Pada pola ini, lapisan *cache* tidak berkomunikasi langsung dengan pangkalan data (*database*). Aplikasi itu sendiri (dalam hal ini, service Golang Anda) bertindak sebagai orkestrator yang menjembatani klien, *cache* (seperti Redis atau Memcached), dan database persisten (seperti PostgreSQL, MySQL, MongoDB).

### Alur Kerja Operasional Cache-Aside:
1. **Intersepsi Permintaan**: Layanan Go menerima instruksi pembacaan (Read Request) data dari klien (bisa berupa HTTP API call, gRPC request, dll).
2. **Inspeksi Cache**: Layanan Go pertama-tama akan memeriksa *cache in-memory* menggunakan sebuah Key yang teridentifikasi secara unik.
3. **Skenario Cache Hit**: Jika data dengan Key tersebut ditemukan di cache, aplikasi langsung mendeserialisasi data (misal JSON to Struct) dan mengembalikannya ke klien. Operasi berhenti di sini, latensi berada di kisaran ~1 milidetik.
4. **Skenario Cache Miss**: Jika data tidak ditemukan, aplikasi wajib mengambil jalur memutar:
   - Aplikasi mengeksekusi *query* ke database (sumber kebenaran utama/SSOT). Latensi bisa berkisar 10ms - 500ms.
   - Setelah database memberikan hasil, aplikasi menserialisasikannya dan menyimpannya (Write/Set) ke *cache*, umumnya dengan batas waktu kadaluarsa (TTL - Time To Live).
   - Terakhir, aplikasi mengembalikan data tersebut ke klien.

```text
==========================================================================
                     DIAGRAM ALIR CACHE-ASIDE
==========================================================================

[ Klien Web/Mobile ] 
       │ 
       ▼ (1) Meminta Data 
[ Layanan Backend Go ] ───(2) Cek Redis (GET key) ───────────┐
       │                                                     │
       │(3) Jika Cache Hit                                   │(4) Jika Cache Miss
       │    Kembalikan data <────────────────────────────────┘
       │
       ▼ (5) Query PostgreSQL (SELECT ...)
[ Database Utama ] 
       │
       ▼ (6) Return Data (Rows)
[ Layanan Backend Go ]
       │
       ▼ (7) Simpan ke Redis (SET key value EX ttl)
[ Node Redis ]
       │
       ▼ (8) Kirim Repons
[ Klien Web/Mobile ]

==========================================================================
```

Keuntungan arsitektur ini sangat besar: pangkalan data Anda tidak dihujani dengan permintaan membaca yang sama berulang kali, sehingga beban I/O bisa ditekan ke tingkat minimal. Namun, ada kelemahan fatal tersembunyi yang menunggu untuk meledak, yaitu masalah konkurensi skala tinggi.

---

## 2. Masalah Skalabilitas Kritis: Cache Stampede (Thundering Herd)

Bayangkan Anda memiliki platform *e-commerce*. Data produk A sedang dalam *flash sale*. Puluhan ribu pengguna me-refresh halaman pada saat yang sama. Data produk A tersimpan di cache, dengan TTL 10 menit.
Saat waktu habis (TTL expired), *key* produk A terhapus dari memori Redis. Pada detik berikutnya, 5000 request dari aplikasi masuk dan mengecek keberadaan data A di Redis.
Karena *key* tidak ada, terjadi **5000 Cache Miss serentak**. Sesuai desain dasar Cache-Aside, kelima ribu thread di aplikasi Anda sekarang akan mengeksekusi query `SELECT * FROM products WHERE id = A` secara paralel ke database Anda.

**Hasilnya?** 
1. Koneksi pangkalan data (*Connection Pool*) habis terpakai seketika.
2. CPU Database melonjak ke 100%, IOPS meningkat tajam, disk melambat.
3. Query mulai tertunda (Timeout). Layanan mulai gagal merespon (HTTP 502/504).
4. Pemadaman sistem keseluruhan (Downtime). 
Fenomena menakutkan ini dikenal di industri sebagai **Cache Stampede** atau **Thundering Herd Problem**.

### Diagram Kiamat Cache Stampede
```text
==========================================================================
                      INSIDEN CACHE STAMPEDE
==========================================================================

T=0    : Key 'produk_flash_sale' kedaluwarsa di Redis.
T=1ms  : [ Klien 1 ] --(Miss)--> \ 
T=2ms  : [ Klien 2 ] --(Miss)-->  \  [Aplikasi Go] ==( 5000 DB Connections )=> [ DB MATI GAYA ]
...                               /  (Semua eksekusi select produk yang sama persis)
T=15ms : [ Klien 5000]-(Miss)--> /

==========================================================================
```

---

## 3. Solusi Elegan dan Idiomatik di Go: `singleflight.Group`

Alih-alih membangun sistem *Locking Distributed* atau *Mutex* yang rumit, ekosistem Golang menyediakan solusi built-in yang sangat elegan melalui *package* `golang.org/x/sync/singleflight`. 

Fungsi utama dari `singleflight.Group` adalah menyediakan mekanisme **suppression of duplicate execution** (penekanan eksekusi duplikat). Konsepnya sederhana namun luar biasa kuat: untuk sekumpulan pemanggilan konkuren ke suatu fungsi yang dipetakan dengan sebuah `key` string yang persis sama, `singleflight` menjamin bahwa fungsi tersebut *hanya akan dieksekusi satu kali saja*. 
Goroutine lain yang datang belakangan (tetapi memanggil `key` yang sama) secara otomatis akan ditahan (*blocked/parked*), menunggu eksekusi Goroutine pertama selesai, lalu pada akhirnya meminjam dan mengembalikan nilai yang sama persis yang dihasilkan oleh eksekusi Goroutine pertama tadi.

### Diagram Mitigasi Singleflight
```text
==========================================================================
                        SINGLEFLIGHT MITIGATION
==========================================================================

[ Klien 1 ] --(Miss)--> [ Aplikasi ] --( singleflight mendaftarkan key 'A' dan Menjalankan DB fetch )---> [ DB ]
                                                                                                           │
[ Klien 2 ] --(Miss)--> [ Aplikasi ] --( mendeteksi 'A' sedang berjalan, Klien 2 menunggu... )-------------X (Tidak akses DB)
                                                                                                           │
[ Klien 5000] -(Miss)-> [ Aplikasi ] --( mendeteksi 'A' sedang berjalan, Klien 5000 menunggu... )----------X
                                                                                                           │
                                                                                                           │
( Setelah eksekusi DB Klien 1 selesai, DB merespons dengan data Produk ) <─────────────────────────────────┘
                                       ( singleflight.Group membagikan hasil ke Klien 1, 2... 5000 )
                                       ( Aplikasi melakukan 1x SET ke Redis )

==========================================================================
```

---

## 4. Implementasi Production-Ready: Penggabungan Pola

Berikut adalah implementasi robust di Golang yang menggabungkan pola Cache-Aside dan mitigasi Singleflight, dilengkapi dengan pemrosesan *Jitter* pada perhitungan *Time-To-Live* (TTL).

```go
package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"time"

	"github.com/go-redis/redis/v8"
	"golang.org/x/sync/singleflight"
)

// User adalah representasi entitas data.
type User struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
}

// Custom errors
var (
	ErrNotFound = errors.New("record not found")
)

// UserCacheService membungkus klien Redis, singleflight group, dan logic DB.
type UserCacheService struct {
	redisClient  *redis.Client
	requestGroup singleflight.Group
	fetchFromDB  func(ctx context.Context, id string) (*User, error)
	baseTTL      time.Duration
}

// NewUserCacheService inisiasi service caching
func NewUserCacheService(r *redis.Client, dbFn func(ctx context.Context, id string) (*User, error)) *UserCacheService {
	// Setup seed untuk kalkulasi Jitter
	rand.Seed(time.Now().UnixNano())
	return &UserCacheService{
		redisClient: r,
		fetchFromDB: dbFn,
		baseTTL:     15 * time.Minute,
	}
}

// GetUser mengimplementasikan Cache-Aside yang divaksinasi Singleflight.
func (s *UserCacheService) GetUser(ctx context.Context, id string) (*User, error) {
	cacheKey := fmt.Sprintf("user_entity:%s", id)

	// FASE 1: Inspeksi Cache (Read Redis)
	val, err := s.redisClient.Get(ctx, cacheKey).Result()
	if err == nil {
		// Proteksi dari Negative Caching (lihat bagian edge cases)
		if val == "NOT_FOUND" {
			return nil, ErrNotFound
		}

		var user User
		if err := json.Unmarshal([]byte(val), &user); err == nil {
			return &user, nil // Cache Hit sukses!
		}
		log.Printf("Warning: Failed to unmarshal cached data: %v", err)
	} else if err != redis.Nil {
		// Degradasi Layanan: Jika Redis error, log saja dan lanjutkan ke DB agar tidak downtime
		log.Printf("Error redis GET: %v", err)
	}

	// FASE 2: Cache Miss / Penetration -> Proteksi Thundering Herd via Singleflight
	// Parameter Do(key string, fn func() (interface{}, error)) (v interface{}, err error, shared bool)
	result, err, shared := s.requestGroup.Do(cacheKey, func() (interface{}, error) {
		
		// 1. Eksekusi fetch sumber data asli (Database)
		user, dbErr := s.fetchFromDB(ctx, id)
		
		if dbErr != nil {
			// NEGATIVE CACHING: Mencegah serangan DDoS pada ID yang memang tidak valid
			if dbErr == ErrNotFound {
				// Simpan nilai kosong "NOT_FOUND" dengan TTL pendek
				_ = s.redisClient.Set(ctx, cacheKey, "NOT_FOUND", 1*time.Minute).Err()
			}
			return nil, dbErr
		}

		// 2. Serialisasi hasil sukses
		userBytes, jsonErr := json.Marshal(user)
		if jsonErr != nil {
			return nil, jsonErr
		}

		// 3. Simpan ke Cache dengan JITTER
		ttl := s.calculateTTLWithJitter()
		setErr := s.redisClient.Set(ctx, cacheKey, userBytes, ttl).Err()
		if setErr != nil {
			log.Printf("Error redis SET: %v", setErr)
		}

		return user, nil
	})

	// Penanganan Kesalahan dan Casting Hasil
	if err != nil {
		return nil, err
	}

	// Logging jika ternyata response di-share bersama request lainnya
	if shared {
		log.Printf("Singleflight shared the execution result for user ID: %s", id)
	}

	return result.(*User), nil
}

// calculateTTLWithJitter menambahkan variansi acak ke TTL dasar untuk mencegah Expiry Storm
func (s *UserCacheService) calculateTTLWithJitter() time.Duration {
	// Menambahkan variansi 0% hingga 20% dari base TTL
	jitterPercent := 0.20 
	jitterDuration := time.Duration(float64(s.baseTTL) * jitterPercent * rand.Float64())
	return s.baseTTL + jitterDuration
}
```

---

## 5. Pola Lanjutan: Skalabilitas Maksimum

### 5.1 Probabilistic Early Expiration (Stale-While-Revalidate)
Pola yang disebutkan sebelumnya bekerja baik, namun `singleflight` masih membuat *request ke-2 hingga n* harus *menunggu (blocking)* selama rentang waktu database memproses request pertama. Bagaimana jika kita ingin latensi 0 untuk *semua* request?
Muncullah pola *Stale-While-Revalidate*.

Konsep ini menyimpan timestamp "kedaluwarsa dini" (early expiration) di samping data cache. Jika sebuah request mem-fetch data dan melihat datanya "sudah mendekati kedaluwarsa" tetapi belum benar-benar lenyap, aplikasi akan **langsung** mengembalikan data lama (stale) kepada klien tanpa menunggu. Di balik layar (background goroutine), aplikasi menggunakan `singleflight` untuk melakukan regenerasi *cache*.

```text
[ Klien ] --> [ Aplikasi Go ] --> ( Cache Hit: Data Stale ) ──> Return Stale ke Klien (0ms latency!)
                    │
                    └─> (Background Go-routine via Singleflight) ─> Fetch DB ─> SET Redis Baru
```

### 5.2 Masalah "Hot Key" & L1 Local In-Memory Cache
Pada beberapa sistem, sebuah *key* bisa diakses 500,000 kali per detik. Redis sendiri bisa kehabisan CPU jika menerima flood perintah GET sebanyak itu. Solusi terbaik adalah Caching Dua Tingkat (L1 & L2).
- **L1 Cache (In-Memory Go):** Menggunakan `freecache`, `bigcache`, atau `ristretto`. Menyimpan data per instance-pod dengan TTL sangat pendek (1 hingga 5 detik).
- **L2 Cache (Redis):** Cache tersentralisasi dengan TTL lebih panjang.

Alur: Request -> Cek L1. Jika Miss -> Cek L2. Jika Miss -> Singleflight -> DB -> Simpan L2 -> Simpan L1.

---

## 6. Bahaya Laten: Anti-Patterns di Caching Go

### Anti-Pattern 1: Mutex Lock Per Key (Coarse-grained Lock)
❌ **BAD:** Percobaan *naif* menggunakan `sync.Mutex` per *key* dengan *map* lokal di Go. Cara ini bocor memori (memory leak) dengan drastis, karena mutex yang telah dibuat dan dimasukkan ke map tidak pernah di-*garbage collect*. Akses konkurensi ke map juga akan menyebabkan panic *concurrent map read and map write*.
```go
// ❌ CONTOH KODE BURUK
var locks = make(map[string]*sync.Mutex) // 1. Map tidak thread-safe
var mu sync.Mutex

func Get(key string) {
    mu.Lock()
    if locks[key] == nil {
        locks[key] = &sync.Mutex{} // 2. Memory Leak (map bengkak terus)
    }
    lock := locks[key]
    mu.Unlock()

    lock.Lock() // Mengunci eksekusi lain
    defer lock.Unlock()
    // Eksekusi DB ...
}
```
✅ **GOOD:** Delegasikan tanggung jawab sinkronisasi identifikasi ke struktur mature seperti `golang.org/x/sync/singleflight` yang melakukan garbage-collection otomatis dari internal struct-nya saat proses eksekusi selesai.

### Anti-Pattern 2: Tidak Menggunakan Jitter (Deterministic TTL)
❌ **BAD:** Hardcoding nilai TTL. Bayangkan Anda menjalankan job cron harian di jam 12 malam untuk memanaskan data 1 juta pengguna, masing-masing dengan TTL `24 * time.Hour`. 
Hasilnya: Besok malamnya di jam 12 persis, 1 juta kunci di Redis meledak (kedaluwarsa) dalam satu waktu, dan menenggelamkan database Anda secara serentak (Expiry Storm).
```go
// ❌ CONTOH KODE BURUK: TTL Deterministik
redisClient.Set(ctx, "user:1", val, 24 * time.Hour) 
```
✅ **GOOD:** Selalu terapkan **Jitter** untuk mencerai-beraikan waktu kedaluwarsa.
```go
// ✅ CONTOH KODE BAIK: Jitter 5-15% ditambahkan
jitter := time.Duration(rand.Intn(3600)) * time.Second // Acak antara 0 - 1 jam
ttl := 24 * time.Hour + jitter
redisClient.Set(ctx, "user:1", val, ttl) 
```

---

## 7. Edge Cases dan Mitigasi Ekstrem

### Edge Case 1: Pembatalan Context (Context Cancellation) di Singleflight
Misalkan Klien 1 memanggil Singleflight, lalu memutuskan koneksinya (`ctx.Done()`). Namun Goroutine pertama yang menanggung singleflight *belum selesai di DB*. Jika Klien 2 tiba dan "menggantungkan nasibnya" pada Goroutine 1, Klien 2 bisa terperangkap selamanya (atau mendapatkan *error cancelled* yang salah karena yang cancel adalah Klien 1).
**MITIGASI:** Gunakan metode `DoChan` pada singleflight agar Anda dapat menggunakan fitur *select multiplexer* terhadap channel yang *channel-safe* per goroutine masing-masing klien.
```go
func (s *UserCacheService) GetWithDoChan(ctx context.Context, id string) (*User, error) {
    ch := s.requestGroup.DoChan(id, func() (interface{}, error) {
        // PERHATIAN: context fallback ke background agar tidak terbatalkan
        // jika klien pertama memutus koneksinya (cancel).
        return s.fetchFromDB(context.Background(), id) 
    })
    
    select {
    case <-ctx.Done():
        return nil, ctx.Err() // Klien ini membatalkan permintaannya sendiri
    case res := <-ch:
        if res.Err != nil { return nil, res.Err }
        return res.Val.(*User), nil
    }
}
```

### Edge Case 2: Negative Caching (Cache Penetration)
Seorang peretas mengetahui bahwa sistem Anda mem-fetch ke DB jika terjadi *cache miss*. Peretas secara berulang meminta `/users/fake-id-999` yang tidak pernah ada di DB. Permintaan ini selalu menghasilkan cache miss dan secara langsung meruntuhkan database Anda (*Cache Penetration*).
**MITIGASI:** Implementasikan *Negative Caching*. Simpan kebohongan/nilai kosong "NOT_FOUND" dalam *cache* berdurasi pendek (misal 1 menit), agar *request* duplikat langsung dihalau oleh Redis, bukan DB. (Telah diperlihatkan di kode blok utama).

### Edge Case 3: Panicking di dalam `Do()` Callback
Jika *closure* eksekusi DB panik (seperti de-referencing pointer nil), `singleflight` di Go secara *default* akan ikut menyebarkan (propagate) *panic* tersebut ke semua goroutine yang sedang menunggu di *group* yang sama, mengakibatkan *cascading failures* mematikan.
**MITIGASI:** Bungkus seluruh panggilan pihak ke-tiga atau parsers dengan blok `defer func() { recover() }()` atau setidaknya laporkan err di dalam *closure* secara sadar agar singleflight mengembalikan error bersih daripada panic.

### Edge Case 4: Cache Breakdown dari Redis Error
Jika node *Redis* mengalami *network partition*, error koneksi (i/o timeout) akan terus dihasilkan dari method `Get()`. Jika kita mendesain aplikasi yang "Panic saat Redis Down", kiamat kecil terjadi.
**MITIGASI:** Jadikan *cache layer* sebagai penyimpan "best-effort". Kegagalan pada *cache read/write* harus diamati (*logged*), diamankan (swallow error), lalu alihkan rute menuju *fallback* terkuat Anda: `singleflight` lalu ke DB Utama. Degradasi, tetapi operasional.

### Edge Case 5: Kunci Singleflight Self-Lock (Deadlock)
Pernah terjadi: Fungsi `GetUser()` membungkus singleflight key "A". Di dalam closure singleflight tersebut, tanpa sengaja memanggil fungsi lain `GetProfile()` yang ternyata secara internal memanggil ulang `GetUser()` dengan kunci "A". Hal ini akan secara permanen menahan eksekusi singleflight tanpa jalan keluar, menyebabkan Goroutine leak raksasa.
**MITIGASI:** Review ketat linting pada diagram panggil (Call Graph) Anda. Pisahkan antara API Publik dan *internal fetcher func* untuk mencegah rekursi terselubung.

---

## 8. Unit Testing (Memverifikasi Concurrency)

Pengujian adalah segalanya. Kita wajib membuktikan Singleflight bekerja nyata.

```go
package cache_test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2" // In-memory Redis simulasi cepat
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"your_project_module/cache" // import service yang telah didefinisikan
)

func setupTestRedis() *redis.Client {
	mr, err := miniredis.Run()
	if err != nil {
		panic(err)
	}
	return redis.NewClient(&redis.Options{Addr: mr.Addr()})
}

// TEST CASE 1: Memverifikasi Cache Hit Tidak Akan Memanggil DB
func TestUserCacheService_CacheHit(t *testing.T) {
	rdb := setupTestRedis()
	ctx := context.Background()
	
	// Pre-seed Redis Data
	rdb.Set(ctx, "user_entity:101", `{"id":"101","name":"Einstein","role":"Admin"}`, time.Minute)

	var dbHitCounter int32 = 0
	svc := cache.NewUserCacheService(rdb, func(c context.Context, id string) (*cache.User, error) {
		atomic.AddInt32(&dbHitCounter, 1) // Atomik inkremental
		return &cache.User{ID: id, Name: "DB Fallback", Role: "Mortal"}, nil
	})

	user, err := svc.GetUser(ctx, "101")
	assert.NoError(t, err)
	assert.Equal(t, "Einstein", user.Name)
	
	// Verifikasi Kritis: Counter DB harus tetap 0
	assert.Equal(t, int32(0), atomic.LoadInt32(&dbHitCounter), "Database fetcher was illegally called!")
}

// TEST CASE 2: Memverifikasi Singleflight Suppression di Thundering Herd
func TestUserCacheService_Singleflight_Suppression(t *testing.T) {
	rdb := setupTestRedis()
	ctx := context.Background()

	var dbHitCounter int32 = 0
	svc := cache.NewUserCacheService(rdb, func(c context.Context, id string) (*cache.User, error) {
		atomic.AddInt32(&dbHitCounter, 1)
		// Simulasi Blocking I/O DB untuk menahan request lain agar berkumpul
		time.Sleep(100 * time.Millisecond) 
		return &cache.User{ID: id, Name: "Thundering Hero", Role: "Savior"}, nil
	})

	var wg sync.WaitGroup
	requestCount := 500 // Eksekusi 500 goroutine bersamaan!
	
	for i := 0; i < requestCount; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			user, err := svc.GetUser(ctx, "999") // Kunci id yang sama "999"
			assert.NoError(t, err)
			assert.Equal(t, "Thundering Hero", user.Name)
		}()
	}
	wg.Wait()

	// Verifikasi Kritis: Meskipun ada 500 panggilan konkuren, eksekusi Fetch DB HANYA BOLEH 1 KALI.
	assert.Equal(t, int32(1), atomic.LoadInt32(&dbHitCounter), "Singleflight Failed! Database was hammered!")
}

// TEST CASE 3: Memverifikasi Negative Caching bekerja (Mencegah Cache Penetration)
func TestUserCacheService_NegativeCaching(t *testing.T) {
	rdb := setupTestRedis()
	ctx := context.Background()
	
	var dbHitCounter int32 = 0
	svc := cache.NewUserCacheService(rdb, func(c context.Context, id string) (*cache.User, error) {
		atomic.AddInt32(&dbHitCounter, 1)
		return nil, cache.ErrNotFound
	})

	// Panggilan Pertama: Harus Hit DB, menghasilkan ErrNotFound, dan diset menjadi 'NOT_FOUND' di Redis
	user1, err1 := svc.GetUser(ctx, "GHOST-ID")
	assert.ErrorIs(t, err1, cache.ErrNotFound)
	assert.Nil(t, user1)
	assert.Equal(t, int32(1), atomic.LoadInt32(&dbHitCounter))

	// Panggilan Kedua (Setelah Cache diset secara background/synchronous): 
	// Harus Cache Hit berupa "NOT_FOUND" dan TIDAK MEMANGGIL DB.
	user2, err2 := svc.GetUser(ctx, "GHOST-ID")
	assert.ErrorIs(t, err2, cache.ErrNotFound)
	assert.Nil(t, user2)
	assert.Equal(t, int32(1), atomic.LoadInt32(&dbHitCounter), "Database called again on fake ID! Negative caching failed.")
}
```
