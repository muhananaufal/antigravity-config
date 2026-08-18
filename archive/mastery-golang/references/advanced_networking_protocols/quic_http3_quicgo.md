# QUIC & HTTP/3 via quic-go

> **Berlaku:** Go 1.21+ · `quic-go` · HTTP/3 · **Lihat juga:** `realtime_networking/tcp_connection_management.md` · `microservices_grpc/http_client_production.md` · `advanced_networking_protocols/dns_resolution_patterns.md` · `microservices_grpc/service_mesh_grpc_lb.md`

## 1. Konsep Utama & Internals
QUIC (Quick UDP Internet Connections) adalah protokol transport layer berbasis UDP yang dirancang untuk mengatasi limitasi TCP, terutama *Head-of-Line (HoL) Blocking*. Berbeda dengan TCP, QUIC mengintegrasikan TLS 1.3 langsung pada level transport, mengurangi handshake dari 3-RTT menjadi 1-RTT atau bahkan 0-RTT (pada koneksi yang dilanjutkan/resumed). 

`quic-go` merupakan implementasi native Go dari QUIC yang memfasilitasi multiplexing stream independen; satu stream yang loss/drop tidak akan memblokir stream lainnya. Dalam HTTP/3, protokol ini menggunakan QUIC sebagai pondasinya. 

**Internals & OS Tuning:**
Tuning socket UDP seperti `SO_RCVBUF` sangat penting di level OS untuk menghindari packet loss pada burst traffic tinggi karena buffer default kernel (terutama di Linux, sekitar 212KB) seringkali terlalu kecil untuk QUIC. QUIC mengelola congestion control sendiri di userspace, tetapi kernel OS harus mampu menampung ledakan paket UDP sebelum userspace Go (`quic-go`) sempat membacanya.

## 2. Diagram Arsitektur / Aliran (ASCII)

```text
      [Client]                                     [Server]
         |       1-RTT Handshake (TLS 1.3 baked in)   |
         |------------------------------------------->|
         |<-------------------------------------------|
         |                                            |
         |=== Stream 1 (HTTP/3 Req A) ===============>| (No HoL Blocking)
         |=== Stream 2 (HTTP/3 Req B) ===============>| 
         |                                            |
  (Pkt Drop on Stream 1)                              |
         |--X (Loss)                                  | 
         |=== Stream 2 (HTTP/3 Req B) ===============>| (Stream 2 continues fine)
         |                                            |
         |=== Stream 1 (Retransmit) =================>|

### Struktur Packet & Flow Control QUIC (ASCII)
```text
+------------------+-----------------+-----------------+-----------------+
| Header Form (1b) | Version (32b)   | Dest Conn ID    | Src Conn ID     |
+------------------+-----------------+-----------------+-----------------+
| Packet Number    | Payload (Frames: STREAM, ACK, PING, CLOSE...)       |
+------------------+-----------------+-----------------+-----------------+
```
```

## 3. Production-Ready Go Code

```go
package quicnet

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
)

// Config encapsulates server configuration.
type Config struct {
	Addr    string
	Timeout time.Duration
}

// StartH3Server starts an HTTP/3 server with QUIC.
func StartH3Server(ctx context.Context, cfg Config, handler http.Handler) (*http3.Server, error) {
	tlsConf, err := generateTLSConfig() // TLS 1.3 is mandatory for QUIC
	if err != nil {
		return nil, fmt.Errorf("failed to generate TLS config: %w", err)
	}

	server := &http3.Server{
		Addr:      cfg.Addr,
		TLSConfig: tlsConf,
		Handler:   handler,
		QuicConfig: &quic.Config{
			MaxIdleTimeout:  cfg.Timeout,
			KeepAlivePeriod: 10 * time.Second,
		},
	}

	// Use context to handle graceful shutdown
	go func() {
		<-ctx.Done()
		_ = server.Close()
	}()

	go func() {
		// ListenAndServe uses UDP under the hood
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			// In production, use structured logging
			fmt.Printf("HTTP/3 server error: %v\n", err)
		}
	}()

	return server, nil
}

// generateTLSConfig creates a self-signed cert for testing/demo.
// In production, use real certificates (e.g., Let's Encrypt).
func generateTLSConfig() (*tls.Config, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("rsa generate key error: %w", err)
	}
	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			Organization: []string{"QUIC Corp"},
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(time.Hour * 24 * 365),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return nil, fmt.Errorf("create cert error: %w", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})

	tlsCert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("x509 key pair error: %w", err)
	}
	return &tls.Config{
		Certificates: []tls.Certificate{tlsCert},
		NextProtos:   []string{"h3"}, // Application-Layer Protocol Negotiation (ALPN)
	}, nil
}
```

### Unit Test

```go
package quicnet

import (
	"context"
	"crypto/tls"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/quic-go/quic-go/http3"
)

func TestQUICHTTP3(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mux := http.NewServeMux()
	mux.HandleFunc("/ping", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("pong"))
	})

	srv, err := StartH3Server(ctx, Config{Addr: "localhost:8443", Timeout: 30 * time.Second}, mux)
	if err != nil {
		t.Fatalf("Failed to start server: %v", err)
	}
	defer srv.Close()

	// Wait for server to start listener
	time.Sleep(500 * time.Millisecond)

	// QUIC Client
	tlsClientConf := &tls.Config{InsecureSkipVerify: true}
	transport := &http3.Transport{
		TLSClientConfig: tlsClientConf,
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   2 * time.Second,
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://localhost:8443/ping", nil)
	if err != nil {
		t.Fatalf("Failed to build request: %v", err)
	}

	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("Failed to GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected status 200, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	if string(body) != "pong" {
		t.Errorf("Expected body 'pong', got '%s'", body)
	}
}

func TestH3ServerGracefulShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	srv, err := StartH3Server(ctx, Config{Addr: "localhost:8444", Timeout: 5 * time.Second}, mux)
	if err != nil {
		t.Fatalf("Failed to start server: %v", err)
	}

	// Trigger context cancellation for graceful shutdown
	cancel()
	
	// Wait a moment for shutdown to complete
	time.Sleep(200 * time.Millisecond)
	
	// Server should close cleanly
	if err := srv.Close(); err != nil && err != http.ErrServerClosed {
		t.Logf("Expected server closed, got: %v", err)
	}
}

func TestH3HandlerLogic_HttpTest(t *testing.T) {
	// Menggunakan httptest untuk menguji handler secara independen dari QUIC
	req := httptest.NewRequest(http.MethodGet, "/ping", nil)
	w := httptest.NewRecorder()

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("pong"))
	})

	handler.ServeHTTP(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected status 200, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "pong" {
		t.Errorf("Expected body 'pong', got '%s'", string(body))
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Mengabaikan Deadlines/Timeouts pada Stream Raw QUIC
Banyak developer berpikir bahwa karena QUIC adalah protokol modern, `quic-go` akan secara ajaib menangani timeout koneksi saat membaca dari stream. Jika Anda tidak mengatur timeout, goroutine bisa bocor (leak) ketika klien secara diam-diam memutus jaringan tanpa mengirim frame `CONNECTION_CLOSE`.

```go
// ❌ BAD: Membaca dari stream tanpa deadline
stream, err := conn.AcceptStream(context.Background())
if err != nil { return err }

go func() {
    buf := make([]byte, 1024)
    // Akan memblokir selamanya jika klien hilang di tengah jalan
    n, err := stream.Read(buf) 
    fmt.Println(string(buf[:n]))
}()
```
**Why dangerous:** Menyebabkan goroutine leak dan memory leak, yang pada akhirnya akan membuat server kehabisan memori (OOM) di production.

```go
// ✅ GOOD: Selalu set context atau deadline pada operasi I/O stream
stream, err := conn.AcceptStream(ctx) // Context aware accept
if err != nil { return err }

go func() {
    // Set batas waktu read
    stream.SetReadDeadline(time.Now().Add(5 * time.Second))
    
    buf := make([]byte, 1024)
    n, err := stream.Read(buf)
    if err != nil {
        // Handle read timeout properly
        return
    }
    fmt.Println(string(buf[:n]))
}()
```

### ❌ Anti-Pattern 2: Berasumsi Multiplexing Stream Aman dari Unbounded Allocations
`quic-go` memungkinkan membuka ribuan stream dalam satu koneksi QUIC. Jika klien nakal (malicious) terus membuka stream tanpa mengirim data (Stream DDoSing), dan server membuka goroutine untuk tiap stream tanpa limit, memory akan habis.

```go
// ❌ BAD: Menerima stream tak terbatas dalam satu koneksi
for {
    stream, err := conn.AcceptStream(ctx)
    if err != nil {
        break
    }
    // Goroutine spawn tanpa limit per koneksi
    go handleStream(stream) 
}
```
**Why dangerous:** Kerentanan DoS / Resource Exhaustion di level aplikasi. Klien dapat dengan mudah membuat server OOM hanya dengan satu koneksi UDP tunggal.

```go
// ✅ GOOD: Gunakan MaxIncomingStreams pada quic.Config
// Dan terapkan rate limiting di sisi aplikasi.
quicConfig := &quic.Config{
    MaxIncomingStreams: 100, // Batasi jumlah stream concurrent per koneksi
    MaxIdleTimeout:     30 * time.Second,
}
// ... saat accept stream:
// Jika stream lebih dari 100, AcceptStream akan otomatis tertahan
// atau klien akan menerima STREAM_LIMIT error
```

## 5. Edge Cases & Defensive Programming

1. **UDP Buffer Overflow (OS Level)**: QUIC menggunakan UDP. Kernel OS biasanya memberikan buffer receive UDP yang kecil (contoh di Linux `net.core.rmem_default` seringkali hanya 212KB). Saat ada burst traffic HTTP/3, paket UDP akan di-drop oleh kernel OS sebelum `quic-go` sempat membacanya. *Defensive:* Jangan hanya mengandalkan kode Go; pastikan Anda men-tuning sysctl di host OS (`sysctl -w net.core.rmem_max=2500000`) dan pertimbangkan mengatur ukuran buffer socket secara eksplisit di Go dengan membuat custom `net.ListenUDP` lalu meneruskannya ke `quic.Server`.
2. **Path MTU Discovery (PMTUD) Blackholing**: QUIC mencoba menemukan Maximum Transmission Unit (MTU) secara otomatis dengan mengirim frame besar (probing). Jika router/firewall di jalur jaringan secara diam-diam membuang (drop) paket besar tanpa mengirim ICMP Fragment Needed (fenomena blackhole), koneksi bisa hang atau terputus-putus (stall). *Defensive:* Dalam skenario tertutup atau jaringan yang sangat dimanipulasi, atur `DisablePathMTUDiscovery: true` pada `quic.Config` untuk menghindari paket terbuang.
3. **0-RTT Replay Attacks pada HTTP/3**: Fitur 0-RTT di QUIC dan TLS 1.3 sangat mempercepat koneksi, namun rentan terhadap serangan Replay (paket dikirim ulang oleh penyerang). *Defensive:* Jika mengaktifkan 0-RTT, server TIDAK BOLEH memproses request yang memodifikasi state (seperti POST/PUT/DELETE) dari data yang datang pada frame 0-RTT. Data ini harus ditolak sampai handshake 1-RTT selesai secara penuh. Untungnya, abstraksi standar di Go harusnya menangani hal ini, tapi jika menulis custom handler QUIC, Anda harus memverifikasi state `Used0RTT`.

## Kapan JANGAN Pakai Ini

- **Bila jaringan target memblokir UDP.** Sebagian jaringan korporat dan operator memblokir atau membatasi UDP. Tanpa fallback ke HTTP/2 yang benar-benar diuji, sebagian pengguna Anda tidak bisa terhubung sama sekali.
- **Tanpa memperhitungkan konsumsi CPU.** QUIC menangani enkripsi dan pemulihan paket di **ruang pengguna**. Pada throughput tinggi, CPU-nya jauh di atas TCP dengan kTLS — dan itu tagihan yang nyata.
- **Mengasumsikan middlebox memahami QUIC.** Banyak firewall, load balancer, dan alat pemantauan memperlakukan QUIC sebagai UDP tak dikenal. Observabilitas dan kontrol yang Anda andalkan bisa hilang tanpa disadari.
- **Untuk lalu lintas internal yang sudah cepat dan andal.** Keunggulan QUIC — pemulihan cepat dari kehilangan paket, migrasi koneksi — muncul pada jaringan yang **buruk**. Di dalam satu data center, ia menambah CPU tanpa manfaat yang sebanding.
- **Tanpa rencana observability.** Alat untuk TCP jauh lebih matang. Bila Anda belum bisa menjawab "kenapa koneksi ini lambat" untuk QUIC, jangan taruh jalur kritis di atasnya.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Sebagian pengguna tidak bisa terhubung | rasio fallback ke HTTP/2 | UDP terblokir di jaringan mereka |
| CPU jauh lebih tinggi dari perkiraan | CPU per gigabit | Pemrosesan QUIC di ruang pengguna |
| Tidak terlihat di alat pemantauan jaringan | dukungan QUIC pada middlebox | Lalu lintas dianggap UDP tak dikenal |
| Tidak ada perbaikan latensi | kualitas jaringan pengguna | Jaringan sudah baik; QUIC tidak menambah apa pun |
| Sulit mendiagnosis koneksi lambat | qlog atau metrik QUIC | Observability belum disiapkan |

```bash
# Berapa banyak yang benar-benar memakai HTTP/3 vs fallback
curl -s localhost:9090/metrics | grep -E 'http_requests_total.*proto="(h3|h2)"'

# Apakah UDP 443 bisa dijangkau dari jaringan target?
nc -zvu api.contoh.id 443
curl -sI --http3 https://api.contoh.id/ 2>&1 | head -3

# CPU per byte: bandingkan dengan jalur HTTP/2
go tool pprof -top 'http://localhost:6060/debug/pprof/profile?seconds=30' | grep -iE 'quic|crypto'
```
