# Apalis Redis Queue Workers: Arsitektur Pekerjaan Latar Belakang Asinkron

File referensi ini membedah implementasi *worker pool* asinkron menggunakan crate `apalis` dengan penyimpanan berbasis Redis Streams. Arsitektur ini dirancang untuk ketahanan tinggi, memanfaatkan pemangkasan *graceful* (graceful shutdown) saat menerima sinyal sistem, serta mekanisme *exponential backoff* dengan *jitter* untuk menangani *transient failures*.

## 1. Arsitektur & Diagram ASCII

Diagram berikut mengilustrasikan alur pekerjaan dari masuknya pekerjaan (job) ke dalam antrean Redis hingga diproses oleh kumpulan worker, lengkap dengan penanganan sinyal terminasi.

```text
+-------------------+       +-----------------------+       +-------------------+
|                   | Push  |                       | Fetch |                   |
|  Web API / App    |------>|  Redis (Streams)      |------>|   Apalis Worker   |
| (Producer)        |       |  [ jobs_queue_xyz ]   |       |   (Consumer)      |
|                   |       |                       |       |                   |
+-------------------+       +-----------------------+       +-------------------+
                                                                     |
                                                                     v
                                                            +-------------------+
                                                            |  Job Processing   |
                                                            |  - Serde Decode   |
                                                            |  - Execute logic  |
                                                            |  - Backoff Retry  |
                                                            +-------------------+
                                                                     |
                                  SIGTERM / SIGABRT                  v
                                ---------------------> +-----------------------+
                                                       | Graceful Shutdown     |
                                                       | (Wait running tasks)  |
                                                       +-----------------------+
```

## 2. Implementasi Produksi Rust Idiomatis

Berikut adalah implementasi sistem *queue worker* menggunakan `apalis`, `redis`, dan `tokio`. Kode ini mendemonstrasikan serialisasi JSON, *backoff* ter-jitter, dan *graceful shutdown*.

```rust
use apalis::{
    prelude::*,
    redis::{RedisStorage, Config as RedisConfig},
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use thiserror::Error;
use rand::Rng;
use tokio::signal;
use tracing::{info, warn, error};

/// Definisi error kustom untuk worker
#[derive(Debug, Error)]
pub enum WorkerError {
    #[error("Database connection timeout")]
    DatabaseTimeout,
    #[error("External API rejected the request")]
    ApiRejection,
    #[error("Internal processing error: {0}")]
    Internal(String),
}

/// Payload pekerjaan (Job Payload)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendEmailJob {
    pub recipient: String,
    pub subject: String,
    pub body: String,
}

// Menandai `SendEmailJob` sebagai pekerjaan Apalis
impl Job for SendEmailJob {
    const NAME: &'static str = "send_email_job";
}

/// Handler fungsi untuk memproses `SendEmailJob`
async fn send_email_handler(job: SendEmailJob, _ctx: JobContext) -> Result<(), WorkerError> {
    info!("Starting email sending process to: {}", job.recipient);
    
    // Simulasi proses yang memakan waktu atau bisa gagal
    if job.recipient.is_empty() {
        error!("Recipient cannot be empty");
        return Err(WorkerError::Internal("Empty recipient".to_string()));
    }
    
    if job.recipient.contains("timeout.com") {
        warn!("Simulated DB timeout for recipient");
        return Err(WorkerError::DatabaseTimeout);
    }
    
    info!("Successfully sent email to {}", job.recipient);
    Ok(())
}

/// Fungsi untuk menghitung eksponensial backoff dengan jitter
pub fn calculate_backoff_with_jitter(attempt: u32) -> Duration {
    let base = 2u64.pow(attempt.min(8)); // Max 256 seconds
    let mut rng = rand::thread_rng();
    let jitter = rng.gen_range(0..=1000); // 0 to 1 second jitter
    Duration::from_millis((base * 1000) + jitter)
}

/// Fungsi middleware untuk retry mechanism (Apalis mendukung retry natively, ini adalah contoh kustom konseptual)
/// Dalam Apalis sebenarnya kita bisa menggunakan `.retry_with(...)` di builder.

/// Konfigurasi Shutdown Signal
async fn wait_for_shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("Failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            info!("Received Ctrl-C, initiating graceful shutdown");
        },
        _ = terminate => {
            info!("Received SIGTERM, initiating graceful shutdown");
        },
    }
}

/// Inisialisasi dan jalankan worker
pub async fn run_worker_pool(redis_url: &str) -> anyhow::Result<()> {
    let redis_config = RedisConfig::default();
    let storage = RedisStorage::new(redis_url.parse()?, redis_config)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to connect to Redis: {}", e))?;

    let worker = Monitor::new()
        .register_with_count(2, move |idx| {
            WorkerBuilder::new(format!("email-worker-{}", idx))
                .with_storage(storage.clone())
                .build_fn(send_email_handler)
        })
        .shutdown_timeout(Duration::from_secs(30)); // 30 detik untuk menyelesaikan pekerjaan berjalan

    info!("Worker pool initialized, waiting for jobs...");
    
    // Jalankan dengan graceful shutdown
    worker.run_with_signal(wait_for_shutdown_signal()).await?;
    
    info!("Worker pool shutdown complete.");
    Ok(())
}
```

## 3. Unit & Integration Testing

Pengujian menggunakan `tokio::test` untuk memverifikasi penanganan job dan simulasi handler. Karena redis membutuhkan instance eksternal, dalam unit test kita menggunakan storage in-memory atau mock function.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use apalis::memory::MemoryStorage;

    #[tokio::test]
    async fn test_send_email_handler_success() {
        let job = SendEmailJob {
            recipient: "user@example.com".to_string(),
            subject: "Welcome".to_string(),
            body: "Hello world".to_string(),
        };
        let ctx = JobContext::new(); // Dummy context
        let result = send_email_handler(job, ctx).await;
        assert!(result.is_ok(), "Handler should succeed for valid recipient");
    }

    #[tokio::test]
    async fn test_send_email_handler_timeout_error() {
        let job = SendEmailJob {
            recipient: "user@timeout.com".to_string(),
            subject: "Will Fail".to_string(),
            body: "Timeout content".to_string(),
        };
        let ctx = JobContext::new();
        let result = send_email_handler(job, ctx).await;
        
        match result {
            Err(WorkerError::DatabaseTimeout) => {}, // Success, expected error
            _ => panic!("Expected DatabaseTimeout error"),
        }
    }
}
```

## 4. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Mengabaikan Sinyal Terminasi (Hard Kill)
**Salah:** Menggunakan loop `while true` tanpa memeriksa sinyal `SIGTERM`. Ketika pod kubernetes diterminasi, pekerjaan yang sedang berjalan akan putus di tengah jalan, meninggalkan state tidak konsisten.
```rust
// ❌ JANGAN LAKUKAN INI
loop {
    let job = redis.pop().await;
    process_job(job).await; // Jika pod mati di sini, job hilang!
}
```
**Benar:** Menerapkan *graceful shutdown* menggunakan `tokio::select!` atau mekanisme bawaan Apalis seperti `worker.run_with_signal()` untuk menunggu proses yang sedang berjalan hingga selesai (atau batas waktu).

### ❌ Anti-Pattern 2: Retry Tanpa Jitter (Thundering Herd)
**Salah:** Melakukan retry statis (misal setiap 5 detik) pada semua worker yang gagal karena koneksi DB mati. Saat DB kembali *online*, semua worker akan menyerang bersamaan (Thundering Herd Problem).
```rust
// ❌ JANGAN LAKUKAN INI
tokio::time::sleep(Duration::from_secs(5)).await;
retry();
```
**Benar:** Menambahkan *jitter* acak di atas *exponential backoff* agar beban retry tersebar.

## 5. Production Edge Cases

1. **Worker Crash di Tengah Proses:**
   - *Kasus:* Pod atau thread *panic* saat sedang memproses *job* (misal memori penuh OOMKill).
   - *Penanganan:* Redis Streams menggunakan mekanisme *acknowledgment*. Jika *worker* tidak mengirim ACK dalam batas waktu tertentu, *job* masuk ke *pending list* dan diambil oleh *worker* lain melalui *consumer group* claim. Pastikan *job handler* bersifat **idempoten**.

2. **Koneksi Redis Putus Sambung Terus-menerus (Flapping Connection):**
   - *Kasus:* Jaringan antara worker dan server Redis tidak stabil, menyebabkan TCP Reset.
   - *Penanganan:* Worker pool harus menggunakan koneksi *multiplexed* dengan auto-reconnect dan backoff. `apalis-redis` di-backing oleh library `redis-rs` yang bisa dikonfigurasi menggunakan `ConnectionManager` agar tangguh secara otomatis.

3. **Lonjakan Volume Payload Sangat Besar (Mega Job Spikes):**
   - *Kasus:* Tiba-tiba ada 1 juta *job* masuk, menghabiskan memori Redis.
   - *Penanganan:* Implementasi limit panjang stream di Redis (`MAXLEN`). Batasi kecepatan *push* (*Rate Limiting*) atau gunakan struktur penyimpanan alternatif seperti SQLite disk-based untuk memecah beban jika Redis hanya di-alokasi RAM kecil.
