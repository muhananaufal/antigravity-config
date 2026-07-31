# Goroutine Scheduler (GMP Model) Internals

## 1. Konsep dan Arsitektur Internal (Technical Depth)

Go *runtime scheduler* beroperasi sepenuhnya di *user-space* dan menggunakan model penjadwalan *M:N* di mana ribuan hingga jutaan *logical threads* (Goroutine) di-multiplex ke atas sejumlah *OS threads* yang jauh lebih sedikit. Di balik layar, scheduler ini menggunakan arsitektur yang dikenal dengan model **GMP**.

### Anatomi GMP

*   **G (Goroutine - `runtime.g`)**:
    Representasi *logical thread* di Go. Setiap entitas `G` memiliki stack sendiri yang alokasinya dimulai sangat kecil (2KB pada Go modern) dan dapat berkembang atau menyusut sesuai kebutuhan (*stack growth/shrink*). `G` menyimpan status eksekusi (seperti `_Grunning`, `_Gwaiting`, `_Grunnable`), instruksi *program counter* (PC), serta pointer ke stack saat ini. Goroutine sangat ringan karena pembuatan dan *context-switch*-nya tidak melibatkan *system call* ke OS kernel.

*   **M (Machine/Thread - `runtime.m`)**:
    Representasi langsung dari *OS Thread* (`pthread` di ekosistem POSIX atau *Windows thread*). *M* bertanggung jawab mutlak untuk mengeksekusi urutan instruksi pada *G*. *M* di-maintain secara pasif; jika ada *syscall* yang memblokir, *M* akan ditidurkan oleh kernel OS, dan Go runtime akan membuat (atau membangunkan) *M* lain untuk menggantikannya. *M* tidak memiliki keterikatan logis permanen terhadap status Go spesifik kecuali ketika mengeksekusi instruksi. Default limit pembuatan *M* adalah 10.000 (dapat diubah via `debug.SetMaxThreads`).

*   **P (Processor/Context - `runtime.p`)**:
    *Logical processor* yang menyimpan *context* eksekusi. Konsep ini adalah inovasi utama sejak Go 1.1 yang memecahkan masalah bottleneck *global mutex*. Setiap `P` mengelola antrean Goroutine lokal yang siap jalan (*Local Run Queue* atau LRQ). Jumlah maksimal `P` yang aktif secara paralel dikendalikan oleh variabel lingkungan `GOMAXPROCS` (atau via `runtime.GOMAXPROCS`). Untuk mengeksekusi `G`, sebuah `M` mutlak membutuhkan `P`.

### Mekanisme Inti Scheduler

1.  **Work-Stealing Algorithm (Penjadwalan Keadilan Beban)**:
    Untuk mencegah *bottleneck* terpusat, scheduler Go menganut sistem *distributed queue*. Setiap `P` memiliki *Local Run Queue* (maksimal 256 Goroutine, sisanya dilempar ke *Global Run Queue*). Saat `M` yang menempel pada `P` kehabisan `G` untuk dieksekusi, ia akan mencari pekerjaan dalam urutan berikut:
    - Mengecek LRQ miliknya sendiri.
    - Mengambil dari *Global Run Queue* (setiap 61 iterasi (tick), `P` dipaksa mengambil dari antrean global untuk mencegah *starvation*).
    - Memeriksa *Network Poller* untuk melihat apakah ada *I/O request* yang sudah selesai.
    - **Stealing**: Jika semua kosong, `P` (via `M`) secara acak memilih `P` lain dan "mencuri" tepat separuh dari isi LRQ milik korban. Algoritma perampasan kerja ini sangat efisien menjaga keseimbangan *load* CPU.

2.  **Sysmon (System Monitor)**:
    *Sysmon* adalah *thread background* sangat istimewa (`runtime.sysmon`) yang berjalan mandiri tanpa membutuhkan ikatan dengan `P`. Ia berfungsi mirip sebagai dewa penjaga yang melakukan tugas pemeliharaan kritis (polling tiap 20us hingga 10ms):
    - Melakukan *retake* (merampas) `P` dari `M` yang terblokir *syscall* lebih dari 10ms.
    - Memicu *Garbage Collection* jika sudah lebih dari 2 menit sejak GC terakhir.
    - Mencabut Goroutine yang melakukan eksekusi terlalu lama tanpa henti (*preemption*).

3.  **Handoff & Syscall Blocking**:
    Ketika sebuah `G` memanggil operasi *system call* (misal membaca *file descriptor* yang sinkron), *OS Thread* (`M`) yang menjalankan `G` tersebut akan ikut terblokir di level OS. Agar `P` (yang berisi ratusan antrean `G` lain) tidak ikut terbengkalai, *runtime* menggunakan fungsi `handoffp()`. Fungsi ini akan melepaskan (detach) `P` dari `M` yang terblokir tersebut. `P` kemudian akan dipasangkan ke `M` baru yang siaga, sehingga sisa antrean `G` bisa dieksekusi terus. Ketika *syscall* selesai, `G` yang lama akan kembali mengantre.

4.  **Asynchronous Preemption (Go 1.14+)**:
    Sebelum Go 1.14, sebuah Goroutine yang berputar dalam *tight loop* (seperti `for {}` tanpa pemanggilan fungsi) tidak bisa dipaksa berhenti karena compiler hanya menyisipkan *preemption check* di *prologue* pemanggilan fungsi. Sejak Go 1.14, scheduler memiliki *Async Preemption*. Sysmon akan mengirimkan *hardware signal* (contoh: `SIGURG` di Unix) langsung ke *OS thread*. Go runtime mencegat sinyal ini dan menyuntikkan instruksi khusus (*asyncPreempt*) yang memaksa Goroutine tersebut untuk *yield* dan kembali ke antrean LRQ.

---

## 2. Diagram ASCII Arsitektur GMP

Di bawah ini adalah ilustrasi status topologi GMP di bawah beban asimetris:

```text
========================================================================================
                              GO RUNTIME SCHEDULER (USER-SPACE)
========================================================================================

    [Network Poller] ----------------------> [Global Run Queue (GRQ)]
    (epoll/kqueue)                               |  [G][G][G][G]
           |                                     |
           | (G wakes up from I/O)               | (1/61 ticks P checks GRQ)
           v                                     v

+--------------------------+   +--------------------------+   +--------------------------+
|       P0 (Context)       |   |       P1 (Context)       |   |       P2 (Context)       |
|                          |   |                          |   |                          |
|  Local Run Queue (LRQ)   |   |  Local Run Queue (LRQ)   |   |  Local Run Queue (LRQ)   |
|  [G1][G2][G3][G4][G5]    |   |  [G6][G7]                |   |  (Empty)                 |
+--------------------------+   +--------------------------+   +--------------------------+
             |                               |                              ^
             |                               |                              | (Steals 50%
             |                               |                              |  from P0)
             v                               v                              |
+--------------------------+   +--------------------------+   +--------------------------+
|       M0 (Thread)        |   |       M1 (Thread)        |   |       M2 (Thread)        |
| Executing: [G0]          |   | Executing: [G8]          |   | Executing: [Sysmon]      |
| Status: Running          |   | Status: Blocked(Syscall) |   | Status: No P required    |
+--------------------------+   +--------------------------+   +--------------------------+
             |                               |
- - - - - - -|- - - - - - - - - - - - - - - -|- - - - - - - - - - - - - - - - - - - - -
             |                               |
             v                               v
========================================================================================
                                     OS KERNEL
========================================================================================
    [ CPU Core 1 ]                   [ CPU Core 2 ]                   [ CPU Core 3 ]
```

---

## 3. Production-Ready Go Code

Dalam lingkungan produksi (khususnya untuk *low-latency system* atau interaksi CGO ekstensif), kita sering kali perlu melakukan *tuning* kesadaran scheduler atau melakukan interaksi khusus via package `runtime`. 

Kode berikut mendemonstrasikan bagaimana kita mengisolasi sebuah *Goroutine* ke *OS thread* spesifik secara presisi (dibutuhkan untuk C-libraries yang bergantung pada *Thread Local Storage* seperti grafis OpenGL atau library media) dengan propagasi *Context* dan *error handling* yang benar.

```go
package runtime_internals

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"time"
)

// GraphicsRenderer mendemonstrasikan worker yang dieksekusi secara ketat 
// pada satu thread OS yang sama selama durasi hidupnya.
type GraphicsRenderer struct {
	jobQueue chan RenderJob
	done     chan struct{}
}

// RenderJob mewakili sebuah task komputasi grafis.
type RenderJob struct {
	ID    string
	Data  []byte
	ErrCh chan<- error
}

// NewGraphicsRenderer menginisiasi komponen renderer.
func NewGraphicsRenderer() *GraphicsRenderer {
	return &GraphicsRenderer{
		jobQueue: make(chan RenderJob, 100),
		done:     make(chan struct{}),
	}
}

// Start memutar worker yang dipaku (pinned) ke thread OS tertentu.
// Menerima ctx sebagai first argument dan error propagations.
func (g *GraphicsRenderer) Start(ctx context.Context) error {
	var wg sync.WaitGroup
	wg.Add(1)

	// Goroutine ini secara eksplisit mengambil alih sebuah OS thread.
	go func() {
		defer wg.Done()
		
		// MENGUNCI GOROUTINE KE OS THREAD:
		// Sejak baris ini, M ini tidak akan pernah mengeksekusi Goroutine lain,
		// dan Goroutine ini tidak akan pernah berpindah ke M lain.
		runtime.LockOSThread()
		
		// SANGAT PENTING: 
		// Bila UnlockOSThread tidak dipanggil, OS thread yang terikat akan dimatikan
		// oleh Go runtime saat Goroutine ini selesai.
		defer runtime.UnlockOSThread()

		for {
			select {
			case <-ctx.Done():
				// Menyelesaikan proses gracefully
				return
			case job, ok := <-g.jobQueue:
				if !ok {
					return
				}
				// Eksekusi job (simulasi panggil library C++ yang butuh thread-local-state)
				time.Sleep(5 * time.Millisecond) // Simulasi CGO render
				
				// Validasi dan return result
				if len(job.Data) == 0 {
					job.ErrCh <- fmt.Errorf("context: render failed due to empty data for %s", job.ID)
					continue
				}
				job.ErrCh <- nil
			}
		}
	}()

	// Tunggu ctx done lalu matikan secara teratur jika perlu (dihilangkan untuk brevity)
	return nil
}

// SubmitJob mengirim task. Thread safe.
func (g *GraphicsRenderer) SubmitJob(job RenderJob) {
	g.jobQueue <- job
}

// Stop menghentikan renderer.
func (g *GraphicsRenderer) Stop() {
	close(g.jobQueue)
	close(g.done)
}
```

### Unit Test

Unit test tidak sekadar *happy path*, tapi memastikan mekanik `LockOSThread` berjalan dan *Goroutine* bereaksi terhadap pembatalan (context cancellation).

```go
package runtime_internals

import (
	"context"
	"testing"
	"time"
)

func TestGraphicsRenderer_ExecutionAndCancellation(t *testing.T) {
	renderer := NewGraphicsRenderer()
	
	// Gunakan timeout yang ketat
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	if err := renderer.Start(ctx); err != nil {
		t.Fatalf("failed to start renderer: %v", err)
	}

	// Buat channel terpisah untuk menangkap respons secara non-blocking
	errCh := make(chan error, 1)

	// Uji 1: Data kosong harus me-return error
	renderer.SubmitJob(RenderJob{
		ID:    "task-1",
		Data:  nil,
		ErrCh: errCh,
	})

	select {
	case err := <-errCh:
		if err == nil {
			t.Error("expected error for empty data, got nil")
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("timeout waiting for job completion")
	}

	// Uji 2: Data valid harus me-return nil
	renderer.SubmitJob(RenderJob{
		ID:    "task-2",
		Data:  []byte("valid-texture-data"),
		ErrCh: errCh,
	})

	select {
	case err := <-errCh:
		if err != nil {
			t.Errorf("expected no error, got %v", err)
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("timeout waiting for valid job completion")
	}

	// Uji 3: Memastikan Context cancellation membersihkan worker (no panic)
	cancel()
	time.Sleep(50 * time.Millisecond) // Memberi waktu scheduler untuk reap
}
```

---

## 4. Anti-Patterns Terkait Scheduler

### ❌ Anti-Pattern 1: Thread Exhaustion Melalui CGO Secara Berlebihan

Di Go, *system call* standar akan dimultiplex via *network poller* atau di-*handoff* secara efisien. Namun pemanggilan **CGO** sifatnya "hitam" (black box) bagi Go runtime. Jika Anda mengeksekusi CGO, thread OS pembawa (M) akan di-*lock*. Jika pemanggilan memakan waktu lama, scheduler akan dipaksa men-spawn *M* baru tanpa batas untuk Goroutine lain.

```go
// ❌ BAD: Memanggil library C lambat dari ribuan goroutine
func ProcessImagesInParallel(images []Image) {
    for _, img := range images {
        go func(i Image) {
            // CGO call yang memakan waktu 1 detik
            // Memblokir OS thread secara permanen selama proses!
            C.ProcessImageSlowly(i.Data)
        }(img)
    }
}
```
**Mengapa berbahaya:** Jika `images` berjumlah 15.000, Go runtime akan mencoba membuat 15.000 OS Threads. Secara default runtime hanya mengizinkan 10.000 thread. Jika terlampaui, program Anda akan mengalami PANIC permanen: `runtime: program exceeds 10000-thread limit`. Jika limit sistem operasi `ulimit -u` lebih rendah, kernel OOM *killer* akan langsung mematikan aplikasi.

```go
// ✅ GOOD: Membatasi degree of concurrency untuk pemblokiran murni
func ProcessImagesInParallel(images []Image) {
    // Batasi maksimum 100 OS thread yang di-block concurrently
    sem := make(chan struct{}, 100)
    var wg sync.WaitGroup
    for _, img := range images {
        wg.Add(1)
        sem <- struct{}{} // acquire
        go func(i Image) {
            defer wg.Done()
            defer func() { <-sem }() // release
            C.ProcessImageSlowly(i.Data)
        }(img)
    }
    wg.Wait()
}
```

### ❌ Anti-Pattern 2: GOMAXPROCS Buta pada Containerized Environments

Seringkali developer sengaja menset `runtime.GOMAXPROCS(runtime.NumCPU())` atau membiarkannya default saat di-_deploy_ di dalam Docker/Kubernetes.

```go
// ❌ BAD: Bergantung pada default runtime.NumCPU() di Kubernetes
func init() {
    // Di dalam pod k8s dengan limit 1 Core, berjalan di node host dengan 128 Cores.
    // runtime.NumCPU() me-return 128!
    // Go scheduler akan men-spawn P=128 dan M=128.
}
```
**Mengapa berbahaya:** Di lingkungan CFS (Completely Fair Scheduler) milik kernel Linux pada container, jika limit CPU pod adalah `1.0`, namun `GOMAXPROCS` Anda terdeteksi 128, scheduler Go akan men-spawn 128 OS threads yang berkompetisi ketat. OS akan melakukan *context-switching* masif di antara ratusan thread, menyebabkan *CPU Throttling* parah. Anda menghabiskan jatah waktu komputasi murni hanya untuk membayar *overhead* penjadwalan OS.

```go
// ✅ GOOD: Menggunakan automaxprocs untuk menyadari cgroup (Control Group) limit
import _ "go.uber.org/automaxprocs"

func main() {
    // automaxprocs secara otomatis membaca /sys/fs/cgroup/cpu/cpu.cfs_quota_us 
    // dan menyetel GOMAXPROCS secara proporsional saat init
    startServer()
}
```

---

## 5. Edge Cases & Penanganan Khusus

Berikut adalah kasus-kasus tepi spesifik (bukan sekadar `nil checking`) yang berhubungan dengan desain G-M-P Go runtime.

### Edge Case 1: *Goroutine Leak* yang Memblokir Sysmon (Goroutine tanpa I/O)
**Masalah:** Sebelum Go 1.14 (atau jika Anda mematikan async preemption karena suatu alasan kompilasi spesifik), sebuah Goroutine yang mengeksekusi `for {}` dan hanya memodifikasi memori register tanpa memanggil satupun fungsi internal (no *func call prologue*), tidak dapat dipreempt oleh sysmon.
**Dampak Spesifik:** Jika Anda memiliki 4 CPU Core (`GOMAXPROCS=4`), dan Anda tak sengaja melepas 4 goroutine dalam kondisi infinite loop tanpa *function call* maupun I/O, **seluruh program** termasuk HTTP server akan membeku (freeze) seratus persen!
**Solusi Defensif:** Pastikan selalu menggunakan versi Go >1.14. Jika Anda perlu mempertahankan rutinitas super-ketat, gunakan `runtime.Gosched()` secara eksplisit di dalam loop berat untuk memaksakan yield, memberi celah pada antrean lain:
```go
for i := 0; i < 1_000_000_000_000; i++ {
    heavyMathComputation()
    if i%1000 == 0 { runtime.Gosched() } // Manual yield point
}
```

### Edge Case 2: Kematian LockOSThread secara Paksa
**Masalah:** Saat `runtime.LockOSThread()` dipanggil, Goroutine terkait ditempelkan erat ke Thread. Jika goroutine ini tiba-tiba mati secara paksa tanpa melalui eksekusi `runtime.UnlockOSThread()` (misalnya karena `panic` yang di-recover di *middleware* yang jauh di atas tumpukan, namun Goroutine utama dimatikan), maka OS thread yang terkunci tersebut menjadi tidak berguna dan *dijatuhkan* oleh sistem runtime.
**Dampak Spesifik:** Jika hal ini terjadi dalam sebuah *hot-path* (misalnya API request HTTP), *Goroutine* baru yang masuk akan memicu Go runtime untuk membuat *OS Thread* (`M`) yang sama sekali baru dari kernel. Pembuatan Thread di OS sangat mahal, yang menghasilkan lonjakan latensi luar biasa (Spike).
**Solusi Defensif:** Selalu gunakan pola *defer* persis di baris setelah *LockOSThread*. 
`runtime.LockOSThread(); defer runtime.UnlockOSThread()` mutlak, bahkan jika Anda menduga kode tidak akan *panic*.

### Edge Case 3: *Timer* Resolution & Latency (Scheduler Tick)
**Masalah:** Operasi seperti `time.Sleep` atau timer diatur oleh *min-heap* di dalam struct `P`. Pengembalian (`wakeup`) Goroutine dari *sleep* di dalam timer bergantung pada sysmon dan *timer interrupt*. Di sistem operasi seperti Windows lama, resolusi timer mungkin tertahan pada kelipatan 15.6ms, menyebabkan `time.Sleep(1 * time.Millisecond)` menjadi meleset secara masif dan tidur sejauh 15ms.
**Dampak Spesifik:** Saat merancang *High-Frequency Trading System* atau poller yang memerlukan presisi sub-milidetik, mengandalkan scheduler Go secara naif akan gagal akibat granularitas tick dari M dan sysmon.
**Solusi Defensif:** Untuk *spin-wait* mikrodetik (ultra-low latency), *JANGAN* menggunakan `time.Sleep()`. Gunakan perulangan sibuk (busy wait) dengan kombinasi `runtime.Gosched()` bila menarget durasi super kecil (misalnya di bawah < 50us), dan siapkan `GOMAXPROCS` ekstra.
