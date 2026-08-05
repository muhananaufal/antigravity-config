# Realtime Networking: TCP Connection Management di Go

> **Berlaku:** Go 1.21+ · `net` · **Lihat juga:** `realtime_networking/websocket_gnet_epoll.md` · `system_programming_linux/syscall_epoll_nonblocking.md` · `microservices_grpc/http_client_production.md` · `hft_zero_alloc/network_io_zero_copy.md`

## 1. Konsep dan Internals

Manajemen koneksi TCP di Go sangat bergantung pada implementasi `net.Conn` dan *runtime network poller*. TCP adalah protokol berbasis aliran (*byte-stream*), berorientasi koneksi (*connection-oriented*), dan andal (*reliable*). Namun, keandalannya dijamin hanya dalam kondisi jaringan normal. Di dunia *realtime* skala besar, *socket* TCP rentan terhadap anomali seperti *Half-Open Connections* (kabel dicabut tanpa mengirim paket FIN), antrean penuh, dan penipisan *File Descriptor*.

Tiga pilar utama manajemen koneksi TCP tingkat produksi di Go:
1.  **Keep-Alive & Deadlines:** Mekanisme absolut untuk membunuh koneksi *zombie*. TCP Keepalive beroperasi di tingkat kernel (mengirim paket probe ACK kosong), sementara *Read/Write Deadlines* beroperasi di tingkat *user-space* aplikasi Go. Keduanya wajib dikombinasikan.
2.  **Backpressure & Buffering:** Di Go, `conn.Write()` bersifat *blocking*. Jika klien (misalnya HP dengan sinyal 3G) men-download data terlalu lambat, *TCP Send Buffer* di kernel host akan penuh, dan goroutine penulis Anda akan terblokir selamanya, menghabiskan memori. Anda wajib memisahkan *goroutine* penulisan dan membaca, dihubungkan dengan *buffered channel*.
3.  **Graceful Shutdown:** Memastikan tidak ada koneksi baru yang diterima `Accept()`, sementara koneksi yang sedang berlangsung (*in-flight*) diberi waktu (misal 5 detik) untuk menyelesaikan transaksinya sebelum ditutup paksa.

## 2. Diagram ASCII: Arsitektur Manajemen TCP Asinkron

```text
                                                [ Timeout Timer ]
                                                        |
+---------------------+                         +-------V-------+
|  Client (Slow 3G)   |    TCP Window Full      | Kernel Buffer |
|  [ TCP Recv Buffer] | <---------------------- | [  100% Full] |
+----------+----------+                         +-------+-------+
           |                                            ^
(Half Open / Ghost conn)                                | (Blocked Write)
           |                                            |
           V                                            |
+-------------------------------------------------------+-------+
|                       Go Application Server                   |
|                                                               |
|  [ Read Goroutine ] <---- (Ping)                      |       |
|    - Update last_seen_time                            |       |
|    - conn.SetReadDeadline(time.Now() + 30s)           |       |
|                                                       |       |
|                                                       |       |
|  [ Business Logic ] ---> (Channel buf: 100) ---> [ Write Goroutine ]
|                                                  - Select/Timeout
|                                                  - conn.Write(msg)
+---------------------------------------------------------------+
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Menulis (Write) Langsung dari Goroutine Handler Utama (Tanpa Timeout)

Mayoritas tutorial Go menunjukkan pemrosesan *echo server* di mana `conn.Write` dipanggil tepat setelah `conn.Read`.

```go
// ❌ BAD: Blocking Write tanpa proteksi
func handleConn(conn net.Conn) {
    defer conn.Close()
    buf := make([]byte, 1024)
    for {
        n, _ := conn.Read(buf)
        // Jika client sengaja tidak membaca dari soketnya, TCP window size akan 0.
        // conn.Write akan block selamanya. Attacker hanya butuh 1000 koneksi
        // untuk menghabiskan 1000 goroutine Anda! (Slowloris attack)
        conn.Write(buf[:n]) 
    }
}
```
**Why dangerous:** Kerentanan terhadap serangan *Slowloris* atau *Resource Exhaustion*. Goroutine akan macet selamanya jika klien lambat, menyebabkan kebocoran memori (Memory Leak) karena *stack* goroutine menumpuk.

```go
// ✅ GOOD: Set Write Deadline sebelum Write
func handleConn(conn net.Conn) {
    defer conn.Close()
    // Pisahkan Read dan Write ke goroutine berbeda dengan channel, ATAU:
    conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
    _, err := conn.Write(data)
    if err != nil {
        return // Drop lambat client!
    }
}
```

### ❌ Anti-Pattern 2: Membiarkan Koneksi Idle Tanpa `ReadDeadline`

TCP Keep-Alive bawaan OS Linux membutuhkan waktu 2 jam (!), 9 probe, dengan jarak 75 detik, sebelum memutus *Half-Open Connection*. Jika Anda tidak menyetel *Read Deadline*, aplikasi akan mempertahankan jutaan FD mati.

```go
// ❌ BAD: Loop Read tanpa perlindungan timeout
for {
    // Jika kabel LAN client dicabut, Read ini akan freeze selamanya
    n, err := conn.Read(buf) 
}
```
**Why dangerous:** Penipisan File Descriptor (FD Leak). Anda akan mencapai limit `ulimit -n` dan server tidak bisa lagi menerima `Accept()` klien baru (Error: `too many open files`).

```go
// ✅ GOOD: Paksakan Read Deadline dinamis pada setiap loop
for {
    // Klien HARUS mengirim data/ping maks tiap 30 detik
    conn.SetReadDeadline(time.Now().Add(30 * time.Second)) 
    n, err := conn.Read(buf)
    if err != nil {
        if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
            log.Println("Client timed out (Ghost connection). Dropping.")
        }
        break // Keluar loop, defer conn.Close() tereksekusi
    }
}
```

## 4. Edge Cases & Defensive Programming

1.  **Nagle's Algorithm vs Realtime (TCP_NODELAY):**
    Secara bawaan, kernel mengaktifkan Nagle's Algorithm untuk TCP (mengumpulkan paket kecil menjadi satu payload besar sebelum dikirim, jeda ~40ms). Untuk game *multiplayer* atau HFT (High Frequency Trading), delay 40ms adalah kiamat. Aplikasi Go mensetel `TCP_NODELAY = true` secara otomatis pada `net.TCPConn`, namun jika Anda mereplika logika TCP Anda via *raw socket* epoll, Anda HARUS menyetel socket option ini via `unix.SetsockoptInt`.
2.  **Graceful Connection Draining:**
    Saat aplikasi Go menerima `SIGTERM`, memanggil `listener.Close()` HANYA menghentikan penerimaan `Accept()`. Goroutine yang sedang menangani klien yang sedang aktif akan dipenggal saat `main()` selesai (*exit*). Untuk mencegah data hilang, gunakan *WaitGroup* untuk memantau semua *active connections*, dan beri waktu 5 detik sebelum benar-benar memanggil `os.Exit`.
3.  **Backpressure dengan Buffered Channels:**
    Di aplikasi Chat/PubSub, saat *broadcaster* mencoba mengirim pesan ke 10.000 koneksi, jangan gunakan loop langsung. Gunakan `chan []byte` (dengan buffer, misal 100) per koneksi klien. Jika channel klien penuh (`default:` di `select`), putus klien tersebut karena dia terlalu lambat membaca dan akan membebani server secara keseluruhan.

## 5. Production-Ready Go Code & Unit Test

Kode berikut menunjukkan pola **Reader/Writer Terpisah (Decoupled)** dengan manajemen *backpressure*, *deadline*, dan *shutdown*.

```go
package tcpman

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// Session mewakili koneksi klien yang aman dari thread-block
type Session struct {
	conn      net.Conn
	sendChan  chan string // Buffered channel untuk backpressure
	closeOnce sync.Once
}

func NewSession(conn net.Conn) *Session {
	return &Session{
		conn:     conn,
		// Buffer 50 pesan. Jika lebih dari ini dan belum dikirim, client drop.
		sendChan: make(chan string, 50),
	}
}

// SendMessage meletakkan pesan di antrian. Non-blocking.
func (s *Session) SendMessage(msg string) error {
	select {
	case s.sendChan <- msg:
		return nil
	default:
		// BACKPRESSURE: Buffer penuh (Klien sangat lambat!)
		s.Close()
		return fmt.Errorf("client buffer full, dropping connection")
	}
}

// Close menutup channel dan socket dengan aman (Idempotent)
func (s *Session) Close() {
	s.closeOnce.Do(func() {
		close(s.sendChan)
		s.conn.Close()
	})
}

// Start memulai goroutine Read dan Write yang terisolasi
func (s *Session) Start(ctx context.Context, wg *sync.WaitGroup, onMessage func(string)) {
	wg.Add(2) // 1 untuk reader, 1 untuk writer

	// Writer Goroutine
	go func() {
		defer wg.Done()
		for {
			select {
			case <-ctx.Done(): // Server dimatikan (Graceful Shutdown)
				s.Close()
				return
			case msg, ok := <-s.sendChan:
				if !ok {
					return // Channel ditutup
				}
				// Cegah blokade OS Write jika klien gantung
				s.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
				if _, err := s.conn.Write([]byte(msg + "\n")); err != nil {
					s.Close()
					return
				}
			}
		}
	}()

	// Reader Goroutine
	go func() {
		defer wg.Done()
		defer s.Close() // Jika read putus, paksa matikan writer juga
		
		scanner := bufio.NewScanner(s.conn)
		for {
			// Cegah Ghost Connection: Harus ada Ping/Data tiap 10 detik
			s.conn.SetReadDeadline(time.Now().Add(10 * time.Second))
			
			if !scanner.Scan() {
				// EOF atau Timeout tercapai
				return 
			}
			text := strings.TrimSpace(scanner.Text())
			if text != "" {
				onMessage(text)
			}
		}
	}()
}

// -------------------------------------------------------------------------
// Unit Test
// -------------------------------------------------------------------------
func TestTCPConnectionManager(t *testing.T) {
	// 1. Setup Server Dummy
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Gagal inisialisasi server: %v", err)
	}
	defer listener.Close()

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup

	msgReceived := make(chan string, 1)

	// Terima 1 koneksi di background
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		
		sess := NewSession(conn)
		sess.Start(ctx, &wg, func(msg string) {
			msgReceived <- msg
			// Echo kembali (menguji writer)
			sess.SendMessage("ACK: " + msg)
		})
	}()

	// 2. Client Setup
	clientConn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatalf("Client gagal koneksi: %v", err)
	}
	defer clientConn.Close()

	// 3. Test Read/Write Flow
	clientConn.Write([]byte("HELLO WORLD\n"))

	reader := bufio.NewReader(clientConn)
	clientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	resp, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("Client gagal baca dari server: %v", err)
	}

	if strings.TrimSpace(resp) != "ACK: HELLO WORLD" {
		t.Errorf("Respon tidak sesuai, didapat: %s", resp)
	}

	// 4. Test Graceful Shutdown
	cancel() // Membatalkan context, memerintahkan writer untuk close socket
	wg.Wait() // Pastikan semua goroutine di Session sudah bersih (Tidak ada memory leak)
	
	// Pembuktian connection ditutup:
	clientConn.SetReadDeadline(time.Now().Add(1 * time.Second))
	_, err = reader.ReadString('\n')
	if err == nil {
		t.Errorf("Harusnya mendapat error EOF (Koneksi ditutup), namun sukses")
	}
}
```

## Kapan JANGAN Pakai Ini

- **Koneksi berumur panjang tanpa keepalive.** NAT, firewall, dan load balancer memutus koneksi yang diam tanpa memberi tahu kedua belah pihak. Aplikasi baru menyadarinya saat mencoba mengirim — sering beberapa menit setelah datanya seharusnya terkirim.
- **Mengabaikan `SetDeadline`.** Koneksi yang menggantung menahan goroutine dan file descriptor tanpa batas. Ini bentuk kebocoran yang paling sering ditemukan pada layanan jaringan Go.
- **Membiarkan Nagle dan delayed ACK berinteraksi tanpa disadari.** Pada protokol permintaan-respons berukuran kecil, kombinasi keduanya bisa menambahkan puluhan milidetik yang tidak terjelaskan. `SetNoDelay(true)` untuk jalur latensi rendah.
- **Buffer besar untuk semua koneksi.** Memori dikalikan jumlah koneksi. Pada sepuluh ribu koneksi, buffer 64 KB masing-masing arah sudah lebih dari satu gigabyte.
- **Mengasumsikan `Write` mengirimkan seluruh buffer.** Ia bisa parsial. Kode yang tidak memeriksa jumlah byte tertulis akan kehilangan data secara acak di bawah beban.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Koneksi mati tidak terdeteksi | keepalive dan read deadline | Tidak ada mekanisme deteksi |
| Goroutine menumpuk pada operasi jaringan | deadline pada koneksi | Koneksi menggantung selamanya |
| Latensi tambahan ~40 ms yang tidak dijelaskan | Nagle + delayed ACK | `SetNoDelay` belum dipasang |
| Memori naik sebanding jumlah koneksi | ukuran buffer per koneksi | Buffer terlalu besar |
| Data terpotong di bawah beban | penanganan `Write` parsial | Jumlah byte tertulis tidak diperiksa |

```bash
# Koneksi dan antrean kirim/terima -- Send-Q yang menumpuk berarti penerima lambat
ss -tin state established | head -20
ss -tan | awk '{print $1}' | sort | uniq -c

# Goroutine yang menggantung di jaringan
curl -s 'localhost:6060/debug/pprof/goroutine?debug=1' | grep -B2 -A3 'net\.' | head -20

# Setelan keepalive kernel (aplikasi tetap harus menyetelnya sendiri)
sysctl net.ipv4.tcp_keepalive_time net.ipv4.tcp_keepalive_intvl net.ipv4.tcp_keepalive_probes
```
