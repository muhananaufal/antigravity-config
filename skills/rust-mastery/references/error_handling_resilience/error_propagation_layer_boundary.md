# Batas Layer & Propagasi Error Terstruktur

## 1. Konsep Utama & Kapan Digunakan
Aplikasi besar harus dirancang berlapis (Layered Architecture): Database Layer -> Domain/Service Layer -> Transport/API Layer. 
Jika `sqlx::Error` "bocor" langsung ke HTTP response (menjadi "Table users not found"), sistem menderita:
- Kebocoran keamanan (Security Leakage): Stuktur DB terbuka untuk attacker.
- Coupling yang ketat: Transport layer bergantung pada crate database.

Propagasi error yang benar memastikan setiap layer membungkus (map/convert) error dari layer bawah menjadi tipe error *miliknya sendiri*, sebelum memberikannya ke layer atas.

## 2. Arsitektur / Flow

```ascii
[ sqlx::Error / std::io::Error ]
       | (Diubah via From / map_err di Repo)
       v
[ crate::domain::RepositoryError ] 
       | (Diubah via From / map_err di Service)
       v
[ crate::service::AppError ]
       | (Implement IntoResponse / HTTP StatusCode mapper)
       v
[ HTTP JSON Response (4xx/5xx) ]
```

## 3. Kode Rust Production-Ready

```rust
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

// 1. Tipe di Domain/Service Layer
#[derive(Debug, Error)]
pub enum AppError {
    #[error("User not found")]
    NotFound,
    
    #[error("User is unauthorized")]
    Unauthorized,

    // Error infrastruktur/internal yang tidak boleh bocor ke user
    #[error("Internal database error")]
    DatabaseError(#[from] sqlx::Error),
}

// 2. Tipe API Error khusus untuk Serialisasi Transport (JSON)
#[derive(serde::Serialize)]
struct ErrorResponse {
    error: String,
    message: String,
}

// 3. Mengubah Domain Error menjadi HTTP Response di Batas Transport (Axum)
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, error_type, message) = match &self {
            AppError::NotFound => (
                StatusCode::NOT_FOUND, 
                "NOT_FOUND", 
                self.to_string()
            ),
            AppError::Unauthorized => (
                StatusCode::UNAUTHORIZED, 
                "UNAUTHORIZED", 
                self.to_string()
            ),
            // PENTING: Jangan tampilkan pesan internal sqlx ke user
            AppError::DatabaseError(db_err) => {
                // Log the real internal error for telemetry
                tracing::error!("Database query failed: {:?}", db_err);
                
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR",
                    "An unexpected internal error occurred".to_string(), // Aman
                )
            }
        };

        let body = Json(ErrorResponse {
            error: error_type.to_string(),
            message,
        });

        (status, body).into_response()
    }
}

// Controller logic
pub async fn get_user_handler() -> Result<String, AppError> {
    // Simulating database error
    // let res = sqlx::query("...").await?; // Otomatis menjadi AppError::DatabaseError lewat #[from]
    Err(AppError::Unauthorized)
}
```

## 4. Anti-Pattern Spesifik
1. **Mengirim `anyhow::Error` langsung ke HTTP Response framework (seperti Actix/Axum).**
   - *Bahaya*: String trace dari `.context()` berisi detail sistem mendalam dikirim telanjang ke HTTP Client (JSON serialization bocor). 
   - *Solusi*: Terapkan `IntoResponse` pada custom `AppError` enum yang mensterilkan isi response untuk kode HTTP 500.
2. **Setiap struct/fungsi di API Layer meng-import dan mem-pattern-match `sqlx::Error`.**
   - *Bahaya*: Jika besok Anda memigrasikan database ke MongoDB / DynamoDB, seluruh Transport layer harus di-rewrite.
   - *Solusi*: Pastikan Repository layer membungkus library eksternal dalam `DomainError`. API tidak boleh tahu crate database yang dipakai.

## 5. Edge Cases & Defensive Programming
- **Error Obfuscation vs Traceability**: Saat menutupi internal error menjadi HTTP 500 (obfuscation untuk security), Anda HILANG konteks di klien. Anda *wajib* men-tracing (logging) error aslinya tepat sebelum konversi (seperti pada contoh di atas: `tracing::error!`), lengkap dengan `tracing::Span` berisi Request ID, sehingga developer bisa mencocokkan error di UI dengan log di backend.
