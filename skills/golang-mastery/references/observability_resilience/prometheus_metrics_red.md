# Prometheus RED Metrics & Instrumentation di Go

> **Berlaku:** Go 1.21+ · `prometheus/client_golang` v1.19+ · **Lihat juga:** `engineering_practice/slo_error_budget.md` · `observability_resilience/opentelemetry_tracing.md` · `observability_resilience/health_check_readiness.md` · `observability_resilience/structured_logging_zerolog.md`

**RED Method** adalah framework observability standar untuk service HTTP/gRPC: Rate (QPS), Errors (error rate), Duration (latency). Prometheus client Go mengekspos metrics via pull-based model — Prometheus server scrape `/metrics` endpoint setiap 15 detik.

---

## 1. Arsitektur: Prometheus Data Model

```
Tipe Metric di Prometheus:
                                                          
  Counter  : monotonically increasing (reset = 0 saat restart)
  │  http_requests_total{method="GET", status="200"} 1500
  │  Fungsi: rate(http_requests_total[5m]) → QPS                  
                                                          
  Histogram: distribusi nilai ke dalam buckets            
  │  http_request_duration_seconds_bucket{le="0.1"} 980
  │  http_request_duration_seconds_bucket{le="0.5"} 1200
  │  http_request_duration_seconds_count 1500            
  │  Fungsi: histogram_quantile(0.99, rate(...[5m])) → p99
                                                          
  Gauge    : nilai yang bisa naik/turun                   
     active_connections 42                                
     memory_usage_bytes 134217728                         
                                                          
Pull-Based Architecture:
                                                          
  [ Go Service :8080 ]   [ Go Service :8080 ]            
       │ /metrics              │ /metrics                 
       └──────────┬────────────┘                          
                  │ scrape every 15s                      
           [ Prometheus Server ]                          
                  │ PromQL queries                        
           [ Grafana Dashboards ]                         
                  │ threshold alerts                      
           [ AlertManager → PagerDuty/Slack ]            
```

**Aturan Cardinality:** Tiap kombinasi label unik = 1 time series di memory. 100K time series = ~500MB RAM di Prometheus. Label dengan nilai unbounded (user_id, IP) → cardinality explosion → OOM.

---

## 2. Kode Go Production-Ready

```go
package metrics

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// Metrics mengenkapsulasi semua Prometheus metrics untuk satu service.
// Menggunakan registry terpisah (non-global) agar test tidak collision.
type Metrics struct {
	registry    *prometheus.Registry
	reqTotal    *prometheus.CounterVec
	reqDuration *prometheus.HistogramVec
	reqInFlight prometheus.Gauge
}

// NewMetrics membuat instance Metrics baru dengan custom registry.
// Gunakan non-global registry untuk test isolation.
func NewMetrics(namespace string) *Metrics {
	reg := prometheus.NewRegistry()

	reqTotal := prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "http_requests_total",
			Help:      "Total HTTP requests partitioned by method, path, and status code.",
		},
		[]string{"method", "path", "status"},
	)

	reqDuration := prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: namespace,
			Name:      "http_request_duration_seconds",
			Help:      "HTTP request duration in seconds.",
			// Buckets disesuaikan untuk fintech API (target p99 < 200ms)
			Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2},
		},
		[]string{"method", "path"},
	)

	reqInFlight := prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: namespace,
		Name:      "http_requests_in_flight",
		Help:      "Current number of HTTP requests being processed.",
	})

	reg.MustRegister(reqTotal, reqDuration, reqInFlight)

	return &Metrics{
		registry:    reg,
		reqTotal:    reqTotal,
		reqDuration: reqDuration,
		reqInFlight: reqInFlight,
	}
}

// Handler mengembalikan HTTP handler untuk /metrics endpoint.
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{
		EnableOpenMetrics: true, // support OpenMetrics format
	})
}

// REDMiddleware wraps handler dengan RED metrics instrumentation.
func (m *Metrics) REDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		// Track in-flight requests
		m.reqInFlight.Inc()
		defer m.reqInFlight.Dec()

		// Capture status code
		rw := &captureWriter{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(rw, r)

		duration := time.Since(start).Seconds()

		// Normalize path — KRITIS: hindari cardinality explosion
		// Gunakan route pattern dari router (chi, gin, echo), bukan r.URL.Path mentah!
		path := normalizePathForMetrics(r)

		m.reqDuration.WithLabelValues(r.Method, path).Observe(duration)
		m.reqTotal.WithLabelValues(r.Method, path, strconv.Itoa(rw.statusCode)).Inc()
	})
}

// normalizePathForMetrics mengambil route pattern dari chi/gorilla context.
// Fallback ke path statis jika tidak ada router context.
func normalizePathForMetrics(r *http.Request) string {
	// Coba ambil route pattern (Go 1.22+ net/http)
	if pattern := r.Pattern; pattern != "" {
		return pattern
	}
	// Untuk path dinamis seperti /users/123 → return /users/{id}
	// Dalam produksi nyata, gunakan chi.RouteContext(r.Context()).RoutePattern()
	return r.URL.Path
}

// captureWriter menangkap HTTP status code dari handler.
type captureWriter struct {
	http.ResponseWriter
	statusCode int
	written    bool
}

func (c *captureWriter) WriteHeader(code int) {
	if !c.written {
		c.statusCode = code
		c.written = true
	}
	c.ResponseWriter.WriteHeader(code)
}

// --- Unit Tests ---

func TestREDMiddleware_CountsRequests(t *testing.T) {
	m := NewMetrics("test")

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	wrapped := m.REDMiddleware(handler)

	// Kirim 3 request
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest("GET", "/api/orders", nil)
		req.URL = &url.URL{Path: "/api/orders"}
		wrapped.ServeHTTP(httptest.NewRecorder(), req)
	}

	// Verifikasi counter = 3
	count, err := testutil.CollectAndCount(m.reqTotal)
	if err != nil {
		t.Fatalf("collect metrics: %v", err)
	}
	if count == 0 {
		t.Error("expected some metric time series, got 0")
	}
}

func TestREDMiddleware_Captures5xx(t *testing.T) {
	m := NewMetrics("test2")

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	wrapped := m.REDMiddleware(handler)

	req := httptest.NewRequest("POST", "/api/pay", nil)
	req.URL = &url.URL{Path: "/api/pay"}
	wrapped.ServeHTTP(httptest.NewRecorder(), req)

	// Verifikasi status=500 terekam
	gathered, _ := m.registry.Gather()
	found := false
	for _, mf := range gathered {
		if strings.Contains(mf.GetName(), "http_requests_total") {
			for _, metric := range mf.GetMetric() {
				for _, label := range metric.GetLabel() {
					if label.GetName() == "status" && label.GetValue() == "500" {
						found = true
					}
				}
			}
		}
	}
	if !found {
		t.Error("expected status=500 label in metrics, not found")
	}
}

func TestREDMiddleware_InFlightGauge(t *testing.T) {
	m := NewMetrics("test3")

	// Handler yang delay — in-flight harus = 1 selama handler jalan
	inFlightDuring := make(chan float64, 1)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Read current in_flight value during request
		gathered, _ := m.registry.Gather()
		for _, mf := range gathered {
			if strings.Contains(mf.GetName(), "in_flight") {
				for _, metric := range mf.GetMetric() {
					inFlightDuring <- metric.GetGauge().GetValue()
				}
			}
		}
		w.WriteHeader(http.StatusOK)
	})
	wrapped := m.REDMiddleware(handler)

	req := httptest.NewRequest("GET", "/", nil)
	req.URL = &url.URL{Path: "/"}
	wrapped.ServeHTTP(httptest.NewRecorder(), req)

	select {
	case val := <-inFlightDuring:
		if val != 1.0 {
			t.Errorf("in_flight during request = %.0f, want 1", val)
		}
	default:
		t.Error("in_flight gauge not captured")
	}
}

func TestMetricsHandler_ServesMetrics(t *testing.T) {
	m := NewMetrics("test4")

	req := httptest.NewRequest("GET", "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("metrics handler: got %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "# HELP") {
		t.Error("metrics response missing HELP comment")
	}
}
```

---

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Label dengan Cardinality Tak Terbatas

```go
// BAD: user_id unik untuk setiap user → jutaan time series → OOM Prometheus
reqTotal := prometheus.NewCounterVec(
    prometheus.CounterOpts{Name: "http_requests_total"},
    []string{"method", "path", "user_id"}, // BERBAHAYA!
)
reqTotal.WithLabelValues("GET", "/orders", "usr_alice").Inc()
reqTotal.WithLabelValues("GET", "/orders", "usr_bob").Inc()
// 1 juta user = 1 juta time series × metadata overhead = ~5GB RAM di Prometheus

// GOOD: Label hanya untuk dimensi low-cardinality
reqTotal := prometheus.NewCounterVec(
    prometheus.CounterOpts{Name: "http_requests_total"},
    []string{"method", "path", "status"}, // max ~100 kombinasi
)
// user_id → gunakan distributed tracing (spans) untuk pencarian per-user
```

**Kenapa berbahaya:** Setiap kombinasi label unik menciptakan satu time series di RAM Prometheus. Label dengan nilai unbounded (user ID, UUID, IP address) menyebabkan cardinality explosion — Prometheus kehabisan RAM dan crash, menghilangkan seluruh observability.

### ❌ Anti-Pattern 2: `r.URL.Path` Mentah sebagai Label Path

```go
// BAD: Path dengan ID dinamis menciptakan cardinality explosion
reqDuration.WithLabelValues(r.Method, r.URL.Path).Observe(duration)
// /users/1, /users/2, /users/3 ... /users/1000000 → 1 juta time series!

// GOOD: Gunakan route pattern dari router
// Chi:
pattern := chi.RouteContext(r.Context()).RoutePattern() // "/users/{id}"
// Gin:
pattern := c.FullPath() // "/users/:id"
// Go 1.22 net/http:
pattern := r.Pattern // "GET /users/{id}"

reqDuration.WithLabelValues(r.Method, pattern).Observe(duration)
// Semua /users/* teragregasi ke 1 time series: "/users/{id}"
```

**Kenapa berbahaya:** REST API dengan ID di path (UUID, integer) menghasilkan unique path per resource. 1M user records = 1M path time series → cardinality explosion yang sama seperti user_id label. Selalu normalize ke route pattern.

### ❌ Anti-Pattern 3: Global Registry di Tests

```go
// BAD: Menggunakan prometheus.MustRegister (global registry) di package code
func init() {
    prometheus.MustRegister(reqTotal) // global registry
}
// Di test: setiap TestXxx menjalankan init() → "duplicate collector" panic
// go test -run=TestA ./...  → PANIC: duplicate metrics registration

// GOOD: Terima Registry sebagai parameter (dependency injection)
func NewMetrics(reg prometheus.Registerer) *Metrics {
    // register ke reg, bukan global prometheus.DefaultRegisterer
}
// Di test: NewMetrics(prometheus.NewRegistry()) → fresh registry per test
// Di production: NewMetrics(prometheus.DefaultRegisterer) → global
```

**Kenapa berbahaya:** Global Prometheus registry menyebabkan `panic: duplicate collector registration` saat test suite berjalan berkali-kali dalam satu proses (go test -count=N). Ini memaksa developer menonaktifkan test atau menambahkan hacks yang buruk.

---

## 4. Edge Cases & Defensive Programming

1. **Histogram Bucket Misconfiguration:** Default buckets (`0.005` to `10`) cocok untuk general web services. Untuk database query (microseconds) atau batch jobs (minutes), semua observasi menumpuk di bucket pertama atau terakhir — p99 tidak akurat. Selalu sesuaikan buckets dengan profil latensi aktual: jalankan `histogram_quantile(0.99, ...)` di Grafana dan perhatikan apakah hasilnya reasonable.

2. **Counter Reset saat Restart:** Counter di-reset ke 0 setiap restart karena stored di RAM. Grafana `rate()` otomatis handle counter reset via deteksi penurunan nilai. Tapi jika pod restart sangat sering (crash loop), `rate()` bisa return 0 selama periode tanpa data. Gunakan alert `increase(http_requests_total[5m]) == 0` untuk deteksi service down.

3. **Scrape Timeout Saat Metrics Berat:** Rendering teks `/metrics` untuk 100K+ time series bisa memakan 5+ detik CPU. Jika Prometheus `scrape_timeout` (default 10s) tercapai, scrape gagal dan Prometheus melaporkan target DOWN. Monitor durasi `promhttp_metric_handler_requests_in_flight` dan ukuran response bytes.

4. **OpenMetrics vs Prometheus Text Format:** Prometheus client Go mendukung kedua format. `EnableOpenMetrics: true` mengaktifkan format OpenMetrics yang lebih ekspresif (unit, created timestamps). Beberapa scraper lama tidak support OpenMetrics — pastikan kompatibilitas dengan Prometheus version yang digunakan.

5. **Rate vs Irate untuk Alert:** `rate()` menghitung rata-rata per detik selama window (smooth tapi lambat deteksi spike). `irate()` menghitung dari 2 sample terakhir (responsif tapi noisy). Untuk alert, gunakan `rate()` dengan window 1-5 menit. Untuk dashboard real-time, `irate()` memberikan respons lebih cepat.

## Kapan JANGAN Pakai Ini

- **Label berkardinalitas tak terbatas** — user ID, order ID, path mentah, pesan galat. Satu label buruk cukup untuk membuat Prometheus kehabisan memori, dan pemulihannya berarti menghapus data historis. Ini kesalahan paling mahal di seluruh domain observabilitas.
- **Histogram untuk segala hal.** Tiap histogram menghasilkan satu deret **per bucket per kombinasi label**. Sepuluh bucket × lima label bernilai puluhan = ledakan deret yang tidak terlihat sampai terlambat.
- **Metrik untuk menjawab "apa yang terjadi pada permintaan X".** Itu wilayah trace dan log. Metrik menjawab pertanyaan agregat; memaksanya menjawab pertanyaan per-permintaan selalu berakhir sebagai masalah kardinalitas.
- **Alert pada metrik mentah.** "CPU > 80%" berbunyi setiap malam dan dalam sebulan akan diabaikan seluruh tim. Alert yang layak membangunkan orang dibangun di atas SLO dan burn rate — lihat `engineering_practice/slo_error_budget.md`.
- **Registry global di dalam uji.** Uji yang berjalan berurutan saling mewarisi nilai counter, dan kegagalannya jadi bergantung urutan — jenis flaky yang paling membingungkan.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Prometheus `OOMKilled` | jumlah deret per metrik | Kardinalitas meledak; cari label penyebabnya |
| Scrape timeout | ukuran keluaran `/metrics` | Terlalu banyak deret pada satu target |
| Nilai p99 tampak mustahil | batas bucket histogram | Bucket tidak mencakup rentang latensi nyata |
| Alert berbunyi terus dan diabaikan | apa yang dijadikan dasar alert | Alert pada metrik mentah, bukan pada dampak ke pengguna |
| Grafik hilang setelah deploy | perubahan nama label | Nama metrik/label bukan hal yang bebas diubah |

```bash
# Deret dengan kardinalitas terbesar -- penyebab OOM nomor satu
curl -s http://prometheus:9090/api/v1/status/tsdb | jq '.data.seriesCountByMetricName[:10]'
curl -s http://prometheus:9090/api/v1/status/tsdb | jq '.data.labelValueCountByLabelName[:10]'

# Berapa deret yang dihasilkan satu target
curl -s localhost:9090/metrics | grep -vc '^#'

# Label yang paling banyak nilainya pada satu metrik
curl -s 'http://prometheus:9090/api/v1/label/path/values' | jq '.data | length'
```
