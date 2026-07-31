# Axum Router State & Extraction

## Konsep Utama
Dalam arsitektur web modern dengan `axum`, **State Extraction** adalah mekanisme type-safe untuk menginjeksi dependensi (seperti connection pool, configuration, atau cache) ke dalam request handler. `axum` menggunakan `State<T>` extractor dan trait `FromRef<T>` untuk memecah state global menjadi sub-state yang spesifik untuk handler tertentu. Ini menggantikan pola lama yang bergantung pada `Extension`, memberikan keamanan tipe pada saat kompilasi (compile-time type safety) di mana handler hanya bisa di-mount ke router jika tipe state-nya cocok.

**Kapan Digunakan:**
- Menyediakan koneksi database (`sqlx::PgPool`) ke handler.
- Mendistribusikan konfigurasi aplikasi (misal: JWT keys, external API URLs).
- Memisahkan domain state di dalam nested routers (modular monolight / microservices).

## Arsitektur & Flow

```ascii
+-------------------+       +-----------------------+       +-------------------+
|                   |       | Router::with_state(S) |       |                   |
|  Incoming HTTP    +------>+-----------------------+------>+  Handler(State)   |
|  Request          |       | S: AppState           |       |                   |
+-------------------+       |                       |       | Extracts:         |
                            |   AppConfig (Sub) ----+------>+ State<AppConfig>  |
                            |   DbPool (Sub)    ----+------>+ State<DbPool>     |
                            +-----------------------+       +-------------------+
                                     ^
                                     | FromRef<AppState> trait
                                     | does the projection
```

## Production-Ready Code

```rust
use axum::{
    extract::{FromRef, State},
    http::StatusCode,
    routing::get,
    Router,
};
use std::sync::Arc;
use tokio::net::TcpListener;

// 1. Definisikan komponen state individu
#[derive(Clone)]
pub struct DbPool { /* placeholder untuk sqlx::PgPool */ }

#[derive(Clone)]
pub struct AppConfig {
    pub max_items: usize,
}

// 2. Gabungkan ke dalam satu AppState (biasanya dibungkus Arc)
#[derive(Clone)]
pub struct AppState {
    pub db: DbPool,
    pub config: AppConfig,
}

// 3. Implementasikan FromRef untuk memecah state
// Memungkinkan handler hanya meminta sebagian dari state global
impl FromRef<AppState> for DbPool {
    fn from_ref(state: &AppState) -> Self {
        state.db.clone()
    }
}

impl FromRef<AppState> for AppConfig {
    fn from_ref(state: &AppState) -> Self {
        state.config.clone()
    }
}

// Handler yang hanya butuh DbPool
async fn get_users(State(_db): State<DbPool>) -> Result<String, StatusCode> {
    // Logika db...
    Ok("Users list".to_string())
}

// Handler yang butuh AppConfig
async fn get_settings(State(config): State<AppConfig>) -> Result<String, StatusCode> {
    Ok(format!("Max items: {}", config.max_items))
}

pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/users", get(get_users))
        .route("/settings", get(get_settings))
        // with_state memastikan semua extractors di handler dapat diresolve dari AppState
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
    async fn test_state_extraction() {
        let state = AppState {
            db: DbPool {},
            config: AppConfig { max_items: 42 },
        };
        let app = app(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/settings")
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

1. **Menggunakan `Extension` untuk Dependency Injection Utama**
   - **MENGAPA BERBAHAYA:** `Extension` menggunakan `TypeMap` yang di-resolve secara dinamis saat runtime. Jika Anda lupa menambahkan `.layer(Extension(pool))` ke router, aplikasi akan panic (Internal Server Error) *saat ada request*. `State` menjamin kompilasi gagal jika state tidak di-supply.
2. **Meletakkan `Mutex<T>` (tanpa `Arc`) di dalam `State`**
   - **MENGAPA BERBAHAYA:** `State` harus mengimplementasikan `Clone`. Jika Anda melakukan `Clone` pada `Mutex<T>` (yang sebenarnya tidak bisa kecuali dibungkus `Arc`), Anda akan kesulitan. Lebih buruk lagi, menggunakan `std::sync::Mutex` di async handler dapat memblokir worker thread tokio. Gunakan `Arc<tokio::sync::Mutex<T>>` atau `Arc<tokio::sync::RwLock<T>>` untuk mutabilitas concurrent.

## Edge Cases & Defensive Programming
- **Large State Clones:** Karena state diekstrak pada setiap request, cloning struct state yang besar bisa memakan biaya (CPU/Memori). Selalu bungkus inner data Anda dengan `Arc` (misalnya `Arc<Config>`) atau pastikan struct tersebut murah untuk di-clone (seperti `sqlx::PgPool` yang secara internal sudah menggunakan `Arc`).
- **Nested Routers State Type Mismatch:** Saat melakukan kompisisi router `Router::new().nest("/api", api_router)`, tipe state dari `api_router` harus kompatibel. Gunakan `.with_state()` pada level teratas untuk menyuntikkan state secara eksplisit agar tipe inferencing compiler bekerja dengan baik.
