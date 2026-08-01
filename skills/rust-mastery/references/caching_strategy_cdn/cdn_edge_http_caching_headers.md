# Strategi Caching HTTP dan CDN Edge di Rust Server (Axum)

## Pendahuluan

Arsitektur performa tinggi tidak pernah tuntas di tingkat Caching In-Memory (L1) dan terdistribusi (L2). Lapis terakhir yang paling krusial untuk menurunkan beban egress jaringan adalah memindahkan lalu-lintas statis dan semi-statis sejauh mungkin dari *origin server* menuju *Edge/CDN* (L3 Caching) layaknya Cloudflare, Fastly, atau AWS CloudFront. 

Di ekosistem Rust modern (khususnya *framework* **Axum** dan lapisan **Tower**), orkestrasi header *Cache-Control* dan manajemen validasi via `ETag` dapat dikontrol secara presisi melalui *middleware* atau utilitas lapis-jaringan, menjamin propagasi semantik HTTP mutakhir (*Stale-While-Revalidate*, *Surrogate-Keys*).

## Arsitektur Caching L3 (Edge Content Delivery Network)

Bagan berikut memvisualisasikan bagaimana siklus validasi asinkron dan kebijakan Edge Cache terjadi antara Klien, Node CDN terdekat, dan Rust Origin Server (Axum).

```text
 +---------------+             +---------------------------+              +-----------------+
 |   Klien /     |             | CDN EDGE (Cloudflare dsb) |              | RUST ORIGIN     |
 |   Browser     |             |                           |              | (Axum Server)   |
 +-------+-------+             +-------------+-------------+              +--------+--------+
         |                                   |                                     |
         | 1. GET /api/v1/news (No-Cache)    |                                     |
         |---------------------------------->|                                     |
         |                                   | 2. Cache Miss! Forward Req          |
         |                                   |------------------------------------>|
         |                                   |                                     |
         |                                   | 3. Res: 200 OK                      |
         |                                   |    Cache-Control: public, max-age=60|
         |                                   |    ETag: "W/abcxyz123"              |
         |                                   |<------------------------------------|
         | 4. Res: 200 OK (Data)             |                                     |
         |<----------------------------------|                                     |
         |                                   |                                     |
         | 5. GET /api/v1/news (After 10s)   |                                     |
         |---------------------------------->|                                     |
         | 6. Res: 200 OK (Dari Cache CDN)   |                                     |
         |<----------------------------------|                                     |
         |                                   |                                     |
         | 7. GET /api/v1/news (After 61s)   | 8. Cache Stale! Revalidate          |
         |    If-None-Match: "W/abcxyz123"   |    If-None-Match: "W/abcxyz123"     |
         |---------------------------------->|------------------------------------>|
         |                                   |                                     |
         |                                   | 9. Res: 304 Not Modified            |
         |                                   |<------------------------------------|
         | 10. Res: 304 Not Modified         |                                     |
         |<----------------------------------|                                     |
```

## Implementasi Kode Produksi (Idiomatis)

Dalam kode *Axum*, pengaturan Header Cache dapat dilakukan secara *ad-hoc* di tiap Endpoint atau melalui Tower Middleware terpusat. Untuk keamanan skalabilitas, kita menggunakan trait `IntoResponse` untuk menanamkan kombinasi `Cache-Control`, `Vary`, dan manajemen `ETag`.

```rust
use axum::{
    http::{header, StatusCode, HeaderMap},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde::Serialize;
use sha2::{Sha256, Digest};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

#[derive(Serialize)]
struct ArticleMetadata {
    id: u32,
    title: String,
    content_hash: String,
}

/// Helper untuk menghasilkan Header `ETag` ringan (Weak ETag) berbasis hashing payload
fn generate_weak_etag(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    
    // Format standar Weak ETag (W/"<hash>")
    let base64_hash = URL_SAFE_NO_PAD.encode(result);
    format!("W/\"{}\"", base64_hash)
}

/// Handler Endpoint Berita dengan strategi "Stale-While-Revalidate"
/// Strategi ini mengizinkan CDN melayani data usang sesaat selagi ia secara latar (background)
/// memicu pengambilan ulang ke Origin Rust.
async fn get_trending_articles(headers: HeaderMap) -> Response {
    let article = ArticleMetadata {
        id: 42,
        title: "Panduan Ekosistem Rust 2026".into(),
        content_hash: "v1_release".into(),
    };

    let body_bytes = serde_json::to_vec(&article).unwrap();
    let etag = generate_weak_etag(&body_bytes);

    // Kritis: Cek permintaan klien yang mungkin berisi `If-None-Match`
    if let Some(client_etag) = headers.get(header::IF_NONE_MATCH) {
        if client_etag.as_bytes() == etag.as_bytes() {
            // Data identik, origin Rust tidak membuang memori & bandwidth utk transmisi bodi.
            // Memerintahkan CDN/Client menggunakan cache yang ada.
            return StatusCode::NOT_MODIFIED.into_response();
        }
    }

    // Konstruksi Response Penuh dengan Bodi dan Header L3
    let mut response = body_bytes.into_response();
    
    // Cache Publik selama 60 detik (Di CDN/Browser).
    // Stale-While-Revalidate: Jika usang 60s, hidangkan yang usang selama 300s tambahan,
    // seraya memicu refresh latar otomatis dari Origin Server Rust ke CDN Edge.
    let cache_policy = "public, max-age=60, stale-while-revalidate=300";

    response.headers_mut().insert(
        header::CACHE_CONTROL,
        cache_policy.parse().unwrap(),
    );
    response.headers_mut().insert(
        header::ETAG,
        etag.parse().unwrap(),
    );
    // Jika respons bervariasi bergantung kredensial masuk / kompresi gzip.
    response.headers_mut().insert(
        header::VARY,
        "Accept-Encoding".parse().unwrap(),
    );
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        "application/json".parse().unwrap(),
    );

    response
}

pub fn app_router() -> Router {
    Router::new().route("/api/v1/articles/trending", get(get_trending_articles))
}
```

## Unit Test dan Integration Test

Pengetesan di bawah ini memastikan fungsionalitas HTTP Semantics, utamanya verifikasi header untuk mekanisme propagasi caching edge yang benar, tanpa menggunakan jaringan internet.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, header, StatusCode},
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn test_cdn_cache_headers_and_etag_validation() {
        let app = app_router();

        // Tembakan Permintaan Pertama (Simulasi Miss Cache)
        let req_miss = Request::builder()
            .uri("/api/v1/articles/trending")
            .body(Body::empty())
            .unwrap();

        let res_miss = app.clone().oneshot(req_miss).await.unwrap();

        // Asserts validasi origin payload & headers
        assert_eq!(res_miss.status(), StatusCode::OK);
        assert!(res_miss.headers().contains_key(header::CACHE_CONTROL));
        assert!(res_miss.headers().contains_key(header::ETAG));
        
        let etag_val = res_miss.headers().get(header::ETAG).unwrap().clone();
        
        // Tembakan Permintaan Kedua (Simulasi Edge/CDN Revalidate Conditional GET)
        let req_revalidate = Request::builder()
            .uri("/api/v1/articles/trending")
            .header(header::IF_NONE_MATCH, etag_val) // Ajukan ETag sebelumnya
            .body(Body::empty())
            .unwrap();

        let res_hit = app.oneshot(req_revalidate).await.unwrap();
        
        // Server Rust Origin mutlak merespon 304 tanpa payload Bodi untuk efisiensi
        assert_eq!(res_hit.status(), StatusCode::NOT_MODIFIED);
    }
}
```

## Anti-Patterns Kritis

1. **Membiarkan Private User-Data Terekspos Caching Global:**
   Mengatur Header `Cache-Control: public, max-age=3600` pada rute seperti `/api/profile/me` atau tanpa memadankan dengan `Vary: Cookie` maupun `Vary: Authorization`. Dampaknya fatal, data identitas otentikasi (PII) User A yang ter-cache oleh node Cloudflare dapat disajikan dan dibaca terbuka oleh User B di negara yang sama! 
2. **Kalkulasi ETag yang Lebih Mahal daripada Payload-nya:**
   Melakukan algoritme hashing lambat (misal Bcrypt atau pembacaan I/O SSD fisik) hanya untuk membangkitkan `ETag` string. Jika biaya komputasi membangkitkan `ETag` membutuhkan proses yang setara/lebih mahal dari melayani `Response Body`, esensi *Caching Conditional GET* menjadi destruktif.

## Production Edge Cases

1. **CDN Caching pada Error Responses (50x/40x):**
   Origin Rust Axum merespons insiden kelebihan beban internal secara panik (500 Internal Server Error) atau batas waktu database, namun rute tidak me-reset header `Cache-Control`. Akibatnya CDN mengkristalkan/mencatat error halaman *500* tersebut ke L3 Edge. Klien akan terus dihantui halaman Error untuk `max-age` sisa waktu meskipun server asal sudah direparasi. Solusi: Pastikan middleware merobek/menghapus *Cache Header* atau memaksakan *no-cache* pada Status Code HTTP bukan 200/304.
2. **Keterlambatan Invalidation CDN (Purge Propagation Delay):**
   Di CloudFront atau platform sejenis, panggilan API purifikasi (Cache Invalidate) untuk suatu pola URL (`/api/v1/news/*`) bukanlah tindakan sinkronik nol-latensi, melainkan dapat tertunda beberapa detik atau bahkan hitungan menit merambat secara global. Origin Rust tidak boleh mendesain ekspektasi mutlak asumsikan *instant synchronization*.
3. **POST/PUT Body Bypassing Cache Semantics:**
   Operasi POST HTTP secara _default_ tidak ter-cache (RFC 7231). Memaksa klien menembak kueri pencarian analitik graf (*GraphQL Query*) via metode POST secara konsisten mem-bypass mekanisme Caching lapis proksi dan CDN standar industri. Origin Rust terpaksa mengeksekusi beban penuh berulang kali kecuali CDN dipaksa dengan penalaan aturan agresif (*caching POST body checksums*).
