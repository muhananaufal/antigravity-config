# System Programming Linux: Epoll (Non-blocking I/O) di Go

## 1. Konsep dan Internals

`epoll` adalah mekanisme I/O event notification paling efisien di Linux. Berbeda dengan mekanisme usang seperti `select` atau `poll` yang memaksa aplikasi untuk memindai (scan) seluruh *File Descriptor* (FD) setiap saat untuk mencari perubahan (kompleksitas memindai state adalah O(N), yang menyebabkan CPU memuncak pada idle connections skala besar), `epoll` menggunakan arsitektur *event-driven* murni di dalam kernel dengan kompleksitas O(1) berdasarkan antrian (queue) yang di-trigger perangkat keras.

**Struktur Data Kernel (`struct eventpoll`):**
Ketika fungsi syscall `epoll_create1` dipanggil, kernel mengalokasikan `struct eventpoll` yang menyimpan:
1.  **Red-Black Tree (`rbr`):** Digunakan untuk menyimpan seluruh File Descriptor (FD) yang sedang dipantau secara simultan (misalnya socket HTTP listener atau TCP persisten). RB-Tree (berkompleksitas O(log N)) memungkinkan pencarian, penambahan, dan penghapusan FD (melalui `epoll_ctl`) secara efisien, jauh lebih cepat daripada menggunakan struktur linear. Setiap node di dalam pohon ini direpresentasikan oleh tipe data kernel `struct epitem`.
2.  **Ready List (`rdllist`):** Sebuah *doubly linked list* murni yang berisi node referensi ke `epitem` dari FD yang benar-benar memiliki I/O events (misalnya, data sudah tiba di stack protokol jaringan TCP kernel).
3.  **Wait Queue:** Digunakan untuk memblokir dengan mulus thread pemanggil dari Userspace (yang mengeksekusi `epoll_wait`) jika tidak ada satupun event di `rdllist`. Thread ini melepaskan CPU kembali ke OS Scheduler sehingga zero-spin CPU waste.

**Alur Sinyal Hardware ke Wait Queue (Zero-Spin):**
Ketika aliran paket tiba di fisik *Network Interface Card (NIC)*, modul *hardware interrupt (IRQ)* memicu driver jaringan, yang kemudian menyalin dan memasukkan data ke buffer socket. Lalu, *callback* asinkron di dalam kernel space (*wakeup function*) secara efisien O(1) memindahkan (menyambung pointer) `epitem` yang bersangkutan secara instan ke dalam `rdllist` lalu segera membangunkan thread yang tertidur di antrian Wait Queue. Hal ini menjelaskan dominasi `epoll` di sistem komputasi berkinerja tinggi (seperti Nginx, Redis, dan Go Runtime): ia tidak pernah boros memindai perulangan FD yang membisu!

**Runtime Network Poller Go:**
Abstraksi `net` package di Go (seperti `net.Conn`, `Read`, `Write`) terlihat sinkron (*blocking*) di mata *developer*. Namun di balik layar, Go tidak menggunakan *Thread OS* untuk memblokir I/O! Go menggunakan *non-blocking sockets* dan **netpoller**. 
Saat goroutine memanggil `Read()` pada soket yang kosong, *netpoller* (berbasis `epoll` di Linux) mendaftarkan FD soket tersebut, dan Go Scheduler *memarkir* (park) goroutine tersebut, melepaskan OS Thread ke goroutine lain. Ketika paket tiba, `epoll` me-notify *netpoller*, yang akan membangunkan goroutine tersebut kembali. Skema ini mengizinkan 1 juta koneksi TCP berjalan hanya dengan segelintir OS Threads!

**Edge-Triggered (EPOLLET) vs Level-Triggered:**
Go *netpoller* menggunakan mode *Edge-Triggered* secara eksklusif. 
*   **Level-Triggered:** Terus-menerus mengirim notifikasi selama masih ada data di buffer.
*   **Edge-Triggered (ET):** Mengirim notifikasi **HANYA SEKALI** saat *state* berubah (dari kosong ke isi). Jika Anda tidak membaca sampai tuntas (*drain* hingga `EAGAIN`), Anda tidak akan mendapat notifikasi lagi, menyebabkan data menggantung (*stall*).

## 2. Diagram ASCII: Go Network Poller dan Epoll

```text
+-----------------------------------------------------------+
|                  Go Application (User Space)              |
|                                                           |
|  [Goroutine 1]                [Goroutine 2]               |
|  conn.Read()                  conn.Read()                 |
|       | (EAGAIN, blocks)           | (EAGAIN, blocks)     |
|       V                            V                      |
| +-------------------------------------------------------+ |
| |                    Go Scheduler                       | |
| |  (Parks Goroutines, yields OS Thread to others)       | |
| +-------------------------+-----------------------------+ |
|                           |                               |
| +-------------------------V-----------------------------+ |
| |                Runtime Netpoller                      | |
| |  sysmon() loop:                                       | |
| |  - epoll_wait(epfd, events, max_events, timeout)      | |
| +-------------------------+-----------------------------+ |
+---------------------------|-------------------------------+
                            | (Syscall)
                            V
+-----------------------------------------------------------+
|                  Linux Kernel (Kernel Space)              |
|                                                           |
|  [ struct eventpoll instance ]                            |
|   |-- rbr (Red-Black Tree: O(log N))                      |
|   |    \-- struct epitem (FD 3, FD 4, FD 5...)            |
|   |                                                       |
|   |-- rdllist (Ready List - Doubly Linked: O(1))          |
|        \-- struct epitem (FD 4 siap dibaca)               |
|                                                           |
|   <--- NIC Hardware Interrupt triggers wakeup() --->      |
+-----------------------------------------------------------+
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Terlalu Banyak Goroutine untuk Koneksi Idle (The 1M Connection Problem)

Meski model standar `go handle(conn)` sangat idiomatis, jika Anda menangani 1 juta koneksi *WebSocket/TCP* yang sebagian besar *idle* (seperti sistem notifikasi *push*), membuat 1 juta goroutine tetap memakan 2KB *stack memory* per goroutine (total ~2GB memori mati).

```go
// ❌ BAD (Untuk C1000K Idle Connections): 1 Goroutine per Koneksi
for {
    conn, _ := listener.Accept()
    go func() {
        buf := make([]byte, 1024)
        for {
            conn.Read(buf) // Goroutine diblokir di netpoller, memakan 2KB memory
            process(buf)
        }
    }()
}
```
**Why dangerous:** Pemborosan memori (*Memory Bloat*). Untuk arsitektur C10M (10 juta koneksi simultan), memori akan habis bukan karena buffer jaringan, tetapi karena *stack* goroutine yang tidak melakukan apa-apa.

```go
// ✅ GOOD: Raw Epoll via library seperti `gnet` atau `evio`
// Alih-alih membuat goroutine, daftarkan FD socket murni (Syscall FD)
// ke custom epoll loop menggunakan `golang.org/x/sys/unix`.
// Hanya buat/eksekusi worker SAAT ada data masuk.
```

### ❌ Anti-Pattern 2: Tidak Me-*Drain* Socket di Edge-Triggered Epoll Custom

Jika Anda membangun event loop epoll custom via `unix.EpollWait`, kesalahan pemula yang paling fatal adalah menggunakan mode `EPOLLET` namun membaca ukuran data secara statis (misal: 1024 bytes) lalu keluar.

```go
// ❌ BAD: Membaca sebagian pada Edge-Triggered
unix.EpollWait(epfd, events, -1)
for _, ev := range events {
    buf := make([]byte, 1024)
    unix.Read(int(ev.Fd), buf) 
    // Jika data dari OS buffer ukurannya 2000 byte, 
    // sisa 976 byte tidak akan pernah men-trigger event lagi! Stall!
}
```
**Why dangerous:** *Stalled Connections*. Koneksi menjadi bisu secara permanen karena kernel berasumsi Anda sudah tahu masih ada data dan tidak akan mengingatkan Anda lagi sampai ada paket *baru* masuk menimpa status.

```go
// ✅ GOOD: Drain the socket until EAGAIN
for {
    n, err := unix.Read(int(ev.Fd), buf)
    if err != nil {
        if err == unix.EAGAIN || err == unix.EWOULDBLOCK {
            break // Data tuntas! Tunggu event epoll berikutnya.
        }
        // Handle error koneksi terputus
    }
    process(buf[:n])
}
```

## 4. Edge Cases & Defensive Programming

### ❌ Anti-Pattern 3: Menutup Socket Tanpa Menghapusnya dari Epoll (Kernel Memory Leak)
Di Linux, menutup FD (`close()`) secara logis menghapusnya dari epoll secara otomatis *hanya* jika tidak ada referensi file (file struct count == 0). Jika socket pernah di-duplicate via `dup()` atau diturunkan ke child process, referensi masih ada dan FD membocorkan kernel memory.

```go
// ❌ BAD: Menutup FD langsung saat epoll masih berjalan
unix.Close(fd) 
// Memori di dalam kernel (struct epitem) berpotensi bocor selamanya sebagai zombied node!
```

```go
// ✅ GOOD: Disiplin panggil hapus (EPOLL_CTL_DEL) eksplisit sebelum tutup
unix.EpollCtl(epfd, unix.EPOLL_CTL_DEL, fd, nil)
unix.Close(fd)
```

## 4. Edge Cases & Defensive Programming

1.  **File Descriptor Exhaustion (`EMFILE`):**
    Di Linux standar, limit FD (via `ulimit -n`) hanya 1024. Saat *load test*, `Accept()` akan mengembalikan error "too many open files". Jika tidak ditangani, program akan *spin* di tight loop, memakan 100% CPU.
    **Implementasi:** Tambahkan *backoff*:
    ```go
    conn, err := listener.Accept()
    if err != nil {
        if ne, ok := err.(net.Error); ok && ne.Temporary() {
            time.Sleep(10 * time.Millisecond) // Backoff OS agar sembuh
            continue
        }
    }
    ```
2.  **Epoll Wait Interrupted System Call (`EINTR`):**
    Saat memanggil `unix.EpollWait`, fungsi ini memblokir. Jika proses menerima *signal* OS tak terkait, return error `EINTR`.
    **Implementasi:** Abaikan `EINTR` dan panggil kembali `EpollWait`.
    ```go
    n, err := unix.EpollWait(epfd, events, -1)
    if err != nil && err == unix.EINTR {
        continue // Coba lagi secara aman
    }
    ```
3.  **The Thundering Herd Problem:**
    Jika 4 OS Thread memanggil `epoll_wait` pada instance yang sama, 1 paket membangunkan *semua* thread (Thundering herd), walau hanya 1 yang menang, buang resource.
    **Implementasi:** Gunakan flag `EPOLLEXCLUSIVE`.
    ```go
    event := &unix.EpollEvent{
        Events: unix.EPOLLIN | unix.EPOLLEXCLUSIVE,
        Fd:     int32(listenerFd),
    }
    unix.EpollCtl(epfd, unix.EPOLL_CTL_ADD, listenerFd, event)
    ```

## 5. Production-Ready Go Code & Unit Test

Kode di bawah mensimulasikan penggunaan murni API `epoll` Linux dari Go (`golang.org/x/sys/unix`), untuk membuat sebuah event loop sederhana (mirip Nginx/Redis) yang memantau *Pipe*.

```go
package nbio

import (
	"context"
	"fmt"
	"os"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// EpollPoller adalah event-loop epoll tunggal
type EpollPoller struct {
	epfd int
}

func NewEpollPoller() (*EpollPoller, error) {
	// Buat epoll instance (EPOLL_CLOEXEC sangat penting untuk keamanan fork)
	epfd, err := unix.EpollCreate1(unix.EPOLL_CLOEXEC)
	if err != nil {
		return nil, fmt.Errorf("gagal membuat epoll: %w", err)
	}
	return &EpollPoller{epfd: epfd}, nil
}

// Add memantau file descriptor untuk Event READ (Level Triggered by default)
func (p *EpollPoller) Add(fd int) error {
	event := &unix.EpollEvent{
		Events: unix.EPOLLIN, // Hanya pantau kejadian bisa dibaca
		Fd:     int32(fd),
	}
	if err := unix.EpollCtl(p.epfd, unix.EPOLL_CTL_ADD, fd, event); err != nil {
		return fmt.Errorf("epoll_ctl add failed: %w", err)
	}
	return nil
}

// Close membersihkan resource
func (p *EpollPoller) Close() {
	unix.Close(p.epfd)
}

// Wait memblokir hingga event tiba, mendukung Context cancellation
func (p *EpollPoller) Wait(ctx context.Context, timeoutMs int) ([]int32, error) {
	if deadline, ok := ctx.Deadline(); ok {
		remain := time.Until(deadline).Milliseconds()
		if remain < 0 {
			return nil, context.DeadlineExceeded
		}
		if timeoutMs < 0 || int(remain) < timeoutMs {
			timeoutMs = int(remain)
		}
	}

	events := make([]unix.EpollEvent, 10)
	n, err := unix.EpollWait(p.epfd, events, timeoutMs)
	
	if err != nil {
		if err == unix.EINTR {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			default:
				return nil, nil
			}
		}
		return nil, fmt.Errorf("epoll_wait failed: %w", err)
	}

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	var readyFds []int32
	for i := 0; i < n; i++ {
		readyFds = append(readyFds, events[i].Fd)
	}
	
	return readyFds, nil
}

// -------------------------------------------------------------------------
// Unit Test
// -------------------------------------------------------------------------
func TestEpollPipe(t *testing.T) {
	// Buat POSIX Pipe (Komunikasi searah antar thread/proses)
	var pipefds [2]int
	if err := syscall.Pipe(pipefds[:]); err != nil {
		t.Fatalf("Gagal membuat pipe: %v", err)
	}
	readFd := pipefds[0]
	writeFd := pipefds[1]

	defer syscall.Close(readFd)
	defer syscall.Close(writeFd)

	// Inisialisasi Epoll
	poller, err := NewEpollPoller()
	if err != nil {
		t.Fatalf("Gagal inisialisasi epoll: %v", err)
	}
	defer poller.Close()

	// Daftarkan READ sisi pipe ke epoll
	if err := poller.Add(readFd); err != nil {
		t.Fatalf("Gagal add readFd: %v", err)
	}

	// Tes timeout: epoll harus mereturn empty list setelah 100ms
	fds, err := poller.Wait(context.Background(), 100)
	if err != nil {
		t.Fatalf("Wait gagal: %v", err)
	}
	if len(fds) > 0 {
		t.Errorf("Harusnya tidak ada event, karena tidak ada yang menulis")
	}

	// Goroutine menulis ke Pipe
	go func() {
		time.Sleep(50 * time.Millisecond)
		syscall.Write(writeFd, []byte("HELLO EPOLL"))
	}()

	fds, err = poller.Wait(context.Background(), -1)
	if err != nil {
		t.Fatalf("Wait gagal: %v", err)
	}
	if len(fds) != 1 || fds[0] != int32(readFd) {
		t.Fatalf("Expected 1 event for readFd, got %v", fds)
	}

	buf := make([]byte, 100)
	n, err := syscall.Read(readFd, buf)
	if err != nil {
		t.Fatalf("Gagal baca: %v", err)
	}
	if string(buf[:n]) != "HELLO EPOLL" {
		t.Errorf("Salah baca data: %s", string(buf[:n]))
	}
}

func TestEpoll_ContextCancellation(t *testing.T) {
	poller, _ := NewEpollPoller()
	defer poller.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	start := time.Now()
	fds, err := poller.Wait(ctx, 1000)
	
	if err != context.DeadlineExceeded {
		t.Errorf("Expected context.DeadlineExceeded, got error: %v", err)
	}
	if len(fds) != 0 {
		t.Errorf("Expected no fds, got %v", fds)
	}
	if time.Since(start) > 200*time.Millisecond {
		t.Errorf("Wait blocked too long despite context cancellation")
	}
}

func TestEpoll_RootRequired_PrivilegedPort(t *testing.T) {
	if os.Getuid() != 0 {
		t.Skip("Skip test yang butuh akses root (Binding Privileged Port < 1024)")
	}
	
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_STREAM, unix.IPPROTO_TCP)
	if err != nil {
		t.Fatalf("Socket failed: %v", err)
	}
	defer unix.Close(fd)

	addr := &unix.SockaddrInet4{Port: 80} 
	copy(addr.Addr[:], []byte{127, 0, 0, 1})
	
	if err := unix.Bind(fd, addr); err != nil {
		t.Fatalf("Bind to port 80 failed: %v", err)
	}

	poller, _ := NewEpollPoller()
	defer poller.Close()

	if err := poller.Add(fd); err != nil {
		t.Fatalf("Epoll add failed: %v", err)
	}
}
```
