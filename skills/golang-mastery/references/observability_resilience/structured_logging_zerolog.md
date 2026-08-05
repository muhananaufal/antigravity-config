# Structured Logging dengan Zerolog

> **Berlaku:** Go 1.21+ · `rs/zerolog` · alternatif pustaka standar `log/slog` (Go 1.21+) · **Lihat juga:** `observability_resilience/opentelemetry_tracing.md` · `observability_resilience/prometheus_metrics_red.md` · `observability_resilience/distributed_tracing_baggage.md` · `engineering_practice/incident_postmortem.md`

`rs/zerolog` adalah logger Go dengan zero-allocation design — tidak menciptakan heap garbage saat menulis log level di atas threshold. Kecepatan 10–100× lebih cepat dari `log.Printf`. Structured logging (JSON) membuat log bisa di-query seperti database di Datadog/Elasticsearch.

---

## 1. Arsitektur Internal Zerolog

```
Zerolog Zero-Allocation Design:
                                                          
  logger.Info()                                           
      │ → returns Event (stack-allocated if level disabled)
      │                                                   
  .Str("req_id", id)                                      
      │ → append key-value ke internal []byte buffer      
      │   (TIDAK menggunakan fmt.Sprintf → zero alloc)   
      │                                                   
  .Msg("Order placed")                                    
      │ → flush buffer ke io.Writer (os.Stdout)           
      │ → release buffer ke sync.Pool                     
      ▼                                                   
  {"level":"info","req_id":"A-123","message":"Order placed","time":"..."}
                                                          
Jika Level DISABLED (misal: Debug di production):        
  logger.Debug() → return zerolog.Discard                
  → semua .Str()/.Int() adalah no-op (zero cost!)        
                                                          
Context Propagation:                                      
  subLogger := log.With().Str("req_id", id).Logger()    
  ctx = subLogger.WithContext(ctx)          // store in ctx
  zerolog.Ctx(ctx).Info().Msg("...")        // retrieve from ctx
```

**Kenapa Structured > Unstructured:**

| Aspek | `log.Printf("user %s error: %v", id, err)` | `log.Error().Str("user_id", id).Err(err)` |
|---|---|---|
| Query di Datadog | `text: "user * error"` (regex lambat) | `user_id:alice AND level:error` (indexed fast) |
| Heap allocation | `fmt.Sprintf` = 1+ alloc | 0 alloc (buffer reuse) |
| Parsing otomatis | Manual regex | JSON → auto-indexed |

---

## Diagram ASCII

```text
   KENAPA ZEROLOG NOL ALOKASI -- dan kapan itu batal

   log.Info().Str("k","v").Int("n",1).Msg("pesan")
        |         |            |          |
        |         |            |          `-- serialisasi & tulis, lalu
        |         |            |              buffer DIKEMBALIKAN ke pool
        |         |            `-- append ke buffer byte, tanpa alokasi
        |         `-- append langsung sebagai JSON, tanpa refleksi
        `-- ambil Event dari sync.Pool

   YANG MEMBATALKANNYA:
     .Msgf("%s gagal", nama)        -> fmt.Sprintf mengalokasikan
     .Interface("obj", struct{}{})  -> refleksi mengalokasikan
     lupa .Msg()/.Send()            -> Event TIDAK kembali ke pool  (bocor)

   ---------------------------------------------------------------

   LEVEL SEBAGAI GERBANG BIAYA

   log.Debug().Str("besar", hitungMahal()).Msg("x")
                    ^^^^^^^^^^^^^^^^^^^^
        hitungMahal() TETAP DIPANGGIL walau level Debug mati.
        Gerbang level hanya melewatkan PENULISAN, bukan argumennya.

   Yang benar:
     if e := log.Debug(); e.Enabled() { e.Str("besar", hitungMahal()).Msg("x") }

   ---------------------------------------------------------------

   JALUR LOG DI PRODUKSI -- di mana biayanya muncul

   aplikasi --> stdout --> runtime container --> agen --> penyimpanan
      ~1us       buffer        rotasi berkas    jaringan    $/GB/bulan
                                                            ^^^^^^^^^^
   Biaya terbesar observabilitas di banyak tim ada di ujung kanan,
   dan yang menentukannya adalah keputusan di ujung KIRI:
   level yang aktif dan berapa field per baris.
```

## 2. Kode Go Production-Ready

```go
package observability

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"go.opentelemetry.io/otel/trace"
)

const maxRequestIDLength = 64

// InitLogger menyiapkan global logger. Dipanggil sekali saat app boot.
//
// keluaran dijadikan parameter (produksi: os.Stdout) supaya fungsi ini
// benar-benar bisa diuji. Versi lama menulis langsung ke os.Stdout, dan
// akibatnya uji yang bernama TestInitLogger_ProductionMode tidak pernah
// memanggil InitLogger sama sekali — ia membangun logger-nya sendiri.
func InitLogger(env string, output io.Writer) zerolog.Logger {
	zerolog.TimeFieldFormat = time.RFC3339Nano

	// Disetel EKSPLISIT. Keduanya variabel global: bila ada pustaka lain yang
	// mengubahnya, field bernama "latency_ms" diam-diam berisi detik, dan
	// tidak ada yang menyadarinya sampai grafik latensi terlihat ganjil.
	zerolog.DurationFieldUnit = time.Millisecond
	zerolog.DurationFieldInteger = false

	level := zerolog.InfoLevel
	if env == "development" {
		level = zerolog.DebugLevel
	}
	zerolog.SetGlobalLevel(level)

	var logger zerolog.Logger
	if env == "development" {
		// ConsoleWriter HANYA di development — terlalu lambat untuk produksi.
		logger = zerolog.New(zerolog.ConsoleWriter{Out: output, TimeFormat: "15:04:05"}).
			With().Timestamp().Caller().Logger()
	} else {
		// JSON ke stdout — standar 12-factor (K8s/Docker mengumpulkan stdout).
		logger = zerolog.New(output).With().
			Timestamp().
			Str("service", "my-service").
			Str("version", os.Getenv("APP_VERSION")).
			Logger()
	}

	log.Logger = logger

	// WAJIB, dan hampir selalu terlewat.
	//
	// Tanpa baris ini, zerolog.Ctx(ctx) pada context yang belum disisipi
	// logger mengembalikan logger YANG DINONAKTIFKAN — bukan nil, bukan
	// panic, melainkan objek sah yang membuang seluruh log tanpa suara. Satu
	// jalur kode yang lupa meneruskan context cukup untuk melenyapkan semua
	// lognya, dan satu-satunya gejala adalah sunyi.
	zerolog.DefaultContextLogger = &logger

	return logger
}

// LoggerDari mengambil logger dari context.
//
// Hanya ADA SATU mekanisme di berkas ini, dan itu disengaja. Versi lama
// menyediakan dua sekaligus — typed key buatan sendiri DAN mekanisme bawaan
// zerolog — dengan perilaku fallback yang BERBEDA: yang satu jatuh ke logger
// global, yang lain diam-diam menonaktifkan diri. Dua mekanisme yang gagal
// secara berbeda lebih buruk daripada satu, karena pemanggil tidak punya cara
// mengetahui mana yang sedang ia pakai.
func LoggerFrom(ctx context.Context) *zerolog.Logger { return zerolog.Ctx(ctx) }

// RequestLoggerMiddleware menyisipkan request-scoped logger ke setiap request.
func RequestLoggerMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		binding := log.With().
			Str("request_id", cleanRequestID(r.Header.Get("X-Request-ID"))).
			Str("method", r.Method).
			Str("path", r.URL.Path).
			Str("remote_addr", r.RemoteAddr)

		// Tanpa dua field ini, log dan trace hidup di dua dunia terpisah:
		// Anda menemukan trace yang lambat lalu tidak punya cara menemukan
		// lognya, dan sebaliknya. Tabel deteksi di bawah mengukur persis ini.
		if sc := trace.SpanContextFromContext(r.Context()); sc.IsValid() {
			binding = binding.
				Str("trace_id", sc.TraceID().String()).
				Str("span_id", sc.SpanID().String())
		}
		subLogger := binding.Logger()

		ctx := subLogger.WithContext(r.Context())
		mulai := time.Now()
		rw := &penulisStatus{ResponseWriter: w, kode: http.StatusOK}

		next.ServeHTTP(rw, r.WithContext(ctx))

		// Level MENGIKUTI hasil. Versi lama mencatat semuanya sebagai Info,
		// sehingga query `level:error` tidak pernah menemukan satu pun 5xx —
		// dan alert apa pun yang dibangun di atas level log tidak berbunyi.
		ev := subLogger.Info()
		switch {
		case rw.kode >= 500:
			ev = subLogger.Error()
		case rw.kode >= 400:
			ev = subLogger.Warn()
		}
		ev.Int("status", rw.kode).
			Dur("latency_ms", time.Since(mulai)).
			Int64("response_bytes", rw.bita).
			Msg("request completed")
	})
}

// requestIDBersih memvalidasi X-Request-ID kiriman klien.
//
// Header itu ditulis pengirim dan panjangnya tidak dibatasi siapa pun.
// zerolog memang meng-escape isinya dengan benar, jadi struktur JSON tidak
// bisa dirusak — tetapi nilai 1 MB akan disalin ke SETIAP baris log
// permintaan itu, dan volume log adalah biaya observabilitas terbesar di
// banyak tim. Nilai sembarang juga mencemari indeks agregator log.
func cleanRequestID(dariKlien string) string {
	if dariKlien == "" || len(dariKlien) > maxRequestIDLength {
		return newRequestID()
	}
	for i := 0; i < len(dariKlien); i++ {
		c := dariKlien[i]
		valid := c == '-' || c == '_' ||
			(c >= '0' && c <= '9') ||
			(c >= 'a' && c <= 'z') ||
			(c >= 'A' && c <= 'Z')
		if !valid {
			return newRequestID()
		}
	}
	return dariKlien
}

// requestIDBaru menghasilkan 128 bit acak.
//
// Versi lama memakai `"req-" + time.Now().Format("20060102150405.000")`
// dengan komentar `// UUID v4` di tempat pemanggilannya. Itu stempel waktu
// MILIDETIK: dua permintaan bersamaan dalam milidetik yang sama mendapat ID
// yang SAMA. Pada trafik nyata tabrakan terjadi terus-menerus, dan akibatnya
// persis kebalikan dari tujuan request ID — Anda mencari satu id lalu
// mendapat beberapa permintaan tak berkaitan yang saling berselang-seling.
func newRequestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand yang gagal menandakan sistem bermasalah serius. Jangan
		// diam-diam turun ke sumber acak yang lebih lemah.
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return hex.EncodeToString(b[:])
}

// penulisStatus menangkap kode status dan jumlah bita.
//
// Ia WAJIB meneruskan antarmuka opsional — pembungkus yang hanya menyematkan
// http.ResponseWriter menghilangkan Flusher dan Hijacker, sehingga handler SSE
// tidak pernah bisa flush dan upgrade WebSocket gagal. Middleware ini dipasang
// di SELURUH rute, jadi kerusakannya menyebar tanpa gejala yang jelas.
type penulisStatus struct {
	http.ResponseWriter
	kode    int
	bita    int64
	ditulis bool
}

func (p *penulisStatus) WriteHeader(kode int) {
	if p.ditulis {
		return // WriteHeader kedua diabaikan transport; jangan catat yang salah
	}
	p.kode = kode
	p.ditulis = true
	p.ResponseWriter.WriteHeader(kode)
}

func (p *penulisStatus) Write(b []byte) (int, error) {
	p.ditulis = true // Write tanpa WriteHeader mengirim 200 secara implisit
	n, err := p.ResponseWriter.Write(b)
	p.bita += int64(n)
	return n, err
}

func (p *penulisStatus) Unwrap() http.ResponseWriter { return p.ResponseWriter }

func (p *penulisStatus) Flush() {
	if f, ok := p.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (p *penulisStatus) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := p.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("underlying ResponseWriter does not support Hijack")
	}
	return h.Hijack()
}

// ProsesPesanan contoh business logic yang memakai logger dari context.
func ProcessOrder(ctx context.Context, idPesanan string, jumlahSen int64) error {
	logger := LoggerFrom(ctx)

	logger.Info().
		Str("order_id", idPesanan).
		Int64("amount_minor", jumlahSen). // satuan sen bertipe int64, bukan float64
		Msg("processing order")

	if jumlahSen <= 0 {
		err := errors.New("invalid amount")
		logger.Error().Err(err).
			Str("order_id", idPesanan).
			Int64("amount_minor", jumlahSen).
			Msg("order validation failed")
		return err
	}

	logger.Debug().Str("order_id", idPesanan).Msg("menyimpan ke basis data")
	logger.Info().Str("order_id", idPesanan).Msg("order processed successfully")
	return nil
}
```

```go
package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

// pulihkanGlobal mengembalikan seluruh keadaan global zerolog setelah uji.
// Tanpa ini, uji yang memanggil InitLogger mengubah logger, level, dan
// DefaultContextLogger untuk SEMUA uji berikutnya — dan hasilnya bergantung
// urutan eksekusi.
func pulihkanGlobal(t *testing.T) {
	t.Helper()
	logger, ctxLogger, level := log.Logger, zerolog.DefaultContextLogger, zerolog.GlobalLevel()
	t.Cleanup(func() {
		log.Logger = logger
		zerolog.DefaultContextLogger = ctxLogger
		zerolog.SetGlobalLevel(level)
	})
}

func TestInitLoggerMenghasilkanJSONValid(t *testing.T) {
	pulihkanGlobal(t)

	var buf bytes.Buffer
	logger := InitLogger("production", &buf)
	logger.Info().Str("key", "value").Msg("test message")

	var terurai map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &terurai); err != nil {
		t.Fatalf("keluaran bukan JSON valid: %v\n%s", err, buf.String())
	}
	for _, k := range []string{"level", "time", "service", "message"} {
		if _, ada := terurai[k]; !ada {
			t.Errorf("field %q hilang dari keluaran: %v", k, terurai)
		}
	}
}

// Versi lama menghasilkan ID dari stempel waktu milidetik. Loop ini membuat
// ribuan ID dalam beberapa milidetik — dengan implementasi lama, sebagian
// besar di antaranya identik.
func TestRequestIDTidakPernahTabrakan(t *testing.T) {
	const n = 10_000
	terlihat := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		id := newRequestID()
		if _, ada := terlihat[id]; ada {
			t.Fatalf("request ID bertabrakan setelah %d pembuatan: %q", i, id)
		}
		terlihat[id] = struct{}{}
	}
}

func TestRequestIDKlienDivalidasi(t *testing.T) {
	kasus := []struct {
		nama    string
		input string
		dipakai bool
	}{
		{"wajar", "abc-123_XYZ", true},
		{"empty", "", false},
		{"terlalu panjang", strings.Repeat("a", maxRequestIDLength+1), false},
		{"karakter aneh", "abc\n{\"level\":\"error\"}", false},
	}
	for _, k := range kasus {
		got := cleanRequestID(k.input)
		if dipakai := got == k.input; dipakai != k.dipakai {
			t.Errorf("%s: dipakai=%v, mau %v (hasil %q)", k.nama, dipakai, k.dipakai, got)
		}
	}
}

// Query `level:error` HARUS menemukan 5xx. Versi lama mencatat semuanya
// sebagai info, sehingga alert berbasis level tidak pernah berbunyi.
func TestLevelLogMengikutiStatus(t *testing.T) {
	pulihkanGlobal(t)
	zerolog.SetGlobalLevel(zerolog.DebugLevel)

	for _, k := range []struct {
		kode int
		mau  string
	}{{200, "info"}, {404, "warn"}, {500, "error"}} {
		var buf bytes.Buffer
		log.Logger = zerolog.New(&buf)

		h := RequestLoggerMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(k.kode)
		}))
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))

		var terurai map[string]any
		if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &terurai); err != nil {
			t.Fatalf("status %d: output is not JSON: %v", k.kode, err)
		}
		if terurai["level"] != k.mau {
			t.Errorf("status %d → level %v, want %q", k.kode, terurai["level"], k.mau)
		}
	}
}

func TestLoggerDariContextKosongTetapMenulis(t *testing.T) {
	pulihkanGlobal(t)

	var buf bytes.Buffer
	InitLogger("production", &buf)

	// Context tanpa logger. Tanpa zerolog.DefaultContextLogger, baris berikut
	// tidak menghasilkan APA PUN — logger nonaktif, tanpa galat, tanpa jejak.
	LoggerFrom(context.Background()).Info().Msg("terlihat")

	if !strings.Contains(buf.String(), "terlihat") {
		t.Fatal("log from empty context vanished — zerolog.Ctx returned disabled logger")
	}
}

func TestPenulisStatusMempertahankanFlusher(t *testing.T) {
	pulihkanGlobal(t)
	log.Logger = zerolog.New(io.Discard)

	var bisaFlush bool
	h := RequestLoggerMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, bisaFlush = w.(http.Flusher)
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))

	if !bisaFlush {
		t.Fatal("pembungkus menghilangkan http.Flusher — handler SSE menggantung di buffer")
	}
}

func TestProsesPesananMencatatGalat(t *testing.T) {
	var buf bytes.Buffer
	ctx := zerolog.New(&buf).WithContext(context.Background())

	if err := ProcessOrder(ctx, "ORD-001", -1000); err == nil {
		t.Fatal("want error for negative amount")
	}
	if !strings.Contains(buf.String(), `"level":"error"`) || !strings.Contains(buf.String(), "ORD-001") {
		t.Errorf("error log mismatch: %s", buf.String())
	}
}
```

---

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: `fmt.Sprintf` di Log Message

```go
// BAD: string interpolation = heap allocation + unstructured
log.Info().Msg(fmt.Sprintf("User %s placed order %s for $%.2f", userID, orderID, amount))
// Output: {"message":"User alice placed order ORD-123 for $99.99"}
// Query di Datadog: harus regex → lambat

// GOOD: structured fields — zero alloc, queryable
log.Info().
    Str("user_id", userID).
    Str("order_id", orderID).
    Float64("amount", amount).
    Msg("order placed")
// Query: user_id:alice AND amount:>50
```

**Kenapa berbahaya:** `fmt.Sprintf` membuat string baru di heap setiap call — menghilangkan seluruh keuntungan zero-allocation zerolog. Pada 10,000 req/s, ini menambah GC pressure signifikan. Di sisi observability, string yang digabung tidak bisa di-filter by field di log aggregator.

### ❌ Anti-Pattern 2: `log.Fatal()` di Non-Bootstrap Code

```go
// BAD: Fatal() memanggil os.Exit(1) — tidak ada graceful shutdown!
func processPayment(ctx context.Context, amount float64) {
    if amount > 1000000 {
        log.Fatal().Msg("amount too large") // KILLS entire server immediately!
        // Semua in-flight requests dibunuh paksa
        // DB connections tidak ditutup
        // Metrics tidak di-flush
    }
}

// GOOD: Return error, biarkan caller memutuskan
func processPayment(ctx context.Context, amount float64) error {
    if amount > 1000000 {
        return fmt.Errorf("amount %.2f exceeds limit", amount)
    }
    // ...
}
// Fatal() HANYA di main() saat aplikasi tidak bisa boot sama sekali
```

**Kenapa berbahaya:** `log.Fatal()` di handler atau business logic membunuh seluruh server production secara instan karena satu request buruk. Tidak ada cleanup, tidak ada graceful shutdown. Gunakan `log.Error()` + `return err` untuk runtime errors.

### ❌ Anti-Pattern 3: Log PII atau Credentials

```go
// BAD: Seluruh request body (mengandung password/token) di-log
log.Debug().Interface("request_body", req).Msg("incoming request")
// → NIK, kartu kredit, password tersimpan di Datadog/Elasticsearch
// → Akses semua engineer → GDPR/PCI-DSS violation

// GOOD: Whitelist fields yang aman saja
log.Debug().
    Str("path", req.URL.Path).
    Str("method", req.Method).
    Str("user_id", req.UserID). // hanya ID, bukan data sensitif
    Msg("incoming request")

// Untuk debug body: gunakan sanitizer yang mask sensitive fields
type sanitizedBody struct {
    Email    string `json:"email"`
    Password string `json:"password,omitempty"` // JANGAN log ini!
}
```

**Kenapa berbahaya:** Log dikirim ke third-party (Datadog, Splunk, Elastic Cloud) dan bisa diakses oleh puluhan engineer. Password, token JWT, nomor kartu kredit di log = pelanggaran GDPR Article 32 dan PCI-DSS Requirement 3. Denda bisa mencapai jutaan euro.

---

## 4. Edge Cases & Defensive Programming

1. **Stdout Blocking di High Throughput:** pada 100K+ req/s, pipe `os.Stdout` bisa menjadi bottleneck I/O karena penulisannya blocking. Zerolog menulis ke `io.Writer` secara sinkron. Solusi: bungkus writer dengan buffer asinkron `zerolog/diode` (ring buffer non-blocking) — ringan di memori, dengan tradeoff sedikit log hilang saat beban ekstrem.

6. **Baris log di atas 4 KB bisa TERPOTONG-POTONG antar-goroutine:** di Linux, penulisan ke pipe dijamin atomik hanya sampai `PIPE_BUF` (4096 byte). Karena stdout container adalah pipe, satu baris log yang melampaui batas itu dapat terjalin dengan baris dari goroutine lain — hasilnya JSON rusak yang ditolak parser di agen log, dan **kedua** log itu hilang sekaligus. Ini bukan kasus langka: ia terjadi persis ketika Anda melakukan hal yang dilarang Anti-Pattern 3 (mencatat objek permintaan utuh) atau menyematkan stack trace panjang. Dua pencegahannya: jaga baris tetap kecil, dan bila memang butuh baris besar, tulis lewat satu writer yang diserialkan sendiri (`diode` atau writer ber-mutex) alih-alih mengandalkan atomisitas pipe.

2. **Multi-line Stack Traces Memecah JSON Parsing:** Panic stack traces mengandung `\n` yang memecah satu log event menjadi banyak baris. Fluentd/Logstash mengira setiap baris adalah JSON baru → parse error. Solusi: gunakan `pkg/errors` atau `github.com/rotisserie/eris` yang mengemas stack trace menjadi JSON array field, bukan multiline string.

3. **Context Logger Hilang di Goroutine Baru:** Zerolog context logger disimpan di `context.Context`. Saat spawn goroutine baru tanpa meneruskan ctx, logger (dan `request_id`) hilang. Pattern yang benar: `go func(ctx context.Context) { logger := zerolog.Ctx(ctx) }(r.Context())`.

4. **Level Sampling untuk Mengurangi Volume:** `log.Debug()` di production dengan ribuan request bisa menghasilkan gigabytes log/jam. Gunakan zerolog sampling: `log.Sample(&zerolog.BurstSampler{Burst: 5, Period: 1*time.Second})` untuk log hanya 5 debug events per detik per endpoint.

5. **Log Level Dinamis via HTTP Endpoint:** log level yang dipatok di config menuntut restart untuk diubah — dan restart menghapus keadaan yang sedang Anda selidiki. Sediakan endpoint `PUT /admin/log-level` yang memanggil `zerolog.SetGlobalLevel()` (aman dari race: ia memakai `atomic.StoreInt32`). Dua syarat: pasang di **port internal yang sama dengan probe**, bukan di port API publik — endpoint yang bisa menyalakan `debug` pada layanan produksi adalah tombol amplifikasi biaya sekaligus tombol kebocoran data; dan pasang pengembalian otomatis ke level semula setelah beberapa menit, karena `debug` yang lupa dimatikan setelah investigasi adalah penyebab lonjakan biaya log nomor satu.

## Kapan JANGAN Pakai Ini

- **Log sebagai pengganti metrik.** Menghitung galat dengan `grep` pada log berskala jauh lebih mahal daripada satu counter, tertunda, dan tidak bisa dijadikan dasar alert yang andal.
- **Level `debug` menyala di produksi.** Di banyak tim, volume log adalah biaya observabilitas terbesar — dan `debug` yang lupa dimatikan setelah investigasi adalah penyebab paling umum.
- **`log.Fatal` di luar bootstrap.** Ia memanggil `os.Exit` dan **melewati seluruh `defer`**: koneksi tidak ditutup, transaksi tidak di-rollback, buffer log sendiri tidak sempat di-flush — sehingga pesan yang menjelaskan penyebabnya justru ikut hilang.
- **Mencatat seluruh objek permintaan atau respons.** Di situlah token, nomor kartu, dan data pribadi bocor tanpa disadari. Log biasanya disimpan lebih lama dan diakses lebih banyak orang daripada database.
- **Zerolog bila tim tidak butuh performanya.** `log/slog` di pustaka standar sudah terstruktur, mendukung handler kustom, dan tidak menambah satu pun dependensi. Pilih zerolog karena angka, bukan karena kebiasaan.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Biaya log melonjak tanpa kenaikan trafik | sebaran level log | `debug` menyala di produksi |
| Log tidak bisa dikorelasikan saat insiden | berapa persen punya `trace_id` | Konteks tracing tidak masuk ke log |
| Proses mati tanpa pesan penjelas | ada `log.Fatal` di jalur itu | `os.Exit` melewati flush buffer log |
| Rahasia ditemukan di sistem log | pola nilai, bukan nama field | Objek permintaan dicatat utuh |
| Alert berbasis log sering telat | jalur ingest log | Log tertunda; alert seharusnya di atas metrik |
| Query `level:error` tidak menemukan 5xx | level yang dipakai middleware | Semua permintaan dicatat sebagai `info` |
| Satu `request_id` memuat beberapa permintaan | cara ID dibuat | ID berbasis stempel waktu; tabrakan di bawah beban |
| JSON rusak sporadis di agen log | panjang baris vs `PIPE_BUF` | Baris >4 KB terjalin antar-goroutine |

```bash
# Volume dan sebaran level -- biaya observabilitas biasanya bersembunyi di sini
kubectl logs -l app=api --since=1h | wc -l
kubectl logs -l app=api --since=1h | jq -r .level | sort | uniq -c | sort -rn

# Apakah level debug aktif di produksi?
kubectl get deploy api -o jsonpath='{.spec.template.spec.containers[0].env}' | jq

# Kebocoran rahasia dideteksi dari BENTUK NILAI, bukan dari nama field
kubectl logs -l app=api --since=1h \
  | grep -EC1 'sk_live_|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|eyJ[A-Za-z0-9_-]{10,}\.eyJ' | head

# Log tanpa trace_id tidak bisa dihubungkan ke trace saat insiden
kubectl logs -l app=api --since=10m | jq -r 'select(.trace_id==null) | .msg' | sort | uniq -c | head
```
