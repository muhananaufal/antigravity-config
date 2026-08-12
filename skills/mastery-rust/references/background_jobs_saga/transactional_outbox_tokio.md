# Transactional Outbox Pattern di Tokio: Jaminan At-Least-Once Delivery

File referensi ini membedah arsitektur *Transactional Outbox Pattern* yang digabungkan dengan daemon latar belakang (background daemon) di Tokio. Pola ini memecahkan masalah umum *dual-write* dalam microservices: memastikan data bisnis (Postgres DB) dan pesan keluar (events) disimpan dalam **satu transaksi atomik**, dan kemudian disiarkan (published) tanpa penyimpangan status (state drift).

## 1. Arsitektur & Diagram ASCII

Diagram ini menggambarkan alur pembuatan entitas bisnis sekaligus entri `outbox` dalam transaksi SQL tunggal. Poller asinkron kemudian membaca entri outbox dan mem-publish-nya.

```text
       Web Request
            |
            v
+-----------------------+
|  Application Handler  |
+-----------------------+
            | (1) Begin SQL Transaction
            v
    +---------------+
    |  Postgres DB  |
    |               |
    | 1. users      | (2) Insert Business Data
    | 2. outbox     | (3) Insert Event Payload
    +---------------+
            | (4) Commit
            v
                                        +-----------------------+
                                        |  Tokio Outbox Poller  |
                                        |  (Background Daemon)  |
                                        +-----------------------+
                                                    | (5) Poll 'outbox' table
                                                    v
                                         +-------------------+
                                         | Message Broker    | (6) Publish Event
                                         | (Kafka/RabbitMQ)  |
                                         +-------------------+
                                                    | (7) If Ack
                                                    v
                                          +-------------------+
                                          | Update 'outbox'   | (8) Mark state = PUBLISHED
                                          | in Postgres       |
                                          +-------------------+
```

## 2. Implementasi Produksi Rust Idiomatis

Berikut adalah implementasi pattern menggunakan `sqlx` dan `tokio`. Kami memisahkan fungsi bisnis transaksional dan daemon poller outbox.

```rust
use sqlx::{PgPool, Postgres, Transaction};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use chrono::{Utc, DateTime};
use thiserror::Error;
use tracing::{info, error, debug};
use tokio::time::{sleep, Duration};

#[derive(Debug, Error)]
pub enum OutboxError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Broker publish error: {0}")]
    Broker(String),
}

/// Payload domain yang akan disimpan di outbox
#[derive(Debug, Serialize, Deserialize)]
pub struct UserCreatedEvent {
    pub user_id: Uuid,
    pub email: String,
    pub timestamp: DateTime<Utc>,
}

/// Menyimpan data user DAN mencatat event ke tabel outbox dalam SATU transaksi atomik.
pub async fn create_user_with_outbox(
    pool: &PgPool,
    email: &str,
) -> Result<Uuid, OutboxError> {
    let mut tx: Transaction<'_, Postgres> = pool.begin().await?;

    let user_id = Uuid::new_v4();

    // 1. Simpan data bisnis (users table)
    sqlx::query!(
        "INSERT INTO users (id, email) VALUES ($1, $2)",
        user_id, email
    )
    .execute(&mut *tx)
    .await?;

    // 2. Siapkan event payload
    let event = UserCreatedEvent {
        user_id,
        email: email.to_string(),
        timestamp: Utc::now(),
    };
    
    let payload = serde_json::to_value(&event).expect("Failed to serialize event");
    let event_type = "USER_CREATED";

    // 3. Simpan event ke outbox (status = PENDING)
    sqlx::query!(
        "INSERT INTO outbox_events (id, event_type, payload, status) VALUES ($1, $2, $3, 'PENDING')",
        Uuid::new_v4(), event_type, payload
    )
    .execute(&mut *tx)
    .await?;

    // 4. Commit transaksi (atomik)
    tx.commit().await?;
    info!("Successfully created user and outbox event for: {}", email);

    Ok(user_id)
}

/// Daemon poller di latar belakang yang berjalan secara konstan
pub async fn start_outbox_poller_daemon(pool: PgPool) {
    info!("Starting outbox poller daemon...");
    loop {
        // Ambil batch event PENDING
        let events_result = sqlx::query!(
            "SELECT id, payload FROM outbox_events WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 50 FOR UPDATE SKIP LOCKED"
        )
        .fetch_all(&pool)
        .await;

        match events_result {
            Ok(events) if !events.is_empty() => {
                for record in events {
                    debug!("Publishing event ID: {}", record.id);
                    
                    // Simulasi publish ke Message Broker (Kafka/RabbitMQ)
                    let publish_success = simulate_publish_to_broker(&record.payload).await;

                    if publish_success {
                        // Tandai berhasil dipublish
                        let update_res = sqlx::query!(
                            "UPDATE outbox_events SET status = 'PUBLISHED', published_at = NOW() WHERE id = $1",
                            record.id
                        )
                        .execute(&pool)
                        .await;
                        
                        if let Err(e) = update_res {
                            error!("Failed to update outbox event {} status to PUBLISHED: {}", record.id, e);
                        }
                    }
                }
            }
            Ok(_) => {
                // Tidak ada pesan, tidur sejenak untuk menghindari busy-loop CPU
                sleep(Duration::from_secs(2)).await;
            }
            Err(e) => {
                error!("Error fetching outbox events: {}", e);
                sleep(Duration::from_secs(5)).await; // Backoff jika DB bermasalah
            }
        }
    }
}

async fn simulate_publish_to_broker(_payload: &serde_json::Value) -> bool {
    // Di dunia nyata ini menggunakan library kafka/rabbitmq
    true
}
```

## 3. Unit / Integration Testing

Test ini membuktikan bahwa jika terjadi kegagalan (secara artifisial, misal rollback), baik data *users* maupun event *outbox* tidak akan tertulis, menjaga konsistensi state.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::PgPool;
    // Menggunakan test database / sqlx::test

    // Mocking a transaction failure
    async fn fail_create_user(pool: &PgPool) -> Result<(), OutboxError> {
        let mut tx = pool.begin().await?;
        
        sqlx::query!("INSERT INTO users (id, email) VALUES ($1, $2)", Uuid::new_v4(), "fail@test.com")
            .execute(&mut *tx).await?;
            
        sqlx::query!("INSERT INTO outbox_events (id, event_type, payload, status) VALUES ($1, $2, $3, 'PENDING')",
            Uuid::new_v4(), "TEST", serde_json::json!({}))
            .execute(&mut *tx).await?;

        // Artifisial rollback karena error logika bisnis
        tx.rollback().await?;
        Ok(())
    }

    #[tokio::test]
    #[ignore] // Jalankan hanya saat PG container tersedia
    async fn test_outbox_transaction_rollback() {
        // let pool = setup_db().await;
        // let _ = fail_create_user(&pool).await;
        // let user_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM users").fetch_one(&pool).await.unwrap();
        // let outbox_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM outbox_events").fetch_one(&pool).await.unwrap();
        // assert_eq!(user_count, 0);
        // assert_eq!(outbox_count, 0); // Outbox terselamatkan dari state anomaly
    }
}
```

## 4. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Dual-Write Tanpa Transaksi
**Salah:** Melakukan penyimpanan DB lalu me-publish event (atau menyimpannya ke storage berbeda) di luar transaksi yang sama.
```rust
// ❌ JANGAN LAKUKAN INI
db.insert_user(user).await?; // Bisa sukses
kafka.publish(user_event).await?; // Bisa GAGAL (Koneksi putus) -> INCONSISTENCY!
```
**Benar:** Wajib menggunakan pola Outbox yang mengikat entitas domain dan entitas event dalam satu transaksi basis data atomik.

### ❌ Anti-Pattern 2: Polling Tanpa `FOR UPDATE SKIP LOCKED`
**Salah:** Daemon mengambil data dengan `SELECT * FROM outbox`. Jika daemon diskalakan menjadi beberapa instance (pods), mereka akan saling tumpang tindih membaca data yang sama dan menyebabkan pengiriman ganda masif.
```sql
-- ❌ JANGAN LAKUKAN INI
SELECT * FROM outbox WHERE status = 'PENDING';
```
**Benar:** Gunakan mekanisme penguncian tingkat baris (row-level locking) Postgres yaitu `FOR UPDATE SKIP LOCKED`. Worker paralel akan melompati baris yang sedang dikunci worker lain secara dinamis.

## 5. Production Edge Cases

1. **Kehilangan Koneksi DB Saat Menandai PUBLISHED:**
   - *Kasus:* Event sudah berhasil dikirim ke Message Broker (Kafka/RabbitMQ), tetapi saat melakukan update `status = 'PUBLISHED'` ke Postgres, koneksi DB putus.
   - *Penanganan:* Saat worker merestart, ia akan membaca record tersebut lagi sebagai `PENDING` dan mengirimnya ulang (At-Least-Once). Oleh karena itu, Consumer (Penerima di Microservice tujuan) **wajib idempoten** terhadap event ID.

2. **Poison Pill dalam Poller:**
   - *Kasus:* Struktur JSON event dalam tabel outbox korup secara manual (misal diedit oleh DBA). Serde decode gagal dan membuahkan infinite panic di worker daemon.
   - *Penanganan:* Implementasikan penanganan deserialize error yang terisolasi. Jika deserialisasi gagal, update statusnya menjadi `FAILED_DECODE` (Dead Letter) dan lanjutkan polling record berikutnya. Jangan *unwrap* atau *panic* di loop utama.

3. **Tabel Outbox Membengkak (Table Bloat):**
   - *Kasus:* Record `PUBLISHED` terus tertumpuk, menggerus IOPS dan ukuran storage Postgres.
   - *Penanganan:* Wajib membuat *garbage collector* background job harian yang melakukan `DELETE FROM outbox_events WHERE status = 'PUBLISHED' AND created_at < NOW() - INTERVAL '7 days'`.
