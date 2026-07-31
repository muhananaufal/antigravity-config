# SIMD Assembly Intrinsics in Go

## Konsep Utama
Bahasa Go merupakan bahasa turunan C yang dikompilasi ke *machine code*, namun kompilator Go (walaupun terus disempurnakan) kadang kurang agresif dibandingkan GCC atau Clang/LLVM C++ dalam memvektorisasi (menerapkan instruksi SIMD) operasi loop secara otomatis.

SIMD (Single Instruction, Multiple Data) memungkinkan unit ALU dalam CPU (melalui set register raksasa seperti SSE, AVX2 256-bit, atau AVX-512 512-bit) memproses puluhan *integer* atau operasi secara bersamaan *hanya dalam satu clock cycle CPU*.

Dalam High Frequency Trading (HFT) Go:
1. **Pola Vektorisasi Otomatis (Auto-Vectorization)**: Kita memandu penulisan `for loop` yang aman sehingga rantaian dependensi patah, membiarkan *backend* Go mendeteksi ini sebagai kandidat instruksi ber-AVX.
2. **Pola Golang Assembly (Plan9 ASM)**: Menulis perakitan murni (`.s` file) yang dihubungkan tanpa jeda batas CGO (CGO sangat fatal karena menelan ~150ns latensi *context switch* User-Space Go ke p-thread C).
3. **Pemuatan Beruntun (*Contiguous Memory*)**: Agar SIMD berjalan, rentetan data mentah (seperti `Price` dan `Volume`) harus diratakan (*flatten*) sebagai *array primitif* (seperti `[]int64`), alih-alih berlindung di dalam hirarki *Pointer array*.

## Diagram ASCII: Scalar vs SIMD Execution

```text
[ SCALAR / NORMAL LOOP (Lambat, 4 Clock Cycles) ]
Loop 1: [A1] + [B1] = [C1] 
Loop 2: [A2] + [B2] = [C2]
Loop 3: [A3] + [B3] = [C3]
Loop 4: [A4] + [B4] = [C4]

[ SIMD AVX256 EXECUTION (Kecepatan 1 Clock Cycle) ]
Membaca 256 byte secara instan, menjumlahkan 4 kelompok int64 sekaligus!
Register YMM0 [ A1 | A2 | A3 | A4 ]
                +    +    +    +
Register YMM1 [ B1 | B2 | B3 | B4 ]
                =    =    =    =
Register YMM2 [ C1 | C2 | C3 | C4 ] (1 Instruksi Hardware Selesai!)
```

## Kode Go Production-Ready

Kode di bawah menunjukkan bagaimana menulis kode idiomatis murni Go (tanpa File `.s`) secara "Auto-Vectorization-Friendly" dengan menghilangkan pengecekan silang (bounds check), sehingga mesin perakit silang Go akan mengubahnya menjadi operasi *SIMD YMM Registers*.

```go
package hftalloc

import (
	"context"
	"fmt"
	"testing"
)

// AggregatePricesScalar (Tradisional) menjumlahkan daftar int64 dan mengalihkannya
func AggregatePricesScalar(ctx context.Context, prices []int64, multiplier int64) int64 {
	var total int64
	for i := 0; i < len(prices); i++ {
		total += prices[i] * multiplier
	}
	return total
}

// AggregatePricesSIMDFriendly adalah fungsi optimasi yang mengarahkan Golang Backend Compiler
// untuk meluncurkan Vectorization.
// Pada Go 1.20+, loop-loop yang lepas ikatan (*unrolled*) dan bebas dari Boundary Checks
// dapat dioptimalkan langsung ke instruksi rakitan AVX.
func AggregatePricesSIMDFriendly(ctx context.Context, prices []int64, multiplier int64) int64 {
	// Menghindari indeks panik (Panic Bounds Check Elimination) 
	// dengan memandu kompilator ke panjang array
	n := len(prices)
	if n == 0 {
		return 0
	}

	// Buat kompilator sadar akan batas panjang, menghindari panic() disetiap siklus 1..n
	_ = prices[n-1] 

	var total int64
	
	// Unrolling putaran manual (Sering diterjemahkan ke AVX register untuk paralel)
	// Kita iterasi dalam satuan porsi (chunk) 4 bilangan 64-bit sekaligus (256-bit AVX2)
	limit := n - (n % 4) 
	
	// Fast Path: Chunk 4 Elemen
	for i := 0; i < limit; i += 4 {
		total += (prices[i] * multiplier) +
			(prices[i+1] * multiplier) +
			(prices[i+2] * multiplier) +
			(prices[i+3] * multiplier)
	}

	// Slow Path: Menyelesaikan sisa yang tidak genap 4 elemen
	for i := limit; i < n; i++ {
		total += prices[i] * multiplier
	}

	return total
}

// Catatan di Dunia Nyata (Real World Production ASM):
// Di HFT Go komersial, perusahaan menulis agregasi ini dalam file "aggregate_amd64.s"
// menggunakan perintah rakitan mentah AVX (VPADDQ). Namun Plan9 Assembly Golang terlalu rumit
// dan kuno untuk disertakan di blok Markdown ini. Praktik di atas (BCE & Unroll) adalah
// aproksimasi Go Murni terbaik untuk memanggil jiwa SIMD kompilator.

// --- UNIT TESTS DAN BENCHMARKS ---

func TestSIMDAggregation(t *testing.T) {
	ctx := context.Background()
	prices := []int64{100, 200, 300, 400, 500, 600}
	
	result := AggregatePricesSIMDFriendly(ctx, prices, 2)
	expected := int64((100+200+300+400+500+600)*2)
	
	if result != expected {
		t.Errorf("expected %d, got %d", expected, result)
	}
}

func BenchmarkAggregate_ScalarVsSIMD(b *testing.B) {
	ctx := context.Background()
	prices := make([]int64, 1024)
	for i := range prices {
		prices[i] = 100
	}

	b.Run("Scalar", func(b *testing.B) {
		b.ReportAllocs() // WAJIB
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = AggregatePricesScalar(ctx, prices, 2)
		}
	})

	b.Run("SIMDFriendly", func(b *testing.B) {
		b.ReportAllocs() // WAJIB
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = AggregatePricesSIMDFriendly(ctx, prices, 2)
		}
	})
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menyebar Akses Memori Slice di `struct` Array Pointer
**Mencoba melakukan perhitungan massal di mana elemen data disebarkan pada properti objek terdistribusi.**

```go
// ❌ BAD: Membunuh kemampuan SIMD untuk bekerja
type BookDelta struct {
    Price int64
    Qty   int64
}

func SumPricesBad(deltas []*BookDelta) int64 {
    var sum int64
    for _, d := range deltas { // CPU melompat-lompat mencari alamat di RAM
        sum += d.Price
    }
    return sum
}
```

**Mengapa Berbahaya:** Registrasi SIMD AVX tidak dapat "melompat" mengumpulkan data (kecuali menggunakan instruksi `Gather` AVX-512 khusus lambat). Mereka menyedot blok memori besar dari L1 Cache dalam konfigurasi linear 1 dimensi. Mengakses pointer dari array of pointer (`[]*BookDelta`) menyebabkan *Pointer Chasing*. Kompilator tidak berani mengoptimalkan ke SIMD karena ini bukan deretan memori integer yang rapat (dense).

```go
// ✅ GOOD: Rantai Kolom (Columnar Storage / SoA - Structure of Arrays)
type BookDeltas struct {
    Prices []int64 // Dense array, memori rata dan kontinu
    Qtys   []int64
}

func SumPricesGood(deltas *BookDeltas) int64 {
    // Array Prices bersifat murni int64, kompilator Go 1.20+ bisa menyulap ini menjadi AVX Vector!
    var sum int64
    for i := range deltas.Prices { 
        sum += deltas.Prices[i]
    }
    return sum
}
```

### ❌ Anti-Pattern 2: Bergantung pada CGO untuk Memanggil SIMD C++
**Menyerahkan rutinitas agregasi ke fungsi pustaka C eksternal demi meminjam kecepatan (libavx).**

```go
// ❌ BAD: Overhead Context Switch CGO
/*
#cgo CFLAGS: -O3 -mavx2
#include <immintrin.h>
long sum_avx(long* arr, int len) { ... }
*/
import "C"

func CallCGO(prices []int64) int64 {
    return int64(C.sum_avx((*C.long)(&prices[0]), C.int(len(prices))))
}
```

**Mengapa Berbahaya:** Mengkonfigurasi `CGO` dari Go mengharuskan Go Runtime menonaktifkan penjadwalan M:N dari thread tersebut, mentransfer pointer alamat memori (Pointer Passing rules yang menyulitkan GC), dan memicu penalti ganti-konteks C-Call senilai 150-200 nanodetik. Jika data loop Anda hanya berkapasitas 50 elemen array (sangat wajar di buku pesanan sekuritas), iterasi Go lambat justru selesai dalam 40ns. Menggunakan SIMD *wrapper C* malah melambatkan kode secara dramatis!

```go
// ✅ GOOD: Native Go Assembly (Plan9 ASM) atau Auto-Vectorization murni
// Tulis dalam file fungsi rakitan `.s` atau strukturisasi slice agar dikenali kompilator Go murni.
```

## Edge Cases & Defensive Programming

1. **Efek Penghancur Padding terhadap Unrolling**:
   *Edge Case*: Anda secara manual membuka putaran (unrolling) *for loop* seperti pada kode di atas (menjadi kelompok berempat / stride-4). Namun Anda mengkompilasi Go dalam arsitektur ARM32 kuno (contoh: board rasberry pi lama).
   *Defensive*: Pada arsitektur yang tidak mendukung fitur paralel SIMD YMM besar atau kekurangan register, Go kompilator justru akan menghasilkan kode *machine instruksi* yang jauh lebih bengkak ukurannya (Instruction Cache Miss). Kode SIMD yang dipaksakan tangan manusia hanya ampuh jika Anda menargetkan OS Bare-metal Intel Xeon / AMD Epyc terbaru. Pertimbangkan menambahkan petunjuk pembangunan (Build Tags: `//go:build amd64`).
2. **Memory Alignment Fault pada Native Assembly**:
   *Edge Case*: Anda nekat dan menulis file rakitan manual `sum_amd64.s` menggunakan instruksi AVX ekstrim `VMOVAPD` (Aligned Packed Double). Namun array slice byte yang dioper dari runtime aplikasi dimulai di alamat *hexadecimal* ganjil, bukan kelipatan batas 32-byte memori cache.
   *Defensive*: Instruksi AVX *Aligned* di CPU Intel jika disodorkan alamat memori yang tidak sejajar (Unaligned Memory Address) akan memicu *General Protection Fault (Segfault Crash)* seketika dari silikon kernel. Gunakan instruksi aman `VMOVUPD` (*Unaligned*) yang sedikit lebih santai, atau pastikan pra-alokasi byte array (`memory arena`) dimulai dengan pemotongan alignment di ekor byte.
3. **Pengecekan Bounded Array Go**:
   *Edge Case*: Kompilator Go, secara default, keras kepala dan rajin menginjeksi potongan rahasia kode "Jika I > Batas Panjang Array, maka lemparkan Panic". Ini dikenal dengan BCE (Bounds Check). Instruksi pencegat tersembunyi inilah yang sering membunuh inisiatif Auto-Vectorization compiler!
   *Defensive*: Anda HARUS membuktikan kepada kompilator bahwa batas *for-loop* sudah aman secara absolut, contohnya dengan peretasan trik awal penugasan bayangan `_ = array[len-1]`. Verifikasi hilangnya penjaga batas ini di log ASM menggunakan perintah `go build -gcflags="-d=ssa/check_bce/debug=1"`. Jika fungsi Anda diam (tidak mencetak keterangan panik), berarti silikon Anda bisa terbang lepas membelah angin (Vektorisasi Murni).

## Internals HFT Tingkat Lanjut: CPU Downclocking & Cache Lines

Dalam HFT, latensi adalah segalanya. Namun, menggunakan instruksi SIMD yang terlalu lebar (seperti AVX-512) pada CPU Intel (terutama arsitektur sebelum Ice Lake/Sapphire Rapids) dapat memicu **AVX-512 Downclocking** (Frequency Scaling). CPU secara otomatis menurunkan *clock speed* inti (misalnya dari 4.5GHz ke 3.6GHz) untuk menghindari *overheating* saat memproses regiser 512-bit secara intensif. Ironisnya, alih-alih lebih cepat, eksekusi kode *non-SIMD* sekitarnya (seperti networking stack Go) menjadi lambat total. Oleh karena itu, di dunia HFT, kita sering secara sengaja membatasi diri pada SSE4 (128-bit) atau AVX2 (256-bit).

### Diagram ASCII: L1 Cache Line (64 Bytes) & AVX2 Register (32 Bytes) Mapping

SIMD sangat bergantung pada *Cache Line* CPU L1. Setiap *Cache Line* berukuran 64 bytes. YMM Register (AVX2) berukuran 256 bits (32 Bytes).
Ini berarti satu siklus tarikan Cache Line L1 bisa langsung menyuplai *dua* YMM registers.

```text
+-------------------------------------------------------------------------------+
|                      L1 Cache Line (64 Bytes = 512 Bits)                      |
+-------------------------------------------------------------------------------+
|     YMM0 (32 Bytes / 256 Bits)      |     YMM1 (32 Bytes / 256 Bits)      |
| [P1][P2][P3][P4] (4 x 64-bit int)   | [P5][P6][P7][P8] (4 x 64-bit int)   |
+-------------------------------------------------------------------------------+
1 tarikan memory mentransfer tepat 8 entri data harga saham secara instan!
```

### ❌ Anti-Pattern 3: *Interface{} Slice* untuk Polimorfisme Harga
**Berusaha membuat fungsi agregasi yang menerima berbagai jenis data struct menggunakan interface{} / any.**

```go
// ❌ BAD: Interface slice membunuh Cache Line dan SIMD
func SumPricesInterfaceBad(items []any) int64 {
    var sum int64
    for _, item := range items { // Boxing/Unboxing via runtime Go!
        if p, ok := item.(int64); ok {
            sum += p
        }
    }
    return sum
}
```

**Mengapa Berbahaya:** Elemen slice `any` (`interface{}`) direpresentasikan oleh 2 memori berukuran *pointer* (8 bytes *type pointer* + 8 bytes *data pointer*). CPU tidak dapat melakukan vektorisasi pada array yang berisi pointer. Setiap iterasi melibatkan alokasi tipe dinamis dan memicu dereferensi pointer ke heap. Ini menyebabkan *cache miss* dengan latensi ~100ns per elemen, berlawanan dengan SIMD yang membutuhkan memori flat!

```go
// ✅ GOOD: Go Generics (Monomorphization)
// Kompilator akan men-generate kode flat array unik per-tipe tanpa overhead runtime.
type Numeric interface {
    ~int64 | ~float64
}

func SumPricesGenericGood[T Numeric](items []T) T {
    var sum T
    for i := 0; i < len(items); i++ { // SIMD bisa di-infer secara statis
        sum += items[i]
    }
    return sum
}
```

## Zero-Alloc HFT Data Structure: Order Book Columnar

Berikut adalah contoh lengkap dari pola arsitektur nol alokasi dengan `Struct of Arrays` (SoA) yang ramah terhadap perakitan SIMD di level industri HFT, mencakup test dan benchmark zero-alloc.

```go
package hftalloc

import (
	"context"
	"testing"
)

// HFTOrderBook (SoA format untuk AVX2 Vectorization)
type HFTOrderBook struct {
	Prices []int64 // Flat array, 64-bit integer (Terjamin cache align)
	Qtys   []int64 // Flat array
	Len    int
}

// NewHFTOrderBook alokasi pre-allocated arena
func NewHFTOrderBook(cap int) *HFTOrderBook {
	return &HFTOrderBook{
		Prices: make([]int64, cap),
		Qtys:   make([]int64, cap),
		Len:    0,
	}
}

// AddOrder bersifat nol alokasi karena memodifikasi pre-allocated slice (Mencegah GC)
func (ob *HFTOrderBook) AddOrder(price, qty int64) {
	if ob.Len >= len(ob.Prices) {
		return // Overflow drop di HFT ring buffer
	}
	ob.Prices[ob.Len] = price
	ob.Qtys[ob.Len] = qty
	ob.Len++
}

// ComputeNotionalValueSIMD menghitung Volume * Price untuk seluruhan buku pesanan
func (ob *HFTOrderBook) ComputeNotionalValueSIMD() int64 {
	n := ob.Len
	if n == 0 {
		return 0
	}
	// BCE: Bounds Check Elimination
	_ = ob.Prices[n-1]
	_ = ob.Qtys[n-1]

	var total int64
	limit := n - (n % 4)

	// SIMD AVX2 (Unrolled Loop) - Mengalikan & menjumlah 4 pasang instan
	for i := 0; i < limit; i += 4 {
		total += (ob.Prices[i] * ob.Qtys[i]) +
			(ob.Prices[i+1] * ob.Qtys[i+1]) +
			(ob.Prices[i+2] * ob.Qtys[i+2]) +
			(ob.Prices[i+3] * ob.Qtys[i+3])
	}

	for i := limit; i < n; i++ {
		total += ob.Prices[i] * ob.Qtys[i]
	}

	return total
}

// --- UNIT TESTS & BENCHMARKS EKSTRA ---

func TestComputeNotionalSIMD(t *testing.T) {
	book := NewHFTOrderBook(100)
	book.AddOrder(100, 2)
	book.AddOrder(150, 3)
	book.AddOrder(200, 1)

	expected := int64((100 * 2) + (150 * 3) + (200 * 1))
	if result := book.ComputeNotionalValueSIMD(); result != expected {
		t.Fatalf("Salah hitung: got %d, expected %d", result, expected)
	}
}

func BenchmarkComputeNotionalSIMD(b *testing.B) {
	book := NewHFTOrderBook(1024) // Mengisi 1024 elemen (Pas cache L1/L2)
	for i := 0; i < 1024; i++ {
		book.AddOrder(int64(100+i), 10)
	}

	b.ReportAllocs() // MEMASTIKAN 0 B/op, 0 allocs/op
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = book.ComputeNotionalValueSIMD()
	}
}

func BenchmarkSoA_vs_AoS(b *testing.B) {
    // Array of Structs (AoS) - Pola OOP tradisional lambat
	type Order struct {
		Price int64
		Qty   int64
	}
	aos := make([]Order, 1024)
	for i := range aos {
		aos[i] = Order{Price: 100, Qty: 10}
	}
    
    // SoA (Struct of Arrays)
	book := NewHFTOrderBook(1024)
	for i := 0; i < 1024; i++ {
		book.AddOrder(100, 10)
	}

	b.Run("AoS_Slow", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			var total int64
			for j := 0; j < len(aos); j++ {
				total += aos[j].Price * aos[j].Qty
			}
			_ = total
		}
	})

	b.Run("SoA_SIMD", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_ = book.ComputeNotionalValueSIMD() // Lebih cepat, Ramah L1 Cache
		}
	})
}
```

## Ekstra Edge Cases & Defensive Programming di HFT Multicore

4. **False Sharing pada Cache Line**:
   *Edge Case*: Anda memiliki beberapa Goroutines yang memperbarui struct `HFTOrderBook` bersama pada array yang saling berdekatan. Misalnya, Goroutine A menulis ke `Prices[0]` dan Goroutine B menulis ke `Prices[1]`.
   *Defensive*: Karena *Cache Line* berukuran 64-byte, modifikasi pada index yang berbeda tetapi di dalam cache line yang sama menyebabkan CPU men-invalidasi memori *cache* antar inti (Cache Coherence Ping-Pong). Hal ini menyebabkan *Lock* tak kasat mata di level hardware (meskipun di kode Go tidak ada mutex). **Solusi**: Gunakan `CPU Padding` (misalnya menambahkan struct dummy `_ [56]byte`) untuk merenggangkan data sensitif, atau pastikan setiap Goroutine menulis ke arena memori terpisah sebelum dijumlahkan (Map-Reduce).

5. **Stop-The-World (STW) Garbage Collection Mengganggu SIMD Throughput**:
   *Edge Case*: Fungsi agregasi SIMD Anda tereksekusi mulus 40ns. Namun tiba-tiba lonjakan STW (Pause Time GC Go) terjadi selama 250 mikrosekon di tengah iterasi loop karena banyaknya pointer yang bocor di sistem sekitarnya.
   *Defensive*: Optimasi SIMD sia-sia jika runtime menangguhkan *thread*. Kombinasikan SIMD dengan `sync.Pool` dan `Off-heap Memory Arena` (melalui mmap `syscall`). Objek *slice* `int64` yang sangat besar tanpa referensi pointer (*pointer-free types*) tidak di-scan secara *deep-scan* oleh GC Golang, mengurangi durasi GC STW secara signifikan.
