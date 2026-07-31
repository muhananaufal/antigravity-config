# JWT: RS256/ES256 Validation & Key Management

## Konsep Utama
JSON Web Token (JWT) sangat rentan terhadap miskonfigurasi. Alih-alih menggunakan algoritma simetris (`HS256`) yang mengharuskan setiap verifier mengetahui *secret key*, sistem *enterprise* menggunakan Asimetris (`RS256` / `ES256`) di mana Server Otorisasi menandatangani dengan *Private Key*, dan *Microservices* memvalidasinya menggunakan *Public Key* (diambil dari endpoint JWKS).
Crate `jsonwebtoken` adalah standar dalam Rust untuk eksekusi ini. Validasi harus diiringi pengecekan *claims* ketat (`exp`, `nbf`, `aud`, `iss`) serta ketahanan terhadap *Key ID (kid) spoofing*.

Kapan digunakan:
- Sistem *Single Sign-On* (SSO) seperti OAuth2 / OpenID Connect.
- *Stateless API Authentication* di arsitektur Microservices (Kubernetes).
- Komunikasi Machine-to-Machine yang terotentikasi.

## Arsitektur & Flow (JWKS Asymmetric Validation)

```text
[ Auth Provider / IdP ]                      [ Rust Microservice API ]
          |                                            |
 1. Publish Public Keys (JWKS)                         |
    Endpoint: /.well-known/jwks.json  <---------- 2. Fetch & Cache Public Keys
          |                                            |
          |                                            |
 [ User / Client ]                                     |
    3. Login (Get JWT signed with RS256, kid="123")    |
          |                                            |
    4. API Request + Bearer JWT ---------------------->|
                                                       |
                                               5. Extract `kid` from Header
                                               6. Find matching Public Key in Cache
                                               7. Verify Signature & Claims (exp, iss, aud)
                                               8. If valid, process request
```

## Production-Ready Code

```rust
use jsonwebtoken::{
    decode, decode_header, Algorithm, DecodingKey, Validation, TokenData
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::error::Error;
use std::sync::RwLock;

/// Struktur Custom Claim dari JWT
#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String, // Subject (User ID)
    pub exp: usize,  // Expiration time
    pub nbf: usize,  // Not Before time
    pub iss: String, // Issuer
    pub aud: String, // Audience
    pub role: String,
}

/// Key Store Cache (Menyimpan pemetaan `kid` ke `DecodingKey`)
/// Digunakan untuk menyimpan JWKS di memori.
pub struct JwksStore {
    keys: RwLock<HashMap<String, DecodingKey>>,
    issuer: String,
    audience: String,
}

impl JwksStore {
    pub fn new(issuer: &str, audience: &str) -> Self {
        Self {
            keys: RwLock::new(HashMap::new()),
            issuer: issuer.to_string(),
            audience: audience.to_string(),
        }
    }

    /// Mensimulasikan injeksi Public Key (biasanya ditarik dari HTTP secara periodik)
    /// Mendukung format PEM atau modulus/exponent.
    pub fn add_rsa_key(&self, kid: String, pem_public_key: &[u8]) -> Result<(), Box<dyn Error>> {
        let key = DecodingKey::from_rsa_pem(pem_public_key)?;
        self.keys.write().unwrap().insert(kid, key);
        Ok(())
    }

    /// Memvalidasi token masuk secara ketat
    pub fn validate_token(&self, token: &str) -> Result<TokenData<Claims>, Box<dyn Error>> {
        // 1. Ekstrak header TANPA memvalidasi (untuk mendapatkan `kid` dan Algoritma)
        let header = decode_header(token)?;
        
        let kid = header.kid.ok_or("Missing 'kid' in JWT header")?;

        // Mencegah Algoritma `None` atau algoritma simetris yang dibajak
        if header.alg != Algorithm::RS256 {
            return Err("Algorithm mismatch, expected RS256".into());
        }

        // 2. Cari kunci di cache
        let keys_cache = self.keys.read().unwrap();
        let decoding_key = keys_cache.get(&kid).ok_or("Unknown Key ID (kid)")?;

        // 3. Konfigurasi Validation Rules (SANGAT PENTING)
        let mut validation = Validation::new(Algorithm::RS256);
        
        validation.set_issuer(&[&self.issuer]);
        validation.set_audience(&[&self.audience]);
        // Leeway (Toleransi beda clock/waktu antar server)
        validation.leeway = 60; // 60 detik toleransi untuk `exp` dan `nbf`
        
        // Wajibkan claim ini ada di token
        validation.set_required_spec_claims(&["exp", "sub", "iss", "aud", "nbf"]);

        // 4. Decode dan verifikasi penuh
        let token_data = decode::<Claims>(
            token,
            decoding_key,
            &validation
        )?;

        // Lolos! Signature dan semua Claims tervalidasi secara kriptografis
        Ok(token_data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};
    use std::time::{SystemTime, UNIX_EPOCH};

    // Fungsi utilitas test untuk membuat RSA keys
    fn generate_rsa_keys() -> (Vec<u8>, Vec<u8>) {
        // Untuk tujuan referensi, ini adalah mock static keys (dalam dunia nyata gunakan OpenSSL/rcgen)
        // Crate jsonwebtoken menyediakan `EncodingKey::from_rsa_pem`
        unimplemented!("Gunakan rcgen atau openssl untuk generate RSA 2048 keys dalam test asli")
    }

    #[test]
    #[ignore] // Diabaikan karena memerlukan generate RSA key pair PEM murni
    fn test_jwt_validation_flow() {
        // Skema pengujian (pseudo-logic)
        let store = JwksStore::new("https://auth.company.com", "api-gateway");
        // store.add_rsa_key("key-1".to_string(), &public_pem).unwrap();
        // create token signed with private_pem
        // store.validate_token(&token).unwrap();
    }
}
```

## Anti-Patterns Spesifik

1. **Vulnerability: Algoritma "None" atau Simetris Spoofing**
   - **Apa yang terjadi:** Sistem tidak menspesifikasikan secara paksa algoritma yang diharapkan di `Validation::new()`, dan bergantung pada tipe algoritma yang tertera di *header* JWT. Attacker dapat mengirim token yang ditandatangani menggunakan `HS256` dengan kunci HMAC berupa Public Key RSA yang diambil publik.
   - **Mengapa berbahaya:** Jika *library* membaca header dan menggunakan `HS256`, ia akan mengambil *Public Key* di sistem dan memperlakukannya sebagai *Shared Secret HMAC*. Karena *attacker* sudah mengetahui *Public Key*, mereka bisa memalsukan token yang valid secara instan.
   - **Solusi:** Selalu tentukan algoritma `Validation::new(Algorithm::RS256)` dan tolak token jika `header.alg` berbeda!

2. **Mengabaikan "Audience" (aud) dan "Issuer" (iss)**
   - **Apa yang terjadi:** Memverifikasi tanda tangan JWT, namun membiarkan siapa saja dengan *keypair* CA yang sama (misal *Identity Provider* umum seperti Google/Auth0) memasuki sistem.
   - **Mengapa berbahaya:** *Attacker* dapat login ke aplikasi lain yang juga menggunakan Auth0/Google, mengambil JWT yang sah (untuk aplikasi tersebut), dan mengirimkannya ke API Anda (*Cross-Application Token Replay*). Karena *signature* valid dari Google, jika Anda tidak mengecek klaim `aud` dan `iss`, API Anda akan tertipu.

## Edge Cases & Defensive Programming

- **DDoS Melalui Payload JWS Tak Terbatas:** Sebuah token JWT secara default di-decode ke dalam `String` di memori. *Attacker* dapat mengirim *Base64 payload* berukuran 100MB di *Authorization header*. Pastikan Reverse Proxy (seperti NGINX) atau Middleware batas HTTP secara tegas membatasi panjang *Header Authorization* maksimal ~8KB sebelum data dikirim ke Rust *service* untuk di-parsing.
- **Cache Poisoning pada endpoint JWKS:** Jangan izinkan pemuatan kunci dari URL yang tertera di header `jku` atau klaim kustom tanpa *whitelisting* domain secara ketat. *Attacker* dapat menunjuk ke domain `attacker.com/jwks.json` mereka dan memaksa server Anda melakukan HTTP GET dan menyimpan kunci mereka. Selalu *hardcode* atau *config-bind* domain *Issuer* ke endpoint JWKS.
- **Token Blacklisting (Revocation):** JWT bersifat *stateless* dan tetap valid hingga kedaluwarsa (`exp`). Untuk fitur *Logout* sejati, simpan klaim `jti` (JWT ID) dalam *Redis / In-Memory cache* berskema *Time-To-Live* sama dengan sisa waktu *expire* JWT. Setiap *request* masuk harus mengecek ketersediaan `jti` di *Redis Blacklist*.
