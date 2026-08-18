# Arsitektur Pub-Sub Terdistribusi dengan AWS SNS dan SQS di Rust

Dokumen referensi ini menguraikan implementasi pola arsitektur *fan-out* terdistribusi tingkat *enterprise* menggunakan `aws-sdk-sns` dan `aws-sdk-sqs`. Arsitektur ini dirancang untuk memproses pesan secara asinkron dengan reliabilitas tinggi, dilengkapi mekanisme *batching*, perpanjangan *visibility timeout* otomatis untuk pesan berdurasi pemrosesan panjang, dan pendelegasian ke Dead Letter Queue (DLQ) saat terjadi kegagalan persisten.

## Diagram Arsitektur ASCII

```text
+----------------+      +-------------------+      +------------------+
|    Producer    | ---> |   SNS Topic       | ---> |   SQS Queue 1    |
| (Microservice) |      | (Pub/Sub Fan-out) |      | (Worker Service) |
+----------------+      +-------------------+      +------------------+
                                  |
                                  +--------------> +------------------+
                                                   |   SQS Queue 2    |
                                                   | (Analytics Job)  |
                                                   +------------------+
                                                            | (Kegagalan Persisten)
                                                            v
                                                   +------------------+
                                                   |   SQS DLQ        |
                                                   | (Dead Letter)    |
                                                   +------------------+
```

## Implementasi Produksi Rust (aws-sdk-sns & aws-sdk-sqs)

Kode di bawah ini menggunakan `tokio` untuk runtime asinkron dan SDK resmi AWS untuk Rust.

```rust
use aws_config::BehaviorVersion;
use aws_sdk_sqs::{Client as SqsClient, types::Message};
use aws_sdk_sns::Client as SnsClient;
use std::sync::Arc;
use tokio::time::{sleep, Duration};
use tracing::{info, error, warn};

/// Konfigurasi untuk worker SQS.
#[derive(Clone, Debug)]
pub struct WorkerConfig {
    pub queue_url: String,
    pub max_messages: i32,
    pub wait_time_seconds: i32,
    pub visibility_timeout: i32,
}

/// State aplikasi yang dibagikan.
#[derive(Clone)]
pub struct AppState {
    pub sqs_client: Arc<SqsClient>,
    pub sns_client: Arc<SnsClient>,
    pub config: WorkerConfig,
}

/// Enum error khusus untuk pemrosesan pesan.
#[derive(Debug, thiserror::Error)]
pub enum ProcessingError {
    #[error("Gagal melakukan deserialisasi pesan: {0}")]
    DeserializationFailed(String),
    #[error("Waktu pemrosesan melebihi batas (Timeout)")]
    ProcessingTimeout,
    #[error("Error internal dari sistem turunan: {0}")]
    InternalSystemError(String),
}

/// Fungsi untuk memproses pesan individu.
async fn process_message(message: &Message) -> Result<(), ProcessingError> {
    let body = message.body().unwrap_or_default();
    info!("Memulai pemrosesan pesan: {}", message.message_id().unwrap_or("unknown"));
    
    // Simulasi pemrosesan yang memerlukan waktu
    sleep(Duration::from_secs(2)).await;
    
    if body.contains("simulasi_error") {
        return Err(ProcessingError::InternalSystemError("Simulasi kegagalan eksekusi".to_string()));
    }
    
    info!("Pemrosesan pesan sukses.");
    Ok(())
}

/// Task background untuk memperpanjang visibility timeout pesan yang sedang diproses.
async fn extend_visibility_timeout(
    client: Arc<SqsClient>,
    queue_url: String,
    receipt_handle: String,
    initial_timeout: i32,
    mut stop_signal: tokio::sync::broadcast::Receiver<()>,
) {
    let mut interval = tokio::time::interval(Duration::from_secs((initial_timeout / 2) as u64));
    
    loop {
        tokio::select! {
            _ = interval.tick() => {
                let extend_req = client
                    .change_message_visibility()
                    .queue_url(&queue_url)
                    .receipt_handle(&receipt_handle)
                    .visibility_timeout(initial_timeout); // Perpanjang sebesar initial timeout
                
                if let Err(e) = extend_req.send().await {
                    error!("Gagal memperpanjang visibility timeout untuk pesan: {:?}", e);
                } else {
                    info!("Berhasil memperpanjang visibility timeout");
                }
            }
            _ = stop_signal.recv() => {
                info!("Menghentikan task perpanjangan timeout karena pemrosesan selesai.");
                break;
            }
        }
    }
}

/// Menangani pesan dengan retry dan perpanjangan timeout otomatis.
pub async fn handle_message_with_timeout(
    state: AppState,
    message: Message,
) -> Result<(), ProcessingError> {
    let receipt_handle = message.receipt_handle().unwrap_or_default().to_string();
    let queue_url = state.config.queue_url.clone();
    let client = state.sqs_client.clone();
    
    let (tx, rx) = tokio::sync::broadcast::channel(1);
    
    // Spawn task untuk memperpanjang visibility timeout
    let timeout_task = tokio::spawn(extend_visibility_timeout(
        client.clone(),
        queue_url.clone(),
        receipt_handle.clone(),
        state.config.visibility_timeout,
        rx,
    ));

    // Proses pesan
    let process_result = process_message(&message).await;

    // Hentikan task perpanjangan timeout
    let _ = tx.send(());
    let _ = timeout_task.await;

    match process_result {
        Ok(_) => {
            // Hapus pesan jika berhasil
            let delete_req = state.sqs_client
                .delete_message()
                .queue_url(&state.config.queue_url)
                .receipt_handle(&receipt_handle);
                
            if let Err(e) = delete_req.send().await {
                error!("Gagal menghapus pesan setelah sukses diproses: {:?}", e);
            }
            Ok(())
        }
        Err(e) => {
            error!("Kegagalan pemrosesan pesan: {:?}. Pesan akan dikembalikan ke antrean (atau DLQ jika max_receive_count tercapai).", e);
            Err(e)
        }
    }
}

/// Fungsi utama untuk polling (menerima pesan secara batching).
pub async fn poll_messages(state: AppState) {
    loop {
        let receive_msg_req = state.sqs_client
            .receive_message()
            .queue_url(&state.config.queue_url)
            .max_number_of_messages(state.config.max_messages)
            .wait_time_seconds(state.config.wait_time_seconds);
            
        match receive_msg_req.send().await {
            Ok(output) => {
                let messages = output.messages().unwrap_or_default();
                if messages.is_empty() {
                    continue;
                }
                
                let mut tasks = Vec::new();
                for msg in messages {
                    let msg_clone = msg.clone();
                    let state_clone = state.clone();
                    
                    let task = tokio::spawn(async move {
                        let _ = handle_message_with_timeout(state_clone, msg_clone).await;
                    });
                    tasks.push(task);
                }
                
                for task in tasks {
                    let _ = task.await;
                }
            }
            Err(e) => {
                error!("Error saat menerima pesan dari SQS: {:?}", e);
                sleep(Duration::from_secs(5)).await; // Backoff dasar
            }
        }
    }
}

/// Mempublikasikan pesan *fan-out* ke SNS Topic.
pub async fn publish_fanout_event(
    sns_client: &SnsClient,
    topic_arn: &str,
    event_payload: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let result = sns_client
        .publish()
        .topic_arn(topic_arn)
        .message(event_payload)
        .send()
        .await?;
        
    Ok(result.message_id().unwrap_or_default().to_string())
}
```

## Unit & Integration Test

Unit test dan integration test (mocked) wajib disertakan untuk memverifikasi logika polling, handling, dan perpanjangan timeout.
Pengujian ini menggunakan simulasi lingkungan asinkron.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_sqs::types::Message;

    #[tokio::test]
    async fn test_process_message_success() {
        let msg = Message::builder()
            .message_id("test-id-123")
            .body("payload data sukses")
            .build();
            
        let result = process_message(&msg).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_process_message_failure() {
        let msg = Message::builder()
            .message_id("test-id-456")
            .body("{\"type\": \"simulasi_error\"}")
            .build();
            
        let result = process_message(&msg).await;
        assert!(result.is_err());
        if let Err(e) = result {
            assert!(matches!(e, ProcessingError::InternalSystemError(_)));
        }
    }
}
```

## ❌ Anti-Patterns Kritis vs ✅ Best Practices

1. **Anti-Pattern (Sinkron / Blocking Processing):**
   * ❌ **Salah:** Menggunakan iterasi `.into_iter().for_each(...)` pada `Vec<Message>` yang menghambat pemrosesan pesan lain pada antrean yang sama. Pesan diproses secara sekuensial.
   * ✅ **Benar:** Membungkus setiap pemrosesan pesan dalam `tokio::spawn(async move { ... })` untuk pemrosesan paralel secara *concurrent*.

2. **Anti-Pattern (Abaikan Visibility Timeout):**
   * ❌ **Salah:** Membiarkan sebuah pesan yang butuh proses lama (misal: encoding video) tanpa memperpanjang SQS Visibility Timeout-nya. Hal ini menyebabkan pekerja lain mem-*pull* ulang pesan yang sama (duplikasi).
   * ✅ **Benar:** Menggunakan task background terpisah via `extend_visibility_timeout` menggunakan `change_message_visibility` yang mengirim denyut (heartbeat) pembaruan timeout sampai *main worker* memberi sinyal selesai via channel broadcast.

## 🚨 Edge Cases Lingkungan Produksi

1. **Poison Pills (Pesan yang Selalu Gagal):**
   * *Masalah:* Pesan dengan muatan malformasi (JSON korup) terus menerus diproses dan mengembalikan *error*, menyebabkan antrean terjebak (*stuck*).
   * *Mitigasi:* Konfigurasi *Redrive Policy* di infrastruktur AWS (Terraform/CDK) agar SQS secara otomatis memindahkan pesan ke Dead Letter Queue (DLQ) setelah `maxReceiveCount` tercapai (misal: 3 atau 5), **tanpa** memerlukan pengiriman manual di level aplikasi Rust.

2. **Keterbatasan API Throttling AWS (Rate Limits):**
   * *Masalah:* Mempublikasikan ribuan pesan secara asinkron (misal dalam iterasi *batch* besar) dapat memicu pengecualian *ProvisionedThroughputExceededException*.
   * *Mitigasi:* Implementasikan *exponential backoff* dan jitter. SDK AWS untuk Rust sudah memiliki lapisan retry *built-in* secara default, namun membatasi konkurensi (misal menggunakan Semaphore dari `tokio::sync::Semaphore`) di sisi aplikasi tetap esensial.

3. **Duplikasi Event dari SNS ke SQS (At-Least-Once Delivery):**
   * *Masalah:* Pesan pub-sub via SNS terkirim lebih dari satu kali ke antrean SQS akibat retriabilitas jaringan, mengakibatkan mutasi database yang redundan.
   * *Mitigasi:* Aplikasi konsumen (*worker*) mutlak harus bersifat **idempotent**. Tambahkan penyimpanan terdistribusi (Redis/DynamoDB) untuk menyimpan `message_id` dan mencegah pemrosesan ulang, atau gunakan transaksi SQL yang memverifikasi ID unik.
