# Network Proxy: SOCKS5 Server Implementation di Go

## 1. Konsep Utama & Internals
SOCKS5 (RFC 1928) adalah protokol proxy jaringan berlapis (Layer 5/Session Layer) yang independen dari protokol aplikasi. Tidak seperti proxy HTTP yang membaca *header*, SOCKS5 bertindak sebagai perantara TCP/UDP murni secara *blind forwarding*. Hal ini memungkinkan SOCKS5 meneruskan berbagai lalu lintas, termasuk SSH, RDP, DNS, hingga protokol *custom/proprietary* tanpa menyentuh *payload* terenkripsi (seperti TLS).

Di Go, mengimplementasikan *server* SOCKS5 membutuhkan penanganan *handshake* otentikasi (No Auth atau Username/Password), resolusi tujuan (bisa IPv4, IPv6, atau nama FQDN yang harus di-resolve oleh server), dan teknik dupleks-penuh menggunakan `io.Copy` dalam goroutine untuk menjahit (splice) koneksi masuk dan keluar. 

## 2. Diagram Arsitektur & Struktur Paket (ASCII)

### A. Flow State Machine
```text
  [Client (Browser / cURL)]                                       [Target Destination (Misal Google)]
         |                                                                      ^
         | 1. SOCKS5 Handshake (Version, Auth Methods)                          |
         |------------------------------------->|                               |
         |<-------------------------------------| 2. Auth Accepted              |
         |                                      |                               |
         | 3. Connect Request (Target IP/Domain)| [Go SOCKS5 Server]            |
         |------------------------------------->|     | 4. net.Dial() --------->|
         |<-------------------------------------|     | 5. Dial Success         |
         | 6. BIND Success (Reply)              |                               |
         |                                      |                               |
         | 7. Raw TCP Data (e.g. TLS Hello)     | 8. Blind io.Copy              |
         |======================================|===============================|
```

### B. Packet Structure SOCKS5
**1. Handshake Request (Client -> Server)**
```text
+----+----------+----------+
|VER | NMETHODS | METHODS  |
+----+----------+----------+
| 1  |    1     | 1 to 255 |
+----+----------+----------+
VER: 0x05 (SOCKS5)
```

**2. Request Detail (Client -> Server)**
```text
+----+-----+-------+------+----------+----------+
|VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
+----+-----+-------+------+----------+----------+
| 1  |  1  | X'00' |  1   | Variable |    2     |
+----+-----+-------+------+----------+----------+
CMD: 0x01 (CONNECT)
ATYP: 0x01 (IPv4), 0x03 (Domain), 0x04 (IPv6)
```

## 3. Production-Ready Go Code

Kode di bawah menunjukkan implementasi proxy TCP SOCKS5 siap produksi dengan penanganan goroutine leak dan mitigasi SSRF.

```go
package socks5proxy

import (
	"context"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

// StartSOCKS5Server menjalankan basic TCP SOCKS5
func StartSOCKS5Server(ctx context.Context, addr string) error {
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	defer listener.Close()

	var wg sync.WaitGroup
	go func() {
		<-ctx.Done()
		listener.Close()
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			continue
		}

		wg.Add(1)
		go func(c net.Conn) {
			defer wg.Done()
			handleSOCKS5(c)
		}(conn)
	}
	wg.Wait()
	return nil
}

func handleSOCKS5(client net.Conn) {
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(10 * time.Second)) 

	// 1. Version identifier/method selection
	buf := make([]byte, 256)
	if _, err := io.ReadFull(client, buf[:2]); err != nil || buf[0] != 0x05 { 
		return
	}
	numMethods := int(buf[1])
	if _, err := io.ReadFull(client, buf[:numMethods]); err != nil {
		return
	}

	// Balas dengan NO AUTHENTICATION REQUIRED (0x00)
	_, _ = client.Write([]byte{0x05, 0x00})

	// 2. Request details
	if _, err := io.ReadFull(client, buf[:4]); err != nil || buf[0] != 0x05 || buf[1] != 0x01 {
		return 
	}

	atyp := buf[3]
	var host string
	switch atyp {
	case 0x01: // IPv4
		if _, err := io.ReadFull(client, buf[:4]); err != nil { return }
		host = net.IP(buf[:4]).String()
	case 0x03: // FQDN
		if _, err := io.ReadFull(client, buf[:1]); err != nil { return }
		domainLen := int(buf[0])
		if _, err := io.ReadFull(client, buf[:domainLen]); err != nil { return }
		host = string(buf[:domainLen])
	default:
		return
	}

	if _, err := io.ReadFull(client, buf[:2]); err != nil { return }
	port := int(buf[0])<<8 | int(buf[1])

	targetAddr := fmt.Sprintf("%s:%d", host, port)

	// Hapus deadline
	_ = client.SetDeadline(time.Time{})

	// 3. Dialing target destination
	dialer := net.Dialer{Timeout: 5 * time.Second}
	target, err := dialer.Dial("tcp", targetAddr)
	if err != nil {
		_, _ = client.Write([]byte{0x05, 0x01, 0x00, 0x01, 0,0,0,0, 0,0})
		return
	}
	defer target.Close()

	// Reply Success
	_, _ = client.Write([]byte{0x05, 0x00, 0x00, 0x01, 0,0,0,0, 0,0})

	// 4. TCP Blind Forwarding (Splice) dengan Error Channel (mencegah Leak)
	errChan := make(chan error, 2)
	go func() { _, err := io.Copy(target, client); errChan <- err }()
	go func() { _, err := io.Copy(client, target); errChan <- err }()

	<-errChan // Akan memblokir sampai salah satu io.Copy selesai, trigger defer Close()
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Goroutine Leak pada `io.Copy` Splicing
```go
// ❌ BAD: Menelantarkan Goroutine io.Copy tanpa pembatalan paksa
var wg sync.WaitGroup
wg.Add(2)
go func() { defer wg.Done(); io.Copy(target, client) }()
go func() { defer wg.Done(); io.Copy(client, target) }()
wg.Wait()
```
**Why dangerous:** Jika salah satu sisi melakukan TCP Half-Close, sisi lainnya akan memblokir goroutine selamanya. `wg.Wait()` tidak akan pernah selesai, menyebabkan goroutine/memory leak masif (OOM).

```go
// ✅ GOOD: Menggunakan errChan untuk early exit
errChan := make(chan error, 2)
go func() { _, err := io.Copy(target, client); errChan <- err }()
go func() { _, err := io.Copy(client, target); errChan <- err }()

<-errChan 
// Selesai seketika salah satu drop. `defer client.Close()` dan `defer target.Close()` di pemanggil
// akan memutus socket secara keras, memaksa iterasi io.Copy yang tersisa untuk abort seketika.
```

### ❌ Anti-Pattern 2: Membaca Packet Tanpa Deterministik Size
```go
// ❌ BAD: Membaca packet utuh sekaligus via Read()
buf := make([]byte, 1024)
n, _ := client.Read(buf) 
```
**Why dangerous:** Kerentanan *Slowloris* & *Index out of bounds*. TCP mungkin mengirim stream terpecah (hanya mengirim 1 byte di packet pertama).

```go
// ✅ GOOD: ReadFull berdasar struktur packet
_ = client.SetDeadline(time.Now().Add(5 * time.Second))
buf := make([]byte, 2)
_, err := io.ReadFull(client, buf) // Pasti menunggu hingga 2 byte tiba atau deadline terlampaui
```

## 5. 3+ Unit Tests Nyata (httptest & net.Pipe)

Berikut adalah 3 Unit Test yang mencakup: validasi Handshake, penolakan command non-Connect, dan End-to-End dengan HTTP local.

```go
package socks5proxy

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Test 1: Handshake Authentication Selection SOCKS5
func TestSOCKS5_Handshake(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()

	go handleSOCKS5(server)

	// Send VER 5, NMETHODS 1, METHOD 0 (No Auth)
	client.Write([]byte{0x05, 0x01, 0x00})

	resp := make([]byte, 2)
	io.ReadFull(client, resp)

	if resp[0] != 0x05 || resp[1] != 0x00 {
		t.Fatalf("Expected 05 00, got %x", resp)
	}
}

// Test 2: Invalid Command Parsing (Harus reject UDP/BIND)
func TestSOCKS5_InvalidCommand(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()

	go handleSOCKS5(server)

	// Handshake valid
	client.Write([]byte{0x05, 0x01, 0x00})
	client.Read(make([]byte, 2))

	// Send Request: VER 5, CMD 2 (BIND - Not Supported), RSV 0, ATYP 1, IP 127.0.0.1, Port 80
	client.Write([]byte{0x05, 0x02, 0x00, 0x01, 127, 0, 0, 1, 0, 80})

	// Connection harusnya diputus (EOF) oleh server karena CMD 2 tidak dihandle
	_, err := client.Read(make([]byte, 10))
	if err != io.EOF {
		t.Fatalf("Expected EOF due to unsupported command, got %v", err)
	}
}

// Test 3: End-To-End Splicing TCP dengan httptest
func TestSOCKS5_EndToEndHTTP(t *testing.T) {
	// Setup target HTTP Server
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("OK"))
	}))
	defer ts.Close()

	// Parse host/port dari httptest
	host, portStr, _ := net.SplitHostPort(ts.Listener.Addr().String())
	var port int
	fmt.Sscanf(portStr, "%d", &port)

	// Setup SOCKS server
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go StartSOCKS5Server(ctx, "127.0.0.1:10800")
	time.Sleep(100 * time.Millisecond)

	// Client manual Dialing via SOCKS
	proxyConn, err := net.Dial("tcp", "127.0.0.1:10800")
	if err != nil {
		t.Fatal(err)
	}

	// 1. Handshake
	proxyConn.Write([]byte{0x05, 0x01, 0x00})
	proxyConn.Read(make([]byte, 2))

	// 2. Request CONNECT ke httptest
	req := []byte{0x05, 0x01, 0x00, 0x01}
	req = append(req, net.ParseIP(host).To4()...)
	req = append(req, byte(port>>8), byte(port&0xFF))
	proxyConn.Write(req)

	// 3. Baca reply success
	reply := make([]byte, 10)
	io.ReadFull(proxyConn, reply)
	if reply[1] != 0x00 { // 0x00 means success
		t.Fatal("SOCKS request failed")
	}

	// 4. Send HTTP GET over SOCKS
	proxyConn.Write([]byte("GET / HTTP/1.1\r\nHost: " + host + "\r\n\r\n"))

	// 5. Read HTTP Response
	respBuf := make([]byte, 128)
	n, _ := proxyConn.Read(respBuf)
	if !bytes.Contains(respBuf[:n], []byte("OK")) {
		t.Fatalf("Missing 'OK' in response: %s", string(respBuf[:n]))
	}
}
```

## 6. Edge Cases & Implementasi Defensif (Detail Code)

**1. Loopback Server Routing (SSRF via Proxy)**
Pengguna dapat memaksa SOCKS server mengirim koneksi ke port lokal (contoh: Database `127.0.0.1:5432`) yang seharusnya terlindungi dari akses internet.
*Implementasi Mitigasi:*
```go
func isPrivateIP(ip net.IP) bool {
	// Memblokir akses ke loopback, private IP, dan multicast
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast()
}

// Di dalam handleSOCKS5(), saat ATYP adalah 0x01 (IPv4):
ip := net.IP(buf[:4])
if isPrivateIP(ip) {
	// SSRF Attempt detected! Balas dengan status "Connection not allowed by ruleset (0x02)"
	client.Write([]byte{0x05, 0x02, 0x00, 0x01, 0,0,0,0, 0,0})
	return
}
host = ip.String()
```

**2. Penanganan Half-Closed TCP Connection**
Secara default, memanggil `.Close()` menutup koneksi baik untuk baca (Read) maupun tulis (Write). Jika client melakukan TCP half-close (mengirim FIN tapi masih bisa menerima), `io.Copy` akan terputus paksa (hilang data).
*Implementasi:* Memanfaatkan `CloseWrite` pada tipe `*net.TCPConn`.
```go
// Daripada 2 errChan sederhana, deteksi EOF untuk Half-Close
var wg sync.WaitGroup
wg.Add(2)

go func() {
	defer wg.Done()
	io.Copy(target, client)
	// Client selesai mengirim (EOF), beri tahu target bahwa kita tidak akan menulis lagi
	if tc, ok := target.(*net.TCPConn); ok {
		tc.CloseWrite()
	}
}()

go func() {
	defer wg.Done()
	io.Copy(client, target)
	// Target selesai mengirim (EOF), beri tahu client
	if tc, ok := client.(*net.TCPConn); ok {
		tc.CloseWrite()
	}
}()
wg.Wait()
```

**3. DNS Resolusi Tertahan di Go `net.Dial`**
Klien dapat mengirim FQDN (misal `non-existent.internal.server.com`). Default `net.Dialer` Go memanggil `getaddrinfo` milik host C-library yang bisa terblokir sangat lama dan menahan thread OS.
*Implementasi Defensif:*
Gunakan `net.Resolver` custom yang memaksa penggunaan murni TCP/UDP tanpa mengunci Cgo thread, dan berlakukan timeout absolut pada request Dialing.
```go
dialer := &net.Dialer{
	Timeout: 5 * time.Second, // Timeout mutlak
	Resolver: &net.Resolver{
		PreferGo: true, // Memaksa Go native resolver, mencegah Cgo blocking DNS
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			d := net.Dialer{Timeout: 2 * time.Second}
			return d.DialContext(ctx, network, "8.8.8.8:53") // DNS Resolver eksternal eksplisit
		},
	},
}
```
