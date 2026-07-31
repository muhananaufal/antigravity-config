# Real-time State Synchronization (Game Server)

## Konsep Internal & Trade-offs

Dalam arsitektur *Client-Server* multiplayer, menjaga sinkronisasi posisi ratusan entitas (Pemain, NPC, Peluru) di jaringan ber-latensi tinggi adalah tantangan tersulit. Jika server mengirimkan seluruh `WorldState` (posisi setiap entitas) setiap 16ms (60Hz), *bandwidth* jaringan akan tersumbat dengan cepat (congestion).

Konsep utamanya melibatkan tiga pilar utama:
1. **Delta Compression / Snapshot Interpolation**: Server merekam *Snapshot* state dunia di Tick N. Di Tick N+1, server hanya mengirimkan *Delta* (perbedaan) apa saja yang berubah sejak Snapshot terakhir yang dikonfirmasi oleh klien. Klien menerima state dengan jeda (latency), lalu melakukan interpolasi (lerp) gerakan secara mulus dari masa lalu ke masa depan.
2. **Client Prediction**: Jika klien harus menunggu balasan server untuk bergerak (Round Trip Time 100ms), game akan terasa sangat *lag* dan tidak responsif. Klien *memprediksi* gerakan lokalnya secara instan, dan ketika *Authoritative Server* membalas posisinya (di masa lalu), klien mengoreksi jika prediksi salah (*Server Reconciliation*).
3. **Lag Compensation**: Untuk memastikan penembak (*Shooter*) merasa serangannya mendarat tepat meskipun ia melihat musuh tertinggal di masa lalu (akibat lag visual), Server menyimpan riwayat (buffer historis) posisi musuh hingga 500ms ke belakang. Saat server menerima aksi `Tembak(WaktuClient=T)`, server "memundurkan waktu" hitbox musuh ke waktu `T` untuk mengecek tabrakan, baru mengembalikan state ke masa kini.

Trade-off terbesar adalah kerumitan (Complexity) vs Keadilan (Fairness) vs Penggunaan Memori. Lag compensation mengharuskan server menyimpan histori spasial setiap tick untuk semua entitas (Memakan banyak RAM). Delta compression memaksa CPU bekerja lebih keras membuat *diffing* per klien (CPU Bound). 

## Arsitektur & Alur Sinkronisasi State

```text
[CLIENT 1] (RTT 100ms)                          [AUTHORITATIVE SERVER] (Tick: 100)
|--- (Tick 95) Input: MAJU ---> (Jaringan) ------> |
|                                                  | (Menerima input dari masa lalu)
| (Client Prediction: Klien                 [History Buffer (Circular)]
|  langsung maju di layar)                         | Tick 95: Posisi A
|                                                  | Tick 96: Posisi B ...
|                                                  | ---> Server re-apply input dari 95 ke 100
|                                                  | ---> Validasi: Ya, bisa maju.
| <--- (Tick 100) State Baru: MAJU --- (Jaringan) -| (Delta State Sync Broadcast)
|
| (Client Reconciliation)
| Klien membandingkan: Prediksi(100) == Server(100) ? 
| Jika Beda -> Klien 'snap' (teleport) ke Server(100)
```

## Kode Go Production-Ready

Contoh sistem *State Broadcast* menggunakan pola Delta (Hanya menyebarkan data entitas yang di-update) menggunakan WebSocket goroutines dan `sync.RWMutex` untuk performa *read-heavy*.

```go
package sync

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Entity mewakili objek di dalam game
type Entity struct {
	ID        uint32
	X, Y      float32
	IsDirty   bool // Flag: Apakah entity ini berubah di tick ini?
}

// World mengelola status entitas dan history
type World struct {
	mu       sync.RWMutex
	Entities map[uint32]*Entity
	Tick     uint64
}

// ClientConnection merepresentasikan koneksi jaringan klien
type ClientConnection struct {
	ID         string
	LastAckTick uint64 // Tick terakhir yang sudah diterima & dibalas klien
	SendChan   chan []byte
}

type SyncManager struct {
	world    *World
	clients  sync.Map // concurrent map klien terhubung
	tickRate int
}

func NewSyncManager(tickRate int) *SyncManager {
	return &SyncManager{
		world: &World{
			Entities: make(map[uint32]*Entity),
			Tick:     0,
		},
		tickRate: tickRate,
	}
}

// UpdateEntity mengubah posisi dan menandai entity sebagai kotor (berubah)
func (s *SyncManager) UpdateEntity(id uint32, x, y float32) {
	s.world.mu.Lock()
	defer s.world.mu.Unlock()

	if e, exists := s.world.Entities[id]; exists {
		// [OPTIMISASI] Jangan tandai dirty jika tidak ada perubahan nyata (Threshold)
		if e.X == x && e.Y == y {
			return 
		}
		e.X, e.Y = x, y
		e.IsDirty = true
	}
}

// BroadcastDeltaLoop dijalankan secara background di Game Loop
func (s *SyncManager) BroadcastDeltaLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Second / time.Duration(s.tickRate))
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.world.mu.Lock()
			
			// 1. Kumpulkan Delta (Entitas yang berubah saja)
			var changedEntities []*Entity
			for _, e := range s.world.Entities {
				if e.IsDirty {
					changedEntities = append(changedEntities, e)
					e.IsDirty = false // Reset status dirty
				}
			}
			currentTick := s.world.Tick
			s.world.Tick++ // Increment tick
			s.world.mu.Unlock()

			// Jika tidak ada perubahan dunia, hemat bandwidth dengan tidak mengirim apapun
			if len(changedEntities) == 0 {
				continue 
			}

			// 2. Serialize Delta State
			// (Dalam produksi nyata, pakai Protobuf/FlatBuffers, ini contoh dummy bytes)
			payload := s.serializeDelta(currentTick, changedEntities)

			// 3. Broadcast ke Semua Client secara konkuren (Fan-Out)
			s.clients.Range(func(key, value interface{}) bool {
				client := value.(*ClientConnection)
				
				select {
				case client.SendChan <- payload:
					// Berhasil masuk queue send klien
				default:
					// [CRITICAL] Backpressure Handling. Klien terlalu lambat membaca.
					// Jangan blokir broadcast ke klien lain! Buang paket (UDP-style)
					// atau putuskan koneksi jika channel kepenuhan terus menerus.
				}
				return true
			})
		}
	}
}

// serializeDelta merakit bytes. (Dibuat sederhana untuk contoh)
func (s *SyncManager) serializeDelta(tick uint64, entities []*Entity) []byte {
	return []byte(fmt.Sprintf("Tick:%d|Changes:%d", tick, len(entities)))
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengirim Data Lewat UDP Tanpa Payload Sequencing/Ack
Developer menyadari TCP lambat (karena *head-of-line blocking*), lalu berganti ke UDP murni.

```go
// BAD: Mengirim lewat UDP murni tanpa penomoran Tick
conn.WriteToUDP([]byte("Move X:10 Y:20"), clientAddr)
```
**Why dangerous:** UDP tidak menjamin urutan (Unordered) dan jaminan sampai (Unreliable). Jika paket Tick 102 sampai lebih dulu dari Tick 101, klien akan bergerak ke masa depan (102), lalu mundur secara glitch ke masa lalu (101) sedetik kemudian. Ini memicu efek "karet gelang" (Rubber-banding) yang sangat merusak mata pemain. *Good Pattern*: Setiap paket state harus memiliki nomor `Tick` absolut. Klien yang menerima paket state `Tick < TickTertinggiDiterima` wajib membuang paket usang tersebut.

### ❌ Anti-Pattern 2: Trust the Client (Mempercayai Prediksi Klien)
Menerima mentah-mentah hit/posisi dari klien agar game terasa responsif bagi klien tersebut.

```go
// BAD: Klien mengirim "Saya bunuh Player 2", Server langsung menyetujui
func HandleClientMessage(msg Message) {
    if msg.Type == "I_SHOT_PLAYER_2" {
        Player2.Health -= 100 // Otoritas diserahkan ke klien (Sangat Berbahaya)
    }
}
```
**Why dangerous:** Ini adalah pintu gerbang *Cheat* / *Hack* (Aimbot, Teleport, God Mode). Arsitektur server harus selalu bersifat *Authoritative*. Klien hanya boleh mengirimkan **Input** (Tekan W, Klik Kiri di Sudut 45 derajat). Server yang mensimulasikan tembakan dengan Lag Compensation, dan server yang memutuskan apakah tembakan tersebut valid (Line of sight tidak terhalang tembok, jarak wajar, cooldown peluru beres). Prediksi klien (Client Prediction) hanyalah ilusi visual di monitor klien, BUKAN penentu kebenaran (*Source of Truth*).

### ❌ Anti-Pattern 3: Full State Sync Tiap Tick (Boros Bandwidth)
Server mengubah map/array dari state menjadi JSON/Protobuf, lalu membroadcast seluruh isi map tiap tick.

```go
// BAD: Mengirim ulang SEMUA NPC dan Player meskipun mereka sedang AFK/diam.
json.Marshal(World.AllEntities)
broadcast(payload) // 500KB per tick -> 30MB/s Bandwidth cost!
```
**Why dangerous:** Tagihan AWS/GCP (Egress Bandwidth) Anda akan meledak puluhan ribu dolar sebulan, dan klien seluler (4G/LTE) akan tercekik paket datanya dan mengalami lag/packet loss massal. Solusinya, gunakan *Delta Compression* (hanya ID entitas yang `IsDirty` yang dikirim). Lebih baik lagi jika didukung oleh *Spatial Partitioning* (Area of Interest / AoI): Klien hanya menerima pembaruan dari entitas yang berada dalam radius 100 meter di dekatnya.

## Edge Cases

1. **Jitter dan Buffer Bloat Jaringan:** Paket jaringan tidak pernah datang tepat waktu (misal RTT 50ms, tapi paket bervariasi dari 30ms hingga 120ms). Jika klien langsung merender/menginterpolasi state saat diterima, pergerakan akan patah-patah. Klien wajib mengimplementasikan **De-jitter Buffer (Interpolation Delay)** (misalnya menyimpan 2-3 tick ke depan sebelum mulai merender interpolasi frame). Hal ini akan menambah latensi visual buatan (sekitar 30-50ms) namun menjamin gerakan super mulus (*smooth*).
2. **Kalkulasi Float64 Determinism Silang Arsitektur:** Klien (C# Unity/ARM64) memprediksi tabrakan antara Player dan Kotak pada Tick 50. Server (Go/x86_64) memproses input yang persis sama. Namun, karena perbedaan pembulatan *float32* pada FPU Intel vs ARM, posisi akhir berselisih 0.0001 unit. Karena game server ketat, selisih sekecil apapun akan memicu *Server Reconciliation* dan *snap* teleport ke klien (micro-stutter). Sebisa mungkin, logika fisik gunakan *Integer Math (Fixed Point)* atau toleransi snap (*epsilon margin*).
3. **Akumulasi Memori Lag Compensation:** Server harus menyimpan posisi (Hitbox Bounding Box) masa lalu (maksimal 500ms) dari semua entitas. Jika ada 10,000 panah beterbangan dan 5,000 NPC, alokasi array historis per entitas akan memicu *Garbage Collection* yang masif di Go jika dibuat-hapus berulang-ulang secara dinamis. Anda WAJIB menggunakan struktur data *Circular Ring Buffer* statik alokasi awal (Pre-allocated) dengan panjang fix (misal `[64]Snapshot`) sehingga tidak ada alokasi *heap* baru sama sekali per frame.

## Unit Test Meaningful

```go
package sync_test

import (
	"context"
	"testing"
	"time"
)

// Simulasi SyncManager (Asumsikan sudah di-export untuk test)
func TestDeltaBroadcast_OnlySendsDirtyEntities(t *testing.T) {
	manager := NewSyncManager(60)

	// Inject 2 Entitas
	manager.UpdateEntity(1, 10.0, 10.0) // Dirty
	manager.UpdateEntity(2, 5.0, 5.0)   // Dirty

	// Mock Client
	clientSendChan := make(chan []byte, 10)
	manager.clients.Store("client-1", &ClientConnection{
		ID:       "client-1",
		SendChan: clientSendChan,
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Jalankan Broadcaster
	go manager.BroadcastDeltaLoop(ctx)

	// Evaluasi Broadcast Pertama (Harus 2 entitas dikirim)
	select {
	case payload := <-clientSendChan:
		payloadStr := string(payload)
		expected := "Tick:0|Changes:2" // Karena tick awal 0, dan 2 entity berubah
		if payloadStr != expected {
			t.Fatalf("Expected %s, got %s", expected, payloadStr)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout menunggu broadcast pertama")
	}

	// Evaluasi Broadcast Kedua
	// Karena kita tidak mengupdate entity (tidak ada pergerakan), 
	// manager TIDAK BOLEH broadcast/spam jaringan (Delta empty)
	select {
	case <-clientSendChan:
		t.Fatal("Expected NO broadcast since no entities were dirty/moved")
	case <-time.After(200 * time.Millisecond):
		// Sukses, tidak ada spam jaringan
	}

	// Ubah hanya Entity 1
	manager.UpdateEntity(1, 12.0, 10.0)

	select {
	case payload := <-clientSendChan:
		payloadStr := string(payload)
		// Tick 1 harusnya dilewati kosong (karena test case di atas), 
		// atau bisa jadi Tick saat ini sudah berjalan jauh karena waktu 200ms terlewat.
		// Yang terpenting, "Changes" haruslah bernilai 1.
		
		// Validasi string contain "Changes:1"
		if len(payloadStr) == 0 {
			t.Fatal("Empty payload")
		}
		// Sederhana, cek byte ujung akhir (karena dummy serialize 'Changes:1')
		if payloadStr[len(payloadStr)-1] != '1' {
			t.Fatalf("Expected exactly 1 changed entity in delta, got payload: %s", payloadStr)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout menunggu broadcast delta parsial")
	}
}
```
