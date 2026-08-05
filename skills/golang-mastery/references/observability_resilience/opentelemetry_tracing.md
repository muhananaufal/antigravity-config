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
	"fmt"
	"net/http"
	"testing"
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
)

// InitTracerProvider melakukan inisialisasi exporter OTLP gRPC dan mengonfigurasi global TracerProvider.
func InitTracerProvider(ctx context.Context, serviceName string, otlpEndpoint string) (*sdktrace.TracerProvider, error) {
	// Definisi metadata service
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(serviceName),
			semconv.ServiceVersion("1.0.0"),
			semconv.DeploymentEnvironment("production"),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to construct resource: %w", err)
	}

	// Inisialisasi Exporter ke Collector
	exporter, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(otlpEndpoint),
		otlptracegrpc.WithInsecure(), // Gunakan WithTLSCredentials di production sesungguhnya!
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create otlp exporter: %w", err)
	}

	// Konfigurasi Sampler: Rekam 10% dari total trace, tetapi SELALU ikuti keputusan upstream
	// (Jika service upstream bilang "sample ini", maka akan direkam meskipun di luar kuota 10%)
	sampler := sdktrace.ParentBased(sdktrace.TraceIDRatioBased(0.1))

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sampler),
	)

	// Register konfigurasi ke Global OTel instance
	otel.SetTracerProvider(tp)
	
	// Set propagator standar (TraceContext W3C + Baggage)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, 
		propagation.Baggage{},
	))

	return tp, nil
}

// ProcessPayment mengeksekusi logika domain dalam konteks tracing.
func ProcessPayment(ctx context.Context, orderID string, amount float64) error {
	// Dapatkan tracer global (nama sebaiknya sesuai package/komponen)
	tracer := otel.Tracer("finance/payment-processor")

	// Mulai Child Span berdasarkan Context
	ctx, span := tracer.Start(ctx, "ProcessPayment", trace.WithSpanKind(trace.SpanKindInternal))
	
	// SELALU gunakan defer untuk End(). 
	defer span.End()

	// Tempel atribut bisnis
	span.SetAttributes(
		attribute.String("order.id", orderID),
		attribute.Float64("payment.amount", amount), // Asumsi ilustrasi, aslinya jangan gunakan float64 untuk uang.
	)

	// Tarik data dari Baggage (bila di-inject oleh upstream)
	b := baggage.FromContext(ctx)
	if tenant := b.Member("tenant_id"); tenant.Value() != "" {
		span.SetAttributes(attribute.String("tenant.id", tenant.Value()))
	}

	// Log event di dalam timeline span
	span.AddEvent("Calling bank API", trace.WithAttributes(
		attribute.String("bank.name", "Bank_ABC"),
	))

	// Simulasi I/O
	time.Sleep(50 * time.Millisecond)

	// Validasi & Error Handling
	if amount <= 0 {
		err := fmt.Errorf("invalid payment amount: %f", amount)
		
		// Rekam error secara eksplisit ke dalam tracer
		span.RecordError(err)
		
		// WAJIB: Set status menjadi Error, agar backend (Jaeger/Tempo) mewarnai span ini merah muda.
		span.SetStatus(codes.Error, "Payment validation failed")
		
		return err
	}

	// Status implisit OK jika tidak di-set Error, tapi eksplisit OK juga aman.
	span.SetStatus(codes.Ok, "Success")
	return nil
}

// TracedHTTPClient memberikan http.Client yang otomatis meng-inject W3C headers 
// dan merekam span untuk outgoing requests.
func TracedHTTPClient() *http.Client {
	return &http.Client{
		Transport: otelhttp.NewTransport(http.DefaultTransport),
		Timeout:   10 * time.Second,
	}
}

// --- Unit Tests ---

func TestInitTracerProvider(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	tp, err := InitTracerProvider(ctx, "test-service", "localhost:4317")
	if err != nil {
		t.Fatalf("Failed to initialize tracer: %v", err)
	}
	defer func() {
		// Shutdown memflush semua batch trace terakhir, gunakan timeout
		if err := tp.Shutdown(ctx); err != nil {
			t.Errorf("Shutdown failed: %v", err)
		}
	}()

	if otel.GetTracerProvider() != tp {
		t.Errorf("Global TracerProvider did not set properly")
	}
}

func TestProcessPayment_ErrorStatus(t *testing.T) {
	ctx := context.Background()
	tracer := otel.Tracer("test-tracer")
	ctx, span := tracer.Start(ctx, "TestRoot")
	defer span.End()

	// Trigger error
	err := ProcessPayment(ctx, "ord-123", -50.0)
	if err == nil {
		t.Error("Expected error, got nil")
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengabaikan Trace Context (Leak Trace)
**Mengapa berbahaya:** Jika Anda tidak meneruskan `context.Context` dari request awal (seperti parameter `r.Context()` di handler HTTP) dan malah menggunakan `context.Background()`, layanan tracing tidak bisa mengaitkan rentang eksekusi baru ke *parent* trace yang datang dari jaringan. Trace akan terputus, menciptakan banyak *orphan trace* yang terpisah dan mengaburkan jejak bottleneck sejati.

```go
// BAD: Menggunakan context.Background() memutus rantai W3C TraceContext
func (s *Service) HandleDB(r *http.Request) {
    ctx, span := s.tracer.Start(context.Background(), "QueryDB")
    defer span.End()
    // ...
}
```

```go
// GOOD: Melanjutkan context yang ada
func (s *Service) HandleDB(r *http.Request) {
    ctx, span := s.tracer.Start(r.Context(), "QueryDB")
    defer span.End()
    // ...
}
```

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
// GOOD: Eksplisit mengubah status ke Error
if err != nil {
    span.RecordError(err)
    span.SetStatus(codes.Error, err.Error())
    return err
}
```

## Edge Cases & Defensive Programming

1. **Tracer Shutdown Blocking**: Ketika aplikasi menerima sinyal pemutusan `SIGTERM`, OTel Tracer harus di-*shutdown* dengan baik (`tp.Shutdown(ctx)`) agar trace di buffer di-flush secara aman. Jika tidak diberi timeout ketat (`context.WithTimeout`), koneksi *backend* OTLP yang terganggu bisa membuat proses shutdown menggantung selamanya (hang), menahan rilis deployment Kubernetes.
2. **Cardinality Explosion pada Event/Attributes**: Menambahkan string hasil bangkitan (seperti nilai ID unik, nama file dinamis) sebagai *key* (nama) atribut alih-alih sebagai nilai (value) sangat berbahaya. Backend tracing sering membuat index berdasarkan keys. Ratusan ribu unique keys akan menyebabkan *Out of Memory* dan *cardinality explosion* di backend (seperti Prometheus dan Tempo). Pastikan key atribut itu statis dan finite (contoh: `attribute.String("item.id", "xyz-123")` adalah benar, sementara `attribute.String("item.xyz-123", "exists")` adalah salah besar).
3. **Baggage Overhead Besar**: W3C Baggage terus diturunkan (*propagated*) melalui HTTP header ke setiap *downstream service* dan disertakan dalam payload request. Menjejalkan terlalu banyak isi ke dalam baggage akan meledakkan payload *Header* hingga melampaui limit 8KB web server standar, menghasilkan error `431 Request Header Fields Too Large` yang sporadis. Gunakan seperlunya untuk data metadata kritis multi-hop (misalnya `tenant_id` atau `experiment_id`).
4. **Context Cancellation di Background Job**: Jika handler utama memutar *goroutine* baru untuk *background processing* dan memberikan context asli (`r.Context()`), context tersebut akan ter-*cancel* otomatis segera setelah *HTTP Response* dikirim. Upaya mengekspor *child span* pada *background job* menggunakan context yang batal itu berisiko gagal dikirim. Jika diperlukan background span, putuskan rantai context tanpa kehilangan parent span melalui utilitas context kustom (atau gunakan tracer Start terpisah).

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
