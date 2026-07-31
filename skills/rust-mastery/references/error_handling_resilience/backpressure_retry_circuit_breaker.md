# Backpressure, Retry, & Circuit Breaker

## 1. Konsep Utama & Kapan Digunakan
Dalam sistem terdistribusi, kegagalan jaringan atau overload pada layanan downstream adalah kepastian. Untuk mencegah *cascading failure* (kegagalan berantai yang menumbangkan seluruh sistem):
- **Retry dengan Exponential Backoff**: Mengulang request gagal dengan waktu tunggu yang bertambah eksponensial.
- **Jitter**: Menambahkan keacakan pada delay retry agar ribuan client tidak retry berbarengan (*thundering herd*).
- **Circuit Breaker**: State machine yang melindungi sistem dari request berulang ke downstream yang sudah dipastikan mati.

Gunakan konsep ini ketika:
- Mengakses eksternal API atau Database melalui jaringan.
- Membangun microservices atau sistem HFT (High-Frequency Trading) di mana backpressure menghentikan load ingestion.

## 2. Arsitektur / Flow (Circuit Breaker)

```ascii
      (Success threshold)
        +---------------+
        |               v
[ HALF-OPEN ] <---- [ CLOSED (Normal) ]
        |               | (Error rate > threshold)
        v               v
 (Failed req)       [ OPEN (Fast fail) ]
        +---------------+ 
           (Timeout expires)
```

## 3. Kode Rust Production-Ready

Contoh menggunakan pola retry native Async Rust (sering dibantu oleh library seperti `reqwest-middleware` atau `failsafe`):

```rust
use std::time::Duration;
use rand::Rng;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RequestError {
    #[error("Network timeout")]
    Timeout,
    #[error("Rate limited by upstream")]
    RateLimited,
    #[error("Server internal error")]
    InternalError,
}

/// Mensimulasikan network call
async fn make_network_request() -> Result<String, RequestError> {
    // Implementasi tiruan
    Err(RequestError::Timeout)
}

/// Retry policy dengan Exponential Backoff + Jitter
pub async fn fetch_with_retry(max_retries: u32) -> Result<String, RequestError> {
    let mut retries = 0;
    let mut base_delay = Duration::from_millis(100);

    loop {
        match make_network_request().await {
            Ok(res) => return Ok(res),
            Err(e) => {
                if retries >= max_retries {
                    return Err(e);
                }

                // Jangan retry pada error non-transient
                if matches!(e, RequestError::InternalError) {
                    return Err(e);
                }

                retries += 1;
                
                // Exponential backoff
                let delay = base_delay * (1 << retries); // 200, 400, 800ms
                
                // Jitter (Full Jitter formula: rand(0, base_delay * 2^retry))
                let jitter: u64 = rand::thread_rng().gen_range(0..delay.as_millis() as u64);
                let sleep_duration = Duration::from_millis(jitter);

                tracing::warn!(
                    "Request failed, retrying {}/{} in {:?}", 
                    retries, max_retries, sleep_duration
                );

                tokio::time::sleep(sleep_duration).await;
            }
        }
    }
}

// Notes on Circuit Breaker:
// Untuk di production, SANGAT DISARANKAN memakai crate `failsafe` untuk CircuitBreaker
// karena state thread-safe (Atomic) cukup rumit jika ditulis manual dari nol.
```

## 4. Anti-Pattern Spesifik
1. **Retry tanpa Jitter di sistem skala besar.**
   - *Bahaya*: Jika downstream database offline sesaat, puluhan ribu worker akan gagal bersamaan, tidur (backoff) `500ms`, lalu bangun serentak menyerang database. Ini disebut *Thundering Herd / Retry Storm*.
   - *Solusi*: Selalu gunakan keacakan (Jitter) di atas waktu backoff kalkulasian.
2. **Infinite retry untuk layer internal (Deadlock).**
   - *Bahaya*: Thread/Task memblokir memory dan resources (connection pool) selamanya karena fungsi looping tanpa timeout absolut.
   - *Solusi*: Terapkan batas waktu absolut request `tokio::time::timeout` melapisi seluruh blok retry.

## 5. Edge Cases & Defensive Programming
- **Idempotency**: Pastikan operasi yang Anda retry adalah idempoten (contoh: `PUT` atau `GET`, atau request berisi Idempotency-Key). Jangan pernah mere-try secara buta `POST /charge_credit_card` kecuali Anda yakin downstream tahu cara deduplikasinya.
- **Circuit Breaker State Scope**: State dari Circuit Breaker harus berada pada instance level (berlaku ke semua task, ditaruh di `Arc<Mutex>` atau `Atomic`), bukan local di dalam 1 request task, karena CB bertujuan men-shortcut seluruh sistem dari downstream yang offline.
