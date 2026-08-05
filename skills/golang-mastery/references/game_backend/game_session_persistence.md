# Game Session & Data Persistence

> **Berlaku:** Go 1.21+ · **Lihat juga:** `game_backend/game_server_architecture.md` · `db_sqlc/acid_transactions_isolation.md` · `distributed_patterns_resilience/idempotency_key_engine.md` · `observability_resilience/graceful_shutdown_drain.md`

## Konsep Internal & Trade-offs

Di game multiplayer yang persisten (MMORPG atau Game Survival dengan *Progression* level), kehilangan data (rollback progress) karena server mati (*crash*) adalah dosa fatal yang menyebabkan pemain berhenti bermain (*churn rate* tinggi).

Masalah utama: Database relasional SQL (PostgreSQL/MySQL) atau NoSQL di-rancang untuk konsistensi transaksi (ACID). Tapi, `INSERT/UPDATE` memakan waktu I/O (millisecond) dan menuntut Lock tabel/row. Di game server, state pemain berubah setiap milidetik (EXP naik, HP turun, dapat item). Melakukan sinkronisasi penuh (Full Save) ke Database Utama (RDBMS) pada **setiap** aksi akan menghancurkan database Anda seketika (*Database Meltdown*).

Pola industri yang dominan adalah arsitektur hibrida memori dan penyimpanan lambat (Write-Back Caching via Redis):
1. **Source of Truth Jangka Pendek (Hot State)**: Memori RAM di proses Golang itu sendiri.
2. **Crash Recovery & Fast State (Warm State)**: Redis In-Memory Database (AOF Enabled). Semua state pemain di-flush ke Redis setiap beberapa detik atau pada *Event* krusial tertentu (seperti mendapatkan *Rare Item* atau menyelesaikan Quest).
3. **Permanent Storage (Cold State)**: Relational Database (PostgreSQL). Bertugas hanya sebagai penyimpanan historis jangka panjang (Periodik *Cron Job* per 5-15 menit) atau saat sesi pemain terputus mutlak (Logout). 

**Trade-offs**: Redis dan Async-Save sangat cepat, tapi Anda mengorbankan sebagian batas konsistensi (Eventual Consistency). Jika server fisik mati lampu dan Redis belum tersinkron ke Disk (*fsync* AOF/RDB defaultnya per-detik), progres selama maksimum 1-5 detik bisa raib.

## Arsitektur & Alur Persistensi

```text
[GAME SERVER (Golang Process)]               [REDIS SERVER (Memory)]          [POSTGRESQL (Disk)]
      (Data Pemain di RAM)                     (Sorted Sets / Hashes)            (Tabel Player)
               |                                        |                               |
    [Pemain bunuh Monster]                              |                               |
    [RAM: EXP +10, Emas +50] (Instan)                   |                               |
               |                                        |                               |
    [Tick Timer 10 Detik]                               |                               |
               |---- (1) Delta Flush (Hanya EXP/Emas) ->|                               |
               |     menggunakan Redis HINCRBY          |                               |
               |                                        |                               |
    [Pemain mendapatkan Pedang Epic (Critical)]         |                               |
               |---- (2) Synchronous Save (Blocking) -->|                               |
               |                                        |                               |
    [Pemain Logout / Server Shutdown]                   |                               |
               |                                        |-----(3) Pekerja (Cron/Go) --->|
               |                                        |   Memindahkan semua record    |
               |                                        |   dari Redis ke PostgreSQL    |
```

## Kode Go Production-Ready

Contoh pola Write-Back ke Redis menggunakan *Pipeline* (Batching perintah) untuk mengurangi overhead jaringan, dan memisahkan alur *Save* periodik ringan vs *Save* kritikal.

```go
package persistence

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	// Pseudo-paket untuk simulasi driver. Dalam produksi gunakan redis/go-redis/v9
)

type RedisClient interface {
	HIncrBy(ctx context.Context, key, field string, incr int64) error
	Pipeline() RedisPipeline
}

type RedisPipeline interface {
	HIncrBy(ctx context.Context, key, field string, incr int64)
	Exec(ctx context.Context) error
}

// SessionManager bertanggung jawab terhadap sinkronisasi memory ke Redis
type SessionManager struct {
	mu           sync.RWMutex
	redisClient  RedisClient
	dirtyPlayers map[string]*PlayerDirtyState
}

// PlayerDirtyState menyimpan akumulasi selisih/perubahan (Delta) saja!
// Bukan seluruh entity pemain. Ini menekan ukuran payload.
type PlayerDirtyState struct {
	ExpDelta  int64
	GoldDelta int64
}

func NewSessionManager(redis RedisClient) *SessionManager {
	return &SessionManager{
		redisClient:  redis,
		dirtyPlayers: make(map[string]*PlayerDirtyState),
	}
}

// AddExp adalah fungsi O(1) in-memory yang dipanggil oleh Game Loop secara instan.
func (sm *SessionManager) AddExp(playerID string, amount int64) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	state, exists := sm.dirtyPlayers[playerID]
	if !exists {
		state = &PlayerDirtyState{}
		sm.dirtyPlayers[playerID] = state
	}
	// Akumulasi di memori
	state.ExpDelta += amount
}

// StartAutoSaveLoop adalah daemon goroutine yang berjalan di background
func (sm *SessionManager) StartAutoSaveLoop(ctx context.Context) {
	// Interval 5 detik untuk membatasi traffic ke Redis
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			// [CRITICAL] Flush terakhir sebelum server mati sepenuhnya
			sm.FlushToRedis(context.Background())
			return
		case <-ticker.C:
			sm.FlushToRedis(ctx)
		}
	}
}

// FlushToRedis memindahkan Delta RAM ke Redis menggunakan Pola Pipelining
func (sm *SessionManager) FlushToRedis(ctx context.Context) {
	sm.mu.Lock()
	// Ambil semua yang dirty, lalu reset map dirty ke map kosong baru 
	// agar Mutex dilepas seketika (mengurangi contention waktu Game Loop utama).
	dirtyCopy := sm.dirtyPlayers
	sm.dirtyPlayers = make(map[string]*PlayerDirtyState)
	sm.mu.Unlock()

	if len(dirtyCopy) == 0 {
		return // Tidak ada yang perlu disave
	}

	// Gunakan pipeline untuk memaketkan ratusan Command Redis dalam 1 RTT Jaringan
	pipe := sm.redisClient.Pipeline()

	for playerID, delta := range dirtyCopy {
		key := fmt.Sprintf("player:%s:stats", playerID)
		
		if delta.ExpDelta != 0 {
			pipe.HIncrBy(ctx, key, "exp", delta.ExpDelta)
		}
		if delta.GoldDelta != 0 {
			pipe.HIncrBy(ctx, key, "gold", delta.GoldDelta)
		}
	}

	// Eksekusi massal (I/O Blocking terjadi di luar scope Game Loop Mutex)
	err := pipe.Exec(ctx)
	if err != nil {
		log.Printf("failed to flush state to Redis: %v", err)
		// Error handling lanjutan: Kembalikan data ke dirty map (Retry mechanism)
		sm.mu.Lock()
		for pid, failedDelta := range dirtyCopy {
			if existing, ok := sm.dirtyPlayers[pid]; ok {
				existing.ExpDelta += failedDelta.ExpDelta
				existing.GoldDelta += failedDelta.GoldDelta
			} else {
				sm.dirtyPlayers[pid] = failedDelta
			}
		}
		sm.mu.Unlock()
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan JSON Blob utuh ke dalam Database untuk State yang Serapuh-Cepat
Setiap kali pemain mendapatkan 1 emas, server mengambil *full state* dari RAM, serialisasi (JSON struct Player raksasa berukuran 5KB), lalu menimpakan utuh (overwrite/SET) ke Database/Redis.

```go
// BAD: State Replacement (Beresiko Data Race dan Boros Bandwidth)
player := server.GetPlayer(1) // struct lengkap (tas, misi, gold, skill)
player.Gold += 1
payload, _ := json.Marshal(player)

redis.Set(ctx, "player:1", payload, 0) // Menulis ulang seluruh 5KB tiap kali 1 stat berubah
```
**Why dangerous:** Ini memicu dua musibah. 1) *Bandwidth membludak*: Memperbarui 500 pemain setiap 5 detik berarti mentransfer MBs data sia-sia. 2) *Race Condition Distributed*: Jika ada layanan sekunder (misalnya layanan Web Store) yang secara konkuren memotong Gold pemain untuk membeli item di Redis, lalu DGS Anda me-replace utuh seluruh JSON, pembelian Web Store akan lenyap (tertiban versi JSON DGS kuno). Solusinya, gunakan *Delta Increment* (seperti `HINCRBY` atau query SQL `SET gold = gold + X`).

### ❌ Anti-Pattern 2: Logout Blocking di Main Game Loop
Ketika pemain disconnect (DC) mendadak, Goroutine utama/jaringan pemain memaksa sinkronisasi sinkronous menyeluruh ke SQL *sebelum* membuang sisa sesi RAM.

```go
// BAD: Blocking network/game thread untuk DB Flush
func (c *Client) OnDisconnect() {
    // Mengeblok seluruh alur kerja room selama 500ms menunggu Postgres
    db.Exec("UPDATE players SET ...", c.State) 
    Room.RemoveClient(c)
}
```
**Why dangerous:** PostgreSQL bisa jadi sedang sibuk melakukan *Vacuum*, menyebabkan latensi *query* spike menjadi 1 detik. Klien Anda (WebSocket thread atau Goroutine Room) akan tertahan 1 detik penuh. Pemain lain yang tergabung dalam room/shard yang sama mendadak nge-lag karena thread room sibuk nyimpen DB. *Good Pattern*: Buang status ke Antrean Background (Task Queue/Worker) seperti RabbitMQ, Redis List, atau Goroutine perantara *buffered channel*, lalu anggap klien *disconnected* secara cepat.

### ❌ Anti-Pattern 3: Tidak Menangani "Dirty State" saat Server Graceful Shutdown
Hanya mengandalkan timer interval.

```go
// BAD: Exit sepihak tanpa membereskan akumulasi
func main() {
    go autoSaveLoop()
    RunServer()
    os.Exit(0) // 4 Detik akumulasi memori lenyap seketika!
}
```
**Why dangerous:** Saat rilis versi atau perbaikan (*maintenance*), Anda mengirim sinyal SIGTERM. Proses Go (OS) terhenti, seluruh memori RAM lenyap. Karena `autoSaveLoop` baru di detik ke-4 (belum mencapai 5 detik), progres pemain 4 detik ke belakang menguap (*Mass Rollback*). Klien akan mengeluh Item Drop terhapus. Solusi WAJIB: Tangkap `os.Signal` syscall, lakukan blokir channel selama Graceful Shutdown untuk memaksa satu kali `FlushToRedis` massal sebelum `os.Exit`.

## Edge Cases

1. **Redis Crash di Tengah Battle (Split-Brain Memory):** Jika instance Redis mati *Out of Memory*, `HINCRBY` akan mengembalikan gagal (Err). Jika Anda tidak menerapkan blok *Retry Mechanism* seperti di kode produksi atas, delta memori (10 EXP) akan dibuang/tenggelam selamanya. Saat Redis hidup lagi, State server (Player lvl 5) vs Redis (Player lvl 4) akan tidak tersinkronisasi. Pastikan Anda mengembalikan status kotor (*Dirty*) ke antrean depan bila gagal I/O!
2. **Item Duplication Glitch (Race Condition Login):** Pemain A sedang bermain dan mendapat Pedang X. Dia tiba-tiba memutus koneksi internetnya mendadak (DC kotor tanpa FIN paket). Server DGS masih menganggapnya Online selama 15 detik (Timeout). Pemain A cepat-cepat login lagi, Server Login merutekannya ke Node Server DGS ke-2. Sekarang ada 2 proses Go paralel yang menge-load dan men-save profil pemain yang sama. Ini adalah celah duplikasi item (Eksploit legendaris). **Penanganan**: Anda WAJIB membuat *Distributed Lock* di Redis (`SETNX player:1:online node_id EX 20`) sebelum membiarkan node mana pun *nge-load* profilnya.
3. **Penyimpanan Barang Unik / Inventaris (Kompleksitas Delta):** `HINCRBY` gampang untuk angka (Gold/EXP). Tapi bagaimana jika inventory pemain digeser susunannya, atau pedang di-enhancement (+1 -> +2)? Untuk data bertipe Array/Struct yang kompleks, gunakan struktur Redis Hashes dan simpan JSON sub-node. Atau, Anda butuh pola *Event Sourcing* di mana semua aksi ("Player A Swap Slot 1 to 2") diubah menjadi byte pesan murni dan dikirim ke Kafka/Redis Stream untuk di-replay ulang di *backend* pemrosesan mandiri.

## Unit Test Meaningful

```go
package persistence_test

import (
	"context"
	"testing"
)

// MockRedisPipeline untuk simulasi tanpa jaringan
type MockRedisPipeline struct {
	Ops map[string]int64
	Err error
}

func (m *MockRedisPipeline) HIncrBy(ctx context.Context, key, field string, incr int64) {
	if m.Ops == nil {
		m.Ops = make(map[string]int64)
	}
	m.Ops[key+":"+field] += incr
}

func (m *MockRedisPipeline) Exec(ctx context.Context) error {
	return m.Err
}

// MockRedis Client
type MockRedis struct {
	Pipe *MockRedisPipeline
}

func (m *MockRedis) Pipeline() persistence.RedisPipeline {
	return m.Pipe
}
func (m *MockRedis) HIncrBy(ctx context.Context, key, field string, incr int64) error {
	return nil
}

func TestSessionManager_AccumulatesAndFlushesDeltas(t *testing.T) {
	mockPipe := &MockRedisPipeline{Ops: make(map[string]int64)}
	mockClient := &MockRedis{Pipe: mockPipe}
	
	manager := persistence.NewSessionManager(mockClient)

	// Aksi 1: Musuh Mati (+10 EXP)
	manager.AddExp("p123", 10)
	
	// Aksi 2: Selesaikan Quest (+50 EXP) - Akumulasi cepat di memory!
	manager.AddExp("p123", 50)

	// Pastikan Redis (pipeline) belum tersentuh sebelum Flush
	if val, ok := mockPipe.Ops["player:p123:stats:exp"]; ok && val != 0 {
		t.Fatalf("Expected Redis to be empty before flush, but found ops")
	}

	// Trigger manual Flush (seolah-olah ticker 5 detik kena)
	manager.FlushToRedis(context.Background())

	// Verifikasi State Pipelined ke Redis -> Hasilnya harus 60 EXP (10 + 50 ditotal in-memory)
	if mockPipe.Ops["player:p123:stats:exp"] != 60 {
		t.Fatalf("Expected Redis HINCRBY by 60, got %d", mockPipe.Ops["player:p123:stats:exp"])
	}

	// Flush kedua kalinya (Tanpa ada aktivitas baru)
	// Seharusnya tidak menambahkan +60 lagi (Dirty map harusnya kosong)
	mockPipe.Ops = make(map[string]int64) // Reset spy mock
	
	manager.FlushToRedis(context.Background())
	
	if len(mockPipe.Ops) != 0 {
		t.Fatalf("Expected no ops on second flush, but got ops: %v", mockPipe.Ops)
	}
}
```

## Kapan JANGAN Pakai Ini

- **Menyimpan state ke database setiap tick.** Tick 30 Hz dikali ribuan sesi adalah beban tulis yang tidak akan ditangani database mana pun. Simpan pada titik yang bermakna: akhir ronde, perubahan penting, dan interval berkala.
- **Tanpa checkpoint sama sekali.** Deploy dan crash akan menghapus kemajuan pemain, dan itu adalah salah satu keluhan paling merusak kepercayaan pada permainan daring.
- **Penyimpanan yang tidak idempoten.** Retry saat simpan bisa menggandakan hadiah atau item. Pada ekonomi permainan, itu masalah yang menyebar cepat.
- **Mengandalkan graceful shutdown untuk menyimpan.** Node bisa hilang tanpa sinyal. State yang hanya tersimpan saat shutdown adalah state yang akan hilang.
- **Menyimpan seluruh state dunia per pemain.** Data tumbuh cepat dan sebagian besar tidak pernah dibaca lagi. Simpan yang benar-benar menentukan kemajuan.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Beban tulis database sangat tinggi | frekuensi checkpoint | Terlalu sering menyimpan |
| Pemain melaporkan kemajuan hilang | interval checkpoint terakhir | Terlalu jarang menyimpan |
| Item atau hadiah ganda | idempotensi penyimpanan | Retry menggandakan |
| Kehilangan state saat node hilang | apakah bergantung pada shutdown | Penyimpanan hanya saat berhenti rapi |
| Ukuran data per pemain tumbuh cepat | apa yang disimpan | Menyimpan lebih dari yang dibutuhkan |

```sql
-- Jarak antara checkpoint terakhir dan sekarang: ini "berapa banyak yang hilang bila crash"
SELECT player_id, now() - saved_at AS since_checkpoint
FROM game_session WHERE is_active ORDER BY saved_at LIMIT 20;

SELECT pg_size_pretty(avg(pg_column_size(state))::bigint) AS avg_state_size FROM game_session;
```

```bash
curl -s localhost:9090/metrics | grep -E 'session_(save|restore|lost)_total'
kubectl logs -l app=game --since=24h | grep -c 'state tidak ditemukan'
```
