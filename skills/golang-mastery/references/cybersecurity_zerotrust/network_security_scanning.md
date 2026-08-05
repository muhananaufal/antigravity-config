# Network Security Scanning (Port & Vulnerability) di Go

> **Berlaku:** Go 1.21+ · nmap / trivy / kube-bench · **Lihat juga:** `testing_quality/govulncheck_security_scan.md` · `cybersecurity_zerotrust/zero_trust_policy_engine.md` · `security_owasp/mtls_certificate_rotation.md` · `devops_control_planes/docker_container_go.md`

Security scanner internal di Zero Trust architecture bertugas memeriksa anomali konfigurasi jaringan dari *dalam* cluster — port terbuka yang tidak diharapkan, layanan usang yang terekspos, atau certificate TLS yang akan kadaluarsa.

---

## 1. Internals: TCP Port Scan States & Banner Grabbing

```
TCP Connect Scan (yang diimplementasikan Go via net.Dial):

Scanner                    Target
   │                          │
   │──── SYN ────────────────►│
   │                          │
   │◄─── SYN-ACK ────────────│  → Port OPEN: complete 3-way handshake
   │──── ACK ────────────────►│    net.Dial() returns conn, err=nil
   │──── RST ────────────────►│    (langsung close — kita hanya cek status)
   │                          │
   │──── SYN ────────────────►│
   │◄─── RST-ACK ────────────│  → Port CLOSED: rejected
                                   net.Dial() returns err "connection refused"
   │──── SYN ────────────────►│
   │         (no response)    │  → Port FILTERED: firewall DROP rule
                                   net.Dial() hangs until timeout
                                   WAJIB set Dialer.Timeout!

Banner Grabbing (service fingerprinting):

  Open Port Detected
       │
       ├──► Try TLS Handshake (TLS port?) ──► Extract cert metadata
       │    (conn.SetDeadline + tls.Client)
       │
       ├──► Read first 512 bytes ──► HTTP? SSH? SMTP? Identify service
       │    (conn.Read dengan deadline)
       │
       └──► Check cert expiry ──► Alert if < 30 days

Worker Pool (wajib untuk scan ribuan port):

  [Port List: 1-65535]
       │ feed via channel
  [jobs chan int]──►[Worker 1]──►[results chan ScanResult]
                  ──►[Worker 2]──►
                  ──►[Worker N]──►  N = min(100, len(ports))
       └──► Controlled by semaphore: avoid fd exhaustion
```

## 2. Diagram Arsitektur (ASCII)
```text
  [Go Security Scanner (CronJob/Agent)]
          |
    (Goroutine Worker Pool: 500 Workers)
          |
          +---> [Target Pod A: Port 80 (Open/HTTP)]
          +---> [Target Pod A: Port 22 (Closed/RST)]
          +---> [Target Pod B: Port 443 (Open/TLS Handshake)]
          |             |
          |             v (Ekstrak TLS Certificate Metadata)
          v
   (Merge Result Channel)
          |
   [Aggregator & Alerting (DefectDojo/Slack)]
```

## 3. Production-Ready Go Code

Kode pemindai multi-port (TCP) efisien menggunakan goroutine, pola *Worker Pool* (untuk membatasi koneksi OS), dan pengaturan batas `Timeout` yang presisi.

```go
package securityscan

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"
)

// ScanResult merepresentasikan hasil pindai satu IP dan Port
type ScanResult struct {
	TargetIP string
	Port     int
	IsOpen   bool
	Service  string // Misal: "TLS", "HTTP" (Banner grab)
	Err      error
}

// Scanner merepresentasikan instance keamanan internal
type Scanner struct {
	WorkerCount int
	Timeout     time.Duration
}

func NewScanner(workers int, timeout time.Duration) *Scanner {
	return &Scanner{
		WorkerCount: workers,
		Timeout:     timeout,
	}
}

// ScanPorts meluncurkan worker pool untuk memindai port secara konkuren
func (s *Scanner) ScanPorts(ctx context.Context, target string, ports []int) []ScanResult {
	jobs := make(chan int, len(ports))
	results := make(chan ScanResult, len(ports))
	var wg sync.WaitGroup

	// 1. Inisiasi Worker Pool (menghindari batas 'Too many open files' limit)
	for i := 0; i < s.WorkerCount; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for port := range jobs {
				select {
				case <-ctx.Done(): // Berhenti jika parent context dicabut
					return
				default:
					results <- s.scanSinglePort(target, port)
				}
			}
		}()
	}

	// 2. Beri muatan pekerjaan (Feed jobs)
	for _, port := range ports {
		jobs <- port
	}
	close(jobs) // Tandai tak ada port baru

	// 3. Tutup channel hasil jika semua worker tuntas
	go func() {
		wg.Wait()
		close(results)
	}()

	// 4. Kumpulkan hasil
	var out []ScanResult
	for res := range results {
		out = append(out, res)
	}
	return out
}

func (s *Scanner) scanSinglePort(ip string, port int) ScanResult {
	addr := fmt.Sprintf("%s:%d", ip, port)
	res := ScanResult{TargetIP: ip, Port: port, IsOpen: false}

	// Gunakan Dialer dengan timeout deterministik
	dialer := net.Dialer{Timeout: s.Timeout}
	conn, err := dialer.Dial("tcp", addr)

	if err != nil {
		res.Err = err
		return res // Port ditutup / di-drop (firewalled)
	}
	defer conn.Close()

	// Port Terbuka
	res.IsOpen = true

	// Inspeksi Tambahan (Banner Grabbing / TLS Fingerprinting)
	// Uji jika port berbicara TLS (HTTPS/Secure Port)
	_ = conn.SetDeadline(time.Now().Add(1 * time.Second))
	tlsConn := tls.Client(conn, &tls.Config{InsecureSkipVerify: true}) // Skip cert validation saat memindai
	if err := tlsConn.Handshake(); err == nil {
		res.Service = "TLS/HTTPS"
		// Di prod nyata, ekstrak tlsConn.ConnectionState().PeerCertificates
		// Untuk audit kadaluarsa sertifikat target.
	} else {
		res.Service = "Plain TCP"
	}

	return res
}

// --- Unit Tests ---

func TestNetworkScan_OpenPort(t *testing.T) {
	// Mulai listener lokal dummy
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("setup listener: %v", err)
	}
	defer l.Close()

	port := l.Addr().(*net.TCPAddr).Port
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	scanner := NewScanner(10, 200*time.Millisecond)
	results := scanner.ScanPorts(ctx, "127.0.0.1", []int{port})

	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	if !results[0].IsOpen {
		t.Errorf("expected port %d to be open, got closed", port)
	}
}

func TestNetworkScan_ClosedPort(t *testing.T) {
	// Port 1 hampir pasti tidak ada listener di lingkungan test
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	scanner := NewScanner(5, 200*time.Millisecond)
	// Port yang sangat tinggi dan tidak mungkin ada listener
	results := scanner.ScanPorts(ctx, "127.0.0.1", []int{59999, 59998})

	for _, r := range results {
		if r.IsOpen {
			t.Errorf("port %d should be closed, got open", r.Port)
		}
	}
}

func TestNetworkScan_MultiplePortsMixed(t *testing.T) {
	// Buka 2 listener
	l1, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("setup l1: %v", err)
	}
	defer l1.Close()

	l2, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("setup l2: %v", err)
	}
	defer l2.Close()

	port1 := l1.Addr().(*net.TCPAddr).Port
	port2 := l2.Addr().(*net.TCPAddr).Port
	closedPort := 59997 // hampir pasti closed

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	scanner := NewScanner(10, 300*time.Millisecond)
	results := scanner.ScanPorts(ctx, "127.0.0.1", []int{port1, port2, closedPort})

	resultMap := make(map[int]bool)
	for _, r := range results {
		resultMap[r.Port] = r.IsOpen
	}

	if !resultMap[port1] {
		t.Errorf("port1 %d should be open", port1)
	}
	if !resultMap[port2] {
		t.Errorf("port2 %d should be open", port2)
	}
	if resultMap[closedPort] {
		t.Errorf("port %d should be closed", closedPort)
	}
}

func TestNetworkScan_ContextCancellation(t *testing.T) {
	// Scan dengan context yang segera dibatalkan
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	defer l.Close()
	port := l.Addr().(*net.TCPAddr).Port

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // batalkan segera

	scanner := NewScanner(5, 500*time.Millisecond)
	// Tidak boleh panic atau hang meski context sudah dibatalkan
	results := scanner.ScanPorts(ctx, "127.0.0.1", []int{port, port + 1, port + 2})
	// Results mungkin kosong atau partial — yang penting tidak panic/deadlock
	t.Logf("results with cancelled context: %d", len(results))
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: "Goroutine per Port" (Firehose Tumpul) Tanpa Pool
Para engineer (developer Go) yang belum terbiasa dengan limitasi OS sering men-loop perintah `go scanPort(...)` untuk rentang penuh 65.535 port TCP (0-65535) secara bersamaan tanpa rem.

```go
// ❌ BAD: Menelantarkan batas sistem (Ulimit)
for port := 1; port <= 65535; port++ {
    go func(p int) {
        net.Dial("tcp", fmt.Sprintf("192.168.1.1:%d", p))
    }(port)
}
```
**Why dangerous:** OS Linux memiliki batas `ulimit -n` (seringkali 1024 *open files/sockets*). Goroutine akan segera menghabiskan batasan *file descriptor* lokal. OS akan menolak request pembuatan socket (`socket: too many open files`), dan scanner Anda me-return *error* palsu seolah semua port "terbuka" atau program *crash*, selain itu membuat jaringan internal terguncang oleh badai SYN.

```go
// ✅ GOOD: Menggunakan pola "Worker Pool" (Semafor/Channels)
// Sediakan maksimal 100 - 500 goroutine pekerja saja, lalu salurkan list (jobs) 
// secara terkontrol melalui channel `jobs <- port`. (Sama seperti kode produksi di atas).
```

### ❌ Anti-Pattern 2: Membiarkan TCP Idle Tanpa `Close()`
Hanya karena berhasil memeriksa bahwa koneksi `Dial` tak menghasilkan *error* (Port buka), engineer lupa menutup file descriptor jaringan tersebut segera.

```go
// ❌ BAD: Membiarkan server menahan koneksi idle
conn, err := net.Dial("tcp", "10.0.0.5:80")
if err == nil {
    return true // Port Terbuka
}
// conn tidak pernah ditutup!
```
**Why dangerous:** Saat memindai ribuan IP, socket *client* pada mesin Go akan bocor dan tetap berstatus `ESTABLISHED` hingga batas OS menendangnya (bisa berjam-jam). Parahnya lagi, bagi server target (pod layanan yang Anda scan), pembiaran ini menumpuk HTTP/TCP koneksi tak berguna yang membebani (men-DDoS target).

```go
// ✅ GOOD: SELALU batalkan/bebaskan descriptor koneksi instan
conn, err := net.Dial("tcp", "10.0.0.5:80")
if err == nil {
    conn.Close() // Langsung putus/tutup (RST/FIN)
    return true
}
```

## 5. Edge Cases & Defensive Programming

1. **Firewall Drop vs Reject (Timeout Ambiguity)**: Saat memindai TCP, sebuah OS yang mematikan layanannya (atau IP tables di-set ke `REJECT`) akan langsung membalas TCP `RST`, mereturn error `connection refused` (kurang dari 1 ms). Namun, jika infrastruktur berada di balik Firewall *stealth* (*DROP* rules), server diam, dan request `net.Dial` akan tertahan (hang). *Defensive:* Jangan gunakan fungsi `net.Dial()` polos. Selalu gunakan `net.DialTimeout()` atau `net.Dialer{Timeout: x}`. Atur timeout sebisa mungkin agresif (misal 500ms di jaringan internal LAN) agar tidak menunda sisa scan ke IP berikutnya selama berpuluh-puluh detik.
2. **TLS Tarpitting (Slowloris Defenses)**: Setelah deteksi Port terbuka, agen mungkin mencoba "TLS Handshake" untuk menarik metadata (banner grab). Server mematikan nakal (*tarpit*) sengaja merespons *Hello* lambat per byte. *Defensive:* Panggilan TLS Handshake TIDAK mematuhi timeout TCP *Dialer*. Pastikan Anda memanggil `conn.SetDeadline(time.Now().Add(x))` tepat sebelum beralih ke `tls.Client(conn, ...)` untuk mengamankan proses negosiasi kunci enkripsinya (seperti dalam contoh kode di atas).
3. **UDP Stateless Illusion**: Berbeda dengan *3-way handshake* TCP, `Dial("udp",...)` hampir SELALU sukses instan di Go sekalipun port tujuan sebenarnya mati. Ini karena UDP *connectionless*—fungsi `Dial` UDP di Go cuma mengatur alamat *default* pada kernel OS. *Defensive:* Jika mendeteksi layanan UDP (misal Port 53 DNS), Anda HARUS menyuntikkan (write) data payload (*magic packet*) yang sah, memanggil *Read*, lalu memeriksa apakah OS membalasnya dengan error data/ICMP Destination Unreachable. UDP *scanning* tidak bisa pasif (blind dial).

## Kapan JANGAN Pakai Ini

- **Memindai sistem yang bukan milik Anda, atau tanpa izin tertulis.** Itu persoalan hukum, bukan persoalan teknis, dan tidak ada argumen teknis yang menyelesaikannya.
- **Pemindaian agresif terhadap produksi tanpa jendela yang disepakati.** Sebagian pemindaian membuka ribuan koneksi atau memicu jalur kode yang jarang dipakai; layanan bisa menjadi tidak stabil karena pemeriksaan keamanan itu sendiri.
- **Pemindaian sebagai pengganti hardening.** Menemukan port terbuka tidak menutupnya. Laporan tanpa perubahan konfigurasi hanya mendokumentasikan masalah yang sama setiap bulan.
- **Hasil pemindaian tanpa pemilik dan tenggat.** Laporan yang tidak ditindaklanjuti melatih seluruh tim mengabaikan laporan — termasuk yang benar-benar penting nanti.
- **Memindai hanya dari luar.** Sebagian besar pergerakan lateral terjadi **dari dalam**. Pemindaian internal antar namespace dan antar layanan sering jauh lebih informatif daripada pemindaian perimeter.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Port terbuka yang tidak diketahui siapa pun | inventaris layanan vs hasil pindai | Ada beban kerja tanpa pemilik |
| Semua pod bisa saling menghubungi | NetworkPolicy yang terpasang | Tidak ada segmentasi internal |
| Temuan yang sama muncul tiap bulan | pemilik dan tenggat temuan | Pemindaian berjalan, perbaikan tidak |
| Layanan tidak stabil saat jadwal pemindaian | intensitas pemindaian | Pemindaian agresif terhadap produksi |
| Image dengan CVE tinggi berjalan | pemindaian di registry vs di runtime | Yang dipindai bukan yang berjalan |

```bash
# Segmentasi internal: tanpa NetworkPolicy, semua pod bisa saling menghubungi
kubectl get networkpolicies -A
kubectl get pods -A -o wide | wc -l

# Kerentanan pada image yang BENAR-BENAR berjalan, bukan yang di repo
kubectl get pods -A -o jsonpath='{range .items[*].spec.containers[*]}{.image}{"\n"}{end}' \
  | sort -u | while read -r i; do echo "== $i"; trivy image --severity HIGH,CRITICAL -q "$i" | tail -5; done

# Konfigurasi cluster terhadap tolok ukur CIS
kube-bench run --targets master,node | grep -E '^\[FAIL\]' | head -20

# Port yang benar-benar terbuka dari dalam cluster
kubectl run scanner --rm -it --image=nicolaka/netshoot -- nmap -sT -Pn service.namespace.svc.cluster.local
```
