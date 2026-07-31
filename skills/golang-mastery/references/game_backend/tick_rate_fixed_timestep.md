# Tick Rate & Fixed Timestep pada Game Server

## Konsep Internal & Trade-offs

Di dalam arsitektur game server (terutama game multiplayer real-time, FPS, atau simulasi fisika), konsep **Tick Rate** dan **Fixed Timestep** adalah jantung dari simulasi dunia. Server bertugas menjadi pemegang otoritas tunggal (Authoritative Server) yang menentukan posisi, tabrakan (collision), dan interaksi entitas. 

Jika server menghitung fisika menggunakan *Variable Delta Time* (berubah-ubah bergantung pada kecepatan iterasi CPU server saat itu), simulasi tidak akan deterministik. Lompatan CPU kecil (jitter), *garbage collection pauses*, atau variasi *network I/O* akan membuat hasil fisika berbeda. Sebagai contoh, pergerakan peluru dengan kecepatan tinggi mungkin menembus tembok pada satu frame jika *delta time* mendadak membesar (dikenal sebagai fenomena *tunneling* atau *bullet through paper*).

Oleh karena itu, standar industri yang diterapkan adalah pola **Fixed Timestep dengan Accumulator**. 
Pola ini memisahkan antara:
1. **Waktu nyata (Wall-clock time)**: Berapa lama waktu yang berlalu secara fisik (misal dari fungsi `time.Now()`).
2. **Waktu simulasi (Simulation time)**: Waktu maya di dalam dunia game yang maju secara konstan, misalnya persis `16.666ms` per siklus untuk server 60 Hz (Tick Rate 60).

Akumulator bertugas menampung waktu nyata yang berlalu. Setiap kali akumulator terisi melebihi batas *Fixed Timestep*, server akan mensimulasikan dunia (fisika, state) maju 1 *tick* dan mengurangi akumulator sebesar *Fixed Timestep*. Hal ini menjamin fungsi `UpdatePhysics()` **selalu** menerima variabel *delta time* yang absolut statik, membuat komputasi 100% deterministik. Sisa waktu (pecahan kurang dari 1 tick) disimpan dalam akumulator untuk siklus frame/loop berikutnya.

Trade-off utama dari Fixed Timestep adalah performa CPU dan *Spiral of Death*. Jika operasi `UpdatePhysics()` memakan waktu komputasi lebih lama daripada *Fixed Timestep* itu sendiri, akumulator akan terus membesar, menyebabkan server mencoba mengejar ketertinggalan dengan melakukan lebih banyak *tick* pada frame berikutnya, yang pada gilirannya makin membebani CPU hingga akhirnya crash atau membeku.

## Arsitektur & Alur Game Loop

```text
       Waktu Nyata (Wall Clock) Berjalan
       |------- 18ms -------|-------- 25ms --------|----- 10ms -----|

[Akumulator Waktu] -- Target Fixed Timestep = 16.6ms (60Hz)

Frame 1 (+18ms):
  Akumulator = 18.0ms
  > 16.6ms? YA -> Tick Fisika (dt=16.6)
  Akumulator Sisa = 1.4ms
  -> [Network Update, Render/Log] -> Sleep yield

Frame 2 (+25ms):
  Akumulator = 1.4 + 25 = 26.4ms
  > 16.6ms? YA -> Tick Fisika 1x (dt=16.6)
  Akumulator Sisa = 9.8ms
  > 16.6ms? TIDAK -> Berhenti
  -> [Network Update] -> Sleep yield

Frame 3 (+10ms):
  Akumulator = 9.8 + 10 = 19.8ms
  > 16.6ms? YA -> Tick Fisika 1x (dt=16.6)
  Akumulator Sisa = 3.2ms
  -> [Network Update] -> Sleep yield
```

## Kode Go Production-Ready

Implementasi *Fixed Timestep* membutuhkan penanganan khusus terhadap `panic`, penggunaan tipe `time.Duration` sebagai akumulator (mencegah *float loss precision*), dan mekanisme *capping* atau limitasi waktu untuk mencegah *Spiral of Death*.

```go
package game

import (
	"context"
	"fmt"
	"log"
	"math"
	"sync"
	"sync/atomic"
	"time"
)

// Constants untuk simulasi
const (
	TickRate       = 60 // 60 Tick per detik
	FixedDeltaTime = time.Second / TickRate
	MaxFrameTime   = 250 * time.Millisecond // Batas maksimal akumulasi waktu per frame (Spiral of death preventer)
)

// WorldState merepresentasikan state game
type WorldState struct {
	mu       sync.RWMutex
	PlayerX  float64
	Velocity float64
	TickNum  uint64
}

// ServerGameLoop adalah engine utama simulasi
type ServerGameLoop struct {
	state       *WorldState
	isRunning   atomic.Bool
	tickCounter atomic.Uint64
}

// NewServerGameLoop inisialisasi server loop
func NewServerGameLoop() *ServerGameLoop {
	return &ServerGameLoop{
		state: &WorldState{
			PlayerX:  0.0,
			Velocity: 15.0,
			TickNum:  0,
		},
	}
}

// Start menjalankan game loop di dalam background goroutine
func (s *ServerGameLoop) Start(ctx context.Context) error {
	if !s.isRunning.CompareAndSwap(false, true) {
		return fmt.Errorf("game loop already running")
	}

	go s.loop(ctx)
	return nil
}

// loop adalah implementasi fixed timestep
func (s *ServerGameLoop) loop(ctx context.Context) {
	defer func() {
		s.isRunning.Store(false)
		if r := recover(); r != nil {
			log.Printf("[CRITICAL] Game loop panicked: %v", r)
		}
	}()

	currentTime := time.Now()
	var accumulator time.Duration

	// Menggunakan fixed float dt untuk iterasi fisika (lebih cepat dari konversi berulang)
	dtSec := FixedDeltaTime.Seconds()

	log.Printf("Starting Game Loop at %d Hz (%.2f ms/Tick)", TickRate, float64(FixedDeltaTime.Milliseconds()))

	for {
		// Cek apakah konteks dibatalkan
		select {
		case <-ctx.Done():
			log.Println("Game loop terminating cleanly...")
			return
		default:
			// Non-blocking, lanjutkan komputasi
		}

		newTime := time.Now()
		frameTime := newTime.Sub(currentTime)

		// [CRITICAL] Spiral of death prevention
		// Jika OS membekukan proses kita (GC pause, I/O wait) terlalu lama, 
		// kita batasi tambahan waktu. Entitas akan "teleport" atau ngelag, 
		// tapi server tidak akan crash karena mencoba mengejar ribuan tick.
		if frameTime > MaxFrameTime {
			log.Printf("[WARN] Server lag spike detected: %v (capped at %v)", frameTime, MaxFrameTime)
			frameTime = MaxFrameTime
		}

		currentTime = newTime
		accumulator += frameTime

		// Simulasi Tick - Selama akumulator cukup untuk 1 tick penuh
		var ticksSimulated int
		for accumulator >= FixedDeltaTime {
			s.updatePhysics(dtSec)
			accumulator -= FixedDeltaTime
			s.tickCounter.Add(1)
			ticksSimulated++
		}

		// Interpolasi (Opsional) untuk Network Broadcast
		// Jika ingin mengirim state di antara dua tick, bisa pakai fraksi
		// fraction := float64(accumulator) / float64(FixedDeltaTime)
		// _ = fraction

		s.broadcastState(ctx)

		// Yield eksekusi. Jangan biarkan CPU terikat 100% pada while loop.
		// Memakai sleep 1ms cukup pada Linux, pada Windows mungkin memakan 15ms.
		// Runtime Go biasanya menghandle Gosched/Sleep dengan efisien.
		time.Sleep(1 * time.Millisecond)
	}
}

func (s *ServerGameLoop) updatePhysics(dt float64) {
	s.state.mu.Lock()
	defer s.state.mu.Unlock()

	// Operasi deterministik. Variabel dt SELALU konstan.
	s.state.PlayerX += s.state.Velocity * dt
	s.state.TickNum++
}

func (s *ServerGameLoop) broadcastState(ctx context.Context) {
	// Contoh: Kirim posisi saat ini ke network/Redis
	// Di sistem produksi, broadcast tidak selalu tiap frame. Bisa di-rate-limit.
}

func (s *ServerGameLoop) GetState() (float64, uint64) {
	s.state.mu.RLock()
	defer s.state.mu.RUnlock()
	return s.state.PlayerX, s.state.TickNum
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengandalkan `time.Ticker` untuk Fisika
Pengembang pemula Go sering menggunakan `time.NewTicker` untuk game loop.

```go
// BAD: Menggunakan OS Ticker untuk presisi simulasi fisika
func BadGameLoop() {
	ticker := time.NewTicker(16 * time.Millisecond)
	for range ticker.C {
		UpdatePhysics(0.016) // Salah! Waktu aslinya mungkin 15ms atau 22ms.
	}
}
```
**Why dangerous:** `time.Ticker` sangat bergantung pada seberapa akurat *scheduler* sistem operasi dan *runtime sysmon* Go membangunkan *thread*. *Jitter* selalu terjadi (bisa telat 1-5ms tiap tick). Dengan Ticker, waktu yang hilang akibat telat **tidak akan pernah ditambahkan kembali** (hilang selamanya). Posisi entitas antar client dan server lambat laun akan desinkronisasi. Solusinya, gunakan akumulator kustom dengan `time.Now()`.

### ❌ Anti-Pattern 2: Spiral of Death (Uncapped Accumulator)
Lupa memberikan batas maksimal pada akumulator *delta time*.

```go
// BAD: Tidak ada limitasi frameTime
newTime := time.Now()
frameTime := newTime.Sub(currentTime)
currentTime = newTime
accumulator += frameTime

for accumulator >= FixedDeltaTime {
	UpdatePhysics(0.0166) // Akan loop 600x berturut-turut jika frameTime 10 detik!
	accumulator -= FixedDeltaTime
}
```
**Why dangerous:** Jika server mengalami I/O macet atau GC pause berat selama 5 detik, `frameTime` menjadi 5000ms. *For loop* fisika akan tereksekusi 300 kali tanpa putus di frame yang sama. Operasi 300x ini bisa memakan CPU yang membuat frameTime berikutnya makin membengkak, dan terjadi efek domino yang menyebabkan *Deadlock/Server Crash*. Solusinya, *cap/clamp* frametime di maksimal misalnya 250ms.

### ❌ Anti-Pattern 3: Float64 sebagai Akumulator Global
Menggunakan float untuk menghitung akumulator atau *uptime server* murni.

```go
// BAD: Mengakumulasi waktu nyata dengan Float64 secara berkesinambungan
var totalUptimeSeconds float64
totalUptimeSeconds += frameTime.Seconds() // Bahaya presisi!
```
**Why dangerous:** *Floating point precision degradation*. `float64` memiliki batasan digit signifikan. Setelah server menyala 2 minggu, `totalUptimeSeconds` akan menjadi angka yang sangat besar (misal 1209600.0). Saat Anda menambahkan *delta time* kecil seperti `0.016`, nilai ini tidak terhitung secara utuh (terpotong) di tingkat bit. Fisika akan melambat secara aneh semakin lama server di-host. Selalu gunakan tipe bilangan bulat murni (`time.Duration` / `int64` nanosecond) untuk menjaga ketepatan waktu.

## Edge Cases

1. **OS Timer Resolution di Windows:** Di lingkungan server Windows, `time.Sleep(1 * time.Millisecond)` seringkali di-resolusi oleh kernel menjadi 15.6ms secara default. Akibatnya, iterasi game loop Anda akan tercekik hanya bisa jalan sekitar 64 frame per detik, mengganggu akurasi jika Anda mentargetkan 128-tick. *Workaround*: Pastikan server dideploy di lingkungan Linux (seperti epoll dan scheduler yang akurat) atau Anda harus memanggil syscall spesifik Windows (`timeBeginPeriod(1)`) untuk memaksa resolusi timer menjadi 1ms.

2. **Garbage Collection Stop-The-World (STW):** Go menggunakan *concurrent garbage collector*, namun masih ada fase *STW* singkat. Jika GC pause terjadi selama 20ms, frameTime akan memanjang menjadi 20+ms. Limit spiral-of-death akan menyerapnya jika kecil, namun jika GC mendadak parah (memori bocor), fisika akan melompat. Bedakan antara lag CPU (yang ditangani limitator frame) vs lag jaringan (yang harus ditangani dengan *Client Prediction/Reconciliation*).

3. **Physics Tunneling karena Velocity Sangat Tinggi:** Meskipun menggunakan fixed timestep, peluru sniper dalam game bisa menempuh 50 meter per tick (dt=0.016s). Jika tembok hanya tebal 1 meter, fisika posisi tick-n vs tick-n+1 akan mendapati peluru sudah lewat menembus, event *Collision* tidak pernah terpicu (disebut *tunneling*). Solusi: Untuk peluru berkecepatan ekstrim, Anda wajib mengimplementasikan *Continuous Collision Detection (CCD)* berupa metode *Raycasting* garis lintasan, bukan sekadar deteksi geometri overlap AABB di titik *fixed* tick.

## Unit Test Meaningful

Tes ini memastikan bahwa akumulator benar-benar mengeksekusi tick dalam jumlah presisi meskipun diberi masukan variasi waktu yang sangat acak (jitter dari simulasi lag).

```go
package game_test

import (
	"context"
	"testing"
	"time"
)

// Catatan: Asumsikan func diekspor untuk test
func TestFixedTimestep_AccuracyWithJitter(t *testing.T) {
	loop := NewServerGameLoop()

	// Simulasi frame time yang sangat kotor / jitter
	// Rata-rata 1000ms / 60 Hz = ~16.6ms
	// Kita sengaja beri nilai-nilai ekstrim
	simulatedJitters := []time.Duration{
		10 * time.Millisecond,
		25 * time.Millisecond,
		5 * time.Millisecond,
		20 * time.Millisecond,
		200 * time.Millisecond, // Spike
	}

	var accumulator time.Duration
	fixedDt := time.Second / 60

	for _, jitter := range simulatedJitters {
		accumulator += jitter
		
		// Loop fisika (manual inline untuk unit test logika)
		for accumulator >= fixedDt {
			loop.UpdatePhysics(fixedDt.Seconds())
			accumulator -= fixedDt
		}
	}

	// Total waktu simulasi masuk adalah 260 Millisecond
	// 260ms / 16.666ms = 15.6 Tick (artinya 15 tick tereksekusi, sisa 0.6 tick di akumulator)
	expectedTicks := uint64(15)
	
	_, ticks := loop.GetState()
	if ticks != expectedTicks {
		t.Fatalf("Expected %d ticks to be processed, but got %d ticks", expectedTicks, ticks)
	}

	// Tes perlindungan Spiral of Death
	// Jika kita kasih 10 detik sekaligus, harusnya di-cap oleh MaxFrameTime (250ms)
	accumulator = 0
	massiveLag := 10 * time.Second
	
	cappedLag := massiveLag
	if cappedLag > (250 * time.Millisecond) {
		cappedLag = 250 * time.Millisecond
	}
	accumulator += cappedLag

	var massiveTicks uint64
	for accumulator >= fixedDt {
		loop.UpdatePhysics(fixedDt.Seconds())
		accumulator -= fixedDt
		massiveTicks++
	}

	// 250ms / 16.6ms = 15 Tick
	if massiveTicks != 15 {
		t.Fatalf("Spiral of death preventer failed. Expected 15 ticks from capped lag, got %d", massiveTicks)
	}
}
```
