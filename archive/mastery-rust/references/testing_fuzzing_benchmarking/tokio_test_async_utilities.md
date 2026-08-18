# Tokio-Test: Manipulasi Waktu Virtual & Task Mocking

## Deskripsi dan Konsep Utama
Menge-test logika *asynchronous* yang bergantung pada jeda waktu (time-based logic) seperti `timeout`, `sleep`, atau *exponential backoff* seringkali berujung pada *brittle test* (test rawan gagal) yang membuang waktu CPU. Menggunakan `tokio::time::pause()` dari crate `tokio-test` memungkinkan kita untuk "membekukan" waktu dunia nyata. Waktu (*virtual clock*) kemudian bisa dimajukan sekejap menggunakan `tokio::time::advance()`. Ini memungkinkan test timeout 24 jam dieksekusi tuntas hanya dalam kurang dari 1 milidetik secara deterministik. Selain virtual clock, kapabilitas macro `assert_pending!` dan `assert_ready!` sangat krusial untuk mengevaluasi manual state dari Future (mesin state `Poll`).

## Arsitektur & Flow (ASCII Diagram)
```text
  [Tokio Test Runtime] (Single Threaded / Current Thread)
           |
   (tokio::time::pause) -----> [Virtual Clock Mocks OS Time]
           |
 [Spawn Async Task] -> Awaits tokio::time::sleep(5 seconds)
           |
 [Task Yields, returns Poll::Pending]
           |
   (tokio::time::advance(5 seconds))
           |
 [Timer Wheel Fires] -----> [Wakes up the Async Task]
           |
 [Task resumes, returns Poll::Ready(Output)]
```

## Implementasi Produksi (Rust)
```rust
use std::time::Duration;
use tokio::time::{sleep, timeout};

/// Fungsi yang disimulasikan sebagai retry loop yang memakan waktu lama
pub async fn exponential_retry_operation(max_retries: u32) -> Result<String, &'static str> {
    let mut current_wait = Duration::from_secs(1);
    
    for _ in 0..max_retries {
        // Disini kita asumsikan pemanggilan I/O, tapi untuk test, anggap selalu gagal
        // sehingga memicu sleep backoff
        sleep(current_wait).await;
        current_wait *= 2;
    }
    
    Err("Max retries exceeded")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{advance, pause, Instant};
    use tokio_test::{assert_pending, assert_ready_eq, task};

    // Wajib: #[tokio::test(start_paused = true)] langsung membekukan jam sejak tes dimulai,
    // menghindari drift beberapa mikrodetik yang membuat assert waktu sangat presisi meleset.
    #[tokio::test(start_paused = true)]
    async fn test_exponential_backoff_timing() {
        let start = Instant::now();
        
        let result = exponential_retry_operation(3).await;
        
        // 3 retry memicu sleep:
        // Iter 1: 1s
        // Iter 2: 2s
        // Iter 3: 4s
        // Total sleep time = 7s.
        // Berkat waktu yang dipause, ini selesai seketika di dunia nyata.
        assert_eq!(result, Err("Max retries exceeded"));
        assert_eq!(start.elapsed(), Duration::from_secs(7));
    }

    #[test]
    fn test_future_polling_manually() {
        // Inisialisasi mock task manual tanpa runtime tokio lengkap
        let mut mock_task = task::spawn(async {
            sleep(Duration::from_secs(10)).await;
            "done"
        });

        // Setup manual pause pada runtime instance ini
        // (Khusus untuk lingkungan dimana start_paused = true tidak digunakan / block code biasa)
        tokio::time::pause();

        // Saat di-poll pertama kali, future menunggu sleep selesai.
        assert_pending!(mock_task.poll());

        // Majukan waktu virtual sejauh 5 detik (belum selesai)
        tokio::time::advance(Duration::from_secs(5)).await;
        assert_pending!(mock_task.poll());

        // Majukan sisa waktunya
        tokio::time::advance(Duration::from_secs(5)).await;
        
        // Future sekarang siap (Ready)
        assert_ready_eq!(mock_task.poll(), "done");
    }
}
```

## Anti-Patterns

1. **Waktu Sleep Asli pada Test**: Menggunakan `std::thread::sleep` atau `tokio::time::sleep` di runtime normal (tanpa time pause) pada test.
   *Mengapa berbahaya*: Coba jalankan ratusan test timeout (10 detik). CI/CD *runner* akan terkunci (*hang*) berjam-jam, tagihan komputasi membengkak, padahal eksekutor hanya tidak ngapa-ngapain menunggu clock berputar lambat.
2. **Memajukan Waktu (Advance) Sebelum Future di-Poll Awal**: Memanggil `tokio::time::advance()` *sebelum* executor pernah mem-poll (memanggil `.await` di task latar/`spawn`) future tersebut.
   *Mengapa berbahaya*: Dalam siklus Tokio, future tidak akan mendaftarkan timer-nya (*waker*) di kernel (*timer wheel*) sampai future itu di-poll setidaknya 1 kali. Memajukan waktu sebelum itu tidak akan memiliki dampak apapun, dan task akan hang selamanya atau timeout gagal.

## Edge Cases & Defensive Programming

1. **Virtual Time Drift (Melayang) pada Multi-Threading**: Waktu virtual (`start_paused = true`) bergantung pada implementasi `current_thread` / single-thread dari Tokio Test. Jika Anda menggunakan runtime `multi_thread` worker dan thread lokal lainnya, virtual time akan desinkronisasi. Pastikan Anda hanya mem-*mock* waktu pada single-threaded `#[tokio::test]`.
2. **Infinite Yield Loop pada Async (Starvation)**: Ada kondisi *race-condition* saat future mereturn `Poll::Pending` tetapi segera menjadwalkan dirinya lagi tanpa mendaftar ke timer. Jika memanggil `tokio::time::advance()`, API *advance* akan panik atau *hang* karena engine tidak menemukan *timer entry* yang menahan eksekusi sistem, mengasumsikan ada *deadlock* pada loop I/O murni.
3. **Penyimpangan Auto-Advance**: Jika test *block* pada `.await`, Tokio secara otomatis (di mode *paused*) akan mencoba me-fast-forward (memajukan) jam virtual ke timer terjauh secara agresif demi mencegah deadlock. Hal ini bisa merusak urutan penembakan event (*event ordering*) jika Anda bergantung pada jeda milidetik ketat di antara banyak future. Manual mock task dengan `assert_pending!` adalah perisai paling deterministik untuk ini.
