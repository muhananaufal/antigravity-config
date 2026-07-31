# System Programming Linux: Process Management (Exec/Fork Patterns) di Go

## 1. Konsep dan Internals

Manajemen proses di Linux berakar pada dua *system call* historis: `fork()` dan `execve()`.
*   **`fork()`**: Menggandakan proses saat ini. Menghasilkan *Parent Process* dan *Child Process* yang berbagi segmen memori (berkat *Copy-on-Write*).
*   **`execve()`**: Mengganti *image* memori proses saat ini dengan program yang benar-benar baru. 

Kombinasi keduanya (sering disebut *fork-exec*) adalah cara Linux meluncurkan program baru. Go, berbeda dengan C, tidak mengekspos fungsi murni `fork()` secara langsung (misal: `syscall.Fork()`). Hal ini disengaja karena model konkurensi Go (*Goroutines* berbasis *OS threads*) sangat rentan terhadap kondisi mematikan jika di-*fork*. Memanggil `fork()` murni di aplikasi multithreaded (seperti *runtime* Go) hanya akan menyalin *thread* pemanggil, mengabaikan goroutine lain, dan berpotensi merusak *locks/mutex* yang menyebabkan *deadlock* instan.

Alih-alih `fork()`, Go menyediakan abstraksi tingkat tinggi via package `os/exec` dan `os` (atau `syscall.ForkExec`), di mana *runtime* Go mengunci OS thread sebentar via `RawSyscall` untuk secara aman melakukan kombinasi *fork* diikuti secara instan oleh *execve*.

Ada dua pola utama saat mengelola proses di Go:
1.  **Synchronous Execution (`Run`, `CombinedOutput`):** Proses Go menunggu hingga *child process* selesai berjalan.
2.  **Daemonization / Background (`Start`):** *Child process* diluncurkan dan dibiarkan berjalan (terlepas). Seringkali melibatkan pemutusan koneksi *standard I/O* dan adopsi oleh PID 1.

### Linux Kernel Data Structures (Deep Internals)
Di dalam kernel Linux, setiap thread dan proses direpresentasikan oleh `task_struct` (terletak di `include/linux/sched.h`). Struktur raksasa ini menyimpan:
- **Status Proses:** `state` (contoh: `TASK_RUNNING`, `TASK_INTERRUPTIBLE`, `TASK_UNINTERRUPTIBLE` (D-state)).
- **Identifiers:** `pid`, `tgid` (Thread Group ID).
- **Parent/Child Links:** `real_parent`, `children`, `sibling`.
- **Memory Descriptor:** `mm_struct` yang mengatur virtual memory mapping (Page Tables).

Saat `fork()` (atau lebih tepatnya `clone` syscall di sistem modern) dipanggil, kernel menjalankan rutin `kernel_clone()` (sebelumnya `do_fork()`). Fungsi ini membuat salinan `task_struct`. Berkat mekanisme **Copy-On-Write (COW)** dari Memory Management Unit (MMU) yang didukung hardware, halaman memori (`mm_struct`) tidak benar-benar disalin ke RAM fisik sampai salah satu proses (biasanya anak) memodifikasinya.

Namun, di Go, OS threads berasosiasi dengan M (Machine) pada runtime, dan setiap M mengeksekusi goroutines (G). Jika kita mem-bypass runtime dan memanggil C `fork()`, OS hanya menggandakan thread M yang memanggil `fork()`. Thread lain (seperti garbage collector atau sysmon) **TIDAK** digandakan. Jika thread-thread yang hilang tersebut memegang mutex internal Go runtime (misalnya untuk alokasi memori), *child process* yang baru akan macet seketika (*instant deadlock*) saat mencoba mengalokasi memori. Itulah mengapa Go mengemas peluncuran proses dengan `os/exec` di mana OS thread dikunci dengan `runtime.LockOSThread()`, memanggil `clone` syscall, mengatur pipa (pipes), dan segera memanggil `execve` menggunakan *Raw Syscall* tanpa memicu sistem alokasi memori runtime.

## 2. Diagram ASCII: Fork-Exec Pipeline di Go

```text
+-----------------------------------+
|  Go Parent Process (PID 1000)     |
|                                   |
|  1. Setup Pipes (Stdin/Out/Err)   |
|  2. Clone Syscall (Fork)  +------------------------+
|                           |      OS Kernel         |
+---------+-----------------+-------+----------------+
          |                         |
(Goroutine Wait/Wait4 syscall)      | [Copy-On-Write]
          |                         V
          |                 +------------------------+
          |                 | Child Process (PID 1001) |
          |                 | (Still Go Runtime)       |
          |                 |                        |
          |                 | 3. Close extra FDs     |
          |                 | 4. dup2(Pipes -> 0,1,2)|
          |                 | 5. execve("/bin/ls")   |
          |                 +-----------+------------+
          |                             |
          |                             V
          |                 +------------------------+
          |                 | Process replaced!      |
          |                 | running /bin/ls        |
          |                 | (Output sent via Pipe) |
          |<--- (SIGCHLD) --+ exit(0)                |
          |                 +------------------------+
+---------+----------+
|  Cmd.Wait() returns|
|  Status: 0         |
+--------------------+
```

### ASCII Diagram: Process State Machine di Linux

Status proses yang tersimpan dalam `task_struct` bertransisi berdasarkan kejadian (events), IO, dan sinyal.

```text
       [ fork() / clone() ]
               |
               V
       +---------------+                   [ Sched / Preempt ]
       |  TASK_NEW     | ----------------------+
       +---------------+                       |
               |                               V
               | wake_up_new_task()    +-------------------+
               +---------------------> |   TASK_RUNNING    | <------------------+
                                       | (Ready / On CPU)  |                    |
                                       +-------------------+                    |
                                         |               |                      |
                    [ wait() / I/O ]     |               |                      |
            +----------------------------+               |                      |
            |                                            |                      |
            V                                            V                      |
 +-----------------------+                    +------------------------+        |
 | TASK_INTERRUPTIBLE    |                    | TASK_UNINTERRUPTIBLE   |        |
 | (S-State / Sleep)     |                    | (D-State / Disk Sleep) |        |
 | Bisa dibangunkan oleh |                    | Tidak bisa di-kill oleh|        |
 | sinyal atau I/O.      |                    | SIGKILL (menunggu H/W) |        |
 +-----------------------+                    +------------------------+        |
            |                                            |                      |
            | [ Signal / I/O Ready ]                     | [ Hardware Ready ]   |
            +--------------------------------------------+----------------------+
               
               | (dari RUNNING state -> exit())
               V
       +---------------+         wait() dari Parent
       | TASK_DEAD (Z) | ---------------------------------> [ Proses Dihapus dari Tabel ]
       | (Zombie)      |
       +---------------+
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: `Wait()` Tanpa Mengosongkan Pipe `Stdout/Stderr`

Seringkali developer ingin memantau atau mengabaikan *output* dari *child process*, dan mereka membuat *pipe* namun lupa untuk membacanya.

```go
// ❌ BAD: Menelantarkan Pipe
cmd := exec.Command("tar", "-czf", "archive.tar.gz", "/huge_dir")
stdout, _ := cmd.StdoutPipe() // Membuat pipe
cmd.Start()
// Developer lupa membaca `stdout`. Pipe buffer OS di Linux (umumnya 64KB) akan penuh.
cmd.Wait() // DEADLOCK!
```
**Why dangerous:** *Deadlock!* Jika *child process* menulis lebih dari 64KB ke *stdout*, ia akan diblokir oleh OS (*blocked on write*) karena *buffer pipe* penuh. Sementara itu, `cmd.Wait()` di *parent process* menunggu selamanya agar *child process* selesai.

```go
// ✅ GOOD: Menggunakan buffer atau menyalinnya ke io.Discard
cmd := exec.Command("tar", "-czf", "archive.tar.gz", "/huge_dir")
cmd.Stdout = io.Discard // OS akan membuang output secara instan
cmd.Stderr = os.Stderr  // Alirkan error ke terminal host

// Atau baca asinkron jika butuh pipe
// go io.Copy(os.Stdout, stdout) 
cmd.Run() // Start + Wait otomatis
```

### ❌ Anti-Pattern 2: Kegagalan Menangani Proses Yatim (Zombie Process)

Ketika memanggil `cmd.Start()` dan tidak pernah memanggil `cmd.Wait()`, proses anak yang telah selesai (exit) akan menjadi **Zombie** (status `Z` di `htop`). Kernel menyimpan kode *exit* di tabel proses sampai *parent* membacanya (lewat `Wait`).

```go
// ❌ BAD: Fire and forget yang menciptakan Zombies
func FireAndForget() {
    cmd := exec.Command("curl", "http://example.com/ping")
    cmd.Start()
    // Selesai. Wait() tidak pernah dipanggil. 
    // Kernel Linux membiarkan status curl sebagai Zombie selamanya.
}
```
**Why dangerous:** Kebocoran *File Descriptor* dan PID limit exhaustion. Sistem akan kehabisan alokasi PID dan aplikasi Anda akan mulai gagal meluncurkan proses baru dengan error `EAGAIN` (resource temporarily unavailable).

```go
// ✅ GOOD: Pastikan Wait selalu dipanggil
func LaunchBackground(ctx context.Context) {
    cmd := exec.CommandContext(ctx, "curl", "http://example.com/ping")
    if err := cmd.Start(); err != nil {
        return
    }
    // Lakukan reaping di goroutine terpisah
    go func() {
        err := cmd.Wait() // Membersihkan entry di tabel proses OS
        if err != nil {
            log.Printf("Background process selesai dengan error: %v", err)
        }
    }()
}
```

### ❌ Anti-Pattern 3: Memanggil `fork()` Murni Menggunakan `syscall.Syscall`

Mencoba menjadi "pintar" dengan langsung memanggil syscall fork dalam program multithreaded Go.

```go
// ❌ BAD: Memanggil fork murni pada runtime multithreaded
func manualFork() {
    // 1. Thread yang memanggil fork akan digandakan.
    // 2. Thread lain (termasuk GC) hilang di child.
    // 3. Jika mutex memori dipegang oleh thread lain di parent, child process
    //    akan terkunci (deadlock) pada malloc/new pertama.
    r1, _, err := syscall.Syscall(syscall.SYS_FORK, 0, 0, 0)
    if err != 0 {
        panic(err)
    }
    if r1 == 0 {
        // Berada di child process
        fmt.Println("I am child!") // fmt.Println menggunakan alokator memori, DEADLOCK!
        os.Exit(0)
    }
}
```
**Why dangerous:** OS mengimplementasikan fork hanya untuk me-replicate memori (via COW) dan *thread* yang memanggilnya. Di runtime multithreaded seperti Go, *locks* yang sedang dipegang oleh thread lain (yang tidak ter-fork) akan tersalin dalam status "terkunci" di memori *child process*. Ketika *child* mencoba mengambil *lock* tersebut, ia akan menunggu selamanya karena thread pembuka kuncinya tidak ada di proses tersebut. Selalu gunakan `os/exec` karena Go runtime menangani "ForkExec" dalam satu transaksi mikrosekon dan menangguhkan pengumpulan sampah dan signal handling di antaranya.

## 4. Edge Cases & Defensive Programming

1.  **Double Kill dan Process Group (`Setsid`):**
    Saat menggunakan `exec.CommandContext`, jika *context* di-*cancel*, Go akan mengirim sinyal `SIGKILL` ke *child process* itu saja. Jika proses tersebut telah me-*spawn* proses cucu (contoh: *shell script* yang memanggil proses lain), cucunya **TIDAK** akan terbunuh (menjadi *orphan*).
    **Defensive:** Set `SysProcAttr.Setpgid = true` untuk meletakkan *child process* di *Process Group* baru. Saat *context timeout*, ubah konfigurasi agar Go mengirim *kill* ke negasi PID (`-PID`) yang membunuh seluruh kelompok proses.
2.  **Environment Variable Injection:**
    Secara default, proses anak mewarisi **seluruh** *environment variables* dari *parent*. Ini berisiko membocorkan rahasia seperti `AWS_SECRET_KEY` ke skrip pihak ketiga.
    **Defensive:** Selalu berikan list eksplisit pada `cmd.Env`. Jika ingin menyertakan *environment* sistem standar (seperti `PATH`), gunakan `os.Environ()` dan saring secara manual.
3.  **FD Leak across Fork:**
    Semua *file descriptor* yang terbuka dengan flag tanpa `O_CLOEXEC` akan diwariskan ke proses anak. Go secara internal mengaktifkan `O_CLOEXEC` (Close on Exec) untuk semua file. Namun, jika Anda menggunakan *library* CGO yang membuka file tanpa flag ini, *child process* akan menahan referensi file tersebut, menghalangi penghapusan file.
4.  **OOM Killer dan penyesuaian OOM Score (`oom_score_adj`):**
    Linux *Out of Memory* (OOM) Killer membunuh proses berdasarkan skor. Anak proses akan mewarisi `oom_score_adj` dari parent-nya. Jika Anda ingin memastikan child process dibunuh *lebih dulu* sebelum host aplikasi jika kehabisan memori, Anda bisa memodifikasi skornya.
    **Defensive:** Buka `/proc/<PID>/oom_score_adj` untuk PID anak setelah dijalankan, lalu tuliskan angka (misal `500` hingga `1000`) agar child process rentan terhadap OOM Killer (dibutuhkan akses root).
5.  **Signal Forwarding:**
    Jika proses Go Anda (parent) menerima sinyal `SIGINT` atau `SIGTERM`, proses anak (kecuali yang memakai *Process Group* terpisah dan ditangani khusus) mungkin tetap berjalan jika `cmd.Wait()` tiba-tiba dibatalkan.
    **Defensive:** Tangani interrupt (`os.Signal` channel) secara eksplisit di parent process dan teruskan (forward) sinyal tersebut ke *child processes* menggunakan `cmd.Process.Signal(os.Interrupt)` sebelum memanggil `os.Exit()`.

## 5. Production-Ready Go Code & Unit Test

Kode berikut menunjukkan peluncuran proses dengan `context` *timeout* dan pembunuhan aman (*Process Group Killing*) jika batas waktu terlewati.

```go
package procman

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// RunCommandSafe menjalankan perintah eksternal dengan batas waktu
// dan jaminan mematikan seluruh cucu proses (Process Group).
func RunCommandSafe(ctx context.Context, timeout time.Duration, command string, args ...string) ([]byte, error) {
	// Buat context dengan timeout absolut untuk penjagaan ganda
	ctxTimeout, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.Command(command, args...)
	
	// Isolasi Process Group (Setpgid). Ini membuat child PID menjadi ketua grup.
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid: true,
	}

	var outBuf bytes.Buffer
	var errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf

	// Bersihkan env agar aman
	cmd.Env = []string{"PATH=/bin:/usr/bin:/usr/local/bin"}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start cmd: %w", err)
	}

	// Goroutine pemantau Timeout/Cancel
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	select {
	case err := <-done:
		// Selesai secara wajar sebelum timeout
		if err != nil {
			return nil, fmt.Errorf("command failed: %s: %w", errBuf.String(), err)
		}
		return outBuf.Bytes(), nil

	case <-ctxTimeout.Done():
		// Timeout tercapai atau context induk dibatalkan!
		// Lakukan Process Group Kill. Kita kirim sinyal SIGKILL ke (-PID)
		// Negasi PID (-PID) berarti sinyal dikirim ke grup tersebut
		pid := cmd.Process.Pid
		killErr := syscall.Kill(-pid, syscall.SIGKILL)
		
		// Wait dipanggil untuk me-reap zombie
		<-done 

		if killErr != nil {
			return nil, fmt.Errorf("context timeout, but failed to kill process group (PID %d): %v", pid, killErr)
		}
		
		return nil, fmt.Errorf("command timed out after %v and was killed", timeout)
	}
}

// -------------------------------------------------------------------------
// Unit Test
// -------------------------------------------------------------------------

// Tes 1: Perintah berjalan lancar
func TestRunCommandSafe_Success(t *testing.T) {
	ctx := context.Background()
	out, err := RunCommandSafe(ctx, 2*time.Second, "echo", "hello world")
	if err != nil {
		t.Fatalf("Expected success, got error: %v", err)
	}
	if string(out) != "hello world\n" {
		t.Errorf("Expected 'hello world', got '%s'", string(out))
	}
}

// Tes 2: Perintah memakan waktu terlalu lama dan HARUS dibunuh (Timeout & Process Group Kill)
func TestRunCommandSafe_Timeout(t *testing.T) {
	ctx := context.Background()
	start := time.Now()
	// sh -c sleep 5 membangkitkan dua proses: sh dan sleep (anak dari sh).
	_, err := RunCommandSafe(ctx, 500*time.Millisecond, "sh", "-c", "sleep 5")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatalf("Expected command to timeout and return error, but it succeeded")
	}

	// Waktu yang berlalu harusnya sekitar 500ms, bukan 5 detik.
	if elapsed >= 2*time.Second {
		t.Errorf("Command took too long to terminate (%v), process group kill might have failed", elapsed)
	}
}

// Tes 3: Pastikan zombie proses di-reap secara benar
func TestRunCommandSafe_ZombieReaping(t *testing.T) {
	ctx := context.Background()
	// Menjalankan command yang exit instan, jika Wait() tidak berfungsi, zombie akan tersisa
	_, err := RunCommandSafe(ctx, 2*time.Second, "true")
	if err != nil {
		t.Fatalf("Expected true to exit 0: %v", err)
	}
	// Di Linux, kita tidak bisa secara mudah mem-polling tabel zombie untuk diri kita sendiri 
	// dari user-space tanpa parsing /proc. Namun fungsi RunCommandSafe memanggil Wait()
	// sehingga kita asumsikan proses zombie tersapu (reaped).
}

// Tes 4: Test Guarded (Membutuhkan akses ROOT untuk mengatur OOM Score)
func TestRunCommand_OOMScore(t *testing.T) {
	// Guard: Hanya berjalan jika UID adalah 0 (root)
	if os.Getuid() != 0 {
		t.Skip("Skipping test: Requires root privileges to write to /proc/<pid>/oom_score_adj")
	}

	cmd := exec.Command("sleep", "10")
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start: %v", err)
	}

	// Sesuaikan OOM Score
	scorePath := fmt.Sprintf("/proc/%d/oom_score_adj", cmd.Process.Pid)
	err := os.WriteFile(scorePath, []byte("500"), 0644)
	if err != nil {
		cmd.Process.Kill()
		t.Fatalf("Failed to write oom_score_adj: %v", err)
	}

	cmd.Process.Kill()
	cmd.Wait()
}
```
