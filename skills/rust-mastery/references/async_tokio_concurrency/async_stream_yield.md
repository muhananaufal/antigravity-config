# Async Streams & Yield

## Konsep Utama
Dalam dunia asinkron, jika kita ingin memproduksi atau mengonsumsi deretan data (sequence) seiring waktu tanpa memblokir seluruh memori (lazy), kita menggunakan trait `Stream` (analogi asinkron dari trait `Iterator`).

Implementasi manual dari `Stream` seringkali melelahkan karena harus menangani *state machine* dan *pinning* (`Pin<&mut Self>`). Karenanya, ekosistem Rust banyak mengandalkan crate `async-stream` (`stream!` macro) untuk menghasilkan stream menggunakan sintaks `yield` yang sangat natural.

Operasi pada Stream umumnya dimanipulasi dengan trait extention `StreamExt` (dari crate `futures` atau `tokio-stream`).

## Arsitektur & Flow (Buffered Stream)
Mencegah lambatnya Producer memblokir Consumer, atau sebaliknya.
```ascii
Stream (Generator)              Buffer (Buffered 3)           Consumer (Foreach)
   yield Item 1  ------> [ Item 1, Empty, Empty ] -------> Consumer takes Item 1 (Processing... 1s)
   yield Item 2  ------> [ Item 2, Empty, Empty ]            |
   yield Item 3  ------> [ Item 2, Item 3, Empty ]           | 
   yield Item 4  ------> [ Item 2, Item 3, Item 4 ]          |
   yield Item 5 (BLOCKED! Backpressure! Producer Yields!)    |
                                                           Consumer finishes Item 1
                 <------- (Buffer punya ruang) <------------- 
   yield Item 5  ------> [ Item 5, Item 3, Item 4 ] -------> Consumer takes Item 2...
```

## Kode Production-Ready

```rust
use async_stream::stream;
use futures::stream::{Stream, StreamExt};
use std::time::Duration;
use tokio::time::sleep;

/// Memproduksi stream ID, misalnya dari database paginasi.
/// `stream!` memungkinkan kita menggunakan sintaks `yield`.
pub fn fetch_user_ids() -> impl Stream<Item = u32> {
    stream! {
        for i in 1..=10 {
            // Simulasi latensi jaringan kecil saat memfetch batch data
            sleep(Duration::from_millis(10)).await;
            yield i; // Emit/Kirim data
        }
    }
}

/// Mensimulasikan pengambilan detail user (I/O asinkron yang lambat)
async fn fetch_user_details(id: u32) -> String {
    sleep(Duration::from_millis(50)).await;
    format!("User_{}", id)
}

/// Fungsi proses yang menerapkan concurency dan backpressure
pub async fn process_users_concurrently() -> Vec<String> {
    let mut results = Vec::new();
    
    // Pipeline pemrosesan Stream:
    let mut stream = fetch_user_ids()
        // Map data stream menjadi Future asinkron (pemanggilan detail)
        .map(|id| async move { fetch_user_details(id).await })
        // Buffer future-future tersebut! 
        // Ini akan menjalankan MAKSIMAL 3 future secara concurrent.
        // Jika stream generator lebih cepat, ia akan tertahan (backpressure).
        .buffered(3);

    // Mengkonsumsi stream (harus menggunakan `while let` karena for-loop async 
    // belum stabil di Rust native (masih menunggu std::async_iter)).
    while let Some(user_data) = stream.next().await {
        results.push(user_data);
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_stream_processing() {
        let res = process_users_concurrently().await;
        assert_eq!(res.len(), 10);
        assert_eq!(res[0], "User_1");
        assert_eq!(res[9], "User_10");
    }
}
```

## Anti-Patterns

1. **Menggunakan `.map(...).await` dalam Stream For-Loop Tanpa `buffered`/`buffer_unordered`**
   - **Contoh:**
     ```rust
     while let Some(id) = stream.next().await {
         let data = fetch(id).await; // <-- SEKUENSIAL TOTAL
     }
     ```
   - **Bahaya:** Anda menyia-nyiakan keuntungan async. Iterasi pertama harus selesai fetch sebelum iterasi kedua dimulai. Waktu total = `n * latensi`.
   - **Solusi:** Gunakan `stream.map(fetch).buffered(CONCURRENCY_LIMIT)` (mempertahankan urutan) atau `buffer_unordered` (tidak peduli urutan, lebih cepat) sehingga stream mengeksekusi banyak task secara tumpang tindih.

2. **Buffer Tak Terbatas (`buffer_unordered(usize::MAX)` atau `FuturesUnordered`)**
   - **Bahaya:** Jika producer memompa 1 juta record dari database dan Anda langsung men-spawn 1 juta network request bersamaan, Anda akan terkena OOM atau ter-ban akibat rate limit (DDoS) dari API yang dipanggil.
   - **Solusi:** Selalu definisikan batasan buffer yang wajar (contoh: 10, 100, 1000) sesuai kapasitas sistem Anda.

## Edge Cases & Defensive Programming
- **Pinning (`Pin<&mut T>`):** Trait `Stream::poll_next` meminta argumen dipin. Saat mengkonsumsi stream yang disimpan di dalam struct lokal, seringkali kompiler melempar error `cannot borrow as mutable`. Gunakan makro `tokio::pin!(stream);` atau bungkus stream menggunakan `Box::pin(stream)` jika Anda butuh menyimpannya di Heap untuk bypass batasan lifetime dan unmovable struct.
- **Panic di dalam stream! Macro:** Crate `async-stream` cukup rapuh jika terjadi panic yang tidak ter-catch di dalam generator. Ia akan menggelembung ke executor dan membunuh task.
