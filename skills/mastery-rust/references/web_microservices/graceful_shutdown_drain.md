# Graceful Shutdown & Connection Draining

## Konsep Utama
Dalam microservices, restart aplikasi sering terjadi akibat deploy CI/CD, auto-scaling (Kubernetes), atau crash tak terduga. **Graceful Shutdown** adalah proses menghentikan aplikasi dengan cara:
1. Menolak koneksi baru (stop listening to TCP port).
2. Menyelesaikan pemrosesan request (inflight requests) yang sedang berjalan ("draining").
3. Menutup koneksi database dan resource lain dengan aman.

Di ekosistem Rust (Tokio & Axum), hal ini ditangani melalui signal handling OS (seperti `SIGTERM` / `SIGINT`) yang disambungkan ke mekanisme token pembatalan (misal `axum::Server::with_graceful_shutdown`).

**Kapan Digunakan:**
- Deployment tanpa downtime di Kubernetes (Pods diterminasi dengan `SIGTERM`).
- Mencegah *corrupted data* karena koneksi putus tiba-tiba saat transaksi berlangsung.

## Arsitektur & Flow

```ascii
+----------------+      +-------------------+      +------------------+
| OS / K8s       | ---> | Tokio Signal Hdlr | ---> | CancellationToken|
+----------------+      +-------------------+      +--------+---------+
  (SIGTERM/Ctrl+C)                                          |
                                                            v
+----------------+      +-------------------+      +--------+---------+
| Client 1 (WIP) | ---> | Axum Server       | <--- | .with_graceful.. |
+----------------+      +-------------------+      +------------------+
  (Finishes req)          (Stops accepting)
                          (Waits for Client 1)
```

## Production-Ready Code

```rust
use axum::{routing::get, Router};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::signal;
use tracing::{info, warn};

// Setup handler untuk menangkap OS signals
async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("Gagal menginisialisasi handler Ctrl+C");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("Gagal menginisialisasi handler signal SIGTERM")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            info!("Menerima signal Ctrl+C (SIGINT), memulai graceful shutdown");
        },
        _ = terminate => {
            info!("Menerima signal SIGTERM, memulai graceful shutdown");
        },
    }
}

pub async fn run_server() {
    let app = Router::new()
        .route("/", get(|| async { 
            // Simulasi long-running request
            tokio::time::sleep(Duration::from_secs(3)).await;
            "Hello World!" 
        }));

    let addr = SocketAddr::from(([127, 0, 0, 1], 8080));
    let listener = TcpListener::bind(addr).await.unwrap();
    info!("Server listening on {}", addr);

    // Bind Axum router menggunakan `axum::serve` dengan graceful shutdown
    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        warn!("Server error saat shutdown: {}", e);
    }

    info!("Graceful shutdown selesai. Membersihkan resource...");
    // Tempat yang tepat untuk membersihkan pool DB: pool.close().await;
}

#[cfg(test)]
mod tests {
    // Pengujian graceful shutdown biasanya diuji pada level integrasi (black box testing)
    // karena memanipulasi process signals sulit dilakukan dengan baik di unit test paralel.
}
```

## Anti-Patterns

1. **Force Kill Tanpa Menunggu Inflight Requests (Timeout Tak Terbatas)**
   - **MENGAPA BERBAHAYA:** Menggunakan `std::process::exit(0)` segera setelah menerima sinyal memutus koneksi klien di tengah jalan, mungkin di saat data setengah terkirim/ter-insert. Di sisi lain, jika aplikasi terjebak dalam deadlock, menunggu tanpa batas timeout juga akan memblokir deployment (Kubernetes akan membunuh dengan paksa via `SIGKILL` setelah `terminationGracePeriodSeconds`, yang defaultnya 30s).
2. **Background Tasks (Tokio::spawn) Tidak Terhubung dengan Sinyal Shutdown**
   - **MENGAPA BERBAHAYA:** Walaupun Axum akan men-drain HTTP connections, jika ada *worker thread* background (misalnya membaca SQS queue / Kafka) yang spawn secara independen tanpa `tokio_util::sync::CancellationToken` atau `broadcast::Receiver`, aplikasi Anda tidak akan berhenti (zombie process) meskipun server HTTP-nya sudah mati.

## Edge Cases & Defensive Programming
- **Keep-Alive Connections:** HTTP keep-alive dapat menyebabkan Axum kesulitan menutup TCP socket (karena idle). Konfigurasikan load balancer (Nginx/Envoy) untuk men-drain koneksi dengan baik, dan atur `timeout` parameter server agar koneksi idle diputus.
- **Draining Timeout:** Karena server akan menunggu inflight requests selesai selamanya secara default (saat `with_graceful_shutdown` terpanggil), penting untuk membungkus `axum::serve` Anda dengan `tokio::time::timeout` agar menjamin bahwa dalam, misal, maksimal 10 detik, aplikasi *akan* mati baik request selesai atau tidak, untuk patuh pada K8s constraints.
