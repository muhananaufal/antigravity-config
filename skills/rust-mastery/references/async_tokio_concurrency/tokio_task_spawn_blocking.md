# Tokio Task: Spawn Blocking & Rayon

## Konsep Utama
Rust async/await mengasumsikan model *cooperative multitasking*. Artinya, sebuah task asinkron **harus** secara rutin melepaskan kontrol kembali ke eksekutor (melalui `.await`) dengan sangat cepat (ideal < 1 milidetik). 

Jika sebuah task mengikat thread tanpa `await` (seperti deserialisasi JSON raksasa, operasi CPU-bound, atau query database via driver sinkron spt Diesel/rusqlite), ini disebut **Blocking**. Di Tokio, ini berbahaya karena memblokir worker thread yang bertugas menangani task lain.

Solusinya:
- **`tokio::task::spawn_blocking`**: Memindahkan eksekusi task blocking ke *thread pool khusus blocking* yang dikelola Tokio secara terpisah dari worker asinkron.
- **`rayon`**: Framework untuk data-parallelism CPU-bound. Sangat kuat untuk memproses *heavy calculation*, namun tidak terintegrasi langsung dengan async Tokio, sehingga butuh trik penghubung (`spawn_blocking`).

## Arsitektur & Flow (Isolasi Task Blocking)
```ascii
 [ Tokio Async Worker Pool (e.g. 4 Threads) ]
 Thread 1 | Thread 2 | Thread 3 | Thread 4
    |          |          |          |
  Async      Async      Async      Async
  Task       Task       Task       Task
    |
    +--> Oh tidak, butuh baca file 10GB pakai sinkron fs::read!
         |
         | (tokio::task::spawn_blocking)
         v
 [ Tokio Blocking Pool (Up to 512 Threads) ]
 Thread B1 (mengeksekusi fs::read secara sinkron) 
         |
         v (mengembalikan hasil, Async Task Thread 1 di-wake up)
```

## Kode Production-Ready

```rust
use tokio::task;
use std::time::Duration;
use serde_json::Value;

/// Simulasi komputasi sinkron yang sangat berat
fn expensive_cpu_operation(data: &str) -> Value {
    // Simulasi lag
    std::thread::sleep(Duration::from_millis(50));
    serde_json::from_str(data).unwrap_or_default()
}

pub async fn handle_request(payload: String) -> Result<Value, String> {
    // KITA TIDAK BOLEH memanggil `expensive_cpu_operation` langsung di sini,
    // karena akan men-starve (memblokir) worker thread asinkron.

    // 1. Offload ke blocking pool
    let join_handle = task::spawn_blocking(move || {
        // Blok kode ini berjalan di thread khusus (bukan asinkron)
        // Di sini aman menggunakan std::thread::sleep atau operasi blocking.
        expensive_cpu_operation(&payload)
    });

    // 2. Await hasil dari blocking task
    match join_handle.await {
        Ok(result) => Ok(result),
        Err(join_err) => {
            // Error terjadi jika thread blocking mengalami panic
            if join_err.is_panic() {
                Err("Internal Error: CPU bound task panicked!".into())
            } else {
                Err("Task cancelled".into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_blocking_offload() {
        let payload = r#"{"status": "ok"}"#.to_string();
        let result = handle_request(payload).await.unwrap();
        assert_eq!(result["status"], "ok");
    }
}
```

## Integrasi Lanjut dengan Rayon
Jika menggunakan `rayon`, jangan me-*await* iterasi parallel secara naif. Bungkus dengan saluran atau `spawn_blocking`.
```rust
use tokio::sync::oneshot;

pub async fn parallel_rayon_sort(mut data: Vec<i32>) -> Vec<i32> {
    let (tx, rx) = oneshot::channel();
    
    // Kirim pekerjaan ke Rayon global threadpool
    rayon::spawn(move || {
        // CPU bound work, berjalan murni di thread pool Rayon
        data.sort();
        let _ = tx.send(data);
    });

    // Await secara asinkron di Tokio untuk kembalian dari Rayon
    rx.await.unwrap_or_default()
}
```

## Anti-Patterns

1. **"Sedikit Blocking Nggak Apa-Apa"**
   - **Contoh:** Membaca file 1MB atau query Redis (yang dianggap cepat) menggunakan API sinkron (seperti `std::fs::read` atau library redis non-async).
   - **Bahaya:** Saat beban tinggi (10,000 req/sec), pengerjaan "cepat" 5ms akan bertumpuk, melumpuhkan epoll reactor Tokio. Latensi P99 sistem akan hancur dan network socket bisa timeout.
   - **Solusi:** Rule of thumb: Apapun di atas 10-50 micro-seconds, wajib di-offload atau gunakan alternatif asinkron (`tokio::fs`, `redis::aio`).

2. **Pool Tersendat (Thread Limit Exhaustion)**
   - **Bahaya:** `spawn_blocking` pool limit default Tokio adalah 512 thread. Jika Anda men-spawn 1000 tugas blocking jaringan sinkron (misal dari crate `reqwest::blocking`), aplikasi akan mentok dan *deadlock* pada tugas ke-513 karena menunggu thread blocking kosong.
   - **Solusi:** Batasi concurency akses ke tugas blocking dengan `tokio::sync::Semaphore` yang sesuai dengan limit koneksi fisik atau thread pool limit.

## Edge Cases & Defensive Programming
- **Panic Boundary:** Jika code di dalam `spawn_blocking` mengalami `panic!()`, panic tersebut tidak langsung membunuh aplikasi utama (kecuali diatur abort-on-panic). Sebaliknya, Tokio menangkapnya, dan `JoinHandle` mengembalikan error tipe panic. Penanganan defensif mengharuskan Anda mengekstrak `join_err.into_panic()` jika berniat melakukan logging forensik.
- **Cancellation Terputus:** Saat memanggil `.abort()` atau membatalkan `spawn_blocking`, future Tokio batal, TETAPI thread operasi sinkron di dalam threadpool akan **terus berjalan** sampai selesai (karena tidak ada mekanisme preemptive cancel di kernel thread Rust). Hati-hati dengan resource leak yang diakibatkan oleh thread blocking yang ditinggalkan ini.
