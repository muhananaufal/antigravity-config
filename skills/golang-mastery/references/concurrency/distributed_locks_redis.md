# Distributed Locks & Redlock (Redis)

> **Berlaku:** Go 1.21+ · Redis 7+ · `go-redsync` · **Lihat juga:** `distributed_patterns_resilience/idempotency_key_engine.md` · `db_sqlc/database_locking_strategies.md` · `background_jobs_worker/cron_scheduler_go.md` · `caching_strategy/redis_advanced_patterns.md`

## Konsep Utama
Dalam transisi dari aplikasi *monolith* menuju arsitektur *microservices* terdistribusi yang masif, primitif sinkronisasi Go bawaan (seperti `sync.Mutex` atau `channels`) menjadi **tidak relevan** untuk menjaga konsistensi eksternal. `sync.Mutex` di Go secara ketat hanya mengunci goroutine *dalam satu mesin / alamat RAM (process space) yang sama*. Jika aplikasi penjadwal tagihan (Billing Job) Anda di-deploy di 5 Pod Kubernetes replika, kelimanya akan melakukan proses `cron` secara serentak, menembus `sync.Mutex` lokal mereka, dan merusak / menduplikasi tagihan user di Database (Data Corruption). 

Oleh karenanya, dibutuhkan mekanisme sinkronisasi pihak ketiga: **Distributed Locks** (Kunci Terdistribusi), di mana *Redis* adalah broker yang paling populer berkat kecepatannya di memori.

1. **SETNX (Set if Not eXists)**: Ini adalah fondasi dari Redis Lock. Pod akan meminta Redis membuat sebuah `key` string. Jika key itu belum ada, instruksi berhasil dan Pod "mendapat lock". Jika key sudah ada, instruksi ditolak (gagal), menandakan pod lain sedang memegang lock.
2. **Atomic Unlock via Lua Script**: Melepaskan Lock (menggunakan `DEL key`) *sangat berbahaya* bila dilakukan naif. Anda hanya berhak melepas Lock yang *Anda* buat sendiri. Maka, kita wajib mengisikan UUID unik sebagai *value* saat SETNX. Saat saatnya Unlock, kita lempar Lua Script ke Redis untuk dicek di level engine Redis: "Hanya hapus key ini JIKA value-nya sama persis dengan UUID saya".
3. **Lease / TTL Expiration (Deadlock Guard)**: Sebuah distributed lock *harus* memiliki masa berlaku (e.g. 5 detik). Jika server Pod pemegang lock tiba-tiba mati listrik (crash) sebelum sempat mengirim perintah Unlock, lock tidak akan tersangkut selamanya (Deadlock terdistribusi) karena Redis akan otomatis menghapusnya (Expire).
4. **Redlock Algorithm**: Untuk sistem enterprise yang menuntut keandalan ekstrem, memakai 1 mesin Redis sebagai broker lock adalah Single Point of Failure (SPOF). Pencipta Redis mengusulkan Redlock: mendistribusikan permintaan Lock ke 5 server Redis independen. Lock sah jika berhasil didapat dari mayoritas (>=3). Di ekosistem Go, hal ini difasilitasi library `github.com/go-redsync/redsync`.

## Diagram ASCII

```text
    Distributed Locking Flow (Redis as Arbitrator)
    
 [Pod A] (K8s Node 1)                               [Redis Master Cluster]
    |                                                      |
 1. SET "lock_key" "uuid-A" NX PX 5000 -------------------> (OK, Acquired!)
    |                                                      |
 [Pod B] (K8s Node 2)                                      |
    |                                                      |
 1. SET "lock_key" "uuid-B" NX PX 5000 -------------------> (Failed, Key Exists) -> Pod B Batal/Sleep
    |
 [Pod A (Processing...)]                                   |
    |
 2. Finishes Job. EVAL(Lua: "if get == uuid-A then del") -> (Deleted! Lock Released)
    |
 [Pod B] (Node 2, Retries)                                 |
 3. SET "lock_key" "uuid-B" NX PX 5000 -------------------> (OK, Acquired!)
```

## Kode Go Production-Ready

Di bawah ini adalah implementasi Distributed Mutex yang *safe*, menggunakan `go-redis/redis` dengan *Context Timeout* dan jaminan atomik pelepasan kunci menggunakan *Lua Scripting*.

```go
package concurrency

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/google/uuid"
	"go.uber.org/goleak"
)

// ==========================================
// KODE PRODUCTION-READY
// ==========================================

// Lua script ini akan di-parse dan dieksekusi oleh redis-server dalam satu 
// unit atomik. Mencegah race condition ketika melepas lock.
const unlockScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
`

// RedisDistributedMutex adalah representasi Distributed Lock.
type RedisDistributedMutex struct {
	client     *redis.Client
	resource   string
	tokenValue string // UUID unik per upaya lock (owner fencing token)
	ttl        time.Duration
}

// NewRedisMutex membuat struct referensi penguncian untuk sebuah `resource`.
func NewRedisMutex(client *redis.Client, resource string, ttl time.Duration) *RedisDistributedMutex {
	return &RedisDistributedMutex{
		client:     client,
		resource:   "dlock:" + resource,
		tokenValue: uuid.New().String(),
		ttl:        ttl,
	}
}

// TryLock mencoba mengakuisisi lock di Redis. Return (true, nil) jika menang.
// Method ini bersifat non-blocking: jika dikuasai orang lain, langsung return false.
func (m *RedisDistributedMutex) TryLock(ctx context.Context) (bool, error) {
	// Menjalankan perintah: SET resource token NX PX ttl
	// NX: Hanya set jika tidak ada. PX: Expiration dalam miliseconds.
	ok, err := m.client.SetNX(ctx, m.resource, m.tokenValue, m.ttl).Result()
	if err != nil {
		return false, fmt.Errorf("redis setnx error: %w", err)
	}
	return ok, nil
}

// Unlock melepas kunci milik goroutine ini.
func (m *RedisDistributedMutex) Unlock(ctx context.Context) error {
	res, err := m.client.Eval(ctx, unlockScript, []string{m.resource}, m.tokenValue).Result()
	if err != nil {
		return fmt.Errorf("redis eval error: %w", err)
	}
	
	// Jika return 0, berarti kunci sudah tak ada (mungkin expired) 
	// ATAU kuncinya milik proses lain yang mengambil alih.
	if res.(int64) == 0 {
		return errors.New("unlock failed: lock lost, expired, or owned by others")
	}
	return nil
}

// ==========================================
// UNIT TEST 
// ==========================================
// (Mengandalkan package alias/mock jika redis tidak berjalan)

func TestRedisDistributedMutex(t *testing.T) {
	defer goleak.VerifyNone(t)

	// CATATAN: Untuk unit test yang bersih di Production CI/CD, 
	// Anda WAJIB menggunakan library `alicebob/miniredis/v2` atau `testcontainers-go`.
	// Untuk keamanan, test ini dilewati secara default jika tak ada instruksi mock eksplisit.
	t.Skip("Membutuhkan instance redis-server (atau mock seperti miniredis) di localhost:6379")

	client := redis.NewClient(&redis.Options{Addr: "localhost:6379"})
	defer client.Close()
	
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	
	// Dua lock instance merepresentasikan dua POD yang berbeda.
	mutex1 := NewRedisMutex(client, "report-gen", 5*time.Second)
	mutex2 := NewRedisMutex(client, "report-gen", 5*time.Second)

	// Pod A (mutex1) menang lock
	acquired1, err := mutex1.TryLock(ctx)
	if err != nil || !acquired1 {
		t.Fatalf("mutex1 failed to lock: %v", err)
	}

	// Pod B (mutex2) mencoba mengambil lock yang sama, HARUSNYA GAGAL DIBLOK
	acquired2, err := mutex2.TryLock(ctx)
	if err != nil || acquired2 {
		t.Fatalf("mutex2 acquired lock, but it should be blocked by mutex1")
	}

	// Pod A selesai kerja, melepas lock
	err = mutex1.Unlock(ctx)
	if err != nil {
		t.Fatalf("mutex1 failed to unlock: %v", err)
	}

	// Pod B coba lagi setelah A lepas, HARUSNYA BERHASIL
	acquired3, err := mutex2.TryLock(ctx)
	if err != nil || !acquired3 {
		t.Fatalf("mutex2 failed to lock after mutex1 unlocked")
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan 2 Instruksi Terpisah (Non-Atomic) untuk Unlock

```go
// ❌ BAD: Rentan Data Race Eksternal (Time-Of-Check to Time-Of-Use bug)
func (m *BadMutex) Unlock(ctx context.Context) {
    // 1. Membaca Token ke RAM lokal Go
    token, _ := m.client.Get(ctx, m.resource).Result()
    if token == m.tokenValue {
        // [ JEDA FATAL BISA TERJADI DI SINI - CPU Pause, GC, Network Spike ]
        // Jika jeda lebih dari sisa TTL, lock akan hilang dari Redis dan Pod B 
        // masuk mengambil lock.
        
        // 2. Pod A jalan lagi, dan malah menghapus kunci milik Pod B !!
        m.client.Del(ctx, m.resource) 
    }
}
// BAD: Logic ini merusak batas perlindungan lock Pod lain.

// ✅ GOOD: Lempar Lua Script murni untuk diproses atomik 1 langkah di Redis
func (m *GoodMutex) Unlock(ctx context.Context) {
    m.client.Eval(ctx, unlockScript, []string{m.resource}, m.tokenValue)
}
// GOOD: Engine single-threaded Redis menjamin tak ada intrusi antar `GET` dan `DEL`.
```

**Why dangerous:** Saat mengeksekusi langkah ganda (Get lalu Del) dari sisi *Client* (aplikasi Go Anda), *Network Roundtrip* dan jeda *Garbage Collector (GC)* dapat mengintervensi eksekusi di antara dua instruksi tersebut. Di sela-sela jeda itu, `TTL` lock Anda di Redis bisa kedaluwarsa. Server B mengklaim lock tersebut. Begitu program Go Anda bangun dari *GC Pause* dan melanjutkan perintah ke baris `DEL`, Anda telah mendelete lock milik Server B! Hal ini membuka gerbang neraka di mana puluhan proses merasa mengantongi "Lock Sah" secara serentak.

### ❌ Anti-Pattern 2: Pekerjaan (Job) Lebih Lama daripada Durasi TTL

```go
// ❌ BAD: Membiarkan worker bekerja tanpa heartbeat saat TTL habis
mutex.TryLock(ctx) // TTL lock diset 10 detik
// BAD: DoHeavyDatabaseMigration butuh 45 detik berjalan.
// Pada detik ke-11, kunci hangus di Redis, Pod lain masuk ke method ini.
// Sekarang ada 2 proses migrasi berjalan menimpa database secara bersamaan.
DoHeavyDatabaseMigration()

// ✅ GOOD: Renew Lock (Heartbeat) di background
func LockAndKeepAlive(ctx context.Context) {
    mutex.TryLock(ctx) // TTL 10 sec
    
    // GOOD: Nyalakan Goroutine untuk "memperpanjang napas" lock (KeepAlive)
    ticker := time.NewTicker(4 * time.Second)
    go func() {
        for range ticker.C {
            RenewLockTTL_LuaScript() // Set expire kembali ke 10 detik
        }
    }()
    
    DoHeavyDatabaseMigration()
    ticker.Stop()
    mutex.Unlock(ctx)
}
```

**Why dangerous:** TTL adalah pelindung dari crash permanen (fail-safe). Namun ia juga menjadi bumerang jika program Anda memproses data secara pelan (*slow down*) melampaui waktu TTL. Lock yang hangus secara prematur dari Redis memberi sinyal "Aman, silakan masuk" ke Pod K8s lainnya. Akibatnya *Critical Section* terlanggar dan data base dapat rusak parah. Di sistem produksi mutakhir (seperti pola di *Redisson* Java), ada entitas bernama *Watchdog Goroutine* yang berdenyut memperpanjang TTL jika pekerjaan utama belum usai.

## Edge Cases

1. **Clock Drift (Ketidakselarasan Jam Mesin)**: Di dalam Topologi Multi-Master Redis, waktu (clock) pada server fisik/VM bisa tidak presisi dan melenceng beberapa puluh milidetik antar satu sama lain. Hal ini berbahaya bagi *Redlock Algorithm* yang sangat bergantung pada selisih timestamp untuk menimbang validitas lock.
   - *Defensive*: Jangan menaruh parameter TTL terlampau sempit (misal 50ms). Sediakan jaring pengaman waktu (Margin of Error) hingga 1-2 detik. Gunakan library spesifik (seperti `go-redsync`) yang internalnya telah mengalkulasi nilai kompensasi *Clock Drift* sebelum meng-grant lock ke aplikasi.

2. **Fencing Tokens dan Storage Out-of-Order**: Harus dipahami bahwa Distributed Lock dengan Redis adalah *Advisory Lock* (Pengunci berbasis Konsensus/Kerjasama), bukan gembok sejati. Jika aplikasi Go terjeda parah oleh OS (e.g. Memory Swapping) hingga lock kedaluwarsa dan direbut Pod lain, saat Pod lambat ini bangun, ia tetap berhak menembakkan Query `UPDATE` ke Database karena database-nya (PostgreSQL/MySQL) **TIDAK TAHU** menahu soal Redis. Permintaan itu diloloskan dan korupsi data mutlak terjadi.
   - *Defensive*: Sistem Database/Storage Backend Anda *wajib* dipasangkan "Fencing Tokens". Yaitu kolom `version` (Optimistic Locking). Redis hanya menjaga antrian aplikasi Anda, namun Database bertugas sebagai benteng terakhir dengan melempar Error jika query `version` yang dikirim sudah basi (`UPDATE table SET val=Y WHERE version=1`).

3. **Master-Slave Replication Lag**: Jika Anda menggunakan topologi redis standard Master-Replica. Ada jeda waktu asinkron saat Master menerima `SETNX` (mendapat Lock), lalu sinkronisasi data ke Replica memakan waktu milidetik. Apabila persis saat itu server Master *crash mati total*, Replica akan diangkat jadi Master baru lewat *Redis Sentinel*, TETAPI status Lock Anda tadi lenyap (karena belum tersalin)! Server Pod lain akan dengan mudah mengklaim lock di Master baru ini.
   - *Defensive*: Jika menjumpai kasus di mana 0.0001% data duplikat tidak bisa ditoleransi sama sekali (misal: Transfer Bank Rp100 Miliar), Anda TIDAK BOLEH memercayakan lock pada sistem eventually-consistent seperti Redis, apalagi arsitektur Master-Slave tunggal. Beralihlah pada algoritma mutlak *CP (Consistency/Partition-tolerance)* seperti *ZooKeeper*, *etcd*, atau penguncian level Database relasional langsung (`SELECT FOR UPDATE`). Redis Lock adalah trade-off agar sistem berjalan kencang (High Availability), bukan absolut.

## Kapan JANGAN Pakai Ini

- **Ketika kebenarannya wajib** — uang, stok, kuota. Lock Redis bersifat *advisory* dan bisa lenyap saat failover master-replica. Untuk jaminan mutlak, kunci di database yang memegang datanya (`SELECT ... FOR UPDATE`), atau pakai sistem CP seperti etcd.
- **Ketika operasinya bisa dibuat idempoten.** Operasi yang aman dijalankan dua kali tidak membutuhkan lock sama sekali. Idempotency key lebih sederhana, lebih murah, dan tidak punya mode gagal yang halus seperti TTL kedaluwarsa di tengah jalan.
- **Untuk memastikan satu cron berjalan di satu pod.** Yang tepat adalah *leader election* dengan sewa yang diperpanjang — `coordination.k8s.io/Lease` atau etcd — bukan lock TTL manual yang harus Anda perpanjang sendiri.
- **Redlock multi-master demi "lebih aman".** Ia menambah kerumitan besar untuk jaminan yang masih diperdebatkan di literatur. Redis satu instans ditambah *fencing token* di database biasanya pilihan yang lebih jujur dan lebih mudah dinalar.
- **Memegang lock selama panggilan jaringan tanpa batas waktu.** Bila panggilannya menggantung lebih lama dari TTL, lock hangus sementara pekerjaan masih berjalan — persis keadaan yang lock itu seharusnya cegah.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Job terjadwal berjalan dua kali | durasi job vs TTL lock | TTL hangus di tengah pekerjaan; butuh perpanjangan berkala |
| Job berhenti total setelah satu crash | `TTL` kunci = `-1` | Lock dibuat tanpa kedaluwarsa; tidak akan pernah lepas sendiri |
| Duplikasi tepat setelah failover Redis | waktu insiden vs `role` Redis | Lock belum tereplikasi saat master berganti |
| Latensi melonjak pada operasi ber-lock | `--latency-history` Redis | Lock menunggu Redis yang sedang lambat |
| Pod lambat menulis data usang | apakah ada fencing token | Lock sudah direbut pod lain; database tidak tahu apa-apa |

```bash
# Lock yang tertinggal dan TTL-nya. -1 berarti TANPA kedaluwarsa: bom waktu.
redis-cli --scan --pattern 'lock:*' | head -20
redis-cli ttl lock:migrasi-harian

# Apakah lock hilang karena pergantian peran?
redis-cli info replication | grep -E 'role|master_link_status|slave_repl_offset'

# Redis yang lambat membuat semua pemegang lock ikut lambat
redis-cli --latency-history -i 5
redis-cli slowlog get 10
```

```bash
# Job yang berjalan dua kali meninggalkan dua baris "mulai" untuk satu jadwal
kubectl logs -l app=worker --since=24h \
  | grep 'job_mulai' | jq -r '.jadwal_id' | sort | uniq -c | awk '$1 > 1'
```
