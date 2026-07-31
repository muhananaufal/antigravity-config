# System Programming Linux: Seccomp-BPF Sandboxing di Go

## 1. Konsep dan Internals

**Seccomp (Secure Computing Mode)** adalah fitur kemanan krusial di kernel Linux yang membatasi *system calls* (syscalls) apa saja yang boleh dieksekusi oleh sebuah proses. Jika proses (*attacker* atau kode rawan) mencoba memanggil syscall yang diblokir, kernel akan langsung membunuhnya (`SIGSYS`).

**Seccomp-BPF** adalah ekstensi seccomp modern yang menggunakan filter eBPF (Extended Berkeley Packet Filter) di dalam kernel untuk mengevaluasi tidak hanya nomor syscall, tetapi juga parameter argumennya. Ini memungkinkan filter yang sangat presisi (contoh: membolehkan `open()` hanya untuk flag `O_RDONLY`).

### Struktur Data `seccomp_data`
Saat sebuah syscall dipanggil, kernel menyiapkan buffer `seccomp_data` (terdefinisi di `<linux/seccomp.h>`) yang kemudian dievaluasi oleh mesin BPF dalam *kernel space*. Struktur ini berbentuk:
```c
struct seccomp_data {
    int   nr;                   // Nomor System call (Offset 0)
    __u32 arch;                 // Nilai AUDIT_ARCH_* (Offset 4)
    __u64 instruction_pointer;  // Instruction pointer CPU pada saat syscall (Offset 8)
    __u64 args[6];              // Argumen System call (Offset 16, 24, 32, ...)
};
```
BPF instruksi membaca lokasi memori menggunakan mode absolut (BPF_ABS). Karena arsitektur dan offset ini sangat spesifik ke Linux Kernel, perancang filter harus sangat presisi mengatur offset (contoh: membaca arch di offset 4, membaca nr di offset 0).

Di Go, penggunaan Seccomp sangat rumit karena dua alasan:
1.  **Runtime Go Membutuhkan Banyak Syscalls:** *Goroutines*, *Garbage Collector*, dan *Network Poller* memanggil puluhan syscall aneh secara konstan (seperti `futex`, `epoll_wait`, `mmap`, `sched_yield`, `clone`, `sigaltstack`). Memblokir ini akan membuat aplikasi Go hancur pada saat melakukan *booting* atau beroperasi.
2.  **CGO & Cross-platform:** Library Go untuk seccomp (`libseccomp-golang`) membutuhkan CGO, yang merusak keunggulan *static binary* Go. Oleh karena itu, library native Go seperti `golang.org/x/sys/unix` (dengan merakit BPF instruksi manual) lebih disukai untuk aplikasi bebas CGO, meski jauh lebih sulit diprogram.

## 2. Diagram ASCII: Seccomp-BPF Evaluation & Memory Layout

```text
+-------------------------------------------------------------+
|                     User Space (Go App)                     |
|                                                             |
|   os.Remove("/etc/shadow")                                  |
|         |                                                   |
|         V                                                   |
|   syscall: unlinkat(dirfd, "/etc/shadow", 0)                |
+---------|---------------------------------------------------+
          | Context Switch & Trap ke Kernel
          V
+---------|---------------------------------------------------+
|     Kernel Space                                            |
|                                                             |
|  [ seccomp_data Struct Passed to BPF VM ]                   |
|  +--------+--------+----------------+-------------------+   |
|  | nr(0)  | arch(4)| ip(8)          | args[0..5] (16+)  |   |
|  +--------+--------+----------------+-------------------+   |
|                                                             |
|  [ Seccomp BPF Engine Evaluator ]                           |
|  1. Load Syscall Number (unlinkat=263) [BPF_LD nr]          |
|  2. JUMP IF syscall != 263 TO NEXT_CHECK                    |
|  3. Memeriksa argumen (flags/integer)                       |
|     (Pointer seccomp tidak di-dereference oleh BPF)         |
|                                                             |
|  [ Result: SECCOMP_RET_KILL_PROCESS ] ----> (Sends SIGSYS)  |
|                                                  |          |
|  (If Allowed: SECCOMP_RET_ALLOW)                 V          |
|         |                              +------------------+ |
|         V                              | Process Killed!  | |
|  [ Execute Syscall ]                   | Core Dumped.     | |
|                                        +------------------+ |
+-------------------------------------------------------------+
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Mengaktifkan Seccomp Sebelum Inisialisasi Runtime Selesai

Menerapkan profil `seccomp` Strict (Mode 1) atau filter ketat di baris pertama `main()` adalah kesalahan fatal. Go secara *lazy* menginisialisasi beberapa komponen. Jika *filter* diterapkan sebelum Go memanggil `mmap` untuk alokasi *heap*, atau `clone` untuk *OS Thread* tambahan, program akan mati mendadak.

```go
// ❌ BAD: Menerapkan Seccomp terlalu awal dengan filter terlalu sempit
func main() {
    // strict mode (hanya allow read, write, exit, sigreturn)
    unix.Prctl(unix.PR_SET_SECCOMP, unix.SECCOMP_MODE_STRICT, 0, 0, 0)
    
    // Aplikasi akan crash instan dengan SIGSYS (Bad System Call)
    // Karena fmt.Println memanggil malloc -> mmap (dilarang!)
    fmt.Println("Hello world") 
}
```
**Why dangerous:** Keruntuhan program yang tidak terprediksi karena Go mengabstraksi pemanggilan *syscall* di balik *runtime*. Filter ketat harus diterapkan **HANYA** setelah aplikasi memasuki *event loop* utamanya.

```go
// ✅ GOOD: Terapkan Seccomp via BPF untuk syscall spesifik (Mode Filter 2)
// Daftarkan semua syscall esensial Go (futex, epoll, mmap)
// atau batasi secara spesifik (deny-list) apa yang berbahaya (misal: execve).
```

### ❌ Anti-Pattern 2: Lupa PR_SET_NO_NEW_PRIVS

Kernel Linux menolak pemasangan Seccomp-BPF jika proses memiliki potensi ekskalasi (*setuid/setgid*), KECUALI proses secara definitif mendeklarasikan bahwa ia menolak semua ekskalasi hak istimewa di masa depan via `PR_SET_NO_NEW_PRIVS`.

```go
// ❌ BAD: Mengirim filter bpf tanpa set no_new_privs (Akan gagal)
err := unix.Prctl(unix.PR_SET_SECCOMP, unix.SECCOMP_MODE_FILTER, uintptr(unsafe.Pointer(&prog)), 0, 0)
// err = EACCES (Permission denied) jika tidak dijalankan sebagai root murni
```
**Why dangerous:** Sandboxing gagal diinisialisasi. Jika error ini tidak di-*panic*, aplikasi Anda berjalan tanpa pengamanan (*Unsandboxed*), memberikan rasa aman palsu (*False Sense of Security*).

```go
// ✅ GOOD: Panggil No New Privs terlebih dahulu
if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
    log.Fatalf("Gagal set NO_NEW_PRIVS: %v", err)
}
// Baru panggil SECCOMP_MODE_FILTER
```

### ❌ Anti-Pattern 3: TOCTOU (Time-of-Check to Time-of-Use) pada Pointer Argument

Seccomp-BPF HANYA dapat memeriksa nilai register mentah yang menyusun `seccomp_data`. BPF dalam seccomp **TIDAK MENGIZINKAN** proses *dereference pointer* ke *user space* memory (hal ini berbeda dengan eBPF `bpf()` modern untuk tracing).

```go
// ❌ BAD: Mencoba memblokir akses file spesifik via BPF string checking (TIDAK MUNGKIN)
// BPF seccomp tidak bisa men-dereference char* /etc/shadow dari argumen openat!
// Jika diakali via userspace-BPF bridge, ini sangat rawan Time-Of-Check to Time-Of-Use (TOCTOU).
```
**Why dangerous:** Penyerang dengan eksploitasi memori di *user space* dapat menukar (*swap*) string di alamat memori setelah BPF filter meloloskan *pointer*-nya, tetapi tepat sebelum *syscall* kernel membacanya, sehingga secara efektif melewati filter.
```go
// ✅ GOOD: Gunakan Landlock LSM atau AppArmor untuk policy berbasis File-Path.
// Batasi penggunaan Seccomp HANYA untuk:
// 1. Memblokir seluruh kategori syscall (contoh: blokir `execve` sepenuhnya).
// 2. Memfilter argumen bertipe Integer/Flags (contoh: izinkan `openat` JIKA flag == O_RDONLY).
```

## 4. Edge Cases & Defensive Programming

1.  **Architecture Dependency (amd64 vs arm64):**
    Nomor syscall berbeda di setiap arsitektur. Nomor `epoll_wait` di `amd64` (232) berbeda dari `arm64`. Filter BPF tingkat rendah HARUS memeriksa arsitektur di awal. Jika aplikasi Go yang dikompilasi ke ARM64 menggunakan nomor `amd64`, filter akan merespons secara keliru dan aplikasi *crash*.
    *Implementation Detail:* Tambahkan instruksi BPF untuk membaca offset arsitektur di depan filter: `unix.BPFStmt(unix.BPF_LD|unix.BPF_W|unix.BPF_ABS, uint32(4))`. Lalu lakukan `BPFJump` untuk `AUDIT_ARCH_X86_64` atau arsitektur target; jika meleset, langsung lompat ke `SECCOMP_RET_KILL`.

2.  **Multithreading (Goroutine) Scope:**
    Saat memanggil `unix.Prctl` atau *syscall* seccomp, efeknya biasanya diaplikasikan ke *Thread OS* spesifik (*Thread-Local*). Jika goroutine dipindahkan oleh *scheduler* ke Thread OS lain yang tidak difilter, ia bisa lolos.
    *Implementation Detail:* Gunakan flag `SECCOMP_FILTER_FLAG_TSYNC` saat menerapkan mode filter via kernel >= 3.17: `unix.Seccomp(unix.SECCOMP_SET_MODE_FILTER, unix.SECCOMP_FILTER_FLAG_TSYNC, unsafe.Pointer(&prog))`. Flag ini menjamin kernel mensinkronisasikan filter ke semua *OS Threads* yang berelasi dengan proses secara *atomic*.

3.  **Audit dan Debugging:**
    Mendebug *crash* karena seccomp sangat membingungkan (hanya teks `SIGSYS`). Sebagai gantinya, saat *development phase*, jangan gunakan `SECCOMP_RET_KILL`.
    *Implementation Detail:* Gunakan `SECCOMP_RET_TRAP`. Ini memicu signal `SIGSYS` yang bisa ditangkap oleh Go `os/signal` handler sebelum aplikasi mati. Anda dapat membaca pointer *Context* dari signal ini untuk mengekstrak register dan melog nomor *syscall* apa yang menyebabkan pelanggaran untuk memudahkan penulisan *whitelist*.

## 5. Production-Ready Go Code & Unit Test

Contoh berikut menunjukkan cara memblokir syscall `execve` menggunakan BPF murni (tanpa CGO) melalui `golang.org/x/sys/unix`. Ini sering digunakan oleh daemon network murni untuk mencegah *Remote Code Execution (RCE)* untuk membuka `sh`.

```go
package sandbox

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/unix"
)

// BlockExecve menyematkan filter seccomp bpf untuk memblokir fork/execve.
// Menggunakan Context untuk propagasi cancellation/timeout selama setup.
func BlockExecve(ctx context.Context) error {
	// Menerima cancelation via context
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("setup canceled before applying seccomp: %w", err)
	}

	// 1. Tolak penambahan privileges
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return fmt.Errorf("prctl(PR_SET_NO_NEW_PRIVS) failed: %w", err)
	}

	// 2. Rangkai instruksi BPF manual. 
	// AUDIT_ARCH_X86_64
	const archX86_64 = 0xC000003E 

	filter := []unix.SockFilter{
		// A = arsitektur proses (Offset 4)
		unix.BPFStmt(unix.BPF_LD|unix.BPF_W|unix.BPF_ABS, uint32(4)), 
		// Jika arsitektur bukan x86_64, matikan (asumsi x86_64)
		unix.BPFJump(unix.BPF_JMP|unix.BPF_JEQ|unix.BPF_K, archX86_64, 0, 4),

		// A = nomor syscall (Offset 0)
		unix.BPFStmt(unix.BPF_LD|unix.BPF_W|unix.BPF_ABS, 0),

		// Jika syscall == execve (59), lompat ke KILL
		unix.BPFJump(unix.BPF_JMP|unix.BPF_JEQ|unix.BPF_K, unix.SYS_EXECVE, 1, 0),
		// Jika syscall == execveat (322), lompat ke KILL
		unix.BPFJump(unix.BPF_JMP|unix.BPF_JEQ|unix.BPF_K, unix.SYS_EXECVEAT, 0, 1),
		
		// ALLOW
		unix.BPFStmt(unix.BPF_RET|unix.BPF_K, unix.SECCOMP_RET_ALLOW),
		// KILL (SIGSYS)
		unix.BPFStmt(unix.BPF_RET|unix.BPF_K, unix.SECCOMP_RET_KILL_PROCESS),
	}

	prog := unix.SockFprog{
		Len:    uint16(len(filter)),
		Filter: (*unix.SockFilter)(unsafe.Pointer(&filter[0])),
	}

	// 3. Terapkan Filter secara global (sinkronisasi semua thread)
	err := unix.Seccomp(unix.SECCOMP_SET_MODE_FILTER, unix.SECCOMP_FILTER_FLAG_TSYNC, unsafe.Pointer(&prog))
	if err != nil {
		return fmt.Errorf("seccomp(SECCOMP_SET_MODE_FILTER) failed: %w", err)
	}

	return nil
}

// -------------------------------------------------------------------------
// Unit Tests (Production Ready)
// -------------------------------------------------------------------------

// Helper to run tests in an isolated subprocess to prevent the global
// Seccomp filter from interfering with the main 'go test' runner.
func runInSubprocess(t *testing.T, testName string) error {
	cmd := exec.Command(os.Args[0], "-test.run="+testName)
	cmd.Env = append(os.Environ(), "BE_CRASHER=1")
	return cmd.Run()
}

// Test 1: Verifikasi bahwa proses benar-benar crash (SIGSYS) saat mengeksekusi syscall yang diblokir.
func TestSeccompBlockExec_Success(t *testing.T) {
	if os.Getenv("BE_CRASHER") == "1" {
		ctx := context.Background()
		if err := BlockExecve(ctx); err != nil {
			fmt.Printf("Seccomp failed to apply: %v\n", err)
			os.Exit(1)
		}
		
		// Ini memanggil syscall execve yang telah diblokir.
		// Seharusnya secara instan dibunuh dengan SIGSYS oleh Kernel.
		syscall.ForkExec("/bin/echo", []string{"echo", "blocked"}, nil)
		
		// Jika sampai sini, seccomp GAGAL.
		os.Exit(0)
	}

	err := runInSubprocess(t, "TestSeccompBlockExec_Success")
	if err == nil {
		t.Fatalf("Process should have been killed by SIGSYS, but exited normally")
	}

	// Memastikan exit code berasal dari signal SIGSYS
	if exitError, ok := err.(*exec.ExitError); ok {
		status := exitError.Sys().(syscall.WaitStatus)
		if status.Signal() != syscall.SIGSYS {
			t.Errorf("Expected SIGSYS (%v), got: %v", syscall.SIGSYS, status.Signal())
		}
	} else {
		t.Fatalf("Expected ExitError, got: %v", err)
	}
}

// Test 2: Edge Case ketika PR_SET_NO_NEW_PRIVS dilupakan (seharusnya gagal jika bukan root).
func TestSeccomp_NoNewPrivs_Missing(t *testing.T) {
	// Test ini membutuhkan non-root env, karena root bisa mengabaikan no_new_privs di beberapa skenario.
	if os.Getuid() == 0 {
		t.Skip("Skipping test because root user might bypass PR_SET_NO_NEW_PRIVS requirement")
	}

	// Simulasi Anti-Pattern 2: Filter tanpa no_new_privs
	filter := []unix.SockFilter{
		unix.BPFStmt(unix.BPF_RET|unix.BPF_K, unix.SECCOMP_RET_ALLOW),
	}
	prog := unix.SockFprog{
		Len:    uint16(len(filter)),
		Filter: (*unix.SockFilter)(unsafe.Pointer(&filter[0])),
	}

	err := unix.Seccomp(unix.SECCOMP_SET_MODE_FILTER, unix.SECCOMP_FILTER_FLAG_TSYNC, unsafe.Pointer(&prog))
	if err == nil {
		t.Fatal("Expected seccomp filter application to fail without PR_SET_NO_NEW_PRIVS, but it succeeded")
	}
}

// Test 3: Context propagation check - pastikan pembatalan context ditangani dengan baik.
func TestSeccomp_ContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	// Langsung membatalkan context
	cancel()

	err := BlockExecve(ctx)
	if err == nil {
		t.Fatal("Expected error due to canceled context, got nil")
	}
	
	if err.Error() != "setup canceled before applying seccomp: context canceled" {
		t.Errorf("Unexpected error message: %v", err)
	}
}
```
