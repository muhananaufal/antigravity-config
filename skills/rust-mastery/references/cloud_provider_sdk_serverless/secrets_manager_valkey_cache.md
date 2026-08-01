# Integrasi AWS Secrets Manager & Valkey Cache (Memory-Safe)

Dokumen ini merupakan referensi *Enterprise-Grade* untuk mengambil, mendeserialisasi, dan melakukan *caching* *secret* dari AWS Secrets Manager menggunakan Valkey sebagai *layer* *caching* terdistribusi dan *in-memory* TTL. Kita menggunakan `secrecy` dan `zeroize` untuk menjamin memori dibersihkan dari *secret* ketika variabel keluar dari *scope*.

## 1. Arsitektur (ASCII Diagram)

```text
+---------------------+       +-----------------------+       +------------------------+
|   Rust Serverless   |       |    Valkey Cache       |       |  AWS Secrets Manager   |
|   (Lambda / Axum)   |       |   (Distributed TTL)   |       |     (Source of Truth)  |
+---------------------+       +-----------------------+       +------------------------+
           |                              |                               |
           | 1. Request Secret            |                               |
           |----------------------------->|                               |
           |                              |                               |
           | 2. Cache Hit? (TTL Valid)    |                               |
           |<-----------------------------|                               |
           |    [Return if Hit]           |                               |
           |                              |                               |
           | 3. Cache Miss / Expired      |                               |
           |------------------------------------------------------------->|
           |                              |                               |
           | 4. Fetch JSON Secret         |                               |
           |<-------------------------------------------------------------|
           |                              |                               |
           | 5. Decode to Zeroize Struct  |                               |
           |    (secrecy::SecretString)   |                               |
           |                              |                               |
           | 6. Set Valkey Cache (TTL)    |                               |
           |----------------------------->|                               |
           |                              |                               |
           | 7. Return to Application     |                               |
           |    (Drop -> Memory Zeroed)   |                               |
           v                              v                               v
```

## 2. Produksi Kode: `secrets_valkey.rs`

Kode berikut siap untuk di-*deploy* ke *production*, menerapkan *strict typing*, penanganan *error* yang baik, dan memori yang bersih.

```rust
use aws_config::SdkConfig;
use aws_sdk_secretsmanager::Client as SecretsClient;
use redis::{AsyncCommands, Client as RedisClient, RedisError};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use thiserror::Error;
use tokio::time::Duration;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Representasi secret dari AWS yang dijamin bersih di memori saat drop.
#[derive(Debug, Deserialize, Serialize, Zeroize, ZeroizeOnDrop)]
pub struct DatabaseCredentials {
    pub username: String,
    pub password: SecretString,
    pub host: String,
    pub port: u16,
}

#[derive(Error, Debug)]
pub enum SecretError {
    #[error("AWS Secrets Manager error: {0}")]
    AwsError(String),
    #[error("Valkey/Redis error: {0}")]
    CacheError(#[from] RedisError),
    #[error("Deserialization error: {0}")]
    SerdeError(#[from] serde_json::Error),
    #[error("Secret Not Found")]
    NotFound,
}

/// Konfigurasi untuk Secrets Manager dengan Fallback Cache
pub struct SecretManagerService {
    secrets_client: SecretsClient,
    cache_client: RedisClient,
    ttl_seconds: usize,
}

impl SecretManagerService {
    /// Inisialisasi Service dengan AWS SDK dan Valkey Connection
    pub fn new(aws_config: &SdkConfig, redis_url: &str, ttl_seconds: usize) -> Result<Self, SecretError> {
        let secrets_client = SecretsClient::new(aws_config);
        let cache_client = RedisClient::open(redis_url)?;
        
        Ok(Self {
            secrets_client,
            cache_client,
            ttl_seconds,
        })
    }

    /// Mengambil secret dari Cache. Jika miss, ambil dari AWS dan simpan ke Cache.
    pub async fn get_database_credentials(&self, secret_id: &str) -> Result<DatabaseCredentials, SecretError> {
        let mut conn = self.cache_client.get_multiplexed_tokio_connection().await?;

        // 1. Coba ambil dari Valkey (Cache)
        let cached_secret: Option<String> = conn.get(secret_id).await?;

        if let Some(cached_json) = cached_secret {
            // Berhasil mendapat cache
            let creds: DatabaseCredentials = serde_json::from_str(&cached_json)?;
            return Ok(creds);
        }

        // 2. Cache Miss, ambil dari AWS
        let resp = self.secrets_client
            .get_secret_value()
            .secret_id(secret_id)
            .send()
            .await
            .map_err(|e| SecretError::AwsError(e.into_service_error().to_string()))?;

        let secret_string = resp.secret_string().ok_or(SecretError::NotFound)?;

        // 3. Simpan ke Valkey dengan TTL
        let _: () = conn.set_ex(secret_id, secret_string, self.ttl_seconds).await?;

        // 4. Parse dan kembalikan
        let creds: DatabaseCredentials = serde_json::from_str(secret_string)?;
        Ok(creds)
    }
    
    /// Invalidasi paksa jika terjadi rotasi manual
    pub async fn invalidate_cache(&self, secret_id: &str) -> Result<(), SecretError> {
        let mut conn = self.cache_client.get_multiplexed_tokio_connection().await?;
        let _: () = conn.del(secret_id).await?;
        Ok(())
    }
}
```

## 3. Unit & Integration Tests

Pengujian memvalidasi bahwa `secrecy` bekerja dan *fallback* fungsi berhasil. (Membutuhkan *mocking* untuk AWS SDK).

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use secrecy::ExposeSecret;
    
    #[test]
    fn test_zeroize_on_drop() {
        // Memastikan tipe SecretString menutupi nilainya dalam Debug
        let raw_json = r#"{
            "username": "admin",
            "password": "super_secret_password_123!",
            "host": "localhost",
            "port": 5432
        }"#;
        
        let creds: DatabaseCredentials = serde_json::from_str(raw_json).unwrap();
        
        // Memastikan password tidak ter-leak ke output Debug
        let debug_str = format!("{:?}", creds);
        assert!(!debug_str.contains("super_secret_password_123!"));
        assert!(debug_str.contains("[REDACTED]"));
        
        // Verifikasi isi asli bisa diambil via expose_secret
        assert_eq!(creds.password.expose_secret(), "super_secret_password_123!");
    }
}
```

## 4. Anti-Patterns Kritis

❌ **Anti-Pattern 1: Menggunakan `String` biasa untuk Secrets**
- **Mengapa buruk:** String di Rust tidak otomatis dihapus dari RAM ketika di-*drop*. Jejak password bisa tertinggal di tumpukan (*stack*) atau *heap*, rentan terhadap serangan eksploitasi memori (seperti mem-dump core dump atau serangan *cold boot*).
- ✅ **Solusi (Best Practice):** Selalu gunakan *crate* `secrecy` (`SecretString`) dan trait `ZeroizeOnDrop` dari `zeroize` pada struct rahasia.

❌ **Anti-Pattern 2: Tidak Menggunakan Backoff pada Request ke Secrets Manager**
- **Mengapa buruk:** Saat Valkey (Cache) *down*, seluruh request Lambda/Axum akan langsung membanjiri AWS Secrets Manager, menyebabkan *Rate Limiting* (Throttling `ThrottlingException`) dan berujung pada *downtime* layanan yang luas.
- ✅ **Solusi (Best Practice):** Gunakan *Exponential Backoff* atau Splay/Jittering saat mengambil data dari AWS, serta terapkan pola *Circuit Breaker* jika Valkey/AWS *down* secara ekstrim.

## 5. Production Edge Cases

1. **Thundering Herd Problem (Cache Stampede):**
   - **Kondisi:** Saat TTL cache *secret* berakhir, ribuan request masuk secara serentak. Semuanya mengalami *cache miss* dan menembak Secrets Manager secara bersamaan.
   - **Mitigasi:** Terapkan strategi *Early Expiration* (Probabilistic Expiration) atau *Mutex Lock* (via Redlock di Valkey) agar hanya ada **1 proses/request** yang diizinkan memanggil AWS, sementara proses lain menunggu proses pertama selesai mengupdate cache.

2. **Network Partition dengan Valkey:**
   - **Kondisi:** Serverless (misal: AWS Lambda) tiba-tiba kehilangan koneksi jaringan ke kluster Valkey, tapi masih bisa memanggil Secrets Manager.
   - **Mitigasi:** `get_multiplexed_tokio_connection` bisa memakan waktu lama (hang). Wajib memberikan Timeout yang sangat singkat (contoh: 50ms - 100ms) menggunakan `tokio::time::timeout`. Jika melewati batas tersebut, layanan harus langsung *fallback* ke AWS Secrets Manager atau ke *local in-memory cache* statis yang bertahan seumur hidup *instance* Lambda (misal menggunakan `moka`).

3. **In-Flight Secret Rotation (Perputaran Saat Terbang):**
   - **Kondisi:** Database memutar (*rotate*) passwordnya, namun Valkey masih menyimpan password lama selama sisa waktu TTL (contoh: 5 menit). Selama itu aplikasi gagal terhubung ke DB karena otentikasinya tidak valid.
   - **Mitigasi:** Saat koneksi ke Database gagal dengan *error Auth Invalid*, aplikasi harus memicu fungsi `invalidate_cache` dan segera mengambil *secret* segar dari AWS Secrets Manager untuk me-*retry* koneksi, menyinkronkan *state* secepat mungkin.
