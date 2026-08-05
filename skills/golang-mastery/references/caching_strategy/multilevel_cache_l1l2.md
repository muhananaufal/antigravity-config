# Multilevel Caching (L1/L2) di Golang: Arsitektur, Implementasi, dan Praktik Produksi

> **Berlaku:** Go 1.21+ · Redis 7+ · **Lihat juga:** `caching_strategy/cache_aside_singleflight.md` · `caching_strategy/cache_invalidation_strategies.md` · `db_sqlc/multi_layer_caching.md` · `runtime_internals/gc_mark_sweep_internals.md`

## 1. Konsep Mendalam & Arsitektur Multilevel Cache

Dalam rekayasa sistem terdistribusi modern dengan beban baca yang luar biasa tinggi (read-heavy), pangkalan data SQL (PostgreSQL, MySQL) sering kali menjadi rintangan utama kinerja (bottleneck). Untuk mengatasi ini, *caching* (penyanggaan) adalah praktik standar. Namun, menggunakan memori bersama (distributed cache) seperti Redis saja terkadang tidak cukup karena masih terdapat latensi jaringan (network hop), biaya koneksi TCP, serta biaya overhead serialisasi dan deserialisasi JSON/Protobuf. 

Multilevel Cache mengadopsi prinsip yang mirip dengan cara kerja unit pemroses sentral (CPU) di dalam komputer Anda (L1/L2/L3 CPU cache), di mana cache terdekat dengan *processing unit* berukuran kecil namun memiliki latensi ultra-rendah.

Di arsitektur *backend* Golang, ini diterjemahkan menjadi:
- **L1 Cache (In-Process / In-Memory Cache):** Disimpan di dalam `heap` memori dari aplikasi Golang itu sendiri (di dalam Pod/Container). Akses ke sini tidak memerlukan perpindahan jaringan (0 milidetik latensi). Biaya CPU sangat rendah.
- **L2 Cache (Distributed Cache):** Sistem penyangga eksternal berkecepatan tinggi seperti Redis atau Memcached. Menawarkan penyimpanan yang jauh lebih besar dan bertindak sebagai tempat berbagi status penyangga antar puluhan atau ratusan instance/Pod aplikasi.
- **L3 / Source of Truth (Database):** Penyimpanan persisten (database).

### Latency Numbers Every Programmer Should Know (Referensi Kasar)
- L1 (Go in-memory struct read): **~50 ns - 100 ns**
- L2 (Redis via local network): **~500,000 ns (0.5 ms) - 2 ms**
- DB (PostgreSQL query di network yang sama): **~5,000,000 ns (5 ms) - 50 ms**

Dengan menambahkan lapis L1, jika *cache hit ratio* mencapai 80-90% pada L1, maka kita mampu menyelamatkan 80-90% trafik dari latensi jaringan dan tekanan I/O serialisasi Redis.

### Diagram ASCII: L1/L2/L3 Hierarchy dengan Hit/Miss Flow

Berikut adalah arsitektur aliran data sistem Caching Hierarkis (L1/L2/L3):

```text
               +-----------------------------+
               |  Request dari Client (API)  |
               +-----------------------------+
                              |
                              v
+===========================================================+
|                      POD APLIKASI GO                      |
|                                                           |
| 1. Periksa L1 (In-Memory)                                 |
| +-------------------------------------------------------+ |
| | L1 CACHE (Ristretto/BigCache)                         | |
| | - [ HIT ] -> Kembalikan struct Go secara langsung!    | |
| | - [ MISS ] -> Lanjut ke L2 Cache                      | |
| +-------------------------------------------------------+ |
|                             |                             |
|                             | (Pub/Sub Subscriber)        |
+=============================|=============================+
                              | (Network Hop)
                              v
+===========================================================+
|                     REDIS CLUSTER                         |
|                                                           |
| 2. Periksa L2 (Redis Distributed Cache)                   |
| +-------------------------------------------------------+ |
| | REDIS CACHE (go-redis/v9)                             | |
| | - [ HIT ] -> Deserialisasi (JSON) -> Simpan di L1     | |
| |              lalu kembalikan ke Klien.                | |
| | - [ MISS ] -> Lanjut ambil ke Database (L3)           | |
| +-------------------------------------------------------+ |
|                             |                             |
|                             | (Pub/Sub Publisher)         |
+=============================|=============================+
                              |
                              v
+===========================================================+
|              DATABASE (SOURCE OF TRUTH / L3)              |
|                                                           |
| 3. Ambil dari DB                                          |
| +-------------------------------------------------------+ |
| | POSTGRESQL / MYSQL                                    | |
| | - Jalankan kueri SELECT.                              | |
| | - [ SUCCESS ] -> Populate/Isi L2 Cache -> Isi L1      | |
| |                  Cache -> Kembalikan ke Klien.        | |
| +-------------------------------------------------------+ |
+===========================================================+
```


## 2. L1 (In-Process): Pemilihan Engine Cache pada Go

Mengapa kita tidak boleh hanya menggunakan struktur data primitif seperti `map[string]interface{}` + `sync.RWMutex`? Jawabannya adalah **Garbage Collector (GC) Overhead**. Di Golang, GC bekerja secara periodik (*Stop-the-World pause* walau sangat singkat) dengan memindai (scan) *seluruh* objek bertipe `pointer` di `heap`. Jika sebuah cache *map* memiliki 10 juta *entry* berupa pointer, fase pemindaian GC (*mark and sweep*) bisa sangat membebani CPU, bahkan hingga menurunkan performa ratusan kali lipat.

Oleh karena itu, diperlukan library caching berkinerja tinggi:

1. **Ristretto (dgraph-io/ristretto):**
   - **Kelebihan:** Menggunakan algoritma *eviction* canggih yang disebut **TinyLFU**. TinyLFU melacak riwayat seberapa sering elemen diakses (frekuensi) menggunakan estimasi hemat memori (Count-Min Sketch), memastikan elemen terpopuler selalu berada di cache. Ristretto mengalokasikan proses metrik eviksi ke *goroutine background* agar penulisan cache (*Set*) sangat cepat dan non-blocking (asynchronous buffer).
   - **Kekurangan:** Jika menyimpan objek Go asli, GC tetap akan memindainya. Terbaik digunakan saat rasio *hit* adalah yang paling penting dan jumlah data memori diset terbatas (MaxCost).
   - **Karakteristik:** Sangat cocok untuk cache metadata, API responses berukuran sedang.

2. **BigCache (allegro/bigcache):**
   - **Kelebihan:** Sepenuhnya **GC-Friendly**. BigCache menghindari pemindaian GC sepenuhnya dengan tidak menyimpan obyek sebagai *pointer* dalam map. Ia menyimpannya sebagai satu blok data primitif `[]byte` dalam sebuah ring buffer pracetak (*pre-allocated*). GC Go tidak memindai byte murni. Selain itu menggunakan prinsip *Sharding* berbasis kunci *hash* untuk menghindari perebutan *mutex* (lock contention).
   - **Kekurangan:** Harus me-marshal (encode) struktur golang menjadi *byte* ketika menyimpan, dan me-unmarshal saat membaca. Tidak mendukung eviksi berdasar frekuensi secerdas Ristretto, sebagian besar eviksi berjalan berdasarkan FIFO/waktu TTL.

3. **FreeCache (coocood/freecache):**
   - **Kelebihan:** Seperti BigCache, bebas GC (zero GC overhead). Menggunakan metode segmentasi ring buffer dengan penegakan algoritma LFU (Least Frequently Used).
   - **Kekurangan:** Lebih lambat pada skenario *write-heavy* ekstrim dibanding BigCache.

## 3. L2 (Redis): go-redis/v9 dan Connection Pool Tuning

`go-redis` adalah client Redis paling dominan. Untuk skala *production*, mengonfigurasi opsi klien (client options) adalah kewajiban absolut agar layanan Anda kebal dari lonjakan beban dan tidak secara tak sengaja membunuh server Redis karena memuntahkan ratusan ribu koneksi TCP idle secara brutal.

```go
redisClient := redis.NewClient(&redis.Options{
    Addr:         "localhost:6379",
    Password:     "",
    DB:           0,

    // [KRITIKAL] Connection Pool Tuning:
    PoolSize:     200,             // Kapasitas koneksi maksimum (soket TCP)
    MinIdleConns: 20,              // Memastikan setidaknya ada koneksi siap sedia untuk latensi yang konsisten
    ConnMaxIdleTime: 10 * time.Minute, // Singkirkan koneksi yang menganggur/mati secara pasif
    ConnMaxLifetime: 1 * time.Hour,    // Re-koneksi paksa untuk mencegah koneksi zombie (TCP half-open state)
    DialTimeout:  1 * time.Second, // Timeout ekstrim agar saat Redis macet, aplikasi tidak ikut terkunci/hang.
    ReadTimeout:  500 * time.Millisecond,
    WriteTimeout: 500 * time.Millisecond,
})
```

## 4. Cache Size Estimation & Monitoring Tekanan Memori

Pengembang sering membuat kesalahan mengasumsikan kapasitas Cache dihitung dalam "Jumlah Item" (contoh: *limit 10.000 entry*). Ini berbahaya. Jika 1 entry berukuran 5 MB (respon JSON raksasa), 10.000 item akan memakan **50 GB** RAM, yang membuat *Pod* Kubernetes hancur (OOM Killed).

### Ristretto MaxCost 
Ristretto menawarkan abstraksi cerdas menggunakan `MaxCost` (biaya maksimum ruang memori) dan parameter fungsi `SetWithTTL(key, value, cost, ttl)`.

- Jika ukuran setiap *cache entry* dapat bervariasi, kita bisa menetapkan ukuran JSON ter-encode sebagai *Cost*. 
- `MaxCost` mematok batas memori total. Jika mendekati ambang batas, TinyLFU akan membuang (evict) data terburuk (jarang diakses).

*Monitor Memory Pressure:* Wajib perhatikan metrik `runtime.MemStats.Alloc` dan `runtime.MemStats.Sys` menggunakan Prometheus middleware agar batas alokasi Ristretto tidak melampaui batasan CGroup/Limit Pod Docker Anda.

## 5. Implementasi L1 Invalidation di Multi-Instance (Redis Pub/Sub)

Dalam Microservices di Kubernetes, jika kita melebarkan aplikasi ke 5 Pod (Pod A, B, C, D, E), setiap Pod memegang salinan L1 cache di memorinya masing-masing. Jika `Pod A` menerima permintaan *Update Profil Pengguna*, `Pod A` akan membilas L2 (Redis) dan Database. TAPI `Pod B-E` TIDAK tahu profil diubah.

Hasilnya: Pengguna mendapat inkonsistensi data ketika Load Balancer melempar *Read Request* ke Pod C (stale data dari L1 pod C).

**Mekanisme Broadcast Invalidation via Pub/Sub:**
1. Pod A memodifikasi data.
2. Pod A mengirim instruksi Hapus (`DEL`) kunci (key) profil ke Redis L2.
3. Pod A mem-`PUBLISH` pesan "Kunci `user:99` diubah" ke kanal Redis Pub/Sub.
4. Pod A, B, C, D, E semuanya `SUBSCRIBE` pada kanal ini (di goroutine independen).
5. Pod A, B, C, D, E menerima event tersebut dan secara agresif menghapus `user:99` di L1 internalnya.

## 6. Produksi-Ready Go Code (Arsitektur Utuh Multilevel Cache)

```go
package multilevelcache

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/dgraph-io/ristretto"
	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"
)

const ChannelInvalidation = "cache:invalidations:v1"

type MultilevelCache struct {
	l1       *ristretto.Cache
	l2       *redis.Client
	pubsub   *redis.PubSub
	sgGroup  singleflight.Group
}

func NewMultilevelCache(l2Client *redis.Client) (*MultilevelCache, error) {
	// Konfigurasi Ristretto berfokus pada Memory Bound dan TinyLFU hit ratio.
	// Asumsi Max Cost: 256MB di RAM Pod.
	cache, err := ristretto.NewCache(&ristretto.Config{
		NumCounters: 1e7,     // Kapasitas jejak TinyLFU untuk kalkulasi rasio hit/miss (disarankan: 10x jumlah max item)
		MaxCost:     256 * 1024 * 1024, // 256 MB maksimum ukuran bobot memori L1
		BufferItems: 64,      // Penyesuaian performa goroutine internal Ristretto (default baik)
	})
	if err != nil {
		return nil, fmt.Errorf("gagal inisialisasi ristretto: %w", err)
	}

	mlc := &MultilevelCache{
		l1: cache,
		l2: l2Client,
	}

	mlc.startInvalidationSubscriber()
	return mlc, nil
}

// Menjalankan goroutine listener yang abadi untuk menerima broadcast PubSub dari pod manapun.
func (m *MultilevelCache) startInvalidationSubscriber() {
	m.pubsub = m.l2.Subscribe(context.Background(), ChannelInvalidation)
	go func() {
		ch := m.pubsub.Channel()
		for msg := range ch {
			invalidationKey := msg.Payload
			m.l1.Del(invalidationKey)
			log.Printf("[MultilevelCache] Menerima broadcast evict untuk kunci: %s", invalidationKey)
		}
	}()
}

// Get Data via Cache L1 -> L2 -> Fetcher(DB) dengan Singleflight Stampede Protection
func (m *MultilevelCache) Get(ctx context.Context, key string, l1TTL, l2TTL time.Duration, fetcher func() (interface{}, error)) (interface{}, error) {
	// 1. Cek L1
	if val, ok := m.l1.Get(key); ok {
		return val, nil // Ultra cepat, 50ns
	}

	// Gunakan SingleFlight untuk memastikan bahwa meski 10,000 goroutine cache miss bersamaan, 
	// fungsi L2/L3-fetch hanya dijalankan SATU kali saja, sementara sisanya menunggu.
	result, err, _ := m.sgGroup.Do(key, func() (interface{}, error) {
		// 2. Cek L2
		valStr, redisErr := m.l2.Get(ctx, key).Result()
		if redisErr == nil {
			var data interface{}
			if errUnmarshal := json.Unmarshal([]byte(valStr), &data); errUnmarshal == nil {
				// Hit L2! Set ke L1 lalu kembali
				m.l1.SetWithTTL(key, data, 1, l1TTL)
				return data, nil
			}
		} else if redisErr != redis.Nil {
			// Jika L2 rusak (koneksi mati), catat error dan lanjut secara gracefully degraded.
			log.Printf("L2 Cache Redis error (graceful degradation): %v", redisErr)
		}

		// 3. Fetch L3 (Database) karena L2 Miss
		data, fetchErr := fetcher()
		if fetchErr != nil {
			return nil, fetchErr
		}

		// Encode struktur ke json
		bytesData, _ := json.Marshal(data)

		// 4. Update L2 (Redis)
		m.l2.Set(ctx, key, bytesData, l2TTL)

		// 5. Update L1
		// Hitung bobot ukuran json mentahnya agar limit Cost L1 akurat
		cost := int64(len(bytesData))
		m.l1.SetWithTTL(key, data, cost, l1TTL)

		return data, nil
	})

	if err != nil {
		return nil, err
	}
	return result, nil
}

// Invalidate membilas data di L2 dan mem-broadcast pesan hapus ke PubSub (memicu semua instance Pod membersihkan L1)
func (m *MultilevelCache) Invalidate(ctx context.Context, key string) error {
	pipe := m.l2.TxPipeline()
	// Gunakan pipeline untuk atomic command
	pipe.Del(ctx, key)
	pipe.Publish(ctx, ChannelInvalidation, key)
	
	_, err := pipe.Exec(ctx)
	if err != nil {
		return fmt.Errorf("gagal mengeksekusi invalidation pipeline: %w", err)
	}

	// Opsional secara proaktif hapus pod sendiri
	m.l1.Del(key)
	return nil
}

func (m *MultilevelCache) Close() {
	if m.pubsub != nil {
		m.pubsub.Close()
	}
	m.l1.Close()
}
```

## 7. Anti-Patterns Caching pada Sistem Golang

### Anti-Pattern 1: L1 Tanpa Batasan (Limit/Size & TTL) Memancing OOM Kubernetes

**Masalah:** Menggunakan native golang map dengan asumsi "Go akan men-GC saat memori penuh". Ini tidak benar; Golang GC hanya membuang objek tanpa *reference* dari heap. Objek di dalam map cache akan hidup selamanya sebagai referensi kuat, menumpuk sampai OOM-Killed OS melibas pod aplikasi.

❌ **BAD:**
```go
// Memori bocor kronis (Stale data & OOM Trap)
var cacheMap = make(map[string]interface{})
var mu sync.RWMutex

func BadSet(key string, val interface{}) {
    mu.Lock()
    defer mu.Unlock()
    cacheMap[key] = val // Tidak ada TTL, Tidak ada Batasan Ukuran!
}
```

✅ **GOOD:** Gunakan lib standar (Ristretto/BigCache) dengan MaxCost ketat & selalu implementasikan Time-To-Live.
```go
cache, _ := ristretto.NewCache(&ristretto.Config{
    NumCounters: 1e7,
    MaxCost:     100 * 1024 * 1024, // Dibatasi 100MB
    BufferItems: 64,
})
// Data punya batas hidup maksimum
cache.SetWithTTL("k", data, 1, 5 * time.Minute)
```

### Anti-Pattern 2: Caching Stampede Tanpa Mutex Grouping (SingleFlight)

**Masalah:** Bayangkan kunci cache bernama "viral_homepage_feed" kedaluwarsa dari redis di detik 0.00. Di saat bersamaan ada 10.000 user merefresh halaman. Fungsi `Get` di atas akan *miss* di cache untuk ke-10,000 goroutine tersebut, mengakibatkan DB ditembaki dengan 10.000 query duplikat secara paralel yang seketika mencekik CPU Database hingga 100%. Fenomena ini disebut **Cache Stampede / Thundering Herd**.

❌ **BAD:**
```go
func GetFeed() (*Feed, error) {
    if hit := L2Get("viral_homepage"); hit != nil {
        return hit, nil
    }
    // BOM! 10.000 goroutine melewati kondisi miss dan menembak fungsi fetch ke DB
    return queryDatabaseFeed()
}
```

✅ **GOOD:** Gunakan mekanisme golang singleflight `golang.org/x/sync/singleflight` untuk mengunci dan menduplikasi *return value* ke semua penelpon duplikat. (Sudah diimplementasikan di kode Produksi-Ready `m.sgGroup.Do(...)` di atas).

### Anti-Pattern 3: In-Memory (L1) Shared Pointer Mutation (Data Corruption)

**Masalah:** L1 Cache (seperti Ristretto) seringkali mengembalikan struktur dalam bentuk alamat *Pointer* (`*User`). Jika goroutine A dan goroutine B menerima *Pointer* obyek `User` dari `Get()`, dan goroutine A tak sengaja (karena logic bisnis salah) mengubah salah satu atribut (e.g. `user.Name = "Modif"`), goroutine B seketika akan terimbas datanya karena mereka memegang pointer memori yang persis sama. Ini menyebabkan *Race Condition / Data Corruption*.

❌ **BAD:**
```go
userPointer := mlc.Get("user_1").(*User) 
// TIDAK SENGAJA MEMODIFIKASI POINTER REFERENSI DARI CACHE L1!
userPointer.Role = "ADMIN_SEMENTARA_UNTUK_LOGIC_VIEW_AJA" 
// SEMUA HTTP REQUEST SELANJUTNYA MELIHAT OBJEK INI SEBAGAI ADMIN!
```

✅ **GOOD:** Pastikan cache me-return obyek *By Value* atau lakukan *Deep Copy* saat menarik objek struktur sensitif, atau ubah struktur aplikasi Anda menjadi sepenuhnya imutabel (immutable). Alternatif lain, simpan payload di L1 sebagai serialized `[]byte` (seperti desain `BigCache`).


## 8. Edge Cases Arsitektur Cache dan Solusinya

Berikut adalah daftar anomali ekstrim di production saat menerapkan Multilevel Cache dan cara memitigasinya:

1. **L1 Out-of-sync antar pod setelah Pub/Sub Terputus (Redis Network Partition)**
   - *Situasi:* Pod B sedang terputus sementara dari Redis saat invalidation diterbitkan. Koneksi Pub/Sub terlempar. Saat Pod B kembali aktif tersambung ke Redis, Pod B melewatkan (miss) sinyal event bahwa objek ID 22 sudah usang. L1 pod B menahan data usang selamanya.
   - *Mitigasi:* Inilah alasan utama bahwa L1 **TIDAK BOLEH BERUMUR PANJANG (No Eternal TTL)**. Selalu tetapkan batas atas asuransi *TTL* yang pendek untuk L1 (Misalnya L2 bertahan 2 jam, L1 bertahan 2 menit maksimal). Pub/Sub dipakai untuk flush secara instan, TTL pendek dipakai untuk merajut (*eventual consistency fallback*) seandainya PubSub macet.

2. **Cache Warm-Up Spikes pada Pod Restart Massal**
   - *Situasi:* Saat fase deploy baru di Kubernetes, seluruh instance versi lama di-shut down, pod versi baru naik dan L1 *completely cold* (kosong). Load balancer melemparkan ribuan trafik per detik ke pod yang kosong ini dan membanjiri antrean TCP ke L2 Redis, membuat delay response membengkak.
   - *Mitigasi:* Tambahkan rutin *Warm-Up* saat `InitContainer` atau dalam siklus start awal `main.go`. Aplikasi harus mengambil serangkaian N kunci global (*hot keys*) dari DB atau Redis dan secara proaktif menginisialisasi L1 cache *sebelum* membuka port HTTP ke Load Balancer (Health Probe/Readiness delay).

3. **Penundaan Menulis Buffer (Asynchronous Writethrough) pada Ristretto**
   - *Situasi:* Ristretto mendesain *Set()* agar sangat mulus/fast dan bersifat asinkron untuk melindungi penulisan cache dari antrian panjang lock. Namun hal ini berarti sebuah kunci belum tentu instan terakses setelah fungsi `Set()` mengembalikan proses. Di Unit Test atau aplikasi yang menuntut konsistensi absolut instan (sepersekian milidetik), ini bisa berujung anomali sesaat (Phantom Reads).
   - *Mitigasi:* Jangan harapkan jaminan transaksional murni (ACID) pada cache in-memory yang *eventually consistent*. 

4. **Dogpile Effect pada Akhir TTL (Jittering)**
   - *Situasi:* Sebuah kunci dengan beban berat dan diakses sangat masif (*contoh: API flash sale global setting*). Disetel punya TTL 60 menit secara pasti. Tepat pada menit 60:00, seluruh ratusan pod secara serempak kehilangan data ini dari L1 dan L2 (Expire time presisi), menciptakan tsunami kecil pada database.
   - *Mitigasi:* Tambahkan **TTL Jitter** (Randomisasi Acak). Jangan patok persis 60 Menit. Setiap pod menambahkan variasi rand(1 hingga 60 detik) untuk durasi TTL nya, sehingga waktu matinya akan terpencar dan melandai (staggered eviction). L1 pod 1 expire di menit 60, pod 2 expire di menit 61, memecah puncak letusan.

5. **Payload Besar yang Berbahaya untuk Serialisasi**
   - *Situasi:* Menyimpan payload 10 MB list JSON respon pada L1 dan L2.
   - *Mitigasi:* Jangan pernah simpan data sebesar itu di L2 Redis tanpa dikompresi (GZip/Snappy). Gunakan middleware kompresi Golang saat memarshal dari/ke L2. Biaya CPU kompresi di server Go jauh lebih murah dibandingkan biaya jaringan memindahkan 10MB payload bolak-balik dari Redis.

## 9. Unit Testing Mendalam

Berikut adalah Unit Test Golang komprehensif. Penggunaan `miniredis` di sini mensimulasikan redis secara akurat pada *in-memory runtime* murni Golang sehingga tidak memerlukan container docker redis pihak ketiga ketika `go test` dijalankan di lingkungan CI/CD pipeline Anda.

```go
package multilevelcache_test

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"myapp/multilevelcache" // Sesuaikan dengan package import anda
)

// Helper setup 
func setupTestEnvironment(t *testing.T) (*multilevelcache.MultilevelCache, *miniredis.Miniredis) {
	mr, err := miniredis.Run()
	require.NoError(t, err)

	opts := &redis.Options{Addr: mr.Addr()}
	rdb := redis.NewClient(opts)

	mlc, err := multilevelcache.NewMultilevelCache(rdb)
	require.NoError(t, err)

	return mlc, mr
}

func TestMultilevelCache_HitMissHierarchy(t *testing.T) {
	mlc, _ := setupTestEnvironment(t)
	defer mlc.Close()
	ctx := context.Background()

	// Melacak panggilan ke backend DB
	fetchCount := 0
	fetcher := func() (interface{}, error) {
		fetchCount++
		return map[string]string{"msg": "dari backend"}, nil
	}

	// Panggilan pertama: Harus melewati semuanya hingga fetcher/DB dieksekusi (Cache Miss mutlak)
	val1, err := mlc.Get(ctx, "kunci1", time.Minute, time.Minute, fetcher)
	require.NoError(t, err)
	assert.Equal(t, 1, fetchCount, "Fetcher harusnya dipanggil pada miss pertama")
	assert.NotNil(t, val1)

	// Jeda waktu mungil, memberikan waktu bagi Ristretto goroutine asinkron background worker mem-flush set buffer
	time.Sleep(15 * time.Millisecond)

	// Panggilan kedua: Harus dipotong instan oleh L1 tanpa menembak fetcher
	val2, err := mlc.Get(ctx, "kunci1", time.Minute, time.Minute, fetcher)
	require.NoError(t, err)
	assert.Equal(t, 1, fetchCount, "Counter fetcher tak boleh bertambah jika L1 Hit")
	assert.NotNil(t, val2)
}

func TestMultilevelCache_PubSubInvalidation(t *testing.T) {
	mlc, _ := setupTestEnvironment(t)
	defer mlc.Close()
	ctx := context.Background()

	fetcherInitial := func() (interface{}, error) {
		return "versi_lama", nil
	}

	// Memaksa inisiasi state
	_, _ = mlc.Get(ctx, "kunci_inval", time.Minute, time.Minute, fetcherInitial)
	time.Sleep(15 * time.Millisecond) // Asinkron flush

	// Fungsi invalidate men-trigger pubsub event dan membersihkan redis l2 
	err := mlc.Invalidate(ctx, "kunci_inval")
	require.NoError(t, err)

	// Beri jeda bagi goroutine subscriber untuk menerima event dari chanel Redis dan mengeksekusi L1 Del()
	time.Sleep(50 * time.Millisecond)

	fetchCountAfterInvalidate := 0
	fetcherAfterInvalidate := func() (interface{}, error) {
		fetchCountAfterInvalidate++
		return "versi_baru_terkini", nil
	}

	// Permintaan get harus miss total karena L1 dan L2 sudah dibersihkan. Lanjut tembak DB baru.
	val3, err := mlc.Get(ctx, "kunci_inval", time.Minute, time.Minute, fetcherAfterInvalidate)
	require.NoError(t, err)
	assert.Equal(t, "versi_baru_terkini", val3)
	assert.Equal(t, 1, fetchCountAfterInvalidate)
}

func TestMultilevelCache_L2Resilience(t *testing.T) {
	mlc, mr := setupTestEnvironment(t)
	defer mlc.Close()
	ctx := context.Background()

	// Inject ke dalam miniredis seakan data sudah dipopulasi oleh pod tetangga 
	// (Mengimitasi L1 miss, tapi L2 memegang datanya)
	_ = mr.Set("kunci_tetangga", `{"data_rahasia":"xyz"}`)

	fetchCount := 0
	fetcher := func() (interface{}, error) {
		fetchCount++
		return nil, nil // Return kosong jika fetcher malang ini berjalan
	}

	val, err := mlc.Get(ctx, "kunci_tetangga", time.Minute, time.Minute, fetcher)
	require.NoError(t, err)
	
	// Val seharusnya merupakan parsing dari interface{} -> map, karena json L2 menyimpan tipe generik
	dict := val.(map[string]interface{})
	assert.Equal(t, "xyz", dict["data_rahasia"])
	assert.Equal(t, 0, fetchCount, "Fetcher DB dilarang dieksekusi, karena Redis L2 sanggup memenuhinya!")
}
```

## Kapan JANGAN Pakai Ini

- **L1 untuk data yang sering berubah.** Nilai per-pod yang tidak sinkron lebih membingungkan bagi pengguna dan bagi tim daripada satu round-trip ke Redis. Gejalanya — "kadang benar, kadang lama" — adalah salah satu bug tersulit dilacak.
- **L1 tanpa batas ukuran.** Cache dalam-proses yang tidak dibatasi adalah kebocoran memori dengan nama yang lebih baik. Pakai LRU berkapasitas tetap, dan hitung ongkosnya terhadap `GOMEMLIMIT`.
- **L1 dan L2 dengan TTL yang sama.** L1 harus jauh lebih pendek. Bila tidak, invalidasi di L2 tidak berarti apa-apa selama L1 masih memegang nilai lama.
- **Menyalin objek besar ke L1.** Memori pod terbatas dan dibagi dengan heap aplikasi; satu cache 500 MB akan tampak sebagai masalah GC, bukan sebagai masalah cache.
- **Mengukur hit rate gabungan saja.** Yang menentukan adalah hit rate L1 dan L2 secara terpisah. L1 dengan hit rate rendah adalah biaya memori tanpa manfaat, dan angka gabungan menyembunyikannya.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Jawaban berbeda tergantung pod | nilai L1 tiap pod | L1 tidak sinkron; TTL terlalu panjang |
| RSS naik dan tidak turun | ukuran cache L1 | Cache dalam-proses tanpa batas |
| Invalidasi tidak berefek | TTL L1 vs L2 | L1 menahan nilai lama lebih lama dari L2 |
| Tekanan GC naik setelah menambah cache | profil heap | Objek cache berumur panjang membebani GC |
| Hit rate gabungan bagus, beban DB tetap | hit rate per level | L2 yang bekerja; L1 hanya biaya |

```bash
# Nilai berbeda antar pod adalah bukti langsung L1 tidak sinkron
for p in $(kubectl get pods -l app=api -o name); do
  kubectl exec "$p" -- curl -s localhost:8080/debug/cache/produk/42
done | sort | uniq -c

# Hit rate HARUS dipisah per level
curl -s localhost:9090/metrics | grep -E 'cache_(hits|misses)_total\{level='

# Berapa besar cache L1 dalam heap
go tool pprof -sample_index=inuse_space -top http://localhost:6060/debug/pprof/heap | head -20
```
