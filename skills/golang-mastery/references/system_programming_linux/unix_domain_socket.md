# System Programming Linux: Unix Domain Sockets di Go

## 1. Konsep dan Internals

Unix Domain Sockets (UDS) adalah mekanisme Inter-Process Communication (IPC) standar POSIX yang memungkinkan proses-proses di dalam satu sistem operasi (host yang sama) untuk saling berkomunikasi. Secara konseptual, UDS beroperasi layaknya *network sockets* (TCP/UDP), namun melewati keseluruhan lapisan protokol jaringan (network stack) seperti IP routing, TCP checksum, dan packet header serialization. Hal ini membuat UDS jauh lebih efisien, memiliki latensi lebih rendah, dan *throughput* lebih tinggi dibandingkan menggunakan koneksi `localhost` (127.0.0.1).

Terdapat dua tipe utama UDS:
1.  **`SOCK_STREAM` (Stream Oriented):** Beroperasi seperti TCP. Menjamin data terkirim sesuai urutan (*in-order*) dan *reliable*. Data dibaca sebagai *continuous byte stream* tanpa batasan pesan (*message boundaries*).
2.  **`SOCK_DGRAM` (Datagram Oriented):** Beroperasi seperti UDP, namun *reliable* (karena berjalan di memori kernel, paket tidak akan hilang kecuali buffer penuh) dan pesannya mempertahankan *boundaries*.

**Keunggulan Utama UDS dibanding TCP Loopback:**
*   **Performa:** Bypass TCP/IP stack berarti mengurangi overhead *context switch* dan manipulasi buffer jaringan.
*   **Keamanan Terpadu (File Permissions):** Karena *file-backed* UDS direpresentasikan sebagai sebuah *inode* di *virtual filesystem* (VFS) Linux, kontrol akses dapat menggunakan sistem *permission* POSIX standar (chmod/chown).
*   **Ancillary Data (Control Messages):** Ini adalah fitur pembunuh (*killer feature*) dari UDS. Memungkinkan proses mentransfer *File Descriptors* (`SCM_RIGHTS`) dan kredensial proses (UID/GID/PID) via `SO_PASSCRED` antar proses tanpa perlu *shared memory*.

## 2. Diagram ASCII: Arsitektur Unix Domain Sockets IPC

```text
                             +-----------------------------------+
                             |          Kernel Space             |
+-------------------+        |                                   |        +-------------------+
| Process A (UID 1) |        |   +---------------------------+   |        | Process B (UID 0) |
| Client / Sender   |        |   |   VFS Inode (Socket)      |   |        | Server / Receiver |
+-------------------+        |   |   /var/run/docker.sock    |   |        +-------------------+
| fd = Dial("unix") |--------|-->|   Perm: 0660 (root:root)  |---|------->| Listen("unix")    |
| Write([]byte)     |        |   |                           |   |        | Accept()          |
+-------------------+        |   +---------------------------+   |        | Read([]byte)      |
                             |                 |                 |        +-------------------+
                             |     [ Direct Buffer Copy ]        |
                             |     (No TCP/IP Packetization)     |
                             +-----------------------------------+
                                         |      ^
       Ancillary Data (Out-of-Band)      |      |
       - SCM_RIGHTS (File Descriptors)---+      |
       - SO_PASSCRED (Process Credentials)------+
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Lupa Menghapus File Socket Lama (Stale Socket)

Pada UDS berbasis file, memanggil `Listen` akan membuat sebuah file di *filesystem*. Jika aplikasi *crash* atau tidak dimatikan dengan benar (*graceful shutdown*), file tersebut akan tertinggal (*stale*). Saat aplikasi dijalankan kembali, `Listen` akan gagal karena file sudah ada.

```go
// ❌ BAD: Mengabaikan sisa file dari proses sebelumnya
listener, err := net.Listen("unix", "/tmp/app.sock")
if err != nil {
    // Akan error "bind: address already in use" jika file masih ada
    log.Fatal(err) 
}
```
**Why dangerous:** Aplikasi tidak bisa *restart* secara mandiri setelah mengalami *crash*. Di lingkungan terkelola (seperti *systemd*), service akan terjebak dalam *crash loop* permanen hingga admin menghapus file secara manual.

```go
// ✅ GOOD: Menghapus file sebelum bind (bersifat idempotent)
socketPath := "/tmp/app.sock"
if err := os.Remove(socketPath); err != nil && !os.IsNotExist(err) {
    log.Fatalf("gagal menghapus stale socket: %v", err)
}

listener, err := net.Listen("unix", socketPath)
if err != nil {
    log.Fatalf("gagal mendengarkan di socket: %v", err)
}
// Pastikan permission aman
os.Chmod(socketPath, 0600)
```

### ❌ Anti-Pattern 2: Tidak Mengubah File Permission Setelah Listen

Fungsi `net.Listen("unix", path)` secara *default* akan membuat file socket mengikuti pengaturan `umask` dari proses yang berjalan (biasanya `0755` atau `0644`). Ini sangat berbahaya karena bisa membiarkan user lain di sistem berinteraksi dengan IPC internal kita.

```go
// ❌ BAD: Membuka socket untuk umum (bisa diakses user manapun)
listener, err := net.Listen("unix", "/tmp/admin.sock")
if err != nil {
    log.Fatal(err)
}
// Lanjut accept koneksi...
```
**Why dangerous:** Kerentanan eskalasi hak istimewa (*Privilege Escalation*). Jika service berjalan sebagai `root` dan mendengarkan instruksi lewat UDS, maka user *non-privileged* (seperti `www-data`) dapat mengirim instruksi *malicious* melalui socket tersebut jika *permission*-nya terlalu longgar.

```go
// ✅ GOOD: Mengamankan file socket segera setelah Listen
listener, err := net.Listen("unix", "/tmp/admin.sock")
if err != nil {
    log.Fatal(err)
}

// Hanya owner (user yang menjalankan service) yang bisa read/write
if err := os.Chmod("/tmp/admin.sock", 0600); err != nil {
    listener.Close()
    log.Fatalf("gagal mengunci permission socket: %v", err)
}
```

## 4. Edge Cases & Defensive Programming

1.  **Abstract Namespace Sockets (Linux Specific):**
    Linux mendukung UDS yang tidak terikat pada *filesystem*. Nama socket diawali dengan *null byte* (`\x00`), misalnya `\x00my_hidden_socket`. Keuntungannya: socket otomatis bersih ketika proses mati, tidak butuh `os.Remove`, dan *namespace* aman dari manipulasi direktori (`/tmp` dir *hijacking*). Namun, *Abstract Sockets* tidak mematuhi *file permissions* POSIX, sehingga satu-satunya cara otentikasi adalah via `SO_PASSCRED`.
    
2.  **Buffer Truncation pada `SCM_RIGHTS` (File Descriptor Passing):**
    Mengirim *File Descriptor* harus melalui *Control Message* (out-of-band data) menggunakan fungsi level rendah seperti `syscall.Sendmsg`. Jika ukuran *buffer control* di sisi penerima lebih kecil dari ukuran data yang dikirim, kernel akan membuang (truncate) sisa data termasuk *File Descriptor* yang sedang ditransfer, menyebabkan *resource leak* sunyi di dalam kernel. Gunakan selalu `syscall.CmsgSpace()` untuk menghitung ukuran alokasi *buffer* penerima dengan aman.
    
3.  **Kelelahan Backlog (Socket Listen Queue Exaustion):**
    Sama halnya dengan TCP, UDS bertipe `SOCK_STREAM` memiliki antrian koneksi masuk (*backlog*). Jika koneksi masuk lebih cepat dari kecepatan `Accept()` goroutine, koneksi akan ditolak (*Connection Refused*). UDS sering memberikan rasa aman palsu karena sangat cepat, namun memproses beban kerja berat di dalam `Accept()` *loop* tanpa *goroutine* per-koneksi akan menyebabkan antrian ini penuh dalam hitungan milidetik.

## 5. Production-Ready Go Code & Unit Test

Kode berikut menunjukkan implementasi Server dan Client UDS yang aman, dengan penanganan eksekusi asinkron (*context-aware*) dan *cleanup* yang *robust*.

```go
package ipc

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"testing"
	"time"
)

// UDSServer merepresentasikan server Unix Domain Socket.
type UDSServer struct {
	path     string
	listener net.Listener
	wg       sync.WaitGroup
}

// NewUDSServer menginisialisasi UDS Server.
func NewUDSServer(path string) *UDSServer {
	return &UDSServer{path: path}
}

// Start menghapus socket lama, memulai listener, dan menjalankan loop Accept.
// Loop akan berhenti ketika context di-cancel.
func (s *UDSServer) Start(ctx context.Context, handler func(context.Context, net.Conn)) error {
	// Menghindari bind: address already in use
	if err := os.Remove(s.path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to clean stale socket %s: %w", s.path, err)
	}

	var err error
	s.listener, err = net.Listen("unix", s.path)
	if err != nil {
		return fmt.Errorf("failed to listen on uds: %w", err)
	}

	// Terapkan keamanan ketat: Hanya user yang sama yang boleh akses
	if err := os.Chmod(s.path, 0600); err != nil {
		s.listener.Close()
		return fmt.Errorf("failed to chmod socket file: %w", err)
	}

	// Goroutine untuk memonitor context cancellation
	go func() {
		<-ctx.Done()
		s.listener.Close() // Memaksa Accept() return error dan berhenti
	}()

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			conn, err := s.listener.Accept()
			if err != nil {
				// Cek apakah listener ditutup secara sengaja oleh context
				if errors.Is(err, net.ErrClosed) {
					return
				}
				// Log error non-fatal, lalu lanjut
				fmt.Printf("accept error: %v\n", err)
				return // Asumsi error fatal untuk loop ini
			}

			s.wg.Add(1)
			go func(c net.Conn) {
				defer s.wg.Done()
				defer c.Close()
				handler(ctx, c)
			}(conn)
		}
	}()

	return nil
}

// Stop menunggu semua handler selesai memproses sisa koneksi.
func (s *UDSServer) Stop() {
	if s.listener != nil {
		s.listener.Close()
	}
	s.wg.Wait()
}

// -------------------------------------------------------------------------
// Unit Test Section
// -------------------------------------------------------------------------

func TestUnixDomainSocketCommunication(t *testing.T) {
	// Gunakan TempDir agar file terisolasi dan otomatis bersih
	tmpDir := t.TempDir()
	socketPath := tmpDir + "/test_daemon.sock"

	server := NewUDSServer(socketPath)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Handler yang me-reverse string dan echo
	handler := func(hCtx context.Context, conn net.Conn) {
		buf := make([]byte, 1024)
		
		// Set read timeout defensif
		conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		n, err := conn.Read(buf)
		if err != nil && !errors.Is(err, io.EOF) {
			return
		}

		msg := string(buf[:n])
		resp := fmt.Sprintf("ACK: %s", msg)
		
		conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		_, _ = conn.Write([]byte(resp))
	}

	if err := server.Start(ctx, handler); err != nil {
		t.Fatalf("Failed to start server: %v", err)
	}
	defer server.Stop()

	// Client Dialing
	client, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatalf("Failed to dial server: %v", err)
	}
	defer client.Close()

	// Pastikan permission file benar
	info, err := os.Stat(socketPath)
	if err != nil {
		t.Fatalf("Failed to stat socket file: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Errorf("Expected permission 0600, got %v", info.Mode().Perm())
	}

	// Test Payload
	payload := "HELLO_UDS"
	_, err = client.Write([]byte(payload))
	if err != nil {
		t.Fatalf("Failed to write to socket: %v", err)
	}

	respBuf := make([]byte, 1024)
	client.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err := client.Read(respBuf)
	if err != nil {
		t.Fatalf("Failed to read from socket: %v", err)
	}

	expected := "ACK: HELLO_UDS"
	actual := string(respBuf[:n])
	if actual != expected {
		t.Errorf("Expected '%s', got '%s'", expected, actual)
	}
}
```
