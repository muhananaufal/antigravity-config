# CPU Cache Optimization (Struct Layout)

> **Berlaku:** Go 1.21+ · x86-64 / arm64 · **Lihat juga:** `concurrency/atomic_lockfree_patterns.md` · `hft_zero_alloc/lock_free_ring_buffer.md` · `runtime_internals/memory_allocator_arenas.md` · `testing_quality/benchmarking_pprof.md`

## Konsep Utama
Dalam mikrokontroler dan High-Frequency Trading (HFT), memori RAM beroperasi jauh lebih lambat (ratusan siklus CPU) dibandingkan dengan Cache L1/L2 milik CPU (1-4 siklus). CPU tidak pernah mengambil data dari RAM dalam satuan byte individual, melainkan dalam bongkahan 64-byte yang disebut **Cache Line**.

Di bahasa Go, kompilator mengatur urutan memori (struct layout) persis seperti urutan penulisan kode sumber Anda. Kompilator sering menyisipkan *Padding* (byte kosong tak terlihat) di antara field untuk menjaga **Data Alignment** (misalnya, variabel `int64` harus diletakkan di alamat memori kelipatan 8 byte). 

Jika *struct* dirancang sembarangan, terjadi 3 isu kritikal:
1. **Bloat Struct Size**: Padding menyebabkan ukuran *struct* membengkak. Jika sebuah *struct* mengambil 2 Cache Line padahal data aktifnya bisa muat di 1 Cache Line, Anda akan memicu 2 kali perputaran lambat ke RAM (*Cache Miss*).
2. **Hot Path Grouping**: Kolom data yang dibaca bersamaan (misalnya *BidPrice* dan *BidQty*) harus diletakkan berdekatan untuk memaksimalkan *Spatial Locality*.
3. **False Sharing**: Jika dua *goroutine* memutasi dua variabel berbeda secara independen namun variabel tersebut berdekatan secara fisik dalam 1 *Cache Line* yang sama, maka L1 Cache dari kedua Core CPU akan terus melakukan invalidasi satu sama lain secara agresif (*Cache Coherency Ping-Pong*), yang menghancurkan latensi komputasi.

## Diagram ASCII: Struct Packing & False Sharing

```text
  [ L1 CACHE LINE 64 BYTES ]

  1. BAD LAYOUT (Padding Gaps)
  ┌──┬────────┬──┬────────┬──┬────────┐
  │B │ (Pad7) │I │        │B │ (Pad7) │ (B=byte, I=int64)
  └──┴────────┴──┴────────┴──┴────────┘

  2. GOOD LAYOUT (Compact & Dense)
  ┌──┬──┬────────┬────────────────────┐
  │B │B │I       │ (Sisa 54 bytes     │
  └──┴──┴────────┴────────────────────┘

  3. FALSE SHARING (Multi-Core Ping-Pong)
  Core 1 (Writes Flag) --> [ Flag1 | Flag2 ] <-- Core 2 (Writes Flag)
                             (Dalam 1 Cache Line, Core 1 dan Core 2 saling membatalkan)
```

## Kode Go Production-Ready

Kode di bawah ini mendemonstrasikan bagaimana kita mengemas *struct* secara efisien dan mencegah fenomena *False Sharing* menggunakan bantalan khusus (*padding manual*).

```go
package hftalloc

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"unsafe"
)

// HFTOrderBad memiliki tata letak yang buruk. Total size: 32 bytes!
// Susunan aslinya: 1 byte bool + 7 padding + 8 byte uint64 + 1 byte bool + 7 padding + 8 byte float
type HFTOrderBad struct {
	IsBuy     bool
	OrderID   uint64
	IsFOK     bool // Fill-or-Kill
	LimitPrc  float64
}

// HFTOrderGood diurutkan dari ukuran field terbesar (8 byte) ke terkecil (1 byte).
// Total size: 24 bytes! (25% lebih hemat memori, muat lebih banyak di L1 Cache)
type HFTOrderGood struct {
	OrderID   uint64
	LimitPrc  float64
	IsBuy     bool
	IsFOK     bool
	// Go akan menambahkan 6 byte padding di ekor struct agar pas (aligned ke 8)
}

// SharedCounters menunjukkan cara mendesain cache-line yang terisolasi.
// Ini mencegah False Sharing antar Goroutine.
type SharedCounters struct {
	// Goroutine 1 hanya akan menulis ke TradeCount
	TradeCount atomic.Uint64 
	
	// Pad1 memaksa field berikutnya untuk masuk ke Cache Line baru (64 byte)
	// uint64 sudah memakan 8 bytes, jadi kita butuh 56 bytes (64-8).
	Pad1 [56]byte 
	
	// Goroutine 2 hanya akan menulis ke CancelCount.
	// Karena dihalangi Pad1, ini berada di L1 Cache yang sepenuhnya berbeda dengan TradeCount.
	CancelCount atomic.Uint64 
}

// ProcessOrdersBad mensimulasikan agregasi yang boros memori dan rentan cache miss.
func ProcessOrdersBad(ctx context.Context, data []HFTOrderBad) (float64, error) {
	if len(data) == 0 {
		return 0, fmt.Errorf("empty order data")
	}
	var total float64
	for i := 0; i < len(data); i++ {
		// Mengakses struct besar dengan field berjauhan
		if data[i].IsBuy {
			total += data[i].LimitPrc
		}
	}
	return total, nil
}

// ProcessOrdersGood mensimulasikan agregasi cache-friendly (spatial locality optimal).
func ProcessOrdersGood(ctx context.Context, data []HFTOrderGood) (float64, error) {
	if len(data) == 0 {
		return 0, fmt.Errorf("empty order data")
	}
	var total float64
	// Karena struct lebih kecil, CPU bisa memuat (prefetch) ~2-3 struct 
	// langsung dalam 1 hit (64 bytes Cache Line).
	for i := 0; i < len(data); i++ {
		if data[i].IsBuy {
			total += data[i].LimitPrc
		}
	}
	return total, nil
}

// --- UNIT TESTS DAN BENCHMARKS ---

func TestStructMemoryLayout(t *testing.T) {
	badSize := unsafe.Sizeof(HFTOrderBad{})
	goodSize := unsafe.Sizeof(HFTOrderGood{})
	
	// Membuktikan Bad struct bengkak
	if badSize != 32 {
		t.Errorf("Expected HFTOrderBad to be 32 bytes, got %d", badSize)
	}
	
	// Membuktikan Good struct efisien
	if goodSize != 24 {
		t.Errorf("Expected HFTOrderGood to be 24 bytes, got %d", goodSize)
	}
	
	// Membuktikan isolasi Cache Line untuk Shared Counters
	counterSize := unsafe.Sizeof(SharedCounters{})
	if counterSize < 64 {
		t.Errorf("Expected SharedCounters to be at least 64 bytes (1 cache line), got %d", counterSize)
	}
}

func BenchmarkStruct_ZeroAlloc_Good(b *testing.B) {
	ctx := context.Background()
	arr := make([]HFTOrderGood, 100000)
	for i := range arr {
		arr[i].IsBuy = true
		arr[i].LimitPrc = 1.0
	}
	
	b.ReportAllocs() // MEMVERIFIKASI ZERO ALLOCATION
	b.ResetTimer()
	
	for i := 0; i < b.N; i++ {
		val, err := ProcessOrdersGood(ctx, arr)
		if err != nil || val == 0 {
			b.Fatalf("failed computation")
		}
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menyusun Struct Berdasarkan Domain Logika 
**Mengelompokkan *field* memori sesuai pemahaman bisnis tanpa peduli besaran byte.**

```go
// ❌ BAD: Membiarkan desain domain mengendalikan urutan variabel.
type TradeSession struct {
    IsActive bool    // 1 byte (+7 padding)
    SessionID int64  // 8 byte
    IsHoliday bool   // 1 byte (+7 padding)
    TotalVol  int64  // 8 byte
}
```

**Mengapa Berbahaya:** Pada sistem HFT, jika Anda menyimpan array `TradeSession` hingga 10 juta elemen di memori (*Memory Arena*), pembengkakan ini menghasilkan *overhead* memori hingga 40%. Pada titik tertentu, iterasi atas array ini akan menyentuh batas kapasitas RAM fisik atau meluap (*spill over*) melebihi L3 Cache, yang berujung pada kejatuhan drastis performa sistem (fenomena *Cache Miss Cliff*).

```go
// ✅ GOOD: Urutkan dari byte terbesar ke terkecil (atau gunakan fieldalignment linter)
type TradeSession struct {
    SessionID int64  // 8 byte
    TotalVol  int64  // 8 byte
    IsActive  bool   // 1 byte
    IsHoliday bool   // 1 byte 
                     // (+6 byte tail padding)
}
```

### ❌ Anti-Pattern 2: Melupakan Penyelarasan Mutex (*False Sharing*)
**Mendeklarasikan *Mutex* atau *Atomic Counters* di dalam struct tanpa padding, yang sering dipakai oleh Goroutine terpisah.**

```go
// ❌ BAD: Rawan terjadinya Cache Line Ping-Pong.
type HighFreqEngine struct {
    Trades atomic.Uint64 // Thread A terus menulis ini
    Cancels atomic.Uint64 // Thread B terus menulis ini
}
```

**Mengapa Berbahaya:** Meskipun variabel `Trades` dan `Cancels` dimutasi tanpa kunci secara aman (Atomic), letaknya hanya terpisah 8 byte. Mereka terperangkap di dalam *Cache Line* (64 bytes) yang sama. Saat Core 1 CPU memperbarui `Trades`, protokol *cache coherency* (seperti MESI) harus menginvalidasi (membuang) kopi seluruh Cache Line tersebut di memori lokal Core 2. Core 2 kemudian harus mengambil kembali dari RAM induk. Jika ini terjadi jutaan kali sedetik, CPU akan sibuk menunggu *Memory Bus* ketimbang mengeksekusi instruksi.

```go
// ✅ GOOD: Pisahkan dengan Padding Array 64 byte.
type HighFreqEngine struct {
    Trades atomic.Uint64
    _ [56]byte // Padding Cache Line pertama (64-8)
    Cancels atomic.Uint64
    _ [56]byte // Padding Cache Line kedua (opsional untuk keamanan)
}
```

## Edge Cases & Defensive Programming

1. **Efek Alignment pada Array/Slice Tail Padding**:
   *Edge Case*: Sebuah struct berakhiran dengan kolom berukuran `1 byte`. Secara mandiri ia hanya butuh sedikit byte. Namun fungsi `unsafe.Sizeof` mengatakan ia butuh kelipatan terbesar (misal 8 byte).
   *Defensive*: Selalu asumsikan struct Anda akan dimasukkan ke dalam slice (di mana kompilator butuh struct berikutnya agar sejajar / *aligned* dengan batas tipe terbesar). Tail Padding akan ditambahkan Go di akhir struct. Evaluasi penggunaan struct padat daripada struct bersarang (*nested structs*) yang dapat memicu multiple tail-paddings.
2. **CPU Prefetcher Grouping**:
   *Edge Case*: Dalam struct raksasa berukuran 128 bytes, field `BestBid` berada di offset 0, dan `TargetVolume` berada di offset 100.
   *Defensive*: Hardware CPU modern mengawasi alur pembacaan kita dan melakukan pra-ambil (*prefetch*). Pastikan variabel yang saling terikat dalam 1 fungsi kalkulasi (*Hot Path Spatial Locality*) ditata berdampingan di struct Anda, sekalipun ukuran mereka berbeda. Anda mungkin terpaksa melanggar hukum "Urutan Terbesar-Terkecil" sedikit saja demi mempertahankan kolom kawan dekat ini agar muat di blok *L1 64-byte* yang sama.
3. **Atomic Boolean Size Under The Hood**:
   *Edge Case*: Anda beralih dari tipe bool standar (1 byte) menjadi fungsi baru Go 1.19 `atomic.Bool`.
   *Defensive*: Library `sync/atomic` untuk *boolean* mendasarinya pada struktur `uint32` murni. Hal ini menghabiskan 4 Bytes memori, bukan 1 byte. Jika Anda berupaya mengepas-ngepaskan *Padding Math* Anda menjadi 64 byte, awasi bahwa ukuran boolean aman Anda telah membesar!

## Advanced CPU Internals & Memory Architecture

Dalam sistem HFT dengan latensi ultra-rendah (sub-mikrodetik), pemahaman tentang *struct layout* saja tidak cukup. Kita harus memahami bagaimana **Cache Hierarchy**, **Translation Lookaside Buffer (TLB)**, dan **Hardware Prefetcher** berinteraksi dengan memori, terutama di bawah tekanan *Zero-Allocation*.

### Diagram ASCII: The Memory Hierarchy (Latensi & Kapasitas)

```text
      [ CPU CORE 0 ]             [ CPU CORE 1 ]
       │        │                 │        │
   [L1 Data] [L1 Inst]        [L1 Data] [L1 Inst]  <-- 32-64KB, ~1-2 ns (3-4 cycles)
       │        │                 │        │
       └──[L2 Cache]──┘           └──[L2 Cache]──┘ <-- 256KB-1MB, ~3-10 ns (10-20 cycles)
               │                          │
               └─────────[ L3 Cache ]─────┘        <-- 16MB-64MB+, ~15-40 ns (40-75 cycles)
                            │
                      [ MEMORY BUS ]
                            │
                   [ MAIN MEMORY (RAM) ]           <-- 16GB-1TB+, ~60-100+ ns
                            │
                      [ NUMA NODE 1 ]              <-- Remote RAM access (sangat dihindari di HFT)
```

Pada mesin modern, L3 Cache dibagikan antar Core. Namun, **False Sharing** terjadi di tingkat L1 dan L2, yang dikoordinasikan oleh protokol **MESI** (Modified, Exclusive, Shared, Invalid).

---

## 3. Tingkat Mahir: Zero-Alloc Data Structures (Ring Buffer HFT)

Di Go, alokasi memori ke *Heap* akan memicu *Garbage Collector (GC)*. GC pause, sekecil apapun, akan membunuh determinisme HFT. Oleh karena itu, kita mempraktekkan **Zero-Allocation** dengan menggunakan struktur *pre-allocated* (seperti *Ring Buffer*).

### Kode Go: Lock-Free Ring Buffer Berorientasi Cache

```go
package hftalloc_test

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"unsafe"
)

// Const ukuran cache line arsitektur standar (x86_64, ARM64)
const CacheLineSize = 64

// HFTTick merepresentasikan 1 event pasar. Ukuran: 24 bytes
type HFTTick struct {
	Timestamp int64
	Price     float64
	Volume    int64
}

// RingBufferHFT adalah queue lock-free single-producer single-consumer (SPSC)
// menggunakan padding agresif agar Head dan Tail berada di cache-line berbeda.
type RingBufferHFT struct {
	// Cache Line 1 (Read Only mostly, shared setup)
	Mask uint64
	_    [56]byte // Padding ke cache-line berikutnya

	// Cache Line 2: Ditulis HANYA oleh Producer
	Tail atomic.Uint64
	_    [56]byte // Cegah False Sharing

	// Cache Line 3: Ditulis HANYA oleh Consumer
	Head atomic.Uint64
	_    [56]byte

	// Pointer array yang di-pre-allocate di awal
	Nodes []HFTTick
}

func NewRingBufferHFT(capacity uint64) *RingBufferHFT {
	// Pastikan power of 2 untuk fast modulo
	if capacity == 0 || (capacity&(capacity-1)) != 0 {
		panic("capacity must be a power of 2")
	}
	return &RingBufferHFT{
		Mask:  capacity - 1,
		Nodes: make([]HFTTick, capacity),
	}
}

// Push menambahkan elemen tanpa alokasi & tanpa lock
func (r *RingBufferHFT) Push(tick HFTTick) bool {
	tail := r.Tail.Load()
	head := r.Head.Load()

	// Cek apakah buffer penuh
	if tail-head >= r.Mask+1 {
		return false
	}

	// Tulis ke slot array secara langsung (Zero Allocation)
	r.Nodes[tail&r.Mask] = tick
	r.Tail.Store(tail + 1)
	return true
}

// Pop mengambil elemen
func (r *RingBufferHFT) Pop() (HFTTick, bool) {
	head := r.Head.Load()
	tail := r.Tail.Load()

	if tail == head {
		return HFTTick{}, false // Kosong
	}

	tick := r.Nodes[head&r.Mask]
	r.Head.Store(head + 1)
	return tick, true
}
```

---

## Tambahan Anti-Patterns di HFT

### ❌ Anti-Pattern 3: Interface untuk State Internal (Dynamic Dispatch & Allocation)
**Menyimpan *interface* Go di *struct* performa kritis atau struct besar.**

```go
// ❌ BAD: Interface memicu implicit allocation & Cache Miss Cliff
type OrderProcessor struct {
    Strategy IStrategy // interface size: 16 bytes (2 pointers), memicu dereferencing tak tertebak
}
```
**Mengapa Berbahaya:** *Interface* di Go tersusun dari *iface* struct internal (pointer ke tipe, pointer ke data). Mengakses variabel lewat *interface* memaksa CPU melakukan lompatan acak ke alamat memori lain (pointer dereference) untuk mencari fungsinya (*Dynamic Dispatch*). Ini pasti **Cache Miss**. L1 Inst Cache akan dikosongkan.

```go
// ✅ GOOD: Generics (Monomorphization pada Go 1.18+) 
// Kompilator Go merender struct kongkret, meniadakan dynamic dispatch dan meng-inline data.
type OrderProcessor[T IStrategy] struct {
    Strategy T // Inlined data struct (ukuran sebenarnya T).
}
```

### ❌ Anti-Pattern 4: False Sharing pada Slices Berdekatan (Array Partitions)
**Beberapa goroutine memproses rentang (slice) dari 1 array raksasa yang sama.**

```go
// ❌ BAD: Goroutine memutasi slot array berdekatan
// Thread 1 meng-update data[0:10], Thread 2 meng-update data[10:20]
func ProcessParallel(data []uint64) {
    go update(data[0:10]) 
    go update(data[10:20])
}
```
**Mengapa Berbahaya:** Indeks batas (misal `data[9]` dan `data[10]`) bisa saja terletak di *Cache Line* 64-byte yang persis sama. Hal ini menciptakan silang-sengkarut *False Sharing* tak kasat mata saat masing-masing goroutine bekerja, merusak latensi keseluruhan.

---

## Pengujian Ekstensif (Benchmarks & Unit Tests)

Melanjutkan *test* sebelumnya, kita perlu memvalidasi properti ring-buffer dan mitigasi zero-allocation.

```go
func TestRingBuffer_SizeAndPadding(t *testing.T) {
	rbSize := unsafe.Sizeof(RingBufferHFT{})
	// Size struct yang dipadding idealnya harus besar (3 * 64 bytes = 192 bytes minimum)
	if rbSize < 192 {
		t.Errorf("Expected RingBufferHFT to have padding, got %d bytes", rbSize)
	}
	
	// Validasi pointer tidak dialokasi selama operasi
	rb := NewRingBufferHFT(1024)
	if cap(rb.Nodes) != 1024 {
		t.Errorf("Expected capacity 1024, got %d", cap(rb.Nodes))
	}
}

func TestRingBuffer_PushPop(t *testing.T) {
	rb := NewRingBufferHFT(8)
	
	// PUSH
	ok := rb.Push(HFTTick{Timestamp: 100, Price: 1.5, Volume: 10})
	if !ok {
		t.Errorf("Push failed")
	}
	
	// POP
	tick, ok := rb.Pop()
	if !ok || tick.Timestamp != 100 {
		t.Errorf("Pop failed or data corrupted")
	}
}

func BenchmarkRingBufferHFT_ZeroAlloc(b *testing.B) {
	rb := NewRingBufferHFT(65536)
	b.ReportAllocs()
	b.ResetTimer()
	
	for i := 0; i < b.N; i++ {
		rb.Push(HFTTick{Timestamp: 1, Price: 1.1, Volume: 10})
		rb.Pop()
	}
}
```

---

## Tambahan Edge Cases & Defensive Programming HFT

4. **Inlining vs Stack Frame Size**:
   *Edge Case*: Fungsi sangat dioptimalkan yang mengambil argumen struct bernilai (`by value`), misalnya struct 50 bytes. Kompilator bisa memutuskan bahwa *stack frame* membengkak, sehingga secara diam-diam meletakkan *copy* data ini ke *Heap* (*Escape Analysis memihak Heap*), merusak tujuan zero-alloc.
   *Defensive*: Gunakan `go build -gcflags="-m"` untuk memverifikasi. Tetap pertimbangkan *passing by pointer* `*struct` jika variabel sering menyeberang *function boundary* yang rumit, namun ingat pointer menyebabkan Cache Indirection. Temukan titik impas (*sweet spot*) menggunakan *benchmarks*.
5. **NUMA Boundary Crossings**:
   *Edge Case*: Anda mendesain *Zero-Alloc struct array* di RAM. Anda menjalankan mesin Dual-Socket CPU dengan arsitektur NUMA (Non-Uniform Memory Access). Goroutine yang berjalan pada Core Socket-1 berupaya membaca array raksasa yang tanpa sengaja dialokasikan oleh OS di Node Memori Socket-2.
   *Defensive*: Latensi RAM antar Socket melonjak (QPI/UPI interconnect bus). Di aplikasi Golang tingkat ekstrem, paksa *Goroutine Affinity* (mengikat goroutine HFT kritis pada core spesifik dengan OS lock thread seperti `runtime.LockOSThread()`) dan *NUMA policy* menggunakan *cgo* atau tools seperti `taskset`/`numactl`.
6. **False Sharing dari GC Scavenger**:
   *Edge Case*: Anda mengoptimalkan struct Anda dari False Sharing terhadap goroutine HFT lainnya. Tetapi tiba-tiba pada persentil 99.9%, latensi Anda hancur (tail latency spikes). 
   *Defensive*: Proses *Background Scavenger* (pengembalian memori ke OS) atau *Garbage Collector Marker* Go berjalan di latar, menyapu halaman memori yang bersebelahan dengan struct penting Anda. Inilah mengapa alokasi *Ring Buffer* besar pada awal peluncuran (pre-allocation) harus sangat besar atau sepenuhnya dipisahkan (isolated pages) menggunakan syscall `mmap` langsung, mem-bypass GC sepenuhnya (Off-heap Memory).

## Kapan JANGAN Pakai Ini

- **Sebelum mengukur cache miss.** Menata ulang struct tanpa data adalah tebakan yang membuat kode lebih sulit dibaca dan belum tentu lebih cepat.
- **Pada beban yang didominasi I/O.** Cache miss tidak relevan bila 99% waktu dihabiskan menunggu jaringan atau disk. Optimasi ini hanya berarti ketika CPU benar-benar menjadi batas.
- **Struct-of-arrays untuk data yang selalu diakses per-objek.** SoA menang ketika Anda memindai **satu field lintas banyak objek**. Untuk akses per objek, ia justru memperburuk lokalitas dan menambah kerumitan.
- **Padding di setiap struct.** Padding menaikkan konsumsi memori dan bisa memperburuk hal lain. Pakai hanya pada variabel yang benar-benar diperebutkan antar core, dan buktikan dengan pengukuran.
- **Mengasumsikan cache line selalu 64 byte.** Apple Silicon memakai 128 byte. Padding yang dihitung untuk 64 tidak menyelesaikan false sharing di sana.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Throughput datar saat core ditambah | `perf c2c` | Beberapa core memperebutkan cache line yang sama |
| Rasio cache-miss tinggi | `perf stat` | Pola akses memori tidak ramah cache |
| Latensi berayun tanpa perubahan beban | migrasi antar core | Data tidak lagi di cache lokal setelah goroutine berpindah |
| Struct besar disalin sering | profil CPU pada `runtime.memmove` | Nilai besar dilewatkan by-value |
| Optimasi tidak berefek di arm64 | ukuran cache line arsitektur | Padding dihitung untuk 64 byte saja |

```bash
# Rasio cache-miss: ini angka pertama yang harus dilihat
perf stat -e cache-misses,cache-references,L1-dcache-load-misses,LLC-load-misses ./app

# Cache line mana yang benar-benar diperebutkan, dan oleh fungsi apa
perf c2c record -- ./app && perf c2c report --stdio | head -40

# Ukuran dan tata letak struct
go build -gcflags='-m' ./... 2>&1 | grep -i 'moved to heap' | head
go vet -structtag ./...

go test -bench=. -benchmem -count=10 -cpu=1,2,4,8 -run='^$' ./...
```
