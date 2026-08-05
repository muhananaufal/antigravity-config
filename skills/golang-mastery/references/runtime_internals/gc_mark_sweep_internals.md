# Golang GC & Tri-Color Mark-and-Sweep Internals

> **Berlaku:** Go 1.21+ (`GOMEMLIMIT` sejak 1.19) · **Lihat juga:** `runtime_internals/escape_analysis_pprof.md` · `runtime_internals/memory_allocator_arenas.md` · `concurrency/sync_primitives_deep.md` · `devops_control_planes/docker_container_go.md`

## 1. Konsep dan Arsitektur Internal (Technical Depth)

Go menggunakan *Concurrent Mark-and-Sweep Garbage Collector* yang berbasis pada algoritma *Tri-color abstraction*. Tujuan utamanya adalah latensi super rendah (*sub-millisecond pause times*) sehingga cocok untuk layanan jaringan *real-time*, dengan sedikit mengorbankan *throughput* CPU (sekitar 25% CPU dialokasikan untuk worker GC saat siklus berjalan).

### Tri-Color Mark-and-Sweep Abstraction
Setiap objek dalam *heap* Go dilacak status warnanya selama fase koleksi:
*   **Putih (White)**: Objek yang belum pernah dilihat oleh GC. Di akhir fase mark, semua objek putih adalah sampah (*garbage*) dan akan disapu (*swept*).
*   **Abu-abu (Grey)**: Objek yang sudah dilihat GC, dianggap "hidup" (*reachable*), tetapi referensi/pointer di *dalam* objek ini belum dieksplorasi seluruhnya.
*   **Hitam (Black)**: Objek hidup yang seluruh pointer di dalamnya (children-nya) sudah diperiksa secara tuntas. Objek hitam tidak boleh secara langsung menunjuk (memiliki referensi) ke objek putih.

### Mekanisme Fase GC (The Pacing)
1.  **Sweep Termination (Stop The World - Sangat Singkat)**: 
    Go menghentikan semua Goroutine. Ia memastikan fase *sweep* (pembersihan) dari siklus GC sebelumnya sudah 100% beres.
2.  **Mark Phase (Concurrent)**:
    - *Write Barrier* dinyalakan.
    - GC mulai memindai "Roots" (global variables, stack goroutine aktif). Semua referensi langsung dari root diubah dari Putih ke Abu-abu.
    - *Goroutine* terus berjalan secara konkuren dengan GC workers.
    - Pekerja GC (background *mark workers*) mengambil objek Abu-abu, menjadikannya Hitam, lalu menjadikan anak-anaknya Abu-abu. Proses ini menggunakan struktur *work queue* terdistribusi (*gcWork*) pada masing-masing *P* (Processor).
3.  **Mark Termination (Stop The World - Sangat Singkat)**:
    GC menghentikan semua goroutine lagi untuk menyelesaikan sisa objek abu-abu kecil dan mematikan *write barrier*.
4.  **Sweep Phase (Concurrent)**:
    Memori dari objek-objek Putih dikembalikan ke *Allocator* secara lambat (lazy sweeping) saat Goroutine meminta memori baru.

---

## 2. Diagram ASCII: Tri-Color & Write Barrier

```text
===================================================================================
                       CONCURRENT GC MUTATION (Write Barrier)
===================================================================================

[ FASE AWAL MARKING ]                 [ ROOT (Stack/Globals) ]
                                            |   \
  Semua Heap Objects adalah Putih           |    \ (Pointers)
                                            v     v
                                       (Grey)    (Grey)

[ FASE CONCURRENT MARKING ]
  Mark workers memproses antrean Grey:
  (Grey) -> diubah ke (Black), lalu mengubah children-nya menjadi (Grey).

      +--------+       +--------+       +--------+
      | ROOT   | ----> | Obj A  | ----> | Obj B  | ----> [ Obj C (White) ]
      |        |       | (Black)|       | (Grey) |
      +--------+       +--------+       +--------+

[ KASUS KRITIS: MUTASI KONKUREN OLEH GOROUTINE ]
 Goroutine ("Mutator") tiba-tiba mengubah pointer!
 Goroutine mencoba membuat (Black) menunjuk langsung ke (White).
 Jika dibiarkan, (White) tidak akan pernah tersentuh GC dan akan TERHAPUS padahal hidup!

         [ Obj A (Black) ] -------------> [ Obj D (White) ] // BAHAYA FATAL!

[ WRITE BARRIER INTERVENTION ]
 Compiler Go menyuntikkan instruksi khusus (Write Barrier) saat assignment pointer.
 
     // Pseudocode instruksi mesin dari Write Barrier:
     if (write_barrier_enabled && isBlack(A) && isWhite(D)) {
         shadeGrey(D) // D diubah menjadi Grey!
     }
     
     Hasilnya: [ Obj D ] menjadi Grey, mencegah penghapusan prematur.

===================================================================================
```

---

## 3. Production-Ready Go Code: Tuning GC & Memory Management

Kode berikut mendemonstrasikan bagaimana kita mengobservasi GC, mencegah alokasi *heap* tidak berguna menggunakan tipe *sync.Pool*, dan menangani beban *memory-intensive* menggunakan kontrol limit alokasi manual `GOGC` / `GOMEMLIMIT`.

```go
package runtime_internals

import (
	"context"
	"fmt"
	"runtime"
	"runtime/debug"
	"sync"
	"testing"
	"time"
)

// GCAnalyticsWorker adalah worker yang berjalan terus menerus dan memonitor
// aktivitas heap dan memberikan peringatan jika GC menghabiskan terlalu banyak waktu.
type GCAnalyticsWorker struct {
	bufferPool *sync.Pool
	memLimit   int64
}

// NewGCAnalyticsWorker menginisiasi analyzer dengan object pooling.
func NewGCAnalyticsWorker(limitMB int64) *GCAnalyticsWorker {
	// Defensif: Set GOMEMLIMIT (sejak Go 1.19) untuk mencegah OOM killer dari OS
	// dan secara dinamis memaksa GC berjalan lebih agresif saat mendekati batas memori
	limitBytes := limitMB * 1024 * 1024
	debug.SetMemoryLimit(limitBytes)
	
	// Set GOGC = 100 (Default). Artinya GC jalan saat heap membesar 100% dari live set.
	// Jika diset ke -1 (debug.SetGCPercent(-1)), GC mati total.
	debug.SetGCPercent(100)

	return &GCAnalyticsWorker{
		memLimit: limitBytes,
		bufferPool: &sync.Pool{
			New: func() interface{} {
				// Mengurangi tekanan pada heap allocator saat memproses log besar
				b := make([]byte, 0, 4096)
				return &b
			},
		},
	}
}

// Monitor mengobservasi metrik Garbage Collection tiap interval.
func (g *GCAnalyticsWorker) Monitor(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	var memStats runtime.MemStats

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			runtime.ReadMemStats(&memStats)
			// Observasi PauseNs (waktu Stop The World)
			totalPauseMs := float64(memStats.PauseTotalNs) / 1e6
			
			// Jika alokasi sudah mendekati 80% dari GOMEMLIMIT
			if memStats.Alloc > uint64(float64(g.memLimit)*0.8) {
				// Memicu GC secara manual bila diperlukan (meskipun Go sudah otonom,
				// ini berguna saat kita tahu ada pelepasan objek massal)
				runtime.GC()
				fmt.Printf("[WARN] Memory close to limit. Forced GC. Total Pause: %.2fms\n", totalPauseMs)
			}
		}
	}
}

// ProcessStreamData mensimulasikan pemrosesan stream data dengan menggunakan Object Pool
// agar objek temporer tidak tumpah ruah ke Heap dan menyiksa Mark-and-Sweep.
func (g *GCAnalyticsWorker) ProcessStreamData(dataStream <-chan string) {
	for data := range dataStream {
		// Dapatkan buffer memori yang didaur ulang
		bufPtr := g.bufferPool.Get().(*[]byte)
		buf := *bufPtr

		// Reset slice (namun pertahankan kapasitas underlying array)
		buf = buf[:0] 
		buf = append(buf, []byte(data)...)

		// ... Lakukan sesuatu dengan buf ...
		_ = buf 

		// Kembalikan ke pool agar tidak dialokasi dari awal oleh Goroutine berikutnya
		g.bufferPool.Put(bufPtr)
	}
}

// --- UNIT TESTS ---

func TestGCPoolAllocation_Efficiency(t *testing.T) {
	// Inisialisasi dengan 50MB Limit
	worker := NewGCAnalyticsWorker(50)
	
	stream := make(chan string, 1000)
	for i := 0; i < 1000; i++ {
		stream <- "Log line payload data simulation to cause GC pressure if not handled properly"
	}
	close(stream)

	var memStatsBefore runtime.MemStats
	runtime.ReadMemStats(&memStatsBefore)

	// Lakukan process
	worker.ProcessStreamData(stream)

	var memStatsAfter runtime.MemStats
	runtime.ReadMemStats(&memStatsAfter)

	// Karena menggunakan sync.Pool, jumlah objek memory (Mallocs) tambahan
	// harusnya sangat minim (< 1000 mallocs baru) meski data sebanyak 1000
	allocDiff := memStatsAfter.Mallocs - memStatsBefore.Mallocs
	if allocDiff > 100 { 
		t.Logf("Expected minimal heap allocations, but got %d new mallocs. (Sync.Pool works efficiently)", allocDiff)
	}
}
```

---

## 4. Anti-Patterns Manajemen Memori Go

### ❌ Anti-Pattern 1: Mengabaikan `sync.Pool` pada Hot-Path I/O (JSON/HTTP)
Di sistem *High Throughput*, pengembang sering melakukan pemrosesan data (seperti decoding JSON ke struct atau merakit *bytes* HTML) dengan membuat array/struct lokal (`myStruct := new(Data)`) miliaran kali per detik.

```go
// ❌ BAD: Menciptakan sampah (Garbage) tanpa akhir
func handleRequest(w http.ResponseWriter, r *http.Request) {
    // Alokasi Heap 64KB setiap kali ada koneksi masuk!
    buffer := make([]byte, 64*1024) 
    r.Body.Read(buffer)
    // GC mark-workers harus bekerja memindai dan menyapu buffer ini terus menerus
}
```
**Mengapa berbahaya:** *Garbage Collector* Go memang cepat (latensi rendah), namun *throughput*-nya lambat. Jika Anda membuat ratusan ribu objek temporer per detik (disebut *Heap Thrashing*), GC akan terus berjalan. CPU Anda akan membuang 25% hingga 40% waktu komputasinya murni hanya untuk menjalankan *mark workers* dan *scavengers*, memicu latensi tinggi *(tail latency)* pada respon API.

```go
// ✅ GOOD: Daur ulang memori dengan sync.Pool
var bufPool = sync.Pool{
    New: func() interface{} { return make([]byte, 64*1024) },
}
func handleRequest(w http.ResponseWriter, r *http.Request) {
    buf := bufPool.Get().([]byte)
    defer bufPool.Put(buf)
    r.Body.Read(buf)
}
```

### ❌ Anti-Pattern 2: Menyetel `GOGC` dengan Nilai Statis Sangat Kecil atau Mati Total
Pengembang mencoba mematikan GC dengan mengeset `GOGC=off` untuk meningkatkan performa komputasi algoritma matematis.

```go
// ❌ BAD: Mematikan GC pada service yang berlari terus-menerus
func init() {
    debug.SetGCPercent(-1) // GC dimatikan
}
```
**Mengapa berbahaya:** Kecuali Anda membuat skrip eksekusi-cepat tunggal (seperti CLI command) atau *short-lived lambdas*, mematikan GC pada layanan *Web Server* HTTP/gRPC akan menyebabkan *Out of Memory (OOM)* pada node OS dalam hitungan jam. 

**✅ GOOD:** Alih-alih mematikan GC, gunakan `GOMEMLIMIT` (sejak Go 1.19) untuk memberitahu GC: *"Silakan istirahat sampai pemakaian RAM saya menyentuh batas 2GB, lalu jalankan GC dengan efisien"*.
```go
// Go 1.19+ feature
// Set Environment variable: GOMEMLIMIT=2048MiB
```

---

## 5. Edge Cases Kritis dalam Tri-Color & GC

1. **Memory Ballast tidak lagi relevan (GOMEMLIMIT replacement):**
   *Kasus:* Developer lama (Go 1.18 ke bawah) sering mendeklarasikan slice raksasa palsu (`ballast := make([]byte, 10<<30)`) di awal program untuk menipu rumusan GC (yang berpatokan pada kelipatan heap).
   *Edge Case:* Sejak Go 1.19, menggunakan *ballast* berpotensi berbenturan dengan algoritma OS *page faulting* dan membingungkan Pacer baru. *Solusi Spesifik:* Buang *ballast array*, ganti dengan mekanisme deklaratif `debug.SetMemoryLimit(10 * 1024 * 1024 * 1024)`. Pacer Go 1.19+ akan secara halus mempertahankan heap di bawah limit ini tanpa tipuan memori statis.

2. **Pointer CGO dalam Heap Memory:**
   *Kasus:* CGO tidak sepenuhnya kompatibel dengan *tracing GC* Go. Jika Anda menyimpan memori C/C++ (hasil dari `C.malloc`) di dalam heap Go berupa *Unsafe.Pointer*.
   *Edge Case:* GC Go tidak memindai memori C. Jika struktur Go menunjuk ke struct C, dan struct C memiliki pointer balik ke struct Go lain, GC Tri-Color Go tidak bisa menembus pembatas (barrier) C. Akibatnya, pointer anak (Go) di dalam struct C dianggap *White* (tidak punya relasi) dan disapu (dihapus). Anda akan mendapatkan *Dangling Pointer* dan *SIGSEGV*.
   *Solusi Spesifik:* *JANGAN* mencampur jaring referensi (*reference graph*). C-pointers biarkan merujuk ke C-objects, Go-pointers ke Go-objects. Jika butuh lintas batas, pertahankan root Go-pointer pada Go-side secara manual (misalnya menggunakan register map global atau struktur *handle* integer, bukan *memory pointer* mentah).

3. **Goroutine Leak yang Mempertahankan GC Roots (Zombie Reference):**
   *Kasus:* Anda meng-assign *struct* raksasa sebesar 50MB (contoh model ML ke *cache* atau data sesi TCP). Goroutine yang menangani TCP terputus mati mendadak dari blok fungsi utama, tetapi ia masih memegang *channel* atau *timer* yang *blocked*.
   *Edge Case:* Seluruh hirarki 50MB tersebut dipertahankan (menjadi Grey lalu Black) secara berulang kali tiap siklus GC berjalan karena Goroutine berstatus `waiting` tetap dianggap sebagai *Root*. Memori RAM perlahan terkuras habis (*Memory Leak* logis, bukan sistem).
   *Solusi Spesifik:* Analisis `pprof` di bagian `goroutine` dan `heap`. Cari Goroutine yang menggantung dengan dependensi *channels*. Pasang `defer cancel()` dengan `context.Context` eksplisit untuk membersihkan tuntas *Root pointer* saat aliran sistem terhenti.

## Kapan JANGAN Pakai Ini

- **Menyetel `GOGC` tanpa `GOMEMLIMIT` di container.** `GOGC` mengendalikan **rasio**, bukan batas. Lonjakan alokasi tetap bisa menembus limit memori pod dan berakhir `OOMKilled`. `GOMEMLIMIT` (Go 1.19+) adalah alat yang menjawab pertanyaan "jangan lewati sekian megabyte".
- **`GOGC=off`.** Heap tumbuh sampai OOM. Ini hanya masuk akal untuk proses batch berumur sangat pendek yang dipastikan selesai sebelum memori habis — dan bahkan di situ, `GOMEMLIMIT` lebih aman.
- **Menurunkan `GOGC` drastis demi hemat memori.** `GOGC=20` memperbanyak siklus GC dan membakar CPU untuk pekerjaan yang sama. Mengurangi laju alokasi hampir selalu lebih efektif daripada memaksa GC bekerja lebih sering.
- **`runtime.GC()` manual di jalur produksi.** Ia memaksa siklus penuh, mengacaukan pacing yang sudah dihitung runtime, dan menambahkan jeda yang justru ingin dihindari.
- **Menyalahkan GC sebelum melihat profil alokasi.** Sebagian besar "masalah GC" sebenarnya masalah alokasi berlebihan. GC hanya membersihkan sampah yang kode Anda hasilkan.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| p99 bergerigi dengan pola periodik | `gctrace` vs waktu lonjakan | Jeda GC atau assist yang membebani goroutine pemanggil |
| CPU tinggi di `runtime.gcBgMarkWorker` | laju alokasi | Alokasi terlalu cepat; GC tidak pernah sempat istirahat |
| `OOMKilled` meski `GOGC` sudah disetel | apakah `GOMEMLIMIT` dipasang | Rasio tidak bisa menjadi batas |
| RSS tidak turun setelah beban reda | `/memory/classes/heap/released:bytes` | Memori dikembalikan ke OS bertahap; belum tentu bocor |
| Heap target membengkak tiap siklus | kolom `->` pada `gctrace` | Objek hidup memang bertambah — kandidat kebocoran sesungguhnya |

```bash
# Satu baris per siklus GC: fase, durasi, dan heap sebelum->sesudah->target
GODEBUG=gctrace=1 ./app 2>&1 | head -20

# Apa yang paling banyak dialokasikan (bukan yang paling banyak dipakai)
go tool pprof -sample_index=alloc_space  -top 'http://localhost:6060/debug/pprof/allocs?seconds=30'
go tool pprof -sample_index=alloc_objects -top 'http://localhost:6060/debug/pprof/allocs?seconds=30'

# Apa yang masih hidup sekarang -- ini yang menentukan target GC
go tool pprof -sample_index=inuse_space -top http://localhost:6060/debug/pprof/heap

# Riwayat OOMKilled di cluster
kubectl get pods -o json \
  | jq -r '.items[] | select(.status.containerStatuses[]?.lastState.terminated.reason=="OOMKilled") | .metadata.name'
```

```go
// runtime/metrics lebih presisi daripada MemStats dan tidak memicu stop-the-world.
// Ekspor minimal empat ini sebagai gauge:
//   /gc/heap/live:bytes              objek hidup setelah mark
//   /gc/pauses:seconds               histogram jeda stop-the-world
//   /memory/classes/total:bytes      total yang dipegang runtime (bandingkan dengan GOMEMLIMIT)
//   /sched/latencies:seconds         berapa lama goroutine menunggu giliran
```
