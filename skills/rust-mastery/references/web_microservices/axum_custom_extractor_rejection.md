# Axum Custom Extractor & Rejection

## Konsep Utama
Dalam `axum`, request handler menerima argumen yang mengimplementasikan trait `FromRequest` atau `FromRequestParts`. **Custom Extractor** digunakan untuk merangkum logika parsing, validasi, dan autentikasi menjadi tipe data deklaratif. Jika ekstraksi gagal, ia menghasilkan **Rejection** yang harus mengimplementasikan `IntoResponse` untuk mengembalikan HTTP error yang semantik.

`FromRequestParts` digunakan untuk mengekstrak data dari HTTP headers, URL, atau method (tanpa mengkonsumsi body), sementara `FromRequest` bisa mengkonsumsi seluruh request body (misal: JSON parsing).

**Kapan Digunakan:**
- JWT Authentication (mengekstrak user dari header `Authorization`).
- Validasi payload kustom.
- Pagination parameter extraction.

## Arsitektur & Flow

```ascii
+-------------+       +-------------------------+       +-------------------+
|  HTTP Req   | ----> |  Extractor (e.g., Auth) | ----> |  Handler(Auth)    |
+-------------+       +-----------+-------------+       +-------------------+
                                  | Success: Returns Extracted Type
                                  |
                                  v Error (Rejection)
                      +-------------------------+
                      |   Rejection Enum        |
                      |   impl IntoResponse     |
                      +-----------+-------------+
                                  |
                                  v
                      +-------------------------+
                      |  HTTP 401 Unauthorized  |
                      +-------------------------+
```

## Production-Ready Code

```rust
use axum::{
    async_trait,
    extract::FromRequestParts,
    http::{header, request::Parts, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

// 1. Definisikan tipe yang akan diekstrak
pub struct AuthenticatedUser {
    pub user_id: String,
    pub role: String,
}

// 2. Definisikan Custom Rejection Enum
pub enum AuthError {
    MissingToken,
    InvalidToken,
}

// 3. Implementasikan IntoResponse untuk Rejection
impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let (status, error_message) = match self {
            AuthError::MissingToken => (StatusCode::UNAUTHORIZED, "Missing authorization header"),
            AuthError::InvalidToken => (StatusCode::UNAUTHORIZED, "Invalid token"),
        };

        let body = Json(json!({
            "error": error_message,
        }));

        (status, body).into_response()
    }
}

// 4. Implementasikan FromRequestParts (karena kita hanya membaca header)
#[async_trait]
impl<S> FromRequestParts<S> for AuthenticatedUser
where
    S: Send + Sync,
{
    type Rejection = AuthError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        // Ambil header Authorization
        let auth_header = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .ok_or(AuthError::MissingToken)?;

        // Validasi basic (di dunia nyata: verifikasi JWT)
        if !auth_header.starts_with("Bearer ") {
            return Err(AuthError::InvalidToken);
        }

        let token = &auth_header["Bearer ".len()..];
        if token != "secret123" {
            return Err(AuthError::InvalidToken);
        }

        // Return the extracted user
        Ok(AuthenticatedUser {
            user_id: "user_999".to_string(),
            role: "admin".to_string(),
        })
    }
}

// Handler contoh
pub async fn profile_handler(user: AuthenticatedUser) -> impl IntoResponse {
    format!("Hello, user {} with role {}", user.user_id, user.role)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};
    use tower::ServiceExt;
    use axum::http::Request;
    use axum::body::Body;

    #[tokio::test]
    async fn test_auth_extractor_missing_token() {
        let app = Router::new().route("/profile", get(profile_handler));
        
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/profile")
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

1. **Menggunakan `FromRequest` ketika `FromRequestParts` cukup**
   - **MENGAPA BERBAHAYA:** Trait `FromRequest` mengkonsumsi `Request` (termasuk body-nya). Jika Anda memiliki dua extractor yang mengimplementasikan `FromRequest` dalam satu handler, kompilator akan protes karena request body hanya bisa dikonsumsi sekali. Selalu gunakan `FromRequestParts` jika Anda hanya butuh membaca header, query, atau path parameters.
2. **Me-return String biasa (atau status code tanpa struktur body yang jelas) sebagai Rejection**
   - **MENGAPA BERBAHAYA:** Menyulitkan client (misalnya frontend atau service lain) untuk memparsing error secara programatis. Selalu buat enum khusus (seperti `AuthError`) yang mengimplementasikan `IntoResponse` dan mengembalikan standar JSON error layout (contoh: [RFC 7807 Problem Details](https://datatracker.ietf.org/doc/html/rfc7807)).

## Edge Cases & Defensive Programming
- **Header Injection / Duplikasi:** `parts.headers.get()` hanya mengembalikan value pertama dari header. Untuk header yang bisa berganda (meskipun jarang untuk `Authorization`), pertimbangkan apakah spesifikasi HTTP memerlukan Anda untuk menolak request atau mengambil semua nilai (menggunakan `get_all()`).
- **Timing Attacks:** Pada validasi token, jika Anda membandingkan string secara langsung (`==`), aplikasi bisa rentan terhadap timing attacks. Gunakan perbandingan *constant time* (misalnya dari crate `subtle` atau `ring`) untuk membandingkan secret token atau signature.
