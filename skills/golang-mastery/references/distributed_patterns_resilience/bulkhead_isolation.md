# Bulkhead Pattern (Isolasi Kegagalan)

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
	"log"
	"time"
)

var (
	ErrBulkheadFull = errors.New("bulkhead is full, request rejected to preserve system stability")
)

// Bulkhead membatasi jumlah eksekusi konkuren.
type Bulkhead struct {
	pool chan struct{}
}

// NewBulkhead menginisialisasi kapasitas maksimum kompartemen.
func NewBulkhead(maxConcurrent int) *Bulkhead {
	return &Bulkhead{
		// Buffered channel berfungsi sebagai Semaphore.
		pool: make(chan struct{}, maxConcurrent),
	}
}

// Execute menjalankan tugas di dalam partisi Bulkhead.
// Jika pool penuh, fungsi akan *fail fast* atau menunggu maksimal sepanjang `timeout`.
func (b *Bulkhead) Execute(ctx context.Context, timeout time.Duration, task func(ctx context.Context) (interface{}, error)) (interface{}, error) {
	// Gunakan timer untuk fallback (Slight delay tolerance)
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	// 1. Fase Acquire Resource (Mencoba masuk kompartemen)
	select {
	case b.pool <- struct{}{}:
		// Berhasil masuk pool
		defer func() {
			// Lepaskan resource saat selesai
			<-b.pool
		}()
	case <-timer.C:
		// Pool penuh dan waktu tunggu habis. FAIL FAST.
		// Menyelamatkan sistem utama dari request hang.
		return nil, ErrBulkheadFull
	case <-ctx.Done():
		// Klien sudah membatalkan request sebelum kita masuk pool
		return nil, fmt.Errorf("request cancelled while waiting for bulkhead: %w", ctx.Err())
	}

	// 2. Fase Eksekusi
	// Perlu kita bungkus dengan goroutine jika task berpotensi blocking panjang
	// Namun karena kita sudah mengontrol concurrency dengan semaphore, 
	// mengeksekusi langsung di goroutine caller juga aman, ASALKAN task menghormati context cancellation.
	
	// Untuk keamanan maksimal dari task jahat, gunakan channel.
	type result struct {
		val interface{}
		err error
	}
	resChan := make(chan result, 1)

	go func() {
		// Panic recovery penting agar semaphore tidak lock permanen
		defer func() {
			if r := recover(); r != nil {
				resChan <- result{nil, fmt.Errorf("panic in task: %v", r)}
			}
		}()
		val, err := task(ctx)
		resChan <- result{val, err}
	}()

	select {
	case res := <-resChan:
		return res.val, res.err
	case <-ctx.Done():
		return nil, fmt.Errorf("context cancelled during task execution: %w", ctx.Err())
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
		orderBulkhead:  NewBulkhead(80),
		// Report hanya diberi 20% agar tidak membunuh service
		reportBulkhead: NewBulkhead(20),
	}
}

func (a *Application) HandleReport(ctx context.Context) error {
	_, err := a.reportBulkhead.Execute(ctx, 500*time.Millisecond, func(c context.Context) (interface{}, error) {
		// Simulasi proses report yang berat dan lambat
		log.Println("Generating heavy report...")
		time.Sleep(10 * time.Second) 
		return nil, nil
	})
	return err
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
   *Penanganan*: *Production code* di atas telah menunjukkan cara yang benar. Pelepasan tiket **wajib** diletakkan di dalam statemen `defer` yang berada langsung di atas (setelah sukses memasukkan tiket), bukan di akhir eksekusi biasa.

3. **Ketidakseimbangan Kapasitas Dinamis (Static Sizing)**:
   Saat aplikasi berskala, limit statis `NewBulkhead(80)` mungkin sudah tidak relevan dan malah mencekik *traffic* normal yang meningkat organik.
   *Penanganan*: Di perusahaan *Big Tech*, Bulkhead tidak di-set statis. Mereka menggunakan algoritma adaptif (mirip TCP Congestion Control) seperti **Netflix's Adaptive Concurrency Limits**, di mana kapasitas maksimum di-*adjust* (naik/turun) secara dinamis berdasarkan kalkulasi latensi rata-rata dari *server* downstream.

## 5. Unit Tests (Behavioral Testing)

```go
package resilience

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestBulkhead_RejectsWhenFull(t *testing.T) {
	// Kapasitas maksimal hanya 2
	bulkhead := NewBulkhead(2)
	ctx := context.Background()

	// Fungsi yang memblokir secara sengaja
	block := make(chan struct{})
	task := func(ctx context.Context) (interface{}, error) {
		<-block // Tunggu instruksi buka
		return "done", nil
	}

	// 1. Eksekusi 2 task (akan mengambil semua kapasitas)
	go bulkhead.Execute(ctx, 1*time.Second, task)
	go bulkhead.Execute(ctx, 1*time.Second, task)

	// Beri waktu goroutine agar masuk ke dalam semaphore
	time.Sleep(50 * time.Millisecond)

	// 2. Eksekusi task ke-3, harusnya gagal
	// Timeout disetel ke 50ms agar cepat putus asa.
	_, err := bulkhead.Execute(ctx, 50*time.Millisecond, task)

	if !errors.Is(err, ErrBulkheadFull) {
		t.Fatalf("Expected ErrBulkheadFull, got %v", err)
	}

	// Lepaskan kunci
	close(block)
}

func TestBulkhead_ContextCancellationPropagation(t *testing.T) {
	bulkhead := NewBulkhead(5)
	
	ctx, cancel := context.WithCancel(context.Background())
	
	var executed atomic.Bool
	
	task := func(c context.Context) (interface{}, error) {
		executed.Store(true)
		// Simulasi long running task
		select {
		case <-c.Done():
			return nil, errors.New("internal aborted")
		case <-time.After(5 * time.Second):
			return "done", nil
		}
	}

	// Cancel context segera
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()

	_, err := bulkhead.Execute(ctx, 10*time.Second, task)

	if err == nil {
		t.Fatal("Expected error from context cancellation")
	}

	if !executed.Load() {
		t.Fatal("Task should have started execution")
	}
}
```
