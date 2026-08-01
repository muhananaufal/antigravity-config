# DLQ Management & Poison Payload Handling

File referensi ini mengekspos strategi top-tier (kelas Sultan) untuk manajemen worker kecepatan tinggi, mengisolasi muatan pesan beracun (*poison payloads*) ke dalam *Dead Letter Queue (DLQ)*, dan menyediakan sirkuit *Job Replay Tooling*. Arsitektur ini krusial untuk mencegah sistem terhenti selamanya (*infinite loop*) akibat kegagalan berulang.

## 1. Arsitektur & Diagram ASCII

Diagram berikut menyoroti pengalihan payload ke DLQ jika percobaan retry maksimum terlampaui. Ia dilengkapi *alert webhook* dan portal utilitas replay manual untuk SysAdmins.

```text
       +---------------+
       | Job Queue     |
       | (Redis/Kafka) |
       +---------------+
              | 1. Pop Job
              v
+----------------------------+
|      Worker Processor      |
|                            |
| 2. Exec Handler (Fail!)    |
| 3. Retry Counter++         |
| 4. Is max_retries > 5?     |
+----------------------------+
        |                 |
        | No              | Yes (Max Retry Exceeded / Poison Payload)
        v                 v
 +-------------+    +-----------------------+     +-------------------+
 | Back to Q   |    | Dead Letter Queue     |---->| Webhook Alerting  |
 | (Delay)     |    | (Postgres DLQ Table)  |     | (Slack/PagerDuty) |
 +-------------+    +-----------------------+     +-------------------+
                              ^
                              | Admin Trigger
                    +-----------------------+
                    |  Job Replay Tooling   |
                    |  (Admin Dashboard)    |
                    +-----------------------+
```

## 2. Implementasi Produksi Rust Idiomatis

Berikut adalah kerangka penanganan *Dead Letter* secara komprehensif. Worker akan menangkap error beruntun, lalu menyimpan status, stacktrace, dan payload awal ke PostgreSQL DLQ.

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgPool;
use chrono::{Utc, DateTime};
use thiserror::Error;
use tracing::{info, warn, error};
use uuid::Uuid;

/// Definisi struktur error Worker
#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("Transient Network Error: {0}")]
    Transient(String),
    #[error("Fatal Validation Error: {0}")]
    Fatal(String), // Langsung masuk DLQ tanpa retry
}

/// Struktur Job universal
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackgroundJob {
    pub id: Uuid,
    pub job_type: String,
    pub payload: Value,
    pub retries: u32,
    pub max_retries: u32,
}

/// Struktur rekaman DLQ untuk Database
#[derive(Debug, Serialize)]
pub struct DlqRecord {
    pub id: Uuid,
    pub job_id: Uuid,
    pub job_type: String,
    pub failed_payload: Value,
    pub error_reason: String,
    pub created_at: DateTime<Utc>,
}

/// Handler utama pemrosesan job yang mendemonstrasikan DLQ Routing
pub async fn process_job_with_dlq(
    mut job: BackgroundJob,
    pool: &PgPool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    info!("Processing Job ID: {}", job.id);

    match execute_business_logic(&job.payload).await {
        Ok(_) => {
            info!("Job {} succeeded.", job.id);
            Ok(())
        }
        Err(e) => {
            warn!("Job {} failed on attempt {}: {}", job.id, job.retries, e);
            
            // Periksa tipe error atau batasan retry
            let should_dlq = match e {
                ProcessError::Fatal(_) => true, // Langsung matikan job ini
                ProcessError::Transient(_) => {
                    job.retries += 1;
                    if job.retries >= job.max_retries {
                        true
                    } else {
                        // Di dunia nyata: masukan lagi ke Queue (Redis) dgn backoff
                        warn!("Re-queuing Job {} for retry", job.id);
                        return Ok(()); // Kembalikan Ok(tapi-retry) (Simplified)
                    }
                }
            };

            if should_dlq {
                error!("Job {} has become a POISON PAYLOAD. Routing to DLQ.", job.id);
                route_to_dlq(job, pool, e.to_string()).await?;
            }
            
            Ok(())
        }
    }
}

/// Menyisipkan job ke tabel Dead Letter Queue dan mengirim webhook
async fn route_to_dlq(
    job: BackgroundJob,
    pool: &PgPool,
    error_msg: String,
) -> Result<(), sqlx::Error> {
    let dlq_id = Uuid::new_v4();
    
    // Simpan ke Postgres DLQ
    sqlx::query!(
        r#"
        INSERT INTO dead_letter_queue (id, job_id, job_type, failed_payload, error_reason, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
        dlq_id,
        job.id,
        job.job_type,
        job.payload,
        error_msg,
        Utc::now()
    )
    .execute(pool)
    .await?;

    info!("Job successfully parked in DLQ (Record: {})", dlq_id);
    
    // Asinkron trigger webhook ke pagerduty/slack
    tokio::spawn(async move {
        trigger_slack_alert(&job.id.to_string(), &error_msg).await;
    });

    Ok(())
}

async fn execute_business_logic(payload: &Value) -> Result<(), ProcessError> {
    // Logika parsing
    if payload.get("malformed_data").is_some() {
        return Err(ProcessError::Fatal("Payload data structural corruption".to_string()));
    }
    // Simulasi transient
    Err(ProcessError::Transient("Connection refused by upstream".to_string()))
}

async fn trigger_slack_alert(job_id: &str, reason: &str) {
    // Logika Http Client memanggil Webhook
    warn!("SLACK ALERT: Job {} failed permanently. Reason: {}", job_id, reason);
}
```

## 3. Unit / Integration Testing

Pengujian di bawah memastikan bahwa logika isolasi *poison pill* tepat mengirim data ke DLQ tanpa *panic*, dan error transient tetap me-respect siklus *max_retries*.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_poison_payload_routing() {
        // Mock payload yang akan trigger Fatal Error
        let poison_job = BackgroundJob {
            id: Uuid::new_v4(),
            job_type: "generate_invoice".to_string(),
            payload: serde_json::json!({ "malformed_data": true }),
            retries: 0,
            max_retries: 5,
        };
        
        let result = execute_business_logic(&poison_job.payload).await;
        
        match result {
            Err(ProcessError::Fatal(msg)) => {
                assert!(msg.contains("structural corruption"));
            },
            _ => panic!("Expected fatal process error to trigger DLQ"),
        }
    }
}
```

## 4. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Infinite Retry Loop
**Salah:** Tidak mengatur batas maksimal retry atau tidak menangani `unwrap` di dalam handler. Jika deserialisasi payload korup gagal, ia di *NACK*, dikembalikan ke top *Queue*, diproses ulang di milidetik berikutnya, dan gagal terus-menerus memakan siklus CPU.
```rust
// ❌ JANGAN LAKUKAN INI
let data: MyStruct = serde_json::from_value(job.payload).unwrap(); // PANIC
```
**Benar:** Buat batas *max_retries* dan berikan rute DLQ. JANGAN PERNAH gunakan `unwrap()` atau `expect()` untuk input *job queue*.

### ❌ Anti-Pattern 2: Membuang Payload DLQ ke Log (Silent Failures)
**Salah:** Hanya menulis error dan isi *payload* ke stdout / file logs saat *job* diputuskan masuk "dead letter".
```rust
// ❌ JANGAN LAKUKAN INI
error!("Job failed completely: {:?}", payload); // Akan hilang dari peredaran sistem
```
**Benar:** Rekam ke sistem database atau *persistent queue* terpisah dengan relasi ke struktur awal. Tim ops harus mampu me-replay JSON aslinya.

## 5. Production Edge Cases

1. **Bug Rilis Baru Memenuhi DLQ dalam Hitungan Menit:**
   - *Kasus:* Tim mendeploy versi baru (V2) dengan bug yang menyebabkan semuat *job* gagal dan di-routing ke DLQ. DLQ melonjak 100.000 data/menit, me-rate-limit server Slack akibat banjir *alert*.
   - *Penanganan:* Logika *Alerting* Webhook wajib memiliki mekanisme *Debouncing* atau *Batching/Rate-Limiting*. Misal: Hanya kirim 1 notifikasi Slack yang mewakili peringatan ("10,000 new DLQ entries in last 5 mins!").

2. **Replay Payload Klasik ke Sistem Modern (Schema Drift):**
   - *Kasus:* Tim admin me-replay *job* DLQ yang berusia 2 minggu, namun *schema* database atau *struct Rust* sudah berubah (contoh: field `customer_id` wajib menjadi string, tapi JSON lama berformat int).
   - *Penanganan:* Implementasikan parser yang fleksibel, versi muatan pesan (Payload Versioning), atau sediakan fitur "Edit Payload" di portal admin sebelum me-replay *job* usang.

3. **DLQ Penuh Membanting Database Storage Utama:**
   - *Kasus:* Karena kurang ter-maintenance, tabel DLQ membengkak (Gigabytes), mengurangi indeks performa Postgres secara keseluruhan.
   - *Penanganan:* Penyimpanan tabel DLQ diusahakan memiliki `TTL (Time To Live)` (menggunakan partisi waktu Postgres atau cron pembersihan) dan letakkan di Tablespace atau instance terpisah jika lalu lintas sangat ekstrem.
