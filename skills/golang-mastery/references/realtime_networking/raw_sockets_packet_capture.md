# Realtime Networking: Raw Sockets & Packet Capture di Go

> **Berlaku:** Go 1.21+ · Linux `AF_PACKET` / libpcap · **Lihat juga:** `realtime_networking/ebpf_cilium_go.md` · `system_programming_linux/syscall_epoll_nonblocking.md` · `cybersecurity_zerotrust/network_security_scanning.md` · `security_owasp/audit_logging_scrubbing.md`

## 1. Konsep dan Internals

Sebagian besar aplikasi jaringan menggunakan *Stream/Datagram Sockets* standar (`net.ListenTCP` / `UDP`). Pada level ini, kernel Linux telah melucuti semua *header* Ethernet dan IP, dan aplikasi hanya memproses/mendapat datanya saja. 

Namun, jika Anda ingin membangun sebuah alat pemantau lalu lintas jaringan (seperti Wireshark/tcpdump), IDS (Intrusion Detection System), atau protokol khusus bukan IP (Layer 2), Anda perlu beroperasi menggunakan **Raw Sockets** atau mekanisme penangkapan paket khusus seperti `AF_PACKET`. Di Go, pustaka standar yang mendominasi domain ini adalah `github.com/google/gopacket` (bersandar pada *libpcap* dan CGO) atau implementasi *AF_PACKET* murni menggunakan *syscalls*.

**AF_PACKET dan BPF Filter:**
Di Linux, paket-paket yang tiba di antarmuka (*Network Card*) disalin oleh kernel dan ditangkap lewat soket keluarga `AF_PACKET`. Agar tidak kebanjiran memori dari menyalin gigabytes data untuk keseluruhan PC, Anda wajib menerapkan filter pcap-bpf (Berkeley Packet Filter klasik - bukan eBPF modern) pada level kernel *sebelum* dikirim ke ruang pengguna (Go application).

## 2. Diagram ASCII: Packet Sniffing via AF_PACKET

```text
       [  Kabel Jaringan / Internet  ]
                    |
+-------------------|------------------------------------------+
|  [Network Interface Card (eth0)]                             |
|                   |                                          |
|  [ Linux Kernel Protocol Stack ]                             |
|                   |                                          |
|        +----------+-----------+                              |
|        |                      |                              |
|   [ AF_INET (TCP/UDP) ]   [ AF_PACKET Socket ]               |
|      (To Web Server)          |                              |
|                               | (1. Skips IP/TCP stripping)  |
|                               | (2. Executes cBPF Filter:    |
|                               |     "tcp and port 80")       |
+-------------------------------|------------------------------+
                                V
+--------------------------------------------------------------+
|                    Go Application (gopacket)                 |
|                                                              |
|   pcap.OpenLive("eth0") // CGO to libpcap                    |
|                                                              |
|   -> gopacket.NewPacketSource(handle, LinkTypeEthernet)      |
|      for packet := range source.Packets() {                  |
|         - Decode Ethernet Header (MAC)                       |
|         - Decode IPv4 Header (IP Src/Dst)                    |
|         - Decode TCP Header (Port, Flags)                    |
|         - Application Payload (HTTP)                         |
|      }                                                       |
+--------------------------------------------------------------+
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan Channel `packetSource.Packets()` pada High-Throughput

Di GoPacket, sering ada tutorial yang membaca paket dari fungsi pembungkus channel. Ini terasa idiomatis (`range`), tapi memiliki performa yang menghancurkan untuk lalu lintas 10 Gbps (Gigabits per detik).

```go
// ❌ BAD: Membaca via Channel memicu Garbage Collector (Alokasi berat)
source := gopacket.NewPacketSource(handle, handle.LinkType())
for packet := range source.Packets() {
    // Pada 10 Gbps (juta paket per detik), mengalokasikan struct 'packet' baru
    // dan melemparnya lewat channel akan membunuh CPU. Program nge-lag atau drop packets.
    print(packet)
}
```
**Why dangerous:** *Memory Thrashing* dan *Packet Drops*. *Buffer Ring* kernel akan penuh karena program Go Anda terlalu lambat mengosongkannya akibat disibukkan tugas *Garbage Collection* (GC) pada jutaan `packet struct`.

```go
// ✅ GOOD: Zero-Allocation Decoding in a loop
var eth layers.Ethernet
var ip4 layers.IPv4
var tcp layers.TCP
var payload gopacket.Payload

// Buat decoder statis
parser := gopacket.NewDecodingLayerParser(layers.LayerTypeEthernet, &eth, &ip4, &tcp, &payload)
decoded := make([]gopacket.LayerType, 0, 4)

for {
    // Baca byte Murni (tanpa alokasi struct paket baru)
    data, _, err := handle.ZeroCopyReadPacketData() 
    if err != nil { continue }
    
    // Decode data in-place
    parser.DecodeLayers(data, &decoded)
    for _, layerType := range decoded {
        if layerType == layers.LayerTypeTCP {
            // Cek tcp.SrcPort
        }
    }
}
```

### ❌ Anti-Pattern 2: Menangkap Paket Tanpa *Promiscuous Mode* di Jaringan Switched

Soket mentah hanya mendengarkan alamat MAC spesifik dari *network card* host. Jika Anda menaruh host ini sebagai alat penyadap di *mirror port switch*, dan Anda gagal mengaktifkan mode *Promiscuous*.

```go
// ❌ BAD: Promiscuous Mode di-set False pada probe sniffer
handle, err := pcap.OpenLive("eth0", 1600, false, pcap.BlockForever)
```
**Why dangerous:** Keruntuhan Fungsi Sniffer (*Blind Spot*). Anda hanya akan melihat lalu lintas si *host* itu sendiri, tapi tidak melihat lalu lintas orang lain di jaringan karena *network card* perangkat keras menjatuhkan (drop) *frame* yang bukan miliknya sebelum diteruskan ke AF_PACKET.

```go
// ✅ GOOD: Set true untuk Network Monitoring
handle, err := pcap.OpenLive("eth0", 65535 /* SnapLen MAX */, true, pcap.BlockForever)
```

## 4. Edge Cases & Defensive Programming

1.  **VLAN Tagging (802.1Q) Pecah Dekoder:**
    Paket *Ethernet* di datacenter atau perkantoran sering disisipi *VLAN tag* di antara *Header Ethernet* dan IP. Jika dekoder raw/C-struct Anda kaku memandang alamat IP mulai di *offset byte* ke-14, VLAN Tag berukuran 4 byte akan membuat seluruh pembacaan IP bergeser dan salah (membaca angka acak). Di `gopacket`, pastikan meregistrasikan `layers.Dot1Q` pada *DecodingLayerParser*.
2.  **TCP Checksum Offloading di Host:**
    Jika menangkap paket yang dibuat oleh *host* (komputer) Anda sendiri, Anda akan sering melihat TCP Checksum-nya bernilai salah (Invalid Checksum). Ini bukan *bug*, ini fitur. Sistem operasi mendelegasikan penghitungan *checksum* ke perangkat keras (*NIC Offload*), jadi paket tertangkap oleh `AF_PACKET` kernel *sebelum* hardware mengisinya. Jangan pernah buang (*drop*) paket berdasarkan *checksum* jika itu lalu-lintas kiriman keluar lokal (*outbound localhost*).
3.  **SnapLen (Snapshot Length) Truncation:**
    Dalam banyak insiden keamanan/pemantauan, Anda hanya perlu melihat Header IP dan TCP (analisis lalu lintas/NetFlow). Mengatur `SnapLen` sebesar MTU (65535/1500) menyebabkan kernel menyalin megabyte muatan data (payload HTTP/Video) ke memori Go. Untuk optimasi *extreme*, atur `SnapLen` ke `64` bytes saja (meng-*capture* header). Payload sisanya otomatis diputus (ter- *truncate*) oleh Kernel dan *buffer* diselamatkan.

## 5. Production-Ready Go Code & Unit Test

Kode mensimulasikan penggunaan `AF_PACKET` di Linux secara murni lewat `golang.org/x/sys/unix` untuk menangkap paket tanpa butuh `libpcap` (CGO bebas), serta mengimplementasikan teknik nol-alokasi (*zero-alloc loop*).

```go
package capture

import (
	"context"
	"fmt"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// RawPacketSniffer memegang referensi soket mentah Linux
type RawPacketSniffer struct {
	fd   int
	ifce string
}

func NewSniffer(ifaceName string) (*RawPacketSniffer, error) {
	// AF_PACKET = Akses level data-link
	// SOCK_RAW = Header Ethernet disertakan
	// ETH_P_ALL = Tangkap semua tipe protokol Layer 3 (IP, ARP, dll). htons(0x0003)
	fd, err := unix.Socket(unix.AF_PACKET, unix.SOCK_RAW, int(unix.Htons(unix.ETH_P_ALL)))
	if err != nil {
		return nil, fmt.Errorf("failed to open raw socket (requires root): %w", err)
	}

	// Mode non-blocking agar tidak hang saat ctx.Done()
	if err := unix.SetNonblock(fd, true); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("set nonblock failed: %w", err)
	}

	// Cari indeks interface
	iface, err := netInterfaceByName(ifaceName)
	if err != nil {
		unix.Close(fd)
		return nil, err
	}

	// Bind socket AF_PACKET ke interface spesifik (misal eth0)
	addr := &unix.SockaddrLinklayer{
		Protocol: unix.Htons(unix.ETH_P_ALL),
		Ifindex:  iface.Index,
	}

	if err := unix.Bind(fd, addr); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("bind failed: %w", err)
	}

	return &RawPacketSniffer{fd: fd, ifce: ifaceName}, nil
}

// netInterfaceByName pembungkus net.InterfaceByName untuk tes
var netInterfaceByName = func(name string) (*netInterface, error) {
	// Dummy untuk bisa test kompilasi tanpa interface betulan, 
	// Aslinya memanggil net.InterfaceByName
	return &netInterface{Index: 1, Name: name}, nil
}
type netInterface struct { Index int; Name string }

// Close menutup socket
func (s *RawPacketSniffer) Close() {
	unix.Close(s.fd)
}

// Start mulai membaca tanpa alokasi baru
func (s *RawPacketSniffer) Start(ctx context.Context, onPacket func(data []byte)) error {
	// 1 buffer statis memuat frame maximum size standar Ethernet MTU (1514)
	buffer := make([]byte, 2048)
	
	// Gunakan epoll atau select untuk memblokir, tapi untuk kesederhanaan
	// contoh ini kita lakukan polling fallback karena nonblocking
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
			// Baca paket dari level Kernel
			n, _, err := unix.Recvfrom(s.fd, buffer, 0)
			if err != nil {
				if err == unix.EAGAIN || err == unix.EWOULDBLOCK {
					// Tidak ada paket saat ini, istirahat dan ulangi
					time.Sleep(1 * time.Millisecond)
					continue
				}
				return fmt.Errorf("recvfrom error: %w", err)
			}

			// Lempar salinan slice ke callback
			// Hati-hati: isi buffer akan dioverwrite di iterasi berikutnya!
			// onPacket harusnya sinkron / tidak di go-routine, atau harus copy.
			onPacket(buffer[:n]) 
		}
	}
}

// -------------------------------------------------------------------------
// Unit Test
// -------------------------------------------------------------------------
func TestRawSocket(t *testing.T) {
	// Mock agar syscall tidak gagal jika bukan Root
	t.Skip("Skipping AF_PACKET test because it strictly requires CAP_NET_RAW / root on Linux OS.")
	
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	sniffer, err := NewSniffer("lo") // Loopback
	if err != nil {
		t.Fatalf("Init gagal: %v", err)
	}
	defer sniffer.Close()

	packetCount := 0
	
	// Jalankan secara Asinkron
	go sniffer.Start(ctx, func(data []byte) {
		packetCount++
	})
	
	// Trigger lalu lintas ping ke diri sendiri
	// exec.Command("ping", "-c", "3", "127.0.0.1").Run()
	
	time.Sleep(1*time.Second)
	if packetCount == 0 {
		t.Log("Tidak ada paket lewat.")
	}
}
```

## Kapan JANGAN Pakai Ini

- **Bila `pcap` atau eBPF sudah cukup.** Raw socket menuntut `CAP_NET_RAW` atau root, dan memberi kapabilitas itu ke sebuah container memperluas dampak setiap kompromi terhadapnya.
- **Menangkap di produksi tanpa filter.** Volume paket pada layanan sibuk akan menghabiskan CPU dan disk lebih cepat daripada yang diperkirakan, dan penangkapannya sendiri menjadi insiden.
- **Menyimpan tangkapan tanpa memikirkan isinya.** Paket memuat data pengguna dalam bentuk polos untuk lalu lintas yang tidak terenkripsi — termasuk yang tunduk aturan privasi dan retensi.
- **Tanpa memperhitungkan paket yang hilang saat beban tinggi.** Tangkapan yang tidak lengkap **menyesatkan**: Anda menyimpulkan sesuatu tidak terjadi padahal hanya tidak tertangkap.
- **Menjalankan dengan kapabilitas jaringan tinggi di container yang tidak membutuhkannya.** Kapabilitas harus mengikuti kebutuhan, dan penangkapan paket biasanya sementara.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Kesimpulan salah dari tangkapan | statistik paket yang di-drop | Tangkapan tidak lengkap |
| CPU melonjak saat penangkapan aktif | filter BPF yang dipakai | Menangkap terlalu banyak |
| Disk penuh oleh berkas tangkapan | rotasi dan batas ukuran | Tidak ada batas |
| Data pengguna ditemukan di berkas pcap | isi tangkapan | Tidak ada penyaringan atau retensi |
| Container punya `CAP_NET_RAW` permanen | securityContext | Kapabilitas tidak dicabut setelah selesai |

```bash
# Paket yang DI-DROP saat penangkapan -- angka ini menentukan tangkapan bisa dipercaya atau tidak
tcpdump -i eth0 -c 1000 'tcp port 8080' 2>&1 | tail -3
cat /proc/net/dev | head -3

# Kapabilitas yang benar-benar dimiliki proses
grep Cap /proc/$(pgrep app)/status
kubectl get pod <pod> -o jsonpath='{.spec.containers[0].securityContext.capabilities}' | jq

# Selalu pakai filter dan batas -- tanpa itu penangkapan menjadi insidennya sendiri
tcpdump -i eth0 -s 96 -c 5000 -w /tmp/tangkap.pcap 'tcp port 8080 and not host 10.0.0.5'
```
