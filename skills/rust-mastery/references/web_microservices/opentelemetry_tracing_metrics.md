# OpenTelemetry, Tracing, & Metrics

## Konsep Utama
Observability adalah pilar microservices (Logs, Metrics, Traces). Dalam Rust, crate `tracing` digunakan sebagai fasad standar untuk merekam event, dan `opentelemetry` digunakan untuk mengekspor data ke kolektor terdistribusi (seperti Jaeger, Zipkin, atau Prometheus) dalam format OTLP.
- **Trace & Spans:** Mewakili masa hidup sebuah operasi (seperti 1 HTTP Request).
- **Span Context Propagation:** Teknik meneruskan `TraceId` di HTTP Headers (W3C TraceContext: `traceparent`) sehingga layanan A dan layanan B terlihat dalam satu trace yang sama.
- **Metrics:** Pengukuran numerik untuk *Dashboarding* dan *Alerting* (seperti HTTP req count, latency P99).

**Kapan Digunakan:**
- Investigasi kemacetan (bottlenecks) dalam pemanggilan lintas microservices.
- Pemonitoran kesehatan aplikasi (SLO/SLA dashboard) via Grafana.

## Arsitektur & Flow

```ascii
+----------------+      W3C Trace Header      +----------------+
| Microservice A | -------------------------> | Microservice B |
+-------+--------+                            +--------+-------+
        |  Otlp Exporter (gRPC)                        |
        v                                              v
+-------------------------------------------------------------+
| OpenTelemetry Collector / Jaeger                            |
+-------------------------------------------------------------+
```

## Production-Ready Code

```rust
use axum::{routing::get, Router};
use opentelemetry::{global, KeyValue};
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::{trace as sdktrace, Resource};
use tracing::{info, instrument};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, Registry};

// 1. Inisialisasi OpenTelemetry Tracer (ke Collector)
pub fn init_tracer() {
    let tracer = opentelemetry_otlp::new_pipeline()
        .tracing()
        .with_exporter(
            opentelemetry_otlp::new_exporter()
                .tonic()
                .with_endpoint("http://localhost:4317"), // OTLP gRPC endpoint
        )
        .with_trace_config(
            sdktrace::config().with_resource(Resource::new(vec![
                KeyValue::new("service.name", "my-microservice"),
            ])),
        )
        .install_batch(opentelemetry_sdk::runtime::Tokio)
        .expect("Gagal inisiasi OTLP tracer");

    let telemetry = tracing_opentelemetry::layer().with_tracer(tracer);

    // Setup logging ke stdout bersamaan dengan otlp traces
    let fmt_layer = tracing_subscriber::fmt::layer().json();

    Registry::default()
        .with(tracing_subscriber::EnvFilter::new("INFO"))
        .with(fmt_layer)
        .with(telemetry)
        .init();
}

// 2. Instrumentasi Fungsi menggunakan makro #[instrument]
// Secara otomatis membuat "Span" bernama "process_payment"
#[instrument(skip(credit_card_no), fields(payment.amount = amount))]
async fn process_payment(amount: f64, credit_card_no: &str) -> String {
    info!("Memulai proses pembayaran ke gateway eksternal");
    // Simulasi delay gateway
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    info!("Pembayaran berhasil");
    "SUCCESS".to_string()
}

pub fn app() -> Router {
    Router::new().route("/pay", get(|| async { 
        process_payment(150.0, "1234-5678-9876").await 
    }))
}

// Untuk flush on shutdown:
// opentelemetry::global::shutdown_tracer_provider();
```

## Anti-Patterns

1. **Memblokir Subscriber (Log I/O Berjalan Secara Sinkron)**
   - **MENGAPA BERBAHAYA:** Menulis log ke terminal (stdout) atau file secara sinkron (seperti `std::println!`) di dalam async handler menghambat thread. Selalu gunakan `tracing_appender::non_blocking` (dengan worker thread terpisah) untuk produksi yang padat traffic, jika melakukan filesystem logging.
2. **Kardinalitas Metrik yang Terlalu Tinggi (High Cardinality)**
   - **MENGAPA BERBAHAYA:** Menggunakan nilai unik per-request (seperti UUID User atau Session ID) sebagai 'Label/Tag' dalam sistem Metrik (Prometheus/StatsD). Ini akan menghabiskan memori TSDB seketika dan membuat instance Prometheus crash (karena setiap label kombinasi unik membuat time-series baru). Batasi label hanya pada finite enum (status code, method, route pattern).

## Edge Context & Defensive Programming
- **Header Extraction untuk Trace Terdistribusi:** Kode di atas baru menyetel tracer internal. Untuk *Menerima* trace ID dari layanan pemanggil sebelumnya, Anda harus membuat Middleware Tower (atau ekstrak dari header axum menggunakan `opentelemetry::global::get_text_map_propagator()`) lalu menjadikan span yang diekstrak sebagai parent dari span saat ini.
- **Graceful Flush Traces:** Batch exporter menyimpan trace di memori secara periodik. Pastikan menaruh `opentelemetry::global::shutdown_tracer_provider();` saat proses shutdown untuk mengeksekusi flush data yang ada di buffer, sebelum aplikasi benar-benar berhenti, sehingga trace terakhir (seperti penyebab crash) tidak hilang.
