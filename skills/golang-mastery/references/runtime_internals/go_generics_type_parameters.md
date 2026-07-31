# Golang Generics (Type Parameters) Internals

## 1. Konsep dan Arsitektur Internal (Technical Depth)

Generik (diperkenalkan pada Go 1.18) akhirnya memecahkan kutukan *boilerplate* kodifikasi fungsi berulang (misal `MaxInt`, `MaxFloat64`) di Go. Namun, implementasinya di balik layar sangat berbeda dengan C++ (yang menggunakan substitusi *Monomorphization* gila-gilaan) atau Java (yang menggunakan *Type Erasure* penuh via `Object`).

Go menggunakan hibrida yang cerdas: **Partial Monomorphization / Stenciling with Dictionaries**.

### Mekanisme Stenciling dan Dictionaries
1. **Monomorphization Murni (C++ style)**: Jika Anda memiliki fungsi generik dan memanggilnya dengan `int`, `int32`, dan `int64`, kompiler membuat 3 fungsi biner yang 100% independen di dalam eksekusi OS (membengkakkan ukuran biner).
2. **Go's GC Shape (GCShape) Stenciling**: Go kompiler tidak mengelompokkan instansiasi berdasarkan *Type Name* murni, melainkan berdasarkan **GC Shape** (bentuk alokasi memori yang dilihat *Garbage Collector*). Semua pointer (baik itu `*User`, `*int`, atau `*string`) memiliki bentuk memori yang persis sama di mata OS (misal statis 8 byte pada sistem 64-bit). Oleh karena itu, Go hanya mencetak **SATU** fungsi (*Stencil*) untuk seluruh varian *Pointer Type* yang digunakan!
3. **Dictionaries (Metadata Dinamis)**: Bagaimana fungsi Stencil tunggal tadi bisa membedakan tipe pointer A dengan pointer B saat harus mengeksekusi *method* (misal `.String()`)? Go secara diam-diam menyuntikkan argumen *tak kasat mata* ke dalam fungsi generik Anda. Argumen ini merujuk ke tabel VTable bernama **Dictionary**, yang berisi *pointer-to-methods* yang relevan khusus untuk tipe spesifik yang sedang dieksekusi tersebut.

### Type Constraints & Interface
Generik Go menggunakan `interface` secara jenius sebagai *Constraints*. Alih-alih antarmuka dinamis tradisional yang diselesaikan saat *runtime*, antarmuka yang mengandung *tilde* `~` (misal `~int`) memaksa validasi kompiler statis untuk seluruh *underlying type* yang bertopeng (seperti `type MyID int`).

---

## 2. Diagram ASCII: Partial Monomorphization

```text
===================================================================================
                   HOW GO COMPILER TRANSLATES GENERICS (STENCILING)
===================================================================================

[ USER CODE ]
  func PrintData[T any](item T) { ... }

  PrintData( int(42) )
  PrintData( float64(3.14) )
  PrintData( &User{} )
  PrintData( &Order{} )

===================================================================================
                            COMPILER PHASE (GC SHAPE ANALYSIS)
===================================================================================

Kompiler Go menganalisa bentuk alokasi (GC Shape):
 - `int` (8 bytes integer murni)       -> Shape A
 - `float64` (8 bytes float/FPU)       -> Shape B
 - `*User` (8 bytes memory pointer)    -> Shape C
 - `*Order` (8 bytes memory pointer)   -> Shape C  (IDENTIK!)

[ GENERATED BINARY CODE (The Stencils) ]

  1. Biner untuk Shape A:
     func PrintData_GC_int(item int) { ... }
     
  2. Biner untuk Shape B:
     func PrintData_GC_float64(item float64) { ... }
     
  3. Biner untuk Shape C (DIBAGIKAN UNTUK SEMUA POINTER!):
     func PrintData_GC_Pointer(DICT *Dictionary, item *void) { 
         // Kompiler menyuntik "DICT".
         // Jika item perlu mengeksekusi operasi spesifik (seperti method call),
         // instruksi perakitan akan melompat (JUMP) meminjam penunjuk tabel dalam DICT!
     }

[ KEUNTUNGAN ]
 - Mencegah "Binary Bloat" (membengkaknya file .exe hingga raksasa seperti C++).
 - Menjaga performa tetap brutal dan memori-efisien (tak ada Type Erasure Java).
===================================================================================
```

---

## 3. Production-Ready Go Code: Generic Ring Buffer (Zero Allocation)

Dalam sistem produksi bervolume tinggi, kita memanfaatkan generik untuk merakit struktur data yang bisa menampung `struct` raksasa atau *pointer* tanpa membocorkan konversi iteratif iterasi antarmuka (`interface{}`) yang kotor ke *Heap GC*.

```go
package runtime_internals

import (
	"context"
	"fmt"
	"sync"
	"testing"
)

// RingBuffer menggunakan Generik untuk meniadakan Heap Escape via box interface{}.
// Semua elemen bertipe konkret `T`, memungkinkan inline caching CPU yang padat.
type RingBuffer[T any] struct {
	mu     sync.Mutex
	data   []T
	head   int
	tail   int
	count  int
	size   int
}

// NewRingBuffer mengalokasikan array dasar dengan tipe presisi.
func NewRingBuffer[T any](capacity int) *RingBuffer[T] {
	return &RingBuffer[T]{
		data: make([]T, capacity),
		size: capacity,
	}
}

// Push menambahkan data. Mengembalikan error jika antrean penuh.
func (r *RingBuffer[T]) Push(ctx context.Context, item T) error {
	select {
	case <-ctx.Done():
		return fmt.Errorf("context canceled before push")
	default:
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if r.count == r.size {
		return fmt.Errorf("ring buffer is full")
	}

	// Alokasi zero-heap, tipe T disalin (Pass-by-value) lurus ke dalam RAM
	r.data[r.tail] = item
	r.tail = (r.tail + 1) % r.size
	r.count++

	return nil
}

// Pop mengambil elemen tertua.
func (r *RingBuffer[T]) Pop() (T, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	var zeroValue T // Konstruksi default nol (nil/0/"") dengan aman

	if r.count == 0 {
		return zeroValue, false
	}

	item := r.data[r.head]
	
	// PENTING: Bebaskan nilai dari array jika T adalah pointer!
	// Mencegah Garbage Collector tertahan merujuk ke objek usang.
	r.data[r.head] = zeroValue 
	
	r.head = (r.head + 1) % r.size
	r.count--

	return item, true
}

// --- UNIT TESTS ---

type AuditLog struct {
	ID      int
	Payload string
}

func TestRingBuffer_Generic_PointerSafety(t *testing.T) {
	// Tes dengan struct by Value
	bufVal := NewRingBuffer[AuditLog](5)
	
	err := bufVal.Push(context.Background(), AuditLog{ID: 1, Payload: "A"})
	if err != nil {
		t.Fatalf("Failed push: %v", err)
	}
	
	val, ok := bufVal.Pop()
	if !ok || val.ID != 1 {
		t.Errorf("Expected Log 1, got %v", val)
	}

	// Tes dengan Pointer (Memvalidasi Zeroing pointer lepas)
	bufPtr := NewRingBuffer[*AuditLog](5)
	
	memLog := &AuditLog{ID: 2, Payload: "PointerLeakCheck"}
	bufPtr.Push(context.Background(), memLog)
	
	ptrVal, ok := bufPtr.Pop()
	if !ok || ptrVal.ID != 2 {
		t.Errorf("Expected pointer Log 2, got %v", ptrVal)
	}
	
	// Secara internal (unsafe access testing), elemen head indeks ke-0 sekarang HARUS <nil> 
	// (bukannya merujuk ke memLog) berkat injeksi 'zeroValue T'.
	if bufPtr.data[0] != nil {
		t.Errorf("Memory Leak detected! The RingBuffer array still holds pointer to popped element")
	}
}
```

---

## 4. Anti-Patterns Terkait Go Generics

### ❌ Anti-Pattern 1: Menggunakan Generik untuk Pengganti Antarmuka Dinamis Sederhana
Mengubah kode lama yang sudah *clean* hanya demi tren "Bebas dari `interface{}`" berujung pada meledaknya instruksi *compile* (Stenciling lambat).

```go
// ❌ BAD: Over-engineering generik tanpa keuntungan performa
// Mengubah kode IoC (Inversion of Control) standar ke generik.
type Server[L LoggerInterface, D DatabaseInterface] struct {
    log L
    db  D
}
func (s *Server[L, D]) Start() { s.log.Info("Starting") }
```
**Mengapa berbahaya:** Anda hanya memanggil fungsi *network*. Performanya ditentukan oleh latensi *I/O database dan network*, BUKAN kecepatan resolusi tipe! Menggunakan struct generik raksasa yang di-*instantiate* secara global dengan kombinasi `LoggerA, DbB` dan `LoggerX, DbY` akan membengkakkan ukuran eksekutor kompilasi file (waktu *compile* bertambah drastis). Go tidak didesain untuk *Generic Class Meta-programming* ala C++.

```go
// ✅ GOOD: Pertahankan Interface murni untuk Inversion of Control (DI)
type Server struct {
    log LoggerInterface // Duck-typing standar menyelesaikan ini dalam 1 struct (O(1) memory layout).
    db  DatabaseInterface
}
```

### ❌ Anti-Pattern 2: Tidak Meng-Nol-kan (Zeroing) Sisa Alokasi Array Generik
Ketika sebuah fungsi Pop dari array Generik menggeser pointer (misalnya Stack atau Ring Buffer), ia gagal membersihkan letak sel (*cell slot*) array tersebut.

```go
// ❌ BAD: Memory Leak Siluman
func (s *Stack[T]) Pop() T {
    s.top--
    val := s.items[s.top]
    // SEL ELEMEN array 's.items[s.top]' MASIH MENYIMPAN NILAI 'val'!
    // Jika 'T' disubstitusikan pengguna sebagai `*http.Request` (pointer struct raksasa), 
    // Go Garbage Collector (GC) tidak akan pernah menghapus *http.Request itu walau 
    // pemanggil program sudah tak menggunakannya!
    return val 
}
```
**Mengapa berbahaya:** Karena kompiler membungkam tipe spesifiknya, kita tidak sadar bahwa yang tersimpan adalah memori berharga (pointer atau slice array). Kegagalan melakukan "Nil" assignment pada antrean *Pop* menyebabkan *Ghost Memory Leak*. Node Kubernetes akan tewas dalam mode OOM (Out Of Memory).

**Solusi (✅ GOOD):** Selalu ciptakan konstruksi nilai-Nol (`zero-value`) di setiap pergeseran struktur linear.
```go
func (s *Stack[T]) Pop() T {
    s.top--
    val := s.items[s.top]
    
    var zero T // Kompiler mensintesa ini secara absolut benar (0 untuk int, nil untuk pointer)
    s.items[s.top] = zero // AMAN! Garis edar GC terputus (Pruning the reference graph)
    
    return val
}
```

---

## 5. Edge Cases Kritis dalam Implementasi Generik Go

1. **Pemanggilan Method pada Constraints `any` Memicu Error Kompilasi:**
   *Kasus:* Anda mencoba membuat utilitas untuk memanggil `.Close()` pada deretan tipe generik `[T any]`.
   *Edge Case:* `any` dalam *constraints* bukan berarti *Duck Typing* mutlak. Tipe T yang diikat dengan `any` TIDAK memiliki metode sama sekali di mata kompiler statis. Jika Anda memaksakan `item.Close()`, kompiler menendang *fatal type error*.
   *Solusi Spesifik:* Definisikan batasan *interface* yang konkret dan sempit, jangan gunakan tipe *sapu jagat* `any`. Tulis konstrain: `type Closer interface { Close() error }`, lalu buat parameter menjadi `func Clean[T Closer](items []T)`. Generik Go patuh terhadap kontrak batasan statis, bukan evaluasi bebas runtime.

2. **Keterbatasan Pointer Method Memicu Benturan Interface (Type Sets Constraint):**
   *Kasus:* Anda mendefinisikan *struct* nilai `type Counter int` yang memiliki *method set* pada referensi pointernya `func (c *Counter) Increment()`. Anda mem-passing variabel tersebut ke sistem antrean generik `[T MyConstraint]`.
   *Edge Case:* Jika *constraint* menuntut fungsi `Increment()`, tetapi Anda mem-passing variabel tersebut sebagai nilai langsung (by-value `Counter`), kompilasi akan gagal dengan kalimat membingungkan `Counter does not implement MyConstraint (Increment method has pointer receiver)`.
   *Solusi Spesifik:* Sintaks tipe penyatuan generik Go (Type Sets) tidak secara otomatis mengangkat nilai *value* menjadi *pointer* di bawah evaluasi *generics interface constraint*. Anda wajib melempar inisialisasi pointernya secara mutlak sejak awal (misal: `queue.Push(&myCounter)`).

3. **Perlambatan Alokasi Memori Melalui Konversi Tipe Ganda (Type Type-Switching):**
   *Kasus:* Anda membuat fungsi pemroses generik tunggal `Process[T any]`, lalu di dalamnya Anda melakukan `switch x := any(item).(type) { case int: ... }`.
   *Edge Case:* Anda membuang kehebatan Stenciling *monomorphization* ke tong sampah. Karena Anda me-*repack* tipe konkret T kembali ke *interface{}* (`any`), dan melakukan *runtime reflection switch*, memori yang tadinya murni dialokasikan efisien di *Stack*, tiba-tiba terjebak *Escape Analysis* dipaksa pindah ke *Heap*. *Latency* akan membengkak, objek berantakan dan GC menangis.
   *Solusi Spesifik:* Jika logika internal Anda harus bercabang secara drastis berdasarkan tipe data internalnya, artinya desain arsitektur Anda **TIDAK COCOK** untuk Go Generics! Bubarkan fungsi generiknya; gunakan model *method overloading* standar atau murni pendekatan *interface* tradisional. Jangan gabungkan generik dan tipe-casting dinamis dalam satu lorong padat.
