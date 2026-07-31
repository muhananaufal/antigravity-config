# Saga Pattern & Distributed Transactions

## Konsep Utama
Dalam arsitektur microservices terdistribusi, transaksi ACID tradisional (2PC / Two-Phase Commit) terlalu lambat dan rentan deadlock. Saga Pattern merangkai transaksi lokal, di mana kegagalan di tengah jalan memicu eksekusi *Compensating Transactions* (rollback fungsional/bisnis) secara berurutan. Ini sering digabungkan dengan **Transactional Outbox** untuk memastikan event publish "at-least-once".

## Arsitektur & Diagram Alur (ASCII)
```text
(Saga Choreography Flow)

[Order Service] --> (Local Tx: Create Order [PENDING])
                --> (Local Tx: Insert to Outbox [ORDER_CREATED])
                      | (Async Relay Worker)
                      v
                [Message Broker / Kafka]
                      |
                      v
[Payment Service] <- (Consume event ORDER_CREATED)
                  -> (Local Tx: Charge Card)
                  -> (Local Tx: Insert to Outbox [PAYMENT_SUCCESS / FAILED])
                      |
                      v
                [Message Broker] -> (Order Service: Update status to COMPLETED/REJECTED)
```

## Kode Rust Production-Ready
```rust
use async_trait::async_trait;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SagaError {
    #[error("Action failed: {0}")]
    ActionFailed(String),
    #[error("Compensation failed: {0}")]
    CompensationFailed(String),
}

/// Mewakili satu langkah lokal dalam Saga
#[async_trait]
pub trait SagaStep {
    async fn execute(&mut self) -> Result<(), SagaError>;
    async fn compensate(&mut self) -> Result<(), SagaError>;
}

/// Orkestrator saga secara memori (contoh)
pub struct SagaOrchestrator {
    steps: Vec<Box<dyn SagaStep + Send + Sync>>,
}

impl SagaOrchestrator {
    pub fn new() -> Self {
        Self { steps: Vec::new() }
    }

    pub fn add_step(&mut self, step: Box<dyn SagaStep + Send + Sync>) {
        self.steps.push(step);
    }

    pub async fn run(&mut self) -> Result<(), SagaError> {
        let mut executed = 0;
        
        for step in self.steps.iter_mut() {
            if let Err(e) = step.execute().await {
                // Eksekusi gagal! Inisiasi proses Kompensasi mundur
                return self.run_compensation(executed).await.and(Err(e));
            }
            executed += 1;
        }
        Ok(())
    }

    async fn run_compensation(&mut self, executed_count: usize) -> Result<(), SagaError> {
        for i in (0..executed_count).rev() {
            if let Err(e) = self.steps[i].compensate().await {
                // Sangat gawat! Kompensasi gagal! Butuh intervensi manusia/Admin
                return Err(SagaError::CompensationFailed(format!("Step {} failed to rollback: {}", i, e)));
            }
        }
        Ok(())
    }
}

// Implementasi Mock Step
struct PaymentStep {
    amount: u64,
}

#[async_trait]
impl SagaStep for PaymentStep {
    async fn execute(&mut self) -> Result<(), SagaError> {
        // Pseudo: Idempotent API call to Payment Provider
        // Outbox.insert(PaymentDoneEvent)
        println!("Payment: Charged {}", self.amount);
        Ok(()) // Simulasikan sukses
    }

    async fn compensate(&mut self) -> Result<(), SagaError> {
        // Pseudo: Idempotent Refund API
        println!("Payment: Refunded {}", self.amount);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FailingInventoryStep;
    #[async_trait]
    impl SagaStep for FailingInventoryStep {
        async fn execute(&mut self) -> Result<(), SagaError> {
            Err(SagaError::ActionFailed("Out of stock".into()))
        }
        async fn compensate(&mut self) -> Result<(), SagaError> { Ok(()) }
    }

    #[tokio::test]
    async fn test_saga_rollback() {
        let mut saga = SagaOrchestrator::new();
        saga.add_step(Box::new(PaymentStep { amount: 100 }));
        saga.add_step(Box::new(FailingInventoryStep));

        let res = saga.run().await;
        // Ekspektasi: execute Payment -> execute Inventory(Fail) -> compensate Payment(Refund)
        assert!(res.is_err());
        match res.unwrap_err() {
            SagaError::ActionFailed(msg) => assert_eq!(msg, "Out of stock"),
            _ => panic!("Expected ActionFailed"),
        }
    }
}
```

## Anti-Patterns
1. **Tidak memiliki Idempotency Key pada handler**
   *Mengapa berbahaya:* Karena sistem event (Kafka/RabbitMQ) berjalan pada model "At-Least-Once", pesan kompensasi (Refund) bisa saja diterima dua kali oleh service `Payment`. Tanpa Idempotency Key (misal mem-blokir duplikat di DB via `tx_id`), uang pelanggan akan di-refund ganda.
2. **Kompensasi sinkron tanpa Retry / Outbox**
   *Mengapa berbahaya:* Jika service `Inventory` memanggil API eksternal secara langsung untuk membatalkan item dan API itu timeout, Saga akan berada pada "State Tidak Pasti" permanen. Gunakan *Transactional Outbox* sehingga event pembatalan disimpan di DB secara persisten lokal lalu di-relay background worker dengan *exponential backoff*.

## Edge Cases & Defensive Programming
- **Poison Pill Messages (Dead Letter Queue):**
  Event yang error secara persisten akibat bug validasi (bukan error temporal network) akan memblokir *Outbox/Kafka Consumer* selamanya dalam loop retry. Wajib tangkap error tersebut, arahkan ke *Dead Letter Queue (DLQ)*, dan berikan alert bagi tim engineer.
- **Kompensasi "Pivot" Gagal (Irrecoverable State):**
  Jika transaksi maju gagal, dan fungsi `compensate()` *juga* gagal (bahkan setelah *retry limit*), data akan korup (uang telah ditarik, tapi tiket tidak jadi dicetak). Wajibkan sistem menerbitkan metrik status INCONSISTENT ke dasbor agar Customer Service dapat mengeksekusi rekonsiliasi manual harian (Cron Audit).
