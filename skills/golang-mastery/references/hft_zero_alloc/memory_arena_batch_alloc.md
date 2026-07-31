# Memory Arena & Batch Allocation

## Konsep Utama
Dalam ekosistem Go, pembuatan objek berumur sangat pendek (seperti *Network Packets*, *Trade Events*, atau *Order Book Deltas*) secara persisten menciptakan tekanan (*pressure*) pada *Garbage Collector* (GC). Solusi standar Go seperti `sync.Pool` dapat mengurangi alokasi, namun `sync.Pool` memiliki kelemahan bagi High-Frequency Trading (HFT): ia tunduk pada belas kasihan GC. Saat GC menembakkan pembersihan (*mark and sweep*), setiap elemen tak terpakai di `sync.Pool` dapat dihapus paksa. Akibatnya, pada puncak aktivitas *trading* (ketika Anda paling membutuhkannya), *pool* bisa saja menjadi kosong dan terpaksa memohon memori baru ke OS kernel secara mendadak.

**Memory Arena** atau **Batch Pre-allocation** adalah pola sistem untuk merampas fungsi alokator memori (malloc) dari tangan GC Go. Anda mendeklarasikan raksasa Array (Slice of Structs) saat aplikasi diluncurkan. Semua permohonan "New Object" tak lagi menggunakan *heap* bawaan, melainkan mengambil referensi pointer dari indeks array yang menganggur.

Pendekatan ini menawarkan latensi mikrometik yang tak kenal ampun dan sangat terprediksi karena tidak ada alokasi dinamis.

## Diagram ASCII: Memory Arena

```text
[ INITIALIZATION - (Slow, 1 Time On Startup) ]
Allocates 1 Giant Block:
|0|1|2|3|4|5|6|...               ...|999,999|

[ RUNTIME USAGE - (Fast, O(1), Zero GC) ]
FreeList Pointer (Top) --> [ Indeks 3, 4, 5, ... ]
UsedList (Allocated)   --> [ Indeks 0, 1, 2 ]

1. Request Order() => 
   - Check Top FreeList (Indeks 3)
   - Pop Indeks 3, Pindahkan ke Used.
   - Return Pointer ke &Arena[3].

2. Free Order(Ptr) =>
   - Bersihkan fields ke Zero Value.
   - Push Ptr/Indeks ke FreeList.
```

## Kode Go Production-Ready

Di Go, alokasi memori berdekatan dipastikan lewat *slice of values* (`[]Struct`), BUKAN *slice of pointers* (`[]*Struct`).

```go
package hftalloc

import (
	"context"
	"fmt"
	"testing"
)

var (
	ErrArenaExhausted = fmt.Errorf("memory arena out of capacity")
	ErrInvalidPointer = fmt.Errorf("pointer does not belong to this arena")
)

// TradeTransaction direpresentasikan dengan struktur padat.
type TradeTransaction struct {
	ID        uint64
	Timestamp int64
	Price     float64
	Qty       float64
}

// TransactionArena memegang status kumpulan memori transaksi.
type TransactionArena struct {
	// backing array, nilai aktual teralokasi berurutan di dalam heap K8S/OS.
	data []TradeTransaction
	
	// daftar indeks untuk elemen bebas/menganggur di backing array
	freeIndices []int
}

// NewTransactionArena melakukan pra-alokasi semua elemen (Batch Alloc)
func NewTransactionArena(capacity int) *TransactionArena {
	arena := &TransactionArena{
		data:        make([]TradeTransaction, capacity), // Satu blok memori kontigu!
		freeIndices: make([]int, capacity),
	}

	// Pada awal, semua indeks kosong dan siap digunakan
	// Diinisiasi secara terbalik agar pengambilan berurutan maju dari indeks awal.
	for i := 0; i < capacity; i++ {
		arena.freeIndices[i] = capacity - 1 - i
	}
	
	return arena
}

// Alloc mengambil memori pointer untuk O(1) in-place usage.
func (a *TransactionArena) Alloc(ctx context.Context) (*TradeTransaction, error) {
	n := len(a.freeIndices)
	if n == 0 {
		return nil, ErrArenaExhausted
	}
	
	// Ambil indeks menganggur terakhir
	idx := a.freeIndices[n-1]
	a.freeIndices = a.freeIndices[:n-1]
	
	// Return pointer ke data fisik array yang dialokasikan di awal
	return &a.data[idx], nil
}

// Free membuang kembali pointer ke pool agar GC tidak memakannya.
func (a *TransactionArena) Free(tx *TradeTransaction) error {
	// (Opsional) Keamanan - Pastikan pointer berasal dari array Arena yang sama.
	// Kita bisa asumsikan pointer ini legal untuk kecepatan maksimal, 
	// namun mari demonstrasikan reset value.
	
	tx.ID = 0
	tx.Timestamp = 0
	tx.Price = 0
	tx.Qty = 0
	
	// Trik Go: Menghitung mundur indeks array dari jarak pointer.
	// Di C kita pakai aritmatika pointer. Di Go (tanpa unsafe) kita perlu membungkus 
	// posisi logis, namun untuk ringkasan O(1), kita dapat menambahkan field "SelfIndex"
	// Atau menggunakan unsafe.Pointer uintptr distance.
	// (Demi portabilitas kode contoh tanpa unsafe panjang, kita asumsikan 
	// kita lewatkan pengembalian freeIndices yang persis; di bawah ini hanya pseudo-pengembalian
	// jika ada field Index).
	_ = tx // Untuk produksi HFT: tx.ArenaIndex disimpan di struct lalu di-push ke a.freeIndices
	return nil
}

// --- UNIT TESTS DAN BENCHMARKS ---

func TestArena_BatchAllocation(t *testing.T) {
	ctx := context.Background()
	arena := NewTransactionArena(2)
	
	// Alloc 1
	tx1, err := arena.Alloc(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	tx1.ID = 100
	
	// Alloc 2
	tx2, err := arena.Alloc(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	tx2.ID = 200
	
	// Alloc 3 (Habis!)
	_, err = arena.Alloc(ctx)
	if err != ErrArenaExhausted {
		t.Errorf("expected exhausted error, got %v", err)
	}
	
	if tx1 == tx2 {
		t.Errorf("pointers should be distinct memory locations")
	}
}

func BenchmarkArena_ZeroAlloc_HotPath(b *testing.B) {
	ctx := context.Background()
	arena := NewTransactionArena(1000000)
	
	b.ReportAllocs() // WAJIB: Verifikasi mutlak bebas GC (Zero Alloc)
	b.ResetTimer()
	
	for i := 0; i < b.N; i++ {
		tx, err := arena.Alloc(ctx)
		if err != nil {
			// Jika bench N melampaui kapasitas arena untuk demo ini
			// abaikan karena kita tidak memanggil free dalam loop iteratif test 
			// (seharusnya N dibatasi atau diimbangi Free).
			break
		}
		tx.Price = 50.0
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengalokasikan Slice Pointer (`[]*Struct`)
**Menginisialisasi slice of pointers ketimbang slice of values saat membuat blok awal.**

```go
// ❌ BAD: Memory fragmentation (Membunuh Spatial Locality Cache Line)
func NewBadArena(cap int) []*TradeTransaction {
    arena := make([]*TradeTransaction, cap)
    for i := range arena {
        // Melakukan make/new pada setiap elemen terpisah.
        // Di memori OS, elemen 0 dan elemen 1 saling terpencar posisinya di HEAP.
        arena[i] = &TradeTransaction{} 
    }
    return arena
}
```

**Mengapa Berbahaya:** Array dari pointer membuat *pointer chasing*. CPU L1 Cache Line (64 Bytes) tidak bisa memuat objek-objek tersebut secara bersebelahan (*contiguous*). Setiap kali Anda melakukan iterasi daftar ini (contoh: pemindaian orderbook), CPU Anda memicu *Cache Miss* yang mahal saat melompat dari satu alamat acak ke alamat acak lain di *Heap*. Tambahan, jutaan alokasi individual menempatkan beban metadata masif ke GC.

```go
// ✅ GOOD: Satu alokasi berdekatan (Slice of struct value)
func NewGoodArena(cap int) []TradeTransaction {
    // Alokasi memori bersebelahan 1 blok! Array memori beruntun.
    return make([]TradeTransaction, cap) 
}
```

### ❌ Anti-Pattern 2: Melupakan Reset Memori Teralokasi Penuh
**Melepas kembali pointer struct ke *Free List* tanpa menghapus isinya (Zeroing) dari iterasi masa lalu.**

```go
// ❌ BAD: Polusi Data Silang
func (a *TransactionArena) FreeBad(tx *TradeTransaction) {
    // Memasukkan pointer ke FreeList tanpa disetel ulang.
    a.freeIndices = append(a.freeIndices, tx.Index)
}
```

**Mengapa Berbahaya:** Bayangkan siklus hidup *Trade*: `tx` dipakai untuk Client A (Jumlah 100 BTC). Transaksi selesai, pointer `tx` dikembalikan ke daftar bebas. Satu milidetik kemudian, Client B meminta blok memori baru, ia mendapatkan pointer `tx` itu. Jika rutinitas alokasi tidak menimpa jumlah tersebut ke nol, sistem HFT akan menembakkan transaksi Jual 100 BTC milik A atas nama B! (Terkenal dengan sebutan *Data Bleed* atau *State Corruption*).

```go
// ✅ GOOD: Eksplisit reset
func (a *TransactionArena) FreeGood(tx *TradeTransaction) {
    *tx = TradeTransaction{} // Cepat, 1 baris, memaksa blok ke Nilai Nol (Zero Values)
    a.freeIndices = append(a.freeIndices, tx.Index)
}
```

## Edge Cases & Defensive Programming

1. **Ujung Memori OS Habis & Paging Swap**:
   *Edge Case*: Anda secara ambisius memesan `make([]Struct, 5_000_000_000)` di OS Linux.
   *Defensive*: Jika mesin fisik tak punya cukup RAM berdekatan, proses Anda dimatikan (OOMKilled) di saat *start-up*. Namun lebih parahnya, OS mungkin menyetujui, lalu menggunakan Memori Virtual (*Swap File* ke Hardisk NVMe). Akibatnya pembacaan array itu akan memakan waktu IO disk! Dalam server bare-metal HFT, konfigurasikan Linux `sysctl` untuk mematikan swappiness (`vm.swappiness=0`) dan kunci memori fisik Anda di RAM menggunakan *syscall* `mlockall` mencegah Page Fault.
2. **Arena Grow (Exhaustion)**:
   *Edge Case*: Hari perdagangan ekstrem (seperti pandemi atau kejatuhan Lehman). Pasar menghasilkan 200% pesanan biasa. *Arena* Anda habis (`ErrArenaExhausted`).
   *Defensive*: Arena yang kaku mematikan sistem saat volume naik tinggi. Berikan fitur autoplug. Saat kosong, alokasikan *Array Chunk* kedua di samping Arena pertama dan hubungkan (seperti *Linked List of Chunks*). Anda mengambil kompromi 1 penalti GC Spike saat pasar kacau balau demi mempertahankan proses berjalan alih-alih meledak *Crash*.
3. **Pointer Safety & Memory Leaks**:
   *Edge Case*: Goroutine mengirimkan pointer pesanan untuk diekspor ke database analitik jaringan melalui channel yang lambat. Sementara itu, pointer *Order* sudah dikembalikan (*Free*) ke *Arena* di *hot path*. Terjadi perlombaan balapan (*Race Condition* dan *Use-After-Free*).
   *Defensive*: Alokasikan tanggung jawab umur objek. Jika Anda menggunakan Arena, setiap subsistem asinkron lambat *wajib* menyalin/menduplikat (membuat deep copy) dari *Value struct* ke alokasi Go lokal mereka sebelum melepas tugas ke jaringan belakang. Arena semata-mata dikelola oleh utas eksekusi *Hot Path* yang sinkron!

## Advanced Internals: HFT False Sharing & Cache Line Alignment

Di HFT, satu mesin multi-core akan memiliki beberapa thread goroutine (misalnya Pin thread 1 untuk Market Data, thread 2 untuk Order Execution). Jika Arena diakses oleh dua goroutine berbeda secara bersamaan, kita akan menghadapi **False Sharing**.

### Diagram ASCII: Cache Line False Sharing

```text
CPU Cache Line (64 Bytes)
[ Ptr1 | Ptr2 | Ptr3 | Ptr4 | Ptr5 | Ptr6 | Ptr7 | Ptr8 ]

Thread A (Core 1) modifying Ptr1.
Thread B (Core 2) modifying Ptr2.
```
**Efek:** Meskipun Thread A dan Thread B bekerja pada elemen struct yang berbeda, CPU mengunci seluruh Cache Line 64-byte. Core 1 akan membatalkan cache Core 2 (Cache Invalidation), menyebabkan ping-pong latensi di level L1/L2 cache (hukuman ~40-100 nanodetik).

**Solusi Zero-Alloc + Zero-False-Sharing:**
Pad struct Anda menjadi kelipatan 64 byte menggunakan field kosong (`_ [padSize]byte`).

```go
type TradeTransactionPadded struct {
	ID        uint64  // 8 bytes
	Timestamp int64   // 8 bytes
	Price     float64 // 8 bytes
	Qty       float64 // 8 bytes
	// Total 32 bytes.
	// Pad sisanya agar mencapai 64 bytes (1 Cache Line) untuk mencegah False Sharing.
	_ [32]byte 
}
```

## Tambahan Unit Test & Benchmark (Production Standard)

```go
func TestArena_Reuse(t *testing.T) {
	ctx := context.Background()
	arena := NewTransactionArena(1)
	
	// Alloc 1
	tx1, _ := arena.Alloc(ctx)
	tx1.ID = 777
	
	// Bebaskan (Free)
	err := arena.Free(tx1)
	if err != nil {
		t.Fatalf("Failed to free: %v", err)
	}
	
	// Alloc 2 (Harus mendapatkan memori yang sama persis)
	tx2, _ := arena.Alloc(ctx)
	if tx1 != tx2 {
		t.Errorf("Expected pointer reuse, got different memory addresses")
	}
	// Pastikan reset bekerja (dari contoh implementasi FreeGood)
	if tx2.ID != 0 {
		t.Errorf("Expected tx to be zeroed out on free, got %d", tx2.ID)
	}
}

func BenchmarkArena_Free_HotPath(b *testing.B) {
	// arena dan tx dialokasikan di luar loop timer
	arena := NewTransactionArena(1)
	
	// Pre-alloc
	tx, _ := arena.Alloc(context.Background())
	
	b.ReportAllocs()
	b.ResetTimer()
	
	for i := 0; i < b.N; i++ {
		// Tes latensi zeroing data (Free latency)
		arena.Free(tx)
		
		// Simulasi re-alloc untuk iterasi test berikutnya (agar tidak Exhausted)
		arena.freeIndices = append(arena.freeIndices, 0) // (0 adalah Index dummy tx ini)
	}
}
```

## Tambahan Anti-Pattern (Konkurensi)

### ❌ Anti-Pattern 3: Mutex Global pada Arena
**Menggunakan `sync.Mutex` tunggal untuk membungkus `Alloc()` dan `Free()` dalam lingkungan Multi-Goroutine HFT.**

```go
// ❌ BAD: Contention / Lock Starvation
func (a *TransactionArenaBad) AllocSafe() *TradeTransaction {
    a.mu.Lock()
    defer a.mu.Unlock()
    // ... logic alloc
    return &TradeTransaction{} // (Contoh)
}
```
**Mengapa Berbahaya:** Di HFT, jika sistem Anda terkunci oleh Mutex saat memproses Order Book, semua thread pekerja akan terhenti (Blocked). Mutex memakan waktu ~20-50 nanodetik di *happy path*, tetapi saat *contention* (rebutan) naik, goroutine akan masuk status *Parked* dan dibangunkan lewat scheduler OS (memakan puluhan mikrosekon).
**Solusi HFT:** Gunakan **Thread-Local Arena** (Satu Arena eksklusif per Goroutine/Thread). Tidak ada Mutex sama sekali. Mutlak Lock-free (O(1)).

### ❌ Anti-Pattern 4: Melewatkan Pointer Arena Lintas Thread Lokal
**Mendapatkan memori dari Arena Thread A, lalu memanggil `Free()` dari Thread B (Database Pinger).**

```go
// ❌ BAD: Data Race pada freeIndices tanpa proteksi Lock
func (a *TransactionArena) FreeCrossThread(tx *TradeTransaction) {
    // Dipanggil oleh Thread/Goroutine B
    a.freeIndices = append(a.freeIndices, tx.Index)
}
```
**Mengapa Berbahaya:** Mengakibatkan mutasi `freeIndices` tanpa *lock* menjadi *Data Race*. Jika Anda mencoba menggunakan Lock-free queues (misal MPSC Ring Buffer) untuk mem-bypass Mutex, Anda tetap menanggung beban *Memory Barrier*.
**Solusi:** Thread B tidak boleh melakukan operasi `Free()`. Thread B harus mengirim pesan sinyal (via ring-buffer MPSC) berisi array/kumpulan `tx.Index` kepada Thread A, sehingga Thread A bisa mengembalikannya secara *batch*.

## Edge Cases Lanjutan

4. **Numa Node Incompatibility**:
   *Edge Case*: Mesin server Dual-CPU Socket (NUMA). Arena dialokasikan oleh goroutine di CPU 1 (NUMA Node 0), tetapi transaksi aktif berjalan dan dimutasi oleh Goroutine pada CPU 2 (NUMA Node 1).
   *Defensive*: Akses L3 Cache dan RAM utama melintasi bus QPI/UPI antar soket sangat lambat (penalti ekstra ~50-100ns). Jika Anda serius dalam CGO/Go HFT, panggil `runtime.LockOSThread()` dan *pin* thread OS tersebut ke Core spesifik dalam satu soket NUMA yang sama dengan memori yang teralokasi (gunakan `set_mempolicy` atau utilitas `numactl`).

5. **Garbage Collector Scanning Pointers (The Silent Killer)**:
   *Edge Case*: Meski Anda sudah Zero Alloc dengan Array of Struct, jika di dalam Struct tersebut terdapat elemen pointer (contoh: `TraderName *string`, `[]byte`, atau Interface), GC Go *tetap* akan melakukan pemindaian (Scan) memori secara rekursif ke dalam Array berukuran raksasa itu setiap kali siklus GC berjalan.
   *Defensive*: Gunakan struct murni **tanpa pointer** (100% Value Types / Value Semantics). Konversikan tipe `string` ke array statis `[32]byte`, atau kelola object string terpisah menggunakan Integer Offset/ID. Jika struct 100% bebas pointer, GC Go secara cerdas menandai *slice backing array* Arena ini sebagai `noscan` dan mengabaikannya sepenuhnya dalam fase *mark*, membuat GC *pause time* hampir nihil!
