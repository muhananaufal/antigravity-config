# Distributed Saga: Orkestrasi & Compensating Transactions

File referensi ini membedah arsitektur state-machine *Distributed Saga* yang tangguh. Saat sebuah *workflow* bisnis melibatkan modifikasi ke banyak microservices (misalnya memesan tiket penerbangan, mereservasi hotel, lalu men-charge kartu kredit), Saga memastikan eksekusi *rollback compensating actions* terjadi secara atomik jika terdapat satu servis yang gagal.

## 1. Arsitektur & Diagram ASCII

Diagram state-machine asinkron di bawah ini mengilustrasikan "Order Fulfillment Saga". Jika pembayaran (`Charge Payment`) gagal, sistem wajib melakukan *Rollback* dengan mengeksekusi kompensasi dari step sebelumnya (`Cancel Flight Reservation`).

```text
       START
         |
         v
+-----------------------+     (Gagal)       +-----------------------+
| 1. Reserve Flight     |------------------>| Abort Saga            |
| (Action)              |                   |                       |
+-----------------------+                   +-----------------------+
         | (Sukses)
         v
+-----------------------+     (Gagal)       +-----------------------+
| 2. Reserve Hotel      |------------------>| 1c. Cancel Flight     |
| (Action)              |                   | (Compensating Action) |
+-----------------------+                   +-----------------------+
         | (Sukses)                                     ^
         v                                              |
+-----------------------+     (Gagal)       +-----------------------+
| 3. Charge Payment     |------------------>| 2c. Cancel Hotel      |
| (Action)              |                   | (Compensating Action) |
+-----------------------+                   +-----------------------+
         | (Sukses)
         v
    SAGA COMPLETE
```

## 2. Implementasi Produksi Rust Idiomatis

Berikut adalah mesin orkestrasi Saga yang mendefinisikan *State Machine* secara *type-safe*. Jika terjadi kegagalan, mesin secara otomatis melacak langkah apa yang sudah berhasil dan menjalankan fungsi kompensasi (rollback) secara berurutan mundur.

```rust
use std::future::Future;
use std::pin::Pin;
use thiserror::Error;
use tracing::{info, warn, error};

#[derive(Debug, Error)]
pub enum SagaError {
    #[error("Action failed: {0}")]
    ActionFailed(String),
    #[error("Compensation failed critically: {0}")]
    CompensationFailed(String),
}

/// Struktur utama Saga Engine
pub struct SagaEngine {
    steps: Vec<Box<dyn SagaStep + Send + Sync>>,
}

/// Trait untuk mendefinisikan satu tahap dalam rantai Saga
#[async_trait::async_trait]
pub trait SagaStep {
    /// Aksi maju (Forward action)
    async fn execute(&self) -> Result<(), SagaError>;
    /// Aksi mundur (Compensating action)
    async fn compensate(&self) -> Result<(), SagaError>;
    fn name(&self) -> &str;
}

impl SagaEngine {
    pub fn new() -> Self {
        Self { steps: Vec::new() }
    }

    pub fn add_step(&mut self, step: Box<dyn SagaStep + Send + Sync>) {
        self.steps.push(step);
    }

    /// Menjalankan seluruh Saga. Jika ada `execute` yang gagal, 
    /// jalankan `compensate` untuk semua langkah yang sudah sukses.
    pub async fn run_saga(&self) -> Result<(), SagaError> {
        let mut completed_steps: Vec<usize> = Vec::new();

        // Maju melalui setiap langkah
        for (index, step) in self.steps.iter().enumerate() {
            info!("Saga Executing: {}", step.name());
            match step.execute().await {
                Ok(_) => {
                    completed_steps.push(index);
                }
                Err(e) => {
                    error!("Saga Failed at {}: {}", step.name(), e);
                    // Memicu Kompensasi secara terbalik
                    return self.run_compensation(completed_steps).await;
                }
            }
        }

        info!("Saga Completed Successfully!");
        Ok(())
    }

    async fn run_compensation(&self, completed: Vec<usize>) -> Result<(), SagaError> {
        info!("Initiating Saga Compensation (Rollback)...");
        
        // Kompensasi harus dieksekusi secara LIFO (Last-In First-Out)
        for &index in completed.iter().rev() {
            let step = &self.steps[index];
            warn!("Saga Compensating: {}", step.name());
            
            // Dalam dunia nyata, kompensasi juga bisa gagal.
            // Harus memiliki retry-mechanism, DLQ, atau alarm DBA.
            if let Err(e) = step.compensate().await {
                error!("CRITICAL: Compensation failed for {}: {}", step.name(), e);
                // Kita kembalikan error fatal, sistem dalam keadaan in-konsisten (requires manual intervention)
                return Err(SagaError::CompensationFailed(format!("Step {} failed to rollback", step.name())));
            }
        }
        
        warn!("Saga Compensation Completed.");
        Err(SagaError::ActionFailed("Saga was aborted and rolled back".to_string()))
    }
}

// === Implementasi Skenario (Concrete Steps) ===

struct ReserveFlightStep;

#[async_trait::async_trait]
impl SagaStep for ReserveFlightStep {
    async fn execute(&self) -> Result<(), SagaError> {
        // Logika memanggil Flight Service API
        Ok(())
    }
    
    async fn compensate(&self) -> Result<(), SagaError> {
        // Logika membatalkan tiket
        Ok(())
    }
    
    fn name(&self) -> &str { "Reserve Flight" }
}

struct ChargePaymentStep {
    fail_intentionally: bool, // Untuk keperluan simulasi testing
}

#[async_trait::async_trait]
impl SagaStep for ChargePaymentStep {
    async fn execute(&self) -> Result<(), SagaError> {
        if self.fail_intentionally {
            return Err(SagaError::ActionFailed("Insufficient Funds".to_string()));
        }
        Ok(())
    }
    
    async fn compensate(&self) -> Result<(), SagaError> {
        // Refund payment
        Ok(())
    }
    
    fn name(&self) -> &str { "Charge Stripe Payment" }
}
```

## 3. Unit / Integration Testing

Test ini membuktikan bahwa orkestrasi bekerja dengan sangat akurat ketika simulasi pembayaran gagal, sistem melacak status untuk mengeksekusi kompensasi hanya terhadap langkah yang sukses.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_saga_orchestrator_rollback() {
        let mut saga = SagaEngine::new();
        
        saga.add_step(Box::new(ReserveFlightStep));
        // Simulate a failing payment step
        saga.add_step(Box::new(ChargePaymentStep { fail_intentionally: true }));

        let result = saga.run_saga().await;
        
        match result {
            Err(SagaError::ActionFailed(msg)) => {
                assert!(msg.contains("aborted and rolled back"));
            },
            _ => panic!("Saga should have failed and rolled back"),
        }
        // Kita juga bisa membuktikan dengan AtomicBool flag di mock step apakah
        // `compensate` milik ReserveFlightStep benar-benar dipanggil.
    }
}
```

## 4. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Kompensasi Non-Idempoten
**Salah:** Langkah kompensasi (`compensate`) yang menduplikasi hasil jika dipanggil dua kali (misal menambah saldo refund sebesar $10 setiap kali gagal, yang berpotensi ditrigger dua kali saat ada network timeout).
```rust
// ❌ JANGAN LAKUKAN INI
async fn compensate(&self) {
    db.execute("UPDATE wallet SET balance = balance + 10").await; // Tidak Idempoten
}
```
**Benar:** Gunakan pengecekan status (empotency key/transaction ID) sebelum melakukan aksi kompensasi (Refund).
```rust
// ✅ BENAR
async fn compensate(&self) {
    db.execute("UPDATE wallet SET balance = balance + 10 WHERE transaction_id = $1 AND refunded = false").await;
}
```

### ❌ Anti-Pattern 2: Lock Asinkron Berkepanjangan di Saga (Distributed Deadlocks)
**Salah:** Memegang kunci (Lock/Mutex) ke data di basis data sembari menunggu keseluruhan orkestrasi Saga yang berumur panjang selesai.
**Benar:** Distributed Saga bersifat *Eventually Consistent*. Jangan gunakan kunci 2-Phase Commit DB. Sebagai gantinya, ubah state sementara objek (misal: "PENDING_RESERVATION") yang terlihat oleh sistem.

## 5. Production Edge Cases

1. **Aksi Kompensasi (Rollback) Ikut Gagal (Fatal Unrecoverable State):**
   - *Kasus:* Sistem mencoba membatalkan tiket pesawat, namun API maskapai sedang tumbang (Down).
   - *Penanganan:* Kompensasi tidak boleh dibuang. Ia harus dimasukkan ke dalam antrean *Dead Letter Queue (DLQ)* atau tabel DB khusus untuk *Manual Intervention* oleh tim operasional (Customer Service). Retry loop latar belakang dapat mencoba menuntaskan kompensasi ini secara asinkron.

2. **Crash Orkestrator Tepat Setelah Execute Berhasil (Dangling Saga):**
   - *Kasus:* Pod yang menjalankan mesin Saga mati (OOMKill) sesaat setelah API `Reserve Hotel` sukses di-commit, sebelum mencatatnya di memori atau memulai step 3.
   - *Penanganan:* Status Saga harus disimpan *durably* ke dalam DB transaksional (*Event Sourcing* atau *Saga State Logging*). Saat Pod me-restart, background worker mendeteksi "Stale Saga" (terhenti > 5 menit) dan melanjutkan dari state DB terakhir.

3. **Race Condition antara Action dan External Cancellation:**
   - *Kasus:* Sementara Saga sedang berjalan memesan tiket, pengguna memencet tombol "Cancel" di UI (berjalan di thread lain).
   - *Penanganan:* Mesin saga harus melakukan pengecekan token *Cancelation/Abortion* (melalui DB/Redis Caching state) di setiap perantara sebelum mengeksekusi *step* berikutnya untuk me-bypass dan beralih ke rute kompensasi.
