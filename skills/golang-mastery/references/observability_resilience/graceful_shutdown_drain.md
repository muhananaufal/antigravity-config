# Graceful Shutdown & Connection Draining di Go

> **Berlaku:** Go 1.21+ · Kubernetes 1.28+ · **Lihat juga:** `observability_resilience/health_check_readiness.md` · `concurrency/goroutine_leak_detection.md` · `concurrency/context_cancellation_timeout.md` · `background_jobs_worker/worker_pool_patterns.md`

Graceful shutdown adalah proses terstruktur untuk menghentikan server tanpa memutus request yang sedang berjalan. Di Kubernetes, jika tidak dilakukan dengan benar, rolling deployment menyebabkan HTTP 502 karena pod lama terbunuh sebelum in-flight request selesai.

---

## 1. Arsitektur Internal: Urutan Events

```
Kubernetes Rolling Update:
                                                          
  1. kubelet → kirim SIGTERM ke PID 1 container          
  2. kube-proxy mulai hapus Pod IP dari iptables rules   
     (butuh 1-3 detik sampai efektif!)                   
  3. Pod masih menerima traffic selama iptables belum    
     sinkron → WAJIB delay sebelum stop listener!        
                                                          
Timeline yang benar:                                      
                                                          
  t=0s:  SIGTERM diterima                                 
  t=0s:  Readiness → 503 (signal LB untuk stop send)     
  t=2s:  sleep 2s (tunggu iptables K8s sinkron)          
  t=2s:  srv.Shutdown(ctx) — stop accept baru            
  t=2s–27s: drain in-flight requests (max 25s)           
  t=~5s: semua request selesai → WaitGroup done          
  t=5s:  close DB connections, flush metrics              
  t=5s:  os.Exit(0)                                       
                                                          
  terminationGracePeriodSeconds K8s: 30s                 
  Go shutdown timeout: 25s (< 30s, wajib!)              
                                                          
  Jika timeout: K8s kirim SIGKILL → paksa mati           
```

**Kenapa `http.Server.Shutdown()` bekerja:**
- `Shutdown()` memanggil `Listener.Close()` — tidak ada koneksi baru masuk
- Menunggu semua `http.ResponseWriter.Write()` selesai via internal counter
- Koneksi idle (Keep-Alive) langsung ditutup
- Koneksi aktif dibiarkan selesai sampai timeout

---

## 2. Kode Go Production-Ready

```go
package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// Server adalah wrapper http.Server dengan lifecycle management.
type Server struct {
	httpServer     *http.Server
	bgTasks        sync.WaitGroup
	isShuttingDown atomic.Bool
	shutdownDelay  time.Duration // delay sebelum Shutdown() — untuk K8s iptables sync
	drainTimeout   time.Duration // max waktu drain in-flight requests
}

// NewServer membuat server production-ready.
func NewServer(addr string, handler http.Handler) *Server {
	s := &Server{
		shutdownDelay: 2 * time.Second,  // K8s iptables sync window
		drainTimeout:  25 * time.Second, // harus < terminationGracePeriodSeconds
	}
	s.httpServer = &http.Server{
		Addr:         addr,
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 20 * time.Second,
		IdleTimeout:  120 * time.Second, // close Keep-Alive conn yang idle
	}
	return s
}

// IsShuttingDown digunakan oleh Readiness Probe.
func (s *Server) IsShuttingDown() bool {
	return s.isShuttingDown.Load()
}

// AddBackgroundTask mendaftarkan goroutine background (queue consumer, cron, dll).
// Wajib dipasangkan dengan DoneBackgroundTask() via defer.
func (s *Server) AddBackgroundTask() {
	s.bgTasks.Add(1)
}

// DoneBackgroundTask dipanggil saat background goroutine selesai.
func (s *Server) DoneBackgroundTask() {
	s.bgTasks.Done()
}

// Run menjalankan server dan memblok sampai signal diterima.
func (s *Server) Run() error {
	// Channel OS signal — buffered 1 agar signal tidak hilang
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	// Start HTTP server di goroutine terpisah
	serverErr := make(chan error, 1)
	go func() {
		if err := s.httpServer.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	// Block sampai signal atau error
	select {
	case err := <-serverErr:
		return fmt.Errorf("server failed to start: %w", err)
	case sig := <-sigCh:
		fmt.Printf("\n[shutdown] signal %s received\n", sig)
	}

	return s.shutdown()
}

// shutdown mengeksekusi urutan shutdown yang benar.
func (s *Server) shutdown() error {
	// Step 1: Tandai sebagai shutting down → Readiness Probe returns 503
	s.isShuttingDown.Store(true)
	fmt.Println("[shutdown] marked as shutting down (readiness: 503)")

	// Step 2: Delay iptables K8s sync (skip di test)
	if s.shutdownDelay > 0 {
		fmt.Printf("[shutdown] waiting %s for K8s iptables sync...\n", s.shutdownDelay)
		time.Sleep(s.shutdownDelay)
	}

	// Step 3: Stop accepting new connections, drain in-flight
	ctx, cancel := context.WithTimeout(context.Background(), s.drainTimeout)
	defer cancel()

	fmt.Println("[shutdown] draining HTTP connections...")
	if err := s.httpServer.Shutdown(ctx); err != nil {
		return fmt.Errorf("HTTP drain forced by timeout: %w", err)
	}
	fmt.Println("[shutdown] HTTP server drained cleanly")

	// Step 4: Tunggu background tasks selesai (dengan timeout yang sama)
	bgDone := make(chan struct{})
	go func() {
		s.bgTasks.Wait()
		close(bgDone)
	}()

	select {
	case <-bgDone:
		fmt.Println("[shutdown] all background tasks completed")
	case <-ctx.Done():
		return fmt.Errorf("timeout waiting for background tasks: %w", ctx.Err())
	}

	fmt.Println("[shutdown] graceful shutdown complete ✓")
	return nil
}

// --- Unit Tests ---

// TestShutdown_NormalFlow memverifikasi bahwa shutdown berjalan clean
// saat tidak ada in-flight request.
func TestShutdown_NormalFlow(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	srv := NewServer("localhost:0", handler)
	srv.shutdownDelay = 0 // skip K8s delay di test

	// Jalankan server di goroutine
	go func() {
		if err := srv.httpServer.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			t.Errorf("unexpected server error: %v", err)
		}
	}()
	time.Sleep(10 * time.Millisecond) // tunggu server start

	if err := srv.shutdown(); err != nil {
		t.Fatalf("shutdown failed: %v", err)
	}
}

// TestShutdown_ReadinessToggle memverifikasi bahwa IsShuttingDown berubah
// menjadi true segera setelah shutdown dipanggil.
func TestShutdown_ReadinessToggle(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	srv := NewServer("localhost:0", handler)
	srv.shutdownDelay = 0

	if srv.IsShuttingDown() {
		t.Fatal("server should not be shutting down initially")
	}

	go func() { srv.httpServer.ListenAndServe() }()
	time.Sleep(10 * time.Millisecond)

	// Jalankan shutdown di goroutine, cek flag segera setelah
	errCh := make(chan error, 1)
	go func() { errCh <- srv.shutdown() }()

	// Beri waktu shutdown() untuk set flag
	time.Sleep(5 * time.Millisecond)
	if !srv.IsShuttingDown() {
		t.Error("server should be marked as shutting down")
	}

	if err := <-errCh; err != nil {
		t.Fatalf("shutdown error: %v", err)
	}
}

// TestShutdown_BackgroundTaskWait memverifikasi bahwa shutdown menunggu
// background task selesai sebelum exit.
func TestShutdown_BackgroundTaskWait(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	srv := NewServer("localhost:0", handler)
	srv.shutdownDelay = 0

	// Register background task yang selesai setelah 50ms
	srv.AddBackgroundTask()
	taskDone := make(chan struct{})
	go func() {
		defer srv.DoneBackgroundTask()
		time.Sleep(50 * time.Millisecond)
		close(taskDone)
	}()

	go func() { srv.httpServer.ListenAndServe() }()
	time.Sleep(10 * time.Millisecond)

	start := time.Now()
	if err := srv.shutdown(); err != nil {
		t.Fatalf("shutdown error: %v", err)
	}

	// Shutdown harus menunggu minimal 50ms untuk task selesai
	elapsed := time.Since(start)
	if elapsed < 40*time.Millisecond {
		t.Errorf("shutdown did not wait for background task: elapsed=%s", elapsed)
	}
	select {
	case <-taskDone:
		// background task selesai — expected
	default:
		t.Error("background task did not complete before shutdown returned")
	}
}

// TestShutdown_InFlightRequests memverifikasi bahwa request yang sedang
// berjalan diselesaikan sebelum server berhenti.
func TestShutdown_InFlightRequests(t *testing.T) {
	requestHandled := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Simulasi request yang butuh waktu lama
		time.Sleep(100 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
		close(requestHandled)
	})

	// Gunakan httptest.Server untuk mendapat real port
	ts := httptest.NewServer(handler)
	defer ts.Close()

	// Kirim request (tidak tunggu)
	go func() {
		http.Get(ts.URL + "/slow")
	}()
	time.Sleep(10 * time.Millisecond) // pastikan request sudah mulai

	// Shutdown server — harus menunggu request selesai
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := ts.Config.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("shutdown error: %v", err)
	}

	select {
	case <-requestHandled:
		// request selesai sebelum shutdown — correct
	default:
		t.Error("in-flight request was not completed before shutdown")
	}
}
```

---

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Shutdown Timeout Lebih Besar dari K8s `terminationGracePeriodSeconds`

```go
// BAD: Go timeout 60s > K8s terminationGracePeriodSeconds 30s
// K8s akan kirim SIGKILL paksa di t=30s — Go timeout tidak relevan
ctx, _ := context.WithTimeout(context.Background(), 60*time.Second)
srv.Shutdown(ctx) // tidak akan pernah sampai 60s — di-kill di t=30

// GOOD: Go timeout selalu LEBIH KECIL dari K8s grace period
// K8s grace: 30s → Go timeout: 25s (memberi 5s buffer untuk cleanup lain)
ctx, _ := context.WithTimeout(context.Background(), 25*time.Second)
srv.Shutdown(ctx)
```

**Kenapa berbahaya:** Jika Go timeout ≥ K8s `terminationGracePeriodSeconds`, SIGKILL akan membunuh proses sebelum Shutdown selesai. In-flight request dibunuh paksa, DB connections tidak ditutup dengan benar — persis masalah yang ingin diselesaikan graceful shutdown.

### ❌ Anti-Pattern 2: `wg.Wait()` Tanpa Timeout — Potensi Deadlock Abadi

```go
// BAD: Jika 1 background goroutine stuck, wg.Wait() hang selamanya
// K8s akhirnya SIGKILL → shutdown tidak graceful
srv.Shutdown(ctx)
backgroundWg.Wait() // DEADLOCK jika goroutine tidak selesai!

// GOOD: Race wg.Wait() dengan context timeout
bgDone := make(chan struct{})
go func() { backgroundWg.Wait(); close(bgDone) }()
select {
case <-bgDone:
    // clean exit
case <-ctx.Done():
    log.Error().Msg("background tasks timed out — forcing exit")
    // Sudah terlambat menunggu, lanjut cleanup lain
}
```

**Kenapa berbahaya:** Background goroutine yang stuck (Kafka consumer yang tidak handle ctx cancellation) menyebabkan main goroutine hang selamanya. K8s akhirnya mengirim SIGKILL kasar — semua resource (DB connections, file locks) tidak di-close dengan benar.

### ❌ Anti-Pattern 3: Tidak Ada Delay Sebelum `Shutdown()` di Kubernetes

```go
// BAD: Langsung shutdown begitu SIGTERM diterima
<-sigChan
srv.Shutdown(ctx) // Traffic K8s masih masuk 1-3 detik! → HTTP 502

// GOOD: Delay 1-2 detik untuk tunggu iptables K8s sinkron
<-sigChan
s.isShuttingDown.Store(true) // readiness probe → 503 segera
time.Sleep(2 * time.Second)  // tunggu iptables
srv.Shutdown(ctx)
```

**Kenapa berbahaya:** Kubelet mengirim SIGTERM ke Pod bersamaan dengan menginstruksikan kube-proxy untuk update iptables rules. Update iptables membutuhkan 1-3 detik. Dalam jeda itu, traffic masih dikirim ke Pod yang sudah mulai shutdown → HTTP 502 bagi user. Delay 2 detik menghilangkan race condition ini.

---

## 4. Edge Cases & Defensive Programming

1. **Keep-Alive Connections Menahan Shutdown:** Client dengan persistent Keep-Alive connection (misalnya mobile SDK) bisa menahan `srv.Shutdown()` terus menunggu. Solusi: set `IdleTimeout` yang ketat di server config (misal 120s) dan pastikan `ReadTimeout`/`WriteTimeout` ada. Shutdown akan menutup idle Keep-Alive connections segera, hanya menunggu yang aktif saja.

2. **WebSocket & Long-Polling Tidak Di-drain oleh `Shutdown()`:** `http.Server.Shutdown()` hanya menunggu standar HTTP requests. WebSocket connections yang sudah di-upgrade tidak dihitung. Solusi: track WebSocket connections manual dengan sync.Map, kirim close frame ke semua connection saat SIGTERM, tunggu semua close via WaitGroup.

3. **`signal.Notify` Buffer Wajib ≥1:** `make(chan os.Signal, 0)` adalah unbuffered channel. Jika goroutine penerima belum siap tepat saat signal diterima, signal hilang diam-diam. Selalu gunakan buffered channel `make(chan os.Signal, 1)`.

4. **Multiple SIGTERM:** Kubernetes kadang mengirim SIGTERM lebih dari sekali. Pastikan handler signal idempotent — gunakan `sync.Once` untuk memastikan shutdown sequence hanya berjalan satu kali meski signal diterima berkali-kali.

5. **Metrics Flush Sebelum Exit:** Exporter Prometheus/OpenTelemetry biasanya punya buffer internal. Saat shutdown, panggil `shutdown()` pada metrics provider SETELAH HTTP server selesai drain tapi SEBELUM `os.Exit()`. Tanpa ini, metrics dari menit terakhir sebelum deployment hilang — mengganggu alerting.

## Kapan JANGAN Pakai Ini

- **Shutdown timeout lebih besar dari `terminationGracePeriodSeconds`.** Kubernetes akan mengirim `SIGKILL` di tengah drain, dan seluruh kerapihan yang Anda tulis tidak pernah terpakai. Timeout aplikasi WAJIB lebih kecil, dengan margin.
- **Langsung memanggil `Shutdown()` begitu menerima SIGTERM.** Endpoint pod masih terdaftar di Service selama beberapa detik; permintaan yang sedang dalam perjalanan akan menabrak listener yang sudah tutup. Tandai tidak-siap dulu, tunggu, baru shutdown.
- **`wg.Wait()` tanpa batas waktu.** Satu goroutine yang tidak pernah selesai membuat shutdown menggantung sampai `SIGKILL` — dan seluruh proses drain menjadi teater.
- **Graceful shutdown untuk pekerjaan yang lebih lama dari grace period.** Job satu jam tidak bisa "diselesaikan dengan rapi" dalam 30 detik. Yang dibutuhkan checkpoint dan idempotency, bukan drain yang lebih panjang.
- **Mengandalkan drain untuk menjaga konsistensi.** Pod bisa mati karena OOM, node hilang, atau kernel panic — tanpa SIGTERM sama sekali. Kebenaran harus dijamin desain, bukan oleh shutdown yang sopan.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| `502`/`504` melonjak tepat saat rollout | urutan tandai-tidak-siap vs shutdown | Listener ditutup sebelum endpoint dilepas dari Service |
| Pod berakhir dengan `SIGKILL` | timeout aplikasi vs grace period | Aplikasi butuh lebih lama daripada yang diizinkan |
| Deploy menggantung sampai batas waktu | goroutine yang tersisa saat drain | Ada yang tidak mendengarkan sinyal berhenti |
| Pekerjaan hilang setiap deploy | apakah ada checkpoint | Job panjang diandalkan selesai dalam grace period |
| Koneksi database tertinggal terbuka | urutan penutupan sumber daya | Pool ditutup sebelum permintaan terakhir selesai |

```bash
kubectl get pod <pod> -o jsonpath='{.spec.terminationGracePeriodSeconds}'

# Pod yang benar-benar di-SIGKILL
kubectl get events --field-selector reason=Killing --sort-by=.lastTimestamp | tail

# Galat gateway saat rollout -- bandingkan jendela waktunya dengan waktu deploy
kubectl logs -l app=ingress --since=30m | grep -cE ' 50[234] '

# Berapa lama dari SIGTERM sampai proses benar-benar keluar
kubectl logs <pod> --previous | grep -iE 'sigterm|shutdown'
```
