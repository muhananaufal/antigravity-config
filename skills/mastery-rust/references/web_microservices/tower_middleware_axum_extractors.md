# Axum & Tower Middleware (Top 1% Architecture)

## 1. Fundamental Law & Mechanical Sympathy

Dalam ekosistem Rust modern, kerangka kerja web tidak lagi dibangun dari nol melainkan dirakit di atas spesifikasi **Tower Service**. `tower::Service` adalah abstraksi matematis yang murni: ia mengambil *Request* secara asinkron dan mengembalikan *Response* atau *Error*. Kerangka kerja seperti **Axum** hanyalah lapisan sintaksis manis (*syntactic sugar*) yang memetakan URL ke *Tower Service*.

Secara mekanik (*Mechanical Sympathy*), rahasia dari performa ekstrim Axum (mampu menembus ratusan ribu *request* per detik) terletak pada pendekatannya terhadap *Extractors* dan *State*. Axum tidak menggunakan *Reflection* atau *Dynamic Dispatch* (`dyn Trait`) saat *runtime* untuk mengurai *request body* menjadi JSON. Ia memaksakan resolusi tipe secara absolut di tingkat kompilator (*Compile-Time Type Resolution*). Jika Anda membuat fungsi *handler* yang menerima tipe `Json<CreateUser>`, kompilator Rust akan menanamkan instruksi spesifik memori tanpa ongkos tambahan (zero-cost abstraction). Namun, ini memicu jebakan yang sangat brutal bagi pemula: pesan *error* kompilator Axum terkenal tidak bisa dibaca jika tipe *State* atau trait `FromRequest` Anda tidak sinkron.

## 2. Top 1% Production Architecture

Arsitektur Web Backend kelas atas memisahkan logika bisnis dari lapisan transport menggunakan *Tower Layers*, serta mengamankan pembagian status (*State Sharing*) di lingkungan *multi-threaded* Tokio.

### 2.1 Thread-Safe State Injection
Membagikan koneksi basis data atau *Redis pool* melintasi ribuan *request* konkuren mensyaratkan arsitektur `Arc` (Atomic Reference Counting). Anda **TIDAK BOLEH** membungkus objek asinkron di dalam *Mutex* standar OS (`std::sync::Mutex`) jika penahanan *lock* melintasi titik `await`.

```rust
use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use std::sync::Arc;
use sqlx::PgPool;

// 1. The AppState must be cheap to clone (Arc provides this)
#[derive(Clone)]
pub struct AppState {
    pub db: PgPool, // PgPool internally uses Arc, so it's cheap to clone!
    pub config: Arc<AppConfig>, // Wrap custom structs in Arc
}

pub struct AppConfig {
    pub max_upload_size: usize,
}

// 2. The Handler uses Type-Safe State extraction
async fn create_user(
    State(state): State<AppState>,
    Json(payload): Json<CreateUserDto>,
) -> Result<Json<UserResponse>, AppError> {
    // Zero-cost database access via State
    let user = sqlx::query!("INSERT INTO users (name) VALUES ($1) RETURNING id", payload.name)
        .fetch_one(&state.db)
        .await?;

    Ok(Json(UserResponse { id: user.id }))
}

pub fn app_router(db_pool: PgPool) -> Router {
    let state = AppState {
        db: db_pool,
        config: Arc::new(AppConfig { max_upload_size: 1024 * 1024 }),
    };

    Router::new()
        .route("/users", post(create_user))
        .with_state(state) // Enforced at compile-time
}
```

### 2.2 Tower Middleware (Timeout & Concurrency Limits)
Melindungi layanan dari hantaman *DDoS* atau kueri berat dilakukan melalui *Tower Layers*, yang bekerja langsung di tingkat soket HTTP sebelum logika bisnis dieksekusi.

```rust
use axum::{Router, routing::get};
use tower::ServiceBuilder;
use tower_http::trace::TraceLayer;
use std::time::Duration;

pub fn build_protected_router() -> Router {
    // ServiceBuilder stacks middlewares (Layers) efficiently
    let middleware_stack = ServiceBuilder::new()
        // 1. Propagate tracing context
        .layer(TraceLayer::new_for_http())
        // 2. Drop requests that take more than 5 seconds
        .timeout(Duration::from_secs(5))
        // 3. Limit to 1024 concurrent requests (shed load beyond this)
        .concurrency_limit(1024)
        .into_inner();

    Router::new()
        .route("/health", get(|| async { "OK" }))
        .layer(middleware_stack)
}
```

## 3. Failure & Edge-Case Anomaly Matrix

| Kelas Anomali | Gejala / Dampak Mutlak | Matriks Mitigasi (Top 1% Tactic) |
| :--- | :--- | :--- |
| **Trait Bound Compilation Hell** | Pesan *error* kompilator sepanjang 300 baris yang menyebutkan `the trait bound fn(...) -> impl Future... is not satisfied by Handler`. | Ini BUKAN *bug* kompilator. Ini terjadi 99% karena tipe pada *Extractor* Anda (misal `State<T>`) tidak sama persis dengan tipe pada `.with_state(T)`. Gunakan *macro* `#[axum::debug_handler]` pada fungsi kueri Anda untuk memaksa kompilator memberikan letak *error* yang manusiawi. |
| **Deadlock on Async Mutex** | Aplikasi berhenti merespons (hang) secara acak di bawah beban tinggi tanpa CPU *spike*. | Jangan gunakan `std::sync::Mutex` melintasi blok `.await`. OS akan menghentikan *thread* dan *Tokio Worker* akan lumpuh (Deadlock). Selalu gunakan `tokio::sync::Mutex` jika menunggu asinkron, atau hindari *Mutex* sama sekali dengan arsitektur kanal (*channels*). |
| **Memory Exhaustion on Uploads** | Klien mengirim berkas 50GB, peladen (*server*) kehabisan RAM dan dibunuh OS (OOM Kill). | Secara baku (*default*), *Extractor* `Json` atau `Bytes` di Axum mengambil memori tanpa batas mutlak. Anda WAJIB menambahkan lapis `RequestBodyLimitLayer` atau mengatur `DefaultBodyLimit::max()` secara global. |

## 4. High-Assurance Testing

Axum memungkinkan pengujian integrasi tanpa harus mengikat (*bind*) peladen ke *port* TCP sungguhan. Kita memanggil *Tower Service* secara langsung dalam memori menggunakan kerangka kerja `tower::ServiceExt`.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt; // for `oneshot`

    #[tokio::test]
    async fn test_health_check() {
        // Arrange
        let app = build_protected_router();

        // Act
        let response = app
            .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();

        // Assert
        assert_eq!(response.status(), StatusCode::OK);
    }
}
```

## 5. Anti-Patterns & "When NOT to Use" Matrix

### Anti-Pattern: Mengembalikan Raw `Result<String, String>` pada Handler
Rust mengizinkan *handler* mengembalikan hampir apa saja, namun mengembalikan nilai *error* primitif (*string*) adalah bencana *Enterprise*.

**Mengapa ini fatal?**
- **Pros:** Cepat ditulis.
- **Cons (1):** Klien akan selalu menerima HTTP 500 (Internal Server Error) terlepas dari jenis kegagalannya (bahkan untuk *Bad Request* 400).
- **Cons (2):** Tidak ada pelacakan yang terstruktur; Sentry/Datadog hanya akan melihat rentetan *string* acak.
- **Top 1% Fix:** Selalu buat `enum AppError`, terapkan trait `IntoResponse`, dan petakan setiap galat ke HTTP *Status Code* yang tepat (misal: `AppError::NotFound -> 404`).

**Kapan Axum/Tower TIDAK Boleh Digunakan:**
- **Pemrosesan CPU-Bound Berat (Video Encoding/ML):** Axum berjalan di atas eksekutor asinkron `tokio`. Menjalankan tugas perhitungan matematis intensif di dalam *handler* Axum akan memblokir *Worker Thread*, menghentikan respons terhadap klien lain. Anda WAJIB menggunakan `tokio::task::spawn_blocking` untuk operasi seperti itu.
