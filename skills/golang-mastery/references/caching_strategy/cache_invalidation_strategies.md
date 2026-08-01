# Cache Invalidation Strategies di Go: A Deep Dive

Mendesain sistem caching pada lingkungan terdistribusi dan highly concurrent selalu kembali pada salah satu masalah klasik dalam ilmu komputer: *Cache Invalidation*. Kesalahan dalam melakukan invalidasi cache dapat menyebabkan inkonsistensi data yang parah (stale data), anomali sistem, hingga cache stampede (thundering herd problem). Di Go, ekosistem untuk menangani ini sangat kaya berkat goroutine dan integrasi kuat dengan in-memory datastores seperti Redis dan Memcached.

Dokumen ini adalah referensi definitif mengenai berbagai strategi cache invalidation di Go, lengkap dengan implementasi production-ready, trade-off arsitektural, best practices, anti-patterns, dan edge cases ekstrem yang sering terjadi di environment skala besar.

---

## 1. Strategi Cache Invalidation

### 1.1 TTL-Based Invalidation (Time-To-Live)
Strategi paling sederhana: setiap key cache diberikan batas waktu (TTL) sebelum otomatis kedaluwarsa.
- **Kelebihan**: Sangat mudah diimplementasikan, memori secara otomatis dibersihkan.
- **Kekurangan**: Adanya jendela *stale data* antara waktu data di-update di database hingga TTL cache habis.
- **Cocok untuk**: Data agregasi lambat berubah, atau data yang toleran terhadap inkonsistensi sementara (misal: jumlah like pada video viral, feed rekomendasi).

### 1.2 Event-Driven Invalidation
Strategi di mana setiap perubahan state pada source of truth (Database) akan memancarkan sebuah event yang kemudian dikonsumsi oleh cache invalidator (melalui Kafka, RabbitMQ, atau Redis Pub/Sub). Sistem yang lebih handal menggunakan CDC (Change Data Capture) seperti Debezium atau *Transactional Outbox Pattern* agar event tidak hilang saat ada kegagalan sebagian.
- **Kelebihan**: Menurunkan waktu *stale data* secara drastis dibandingkan TTL murni, loosely coupled.
- **Kekurangan**: Kompleksitas arsitektur tinggi, risiko out-of-order events.

### 1.3 Tag-Based Invalidation
Teknik lanjutan di mana setiap entity cache dikelompokkan berdasarkan "tag". Misalnya, sebuah artikel cache di-tag dengan `tag:author:123` dan `tag:category:golang`. Jika author 123 di-update, sistem cukup melakukan operasi penghapusan pada semua key yang berelasi di dalam set `tag:author:123`.
- **Implementasi Redis**: Menyimpan relasi menggunakan struktur Set (`SADD tag:author:123 cache_key_1`), lalu saat invalidasi menggunakan `SMEMBERS tag:author:123` untuk mendapatkan daftar key yang harus dihapus, diikuti `DEL` (atau `UNLINK` untuk non-blocking delete) dan penghapusan tag set itu sendiri.
- **Kelebihan**: Granularitas luar biasa untuk menghapus kelompok data yang kompleks (misal query majemuk).
- **Kekurangan**: Overhead write cache lebih besar karena harus menyimpan tag, risiko *OOM* jika tag set membesar (*large collections*).

### 1.4 Write-Through & Write-Behind (Write-Back)
Dua paradigma tentang kapan data ditulis ke cache vs DB.
- **Write-Through**: Operasi tulis dilakukan ke Database dan Cache secara sinkron (atomic bila memungkinkan). Aplikasi menunggu hingga keduanya sukses (atau DB sukses lalu Cache disinkronisasi langsung).
- **Write-Behind (Write-Back)**: Aplikasi hanya menulis data ke Cache, lalu segera me-return response. Secara *asynchronous*, sebuah worker (goroutine/scheduler) akan melakukan "flush" memindahkan data dari Cache ke Database.
  - **Risiko Write-Behind**: Jika node Cache (misal Redis) *crash* sebelum data di-flush ke DB, akan terjadi *Data Loss* permanen.

### 1.5 Cache Versioning
Sistem cache tidak dihapus melainkan "ditinggalkan" dengan cara mengubah skema key version. Misalnya `user:123:v1` berubah menjadi `user:123:v2`.
- **Kelebihan**: Bebas dari lock collision selama update besar-besaran, fallback sangat mudah (jika v2 rusak, kembalikan read ke v1).
- **Kekurangan**: Meninggalkan banyak sampah di memori (mengandalkan Eviction Policy Redis seperti `volatile-lru` atau `allkeys-lru` untuk bersih-bersih otomatis).

---

## 2. Diagram Perbandingan Strategi & Trade-off (ASCII)

```text
+-----------------------+-------------------+--------------------+------------------------+-----------------------------+
| Strategi              | Data Freshness    | Kompleksitas       | Risiko                 | Use Case Ideal              |
+-----------------------+-------------------+--------------------+------------------------+-----------------------------+
| TTL-Based             | Rendah (Stale)    | Rendah             | Cache Stampede saat    | Data statis, read-heavy,    |
|                       |                   |                    | TTL masif kedaluwarsa  | eventual consistency ok.    |
+-----------------------+-------------------+--------------------+------------------------+-----------------------------+
| Event-Driven          | Tinggi            | Sangat Tinggi      | Out-of-order events,   | Microservices, real-time    |
| (CDC/Outbox)          |                   | (Broker, Workers)  | message loss, lag      | dashboard, inventory.       |
+-----------------------+-------------------+--------------------+------------------------+-----------------------------+
| Tag-Based             | Sangat Tinggi     | Sedang             | Tag Set explosion,     | E-commerce (category &      |
|                       |                   |                    | Overhead saat write    | product relation invalid).  |
+-----------------------+-------------------+--------------------+------------------------+-----------------------------+
| Write-Through         | Sempurna          | Sedang             | Penurunan performa     | Financial data kecil,       |
|                       | (Atomic/Sync)     |                    | write (latency naik)   | user session.               |
+-----------------------+-------------------+--------------------+------------------------+-----------------------------+
| Write-Behind          | Rendah            | Tinggi             | DATA LOSS permanen     | Gaming leaderboard,         |
| (Write-Back)          | (DB Delay)        | (Async workers)    | saat crash node cache  | metric aggregations, views. |
+-----------------------+-------------------+--------------------+------------------------+-----------------------------+
| Cache Versioning      | Tinggi            | Rendah             | Memory Bloat (OOM)     | Schema change, massive      |
|                       |                   |                    | jika LRU tidak optimal | tenant updates.             |
+-----------------------+-------------------+--------------------+------------------------+-----------------------------+
```

---

## 3. Anti-Patterns Cache Invalidation

### Anti-Pattern 1: Manual Key Tracking (Sangat Rentan Miss/Lupa)
Menyebarkan logika penghapusan cache (`redis.Del()`) di mana-mana di seluruh layer handler atau repository. Ini melanggar SRP (Single Responsibility Principle) dan sangat rentan terhadap programmer yang lupa menambahkan `Del` saat membuat update endpoint baru.

❌ **BAD: Tersebar secara sporadis**
```go
// User Handler Layer
func (h *UserHandler) UpdateProfile(ctx context.Context, req UpdateReq) error {
    // 1. Update DB
    err := h.db.Exec("UPDATE users SET name = ? WHERE id = ?", req.Name, req.ID)
    
    // 2. Lupa delete cache profile jika req.Role berubah, hanya ingat name
    h.redis.Del(ctx, fmt.Sprintf("user:%d:name", req.ID))
    // OOPS: Lupa delete "user:%d:profile"
    
    return nil
}
```

✅ **GOOD: Event-driven atau Hook-based di Repository Level**
Gunakan event / hook pada level repository/ORM (seperti GORM Hooks `AfterUpdate`) agar semua perubahan pasti men-trigger invalidasi yang tersentralisasi.
```go
// User Repository Layer menggunakan Hook-like pattern atau Decorator
func (r *UserRepoWithCache) UpdateUser(ctx context.Context, user *User) error {
    // 1. Update Source of Truth
    if err := r.db.Update(ctx, user); err != nil {
        return err
    }
    
    // 2. Sentralisasi Invalidation
    return r.invalidateUserCaches(ctx, user.ID)
}

func (r *UserRepoWithCache) invalidateUserCaches(ctx context.Context, userID int64) error {
    keys := []string{
        fmt.Sprintf("user:%d:profile", userID),
        fmt.Sprintf("user:%d:permissions", userID),
    }
    // Hapus dengan UNLINK secara asinkron di background (Redis 4.0+)
    return r.redis.Unlink(ctx, keys...).Err()
}
```

### Anti-Pattern 2: Cache Thrashing dengan "Delete-All" (Flush)
Setiap ada update kecil, men-delete (flush) cache pada level namespace secara brutal menggunakan pattern glob (misal: `KEYS user:*` lalu `DEL`). `KEYS` akan mem-block Redis O(N) dan mematikan performa secara instan, sedangkan penghapusan massal mengakibatkan *Cache Stampede* karena request ke DB akan melonjak 1000x lipat bersamaan.

❌ **BAD: Block Redis dan Bikin Stampede**
```go
func (r *ItemRepo) UpdatePrice(ctx context.Context, itemID int, price float64) {
    r.db.UpdatePrice(itemID, price)
    
    // SANGAT BURUK: Menggunakan KEYS di production!
    keys, _ := r.redis.Keys(ctx, "items:*").Result() 
    r.redis.Del(ctx, keys...) // Menghapus SEMUA item cache karena 1 harga item berubah
}
```

✅ **GOOD: Tag-Based Invalidation menggunakan Sets**
```go
func (r *ItemRepo) UpdatePrice(ctx context.Context, itemID int, price float64) {
    r.db.UpdatePrice(itemID, price)
    
    // Hanya invalidasi cache yang memiliki tag itemID tersebut
    tagKey := fmt.Sprintf("tag:item:%d", itemID)
    
    // Ambil anggota tag
    cacheKeys, _ := r.redis.SMembers(ctx, tagKey).Result()
    if len(cacheKeys) > 0 {
        // Hapus cache spesifik (gunakan pipeline agar atomic & cepat)
        pipe := r.redis.Pipeline()
        pipe.Unlink(ctx, cacheKeys...)
        pipe.Unlink(ctx, tagKey) // Bersihkan tagnya juga
        _, _ = pipe.Exec(ctx)
    }
}
```

---

## 4. Production-Ready Go Implementation (Tag-Based & Event-Driven Hybrid)

Di bawah ini adalah implementasi `CacheManager` di Go menggunakan `go-redis/v9`. Ini memadukan Tag-Based Invalidation dengan eksekusi pipeline yang robust.

```go
package cachex

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type CacheManager interface {
	SetWithTags(ctx context.Context, key string, value interface{}, ttl time.Duration, tags ...string) error
	InvalidateByTags(ctx context.Context, tags ...string) error
	Get(ctx context.Context, key string) (string, error)
}

type redisCacheManager struct {
	client redis.UniversalClient
}

func NewRedisCacheManager(client redis.UniversalClient) CacheManager {
	return &redisCacheManager{client: client}
}

// SetWithTags menyimpan data dan merelasikannya dengan N tags
func (c *redisCacheManager) SetWithTags(ctx context.Context, key string, value interface{}, ttl time.Duration, tags ...string) error {
	pipe := c.client.Pipeline()
	
	// Set actual data
	pipe.Set(ctx, key, value, ttl)
	
	// Hubungkan key dengan tags
	for _, tag := range tags {
		tagKey := fmt.Sprintf("tag:%s", tag)
		pipe.SAdd(ctx, tagKey, key)
		// Set TTL untuk tag set agar tidak OOM jika data cache-nya sendiri expired
		// Idealnya TTL tag sedikit lebih lama dari TTL cache data
		pipe.Expire(ctx, tagKey, ttl+time.Minute)
	}
	
	_, err := pipe.Exec(ctx)
	return err
}

// InvalidateByTags menghapus semua cache yang terasosiasi dengan tag(s) tertentu
func (c *redisCacheManager) InvalidateByTags(ctx context.Context, tags ...string) error {
	if len(tags) == 0 {
		return nil
	}

	// Dalam eksekusi produksi, sangat dianjurkan menggunakan Lua Script untuk atomicitas
	// atau pipeline multi-step. Berikut adalah implementasi hybrid robust:
	
	pipe := c.client.Pipeline()
	
	for _, tag := range tags {
		tagKey := fmt.Sprintf("tag:%s", tag)
		
		// Kita butuh mengambil member terlebih dahulu. 
		// Menggunakan pipeline untuk batch read members bisa rumit jika datanya besar.
		// Secara aman, kita gunakan SMembers (ingat limit ukuran Set).
		members, err := c.client.SMembers(ctx, tagKey).Result()
		if err != nil && err != redis.Nil {
			continue // Skip or log err
		}
		
		if len(members) > 0 {
			// Gunakan UNLINK agar tidak mem-block thread Redis jika data > 10KB
			pipe.Unlink(ctx, members...)
		}
		// Hapus juga tag set-nya
		pipe.Unlink(ctx, tagKey)
	}
	
	_, err := pipe.Exec(ctx)
	return err
}

func (c *redisCacheManager) Get(ctx context.Context, key string) (string, error) {
	return c.client.Get(ctx, key).Result()
}
```

---

## 5. Unit Testing Invalidation

Dalam Go, testing redis secara nyata paling baik dilakukan dengan library `miniredis` (sebuah pure-Go Redis server).

```go
package cachex_test

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"yourproject/pkg/cachex"
)

func setupRedis(t *testing.T) (*miniredis.Miniredis, cachex.CacheManager) {
	mr, err := miniredis.Run()
	require.NoError(t, err)

	client := redis.NewClient(&redis.Options{
		Addr: mr.Addr(),
	})

	manager := cachex.NewRedisCacheManager(client)
	return mr, manager
}

func TestSetAndGet_Success(t *testing.T) {
	mr, cache := setupRedis(t)
	defer mr.Close()
	ctx := context.Background()

	err := cache.SetWithTags(ctx, "user:1", "data-user-1", time.Hour, "user:1")
	assert.NoError(t, err)

	val, err := cache.Get(ctx, "user:1")
	assert.NoError(t, err)
	assert.Equal(t, "data-user-1", val)
}

func TestInvalidateByTags_DeletesAssociatedKeys(t *testing.T) {
	mr, cache := setupRedis(t)
	defer mr.Close()
	ctx := context.Background()

	// Arrange: 3 cache data, 2 berelasi dengan org:555
	cache.SetWithTags(ctx, "report:A", "A", time.Hour, "org:555", "type:finance")
	cache.SetWithTags(ctx, "report:B", "B", time.Hour, "org:555", "type:hr")
	cache.SetWithTags(ctx, "report:C", "C", time.Hour, "org:999", "type:finance")

	// Act: Hapus cache org:555
	err := cache.InvalidateByTags(ctx, "org:555")
	assert.NoError(t, err)

	// Assert
	_, errA := cache.Get(ctx, "report:A")
	assert.ErrorIs(t, errA, redis.Nil, "report:A seharusnya terhapus")

	_, errB := cache.Get(ctx, "report:B")
	assert.ErrorIs(t, errB, redis.Nil, "report:B seharusnya terhapus")

	valC, errC := cache.Get(ctx, "report:C")
	assert.NoError(t, errC, "report:C tidak terpengaruh")
	assert.Equal(t, "C", valC)
}

func TestInvalidateByTags_Idempotent(t *testing.T) {
	mr, cache := setupRedis(t)
	defer mr.Close()
	ctx := context.Background()

	// Invalidate tag yang tidak ada tidak boleh error
	err := cache.InvalidateByTags(ctx, "nonexistent_tag")
	assert.NoError(t, err)
}
```

---

## 6. Edge Cases & Mitigasi di Skala Ekstrem

### Edge Case 1: Cache Invalidation dalam Distributed Transactions (Partial Failures / 2PC)
**Skenario**: Sistem menggunakan saga pattern. Service A sukses mengupdate DB dan meng-invalidate cache. Namun Service B gagal, sehingga transaksi di-rollback. Sekarang database rollback ke versi V1, tapi cache sudah terhapus dan di-populate oleh request concurrent lain dengan V2 (sebelum rollback selesai) atau menjadi inkonsisten.
**Mitigasi**:
- Jangan langsung menghapus (Del) cache saat transaksi DB masih berlangsung. Lakukan invalidasi *SETELAH* transaksi Commit (menggunakan Transactional Outbox pattern).
- *Tombstone Keys*: Daripada menghapus, tandai key tersebut dengan nilai `TOMBSTONE` yang punya TTL pendek (misal 5 detik). Siapapun yang membaca `TOMBSTONE` wajib me-read dari DB. Ini menahan request nakal yang mencoba me-repopulate cache saat transaksi masih labil.

### Edge Case 2: Cascade Invalidation Explosion (Thundering Herd Invocation)
**Skenario**: Menggunakan Tag-Based invalidation, dan entitas "Negara: Indonesia" di-update. Tag `tag:country:ID` ternyata berelasi dengan 10.000.000 keys di Redis. Perintah `SMEMBERS tag:country:ID` membuat response payload Redis sebesar 100MB, menyebabkan Redis CPU spike ke 100%, OOM (Out Of Memory) di client Go, dan mengunci entire service.
**Mitigasi**:
- Batasi jumlah maksimum elemen dalam Tag Set. Jika lebih dari `MAX_TAG_MEMBERS` (misal 5,000), jangan gunakan metode explicit deletion.
- Gunakan **Cache Versioning** untuk key yang masif. Daripada menghapus 10 juta key, cukup update version key untuk negara tersebut (e.g. `version:country:ID` menjadi `v2`). Semua request akan melampirkan versi terbaru ke query cache key `user:123:country:ID:v2`. Otomatis cache v1 ditinggalkan dan dievict oleh LRU.

### Edge Case 3: Out-of-Order Event Delivery (Race Condition pada CDC/PubSub)
**Skenario**: Anda menggunakan Kafka untuk Event-Driven Invalidation.
1. Event A: `Update name="Budi"`.
2. Event B: `Update name="Andi"`.
Dalam Kafka, Event A dan B di-proses out-of-order karena consumer lag/rebalancing.
Akibatnya: DB berisi "Andi", tapi Cache Invalidator memproses B lalu A. Cache berisi "Budi" = STALE selamanya.
**Mitigasi**:
- Gunakan partisi message broker (Kafka Partitioning) berbasis Key/ID sehingga urutan update ke ID yang sama *dijamin* sekuensial.
- Simpan *version number* (timestamp/sequence) ke dalam value Cache. Sebelum write/set cache, validasi menggunakan Lua Script di Redis: "Hanya overwrite jika version_baru > version_cache_lama".

### Edge Case 4: Network Partition antara App dan Cache (Stale Selamanya)
**Skenario**: Go app berhasil write DB, lalu hendak meng-invalidate cache, namun saat itu TCP connection ke Redis putus (Network Partition). Error terjadi, log mencatat error, dan aplikasi melaju. Result: Cache tidak terhapus, stale data bertahan sampai TTL habis (yang mungkin 30 hari).
**Mitigasi**:
- Terapkan **Fall-forward Retry**: Masukkan perintah penghapusan gagal ke local disk queue atau persistent queue lokal. Sebuah background worker (goroutine) akan retry terus menerus hingga Redis online.
- Gunakan TTL yang waras (misal maks 5 menit), sehingga walaupun invalidasi gagal karena network putus, *damage window*-nya maksimal 5 menit saja (Eventual Consistency).

### Edge Case 5: Race Condition antara Read-Through dan Explicit Invalidation
**Skenario (The Classic Race)**:
1. (T1) Goroutine 1 (GET) mendapati cache miss, query ke DB, dapat data lama = "V1".
2. (T2) Goroutine 2 (UPDATE) melakukan update DB menjadi = "V2".
3. (T3) Goroutine 2 (UPDATE) meng-invalidate cache (DELETE `key`).
4. (T4) Goroutine 1 (GET) kembali dari DB lalu melakukan `SET key "V1"`.
**Boom!** Cache berisi "V1" sementara DB sudah "V2". Ini akan stale selamanya.
**Mitigasi**:
- Gunakan algoritma *Lease* (seperti Memcached `GETS` / `CAS`).
- Di Redis: Jangan gunakan murni `SET`. Goroutine 1 dapat men-set lock atau placeholder terlebih dahulu (e.g. `SETNX key "FILLING"`). Jika goroutine 2 menghapus, `SET` selanjutnya (berbasis Lua/CAS) dari Goroutine 1 akan digagalkan jika state placeholder-nya sudah berubah atau hilang akibat `DEL` dari Goroutine 2.
- Mengubah Invalidasi (DEL) menjadi UPDATE paksa dengan data versi terbaru (Write-Through) yang menyertakan resource locking terpusat (Redlock / Mutex di level Go) di sekitar blok read-repopulate.

---

Dengan memahami strategi, pola implementasi, serta jebakan-jebakan ini, sistem terdistribusi di Go dapat mengamankan performa latensi mikrosekon tanpa mengorbankan konsistensi data yang fatal.
