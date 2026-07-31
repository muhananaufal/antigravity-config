# Network I/O Zero Copy (Kernel Bypass)

## Konsep Utama
Dalam ekosistem High-Frequency Trading (HFT), jaringan berbasis standar (*Standard TCP/IP Socket API*) adalah sebuah malapetaka latensi. Saat Anda membaca dari socket UDP/TCP Go konvensional (`net.Conn`), data jaringan melakukan perjalanan mahal:
1. Kartu Jaringan (NIC) menyalin (*copy*) paket ke Ring Buffer Memori Kernel via DMA.
2. Kernel Linux membangkitkan interupsi (*hardware interrupt*) dan memproses protokol TCP/IP.
3. Fungsi `Read()` pada Go memicu *System Call* (Context Switch dari User Space ke Kernel Space).
4. Data disalin *lagi* dari bufer Kernel ke bufer User Space (seperti `[]byte` di dalam program Go).

Latensi ini bisa memakan 10 - 50 mikrodetik per pesan. Pola **Zero Copy** dan **Kernel Bypass** meniadakan penyalinan perantara ini. Dalam HFT, kita menggunakan teknologi seperti `AF_XDP` (Linux eBPF), DPDK (Data Plane Development Kit), atau efisiensi mentah dari `epoll` bersama `mmap()`.

Tujuan dari *Zero Copy*: Mengarahkan penulisan perangkat keras DMA (Direct Memory Access) jaringan *secara langsung* ke alamat blok array memori dalam program kita di User Space, meniadakan intervensi Kernel sepenuhnya!

## Diagram ASCII: Standard I/O vs Kernel Bypass

```text
[ ARSITEKTUR KONEKSI STANDAR (Lambat) ]
 NIC -> [ DMA Copy ] -> Linux Kernel Space (TCP Stack) -> [ Syscall CPU Copy ] -> User Space (Go)
                     (Latensi Tinggi: Interrupt, Context Switch, Double Memcopy)

[ ZERO COPY & KERNEL BYPASS DENGAN DPDK/AF_XDP (Kecepatan Cahaya) ]
 NIC -----------------------------------------------------> User Space Memori Arena (Go)
       [ Zero-Copy DMA mem-bypass seluruh Linux OS Stack! ] 
                  (No Interrupts, dipoll manual dengan Goroutine 100% CPU Spin)
```

## Kode Go Production-Ready

Karena library eBPF (AF_XDP) atau CGO DPDK terlalu kompleks diilustrasikan tanpa prasyarat instalasi berat, di bawah ini kita menyimulasikan filosofi murni Zero-Copy parsing UDP dengan pra-alokasi memori penuh dari OS ke slice yang tak akan pernah berpindah/di-copy ke goroutine lain (Zero Allocation `Read` buffering).

```go
package hftalloc

import (
	"context"
	"fmt"
	"net"
	"testing"
)

// NetworkFeed merepresentasikan payload ringkas paket mentah
type NetworkFeed struct {
	Header int32
	Data   [60]byte
}

// ZeroCopyUDPListener membungkus operasi socket UDP rendah-interupsi Go
type ZeroCopyUDPListener struct {
	conn       *net.UDPConn
	// Buffer tunggal statis, kita tidak membuat `make([]byte)` per panggilan Read!
	readBuffer []byte 
}

func NewZeroCopyListener(address string) (*ZeroCopyUDPListener, error) {
	addr, err := net.ResolveUDPAddr("udp4", address)
	if err != nil {
		return nil, fmt.Errorf("resolving address: %w", err)
	}

	conn, err := net.ListenUDP("udp4", addr)
	if err != nil {
		return nil, fmt.Errorf("listening udp: %w", err)
	}

	// Tweak SO_RCVBUF Linux Socket agar Kernel mendrop paket yang lambat alih-alih buffer bengkak
	_ = conn.SetReadBuffer(1048576) // 1MB Ring Buffer

	return &ZeroCopyUDPListener{
		conn:       conn,
		// Menyiapkan bufer masif statis MTU (Maximum Transmission Unit) standar 1500 bytes
		readBuffer: make([]byte, 1500),
	}, nil
}

// PollNextMessage melakukan Zero Allocation Read.
// PENTING: Slice data yang di-return BENAR-BENAR menunjuk pada lokasi `readBuffer` tunggal.
// Jangan lewatkan (passing) ke goroutine lain tanpa penyalinan manual jika goroutine itu menunda proses!
func (l *ZeroCopyUDPListener) PollNextMessage(ctx context.Context) ([]byte, error) {
	// Sistem operasi menyalin paket mentah L2/L3 LANGSUNG ke memori l.readBuffer kita (User space)
	n, _, err := l.conn.ReadFromUDP(l.readBuffer)
	if err != nil {
		return nil, fmt.Errorf("read failed: %w", err)
	}
	
	// Zero-copy retriksi irisan (slice bounds). Ini hanyalah pointer, BUKAN alokasi memori baru!
	return l.readBuffer[:n], nil
}

// --- UNIT TESTS DAN BENCHMARKS ---

// Kita buat server tiruan UDP di belakang untuk Test & Bench.
func mockUDPServer(t *testing.T, payload []byte) *net.UDPConn {
	addr, _ := net.ResolveUDPAddr("udp4", "127.0.0.1:0")
	conn, _ := net.ListenUDP("udp4", addr)
	go func() {
		for {
			_, _ = conn.WriteToUDP(payload, addr)
		}
	}()
	return conn
}

func BenchmarkUDP_ZeroAlloc_Read(b *testing.B) {
	// Dalam tes ini, kita tidak membuat koneksi beneran, 
	// kita asumsikan pemanggilan l.conn.ReadFrom() dimock dengan salinan statis.
	listener := &ZeroCopyUDPListener{
		readBuffer: make([]byte, 1500),
	}
	ctx := context.Background()
	payload := []byte("SIMULATED_MARKET_DATA_PACKET_64BYTES")
	
	b.ReportAllocs() // WAJIB: Buktikan bahwa membaca data UDP tidak menghasilkan objek Heap!
	b.ResetTimer()
	
	for i := 0; i < b.N; i++ {
		// Mock simulasi Kernel DMA copy ke UserSpace array (l.readBuffer)
		n := copy(listener.readBuffer, payload)
		
		// Return array yang di-slice
		msg := listener.readBuffer[:n]
		
		if len(msg) == 0 {
			b.Fatal("unexpected empty")
		}
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengalokasikan Bufer Per Paket (Heap Escape)
**Pembuatan slice byte baru setiap kali mendengarkan paket masuk di goroutine `net.Conn`.**

```go
// ❌ BAD: Memory churn (Sampah GC per Paket)
func ReadNetworkLoop(conn net.Conn) {
    for {
        buf := make([]byte, 1024) // ALOKASI: Dijalankan 10 juta kali sedetik!
        n, _ := conn.Read(buf)
        go Process(buf[:n]) // Goroutine baru dan pelarian Heap!
    }
}
```

**Mengapa Berbahaya:** Bayangkan koneksi OUCH NASDAQ yang menyemburkan pesan multicast dengan laju 5-10 juta paket per detik di pembukaan market (Market Open). Jika Anda membuat array `1024 byte` per pesan, Go Runtime Anda akan berjuang mengalokasikan 10 GigaByte sampah memori per detik. GC akan sepenuhnya menghentikan CPU core aplikasi dan mencungkil (*stall*) sistem HFT Anda selama puluhan milidetik. Paket UDP selanjutnya akan ditendang / didepak oleh Kernel ke laci sampah (Dropped Packets).

```go
// ✅ GOOD: Satu Bufer Statis dalam Thread Pemintal (Spin Thread)
func ReadNetworkLoop(conn net.Conn) {
    buf := make([]byte, 1500) // 1 Kali saat startup
    for {
        n, _ := conn.Read(buf) 
        // Parsing nilai primitif LANGSUNG dari irisan buf (tanpa mengamankan pointer)
        ProcessSynchronous(buf[:n]) 
    }
}
```

### ❌ Anti-Pattern 2: Pembacaan Terpisah lewat `io.Reader` Abstrak HFT
**Membungkus koneksi socket dengan wrapper seperti `bufio.Reader` atau `io.ReadFull`.**

```go
// ❌ BAD: Overhead Interface Call dan Penyalinan Ganda
func HFTRead(reader io.Reader) []byte {
    buf := make([]byte, 100)
    io.ReadFull(reader, buf) // Polymorphism interface{} overhead
    return buf
}
```

**Mengapa Berbahaya:** Pembungkus abstrak Go yang dirancang untuk web server (seperti `bufio`) menelan banyak abstraksi *interface polymorphism*, memori *struct* di belakang layar, dan yang terpenting: *Copying*. `bufio` memindahkan data dari socket kernel -> *buffer bufio internal* -> lalu di-copy lagi ke *buffer `buf` milik Anda*. (Dua salinan berantai). 

## Edge Cases & Defensive Programming

1. **Memory Aliasing pada Shared Read Buffer**:
   *Edge Case*: Anda membaca paket UDP (pesan #1) ke dalam `l.readBuffer`, lalu menyerahkan slice `msg1` ke *Order Engine*. Sebelum *Order Engine* memproses `msg1`, goroutine jaringan telah melanjutkan putaran (*loop*) dan membaca pesan masuk UDP (pesan #2) ke dalam buffer statis yang sama. Keterkejutan brutal terjadi: `msg1` milik *Order Engine* akan berisi data dari pesan #2 yang menimpa alamat byte!
   *Defensive*: Di aliran *Zero Copy*, komponen penerima bufer (seperti parser HFT) **HARUS** mengekstrak dan mem-parsing tipe data murni (seperti `int64` harga) dari byte secara instan, persis di utas (*thread*) yang sama tanpa pendelegasian. Jika delegasi dibutuhkan, *Ring Buffer Lock-Free* MPSC/SPSC memori dalam yang pra-alokasi harus dipakai!
2. **Kelelahan Antrean Ring Kernel (UDP Drop Buffer)**:
   *Edge Case*: UDP tidak memilliki konfirmasi TCP ACK. Jika HFT Go Anda mengeksekusi dagang agak lamban di suatu siang (misal karena *Disk I/O Logging* yang ngawur memblokir goroutine), ring buffer UDP internal OS Kernel Linux cepat penuh. Linux akan diam-diam menghapus (*drop*) pesan pasar penting, menciptakan "Data Gap" di otak *trading algorithm* Anda.
   *Defensive*: Sesuaikan Linux *sysctls* untuk HFT: naikan batas `net.core.rmem_max` menjadi 16-64MB. Setel ukuran buffer di sisi program dengan `conn.SetReadBuffer(16777216)`. Perlu ditekankan: *Zero Copy* via paket mentah (seperti *pcap* bind) atau AF_XDP eBPF lebih tangguh menghadapi rentetan UDP (microburst) karena aplikasilah yang menyedot DMA.
3. **Hardware Interrupt Affinity & NUMA Nodes**:
   *Edge Case*: Kartu NIC (Network Card) PCIe dicolokkan ke motherboard CPU Core 1 (NUMA Node 0). Tapi Anda menjalankan Go routine HFT Poller di CPU Core 8 (NUMA Node 1). Ada penalti laten karena memori bergeser antar bus silikon.
   *Defensive*: Saat mengonfigurasi AF_XDP/DPDK *Zero Copy* Engine Go, Anda HARUS menggunakan utilitas OS *taskset* atau CPU Pinning (contoh `runtime.LockOSThread()`) dan mengikat eksekusi utas aplikasi persis di inti CPU (*core*) yang berafiliasi dengan letak fisik kartu *Network Adapter* untuk menghapus *Cross-NUMA penalty*.
4. **System Call Overhead pada Polling Non-Blocking**:
   *Edge Case*: Menggunakan `epoll` atau `select` secara terus-menerus memicu system call `epoll_wait` yang memakan waktu ~500-1000ns. Di HFT, ini terlalu lama.
   *Defensive*: Gunakan 100% *CPU busy-polling* (spin loop) untuk membaca status ring buffer secara langsung dari memory-mapped file UMEM di user space, menghindari syscall sama sekali selama jam trading aktif.

### ❌ Anti-Pattern 3: Menggunakan `defer`, `time.Timer`, atau `Goroutine Spawning` di Hot Path
**Menggunakan abstraksi Go Runtime yang memicu alokasi heap tersembunyi atau penjadwalan.**

```go
// ❌ BAD: Memicu alokasi dan intervensi scheduler
func ProcessPacket(msg []byte) {
    defer log.Println("Processed") // ❌ Heap allocation & overhead
    go parseOrder(msg)             // ❌ Context switch (Goroutine creation)
}

// ✅ GOOD: Panggil secara sinkron, gunakan inline, hindari Go Scheduler di Hot Path
func ProcessPacketSync(msg []byte) {
    parseOrderInline(msg)
}
```

**Mengapa Berbahaya:** `defer` pada loop yang berjalan jutaan kali sedetik memakan CPU cycles yang signifikan untuk mengatur linked list dari fungsi yang ditunda (meski open-coded defer di Go 1.14+ lebih cepat, tetap ada overhead instruksi). Membuat goroutine (`go func()`) memiliki latensi scheduling (sekitar 2-10 mikrodetik) yang bisa berakibat tertinggalnya order di antrean bursa.

## Internals Mendalam: AF_XDP dan UMEM Ring Buffers

AF_XDP (Address Family eXpress Data Path) adalah fitur kernel Linux yang mem-bypass TCP/IP stack dan mengirim frame mentah langsung ke *User Space* melalui memori bersama (*shared memory* / `mmap`).

Inti dari AF_XDP adalah **UMEM** (User Memory) dan 4 jenis antrean sirkular (*Ring Buffers*):
1. **Fill Ring**: Aplikasi User-Space memberikan alamat UMEM (pointer) kosong ke Kernel.
2. **RX Ring**: Kernel meletakkan paket masuk ke alamat UMEM tersebut dan mengembalikan pointer ke RX Ring.
3. **TX Ring**: Aplikasi memberikan pointer UMEM berisi data untuk dikirim ke Kernel.
4. **Completion Ring**: Kernel mengembalikan pointer UMEM ke aplikasi setelah transmisi selesai.

### Diagram ASCII: AF_XDP Memory Mapped Ring Buffers

```text
[ USER SPACE (Aplikasi Go HFT) ]
       |                                      ^
       v                                      |
+-------------+                        +-------------+
|  FILL RING  | (Memberi alamat UMEM   |   RX RING   | (Menerima index memori 
| [0x10, 0x20]|  kosong ke Kernel)     | [0x10, 0x20]|  berisi paket data)
+-------------+                        +-------------+
       |                                      ^
-------|--------------------------------------|-----------------
[ KERNEL SPACE (eBPF / AF_XDP) ]              |
       v                                      |
  (Kernel menulis paket jaringan langsung ke UMEM via DMA)
       |                                      |
       +------------> [ UMEM ] ---------------+
               (Blok Memori Berbagi / memory-mapped)
               [ 0x10: 64 byte packet ]
               [ 0x20: 128 byte packet]
-------|--------------------------------------------------------
[ HARDWARE (NIC) ]
       +---> (DMA Transfer paket dari Kabel langsung ke UMEM)
```

## Advanced Go Code: AF_XDP UMEM Zero-Alloc Simulation

Berikut adalah simulasi ring buffer `AF_XDP` *Lock-Free* menggunakan operasi atomik (`sync/atomic`) di Go. Tidak ada *mutex* maupun *channel*, 100% Zero Allocation polling.

```go
package hftalloc

import (
	"runtime"
	"sync/atomic"
	"testing"
)

const UMEMSize = 4096
const FrameSize = 128

// XDPUMEM menyimulasikan memory mapped file yang dibagi dengan NIC/Kernel
type XDPUMEM struct {
	memory [UMEMSize * FrameSize]byte
}

// LockFreeRXRing menyimulasikan RX Ring tempat Kernel meletakkan paket
type LockFreeRXRing struct {
	head uint64 // Ditulis oleh Kernel (Producer)
	tail uint64 // Dibaca & Ditulis oleh Aplikasi Go (Consumer)
	mask uint64
	ring []uint32 // Berisi index (offset) ke dalam UMEM
}

func NewLockFreeRXRing(capacity uint32) *LockFreeRXRing {
	return &LockFreeRXRing{
		head: 0,
		tail: 0,
		mask: uint64(capacity - 1),
		ring: make([]uint32, capacity),
	}
}

// Poll mengambil 1 paket dari ring buffer TANPA syscall, mutlak zero-alloc.
// Ini di-loop pada 100% CPU (Busy Polling) di thread HFT utama.
func (r *LockFreeRXRing) Poll(umem *XDPUMEM) ([]byte, bool) {
	currentTail := atomic.LoadUint64(&r.tail)
	currentHead := atomic.LoadUint64(&r.head) // Load status dari Kernel

	if currentTail == currentHead {
		return nil, false // Ring kosong, tidak ada paket baru
	}

	// Ambil indeks frame dari ring buffer
	frameOffset := r.ring[currentTail&r.mask]
	
	// Increment consumer tail
	atomic.StoreUint64(&r.tail, currentTail+1)

	// Zero-copy retriksi array (slice pointer) langsung ke UMEM, mutlak alokasi 0
	return umem.memory[frameOffset : frameOffset+FrameSize], true
}

// SimulateKernelPush menyimulasikan interupsi DMA Kernel menulis ke Ring
func (r *LockFreeRXRing) SimulateKernelPush(offset uint32) {
	currentHead := atomic.LoadUint64(&r.head)
	r.ring[currentHead&r.mask] = offset
	atomic.StoreUint64(&r.head, currentHead+1)
}
```

## Additional Unit Tests & Benchmarks

Selain dari tes standar UDP, pengujian buffer Lock-Free di ranah HFT berfokus pada througput latensi-rendah ekstrem.

```go
// ... (Pastikan `testing`, `sync/atomic`, `runtime` diimport di awal file package ini)

func TestZeroCopy_PollNextMessage(t *testing.T) {
	listener := &ZeroCopyUDPListener{
		readBuffer: make([]byte, 1500),
	}
	
	// Simulasikan kernel mengisi bufer
	expected := "ORDER_MATCH_1234"
	copy(listener.readBuffer, expected)
	
	msg := listener.readBuffer[:len(expected)]
	
	if string(msg) != expected {
		t.Fatalf("Expected %s, got %s", expected, string(msg))
	}
}

func TestAFXDP_RingBuffer_Empty(t *testing.T) {
	umem := &XDPUMEM{}
	rx := NewLockFreeRXRing(1024)
	
	_, ok := rx.Poll(umem)
	if ok {
		t.Fatal("Expected no packet on empty ring")
	}
}

func BenchmarkZeroCopy_UMEM_Simulation(b *testing.B) {
	umem := &XDPUMEM{}
	rx := NewLockFreeRXRing(1024)
	
	b.ReportAllocs()
	b.ResetTimer()
	
	// Skenario Producer-Consumer Asynchronous yang Sangat Cepat
	go func() {
		for i := 0; i < b.N; i++ {
			// Kernel push frame offset 0
			rx.SimulateKernelPush(0)
			// Beri nafas sedikit agar tidak over-run head-to-tail
			if i%100 == 0 {
				runtime.Gosched()
			}
		}
	}()
	
	received := 0
	for received < b.N {
		msg, ok := rx.Poll(umem)
		if ok {
			_ = msg[0] // Baca 1 byte untuk mencegah optimasi compiler menghilangkan variabel
			received++
		}
	}
}
```
