# Utilitas Test Async Tokio

## 1. Konsep Utama & Kapan Digunakan
Menguji kode asynchronous (futures) yang bergantung pada Time (waktu) atau I/O (jaringan/file) sangat rentan di dunia nyata. Eksekusi test bisa berjalan amat lambat jika setiap test benar-benar menunggu 5 detik, atau flaky akibat resource race condition.
Crate `tokio-test` memberikan alat pengujian murni untuk task async, seperti time pausing (waktu yang berjalan instan), mem-mock I/O Streams (`AsyncRead` / `AsyncWrite`), dan assertion state polling secara manual (`Pending` vs `Ready`).

Gunakan utilitas ini ketika:
- Menguji retry backoff logic (yang tidur belasan detik) sehingga bisa berjalan dalam hitungan nanodetik.
- Menguji custom `Future` implementations Anda yang rumit atau stateful `Stream`.
- Memastikan batas-batas IO (Chunked data network) dibaca/tulis terstruktur via Mock Builder.

## 2. Arsitektur / Flow

```ascii
[ Waktu Nyata = 10ms ]
       |  ( tokio::time::pause() )
       v
[ Waktu Virtual ] ---> Task 1 (sleep 5s) ---> (Waktu melompat seketika +5s)
                  ---> Task 2 timeout trigger aktif otomatis
```

## 3. Kode Rust Production-Ready

```rust
use tokio::time::{sleep, Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub async fn retry_task() -> Result<(), ()> {
    // Simulasi retry yang lama (1 menit)
    sleep(Duration::from_secs(60)).await;
    Ok(())
}

pub async fn process_protocol(mut stream: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin) -> std::io::Result<()> {
    let mut buf = [0u8; 4];
    stream.read_exact(&mut buf).await?;
    if &buf == b"PING" {
        stream.write_all(b"PONG").await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_test::io::Builder;
    use tokio_test::{assert_ready, assert_pending, task::spawn};

    // 1. Time Travel testing
    #[tokio::test(start_paused = true)] // Otomatis pause time di tokio test runtime
    async fn test_fast_retry_logic() {
        let start = tokio::time::Instant::now();
        
        // Memakan waktu 60 detik secara virtual, tapi tereksekusi seketika (0 detik dunia nyata)
        retry_task().await.unwrap(); 
        
        assert!(start.elapsed() >= Duration::from_secs(60));
    }

    // 2. Mocking Async I/O Boundaries
    #[tokio::test]
    async fn test_protocol_ping_pong() {
        // Builder ini membungkus AsyncRead dan AsyncWrite.
        // Sangat eksak: akan panic jika program membaca/menulis byte di luar urutan yang diatur.
        let mut mock_stream = Builder::new()
            .read(b"PING")   // Meniru menerima data
            .write(b"PONG")  // Ekspektasi mengirim data
            .build();

        process_protocol(&mut mock_stream).await.unwrap();
    }
    
    // 3. Manual Polling Assertion
    #[test]
    fn test_custom_future_state() {
        // tokio_test::task::spawn ini BUKAN tokio::spawn. Ini untuk menjalankan manual test polling
        let mut task = spawn(sleep(Duration::from_millis(100)));
        
        // Future belum selesai (seharusnya pending)
        assert_pending!(task.poll());
        
        // Anda bisa men-simulate waktu/bangun manual (waker) lalu check:
        // assert_ready!(task.poll());
    }
}
```

## 4. Anti-Pattern Spesifik
1. **Menggunakan `std::thread::sleep` atau `Instant::now` bawaan STD di dalam blok asinkron.**
   - *Bahaya*: Memblokir (block) OS thread sepenuhnya, menghancurkan penjadwalan (scheduler) Tokio. Selain itu, fungsi `start_paused` dari Tokio test tidak bisa mempercepat durasi dari STD time.
   - *Solusi*: Selalu gunakan `tokio::time::sleep` dan `tokio::time::Instant`.
2. **Tidak menutup Builder I/O tokio-test secara lengkap.**
   - *Bahaya*: Jika kode Anda me-loop baca data namun Builder IO tidak punya urutan buffer `.read` tersisa, task Anda akan hang tanpa waker di dalam test.

## 5. Edge Cases & Defensive Programming
- **Time auto-advancement**: Pada Tokio `start_paused = true`, jika seluruh task asinkron dalam posisi terblokir menunggu timer (idle), runtime akan otomatis "memajukan (fast-forward)" waktu sejauh timer terdekat, agar task tersebut hidup kembali. Jika ada task macet (deadlock mutlak) tanpa timer, maka Tokio Test akan hang dan panic.
- **Interaksi Library**: Waspadai librari luar yang Anda test menggunakan background threads/runtimes dari crate lain (seperti `reqwest` atau OS-native file polling). Waktu (time pause) dari Tokio test *tidak* akan memengaruhi eksekusi eksternal mereka, sehingga behavior timing dapat menjadi kacau antar thread nyata vs thread waktu virtual.
