# Realtime Networking: eBPF dengan Cilium/ebpf di Go

> **Berlaku:** Go 1.21+ · `cilium/ebpf` · Linux 5.10+ · **Lihat juga:** `realtime_networking/raw_sockets_packet_capture.md` · `system_programming_linux/cgroups_v2_namespaces.md` · `system_programming_linux/seccomp_bpf_sandbox.md` · `observability_resilience/prometheus_metrics_red.md`

## 1. Konsep dan Internals

eBPF (*Extended Berkeley Packet Filter*) adalah terobosan fundamental di kernel Linux. Kemampuan ini mengizinkan pengguna untuk memuat *bytecode* program mikro dengan aman langsung ke dalam kernel, yang bisa dieksekusi secara sinkron setiap saat (berbasis *event*) tanpa mengubah *source code* kernel atau me- *load* *Kernel Module* yang membahayakan sistem. 

eBPF sangat revolusioner di ranah *Realtime Networking* (Observability, Security, Load Balancing). Alih-alih lalu lintas TCP masuk ke aplikasi Go (di ruang pengguna/*user-space*) untuk diukur, kita mengirim kode eBPF ke ruang kernel untuk menghitung *byte* secara instan sesaat sebelum/setelah paket mengenai *Network Interface Card* (XDP/TC hooks), lalu aplikasi Go kita hanya bertugas membaca angka hasil akhirnya saja.

Untuk berinteraksi dengan program eBPF dari Go, library `github.com/cilium/ebpf` merupakan standar tertinggi (dibangun oleh tim Cilium). Toolchain standar (bpf2go) digunakan untuk mengkompilasi kode C eBPF menjadi skrip *bytecode* yang kemudian dibungkus sebagai variabel biner murni Go (`[]byte`).

**Komponen Arsitektur:**
1. **eBPF Program (C Code):** Program kecil yang dimuat ke dalam kernel. Dibatasi secara ekstrem (tidak boleh ada infinite loop, alokasi memori dinamis, jumlah instruksi dibatasi *verifier*).
2. **eBPF Maps:** Struktur data (*Hash*, *Array*, *RingBuffer*) yang berada di memori kernel, tapi di- *share* antara program eBPF dan aplikasi Go di User Space untuk pertukaran data dua arah.
3. **User Space Program (Go Code):** Mengontrol *lifecycle* pemuatan program eBPF (Load), penempelan (Attach) ke *hooks* (seperti Kprobes, XDP), dan pemindahan data/grafik dari Maps ke UI atau Database.

## 2. Diagram ASCII: Arsitektur XDP eBPF & Go

```text
       [ User Space (Go Application) ]
+------------------------------------------------+
|  1. Load bpf.o into Kernel                     |
|  2. Attach to "eth0" Interface (XDP)           |
|                                                |
|  [ Periodic Poller Goroutine ]                 |
|      reads Map "packet_counts" ----------+     |
+------------------------------------------|-----+
                                           | (Syscall BPF)
                                           |
+------------------------------------------|----------------------+
|                      [ Kernel Space ]    V                      |
|                                                                 |
|   +-----------------------------------------------------+       |
|   |   eBPF Map (Hash) : { "IP_1": 50, "IP_2": 1500 }    |<---+  |
|   +-----------------------------------------------------+    |  |
|                                                              |  |
|   +--------------------------------------------------+       |  |
|   | eBPF Program (XDP Hook)                          |       |  |
|   |                                                  |       |  |
|   | if (IP_Protocol == UDP && Port == 53) {          |       |  |
|   |    packet_counts[SRC_IP]++; // Updates Map ------|-------+  |
|   |    return XDP_DROP; // Drops malicious DNS       |          |
|   | }                                                |          |
|   | return XDP_PASS; // Normal processing            |          |
|   +------------------------^-------------------------+          |
|                            |                                    |
+----------------------------|------------------------------------+
                             |
             [ Network Card (NIC) / eth0 ]
                   (Incoming Packet)
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan Polling Berkecepatan Tinggi untuk Notifikasi *Event*

Pengembang Go yang baru bermigrasi ke eBPF sering kali menggunakan *Array Map* dan membuat *goroutine loop* yang membaca data itu setiap 1 milidetik untuk melihat apakah ada event jaringan baru.

```go
// ❌ BAD: Spin/Poll Loop pada Map
for {
    var value uint64
    // Ini adalah BPF Syscall. 1000x per detik membuang-buang CPU!
    objs.EventsMap.Lookup(uint32(0), &value) 
    if value > 0 {
        // ...
    }
    time.Sleep(1 * time.Millisecond)
}
```
**Why dangerous:** *Overhead CPU Ekstrim*. Syscall menembus ruang kernel memakan siklus (cycles) CPU yang lumayan. Jika aplikasi Go menggunakan teknik polling agresif, penghematan performa yang dijanjikan oleh eBPF tidak tercapai, host justru mengalami utilisasi CPU 100%.

```go
// ✅ GOOD: Menggunakan eBPF Perf Event Array atau Ring Buffer
// Dalam kode C: bpf_ringbuf_output(&ringbuf, &data, sizeof(data), 0);
// Dalam kode Go:
reader, _ := ringbuf.NewReader(objs.EventsMap)
for {
    // Blocking (Tidur di kernel). Nol persen CPU usage ketika idle!
    record, err := reader.Read() 
    if err != nil { return }
    process(record.RawSample)
}
```

### ❌ Anti-Pattern 2: Asumsi Arsitektur Selalu *Little-Endian* dalam Parser Paket (Di Go dan C)

Kernel jaringan umumnya *Network Byte Order* (Big Endian), tapi arsitektur mesin/host umumnya *Little Endian* (x86_64).

```c
// ❌ BAD (C eBPF): Membaca port begitu saja
struct tcphdr *tcp = data + sizeof(struct ethhdr) + sizeof(struct iphdr);
if (tcp->dest == 80) { // ❌ SALAH. Angka 80 (Little Endian) bukan 80 (Big Endian)
    // ...
}
```
**Why dangerous:** Program tidak mendeteksi (*mismatch*) apapun dan gagal melakukan *tracing* diam-diam. Di Go, jika Anda membaca Raw IP dari *Ring Buffer* dan langsung melemparkannya ke `binary.LittleEndian.Uint32`, Anda mendapatkan IP siluman.

```c
// ✅ GOOD (C eBPF): Konversi eksplisit menggunakan macro BPF
if (tcp->dest == bpf_htons(80)) { // htons: host to network short
   // ...
}
```

## 4. Edge Cases & Defensive Programming

1.  **RLIMIT_MEMLOCK (Ulimit restriction):**
    Memori program dan map eBPF Kernel tidak bisa di-*swap* ke disk (harus selalu *pinned/locked* di RAM). Linux versi lawas memberi jatah memori terkunci (*memlock*) sangat kecil. Memanggil `ebpf.LoadCollection` akan me-*return* error `EPERM` jika limit terlalu kecil. **Defensif:** Aplikasi Go eBPF production selalu harus memanggil `unix.Setrlimit(unix.RLIMIT_MEMLOCK, &unix.Rlimit{Cur: unix.RLIM_INFINITY, Max: unix.RLIM_INFINITY})` sebelum memulai inisialisasi apa pun. (Di Kernel >= 5.11 ini sudah dicabut, namun tetap krusial untuk OS lama).
2.  **Verifier Rejection (The 1,000,000 Instructions Limit):**
    Program C BPF Anda bisa terkompilasi (dengan `clang`) dengan sukses, tetapi gagal dimuat ke Kernel dengan error panjang karena Verifier Kernel menolak kode tersebut. Penyebabnya biasanya karena *loop* tidak jelas batasnya (*unbounded loops*) atau akses *memory pointer* paket belum di- *bound check* (memastikan `data + length < data_end`). *Error* eBPF verifier saat *load* dari Go harus dicetak utuh (`ebpf.Error.Errors`) agar developer bisa memperbaikinya.
3.  **Kernel Version Mismatch & CO-RE:**
    Membuat BPF yang merujuk struktur internal Kernel (seperti `task_struct` untuk memantau proses *exec*) sangat rentan pecah di versi kernel lain, karena layout strukturnya bergeser. Gunakan **BTF (BPF Type Format)** dan fitur CO-RE (*Compile Once - Run Everywhere*) dari paket cilium/ebpf. Ini memungkinkan Go secara ajaib membetulkan *offset struct memory* kernel di target mesin pada saat `Load()`, walau dikompilasi di mesin lain.

## 5. Production-Ready Go Code & Unit Test

Kode di bawah mensimulasikan kode ruang pengguna (*User Space*) Go yang akan memuat skrip BPF yang sudah dikompilasi (biasanya hasil `go generate` via `bpf2go`), menangani pendaftaran XDP (*eXpress Data Path*), dan memantau hitungan dari BPF Map.

```go
package ebpfgo

import (
	"context"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/rlimit"
)

// Catatan: Di dunia nyata, Anda menaruh anotasi "//go:generate go run github.com/cilium/ebpf/cmd/bpf2go xdp counter.c"
// Hasilnya akan memunculkan struct xdpObjects. Untuk mensimulasikan kode ini agar bisa dikompilasi,
// kita pura-pura xdpObjects ini dihasilkan oleh bpf2go.
type xdpObjects struct {
	xdpPrograms
	xdpMaps
}
type xdpPrograms struct {
	XdpDropFunc *ebpf.Program `ebpf:"xdp_drop_func"`
}
type xdpMaps struct {
	PktCountMap *ebpf.Map `ebpf:"pkt_count_map"`
}

// LoadAndAttachXDP menginisialisasi limit dan menyisipkan XDP BPF ke interface jaringan
func LoadAndAttachXDP(ctx context.Context, ifaceName string, objs *xdpObjects) (link.Link, error) {
	// 1. Edge Case Handler: Naikkan batas Memlock untuk kernel lama
	if err := rlimit.RemoveMemlock(); err != nil {
		return nil, fmt.Errorf("failed to remove memlock: %w", err)
	}

	// 2. Dapatkan objek net.Interface dari OS
	iface, err := net.InterfaceByName(ifaceName)
	if err != nil {
		return nil, fmt.Errorf("lookup network iface %s: %w", ifaceName, err)
	}

	// Dalam skenario asli, Anda memanggil `loadXdpObjects(objs, nil)` hasil dari bpf2go.
	// Jika objs.XdpDropFunc masih nil setelah diload, gagal.
	if objs.XdpDropFunc == nil {
		return nil, fmt.Errorf("bpf program is nil, load failed")
	}

	// 3. Attach ke Interface
	l, err := link.AttachXDP(link.XDPOptions{
		Program:   objs.XdpDropFunc,
		Interface: iface.Index,
	})
	if err != nil {
		return nil, fmt.Errorf("could not attach XDP program: %w", err)
	}

	return l, nil
}

// MonitorMap mencetak perubahan angka hitungan drop setiap 1 detik.
// Berhenti secara aman saat context dicancel.
func MonitorMap(ctx context.Context, m *ebpf.Map) error {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	// Keys yang kita ukur (Misal: Protocol ID. 1 untuk ICMP/Ping)
	var protocolKey uint32 = 1 

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			var value uint64
			// Membaca BPF Map (Aman antar User/Kernel Space)
			err := m.Lookup(protocolKey, &value)
			if err != nil {
				// Biasanya error ErrKeyNotExist jika belum ada map entry (bukan fatal)
				continue
			}
			fmt.Printf("[XDP Monitor] Protocol 1 dropped %d packets\n", value)
		}
	}
}

// -------------------------------------------------------------------------
// Unit Test
// -------------------------------------------------------------------------
func TestEBPFXdpLoader(t *testing.T) {
	// Tes ini sangat tricky di CI karena eBPF butuh root dan kapabilitas CAP_SYS_ADMIN.
	// Kami asumsikan bpf2go tidak dijalankan di test file ini untuk menghindari build error.
	
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// Dummy object hasil generate. Karena ini nil struct, func Attach akan error, 
	// yang mana hal yang BENAR dalam validasi tes defensif.
	objs := &xdpObjects{} 

	// Mencoba melampirkan ke loopback
	iface := "lo"
	lnk, err := LoadAndAttachXDP(ctx, iface, objs)
	
	if err == nil {
		// Jika ini berhasil padahal dummy, ada yang salah di mock
		lnk.Close()
		t.Fatalf("Expected failure due to dummy bpf code, but succeeded")
	}

	// Ekspektasi adalah program bpf masih nil 
	if err.Error() != "bpf program is nil, load failed" {
		t.Errorf("Unexpected error: %v", err)
	}
}
```

## Kapan JANGAN Pakai Ini

- **Bila metrik dan trace biasa sudah cukup.** eBPF mengikat kode Anda pada versi kernel dan menambah lapisan yang hanya sedikit orang di tim bisa debug. Pakai ketika Anda benar-benar butuh melihat apa yang tidak bisa diinstrumentasi dari ruang pengguna.
- **Program yang tidak diuji terhadap verifier di setiap versi kernel target.** Program yang lolos di kernel 6.1 bisa **ditolak** di 5.10, dan penolakannya terjadi saat start di node yang kebetulan lebih tua.
- **Map tanpa batas ukuran.** Map eBPF menempati memori kernel yang tidak bisa di-swap. Map yang tumbuh tanpa batas akan mendorong node ke tekanan memori yang mempengaruhi semua beban kerja di sana.
- **eBPF untuk logika bisnis.** Ia untuk observasi, penyaringan, dan pengarahan lalu lintas. Aturan bisnis di dalam kernel tidak bisa diuji, tidak bisa didebug dengan alat biasa, dan mengubahnya menuntut hak akses tinggi.
- **Menjalankan di produksi tanpa uji pada versi kernel yang persis sama.** Perbedaan kernel minor bisa mengubah struktur yang Anda baca, dan hasilnya berupa angka yang salah, bukan galat.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Program ditolak saat start di sebagian node | versi kernel per node | Verifier berbeda antar versi |
| Node mengalami tekanan memori | ukuran map eBPF | Map tumbuh tanpa batas |
| Angka dari eBPF tidak masuk akal | struktur kernel yang dibaca | Layout berubah antar versi kernel |
| Sulit mendiagnosis saat ada masalah | siapa yang bisa membaca program | Pengetahuan terkonsentrasi di satu orang |
| Beban CPU kernel naik | frekuensi hook | Program terpasang di jalur terlalu panas |

```bash
# Program dan map yang benar-benar terpasang
bpftool prog show
bpftool map show

# Memori yang dipakai map eBPF -- tidak bisa di-swap
bpftool map show | grep -oE 'max_entries [0-9]+' | head

# Versi kernel di seluruh node: program WAJIB diuji pada semuanya
kubectl get nodes -o custom-columns='NODE:.metadata.name,KERNEL:.status.nodeInfo.kernelVersion'

# Penolakan verifier muncul di dmesg
dmesg | grep -i bpf | tail -20
```
