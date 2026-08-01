# OpenTelemetry Tracing & Metrics di Rust Microservices

## Deskripsi dan Konsep Utama
Observability adalah pondasi utama dalam microservices. OpenTelemetry (OTel) memberikan standar untuk Traces, Metrics, dan Logs. Integrasi OTel SDK di Rust (menggunakan `opentelemetry-otlp`) memungkinkan kita mengekspor data telemetri ke collector (seperti Jaeger, Prometheus). Tracing span correlation, khususnya menggunakan `X-Request-ID`, memastikan bahwa perjalanan request melintasi beberapa services dapat dilacak secara koheren. Prometheus RED (Rate, Errors, Duration) metrics digunakan untuk mengukur *health* service.

## Arsitektur & Flow (ASCII Diagram)
```text
[Client] --(HTTP/gRPC)--> [Tower Layer: Trace / Metrics] 
                                    | 
                             (Extrapolate X-Request-ID)
                                    v
                           [Axum / Tonic Handler]
                            |                  |
                       [Tracing Span]     [OTel Meter]
                            |                  |
                     (OTLP Exporter)   (Prometheus Exporter)
                            |                  |
                            v                  v
                   [Jaeger/Zipkin]     [Prometheus Scraper]
```

## Implementasi Produksi (Rust)
```rust
use axum::{
    body::Body,
    http::Request,
    response::Response,
    routing::get,
    Router,
};
use opentelemetry::{
    global,
    metrics::{Counter, Histogram},
    KeyValue,
};
use std::{net::SocketAddr, time::Instant};
use tower::{Layer, Service};
use tracing::{info, instrument, span, Level};
use tracing_subscriber::{layer::SubscriberExt, Registry};
use core::task::{Context, Poll};
use futures_util::future::BoxFuture;

// Komponen Metrics
#[derive(Clone)]
pub struct HttpMetrics {
    pub requests_total: Counter<u64>,
    pub request_duration: Histogram<f64>,
}

impl HttpMetrics {
    pub fn new() -> Self {
        let meter = global::meter("http_service");
        Self {
            requests_total: meter
                .u64_counter("http_requests_total")
                .with_description("Total HTTP requests")
                .init(),
            request_duration: meter
                .f64_histogram("http_request_duration_seconds")
                .with_description("HTTP request duration in seconds")
                .init(),
        }
    }
}

// Middleware Tower untuk OTel
#[derive(Clone)]
pub struct TelemetryMiddleware<S> {
    inner: S,
    metrics: HttpMetrics,
}

impl<S, ReqBody, ResBody> Service<Request<ReqBody>> for TelemetryMiddleware<S>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>> + Clone + Send + 'static,
    S::Future: Send + 'static,
    ReqBody: Send + 'static,
    ResBody: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = BoxFuture<'static, Result<Self::Response, Self::Error>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<ReqBody>) -> Self::Future {
        let metrics = self.metrics.clone();
        let clone = self.inner.clone();
        let mut inner = std::mem::replace(&mut self.inner, clone);
        
        // Ambil Request ID
        let req_id = req
            .headers()
            .get("x-request-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("unknown_id")
            .to_string();

        let span = tracing::info_span!("http_request", request_id = %req_id, path = %req.uri().path());

        Box::pin(async move {
            let start = Instant::now();
            let _enter = span.enter();
            
            let response = inner.call(req).await;
            
            let duration = start.elapsed().as_secs_f64();
            let status = match &response {
                Ok(res) => res.status().as_u16().to_string(),
                Err(_) => "500".to_string(),
            };

            let labels = [
                KeyValue::new("status", status),
                KeyValue::new("request_id", req_id),
            ];

            metrics.requests_total.add(1, &labels);
            metrics.request_duration.record(duration, &labels);

            response
        })
    }
}

pub struct TelemetryLayer {
    metrics: HttpMetrics,
}

impl<S> Layer<S> for TelemetryLayer {
    type Service = TelemetryMiddleware<S>;

    fn layer(&self, inner: S) -> Self::Service {
        TelemetryMiddleware {
            inner,
            metrics: self.metrics.clone(),
        }
    }
}

#[instrument(skip_all, fields(worker_id = 42))]
async fn process_data() -> &'static str {
    info!("Processing data internally");
    "Data processed"
}

pub fn build_router() -> Router {
    let metrics = HttpMetrics::new();
    Router::new()
        .route("/process", get(process_data))
        .layer(TelemetryLayer { metrics })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    #[tokio::test]
    async fn test_telemetry_layer() {
        let app = build_router();
        
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/process")
                    .header("x-request-id", "test-12345")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status().as_u16(), 200);
    }
}
```

## Anti-Patterns

1. **Memblokir OTLP Exporter di Main Thread**: Menginisiasi *OTLP exporter pipeline* secara *synchronous* atau tanpa buffer yang cukup. 
   *Mengapa berbahaya*: Timeout dari collector akan memblokir *async executor*, menunda HTTP response aplikasi secara total.
2. **Cardinality Ledakan di Metrics (High Cardinality)**: Menggunakan user ID, UUID, atau parameter URL dinamis langsung ke sebagai label Prometheus di *metrics*.
   *Mengapa berbahaya*: Prometheus akan mengalokasikan time series baru per label unik, menyebabkan OOM (Out of Memory) pada metrics server dan aplikasi Rust sendiri karena struktur hash map yang membengkak.

## Edge Cases & Defensive Programming

1. **Trace Context Hilang di Boundary Task Baru**: Saat men-spawn task dengan `tokio::spawn`, *tracing context* (Span saat ini) tidak ikut secara default. Solusinya, gunakan `Instrument::instrument` atau `in_current_span()` dari `tracing` crate untuk mengikat span induk ke future task yang berjalan di *background*.
2. **Clock Skew pada Durasi Histogram**: Waktu (Instant) yang melompat karena sinkronisasi NTP server (NTP adjustments). Meskipun `Instant::elapsed` di Rust dijamin monotonic, jeda saat sistem tertidur (*suspend*) bisa memperpanjang durasi secara anomali, yang memicu P99 alert di observability (Padahal bukan salah request).
3. **Trace Header Malformed**: Jika *upstream proxy* mengirimkan trace context yang invalid secara spek W3C (contohnya `traceparent` tidak lengkap), parser dapat panik atau gagal *silently*. Crate telemetri harus diset untuk menolerir kesalahan ini dengan membuat root span baru.
