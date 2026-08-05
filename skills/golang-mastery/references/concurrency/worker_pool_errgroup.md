# Worker Pool & ErrGroup

> **Berlaku:** Go 1.20+ (`errgroup.SetLimit`) · Go 1.22+ (variabel loop aman) · **Lihat juga:** `concurrency/channel_patterns_pipelines.md` · `background_jobs_worker/worker_pool_patterns.md` · `distributed_patterns_resilience/bulkhead_isolation.md` · `db_sqlc/connection_pool_tuning.md`

## Konsep Utama
Me-spawn goroutine di Go memang amat sangat murah (overhead memori ~2KB saja per goroutine). Namun hal itu memicu sindrom ilusi aman. Jika layanan HTTP server Anda menerima lonjakan 100.000 trafik di detik yang sama, dan Anda menggunakan pola "Satu Request = Satu Goroutine + Akses Database", aplikasi Go Anda memang tetap hidup; Namun, Database RDBMS di backend Anda (PostgreSQL/MySQL), API pihak ke-3 eksternal, maupun router OS Anda akan tumbang binasa seketika karena kehabisan resource koneksi (Connection Exhaustion) atau terkena gempuran Rate Limiting brutal 429 Too Many Requests. 

Solusi absolut dari masalah ini adalah arsitektur **Worker Pool** atau *Bounded Parallelism* (Paralelisme Dibatasi). Daripada 100.000 goroutine dibiarkan liar tanpa henti, kita mencekik dan menyalurkan beban mereka melalui corong (funnel) berisi jumlah pekerja (worker) yang konstan (misal: hanya maksimal 20 goroutine pada satu waktu yang diperbolehkan memproses payload data dan menghubungi DB).

Untuk memudahkan manajemen Pool rumit, paket eksternal resmi `golang.org/x/sync/errgroup` mendongkrak fungsionalitas `sync.WaitGroup` primitif menjadi artileri level *enterprise*, karena ia menyuplai 3 keunggulan mutlak:
1. **Error Aggregation**: Merekam, menampung, dan mengembalikan `error` PERTAMA (*The First Ocurrence*) yang dilemparkan (return) oleh siapapun dari anak-anak goroutine (child worker). Anda tak perlu membuat channel `chan error` manual.
2. **Context Cancellation Propagation (`WithContext`)**: Jika satu goroutine worker gagal (mengembalikan error pertama), parent context kelompok `Group` tersebut akan *Otomatis Dibatalkan (Canceled) pada milidetik itu juga*. Sinyal kematian `Done()` dikirim paksa serentak, sehingga semua worker goroutine kolega lainnya yang sedang berjalan terpelatuk mati membatalkan task sisa (*graceful abort*) menghemat komputasi berharga CPU.
3. **Concurrency Limiting (`SetLimit`)**: Membatasi jumlah goroutine yang berjalan bersamaan tanpa perlu menyusun semaphore berbasis buffered channel sendiri.

   **Catatan versi yang sering salah dikutip:** `SetLimit` adalah fitur modul **`golang.org/x/sync`** (ditambahkan pada rilis modul di 2022), **bukan** fitur bahasa Go 1.20. Yang menentukan ketersediaannya adalah versi `golang.org/x/sync` di `go.mod` Anda — bukan versi toolchain Go. Menaikkan Go tanpa menaikkan modulnya tidak akan memunculkan `SetLimit`.

## Diagram ASCII

```text
    ErrGroup Workflow (Fail-Fast Mechanism Propagation)
    
           [ Main HTTP Handler / Controller ]
                      |
             errgroup.WithContext() -> Produces (Group, Ctx)
                      |
       +--------------+--------------+
       |              |              |
   [Worker 1]     [Worker 2]     [Worker 3]
       |              |              |
       v              v              v
    (Success)    (BOM ERROR!)    (Long CPU Processing...)
                      |           
          1. Sends FIRST error -> ErrGroup
          2. ErrGroup automatically triggers CANCEL() on Ctx
          3. Ctx propagates -> <-ctx.Done() activates for Worker 3
          4. Worker 3 gracefully exits early without wasting CPU
                      |
          [ Main Group.Wait() catches that Error & responds to Client ]
```

## Kode Go Production-Ready

Kode asertif di bawah ini menangani proses sekumpulan koleksi pekerjaan (batch task processing) menggunakan arsitektur Bounded Pool untuk mengolah task yang aman.

```go
package concurrency

import (
	"context"
	"fmt"
	"testing"
	"time"

	"go.uber.org/goleak"
	"golang.org/x/sync/errgroup"
)

// ==========================================
// KODE PRODUCTION-READY
// ==========================================

// TaskInfo merepresentasikan blok persatuan pekerjaan.
type TaskInfo struct {
	ID    int
	Input string
}

// TaskResult merepresentasikan kalkulasi output paska pekerjaan.
type TaskResult struct {
	ID     int
	Output string
}

// ProcessBatchWithWorkers mengorganisasikan ribuan tasks ke dalam batas corong
// worker yang tak melampaui maxWorkers. Merupakan pola Fail-Fast.
func ProcessBatchWithWorkers(ctx context.Context, tasks []TaskInfo, maxWorkers int) ([]TaskResult, error) {
	
	// PRINSIP PRODUCTION 1: Rangkai errgroup yang erat dengan parent request `ctx`.
	// Sifat context: Jika parent mati, child (gCtx) batal. 
	// Jika 1 child worker dari group melempar error, gCtx otomatis batal.
	g, gCtx := errgroup.WithContext(ctx)
	
	// PRINSIP PRODUCTION 2: Membatasi inflasi Goroutine (Go 1.20+)
	// Ini menjamin tak akan ada lebih dari (maxWorkers) pemanggilan `g.Go` 
	// yang hidup serentak di runtime scheduler.
	g.SetLimit(maxWorkers)

	// Channel penampung kesuksesan yang Bebas-Mutex (Lock-free channel).
	// Buffer diset sama atau melebihi jumlah total task agar worker tidak 
	// pernah terblokir meskipun main goroutine belum menjaring/membaca.
	resultCh := make(chan TaskResult, len(tasks))

	for _, task := range tasks {
		// WAJIB: Copy variabel iterasi (Shadowing) untuk menghindar dari
		// bug alamat pointer loop semu di versi Go sebelum 1.22.
		t := task 
		
		g.Go(func() error {
			// Skenario Defensive: Sebelum masuk komputasi berat, pastikan 
			// Group ini belum berstatus 'Dibatalkan' karena kelalaian rekan kerja lainnya.
			if gCtx.Err() != nil {
				return gCtx.Err() // Abort instan (Early Exit)
			}
			
			// == MULAI SIMULASI PEKERJAAN (Network/Disk IO) ==
			
			// Idealnya API Call/DB Query turut mem-parsing `gCtx` di parameter, 
			// contoh:  db.QueryRowContext(gCtx, "...")
			time.Sleep(20 * time.Millisecond)
			
			// Memicu error simulasi terprogram (misal di ID 5)
			if t.ID == 5 {
				return fmt.Errorf("fatal connection reset on task ID: %d", t.ID)
			}
			
			// == SELESAI SIMULASI PEKERJAAN ==
			
			// Setorkan payload success. Bebas Data-Race tanpa Lock Mutex
			resultCh <- TaskResult{
				ID:     t.ID,
				Output: fmt.Sprintf("DONE_%s", t.Input),
			}
			
			return nil
		})
	}

	// 1. Group Wait membekukan pemanggil (caller) hingga kondisi tuntas tercapai:
	//    a. SELURUH goroutine telah return nilai nil error (Sukses Paripurna)
	//    b. ATAU, SALAH SATU (yg tercepat) melepas 1 error (Fail-Fast)
	if err := g.Wait(); err != nil {
		return nil, fmt.Errorf("batch processing aborted: %w", err)
	}
	
	// 2. Apabila wait menembus dengan sukses nil, saluran aman ditutup (Close)
	// tanpa ketakutan memicu "panic: send on closed channel".
	close(resultCh) 
	
	// 3. Jaring/Tuai semua kalkulasi hasil
	results := make([]TaskResult, 0, len(tasks))
	for r := range resultCh {
		results = append(results, r)
	}
	
	return results, nil
}

// ==========================================
// UNIT TEST (-race compatible)
// ==========================================

func TestProcessBatchWithWorkers_TotalSuccess(t *testing.T) {
	defer goleak.VerifyNone(t)
	
	tasks := []TaskInfo{
		{ID: 1, Input: "DocA"}, {ID: 2, Input: "DocB"},
		{ID: 3, Input: "DocC"}, {ID: 4, Input: "DocD"},
	}

	res, err := ProcessBatchWithWorkers(context.Background(), tasks, 2)
	if err != nil {
		t.Fatalf("expected nil error (100%% success), got %v", err)
	}
	if len(res) != 4 {
		t.Fatalf("expected 4 documents back, got %d", len(res))
	}
}

func TestProcessBatchWithWorkers_FailFastPropagation(t *testing.T) {
	defer goleak.VerifyNone(t)
	
	// Menyertakan Task ID = 5 akan melempar bom error 
	// dan merobohkan/membatalkan worker di sekitarnya.
	tasks := []TaskInfo{
		{ID: 1, Input: "DocA"}, 
		{ID: 5, Input: "PoisonPill"}, // Menimbulkan Error
		{ID: 2, Input: "DocC"}, 
		{ID: 3, Input: "DocD"},
		{ID: 4, Input: "DocE"},
	}

	_, err := ProcessBatchWithWorkers(context.Background(), tasks, 3)
	
	if err == nil {
		t.Fatal("expected fail-fast error, got nil success mask")
	}
	
	// Pastikan error original tidak tertelan/hilang
	expectedErrMsg := "batch processing aborted: fatal connection reset on task ID: 5"
	if err.Error() != expectedErrMsg {
		t.Fatalf("unexpected error string: %v", err.Error())
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengagregasikan Hasil menggunakan Mutex Global dari dalam Worker

```go
// ❌ BAD: Memakai Lock Contention untuk Write (Slice Append)
var globalResults []string
var mu sync.Mutex

for _, task := range tasks {
    g.Go(func() error {
        dataOutput := ExpensiveDBQuery()
        
        // BAD: Ratusan worker ini menembak query dengan kecepatan cahaya,
        // TAPI tersangkut dan mengantri di bottleneck kemacetan (Lock) 1 lajur ini! 
        // CPU akan terbuang untuk konteks switching, bukan bekerja.
        mu.Lock() 
        globalResults = append(globalResults, dataOutput)
        mu.Unlock()
        
        return nil
    })
}

// ✅ GOOD: Lempar ke dalam Buffered Channel yang dilindungi (Lock-Free)
resultCh := make(chan string, totalTasks)
for _, task := range tasks {
    g.Go(func() error {
        resultCh <- ExpensiveDBQuery() // GOOD: Memasukkan payload sedetik sekedip mata
        return nil
    })
}
```

**Why dangerous:** Paralelisme hancur lebur berkeping-keping. Membuka goroutine agar memproses secara konkruen (simultan), lalu memaksa mereka masuk melewati antrean 1 pintu tol sempit (`sync.Mutex`) pada akhir masa bakti, adalah perbuatan absurd yang kontra-produktif. Lock contention akan membunuh *throughput*. Selalu delegasikan pengumpulan hasil pada struktur murni perpesanan (`chan`) di mana runtime scheduler Go menanganinya pada level memori ultra cepat *(Ring Buffer Lock-Free)*.

### ❌ Anti-Pattern 2: Melupakan Scope Shadowing dari Variabel Iterasi (Pre Go 1.22)

```go
// ❌ BAD: Goroutine akan merujuk ke Memory Pointer yang sama berulang-ulang
for _, item := range dataset { // item beralamat statis (misal 0x123C)
    g.Go(func() error {
        // BAD: Karena goroutine ini lazy start-up, saat kode ini aktif, 
        // pointer (0x123C) tersebut sudah berganti isi dengan 'item' ke-akhir loop!
        // Semua worker akan mengerjakan item TERAKHIR, dan yang awal tidak terpanggil.
        uploadS3(item) 
        return nil
    })
}

// ✅ GOOD: Buat variabel bayangan independen yang dikunci dalam closure scope (Shadowing)
for _, item := range dataset {
    shadowItem := item 
    g.Go(func() error { 
        uploadS3(shadowItem) // GOOD: Worker memegang nilai memori snapshot yang valid
        return nil 
    })
}
```

**Why dangerous:** Bug *Silent Data Corruption* yang fenomenal dan melegenda. Program tidak *crash*, tidak *panic*, tidak berisik di *log*, namun data di database Anda rusak akibat duplikasi pemrosesan dari ID elemen paling akhir. (Catatan: Pada *Go Compiler rilis 1.22 ke atas*, perilaku scope for-loop ini akhirnya telah direvisi menjadi aman secara *default*. Akan tetapi sebagai *engineer* yang memelihara *code base production* lama (Go 1.19 / Go 1.21), Anda pantang melupakan trik *variable shadowing* kaku ini.)

## Edge Cases

1. **Memori Ram Bocor di Channel Collection Terlalu Besar**: Apabila Anda mengeksekusi iterasi raksasa dengan total 3 Juta payload batch dan Anda mendesain pre-alokasi channel secara serakah: `resultCh := make(chan Result, 3_000_000)`, Runtime akan instan mem-booking / membakar ber-Gigabyte RAM hanya untuk menyegel (allocate) tempat kosong channel buffer. Jika payloadnya berupa struct besar (seperti PDF byte array), server Anda niscaya pingsan OOM.
   - *Defensive*: Anda TIDAK dipaksa me-list out seluruh total payload ke dalam memori buffer. Desain saja ukuran max 10.000, JALANKAN sebuah goroutine konsumen tunggal secara terpisah yang bertugas menyedot/draining `resultCh` *di saat yang sama* worker mengisi data. Stream langsung hasil hisapan itu ke storage disk (File/Redis), jangan dikoleksi ke memori stack.
2. **Fatal Crash karena Worker Panic (Bypass ErrGroup)**: Paket `errgroup` adalah konduktor orkestra yang rapi jika musisinya patuh memberikan `return error`. NAMUN bila musisinya mengidap skizofrenia lalu melempar `panic()` karena menabrak Nil Pointer di kedalaman layer logic, ErrGroup tak menyediakan fitur *safety net / auto recover*. Paniknya sang *child* goroutine akan merobohkan pondasi *Parent/Main program* tak tersisa.
   - *Defensive*: Wajib implementasi bungkus lapis luar: pasang blok baris `defer func() { if p := recover(); p != nil { ... } }()` kustom dan jahit panic trace tersebut, *cast* menjadi objek error biasa (`fmt.Errorf()`), lalu biarkan `errgroup` menelannya secara wajar membatalkan sisanya elegan.
3. **Ghost Worker Akibat Mengabaikan Peringatan Context**: Sifat `g, gCtx := errgroup.WithContext(ctx)` adalah menjanjikan sinyal penghentian paksa manakala ada 1 kecacatan. **TAPI HATI-HATI**: `gCtx` tidak bekerja magis menginterupsi *OS thread*. Jika rutinitas berat Anda (seperti pembacaan `IO Disk` loop) lalai menyelipkan kode kondisional pengecekan status rutin pembatalan: `if gCtx.Err() != nil { return nil }`, goroutine Anda seutuhnya Buta Nada. Ia takkan sudi mati / kembali dengan damai biarpun rekan sejawatnya sudah menyerah lama. Worker tersebut terperangkap jadi arwah (Zombie Phantom Worker) menyedot jatah DB connection, menunggu kiamat.
   - *Defensive*: Selalu selipkan parameter `ctx` ke layer/API terbawah (*Database Driver, HTTP Client*) dan rajin periksa `ctx.Done()` di setiap iterasi Loop (sebelum dan sesudahnya).

## Kapan JANGAN Pakai Ini

- **Ketika hilirnya sudah punya pool sendiri.** Membungkus query database dengan worker pool 50 sementara `SetMaxOpenConns(10)` hanya memindahkan antrean satu lapis ke atas. Batasi konkurensi di **satu** tempat, dan pilih tempat yang paling dekat dengan sumber daya langka.
- **Untuk batch yang wajib diproses seluruhnya.** `errgroup.WithContext` bersifat fail-fast: satu baris rusak dari 10.000 membatalkan 9.999 yang sehat. Untuk impor data, pakai `errgroup` **tanpa** `WithContext`, kumpulkan galat per item, lalu gabungkan dengan `errors.Join`.
- **Untuk proses jangka panjang** — konsumer Kafka, daemon, penjadwal. `Wait()` tidak pernah kembali, dan galat pertama mematikan seluruh armada. Pola yang tepat adalah supervisor dengan restart per komponen.
- **Sebagai rate limiter.** `SetLimit` membatasi berapa yang berjalan **bersamaan**, bukan berapa per detik. Worker cepat dengan limit 10 tetap bisa mengirim 5.000 permintaan per detik dan kena `429`. Untuk kuota, pakai `golang.org/x/time/rate`.
- **Menyetel ukuran pool dari `GOMAXPROCS`.** Itu benar untuk beban CPU. Untuk beban I/O, angkanya ditentukan kapasitas hilir — jumlah koneksi DB, kuota API, IOPS disk — dan tidak ada hubungannya dengan jumlah core.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| p99 naik, CPU rendah, antrean menumpuk | waktu tunggu slot vs waktu kerja | Pool terlalu kecil untuk beban masuk |
| `429`, `connection refused`, atau pool DB habis | konkurensi efektif vs kapasitas hilir | Pool terlalu besar; batasnya salah tempat |
| Batch selesai tapi jumlah hasil kurang | rasio task sukses vs total | Fail-fast membatalkan sisa pekerjaan yang sehat |
| Sebagian task tidak pernah selesai | goroutine yang menggantung di `errgroup` | Worker tidak memeriksa `gCtx.Done()` |
| Seluruh proses mati mendadak | `panic` di dalam `g.Go` | `errgroup` tidak menangkap panic; butuh `recover` lokal |

```bash
# Waktu tunggu slot. Aktifkan dulu di kode: runtime.SetBlockProfileRate(1)
go tool pprof -top http://localhost:6060/debug/pprof/block

# Worker yang mengantre slot errgroup muncul sebagai semacquire
curl -s 'localhost:6060/debug/pprof/goroutine?debug=1' | grep -B3 -i errgroup
```

```sql
-- Apakah pool DB yang jadi batas sebenarnya?
SELECT state, count(*) FROM pg_stat_activity GROUP BY state;
SELECT count(*) AS terpakai,
       (SELECT setting::int FROM pg_settings WHERE name='max_connections') AS batas
FROM pg_stat_activity;
```
