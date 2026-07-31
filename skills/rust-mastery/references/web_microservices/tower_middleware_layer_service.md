# Tower Middleware, Layer, dan Service

## Konsep Utama
Dalam ekosistem Rust async HTTP (terutama `axum` dan `tonic`), **Tower** adalah fondasi untuk middleware. Konsep utamanya terdiri dari:
- `Service<Request>`: Trait asinkron yang menerima request dan mengembalikan response (atau error).
- `Layer<S>`: Trait untuk membungkus (decorate) sebuah `Service` yang sudah ada menjadi `Service` baru. Ini adalah pola *Decorator*.
- `ServiceBuilder`: Utilitas untuk menyusun tumpukan `Layer` secara berurutan.

Middleware digunakan untuk mengeksekusi logika silang (cross-cutting concerns) seperti logging, rate-limiting, timeout, atau modifikasi request/response headers sebelum mencapai handler yang sebenarnya.

**Kapan Digunakan:**
- Injeksi Request ID (`X-Request-Id`) pada setiap request masuk.
- Observability (Tracing, Metrik Prometheus).
- Global Timeout dan Panic Recovery.

## Arsitektur & Flow

```ascii
+----------------+      +----------------+      +----------------+
| Request        | ---> | Layer 1 (Log)  | ---> | Layer 2 (Auth) | --+
+----------------+      +----------------+      +----------------+   |
                                                                     v
+----------------+      +----------------+      +----------------+   |
| Response       | <--- | Layer 1 (Log)  | <--- | Layer 2 (Auth) | <-+
+----------------+      +----------------+      +----------------+
                                                         | (Inner Service)
```

## Production-Ready Code

```rust
use axum::{
    body::Body,
    http::{Request, Response},
    routing::get,
    Router,
};
use pin_project_lite::pin_project;
use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
    time::Instant,
};
use tower::{Layer, Service};

// 1. Definisikan Layer
#[derive(Clone)]
pub struct MetricsLayer;

impl<S> Layer<S> for MetricsLayer {
    type Service = MetricsService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        MetricsService { inner }
    }
}

// 2. Definisikan Service yang membungkus inner service
#[derive(Clone)]
pub struct MetricsService<S> {
    inner: S,
}

impl<S, ReqBody, ResBody> Service<Request<ReqBody>> for MetricsService<S>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>>,
    S::Future: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = MetricsFuture<S::Future>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        // Forward poll_ready ke inner service (Backpressure handling)
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<ReqBody>) -> Self::Future {
        let path = req.uri().path().to_owned();
        let method = req.method().clone();
        let start = Instant::now();

        // Panggil inner service
        let future = self.inner.call(req);

        MetricsFuture {
            future,
            path,
            method: method.to_string(),
            start,
        }
    }
}

// 3. Definisikan Future custom untuk mengeksekusi logika setelah response selesai
pin_project! {
    pub struct MetricsFuture<F> {
        #[pin]
        future: F,
        path: String,
        method: String,
        start: Instant,
    }
}

impl<F, ResBody, Error> Future for MetricsFuture<F>
where
    F: Future<Output = Result<Response<ResBody>, Error>>,
{
    type Output = F::Output;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.project();

        match this.future.poll(cx) {
            Poll::Ready(result) => {
                let duration = this.start.elapsed();
                // Observability / Metrics recording point
                let status = match &result {
                    Ok(res) => res.status().as_u16().to_string(),
                    Err(_) => "error".to_string(),
                };
                
                // Di produksi: rekam ke Prometheus
                println!(
                    "metrics: method={} path={} status={} duration_ms={}",
                    this.method,
                    this.path,
                    status,
                    duration.as_millis()
                );
                
                Poll::Ready(result)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

// Contoh integrasi dengan Axum
pub fn app() -> Router {
    Router::new()
        .route("/health", get(|| async { "OK" }))
        .layer(MetricsLayer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use tower::ServiceExt;

    #[tokio::test]
    async fn test_metrics_middleware() {
        let app = app();
        let response = app
            .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
```

## Anti-Patterns

1. **Memblokir Async Runtime di dalam `poll_ready` atau `call`**
   - **MENGAPA BERBAHAYA:** Fungsi `call` dan `poll_ready` berjalan secara sinkron di dalam *worker thread* Tokio yang mengeksekusi future saat itu. Melakukan I/O blocking (misal: baca file, query DB sinkron) di sini akan mematikan performa (thread starvation). Seluruh tugas I/O atau komputasi berat harus dikembalikan di dalam `Future` hasil dari `call`.
2. **Mengabaikan Backpressure (Tidak Memanggil `inner.poll_ready(cx)`)**
   - **MENGAPA BERBAHAYA:** Tower menggunakan `poll_ready` untuk backpressure. Jika Service custom Anda selalu mereturn `Poll::Ready` tanpa mengecek `inner.poll_ready(cx)`, Anda dapat mengirimkan beban ke service selanjutnya saat ia belum siap, menyebabkan Out Of Memory atau unhandled panics.

## Edge Cases & Defensive Programming
- **Service Cloneability:** Router axum membutuhkan service untuk mengimplementasikan `Clone` karena ia di-clone untuk setiap request connection. Jika Service kustom Anda memiliki state internal (seperti koneksi atau cache), pastikan dibungkus dengan `Arc`.
- **Response vs Request Modification Lifecycle:** Kadang pengembang secara keliru memanipulasi Body request di `call` yang sudah bersifat streaming. Memanipulasi *streaming body* memerlukan middleware khusus (misalnya `axum::middleware::map_request` dengan byte manipulation). Untuk kasus biasa, gunakan fungsi helper `axum::middleware::from_fn` jika implementasi trait raw `Service` terlalu rumit.
