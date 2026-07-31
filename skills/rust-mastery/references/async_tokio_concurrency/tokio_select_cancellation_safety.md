# Tokio Select & Cancellation Safety

## Konsep Utama
Macro `tokio::select!` memungkinkan task untuk menunggu berbagai masa depan (futures) secara bersamaan, merespons mana pun yang selesai (menyelesaikan *poll*) lebih dulu. Ini setara dengan fungsi `select()` atau `epoll_wait` di C, tetapi pada tingkat asinkron.

Ketika satu *branch* di `select!` selesai, Tokio **membatalkan (drop)** futures di *branch* lain yang belum selesai. Pembatalan ini memunculkan masalah kritis: **Cancellation Safety**. Sebuah future disebut *cancellation safe* jika di-drop di tengah eksekusinya tidak merusak state internal atau menghilangkan data (loss of state).

**Kasus Penggunaan:**
- Timeout pada network request (select antara `sleep` dan I/O read).
- Menunggu sinyal shutdown (select antara worker loop dan `CancellationToken`).
- Mem-multiplex channel membaca (select dari beberapa channel sekaligus).

## Arsitektur & Flow
```ascii
    Future 1: tcp_stream.read() ----> Pending
                                              \
    Future 2: ctrl_c_signal() ------> Pending  -- tokio::select! 
                                              /       | (waits)
    Future 3: sleep(5s) ------------> Ready! <--------+
                                              
    Action: 
    1. Eksekusi kode branch Future 3.
    2. DROP Future 1 dan Future 2. (Koneksi TCP tidak akan rusak karena `read` is cancellation safe)
```

## Kode Production-Ready

```rust
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::{sleep, timeout};
use tokio_util::sync::CancellationToken;

#[derive(Debug)]
pub enum TaskError {
    Timeout,
    Cancelled,
}

/// Menjalankan worker loop dengan perlindungan timeout per tugas dan 
/// global shutdown via CancellationToken.
pub async fn resilient_worker(
    mut rx: mpsc::Receiver<String>,
    token: CancellationToken,
) -> Result<(), TaskError> {
    loop {
        // tokio::select! secara default bersifat 'random' untuk mencegah 
        // starvation pada branch jika beberapa future siap bersamaan.
        // Jika kita ingin memprioritaskan branch (misal: sinyal mati diutamakan),
        // gunakan atribut `biased;`.
        tokio::select! {
            biased;

            // Prioritas 1: Sinyal pembatalan dari luar
            _ = token.cancelled() => {
                println!("Worker di-shutdown gracefully.");
                return Err(TaskError::Cancelled);
            }

            // Prioritas 2: Proses pesan dengan timeout
            msg_opt = rx.recv() => {
                match msg_opt {
                    Some(msg) => {
                        // Proses dengan perlindungan timeout
                        let process_result = timeout(
                            Duration::from_secs(2), 
                            process_message(msg)
                        ).await;
                        
                        if process_result.is_err() {
                            println!("Warning: Proses pesan timeout!");
                        }
                    }
                    None => {
                        // Channel ditutup
                        println!("Channel tertutup, worker exit.");
                        return Ok(());
                    }
                }
            }
        }
    }
}

// Dummy proses, tidak sepenuhnya cancellation safe jika memodifikasi shared state 
// rumit, tetapi karena di-drop utuh oleh `timeout`, ini aman.
async fn process_message(msg: String) {
    println!("Memproses: {}", msg);
    sleep(Duration::from_millis(500)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn test_cancellation() {
        let (tx, rx) = mpsc::channel(10);
        let token = CancellationToken::new();
        
        let token_clone = token.clone();
        let worker_handle = tokio::spawn(async move {
            resilient_worker(rx, token_clone).await
        });

        tx.send("test1".into()).await.unwrap();
        
        // Batalkan worker secara paksa
        token.cancel();
        
        let res = worker_handle.await.unwrap();
        assert!(matches!(res, Err(TaskError::Cancelled)));
    }
}
```

## Anti-Patterns

1. **Memasukkan Konstruk Non-Cancellation Safe ke `select!`**
   - **Contoh:** Membaca data dari `tokio::io::AsyncReadExt::read_exact` menggunakan stateful buffer di dalam branch loop `select!`.
   - **Bahaya:** Jika `select!` terputus (karena branch lain selesai) saat `read_exact` baru membaca setengah dari byte yang diminta, sisa byte yang ada di stream akan hilang, dan sinkronisasi protokol TCP rusak (data corruption).
   - **Solusi:** `tokio::sync::mpsc::Receiver::recv` bersifat *cancellation safe*. Untuk network I/O, hindari makro kombinator stateful, atau enkapsulasi pemrosesan ke dalam `tokio::spawn` terpisah sehingga I/O tidak terinterupsi.

2. **Lupa Menangani State yang Berubah Akibat Drop**
   - **Bahaya:** Mem-hold mutlak suatu guard (seperti semaphore guard) dan tidak memulihkannya jika future ter-cancel, atau state eksternal ditinggalkan inkonsisten.
   - **Solusi:** Gunakan pola RAII (Drop trait) untuk membersihkan *resources* atau me-rollback state jika eksekusi dibatalkan sebelum commit.

## Edge Cases & Defensive Programming
- **Biased Select:** Secara default, jika `rx.recv()` dan `token.cancelled()` keduanya siap (Ready) dalam iterasi yang sama, `tokio::select!` me-randomize eksekusi. Untuk *graceful shutdown*, Anda hampir selalu ingin mengecek token pembatalan *terlebih dahulu*. Itulah mengapa keyword `biased;` sangat krusial di sistem production.
- **CancellationToken vs watch::Receiver:** `CancellationToken` (dari `tokio_util`) lebih ringan dan dioptimalkan secara spesifik untuk sinyal *broadcast abort* dibandingkan dengan mengimplementasikan manual menggunakan `tokio::sync::watch::channel(false)`.
