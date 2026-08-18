# Rate Limiting: Token-Bucket dengan `tower-governor`

## Deskripsi dan Konsep Utama
Rate limiting krusial untuk mencegah penyalahgunaan (DDoS, brute-force, scraping) dan memastikan *fair usage*. Menggunakan algoritma *Token Bucket* (via crate `governor`), kita dapat mengatur batas *burst* dan *sustained rate* per-client (berdasarkan IP, API Key, atau session token). Integrasi di Rust biasanya dilakukan sebagai layer *middleware* via `tower-governor`, memungkinkan penolakan (HTTP 429 Too Many Requests) terjadi bahkan sebelum request mencapai *routing logic* atau *handler*, sehingga menghemat *compute resources* secara drastis.

## Arsitektur & Flow (ASCII Diagram)
```text
     [HTTP Request]
           |
           v
 [Tower Rate Limit Layer]
           |
     [Extract Key (IP/Key)]
           |
           v
 +-----------------------+
 |   Token Bucket State  |  <--- Check quota (Governor)
 +-----------------------+       (In-Memory / Redis)
           |
   [Rate Limit Exceeded?]
     /              \
 [YES]              [NO]
   |                  |
   v                  v
[Return 429]     [Axum Router]
                 [Handler Logic]
```

## Implementasi Produksi (Rust)
```rust
use axum::{
    error_handling::HandleErrorLayer,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use governor::{quota::Quota, clock::DefaultClock, state::keyed::DefaultKeyedStateStore};
use std::{net::IpAddr, num::NonZeroU32, sync::Arc, time::Duration};
use tower::{BoxError, ServiceBuilder};
use tower_governor::{
    errors::display_error,
    governor::GovernorConfigBuilder,
    key_extractor::{KeyExtractor, SmartIpKeyExtractor},
    GovernorLayer,
};

// Custom Extractor untuk Rate Limiting berdasarkan API Key di Header
#[derive(Clone)]
pub struct ApiKeyExtractor;

impl KeyExtractor for ApiKeyExtractor {
    type Key = String;
    
    // Fallback error, dalam konteks ini kita bypass jika extractor gagal,
    // tapi production sebaiknya diatasi secara hati-hati.
    type KeyExtractionError = &'static str;

    fn extract<B>(&self, req: &Request<B>) -> Result<Self::Key, Self::KeyExtractionError> {
        req.headers()
            .get("X-API-KEY")
            .and_then(|val| val.to_str().ok())
            .map(|s| s.to_string())
            .ok_or("Missing API Key")
    }
}

pub async fn target_handler() -> &'static str {
    "Rate limited handler success"
}

// Custom handler untuk 429 Error
fn custom_429_handler(err: BoxError) -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        format!("Rate limit exceeded: {}", err),
    )
        .into_response()
}

pub fn build_rate_limited_router() -> Router {
    // 5 request per detik per API Key
    let quota = Quota::per_second(NonZeroU32::new(5).unwrap());
    
    let governor_conf = Box::new(
        GovernorConfigBuilder::default()
            .per_second(5)
            .burst_size(5)
            .key_extractor(ApiKeyExtractor)
            .finish()
            .unwrap(),
    );

    let governor_layer = GovernorLayer {
        config: Box::leak(governor_conf),
    };

    Router::new()
        .route("/protected", get(target_handler))
        .layer(
            ServiceBuilder::new()
                .layer(HandleErrorLayer::new(custom_429_handler))
                .layer(governor_layer)
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    #[tokio::test]
    async fn test_rate_limiting_under_quota() {
        let app = build_rate_limited_router();
        
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/protected")
                    .header("X-API-KEY", "secret-key-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }
}
```

## Anti-Patterns

1. **Rate Limiting Sesudah Parsing Body**: Menempatkan middleware rate limit di urutan setelah layer `BodyParser` atau dekompresi data.
   *Mengapa berbahaya*: Attacker tetap bisa membebankan CPU dan Memory server dengan payload raksasa yang di-decode, padahal ujung-ujungnya request ditolak. Middleware rate limit wajib ditaruh paling depan dari pipeline.
2. **Local Bucket di Distribusi Horizontal**: Menggunakan *in-memory* state (`governor` lokal) di deployment yang melibatkan puluhan pod Kubernetes (horizontal scaling). 
   *Mengapa berbahaya*: Rate limit tidak konsisten. Jika client diizinkan 5 req/sec, dan ada 10 pod, client bisa mengirim 50 req/sec karena bucket tidak sinkron (shared). Harus menggunakan Redis-backed rate limiter untuk sistem terdistribusi.

## Edge Cases & Defensive Programming

1. **Spoofing Header Client IP / Key**: Extractor default `X-Forwarded-For` sangat mudah di-spoof oleh *malicious actor* dengan mengirim request HTTP palsu jika tidak dibersihkan (*sanitized*) oleh reverse proxy terdepan (seperti Nginx atau Cloudflare).
2. **OOM dari Token Bucket Maps**: Menyimpan bucket state untuk setiap IP address *unique* (jutaan *botnet* IP). Dalam *in-memory datastore*, ini berarti alokasi `HashMap` raksasa yang terus tumbuh, memicu OOM (Out Of Memory). Perlu implementasi *LRU cache eviction* atau *Time-To-Live* (TTL) state untuk membuang entri lama dari bucket memori.
3. **Deadlock saat Mutex Contention Rate Limiter**: Redis connection pool dari limiter kustom terhenti. Pastikan timeout Redis sangat singkat (< 10ms). Jika limit-check lebih lambat dari request aslinya, limiter malah menjadi *bottleneck* performa aplikasi (*Fail Open* vs *Fail Closed* strategy perlu dipertimbangkan, misal biarkan request lewat jika Redis mati, untuk menjaga *availability*).
