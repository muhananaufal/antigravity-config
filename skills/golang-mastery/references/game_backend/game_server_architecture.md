# Game Server Architecture (Golang)

> **Berlaku:** Go 1.21+ · **Lihat juga:** `game_backend/tick_rate_fixed_timestep.md` · `game_backend/realtime_state_sync.md` · `realtime_networking/websocket_gnet_epoll.md` · `game_backend/game_session_persistence.md`

## Konsep Internal & Trade-offs

Arsitektur game server (terutama yang *Authoritative* seperti MOBA, FPS, dan Survival) sangat berbeda dengan arsitektur REST API biasa. REST bersifat statis (*Stateless*), setiap HTTP request berumur pendek, tidak bergantung pada koneksi sebelumnya, dan datanya diambil dari Database.

Sedangkan Game Server adalah **Stateful, In-Memory, Long-Lived System**. Pemain terhubung melalui *Persistent Connection* (WebSockets, TCP, atau UDP murni). Server menahan status dunia (koordinat X/Y, *Health*, item) di dalam *RAM*. Interaksi database (SQL/NoSQL) ditekan seminimal mungkin (hanya saat *login* dan *save state* setiap 5 menit) karena menulis disk per-frame akan meremukkan I/O server.

Terdapat tiga skala skalabilitas dalam game server Go:
1. **Single Monolith (Room-based)**: Satu proses Go menampung banyak goroutine `Room`. Tiap room (misal 5v5 MOBA match) adalah loop mandiri yang tidak berbagi lock memori. Sederhana, aman dari GC lag masif, cocok untuk 5.000 pemain.
2. **Distributed (Zone/Sharded)**: Untuk game open world (MMO). Map dibagi menjadi kotak grid raksasa. Jika Pemain melintasi zona timur, koneksinya ditransfer (*Handoff*) ke Server Node B. Keras dalam arsitektur IPC (*Inter-Process Communication*).
3. **Microservices (Services vs Dedicated Game Server / DGS)**: Memisahkan layanan lambat (Matchmaking, Chat, Guild, Login REST) dari DGS. DGS (C++, Go murni) khusus memutar game loop fisika dan terputus dari DB, sehingga frame lag benar-benar stabil.

## Arsitektur & Alur Data (Dedicated Game Server)

```text
[CLIENTS] (UDP / WebSockets)
   |
   | (Persisten 60 Ticks per detik)
   v
+-----------------------------------------------------------+
|               GAME SERVER PROCESS (GO)                    |
|                                                           |
|  [Network Layer (Goroutine per Client - I/O Blocking)]    |
|   | (Pesan diparsing, di-enqueue)                         |
|   v                                                       |
|  [Message Queue / Channel (Fan-in)]                       |
|   |                                                       |
|   v                                                       |
|  [Game Loop Goroutine (Single-Threaded per Room)] <-------+ (Ticker 60Hz)
|   - Update Fisika                                         |
|   - Proses Damage & Skill                                 |
|   - Spatial Partitioning Hitbox                           |
|   |                                                       |
|   v                                                       |
|  [Delta Broadcaster] -> Broadcast state update ke client  |
+-----------------------------------------------------------+
         | (Secara periodik, background)
         v
[Redis / PostgreSQL] (Hanya untuk Player Save Data)
```

## Kode Go Production-Ready

Contoh arsitektur *Room-based* menggunakan pola *Actor Model*. Semua goroutine klien (Network Layer) tidak boleh menyentuh state dunia secara langsung untuk menghindari `Mutex` contention. Mereka hanya menaruh aksi ke channel *Room* (Actor).

```go
package architecture

import (
	"context"
	"fmt"
	"log"
	"time"
)

// PlayerAction adalah pesan yang dikirim klien
type PlayerAction struct {
	PlayerID string
	Type     string
	Payload  []byte
}

// RoomActor adalah representasi 1 match (contoh: 5v5). 
// Berjalan sepenuhnya di 1 goroutine (Lock-free world state).
type RoomActor struct {
	RoomID       string
	ActionInbox  chan PlayerAction // Antrian pesan masuk
	WorldState   map[string]int    // Dummy state (misal map PlayerID -> Health)
	IsActive     bool
	TickRate     int
}

func NewRoomActor(id string, tickRate int) *RoomActor {
	return &RoomActor{
		RoomID:      id,
		ActionInbox: make(chan PlayerAction, 1024), // Buffered untuk backpressure
		WorldState:  make(map[string]int),
		IsActive:    true,
		TickRate:    tickRate,
	}
}

// Start menjalankan Game Loop khusus untuk room ini.
// Karena kita hanya memutasi state dari DENGAN DALAM fungsi ini, 
// kita TIDAK butuh Mutex untuk WorldState! (Lock-free/Actor Pattern)
func (r *RoomActor) Start(ctx context.Context) {
	ticker := time.NewTicker(time.Second / time.Duration(r.TickRate))
	defer ticker.Stop()

	log.Printf("[Room %s] Started", r.RoomID)

	for r.IsActive {
		select {
		case <-ctx.Done():
			log.Printf("[Room %s] Context cancelled, shutting down", r.RoomID)
			r.IsActive = false
			return

		case <-ticker.C:
			// 1. Kuras Inbox (Proses semua input pemain yang masuk sejak tick terakhir)
			// Pola ini disebut "Batching/Draining channel"
			drainInbox(r)

			// 2. Simulasi Dunia (Fisika, Cooldown, dll)
			r.simulatePhysics()

			// 3. Broadcast Hasil
			r.broadcastState()
		}
	}
}

func drainInbox(r *RoomActor) {
	// Kuras sampai habis atau batas maksimal per frame
	limit := 100 
	for i := 0; i < limit; i++ {
		select {
		case action := <-r.ActionInbox:
			r.processAction(action)
		default:
			// Inbox kosong, lanjut simulasi
			return
		}
	}
}

func (r *RoomActor) processAction(action PlayerAction) {
	if action.Type == "DAMAGE" {
		r.WorldState[action.PlayerID] -= 10
	}
}

func (r *RoomActor) simulatePhysics() {
	// Mutasi yang aman karena berjalan pada single goroutine yang sama
	for pid, hp := range r.WorldState {
		if hp <= 0 {
			// Player mati
			_ = pid
		}
	}
}

func (r *RoomActor) broadcastState() {
	// (Implementasi pengiriman data keluar)
}

// OnClientMessage dipanggil oleh Goroutine I/O TCP/WebSocket (Network Layer).
// Fungsi ini HANYA menaruh pesan ke Inbox (Non-blocking), tidak mengeblok I/O.
func (r *RoomActor) OnClientMessage(action PlayerAction) error {
	select {
	case r.ActionInbox <- action:
		return nil
	default:
		return fmt.Errorf("room inbox is full, dropping action (server overload)")
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: CRUD REST API untuk Pergerakan Real-time
Developer Web (Backend) biasanya mendesain game dengan memanggil Database di setiap interaksi.

```go
// BAD: State Game ada di Database, bukan RAM.
func MovePlayerHandler(w http.ResponseWriter, r *http.Request) {
    db.Exec("UPDATE players SET x = x + 1 WHERE id = ?", req.PlayerID) // TERLAMBAT!
}
```
**Why dangerous:** I/O Latency. Waktu akses RAM (in-memory) adalah `~100 nanosecond`. Waktu query ke Postgres lokal adalah `~1 millisecond` (10.000x lebih lambat). Jika Anda menaruh state pergerakan koordinat di DB, server hanya sanggup menangani beberapa puluh player sebelum koneksi DB pool kelelahan (Connection exhaustion), lag mencapai detik, dan game lumpuh. Database di game multiplayer HANYA digunakan saat pemain login, atau saat pertandingan selesai (menyimpan skor EXP). Segala yang terjadi di tengahnya eksklusif di RAM Server.

### ❌ Anti-Pattern 2: Global Mutex di Entitas
Menggunakan Mutex di setiap struct Entity agar aman dibaca-tulis dari berbagai Goroutine WebSocket (I/O).

```go
// BAD: Semua Goroutine Klien bebas saling mengunci Entitas
func (c *ClientSession) onMessage(msg []byte) {
    GlobalWorld.Players["enemy_1"].mu.Lock()
    GlobalWorld.Players["enemy_1"].HP -= 10 // Race Lock Contention
    GlobalWorld.Players["enemy_1"].mu.Unlock()
}
```
**Why dangerous:** Jika Goroutine Klien A mengunci musuh_1, Goroutine Klien B (yang juga nyerang musuh_1) akan *nge-hang* menunggu. Lebih parah, *Game Loop Utama* yang mau mensimulasikan lari musuh_1 juga ikut mati terblokir! CPU usage drop ke 10% tapi server super ngelag. Pola arsitektur server yang benar (seperti di atas) menggunakan **Actor Model (Single-Threaded Room/World)** atau *Lock-Free queue* untuk menghindari perebutan *Mutex*. Goroutine klien hanya mengirim *Command* lewat Channel.

### ❌ Anti-Pattern 3: Goroutine Per Entity (Actor Model Murni untuk Fisika)
Terlalu terobsesi pada keunggulan goroutine Go, developer membuat 1 Goroutine untuk setiap Peluru, NPC, dan Pohon.

```go
// BAD: Ribuan goroutine kecil-kecilan
go bullet.SimulateLife()
go npc.AIThinkLoop()
go item.DespawnTimer()
```
**Why dangerous:** Sinkronisasi spatial menjadi mimpi buruk. Jika peluru harus mengecek tabrakan ke NPC, Goroutine Peluru harus mengirim pesan antar-channel ke Goroutine NPC ratusan kali sedetik! Channel Go memiliki overhead *locking* ringan di bawah kapnya. Memutar 10.000 loop lewat goroutine yang saling bertukar channel tiap *millisecond* mematikan scheduler (Context switch thrashing). Game loop fisika/tabrakan HARUS dieksekusi secara terpusat (*Data-Oriented Design / ECS*) di 1 titik rutin utama untuk memaksimalkan *CPU Cache Locality*.

## Edge Cases

1. **Panic di Dalam Room Membunuh Seluruh Server:** Jika sebuah Room memiliki logika *index-out-of-bounds* (misal memproses skill yang cacat), panik akan terjadi. Tanpa *recovery*, seluruh proses Go (semua 100 room yang sedang main) akan mati bersama. *Mitigasi*: WAJIB bungkus `Start()` room goroutine dengan `defer func() { if r := recover(); r != nil { log.Fatal() } }()`. Anda lebih baik mencrashkan 1 match (klien disconnect dan dianggap batal), daripada menggugurkan 99 match lainnya.
2. **Channel Deadlock saat Broadcast (Slow Consumer):** Server mencoba mengirim state (byte array) ke channel `SendChan` milik goroutine Klien (WebSocket Writer). Jika internet klien putus diam-diam (*TCP half-open*), Klien goroutine akan tertahan/hang saat nge-Write jaringan. `SendChan` klien akhirnya penuh. Jika server game loop membroadcast pakai blokir (`client.SendChan <- data`), GAME LOOP AKAN IKUT HANG SELAMANYA! *Mitigasi*: Broadcaster dari game loop wajib bersifat *non-blocking select* (seperti contoh pada file *state sync*) dan langsung membuang (kick) klien lambat.
3. **Garbage Collection (STW) Spikes karena Serialisasi:** Arsitektur yang terlihat sempurna mendadak nge-lag (ping spike 100ms) tiap beberapa detik. Penyebab utama di Go adalah proses kompresi payload jaringan. Jika Anda mengubah State menjadi JSON byte (`json.Marshal`) sebanyak ribuan objek tiap detik, alokasi memori heap akan masif. Go GC Stop-the-world akan menendang jatuh frame rate fisika. Anda WAJIB beralih dari JSON ke format biner (*FlatBuffers / Protocol Buffers*) dan mendaur ulang objek bytes menggunakan `sync.Pool`.

## Unit Test Meaningful

Tes mendemonstrasikan bahwa arsitektur Actor Model (Room) mencegah *data race* tanpa Mutex, dan membuktikan bahwa backpressure dari inbox berfungsi jika server diserang dengan DDoS *action spam*.

```go
package architecture_test

import (
	"context"
	"testing"
	"time"
)

// Asumsi paket bisa dipanggil di test
func TestRoomActor_ConcurrencyAndBackpressure(t *testing.T) {
	room := NewRoomActor("room-101", 60)
	room.WorldState["player1"] = 1000 // Inisiasi HP awal yang tebal

	ctx, cancel := context.WithCancel(context.Background())
	
	// Nyalakan Actor
	go room.Start(ctx)

	// Simulasi 5 goroutine berbeda menyerang bersamaan (Concurrency Test)
	for i := 0; i < 5; i++ {
		go func() {
			for j := 0; j < 10; j++ {
				// Coba masukan serangan (Total 5*10 = 50 serangan x 10 DMG = 500 DMG)
				err := room.OnClientMessage(PlayerAction{
					PlayerID: "player1",
					Type:     "DAMAGE",
				})
				// Beberapa akan kena backpressure jika buffer penuh, tapi
				// dengan limit channel 1024 dan loop cepat, ini harusnya masuk semua.
				_ = err 
				time.Sleep(1 * time.Millisecond)
			}
		}()
	}

	// Simulasi DDoS (Melebihi Inbox Capacity 1024)
	go func() {
		overflowErrCount := 0
		for k := 0; k < 2000; k++ {
			err := room.OnClientMessage(PlayerAction{
				PlayerID: "dummy",
				Type:     "IDLE",
			})
			if err != nil {
				overflowErrCount++
			}
		}
		
		// Backpressure harus tertendang
		if overflowErrCount == 0 {
			t.Errorf("Expected some messages to drop due to backpressure under DDoS")
		}
	}()

	// Tunggu Room memproses beberapa Frame (TickRate 60)
	time.Sleep(200 * time.Millisecond)

	// Hentikan Room Actor
	cancel()
	time.Sleep(50 * time.Millisecond)

	// Karena kita mengirim 50 serangan (tiap serangan kurang 10) 
	// maka harus tersisa 1000 - 500 = 500 HP
	// Jika sistem ini race condition (seperti ++ normal tanpa mutex), nilainya akan salah.
	if room.WorldState["player1"] != 500 {
		t.Fatalf("Lock-free room actor failed. Expected HP 500, got %d", room.WorldState["player1"])
	}
}
```

## Kapan JANGAN Pakai Ini

- **Arsitektur authoritative server untuk permainan tanpa insentif curang.** Simulasi di server menambah biaya komputasi dan latensi. Untuk permainan kooperatif tanpa kompetisi, kepercayaan pada klien bisa memadai — itu keputusan produk.
- **Satu proses untuk semua ruang permainan tanpa isolasi.** Satu ruang yang bermasalah menjatuhkan semua pemain di proses itu. Isolasi per ruang atau per proses membatasi radius kerusakan.
- **State permainan hanya di memori tanpa checkpoint.** Crash atau deploy berarti kehilangan sesi yang sedang berjalan, dan pemain merasakannya sebagai kehilangan kemajuan.
- **Matchmaking di dalam proses permainan.** Keduanya punya profil beban dan siklus rilis yang berbeda; menyatukannya berarti setiap perubahan matchmaking men-deploy ulang server permainan yang sedang dipakai.
- **Mengabaikan wilayah geografis.** Latensi ditentukan jarak fisik. Server yang jauh membuat permainan terasa buruk tanpa ada yang salah di kode.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Banyak pemain terputus bersamaan | isolasi antar ruang | Satu proses memegang terlalu banyak ruang |
| Kemajuan pemain hilang saat deploy | frekuensi checkpoint | State hanya di memori |
| Keluhan lag dari wilayah tertentu | latensi per wilayah | Server terlalu jauh dari pemain |
| Deploy matchmaking mengganggu permainan | pemisahan layanan | Keduanya dalam satu proses |
| Curang terdeteksi terlambat | apa yang diotorisasi server | Klien terlalu dipercaya |

```bash
# Sebaran pemain per proses -- konsentrasi tinggi berarti radius kerusakan besar
curl -s localhost:9090/metrics | grep -E 'game_(rooms|players|ticks)'

# Latensi per wilayah: ini menentukan pengalaman lebih dari apa pun di kode
kubectl logs -l app=game --since=1h \
  | jq -r '"\(.wilayah) \(.rtt_ms)"' | awk '{s[$1]+=$2;n[$1]++} END{for(k in s) print k, s[k]/n[k]}'

# Sesi yang hilang saat deploy
kubectl logs -l app=game --since=24h | grep -c 'sesi hilang'
```
