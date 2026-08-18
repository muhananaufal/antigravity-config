# Tokio Graceful Shutdown & Lifecycle Management

## Konsep Utama
Dalam sistem backend production (terutama di environment Kubernetes atau kontainer docker), service tidak boleh mati begitu saja saat menerima pembaruan (deploy) atau restart. Terminasi paksa (hard kill) memutuskan koneksi user di tengah-tengah transaksi.

**Graceful Shutdown** memastikan bahwa saat program menerima sinyal terminasi (`SIGTERM` atau `CTRL+C`/`SIGINT`), sistem akan:
1. Berhenti menerima request/koneksi baru.
2. Memberikan waktu agar koneksi yang sedang diproses (inflight requests) selesai.
3. Membersihkan resource (database pool connection diputus secara baik, memory di-flush).
4. Exit secara bersih.

Kita mengatur ini di Tokio menggunakan `tokio::signal`, `tokio_util::sync::CancellationToken`, dan `tokio::task::JoinSet`.

## Arsitektur & Flow (Graceful Drain)
```ascii
   SIGTERM diterima (Kubernetes pod termination)
          |
          v
  Broadcast CancellationToken
          |
  +-------+--------------------+
  |                            |
  v                            v
Listener TCP dihentikan      Worker Task menerima token cancel
(Tidak ada req baru)         (Menolak task baru, menyelesaikan task saat ini)
                               |
                               | (Menunggu inflight)
  <----------------------------+
  |
  v
Semua Task selesai (JoinSet kosong) -> DB Disconnect -> Process Exit (0)
```

## Kode Production-Ready

```rust
use std::time::Duration;
use tokio::signal;
use tokio::task::JoinSet;
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

/// Mensimulasikan server koneksi TCP (Listener)
async fn connection_listener(token: CancellationToken, mut join_set: JoinSet<()>) {
    let mut connection_id = 0;
    
    loop {
        tokio::select! {
            // Prioritas shutdown
            _ = token.cancelled() => {
                println!("Listener berhenti menerima koneksi baru...");
                break;
            }
            // Menerima request baru
            _ = sleep(Duration::from_millis(200)) => {
                connection_id += 1;
                println!("Request masuk ID: {}", connection_id);
                
                // Spawn pekerjaan ke JoinSet agar kita bisa melacak kelarnya nanti
                let token_clone = token.clone();
                join_set.spawn(async move {
                    handle_connection(connection_id, token_clone).await;
                });
            }
        }
    }

    // Fase Draining: Tunggu SEMUA task di dalam JoinSet selesai!
    println!("Draining inflight requests (Menunggu sisa request)...");
    while let Some(res) = join_set.join_next().await {
        if let Err(e) = res {
            println!("Worker panik/gagal: {}", e);
        }
    }
    println!("Semua worker berhasil diselesaikan.");
}

async fn handle_connection(id: u32, token: CancellationToken) {
    tokio::select! {
        // Kita mensimulasikan pekerjaan yang memakan waktu 1 detik
        _ = sleep(Duration::from_secs(1)) => {
            println!("Request {} selesai diproses dengan sukses.", id);
        }
        _ = token.cancelled() => {
            // Dalam beberapa kasus, Anda mungkin ingin memutus pekerjaan seketika,
            // atau memperbolehkan penyelesaian. Jika memperbolehkan penyelesaian,
            // hiraukan token cancellation di fungsi ini.
            println!("Request {} dibatalkan secara paksa (Fast Shutdown).", id);
        }
    }
}

pub async fn run_server() {
    let token = CancellationToken::new();
    let join_set = JoinSet::new();

    // Jalankan komponen server utama
    let server_handle = tokio::spawn(
        connection_listener(token.clone(), join_set)
    );

    // Block hingga menerima sinyal dari OS
    let ctrl_c = async {
        signal::ctrl_c().await.expect("Failed to listen for event");
    };

    #[cfg(unix)]
    let sigterm = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("Failed to bind SIGTERM")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let sigterm = std::future::pending::<()>(); // Dummy untuk windows

    // Tunggu mana saja yang memicu shutdown (Ctrl-C atau Terminate)
    tokio::select! {
        _ = ctrl_c => println!("Menerima Ctrl-C!"),
        _ = sigterm => println!("Menerima SIGTERM!"),
    }

    // Picu pembatalan global
    token.cancel();

    // Tunggu server shutdown total (Graceful await)
    let _ = server_handle.await;
    println!("Shutdown sukses!");
}

// Catatan: test ditiadakan karena sinyal OS sulit di-mock di standar Cargo test tanpa crate khusus
```

## Anti-Patterns

1. **Mengabaikan Sinyal SIGTERM (Hanya handle Ctrl+C)**
   - **Bahaya:** `tokio::signal::ctrl_c()` HANYA mendeteksi sinyal `SIGINT`. Ketika aplikasi di-deploy di Kubernetes, K8s mengirimkan `SIGTERM` untuk mematikan pod. Jika Anda tidak meng-handle `SIGTERM`, aplikasi akan mengabaikan peringatan tersebut dan berjalan terus sampai K8s mengirim `SIGKILL` 30 detik kemudian (Hard crash).
   - **Solusi:** Kombinasikan `ctrl_c` dengan handler `signal::unix::signal(SignalKind::terminate())` di sistem unix.

2. **Draining Tanpa Batas Waktu (Infinite Wait)**
   - **Bahaya:** Jika sebuah task mengalami deadlock network I/O, `join_set.join_next().await` akan memblokir selamanya, dan aplikasi Anda tidak pernah keluar secara bersih (Zombie process).
   - **Solusi:** Bungkus operasi *wait inflight* / *drain* menggunakan `tokio::time::timeout`. Berikan waktu maksimal misalnya 10 detik. Jika lebih dari itu, aplikasikan Drop paksa.

## Edge Cases & Defensive Programming
- **Zero-Downtime Deployments:** Menggunakan shutdown graceful hanyalah sebelah mata koin. Anda juga perlu socket transfer, misalnya `SO_REUSEPORT`, sehingga proses backend v2 yang baru naik bisa mulai menerima koneksi baru dari OS *sebelum* proses v1 yang lama selesai melakukan pembuangan (drain) dan mati.
- **JoinSet Capping:** `JoinSet::spawn` menyimpan referensi memori hingga Anda memanggil `join_next`. Jika Anda hanya melakukan `.spawn()` berjuta kali tanpa secara reguler memanen *zombie tasks* yang sukses menggunakan polling (atau task spawn terpisah), Anda akan mengalami Memory Leak pelan-pelan. Loop yang sehat rutin memanggil `join_set.try_join_next()` di background.
