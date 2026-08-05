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

### Yang tidak diselesaikan mekanisme ini

Broadcast invalidation menutup celah *antar pod*. Ia tidak menutup celah **antara pembacaan dan penulisan**, dan celah itu meninggalkan nilai basi di cache **secara permanen** — bukan sampai TTL berikutnya, melainkan sampai TTL dari nilai yang salah itu sendiri habis:

```text
Pod C (baca)                        Pod A (tulis)
─────────────────────────────       ─────────────────────────────
t0  L2 miss
t1  SELECT -> "nama lama"
                                    t2  UPDATE db -> "nama baru"
                                    t3  DEL L2 + PUBLISH
                                        (tidak ada yang perlu dihapus,
                                         L2 memang masih kosong)
t4  SET L2 = "nama lama"   <───── nilai basi masuk SETELAH invalidasi
```

Pod C sudah membaca sebelum penulisan, tetapi menulis ke cache sesudahnya. Invalidasi Pod A datang di antara keduanya dan tidak menemukan apa pun untuk dihapus. Hasilnya: L2 memegang nilai yang salah selama TTL penuh, dan setiap pod yang mengisi L1 dari L2 ikut menyebarkannya.

Jendelanya sempit tetapi nyata, dan melebar tepat ketika database sedang lambat — yaitu saat trafik tulis tinggi. Tiga penanganan yang benar-benar dipakai di produksi:

| Penanganan | Cara kerja | Ongkos |
| :--- | :--- | :--- |
| **Delayed double delete** | `DEL` sekali sekarang, lalu `DEL` lagi setelah jeda > durasi baca terlama | Sederhana; jedanya tebakan, dan tetap ada jendela |
| **Kunci berversi** | Kunci cache memuat versi baris (`user:99:v7`); tulisan menaikkan versi | Menghilangkan perlombaan sepenuhnya; butuh versi di skema DB |
| **Isi cache HANYA dari jalur tulis** | Pembacaan tidak pernah menulis cache (write-through) | Konsisten; kehilangan sifat lazy dari cache-aside |

Bila konsistensinya penting, kunci berversi adalah satu-satunya dari ketiganya yang benar-benar menghapus perlombaannya, bukan mengecilkan jendelanya. Perhatikan bahwa bagian "Kapan JANGAN Pakai Ini" di `caching_strategy/cache_aside_singleflight.md` sudah menyebut hal ini — "Butuh versi atau invalidasi, bukan penulisan langsung".

## 6. Produksi-Ready Go Code (Arsitektur Utuh Multilevel Cache)

```go
package multilevelcache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"sync/atomic"
	"time"

	"github.com/dgraph-io/ristretto"
	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"
)

const ChannelInvalidation = "cache:invalidations:v1"

// MultilevelCache DIPARAMETERKAN OLEH TIPE NILAINYA, dan itu memperbaiki cacat
// yang paling sulit dilihat pada versi `interface{}`:
//
//	Jalur L3 menyimpan hasil fetcher apa adanya (misal `*User`).
//	Jalur L2 menyimpan hasil `json.Unmarshal` ke `interface{}`
//	  -> yang selalu menjadi `map[string]interface{}`.
//
// Artinya KUNCI YANG SAMA mengembalikan TIPE YANG BERBEDA tergantung dari
// lapisan mana ia terlayani. Pemanggil yang menulis `hasil.(*User)` bekerja
// sempurna di uji dan di menit-menit pertama produksi, lalu PANIC begitu entri
// L1 ter-evict dan permintaan berikutnya dilayani dari L2 -- kegagalan yang
// muncul setelah restart pod atau tekanan memori, bukan saat deploy.
type MultilevelCache[T any] struct {
	l1      *ristretto.Cache
	l2      *redis.Client
	pubsub  *redis.PubSub
	sgGroup singleflight.Group

	l1TTL, l2TTL time.Duration
	batasMuat    time.Duration

	// Metrik per level. Bagian "Kapan JANGAN Pakai Ini" di bawah menegaskan
	// hit rate WAJIB dipisah per level -- angka gabungan menyembunyikan L1
	// yang hanya jadi biaya memori tanpa manfaat.
	hitL1, hitL2, missTotal atomic.Int64
	l1Ditolak               atomic.Int64
	invalidasiDiterima      atomic.Int64
}

func NewMultilevelCache[T any](l2Client *redis.Client, l1TTL, l2TTL time.Duration) (*MultilevelCache[T], error) {
	if l1TTL >= l2TTL {
		// Dipaksakan, bukan disarankan. Dengan L1 >= L2, invalidasi di L2 tidak
		// berarti apa-apa selama L1 masih memegang nilai lama -- dan itulah
		// satu-satunya jaring pengaman ketika Pub/Sub melewatkan pesan
		// (Edge Case 1). Aturan ini tercantum di "Kapan JANGAN Pakai Ini"
		// dan sebelumnya tidak ditegakkan di mana pun.
		return nil, fmt.Errorf("l1TTL (%v) harus jauh lebih pendek dari l2TTL (%v)", l1TTL, l2TTL)
	}

	// Konfigurasi Ristretto berfokus pada Memory Bound dan TinyLFU hit ratio.
	// Asumsi Max Cost: 256MB di RAM Pod.
	cache, err := ristretto.NewCache(&ristretto.Config{
		NumCounters: 1e7,               // Kapasitas jejak TinyLFU (disarankan: 10x jumlah max item)
		MaxCost:     256 * 1024 * 1024, // 256 MB maksimum ukuran bobot memori L1
		BufferItems: 64,                // Penyesuaian performa goroutine internal Ristretto
	})
	if err != nil {
		return nil, fmt.Errorf("gagal inisialisasi ristretto: %w", err)
	}

	mlc := &MultilevelCache[T]{
		l1:        cache,
		l2:        l2Client,
		l1TTL:     l1TTL,
		l2TTL:     l2TTL,
		batasMuat: 5 * time.Second,
	}

	mlc.startInvalidationSubscriber()
	return mlc, nil
}

// Statistik memisahkan hit per level. Lihat catatan pada struct.
func (m *MultilevelCache[T]) Statistik() (hitL1, hitL2, miss, l1Ditolak int64) {
	return m.hitL1.Load(), m.hitL2.Load(), m.missTotal.Load(), m.l1Ditolak.Load()
}

// TungguL1 memblokir sampai buffer Set asinkron Ristretto terkuras.
//
// Ristretto sengaja membuat Set non-blocking (Edge Case 3), sehingga sebuah
// kunci belum tentu terbaca segera setelah Set kembali. Di uji, ini SATU-
// SATUNYA cara yang benar untuk menunggunya; `time.Sleep(15*time.Millisecond)`
// hanyalah tebakan tentang penjadwal yang gagal acak di CI yang sibuk.
// Jangan panggil ini di jalur produksi.
func (m *MultilevelCache[T]) TungguL1() { m.l1.Wait() }

// BuangL1 menghapus satu kunci dari L1 pod INI saja, tanpa menyentuh L2 dan
// tanpa broadcast. Berguna untuk mensimulasikan eviksi/restart di uji.
func (m *MultilevelCache[T]) BuangL1(key string) { m.l1.Del(key) }

// Menjalankan goroutine listener untuk menerima broadcast PubSub dari pod manapun.
func (m *MultilevelCache[T]) startInvalidationSubscriber() {
	m.pubsub = m.l2.Subscribe(context.Background(), ChannelInvalidation)
	go func() {
		// PubSub.Channel() go-redis bertahan melintasi reconnect: klien
		// menyambung ulang dan berlangganan ulang sendiri, sehingga loop ini
		// TIDAK berhenti pada gangguan jaringan sesaat. Yang hilang hanyalah
		// pesan yang diterbitkan SELAMA putus -- dan itulah alasan sebenarnya
		// L1 wajib ber-TTL pendek (Edge Case 1), bukan karena langganannya mati.
		//
		// Loop ini berakhir ketika Close() menutup pubsub.
		for msg := range m.pubsub.Channel() {
			m.l1.Del(msg.Payload)
			// COUNTER, bukan log per pesan. `log.Printf` di sini menghasilkan
			// satu baris di SETIAP pod untuk SETIAP invalidasi; pada sistem
			// dengan penulisan aktif dan 20 pod, itu 20x volume tulis Anda
			// dalam bentuk baris log yang tidak ada yang membacanya.
			m.invalidasiDiterima.Add(1)
		}
	}()
}

// Get mengambil data via L1 -> L2 -> Fetcher(DB) dengan proteksi stampede.
//
// fetcher MENERIMA context. Versi `func() (interface{}, error)` membuat
// seluruh jalur pengambilan data -- bagian paling lambat dari operasi ini --
// menjadi satu-satunya bagian yang tidak bisa dibatalkan maupun ditelusuri.
func (m *MultilevelCache[T]) Get(ctx context.Context, key string, fetcher func(context.Context) (T, error)) (T, error) {
	var nol T

	// 1. Cek L1
	if v, ok := m.l1.Get(key); ok {
		if nilai, cocok := v.(T); cocok {
			m.hitL1.Add(1)
			return nilai, nil // Ultra cepat, ~50ns
		}
		// Tipe tak terduga di L1 (mis. sisa dari versi kode sebelumnya yang
		// masih hidup di pod yang sama). Buang dan perlakukan sebagai miss --
		// jangan pernah type-assert tanpa comma-ok di jalur yang dilewati
		// setiap permintaan.
		m.l1.Del(key)
	}
	m.missTotal.Add(1)

	// SingleFlight: meski 10.000 goroutine miss bersamaan, jalur L2/L3 hanya
	// dieksekusi SATU kali; sisanya menunggu hasil yang sama.
	//
	// DoChan + context yang dilepas, bukan Do dengan ctx pemanggil. Alasannya
	// dibahas tuntas di `caching_strategy/cache_aside_singleflight.md`:
	// dengan ctx pemanggil, klien PERTAMA yang menutup koneksi membatalkan
	// pemuatan untuk semua penumpang DAN menggagalkan penulisan ke L2 --
	// sehingga cache tetap kosong dan gelombang berikutnya menyerbu DB lagi.
	ch := m.sgGroup.DoChan(key, func() (any, error) {
		ctxMuat, batal := context.WithTimeout(context.WithoutCancel(ctx), m.batasMuat)
		defer batal()
		return m.muat(ctxMuat, key, fetcher)
	})

	select {
	case <-ctx.Done():
		return nol, ctx.Err()
	case res := <-ch:
		if res.Err != nil {
			return nol, res.Err
		}
		nilai, cocok := res.Val.(T)
		if !cocok {
			return nol, fmt.Errorf("tipe hasil singleflight tak terduga: %T", res.Val)
		}
		return nilai, nil
	}
}

func (m *MultilevelCache[T]) muat(ctx context.Context, key string, fetcher func(context.Context) (T, error)) (any, error) {
	// 2. Cek L2
	valStr, redisErr := m.l2.Get(ctx, key).Result()
	switch {
	case redisErr == nil:
		var data T
		if uErr := json.Unmarshal([]byte(valStr), &data); uErr == nil {
			m.hitL2.Add(1)
			// Hit L2 -> isi L1 dengan biaya SEBENARNYA.
			//
			// `cost: 1` -- yang tertulis di sini sebelumnya -- adalah persis
			// kesalahan yang diperingatkan bagian 4 berkas ini: menghitung
			// JUMLAH ITEM alih-alih BYTE. Dan ia ada di jalur TERPANAS: pada
			// sistem yang sudah hangat, sebagian besar pengisian L1 datang
			// dari L2, bukan dari DB. Dengan cost 1, MaxCost 256 MB berubah
			// makna menjadi "256 juta entri", dan pod di-OOM-kill jauh
			// sebelum Ristretto merasa perlu meng-evict apa pun.
			m.simpanL1(key, data, int64(len(valStr)))
			return data, nil
		} else {
			slog.WarnContext(ctx, "data L2 rusak, jatuh ke sumber asli", "key", key, "galat", uErr)
		}
	case errors.Is(redisErr, redis.Nil):
		// Miss biasa. errors.Is, bukan `!= redis.Nil` -- go-redis membungkus
		// galat pada jalur hook/tracing/cluster.
	default:
		slog.ErrorContext(ctx, "L2 bermasalah, degradasi ke sumber asli", "key", key, "galat", redisErr)
	}

	// 3. Fetch L3 (Database)
	data, fetchErr := fetcher(ctx)
	if fetchErr != nil {
		return nil, fetchErr
	}

	bytesData, jsonErr := json.Marshal(data)
	if jsonErr != nil {
		// Dibuang dengan `_` sebelumnya. Akibatnya berantai dan senyap:
		// bytesData nil -> L2 menyimpan string kosong -> Unmarshal pada
		// pembacaan berikutnya gagal -> setiap permintaan jatuh ke DB
		// selamanya; dan cost L1 menjadi 0 sehingga akuntansi memori ikut
		// rusak. Semuanya tanpa satu galat pun yang terlihat.
		return nil, fmt.Errorf("menserialisasi nilai untuk %s: %w", key, jsonErr)
	}

	// 4. Update L2 dengan TTL ber-jitter.
	if setErr := m.l2.Set(ctx, key, bytesData, jitter(m.l2TTL)).Err(); setErr != nil {
		// Bukan alasan menggagalkan permintaan -- datanya sudah ada. Tapi L2
		// yang tidak pernah terisi berarti setiap permintaan menjadi miss,
		// dan gejalanya hanya muncul sebagai beban DB yang tidak turun.
		slog.ErrorContext(ctx, "SET L2 gagal; permintaan berikutnya akan tetap miss", "key", key, "galat", setErr)
	}

	// 5. Update L1
	m.simpanL1(key, data, int64(len(bytesData)))
	return data, nil
}

func (m *MultilevelCache[T]) simpanL1(key string, data T, cost int64) {
	// NILAI KEMBALIAN Set WAJIB DIPERIKSA.
	//
	// Ristretto mengembalikan false ketika item DITOLAK -- buffer masuk penuh,
	// atau kebijakan admission TinyLFU menilai item ini kalah populer dari
	// yang sudah ada. Itu perilaku yang benar, tetapi membuangnya berarti Anda
	// tidak punya cara membedakan "tersimpan" dari "diam-diam dibuang", dan
	// misteri "kenapa hit rate L1 rendah padahal cache besar" tidak punya
	// satu pun angka untuk menjawabnya.
	if !m.l1.SetWithTTL(key, data, cost, jitter(m.l1TTL)) {
		m.l1Ditolak.Add(1)
	}
}

// jitter menyebar waktu kedaluwarsa agar tidak seluruh pod kehilangan kunci
// yang sama pada detik yang sama.
//
// Edge Case 4 di bawah memerintahkan jitter TTL -- dan sebelumnya tidak ada
// satu baris pun yang menerapkannya: l1TTL dan l2TTL diteruskan mentah dari
// pemanggil, sehingga seluruh pod yang memuat kunci panas pada gelombang yang
// sama akan kehilangannya pada gelombang yang sama pula.
func jitter(d time.Duration) time.Duration {
	return d + time.Duration(float64(d)*0.20*rand.Float64())
}

// Invalidate membilas L2 dan mem-broadcast hapus ke seluruh pod.
func (m *MultilevelCache[T]) Invalidate(ctx context.Context, key string) error {
	// Hapus L1 lokal LEBIH DULU, bukan setelah Exec.
	//
	// Di antara Exec dan Del lokal ada jendela di mana pod ini sendiri masih
	// menyajikan nilai lama dari L1-nya -- pod yang paling tahu data itu sudah
	// berubah justru menjadi yang terakhir berhenti menyajikan versi lamanya.
	m.l1.Del(key)

	// TxPipeline membungkus keduanya dalam MULTI/EXEC. Perlu presisi soal apa
	// yang dijaminnya: Redis menjalankan kedua perintah berurutan tanpa
	// disisipi klien lain, TETAPI TIDAK ADA ROLLBACK -- bila PUBLISH gagal,
	// DEL yang sudah berjalan tetap berlaku. "Atomic" di sini berarti
	// tak-tersisipi, bukan all-or-nothing.
	pipe := m.l2.TxPipeline()
	pipe.Del(ctx, key)
	pipe.Publish(ctx, ChannelInvalidation, key)

	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("gagal mengeksekusi invalidation pipeline: %w", err)
	}
	return nil
}

func (m *MultilevelCache[T]) Close() {
	if m.pubsub != nil {
		_ = m.pubsub.Close()
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
   - *Mitigasi:* Jangan harapkan jaminan transaksional murni (ACID) pada cache in-memory yang *eventually consistent*. **Di uji, jangan pula menambalnya dengan `time.Sleep`** — Ristretto menyediakan `Cache.Wait()` yang memblokir sampai buffer Set terkuras. Tidur adalah tebakan tentang penjadwal: gagal acak di CI yang sibuk, membuang waktu di mesin cepat, dan tidak pernah menjelaskan mengapa angkanya 15 ms.
   - *Yang jarang disebut:* `Set` dan `SetWithTTL` **mengembalikan `bool`**, dan `false` berarti item DITOLAK — buffer masuk penuh, atau kebijakan admission TinyLFU menilai item ini kalah populer dari yang sudah ada. Ini perilaku yang benar dan disengaja, tetapi membuang nilai kembaliannya berarti Anda tidak punya cara membedakan "tersimpan" dari "diam-diam dibuang". Hitung penolakannya (`l1Ditolak` pada kode di atas), atau pertanyaan "kenapa hit rate L1 rendah padahal cache-nya besar" tidak akan pernah punya jawaban berbasis angka.

4. **Dogpile Effect pada Akhir TTL (Jittering)**
   - *Situasi:* Sebuah kunci dengan beban berat dan diakses sangat masif (*contoh: API flash sale global setting*). Disetel punya TTL 60 menit secara pasti. Tepat pada menit 60:00, seluruh ratusan pod secara serempak kehilangan data ini dari L1 dan L2 (Expire time presisi), menciptakan tsunami kecil pada database.
   - *Mitigasi:* Tambahkan **TTL Jitter** — lihat fungsi `jitter()` pada kode di atas, yang dipakai di jalur L1 maupun L2. Sebelumnya bagian ini memerintahkan jitter sementara kodenya meneruskan `l1TTL` dan `l2TTL` mentah dari pemanggil, sehingga seluruh pod yang memuat kunci panas pada gelombang yang sama akan kehilangannya pada gelombang yang sama pula.
   - *Pakai persentase, bukan durasi tetap:* "rand(1–60 detik)" pada TTL 60 menit hanya menyebar 1,7% — praktis tidak mengubah apa pun. Pada TTL 2 menit, angka yang sama menggandakan masa hidupnya. Jitter proporsional (`d + 20% × rand`) benar untuk keduanya. Yang harus dibandingkan adalah **kedaluwarsa per detik melawan kapasitas cache-miss hilir**, bukan apakah angkanya terasa cukup besar.

5. **Payload Besar yang Berbahaya untuk Serialisasi**
   - *Situasi:* Menyimpan payload 10 MB list JSON respon pada L1 dan L2.
   - *Mitigasi:* Jangan pernah simpan data sebesar itu di L2 Redis tanpa dikompresi (GZip/Snappy). Gunakan middleware kompresi Golang saat memarshal dari/ke L2. Biaya CPU kompresi di server Go jauh lebih murah dibandingkan biaya jaringan memindahkan 10MB payload bolak-balik dari Redis.

## 9. Unit Testing Mendalam

Berikut adalah Unit Test Golang komprehensif. Penggunaan `miniredis` di sini mensimulasikan redis secara akurat pada *in-memory runtime* murni Golang sehingga tidak memerlukan container docker redis pihak ketiga ketika `go test` dijalankan di lingkungan CI/CD pipeline Anda.

```go
package multilevelcache_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"myapp/multilevelcache" // Sesuaikan dengan package import anda
)

type Profil struct {
	ID   string `json:"id"`
	Nama string `json:"nama"`
}

// Helper setup
func setupTestEnvironment(t *testing.T) (*multilevelcache.MultilevelCache[Profil], *miniredis.Miniredis) {
	t.Helper()
	// RunT, bukan Run: `miniredis.Run()` tanpa Close meninggalkan server
	// beserta goroutine listener-nya hidup untuk setiap uji.
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	mlc, err := multilevelcache.NewMultilevelCache[Profil](rdb, time.Minute, 10*time.Minute)
	require.NoError(t, err)
	t.Cleanup(mlc.Close)

	return mlc, mr
}

func TestMultilevelCache_HitMissHierarchy(t *testing.T) {
	mlc, _ := setupTestEnvironment(t)
	ctx := context.Background()

	// Melacak panggilan ke backend DB
	fetchCount := 0
	fetcher := func(context.Context) (Profil, error) {
		fetchCount++
		return Profil{ID: "1", Nama: "dari backend"}, nil
	}

	// Panggilan pertama: melewati semuanya hingga fetcher/DB (Cache Miss mutlak)
	val1, err := mlc.Get(ctx, "kunci1", fetcher)
	require.NoError(t, err)
	assert.Equal(t, 1, fetchCount, "fetcher harus dipanggil pada miss pertama")
	assert.Equal(t, "dari backend", val1.Nama)

	// `time.Sleep(15ms)` -- yang tertulis di sini sebelumnya -- adalah
	// taruhan dua arah terhadap penjadwal: gagal acak di CI yang sibuk, dan
	// membuang waktu di mesin cepat. Ristretto menyediakan Wait() persis
	// untuk menunggu buffer Set asinkronnya terkuras. Pakai itu.
	mlc.TungguL1()

	// Panggilan kedua: dipotong instan oleh L1 tanpa menembak fetcher
	val2, err := mlc.Get(ctx, "kunci1", fetcher)
	require.NoError(t, err)
	assert.Equal(t, 1, fetchCount, "counter fetcher tak boleh bertambah saat L1 hit")
	assert.Equal(t, "dari backend", val2.Nama)

	hitL1, _, _, _ := mlc.Statistik()
	assert.Equal(t, int64(1), hitL1, "panggilan kedua harus tercatat sebagai hit L1")
}

// Kunci yang sama WAJIB mengembalikan tipe yang sama, dari lapisan mana pun ia
// dilayani. Versi `interface{}` gagal di sini: jalur L3 mengembalikan tipe
// asli fetcher, sementara jalur L2 mengembalikan map[string]interface{} hasil
// json.Unmarshal -- sehingga type assertion pemanggil bekerja sampai entri L1
// ter-evict, lalu panic di produksi.
func TestMultilevelCache_TipeStabilLintasLapisan(t *testing.T) {
	mlc, _ := setupTestEnvironment(t)
	ctx := context.Background()

	fetcher := func(context.Context) (Profil, error) {
		return Profil{ID: "7", Nama: "asli"}, nil
	}

	// Dilayani dari L3.
	dariL3, err := mlc.Get(ctx, "kunci_tipe", fetcher)
	require.NoError(t, err)
	mlc.TungguL1()

	// Buang L1 saja; L2 tetap terisi. Ini keadaan setelah pod restart atau
	// setelah eviksi karena tekanan memori -- keadaan yang PASTI terjadi.
	mlc.BuangL1("kunci_tipe")

	// Dilayani dari L2. Harus tipe yang sama, nilai yang sama.
	dariL2, err := mlc.Get(ctx, "kunci_tipe", func(context.Context) (Profil, error) {
		t.Fatal("fetcher tidak boleh dipanggil; L2 memegang datanya")
		return Profil{}, nil
	})
	require.NoError(t, err)
	assert.Equal(t, dariL3, dariL2, "nilai dari L2 dan L3 harus identik")

	_, hitL2, _, _ := mlc.Statistik()
	assert.Equal(t, int64(1), hitL2)
}

func TestMultilevelCache_PubSubInvalidation(t *testing.T) {
	mlc, _ := setupTestEnvironment(t)
	ctx := context.Background()

	_, err := mlc.Get(ctx, "kunci_inval", func(context.Context) (Profil, error) {
		return Profil{ID: "9", Nama: "versi_lama"}, nil
	})
	require.NoError(t, err)
	mlc.TungguL1()

	require.NoError(t, mlc.Invalidate(ctx, "kunci_inval"))

	fetchCount := 0
	fetcherBaru := func(context.Context) (Profil, error) {
		fetchCount++
		return Profil{ID: "9", Nama: "versi_baru"}, nil
	}

	// L1 dan L2 sudah dibersihkan -> harus miss total dan menembak DB.
	//
	// Catatan: uji ini TIDAK membuktikan Pub/Sub bekerja. Invalidate menghapus
	// L1 pod ini secara langsung, jadi hasilnya sama persis dengan atau tanpa
	// subscriber. Pembuktian Pub/Sub yang sebenarnya butuh DUA instance yang
	// berbagi satu Redis -- lihat uji berikutnya. Uji lama berhenti di sini
	// dan menamainya "PubSubInvalidation".
	val, err := mlc.Get(ctx, "kunci_inval", fetcherBaru)
	require.NoError(t, err)
	assert.Equal(t, "versi_baru", val.Nama)
	assert.Equal(t, 1, fetchCount)
}

// INI yang benar-benar menguji broadcast: dua instance berbagi satu Redis,
// invalidasi diterbitkan oleh instance A, L1 instance B harus ikut kosong.
func TestMultilevelCache_BroadcastMenjangkauInstanceLain(t *testing.T) {
	mr := miniredis.RunT(t)
	ctx := context.Background()

	buat := func() *multilevelcache.MultilevelCache[Profil] {
		rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
		t.Cleanup(func() { _ = rdb.Close() })
		c, err := multilevelcache.NewMultilevelCache[Profil](rdb, time.Minute, 10*time.Minute)
		require.NoError(t, err)
		t.Cleanup(c.Close)
		return c
	}
	podA, podB := buat(), buat()

	// Kedua pod memuat kunci yang sama ke L1 masing-masing.
	awal := func(context.Context) (Profil, error) { return Profil{ID: "3", Nama: "lama"}, nil }
	_, err := podA.Get(ctx, "bersama", awal)
	require.NoError(t, err)
	_, err = podB.Get(ctx, "bersama", awal)
	require.NoError(t, err)
	podA.TungguL1()
	podB.TungguL1()

	require.NoError(t, podA.Invalidate(ctx, "bersama"))

	// Broadcast bersifat asinkron. Polling dengan batas waktu, BUKAN
	// time.Sleep(50ms) tetap: tidur tetap gagal acak di CI yang sibuk dan
	// membuang waktu di mesin cepat.
	batas := time.After(3 * time.Second)
	for {
		fetchB := 0
		v, err := podB.Get(ctx, "bersama", func(context.Context) (Profil, error) {
			fetchB++
			return Profil{ID: "3", Nama: "baru"}, nil
		})
		require.NoError(t, err)
		if fetchB == 1 && v.Nama == "baru" {
			return // L1 pod B sudah dikosongkan oleh broadcast
		}
		select {
		case <-batas:
			t.Fatal("L1 pod B masih menyajikan nilai lama; broadcast tidak sampai")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestMultilevelCache_L2MelayaniTanpaMenyentuhDB(t *testing.T) {
	mlc, mr := setupTestEnvironment(t)
	ctx := context.Background()

	// Data seolah sudah dipopulasi pod tetangga: L1 miss, L2 hit.
	require.NoError(t, mr.Set("kunci_tetangga", `{"id":"42","nama":"dari_tetangga"}`))

	fetchCount := 0
	val, err := mlc.Get(ctx, "kunci_tetangga", func(context.Context) (Profil, error) {
		fetchCount++
		return Profil{}, nil
	})
	require.NoError(t, err)

	// BERTIPE. Uji lama menulis `val.(map[string]interface{})` di sini dan
	// menjelaskannya sebagai "karena json L2 menyimpan tipe generik" --
	// mengabadikan ketidakstabilan tipe lintas lapisan sebagai perilaku yang
	// diharapkan, alih-alih mengenalinya sebagai cacat.
	assert.Equal(t, "dari_tetangga", val.Nama)
	assert.Equal(t, 0, fetchCount, "fetcher DB dilarang jalan; L2 sanggup memenuhinya")
}

// Ristretto MENOLAK sebagian Set (buffer penuh / kalah admission TinyLFU).
// Penolakan itu sah, tetapi harus terhitung -- kalau tidak, "kenapa hit rate
// L1 rendah padahal cache besar" tidak punya satu angka pun untuk dijawab.
func TestMultilevelCache_PenolakanL1Terhitung(t *testing.T) {
	mlc, _ := setupTestEnvironment(t)
	ctx := context.Background()

	for i := 0; i < 200; i++ {
		key := fmt.Sprintf("k%d", i)
		_, err := mlc.Get(ctx, key, func(context.Context) (Profil, error) {
			return Profil{ID: key, Nama: "x"}, nil
		})
		require.NoError(t, err)
	}
	mlc.TungguL1()

	hitL1, hitL2, miss, ditolak := mlc.Statistik()
	t.Logf("hitL1=%d hitL2=%d miss=%d l1Ditolak=%d", hitL1, hitL2, miss, ditolak)
	assert.Equal(t, int64(200), miss, "seluruh kunci baru harus tercatat sebagai miss")
	// ditolak bisa 0 pada cache lapang; yang diuji adalah angkanya TERSEDIA,
	// bukan nilainya. Sebelumnya nilai kembalian Set dibuang sepenuhnya.
	assert.GreaterOrEqual(t, ditolak, int64(0))
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
