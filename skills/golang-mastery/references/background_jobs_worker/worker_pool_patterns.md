---
title: "Golang Background Job Worker Pool Patterns"
description: "Panduan mendalam tentang arsitektur worker pool, backpressure, fan-out/fan-in, graceful shutdown, serta edge-cases handling pada Go."
---

# 🏭 Golang Worker Pool Patterns & Background Job Internals

Artikel ini membahas berbagai pola worker pool dan pemrosesan background job tingkat lanjut di Go. Sebagai *production-grade* engineering, kita harus menjauhi goroutine leak, mengelola memory footprint (backpressure), dan menangani error secara deterministik.

## 1. Arsitektur Dasar: Fan-out / Fan-in Pattern

Pola **Fan-out** mendistribusikan satu aliran data ke banyak worker.
Pola **Fan-in** menggabungkan hasil dari banyak worker ke satu channel.

### Diagram ASCII Aliran Data

```text
                        +-----------+
                     -> | Worker 1  | --+
                    /   +-----------+    \
+--------------+   /                      \    +-------------+
| Producer     |--+---> +-----------+      +-> | Aggregator  |
| (Jobs chan)  |        | Worker 2  | -------->| (Results)   |
+--------------+--+     +-----------+      +-> +-------------+
                   \                      /
                    \   +-----------+    /
                     -> | Worker N  | --+
                        +-----------+
```

### Implementasi Fan-out / Fan-in Production-Ready

```go
package workerpool

import (
	"context"
	"fmt"
	"sync"
)

type Job struct {
	ID    int
	Input string
}

type Result struct {
	JobID int
	Value string
	Err   error
}

// ProcessJobs mengimplementasikan fan-out fan-in pattern secara graceful.
func ProcessJobs(ctx context.Context, jobs <-chan Job, numWorkers int) <-chan Result {
	results := make(chan Result, numWorkers)
	var wg sync.WaitGroup

	// Fan-out: Spawn workers
	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					// Context cancelled, aborting early
					return
				case job, ok := <-jobs:
					if !ok {
						// Jobs channel ditutup (drained), worker selesai
						return
					}
					// Proses secara sinkron dalam worker ini
					res, err := executeJob(ctx, job)
					select {
					case <-ctx.Done():
						return // Hindari blocking pada results saat context cancelled
					case results <- Result{JobID: job.ID, Value: res, Err: err}:
					}
				}
			}
		}(i)
	}

	// Fan-in aggregator closure
	go func() {
		wg.Wait()
		close(results) // Semua worker selesai, tutup channel results
	}()

	return results
}

func executeJob(ctx context.Context, job Job) (string, error) {
	// Simulasi pemrosesan
	return fmt.Sprintf("Processed %s", job.Input), nil
}
```

## 2. Bounded Worker Pool dengan Semaphore

Menggunakan paket `golang.org/x/sync/semaphore` sangat efisien untuk membatasi jumlah goroutine yang berjalan konkuren *tanpa* perlu channel worker, terutama berguna jika job tidak dialirkan via channel, melainkan iterasi slice.

```go
package workerpool

import (
	"context"
	"fmt"
	"log"

	"golang.org/x/sync/semaphore"
)

// ProcessWithSemaphore mengeksekusi iterasi menggunakan weight semaphore.
func ProcessWithSemaphore(ctx context.Context, jobs []Job, limit int64) error {
	sem := semaphore.NewWeighted(limit)
	errChan := make(chan error, len(jobs))

	for _, j := range jobs {
		// Acquire token
		if err := sem.Acquire(ctx, 1); err != nil {
			return fmt.Errorf("gagal acquire semaphore: %w", err)
		}

		go func(job Job) {
			defer sem.Release(1)
			
			// Defensive: tangani panic
			defer func() {
				if r := recover(); r != nil {
					log.Printf("Panic recovered in job %d: %v", job.ID, r)
					errChan <- fmt.Errorf("panic in job %d: %v", job.ID, r)
				}
			}()

			_, err := executeJob(ctx, job)
			if err != nil {
				errChan <- err
			}
		}(j)
	}

	// Wait all acquires (Trick: acquire full weight)
	if err := sem.Acquire(ctx, limit); err != nil {
		return fmt.Errorf("gagal menunggu seluruh job selesai: %w", err)
	}
	close(errChan)

	// Collect first error if any
	for err := range errChan {
		if err != nil {
			return err
		}
	}
	return nil
}
```

## 3. Errgroup untuk Koleksi Error dan Konkurensi

`golang.org/x/sync/errgroup` adalah pattern andalan untuk menjalankan *finite* sub-tasks secara paralel dan menghentikan sisanya jika satu task gagal.

```go
package workerpool

import (
	"context"

	"golang.org/x/sync/errgroup"
)

// ProcessWithErrGroup menjalankan task dan otomatis cancel jika satu gagal.
func ProcessWithErrGroup(ctx context.Context, jobs []Job) error {
	// WithContext mengembalikan context turunan yang di-cancel jika fungsi return error
	g, gCtx := errgroup.WithContext(ctx)
	// Opsional: g.SetLimit(10) // go 1.20+

	for _, job := range jobs {
		j := job // shadow loop variable untuk goroutine
		g.Go(func() error {
			// Periksa jika sudah batal oleh job lain
			select {
			case <-gCtx.Done():
				return gCtx.Err()
			default:
			}

			_, err := executeJob(gCtx, j)
			if err != nil {
				// Akan men-trigger cancellation untuk seluruh task lain
				return err
			}
			return nil
		})
	}

	// Block hingga semua task selesai atau gagal
	return g.Wait()
}
```

## 4. Backpressure & Graceful Shutdown

Sistem yang tangguh tidak boleh kelebihan muatan memori. **Backpressure** diterapkan dengan channel *buffered*. Saat buffer penuh, *producer* akan melambat secara alami.

**Graceful Shutdown** melibatkan:
1. Mendengarkan `os.Signal` (SIGTERM/SIGINT).
2. Berhenti menerima job baru.
3. Menunggu (draining) in-flight jobs selesai atau mencapai timeout paksa.

```go
package workerpool

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"
)

type Server struct {
	jobQueue  chan Job
	wg        sync.WaitGroup
	quit      chan struct{}
	workerNum int
}

func NewServer(bufferSize, workers int) *Server {
	return &Server{
		jobQueue:  make(chan Job, bufferSize), // Buffer size = Backpressure control
		quit:      make(chan struct{}),
		workerNum: workers,
	}
}

func (s *Server) Start(ctx context.Context) {
	for i := 0; i < s.workerNum; i++ {
		s.wg.Add(1)
		go s.workerLoop(ctx, i)
	}
}

func (s *Server) workerLoop(ctx context.Context, id int) {
	defer s.wg.Done()
	for {
		select {
		case <-s.quit:
			log.Printf("Worker %d menerima sinyal quit, shutting down...", id)
			return
		case job, ok := <-s.jobQueue:
			if !ok {
				return // Channel ditutup
			}
			// Simulasi DB Insert batching atau proses lambat
			time.Sleep(100 * time.Millisecond)
			log.Printf("Worker %d menyelesaikan job %d", id, job.ID)
		}
	}
}

func (s *Server) SubmitJob(j Job) error {
	select {
	case <-s.quit:
		return errors.New("server is shutting down, reject new job")
	case s.jobQueue <- j: // Block jika queue penuh (Backpressure!)
		return nil
	}
}

// GracefulShutdown menutup server dengan timeout
func (s *Server) GracefulShutdown(timeout time.Duration) {
	log.Println("Memulai graceful shutdown...")
	close(s.quit) // Stop semua worker menerima dari s.quit, tapi jobQueue mungkin masih ada data

	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		log.Println("Semua worker berhasil shutdown (graceful).")
	case <-time.After(timeout):
		log.Println("Timeout tercapai, memaksa exit (hard shutdown).")
	}
}
```

## 5. Ants Library: High-Performance Pool

Untuk kebutuhan *ultra-high throughput* di mana spawning ribuan goroutine tetap mahal, `github.com/panjf2000/ants/v2` mengelola goroutine yang dapat dipanggil ulang (*reusable*), menghemat overhead alokasi memori secara masif.

```go
package workerpool

import (
	"context"
	"log"

	"github.com/panjf2000/ants/v2"
)

func ProcessWithAnts(jobs []Job) {
	defer ants.Release() // membersihkan default pool

	// Buat custom pool
	p, err := ants.NewPoolWithFunc(100, func(i interface{}) {
		job := i.(Job)
		executeJob(context.Background(), job)
	}, ants.WithPreAlloc(true), ants.WithMaxBlockingTasks(500))
	if err != nil {
		log.Fatal(err)
	}
	defer p.Release()

	for _, j := range jobs {
		// Mengirim task ke ants pool. Akan ter-block jika > maxBlockingTasks
		_ = p.Invoke(j)
	}
}
```

## 6. Dynamic Sizing Worker Pool

Pool dapat beradaptasi ukurannya berdasarkan beban queue (scale-up dan scale-down).

```go
package workerpool

import (
	"sync"
	"sync/atomic"
	"time"
)

type DynamicPool struct {
	jobChan     chan func()
	minWorkers  int32
	maxWorkers  int32
	currWorkers int32
	idleTimeout time.Duration
	wg          sync.WaitGroup
}

func NewDynamicPool(min, max int32, idle time.Duration) *DynamicPool {
	p := &DynamicPool{
		jobChan:     make(chan func()),
		minWorkers:  min,
		maxWorkers:  max,
		idleTimeout: idle,
	}
	for i := int32(0); i < min; i++ {
		p.spawnWorker()
	}
	return p
}

func (p *DynamicPool) spawnWorker() {
	atomic.AddInt32(&p.currWorkers, 1)
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		defer atomic.AddInt32(&p.currWorkers, -1)
		
		idleTimer := time.NewTimer(p.idleTimeout)
		defer idleTimer.Stop()

		for {
			idleTimer.Reset(p.idleTimeout)
			select {
			case task, ok := <-p.jobChan:
				if !ok { return }
				task()
			case <-idleTimer.C:
				// Worker timeout, scale down jika current > min
				curr := atomic.LoadInt32(&p.currWorkers)
				if curr > p.minWorkers {
					return // Worker goroutine mati (scale down)
				}
			}
		}
	}()
}

func (p *DynamicPool) Submit(task func()) {
	curr := atomic.LoadInt32(&p.currWorkers)
	// Scale up heuristik
	if len(p.jobChan) > 0 && curr < p.maxWorkers {
		p.spawnWorker()
	}
	p.jobChan <- task
}
```

## 7. Anti-Patterns (❌ vs ✅)

### Anti-Pattern 1: Unbounded Goroutine Spawn (Goroutine Leak)
❌ **BAD:** Tidak ada batasan konkurensi. Memori membengkak (OOM Killer).
```go
// ❌ Jangan lakukan ini!
func ProcessAllBad(reqs []string) {
    for _, r := range reqs {
        go func(req string) {
            // MakeHTTPCall(req) // Jika slow response, ribuan goroutines menumpuk
        }(r)
    }
}
```
✅ **GOOD:** Gunakan semafore atau worker pool.
```go
// ✅ Gunakan bounded konkurensi
import "golang.org/x/sync/semaphore"

func ProcessAllGood(reqs []string) {
    sem := semaphore.NewWeighted(50) // Max 50 request konkuren
    for _, r := range reqs {
        sem.Acquire(context.Background(), 1)
        go func(req string) {
            defer sem.Release(1)
            // MakeHTTPCall(req)
        }(r)
    }
}
```

### Anti-Pattern 2: No Backpressure
❌ **BAD:** Unbuffered channel membuat sistem tidak sadar load yang menumpuk.
```go
// ❌ Unbuffered / unbounded queue slice
var jobsQueue []Job
func Enqueue(j Job) {
    jobsQueue = append(jobsQueue, j) // Memori bocor pelan-pelan
}
```
✅ **GOOD:** Buffered channel memblokir producer (Backpressure OS tingkat jaringan/TCP windowing scale-down).
```go
// ✅ Memiliki limit antrian
var jobQueueGood = make(chan Job, 1000) 
func EnqueueGood(j Job) {
    jobQueueGood <- j // Terblokir jika buffer 1000 penuh, caller harus menunggu
}
```

## 8. Edge Cases & Defensive Programming

### 1. Panic di Worker
**Masalah:** Satu goroutine panic mematikan seluruh aplikasi.
**Mitigasi:** WAJIB gunakan `recover()` di root layer goroutine. Selalu `defer func(){ recover() }()` pada closure yang dieksekusi oleh pool, mencegah crash daemon.

### 2. Context Cancellation saat DB Batch Insert
**Masalah:** Context expired ketika transaksi `db.ExecContext()` sedang berlangsung, membuat data korup.
**Mitigasi:** Pisahkan root context dari context request, gunakan `context.WithoutCancel(ctx)` pada Go 1.21+ untuk operasi persisten yang krusial, atau beri context timeout terpisah khusus untuk proses batch storage.

### 3. Goroutine Blocked Selamanya (Deadlock)
**Masalah:** Channel receive tanpa select-context, worker tersangkut di request eksternal (HTTP/RPC).
**Mitigasi:** Gunakan `http.Client{Timeout: 5 * time.Second}` dan selalu sertakan timeout atau `case <-ctx.Done():` saat menanti event dari channel.

### 4. WaitGroup Negative Counter
**Masalah:** Memanggil `wg.Done()` lebih banyak dari `wg.Add()`. Aplikasi panic "sync: negative WaitGroup counter".
**Mitigasi:** `wg.Add(1)` HANYA dilakukan di parent goroutine SEBELUM instansiasi `go func()`, dan `wg.Done()` WAJIB dijalankan melalui mekanisme `defer` di blok pertama child goroutine.

### 5. Race Condition Closure Loop
**Masalah:** `for _, j := range jobs { go func() { print(j) }() }` (Terutama di Go versi < 1.22) mem-print elemen terakhir berulang-ulang akibat pointer loop-variable.
**Mitigasi:** Lakukan copy lokal `j := j` di scope iterasi, atau injeksi via argumen anonimus `go func(job Job){ ... }(j)`.

## 9. Unit & Integration Tests

```go
package workerpool_test

import (
	"context"
	"testing"
	"time"
)

// Simulasi package import
// import "myproj/workerpool"

func TestFanOutFanIn_Success(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	jobsChan := make(chan workerpool.Job, 10)
	for i := 0; i < 5; i++ {
		jobsChan <- workerpool.Job{ID: i, Input: "test"}
	}
	close(jobsChan) // Drain

	results := workerpool.ProcessJobs(ctx, jobsChan, 3)

	var count int
	for res := range results {
		if res.Err != nil {
			t.Fatalf("unexpected error: %v", res.Err)
		}
		count++
	}

	if count != 5 {
		t.Fatalf("expected 5 results, got %d", count)
	}
}

func TestSemaphorePool_TimeoutCancellation(t *testing.T) {
	// Membuktikan token release terjadi walau timeout
	jobs := []workerpool.Job{
		{ID: 1, Input: "normal"},
		{ID: 2, Input: "slow"}, // Trigger context cancel (timeout logic mock in real scenario)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Millisecond)
	defer cancel()

	err := workerpool.ProcessWithSemaphore(ctx, jobs, 2)
	if err == nil {
		t.Fatal("expected error context timeout, got nil")
	}
}

func TestDynamicPool_ScaleUp(t *testing.T) {
	pool := workerpool.NewDynamicPool(1, 5, 100*time.Millisecond)
	
	// Scale Up
	for i := 0; i < 10; i++ {
		pool.Submit(func() {
			time.Sleep(10 * time.Millisecond) // Simulasi lambat
		})
	}
	
	// Validasi secara observasional atau dengan mock
}
```
