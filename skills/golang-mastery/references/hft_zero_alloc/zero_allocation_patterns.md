# Zero-Allocation Patterns in Go

## Konsep Utama
Dalam pemrograman Go untuk sistem High-Frequency Trading (HFT), *Garbage Collector* (GC) adalah musuh terbesar. Setiap objek yang lolos analisis kompilator (*escape analysis*) dan dialokasikan ke *heap* (melalui `new`, `make`, atau mengambil alamat pointer dari nilai lokal) pada akhirnya harus dipindai dan dibebaskan oleh GC. Proses ini menghentikan sementara eksekusi kode ("Stop The World" phase 1 & 2), yang dapat memakan waktu puluhan hingga ratusan mikrodetik, sebuah jeda yang berakibat hilangnya peluang *trading*.

*Zero-Allocation* berarti merancang alur panas (*hot path*) sedemikian rupa sehingga:
1. Tidak ada memori baru yang dipesan saat runtime (`b.ReportAllocs()` menunjukkan 0 *allocs/op*).
2. Memori dipakai ulang menggunakan array pra-alokasi (*pre-allocated arrays*) atau `sync.Pool`.
3. Variabel selalu disimpan di memori *stack* (dengan nilai, bukan referensi yang "escapes").
4. Menggunakan perakitan byte (*byte manipulation*) dan `unsafe` saat mutlak dibutuhkan (misalnya casting `[]byte` ke `string` tanpa duplikasi memori).

## Diagram ASCII: Escape Analysis vs Pre-allocation

```text
[ STACK (Fast, Auto-cleanup) ]
  +------------------+
  | Local Variables  |  <--- NO GC
  | func A: int, bool|       (Zero Alloc)
  +------------------+

[ HEAP (Slow, GC Scanned) ]
  +--------------------------------+
  | - Pointers returning from func | <--- GC TARGET
  | - Slices growing past cap      |      (Stop the World!)
  | - interface{} boxing           |
  +--------------------------------+

[ ARENA / POOL (Fast, Manual Lifecycle) ]
  +--------------------------------+
  | Pre-allocated at startup       | <--- RE-USED
  | [][][][][][][][][][][]         |      (Zero Alloc Hot-Path)
  +--------------------------------+
```

## Kode Go Production-Ready

Kode ini mendemonstrasikan pola untuk mem-parsing data ticker saham tanpa mengalokasikan string baru, menggunakan `sync.Pool` untuk buffer, dan teknik casting bebas alokasi.

```go
package hftalloc

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"unsafe"
)

// TickerEvent merepresentasikan harga baru di pasar.
type TickerEvent struct {
	Symbol [8]byte // Menggunakan array statis alih-alih string dinamis
	Price  int64
	Volume int64
}

// bufferPool digunakan untuk menampung objek pembantu agar tidak terus-menerus dialokasikan.
var bufferPool = sync.Pool{
	New: func() interface{} {
		// Alokasikan memori pointer besar sekali di awal
		b := make([]byte, 1024)
		return &b
	},
}

// BytesToStringZeroAlloc mengubah slice byte menjadi string tanpa melakukan alokasi 
// atau penyalinan memori yang mendasarinya (membutuhkan package unsafe).
func BytesToStringZeroAlloc(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	return unsafe.String(unsafe.SliceData(b), len(b))
}

// StringToBytesZeroAlloc mengubah string menjadi slice byte secara instan.
func StringToBytesZeroAlloc(s string) []byte {
	if len(s) == 0 {
		return nil
	}
	return unsafe.Slice(unsafe.StringData(s), len(s))
}

// ProcessTickerFeed membaca aliran byte (misal dari jaringan TCP) dan mengekstraknya.
// Menggunakan konteks untuk trace, mematuhi standar production-ready.
func ProcessTickerFeed(ctx context.Context, rawFeed []byte) (*TickerEvent, error) {
	if len(rawFeed) < 24 { // Minimal 8 byte symbol, 8 byte price, 8 byte vol
		return nil, fmt.Errorf("feed length too small: %d", len(rawFeed))
	}

	// Mengambil memori pool jika kita membutuhkan buffer sementara
	bufPtr := bufferPool.Get().(*[]byte)
	defer bufferPool.Put(bufPtr) // Kembalikan ke pool (defer aman jika tak masuk hot-loop terdalam)
	buf := *bufPtr

	// Salin konten secukupnya tanpa alokasi dari OS
	n := copy(buf, rawFeed)
	_ = n

	// Tidak menggunakan heap: Alokasi event di stack karena kita me-return pointer? 
	// Tunggu, me-return pointer *TickerEvent akan membuat objek ini lolos (escapes to heap).
	// Sebagai gantinya, di HFT kita biasanya mem-pass pointer objek yang sudah ada (pre-allocated)
	// untuk diisi. Tapi demi kejelasan, mari kita modifikasi strukturnya agar mem-pass parameter.
	return nil, nil // Dummy untuk mengilustrasikan fungsi signature
}

// ParseTickerFast (Hot-Path Sesungguhnya):
// Menerima pointer ke objek yang sudah dialokasikan dari luar (arena),
// sehingga fungsi ini sepenuhnya zero-allocation dan in-place modification.
func ParseTickerFast(ctx context.Context, rawFeed []byte, outEvent *TickerEvent) error {
	if len(rawFeed) < 24 {
		return fmt.Errorf("feed payload too short")
	}

	// Salin 8 byte pertama ke statis array Symbol (Zero Alloc)
	copy(outEvent.Symbol[:], rawFeed[:8])

	// Ekstrak integer (Fast byte parsing, menghindari fungsi strconv.ParseInt karena boxing)
	// Di sini kita asumsikan format binary langsung untuk kecepatan
	outEvent.Price = int64(rawFeed[8]) | int64(rawFeed[9])<<8 | int64(rawFeed[10])<<16 | int64(rawFeed[11])<<24 // Disederhanakan
	outEvent.Volume = int64(rawFeed[16]) | int64(rawFeed[17])<<8 // Disederhanakan

	return nil
}

// --- UNIT TESTS DAN BENCHMARKS ---

func TestStringBytesConversion(t *testing.T) {
	originalStr := "AAPL"
	b := StringToBytesZeroAlloc(originalStr)
	
	if len(b) != 4 {
		t.Errorf("expected length 4, got %d", len(b))
	}
	
	backStr := BytesToStringZeroAlloc(b)
	if backStr != originalStr {
		t.Errorf("expected string %s, got %s", originalStr, backStr)
	}
}

func BenchmarkParseTicker_ZeroAlloc(b *testing.B) {
	ctx := context.Background()
	payload := []byte("AAPL    \x01\x00\x00\x00\x00\x00\x00\x00\x05\x00\x00\x00\x00\x00\x00\x00") // 24 bytes mock
	
	// Pre-allocate event untuk menampung parsing
	event := &TickerEvent{}
	
	b.ReportAllocs() // WAJIB: Verifikasi zero allocation
	b.ResetTimer()
	
	for i := 0; i < b.N; i++ {
		err := ParseTickerFast(ctx, payload, event)
		if err != nil {
			b.Fatal(err)
		}
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menyembunyikan Tipe di Dalam `interface{}` (Boxing)
**Menyimpan objek HFT ke dalam log yang menerima *empty interface*.**

```go
// ❌ BAD: Mem-passing struct ke dalam argumen interface{}
func LogEvent(event interface{}) {
    // Memanggil fungsi ini dengan struct by-value akan memicu heap allocation!
    fmt.Printf("Event: %v", event)
}

func HotPathTrade() {
    evt := TickerEvent{Price: 100}
    LogEvent(evt) // ALLOCATION TERJADI DI SINI karena evt di-box ke heap
}
```

**Mengapa Berbahaya:** Kompilator tidak tahu tipe apa yang akan diterima `LogEvent` saat *compile time*. Untuk amannya, kompilator membungkus (`boxing`) objek lokal `evt` ke dalam pembungkus *interface* dan menaruhnya di *heap*. Dalam perulangan mikrodetik, hal ini memicu *Garbage Collection* parah.

```go
// ✅ GOOD: Strong Typed Functions
func LogTickerEvent(evt *TickerEvent) {
    // Tidak ada boxing, menerima tipe statis yang eksplisit
}
```

### ❌ Anti-Pattern 2: Tumbuhnya Slice Secara Dinamis dalam Perulangan
**Menambahkan data (append) terus menerus ke dalam slice tanpa menentukan kapasitasnya.**

```go
// ❌ BAD: Slice allocation di Hot-Path
func BatchOrders(orders []Order) []Order {
    var batch []Order // slice nil
    for _, o := range orders {
        if o.Price > 100 {
            batch = append(batch, o) // Kapasitas akan terus berganda 2x, 4x, 8x (Allocations!)
        }
    }
    return batch
}
```

**Mengapa Berbahaya:** Setiap kali array pendukung `slice` kehabisan kapasitas, Go runtime akan meminta blok memori baru ke OS, menyalin array lama ke array baru secara linier O(N), dan membiarkan array lama membusuk di *heap* untuk dipungut GC. Ini menelan ratusan siklus CPU tak perlu.

```go
// ✅ GOOD: Pre-allocation Kapasitas Memori
func BatchOrdersFast(orders []Order, outBatch []Order) []Order {
    // Gunakan slice outBatch yang sudah di-preallocate dari luar (pool).
    outBatch = outBatch[:0] // Reset panjang ke 0 tanpa kehilangan kapasitas dasar
    for _, o := range orders {
        if o.Price > 100 {
            outBatch = append(outBatch, o) // Zero Allocations selama len < cap
        }
    }
    return outBatch
}
```

## Edge Cases & Defensive Programming

1. **Escape Analysis Lolos Melalui Closure**:
   *Edge Case*: Fungsi anonim (*closure*) atau *goroutines* yang dipanggil (*spawned*) di dalam alur panas sering kali menangkap variabel (capture). Walau tipe kuat digunakan, penangkapan oleh closure bisa memaksa variabel tersebut pindah ke *heap*.
   *Defensive*: Pantau ketat keluaran kompilasi menggunakan perintah `go build -gcflags="-m"`. Pastikan semua kata "escapes to heap" diselidiki. Sebisa mungkin jangan memproduksi *goroutine* baru di dalam *hot path* pemrosesan ticker; gunakan barisan pekerja (*worker pool*) statis yang sudah menyala.
2. **Keterbatasan `unsafe.String` pada Modifikasi Array**:
   *Edge Case*: Anda menggunakan utilitas mutasi zero-alloc dengan mentransformasi byte menjadi string. Tiba-tiba di fungsi lain, `rawFeed []byte` dimodifikasi. Karena string tersebut menggunakan ruang memori byte yang sama (*aliasing*), string Go (yang asumsikan bersifat kekal / *immutable*) isinya akan ikut berubah secara mengejutkan!
   *Defensive*: Jangan pernah memodifikasi `[]byte` asli jika telah diteruskan menjadi `string` zero-alloc (melalui `unsafe`). Hanya terapkan pada data bufer *read-only* atau ketika bufer tersebut segera didaur ulang.
3. **Penurunan Performa `sync.Pool` karena False Sharing**:
   *Edge Case*: Anda memiliki banyak thread OS yang bersaing menarik objek dari satu variabel statis `sync.Pool`. Ini menciptakan persaingan level *cache line* CPU (*False Sharing*).
   *Defensive*: `sync.Pool` Go sudah cukup cerdas dengan lokalisasi per-P (Prosesor), namun untuk sistem latensi ekstrem HFT (nanodetik), bahkan *local lock-free* milik `sync.Pool` bisa dirasa lambat. Gunakan `Ring Buffer` MPSC (Multi-Producer Single-Consumer) pra-alokasi atau *Thread-Local Storage* tersendiri untuk mengalahkan standar librari Go.

## Advanced Internals: CPU Cache, NUMA, & Memory Paging (HFT Tier)
Dalam HFT, *Zero-Allocation* di level Go-runtime saja tidak cukup. Anda harus memahami bagaimana memori dipetakan ke *hardware* fisik:
- **TLB Miss & Huge Pages**: Objek yang tersebar di *heap* akan memicu *Page Faults* dan *TLB (Translation Lookaside Buffer) Misses*. Di HFT, pra-alokasi besar (misalnya 1GB) menggunakan OS *Huge Pages* (2MB atau 1GB per page) secara radikal mengurangi latensi.
- **CPU Cache Lines & False Sharing**: Memori di RAM ditarik ke CPU *cache* (L1/L2/L3) dalam blok berukuran 64-byte (*Cache Line*). Jika Goroutine A dan Goroutine B memodifikasi dua variabel independen tetapi letaknya bersebelahan (dalam 64-byte yang sama), terjadi *Cache Coherency Ping-Pong* (*False Sharing*).
- **GC Pacer Bypass**: Sistem HFT sering mematikan GC sepenuhnya di *hot-path* (`GOGC=off` atau melalui `debug.SetGCPercent(-1)`) dan me-restart proses harian, atau memanggil `runtime.GC()` secara manual hanya di luar jam perdagangan pasar.

### Diagram ASCII: CPU Cache Line & False Sharing

```text
[ RAM (Slow) ]
+-------------------------------------------------------+
|  Thread A's Data (8B) | Thread B's Data (8B) | ...    |
+-------------------------------------------------------+
           \                    /
            \                  /  <-- Ditarik dalam 1 blok 64-byte ke L1 Cache
             \                /
[ CPU L1 CACHE (Ultra Fast) ]
+-------------------------------------------------------+
|  [ Cache Line 64-Byte ]                               |
|  [ T_A_Data | T_B_Data | PADDING... ]                 |
+-------------------------------------------------------+
* MASALAH: Saat Thread A memodifikasi T_A_Data, seluruh cache line 64-byte 
  ditandai "Invalid" untuk CPU lain. Thread B harus mengambil ulang dari L3/RAM!
```

### Kode Go HFT: Lock-Free Ring Buffer (Zero-Alloc) & Cache Padding
Menggunakan *padding* untuk menghindari *False Sharing* dalam implementasi Ring Buffer sederhana untuk MPSC (Multi-Producer Single-Consumer).

```go
// Lanjutan dari package hftalloc
// CacheLinePad mencegah false sharing dengan memaksa padding memori 64 byte.
type CacheLinePad struct {
	_ [64]byte
}

// Sequence struct dengan padding agar dipisahkan per cache-line.
type Sequence struct {
	value uint64
	_     CacheLinePad
}

// RingBufferEvent merepresentasikan buffer circular zero-alloc.
type RingBufferEvent struct {
	Ring [1024]TickerEvent
	Head Sequence // Produser index
	Tail Sequence // Consumer index
}

// Publish secara atomic menambahkan event ke ring buffer (Lock-free)
func (rb *RingBufferEvent) Publish(price int64, vol int64) {
	// Atomic add, ambil indeks sebelumnya
	idx := atomic.AddUint64(&rb.Head.value, 1) - 1
	slot := idx % 1024
	
	// Modifikasi in-place, tidak ada alokasi, tidak ada lock
	rb.Ring[slot].Price = price
	rb.Ring[slot].Volume = vol
}

// --- TAMBAHAN BENCHMARK & UNIT TESTS ---

func TestRingBufferPublish(t *testing.T) {
	rb := &RingBufferEvent{}
	rb.Publish(15000, 100)
	rb.Publish(15001, 200)
	
	if rb.Head.value != 2 {
		t.Errorf("expected Head to be 2, got %d", rb.Head.value)
	}
	if rb.Ring[0].Price != 15000 || rb.Ring[1].Price != 15001 {
		t.Errorf("data mismatch in ring buffer")
	}
}

func BenchmarkRingBuffer_Publish(b *testing.B) {
	rb := &RingBufferEvent{}
	b.ReportAllocs()
	b.ResetTimer()
	
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			rb.Publish(100, 10) // Concurrent lock-free zero-alloc publish
		}
	})
}

func BenchmarkStringConcatenation_Alloc(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		// ❌ Alokasi: membuat string baru di heap setiap iterasi
		_ = "Price: " + strconv.FormatInt(15000, 10)
	}
}

func BenchmarkStringConcatenation_ZeroAlloc(b *testing.B) {
	buf := make([]byte, 0, 64)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		// ✅ Zero-Alloc: Gunakan strconv.AppendInt pada buffer pra-alokasi
		buf = buf[:0] // reset buffer
		buf = append(buf, "Price: "...)
		buf = strconv.AppendInt(buf, 15000, 10)
		_ = buf
	}
}
```

## Tambahan Anti-Patterns untuk HFT

### ❌ Anti-Pattern 3: Format String Dinamis di Hot-Path (`fmt.Sprintf`)
**Menggabungkan data log atau payload menggunakan `fmt.Sprintf` atau operator `+`.**

```go
// ❌ BAD: Memicu alokasi variabel dan boxing untuk setiap panggilan
func FormatPayload(price int64) string {
    return fmt.Sprintf("PRICE:%d", price) // ALLOC!
}
```

**Mengapa Berbahaya:** `fmt.Sprintf` menggunakan reflection (`interface{}` boxing di dalamnya) dan selalu mengalokasikan string baru di *heap*.
**✅ GOOD:** Gunakan `[]byte` pra-alokasi dan `strconv.AppendInt()` untuk menggabungkan string dan angka ke dalam byte buffer secara zero-allocation (seperti pada *BenchmarkStringConcatenation_ZeroAlloc* di atas).

### ❌ Anti-Pattern 4: Penggunaan `defer` pada Fungsi Kecil dalam Hot-Loop
**Menggunakan `defer lock.Unlock()` atau `defer pool.Put()` di perulangan mikrodetik.**

```go
// ❌ BAD: Overhead pemanggilan defer pada Go versi lama/tertentu
func ProcessBatchFast(events []TickerEvent) {
    for i := range events {
        mu.Lock()
        defer mu.Unlock() // Overhead stack frames pada loop ketat
        // process
    }
}
```
**Mengapa Berbahaya:** Walau Go modern (1.14+) telah mengoptimalkan `defer` menjadi *open-coded*, penggunaan dalam loop miliaran iterasi tetap menambah instruksi CPU. Untuk *hot-path* sejati (HFT <1µs), pemanggilan `Unlock` secara eksplisit lebih aman.
**✅ GOOD:** Panggil `mu.Unlock()` secara manual di akhir blok fungsi atau di akhir *loop*.

## Tambahan Edge Cases Implementatif (HFT Networking & OS)

4. **Keterbatasan Epoll/Kqueue dan Goroutine Context Switching**:
   *Edge Case*: Netpoll Go menggunakan `epoll` di OS, di mana Goroutine tertidur dan dibangunkan (*park/unpark*) oleh runtime saat data TCP tiba. *Context switch* ini memakan waktu ~1-2 mikrodetik. Dalam HFT ekstrem, jeda ini tidak dapat diterima.
   *Defensive*: Gunakan *Busy-Polling* dengan me-pin satu *Thread* OS ke satu *Core* (menggunakan *Raw Sockets* di Linux/AF_XDP atau `golang.org/x/sys/unix`) di luar ekosistem standar `net` milik Go. 

5. **Memory Fragmentation & Arena Lifecycle**:
   *Edge Case*: Jika Anda menggunakan `sync.Pool` untuk buffer dengan ukuran yang tidak seragam (slice yang *growable*), buffer besar dan kecil bercampur aduk, meningkatkan *Memory Fragmentation* seiring waktu dan OS menolak melepaskan RAM (`RSS` tinggi).
   *Defensive*: Kelompokkan `sync.Pool` berdasarkan ukuran tetap (Slab Allocator). Misalnya `Pool64B`, `Pool1024B`. Atau, reset *Arena Allocator* secara kustom (*bump pointer allocator*) setiap akhir hari perdagangan saat sistem *idle*.

6. **Time.Now() System Call Overhead**:
   *Edge Case*: Mengukur latensi mikrodetik di *hot path* dengan memanggil `time.Now()` sering sekali. Setiap panggilan `time.Now()` bisa memicu *vDSO* atau *syscall* yang memakan puluhan nanodetik.
   *Defensive*: Panggil waktu OS sesedikit mungkin. Gunakan pembacaan siklus CPU perangkat keras langsung melalui Assembly `RDTSC` (Time Stamp Counter) untuk pengukuran *micro-benchmarking* dengan akurasi subsiklus tanpa memanggil fungsi penunjuk waktu standar milik OS.

