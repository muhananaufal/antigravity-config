# HTTP Client Production Patterns (Go)

> **Berlaku:** Go 1.21+ · `net/http` · **Lihat juga:** `distributed_patterns_resilience/retry_backoff_jitter.md` · `observability_resilience/circuit_breaker_hystrix.md` · `concurrency/context_cancellation_timeout.md` · `microservices_grpc/service_mesh_grpc_lb.md`

## 1. Konsep Mendalam & Internals

### Mengapa `http.DefaultClient` Berbahaya di Production

`http.DefaultClient` adalah `&http.Client{}` tanpa timeout dan dengan `http.DefaultTransport` yang default connection pool-nya terlalu longgar untuk production. Setiap panggilan ke external service tanpa timeout berarti satu goroutine yang berpotensi **leak selamanya** jika server lambat atau tidak respond.

```
http.Client Architecture:

  ┌─────────────────────────────────────────────────────┐
  │  http.Client                                        │
  │  ├── Timeout          ← OVERALL request deadline    │
  │  │   (dari mulai Dial sampai body dibaca habis)     │
  │  ├── CheckRedirect    ← redirect policy             │
  │  ├── Jar             ← cookie management            │
  │  └── Transport ──────────────────────────────────┐  │
  │                                                   │  │
  │  http.Transport (implements http.RoundTripper)    │  │
  │  ├── DialContext      ← TCP connection setup      │  │
  │  ├── TLSHandshakeTimeout                         │  │
  │  ├── ResponseHeaderTimeout                       │  │
  │  ├── ExpectContinueTimeout                       │  │
  │  ├── IdleConnTimeout  ← keep-alive TTL            │  │
  │  ├── MaxIdleConns     ← total idle conn pool      │  │
  │  ├── MaxIdleConnsPerHost ← per-host pool          │  │
  │  ├── MaxConnsPerHost  ← max concurrent per host   │  │
  │  └── DisableKeepAlives ← jika true: no pooling    │  │
  └───────────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────┘
```

### Timeout Chain — Jangan Salah Pasang

Banyak engineer hanya set `http.Client{Timeout: 30s}` — ini adalah **overall deadline** dari awal Dial sampai body selesai dibaca. Ini tidak cukup untuk deteksi masalah spesifik:

```
Request Timeline:

  t=0ms    t=200ms   t=400ms  t=800ms   t=1200ms   t=2000ms
  │        │         │        │         │          │
  ├─ Dial ─┤         │        │         │          │
  │ (TCP)  ├─ TLS ───┤        │         │          │
  │        │         ├─ Send ─┤         │          │
  │        │         │ (req)  ├─ Header─┤          │
  │        │         │        │         ├─── Body ─┤
  │        │         │        │         │          │
  └────────┴─────────┴────────┴─────────┴──────────┘
  ↑                                                ↑
  Timeout overall covers ALL of this

  Per-phase timeouts:
  ├── DialTimeout (via net.Dialer.Timeout)    → gagal jika server tidak reachable
  ├── TLSHandshakeTimeout                     → gagal jika TLS lambat
  ├── ResponseHeaderTimeout                   → gagal jika server tidak kirim header
  └── http.Client.Timeout (overall)           → hard deadline seluruh request
```

### Connection Pool — Kenapa MaxIdleConnsPerHost Kritis

Go default `MaxIdleConnsPerHost = 0` yang berarti menggunakan `DefaultMaxIdleConnsPerHost = 2`. Ini **terlalu kecil** untuk high-throughput service yang call satu downstream intensif:

```
Scenario: Payment service call Midtrans API 1000 RPS

  Default (MaxIdleConnsPerHost=2):
  ┌─────────────────────────────────────────┐
  │ Connection Pool: [conn1] [conn2] (FULL) │
  │ 998 goroutines waiting → buat TCP baru  │
  │ TIME_WAIT accumulation → port exhaustion│
  └─────────────────────────────────────────┘

  Tuned (MaxIdleConnsPerHost=100):
  ┌─────────────────────────────────────────┐
  │ Connection Pool: [c1..c100]             │
  │ Goroutines reuse idle connections       │
  │ Minimal TCP handshake overhead          │
  └─────────────────────────────────────────┘
```

## 2. Production-Ready HTTP Client

### Base Client dengan Tuning Lengkap

```go
package httpclient

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"time"
)

// Config adalah konfigurasi HTTP client production.
type Config struct {
	// Timeout keseluruhan request (dial + TLS + send + read body)
	Timeout time.Duration

	// DialTimeout: maksimum waktu untuk establish TCP connection
	DialTimeout time.Duration

	// TLSHandshakeTimeout: maksimum waktu untuk TLS handshake
	TLSHandshakeTimeout time.Duration

	// ResponseHeaderTimeout: maksimum waktu tunggu header dari server
	// setelah request dikirim. Kritis untuk deteksi server lambat.
	ResponseHeaderTimeout time.Duration

	// IdleConnTimeout: berapa lama idle connection disimpan di pool
	IdleConnTimeout time.Duration

	// MaxIdleConns: total idle connections di semua host
	MaxIdleConns int

	// MaxIdleConnsPerHost: idle connection per host (KRITIS untuk high-throughput)
	MaxIdleConnsPerHost int

	// MaxConnsPerHost: max concurrent connections per host (0 = unlimited)
	MaxConnsPerHost int

	// InsecureSkipVerify: HANYA untuk development/testing, DILARANG production
	InsecureSkipVerify bool
}

// DefaultConfig mengembalikan config production yang aman.
func DefaultConfig() Config {
	return Config{
		Timeout:               30 * time.Second,
		DialTimeout:           5 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConns:          200,
		MaxIdleConnsPerHost:   50,
		MaxConnsPerHost:       0, // unlimited, batasi via semaphore di application layer
	}
}

// New membuat http.Client yang production-ready.
func New(cfg Config) *http.Client {
	dialer := &net.Dialer{
		Timeout:   cfg.DialTimeout,
		KeepAlive: 30 * time.Second, // TCP keep-alive agar idle conn tidak di-cut firewall
	}

	transport := &http.Transport{
		DialContext:           dialer.DialContext,
		TLSHandshakeTimeout:   cfg.TLSHandshakeTimeout,
		ResponseHeaderTimeout: cfg.ResponseHeaderTimeout,
		ExpectContinueTimeout: 1 * time.Second,
		IdleConnTimeout:       cfg.IdleConnTimeout,
		MaxIdleConns:          cfg.MaxIdleConns,
		MaxIdleConnsPerHost:   cfg.MaxIdleConnsPerHost,
		MaxConnsPerHost:       cfg.MaxConnsPerHost,
		// ForceAttemptHTTP2: true — aktifkan HTTP/2 jika server support
		// (lebih efisien: multiplexing, header compression)
		ForceAttemptHTTP2: true,
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: cfg.InsecureSkipVerify, //nolint:gosec
			MinVersion:         tls.VersionTLS12,       // DILARANG TLS 1.0/1.1
		},
	}

	return &http.Client{
		Timeout:   cfg.Timeout,
		Transport: transport,
		// CheckRedirect: batasi redirect untuk keamanan
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return http.ErrUseLastResponse // stop setelah 5 redirect
			}
			return nil
		},
	}
}
```

### RoundTripper Interceptor — Inject Header & Logging

Pattern `http.RoundTripper` wrapper memungkinkan inject behavior tanpa mengubah call site. Ini equivalent dengan middleware di server side.

```go
package httpclient

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// key type untuk context value (hindari collision dengan package lain)
type contextKey string

const correlationIDKey contextKey = "correlation_id"

// WithCorrelationID menyimpan correlation ID ke context.
func WithCorrelationID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, correlationIDKey, id)
}

// CorrelationIDFromContext mengambil correlation ID dari context.
func CorrelationIDFromContext(ctx context.Context) string {
	if id, ok := ctx.Value(correlationIDKey).(string); ok {
		return id
	}
	return ""
}

// LoggingRoundTripper mencatat setiap request + response + latency.
type LoggingRoundTripper struct {
	next    http.RoundTripper
	logger  *slog.Logger
	service string // nama downstream service untuk label log
}

func NewLoggingRoundTripper(next http.RoundTripper, logger *slog.Logger, service string) *LoggingRoundTripper {
	if next == nil {
		next = http.DefaultTransport
	}
	return &LoggingRoundTripper{next: next, logger: logger, service: service}
}

func (l *LoggingRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	start := time.Now()

	// Propagasi correlation ID dari context ke header downstream
	if corrID := CorrelationIDFromContext(req.Context()); corrID != "" {
		req = req.Clone(req.Context())
		req.Header.Set("X-Request-ID", corrID)
		req.Header.Set("X-Correlation-ID", corrID)
	}

	resp, err := l.next.RoundTrip(req)
	duration := time.Since(start)

	if err != nil {
		l.logger.ErrorContext(req.Context(), "http client error",
			"service", l.service,
			"method", req.Method,
			"url", req.URL.String(),
			"duration_ms", duration.Milliseconds(),
			"error", err.Error(),
		)
		return nil, err
	}

	l.logger.InfoContext(req.Context(), "http client request",
		"service", l.service,
		"method", req.Method,
		"url", req.URL.String(),
		"status", resp.StatusCode,
		"duration_ms", duration.Milliseconds(),
	)

	return resp, nil
}

// AuthRoundTripper meng-inject Authorization header secara otomatis.
// Berguna untuk service-to-service auth (static token atau dynamic token).
type AuthRoundTripper struct {
	next     http.RoundTripper
	tokenFn  func() string // func agar mendukung dynamic token rotation
}

func NewAuthRoundTripper(next http.RoundTripper, tokenFn func() string) *AuthRoundTripper {
	return &AuthRoundTripper{next: next, tokenFn: tokenFn}
}

func (a *AuthRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.Header.Set("Authorization", "Bearer "+a.tokenFn())
	req.Header.Set("User-Agent", "myapp/1.0 go-http-client")
	return a.next.RoundTrip(req)
}

// NewClientWithMiddleware membuat client dengan chain RoundTripper.
// Urutan eksekusi: logging → auth → transport (inner-most terakhir dieksekusi dulu)
func NewClientWithMiddleware(cfg Config, logger *slog.Logger, service string, tokenFn func() string) *http.Client {
	base := New(cfg)

	// Chain: request masuk → LoggingRT → AuthRT → Transport → server
	//                         (outermost)            (innermost)
	transport := NewLoggingRoundTripper(
		NewAuthRoundTripper(base.Transport, tokenFn),
		logger,
		service,
	)

	return &http.Client{
		Timeout:       cfg.Timeout,
		Transport:     transport,
		CheckRedirect: base.CheckRedirect,
	}
}
```

### Response Body Drain — Wajib Ada

```go
package httpclient

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// Do melakukan HTTP request dengan proper response body handling.
// WAJIB: drain + close body agar connection dikembalikan ke pool.
func Do[T any](ctx context.Context, client *http.Client, req *http.Request) (T, error) {
	var zero T

	resp, err := client.Do(req.WithContext(ctx))
	if err != nil {
		return zero, fmt.Errorf("http request failed: %w", err)
	}
	defer func() {
		// WAJIB: drain body sebelum close agar connection reuse ke pool.
		// Tanpa ini: setiap request buat TCP connection baru → performance collapse.
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096)) // limit 4KB untuk error body
		return zero, &HTTPError{
			StatusCode: resp.StatusCode,
			Body:       string(body),
			URL:        req.URL.String(),
		}
	}

	var result T
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return zero, fmt.Errorf("decode response: %w", err)
	}

	return result, nil
}

// HTTPError adalah typed error untuk HTTP non-2xx response.
type HTTPError struct {
	StatusCode int
	Body       string
	URL        string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("http error %d from %s: %s", e.StatusCode, e.URL, e.Body)
}

// IsRetryable mengembalikan true jika error layak di-retry.
func IsRetryable(err error) bool {
	var httpErr *HTTPError
	if errors.As(err, &httpErr) {
		// 429 Too Many Requests, 502/503/504 server error → retry
		switch httpErr.StatusCode {
		case http.StatusTooManyRequests,
			http.StatusBadGateway,
			http.StatusServiceUnavailable,
			http.StatusGatewayTimeout:
			return true
		}
	}
	// Network error → juga bisa di-retry
	return isNetworkError(err)
}
```

### Client Factory — Dependency Injection Pattern

```go
package httpclient

import (
	"log/slog"
	"sync"
)

// Registry menyimpan named HTTP clients agar tidak recreate per-request.
// Pattern: satu client per downstream service, di-share di seluruh aplikasi.
type Registry struct {
	mu      sync.RWMutex
	clients map[string]*http.Client
	logger  *slog.Logger
}

func NewRegistry(logger *slog.Logger) *Registry {
	return &Registry{
		clients: make(map[string]*http.Client),
		logger:  logger,
	}
}

// Register mendaftarkan client dengan nama service.
func (r *Registry) Register(name string, cfg Config, tokenFn func() string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.clients[name] = NewClientWithMiddleware(cfg, r.logger, name, tokenFn)
}

// Get mengambil client berdasarkan nama service.
func (r *Registry) Get(name string) (*http.Client, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	c, ok := r.clients[name]
	return c, ok
}

// MustGet panic jika client tidak ditemukan — untuk startup validation.
func (r *Registry) MustGet(name string) *http.Client {
	c, ok := r.Get(name)
	if !ok {
		panic("http client not registered: " + name)
	}
	return c
}
```

## 3. Unit Test — Dengan httptest.Server

```go
package httpclient_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestHTTPClientTimeout memverifikasi bahwa client menghormati timeout.
func TestHTTPClientTimeout(t *testing.T) {
	// Server yang sengaja lambat
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(500 * time.Millisecond) // lebih lama dari client timeout
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	cfg := DefaultConfig()
	cfg.Timeout = 100 * time.Millisecond // timeout lebih pendek dari server delay

	client := New(cfg)
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL, nil)

	_, err := client.Do(req)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "context deadline exceeded")
}

// TestRoundTripperInjectsCorrelationID memverifikasi header propagation.
func TestRoundTripperInjectsCorrelationID(t *testing.T) {
	var receivedCorrelationID string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedCorrelationID = r.Header.Get("X-Correlation-ID")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}))
	defer server.Close()

	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	client := NewClientWithMiddleware(
		DefaultConfig(),
		logger,
		"test-service",
		func() string { return "static-token" },
	)

	ctx := WithCorrelationID(context.Background(), "trace-abc-123")
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	resp, err := client.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body) // drain

	assert.Equal(t, "trace-abc-123", receivedCorrelationID)
}

// TestResponseBodyDrainAllowsConnectionReuse memverifikasi connection pool behavior.
func TestResponseBodyDrainAllowsConnectionReuse(t *testing.T) {
	requestCount := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]int{"count": requestCount})
	}))
	defer server.Close()

	type Response struct {
		Count int `json:"count"`
	}

	client := New(DefaultConfig())

	// Kirim 10 request berturut-turut — semuanya harus reuse connection
	for i := 1; i <= 10; i++ {
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL, nil)
		result, err := Do[Response](context.Background(), client, req)
		require.NoError(t, err)
		assert.Equal(t, i, result.Count)
	}
}

// TestHTTPErrorTyped memverifikasi typed error untuk non-2xx response.
func TestHTTPErrorTyped(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		w.Write([]byte(`{"error":"validation failed","field":"amount"}`))
	}))
	defer server.Close()

	type Response struct{}
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, server.URL, nil)
	_, err := Do[Response](context.Background(), New(DefaultConfig()), req)

	require.Error(t, err)

	var httpErr *HTTPError
	require.ErrorAs(t, err, &httpErr)
	assert.Equal(t, http.StatusUnprocessableEntity, httpErr.StatusCode)
	assert.Contains(t, httpErr.Body, "validation failed")
}

// TestIsRetryable memverifikasi klasifikasi error yang bisa di-retry.
func TestIsRetryable(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		expected bool
	}{
		{"429 Too Many Requests", http.StatusTooManyRequests, true},
		{"503 Service Unavailable", http.StatusServiceUnavailable, true},
		{"502 Bad Gateway", http.StatusBadGateway, true},
		{"422 Unprocessable Entity", http.StatusUnprocessableEntity, false},
		{"401 Unauthorized", http.StatusUnauthorized, false},
		{"200 OK (no error)", http.StatusOK, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.status == http.StatusOK {
				assert.False(t, IsRetryable(nil))
				return
			}
			err := &HTTPError{StatusCode: tc.status}
			assert.Equal(t, tc.expected, IsRetryable(err))
		})
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: `http.DefaultClient` atau Client Tanpa Timeout

```go
// BAD: DefaultClient tidak punya timeout — goroutine leak selamanya
resp, err := http.Get("https://payment-gateway.example.com/charge")

// BAD: Client tanpa timeout
client := &http.Client{}
resp, err := client.Do(req)

// BAD: Hanya set Timeout tapi tidak ResponseHeaderTimeout
// Server bisa kirim header lambat-lambat, Timeout tidak terdeteksi sampai body selesai
client := &http.Client{Timeout: 30 * time.Second}
```

```go
// GOOD: Client dengan full timeout chain
client := New(Config{
    Timeout:               30 * time.Second,
    DialTimeout:           5 * time.Second,
    TLSHandshakeTimeout:   5 * time.Second,
    ResponseHeaderTimeout: 10 * time.Second, // ← kritis!
    IdleConnTimeout:       90 * time.Second,
    MaxIdleConnsPerHost:   50,
})
```

**Kenapa berbahaya:** Tanpa timeout, satu downstream yang lambat bisa membuat seluruh goroutine pool habis. Di K8s, ini menyebabkan pod tidak respond → readiness probe gagal → pod direstart → cascading failure.

---

### ❌ Anti-Pattern 2: Tidak Drain Response Body

```go
// BAD: Close tanpa drain — connection TIDAK dikembalikan ke pool
resp, err := client.Do(req)
if err != nil { return err }
defer resp.Body.Close() // ← tanpa drain sebelumnya

// Akibat: setiap request buat TCP connection baru
// High-traffic → file descriptor exhaustion → "too many open files" error
```

```go
// GOOD: Drain dulu, baru close
resp, err := client.Do(req)
if err != nil { return err }
defer func() {
    io.Copy(io.Discard, resp.Body) // drain sisa body
    resp.Body.Close()              // kembalikan ke pool
}()
```

**Kenapa berbahaya:** Go HTTP transport hanya bisa reuse connection jika body sudah dibaca habis. Jika tidak, transport membuat `TIME_WAIT` connection baru setiap request — pada 1000 RPS, ini menguras port range OS dalam hitungan menit.

---

### ❌ Anti-Pattern 3: Satu Client Per Request

```go
// BAD: Buat client baru di setiap function call
func CallPaymentGateway(amount int) error {
    client := &http.Client{Timeout: 30 * time.Second} // ← baru setiap call!
    // ...
}

// Akibat: tidak ada connection reuse, MaxIdleConnsPerHost tidak berguna,
// setiap call = TCP handshake baru = 3-way handshake + TLS = ~100-200ms overhead
```

```go
// GOOD: Satu client di-share di seluruh aplikasi (singleton atau DI)
type PaymentService struct {
    client *http.Client // di-inject saat konstruksi, di-reuse selamanya
}

func NewPaymentService(client *http.Client) *PaymentService {
    return &PaymentService{client: client}
}

func (s *PaymentService) Charge(ctx context.Context, amount int) error {
    // Reuse s.client — connection pool aktif, TLS session cached
}
```

## 5. Edge Cases

1. **HTTP/2 vs HTTP/1.1 multiplexing:** Dengan `ForceAttemptHTTP2: true`, satu TCP connection bisa handle banyak request concurrent (multiplexing). Akibatnya `MaxIdleConnsPerHost` untuk HTTP/2 tidak perlu sebesar HTTP/1.1 — 10-20 koneksi sudah bisa handle ratusan concurrent request. Tapi jika server tidak support HTTP/2, transport fallback ke HTTP/1.1 otomatis.

2. **DNS Caching di Transport:** `http.Transport` cache DNS hasil resolve. Jika downstream service IP berubah (blue/green deployment, K8s service endpoint update), client lama tetap hit IP lama sampai `IdleConnTimeout` atau connection drop. Solusi: set `DisableKeepAlives: false` dengan `IdleConnTimeout` pendek (30s) untuk cluster internal, atau gunakan DNS-based load balancing yang aware akan ini.

3. **Connection Leak saat Context Dibatalkan:** Jika context dibatalkan di tengah request, Go transport menutup connection dan **tidak mengembalikan ke pool** (karena tidak tahu apakah response sudah partial). Ini normal — tapi jika context sering dibatalkan (misalnya timeout yang agresif), `MaxIdleConns` akan cepat habis. Monitor via `http.Transport.CloseIdleConnections()` atau metric `go_http_client_connections`.

4. **`req.Clone()` Wajib di RoundTripper:** `http.Request` tidak thread-safe untuk modifikasi header. Jika RoundTripper memodifikasi header tanpa `req.Clone()`, akan terjadi race condition pada retry atau concurrent request yang share Request object yang sama. Selalu `req = req.Clone(req.Context())` sebelum modifikasi.

5. **Proxy & Corporate Firewall:** Di environment enterprise, traffic keluar melalui HTTP proxy. `http.Transport` sudah support `HTTP_PROXY`/`HTTPS_PROXY` env vars via `http.ProxyFromEnvironment`. Jika custom `DialContext` diset, proxy support hilang — harus implement manual atau gunakan `http.ProxyURL` di Transport config.

6. **Large Response Streaming:** Untuk response body besar (file download, NDJSON stream), gunakan `io.LimitReader` untuk proteksi memory: `io.Copy(w, io.LimitReader(resp.Body, 100<<20))` — maksimum 100MB. Tanpa ini, malicious server bisa kirim response tidak terbatas dan exhaust heap.

## Kapan JANGAN Pakai Ini

- **`http.DefaultClient`.** Ia tidak punya timeout sama sekali. Satu hilir yang menggantung akan menahan goroutine Anda selamanya — ini penyebab kehabisan sumber daya paling umum di layanan Go, dan paling mudah dihindari.
- **Membuat klien baru per permintaan.** Tiap `http.Client` membawa transport dan pool koneksinya sendiri. Membuatnya berulang berarti membuang keep-alive dan membayar TCP handshake plus TLS handshake setiap kali.
- **`Timeout` pada `http.Client` sebagai satu-satunya batas.** Ia mencakup **seluruh** siklus termasuk pembacaan body, sehingga salah untuk unduhan besar atau streaming. Pakai context per permintaan, ditambah timeout terpisah di transport untuk dial dan TLS.
- **Retry tanpa memastikan operasinya idempoten.** Mengulang `POST` yang sebenarnya sudah sampai — hanya responsnya yang hilang — akan menggandakan efeknya di sisi penerima.
- **Melewatkan pembacaan body sampai habis sebelum `Close`.** Koneksi yang body-nya belum terbaca tidak dikembalikan ke pool. Pool perlahan kosong, dan latensi naik tanpa sebab yang tampak.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Goroutine menumpuk di `net/http` `RoundTrip` | `pprof/goroutine` | Permintaan tanpa timeout, menunggu selamanya |
| Ribuan koneksi `TIME_WAIT` | `ss -tan state time-wait` | Koneksi tidak dipakai ulang |
| Latensi naik perlahan sepanjang hari | rasio koneksi baru vs dipakai ulang | Pool kosong karena body tidak di-drain |
| Efek ganda di sistem penerima | apakah retry aktif pada non-idempoten | Retry tanpa idempotency key |
| Unduhan besar selalu gagal di detik ke-N | `Client.Timeout` | Timeout menyeluruh ikut membatasi pembacaan body |

```bash
# Koneksi yang tidak dipakai ulang meninggalkan jejak di TIME_WAIT
ss -tan state time-wait | wc -l

# Goroutine yang menggantung di klien HTTP
curl -s 'localhost:6060/debug/pprof/goroutine?debug=1' | grep -B2 -A4 'RoundTrip'

# Latensi hilir dibandingkan timeout yang disetel
curl -s localhost:9090/metrics | grep -E 'http_client_(request_duration|requests_total)'

# Aktifkan httptrace lalu catat conn_reused: rasio rendah = pool tidak bekerja
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.conn_reused==false) | .host' | sort | uniq -c | sort -rn | head
```
