# Tower Auth JWT Middleware & JWKS

## Konsep Utama
JSON Web Token (JWT) di sistem terdistribusi mikroservis idealnya diverifikasi tanpa memukul database (stateless). Praktik terbaik menggunakan enkripsi asimetris (RS256 / ES256). Identity Provider (Auth0, Keycloak) memegang *Private Key* untuk men-sign JWT, sedangkan semua microservices mengunduh *Public Keys* secara dinamis melalui endpoint JWKS (JSON Web Key Set).

Di Axum, validasi JWT dapat dimasukkan di layer Middleware (menggunakan `tower::Service` atau `FromRequestParts` extractor) agar setiap route yang diproteksi aman dan menolak akses tak dikenal secara dini.

## Arsitektur & Flow

```ascii
+--------------+ 1. Authenticate   +------------------+
| Client App   | <================>| Identity Provider| (Auth0/Keycloak)
+-------+------+ 2. Returns JWT    +--------+---------+
        |                                   | 4. Fetch /jwks.json (Caching)
        | 3. HTTP GET + Bearer              |
        v                                   v
+-----------------------------------------------------+
| Microservice API                                    |
| (Tower JWT Middleware) -> Validates signature local |
+-----------------------------------------------------+
```

## Production-Ready Code

*(Disimplifikasi: Di produksi nyata, JWKS fetching menggunakan crate seperti `jwks_client` atau implementasi cache periodic background task. Di sini kita fokus validasi)*

```rust
use axum::{
    async_trait,
    extract::FromRequestParts,
    http::{header, request::Parts, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use jsonwebtoken::{decode, DecodingKey, Validation, Algorithm};
use serde::{Deserialize, Serialize};

// 1. Klaim yang ada di payload JWT
#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String, // User ID
    pub exp: usize,  // Expiration timestamp
    // Custom claims
    pub role: String,
}

// 2. Custom Extractor Error
pub enum JwtError {
    MissingOrInvalidToken,
    ExpiredSignature,
    InvalidSignature,
}

impl IntoResponse for JwtError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            JwtError::MissingOrInvalidToken => (StatusCode::UNAUTHORIZED, "Token tidak valid/hilang"),
            JwtError::ExpiredSignature => (StatusCode::UNAUTHORIZED, "Token kedaluwarsa"),
            JwtError::InvalidSignature => (StatusCode::UNAUTHORIZED, "Tanda tangan digital tidak sah"),
        };
        (status, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}

// 3. Extractor JWT di Axum
#[async_trait]
impl<S> FromRequestParts<S> for Claims
where
    S: Send + Sync,
{
    type Rejection = JwtError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let auth_header = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|val| val.to_str().ok())
            .ok_or(JwtError::MissingOrInvalidToken)?;

        if !auth_header.starts_with("Bearer ") {
            return Err(JwtError::MissingOrInvalidToken);
        }
        let token = &auth_header["Bearer ".len()..];

        // Di produksi, Anda harus mengambil DecodingKey dari JWKS Cache!
        // Hardcoded PEM di bawah hanya untuk mendemonstrasikan RS256 decoding.
        let public_key_pem = b"-----BEGIN PUBLIC KEY-----\nMIIBI... (Ganti dengan Public Key Asli)\n-----END PUBLIC KEY-----";
        let decoding_key = DecodingKey::from_rsa_pem(public_key_pem)
            .map_err(|_| JwtError::InvalidSignature)?;

        // Gunakan RS256 untuk asimetris
        let mut validation = Validation::new(Algorithm::RS256);
        // Penting: Setel aud (audience) dan iss (issuer) jika relevan
        // validation.set_audience(&["my-api"]);
        
        let token_data = decode::<Claims>(token, &decoding_key, &validation)
            .map_err(|e| match e.kind() {
                jsonwebtoken::errors::ErrorKind::ExpiredSignature => JwtError::ExpiredSignature,
                _ => JwtError::InvalidSignature,
            })?;

        Ok(token_data.claims)
    }
}
```

## Anti-Patterns

1. **Menggunakan `HS256` (Symmetric Key) untuk Microservices**
   - **MENGAPA BERBAHAYA:** Di HS256, *key* yang sama dipakai untuk men-sign dan mem-validasi. Jika microservice C (sebagai resource API) butuh memvalidasi token dari Identity Provider, microservice C perlu tahu secret key-nya. Jika microservice C diretas, penyerang dapat mengambil *secret key* dan mencetak JWT palsu untuk menyamar sebagai admin. Selalu gunakan Asymmetric Keys (RS256/ES256) agar servis backend hanya memerlukan *Public Key*.
2. **Melakukan Blocking HTTP Request (Sync Fetch) ke JWKS**
   - **MENGAPA BERBAHAYA:** Jika Anda mengambil JWKS Endpoint secara lazily di dalam ekstraktor saat request datang dengan library HTTP blocking (atau memblok thread async), latensi service Anda akan hancur dan rentan DOS. Simpan Public Key di dalam memory buffer secara asinkron (misal dalam cache perodik berputar).

## Edge Context & Defensive Programming
- **Key Rotation Support:** Server otentikasi dapat mengganti (rotate) keys kapan saja untuk keamanan. JWT header memiliki field `kid` (Key ID). Token yang sah harus mencocokkan `kid` pada token dengan `kid` pada data set JWKS.
- **Clock Skew (NTP out of sync):** Saat server menolak token sebagai 'Expired' atau 'Issued At Future', pastikan ada toleransi perbedaan waktu server (Clock Skew/Leeway). Library `jsonwebtoken` menyediakan properti `validation.leeway = 60` detik untuk menutupi inkonsistensi waktu antar server klaster AWS/GCP Anda.
