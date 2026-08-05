# OpenTelemetry Tracing: Setup, Propagation & Sampling

> **Berlaku:** Go 1.21+ · OpenTelemetry-Go v1.24+ · **Lihat juga:** `observability_resilience/distributed_tracing_baggage.md` · `observability_resilience/prometheus_metrics_red.md` · `observability_resilience/structured_logging_zerolog.md` · `microservices_grpc/grpc_interceptors_middleware.md`

## Concept/Internals
OpenTelemetry (OTel) adalah standar industri *vendor-neutral* untuk mengumpulkan, menghasilkan, dan mengekspor telemetry data (traces, metrics, logs). Di dalam ekosistem *distributed systems* dan arsitektur *microservices*, *Distributed Tracing* menjadi krusial untuk menganalisis jalur eksekusi sebuah *request* yang melintasi berbagai layanan.

Komponen internal utama:
- **TracerProvider & Tracer**: Konfigurasi tingkat akar (root). `TracerProvider` mendefinisikan kemana traces akan dikirim (Exporter), metadata apa yang akan ditempelkan (Resource/Service Name), dan berapa persen trace yang direkam (Sampler). `Tracer` adalah instrumen yang membuat dan memulai `Span`.
- **Span & Span Context**: `Span` merepresentasikan satu unit pekerjaan logis (misal: request database, atau HTTP call). Setiap `Span` memiliki identitas unik berupa `TraceID` (mewakili *request* secara utuh) dan `SpanID` (mewakili unit kerja parsial). 
- **Context Propagation**: Rahasia utama di balik distributed tracing. OTel memanfaatkan implementasi W3C TraceContext. Saat layanan A memanggil layanan B via HTTP, layanan A akan menanamkan (*inject*) `TraceID` dan `SpanID` saat ini ke header HTTP (`traceparent: 00-{TraceID}-{SpanID}-01`). Layanan B mengekstraksi header tersebut untuk melanjutkan rantai trace.
- **Baggage**: Mekanisme W3C lain untuk meneruskan pasangan *key-value* arbitrer melintasi batas jaringan secara otomatis, berdampingan dengan `TraceContext`. Tidak seperti *span attributes* (yang hanya nempel di span tertentu), *baggage* diteruskan ke *semua* layanan hilir (downstream).

### Diagram ASCII: Lifecycle & Context Propagation

```ascii
[Client] (tanpa TraceID)
   |
   | HTTP POST /checkout
   v
+-------------------------------------------------+
| Service A: API Gateway                          |
| (1) Tracer.Start() -> Buat Root Span (TraceID)  |
| (2) Context.Inject() -> Taruh di Header         |
+--------+----------------------------------------+
         | HTTP Header
         | traceparent: 00-4bf92f35...-00f06...-01
         | baggage: tenant_id=customer_442
         v
+-------------------------------------------------+
| Service B: Order Processor                      |
| (1) Context.Extract() dari Header               |
| (2) Tracer.Start() -> Buat Child Span           |
| (3) Span.AddEvent("Validating payment")         |
| (4) SetStatus(Error) jika gagal                 |
+--------+----------------------------------------+
         | (Asynchronous Export via gRPC/HTTP)
         v
+-------------------------------------------------+
| OTel Collector -> Tempo / Jaeger / Datadog      |
+-------------------------------------------------+
```

## Production Code

Berikut implementasi production-ready untuk inisialisasi OTel Tracer dan pattern terbaik dalam membuat span, menangani propagasi context, serta merekam error yang elegan.

```go
package tracing

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.20.0"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc/credentials"
)

// KonfigTracing memuat seluruh nilai yang BERBEDA antar lingkungan.
//
// Lingkungan sengaja jadi parameter, bukan konstanta "production". Nilai yang
// dipatok di kode membuat trace staging masuk ke backend berlabel produksi —
// dan sesudah itu tidak ada cara memisahkannya lagi.
type KonfigTracing struct {
	NamaLayanan  string
	VersiLayanan string
	Lingkungan   string // "production", "staging", "dev"
	Endpoint     string
	Rasio        float64 // head sampling untuk trace yang DIMULAI di sini
	// TepiPublik=true bila layanan ini menerima `traceparent` dari klien yang
	// tidak tepercaya. Lihat keputusan sampler di bawah.
	TepiPublik bool
	// TLS wajib true kecuali collector berada di dalam pod yang sama.
	TLS bool
}

// InitTracerProvider menyiapkan exporter OTLP gRPC dan TracerProvider global.
func InitTracerProvider(ctx context.Context, k KonfigTracing) (*sdktrace.TracerProvider, error) {
	// resource.Merge dengan resource.Default() adalah pola yang
	// didokumentasikan OTel: ia MENAMBAH atribut Anda ke atribut bawaan SDK,
	// bukan menggantikannya.
	res, err := resource.Merge(
		resource.Default(),
		resource.NewWithAttributes(semconv.SchemaURL,
			semconv.ServiceName(k.NamaLayanan),
			semconv.ServiceVersion(k.VersiLayanan),
			semconv.DeploymentEnvironment(k.Lingkungan),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("bangun resource: %w", err)
	}

	opsi := []otlptracegrpc.Option{otlptracegrpc.WithEndpoint(k.Endpoint)}
	if k.TLS {
		opsi = append(opsi, otlptracegrpc.WithTLSCredentials(
			credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12})))
	} else {
		opsi = append(opsi, otlptracegrpc.WithInsecure())
	}

	exporter, err := otlptracegrpc.New(ctx, opsi...)
	if err != nil {
		return nil, fmt.Errorf("buat exporter otlp: %w", err)
	}

	// SAMPLER — dan satu konsekuensi yang jarang disebut.
	//
	// ParentBased mengikuti keputusan induk. Di DALAM sistem Anda itu memang
	// yang diinginkan: satu trace direkam utuh atau tidak sama sekali.
	//
	// Di tepi publik ceritanya berbeda. `traceparent` adalah header HTTP biasa
	// yang ditulis pengirim. Siapa pun bisa mengirim flag sampled `-01` dan
	// memaksa 100% permintaannya direkam — artinya tagihan observabilitas Anda
	// bisa dinaikkan orang lain dengan satu baris curl, dan tidak ada galat
	// yang muncul. Di tepi, keputusan induk JARAK JAUH diabaikan; keputusan
	// induk lokal (dalam proses) tetap dihormati.
	dasar := sdktrace.TraceIDRatioBased(k.Rasio)
	sampler := sdktrace.ParentBased(dasar)
	if k.TepiPublik {
		sampler = sdktrace.ParentBased(dasar,
			sdktrace.WithRemoteParentSampled(dasar),
			sdktrace.WithRemoteParentNotSampled(dasar),
		)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sampler),
		sdktrace.WithBatcher(exporter,
			// Antrean penuh berarti span DIJATUHKAN, tanpa galat di jalur
			// request. Inilah penyebab gejala "span hilang saat trafik puncak"
			// pada tabel deteksi di bawah.
			sdktrace.WithMaxQueueSize(4096),
			sdktrace.WithBatchTimeout(5*time.Second),
			sdktrace.WithExportTimeout(10*time.Second),
		),
	)

	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	// Tanpa baris ini, kegagalan ekspor hanya sampai ke stderr lewat logger
	// bawaan OTel dan tidak pernah masuk sistem log terstruktur Anda —
	// sehingga span yang dijatuhkan benar-benar tidak terlihat oleh siapa pun.
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		slog.Error("kegagalan otel", "galat", err)
	}))

	return tp, nil
}

// ProsesorPembayaran menyimpan dependensinya sebagai field agar bisa diuji
// tanpa jaringan sungguhan.
type ProsesorPembayaran struct {
	klien   *http.Client
	bankURL string
}

func NewProsesorPembayaran(bankURL string) *ProsesorPembayaran {
	return &ProsesorPembayaran{klien: TracedHTTPClient(), bankURL: bankURL}
}

// Proses mengeksekusi logika domain dalam konteks tracing.
func (p *ProsesorPembayaran) Proses(ctx context.Context, idPesanan string, jumlahSen int64) error {
	tracer := otel.Tracer("finance/payment-processor")

	ctx, span := tracer.Start(ctx, "ProsesPembayaran", trace.WithSpanKind(trace.SpanKindInternal))
	defer span.End()

	span.SetAttributes(
		attribute.String("order.id", idPesanan),
		// Satuan minor bertipe int64. float64 untuk uang tidak pernah benar,
		// termasuk di atribut span — trace kerap dipakai sebagai bukti saat
		// merekonsiliasi selisih pembukuan.
		attribute.Int64("payment.amount_minor", jumlahSen),
	)

	if tenant := baggage.FromContext(ctx).Member("tenant_id").Value(); tenant != "" {
		span.SetAttributes(attribute.String("tenant.id", tenant))
	}

	if jumlahSen <= 0 {
		err := fmt.Errorf("jumlah pembayaran tidak valid: %d", jumlahSen)
		span.RecordError(err)
		span.SetStatus(codes.Error, "validasi pembayaran gagal")
		return err
	}

	span.AddEvent("memanggil API bank")
	if err := p.panggilBank(ctx, idPesanan); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "panggilan bank gagal")
		return err
	}

	// SENGAJA TIDAK memanggil span.SetStatus(codes.Ok, ...).
	//
	// Menurut spesifikasi OTel, status Ok bersifat FINAL: setelah diset, setiap
	// percobaan berikutnya untuk mengubahnya diabaikan. Menyetelnya di sini
	// membuat lapisan di atas — otelhttp yang menandai 5xx, interceptor yang
	// menangkap panic — tidak lagi bisa menandai span ini gagal. Status Unset
	// sudah diperlakukan sebagai sukses oleh backend mana pun.
	return nil
}

func (p *ProsesorPembayaran) panggilBank(ctx context.Context, idPesanan string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.bankURL, nil)
	if err != nil {
		return fmt.Errorf("bangun request bank: %w", err)
	}
	req.Header.Set("Idempotency-Key", idPesanan)

	resp, err := p.klien.Do(req)
	if err != nil {
		return fmt.Errorf("panggil bank: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode >= 400 {
		return fmt.Errorf("bank menolak: %d", resp.StatusCode)
	}
	return nil
}

// TracedHTTPClient membungkus transport dengan otelhttp sehingga header W3C
// ter-inject dan span klien terbentuk otomatis.
//
// Transport-nya milik sendiri, BUKAN http.DefaultTransport: batas bawaan
// MaxIdleConnsPerHost=2 membuat panggilan ke satu host hilir membuka-tutup
// koneksi terus-menerus di bawah beban.
func TracedHTTPClient() *http.Client {
	tr := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 100,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 5 * time.Second,
	}
	return &http.Client{
		Transport: otelhttp.NewTransport(tr),
		Timeout:   10 * time.Second,
	}
}
```

```go
package tracing

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// tracerUji memasang TracerProvider SINKRON berbasis memori, lalu memulihkan
// provider global lewat t.Cleanup.
//
// Dua hal yang diperbaiki sekaligus. Pertama, uji lama menembak
// "localhost:4317" — bergantung pada ada-tidaknya collector di mesin penguji.
// Kedua, uji lama memanggil otel.SetTracerProvider dan TIDAK pernah
// memulihkannya, sehingga setiap uji sesudahnya berjalan di atas provider yang
// sudah di-shutdown, dan hasilnya bergantung urutan eksekusi.
func tracerUji(t *testing.T) *tracetest.InMemoryExporter {
	t.Helper()
	exp := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exp))

	sebelumnya := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	t.Cleanup(func() {
		if err := tp.Shutdown(context.Background()); err != nil {
			t.Errorf("shutdown tp uji: %v", err)
		}
		otel.SetTracerProvider(sebelumnya)
	})
	return exp
}

func cariSpan(t *testing.T, exp *tracetest.InMemoryExporter, nama string) tracetest.SpanStub {
	t.Helper()
	var ada []string
	for _, s := range exp.GetSpans() {
		if s.Name == nama {
			return s
		}
		ada = append(ada, s.Name)
	}
	t.Fatalf("span %q tidak ditemukan; yang terekam: %v", nama, ada)
	return tracetest.SpanStub{}
}

// Membuktikan Anti-Pattern 3 benar-benar ditangani. Versi lama uji ini hanya
// memeriksa `err != nil` — status span, yang menjadi inti seluruh berkas,
// tidak pernah diperiksa sama sekali.
func TestSpanDitandaiGagalSaatValidasiGagal(t *testing.T) {
	exp := tracerUji(t)

	p := NewProsesorPembayaran("http://tidak-dipakai.invalid")
	if err := p.Proses(context.Background(), "ord-123", -5000); err == nil {
		t.Fatal("mau galat untuk jumlah negatif, dapat nil")
	}

	span := cariSpan(t, exp, "ProsesPembayaran")
	if span.Status.Code != codes.Error {
		t.Fatalf("status span = %v, mau Error", span.Status.Code)
	}
	if len(span.Events) == 0 {
		t.Fatal("RecordError tidak menghasilkan event apa pun")
	}
}

// Menegakkan aturan yang paling mudah dilanggar tanpa sadar: jalur sukses
// TIDAK boleh menyetel codes.Ok, karena Ok bersifat final dan mengunci span
// dari penandaan galat oleh lapisan di atasnya.
func TestJalurSuksesMembiarkanStatusUnset(t *testing.T) {
	exp := tracerUji(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	p := NewProsesorPembayaran(srv.URL)
	if err := p.Proses(context.Background(), "ord-1", 10_000); err != nil {
		t.Fatalf("Proses: %v", err)
	}

	span := cariSpan(t, exp, "ProsesPembayaran")
	if span.Status.Code != codes.Unset {
		t.Fatalf("status = %v, mau Unset — codes.Ok final dan mengunci span dari penandaan galat", span.Status.Code)
	}
	// otelhttp WAJIB menghasilkan span anak untuk panggilan keluar; kalau tidak,
	// header W3C juga tidak ter-inject dan trace putus di batas ini.
	if len(exp.GetSpans()) < 2 {
		t.Fatalf("span terekam = %d, mau ≥2 (induk + span klien otelhttp)", len(exp.GetSpans()))
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengabaikan Trace Context (Leak Trace)
**Mengapa berbahaya:** Jika Anda tidak meneruskan `context.Context` dari request awal (seperti parameter `r.Context()` di handler HTTP) dan malah menggunakan `context.Background()`, layanan tracing tidak bisa mengaitkan rentang eksekusi baru ke *parent* trace yang datang dari jaringan. Trace akan terputus, menciptakan banyak *orphan trace* yang terpisah dan mengaburkan jejak bottleneck sejati.

```go
// BAD: context.Background() memutus rantai W3C TraceContext
func (s *Service) HandleDB(r *http.Request) error {
    ctx, span := s.tracer.Start(context.Background(), "QueryDB")
    defer span.End()
    return s.repo.Ambil(ctx)
}
```

```go
// GOOD: melanjutkan context yang sudah membawa span induk
func (s *Service) HandleDB(r *http.Request) error {
    ctx, span := s.tracer.Start(r.Context(), "QueryDB")
    defer span.End()
    return s.repo.Ambil(ctx)
}
```

> Perhatikan `ctx` benar-benar **dipakai** di kedua potongan. Menulis `ctx, span := tracer.Start(...)` lalu tidak memakai `ctx` bukan sekadar tidak rapi — Go menolaknya sebagai `declared and not used`, dan itu justru pertanda konteksnya memang tidak diteruskan ke mana-mana: span berikutnya akan lahir yatim.

### ❌ Anti-Pattern 2: PII Data Leakage di Span Attributes
**Mengapa berbahaya:** Span Attributes dan Event secara *default* akan dikirim dalam format plain-text JSON/protobuf dan disimpan ke sistem *observability backend* yang biasanya memiliki akses terbuka bagi semua engineer. Menyimpan *Personally Identifiable Information* (PII) atau rahasia sensitif dapat melanggar PCI-DSS, GDPR, dan UU PDP.

```go
// BAD: Membocorkan data otentikasi dan identitas sensitif
span.SetAttributes(
    attribute.String("user.password", req.Password),
    attribute.String("user.credit_card", req.CreditCardNumber),
)
```

```go
// GOOD: Gunakan masker atau referensi tidak langsung
span.SetAttributes(
    attribute.String("user.id", req.UserID),
    attribute.Bool("payment.method.is_saved_card", true),
)
```

### ❌ Anti-Pattern 3: Lupa Memanggil `span.SetStatus()` Saat Error
**Mengapa berbahaya:** Jika terjadi kegagalan (misalnya database timeout) namun kita hanya mereturn `error` Go tanpa mengatur status span secara eksplisit (`span.SetStatus(codes.Error, ...)`), sistem tracing backend tidak tahu bahwa span ini gagal. Sistem akan menampilkannya sebagai *success span*, menyamarkan *error rate* sesungguhnya pada dashboard SRE/DevOps.

```go
// BAD: Lupa set status error, backend anggap sukses.
if err != nil {
    span.RecordError(err) // Tidak cukup! Ini hanya mencatat event, tidak mengubah status akhir.
    return err
}
```

```go
// GOOD: eksplisit mengubah status ke Error
if err != nil {
    span.RecordError(err)                      // detail lengkap masuk ke event
    span.SetStatus(codes.Error, "query gagal") // deskripsi STABIL, bukan err.Error()
    return err
}
```

Dua catatan yang melengkapi aturan ini:

- **Deskripsi status sebaiknya kalimat tetap, bukan `err.Error()`.** Detail galat sudah dibawa `RecordError` sebagai event. Menyalin galat mentah ke deskripsi menghasilkan nilai berkardinalitas tinggi yang sulit dikelompokkan di backend, dan sering ikut menyeret isi query atau nama host — persis yang dilarang Anti-Pattern 2.
- **Jangan menyetel `codes.Ok` di jalur sukses.** Kebalikan dari anti-pattern ini punya jebakannya sendiri: menurut spesifikasi OTel, status `Ok` bersifat **final** — setelah diset, percobaan berikutnya untuk mengubahnya diabaikan. Middleware di lapisan atas (`otelhttp` yang menandai 5xx, interceptor penangkap panic) jadi tidak bisa lagi menandai span itu gagal. Biarkan `Unset`; backend memperlakukannya sebagai sukses.

## Edge Cases & Defensive Programming

1. **Tracer Shutdown Blocking**: Ketika aplikasi menerima sinyal pemutusan `SIGTERM`, OTel Tracer harus di-*shutdown* dengan baik (`tp.Shutdown(ctx)`) agar trace di buffer di-flush secara aman. Jika tidak diberi timeout ketat (`context.WithTimeout`), koneksi *backend* OTLP yang terganggu bisa membuat proses shutdown menggantung selamanya (hang), menahan rilis deployment Kubernetes.
2. **Cardinality Explosion pada Event/Attributes**: Menambahkan string hasil bangkitan (seperti nilai ID unik, nama file dinamis) sebagai *key* (nama) atribut alih-alih sebagai nilai (value) sangat berbahaya. Backend tracing sering membuat index berdasarkan keys. Ratusan ribu unique keys akan menyebabkan *Out of Memory* dan *cardinality explosion* di backend (seperti Prometheus dan Tempo). Pastikan key atribut itu statis dan finite (contoh: `attribute.String("item.id", "xyz-123")` adalah benar, sementara `attribute.String("item.xyz-123", "exists")` adalah salah besar).
3. **Baggage Overhead Besar**: W3C Baggage terus diturunkan (*propagated*) melalui HTTP header ke setiap *downstream service* dan disertakan dalam payload request. Menjejalkan terlalu banyak isi ke dalam baggage akan meledakkan payload *Header* hingga melampaui limit 8KB web server standar, menghasilkan error `431 Request Header Fields Too Large` yang sporadis. Gunakan seperlunya untuk data metadata kritis multi-hop (misalnya `tenant_id` atau `experiment_id`).
4. **Context Cancellation di Background Job — `context.WithoutCancel` adalah jawabannya**: goroutine latar yang menerima `r.Context()` akan melihat context-nya dibatalkan begitu respons HTTP terkirim. Span anak yang dimulai sesudah itu ikut tercemar, dan pekerjaannya sendiri berhenti di tengah. Sejak **Go 1.21** ada jawaban tepat di pustaka standar:

   ```go
   go func() {
       // Mewarisi SELURUH nilai — span induk, baggage, ID korelasi —
       // tetapi TIDAK mewarisi pembatalannya.
       ctx := context.WithoutCancel(r.Context())
       ctx, batal := context.WithTimeout(ctx, 30*time.Second) // batas waktu SENDIRI
       defer batal()

       ctx, span := tracer.Start(ctx, "kirim-email-resi")
       defer span.End()
       // ...
   }()
   ```

   Yang keliru dilakukan orang di sini adalah memakai `context.Background()`: pekerjaannya memang berjalan, tapi rantai trace-nya putus dan span-nya jadi yatim — persis Anti-Pattern 1. `WithoutCancel` memutus pembatalan **tanpa** memutus konteks. Tetap beri batas waktu sendiri; tanpa itu goroutine tersebut tidak punya penghenti sama sekali.

## Kapan JANGAN Pakai Ini

- **Sampling 100% pada layanan bertrafik tinggi.** Biaya penyimpanan dan jaringan naik linear, sementara nilai tambah trace ke-satu-juta mendekati nol. Pakai rasio head sampling, atau tail-based sampling yang selalu menyimpan trace bergalat dan yang lambat.
- **Span untuk setiap fungsi.** Trace berisi 500 span tidak bisa dibaca manusia dan membebani collector. Beri span pada **batas**: HTTP, gRPC, query database, publikasi/konsumsi antrean, panggilan pihak ketiga.
- **Tracing sebagai pengganti metrik.** Trace menjawab "kenapa permintaan **ini** lambat"; metrik menjawab "berapa banyak yang lambat". Alert dibangun di atas metrik, bukan trace.
- **Atribut span berkardinalitas tak terbatas untuk hal yang seharusnya jadi metrik.** Backend trace memang menampungnya — biayanya muncul di tagihan, bukan sebagai galat, sehingga tidak ada yang menyadarinya sampai akhir bulan.
- **Tanpa memastikan propagator disetel di semua sisi.** Trace yang terputus lebih menyesatkan daripada tidak ada trace sama sekali: ia tampak lengkap padahal separuh perjalanannya hilang.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Trace berhenti di batas layanan tertentu | propagator di layanan itu | `otel.SetTextMapPropagator` tidak dipasang seragam |
| Banyak trace hanya berisi satu span | rasio span per trace | Konteks tidak diteruskan; tiap layanan memulai trace baru |
| Span hilang saat trafik puncak | metrik eksportir | Antrean batch penuh; span dijatuhkan diam-diam |
| Tidak ada trace untuk permintaan yang gagal | strategi sampling | Head sampling membuang justru yang paling perlu dilihat |
| Biaya observabilitas melonjak | jumlah span per permintaan | Instrumentasi terlalu halus |
| Volume trace melonjak dari satu sumber saja | flag sampled pada `traceparent` masuk | Klien memaksa sampling di tepi publik |
| Span gagal muncul sebagai sukses | apakah jalur sukses menyetel `codes.Ok` | `Ok` bersifat final; lapisan atas tidak bisa lagi menandainya galat |

```bash
# Trace yang hanya berisi satu span = konteks tidak merambat
curl -s "$JAEGER/api/traces?service=api&limit=50" \
  | jq '[.data[] | select((.spans|length)==1)] | length'

# Span terlama dalam satu trace
curl -s "$JAEGER/api/traces/$TRACE_ID" \
  | jq -r '.data[0].spans | sort_by(-.duration)[:5][] | "\(.duration/1000)ms \(.operationName)"'

# Collector menjatuhkan atau gagal mengirim
curl -s localhost:8888/metrics | grep -E 'otelcol_processor_dropped|otelcol_exporter_send_failed'
kubectl logs -l app=api --since=1h | grep -c 'failed to export'
```
