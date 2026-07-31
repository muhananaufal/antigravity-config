# Golang Escape Analysis & Memory Profiling (pprof)

## 1. Konsep dan Arsitektur Internal (Technical Depth)

Salah satu alasan mengapa bahasa Go bisa sangat cepat secara operasional (sebanding dengan bahasa tanpa GC seperti C/Rust di banyak beban kerja I/O) adalah efisiensi algoritma kompilernya dalam meletakkan data variabel di memori. Ini diatur oleh *Escape Analysis*.

### Paradigma Penempatan Memori
1.  **Stack Allocation:** Setiap Goroutine memiliki memori *stack* pribadi. Variabel yang dialokasikan di *stack* dihapus seketika begitu fungsi *return* (dengan menggeser pointer memori *Stack Pointer* ke bawah). Biaya eksekusi alokasi *stack* praktis adalah `nol`, dan hal ini 100% lolos dari jeratan *Garbage Collector*.
2.  **Heap Allocation:** Memori *heap* bersifat global dan dibagikan. Memori di sini dialokasikan melalui *mheap/mcache* runtime dan wajib disapu kembali oleh *Garbage Collector* secara iteratif (menimbulkan *CPU overhead* tambahan).

### Mekanisme Escape Analysis
*Escape Analysis* dijalankan secara statis pada saat tahap kompilasi (*compile time*), bukan saat *runtime*. Kompiler menelusuri grafik *Abstract Syntax Tree (AST)* setiap fungsi untuk memutuskan: *Apakah referensi memori variabel ini berpeluang diakses/dibaca oleh fungsi lain setelah fungsi pembuatnya selesai berjalan?*
Jika jawabannya **YA** (variabel tersebut "melarikan diri/escape" dari scope-nya), kompiler secara diam-diam memindahkannya dari alokasi *stack* ke *heap*.

**Kondisi Umum Pemicu "Escape to Heap":**
1. Meneruskan *Pointer* (`*T`) ke *caller* yang level *stack*-nya lebih tinggi.
2. Menyimpan referensi di dalam variabel *Global*.
3. Menyimpan referensi di dalam *Closure function* (Anonymous goroutine variable capture).
4. Meneruskan data sebagai tipe `interface{}` (contohnya `fmt.Println(x)` yang menerima `...any`), menyebabkan proses *boxing* ke Heap.
5. Alokasi array/slice dinamik di mana ukuran *bound/capacity*-nya tidak diketahui pada saat kompilasi.
6. Ukuran statis data melebihi ambang batas ukuran *stack frame* lokal (Go membatasi ukuran maksimal objek lokal sebelum dipaksa masuk Heap).

---

## 2. Diagram ASCII: Escape Boundary

```text
===================================================================================
                       ESCAPE ANALYSIS GRAPH TRAVERSAL
===================================================================================

[ HEAP MEMORY (Global) ]  <-----------+ (GC Bekerja di sini)
                                      |
                                      | "Escaped Objects"
=================( BOUNDARY OF RETURN ADDRESS / LIFETIME )=========================
                                      |
[ GOROUTINE STACK ]                   |  (Tidak Butuh GC, O(1) Allocation)
                                      |
+---------------------------------+   |
| callerFunc()                    |   |
|   - a := getLocalValue()        |   |
|   - b := getEscapedPointer() ---|---+ (Pointer dikirim melampaui batas scope)
+---------------------------------+
               |
               v
+---------------------------------+
| getEscapedPointer() *User {     |
|   u := User{Name:"Bob"}         | ---> Kompiler melihat "u" dipassing sebagai pointer!
|   return &u                     | ---> Jika ditaruh di stack, saat `getEscapedPointer` selesai,
| }                               |      memori Stack 'u' akan terhapus. Caller dapat Dangling Pointer!
+---------------------------------+      Maka, Compiler menyuntik instruksi `runtime.newobject`.

+---------------------------------+
| getLocalValue() User {          |
|   u := User{Name:"Alice"}       | ---> Dikembalikan secara Value (Copy by Value).
|   return u                      | ---> "u" TIDAK escape. Tetap di Stack. (Efisien)
| }                               |
+---------------------------------+
```

---

## 3. Production-Ready Go Code: Analisis dan Optimisasi Pprof

Mengetahui teori adalah satu hal; memvalidasi *heap profiling* menggunakan `pprof` di production adalah praktik *Principal Engineer*. Kode ini mendemonstrasikan integrasi HTTP pprof secara aman dan sebuah kasus optimisasi struct yang terbukti mengurangi *heap allocation*.

```go
package runtime_internals

import (
	"context"
	"fmt"
	"io"
	// SANGAT PENTING: Untuk production, hindari '_' blank import di main MUX.
	// Daftarkan handler net/http/pprof pada MUX internal terpisah secara manual.
	// "net/http/pprof" 
	"testing"
)

// HeavyReport melambangkan dokumen dengan beban besar
type HeavyReport struct {
	Title string
	Data  []byte // slice header 24 bytes (Pointer, Len, Cap)
}

// ❌ VERSI LAMA: Fungsi yang membocorkan alokasi ke Heap.
// Mengembalikan pointer ke struct yang didefinisikan lokal.
func generateReportEscaping(title string) *HeavyReport {
	// Kompiler Go akan menampilkan pesan: 
	// "./main.go:x: moved to heap: r" (jika dibuild dengan -gcflags="-m")
	r := HeavyReport{
		Title: title,
		Data:  make([]byte, 1024), // Array dinamik membesar ke heap
	}
	return &r
}

// ✅ VERSI OPTIMAL: Fungsi yang meniadakan Heap Escape (Stack Only).
// Pemanggil bertanggung jawab menyediakan memorinya (Dependency Injection memory).
// Pola ini banyak dipakai pada interface io.Reader (baca ke buffer, jangan return buffer baru).
func generateReportStackOnly(title string, buf []byte, out *HeavyReport) {
	// 'out' dan 'buf' disediakan oleh caller. 
	// Fungsi ini murni mutasi mutator tanpa meng-alloc di stacknya sendiri!
	// Tidak ada memory yang melarikan diri ("escape") di sini.
	out.Title = title
	
	// Copy memory dengan aman 
	copy(buf, []byte("generated fake content"))
	out.Data = buf
}

// --- PROFILING INSTRUCTION (HOW TO OBSERVE) ---
/*
1. Build aplikasi Anda dengan instrumentasi escape analysis:
   $ go build -gcflags="-m -m" main.go

2. Saat aplikasi berjalan (asumsi pprof didaftarkan di localhost:6060):
   $ go tool pprof http://localhost:6060/debug/pprof/heap

3. Perintah konsol pprof untuk mencari biang kerok alokasi memori (heap thrashing):
   (pprof) top 20 -cum
   (pprof) list generateReportEscaping
*/

// --- UNIT TESTS ---

func BenchmarkEscapeVsStack(b *testing.B) {
	b.Run("Escaping Allocation", func(b *testing.B) {
		// Menghitung jumlah byte yang dialokasikan di HEAP.
		b.ReportAllocs() 
		for i := 0; i < b.N; i++ {
			_ = generateReportEscaping("Financial")
		}
	})

	b.Run("Stack Allocation (Zero Heap)", func(b *testing.B) {
		b.ReportAllocs()
		
		// Buffer dialokasikan di caller scope (atau sync.Pool).
		// Compiler melihat `rep` tidak pernah dipassing ke routine lain,
		// sehingga `rep` dan `buf` dialokasikan secara efisien di Stack lokal `Benchmark` ini!
		var rep HeavyReport
		buf := make([]byte, 1024) 

		for i := 0; i < b.N; i++ {
			generateReportStackOnly("Financial", buf, &rep)
		}
	})
}
```

---

## 4. Anti-Patterns Kinerja & Heap Allocation

### ❌ Anti-Pattern 1: Menyalahgunakan Abstraksi `interface{}` dan `any` Terlalu Luas
Tipe `interface{}` atau `any` menuntut *Go Runtime* untuk menyimpan tabel dinamik (metadata tipe dan nilai pointernya). Karena kompiler tidak dapat memastikan secara statis *concrete type* dan siklus hidup nilai yang dibungkus antarmuka ini pada saat kompilasi, kompiler terpaksa merujuk (mengalokasikan) nilainya ke *Heap*.

```go
// ❌ BAD: Menambahkan log sederhana tapi membunuh performa 
func ProcessData(id int, query string) {
    // fmt.Println menerima argumen variadic `...any`
    // Variabel integer `id` yang murni skalar (stack) terpaksa dibungkus "boxing" 
    // ke dalam representasi interface dan "ESCAPE" ke heap!
    // Ini mengotori GC hanya karena mencetak string!
    fmt.Println("Processing id:", id)
}
```
**Mengapa berbahaya:** Pada aplikasi jaringan skala gigabit, fungsi `logger.Info("request id", reqID)` yang menerima tipe generik `any` akan mengalokasikan objek temporer secara masif. Ini menyebabkan *GC Pause* melambung. *Latency* pada persentil 99th p99 akan hancur lebur.

```go
// ✅ GOOD: Gunakan *Zero-Allocation Logger* berbasis Concrete Types
import "go.uber.org/zap"

func ProcessData(id int, query string) {
    // Paket seperti Zap menggunakan field statis bertipe asli.
    // Tidak ada casting interface{}. 100% dialokasi di Stack.
    logger.Info("Processing id", zap.Int("id", id))
}
```

### ❌ Anti-Pattern 2: Penumpukan Slice Append yang Bocor
Menggunakan `append` dalam perulangan tanpa mendefinisikan kapasitas dasar (Capacity).

```go
// ❌ BAD: Re-alokasi Heap 
func extractIDs(data []User) []int {
    var ids []int // Length 0, Capacity 0
    for _, u := range data {
        // Jika loop ini berjalan ribuan kali, array "ids" akan penuh berulang kali.
        // Go harus mencari blok Heap baru, menyalin data lama (memcpy), dan membuang array lama.
        ids = append(ids, u.ID)
    }
    return ids
}
```
**Mengapa berbahaya:** Pertumbuhan slice Go berlipat ganda secara algoritmik. `append` akan merekayasa pemanggilan `runtime.growslice` secara konstan yang harus merambah *mcache/mcentral* di Heap OS, memperlambat sirkulasi *memory CPU cache*.

**Solusi (✅ GOOD):** Selalu, tanpa kompromi, inisialisasikan `capacity` dari slice jika ukuran akhir dapat ditebak atau diketahui dari panjang *source*.
```go
func extractIDs(data []User) []int {
    // Injeksi kapasitas sejak awal! Memory heap dipesan bulat hanya SATU kali!
    ids := make([]int, 0, len(data))
    for _, u := range data {
        ids = append(ids, u.ID)
    }
    return ids
}
```

---

## 5. Edge Cases Kritis dalam Escape Analysis

1. **Efek Ukuran Statis (Large Object Escape Threshold):**
   *Kasus:* Anda mendefinisikan *array* tetap di dalam fungsi untuk menampung *byte buffer*: `buf := [100000]byte{}` (100 KB ukuran statis). Anda tidak pernah mereturn pointer-nya, murni *Copy-by-Value* internal.
   *Edge Case:* Walau logika Anda tidak membocorkan memori, kompiler Go melempar array ini ke *Heap*! Mengapa? Kompiler memiliki `MaxStackVarSize` (biasanya sekitar 10MB, namun untuk array lokal dibatasi agar tak menghabiskan alokasi per-goroutine yang cuma 2KB-4KB awalnya).
   *Solusi Spesifik:* Jika fungsi Anda menuntut buffer spasial masif secara sesaat dan konstan, jangan andalkan alokasi goroutine stack (Kompiler akan diam-diam menghukumnya masuk Heap). Gunakan `sync.Pool` ber-kapasitas raksasa dan pakai ulang penunjuk (`pointer`) alokasinya tanpa mempedulikan Escape rules.

2. **Pointer Indirection dalam Closure (Capture By Reference):**
   *Kasus:* Mengeksekusi blok kode Go yang anonim dan menangkap variabel dari scope induk.
   ```go
   func launchWorker() {
       jobId := 10 // Skalar Integer
       go func() { fmt.Println("Kerjakan job", jobId) }()
   }
   ```
   *Edge Case:* Goroutine anak diluncurkan secara asinkron (kapan jadual eksekusinya ditentukan sembarang oleh *P Scheduler*). Ini berarti, Goroutine anak bisa berjalan **jauh setelah** fungsi `launchWorker` selesai dan terhapus *Stack* utamanya. Agar `jobId` tak hancur terbakar, Escape Analysis memindahkannya paksa ke Heap!
   *Solusi Spesifik:* Jika Anda meluncurkan 1 juta Goroutine, ini menciptakan 1 juta variabel sampah di Heap secara individu. Lebih efisien mengalokasikan parameter struktural statis yang di-*pass by value* sebagai argumen penangkap langsung: `go func(id int) {}(jobId)`.

3. **Slice Reslicing menjebak Base Array (Memory Leak via GC Pinning):**
   *Kasus:* Membaca file gambar berukuran 10MB ke dalam RAM `[]byte`, lalu fungsi Anda hanya melakukan *reslice* mengambil 50 byte metadata awal. 
   `header := imageBytes[:50]`. Anda kemudian menyimpan variabel `header` ini ke *global cache* jangka panjang.
   *Edge Case:* Di Go, slice (potongan) mewarisi (*share*) *underlying base array* yang sama. Meskipun `header` panjangnya 50 byte, variabel ini menahan **seluruh sisa 10MB RAM array induk** dari jangkauan *Garbage Collector*! GC tidak dapat memilah "oh, dia hanya butuh 50 byte", karena *GC tracing pointer* melihat satu bongkah utuh.
   *Solusi Spesifik:* Lakukan `copy` byte array data krusial tersebut ke struktur *array slice* yang sungguh-sungguh baru dengan kapasitas persis 50 byte: `clone := bytes.Clone(header)`. Lalu simpan *clone* tersebut dan biarkan *pointer* array asal gugur ditelan GC.
