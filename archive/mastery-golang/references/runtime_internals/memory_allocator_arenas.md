# Golang Memory Allocator & Arenas Internals

> **Berlaku:** Go 1.21+ · paket `arena` masih eksperimental (`GOEXPERIMENT=arenas`) · **Lihat juga:** `runtime_internals/gc_mark_sweep_internals.md` · `runtime_internals/escape_analysis_pprof.md` · `hft_zero_alloc/memory_arena_batch_alloc.md` · `concurrency/sync_primitives_deep.md`

## 1. Konsep dan Arsitektur Internal (Technical Depth)

Go memiliki *Memory Allocator* tingkat lanjut yang dimodelkan berdasarkan **TCMalloc** (Thread-Caching Malloc) milik Google. Allocator Go dirancang untuk menangani beban konkurensi (Goroutine) secara efisien tanpa mengalami *bottleneck* penguncian (lock contention) tingkat global, serta berfokus meminimalisir fragmentasi *heap*.

Secara struktural, arsitektur manajemen memori Go terbagi ke dalam tiga hierarki besar:
*   **mcache**: *Cache* memori lokal per utas eksekusi (dimiliki oleh `P` / Processor). Menyediakan akses bebas-kunci (*lock-free*) ke *span* memori saat Goroutine (G) membutuhkan objek memori kecil (≤ 32KB).
*   **mcentral**: Cache memori level menengah yang dibagikan (di-*share*) dan bersifat per-kelas ukuran (*size-class*). Jika `mcache` kehabisan *span*, ia meminta ke `mcentral` dengan menggunakan *mutex lock*.
*   **mheap**: Heap global yang bertindak sebagai antarmuka utama terhadap Sistem Operasi (OS). Meminta dan mengembalikan blok memori besar (dinamakan *Arenas*, 64MB di sistem 64-bit) ke OS secara langsung (menggunakan *system call* `mmap` di Unix/Linux).

### Hierarki Objek Memori
Allocator Go mengkategorikan alokasi menjadi 3 kelas berdasarkan ukuran objek:
1.  **Tiny Objects (< 16 Bytes)**: Dioptimalkan secara radikal. Digabungkan ke dalam 16-byte block untuk menekan *overhead* pointer per objek.
2.  **Small Objects (16 Bytes - 32 KB)**: Menggunakan alokasi *Size Classes* (terdapat ~67 kelas dari 8, 16, 32 hingga 32768 bytes). Meminimalisir fragmentasi eksternal. Objek ini dilayani langsung oleh `mcache`.
3.  **Large Objects (> 32 KB)**: Bypasses `mcache` dan `mcentral`. Langsung meminta ke `mheap` secara *page-aligned*.

---

## 2. Diagram ASCII: Hierarki Allocator Go

```text
===================================================================================
                       GO MEMORY ALLOCATOR HIERARCHY
===================================================================================

[ GOROUTINE 1 ]      [ GOROUTINE 2 ]               [ GOROUTINE 3 ]
       |                    |                             |
       v                    v                             v
+------------------------------------+         +-----------------------+
|             P (Processor)          |         |      P (Processor)    |
|                                    |         |                       |
|           [ mcache ]               |         |      [ mcache ]       |  (Lock-Free
|  +------------------------------+  |         |  +-----------------+  |   Allocation)
|  | Span Class 1 (8B): [ ][ ][ ] |  |         |  | SC 1: [ ][ ]    |  |
|  | Span Class 2 (16B):[ ][ ]    |  |         |  | SC 2: [ ]       |  |
|  +------------------------------+  |         |  +-----------------+  |
+------------------------------------+         +-----------------------+
       | (Cache Miss: mcache empty)                       |
       |                                                  |
===================================================================================
                                      | Lock (Mutex)
                                      v
+---------------------------------------------------------------------------------+
|                                 mcentral                                        |
|  (Global list of spans grouped by Size Class - Partial/Empty Spans)             |
|                                                                                 |
|  [ SC 1 (8B) Spans ] -----> [ Span (Full) ] -> [ Span (Partial) ]               |
|  [ SC 2 (16B) Spans ] ----> [ Span (Empty) ] -> [ Span (Empty) ]                |
+---------------------------------------------------------------------------------+
                                      | Lock (Mutex)
                                      v
+---------------------------------------------------------------------------------+
|                                  mheap                                          |
|  (Global memory manager allocating OS memory in 64MB Arenas and 8KB Pages)      |
|                                                                                 |
|   [ Arena 1 (64MB) ] -----> [ Page 1 (8KB) ] [ Page 2 (8KB) ] [ Page 3 ... ]    |
|   [ Arena 2 (64MB) ] -----> [ ... ]                                             |
+---------------------------------------------------------------------------------+
                                      | 
                                      v (mmap/madvise)
===================================================================================
                             OS VIRTUAL MEMORY MANAGER
===================================================================================
```

---

## 3. Production-Ready Go Code: Memory Profiling & Arena (Go 1.20+)

Go versi 1.20+ memperkenalkan fitur eksperimental `arena` (paket `arena`), yang memungkinkan alokasi memori manual yang dapat didealokasi secara instan sekaligus, *bypassing* proses iteratif Mark-and-Sweep. Ini sangat krusial untuk *gRPC endpoints* yang menghasilkan ribuan Protobuf temporer per *request*.

```go
package runtime_internals

import (
	"context"
	"fmt"
	// Fitur ini masih eksperimental, butuh flag GOEXPERIMENT=arenas
	// Namun secara konsep, package ini menunjukkan kontrol manual atas allocator 
	"arena" 
	"runtime"
	"testing"
)

// LargeDataProcessor mensimulasikan sistem yang merender ribuan
// record data sekali pakai dan langsung membuangnya (seperti rendering response JSON besar)
type LargeDataProcessor struct {
	// dependencies
}

// ProcessWithArena (Experimental Go 1.20+) 
// Memanfaatkan memory arena. Arena merupakan area heap (Chunk OS) terisolasi.
// Semua malloc di dalam arena ini dilepaskan secara mutlak (Free) dalam O(1) time
// tanpa menyebabkan fragmentasi mcache/mcentral.
func (p *LargeDataProcessor) ProcessWithArena(ctx context.Context, records int) ([]string, error) {
	// Inisiasi Memory Arena baru. 
	// Di belakang layar, ini meminta page baru langsung dari mheap,
	// bypassing mcache per-thread untuk menjamin linearitas block.
	memArena := arena.NewArena()
	
	// PENTING: Bebaskan seluruh Arena dalam 1 operasi (Free) saat selesai.
	// Jika lupa dibebaskan, memory leak fatal.
	defer memArena.Free()

	// arena.MakeSlice mengalokasi slice langsung ke memArena (bukan heap biasa).
	// Ini menjamin memori berada di chunk berdekatan (cache friendly).
	result := arena.MakeSlice[string](memArena, 0, records)

	for i := 0; i < records; i++ {
		// arena.New membuat object string dalam arena
		// Dalam prakteknya, alokasi struct raksasa seperti node AST sangat cocok disini
		strPtr := arena.New[string](memArena)
		*strPtr = fmt.Sprintf("Data-record-payload-%d", i)
		result = append(result, *strPtr)
	}

	// Lakukan sesuatu dengan array result.
	// Hati-hati: saat memArena.Free() dieksekusi oleh defer, 'result'
	// menjadi pointer menggantung (Dangling Pointers).
	// Ekstraksi data murni harus disalin ke heap standar jika dibutuhkan di luar scope ini.
	
	fmt.Printf("Processed %d records inside Memory Arena.\n", len(result))
	return nil, nil // Hanya simulasi; jangan return data beralaskan arena!
}

// CheckMHeapStatistics dapat digunakan untuk monitor fragmentasi mheap di environment prod
func CheckMHeapStatistics() float64 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	// Menghitung fragmentasi heap secara kasar
	// InUse vs Sys (dialokasikan oleh OS ke mheap namun belum digunakan goroutine)
	if m.HeapSys > 0 {
		return float64(m.HeapInuse) / float64(m.HeapSys)
	}
	return 0.0
}

// --- UNIT TESTS ---

func TestArena_UsageSimulations(t *testing.T) {
	processor := &LargeDataProcessor{}
	
	// Catat stats memori sebelum
	var statsBefore runtime.MemStats
	runtime.ReadMemStats(&statsBefore)

	// Lakukan eksekusi arena (misal 1000 record)
	_, err := processor.ProcessWithArena(context.Background(), 1000)
	if err != nil {
		t.Fatalf("Arena process failed: %v", err)
	}

	// Panggil GC secara eksplisit untuk membersihkan noise mcache standar
	runtime.GC()

	// Catat stats memori setelah defer arena.Free() berjalan
	var statsAfter runtime.MemStats
	runtime.ReadMemStats(&statsAfter)

	// Jika Arena bekerja, memori besar (ribuan array dan pointer) seharusnya
	// lenyap sepenuhnya dan tidak tersisa sebagai fragmentasi di mheap.
	t.Logf("Heap in use before: %d, after: %d", statsBefore.HeapInuse, statsAfter.HeapInuse)
}
```

---

## 4. Anti-Patterns Manajemen & Allocator Memori

### ❌ Anti-Pattern 1: Mengembalikan Struct/Slice Berbasis Arena ke Luar Fungsi
*Memory Arena* mematikan *Garbage Collector* secara lokal untuk blok memori tersebut, dan menukarnya dengan manajemen manual gaya C/C++. Jika Anda mengalokasikan Slice di dalam memori Arena, kemudian mereturn pointer-nya, Anda sedang menciptakan bom waktu referensi (Dangling Pointer).

```go
// ❌ BAD: Mengirim kembali data Arena 
func BuildConfig() *Config {
    a := arena.NewArena()
    defer a.Free() // Semua memori di dalam arena ini dihancurkan ketika fungsi return
    
    cfg := arena.New[Config](a) // Dialokasikan di Arena!
    cfg.Version = 1.0
    
    return cfg // FATAL! Membalikkan Dangling Pointer ke caller
}
```
**Mengapa berbahaya:** Pemanggil (`caller`) akan menerima variabel struct `Config` yang menunjuk pada ruang memori yang sudah di-`Free()` kembali ke OS kernel. Saat Goroutine *caller* mencoba membaca `cfg.Version`, program akan langsung *crash* dengan *Segmentation Fault*, atau lebih parahnya, membaca *garbage data* milik proses memori Goroutine lain!

```go
// ✅ GOOD: Menggandakan data yang relevan keluar dari Arena (Deep Copy) ke standar Heap
func BuildConfig() Config {
    a := arena.NewArena()
    defer a.Free()
    
    cfg := arena.New[Config](a)
    cfg.Version = 1.0
    
    // Salin nilai (by value) keluar, yang akan di-allocate di standard Heap
    return *cfg 
}
```

### ❌ Anti-Pattern 2: Fragmentasi Eksternal dengan Pembuatan Buffer Raksasa secara Dinamis
Di Go, kelas memori dengan ukuran besar (>32 KB) menghindari `mcache` / `mcentral` sama sekali dan dipanggil langsung ke struktur data pengelola `mheap` (menggunakan Treap/Radix tree). Jika layanan Anda secara sporadis mengalokasikan memori >32KB dengan *ukuran ganjil yang acak*, *mheap* akan terbelah belah (Fragmentasi).

```go
// ❌ BAD: Membuat alokasi besar tanpa alignment statis
func parsePayload(dynamicSize int) {
    // Jika dynamicSize == 42.100 bytes, lalu selanjutnya 65.300 bytes, dst.
    // mheap akan memotong page memori (OS-level) secara acak, menyisakan lobang.
    buf := make([]byte, dynamicSize) 
    process(buf)
}
```
**Mengapa berbahaya:** Jika fragmentasi *mheap* tinggi, Go runtime tidak bisa mengembalikan blok memori (menggunakan `madvise` MADV_DONTNEED ke OS) walau memori tersebut sebetulnya sudah dikosongkan. Layanan *Kubernetes Pod* Anda akan terus terlihat membesar secara RSS memory usage, dan OOM Killer membunuh Pod Anda (Memory Leak karena Fragmentasi).

```go
// ✅ GOOD: Alokasikan Size Class standar statis dan potong menjadi sub-slice (Slicing)
var globalPool = sync.Pool{
    New: func() interface{} { 
        // Mengalokasikan 64KB fix-size (mudah di-cache dan di-pool tanpa fragmentasi)
        return make([]byte, 64*1024) 
    },
}

func parsePayload(dynamicSize int) {
    buf := globalPool.Get().([]byte)
    defer globalPool.Put(buf)
    
    // Slice hanya bagian yang dibutuhkan, memori dasarnya tidak terfragmentasi
    workBuf := buf[:dynamicSize] 
    process(workBuf)
}
```

---

## 5. Edge Cases Kritis dalam Malloc & Mheap

1. **Memori Virtual vs RSS (Resident Set Size):**
   *Kasus:* Pada instance mesin dengan RAM sangat besar, Goroutine menciptakan ribuan blok *Arena mheap*. Go runtime sangat haus akan *Virtual Memory*. VIRT usage (dipantau via *htop*) mungkin menyentuh 50GB sementara RSS (memori nyata yang terpakai) hanya 1GB.
   *Edge Case:* Pada *cloud environments* yang mengunci rasio komitmen memori virtual tinggi (seperti instance tertentu di AWS Fargate atau cgroups ketat), OS dapat melakukan `SIGKILL` karena *overcommit*.
   *Solusi Spesifik:* Ini adalah perilaku lazim pengalokasi memori Go (menahan halaman memori via `mmap` dan menandainya `MADV_FREE` yang tidak segera menurunkan *RSS* di Linux lama). Atur variabel environment `GODEBUG=madvdontneed=1` untuk memaksa kernel menarik halaman kosong seketika, agar metrik *Grafana/cAdvisor* selaras dengan kenyataan *Heap*.

2. **Kejenuhan Mutex pada Mcentral (Lock Contention):**
   *Kasus:* Ribuan goroutine (`GOMAXPROCS=32`) secara terus-menerus mengeksekusi operasi `json.Unmarshal`. Karena `json.Unmarshal` menggunakan banyak refleksi (reflection) internal yang mengalokasikan struct dinamis.
   *Edge Case:* `mcache` lokal pada `P` sering terkuras (*Cache Miss*). Semua 32 CPU cores Goroutines dipaksa mengantre (`spin lock`) memohon memori baru pada `mcentral`. Terjadi penundaan (latensi) 1-5ms untuk fungsi remeh hanya karena menunggu kunci mutlak.
   *Solusi Spesifik:* Jika `pprof` menunjukkan *bottleneck* tinggi pada `runtime.mcentral.cacheSpan`, perbaiki lapisan aplikasi dengan menghilangkan alokasi dinamis (*zero-allocation json decoder* seperti `easyjson`) atau kurangi tingkat konkurensi (jangan proses 10,000 JSON concurrently dari MQ, gunakan *Batching* dengan jumlah *Worker Pool* tetap = CPU Core).

3. **CGO Memory yang Hilang dari Metrik Go (Hidden Heap):**
   *Kasus:* Menggunakan CGO untuk memanggil C++ library (contoh AI Inference atau Image Processing). Anda memantau `runtime.MemStats.HeapInuse`.
   *Edge Case:* `MemStats` HANYA melaporkan blok data dari pengelola Go `mheap`. Jika librari C melakukan `malloc()` sebesar 4GB, Go runtime akan mengabarkan bahwa heap usage Anda cuma 50MB! Anda tertipu dan mengira server aman.
   *Solusi Spesifik:* Lacak `cgo` allocations via `jemalloc` atau instrumentasi metrik dari OS Linux `sys/fs/cgroup/memory.current` (bukan mengandalkan `runtime.MemStats` Go), lalu sediakan proteksi sirkuit-breaker untuk menolak *request* CGO baru ketika mendekati batas host.

## Kapan JANGAN Pakai Ini

- **`arena` di kode produksi.** Ia berada di balik `GOEXPERIMENT`, tidak tercakup jaminan kompatibilitas Go 1, dan bisa dihapus tanpa jalur migrasi. `sync.Pool` dan slice yang dipakai ulang memberi sebagian besar manfaatnya tanpa risiko itu.
- **Mengoptimalkan allocator sebelum mengurangi alokasi.** Alokasi yang tidak pernah terjadi selalu lebih cepat daripada alokasi yang dipercepat.
- **Buffer raksasa berukuran beragam yang dialokasikan dinamis.** Objek di atas 32 KB masuk jalur large object dan diambil langsung dari mheap; ukuran yang berubah-ubah memperparah fragmentasi dan menahan span.
- **Menaruh objek berumur panjang di pool objek berumur pendek.** Itu membalik asumsi allocator dan menahan span yang seharusnya sudah bebas.
- **Membaca RSS sebagai ukuran heap.** Go mengembalikan memori ke OS secara bertahap. RSS yang tinggi setelah beban reda belum tentu kebocoran — bandingkan dengan `heap/released`.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| RSS jauh di atas heap yang hidup | `heap/objects` vs `heap/free` vs `heap/released` | Fragmentasi, atau memori belum dikembalikan ke OS |
| Alokasi besar berulang di profil | distribusi ukuran objek | Jalur large object; pertimbangkan buffer berukuran tetap |
| `sync.Pool` tidak menurunkan alokasi | rasio `Get` vs `Put` | Objek tidak pernah dikembalikan ke pool |
| Memori naik seiring jumlah goroutine | `os-stacks:bytes` | Yang tumbuh stack, bukan heap |
| Heap tinggi tapi objek hidup sedikit | `gctrace` kolom sesudah GC | Sampah menumpuk di antara siklus; laju alokasi terlalu tinggi |

```go
// runtime/metrics memberi pemisahan yang MemStats tidak berikan:
//   /memory/classes/heap/objects:bytes    objek yang hidup
//   /memory/classes/heap/free:bytes       span bebas, siap dipakai lagi
//   /memory/classes/heap/released:bytes   sudah dikembalikan ke OS
//   /memory/classes/os-stacks:bytes       memori stack seluruh goroutine
```

```bash
go tool pprof -sample_index=inuse_space   -top http://localhost:6060/debug/pprof/heap
go tool pprof -sample_index=alloc_objects -top 'http://localhost:6060/debug/pprof/allocs?seconds=30'

# Kolom heap pada gctrace: sebelum -> sesudah -> target
GODEBUG=gctrace=1 ./app 2>&1 | head -20
```
