# 🚀 CGroup Resource Limits & Graceful Kill (Anti-OOM & Bebas Putus)

## 1. Arsitektur Memori dan Eksekusi Kematian Kontainer
Ketika aplikasi Rust beroperasi di Kubernetes/Docker dengan spesifikasi memory limit (misal: 128Mi), kernel Linux `cgroup v2` memantau ketat alokasi memori halaman fisik (RSS - Resident Set Size). Masalahnya, sistem alokator memori standar Linux (atau jemalloc) terkadang tidak menyadari batasan cgroup ini, lalu mengekspansi *arena* memori terlalu besar. Akibatnya kernel akan melakukan tindakan ekstrem: mengirimkan sinyal `SIGKILL` tak berampun (`OOMKilled`). 

Di sisi eksekusi, saat orchestrator (K8s) melakukan rolling update, ia akan mengirim sinyal `SIGTERM`. Jika aplikasi Rust tidak menanganinya secara asinkron (*graceful shutdown*), koneksi client yang sedang berlangsung akan terputus paksa menghasilkan status `502 Bad Gateway`.

### Diagram ASCII: Sinyal Penghentian dan OOM
```text
KUBERNETES / DOCKER DEPLOYMENT
       |
       | (Sinyal Selesai / Rolling Update)
       +---> [ SIGTERM ] ---> Dikirim ke PID 1 (Rust App)
                                |
                                +--> Tokio Signal Handler menangkap.
                                +--> Menolak request HTTP baru.
                                +--> Menyelesaikan request lama s/d 30 detik (Graceful)
                                +--> Tutup koneksi DB -> Exit(0).
       |
       | (Batas Memory 128MB Dilanggar / Memory Leak)
       +---> [ SIGKILL (OOM) ] ---> Kernel langsung menghancurkan PID 1.
                                    Tidak bisa di-catch/trap oleh program Rust.
                                    Client langsung Error (RST tcp reset).
```

## 2. Kode Rust Idiomatis: Tokio Graceful Shutdown
Implementasikan `tokio::signal` untuk memblokir terminasi program sampai server mematikan dirinya secara elegan.

```rust
use std::net::SocketAddr;
use std::time::Duration;
use tokio::signal;
use tokio::time::sleep;
use axum::{routing::get, Router};

// Handler simulasi proses lama
async fn slow_handler() -> &'static str {
    sleep(Duration::from_secs(5)).await;
    "Process Complete!"
}

#[tokio::main]
async fn main() {
    let app = Router::new().route("/slow", get(slow_handler));
    let addr = SocketAddr::from(([0, 0, 0, 0], 8080));
    println!("Server running on {}", addr);

    // Bind server axum
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    
    // Pasang handler dengan graceful shutdown
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();

    println!("Server gracefully stopped. Database connections closed.");
}

/// Menunggu `CTRL+C` atau `SIGTERM` dari Kubernetes
async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("Failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => println!("Received Ctrl-C (SIGINT). Shutting down..."),
        _ = terminate => println!("Received SIGTERM from Docker/K8s. Shutting down..."),
    }
}
```

## 3. Penyesuaian Allocator (jemalloc) untuk CGroup Limits
Untuk mencegah allocator default menggunakan pola eksploitatif memori berlebihan, Rust dapat diubah untuk menggunakan `jemalloc` dengan flag tuning latar belakang.

Tambahkan di `Cargo.toml`:
```toml
[dependencies]
tikv-jemallocator = "0.5"
```

Dalam `main.rs`:
```rust
#[cfg(not(target_env = "msvc"))]
use tikv_jemallocator::Jemalloc;

#[cfg(not(target_env = "msvc"))]
#[global_allocator]
static GLOBAL: Jemalloc = Jemalloc;
```

Dalam Dockerfile (Tuning Environment Variables):
```dockerfile
# Memerintahkan jemalloc membuang (purge) memory arena yang tidak terpakai kembali ke OS
# Mencegah memory fragmentation dan RSS palsu naik sehingga terkena OOMKill
ENV MALLOC_CONF="background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:2000"
```

## 4. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Mengabaikan SIGTERM pada Async Runtime
**Masalah**: Developer mengandalkan `unwrap()` dan tidak mengikat sinyal OS ke server loop. Saat Docker menghentikan kontainer, ia mengeksekusi `kill -15 (SIGTERM)`. Karena program Rust tidak merespon/mengabaikan, Docker akan menunggu 10 detik lalu murka dengan mengirim `kill -9 (SIGKILL)`, memutuskan paksa seluruh database transaction yang kritis.
**Solusi (✅)**: Selalu pasang `.with_graceful_shutdown(shutdown_signal())` seperti pada contoh `Axum` di atas untuk membersihkan state memori (flush buffer, disk sync).

### ❌ Anti-Pattern 2: Thread Pool Tokiot/Blocking Memblokir Shutdown
**Masalah**: Anda memiliki tugas `tokio::task::spawn_blocking` yang loop selamanya atau sleep panjang. Signal handler tertangkap, tapi runtime `tokio::main` tetap hang menunggu proses blocking selesai, hingga akhirnya terkena batas waktu `terminationGracePeriodSeconds` Kubernetes.
**Solusi (✅)**: Gunakan `CancellationToken` (dari crate `tokio-util`) untuk merambatkan sinyal pembatalan ke seluruh worker threads / channel sehingga loop yang berjalan dapat menghentikan iterasinya ("break") secara instan saat SIGTERM tiba.

## 5. Production Edge Cases

1. **OOMKilled akibat Limit vs Request (K8s) Terlalu Cekat**:
   K8s menetapkan Memory Request 100Mi, Limit 120Mi. Dalam kasus sudden traffic burst, Rust alokasi heap spike sangat instan (meski de-alokasi juga cepat). Kernel `cgroup v2` langsung mengeksekusi OOMKilled tanpa peduli memori tersebut akan langsung direlakan sesudahnya. **Mitigasi**: Berikan rasio ruang lega (`headroom`). Set Limit minimal 30-50% lebih besar dari konsumsi puncak profil memori (misal Limit 256Mi, Request 128Mi).

2. **Koneksi Keep-Alive Terlalu Lama (Liveness Probe K8s)**:
   Aplikasi menolak traffic baru namun *graceful shutdown* mengambil 45 detik (karena download file besar client). Padahal, `terminationGracePeriodSeconds` di K8s secara default hanya 30 detik. K8s tidak akan segan menembak mati (SIGKILL). **Mitigasi**: Atur `terminationGracePeriodSeconds: 60` di manifest K8s deployment Anda, atau terapkan timeout pada request-level maksimal 20-30 detik.

3. **PID 1 Problematika Shell Eksekusi Dockerfile**:
   Banyak developer keliru menuliskan instruksi di Dockerfile dengan gaya string (Shell Form):
   `ENTRYPOINT "/app/my_rust_service"`
   Ini akan meluncurkan `/bin/sh -c "/app/my_rust_service"`. Proses PID 1 adalah Bash/Shell, bukan aplikasi Rust Anda! Bash (sh) secara default tidak meneruskan propagasi sinyal SIGTERM ke proses anakannya. Aplikasi Anda tidak pernah mendapat sinyal mati dan selalu terbunuh paksa.
   **Mitigasi Wajib**: Gunakan **Exec Form** berbasis array JSON.
   `ENTRYPOINT ["/app/my_rust_service"]`
