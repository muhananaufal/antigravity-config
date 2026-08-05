# Bulkhead Pattern (Isolasi Kegagalan)

> **Berlaku:** Go 1.21+ · `golang.org/x/sync/semaphore` · **Lihat juga:** `observability_resilience/circuit_breaker_hystrix.md` · `concurrency/worker_pool_errgroup.md` · `db_sqlc/connection_pool_tuning.md` · `observability_resilience/rate_limiting_patterns.md`

## 1. Konsep & Internal

Nama **Bulkhead** diambil dari desain lambung kapal laut yang dibagi menjadi beberapa kompartemen (partisi) kedap air. Jika lambung bocor di satu bagian, air hanya akan mengisi kompartemen tersebut. Kapal tidak akan tenggelam seluruhnya.

Dalam perangkat lunak (Go), *Bulkhead Pattern* memisahkan alokasi *resource* (koneksi database, *goroutines*, *thread pools*) untuk bagian-bagian layanan yang berbeda. Tujuannya adalah mencegah **Satu komponen yang bermasalah menghabiskan seluruh resource sistem** (Resource Exhaustion).

Contoh klasik:
Aplikasi memiliki API "Order" dan API "Laporan". API Laporan sangat lambat dan memakan banyak CPU/Memory. Tanpa Bulkhead, jika ribuan pengguna membuka "Laporan", seluruh *worker pool* (atau *connection pool* DB) akan terpakai oleh Laporan. Akibatnya, API "Order" tidak mendapatkan porsi untuk memproses pembayaran, dan sistem terlihat `DOWN` total.

### Diagram Alir / Arsitektur (ASCII)

```ascii
[ TANPA BULKHEAD - Shared Resources ]
Semua request masuk ke 1 pool goroutine.

Incoming Requests (Mixed) ----> [ Global Goroutine Pool (Max 100) ]
- Report (Slow)                 - 99 Goroutines stuck on Report
- Order (Fast)                  - 1 Goroutine serving Order
(Hasil: Sistem macet)

[ DENGAN BULKHEAD - Compartmentalization ]
Resource dipisah secara logika.

Incoming Requests ------------> [ Dispatcher / Router ]
                                       |
                   +-------------------+-------------------+
                   v                                       v
    [ Pool A: Orders (Max 80) ]             [ Pool B: Reports (Max 20) ]
        | (Tetap cepat)                            | (Macet, tapi terisolasi)
        v                                          v
   +----------+                               +----------+
   | Order DB |                               | Report DB|
   +----------+                               +----------+
```

## 2. Production-Ready Code (Channel Semaphore)

Dalam Golang, Bulkhead sangat elegan dan mudah diimplementasikan menggunakan *Buffered Channels* sebagai *Semaphore* (pembatas konkurensi maksimum) secara independen untuk tiap fungsi atau layanan.

```go
package resilience

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync/atomic"
	"time"
)

var ErrBulkheadFull = errors.New("bulkhead full, request rejected to maintain system stability")

// Bulkhead membatasi jumlah eksekusi konkuren.
type Bulkhead struct {
	nama string
	pool chan struct{}

	// Metrik. Bagian "Cara Mendeteksi Gejalanya di Produksi" di bawah
	// memerintahkan memantau bulkhead_active / bulkhead_rejected_total /
	// bulkhead_wait_seconds -- angka-angka itu harus benar-benar ADA, atau
	// perintah deteksinya hanya menghasilkan keluaran kosong yang terbaca
	// seperti "tidak ada masalah".
	aktif      atomic.Int64 // gauge: sedang berjalan
	diterima   atomic.Int64 // counter: total yang pernah mendapat tiket
	ditolak    atomic.Int64 // counter: total yang ditolak
	waitNano atomic.Int64 // counter: akumulasi waktu tunggu tiket
}

// NewBulkhead menginisialisasi kapasitas maksimum kompartemen.
func NewBulkhead(nama string, maxConcurrent int) *Bulkhead {
	if maxConcurrent < 1 {
		panic("kapasitas bulkhead harus >= 1")
	}
	return &Bulkhead{
		nama: nama,
		// Buffered channel berfungsi sebagai Semaphore.
		pool: make(chan struct{}, maxConcurrent),
	}
}

// Statistik mengembalikan cuplikan metrik untuk diekspor ke Prometheus.
//
// `aktif` adalah GAUGE (sedang berjalan sekarang); `diterima` dan `ditolak`
// adalah COUNTER kumulatif. Membaginya dengan gauge -- godaan yang mudah --
// menghasilkan angka tak bermakna yang berubah-ubah mengikuti beban sesaat.
func (b *Bulkhead) Stats() (aktif, diterima, ditolak int64, waitMean time.Duration) {
	aktif = b.aktif.Load()
	diterima = b.diterima.Load()
	ditolak = b.ditolak.Load()
	if n := diterima + ditolak; n > 0 {
		waitMean = time.Duration(b.waitNano.Load() / n)
	}
	return aktif, diterima, ditolak, waitMean
}

// Kapasitas mengembalikan batas maksimum kompartemen ini.
func (b *Bulkhead) Kapasitas() int { return cap(b.pool) }

// Jalankan menjalankan tugas di dalam partisi Bulkhead.
//
// FUNGSI PAKET, BUKAN METHOD, dan itu bukan pilihan gaya: Go TIDAK
// mengizinkan method punya type parameter sendiri (`func (b *Bulkhead)
// Execute[T any]` adalah galat kompilasi). Karena itu satu-satunya cara
// mendapatkan hasil bertipe tanpa `interface{}` adalah menaikkannya menjadi
// fungsi paket dengan penerima sebagai argumen. Ini pola yang sama dengan
// `slices.SortFunc` dan sejenisnya.
//
// Bentuk lama `Execute(...) (interface{}, error)` memaksa SETIAP pemanggil
// melakukan type assertion, dan assertion tanpa comma-ok adalah panic yang
// menunggu giliran -- di dalam fungsi yang justru bertugas menjaga stabilitas.
func Jalankan[T any](
	ctx context.Context,
	b *Bulkhead,
	timeout time.Duration,
	task func(ctx context.Context) (T, error),
) (T, error) {
	var zero T
	startWait := time.Now()

	// 1. Fase Acquire Resource (Mencoba masuk kompartemen)
	err := b.getTicket(ctx, timeout)
	b.waitNano.Add(int64(time.Since(startWait)))
	if err != nil {
		b.ditolak.Add(1)
		return zero, err
	}
	b.diterima.Add(1)
	b.aktif.Add(1)

	type result struct {
		val T
		err error
	}
	// Kapasitas 1 WAJIB. Dengan channel tanpa buffer, goroutine di bawah akan
	// menggantung selamanya pada pengiriman bila Jalankan sudah keluar lewat
	// ctx.Done() -- kebocoran goroutine di dalam pola yang tujuannya justru
	// membatasi goroutine.
	resultCh := make(chan result, 1)

	go func() {
		// URUTAN DEFER DI SINI MENENTUKAN KEBENARANNYA.
		//
		// Tiket dilepas DI DALAM goroutine ini, BUKAN lewat defer di Jalankan.
		// Inilah perbedaan antara bulkhead yang bekerja dan bulkhead yang
		// hanya terlihat bekerja:
		//
		//   Bila tiket dilepas saat Jalankan RETURN, maka jalur ctx.Done() di
		//   bawah melepaskan tiket SEMENTARA task-nya MASIH BERJALAN. Slot
		//   dinyatakan kosong, permintaan berikutnya masuk, task-nya juga
		//   menggantung, dan seterusnya. Di bawah hilir yang macet plus klien
		//   yang time out -- kombinasi yang PASTI terjadi bersamaan -- jumlah
		//   goroutine tumbuh tanpa batas sementara metrik melaporkan kapasitas
		//   tersedia. Itu persis OOM yang Anti-Pattern 1 ada untuk mencegahnya,
		//   hanya dengan pembatas yang berbohong.
		//
		// Didaftarkan PERTAMA berarti dieksekusi TERAKHIR (LIFO), sehingga
		// tiket baru lepas setelah recover selesai mengirim hasilnya.
		defer func() {
			<-b.pool
			b.aktif.Add(-1)
		}()

		defer func() {
			if r := recover(); r != nil {
				// Stack WAJIB dicatat di sini. Mengubah panic menjadi error
				// tanpa mencatat stack-nya menghapus satu-satunya petunjuk
				// letak bug-nya; yang sampai ke pemanggil hanya pesan panik
				// tanpa satu pun nama fungsi.
				slog.ErrorContext(ctx, "panic dalam task bulkhead",
					"bulkhead", b.nama, "panic", r, "stack", string(debug.Stack()))
				resultCh <- result{err: fmt.Errorf("panic dalam task: %v", r)}
			}
		}()

		val, err := task(ctx)
		resultCh <- result{val, err}
	}()

	select {
	case res := <-resultCh:
		return res.val, res.err
	case <-ctx.Done():
		// Jalankan kembali lebih awal agar klien tidak menunggu, TETAPI
		// tiketnya tetap dipegang goroutine di atas sampai task benar-benar
		// selesai. Slot yang tidak pernah kembali berarti task Anda tidak
		// menghormati ctx -- dan itu memang harus terlihat sebagai kapasitas
		// yang menyusut, bukan disembunyikan.
		return zero, fmt.Errorf("context dibatalkan saat task berjalan: %w", ctx.Err())
	}
}

func (b *Bulkhead) getTicket(ctx context.Context, timeout time.Duration) error {
	// timeout <= 0 berarti fail-fast murni. Ini BUKAN kasus akademis:
	// `time.NewTimer(0)` menyala seketika, dan `select` memilih ACAK di antara
	// case yang sama-sama siap -- sehingga permintaan bisa ditolak meski slot
	// tersedia. Jalur non-blocking dengan `default` menghilangkan keacakan itu.
	if timeout <= 0 {
		select {
		case b.pool <- struct{}{}:
			return nil
		case <-ctx.Done():
			return fmt.Errorf("permintaan dibatalkan sebelum masuk bulkhead: %w", ctx.Err())
		default:
			return ErrBulkheadFull
		}
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case b.pool <- struct{}{}:
		return nil
	case <-timer.C:
		// Pool penuh dan waktu tunggu habis. FAIL FAST.
		return ErrBulkheadFull
	case <-ctx.Done():
		return fmt.Errorf("permintaan dibatalkan sebelum masuk bulkhead: %w", ctx.Err())
	}
}

// --- PENGGUNAAN DI LAYER APLIKASI ---

type Application struct {
	orderBulkhead  *Bulkhead
	reportBulkhead *Bulkhead
}

func NewApp() *Application {
	return &Application{
		// Order diberi porsi 80% kapasitas karena ini krusial
		orderBulkhead: NewBulkhead("order", 80),
		// Report hanya diberi 20% agar tidak membunuh service
		reportBulkhead: NewBulkhead("report", 20),
	}
}

type Laporan struct{ Rows int }

func (a *Application) HandleReport(ctx context.Context) (Laporan, error) {
	// Hasilnya BERTIPE. Tidak ada type assertion, tidak ada interface{}.
	return Jalankan(ctx, a.reportBulkhead, 500*time.Millisecond,
		func(ctx context.Context) (Laporan, error) {
			slog.InfoContext(ctx, "membangun laporan berat")

			// `time.Sleep(10*time.Second)` -- bentuk yang paling sering ditulis
			// di sini -- adalah TASK JAHAT yang dibahas berkas ini: ia tidak
			// bisa dibangunkan oleh ctx, sehingga slot bulkhead-nya tertahan
			// penuh 10 detik meski kliennya sudah pergi di detik pertama.
			// Dengan kapasitas 20, dua puluh klien yang menyerah membekukan
			// seluruh kompartemen laporan selama sepuluh detik.
			//
			// Bulkhead membatasi BERAPA BANYAK yang berjalan; hanya task yang
			// menghormati ctx yang membatasi BERAPA LAMA. Keduanya diperlukan.
			select {
			case <-time.After(10 * time.Second):
				return Laporan{Rows: 1_000_000}, nil
			case <-ctx.Done():
				return Laporan{}, ctx.Err()
			}
		})
}
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Mengandalkan Global Timeout Saja
**Masalah**: Developer menganggap *Context Timeout* (misal 5 detik) sudah cukup menyelamatkan *server*.
```go
// BAD: Timeout tidak membatasi JUMLAH goroutine
ctx, cancel := context.WithTimeout(req.Context(), 5*time.Second)
defer cancel()
go HandleSlowReport(ctx)
```
**Why dangerous:** Jika terjadi serangan DDOS atau *traffic spike* pada rute "Report", sistem bisa menerima 100.000 *request* dalam 1 detik. Meskipun tiap *request* akan mati di detik ke-5, selama 5 detik tersebut sistem akan meng-inisialisasi 100.000 *goroutine* dan koneksi DB. CPU akan *throttle*, Memory OOM (*Out of Memory*), dan pod akan mati seketika.
**Solusi:** Terapkan Bulkhead (Batasi maksimal konkuren misal 50). Request ke-51 akan langsung ditolak dalam 1 milidetik (*fail fast*), menyelamatkan nyawa *server*.

### ❌ Anti-Pattern 2: Bulkhead Menggunakan Database Connection Pool Global
**Masalah**: Service API dipisahkan Bulkhead-nya, tapi di ujung, semua API mengakses database yang sama menggunakan *global connection pool* bawaan `sql.DB`.
```go
// BAD: 
db, _ := sql.Open(...)
db.SetMaxOpenConns(100) // Global pool
```
**Why dangerous:** Jika API "Report" dibatasi di level Go sebesar 50, dan API "Order" sebesar 100. Jika API "Report" mengeksekusi *query* pelan dan mengunci 50 koneksi DB. API "Order" yang butuh memproses cepat terpaksa harus antri karena *pool* DB mulai menipis.
**Solusi:** Di layer *database*, buat **beberapa instance connection pool** atau siapkan user DB terpisah dengan limit (Role Quotas) agar *resource contention* di tingkat DB juga diisolasi.

## 4. Edge Cases Spesifik

1. **Deadlock Karena Self-Referential Bulkhead**:
   Sebuah *goroutine* yang sudah berada di dalam kompartemen A memanggil fungsi lain yang juga diam-diam mencoba mengambil izin dari kompartemen A. Jika Bulkhead di kompartemen A sedang penuh (sisanya terkunci di antrean), dan Goroutine tersebut menahan satu tiket, maka akan terjadi *Deadlock* (goroutine diam selamanya).
   *Penanganan*: Pastikan Bulkhead tidak bersarang (*nested*) secara rekursif pada kompartemen yang sama. Desain arsitektur harus *flat* untuk pembagian kompartemen.

2. **Panics di Dalam Eksekusi yang Tidak Dilepas**:
   Jika fungsi `task()` mengalami `panic()` secara fatal dan developer tidak menggunakan `defer <-pool`, tiket dalam *channel Semaphore* tidak akan pernah dilepaskan. Kapasitas Bulkhead berkurang permanen (Goroutine Pool Leak).
   *Penanganan*: Pelepasan tiket **wajib** berada di `defer`, dan — ini bagian yang jauh lebih sering salah — **di dalam goroutine yang menjalankan task, bukan di dalam fungsi yang menunggunya.**

   Bedanya menentukan apakah bulkhead benar-benar membatasi sesuatu:

   ```go
   // ❌ SALAH -- terlihat benar, dan hijau di hampir semua uji
   func Jalankan(...) {
       b.pool <- struct{}{}
       defer func() { <-b.pool }()   // lepas saat Jalankan RETURN
       go func() { resultCh <- task(ctx) }()
       select {
       case res := <-resultCh: return res
       case <-ctx.Done():    return ctx.Err()   // <-- tiket lepas, TASK MASIH JALAN
       }
   }

   // ✅ BENAR -- tiket lepas saat KERJA-nya selesai, bukan saat penunggunya pergi
   go func() {
       defer func() { <-b.pool }()
       ...
       resultCh <- task(ctx)
   }()
   ```

   Pada bentuk pertama, klien yang time out melepaskan slot sementara task-nya masih menahan koneksi DB dan memori. Permintaan berikutnya masuk, ikut menggantung, dan seterusnya — **jumlah goroutine tumbuh tanpa batas sementara metrik melaporkan kapasitas tersedia.** Itu persis kondisi OOM yang Anti-Pattern 1 ada untuk mencegahnya, hanya kali ini dengan pembatas yang berbohong. Dan cacat ini tidak terlihat oleh uji mana pun kecuali yang secara khusus mengukur konkurensi puncak saat pemanggil menyerah — lihat `TestBulkhead_TiketTidakLepasSaatPemanggilMenyerah`.

   Konsekuensi yang harus diterima: task yang tidak menghormati `ctx` akan menahan slotnya selamanya, dan kapasitas menyusut permanen. Itu **benar** — sumber dayanya memang masih terpakai. Yang salah adalah menyembunyikannya.

3. **Ketidakseimbangan Kapasitas Dinamis (Static Sizing)**:
   Saat aplikasi berskala, limit statis `NewBulkhead("order", 80)` mungkin sudah tidak relevan dan malah mencekik *traffic* normal yang meningkat organik.
   *Penanganan*: Di perusahaan *Big Tech*, Bulkhead tidak di-set statis. Mereka menggunakan algoritma adaptif (mirip TCP Congestion Control) seperti **Netflix's Adaptive Concurrency Limits**, di mana kapasitas maksimum di-*adjust* (naik/turun) secara dinamis berdasarkan kalkulasi latensi rata-rata dari *server* downstream.

   *Sebelum sampai ke sana, ada angka awal yang bisa diturunkan, bukan ditebak.* Bagian "Kapan JANGAN Pakai Ini" di bawah menyatakan ukuran partisi harus berasal dari kapasitas hilir dan target latensi — rumusnya adalah **Hukum Little**:

   ```text
   konkurensi = throughput × latensi

   Contoh: hilir sanggup 200 permintaan/detik, latensi p99-nya 150 ms
           konkurensi = 200 × 0,15 = 30 slot
   ```

   Tiga hal yang membuat angka ini benar dan sering dilewatkan:
   - **Pakai latensi p99, bukan rata-rata.** Slot ditahan oleh permintaan yang lambat, bukan oleh yang khas. Memakai p50 menghasilkan partisi yang terlalu kecil dan menolak trafik normal.
   - **Batasnya adalah kapasitas HILIR, bukan kapasitas Anda.** Memberi 200 slot pada database yang hanya punya 50 koneksi tidak menambah throughput — ia hanya memindahkan antrean ke tempat yang tidak punya metrik.
   - **Jumlah seluruh partisi harus muat di anggaran nyata.** 80 + 20 slot yang semuanya menyentuh satu `sql.DB` ber-`MaxOpenConns(50)` berarti isolasinya berhenti di lapisan Go — persis Anti-Pattern 2.

   Setelah angka awal itu terpasang, barulah metriknya (`Statistik()`) memberi tahu apakah ia perlu naik atau turun: `ditolak` yang tinggi sementara hilir santai berarti terlalu kecil; `ditolak` yang selalu nol berarti ia tidak melindungi apa pun.

## 5. Unit Tests (Behavioral Testing)

```go
package resilience

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestBulkhead_MenolakSaatPenuh(t *testing.T) {
	b := NewBulkhead("uji", 2)
	ctx := context.Background()

	masuk := make(chan struct{}, 2) // sinyal: task sudah benar-benar berjalan
	lepas := make(chan struct{})
	task := func(context.Context) (string, error) {
		masuk <- struct{}{}
		<-lepas
		return "done", nil
	}

	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := Jalankan(ctx, b, time.Second, task); err != nil {
				t.Errorf("filler task failed: %v", err)
			}
		}()
	}

	// Sinkronisasi lewat channel, BUKAN time.Sleep(50ms). Tidur adalah
	// taruhan dua arah: gagal acak di mesin sibuk (CI), dan membuang waktu di
	// mesin cepat. Di sini ia juga bisa membuat uji lolos karena alasan yang
	// salah -- bila kedua task belum sempat masuk, penolakan berikutnya
	// terjadi bukan karena bulkhead penuh.
	for i := 0; i < 2; i++ {
		select {
		case <-masuk:
		case <-time.After(2 * time.Second):
			t.Fatal("filler task never started running")
		}
	}

	_, err := Jalankan(ctx, b, 50*time.Millisecond, task)
	if !errors.Is(err, ErrBulkheadFull) {
		t.Fatalf("mengharapkan ErrBulkheadFull, dapat %v", err)
	}

	// Fail-fast murni (timeout 0) juga harus menolak, tanpa menunggu.
	mulai := time.Now()
	if _, err := Jalankan(ctx, b, 0, task); !errors.Is(err, ErrBulkheadFull) {
		t.Errorf("timeout 0 harus fail-fast dengan ErrBulkheadFull, dapat %v", err)
	}
	if d := time.Since(mulai); d > 20*time.Millisecond {
		t.Errorf("fail-fast menunggu %v; seharusnya nyaris seketika", d)
	}

	close(lepas)
	wg.Wait() // uji tidak boleh selesai sementara goroutine-nya masih berjalan
}

// INI UJI YANG PALING PENTING DI BERKAS INI.
//
// Ia memeriksa bahwa tiket TIDAK dilepas ketika pemanggil menyerah sementara
// task-nya masih berjalan. Tanpa ini, cacatnya tidak terlihat: setiap uji lain
// tetap hijau sementara bulkhead diam-diam kehilangan kemampuan membatasi
// apa pun -- persis di bawah beban yang menjadi alasan ia dipasang.
func TestBulkhead_TiketTidakLepasSaatPemanggilMenyerah(t *testing.T) {
	const capacity = 3
	b := NewBulkhead("uji", capacity)

	var running atomic.Int64
	var peak atomic.Int64
	tahan := make(chan struct{})

	// Task yang SENGAJA mengabaikan ctx -- mensimulasikan hilir yang macet
	// atau pustaka pihak ketiga tanpa dukungan context.
	task := func(context.Context) (int, error) {
		n := running.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		defer running.Add(-1)
		<-tahan
		return 1, nil
	}

	var wg sync.WaitGroup
	// Jauh lebih banyak pemanggil daripada kapasitas. Setiap pemanggil
	// menyerah cepat, tetapi task-nya tetap berjalan.
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, batal := context.WithTimeout(context.Background(), 30*time.Millisecond)
			defer batal()
			_, _ = Jalankan(ctx, b, 50*time.Millisecond, task)
		}()
	}
	wg.Wait()

	// Beri kesempatan task yang tertinggal untuk terdaftar.
	time.Sleep(50 * time.Millisecond)

	if p := peak.Load(); p > capacity {
		t.Fatalf("task berjalan serentak mencapai %d, melebihi kapasitas %d; "+
			"tiket dilepas saat pemanggil keluar padahal task masih berjalan", p, capacity)
	}

	close(tahan)
}

func TestBulkhead_PembatalanContextDiteruskan(t *testing.T) {
	b := NewBulkhead("uji", 5)
	ctx, batal := context.WithCancel(context.Background())

	mulai := make(chan struct{})
	task := func(c context.Context) (string, error) {
		close(mulai)
		select {
		case <-c.Done():
			return "", c.Err()
		case <-time.After(5 * time.Second):
			return "done", nil
		}
	}

	go func() {
		<-mulai
		batal()
	}()

	_, err := Jalankan(ctx, b, 10*time.Second, task)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled in error chain, got %v", err)
	}
}

// Panic dalam task tidak boleh mengurangi kapasitas secara permanen.
func TestBulkhead_PanicMelepasTiket(t *testing.T) {
	b := NewBulkhead("uji", 1)
	ctx := context.Background()

	_, err := Jalankan(ctx, b, time.Second, func(context.Context) (int, error) {
		panic("task meledak")
	})
	if err == nil {
		t.Fatal("panic must be returned as an error")
	}

	// Bila tiket tidak dilepas, panggilan berikutnya menggantung sampai
	// timeout dan mengembalikan ErrBulkheadFull.
	if _, err := Jalankan(ctx, b, 200*time.Millisecond, func(context.Context) (int, error) {
		return 7, nil
	}); err != nil {
		t.Fatalf("capacity did not recover after panic: %v", err)
	}
}

// Metrik yang diperintahkan bagian deteksi harus benar-benar bergerak.
func TestBulkhead_MetrikTercatat(t *testing.T) {
	b := NewBulkhead("uji", 1)
	ctx := context.Background()

	if _, err := Jalankan(ctx, b, time.Second, func(context.Context) (int, error) {
		return 1, nil
	}); err != nil {
		t.Fatal(err)
	}

	tahan := make(chan struct{})
	siap := make(chan struct{})
	go func() {
		_, _ = Jalankan(ctx, b, time.Second, func(context.Context) (int, error) {
			close(siap)
			<-tahan
			return 1, nil
		})
	}()
	<-siap

	if _, err := Jalankan(ctx, b, 0, func(context.Context) (int, error) {
		return 1, nil
	}); !errors.Is(err, ErrBulkheadFull) {
		t.Fatalf("mengharapkan penolakan, dapat %v", err)
	}

	aktif, diterima, ditolak, _ := b.Stats()
	if aktif != 1 {
		t.Errorf("aktif = %d, mau 1", aktif)
	}
	if diterima != 2 {
		t.Errorf("diterima = %d, mau 2", diterima)
	}
	if ditolak != 1 {
		t.Errorf("ditolak = %d, mau 1", ditolak)
	}

	close(tahan)
}
```

## Kapan JANGAN Pakai Ini

- **Ketika hanya ada satu dependensi.** Bulkhead memisahkan sumber daya agar satu dependensi yang lambat tidak menghabiskan semuanya. Dengan satu dependensi, tidak ada yang dipisahkan — yang dibutuhkan hanya batas dan timeout.
- **Partisi yang terlalu banyak.** Sepuluh bulkhead masing-masing berkapasitas dua berarti tidak satu pun punya kapasitas memadai saat lonjakan normal, dan Anda menciptakan kemacetan yang sebelumnya tidak ada.
- **Bulkhead tanpa timeout.** Membatasi **jumlah** tidak membatasi **durasi**. Sepuluh slot yang semuanya menggantung tetap berarti jalur itu mati — hanya dengan angka yang lebih rapi.
- **Sebagai pengganti perbaikan hilir yang lambat.** Ia membatasi luas kerusakan, bukan menghilangkan penyebabnya. Bila hilir selalu lambat, bulkhead hanya membuat kegagalannya lebih sopan.
- **Dengan ukuran partisi yang ditebak.** Angkanya harus diturunkan dari kapasitas hilir dan target latensi. Angka bulat yang enak dilihat bukan dasar yang sah.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Satu dependensi lambat menjatuhkan semua jalur | apakah bulkhead terpasang | Sumber daya dibagi tanpa isolasi |
| Permintaan ditolak padahal sistem tidak sibuk | ukuran partisi | Partisi terlalu kecil untuk beban normal |
| Slot penuh tapi tidak ada kemajuan | durasi pemakaian slot | Tidak ada timeout; slot tertahan selamanya |
| Waktu tunggu slot mendominasi latensi | rasio tunggu vs kerja | Kapasitas hilir yang jadi batas, bukan bulkhead |
| Bulkhead tidak pernah penuh | ukuran vs trafik nyata | Partisi terlalu longgar; tidak melindungi apa pun |
| Goroutine tumbuh terus padahal slot "tersedia" | konkurensi puncak vs kapasitas | Tiket dilepas saat pemanggil menyerah, bukan saat task selesai (Edge Case 2) |

```bash
# Metrik ini berasal dari Bulkhead.Statistik(). Ekspor ketiganya, bukan hanya
# yang aktif: gauge saja tidak bisa membedakan "tidak ada beban" dari
# "semua ditolak".
curl -s localhost:9090/metrics | grep -E 'bulkhead_(active|accepted_total|rejected_total|wait_seconds)'

# Konkurensi nyata vs kapasitas yang dideklarasikan. Angka pertama yang
# melebihi angka kedua membuktikan pembatasnya bocor.
curl -s 'localhost:6060/debug/pprof/goroutine?debug=1' | grep -c 'resilience.Jalankan'

# Aktifkan dulu: runtime.SetBlockProfileRate(1)
go tool pprof -top http://localhost:6060/debug/pprof/block

# Goroutine yang mengantre semaphore
curl -s 'localhost:6060/debug/pprof/goroutine?debug=1' | grep -i -B2 -A3 semaphore
```
