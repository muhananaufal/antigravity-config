# Tokio Runtime & Async Internals

## Konsep Utama
Tokio adalah runtime asinkron paling populer di ekosistem Rust. Rust sendiri tidak menyediakan runtime async bawaan, melainkan hanya menyediakan *state machine generator* (melalui `Future` dan `async`/`await`). Tokio menyediakan eksekutor, I/O selector (epoll/kqueue), dan timer.

Terdapat dua jenis eksekutor utama di Tokio:
1. **Multi-thread (Work-stealing) Runtime**: Default saat menggunakan `#[tokio::main]`. Cocok untuk aplikasi jaringan throughput tinggi. Menjalankan *worker threads* sebanyak jumlah CPU core logis.
2. **Current-thread Runtime**: Dikonfigurasi dengan `#[tokio::main(flavor = "current_thread")]`. Berjalan hanya di satu thread. Sangat efisien untuk sistem embedded, WebAssembly, atau aplikasi yang tidak memerlukan skalabilitas multi-core (karena menghindari overhead sinkronisasi antar-thread).

**Kasus Penggunaan:**
- **High-Frequency Trading (HFT)**: Mengkustomisasi thread affinitiy, worker pool, dan max blocking threads untuk meminimalkan latensi P99.
- **Microservices**: Tuning stack size dan pool size agar efisien pada memory-constrained containers (Kubernetes).

## Arsitektur & Flow (Work-Stealing)
```ascii
+-----------------------------------------------------------+
|                      Tokio Runtime                        |
|                                                           |
|  +-------------+       +-------------+    +------------+  |
|  | Worker 1    |       | Worker 2    |    | Blocking   |  |
|  | (Thread)    |       | (Thread)    |    | Pool       |  |
|  |             | steal |             |    | (Threads)  |  |
|  | Local Queue | <---- | Local Queue |    |            |  |
|  | [T1, T2]    |       | [T5, T6]    |    | [B1, B2]   |  |
|  +-------------+       +-------------+    +------------+  |
|         ^                     ^                  ^        |
|         |                     |                  |        |
|         v                     v                  v        |
|  +------------------------------------------------------+ |
|  |                  Global Task Queue                   | |
|  |                  [T3, T4, T7, T8]                    | |
|  +------------------------------------------------------+ |
+-----------------------------------------------------------+
```

## Kode Production-Ready

```rust
use std::time::Duration;
use tokio::runtime::{Builder, Handle};
use tokio::task;

/// Mengkonfigurasi runtime kustom untuk high-performance service.
pub fn start_custom_runtime() -> std::io::Result<()> {
    // Hindari menggunakan #[tokio::main] secara buta. 
    // Builder memungkinkan fine-tuning untuk production.
    let rt = Builder::new_multi_thread()
        .worker_threads(4) // Spesifikasikan jumlah thread (misal: CPU core - 1)
        .thread_name("hft-async-worker")
        .thread_stack_size(3 * 1024 * 1024) // 3MB stack per thread (default 2MB)
        .max_blocking_threads(512) // Batas thread untuk operasi sinkron/blocking
        .enable_all() // Aktifkan timer dan I/O
        .build()?;

    // Blok thread utama sampai seluruh runtime selesai dieksekusi.
    rt.block_on(async {
        println!("Runtime started!");
        
        // Spawn task asinkron
        let handle = tokio::spawn(async {
            process_data().await;
        });

        // Ambil handle saat ini (berguna jika dilempar ke thread/konteks lain)
        let current_handle = Handle::current();
        
        current_handle.spawn(async {
            // Task lain
        });

        let _ = handle.await;
    }); // Saat scope berakhir, runtime akan di-shutdown

    // Shutdown gracefully: berikan waktu maksimal 5 detik untuk inflight tasks
    rt.shutdown_timeout(Duration::from_secs(5));
    Ok(())
}

async fn process_data() {
    tokio::time::sleep(Duration::from_millis(10)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_custom_runtime_creation() {
        assert!(start_custom_runtime().is_ok());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_async_function() {
        process_data().await;
    }
}
```

## Anti-Patterns

1. **CPU-bound Blocking Task di Async Context**
   - **Contoh:** Melakukan hashing Argon2 atau membaca file besar menggunakan `std::fs` langsung di dalam eksekutor asinkron.
   - **Bahaya:** Worker thread Tokio akan "tercekik" (starvation). Karena worker thread tidak bisa memproses task asinkron lain, latensi sistem akan naik tajam.
   - **Solusi:** Selalu gunakan `tokio::task::spawn_blocking` untuk I/O sinkron atau perhitungan berat.

2. **Membuat Multiple Runtimes Secara Tidak Sengaja**
   - **Contoh:** Memanggil `Builder::new_multi_thread().build().unwrap().block_on(...)` berkali-kali di berbagai thread.
   - **Bahaya:** Overhead thread context-switching dan memori sangat besar. Timer dan I/O selector akan berjalan ganda.
   - **Solusi:** Buat *satu* instance `Runtime` dan bagikan `Handle` clone-able jika perlu men-spawn task dari luar konteks asinkron.

## Edge Cases & Defensive Programming
- **Thread Local Storage (TLS):** Hati-hati menggunakan `thread_local!` di Tokio work-stealing runtime. Task asinkron bisa di-*yield* dan di-resume di worker thread yang *berbeda*, menyebabkan hilangnya data atau kondisi inkonsisten. Gunakan `tokio::task_local!` sebagai gantinya.
- **Shutdown Timeout:** Jika Anda tidak menggunakan `shutdown_timeout`, Tokio akan langsung memutus (drop) semua blocking threads tanpa menunggu selesai, yang bisa merusak konsistensi file I/O atau database connection. Selalu definisikan mekanisme shutdown eksplisit.
