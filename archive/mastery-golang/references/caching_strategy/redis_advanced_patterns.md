# Redis Advanced Patterns di Go: Arsitektur, Optimasi, dan Implementasi Production-Ready

> **Berlaku:** Go 1.21+ · Redis 7+ · `redis/go-redis/v9` · **Lihat juga:** `caching_strategy/cache_invalidation_strategies.md` · `concurrency/distributed_locks_redis.md` · `observability_resilience/rate_limiting_patterns.md` · `caching_strategy/multilevel_cache_l1l2.md`

Redis bukan sekadar key-value store biasa. Dengan stuktur data yang kaya dan kapabilitas eksekusi command pada level mikrodetik, Redis adalah senjata utama dalam arsitektur distributed systems modern. Namun, penggunaan Redis yang naif hanya akan memberikan sekelumit performa aslinya, dan pada skala besar, dapat menjadi bottleneck atau single point of failure. 

Dokumen ini adalah referensi mendalam mengenai advanced patterns penggunaan Redis dalam ekosistem Go, membahas mekanika internal, strategi optimal, implementasi kode *production-ready*, hingga jebakan (anti-patterns) dan *edge cases* yang sering terjadi di lapangan.

---

## 1. Mekanisme Komunikasi: Serial vs Pipelining

Dalam interaksi standar, klien Go mengirimkan satu command ke Redis dan memblokir (*block*) hingga balasan diterima. Waktu yang dibutuhkan untuk operasi ini didominasi oleh latensi jaringan (Network RTT - Round Trip Time), bukan waktu pemrosesan di server Redis yang biasanya berada di bawah rentang sub-milidetik.

### 1.1 Diagram ASCII: Serial Commands vs Pipeline Latency

```ascii
=== SKENARIO SERIAL COMMANDS (Klien menunggu tiap balasan) ===

Client                            Redis Server
  |                                   |
  |--- [CMD 1: SET user:1] ---------->|
  |                                   | (Processing... 0.1ms)
  |<-- [Reply 1: OK] -----------------|
  |                                   | (Total RTT = 2ms)
  |--- [CMD 2: SET user:2] ---------->|
  |                                   | (Processing... 0.1ms)
  |<-- [Reply 2: OK] -----------------|
  |                                   | (Total RTT = 2ms)
  |--- [CMD 3: SET user:3] ---------->|
  |                                   | (Processing... 0.1ms)
  |<-- [Reply 3: OK] -----------------|
  
Total Latency = (RTT 1 + RTT 2 + RTT 3) = 6ms


=== SKENARIO PIPELINE (Batch command transmission) ===

Client                            Redis Server
  |                                   |
  |--- [CMD 1: SET user:1] ---------->|
  |--- [CMD 2: SET user:2] ---------->|
  |--- [CMD 3: SET user:3] ---------->|
  |                                   | (Processing all 3 commands... 0.3ms)
  |<-- [Reply 1, Reply 2, Reply 3] ---|
  
Total Latency = 1 x RTT + Processing Time ≈ 2.3ms (Jauh lebih cepat!)
```

### 1.2 Pipelining di Go (go-redis)

Pipelining memungkinkan klien untuk mengirim banyak perintah sekaligus (batching) ke server tanpa menunggu balasan satu per satu. Balasan akan di-buffer di memori Redis server dan dikembalikan sekaligus. 

**Internals:**
- Redis menggunakan I/O multiplexing (`epoll` di Linux). Saat klien mengirim batch, Redis memproses instruksi yang ada di buffer socket sebelum *flush* balasan.
- Sangat berguna saat melakukan bulk insert data atau menarik banyak state dari berbagai keys secara bersamaan.
- *Trade-off*: Pipelining memakai lebih banyak RAM pada server untuk menyimpan buffer balasan. Jangan pipelining jutaan keys sekaligus; pecah dalam *chunk* ukuran wajar (misalnya: 500-1000 per *pipeline*).

**Production-Ready Code:**
```go
package redis_patterns

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// BulkCacheUserSessions menyimpan daftar sesi menggunakan pipeline
func BulkCacheUserSessions(ctx context.Context, rdb *redis.Client, sessions map[string]string) error {
	// Menggunakan pipeline untuk menghindari latensi RTT ganda
	pipe := rdb.Pipeline()

	for userID, sessionData := range sessions {
		key := fmt.Sprintf("session:%s", userID)
		// Perintah tidak langsung dikirim, tapi diantrekan di memory client
		pipe.Set(ctx, key, sessionData, 24*time.Hour)
	}

	// Mengeksekusi semua perintah dalam antrean secara atomik (dari sisi RTT)
	// Catatan: eksekusi Redis sendiri TIDAK atomik, bisa disela command lain
	_, err := pipe.Exec(ctx)
	if err != nil {
		return fmt.Errorf("failed to execute pipeline: %w", err)
	}

	return nil
}
```

---

## 2. Transactions: `MULTI` / `EXEC` untuk Atomic Operations

Berbeda dengan Pipelining yang ditujukan murni untuk optimasi RTT, Transactions (`MULTI`, `EXEC`, `DISCARD`, `WATCH`) digunakan untuk memastikan serangkaian perintah dijalankan bersamaan dalam *isolasi* penuh. Saat `EXEC` dipanggil, semua antrean perintah dijamin dieksekusi urut secara *atomic*; tidak ada command dari client lain yang menyela eksekusi tersebut.

**Internals & Optimistic Locking:**
- Pola *optimistic locking* menggunakan perintah `WATCH`.
- Jika suatu key "diawasi" (watched) dan berubah sebelum `EXEC`, maka transaksi akan di-abort (mengembalikan error `redis.TxFailedErr`), sehingga mencegah *race conditions*.

**Production-Ready Code:**
```go
// TransferPoints mentransfer poin antar pengguna secara atomic dengan Optimistic Locking
func TransferPoints(ctx context.Context, rdb *redis.Client, fromUser, toUser string, amount int) error {
	txf := func(tx *redis.Tx) error {
		// Dapatkan nilai saldo asal
		fromKey := fmt.Sprintf("user:%s:points", fromUser)
		toKey := fmt.Sprintf("user:%s:points", toUser)

		// Ambil balance (Read)
		balanceStr, err := tx.Get(ctx, fromKey).Int()
		if err != nil && err != redis.Nil {
			return err
		}

		// Validasi logic
		if balanceStr < amount {
			return fmt.Errorf("insufficient points")
		}

		// TxPipelined memastikan MULTI dan EXEC berjalan atomik dalam block tx
		_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
			pipe.DecrBy(ctx, fromKey, int64(amount))
			pipe.IncrBy(ctx, toKey, int64(amount))
			return nil
		})
		return err
	}

	// Jalankan transaksi di bawah proteksi Watch
	err := rdb.Watch(ctx, txf, fmt.Sprintf("user:%s:points", fromUser))
	if err == redis.TxFailedErr {
		return fmt.Errorf("transaction failed due to concurrent modification")
	} else if err != nil {
		return err
	}
	return nil
}
```

---

## 3. Lua Scripting: Atomic Read-Modify-Write

Sementara transaksi `WATCH` rentan gagal jika terjadi *contention* (persaingan tinggi), *Lua scripting* (melalui `EVAL` atau `EVALSHA`) memindahkan komputasi dan logika baca-tulis ke sisi server.

**Internals:**
- Redis mengeksekusi Lua scripts secara *atomic* (single-threaded nature).
- Script tidak dapat disela (di-*preempt*) oleh koneksi mana pun sampai script tersebut selesai, menjamin isolasi read-modify-write sempurna tanpa overhead client-server (RTT).
- Karena memblokir seluruh proses Redis, script harus berjalan *sangat cepat* (O(1) atau O(N) dengan N kecil).

**Production-Ready Code (Rate Limiter Berbasis Token Bucket):**
```go
var checkAndDeductTokenScript = redis.NewScript(`
	local key = KEYS[1]
	local max_tokens = tonumber(ARGV[1])
	local refill_rate = tonumber(ARGV[2])
	local now = tonumber(ARGV[3])
	local request_tokens = 1

	-- Struktur Hash: last_refill, tokens
	local bucket = redis.call("HMGET", key, "last_refill", "tokens")
	local last_refill = tonumber(bucket[1]) or now
	local current_tokens = tonumber(bucket[2]) or max_tokens

	-- Kalkulasi refill
	local time_passed = math.max(0, now - last_refill)
	local tokens_to_add = math.floor(time_passed * refill_rate)
	
	if tokens_to_add > 0 then
		current_tokens = math.min(max_tokens, current_tokens + tokens_to_add)
		last_refill = now
	end

	if current_tokens >= request_tokens then
		current_tokens = current_tokens - request_tokens
		redis.call("HMSET", key, "last_refill", last_refill, "tokens", current_tokens)
		-- Optional: Set expire agar key tidak bocor jika tidak dipakai
		redis.call("EXPIRE", key, 3600)
		return 1 -- OK
	else
		-- Refill aja walau gagal untuk up-to-date
		redis.call("HMSET", key, "last_refill", last_refill, "tokens", current_tokens)
		redis.call("EXPIRE", key, 3600)
		return 0 -- Gagal
	end
`)

// IsAllowedRateLimit memanggil script Lua rate limiter secara aman
func IsAllowedRateLimit(ctx context.Context, rdb *redis.Client, clientIP string) (bool, error) {
	key := fmt.Sprintf("rate_limit:%s", clientIP)
	now := time.Now().Unix()
	
	res, err := checkAndDeductTokenScript.Run(ctx, rdb, []string{key}, 10, 1, now).Result()
	if err != nil {
		return false, err
	}
	return res.(int64) == 1, nil
}
```

---

## 4. Redis Streams: Lightweight Message Queue

Redis Streams adalah struktur data *append-only* tingkat lanjut (mengadopsi ide dari Kafka) yang memungkinkan penyebaran data dan manajemen konsumen (Consumer Groups).

**Internals:**
- `XADD` menghasilkan O(1) appending. Tiap pesan diberi ID unik berbasis waktu (misal: `1518951480106-0`).
- `XREADGROUP` memungkinkan distribusi antrean (fan-out) antar instance pekerja mikroservis, sehingga satu pesan hanya dikerjakan satu pekerja.
- Pekerja harus mengirim `XACK` untuk menandai pesan selesai. Pesan yang macet (di-pick up tapi tidak di-ack) berada di area `PEL` (Pending Entries List) dan dapat diklaim ulang (*reclaim*) menggunakan `XCLAIM`.

**Production-Ready Code:**
```go
func PublishEvent(ctx context.Context, rdb *redis.Client, streamName string, payload map[string]interface{}) error {
	// Menambahkan maxlen untuk mencegah memory leak
	args := &redis.XAddArgs{
		Stream: streamName,
		Values: payload,
		MaxLen: 100000,
		Approx: true,
	}
	_, err := rdb.XAdd(ctx, args).Result()
	return err
}

func ConsumeEventsLoop(ctx context.Context, rdb *redis.Client, stream, group, consumer string) {
	// Pastikan grup dibuat (abaikan jika ada)
	_ = rdb.XGroupCreateMkStream(ctx, stream, group, "$").Err()

	for {
		select {
		case <-ctx.Done():
			return
		default:
			// Blokir 2 detik mencari pesan
			args := &redis.XReadGroupArgs{
				Group:    group,
				Consumer: consumer,
				Streams:  []string{stream, ">"},
				Block:    2 * time.Second,
			}
			
			streams, err := rdb.XReadGroup(ctx, args).Result()
			if err != nil {
				if err != redis.Nil {
					// Handling log error
				}
				continue
			}

			for _, strm := range streams {
				for _, msg := range strm.Messages {
					fmt.Printf("Processing %s: %v\n", msg.ID, msg.Values)
					// Lakukan ack setelah berhasil diproses
					rdb.XAck(ctx, stream, group, msg.ID)
				}
			}
		}
	}
}
```

---

## 5. Sorted Set (ZSET): Leaderboard & Sliding Window

ZSET memungkinkan pemetaan unik antara *member* (string unik) dan *score* (float). Elemen otomatis terurut berdasarkan *score*.

**Internals:**
- Menggunakan kombinasi *Hash Table* dan *Skip List*. Kompleksitas penambahan/pencarian adalah O(log N).
- Berguna untuk *Leaderboard* game, atau pola algoritmik kompleks seperti **Sliding Window Rate Limit** dengan membuang member ber-score masa lampau (menggunakan waktu *timestamp*).

**Production-Ready Sliding Window Rate Limiter:**
```go
// SlidingWindowRateLimit memeriksa apakah request diperbolehkan
// maxRequests = 100, window = 60s
func SlidingWindowRateLimit(ctx context.Context, rdb *redis.Client, userID string, maxReq int, window time.Duration) (bool, error) {
	key := fmt.Sprintf("sl_window:%s", userID)
	now := time.Now().UnixMilli()
	windowStart := now - window.Milliseconds()

	pipe := rdb.Pipeline()
	// 1. Bersihkan request di luar rentang window
	pipe.ZRemRangeByScore(ctx, key, "-inf", fmt.Sprintf("%d", windowStart))
	// 2. Tambahkan request saat ini (UUID atau nano stamp sebagai key agar unik)
	pipe.ZAdd(ctx, key, redis.Z{Score: float64(now), Member: fmt.Sprintf("%d", time.Now().UnixNano())})
	// 3. Hitung elemen di dalam window
	countCmd := pipe.ZCard(ctx, key)
	// 4. Reset expiry untuk membersihkan key basi
	pipe.Expire(ctx, key, window+time.Second)

	_, err := pipe.Exec(ctx)
	if err != nil {
		return false, err
	}

	count := countCmd.Val()
	if count > int64(maxReq) {
		return false, nil // Melebihi rate limit
	}
	return true, nil
}
```

---

## 6. Keyspace Notifications: Cache Invalidation Event

Aplikasi klien bisa berlangganan (melalui Pub/Sub internal) untuk di-notifikasi ketika suatu `key` kadaluarsa (expired), dihapus, atau diubah.

**Internals:**
- Event dikirim di channel khusus `__keyevent@<db>__:<event>`.
- **Perhatian:** Event fire-and-forget. Jika microservice restart, ia tidak akan tahu event yang terlewat. Gunakan hanya untuk invalidasi cache L1 lokal memori.

```go
func ListenForExpirations(ctx context.Context, rdb *redis.Client) {
	// Pastikan redis config 'notify-keyspace-events Ex' diaktifkan
	pubsub := rdb.Subscribe(ctx, "__keyevent@0__:expired")
	defer pubsub.Close()

	ch := pubsub.Channel()
	for {
		select {
		case msg := <-ch:
			fmt.Printf("Key Expired: %s\n", msg.Payload)
			// Trigger logic pembersihan internal, notif user session, dll
		case <-ctx.Done():
			return
		}
	}
}
```

---

## 7. Redis Cluster Key Distribution & Hash Tags

Pada mode Redis Cluster, dataset disebarkan ke-16384 slot hash. Klien melakukan hashing fungsi CRC16 terhadap *key* lalu `MOD 16384` untuk tahu node mana yang menyimpan.

**Internals Hash Tag `{...}`:**
- Saat melakukan multi-key transaction (Pipelining, MGET, Lua script) pada Cluster, **SEMUA KEY HARUS BERADA PADA SLOT (NODE) YANG SAMA**. Jika tidak, muncul error `CROSSSLOT`.
- Solusinya adalah *Hash Tags*: Jika key mengandung pola `{tag}`, hash akan dihitung HANYA berdasarkan kata dalam tanda kurung kurawal.

**Contoh:**
Key 1: `user:{100}:profile` (Slot A)
Key 2: `user:{100}:session` (Slot A)
Kedua key ini pasti jatuh ke slot yang sama!

```go
// Penggunaan yang BENAR di Redis Cluster
func UpdateProfileAndSession(ctx context.Context, rdb *redis.ClusterClient, userID string) {
	// Memanfaatkan Hash tag {} 
	profileKey := fmt.Sprintf("user:{%s}:profile", userID)
	sessionKey := fmt.Sprintf("user:{%s}:session", userID)

	// Sekarang aman dipipeline karena di slot yang sama
	pipe := rdb.Pipeline()
	pipe.Set(ctx, profileKey, "data", 0)
	pipe.Set(ctx, sessionKey, "token", 0)
	_, err := pipe.Exec(ctx) // TIDAK akan error CROSSSLOT
}
```

---

## 8. Anti-Patterns di Production

Banyak permasalahan Redis di-production bukan dikarenakan limitasi sistem, namun desain penggunaan yang naif.

### 8.1 ❌ BAD: Menggunakan KEYS * vs ✅ GOOD: Menggunakan SCAN

Perintah `KEYS *` mencari kecocokan O(N) dan akan memblokir Redis *thread* utama jika terdapat jutaan *keys*. Ini mematikan layanan aplikasi *real-time*.

❌ **BAD:**
```go
// JANGAN PERNAH LAKUKAN INI DI PRODUCTION
// Akan membuat server freeze selama proses jika data jutaan!
keys, err := rdb.Keys(ctx, "session:*").Result()
for _, key := range keys {
	rdb.Del(ctx, key)
}
```

✅ **GOOD:**
Gunakan perintah `SCAN` yang bekerja seperti kursor (iterator berbasis pagination).

```go
func CleanUpSessionsCursor(ctx context.Context, rdb *redis.Client) {
	var cursor uint64
	for {
		var keys []string
		var err error
		// Ambil max 500 keys secara parsial
		keys, cursor, err = rdb.Scan(ctx, cursor, "session:*", 500).Result()
		if err != nil {
			panic(err)
		}
		
		if len(keys) > 0 {
			// Hapus batch secara efisien
			rdb.Del(ctx, keys...) 
		}

		// Cursor 0 menandakan akhir scan iterasi
		if cursor == 0 {
			break
		}
	}
}
```

### 8.2 ❌ BAD: Inisialisasi Koneksi per Request

Redis Client Connection (terutama TCP `dial`) sangat mahal.

❌ **BAD:**
```go
func HandleHTTP(w http.ResponseWriter, r *http.Request) {
	// SANGAT BURUK! Membuat pool baru tiap request.
	rdb := redis.NewClient(&redis.Options{Addr: "localhost:6379"})
	defer rdb.Close()
	val, _ := rdb.Get(r.Context(), "key").Result()
}
```

✅ **GOOD:**
```go
// Inisiasi global / di-inject ke handler (Connection Pool bawaan go-redis otomatis)
var rdb *redis.Client = redis.NewClient(&redis.Options{
	Addr:         "localhost:6379",
	PoolSize:     100, // max koneksi di pool
	MinIdleConns: 10,
})

func HandleHTTP(w http.ResponseWriter, r *http.Request) {
	// Sangat aman diconcurrently pakai
	val, _ := rdb.Get(r.Context(), "key").Result()
}
```

---

## 9. Edge Cases yang Sering Terjadi (WAJIB DIPERHATIKAN)

1. **Redis Cluster Cross-Slot Transaction Error:**
   *Kondisi:* Ketika mencoba mengeksekusi LUA script yang berinteraksi dengan dua *keys* berbeda tanpa *hash tag*.
   *Solusi:* Wajib pasang pola kurung kurawal `{tag}` seperti `cart:{user_id}:item` dan `history:{user_id}:log` agar pemetaan CRC hash mematoknya ke *node*/slot yang sama.

2. **Lua Script Timeout (OOM atau Infinite Loop):**
   *Kondisi:* Skrip Lua memiliki kalkulasi lama (contoh iterasi `for` array raksasa). Karena redis itu single-threaded, request klien lain akan ter-block dan timeout.
   *Solusi:* Jaga limit waktu komputasi script (parameter `lua-time-limit` bawaan adalah 5 detik, namun pada dasarnya hindari kompleksitas di atas O(100)). Jika script *stuck*, operator harus menembak `SCRIPT KILL`.

3. **Memory Leak pada Streams `XADD` tanpa `MAXLEN`:**
   *Kondisi:* Menggunakan `XADD` tanpa henti, Stream akan membesar menelan RAM instance hingga memicu `OOM-Killer`.
   *Solusi:* Selalu gunakan parameter limit, e.g. `XADD mystream MAXLEN ~ 10000 * value`.

4. **Kondisi Thundering Herd (Cache Stampede):**
   *Kondisi:* Sebuah *hot key* (misal: JSON dashboard raksasa) expired. Seketika 10.000 requests Go bersamaan merequest database karena tembakan Redis miss.
   *Solusi:* Implementasi pattern *Singleflight* (contoh: paket `golang.org/x/sync/singleflight`) pada level Go *worker* di mana hanya 1 pemanggilan DB dilakukan yang dishare ke ribuan rutin lainnya. Atau gunakan "Soft TTL" di payload Redis.

5. **`go-redis` Connection Pool Timeout (Timeout vs MaxRetries):**
   *Kondisi:* Ketika trafik spike tajam, `go-redis` mencoba ambil koneksi dari *pool*. Jika limit *PoolSize* tercapai dan *PoolTimeout* (default 4s) terlewati, aplikasi melempar *timeout*.
   *Solusi:* Skalakan kapasitas `PoolSize` dan gunakan Metriks (Prometheus) untuk mendiagnosa utilitas *pool connection*, pastikan tidak terlalu rendah namun tidak melebihi kemampuan koneksi TCP di server Redis.

---

## 10. Real Unit Tests dengan miniredis

Mocking integrasi ke Redis seringkali rapuh. Best practice di Golang adalah memanfaatkan instance di-memori seperti paket `alicebob/miniredis`.

```go
package redis_patterns_test

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
)

func setupTestRedis(t *testing.T) (*miniredis.Miniredis, *redis.Client) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}

	client := redis.NewClient(&redis.Options{
		Addr: mr.Addr(),
	})
	
	// Pastikan dibersihkan
	t.Cleanup(func() {
		client.Close()
		mr.Close()
	})
	return mr, client
}

// 1. Uji Transaksi Pipeline
func TestBulkCacheUserSessions(t *testing.T) {
	mr, client := setupTestRedis(t)
	ctx := context.Background()

	sessions := map[string]string{
		"101": "session_data_abc",
		"102": "session_data_def",
	}

	// Panggil implementasi
	err := BulkCacheUserSessions(ctx, client, sessions)
	assert.NoError(t, err)

	// Cek state miniredis langsung
	val1, err := mr.Get("session:101")
	assert.NoError(t, err)
	assert.Equal(t, "session_data_abc", val1)
}

// 2. Uji Atomicity Transaksi Watch
func TestTransferPoints_ConcurrencyConflict(t *testing.T) {
	mr, client := setupTestRedis(t)
	ctx := context.Background()

	// Setup awal
	mr.Set("user:A:points", "100")
	mr.Set("user:B:points", "50")

	// Pura-puranya ini dijalankan bersamaan dengan goroutine
	// Kita akan memanipulasi WATCH point lewat miniredis langsung setelah WATCH
	// Untuk uji optimisict locking
	
	// Fungsi ini akan mensimulasikan kegagalan WATCH
	err := client.Watch(ctx, func(tx *redis.Tx) error {
		// Mengambil nilai
		tx.Get(ctx, "user:A:points")
		
		// [SIMULASI RACE CONDITION]: Ada pihak lain yang update value sebelum tx commit!
		mr.Set("user:A:points", "0") // Merusak state!

		_, err := tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
			pipe.DecrBy(ctx, "user:A:points", 50)
			return nil
		})
		return err
	}, "user:A:points")

	assert.Error(t, err)
	assert.Equal(t, redis.TxFailedErr, err, "Transaction should fail due to watch key modification")
}

// 3. Uji LUA Script Rate Limiter (Token Bucket)
func TestIsAllowedRateLimit(t *testing.T) {
	_, client := setupTestRedis(t)
	ctx := context.Background()
	ip := "192.168.1.1"

	// Bucket max=10, limit=1.
	// Kita hit 10x harusnya lolos
	for i := 0; i < 10; i++ {
		allowed, err := IsAllowedRateLimit(ctx, client, ip)
		assert.NoError(t, err)
		assert.True(t, allowed, "Harusnya allowed pada iterasi ke %d", i)
	}

	// Hit ke-11 harusnya habis token (gagal) karena interval blm lewat
	allowed, err := IsAllowedRateLimit(ctx, client, ip)
	assert.NoError(t, err)
	assert.False(t, allowed, "Harusnya DITOLAK karena bucket habis")
}
```

## Kapan JANGAN Pakai Ini

- **`KEYS` di produksi.** Redis bersifat satu utas; `KEYS` memblokir **seluruh** server selama pemindaian. Pada dataset besar itu berarti setiap klien membeku bersamaan. `SCAN` yang benar, dan tetap dengan hati-hati.
- **Skrip Lua yang panjang.** Skrip berjalan atomik — artinya seluruh server berhenti melayani selama skrip berjalan. Atomisitas yang Anda dapat dibayar dengan latensi semua orang.
- **Redis sebagai database utama tanpa memahami persistensinya.** RDB dan AOF memberi jaminan yang berbeda, dan konfigurasi bawaan bisa kehilangan penulisan terakhir saat crash. Itu keputusan yang harus diambil sadar.
- **`MULTI/EXEC` dianggap transaksi ACID.** Ia tidak punya rollback: perintah yang gagal saat eksekusi tidak membatalkan yang lain. Untuk atomisitas sungguhan, pakai skrip Lua yang pendek.
- **Kunci raksasa** — list atau hash berisi jutaan elemen. Satu operasi padanya memblokir server, dan `DEL`-nya juga. Gunakan `UNLINK` untuk penghapusan asinkron, dan pecah strukturnya sejak awal.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Semua klien membeku bersamaan | `slowlog` | Satu perintah memblokir server satu utas |
| Latensi p99 melonjak berkala | `latency history` | Fork untuk RDB, atau perintah berat periodik |
| Memori penuh lebih cepat dari perkiraan | `--bigkeys` | Ada struktur data yang membengkak |
| Data hilang setelah restart | `info persistence` | Konfigurasi persistensi tidak sesuai harapan |
| `DEL` menyebabkan lonjakan latensi | ukuran kunci yang dihapus | Penghapusan sinkron pada kunci raksasa |

```bash
# Perintah yang memblokir server -- ini tempat pertama yang dilihat saat Redis lambat
redis-cli slowlog get 10
redis-cli --latency-history -i 5

# Kunci raksasa: penyebab paling umum lonjakan latensi yang tidak dijelaskan apa pun
redis-cli --bigkeys
redis-cli memory usage nama:kunci:besar

# Jaminan persistensi yang sebenarnya berlaku
redis-cli info persistence | grep -E 'aof_enabled|rdb_last_bgsave_status|aof_last_write_status'
redis-cli config get save
redis-cli config get appendfsync

# Klien yang paling banyak mengirim perintah
redis-cli info commandstats | sort -t= -k2 -rn | head
```
