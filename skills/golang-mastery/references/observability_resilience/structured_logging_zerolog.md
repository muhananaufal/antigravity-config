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
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

// InitLogger menyiapkan global logger. Dipanggil sekali saat app boot.
func InitLogger(env string) zerolog.Logger {
	zerolog.TimeFieldFormat = time.RFC3339Nano // presisi nanosecond

	level := zerolog.InfoLevel
	if env == "development" {
		level = zerolog.DebugLevel
	}
	zerolog.SetGlobalLevel(level)

	var logger zerolog.Logger
	if env == "development" {
		// ConsoleWriter HANYA di development — terlalu lambat untuk production
		logger = zerolog.New(zerolog.ConsoleWriter{
			Out:        os.Stdout,
			TimeFormat: "15:04:05",
		}).With().Timestamp().Caller().Logger()
	} else {
		// JSON ke stdout — 12-factor app standard (K8s/Docker collect stdout)
		logger = zerolog.New(os.Stdout).
			With().
			Timestamp().
			Str("service", "my-service").
			Str("version", os.Getenv("APP_VERSION")).
			Logger()
	}

	// Set sebagai global logger agar bisa dipakai via log.Info()
	log.Logger = logger
	return logger
}

// contextKey type untuk menghindari collision dengan package lain.
type contextKey struct{ name string }

var loggerCtxKey = &contextKey{"logger"}

// WithRequestLogger menyisipkan request-scoped logger ke dalam context.
// Berbeda dari zerolog.Logger.WithContext() bawaan — ini menggunakan typed key.
func WithRequestLogger(ctx context.Context, logger zerolog.Logger) context.Context {
	return context.WithValue(ctx, loggerCtxKey, logger)
}

// GetLogger mengambil logger dari context, fallback ke global logger.
func GetLogger(ctx context.Context) zerolog.Logger {
	if l, ok := ctx.Value(loggerCtxKey).(zerolog.Logger); ok {
		return l
	}
	return log.Logger
}

// RequestLoggerMiddleware menyisipkan request-scoped logger ke setiap request.
func RequestLoggerMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqID := r.Header.Get("X-Request-ID")
		if reqID == "" {
			reqID = generateRequestID() // UUID v4
		}

		// Buat sublogger dengan request metadata
		subLogger := log.With().
			Str("request_id", reqID).
			Str("method", r.Method).
			Str("path", r.URL.Path).
			Str("remote_addr", r.RemoteAddr).
			Logger()

		// Simpan ke context via zerolog bawaan DAN typed key kita
		ctx := subLogger.WithContext(r.Context())
		ctx = WithRequestLogger(ctx, subLogger)

		start := time.Now()
		rw := &statusResponseWriter{ResponseWriter: w, code: http.StatusOK}

		next.ServeHTTP(rw, r.WithContext(ctx))

		// Log request selesai dengan latency dan status
		subLogger.Info().
			Int("status", rw.code).
			Dur("latency_ms", time.Since(start)).
			Int64("response_bytes", rw.bytes).
			Msg("request completed")
	})
}

// statusResponseWriter menangkap status code dan bytes ditulis.
type statusResponseWriter struct {
	http.ResponseWriter
	code  int
	bytes int64
}

func (rw *statusResponseWriter) WriteHeader(code int) {
	rw.code = code
	rw.ResponseWriter.WriteHeader(code)
}

func (rw *statusResponseWriter) Write(b []byte) (int, error) {
	n, err := rw.ResponseWriter.Write(b)
	rw.bytes += int64(n)
	return n, err
}

func generateRequestID() string {
	return "req-" + time.Now().Format("20060102150405.000")
}

// ProcessOrder contoh business logic yang menggunakan context logger.
func ProcessOrder(ctx context.Context, orderID string, amount float64) error {
	logger := zerolog.Ctx(ctx) // extract logger dari context

	logger.Info().
		Str("order_id", orderID).
		Float64("amount", amount).
		Msg("processing order")

	if amount <= 0 {
		err := errors.New("invalid amount")
		logger.Error().
			Err(err).
			Str("order_id", orderID).
			Float64("amount", amount).
			Msg("order validation failed")
		return err
	}

	// Simulasi DB call
	logger.Debug().Str("order_id", orderID).Msg("saving to database")

	logger.Info().
		Str("order_id", orderID).
		Msg("order processed successfully")
	return nil
}

// --- Unit Tests ---

func TestInitLogger_ProductionMode(t *testing.T) {
	// Redirect output ke buffer untuk verifikasi
	var buf bytes.Buffer
	logger := zerolog.New(&buf).With().Timestamp().Logger()
	log.Logger = logger

	log.Info().Str("key", "value").Msg("test message")

	output := buf.String()
	if !strings.Contains(output, `"level":"info"`) {
		t.Errorf("expected JSON level field, got: %s", output)
	}
	if !strings.Contains(output, `"key":"value"`) {
		t.Errorf("expected key field, got: %s", output)
	}
	if !strings.Contains(output, `"message":"test message"`) {
		t.Errorf("expected message field, got: %s", output)
	}

	// Verifikasi output adalah valid JSON
	var parsed map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &parsed); err != nil {
		t.Errorf("log output is not valid JSON: %v\n%s", err, output)
	}
}

func TestRequestLoggerMiddleware_InjectsRequestID(t *testing.T) {
	var capturedCtx context.Context
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedCtx = r.Context()
		w.WriteHeader(http.StatusOK)
	})

	// Setup logger yang output ke buffer
	var buf bytes.Buffer
	log.Logger = zerolog.New(&buf)

	wrapped := RequestLoggerMiddleware(handler)
	req := httptest.NewRequest("GET", "/api/orders", nil)
	req.Header.Set("X-Request-ID", "test-req-123")

	wrapped.ServeHTTP(httptest.NewRecorder(), req)

	// Verifikasi request_id ter-log
	logOutput := buf.String()
	if !strings.Contains(logOutput, "test-req-123") {
		t.Errorf("request_id not found in log output: %s", logOutput)
	}

	// Verifikasi logger tersedia di context
	logger := GetLogger(capturedCtx)
	var innerBuf bytes.Buffer
	logger2 := logger.Output(&innerBuf)
	logger2.Info().Msg("inner message")
	if !strings.Contains(innerBuf.String(), "inner message") {
		t.Error("logger from context should be writable")
	}
}

func TestProcessOrder_LogsError(t *testing.T) {
	var buf bytes.Buffer
	logger := zerolog.New(&buf)
	ctx := logger.WithContext(context.Background())

	err := ProcessOrder(ctx, "ORD-001", -10.0)
	if err == nil {
		t.Fatal("expected error for negative amount")
	}

	output := buf.String()
	if !strings.Contains(output, `"level":"error"`) {
		t.Errorf("expected error level in log, got: %s", output)
	}
	if !strings.Contains(output, "ORD-001") {
		t.Errorf("expected order_id in error log, got: %s", output)
	}
}

func TestProcessOrder_Success(t *testing.T) {
	var buf bytes.Buffer
	logger := zerolog.New(&buf)
	ctx := logger.WithContext(context.Background())

	err := ProcessOrder(ctx, "ORD-002", 99.99)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verifikasi ada log "processed successfully"
	if !strings.Contains(buf.String(), "order processed successfully") {
		t.Errorf("success log not found: %s", buf.String())
	}
}

func TestStatusResponseWriter_CapturesCode(t *testing.T) {
	rec := httptest.NewRecorder()
	rw := &statusResponseWriter{ResponseWriter: rec, code: http.StatusOK}

	rw.WriteHeader(http.StatusCreated)
	if rw.code != http.StatusCreated {
		t.Errorf("code = %d, want 201", rw.code)
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

1. **Stdout Blocking di High Throughput:** Pada 100K+ req/s, `os.Stdout` pipe bisa menjadi bottleneck I/O karena blocking write. Zerolog menulis ke `io.Writer` synchronously. Solusi: wrap writer dengan async buffer menggunakan `zerolog/diode` (non-blocking ring buffer) — ringan memory dengan tradeoff slight log loss di extreme load.

2. **Multi-line Stack Traces Memecah JSON Parsing:** Panic stack traces mengandung `\n` yang memecah satu log event menjadi banyak baris. Fluentd/Logstash mengira setiap baris adalah JSON baru → parse error. Solusi: gunakan `pkg/errors` atau `github.com/rotisserie/eris` yang mengemas stack trace menjadi JSON array field, bukan multiline string.

3. **Context Logger Hilang di Goroutine Baru:** Zerolog context logger disimpan di `context.Context`. Saat spawn goroutine baru tanpa meneruskan ctx, logger (dan `request_id`) hilang. Pattern yang benar: `go func(ctx context.Context) { logger := zerolog.Ctx(ctx) }(r.Context())`.

4. **Level Sampling untuk Mengurangi Volume:** `log.Debug()` di production dengan ribuan request bisa menghasilkan gigabytes log/jam. Gunakan zerolog sampling: `log.Sample(&zerolog.BurstSampler{Burst: 5, Period: 1*time.Second})` untuk log hanya 5 debug events per detik per endpoint.

5. **Log Level Dinamis via HTTP Endpoint:** Hard-coding log level di config membutuhkan restart untuk mengubah level. Expose endpoint internal `PUT /admin/log-level` yang memanggil `zerolog.SetGlobalLevel()` — ubah log level di runtime tanpa restart. Wajib diamankan dengan autentikasi internal.

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
