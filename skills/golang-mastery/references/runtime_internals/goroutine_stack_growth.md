# Goroutine Stack Growth & Shrinking Internals

## 1. Konsep dan Arsitektur Internal (Technical Depth)

Berbeda dengan utas OS (*Thread Native* seperti di C/C++ POSIX) yang sejak awal lahir menuntut porsi memori raksasa tak bergeming (umumnya 1MB-8MB ruang *virtual memory* per thread), Go menggunakan konsep **Contiguous Stack Dinamis** untuk *Goroutine*-nya. Ini adalah fondasi sesungguhnya dari kemampuan Go men-spawn jutaan konkurensi di server berukuran kecil.

Setiap goroutine lahir dengan *stack* (tumpukan) awal yang sangat tipis, yaitu **2048 bytes (2 KB)**.

### Siklus Pertumbuhan Bertahap (Contiguous Stack Growth)
1. **Stack Prologue Check (Pengecekan Ambang Batas):**
   Compiler Go menyuntikkan instruksi khusus (beberapa instruksi Assembly `CMP` dan `JUMP`) di awal (prologue) pendefinisian _setiap pemanggilan fungsi_. Instruksi ini akan membandingkan letak `Stack Pointer (SP)` saat ini dengan batas bawah *stack guard* goroutine.
2. **Kondisi Overflow (Morestack):**
   Jika tumpukan *stack* akan tembus atau ruangnya kurang dari 128 bytes, fungsi akan menghentikan alur rutinitasnya sejenak dan memanggil fungsi *runtime* magis bernama `runtime.morestack()`.
3. **Penyalinan Memori Utuh (Contiguous Copying):**
   (Berbeda dari era pra-Go-1.3 yang menggunakan _Split Stacks_ seperti _Linked-list_). Go saat ini mengalokasikan area blok *memori kontinu (Contiguous)* baru yang berukuran **2 kali lipat** lipat dari kapasitas asalnya (misal dari 2KB dipindah mutlak jadi 4KB, kemudian 8KB, 16KB).
   Seluruh data dan *pointer* di memori lama disalin menggunakan algoritma iterasi super cepat (Mirip operasi `memmove`).
4. **Penyesuaian Pointer Rekursif (Pointer Fix-up / Adjustment):**
   Karena ini adalah bahasa terkelola (*managed language*), memindahkan alamat memori stack berarti mematahkan letak (*address*) semua variabel referensi di dalam Goroutine tersebut! Go compiler dan runtime secara presisi melacak letak *pointers* berdasar tabel *Stack Map* lalu mengoreksi arah rujukan pointer tersebut ke lokasi *memori offset baru*. Sangat menakjubkan.

### Mekanisme Penyusutan (Shrinking)
*Stack* yang tumbuh sampai 10MB karena mengeksekusi rekursi masif, tak akan diam selamanya menelan RAM. Saat fase **Garbage Collection (GC) Mark**, Go menginspeksi ukuran aktual penggunaan stack goroutine. Bila ukuran terpakainya kurang dari **1/4 (25%)** kapasitas *stack*, Go mengalokasikan memori paruh ukuran (1/2), menyalin isinya, dan membuang memori raksasa yang usang.

---

## 2. Diagram ASCII: Mekanisme Contiguous Stack Growth

```text
===================================================================================
                       CONTIGUOUS STACK MEMORY ALLOCATION
===================================================================================

[ FASE AWAL ] - Goroutine baru dialokasikan

  +-------------------------------+ <--- Stack Base (G.stack.hi)
  | caller() Frame                | 
  | localVars (1 KB)              |
  +-------------------------------+ <--- Stack Pointer (SP)
  | Sisa Ruang (1 KB)             |
  +-------------------------------+ <--- Guard Page (G.stack.lo) (2KB boundary)

[ FASE PEMANGGILAN FUNGSI DALAM ]

 Goroutine memanggil `deepFunc()` yang membutuhkan memori Frame 1.5 KB!
 Compiler mendeteksi SP + 1.5KB melewati `Guard Page`.
 Terpicu `runtime.morestack`!

[ FASE ALOKASI DAN COPY (STACK GROWTH: 2x LIPAT = 4KB) ]

  Stack Lama (Dibuang / GC-ed)              Stack Baru (Ukuran 4KB)
  +-------------------------+             +-------------------------------+
  | caller() Frame          | ==========> | caller() Frame                |
  +-------------------------+   Disalin   +-------------------------------+
  | (Ruang Habis)           |             | deepFunc() Frame (1.5 KB)     |
  +-------------------------+             +-------------------------------+ <--- SP Baru
                                          | Sisa Ruang (1.5 KB)           |
                                          |                               |
                                          +-------------------------------+ <--- Guard Page

* Catatan: Semua pointer internal (yang mengarah ke variabel dalam stack lama) 
           direkonstruksi (Fix-up) oleh Go Runtime merujuk ke memori 4KB baru!
===================================================================================
```

---

## 3. Production-Ready Go Code: Memantau Batasan Stack dan Eksploitasi Stack

Dalam sistem berpresisi tinggi (misal *engine parser sintaks* atau *data walker* rekursif), pengembang harus mengontrol agar ledakan *stack* dapat dicegat sebelum *runtime* Go mengorbankan memori dengan fatal. Kode di bawah ini memperlihatkan mekanisme membatasi level *call frame depth*.

```go
package runtime_internals

import (
	"context"
	"fmt"
	"runtime/debug"
	"testing"
)

// ConfigStack melambangkan konfigurasi keamanan eksekutor rekursif.
type ConfigStack struct {
	MaxDepth int // Angka maksimal kedalaman pemanggilan Goroutine
}

// DataNode representasi graf bersarang (Nested Tree Data).
type DataNode struct {
	Value    string
	Children []*DataNode
}

// ProcessTree mensimulasikan pemrosesan rekursif dengan pelindung batas.
// Secara sengaja melewati "ctx" sebagai kontrol asinkron pertama,
// dan "currentDepth" (passing by value, dialokasi efisien di Stack).
func ProcessTree(ctx context.Context, node *DataNode, currentDepth int, cfg ConfigStack) error {
	select {
	case <-ctx.Done():
		// Memastikan goroutine bisa lepas andai terjadi pembatalan (Timeout/Cancel)
		return fmt.Errorf("operation canceled")
	default:
	}

	// PROTEKSI REKURSI (Anti-Stack Overflow / Mem-Blowup memori OS)
	if currentDepth > cfg.MaxDepth {
		return fmt.Errorf("stack recursion depth exceeded limit (%d). preventing memory corruption", cfg.MaxDepth)
	}

	// Simulasi pemrosesan
	if node == nil {
		return nil
	}

	for _, child := range node.Children {
		err := ProcessTree(ctx, child, currentDepth+1, cfg)
		if err != nil {
			return err
		}
	}
	return nil
}

// GenerateDeepTree menciptakan rantai pohon yang sangaaaat dalam.
func GenerateDeepTree(depth int) *DataNode {
	root := &DataNode{Value: "root"}
	curr := root
	for i := 0; i < depth; i++ {
		newNode := &DataNode{Value: fmt.Sprintf("child_%d", i)}
		curr.Children = []*DataNode{newNode}
		curr = newNode
	}
	return root
}

// --- UNIT TESTS ---

func TestGoroutineStackRecursionLimits(t *testing.T) {
	// Di environment OS sesungguhnya, batas mutlak stack Goroutine adalah
	// sekitar 1 GB (64-bit OS). Lebih dari itu, aplikasi mati mendadak (Crash `fatal error`).
	// Kita mensimulasikan batasan stack untuk sistem produksi.

	cfg := ConfigStack{MaxDepth: 1000} // Batas aman rekursi untuk arsitektur ini

	// Buat tree mematikan (2500 kedalaman)
	badTree := GenerateDeepTree(2500)
	
	ctx := context.Background()
	err := ProcessTree(ctx, badTree, 0, cfg)

	if err == nil {
		t.Fatalf("Expected stack depth error, but got nil")
	}
	t.Logf("Success protected from stack blowup: %v", err)
}

// Tuning Global Go Runtime Stack:
func init() {
	// Membatasi ukuran maksimal memori Stack untuk Goroutine Tunggal!
	// Jika ada goroutine menembus memori byte ini, Go Runtime melempar Panic mematikan.
	// Default: 1GB (64-bit) / 250MB (32-bit).
	// Kita bisa mengecilkan ini jika butuh sistem dengan footprint memori sangat kaku.
	
	// debug.SetMaxStack(8 * 1024 * 1024) // Batasi ke 8MB (Setara C pthread)
}
```

---

## 4. Anti-Patterns Kinerja Stack

### ❌ Anti-Pattern 1: Mengalokasikan Memori Vektor Raksasa di dalam Variabel Lokal
Banyak *programmer* dengan pola pikir C++ `stack-array` statis mencoba mendeklarasikan buffer matriks multi-megabyte menggunakan instansiasi statis lokal dalam fungsi untuk menghindari inisialisasi iteratif Heap.

```go
// ❌ BAD: Tumpukan Stack membengkak meledak!
func processHugeImageData() {
    // Array statis 1 Juta elemen uint64 (8 MB memori lokal!)
    var rawPixelMatrix [1_000_000]uint64 
    
    // Walau kompiler Go menyadari ini meledakkan frame dan secara diam-diam memindahkannya 
    // ke Heap via Escape Analysis (MaxStackVarSize check), namun perilaku 
    // seperti ini sering lolos di structs hierarki menengah.
    // Jika tidak escape (lolos ke Stack), Goroutine yang tadinya 2KB dipaksa
    // memanggil `morestack` berlipat kali dalam mikrodetik hingga menjebol 8MB!
    populateMatrix(&rawPixelMatrix)
}
```
**Mengapa berbahaya:** Menyalin stack (melipatgandakan *contiguous slice*) itu mahal secara siklus CPU (*memmove* masif). Semakin besar ukuran stack Anda secara dinamis meledak (contoh 2KB -> 4KB -> ... -> 8MB), Anda memaksa runtime menghabiskan 10 milidetik *latency* murni menyalin pointer. Waktu eksekusi hancur.

```go
// ✅ GOOD: Alokasi Heap Manual lewat Slice (ataupun Pool)
func processHugeImageData() {
    // Array Slice dialokasikan langsung di peranti Heap.
    // Menjaga Stack frame goroutine tetap kurus (< 1KB), tidak butuh `morestack` grow sama sekali!
    rawPixelMatrix := make([]uint64, 1_000_000)
    populateMatrix(rawPixelMatrix)
}
```

### ❌ Anti-Pattern 2: `defer` dalam Lintasan Looping (Membocorkan Frame Stack)
Menggunakan `defer` di dalam rutinitas iteratif besar (seperti memproses file demi file) tanpa membuat bingkai perantara (closure/anonymous func).

```go
// ❌ BAD: Akumulasi instruksi defer pada satu Stack Frame besar
func closeAllConnections(conns []net.Conn) {
    for _, c := range conns {
        // Terus menerus mendesak instruksi (dan pointer argumen) ke tumpukan 
        // internal _defer record_ dari goroutine. 
        // Stack Frame fungsi `closeAllConnections` menjadi gila-gilaan membesar!
        defer c.Close() 
    }
}
```
**Mengapa berbahaya:** Catatan `defer` ditumpuk di memori *frame stack goroutine* (*linked list struct `_defer`*). Jika daftar panjang itu 10.000 iterasi, *stack goroutine* yang sama akan meledak karena menyimpan 10.000 *pointer function pointer*. *Growth penalty* terus dialami dan *file descriptor* tertunda pelepasannya sampai loop raksasa selesai seluruhnya.

**Solusi (✅ GOOD):** Evaluasi *lifetime* defer ke *Stack Frame* yang paling sempit dengan memanggil fungsi anonim *(closure).*
```go
func closeAllConnections(conns []net.Conn) {
    for _, c := range conns {
        // Meluncurkan Stack Frame kecil seketika!
        // Dibuat dan dihancurkan dalam satu lompatan. Sangat efisien, defer tereksekusi langsung.
        func(conn net.Conn) {
            defer conn.Close()
            // Lakukan modifikasi...
        }(c)
    }
}
```

---

## 5. Edge Cases Kritis dalam Pertumbuhan Stack Goroutine

1. **Jebakan Penguncian FFI CGO (No-Stack-Growth di Wilayah C):**
   *Kasus:* Goroutine menyeberang panggilan ke *Native C library* via CGO, kemudian library C (yang berjalan dalam utas OS) mencoba secara *callback* kembali menembus fungsi Golang (`//export myFunc`).
   *Edge Case:* Saat fungsi C berjalan, *Go Runtime* tidak dapat memantau, memeriksa batas (`Guard Page`), atau membesarkan/mengecilkan stack C. Stack C statis murni. Jika kode C memanggil rutin Go raksasa, Go tak berdaya men-*grow* memori lintas batas (*cross boundary*) ABI! Sering meletup menjadi *Segfault*.
   *Solusi Spesifik:* Saat menulis kode C/C++ yang menginjeksi (callback) fungsi Go, jangan percayakan operasional berat ke Goroutine reinkarnasi tersebut. Terima sinyal/pesan di fungsi `//export`, taruh di buffer channel Go, biarkan *Goroutine Go murni (di wilayah Go-land)* murni mengeksekusinya secara asinkron (yang memori stack-nya 100% termonitor aman).

2. **Pointer Penunjuk Internal (Self-Referential Structs) Pasca-Stack-Grow:**
   *Kasus:* Di dalam *Goroutine stack*, Anda membangun tipe data struct `RingBuffer` yang *pointer* node-nya merujuk ke elemen memori *struct* di dalam variabel *stack* yang sama.
   *Edge Case:* Saat Goroutine memanggil fungsi rumit lain, tumpukan (*stack*) meledak memicu *Growth*. Go *Runtime* dengan brilian akan menyalin blok seluruh variabel ke ruang *memori baru* dan mengkoreksi nilai letak *pointers*. Namun, jika Anda menggunakan trik `unsafe.Pointer` atau `uintptr` (angka murni tanpa label *type-safe* pointer) untuk menyimpan struktur cincin internal Anda di stack, Go Runtime **GAGAL** mengenalinya sebagai *pointer*.
   Alamat tidak dikoreksi/di-update. Kode membaca *alamat memori lama yang sudah disapu OS!* Program meledak secara mistis.
   *Solusi Spesifik:* **Haram hukumnya** menyembunyikan referensi lokal (stack) via interupsi matematika murni seperti `uintptr` karena *Goroutine Stack* bisa berpindah alamat (*moving memory*) sekapan pun! Selalu gunakan tipologi *pointer murni* `*T` sehingga tabel *Garbage Collector (Stack Map)* dapat membantunya tetap awet.

3. **Goncangan Memori Sinkron (Stack Shrinking Pauses):**
   *Kasus:* Fungsi rutin poller TCP menerima paket gergasi 5MB sesekali, lalu diam menerima *heartbeat* 10 byte per jam selama ratusan hari.
   *Edge Case:* *Stack Shrinking* berjalan ketika siklus GC memindai goroutine. Jika Goroutine tersebut tak pernah membebaskan diri dari titik *sleep blocking* atau loop tak tentu, proses penyalinan dari *stack 10MB* diringkas jadi *2MB* (*memory shrinking copy*) terjadi, mengorbankan siklus CPU GC.
   *Solusi Spesifik:* Gunakan fungsi Goroutine secara temporal (*short-lived worker pattern*). Daripada poller TCP abadi yang menahan riwayat kedalaman stack gergasi, buat arsitektur loop utama kurus yang men-spawn goroutine kecil berumur-pendek per paket *network* yang datang.
