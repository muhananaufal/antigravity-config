# DNS Resolution & Custom Resolvers in Go

## 1. Konsep Utama & Internals
Dalam sistem terdistribusi, System Name Resolution (DNS) lebih dari sekadar pemetaan domain ke IP. Layanan tingkat lanjut seperti *Split-horizon DNS*, *Service Discovery* (berbasis SRV records), atau *DNS Caching* kustom untuk menghindari *rate limit* ISP memerlukan pengelolaan DNS secara teliti. 

Go memiliki resolver internal bawaan (`net.Resolver`). Namun, dependensi pada OS (seperti `/etc/resolv.conf`) sering memicu isu ketidakkonsistenan antar environment. `cgo` resolver (default di beberapa OS) menggunakan OS thread (`getaddrinfo`) yang bersifat *blocking*, menyebabkan *thread starvation* saat *high-load*. Library `github.com/miekg/dns` (yang juga menjadi pondasi CoreDNS) adalah standar de-facto di Go untuk merakit klien/server DNS native yang sepenuhnya *non-blocking* dan *goroutine-friendly*.

## 2. Diagram Arsitektur (ASCII)
```text
  [Microservice A (Go)] 
         |  (Custom net.Dialer)
         v
  [ Custom Go DNS Resolver (miekg/dns) ]
         |
  (Cek Local In-Memory Cache TTL)
         |
    +----+----+
    |         |
 (Cache Hit) (Cache Miss)
    |         |
    v         v
 Return IP   [Upstream DNS: e.g., Consul (Port 8600) / Cloudflare (1.1.1.1)]
              |
              +--> Returns: Target: 10.0.x.x, TTL: 60s
              |
         (Update Cache)
```

## 3. Production-Ready Go Code

Kode di bawah mendemonstrasikan custom resolver yang aman dari *goroutine leak*, menangani *UDP Truncation* (beralih ke TCP otomatis), dan mengelola context timeout secara eksplisit.

```go
package dnsnet

import (
	"context"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/miekg/dns"
)

// CustomResolver is a DNS resolver with specific upstreams.
type CustomResolver struct {
	udpClient *dns.Client
	tcpClient *dns.Client
	Server    string // e.g. "8.8.8.8:53"
}

// NewCustomResolver menginisialisasi client untuk UDP dan fallback TCP
func NewCustomResolver(server string) *CustomResolver {
	return &CustomResolver{
		udpClient: &dns.Client{
			Net:     "udp",
			Timeout: 2 * time.Second,
		},
		tcpClient: &dns.Client{
			Net:     "tcp",
			Timeout: 2 * time.Second,
		},
		Server: server,
	}
}

// LookupA fetches IPv4 addresses for a domain handling context and truncations.
func (r *CustomResolver) LookupA(ctx context.Context, domain string) ([]string, error) {
	msg := new(dns.Msg)
	// Domain HARUS FQDN (diakhiri titik)
	msg.SetQuestion(dns.Fqdn(domain), dns.TypeA)
	msg.RecursionDesired = true

	// Gunakan channel untuk mengikat operasi dengan context timeout caller
	type result struct {
		in  *dns.Msg
		err error
	}
	done := make(chan result, 1)

	go func() {
		// Coba UDP terlebih dahulu
		in, _, err := r.udpClient.Exchange(msg, r.Server)
		if err == nil && in != nil && in.Truncated {
			// Fallback ke TCP jika UDP terpotong (TC bit diset)
			in, _, err = r.tcpClient.Exchange(msg, r.Server)
		}
		done <- result{in, err}
	}()

	select {
	case <-ctx.Done():
		return nil, fmt.Errorf("dns lookup timeout/cancelled: %w", ctx.Err())
	case res := <-done:
		if res.err != nil {
			return nil, fmt.Errorf("dns exchange failed: %w", res.err)
		}
		if res.in.Rcode != dns.RcodeSuccess {
			return nil, fmt.Errorf("dns lookup failed with rcode: %d", res.in.Rcode)
		}

		var ips []string
		for _, ans := range res.in.Answer {
			if a, ok := ans.(*dns.A); ok {
				ips = append(ips, a.A.String())
			}
		}
		return ips, nil
	}
}

// CustomDialer returns a net.Dialer that uses our CustomResolver for standard HTTP/TCP clients.
func CustomDialer(resolverServer string) *net.Dialer {
	return &net.Dialer{
		Resolver: &net.Resolver{
			PreferGo: true, // Paksa pure-Go resolver (non-blocking)
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				d := net.Dialer{Timeout: 2 * time.Second}
				// Arahkan semua query dari net/http standar ke resolver spesifik kita
				return d.DialContext(ctx, "udp", resolverServer)
			},
		},
	}
}
```

### Unit Test

```go
package dnsnet

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestCustomResolver_LookupA(t *testing.T) {
	resolver := NewCustomResolver("8.8.8.8:53")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	ips, err := resolver.LookupA(ctx, "google.com.")
	if err != nil {
		t.Fatalf("Lookup failed: %v", err)
	}
	if len(ips) == 0 {
		t.Fatalf("Expected IPs, got 0")
	}
}

func TestCustomDialer_HTTP(t *testing.T) {
	dialer := CustomDialer("8.8.8.8:53")
	transport := &http.Transport{
		DialContext: dialer.DialContext,
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   5 * time.Second,
	}

	resp, err := client.Get("http://example.com")
	if err != nil {
		t.Fatalf("HTTP GET with custom resolver failed: %v", err)
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected 200 OK, got %d", resp.StatusCode)
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan (Caching) IP Tanpa Menghormati TTL
Banyak developer mengoptimasi aplikasi dengan menginisiasi resolusi *hostname* di awal (`init()`), lalu menyimpan string IP tersebut ke variabel global secara permanen.

```go
// ❌ BAD: Resolve sekali, simpan IP selamanya
var dbIP string

func init() {
    ips, _ := net.LookupIP("db.internal")
    dbIP = ips[0].String() // Digunakan terus di semua query SQL
}
```
**Why dangerous:** Di era Cloud, Load Balancer dan Database failover sering berganti IP (misal AWS RDS failover ke instance standby). Menyimpan statis IP menyebabkan aplikasi Anda gagal koneksi permanen saat topologi cloud berubah, memaksa Anda merestart service manual.

```go
// ✅ GOOD: Re-resolve dinamis, taati TTL DNS (atau delegasikan ke net/http dialer internal)
// Gunakan dialer yang menyisipkan custom resolver dan caching sesuai TTL records.
// Atau lookup secara dinamis saat dial connection.
func connectDB() (net.Conn, error) {
    // Dialer ini otomatis menangani TTL jika dikonfigurasi di level OS atau dns proxy,
    // Atau kita re-resolve setiap kali membuat koneksi TCP baru.
    return dialer.DialContext(ctx, "tcp", "db.internal:5432") 
}
```

### ❌ Anti-Pattern 2: Ketergantungan Buta pada `cgo` (getaddrinfo)
Secara default di Linux dengan CGO_ENABLED=1, Go menggunakan *C library* (`libc`) untuk DNS `getaddrinfo()`. Operasi ini bersifat *blocking* ke OS thread asli, bukan *goroutine multiplexing*.

```go
// ❌ BAD (Implied): Aplikasi yang dibangun dengan cgo menggunakan default net.Dial
// Tanpa membedakan thread concurrency
http.Get("https://api.lambat-resolve.com") 
```
**Why dangerous:** Saat layanan mengalami *spike* dan banyak thread harus meresolve DNS yang lambat merespons, runtime Go akan menspawr OS Thread baru secara masif (menguras memori OS) menyebabkan *Thread Starvation* dan aplikasi crash.

```go
// ✅ GOOD: Secara eksplisit paksa Go native resolver 
// yang menggunakan epoll/kqueue non-blocking UDP socket
os.Setenv("GODEBUG", "netdns=go")
// ATAU di level kode:
net.DefaultResolver = &net.Resolver{
    PreferGo: true,
}
```

## 5. Edge Cases & Defensive Programming

1. **Truncated UDP Responses (TC Bit)**: Standar lama membatasi paket UDP DNS maksimal 512 byte (tanpa EDNS0). Jika jawaban dari server (seperti request TXT record besar atau banyak A record) melebihi batas, DNS server mengatur bit `TC=1` (Truncated). *Defensive:* Jangan mengabaikan field `in.Truncated`. Jika ini terjadi dan Anda hanya menggunakan UDP, IP yang Anda butuhkan mungkin terpotong. Seperti pada kode produksi di atas, tangkap kondisi `in.Truncated` dan secara otomatis *fallback* me-retry *query* menggunakan klien berprotokol TCP (`Net: "tcp"`).
2. **DNS SSRF (Server-Side Request Forgery) via Bogon IP**: Penyerang mendaftarkan domain pubilk `attacker.com` untuk menunjuk ke IP internal/lokal Anda (seperti `169.254.169.254` AWS Metadata atau `127.0.0.1`). Aplikasi Go lalu me-resolve domain tersebut dan mengirim request HTTP. *Defensive:* Setelah mendapatkan `ips` dari resolver, loop melalui hasilnya dan pastikan tidak ada blok IP private (RFC 1918) atau loopback (Bogon space) jika Anda mendial ke layanan publik eksternal eksternal. Go menyediakan fungsi cek `ip.IsPrivate()` dan `ip.IsLoopback()`.
3. **Split-Horizon Ambiguity (Search Domains Kubernetes)**: Saat aplikasi di Kubernetes mencoba me-resolve `google.com`, `/etc/resolv.conf` K8s memiliki `search default.svc.cluster.local svc.cluster.local cluster.local`. Resolusi akan mencoba `google.com.default.svc.cluster.local` terlebih dahulu (bocor internal). *Defensive:* Untuk domain publik absolut, pastikan Anda menambahkan titik di akhir domain (`google.com.`) dalam pemanggilan `LookupA`—titik di akhir menyatakan status *Fully Qualified Domain Name (FQDN)* yang memerintahkan resolver untuk mengabaikan pengaturan `search domain` di OS dan langsung menembak *root zone*.
