# Implementing `Future` Trait & State Machine Compilation

## Konsep Utama
Trait `Future` adalah fondasi dari seluruh ekosistem asynchronous di Rust. Tidak seperti callback atau thread OS, `Future` di Rust bersifat malas (lazy) dan berbasis *polling*. Sebuah `async fn` tidak mengeksekusi apa pun saat dipanggil, melainkan mengembalikan *state machine* yang di-generate oleh compiler (sering disebut sebagai generator desugaring). Executor akan memanggil `poll` dengan menyertakan `Context` (yang berisi `Waker`), dan `Future` akan mengembalikan `Poll::Ready(Output)` jika selesai, atau `Poll::Pending` jika masih menunggu, sembari mendaftarkan `Waker` agar di-*wake* (dibangunkan) saat event terjadi.

## Arsitektur & State Machine Flow

```text
                  +-------------------+
                  |   async fn task   | (Compiler desugared to State Machine)
                  +-------------------+
                           |
                           v
+----------------+       poll(cx)      +-------------------+
|    Executor    | ------------------> |   State: Start    |
+----------------+                     +-------------------+
        ^                                        | await I/O
        |                                        v
        | wake()                       +-------------------+
+----------------+                     |  State: Waiting   |
| Reactor / I/O  | <--- register waker +-------------------+
+----------------+                     |
        ^                              | I/O ready
        |                              v
        +----------------------------- +-------------------+
                                       |   State: Done     |
                                       +-------------------+
```

## Production-Ready Code

```rust
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// Shared state antara Future dan thread pekerja (reactor simulasi)
struct SharedState {
    completed: bool,
    waker: Option<Waker>,
}

/// Custom Future yang menyelesaikan I/O atau delay di background thread
pub struct DelayFuture {
    shared_state: Arc<Mutex<SharedState>>,
}

impl DelayFuture {
    /// Membuat DelayFuture baru yang akan selesai setelah durasi tertentu
    pub fn new(duration: Duration) -> Self {
        let shared_state = Arc::new(Mutex::new(SharedState {
            completed: false,
            waker: None,
        }));

        let thread_shared_state = shared_state.clone();
        
        // Simulasi reaktor / background thread untuk I/O
        thread::spawn(move || {
            thread::sleep(duration);
            let mut shared = thread_shared_state.lock().unwrap();
            shared.completed = true;
            // Bangunkan executor jika waker sudah diregistrasi
            if let Some(waker) = shared.waker.take() {
                waker.wake();
            }
        });

        DelayFuture { shared_state }
    }
}

impl Future for DelayFuture {
    type Output = String;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut shared = self.shared_state.lock().unwrap();

        if shared.completed {
            Poll::Ready("Delay selesai!".to_string())
        } else {
            // Update waker dengan waker terbaru dari context
            // clone waker itu murah, tapi penting jika Future dipindah antar executor
            shared.waker = Some(cx.waker().clone());
            Poll::Pending
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_executor::block_on;

    #[test]
    fn test_delay_future() {
        let delay = DelayFuture::new(Duration::from_millis(50));
        let result = block_on(delay);
        assert_eq!(result, "Delay selesai!");
    }
}
```

## Anti-Patterns

1. **Spinning / Block di dalam `poll`**
   - *Deskripsi*: Melakukan operasi blocking secara sinkronus (seperti `std::thread::sleep` atau sinkron I/O) atau mengembalikan `Poll::Pending` tanpa mendaftarkan `Waker`.
   - *Mengapa Berbahaya*: Ini akan menahan thread executor, menghentikan progres dari task lain (starvation), atau menyebabkan infinite loop CPU jika melakukan polling terus menerus (busy-waiting).

2. **Lupa Memperbarui Waker (Stale Waker)**
   - *Deskripsi*: Menyimpan `Waker` di saat `poll` dipanggil pertama kali dan tidak memperbaruinya ketika `poll` dipanggil dengan `Context` yang baru.
   - *Mengapa Berbahaya*: Task bisa berpindah thread atau executor di antara *await points*. Jika waker tidak diperbarui, event I/O akan membangunkan waker yang sudah tidak valid (stale), mengakibatkan Future macet (deadlock/hang) selamanya.

## Edge Cases & Defensive Programming

- **Spurious Wakeups**: `poll` dapat dipanggil meskipun operasi belum selesai. Selalu periksa status riil (e.g., `shared.completed`) di dalam implementasi `poll` sebelum mengembalikan `Poll::Ready`.
- **Drop Semantics**: Sebuah `Future` bisa di-drop sebelum selesai. Pastikan tidak ada memory leak atau resource leak pada background process (misalnya batalkan timer atau I/O call saat `Drop` diimplementasikan).
- **Pinning**: Gunakan `Pin<&mut Self>` secara ketat saat struct mengandung referensi self-referential (biasa terjadi pada desugared async fn). Hindari `Unpin` jika tidak benar-benar dijamin aman pindah memori.
