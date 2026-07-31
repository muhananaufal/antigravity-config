# Async Channels & Messaging

## Konsep Utama
Rust dan Tokio mempromosikan paradigma *"Do not communicate by sharing memory; instead, share memory by communicating"*. Channel di Tokio digunakan untuk komunikasi *lock-free* antar task asinkron.

Tokio menyediakan empat jenis channel utama:
1. **`mpsc` (Multi-Producer, Single-Consumer):** Digunakan untuk mengirim pesan dari banyak worker ke satu pengelola (misal: metrics aggregator, database connection multiplexer). Tersedia varian *bounded* (kapasitas terbatas, memberikan backpressure) dan *unbounded* (tanpa batas).
2. **`oneshot` (Single-Producer, Single-Consumer):** Hanya mengirim SATU pesan. Sangat ringan. Sering dikombinasikan dengan `mpsc` sebagai *callback/response channel*.
3. **`broadcast` (Multi-Producer, Multi-Consumer):** Setiap konsumen (receiver) mendapatkan salinan (clone) dari *setiap* pesan. Digunakan untuk pub/sub internal. Jika receiver lambat, ia akan mengalami `Lagged` error.
4. **`watch` (Single-Producer, Multi-Consumer):** Mirip dengan broadcast, tetapi hanya menyimpan *satu* nilai terbaru. Receiver hanya peduli pada status terkini, bukan setiap transisi (misal: sinyal config reload atau shutdown).

## Arsitektur & Flow (MPSC + Oneshot Pattern)
Pola yang sering dipakai adalah "Request-Response" tanpa *shared lock*:
```ascii
[Task A (Producer)]                           [Task B (State Manager)]
    |                                                 |
    | send(Command::Get(key, oneshot_tx))             |
    |------------------------------------------------>|
    |                                                 | process request
    | <-----------------------------------------------| send(Value) via oneshot_tx
    | await response                                  |
```

## Kode Production-Ready

```rust
use tokio::sync::{mpsc, oneshot};
use std::collections::HashMap;

// Tipe perintah dengan oneshot channel untuk memberikan respons balik.
#[derive(Debug)]
pub enum Command {
    Get {
        key: String,
        resp: oneshot::Sender<Option<String>>,
    },
    Set {
        key: String,
        val: String,
        resp: oneshot::Sender<()>,
    }
}

pub struct StateManager {
    // Channel bounded untuk menerima perintah (menyediakan backpressure)
    cmd_rx: mpsc::Receiver<Command>,
    store: HashMap<String, String>,
}

impl StateManager {
    pub fn new() -> (Self, mpsc::Sender<Command>) {
        // Gunakan bounded channel (1000) untuk mencegah Out-Of-Memory (OOM)
        let (tx, rx) = mpsc::channel(1000);
        (
            Self {
                cmd_rx: rx,
                store: HashMap::new(),
            },
            tx,
        )
    }

    pub async fn run(mut self) {
        // Loop akan otomatis berhenti jika semua Sender (tx) didrop
        while let Some(cmd) = self.cmd_rx.recv().await {
            match cmd {
                Command::Get { key, resp } => {
                    let val = self.store.get(&key).cloned();
                    // Abaikan error jika receiver sudah drop/mati
                    let _ = resp.send(val);
                }
                Command::Set { key, val, resp } => {
                    self.store.insert(key, val);
                    let _ = resp.send(());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_state_manager() {
        let (manager, tx) = StateManager::new();
        
        // Jalankan manager di background task
        tokio::spawn(async move {
            manager.run().await;
        });

        // Test Set
        let (resp_tx, resp_rx) = oneshot::channel();
        tx.send(Command::Set {
            key: "foo".into(),
            val: "bar".into(),
            resp: resp_tx,
        }).await.unwrap();
        resp_rx.await.unwrap();

        // Test Get
        let (resp_tx, resp_rx) = oneshot::channel();
        tx.send(Command::Get {
            key: "foo".into(),
            resp: resp_tx,
        }).await.unwrap();
        
        let val = resp_rx.await.unwrap();
        assert_eq!(val, Some("bar".into()));
    }
}
```

## Anti-Patterns

1. **Menggunakan `mpsc::unbounded_channel` secara Sembarangan**
   - **Bahaya:** Jika producer memproduksi pesan lebih cepat daripada yang bisa diproses consumer, antrean di channel akan terus membesar tanpa batas, menyebabkan *memory leak* dan OOM kill pada proses.
   - **Solusi:** Selalu default ke `mpsc::channel(N)` untuk memberikan *backpressure*. Jika antrean penuh, method `.send().await` akan memblokir (yield) producer.

2. **Channel Leak (Tidak Men-drop Sender Terakhir)**
   - **Bahaya:** Consumer yang menunggu di `while let Some(msg) = rx.recv().await` tidak akan pernah keluar (deadlock) jika masih ada referensi ke `Sender` yang tersisa, bahkan jika producer sudah tidak beroperasi.
   - **Solusi:** Pastikan `Sender` di-drop ketika tidak digunakan. Seringkali ini memerlukan trik seperti men-drop `Sender` bawaan setelah task-task spawn, atau memindahkan *ownership* `Sender` secara teliti.

## Edge Cases & Defensive Programming
- **Kapasitas Bounded vs CPU Overhead:** Ukuran channel `mpsc::channel(1)` memiliki overhead sinkronisasi per-elemen yang relatif lebih tinggi dibanding `mpsc::channel(64)`. Tuning buffer size sangat bergantung pada workload latensi.
- **Broadcast Lagging:** Di channel `broadcast`, selalu periksa nilai kembali dari `.recv().await`. Jika terjadi `Err(RecvError::Lagged(n))`, artinya consumer ketinggalan `n` pesan yang sudah terhapus. Defensive programming mengharuskan consumer bisa resync full-state jika tertinggal (lag).
