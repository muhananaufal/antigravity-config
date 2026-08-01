# Referensi Mutakhir: Validasi Token OIDC JWT dan Integrasi Rahasia Hashicorp Vault 

## 1. Pendahuluan
Prinsip dasar Zero Trust berbunyi: "Jangan percaya siapapun, selalu verifikasi." Otentikasi dan otorisasi dari mesin-ke-mesin (*machine-to-machine*) atau pengguna-ke-layanan bergantung penuh pada token identitas (biasanya JSON Web Tokens/JWT via OpenID Connect). Di sisi lain, material kriptografis (kunci *signing*, *secret*) tidak boleh di-*hardcode* atau disimpan sembarangan; ia wajib dikelola via brankas aman tersentralisasi seperti HashiCorp Vault. Artikel ini mendemonstrasikan perpaduan validasi JWT yang kokoh di Rust menggunakan material kunci simulasi, menyajikan arsitektur siap produksi yang ketat.

## 2. Diagram Arsitektur Validasi & Vault
Berikut adalah gambaran aliran kunci dan token:

```text
    [ HashiCorp Vault / Secret Manager ]
             |   (Periodik Rotasi Kunci via mTLS)
             v
    +-----------------------------------------------+
    | Layanan Penjaga Kunci (Key Manager Service)   |
    |  - Menyimpan Publik Key (RSA/EdDSA) Cache     |
    +-----------------------------------------------+
             | (In-memory Access)
             v
    +-----------------------------------------------+
    | API Gateway / Auth Middleware                 |
    |                                               |
    |  [ Permintaan Masuk dg Header Authorization ] |
    |                     |                         |
    |          ( Ekstraksi JWT Bearer )             |
    |                     |                         |
    |  +-----------------------------------------+  |
    |  |  Modul jsonwebtoken (Decode & Verify)   |  |
    |  |  - Cek Signatur, Exp, Iss, Aud, NBF     |  |
    |  +-----------------------------------------+  |
    |            |                       |          |
    |       ( Valid )                ( Invalid )    |
    +------------+-----------------------+----------+
                 |                       |
                 v                       v
         [ Lanjut ke Bisnis ]   [ Tolak, Log Anomali ]
```

## 3. Implementasi Produksi Idiomatis
Implementasi menggunakan _crate_ `jsonwebtoken` untuk dekode dan validasi dengan ketat, mensimulasikan manajemen rahasia dari layanan *Vault*.

```rust
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TokenError {
    #[error("Token tidak valid atau manipulasi signatur terdeteksi")]
    InvalidToken,
    #[error("Token telah kedaluwarsa")]
    ExpiredToken,
    #[error("Kunci pembacaan gagal dimuat dari Vault")]
    VaultError,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub iss: String,
    pub aud: String,
    pub exp: usize,
    pub nbf: usize,
    pub roles: Vec<String>,
}

/// Simulasi Klien Vault untuk mengambil kunci rahasia
pub struct MockVaultClient {
    secret_key: String,
}

impl MockVaultClient {
    pub fn new(secret_key: &str) -> Self {
        Self {
            secret_key: secret_key.to_string(),
        }
    }

    /// Mensimulasikan pemanggilan API ke HashiCorp Vault untuk mengambil secret/kunci publik
    pub async fn fetch_decoding_key(&self) -> Result<DecodingKey, TokenError> {
        // Dalam implementasi nyata, ini akan melibatkan panggilan HTTP mTLS ke endpoint Vault.
        // Simulasi kita menggunakan HMAC shared-secret untuk kemudahan demonstrasi.
        Ok(DecodingKey::from_secret(self.secret_key.as_bytes()))
    }
    
    pub fn fetch_encoding_key(&self) -> Result<EncodingKey, TokenError> {
         Ok(EncodingKey::from_secret(self.secret_key.as_bytes()))
    }
}

pub struct TokenValidator {
    vault: MockVaultClient,
    issuer: String,
    audience: String,
}

impl TokenValidator {
    pub fn new(vault: MockVaultClient, issuer: &str, audience: &str) -> Self {
        Self {
            vault,
            issuer: issuer.to_string(),
            audience: audience.to_string(),
        }
    }

    /// Memverifikasi dan mendekode JWT dengan mematuhi spesifikasi Zero Trust (Aud, Iss, Exp wajib)
    pub async fn verify_token(&self, token: &str) -> Result<Claims, TokenError> {
        let decoding_key = self.vault.fetch_decoding_key().await?;

        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_audience(&[&self.audience]);
        validation.set_issuer(&[&self.issuer]);
        validation.leeway = 15; // Beri toleransi clock-drift 15 detik

        match decode::<Claims>(token, &decoding_key, &validation) {
            Ok(token_data) => Ok(token_data.claims),
            Err(e) => {
                let err_kind = e.into_kind();
                if matches!(err_kind, jsonwebtoken::errors::ErrorKind::ExpiredSignature) {
                    Err(TokenError::ExpiredToken)
                } else {
                    Err(TokenError::InvalidToken)
                }
            }
        }
    }
}
```

## 4. Pengujian (Unit & Integration Tests)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn current_timestamp() -> usize {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as usize
    }

    fn generate_valid_token(vault: &MockVaultClient) -> String {
        let claims = Claims {
            sub: "user_123".to_owned(),
            iss: "zero_trust_idp".to_owned(),
            aud: "enterprise_api".to_owned(),
            exp: current_timestamp() + 3600, // Aktif 1 jam ke depan
            nbf: current_timestamp() - 60,
            roles: vec!["staff".to_owned()],
        };
        
        let key = vault.fetch_encoding_key().unwrap();
        encode(&Header::default(), &claims, &key).unwrap()
    }
    
    fn generate_expired_token(vault: &MockVaultClient) -> String {
        let claims = Claims {
            sub: "user_123".to_owned(),
            iss: "zero_trust_idp".to_owned(),
            aud: "enterprise_api".to_owned(),
            exp: current_timestamp() - 3600, // Sudah kedaluwarsa 1 jam lalu
            nbf: current_timestamp() - 7200,
            roles: vec!["staff".to_owned()],
        };
        
        let key = vault.fetch_encoding_key().unwrap();
        encode(&Header::default(), &claims, &key).unwrap()
    }

    #[tokio::test]
    async fn test_verify_valid_token() {
        let vault = MockVaultClient::new("super_secret_key_production_vault_9921");
        let token = generate_valid_token(&vault);
        
        let validator = TokenValidator::new(vault, "zero_trust_idp", "enterprise_api");
        let claims = validator.verify_token(&token).await;
        
        assert!(claims.is_ok());
        let claims = claims.unwrap();
        assert_eq!(claims.sub, "user_123");
    }

    #[tokio::test]
    async fn test_verify_expired_token() {
        let vault = MockVaultClient::new("super_secret_key_production_vault_9921");
        let token = generate_expired_token(&vault);
        
        let validator = TokenValidator::new(vault, "zero_trust_idp", "enterprise_api");
        let result = validator.verify_token(&token).await;
        
        assert!(matches!(result, Err(TokenError::ExpiredToken)));
    }
    
    #[tokio::test]
    async fn test_verify_invalid_signature() {
        let vault_real = MockVaultClient::new("super_secret_key_production_vault_9921");
        let vault_fake = MockVaultClient::new("fake_hacker_key");
        
        // Token di-*sign* dengan kunci hacker
        let token = generate_valid_token(&vault_fake);
        
        // Validator menggunakan kunci *real* dari Vault
        let validator = TokenValidator::new(vault_real, "zero_trust_idp", "enterprise_api");
        let result = validator.verify_token(&token).await;
        
        assert!(matches!(result, Err(TokenError::InvalidToken)));
    }
}
```

## 5. Anti-Patterns Kritis

1. **Memuat Kunci dari Vault secara Sinkron pada Setiap Permintaan**
   *Penjelasan:* Mengambil material rahasia publik/simetris langsung dari layanan eksternal (seperti Vault API HTTP) untuk setiap request validasi token akan mematikan performa secara drastis (*Latency Spikes*) dan membahayakan kuota *rate-limit* Vault itu sendiri.
   *Solusi:* Gunakan *Caching Kunci In-Memory* secara berkala (*background worker* rotasi kunci) berbasis waktu, sehingga penandatanganan dilakukan dengan kunci *cache* yang dikelola dengan aman di memori lokal (misal menggunakan struktur `RwLock` asinkron).

2. **Mengabaikan Pengecekan Target (Audience) dan Penerbit (Issuer)**
   *Penjelasan:* Pada organisasi besar, IdP (Identity Provider) mungkin mengeluarkan banyak token untuk berbagai layanan yang berbeda. Jika *microservice* "Layanan Keuangan" memvalidasi token milik "Layanan HRD" sebagai token sah (hanya karena *signature*-nya valid), akan terjadi eksploitasi *Cross-Service Confused Deputy*.
   *Solusi:* Validasi atribut *Audience* (`aud`) yang spesifik, dan *Issuer* (`iss`) yang ketat pada fungsi verifikasi secara harfiah.

## 6. Production Edge Cases

1. **Rotasi Algoritma dan Pencabutan Kunci Darurat (Key Compromise)**
   *Penjelasan:* Jika kunci asimetris pribadi IdP bocor, semua token yang beredar tidak dapat dipercaya. Organisasi harus merotasi kunci (biasanya dengan pergeseran `kid` di Header JWT). Jika arsitektur layanan tidak memantau perubahan `kid` (*Key ID*) baru dan hanya memakai *cache* statis yang terlalu panjang, layanan bisa gagal merespons atau salah menerima token kedaluwarsa.
   *Penanganan:* Bangun penanganan yang ketika deteksi JWT memiliki `kid` yang tidak dikenali, layanan langsung proaktif melakukan _request_ pembaruan _JWKS endpoint_ Vault alih-alih melempar _error_ secara prematur.

2. **Skew Waktu Ekstrem (Severe NTP Drift) Antara IdP dan Layanan**
   *Penjelasan:* Server validasi yang tertinggal waktu (*clock drift* mundur) mungkin akan melempar *error* "Token is not valid yet" (`nbf` gagal) ketika menerima token baru dari IdP. Sebaliknya, waktu yang mendahului bisa memvalidasi token yang sudah kedaluwarsa sebentar.
   *Penanganan:* Definisikan toleransi waktu (*Leeway*) secara hati-hati pada kelas `Validation` (contoh: 15-30 detik). Jaga mesin *host* selalu terkalibrasi ke layanan *Time Server* internal.

3. **Serangan Algoritma "None" atau Penurunan Kriptografi (Downgrade Attack)**
   *Penjelasan:* Penyerang memanipulasi *header* token menjadi `alg: "none"` atau mensubstitusi skema RS256 menjadi HS256 yang kemudian menggunakan *public key* pemverifikasi sebagai kunci HMAC.
   *Penanganan:* Saat membuat instansi `Validation` pada konfigurasi librari `jsonwebtoken`, secara eksplisit dan absolut hanya *whitelist* algoritma yang digunakan dalam infrastruktur yang dibolehkan (contoh: secara ketat mendefinisikan `Algorithm::RS256` tanpa celah algoritma lain).
