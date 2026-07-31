# Rate Limiting dengan Governor & Tower

## Konsep Utama
Di lingkungan microservices, **Rate Limiting** mencegah abuse/DDoS dan melindungi infrastruktur backend (DB/Downstreams) dari traffic spikes.
Ekosistem Rust menyediakan crate `governor` (implementasi algoritma GCRA / Leaky Bucket yang sangat efisien, lock-free).
Dalam integrasinya dengan server HTTP (seperti Axum), crate pendukung `tower_governor` menyediakan middleware (Tower Layer) untuk mengekstrak informasi request (misal: IP address dari proxy), menghitung rate-limit, dan menghentikan request dengan membalas error **HTTP 429 Too Many Requests** beserta header standar rate-limit (`X-RateLimit-Limit`).

**Kapan Digunakan:**
- Perlindungan endpoint publik seperti Login/OTP dari *Brute Force*.
- Menjamin fair-usage di sistem SaaS (Tier limit berdasar API Key).

## Arsitektur & Flow

```ascii
+---------------+    +------------------------+    +---------------+
| HTTP Request  | -> | Tower_Governor (Layer) | -> | Route Handler |
+---------------+    +------------------------+    +---------------+
 (X-Forwarded)          |
                        v
                     Extract Key (IP) -> Hash
                        |
                        v GCRA Quota Check
                     [ Allowed ]  ====> (Teruskan ke Handler)
                     [ Denied  ]  ====> (Balas HTTP 429 + Retry-After)
```

## Production-Ready Code

```rust
use axum::{routing::get, Router};
use std::time::Duration;
use tower_governor::{governor::GovernorConfigBuilder, GovernorLayer};
use tower_governor::key_extractor::SmartIpKeyExtractor;

// Handler endpoint yang dilindungi
async fn sensitive_route() -> &'static str {
    "Hello! You are not rate-limited yet."
}

pub fn app() -> Router {
    // Setup konfigurasi Governor (misal, 5 requests per detik, per IP)
    // - per_second(5): replenishment (leak rate)
    // - burst_size(5): bucket size maximal (burst)
    // - SmartIpKeyExtractor: ekstrak IP dari header X-Forwarded-For atau X-Real-IP jika di-proxy.
    let governor_conf = GovernorConfigBuilder::default()
        .per_second(5)
        .burst_size(5)
        .key_extractor(SmartIpKeyExtractor)
        .finish()
        .unwrap();

    // Init router dengan middleware layer Governor
    Router::new()
        .route("/api/sensitive", get(sensitive_route))
        .layer(GovernorLayer {
            config: Box::new(governor_conf),
        })
}

// NOTE: SmartIpKeyExtractor butuh proper trust pada reverse proxy Anda,
// atau client dapat me-spoof "X-Forwarded-For".
// Untuk keamanan yang lebih rigid, gunakan crate `axum-client-ip` yang dikonfigurasi
// dengan trust mask IP load balancer.
```

## Anti-Patterns

1. **Rate Limit Berdasarkan `SocketAddr` Tanpa Parsing `X-Forwarded-For`**
   - **MENGAPA BERBAHAYA:** Di microservices (terutama kubernetes atau behind Nginx/Cloudflare), `SocketAddr` asli koneksi selalu berupa IP internal ingress loadbalancer (contoh `10.0.x.x`). Memakai ini sebagai kunci hashing akan merate-limit *semua traffic user* dari seluruh dunia (False Positive), karena dianggap berasal dari satu IP yang sama (si proxy).
2. **State Governor In-Memory di Arsitektur Multi-Instance / Auto Scaling**
   - **MENGAPA BERBAHAYA:** Crate `governor` default menggunakan memori instansi aplikasi (lokal). Jika Anda memiliki 10 instansi (pods) microservice, rate limit sesungguhnya adalah 10x lipat dari kuota karena state-nya tidak saling tersinkron. Untuk limit terdistribusi akurat (meski ada pinalti latensi I/O), butuh Redis (via rate limiter terpisah spt `redis-cell` atau algoritma Sliding Window Redis).

## Edge Context & Defensive Programming
- **Algoritma GCRA (Generic Cell Rate Algorithm):** GCRA jauh lebih mulus (smooth) daripada implementasi "Fixed Window" konvensional. Fixed Window bisa dimanipulasi dengan meledakkan request tepat di akhir jendela 1 menit, dan lagi tepat di awal detik pertama menit berikutnya (men-double burst traffic). GCRA memperhitungkan rentang kedatangan secara teoretis secara merata, menjadikannya standar industri.
- **Header Security Spoofing:** Saat membaca IP client yang di-proxy, penyerang bisa mengirim `X-Forwarded-For: 12.34.56.78` buatan sendiri ke Cloudflare Anda. Pastikan load balancer memvalidasi/me-reset header eksternal, atau konfigurasikan key extractor Anda untuk mengambil IP dari hop terakhir (Right-most IP) yang valid secara spesifikasi infrastruktur Anda, bukan IP paling kiri yang berpotensi *spoofed*.
