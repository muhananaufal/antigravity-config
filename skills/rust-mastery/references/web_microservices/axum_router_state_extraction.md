# Axum Router State & Custom Extractors: Advanced Architecture

## Deskripsi dan Konsep Utama
Dalam membangun microservices menggunakan `axum`, membagikan *state* antar *handlers* secara *type-safe* dan efisien adalah krusial. Axum menggunakan `Router::with_state` untuk menyuntikkan dependensi (seperti connection pools atau konfigurasi) ke dalam handlers. Menggunakan `Arc` sangat penting untuk menghindari alokasi dan *overhead cloning* yang berlebihan. Selain state bawaan, kita dapat mengimplementasikan custom extractors (`FromRequestParts` dan `FromRequest`) untuk logika ekstraksi yang lebih kompleks, seperti autentikasi atau validasi kustom, dengan *type-safety* penuh di level kompilasi.

## Arsitektur & Flow (ASCII Diagram)
```text
[HTTP Request] ---> (Tower Middleware / Tower Layer)
                           |
                           v
                    [Axum Router]
                           |
            +--------------+--------------+
            |                             |
    [State Extractor]            [Custom Extractor]
  (Arc<ConnectionPool>)        (e.g., AuthToken Validation)
            |                             |
            +------------> [Handler] <----+
                           |
                    [HTTP Response]
```

## Implementasi Produksi (Rust)
```rust
use axum::{
    async_trait,
    extract::{FromRef, FromRequestParts, State},
    http::{request::Parts, StatusCode},
    routing::get,
    Router,
};
use std::sync::Arc;
use tokio::sync::Mutex;

/// AppState merepresentasikan global state dari aplikasi.
/// Harus murah untuk di-clone, makanya kita wrap di dalam Arc.
#[derive(Clone)]
pub struct AppState {
    pub db_pool: Arc<DatabasePool>,
    pub config: Arc<AppConfig>,
}

pub struct DatabasePool {
    pub connections: Mutex<usize>,
}

impl DatabasePool {
    pub async fn new() -> Self {
        Self {
            connections: Mutex::new(10),
        }
    }
}

pub struct AppConfig {
    pub jwt_secret: String,
}

// Custom Extractor untuk meng-extract token JWT
pub struct AuthUser {
    pub user_id: String,
}

#[async_trait]
impl<S> FromRequestParts<S> for AuthUser
where
    S: Send + Sync,
    // Ekstraktor butuh AppConfig, jadi S harus bisa menghasilkan Arc<AppConfig>
    Arc<AppConfig>: FromRef<S>,
{
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        // Ambil config dari state
        let config = Arc::<AppConfig>::from_ref(state);
        
        let auth_header = parts
            .headers
            .get("Authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();

        if !auth_header.starts_with("Bearer ") {
            return Err((StatusCode::UNAUTHORIZED, "Missing or invalid token"));
        }

        let token = &auth_header["Bearer ".len()..];
        
        // Simulasi validasi JWT dengan jwt_secret
        if token == config.jwt_secret {
            Ok(AuthUser {
                user_id: "user-123".to_string(),
            })
        } else {
            Err((StatusCode::UNAUTHORIZED, "Invalid token"))
        }
    }
}

// Handler yang menggunakan multiple extractors
pub async fn user_profile_handler(
    State(db): State<Arc<DatabasePool>>,
    user: AuthUser,
) -> Result<String, StatusCode> {
    let mut conn = db.connections.lock().await;
    *conn -= 1; // Simulasi penggunaan koneksi
    Ok(format!("Profile for user: {}. Available conns: {}", user.user_id, conn))
}

pub fn app_router(state: AppState) -> Router {
    Router::new()
        .route("/profile", get(user_profile_handler))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn test_valid_auth() {
        let state = AppState {
            db_pool: Arc::new(DatabasePool::new().await),
            config: Arc::new(AppConfig { jwt_secret: "secret".to_string() }),
        };
        
        let app = app_router(state);
        
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/profile")
                    .header("Authorization", "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_invalid_auth() {
        let state = AppState {
            db_pool: Arc::new(DatabasePool::new().await),
            config: Arc::new(AppConfig { jwt_secret: "secret".to_string() }),
        };
        
        let app = app_router(state);
        
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/profile")
                    .header("Authorization", "Bearer badtoken")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
```

## Anti-Patterns

1. **State Tanpa `Arc` yang Mahal untuk di-Clone**: Menggunakan tipe yang besar dan berat seperti array besar atau koneksi langsung dalam state yang tidak di-wrap `Arc`. Setiap request akan meng-clone data ini, menyebabkan bottleneck performa parah.
   *Mengapa berbahaya*: Menghabiskan CPU time dan memory bandwith secara proporsional dengan traffic.
2. **Mengakses State yang Memblokir (Blocking I/O) dalam Extractor**: Melakukan synchronous database call atau sleep dalam `from_request_parts`.
   *Mengapa berbahaya*: Menghentikan worker thread Tokio, memicu thread starvation dan *cascading failure* di seluruh sistem aplikasi.

## Edge Cases & Defensive Programming

1. **Multiple Rejection Types pada Custom Extractor**: Saat custom extractor me-return error (rejection), jika kita tidak memberikan informasi detail pada log (namun tidak ke user), debug akan sangat sulit saat ada kasus header aneh atau *malformed* data. Solusi: Gunakan error handling yang me-log spesifik error secara internal namun mengembalikan `StatusCode` generik.
2. **State Leakage via Closure**: Mengambil kepemilikan variabel dari luar `Router` secara langsung menggunakan closure `move` di handler bisa memicu *memory leak* jika ada cyclic reference. Hindari dengan selalu bergantung pada `State` extractor Axum.
3. **Type-Mismatch Panic di `FromRef`**: Saat state dipecah menggunakan sub-routers, pastikan tipe `S` (State) di router induk dapat mengkonversi (*derive* `FromRef`) ke tipe yang dibutuhkan sub-router. Axum mendeteksi ini pada saat *compile-time*, jadi pastikan desain modularity sub-router mendefinisikan *trait bounds* dengan benar untuk mencegah komplikasi struktur *trait*.
