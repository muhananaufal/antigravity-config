# Prometheus RED Metrics & Instrumentation di Go

> **Berlaku:** Go **1.22+** (`r.Pattern` di `net/http` baru ada sejak 1.22; pada 1.21 kode ini tidak kompilasi) · `prometheus/client_golang` v1.19+ · **Lihat juga:** `engineering_practice/slo_error_budget.md` · `observability_resilience/opentelemetry_tracing.md` · `observability_resilience/health_check_readiness.md` · `observability_resilience/structured_logging_zerolog.md`

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
	"bufio"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel/trace"
)

// Metrics mengenkapsulasi seluruh metrik Prometheus untuk satu service.
type Metrics struct {
	reqTotal    *prometheus.CounterVec
	reqDuration *prometheus.HistogramVec
	reqInFlight prometheus.Gauge
}

// NewRegistry membuat registry non-global BESERTA kolektor bawaan.
//
// Inilah bagian yang paling sering hilang saat berpindah dari
// DefaultRegisterer ke registry sendiri: registry kosong TIDAK memuat
// go_goroutines, go_memstats_*, maupun process_resident_memory_bytes.
// Anjuran "pakai registry sendiri" itu benar, tetapi tanpa dua baris di bawah
// Anda kehilangan persis metrik yang dibutuhkan untuk mendiagnosis kebocoran
// goroutine dan memori — dan biasanya baru menyadarinya saat sedang
// menanganinya.
func NewRegistry() *prometheus.Registry {
	reg := prometheus.NewRegistry()
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	return reg
}

// NewMetrics menerima Registerer sebagai parameter — persis bentuk yang
// diresepkan Anti-Pattern 3. Produksi memakai NewRegistry(); uji memakai
// prometheus.NewRegistry() yang segar per kasus uji.
func NewMetrics(namespace string, reg prometheus.Registerer) *Metrics {
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
			// Bucket WAJIB mencakup rentang latensi NYATA, TERMASUK ekornya.
			//
			// Deretan yang berhenti di 2 detik terlihat masuk akal untuk API
			// dengan target p99 < 200ms — dan justru itu jebakannya. Bila lebih
			// dari 1% permintaan melampaui bucket berhingga tertinggi,
			// histogram_quantile mengembalikan batas atas bucket tersebut: p99
			// Anda TERKUNCI di angka 2 dan tidak bergerak lagi, seburuk apa pun
			// keadaannya. Grafiknya tetap tampak wajar. Batas atas harus
			// melampaui timeout klien, bukan target SLO.
			Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10},
		},
		[]string{"method", "path"},
	)

	reqInFlight := prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: namespace,
		Name:      "http_requests_in_flight",
		Help:      "Current number of HTTP requests being processed.",
	})

	reg.MustRegister(reqTotal, reqDuration, reqInFlight)

	return &Metrics{reqTotal: reqTotal, reqDuration: reqDuration, reqInFlight: reqInFlight}
}

// Handler menyajikan endpoint /metrics.
func Handler(g prometheus.Gatherer) http.Handler {
	return promhttp.HandlerFor(g, promhttp.HandlerOpts{
		EnableOpenMetrics: true, // WAJIB agar exemplar ikut terekspos
	})
}

// REDMiddleware membungkus handler dengan instrumentasi RED.
func (m *Metrics) REDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mulai := time.Now()
		m.reqInFlight.Inc()

		pw := &penulisTerbungkus{ResponseWriter: w, kode: http.StatusOK}

		record := func() {
			durasi := time.Since(mulai).Seconds()
			m.reqInFlight.Dec()

			// WAJIB dihitung SESUDAH next.ServeHTTP: ServeMux menuliskan
			// r.Pattern saat merutekan, jadi sebelum itu nilainya masih kosong.
			jalur := pathForMetrics(r)

			m.observeDuration(r, jalur, durasi)
			m.reqTotal.WithLabelValues(r.Method, jalur, strconv.Itoa(pw.kode)).Inc()
		}

		// Pencatatan WAJIB di dalam defer. Tanpa itu, handler yang panic
		// melewatkan Observe DAN Inc sepenuhnya: permintaan yang paling perlu
		// terlihat justru satu-satunya yang tidak tercatat, dan error rate
		// tampak TURUN tepat saat insiden memburuk.
		defer func() {
			if p := recover(); p != nil {
				pw.kode = http.StatusInternalServerError
				record()
				panic(p) // diteruskan ke middleware recovery di lapisan luar
			}
			record()
		}()

		next.ServeHTTP(pw, r)
	})
}

// amatiDurasi menautkan sampel ke TraceID lewat exemplar bila permintaan ini
// ikut ter-sampling. Dari satu titik p99 di Grafana Anda bisa langsung membuka
// trace permintaan yang menyebabkannya — jembatan yang membuat metrik dan
// trace saling berguna alih-alih berdiri sendiri.
func (m *Metrics) observeDuration(r *http.Request, jalur string, durasi float64) {
	obs := m.reqDuration.WithLabelValues(r.Method, jalur)

	sc := trace.SpanContextFromContext(r.Context())
	if eo, ok := obs.(prometheus.ExemplarObserver); ok && sc.IsSampled() {
		eo.ObserveWithExemplar(durasi, prometheus.Labels{"trace_id": sc.TraceID().String()})
		return
	}
	obs.Observe(durasi)
}

// jalurUntukMetrik mengembalikan POLA rute, bukan path mentah.
//
// Fallback-nya sengaja konstanta, BUKAN r.URL.Path. Mengembalikan path mentah
// di sini persis merupakan Anti-Pattern 2 — dan ia gagal secara SENYAP:
// seluruh uji lolos karena memakai path statis, lalu di produksi
// /pesanan/{uuid} melahirkan satu deret waktu per pesanan sampai Prometheus
// kehabisan memori. Kehilangan satu dimensi jauh lebih murah daripada
// kehilangan seluruh sistem metrik.
func pathForMetrics(r *http.Request) string {
	if r.Pattern == "" {
		// Router pihak ketiga, ambil dari context-nya masing-masing:
		//   chi  : chi.RouteContext(r.Context()).RoutePattern()
		//   gin  : c.FullPath()
		//   echo : c.Path()
		return "lainnya"
	}
	// r.Pattern memuat metode ("GET /pesanan/{id}") sementara metode sudah
	// menjadi label tersendiri. Diambil bagian polanya saja agar label tidak
	// menduplikasi informasi yang sama.
	if i := strings.LastIndex(r.Pattern, " "); i >= 0 {
		return r.Pattern[i+1:]
	}
	return r.Pattern
}

// penulisTerbungkus menangkap kode status HTTP.
//
// Ia WAJIB meneruskan antarmuka opsional. http.ResponseWriter yang dibungkus
// struct biasa kehilangan Flusher, Hijacker, dan ReaderFrom — akibatnya
// handler SSE tidak pernah bisa flush (respons menggantung di buffer sampai
// handler selesai), upgrade WebSocket gagal, dan io.Copy kehilangan jalur
// cepatnya. Ketiganya terjadi DIAM-DIAM, dan hanya pada rute yang kebetulan
// membutuhkannya — sementara middleware ini dipasang di SELURUH rute.
type penulisTerbungkus struct {
	http.ResponseWriter
	kode    int
	ditulis bool
}

func (p *penulisTerbungkus) WriteHeader(kode int) {
	if !p.ditulis {
		p.kode = kode
		p.ditulis = true
	}
	p.ResponseWriter.WriteHeader(kode)
}

func (p *penulisTerbungkus) Write(b []byte) (int, error) {
	p.ditulis = true // Write tanpa WriteHeader mengirim 200 secara implisit
	return p.ResponseWriter.Write(b)
}

// Unwrap dipakai http.NewResponseController (Go 1.20+) untuk menembus
// pembungkus. Inilah jalur yang benar bagi handler modern.
func (p *penulisTerbungkus) Unwrap() http.ResponseWriter { return p.ResponseWriter }

// Flush dan Hijack tetap diteruskan eksplisit untuk pustaka yang masih
// melakukan type assertion langsung, mis. w.(http.Flusher).
func (p *penulisTerbungkus) Flush() {
	if f, ok := p.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (p *penulisTerbungkus) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := p.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("underlying ResponseWriter does not support Hijack")
	}
	return h.Hijack()
}
```

```go
package metrics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestREDMiddlewareMenghitungPermintaan(t *testing.T) {
	m := NewMetrics("uji", prometheus.NewRegistry())

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/pesanan/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	wrapped := m.REDMiddleware(mux)

	// Tiga ID BERBEDA — inilah yang membedakan uji ini dari versi lama, yang
	// hanya memakai satu path statis sehingga tidak pernah bisa membedakan
	// normalisasi yang bekerja dari yang tidak.
	for _, id := range []string{"1", "2", "3"} {
		wrapped.ServeHTTP(httptest.NewRecorder(),
			httptest.NewRequest(http.MethodGet, "/api/pesanan/"+id, nil))
	}

	// testutil.ToFloat64 membaca NILAI counter.
	//
	// Versi lama memakai `count, err := testutil.CollectAndCount(...)` — yang
	// bahkan tidak kompilasi, karena CollectAndCount mengembalikan satu nilai
	// (int), bukan (int, error). Seandainya kompilasi pun, ia menghitung
	// jumlah DERET WAKTU, bukan nilai counter, sehingga asersi "count != 0"
	// tidak pernah bisa membuktikan tiga permintaan tercatat — meski nama dan
	// komentar ujinya mengklaim persis itu.
	if got := testutil.ToFloat64(m.reqTotal.WithLabelValues("GET", "/api/pesanan/{id}", "200")); got != 3 {
		t.Fatalf("counter = %v, mau 3", got)
	}
	if n := testutil.CollectAndCount(m.reqTotal); n != 1 {
		t.Fatalf("time series = %d, want 1 — three different IDs should aggregate to one pattern", n)
	}
}

// Menjaga janji terpenting berkas ini: label jalur TIDAK PERNAH boleh berisi
// path mentah, bahkan ketika pola rute tidak tersedia.
func TestFallbackJalurTidakPernahMentah(t *testing.T) {
	m := NewMetrics("uji2", prometheus.NewRegistry())
	wrapped := m.REDMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	for _, id := range []string{"a1b2", "c3d4", "e5f6"} {
		wrapped.ServeHTTP(httptest.NewRecorder(),
			httptest.NewRequest(http.MethodGet, "/pesanan/"+id, nil))
	}

	if n := testutil.CollectAndCount(m.reqTotal); n != 1 {
		t.Fatalf("time series = %d, want 1 — fallback returned raw path and exploded cardinality", n)
	}
}

func TestPanicTetapTercatat(t *testing.T) {
	m := NewMetrics("uji3", prometheus.NewRegistry())
	wrapped := m.REDMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("handler meledak")
	}))

	func() {
		defer func() { _ = recover() }() // menirukan middleware recovery di lapisan luar
		wrapped.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	}()

	if got := testutil.ToFloat64(m.reqTotal.WithLabelValues("GET", "lainnya", "500")); got != 1 {
		t.Fatalf("permintaan panic tercatat %v kali sebagai 500, mau 1", got)
	}
	if got := testutil.ToFloat64(m.reqInFlight); got != 0 {
		t.Fatalf("in-flight = %v setelah panic, mau 0", got)
	}
}

func TestPembungkusMempertahankanFlusher(t *testing.T) {
	m := NewMetrics("uji4", prometheus.NewRegistry())
	var bisaFlush bool
	wrapped := m.REDMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, bisaFlush = w.(http.Flusher)
	}))
	wrapped.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))

	if !bisaFlush {
		t.Fatal("pembungkus menghilangkan http.Flusher — handler SSE akan menggantung di buffer")
	}
}

func TestHandlerMenyajikanKolektorBawaan(t *testing.T) {
	reg := NewRegistry()
	NewMetrics("uji5", reg)

	rec := httptest.NewRecorder()
	Handler(reg).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("kode = %d, mau 200", rec.Code)
	}
	// Registry sendiri TIDAK memuat kolektor runtime secara otomatis. Tanpa
	// NewRegistry(), asersi ini gagal — dan di produksi Anda kehilangan
	// go_goroutines persis saat mencari kebocoran goroutine.
	for _, required := range []string{"go_goroutines", "process_resident_memory_bytes"} {
		if !strings.Contains(rec.Body.String(), required) {
			t.Errorf("/metrics output does not contain %q", required)
		}
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

// GOOD: pola rute dari router
pattern := chi.RouteContext(r.Context()).RoutePattern() // chi  → "/users/{id}"
pattern = c.FullPath()                                  // gin  → "/users/:id"
pattern = r.Pattern                                     // Go 1.22+ → "GET /users/{id}"

reqDuration.WithLabelValues(r.Method, pattern).Observe(duration)
// Semua /users/* teragregasi ke 1 time series: "/users/{id}"
```

**Kenapa berbahaya:** REST API dengan ID di path (UUID, integer) menghasilkan path unik per resource. 1 juta record = 1 juta deret path → ledakan kardinalitas yang sama seperti label `user_id`.

Tiga detail yang menentukan apakah normalisasi ini benar-benar bekerja:

- **Fallback-nya TIDAK boleh path mentah.** Menulis `return r.URL.Path` sebagai jalur cadangan berarti anti-pattern ini tetap hidup, hanya bersembunyi di cabang `else`. Ia lolos setiap uji (yang selalu memakai path statis) lalu meledak di produksi. Kembalikan konstanta seperti `"lainnya"`: kehilangan satu dimensi jauh lebih murah daripada kehilangan seluruh Prometheus.
- **`r.Pattern` baru terisi SESUDAH routing.** `ServeMux` menuliskannya saat memilih handler, jadi middleware yang membacanya **sebelum** `next.ServeHTTP` selalu mendapat string kosong — dan diam-diam jatuh ke fallback untuk setiap permintaan.
- **`r.Pattern` memuat metode** (`"GET /users/{id}"`). Bila `method` sudah menjadi label tersendiri, memakainya utuh menduplikasi dimensi yang sama dan melipatgandakan jumlah deret tanpa menambah informasi.

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

1. **Bucket histogram yang salah membuat p99 BERBOHONG, bukan sekadar tidak akurat:** bucket bawaan (`0.005`–`10`) cocok untuk layanan web umum. Untuk query database (mikrodetik) atau batch job (menit), seluruh observasi menumpuk di bucket pertama atau terakhir. Yang membuatnya berbahaya adalah bentuk kegagalannya:
   - Bila kuantil jatuh di bucket `+Inf`, `histogram_quantile` mengembalikan **batas atas bucket berhingga tertinggi**. Dengan bucket teratas 2 detik, p99 Anda akan menampilkan tepat `2` — selamanya, seburuk apa pun keadaannya. Grafiknya rata dan tampak sehat; tidak ada peringatan apa pun.
   - Bila kuantil jatuh di bucket pertama, Prometheus mengasumsikan sebaran linier dari **nol** ke batas atas bucket itu — angka yang keluar mendekati tebakan.

   Karena itu batas atas bucket harus ditentukan oleh **timeout klien**, bukan oleh target SLO. Sebagai alternatif, `client_golang` v1.19+ mendukung **native histogram** lewat `NativeHistogramBucketFactor` (mis. `1.1`), yang menyesuaikan bucket secara otomatis dan menghapus seluruh persoalan ini — dengan catatan Prometheus di sisi server harus dijalankan dengan `--enable-feature=native-histograms`, dan fitur ini masih berstatus eksperimental.

2. **Counter Reset saat Restart:** Counter di-reset ke 0 setiap restart karena stored di RAM. Grafana `rate()` otomatis handle counter reset via deteksi penurunan nilai. Tapi jika pod restart sangat sering (crash loop), `rate()` bisa return 0 selama periode tanpa data. Gunakan alert `increase(http_requests_total[5m]) == 0` untuk deteksi service down.

3. **Scrape Timeout Saat Metrics Berat:** Rendering teks `/metrics` untuk 100K+ time series bisa memakan 5+ detik CPU. Jika Prometheus `scrape_timeout` (default 10s) tercapai, scrape gagal dan Prometheus melaporkan target DOWN. Monitor durasi `promhttp_metric_handler_requests_in_flight` dan ukuran response bytes.

4. **OpenMetrics bukan sekadar format yang lebih ekspresif — ia syarat untuk exemplar:** `EnableOpenMetrics: true` mengaktifkan unit dan created timestamp, tetapi manfaat terbesarnya adalah **exemplar**: menautkan satu sampel histogram ke `trace_id`-nya. Dengan itu, dari satu titik p99 yang mencurigakan di Grafana Anda bisa langsung membuka trace permintaan yang menyebabkannya — jembatan yang membuat metrik dan trace saling berguna alih-alih berdiri sendiri (lihat `amatiDurasi` di §2). Tanpa OpenMetrics, exemplar tidak pernah ikut ter-scrape meskipun sudah dicatat di sisi aplikasi. Scraper lama yang tidak mendukung OpenMetrics tetap bisa membaca format teks biasa — negosiasinya lewat header `Accept`, jadi mengaktifkannya aman.

6. **Registry sendiri TIDAK memuat kolektor runtime:** `prometheus.NewRegistry()` menghasilkan registry benar-benar kosong. `go_goroutines`, `go_memstats_*`, dan `process_resident_memory_bytes` hanya ada di `DefaultRegisterer` karena kolektornya didaftarkan di sana lewat `init()`. Anjuran memakai registry sendiri (Anti-Pattern 3) tetap benar, tapi harus disertai `collectors.NewGoCollector()` dan `collectors.NewProcessCollector(...)` — kalau tidak, Anda kehilangan persis metrik yang dicari saat menelusuri kebocoran goroutine atau memori.

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
| p99 rata sempurna di satu angka | batas atas bucket tertinggi | Kuantil jatuh di `+Inf`; angkanya terkunci di sana |
| Error rate TURUN saat insiden memburuk | apakah panic ikut tercatat | Handler panic melewati pencatatan metrik |
| `go_goroutines` tidak ada di `/metrics` | kolektor pada registry | Registry sendiri tanpa `collectors.NewGoCollector()` |

```bash
# Deret dengan kardinalitas terbesar -- penyebab OOM nomor satu
curl -s http://prometheus:9090/api/v1/status/tsdb | jq '.data.seriesCountByMetricName[:10]'
curl -s http://prometheus:9090/api/v1/status/tsdb | jq '.data.labelValueCountByLabelName[:10]'

# Berapa deret yang dihasilkan satu target
curl -s localhost:9090/metrics | grep -vc '^#'

# Label yang paling banyak nilainya pada satu metrik
curl -s 'http://prometheus:9090/api/v1/label/path/values' | jq '.data | length'
```
