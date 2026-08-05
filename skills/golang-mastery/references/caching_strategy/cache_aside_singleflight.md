# Panduan Ekstensif dan Definitif: Arsitektur Cache-Aside, Mitigasi Thundering Herd, dan Penerapan Singleflight di Golang

> **Berlaku:** Go 1.21+ · Redis 7+ · `golang.org/x/sync/singleflight` · **Lihat juga:** `concurrency/singleflight_thundering_herd.md` · `caching_strategy/cache_invalidation_strategies.md` · `caching_strategy/multilevel_cache_l1l2.md` · `db_sqlc/multi_layer_caching.md`

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
	"log/slog"
	"math/rand"
	"runtime/debug"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"
)

// User adalah representasi entitas data.
type User struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
}

// Custom errors
var ErrNotFound = errors.New("record not found")

const penandaTidakAda = "NOT_FOUND"

// UserCacheService membungkus klien Redis, singleflight group, dan logic DB.
type UserCacheService struct {
	redisClient  *redis.Client
	requestGroup singleflight.Group
	fetchFromDB  func(ctx context.Context, id string) (*User, error)
	baseTTL      time.Duration

	// BatasMuat membatasi berapa lama satu pemuatan boleh menahan entri
	// singleflight. Tanpa ini, satu query DB yang menggantung menahan SELURUH
	// pemanggil kunci itu selama query tersebut menggantung -- dan karena
	// pemuatannya sengaja dilepas dari context pemanggil (lihat GetUser),
	// tidak ada satu pun pembatalan klien yang bisa mengakhirinya.
	BatasMuat time.Duration

	// Metrik, bukan log per pemanggil. Lihat catatan pada `shared` di GetUser.
	digabung atomic.Int64
}

// NewUserCacheService inisiasi service caching
func NewUserCacheService(r *redis.Client, dbFn func(ctx context.Context, id string) (*User, error)) *UserCacheService {
	// TIDAK ADA rand.Seed di sini, dan itu disengaja.
	//
	// `rand.Seed` DEPRECATED sejak Go 1.20. Sejak versi itu sumber acak global
	// sudah di-seed secara acak oleh runtime; memanggil rand.Seed justru
	// MEMATIKAN perilaku itu dan mengembalikan generator ke mode lama yang
	// deterministik terhadap seed.
	//
	// Menaruhnya di KONSTRUKTOR menambah satu lapis salah lagi: membuat dua
	// service dalam nanodetik yang sama memberi keduanya seed identik,
	// sehingga jitter TTL keduanya bergerak seiring -- kebalikan persis dari
	// tujuan jitter.
	return &UserCacheService{
		redisClient: r,
		fetchFromDB: dbFn,
		baseTTL:     15 * time.Minute,
		BatasMuat:   5 * time.Second,
	}
}

// JumlahDigabung mengembalikan berapa pemanggil yang hasilnya dipenuhi oleh
// pemuatan milik pemanggil lain. Ini metrik kesehatan singleflight.
func (s *UserCacheService) JumlahDigabung() int64 { return s.digabung.Load() }

// GetUser mengimplementasikan Cache-Aside yang divaksinasi Singleflight.
func (s *UserCacheService) GetUser(ctx context.Context, id string) (*User, error) {
	cacheKey := "user_entity:" + id

	// FASE 1: Inspeksi Cache (Read Redis)
	val, err := s.redisClient.Get(ctx, cacheKey).Result()
	switch {
	case err == nil:
		if val == penandaTidakAda {
			return nil, ErrNotFound
		}
		var user User
		if uErr := json.Unmarshal([]byte(val), &user); uErr == nil {
			return &user, nil // Cache Hit sukses!
		} else {
			// `err` di sini dulu tertukar dengan galat Get yang sudah nil,
			// sehingga peringatannya selalu mencetak "<nil>" dan galat
			// unmarshal yang sebenarnya tidak pernah terlihat.
			slog.WarnContext(ctx, "data cache rusak, jatuh ke sumber asli",
				"key", cacheKey, "galat", uErr)
		}
	case errors.Is(err, redis.Nil):
		// Cache miss biasa. Bukan galat.
		//
		// errors.Is, BUKAN `err != redis.Nil`. go-redis membungkus galat pada
		// beberapa jalur (hook, tracing, cluster), dan perbandingan langsung
		// akan meleset -- membuat cache miss biasa terbaca sebagai kegagalan
		// Redis dan membanjiri log saat trafik normal.
	default:
		// Degradasi Layanan: Redis bermasalah -> catat, lanjut ke DB.
		slog.ErrorContext(ctx, "GET redis gagal, melanjutkan ke sumber asli",
			"key", cacheKey, "galat", err)
	}

	// FASE 2: Cache Miss -> Proteksi Thundering Herd via Singleflight.
	//
	// DoChan, BUKAN Do -- dan context pemuatannya DILEPAS dari context
	// pemanggil. Ini persis mitigasi yang diperintahkan Edge Case 1 di bawah,
	// dan bentuk `Do(key, func(){ fetch(ctx, ...) })` yang lebih sering
	// ditulis melanggarnya dengan cara yang mahal:
	//
	//   Pemanggil PERTAMA yang membatalkan (klien menutup tab, timeout HTTP)
	//   membatalkan pemuatan untuk SEMUA pemanggil yang menumpang. Mereka
	//   menerima context.Canceled yang bukan miliknya, penulisan ke Redis ikut
	//   gagal karena ctx-nya mati, dan gelombang permintaan BERIKUTNYA
	//   menyerbu database lagi. Satu klien yang menyerah menghapus proteksi
	//   stampede untuk seluruh sisanya -- tepat saat proteksi itu dibutuhkan.
	//
	// WithoutCancel mempertahankan nilai context (trace ID, tenant) sambil
	// melepaskan pembatalannya; WithTimeout memastikan pemuatan yang
	// menggantung tidak menahan entri singleflight selamanya.
	ch := s.requestGroup.DoChan(cacheKey, func() (any, error) {
		ctxMuat, batal := context.WithTimeout(context.WithoutCancel(ctx), s.BatasMuat)
		defer batal()
		return s.muat(ctxMuat, cacheKey, id)
	})

	select {
	case <-ctx.Done():
		// HANYA pemanggil INI yang menyerah. Pemuatannya tetap berjalan untuk
		// pemanggil lain, dan hasilnya tetap masuk cache.
		return nil, ctx.Err()
	case res := <-ch:
		if res.Err != nil {
			return nil, res.Err
		}
		if res.Shared {
			// METRIK, bukan log per pemanggil.
			//
			// `log.Printf` di sini -- bentuk yang lebih sering ditulis --
			// menghasilkan satu baris log untuk SETIAP penumpang. Pada
			// stampede 5000 permintaan itu 4999 baris log dalam beberapa
			// milidetik, tepat ketika sistem sedang tertekan dan log pipeline
			// paling tidak sanggup menerimanya. Singleflight yang bekerja
			// dengan baik justru menghasilkan log paling banyak.
			s.digabung.Add(1)
		}
		u, ok := res.Val.(*User)
		if !ok {
			// Comma-ok, bukan `res.Val.(*User)` telanjang. singleflight
			// mengembalikan `any`, dan assertion tanpa comma-ok adalah panic
			// yang menunggu giliran -- di jalur yang dilewati setiap
			// permintaan.
			return nil, fmt.Errorf("tipe hasil singleflight tak terduga: %T", res.Val)
		}
		// SALINAN PER PEMANGGIL. Ini bukan kehati-hatian berlebihan:
		// singleflight secara desain membagikan SATU nilai ke semua penumpang,
		// jadi satu `*User` yang sama dipegang bisa ribuan goroutine. Satu
		// pemanggil yang menulis `u.Name = ...` memutasi apa yang dilihat
		// semua pemanggil lain, dan `go test -race` akan menandainya. Tidak
		// ada dalam tanda tangan `GetUser` yang memberi tahu pemanggil bahwa
		// pointer itu dibagi.
		salinan := *u
		return &salinan, nil
	}
}

// muat mengambil dari sumber asli dan mengisi cache. Dipanggil paling banyak
// sekali per kunci per gelombang, di dalam singleflight.
func (s *UserCacheService) muat(ctx context.Context, cacheKey, id string) (hasil any, err error) {
	// Panic di dalam closure singleflight DISEBARKAN ULANG ke SEMUA goroutine
	// yang menunggu kunci ini -- satu nil pointer dereference menjatuhkan
	// ribuan permintaan sekaligus. Karena itu ia harus ditangkap DI SINI.
	//
	// Catatan penting: `defer func(){ recover() }()` telanjang -- bentuk yang
	// sering disarankan -- justru LEBIH BURUK daripada panic-nya. Ia menelan
	// panik tanpa mengubah apa pun, fungsi mengembalikan nilai nol dengan
	// galat nil, dan setiap penumpang menerima user nil tanpa satu pun tanda
	// bahwa ada yang salah. Recover WAJIB mengubahnya menjadi galat DAN
	// mencatat stack-nya; tanpa stack, satu-satunya petunjuk letak bug hilang.
	defer func() {
		if r := recover(); r != nil {
			slog.ErrorContext(ctx, "panic saat memuat cache",
				"key", cacheKey, "panic", r, "stack", string(debug.Stack()))
			hasil, err = nil, fmt.Errorf("panic saat memuat %s: %v", cacheKey, r)
		}
	}()

	user, dbErr := s.fetchFromDB(ctx, id)
	if dbErr != nil {
		// NEGATIVE CACHING: mencegah cache penetration pada ID yang tidak ada.
		//
		// errors.Is, BUKAN `dbErr == ErrNotFound`. Setiap berkas lain di
		// korpus ini mengajarkan membungkus galat dengan %w
		// (`fmt.Errorf("query user %s: %w", id, ErrNotFound)`) -- dan
		// perbandingan langsung TIDAK PERNAH cocok dengan galat terbungkus.
		// Akibatnya proteksi penetrasi ini diam-diam tidak pernah aktif,
		// justru bila Anda mengikuti anjuran korpus ini sendiri.
		if errors.Is(dbErr, ErrNotFound) {
			if setErr := s.redisClient.Set(ctx, cacheKey, penandaTidakAda, time.Minute).Err(); setErr != nil {
				// Dibuang dengan `_ =` berarti proteksi penetrasi bisa mati
				// tanpa satu pun tanda. Justru penyerang yang membanjiri ID
				// palsulah yang paling mungkin membuat Redis menolak tulisan.
				slog.ErrorContext(ctx, "gagal menulis negative cache; proteksi penetrasi tidak aktif",
					"key", cacheKey, "galat", setErr)
			}
		}
		return nil, dbErr
	}
	if user == nil {
		// fetchFromDB milik pemanggil bisa saja mengembalikan (nil, nil).
		// Tanpa penjaga ini, nil tersebut ikut di-cache dan dibagikan.
		return nil, fmt.Errorf("%w: %s", ErrNotFound, id)
	}

	userBytes, jsonErr := json.Marshal(user)
	if jsonErr != nil {
		return nil, fmt.Errorf("menserialisasi user %s: %w", id, jsonErr)
	}

	if setErr := s.redisClient.Set(ctx, cacheKey, userBytes, s.ttlBerjitter()).Err(); setErr != nil {
		// Gagal menulis cache BUKAN alasan menggagalkan permintaan -- datanya
		// sudah ada. Tapi ia harus terlihat: cache yang tidak pernah terisi
		// berarti setiap permintaan menjadi cache miss, dan gejalanya hanya
		// muncul sebagai beban DB yang tidak turun-turun.
		slog.ErrorContext(ctx, "SET redis gagal; permintaan berikutnya akan tetap miss",
			"key", cacheKey, "galat", setErr)
	}

	return user, nil
}

// ttlBerjitter menambahkan variansi acak ke TTL dasar untuk mencegah Expiry Storm.
func (s *UserCacheService) ttlBerjitter() time.Duration {
	// Variansi 0%–20% dari base TTL. rand.Float64 memakai sumber global yang
	// sudah di-seed acak oleh runtime sejak Go 1.20 -- tidak perlu rand.Seed.
	return s.baseTTL + time.Duration(float64(s.baseTTL)*0.20*rand.Float64())
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

*"Latensi 0 untuk semua request" itu dibeli dengan sesuatu, dan harganya harus disebut.* Pola ini bukan peningkatan gratis atas singleflight — ia menukar **kesegaran** dengan **latensi**, dan menambah dua cara gagal baru:

- **Klien menerima data yang Anda TAHU sudah basi.** Untuk katalog produk, itu wajar. Untuk saldo, batas kredit, atau status izin, itu keputusan yang harus disetujui pemilik domainnya — bukan optimasi yang diam-diam dipasang engineer.
- **Goroutine latar wajib memakai context yang dilepas.** Bila ia mewarisi context permintaan HTTP, ia mati begitu handler-nya balas — sehingga regenerasi tidak pernah selesai, data tetap basi, dan setiap permintaan berikutnya memicu goroutine latar baru yang juga mati. Gejalanya: cache yang tidak pernah segar dan jumlah goroutine yang naik pelan-pelan. Pakai `context.WithoutCancel(ctx)` + `WithTimeout`, sama seperti pada `GetUser`.
- **Regenerasi latar tetap butuh singleflight**, atau setiap permintaan yang melihat data basi menelurkan satu pemuatan sendiri — yaitu stampede yang sama, hanya berpindah ke latar belakang di mana ia tidak terlihat pada latensi p99.

Aturan praktisnya: pakai stale-while-revalidate ketika **menyajikan data lama lebih baik daripada menunggu**, dan hanya untuk data yang batas kebasiannya bisa Anda tuliskan sebagai angka. Bila Anda tidak bisa menjawab "basi berapa detik masih boleh?", pertanyaannya belum siap dijawab dengan pola ini.

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
// Jitter 0–20% dari TTL dasar. Persentase, bukan durasi tetap: TTL 5 menit
// dan TTL 24 jam butuh sebaran yang berbeda, dan angka tetap salah untuk
// salah satunya.
const dasar = 24 * time.Hour
ttl := dasar + time.Duration(float64(dasar)*0.20*rand.Float64())
redisClient.Set(ctx, "user:1", val, ttl)
```

*Ukur sebarannya, jangan pilih angka yang enak dilihat.* Untuk skenario di atas — 1 juta kunci ditulis serentak oleh cron:

```text
sebaran nol           -> 1.000.000 kedaluwarsa dalam 1 detik   (DB mati)
jitter tetap 0–1 jam  -> ~278 kedaluwarsa/detik                (masih memuncak di awal)
jitter 0–20% dari 24j -> tersebar merata di 4,8 jam, ~58/detik (aman)
```

Angka yang harus dibandingkan adalah **kedaluwarsa per detik melawan kapasitas cache-miss hilir Anda**, bukan "apakah jitter-nya terasa cukup besar". Perhatikan juga bahwa jitter di sini hanya menambah, tidak pernah mengurangi — jadi TTL efektif rata-rata menjadi 1,1× dasar, bukan 1×. Bila batas kesegaran datanya keras, kurangi dasarnya.

---

## 7. Edge Cases dan Mitigasi Ekstrem

### Edge Case 1: Pembatalan Context (Context Cancellation) di Singleflight
Misalkan Klien 1 memanggil Singleflight, lalu memutuskan koneksinya (`ctx.Done()`). Namun Goroutine pertama yang menanggung singleflight *belum selesai di DB*. Jika Klien 2 tiba dan "menggantungkan nasibnya" pada Goroutine 1, Klien 2 bisa terperangkap selamanya (atau mendapatkan *error cancelled* yang salah karena yang cancel adalah Klien 1).
**MITIGASI:** Gunakan `DoChan` agar tiap klien punya jalur `select` sendiri, **dan lepaskan context pemuatan dari context pemanggil**. Kode utama di bagian 4 sudah menerapkannya; berikut inti perubahannya berikut satu jebakan yang sering ikut tersalin:

```go
ch := s.requestGroup.DoChan(cacheKey, func() (any, error) {
    // ❌ context.Background() -- yang paling sering ditulis di sini.
    //    Ia memang melepas pembatalan, tapi sekaligus MEMBUANG trace ID,
    //    tenant, dan seluruh nilai context lain, sehingga query yang paling
    //    mahal di sistem Anda justru yang paling sulit dilacak. Ia juga tidak
    //    punya tenggat sama sekali: satu query DB yang menggantung menahan
    //    entri singleflight ini SELAMANYA, dan karena pembatalan sudah
    //    dilepas, tidak ada klien mana pun yang bisa mengakhirinya.
    //
    // ✅ WithoutCancel + WithTimeout (Go 1.21+): nilai context dipertahankan,
    //    pembatalan dilepas, dan pemuatannya tetap punya batas.
    ctxMuat, batal := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
    defer batal()
    return s.muat(ctxMuat, cacheKey, id)
})

select {
case <-ctx.Done():
    return nil, ctx.Err()   // HANYA klien ini yang menyerah
case res := <-ch:
    ...
}
```

Perhatikan apa yang sebenarnya diselamatkan: bukan sekadar galat yang benar untuk klien ke-2, melainkan **proteksi stampede-nya sendiri**. Dengan `Do(key, fn)` yang memakai ctx pemanggil, satu klien yang menutup tab membatalkan pemuatan untuk semuanya — penulisan ke Redis ikut gagal, cache tetap kosong, dan gelombang berikutnya menyerbu database lagi.

### Edge Case 2: Negative Caching (Cache Penetration)
Seorang peretas mengetahui bahwa sistem Anda mem-fetch ke DB jika terjadi *cache miss*. Peretas secara berulang meminta `/users/fake-id-999` yang tidak pernah ada di DB. Permintaan ini selalu menghasilkan cache miss dan secara langsung meruntuhkan database Anda (*Cache Penetration*).
**MITIGASI:** Implementasikan *Negative Caching*. Simpan kebohongan/nilai kosong "NOT_FOUND" dalam *cache* berdurasi pendek (misal 1 menit), agar *request* duplikat langsung dihalau oleh Redis, bukan DB. (Telah diperlihatkan di kode blok utama).

### Edge Case 3: Panicking di dalam `Do()` Callback
Jika *closure* eksekusi DB panik (seperti de-referencing pointer nil), `singleflight` di Go secara *default* akan ikut menyebarkan (propagate) *panic* tersebut ke semua goroutine yang sedang menunggu di *group* yang sama, mengakibatkan *cascading failures* mematikan.
**MITIGASI:** Tangkap panik **di dalam** closure dan **ubah menjadi galat** — lihat `muat()` di bagian 4.

Satu peringatan tentang mitigasi yang sering disarankan: **`defer func() { recover() }()` telanjang justru lebih buruk daripada panik itu sendiri.** Ia menelan panik tanpa mengubah apa pun; fungsi lalu mengembalikan nilai nol dengan galat `nil`, singleflight membagikan `nil` itu ke seluruh penumpang, dan setiap klien menerima data kosong yang terlihat sah. Panik yang jatuh setidaknya terlihat; panik yang ditelan berubah menjadi data hilang tanpa satu pun tanda.

Recover di jalur ini **wajib** melakukan tiga hal:
```go
defer func() {
    if r := recover(); r != nil {
        slog.ErrorContext(ctx, "panic saat memuat cache",
            "key", cacheKey, "panic", r, "stack", string(debug.Stack()))  // 1. stack
        hasil, err = nil, fmt.Errorf("panic saat memuat %s: %v", cacheKey, r)  // 2. jadi galat
    }
}()
```
Nomor 3 adalah syarat bahasanya: fungsi itu **harus memakai named return values**, atau nilai yang di-set di dalam `recover` tidak akan pernah sampai ke pemanggil.

Tanpa `debug.Stack()`, yang tersisa hanyalah pesan panik tanpa satu nama fungsi pun — dan panik di dalam closure caching hampir selalu berasal dari lapisan yang lebih dalam (driver, parser, mapper), bukan dari baris yang terlihat.

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
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2" // In-memory Redis simulasi cepat
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"your_project_module/cache" // import service yang telah didefinisikan
)

func setupTestRedis(t *testing.T) *redis.Client {
	t.Helper()
	// RunT, bukan Run. `miniredis.Run()` tanpa Close meninggalkan satu server
	// beserta goroutine listener-nya hidup untuk SETIAP uji -- pada suite yang
	// besar itu ratusan server yang menumpuk sampai proses uji berakhir.
	// RunT mendaftarkan pembersihannya lewat t.Cleanup.
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	return rdb
}

// TEST CASE 1: Memverifikasi Cache Hit Tidak Akan Memanggil DB
func TestUserCacheService_CacheHit(t *testing.T) {
	rdb := setupTestRedis(t)
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
	rdb := setupTestRedis(t)
	ctx := context.Background()

	var dbHitCounter int32
	svc := cache.NewUserCacheService(rdb, func(c context.Context, id string) (*cache.User, error) {
		atomic.AddInt32(&dbHitCounter, 1)
		// Simulasi Blocking I/O DB untuk menahan request lain agar berkumpul
		time.Sleep(100 * time.Millisecond)
		return &cache.User{ID: id, Name: "Thundering Hero", Role: "Savior"}, nil
	})

	// Gerbang start: tanpa ini, 500 goroutine dijadwalkan berangsur-angsur dan
	// sebagian bisa tiba SETELAH pemuatan pertama selesai -- lalu lolos lewat
	// cache, bukan lewat singleflight. Ujinya tetap hijau, tapi yang terbukti
	// bukan yang dimaksud.
	gerbang := make(chan struct{})
	var wg sync.WaitGroup
	const requestCount = 500

	for i := 0; i < requestCount; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-gerbang
			user, err := svc.GetUser(ctx, "999") // Kunci id yang sama "999"
			// assert (bukan require) memang benar di dalam goroutine:
			// require memanggil t.FailNow, dan t.FailNow dari goroutine
			// selain goroutine uji adalah pemakaian terlarang.
			if assert.NoError(t, err) {
				assert.Equal(t, "Thundering Hero", user.Name)
			}
		}()
	}
	close(gerbang)
	wg.Wait()

	// Verifikasi Kritis: Meskipun ada 500 panggilan konkuren, eksekusi Fetch DB HANYA BOLEH 1 KALI.
	assert.Equal(t, int32(1), atomic.LoadInt32(&dbHitCounter), "Singleflight gagal! Database dihajar!")
	// Dan buktikan penekanannya benar-benar terjadi -- bukan sekadar semua
	// pemanggil kebetulan mendapat cache hit.
	assert.Greater(t, svc.JumlahDigabung(), int64(0), "tidak ada satu pun pemanggil yang digabung")
}

// TEST CASE 2b: Pembatalan oleh SATU pemanggil tidak boleh menjatuhkan yang lain.
//
// Inilah uji yang membuktikan perbedaan antara `Do(key, fn(ctx))` dan
// `DoChan` + context yang dilepas. Dengan bentuk lama, pemanggil kedua
// menerima context.Canceled yang bukan miliknya dan cache tetap kosong.
func TestUserCacheService_PembatalanSatuKlienTidakMenularkanKegagalan(t *testing.T) {
	rdb := setupTestRedis(t)

	mulai := make(chan struct{})
	var dbHits int32
	svc := cache.NewUserCacheService(rdb, func(c context.Context, id string) (*cache.User, error) {
		if atomic.AddInt32(&dbHits, 1) == 1 {
			close(mulai)
		}
		time.Sleep(150 * time.Millisecond)
		return &cache.User{ID: id, Name: "Selamat", Role: "User"}, nil
	})

	ctxPertama, batal := context.WithCancel(context.Background())
	go func() {
		_, _ = svc.GetUser(ctxPertama, "777")
	}()
	<-mulai // pemuatan sudah berjalan

	// Pemanggil kedua menumpang pemuatan yang sama.
	hasil := make(chan error, 1)
	go func() {
		_, err := svc.GetUser(context.Background(), "777")
		hasil <- err
	}()

	time.Sleep(20 * time.Millisecond)
	batal() // klien pertama menutup koneksinya

	select {
	case err := <-hasil:
		assert.NoError(t, err, "pembatalan klien pertama menular ke klien kedua")
	case <-time.After(2 * time.Second):
		t.Fatal("klien kedua tidak pernah mendapat hasil")
	}

	// Cache wajib terisi meski klien pertama pergi -- kalau tidak, gelombang
	// permintaan berikutnya menyerbu DB lagi.
	assert.Equal(t, int32(1), atomic.LoadInt32(&dbHits))
	_, err := svc.GetUser(context.Background(), "777")
	assert.NoError(t, err)
	assert.Equal(t, int32(1), atomic.LoadInt32(&dbHits), "cache tidak terisi; proteksi stampede hilang")
}

// TEST CASE 2c: Hasil singleflight dibagikan, jadi setiap pemanggil wajib
// menerima SALINANNYA SENDIRI. Jalankan dengan -race.
func TestUserCacheService_HasilTidakDibagiSebagaiPointerSama(t *testing.T) {
	rdb := setupTestRedis(t)
	svc := cache.NewUserCacheService(rdb, func(c context.Context, id string) (*cache.User, error) {
		time.Sleep(50 * time.Millisecond)
		return &cache.User{ID: id, Name: "Asli", Role: "User"}, nil
	})

	gerbang := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			<-gerbang
			u, err := svc.GetUser(context.Background(), "555")
			if !assert.NoError(t, err) {
				return
			}
			// Setiap pemanggil memutasi salinannya. Bila pointer-nya dibagi,
			// -race menandainya dan assersi di bawah gagal.
			u.Name = fmt.Sprintf("pemanggil-%d", n)
			assert.Equal(t, fmt.Sprintf("pemanggil-%d", n), u.Name)
		}(i)
	}
	close(gerbang)
	wg.Wait()
}

// TEST CASE 3: Memverifikasi Negative Caching bekerja (Mencegah Cache Penetration)
func TestUserCacheService_NegativeCaching(t *testing.T) {
	rdb := setupTestRedis(t)
	ctx := context.Background()

	var dbHitCounter int32
	svc := cache.NewUserCacheService(rdb, func(c context.Context, id string) (*cache.User, error) {
		atomic.AddInt32(&dbHitCounter, 1)
		// Galat DIBUNGKUS -- persis seperti yang diajarkan seluruh korpus ini.
		// Dengan perbandingan `dbErr == ErrNotFound`, bentuk terbungkus ini
		// TIDAK PERNAH cocok dan negative caching diam-diam tidak aktif.
		// Uji lama memakai sentinel telanjang, sehingga tidak pernah
		// menyentuh cacat itu.
		return nil, fmt.Errorf("query user %s: %w", id, cache.ErrNotFound)
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

## Kapan JANGAN Pakai Ini

- **Untuk data yang harus konsisten seketika.** Selalu ada jendela antara penulisan ke database dan invalidasi cache di mana pembaca menerima nilai lama. Bila jendela itu tidak bisa diterima, cache-aside bukan polanya.
- **Menulis ke cache dari jalur tulis tanpa memikirkan urutan.** Dua penulis serentak bisa meninggalkan nilai **lama** di cache secara permanen: penulis lambat menyimpan hasil bacaan lamanya setelah penulis cepat selesai. Butuh versi atau invalidasi, bukan penulisan langsung.
- **Menyimpan hasil galat di cache.** Satu kegagalan sementara akan disajikan berulang selama TTL, mengubah gangguan lima detik menjadi gangguan lima menit.
- **Singleflight sebagai perlindungan stampede lintas pod.** Ia hanya menggabungkan di dalam satu proses — lihat `concurrency/singleflight_thundering_herd.md`.
- **Tanpa memikirkan apa yang terjadi saat Redis mati.** Bila kode langsung gagal ketika cache tidak terjangkau, Anda menambahkan satu titik kegagalan baru alih-alih mengurangi beban. Cache yang tidak terjangkau harus berarti "lambat", bukan "gagal".

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Layanan mati saat Redis bermasalah | penanganan galat cache | Cache jadi dependensi keras, bukan optimasi |
| Nilai lama bertahan meski data sudah berubah | urutan tulis dan invalidasi | Penulisan cache dari jalur tulis tanpa versi |
| Galat yang sama disajikan berulang | apakah galat ikut di-cache | Hasil gagal tersimpan di cache |
| Lonjakan database di detik yang sama tiap jam | keseragaman TTL | Semua kunci kedaluwarsa bersamaan |
| Hit rate tinggi tapi beban DB tetap | apa yang di-cache | Yang di-cache bukan query yang mahal |

```bash
redis-cli info stats | grep -E 'keyspace_hits|keyspace_misses|expired_keys|evicted_keys'

# Sebaran TTL sisa: menumpuk di satu nilai berarti jitter belum dipasang
for k in $(redis-cli --scan --pattern 'produk:*' | head -200); do redis-cli ttl "$k"; done \
  | sort -n | uniq -c | tail -10

# Apakah layanan tetap hidup tanpa cache? Uji ini WAJIB dilakukan sebelum insiden.
redis-cli client pause 5000   # di staging, bukan produksi
```
