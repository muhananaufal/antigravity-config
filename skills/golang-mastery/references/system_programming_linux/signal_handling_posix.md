# System Programming Linux: Signal Handling (POSIX) di Go

## 1. Konsep dan Internals

Sinyal (Signals) adalah bentuk Inter-Process Communication (IPC) tertua dan paling dasar di Linux/UNIX. Sinyal digunakan kernel untuk memberitahu sebuah proses tentang *asynchronous events*. 

### Linux Kernel Data Structures & Signal Delivery
Pada level kernel Linux, setiap proses direpresentasikan oleh `task_struct`. Ketika sebuah sinyal dikirim (misal via syscall `kill()`), kernel tidak langsung menginterupsi proses. Kernel memodifikasi struktur data di dalam `task_struct` dari proses target:
1. **`pending` (struct sigpending):** Menambahkan sinyal ke dalam antrean (bitmap/list).
2. **`blocked` (sigset_t):** Mengecek apakah proses memblokir sinyal tersebut (sigmask).
3. **Delivery:** Sinyal benar-benar dikirimkan (*delivered*) saat transisi dari Kernel Mode ke User Mode (misalnya saat proses kembali dari sebuah syscall atau saat penjadwalan ulang / *context switch*).

Di Go, penanganan sinyal sangat unik dibandingkan C/C++. Karena Go memilki *runtime scheduler* berbasis goroutine (M:N scheduler), *signal handling* tradisional POSIX (yang menginterupsi *OS thread* yang sedang berjalan untuk mengeksekusi *signal handler callback*) sangat berisiko merusak state dari *scheduler* Go. Oleh karena itu, *runtime* Go mengambil alih SEMUA sinyal (via fungsi internal `sigtramp` di level OS yang ditulis dalam Assembly/C low-level). *Runtime* kemudian mendistribusikan sinyal-sinyal ini ke dalam channel Go secara sinkron (aman), melalui *package* `os/signal`.

**Sinyal Penting di Linux:**
*   `SIGINT` (Ctrl+C) dan `SIGTERM`: Standar de-facto untuk meminta *Graceful Shutdown*.
*   `SIGKILL` (Kill -9): Eksekusi mati absolut oleh kernel. **Tidak bisa ditangkap**, di-blok, atau diabaikan oleh `os/signal`.
*   `SIGHUP`: Historisnya koneksi SSH terputus, namun aplikasi modern (seperti Nginx) menjadikannya standar untuk "Reload Configuration" tanpa henti.
*   `SIGQUIT` (Ctrl+\): Menghasilkan Core Dump. Di Go, defaultnya akan men-dump *stack trace* seluruh goroutine.
*   `SIGCHLD`: Dikirim saat *child process* berhenti atau mati, krusial untuk mencegah zombie processes.

## 2. Diagram ASCII: Signal Routing di Go Runtime

```text
       +-------------------------------------------------------------+
       |                   Linux OS Kernel Space                     |
       |                                                             |
       | 1. Syscall kill(pid, SIGINT) or Hardware Interrupt          |
       | 2. Kernel updates task_struct->pending signals bitmap       |
       | 3. Kernel sets TIF_SIGPENDING thread flag                   |
       | 4. On return to User Mode, kernel invokes signal handler    |
       +--------------------------+----------------------------------+
                                  |
                                  V (Context Switch to User Mode)
+--------------------------------------------------------------------+
|                         Go Runtime (User Space)                    |
|                                                                    |
|  [ sigtramp() - Low-level Assembly Signal Handler in Go ]          |
|    - Runs on signal stack (sigaltstack)                            |
|    - 1. Acknowledge signal                                         |
|    - 2. Push to runtime internal ring buffer                       |
|    - 3. Wake up 'signal_recv' background goroutine                 |
|                                                                    |
+---------------------------------+----------------------------------+
                                  |
                                  V (Pushed to Go Channel)
+--------------------------------------------------------------------+
|                      Your Go Application Code                      |
|                                                                    |
|  sigChan := make(chan os.Signal, 1)                                |
|  signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)           |
|                                                                    |
|  select {                                                          |
|  case <-sigChan:                                                   |
|       log.Println("Initiating Graceful Shutdown...")               |
|       httpServer.Shutdown(ctx)                                     |
|  }                                                                 |
+--------------------------------------------------------------------+
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan Channel Tanpa Buffer (Unbuffered Channel)

Fungsi `signal.Notify` mendaftarkan channel untuk menerima sinyal. Jika channel tersebut dibuat tanpa buffer (`make(chan os.Signal)`), *runtime* Go **TIDAK AKAN** memblokir dirinya untuk menunggu Anda membacanya. Jika program Anda sedang sibuk dan tidak ada goroutine yang menunggu pada channel saat sinyal tiba, sinyal tersebut akan didrop (hilang).

```go
// ❌ BAD: Channel tanpa buffer
sigChan := make(chan os.Signal) // Unbuffered!
signal.Notify(sigChan, syscall.SIGTERM)

// Jika OS mengirim SIGTERM saat goroutine ini sedang sibuk (misal init lambat),
// Runtime Go mencoba mengirim ke sigChan, tapi karena unbuffered & tidak ada reader siap,
// sinyal dibuang (dropped). Program tidak pernah tahu ia disuruh mati.
<-sigChan // Deadlock jika signal sudah lewat.
```
**Why dangerous:** Aplikasi tidak bisa dimatikan (*Graceful Shutdown* gagal). *Kubernetes* atau *systemd* mengirim `SIGTERM`, lalu menunggu 30 detik. Karena sinyal hilang, aplikasi Anda tidak merespons, dan OS terpaksa mengirim `SIGKILL`, menyebabkan korupsi data di tengah proses transaksi.

```go
// ✅ GOOD: Selalu gunakan Buffered Channel untuk Signal
sigChan := make(chan os.Signal, 1) // Buffer ukuran 1
signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
```

### ❌ Anti-Pattern 2: Asumsi `os.Exit(0)` Adalah Graceful

*Developer* sering mencetak pesan "Exiting" lalu memanggil `os.Exit(0)` saat sinyal diterima.

```go
// ❌ BAD: Langsung Exit saat sinyal diterima
go func() {
    <-sigChan
    log.Println("Shutting down...")
    os.Exit(0) // Fatal!
}()
```
**Why dangerous:** `os.Exit` akan langsung membunuh proses seketika dengan level OS. Instruksi `defer` (seperti menutup koneksi *database* atau membersihkan *temporary files*) pada fungsi `main()` dan fungsi goroutine lain **tidak akan pernah dieksekusi**. Ini mengakibatkan *resource leaks* dan transaksi *database* yang gantung (*dangling*).

```go
// ✅ GOOD: Gunakan Context Cancellation untuk memicu Exit alami
ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
defer cancel() // Membersihkan signal handler

// Kirim ctx ini ke HTTP Server atau Background Workers
<-ctx.Done()
log.Println("Signal received. Cleaning up...")
// Fungsi akan berakhir secara alami dan semua 'defer' tereksekusi
```

### ❌ Anti-Pattern 3: Mengabaikan Pengaruh `CGO` pada Signal Handling

Saat Go memanggil pustaka C menggunakan `cgo`, signal handlers POSIX dari kode C dapat bertabrakan dengan *runtime* Go. Jika kode C Anda meng-override *signal handler* (misalnya memanggil `sigaction` untuk `SIGSEGV` atau `SIGINT`), aplikasi Go bisa *crash* tanpa *stack trace* Go atau gagal melakukan shutdown.

```go
// ❌ BAD: Pustaka C secara diam-diam memodifikasi signal handler
/*
#include <signal.h>
#include <stdlib.h>
void bad_c_init() {
    signal(SIGINT, SIG_IGN); // Mengabaikan SIGINT di level OS!
}
*/
import "C"

func main() {
    C.bad_c_init()
    // Go signal.Notify(SIGINT) tidak akan pernah menerima SIGINT 
    // karena C telah menginstruksikan kernel untuk mengabaikannya (SIG_IGN).
}
```
**Why dangerous:** Aplikasi akan kebal terhadap Ctrl+C atau perintah penghentian tertentu dari OS karena konfigurasi *signal handler* dibajak oleh C.

```go
// ✅ GOOD: Pastikan CGO tidak merusak sigmask/handlers, 
// atau restore Go's handler menggunakan package `os/signal` `Reset`.
func main() {
    C.bad_c_init()
    // Kembalikan handler Go sebagai yang utama
    signal.Reset(syscall.SIGINT)
}
```

## 4. Edge Cases & Defensive Programming

1.  **Multiple Signals dan Signal Spamd (Ctrl+C ditekan 3x beruntun):**
    Jika *shutdown* memakan waktu lambat (misal 10 detik menunggu koneksi selesai), user mungkin tidak sabar dan menekan Ctrl+C berkali-kali. `signal.NotifyContext` memecahkan masalah ini dengan cerdas: Sinyal *pertama* akan men-*cancel* *context*. Jika *user* menekan *lagi* (sinyal kedua), *runtime* Go akan kembali ke perilaku *default* OS, yaitu mematikan program secara instan (menggugurkan *graceful shutdown* demi mencegah *hang*).
2.  **Sinyal Fatal Internal (SIGSEGV, SIGFPE):**
    Go menangkap sinyal sinkron seperti *Segmentation Fault* (`SIGSEGV`). Anda *tidak bisa* dan *tidak boleh* mendaftarkan ini di `signal.Notify`. Jika terjadi *panic* (seperti *nil pointer dereference*), *runtime* mengeksekusi prosedur internal untuk men-dump *stack trace* dan *crash*, memastikan program tidak berada di keadaan inkonsisten.
3.  **Tuntutan Timeout Shutdown:**
    Saat menerima `SIGTERM`, Anda harus memiliki batas waktu tegas untuk bersih-bersih (*grace period*). Jika Anda menunggu `db.Close()` dan *database* server terputus tak merespons, goroutine bersih-bersih Anda akan terblokir selamanya, yang berujung OS mengeksekusi `SIGKILL`. Gunakan `context.WithTimeout` dari sinyal diterima untuk memastikan mati dengan pasti maksimal N detik.
4.  **Menghindari Zombie Processes dengan `SIGCHLD`:**
    Jika aplikasi Anda melakukan `fork/exec` (menjalankan *child process*), Anda perlu me-reap (menuai) proses yang mati. Saat *child* mati, kernel mengirim `SIGCHLD`. Anda bisa menangkapnya dan memanggil `syscall.Wait4` untuk mencegah *child process* berubah menjadi status *Zombie* (Z) di `top/htop`.
5.  **Syscall Interruption (`EINTR`):**
    Ketika sebuah sinyal ditangkap, panggilan sistem (syscall) yang lambat (misal `read()` dari soket atau `wait()`) di sisi OS akan terganggu dan mengembalikan error `EINTR` (Interrupted system call). Meskipun *runtime* Go secara otomatis akan men-retry banyak syscall yang di-*interrupt* secara internal (sejak Go 1.14 dengan *asynchronous preemption*), saat menulis kode CGO atau *raw syscalls*, Anda harus men-handle error `EINTR` secara eksplisit dengan perulangan re-try.

## 5. Production-Ready Go Code & Unit Test

Kode di bawah menunjukkan standar emas (*gold standard*) perancangan *Graceful Shutdown* dalam aplikasi Go, memanfaatkan `signal.NotifyContext` dan sinkronisasi `errgroup`.

```go
package signaltest

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"testing"
	"time"
)

// Pekerja dummy yang berjalan dalam loop, yang dapat dihentikan via Context
func longRunningTask(ctx context.Context, id int) error {
	for {
		select {
		case <-ctx.Done():
			// Proses pembersihan khusus pekerja ini
			time.Sleep(100 * time.Millisecond) 
			return fmt.Errorf("task %d stopped gracefully: %w", id, ctx.Err())
		case <-time.After(1 * time.Second):
			// Simulasi pekerjaan rutin
			log.Printf("Task %d working...", id)
		}
	}
}

// RunApplication menyimulasikan siklus hidup aplikasi utuh
func RunApplication() error {
	// 1. Tangkap SIGINT dan SIGTERM dan ubah menjadi Context Cancellation
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop() // Wajib: membebaskan memori dan merestore perilaku default OS

	// Simulasi Background Workers (Gunakan errgroup di dunia nyata)
	doneChan := make(chan error, 2)
	go func() { doneChan <- longRunningTask(ctx, 1) }()
	go func() { doneChan <- longRunningTask(ctx, 2) }()

	// 2. Tunggu sampai ada instruksi berhenti (Context dibatalkan oleh Sinyal)
	<-ctx.Done()
	log.Println("Interrupt signal received. Initiating graceful shutdown...")

	// 3. Batas waktu kritis: Beri waktu worker maks 3 detik untuk berbenah
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	// Menunggu worker selesai, dibatasi oleh shutdownCtx
	workersDone := 0
	for workersDone < 2 {
		select {
		case err := <-doneChan:
			log.Printf("Worker exited: %v", err)
			workersDone++
		case <-shutdownCtx.Done():
			// Jika cleanup terlalu lama (db gantung, dll), paksa keluar!
			return fmt.Errorf("graceful shutdown timed out, forcefully killing application")
		}
	}

	log.Println("All workers exited cleanly. Goodbye.")
	return nil
}

// -------------------------------------------------------------------------
// Unit Test
// -------------------------------------------------------------------------
func TestSignalGracefulShutdown(t *testing.T) {
	// Jalankan aplikasi di background
	appDone := make(chan error, 1)
	go func() {
		appDone <- RunApplication()
	}()

	// Beri aplikasi waktu untuk start dan mendaftarkan signal handler
	time.Sleep(100 * time.Millisecond)

	// SIMULASI OS MENGIRIM SINYAL SIGTERM KE APLIKASI
	// Menggunakan os.Process.Signal mengirim sinyal ke diri sendiri
	process, err := os.FindProcess(os.Getpid())
	if err != nil {
		t.Fatalf("Gagal mendapat pid: %v", err)
	}
	
	if err := process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("Gagal mengirim SIGTERM: %v", err)
	}

	// Tunggu aplikasi mati
	select {
	case err := <-appDone:
		if err != nil {
			t.Errorf("Aplikasi tidak mati dengan wajar: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("Aplikasi hang! Tidak merespons SIGTERM dalam 5 detik")
	}
}

func TestSIGHUPReloadSimulation(t *testing.T) {
	// Tes ini memverifikasi bahwa program tidak mati saat menerima SIGHUP
	// Melainkan hanya mencetak (atau merefresh config)
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGHUP)
	defer signal.Stop(sigChan)

	process, err := os.FindProcess(os.Getpid())
	if err != nil {
		t.Fatalf("Gagal mendapat pid: %v", err)
	}

	// Kirim SIGHUP (biasanya untuk reload config)
	if err := process.Signal(syscall.SIGHUP); err != nil {
		t.Fatalf("Gagal mengirim SIGHUP: %v", err)
	}

	select {
	case <-sigChan:
		// Berhasil ditangkap
		t.Log("SIGHUP berhasil diterima, simulasi reload config")
	case <-time.After(1 * time.Second):
		t.Fatalf("Gagal menangkap SIGHUP tepat waktu")
	}
}

func TestSignalToOtherProcess_RootOnly(t *testing.T) {
	// Tes ini mensimulasikan daemon yang mencoba membunuh proses lain (e.g., zombie reapper / system supervisor)
	// Hanya bisa dilakukan dengan permission root di Linux jika pid lain milik user berbeda.
	if os.Getuid() != 0 {
		t.Skip("Skipping test: Requires root privileges to safely test sending arbitrary signals to other processes")
	}

	// Implementasi mock/dummy test mengirim signal ke proses Init/dummy process
	// Peringatan: jangan mengirim SIGKILL ke PID 1 (Init) secara nyata!
	// Kita akan spawn child process kecil dan kirim signal kepadanya.
	
	// Create dummy child
	attr := &os.ProcAttr{Files: []*os.File{os.Stdin, os.Stdout, os.Stderr}}
	proc, err := os.StartProcess("/bin/sleep", []string{"sleep", "10"}, attr)
	if err != nil {
		t.Fatalf("Gagal membuat dummy child process: %v", err)
	}

	// Kirim SIGTERM ke child process
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("Gagal mengirim sinyal ke child: %v", err)
	}

	// Menunggu exit (reaping)
	state, err := proc.Wait()
	if err != nil {
		t.Fatalf("Gagal wait child: %v", err)
	}

	if state.ExitCode() == 0 {
		t.Logf("Proses child berhasil diterminate, Exit Code: %d (tergantung implementasi shell/sleep)", state.ExitCode())
	}
}
```
