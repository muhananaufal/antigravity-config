# Lock-Free Ring Buffer (MPSC / SPSC)

> **Berlaku:** Go 1.21+ · `sync/atomic` · **Lihat juga:** `concurrency/atomic_lockfree_patterns.md` · `hft_zero_alloc/cpu_cache_optimization.md` · `concurrency/channel_patterns_pipelines.md` · `concurrency/data_race_detection.md`

## Konsep Utama
Dalam sistem berbasis peristiwa dengan latensi rendah (seperti pemrosesan paket jaringan HFT atau aliran kursor *Orderbook*), penggunaan `channel` bawaan Go dan `sync.Mutex` merupakan ancaman serius. `Channel` Go menggunakan *locking* berbiaya tinggi di bawah permukaannya dan memicu penundaan penjadwalan OS (*context switching*) tatkala Goroutine terblokir (*blocked*).

Untuk pertukaran data secepat kilat antar *thread* CPU yang didedikasikan (*pinned threads*), HFT beralih ke **Lock-Free Ring Buffer**. Struktur ini berupa array melingkar statis, dengan penunjuk ekor (*Tail*) untuk menulis dan penunjuk kepala (*Head*) untuk membaca.
Karakteristiknya meliputi:
1. **Zero Allocation**: Kapasitas telah dialokasikan penuh di awal; setiap slot diputar ulang (*reused*).
2. **Atomic Operations**: Penunjuk *Head* dan *Tail* dimanipulasi dengan `sync/atomic` Go murni (tanpa mutex).
3. **SPSC (Single Producer, Single Consumer)**: Paling efisien, sama sekali tidak memerlukan rekonsiliasi balapan antar-penulis.
4. **MPSC (Multi Producer, Single Consumer)**: Produsen bersaing untuk *Tail* menggunakan operasi `CompareAndSwap` (CAS), sedangkan Konsumen membaca *Head* dengan tenang.

## Diagram ASCII: Lock-Free Ring Buffer

```text
  [ RING BUFFER ARRAY (Capacity: 8) ]

          Head (Consumer Reads Here)
          |
  [0]    [1]    [2]    [3]    [4]    [5]    [6]    [7]
 +------+------+------+------+------+------+------+------+
 | Done | Data | Data | Data | Free | Free | Free | Done |
 +------+------+------+------+------+------+------+------+
                              |
                              Tail (Producer Writes Here)

  [ Operasi SPSC Tanpa Kunci ]
  Producer -> Write[Tail] -> AtomicAdd(Tail, 1)
  Consumer -> Read[Head]  -> AtomicAdd(Head, 1)
```

## Kode Go Production-Ready

Kode di bawah menunjukkan implementasi **SPSC Ring Buffer** nol alokasi untuk melewatkan struct *TickEvent* antar *Goroutines* tanpa mutex.

```go
package hftalloc

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"
)

var (
	ErrBufferFull  = fmt.Errorf("ring buffer full")
	ErrBufferEmpty = fmt.Errorf("ring buffer empty")
)

// TickEvent mewakili pesan pasar. (Di-padding agar muat di Cache Line bila perlu)
type TickEvent struct {
	Timestamp int64
	Price     int64
	Volume    int64
}

// SPSCRingBuffer adalah antrean tanpa kunci khusus untuk 1-Producer dan 1-Consumer.
type SPSCRingBuffer struct {
	// Kapasitas selalu dipaksa ke pangkat 2 (power of 2) untuk mengizinkan
	// operasi bitwise AND alih-alih fungsi modulo (%) yang lambat.
	capacity uint64
	mask     uint64

	// Padding untuk False Sharing antara Head (Konsumen) dan Tail (Produsen)
	_ [56]byte
	head atomic.Uint64
	
	_ [56]byte
	tail atomic.Uint64
	
	_ [56]byte
	
	// Array backing dialokasikan penuh (Zero alloc on hot path)
	buffer []TickEvent
}

// NewSPSCRingBuffer membuat RingBuffer dengan kapasitas power-of-2.
func NewSPSCRingBuffer(powerOfTwoCapacity uint64) *SPSCRingBuffer {
	// Verifikasi apakah nilainya valid kelipatan pangkat 2 (misal: 1024, 2048)
	if powerOfTwoCapacity == 0 || (powerOfTwoCapacity&(powerOfTwoCapacity-1)) != 0 {
		powerOfTwoCapacity = 1024 // Default fallback
	}

	return &SPSCRingBuffer{
		capacity: powerOfTwoCapacity,
		mask:     powerOfTwoCapacity - 1,
		buffer:   make([]TickEvent, powerOfTwoCapacity),
	}
}

// Offer mamasukkan event ke buffer (Produser). (Non-blocking)
func (rb *SPSCRingBuffer) Offer(ctx context.Context, ev *TickEvent) error {
	currentTail := rb.tail.Load()
	currentHead := rb.head.Load()

	// Cek penuh: Jika (Tail - Head) >= Kapasitas
	if currentTail-currentHead >= rb.capacity {
		return ErrBufferFull
	}

	// Tulis data ke indeks melingkar menggunakan operasi Bitwise AND yang super cepat
	idx := currentTail & rb.mask
	rb.buffer[idx] = *ev

	// Publikasikan visibilitasnya ke Konsumen dengan Atomic Store
	rb.tail.Store(currentTail + 1)
	return nil
}

// Poll mengekstrak event dari buffer (Konsumer). (Non-blocking)
func (rb *SPSCRingBuffer) Poll(ctx context.Context, outEv *TickEvent) error {
	currentHead := rb.head.Load()
	currentTail := rb.tail.Load()

	// Cek kosong: Jika Head mengejar Tail
	if currentHead == currentTail {
		return ErrBufferEmpty
	}

	idx := currentHead & rb.mask
	*outEv = rb.buffer[idx] // Salin nilai struct secara penuh (Value semantic, escape avoidance)

	// Tandai slot sebagai kosong dengan memajukan head
	rb.head.Store(currentHead + 1)
	return nil
}

// --- UNIT TESTS DAN BENCHMARKS ---

func TestSPSCRingBuffer_OfferPoll(t *testing.T) {
	ctx := context.Background()
	rb := NewSPSCRingBuffer(4) // Kapasitas 4
	
	evt := &TickEvent{Price: 100}
	
	// Test Offer
	if err := rb.Offer(ctx, evt); err != nil {
		t.Fatalf("unexpected full error")
	}
	
	// Test Poll
	var out TickEvent
	if err := rb.Poll(ctx, &out); err != nil {
		t.Fatalf("unexpected empty error")
	}
	
	if out.Price != 100 {
		t.Errorf("expected 100, got %d", out.Price)
	}
	
	// Pastikan buffer kosong lagi
	if err := rb.Poll(ctx, &out); err != ErrBufferEmpty {
		t.Errorf("expected buffer empty, got %v", err)
	}
}

func BenchmarkSPSCRingBuffer_ZeroAlloc(b *testing.B) {
	ctx := context.Background()
	rb := NewSPSCRingBuffer(1024)
	evt := &TickEvent{Price: 150}
	var out TickEvent
	
	b.ReportAllocs() // WAJIB: Memverifikasi zero allocation
	b.ResetTimer()
	
	for i := 0; i < b.N; i++ {
		_ = rb.Offer(ctx, evt)
		_ = rb.Poll(ctx, &out)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan Modulo Operator (`%`)
**Menghitung indeks array melingkar dengan fungsi aritmatika modulo.**

```go
// ❌ BAD: Matematika modulo berkinerja buruk untuk HFT
func (rb *RingBuffer) Put(data int) {
    idx := rb.tail.Load() % rb.capacity // Membutuhkan instruksi divisi (DIV) siklus tinggi
    rb.buffer[idx] = data
}
```

**Mengapa Berbahaya:** Di level rakitan CPU (Assembly), instruksi pembagian matematika (Integer Division) yang mendasari modulo `%` sangat lambat dan dapat menghabiskan 10-40 siklus (*clock cycles*). Jika Anda memproses belasan juta paket jaringan (*packet per second*), *bottleneck* instruksi silikon ini akan menaikkan latensi CPU yang merusak eksekusi dagang.

```go
// ✅ GOOD: Menggunakan Bitwise AND Masking (Kapasitas harus Pangkat 2)
func (rb *RingBuffer) Put(data int) {
    // Kapasitas 1024 -> Mask = 1023 (001111111111 dalam biner)
    idx := rb.tail.Load() & rb.mask // Instruksi 1 siklus CPU (AND)
    rb.buffer[idx] = data
}
```

### ❌ Anti-Pattern 2: Tidak Menghentikan (*Backoff*) Goroutine yang *Spinning*
**Membuat antrean konsumen me-looping instan saat kosong.**

```go
// ❌ BAD: CPU Burn (Busy-Wait Polling Buta)
func ConsumerThread(rb *RingBuffer) {
    for {
        err := rb.Poll(ctx, &event)
        if err == ErrBufferEmpty {
            continue // Langsung berulang tanpa henti, memakan 100% Core CPU!
        }
        Process(event)
    }
}
```

**Mengapa Berbahaya:** Jika antrean kosong sesaat, loop `for {}` tanpa jeda akan menyandera OS Thread Karyawan. Go Scheduler dipaksa menaikkan konsumsi core CPU hingga 100% dan menghasilkan lonjakan panas mesin (*Thermal Throttling*). Lebih buruk lagi, karena Thread OS tidak pernah dikembalikan (*yield*), Go runtime kesulitan menjadwalkan Goroutine produksi lainnya untuk berjalan.

```go
// ✅ GOOD: Gosched atau runtime Pause (Exponential Backoff Spin)
func ConsumerThread(rb *RingBuffer) {
    var spinCount int
    for {
        err := rb.Poll(ctx, &event)
        if err == ErrBufferEmpty {
            spinCount++
            if spinCount < 1000 {
                // Biarkan spin sejenak untuk latensi nanodetik
            } else {
                // Yield thread ini kembali ke Go Scheduler
                runtime.Gosched() 
            }
            continue
        }
        spinCount = 0
        Process(event)
    }
}
```

## Edge Cases & Defensive Programming

1. **Variabel Visibilitas Lintas Inti & Memori (Memory Ordering/Fences)**:
   *Edge Case*: Produsen menulis data ke indeks `buffer[idx]`, kemudian memajukan `tail` variabel (AtomicStore). Tiba-tiba CPU mengaplikasikan *Out-of-Order Execution*. CPU memajukan `tail` DULUAN sebelum memori data struct selesai disalin ke RAM. Konsumen mengambil *event* dari array, dan mendapatkan struct kosong berisikan *sampah (garbage bytes)*.
   *Defensive*: Pada arsitektur non-x86 (seperti ARM M-Series Apple Silicon), *memory model* bersifat kendor (*relaxed*). Pemanggilan `atomic.Store` Go memberikan jaminan keamanan absolut (menjalankan barikade `Store Memory Barrier/Fence`). Anda *tidak boleh* menggantinya dengan variabel biasa tanpa *atomic* meskipun di arsitektur SPSC!
2. **Buffer Penuh - Drop vs Block**:
   *Edge Case*: Konsumen lambat. Antrean penuh (`ErrBufferFull`). Produsen HFT harus bereaksi.
   *Defensive*: Dalam HFT, penundaan sistem (*Blocking/Waiting*) di titik pemicu event tidak diizinkan. Jika buffer pengiriman UDP *feed* penuh, panggil fungsi `Reject/Drop` paket tersebut dan amankan metrik *Telemetry Error Count*. Mengorbankan integritas satu order demi kelangsungan hidup koneksi keseluruhan jauh lebih baik dibanding membekukan aliran *Order Matching Engine*.
3. **MPSC (Multi-Producer SPSC) ABA Problem**:
   *Edge Case*: Jika Anda merubah *Ring Buffer* menjadi *Multi Producer*, penggunaan fungsi `CompareAndSwap` (CAS) pada `Tail` dapat menyandung Anda saat Thread A membaca Tail, lalu Thread B mengubah Tail, dan Thread C memutarnya kembali ke posisi Tail awal (*ABA Problem*).
   *Defensive*: Di Go, penggunaan counter indeks monotonik absolut `uint64` 64-bit yang tumbuh terus tanpa pernah membungkus kembali ke-0 (*wrap-around*), secara de-facto melindungi Anda dari fenomena *ABA*. CPU harus menyala ribuan tahun untuk bisa kehabisan counter 64-bit, asalkan Anda tak pernah me-reset `Tail`.

## Deep Internals: HFT CPU Caching & False Sharing

Dalam HFT, latensi diukur dalam *nanosecond* (ns). Akses ke memori utama (RAM) memakan waktu ~100ns, sedangkan L1 Cache CPU hanya ~1ns. Ring buffer dirancang agar data tetap hangat di L1/L2 Cache.

### Cache Line Bouncing (Ping-Pong Effect)
CPU memuat memori dalam bentuk balok (chunk) yang disebut **Cache Line** (biasanya 64 byte). 
Jika Produsen (`Tail`) dan Konsumen (`Head`) diletakkan bersebelahan di dalam struktur data yang sama, mereka akan berada di Cache Line yang sama.
Setiap kali Produsen memodifikasi `Tail`, Cache Line tersebut diinvaliasi secara global di seluruh inti CPU (via protokol MESI). 
Ketika Konsumen ingin membaca `Head`, ia dipaksa melakukan *cache miss* dan mengambil ulang dari RAM/L3 Cache. Ini disebut **False Sharing**.

### Diagram ASCII: False Sharing vs Padded Layout

```text
[❌ False Sharing - Bad Layout]
Cache Line (64 Bytes): | Head (8B) | Tail (8B) | Other (48B) |
Core 1 (Prod) mengubah Tail -> Cache Line Core 2 (Cons) menjadi INVALID!

[✅ False Sharing Terhindari - Padded Layout]
Cache Line 1 (64B): | Head (8B) | Padding (56B) | -> Dimiliki Core 2
Cache Line 2 (64B): | Tail (8B) | Padding (56B) | -> Dimiliki Core 1
```

## Implementasi MPSC (Multi-Producer, Single-Consumer)

MPSC Ring Buffer mengizinkan banyak Goroutine untuk memasukkan data (CAS) sementara satu Goroutine membaca.
Berikut implementasi *zero-alloc*, *lock-free* menggunakan `CompareAndSwap`:

```go
package hftalloc

import (
	"context"
	"fmt"
	"runtime"
	"sync/atomic"
	"testing"
)

// MPSCRingBuffer mendukung Multi-Producer
type MPSCRingBuffer struct {
	capacity uint64
	mask     uint64

	_    [56]byte
	head atomic.Uint64 // Konsumen

	_    [56]byte
	tail atomic.Uint64 // Multi-Produser (Reservasi)

	_         [56]byte
	published atomic.Uint64 // Produser selesai menulis

	_      [56]byte
	buffer []TickEvent
}

// NewMPSCRingBuffer inisialisasi dengan power of 2
func NewMPSCRingBuffer(powerOfTwo uint64) *MPSCRingBuffer {
	if powerOfTwo == 0 || (powerOfTwo&(powerOfTwo-1)) != 0 {
		powerOfTwo = 1024
	}
	return &MPSCRingBuffer{
		capacity: powerOfTwo,
		mask:     powerOfTwo - 1,
		buffer:   make([]TickEvent, powerOfTwo),
	}
}

// Offer (Multi-Producer) menggunakan CAS
func (rb *MPSCRingBuffer) Offer(ctx context.Context, ev *TickEvent) error {
	var currentTail uint64
	for {
		currentTail = rb.tail.Load()
		currentHead := rb.head.Load()

		if currentTail-currentHead >= rb.capacity {
			return ErrBufferFull
		}

		// Berebut slot dengan CAS
		if rb.tail.CompareAndSwap(currentTail, currentTail+1) {
			break // Berhasil mengklaim slot
		}
		runtime.Gosched() // Gagal klaim, yield CPU
	}

	idx := currentTail & rb.mask
	rb.buffer[idx] = *ev

	// Tunggu giliran publikasi untuk mempertahankan urutan FIFO (Spin)
	for {
		if rb.published.CompareAndSwap(currentTail, currentTail+1) {
			break
		}
		runtime.Gosched()
	}
	return nil
}

// Poll (Single-Consumer)
func (rb *MPSCRingBuffer) Poll(ctx context.Context, outEv *TickEvent) error {
	currentHead := rb.head.Load()
	currentPublished := rb.published.Load()

	// Hanya boleh membaca yang sudah selesai dipublikasi
	if currentHead == currentPublished {
		return ErrBufferEmpty
	}

	idx := currentHead & rb.mask
	*outEv = rb.buffer[idx]

	rb.head.Store(currentHead + 1)
	return nil
}
```

## Anti-Patterns Lanjutan (HFT)

### ❌ Anti-Pattern 3: Mengembalikan Pointer dari Ring Buffer
**Menghindari *value copy* dengan mengembalikan *pointer* struct.**

```go
// ❌ BAD: Mengembalikan pointer ke elemen internal buffer
func (rb *RingBuffer) Poll() (*TickEvent, error) {
    // ...
    return &rb.buffer[idx], nil // Escape Analysis: Memicu Heap Allocation!
}
```

**Mengapa Berbahaya:** Jika Anda mengembalikan pointer ke suatu blok memori yang digunakan berulang kali oleh Ring Buffer, Anda mengambil risiko **Data Race** mematikan. Produsen bisa menimpa struct saat pointer tersebut masih diproses oleh Konsumen. Selain itu, kompiler Go (Escape Analysis) mungkin menganggap pointer itu lolos (escape), sehingga memaksa *Heap Allocation* dan memicu *Garbage Collector (GC) Pause*.

```go
// ✅ GOOD: Pass-by-value atau pass-by-pointer argument
func (rb *RingBuffer) Poll(out *TickEvent) error {
    // ...
    *out = rb.buffer[idx] // Value copy mutlak (Aman dari race)
    return nil
}
```

### ❌ Anti-Pattern 4: Tidak Melakukan CPU Pinning (Thread Affinity)
**Mengandalkan Go Scheduler murni tanpa OS Pinning di lingkungan latensi ultra-rendah.**

**Mengapa Berbahaya:** Go Scheduler bebas memindahkan Goroutine dari *Core 1* ke *Core 5*. Perpindahan ini mematikan (*invalidate*) status L1/L2 Cache (*Cold Cache*), menambah penundaan hingga ratusan nanodetik tiap kali *context switch* terjadi.
✅ **GOOD**: Gunakan pustaka OS (*syscall*) untuk memaku (*pin*) Producer Goroutine dan Consumer Goroutine ke *CPU Core* yang spesifik secara persisten.

## Lanjutan Unit Tests & Benchmarks

Berikut adalah 3 fungsi benchmark dan test tambahan untuk *Coverage* standar HFT:

```go
// 1. Benchmark MPSC Parallel (Multi-Producer Contention)
func BenchmarkMPSCRingBuffer_Parallel(b *testing.B) {
	ctx := context.Background()
	rb := NewMPSCRingBuffer(8192)
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		evt := &TickEvent{Price: 200}
		for pb.Next() {
			_ = rb.Offer(ctx, evt) // CAS contention test
		}
	})
}

// 2. Unit Test Edge Case: Overlap & Wrap-around Data Integrity
func TestSPSCRingBuffer_WrapAround(t *testing.T) {
	ctx := context.Background()
	cap := uint64(4)
	rb := NewSPSCRingBuffer(cap)
	
	// Put 4 (Full)
	for i := uint64(0); i < cap; i++ {
		rb.Offer(ctx, &TickEvent{Price: int64(i)})
	}
	
	if err := rb.Offer(ctx, &TickEvent{}); err != ErrBufferFull {
		t.Fatal("Expected ErrBufferFull")
	}

	// Poll 2
	var out TickEvent
	rb.Poll(ctx, &out) // price 0
	rb.Poll(ctx, &out) // price 1

	// Put 2 (wrap around mask)
	rb.Offer(ctx, &TickEvent{Price: 4})
	rb.Offer(ctx, &TickEvent{Price: 5})

	// Poll semua memastikan urutan tidak rusak (FIFO integrity)
	expectedPrices := []int64{2, 3, 4, 5}
	for _, expected := range expectedPrices {
		if err := rb.Poll(ctx, &out); err != nil {
			t.Fatalf("Unexpected empty: %v", err)
		}
		if out.Price != expected {
			t.Fatalf("Wrap-around failed. Expected %d got %d", expected, out.Price)
		}
	}
}

// 3. Unit Test: Konsumen Ketinggalan (Slow Consumer Alert)
func TestMPSCRingBuffer_SlowConsumer(t *testing.T) {
	ctx := context.Background()
	rb := NewMPSCRingBuffer(2)
	
	_ = rb.Offer(ctx, &TickEvent{Price: 10})
	_ = rb.Offer(ctx, &TickEvent{Price: 20})
	
	err := rb.Offer(ctx, &TickEvent{Price: 30})
	if err != ErrBufferFull {
		t.Fatalf("Slow consumer tidak terdeteksi, harusnya penuh. Err: %v", err)
	}
}
```

## Lanjutan Edge Cases & Eksekusi Implementatif

4. **Goroutine Preemption (Penundaan Paksa oleh Scheduler)**:
   *Edge Case*: Dalam operasi MPSC (CAS), sebuah Produsen A sedang berada tepat di antara step 1 (Klaim Slot `Tail`) dan step 2 (Klaim Publikasi `Published`). Jika runtime Go menghentikan sejenak (preempt) Produsen A untuk *Garbage Collection*, maka semua Produsen B dan C di belakangnya akan terjebak *Spin-Wait* pada putaran `published.CompareAndSwap`. Ini memicu efek domino pelambatan masif.
   *Defensive*: Pada skenario kritis, ubah algoritma MPSC menjadi *Array of Atomic Pointers* di mana tiap slot bertanggungjawab akan *flag* publisitasnya sendiri, sehingga tidak ada *bottleneck* antrean global pada `published`.

5. **NUMA (Non-Uniform Memory Access) Node Cross-Talk**:
   *Edge Case*: Server HFT modern memiliki dua soket CPU (NUMA 0 dan NUMA 1). Jika Ring Buffer dialokasikan di RAM NUMA 0, tetapi Konsumen Goroutine dijalankan oleh Core di NUMA 1, terjadi latensi lintas *QPI/UPI link* (tambahan lambat ~30-40ns).
   *Defensive*: Selalu mendedikasikan (Pinning) Producer Goroutine, Consumer Goroutine, dan alokasi RingBuffer *make([]TickEvent)* ke dalam *NUMA Node* memori fisik yang sama.

6. **Struct Alignment (Word Size)**:
   *Edge Case*: Menggunakan tipe boolean (1 byte) atau `int32` (4 byte) tak teratur di dalam struct `TickEvent` memicu *compiler padding* tersembunyi (bytes kosong di antara field) dan penalti siklus baca/tulis memori.
   *Defensive*: Kelompokkan *fields* dengan ukuran dari yang paling besar (8 byte) ke yang terkecil, memastikan ukuran struct adalah kelipatan pasti 8 byte (atau 64 byte jika memungkinkan), yang akan mereduksi kemungkinan False Sharing pada elemen array secara dramatis.

## Kapan JANGAN Pakai Ini

- **Bila channel sudah cukup.** Channel Go sudah dioptimalkan dengan baik dan terintegrasi dengan penjadwal. Ring buffer lock-free hanya menang pada jalur mikrodetik yang benar-benar terukur — dan Anda harus punya angkanya sebelum memulai.
- **Menulis implementasi sendiri tanpa uji stres dan pemahaman model memori Go.** Bug lock-free tidak deterministik: ia muncul sekali dalam sejuta iterasi, di mesin produksi, dan tidak bisa direproduksi di laptop.
- **Tanpa memutuskan perilaku saat penuh.** Menjatuhkan, memblokir, atau menimpa adalah tiga perilaku dengan konsekuensi bisnis yang sama sekali berbeda. Memilihnya secara implisit adalah kesalahan desain, bukan detail implementasi.
- **Multi-producer multi-consumer padahal single-producer cukup.** SPSC jauh lebih sederhana, lebih cepat, dan jauh lebih mudah dibuktikan benar.
- **Tanpa padding cache line antara indeks baca dan tulis.** False sharing bisa membuat ring buffer lock-free **lebih lambat** daripada mutex biasa.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Throughput tidak naik saat core ditambah | rasio cache-miss | False sharing antara indeks baca dan tulis |
| Data hilang tanpa jejak | perilaku saat buffer penuh | Strategi penuh adalah "jatuhkan" tanpa metrik |
| Kerusakan data yang tidak bisa direproduksi | jumlah produser/konsumen nyata | Implementasi SPSC dipakai untuk MPMC |
| CPU tinggi tanpa kemajuan | profil CPU pada `atomic` | Spin loop tanpa backoff |
| Lebih lambat daripada channel | benchmark tandingan | Kompleksitas tanpa manfaat pada beban ini |

```bash
go test -race -count=50 -cpu=1,2,4,8 ./...
go test -bench='BenchmarkRing|BenchmarkChannel' -benchmem -count=10 -run='^$' ./...

# False sharing terlihat sebagai rasio cache-miss yang tinggi (Linux)
perf stat -e cache-misses,cache-references,LLC-load-misses ./app
perf c2c record -- ./app && perf c2c report --stdio | head -40

# Berapa banyak yang dijatuhkan saat penuh -- WAJIB jadi metrik
curl -s localhost:9090/metrics | grep -E 'ring_(dropped|full|depth)'
```
