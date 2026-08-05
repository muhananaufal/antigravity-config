# Multi-Layer Caching (In-Process, Redis, DB) & Sinkronisasi Invalidation

> **Berlaku:** Go 1.21+ · Redis 7+ · PostgreSQL `LISTEN/NOTIFY` · **Lihat juga:** `caching_strategy/multilevel_cache_l1l2.md` · `caching_strategy/cache_invalidation_strategies.md` · `concurrency/singleflight_thundering_herd.md` · `db_sqlc/read_replica_routing.md`

## Konsep dan Internals

Untuk aplikasi Go ber-frekuensi sangat tinggi (High-Frequency / High-Throughput) seperti Gateway API atau e-Commerce, mengandalkan **Database (L3)** saja akan menyebabkan kelebihan muatan (bottleneck) secara instan. Menambahkan **Redis (L2)** memang membantu, namun setiap akses ke Redis tetap melibatkan *Network I/O* (Round-Trip Time) dan *Serialization/Deserialization*, yang rata-rata memakan waktu 1-2 milidetik per operasi. 

Solusi kasta tertinggi adalah menerapkan **Caching L1 (In-Process)**. Pustaka *Cache lokal* di memori aplikasi Go (seperti `dgraph-io/ristretto` atau `maypok86/otter`) dapat menyajikan data dalam hitungan nanodetik (0,0001 ms). Namun, tantangan terberat muncul: **Data Basi (Stale Data)**. Jika *Pod A* memperbarui profil pengguna di database, *Pod B* (karena punya L1 sendiri) tidak menyadarinya dan masih memberikan profil lama.

Untuk mengatasi ini, kita tidak wajib menyiapkan Kafka. PostgreSQL memiliki mekanisme *Pub/Sub* native yang luar biasa efisien: **`LISTEN / NOTIFY`**. Saat modifikasi terjadi, *Database Trigger* memancarkan event `pg_notify`. Ekosistem driver `pgx/v5` secara ajaib menangkap sinyal ini melalui kanal jaringannya dan membangunkan Goroutine di setiap Pod (A, B, C) untuk "membersihkan/membuang" *key* spesifik (Invalidation) dari L1 Cache masing-masing.

---

## Diagram ASCII: Arsitektur Invalidasi Otomatis (Event-Driven)

```text
========================================================================================
[ Skenario Pembacaan (Read) - Nanosecond Latency ]
Klien -> [ Go App Instance 1 ]
             |
             +-> L1 Cache (Ristretto) -> HIT! (0ms, Selesai)

========================================================================================
[ Skenario Modifikasi & Invalidasi Massal ]

Klien 2 -> [ Go App Instance 2 ] -> Update User(ID=123)
                 |
                 v 
      (UPDATE users SET name...)
                 |
      +-----------------------------+
      |        POSTGRES DB          |
      | Trigger 'ON UPDATE'         |
      | SELECT pg_notify('cache',   |
      |   'user_123');              |
      +-----------------------------+
                 |
                 v (Broadcast)
   +---------------------------------------+
   | (LISTEN 'cache')                      | (LISTEN 'cache')
   v                                       v
[ Go App Instance 1 ]                   [ Go App Instance 3 ]
(Pesan masuk! Hapus                    (Pesan masuk! Hapus
 key 'user_123' dari L1)                key 'user_123' dari L1)

(Saat dibaca ulang, semua node serentak Cache-Miss, dan mengambil data segar dari L3)
========================================================================================
```

---

## Kode Go Production-Ready

Kode di bawah mensimulasikan gabungan dari Cache-Aside (Lazy Loading), `singleflight` untuk mencegah *Dogpiling*, dan kanal latar belakang (*background worker*) `pgx` untuk bereaksi pada *Listen*.

```go
package cache

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/dgraph-io/ristretto"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/singleflight"
)

// MultiLayerCache mengatur orkestrasi antara L1 (Ristretto) dan L3 (pgxpool).
// Catatan: L2 (Redis) bisa disisipkan di antara keduanya dalam pattern nyata.
type MultiLayerCache struct {
	l1    *ristretto.Cache
	pool  *pgxpool.Pool
	sfg   singleflight.Group // Proteksi Cache Stampede
	log   *slog.Logger
}

func NewMultiLayerCache(pool *pgxpool.Pool, logger *slog.Logger) (*MultiLayerCache, error) {
	// Ristretto adalah cache concurrent performa tinggi, dirancang khusus
	// menghindari contention lock mutex tradisional.
	cache, err := ristretto.NewCache(&ristretto.Config{
		NumCounters: 1e7,     // metrik frekuensi untuk ~10 juta item
		MaxCost:     1 << 28, // 268.435.456 satuan "cost"
		BufferItems: 64,      // ukuran channel buffer internal
	})
	// PERINGATAN — MaxCost BUKAN batas byte secara otomatis.
	//
	// MaxCost hanya berarti "byte" bila setiap Set() menyertakan cost dalam
	// satuan byte. Bila Anda memakai cost = 1 per item (pola yang sangat
	// umum disalin), MaxCost 1<<28 berarti batasnya 268 JUTA ITEM, bukan
	// 256 MB -- dan cache itu bisa menghabiskan puluhan gigabyte sebelum
	// satu item pun dievict.
	//
	// Pilih satu dan konsisten:
	//   (a) cost = perkiraan byte item  -> MaxCost adalah batas memori
	//   (b) cost = 1                    -> MaxCost adalah batas jumlah item,
	//                                      dan setel angkanya sesuai itu
	// Kode di bawah memakai (a).
	if err != nil {
		return nil, fmt.Errorf("failed to init ristretto l1 cache: %w", err)
	}

	return &MultiLayerCache{
		l1:   cache,
		pool: pool,
		log:  logger,
	}, nil
}

// GetUserName adalah rute pengambilan (Read Path) Cache-Aside pattern dengan Singleflight.
func (c *MultiLayerCache) GetUserName(ctx context.Context, userID int) (string, error) {
	cacheKey := fmt.Sprintf("user:%d", userID)

	// L1 Cache (In-Memory)
	if val, found := c.l1.Get(cacheKey); found {
		return val.(string), nil
	}

	// Cache Miss!
	// Mencegah "Dogpiling/Stampede": Jika 10,000 request miss pada detik yang sama untuk user ini,
	// Singleflight menjamin hanya 1 goroutine yang lolos mengeksekusi query database L3.
	// 9,999 lainnya menahan nafas dan menerima hasilnya (sharing result).
	v, err, _ := c.sfg.Do(cacheKey, func() (interface{}, error) {
		var name string
		
		c.log.DebugContext(ctx, "cache miss, hitting database", slog.String("key", cacheKey))
		err := c.pool.QueryRow(ctx, "SELECT name FROM users WHERE id = $1", userID).Scan(&name)
		if err != nil {
			return nil, err
		}

		// cost = perkiraan byte yang benar-benar dipakai item ini, konsisten
		// dengan MaxCost sebagai batas memori. Menaruh 1 di sini akan membuat
		// MaxCost berhenti berarti sebagai batas byte.
		biaya := int64(len(cacheKey) + len(name) + 48) // +48: overhead header string & entri

		// Set MENGEMBALIKAN bool: kebijakan admisi Ristretto boleh MENOLAK item.
		// Mengabaikannya berarti Anda tidak pernah tahu cache diam-diam tidak
		// menyimpan apa pun -- hit rate nol tanpa satu pun galat.
		if diterima := c.l1.SetWithTTL(cacheKey, name, biaya, 30*time.Minute); !diterima {
			c.log.DebugContext(ctx, "item ditolak kebijakan admisi L1",
				slog.String("key", cacheKey))
		}

		// Ristretto menulis secara asinkron: ada jeda singkat sebelum item
		// benar-benar terlihat oleh Get() berikutnya. Di uji, panggil Wait().
		return name, nil
	})

	if err != nil {
		return "", err
	}

	return v.(string), nil
}

// StartInvalidationListener menduduki 1 koneksi pool secara permanen untuk 
// memonitor command LISTEN/NOTIFY PostgreSQL secara real-time.
func (c *MultiLayerCache) StartInvalidationListener(ctx context.Context) {
	go func() {
		for {
			// Backoff and Reconnect logic
			err := c.listenRoutine(ctx)
			if err != nil {
				c.log.Error("listen routine disconnected", slog.String("error", err.Error()))
			}

			// Keluar jika Context utama (shutdown signal) telah dibatalkan
			if ctx.Err() != nil {
				return
			}
			time.Sleep(3 * time.Second) // Reconnect delay
		}
	}()
}

func (c *MultiLayerCache) listenRoutine(ctx context.Context) error {
	// Koneksi yang sudah menjalankan LISTEN TIDAK BOLEH kembali ke pool.
	//
	// pgxpool tidak mereset status LISTEN saat Release(). Koneksi itu akan
	// diberikan ke query biasa berikutnya sementara langganannya masih aktif
	// -- notifikasi berakhir di tempat yang tidak menanganinya, dan hilang.
	// Gejalanya: invalidasi cache "kadang tidak sampai", tanpa satu pun galat.
	//
	// Hijack() MENGELUARKAN koneksi dari pool secara permanen. Kita yang
	// bertanggung jawab menutupnya.
	poolConn, err := c.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire notify connection: %w", err)
	}
	conn := poolConn.Hijack() // sejak titik ini, pool tidak lagi memilikinya
	defer func() {
		// Konteks terpisah: ctx bisa sudah dibatalkan, dan penutupan tetap
		// harus terkirim agar tidak meninggalkan koneksi menggantung di server.
		tutupCtx, batal := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer batal()
		if err := conn.Close(tutupCtx); err != nil {
			c.log.Error("gagal menutup koneksi listener", slog.String("error", err.Error()))
		}
	}()

	// Daftarkan niat pada channel pg_notify 'cache_invalidation'
	_, err = conn.Exec(ctx, "LISTEN cache_invalidation")
	if err != nil {
		return fmt.Errorf("exec listen: %w", err)
	}

	c.log.Info("pg_notify invalidation listener activated")

	for {
		// WaitForNotification menahan goroutine dan sangat hemat CPU.
		notification, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			return fmt.Errorf("wait for notification interupted: %w", err)
		}
		
		// Payload berisi Key spesifik yang dikirim oleh Trigger DB (misal: "user:123")
		keyToInvalidate := notification.Payload
		c.log.Debug("received invalidation event", slog.String("key", keyToInvalidate))
		
		c.l1.Del(keyToInvalidate) // Bersihkan data basi!
	}
}
```

---

## Anti-Patterns

### ❌ Anti-Pattern 1: Cache Stampede (Dogpiling) Tanpa Perlindungan
Data seorang Influencer sangat populer. Kuncinya (key) kedaluwarsa secara alami di L1 & L2. Ribuan HTTP request milidetik tersebut mengalami *Cache Miss* serentak.

```go
// ❌ BAD: Tidak ada gerbang pembatas
func (c *MultiLayerCache) GetUser(id int) (User, error) {
	if cached, ok := c.Get(id); ok { return cached, nil }
	
	// Jika ada 10.000 QPS (Queries per Sec) untuk user ini,
	// SEMUA 10.000 Goroutine akan secara agresif mengeksekusi SELECT ke PostgreSQL.
	// Postgres CPU 100% -> Crash!
	user, err := c.db.Query("SELECT ...", id)
	c.Set(id, user)
	return user, err
}
```
**Why dangerous:** Ini adalah fenomena penyebab matinya server raksasa secara berantai (Cascading failure). Database menanggung beban kueri identik secara eksponensial dalam sekejap (*Thundering Herd*).

**✅ Solusi Benar:** Gunakan `golang.org/x/sync/singleflight` seperti pada contoh kode *production* di atas. Paket tersebut secara harfiah akan menyatukan ribuan pemanggilan *concurrent* identik menjadi 1 eksekusi fisik, lalu membagikan return valuenya ke seluruh *caller* secara sinkron!

### ❌ Anti-Pattern 2: Koneksi Bocor (Leak) pada pgx Listener
Mengeksekusi *Listen* di koneksi pool acak.

```go
// ❌ BAD: Mencoba LISTEN tanpa mengambil kontrol penuh dari connection lifecycle.
rows, _ := pool.Query(ctx, "LISTEN channel_ku") // KONEKSI LEAK!
```
**Why dangerous:** Saat memanggil `LISTEN`, sesi OS koneksi PostgreSQL tersebut secara *stateful* masuk ke mode pemantauan (*listening*). Jika Anda mengembalikannya ke `pgxpool` (Pool biasa), saat fungsi lain yang berniat melakukan *SELECT/INSERT* meminjam koneksi tersebut, akan terjadi tabrakan protokol, karena *socket* tersebut sedang dicekoki asinkron oleh paket-paket *NOTIFY*.

**✅ Solusi Benar:** Selalu gunakan `conn, _ := pool.Acquire()` dan `conn.Conn().WaitForNotification()`. Ingat, **Koneksi ini hilang (berkurang) secara absolut dari MaxConns pool Anda**, jadi jika MaxConns adalah 10, Anda hanya punya 9 koneksi sisa untuk kueri!

---

## Edge Cases & Defensive Programming

1. **Sifat Asinkron Ristretto (`Set()`)**
   Berbeda dengan map/redis sinkron, jika Anda memanggil `l1.Set("a", 1)` di Ristretto, data itu dioper ke buffer (Background Worker) dan baru masuk ke ring sekitar **beberapa milidetik** kemudian. Jangan pernah mendesain logic test yang mengharap `Set` dan tepat di baris bawahnya `Get` berhasil (*Immediate Consistency*). Gunakan *fallback* ke pemanggilan aslinya jika miss!

2. **Limitasi Payload 8000 Bytes pg_notify**
   Trigger pada Database (PL/pgSQL) sering diprogram untuk mengirim payload lengkap JSON row baru: `SELECT pg_notify('channel', row_to_json(NEW)::text);`.
   Namun PostgreSQL melarang payload melebihi ~8KB. Jika baris (row) Anda sangat gemuk (memiliki TEXT deskripsi 10MB), notifikasi akan meledak (*error*). *Rule of thumb*: HANYA kirimkan Primary Key / ID / Cache Key sebagai Payload (misal: "user:125"). Biarkan aplikasi yang mengambil ulangnya sendiri.

3. **Jitter pada Batas Kedaluwarsa (TTL Jittering)**
   Terkadang kita perlu menghapus cache secara manual (Invalidate). Namun, apa yang terjadi jika L1 Cache *Expired* secara wajar dan semua pod meresetnya di milidetik yang sama? Dogpiling terjadi. Tambahkan waktu acak (Jitter) sebesar $\pm 10\%$ ke dalam fungsi TTL (Misal: bukannya `30m`, gunakan `27m - 33m` secara rand). Ini memastikan setiap server/pod di Kubernetes "basi" pada detik yang sedikit berbeda-beda, melunakkan pukulan (*smoothing the blow*) ke database L3.

---

## Unit Tests

Menguji keberhasilan `singleflight` (yang sangat penting mencegah *stampede*) cukup unik.

```go
package cache_test

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sync/singleflight"
)

// Uji coba ini memastikan bahwa 100 Goroutine yang lapar 
// hanya memicu eksekusi fetch yang berat sebanyak 1 kali!
func TestSingleflightStampedePrevention(t *testing.T) {
	var sfg singleflight.Group
	var executionCount int32 // Menghitung berapa kali "DB" fisik diakses

	// Logika (Tiruan fungsi query yang memakan waktu lama)
	slowDBFetch := func() (interface{}, error) {
		atomic.AddInt32(&executionCount, 1)
		time.Sleep(50 * time.Millisecond) // Simulasikan RTT 50ms
		return "Hasil_Mahal", nil
	}

	var wg sync.WaitGroup
	concurrentRequests := 100
	wg.Add(concurrentRequests)

	// Ledakkan 100 request identik di waktu bersamaan (Thundering herd)
	for i := 0; i < concurrentRequests; i++ {
		go func() {
			defer wg.Done()
			
			// Proteksi Singleflight (semua akan berbagi hasil dari panggilan pertama yg sama key-nya)
			v, err, shared := sfg.Do("user:123", slowDBFetch)
			
			if err != nil || v.(string) != "Hasil_Mahal" {
				t.Errorf("Unexpected result: %v", v)
			}
			
			// shared akan bernilai true untuk request ke-2 hingga ke-100
			if !shared && executionCount > 1 {
				t.Errorf("Request was not shared properly")
			}
		}()
	}

	wg.Wait() // Tunggu semuanya selesai

	// INI HAL YANG LUAR BIASA! Walau ada 100 panggilan konkuren serentak, 
	// database kita HANYA DIPUKUL SATU KALI!
	if executionCount != 1 {
		t.Fatalf("Expected exactly 1 DB execution, got %d. Cache Stampede prevention failed!", executionCount)
	}
}
```

## Kapan JANGAN Pakai Ini

- **Cache L1 dalam-proses untuk data yang wajib konsisten antar pengguna.** Tiap pod memegang salinannya sendiri dan invalidasinya tidak pernah serentak. Pengguna akan melihat nilai berbeda tergantung pod mana yang kebetulan melayaninya — dan itu tampak seperti bug hantu.
- **Cache untuk data yang jarang dibaca.** Hit rate rendah berarti seluruh kerumitan invalidasi dibayar tanpa imbalan. Ukur rasio baca/tulis sebelum menambah lapisan.
- **Cache di depan query yang belum di-index.** Yang disembunyikan hanya gejalanya. Saat cache dingin — deploy, restart Redis, eviction massal — beban penuh langsung menghantam database yang tidak pernah disiapkan menerimanya.
- **Menyimpan hasil yang bergantung pada identitas pemanggil tanpa memasukkannya ke kunci.** Ini cara paling umum data satu pengguna muncul di layar pengguna lain. Tenant, bahasa, dan peran WAJIB masuk ke dalam kunci.
- **Cache tanpa rencana invalidasi.** "TTL 1 jam" adalah rencana yang sah. "Nanti kita pikirkan" bukan — dan biasanya berakhir sebagai data usang yang bertahan berhari-hari.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Beban database tidak turun setelah cache dipasang | `keyspace_hits` vs `keyspace_misses` | Hit rate rendah; kuncinya terlalu spesifik atau TTL terlalu pendek |
| Pengguna melapor data lama, hilang setelah refresh | perbedaan nilai antar pod | L1 tidak menerima sinyal invalidasi |
| Lonjakan query database tepat setelah deploy | waktu deploy vs lonjakan | Seluruh L1 kosong serentak |
| Data hilang dari cache sebelum TTL | `evicted_keys` di Redis | Memori Redis penuh; kebijakan eviction membuang data |
| Pengguna melihat data milik orang lain | komposisi kunci cache | Identitas pemanggil tidak masuk ke kunci |

```bash
redis-cli info stats  | grep -E 'keyspace_hits|keyspace_misses|expired_keys|evicted_keys'
redis-cli info memory | grep -E 'used_memory_human|maxmemory_human|maxmemory_policy'

# Kunci raksasa yang membuat latensi Redis melonjak
redis-cli --bigkeys

# Nilai berbeda antar pod = bukti L1 tidak sinkron
for p in $(kubectl get pods -l app=api -o name); do
  kubectl exec "$p" -- curl -s localhost:8080/debug/cache/produk/42
done | sort | uniq -c
```

```sql
-- LISTEN/NOTIFY: pastikan pendengarnya benar-benar ada dan hidup
SELECT pid, application_name, state, now()-state_change AS diam
FROM pg_stat_activity WHERE query ILIKE 'LISTEN%';
```
