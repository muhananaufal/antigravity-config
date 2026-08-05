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
                                                          
  t=0s      SIGTERM diterima                              
  t=0s      Readiness → 503 (sinyal LB berhenti mengirim) 
  t=0–5s    JEDA — endpoint belum lepas dari Service,     
            trafik baru MASIH datang                      
  t=5s      srv.Shutdown(ctx) — berhenti menerima koneksi 
  t=5–25s   drain permintaan aktif + tugas latar (20s)    
  t≤28s     tutup konsumer, flush metrik, tutup pool DB (3s)
  t≤28s     proses keluar                                 
                                                          
  terminationGracePeriodSeconds K8s : 30s                 
  jeda 5 + drain 20 + penutupan 3   = 28s → margin 2s     
                                                          
  Bila total ≥ 30s: SIGKILL datang di tengah drain,       
  dan seluruh urutan di atas tidak pernah selesai.        
```

> Angka di diagram ini, di diagram berikutnya, di kode §2, dan di manifest Kubernetes pada Anti-Pattern 3 adalah **satu himpunan yang sama**. Mengubah salah satunya tanpa yang lain adalah cara paling umum bagaimana graceful shutdown berhenti bekerja tanpa ada yang menyadarinya.

**Kenapa `http.Server.Shutdown()` bekerja:**
- `Shutdown()` memanggil `Listener.Close()` — tidak ada koneksi baru masuk
- Menunggu semua `http.ResponseWriter.Write()` selesai via internal counter
- Koneksi idle (Keep-Alive) langsung ditutup
- Koneksi aktif dibiarkan selesai sampai timeout

---

## Diagram ASCII

```text
   URUTAN SHUTDOWN -- kenapa jeda di awal menentukan segalanya

   t=0     Kubernetes kirim SIGTERM
           DAN mulai melepas endpoint dari Service
           (dua hal ini ASINKRON -- tidak ada jaminan mana duluan)
             |
   t=0      | aplikasi tandai /readyz = NOT READY
             |
   t=0..5s  | JEDA. Endpoint masih terdaftar beberapa detik;
             | trafik baru MASIH datang. Menutup listener di sini
             | menghasilkan 502 di sisi pengguna.
             |
   t=5s     | server.Shutdown(ctx) -- berhenti menerima koneksi BARU,
             | permintaan yang sedang berjalan diselesaikan
             |
   t=5..25s | drain: tunggu permintaan aktif selesai (DENGAN batas waktu)
             |
   t=..28s  | tutup konsumer antrean, flush buffer, tutup pool DB
             |
   t=28s    | proses keluar bersih
             |
   t=30s    Kubernetes kirim SIGKILL  <-- terminationGracePeriodSeconds

   HUBUNGAN YANG WAJIB DIPEGANG:
     jeda + timeout drain + waktu penutupan  <  terminationGracePeriodSeconds
     Bila lebih besar, SIGKILL datang di tengah drain dan seluruh
     kerapihan yang ditulis tidak pernah terpakai.

   ---------------------------------------------------------------

   URUTAN PENUTUPAN SUMBER DAYA -- dari luar ke dalam

   listener HTTP  ditutup PERTAMA  (berhenti menerima pekerjaan baru)
        |
   permintaan aktif  diselesaikan
        |
   konsumer antrean  dihentikan   (jangan ambil pesan baru)
        |
   pool database     ditutup TERAKHIR

   Membalik urutan ini = permintaan yang sedang berjalan kehilangan
   koneksi database di tengah transaksi.
```

## 2. Kode Go Production-Ready

```go
package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// Penutup adalah satu sumber daya yang harus ditutup saat shutdown.
// Urutannya dalam slice menentukan urutan penutupan: dari luar ke dalam,
// pool database TERAKHIR.
type Penutup struct {
	Nama  string
	Tutup func(context.Context) error
}

// Server adalah wrapper http.Server dengan lifecycle management.
type Server struct {
	httpServer *http.Server
	bgTasks    sync.WaitGroup
	sedangMati atomic.Bool
	sekaliMati sync.Once

	jedaTepi     time.Duration // jeda sebelum Shutdown — tunggu endpoint dilepas
	batasDrain   time.Duration // anggaran drain HTTP + tugas latar
	batasPenutup time.Duration // anggaran seluruh Penutup
	penutup      []Penutup
}

// NewServer membuat server production-ready.
//
// Angka di bawah harus dibaca bersama manifest Kubernetes (Anti-Pattern 3):
// jedaTepi 5 + batasDrain 20 + batasPenutup 3 = 28s, di bawah grace period 30s.
func NewServer(addr string, handler http.Handler) *Server {
	s := &Server{
		jedaTepi:     5 * time.Second,
		batasDrain:   20 * time.Second,
		batasPenutup: 3 * time.Second,
	}
	s.httpServer = &http.Server{
		Addr:    addr,
		Handler: handler,
		// ReadTimeout memberi batas pada koneksi yang baru mengirim SEBAGIAN
		// request. Koneksi seperti itu dihitung AKTIF oleh Shutdown, jadi tanpa
		// batas ini satu klien lambat bisa menahan drain sampai habis.
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 20 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
	return s
}

// DaftarkanPenutup menambah sumber daya ke urutan penutupan.
// Panggil sesuai urutan luar-ke-dalam: konsumer antrean dulu, pool DB terakhir.
func (s *Server) DaftarkanPenutup(nama string, tutup func(context.Context) error) {
	s.penutup = append(s.penutup, Penutup{Nama: nama, Tutup: tutup})
}

// IsShuttingDown digunakan oleh Readiness Probe.
func (s *Server) IsShuttingDown() bool { return s.sedangMati.Load() }

// AddBackgroundTask mendaftarkan goroutine background (queue consumer, cron, dll).
// Wajib dipasangkan dengan DoneBackgroundTask() via defer.
func (s *Server) AddBackgroundTask() { s.bgTasks.Add(1) }

// DoneBackgroundTask dipanggil saat background goroutine selesai.
func (s *Server) DoneBackgroundTask() { s.bgTasks.Done() }

// Run menjalankan server dan memblok sampai signal diterima.
func (s *Server) Run() error {
	// Buffer ≥2: satu untuk sinyal pertama, satu untuk katup darurat di bawah.
	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigCh)

	serverErr := make(chan error, 1)
	go func() {
		if err := s.httpServer.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	select {
	case err := <-serverErr:
		return fmt.Errorf("server gagal start: %w", err)
	case sig := <-sigCh:
		slog.Info("shutdown: sinyal diterima", "sinyal", sig.String())
	}

	// Katup darurat. Begitu signal.Notify aktif, perilaku default sinyal sudah
	// diambil alih — tanpa goroutine ini, Ctrl-C KEDUA tidak melakukan apa pun
	// dan operator hanya bisa menunggu drain sampai habis.
	go func() {
		sig := <-sigCh
		slog.Warn("shutdown: sinyal kedua, keluar paksa", "sinyal", sig.String())
		os.Exit(1)
	}()

	return s.shutdown()
}

// shutdown idempoten: Kubernetes kadang mengirim SIGTERM lebih dari sekali.
func (s *Server) shutdown() error {
	var err error
	s.sekaliMati.Do(func() { err = s.jalankanShutdown() })
	return err
}

func (s *Server) jalankanShutdown() error {
	// Tahap 0: tandai tidak siap. WAJIB sebelum jeda — kalau urutannya
	// terbalik, load balancer masih mengirim trafik selama seluruh jeda dan
	// jeda itu jadi tidak ada gunanya sama sekali.
	s.sedangMati.Store(true)
	slog.Info("shutdown: ditandai tidak siap", "readiness", http.StatusServiceUnavailable)

	if s.jedaTepi > 0 {
		slog.Info("shutdown: menunggu endpoint dilepas dari Service", "jeda", s.jedaTepi)
		time.Sleep(s.jedaTepi)
	}

	ctx, cancel := context.WithTimeout(context.Background(), s.batasDrain)
	defer cancel()

	// Galat DIKUMPULKAN, bukan di-return di tempat. Tahap berikutnya justru
	// paling penting dijalankan ketika tahap sebelumnya gagal — di situlah
	// koneksi masih menggantung dan pool DB masih terbuka.
	var galat []error

	// Tahap 1: listener ditutup, permintaan aktif diselesaikan.
	slog.Info("shutdown: mengalirkan koneksi HTTP", "batas", s.batasDrain)
	if err := s.httpServer.Shutdown(ctx); err != nil {
		galat = append(galat, fmt.Errorf("drain HTTP: %w", err))
		// Putuskan paksa sisa koneksi. Tanpa ini, handler yang menggantung
		// tetap memegang koneksi DB dan menahan tahap 3.
		if err := s.httpServer.Close(); err != nil {
			galat = append(galat, fmt.Errorf("tutup paksa listener: %w", err))
		}
	}

	// Tahap 2: konsumer antrean dan cron.
	selesai := make(chan struct{})
	go func() { s.bgTasks.Wait(); close(selesai) }()
	select {
	case <-selesai:
		slog.Info("shutdown: seluruh tugas latar selesai")
	case <-ctx.Done():
		galat = append(galat, fmt.Errorf("tugas latar belum selesai: %w", ctx.Err()))
	}

	// Tahap 3: sumber daya, dari luar ke dalam. Memakai context BARU dengan
	// sengaja: pada titik ini ctx di atas kemungkinan besar sudah kedaluwarsa,
	// dan menutup pool DB adalah hal terakhir yang boleh dilewatkan. Inilah
	// alasan batasPenutup harus ikut dihitung dalam anggaran grace period.
	tutupCtx, batalTutup := context.WithTimeout(context.Background(), s.batasPenutup)
	defer batalTutup()
	for _, p := range s.penutup {
		if err := p.Tutup(tutupCtx); err != nil {
			galat = append(galat, fmt.Errorf("tutup %s: %w", p.Nama, err))
		}
	}

	if len(galat) > 0 {
		return errors.Join(galat...)
	}
	slog.Info("shutdown: selesai bersih")
	return nil
}

```

```go
package lifecycle

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"
	"time"
)

// mulaiServer mengikat listener SEBELUM goroutine dijalankan, sehingga tidak
// ada `time.Sleep` untuk "menunggu server start" — port sudah pasti terbuka
// saat fungsi ini kembali.
//
// Galat Serve dikirim lewat channel, TIDAK dilaporkan langsung dari goroutine.
// Memanggil t.Errorf/t.Fatalf dari goroutine yang masih hidup setelah fungsi
// uji kembali membuat runtime panic ("Log in goroutine after test has
// completed") dan menjatuhkan SELURUH binary uji — kegagalan yang muncul acak
// dan hampir mustahil dilacak balik ke berkas asalnya.
func mulaiServer(t *testing.T, s *Server) (alamat string, serveErr <-chan error) {
	t.Helper()
	ln, err := net.Listen("tcp", "localhost:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	errCh := make(chan error, 1)
	go func() { errCh <- s.httpServer.Serve(ln) }()
	return ln.Addr().String(), errCh
}

func TestShutdown_AlurNormal(t *testing.T) {
	srv := NewServer("localhost:0", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	srv.jedaTepi = 0

	_, serveErr := mulaiServer(t, srv)

	if err := srv.shutdown(); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if err := <-serveErr; !errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("Serve = %v, mau ErrServerClosed", err)
	}
}

// Properti yang diuji: penanda tidak-siap WAJIB menyala SEBELUM jeda tepi
// dimulai. Bila urutannya terbalik, load balancer tetap mengirim trafik selama
// seluruh jeda — dan jeda yang menjadi inti berkas ini kehilangan gunanya.
func TestReadinessDitandaiSebelumJedaTepi(t *testing.T) {
	srv := NewServer("localhost:0", http.NotFoundHandler())
	srv.jedaTepi = 300 * time.Millisecond

	if srv.IsShuttingDown() {
		t.Fatal("belum boleh ditandai mati sebelum shutdown")
	}

	_, serveErr := mulaiServer(t, srv)
	shutdownErr := make(chan error, 1)
	go func() { shutdownErr <- srv.shutdown() }()

	// Tenggat sengaja di DALAM jeda tepi: kalau penanda baru menyala setelah
	// jeda selesai, uji ini gagal.
	tenggat := time.After(200 * time.Millisecond)
	for !srv.IsShuttingDown() {
		select {
		case <-tenggat:
			t.Fatal("penanda tidak-siap belum menyala saat jeda tepi masih berjalan")
		default:
			runtime.Gosched()
		}
	}

	if err := <-shutdownErr; err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	<-serveErr
}

func TestShutdown_MenungguTugasLatar(t *testing.T) {
	srv := NewServer("localhost:0", http.NotFoundHandler())
	srv.jedaTepi = 0

	srv.AddBackgroundTask()
	tugasSelesai := make(chan struct{})
	go func() {
		defer srv.DoneBackgroundTask()
		time.Sleep(50 * time.Millisecond)
		close(tugasSelesai)
	}()

	_, serveErr := mulaiServer(t, srv)

	if err := srv.shutdown(); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	select {
	case <-tugasSelesai:
	default:
		t.Error("shutdown kembali sebelum tugas latar selesai")
	}
	<-serveErr
}

// Membuktikan urutan penutupan sumber daya dijalankan dari luar ke dalam,
// dan — yang lebih penting — TETAP dijalankan meski drain HTTP gagal.
func TestPenutupBerjalanMeskiDrainGagal(t *testing.T) {
	blokir := make(chan struct{})
	masuk := make(chan struct{})
	srv := NewServer("localhost:0", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(masuk)
		<-blokir // handler sengaja tidak pernah selesai dalam anggaran drain
	}))
	srv.jedaTepi = 0
	srv.batasDrain = 100 * time.Millisecond

	var urutan []string
	srv.DaftarkanPenutup("konsumer", func(context.Context) error {
		urutan = append(urutan, "konsumer")
		return nil
	})
	srv.DaftarkanPenutup("pool-db", func(context.Context) error {
		urutan = append(urutan, "pool-db")
		return nil
	})

	alamat, serveErr := mulaiServer(t, srv)

	go func() { _, _ = http.Get("http://" + alamat) }()
	<-masuk // handler yang memblokir sudah benar-benar berjalan

	err := srv.shutdown()
	close(blokir)

	// Drain WAJIB melaporkan galat, karena handler tidak akan pernah selesai
	// di dalam batasDrain 100ms.
	if err == nil {
		t.Fatal("drain seharusnya gagal karena handler memblokir")
	}
	// Tetapi urutan penutupan HARUS tetap berjalan lengkap. Versi lama
	// berkas ini `return` begitu drain gagal, sehingga pool DB TIDAK PERNAH
	// ditutup persis pada jalur yang paling membutuhkannya.
	if len(urutan) != 2 || urutan[0] != "konsumer" || urutan[1] != "pool-db" {
		t.Fatalf("urutan penutup = %v, mau [konsumer pool-db]", urutan)
	}
	<-serveErr
}

func TestShutdown_PermintaanBerjalanDiselesaikan(t *testing.T) {
	masuk := make(chan struct{})
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(masuk) // deterministik: handler benar-benar sudah berjalan
		time.Sleep(100 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("selesai"))
	}))
	defer ts.Close()

	type hasil struct {
		kode int
		body string
		err  error
	}
	hasilCh := make(chan hasil, 1)
	go func() {
		resp, err := ts.Client().Get(ts.URL + "/lambat")
		if err != nil {
			hasilCh <- hasil{err: err}
			return
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		hasilCh <- hasil{kode: resp.StatusCode, body: string(b), err: err}
	}()

	<-masuk // menggantikan time.Sleep(10ms) yang menebak-nebak

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := ts.Config.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	// Yang diuji bukan "handler sempat selesai", melainkan KLIEN benar-benar
	// menerima responsnya. Shutdown yang menjatuhkan respons setelah handler
	// kembali tetap lolos versi lama uji ini.
	h := <-hasilCh
	if h.err != nil {
		t.Fatalf("klien: %v", h.err)
	}
	if h.kode != http.StatusOK || h.body != "selesai" {
		t.Fatalf("klien menerima %d %q, mau 200 %q", h.kode, h.body, "selesai")
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
srv.Shutdown(ctx) // endpoint belum lepas dari Service → HTTP 502

// GOOD: tandai tidak siap, beri jeda, baru tutup listener
<-sigChan
s.sedangMati.Store(true)    // readiness probe → 503 segera
time.Sleep(5 * time.Second) // tunggu endpoint dilepas
srv.Shutdown(ctx)
```

**Kenapa berbahaya:** kubelet mengirim SIGTERM **bersamaan** dengan endpoint controller melepas Pod dari `Endpoints`/`EndpointSlice`. Keduanya asinkron dan tidak ada jaminan mana lebih dulu; pelepasan itu sendiri masih harus menyebar ke setiap kube-proxy dan setiap ingress controller di klaster. Selama penyebaran itu, trafik baru terus datang ke Pod yang listener-nya sudah tertutup → `502` bagi pengguna.

**Yang lebih sering luput: probe kesiapan Anda mungkin lebih lambat dari seluruh grace period.**

```yaml
# Bagian Kubernetes yang WAJIB cocok dengan angka di kode §2.
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      # Anggaran total. SELURUH urutan shutdown harus muat di sini.
      terminationGracePeriodSeconds: 30
      containers:
        - name: api
          lifecycle:
            preStop:
              exec:
                # Alternatif yang lebih rapi dari jeda di dalam aplikasi:
                # preStop berjalan SEBELUM SIGTERM dikirim, jadi aplikasi tidak
                # perlu tahu apa-apa soal jeda.
                #
                # JEBAKAN: durasi preStop DIPOTONG dari terminationGracePeriod
                # yang sama — 5 detik di sini menyisakan 25 detik, bukan 30.
                # Kalau memakai ini, set jedaTepi=0 di aplikasi agar tidak
                # terhitung dua kali.
                command: ["sleep", "5"]
          readinessProbe:
            httpGet: { path: /readyz, port: 9090 }
            periodSeconds: 2
            timeoutSeconds: 1
            # failureThreshold × periodSeconds = berapa lama sampai endpoint
            # benar-benar dilepas: 2 × 2 = 4 detik, DI BAWAH jedaTepi 5 detik.
            # Bawaan 3 × 10 = 30 detik LEBIH LAMA dari seluruh grace period,
            # sehingga Pod mati sebelum sempat ditandai tidak siap dan jeda di
            # aplikasi tidak menghasilkan apa-apa.
            failureThreshold: 2
          livenessProbe:
            # WAJIB tetap 200 selama drain. Liveness yang ikut 503 saat
            # shutdown membuat kubelet me-restart container di tengah drain —
            # lihat Anti-Pattern 4 di health_check_readiness.md.
            httpGet: { path: /livez, port: 9090 }
            periodSeconds: 10
            failureThreshold: 3
```

---

## 4. Edge Cases & Defensive Programming

1. **Apa yang benar-benar menahan `Shutdown()` — dan apa yang tidak:** koneksi Keep-Alive yang **menganggur** TIDAK menahan shutdown. `Shutdown` menutupnya seketika, jadi `IdleTimeout` sama sekali tidak memengaruhi durasi shutdown; menyetelnya "lebih ketat" sebagai obat adalah salah sasaran. Yang benar-benar menahan hanya tiga hal: **(a)** handler yang masih berjalan, **(b)** koneksi yang sudah mengirim sebagian request dan dihitung aktif — inilah alasan `ReadTimeout` wajib ada, karena satu klien lambat bisa menahan drain sampai anggaran habis, dan **(c)** koneksi yang di-hijack (lihat butir 2). Batas atas sesungguhnya untuk satu request adalah `WriteTimeout`, bukan `IdleTimeout`.

2. **WebSocket & Long-Polling Tidak Di-drain oleh `Shutdown()`:** `http.Server.Shutdown()` hanya menunggu standar HTTP requests. WebSocket connections yang sudah di-upgrade tidak dihitung. Solusi: track WebSocket connections manual dengan sync.Map, kirim close frame ke semua connection saat SIGTERM, tunggu semua close via WaitGroup.

3. **`signal.Notify` Buffer Wajib ≥1:** `make(chan os.Signal, 0)` adalah unbuffered channel. Jika goroutine penerima belum siap tepat saat signal diterima, signal hilang diam-diam. Selalu gunakan buffered channel `make(chan os.Signal, 1)`.

4. **Sinyal kedua butuh DUA hal, bukan satu:** `sync.Once` membuat urutan shutdown tidak berjalan dua kali — itu perlu, tapi tidak cukup. Begitu `signal.Notify` dipasang, perilaku default sinyal **diambil alih Go**: `Ctrl-C` kedua tidak lagi mematikan proses, ia hanya masuk ke channel yang tidak ada yang membacanya. Operator yang sudah tidak mau menunggu drain 20 detik menekan `Ctrl-C` berkali-kali dan tidak terjadi apa-apa. Karena itu `Run()` di §2 memasang **katup darurat**: satu goroutine yang membaca sinyal berikutnya dan langsung `os.Exit(1)`. Idempotensi menjaga kebenaran; katup darurat menjaga kewarasan orang yang sedang menangani insiden.

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
