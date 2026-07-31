# Chase-Lev Work-Stealing Deque

## Konsep Utama
Work-stealing (pencurian kerja) adalah tulang punggung performa multi-threaded executor modern (termasuk `Tokio`). Algoritma inti yang digunakan adalah *Chase-Lev Deque*. Setiap thread pekerja (worker) memiliki antrian (deque) lokal di mana ia memasukkan/mengambil tugas dari ujung *bottom* (LIFO, tanpa kontensi lock). Ketika worker kehabisan tugas, ia bertindak sebagai *stealer* dan mencuri tugas dari antrian worker lain dari ujung *top* (FIFO, butuh sinkronisasi). Algoritma ini memaksimalkan cache locality untuk worker sendiri, sembari mendistribusikan beban secara dinamis tanpa central bottleneck.

## Arsitektur & Chase-Lev Flow

```text
Worker 1 (Local Deque)                Worker 2 (Local Deque)
+-----------------------+             +-----------------------+
|  Top (FIFO, Steal)    | <---steal-- |  Top (FIFO, Steal)    |
|-----------------------|             |-----------------------|
|  Task A               |             |  Task X               |
|  Task B               |             |  Task Y               |
|-----------------------|             |-----------------------|
| Bottom (LIFO, Push/Pop|             | Bottom (LIFO, Push/Pop|
+-----------------------+             +-----------------------+
   ^                                     ^
   | Local push/pop                      | Local push/pop
```

## Production-Ready Code

```rust
use crossbeam_deque::{Worker, Stealer, Steal};
use std::thread;
use std::time::Duration;

/// Representasi struct untuk menjalankan simulasi work-stealing
pub struct ThreadPool {
    workers: Vec<Worker<usize>>,
    stealers: Vec<Stealer<usize>>,
}

impl ThreadPool {
    pub fn new(size: usize) -> Self {
        let mut workers = Vec::with_capacity(size);
        let mut stealers = Vec::with_capacity(size);

        for _ in 0..size {
            // Worker bertindak sebagai LIFO local queue (Chase-Lev)
            let worker = Worker::new_fifo(); // atau new_lifo() tergantung strategi
            stealers.push(worker.stealer());
            workers.push(worker);
        }

        Self { workers, stealers }
    }

    pub fn run_example(self) {
        let mut thread_handles = Vec::new();

        for (id, worker) in self.workers.into_iter().enumerate() {
            let stealers = self.stealers.clone();

            let handle = thread::spawn(move || {
                // Beri tugas awal ke worker 0 untuk simulasi ketidakseimbangan
                if id == 0 {
                    for task in 1..=10 {
                        worker.push(task);
                    }
                }

                // Loop eksekusi work-stealing
                loop {
                    // 1. Coba pop task dari antrian lokal
                    if let Some(task) = worker.pop() {
                        println!("Worker {} memproses task {} (lokal)", id, task);
                        continue;
                    }

                    // 2. Jika kosong, coba steal dari worker lain
                    let mut stolen = false;
                    for stealer in &stealers {
                        match stealer.steal_batch_and_pop(&worker) {
                            Steal::Success(task) => {
                                println!("Worker {} mencuri task {}", id, task);
                                stolen = true;
                                break;
                            }
                            Steal::Empty => continue,
                            Steal::Retry => continue, // Terjadi kontensi atomics, iterasi ulang
                        }
                    }

                    if !stolen {
                        // Tidak ada task di seluruh sistem (shutdown/idle handling)
                        break;
                    }
                }
            });
            thread_handles.push(handle);
        }

        for handle in thread_handles {
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chase_lev_stealing() {
        let pool = ThreadPool::new(2);
        pool.run_example(); // Pastikan tidak panic dan selesai
    }
}
```

## Anti-Patterns

1. **Global Mutex Lock sebagai Task Queue**
   - *Deskripsi*: Menggunakan `Arc<Mutex<VecDeque<Task>>>` tunggal sebagai tempat semua worker menaruh dan mengambil tugas.
   - *Mengapa Berbahaya*: Kontensi memori brutal (Lock Contention). Saat pool membesar, thread akan lebih banyak menganggur menunggu *lock* terbuka daripada mengeksekusi I/O atau perhitungan, menghancurkan skalabilitas vertikal.

2. **Mencuri Secara Berurutan (Sequential Stealing)**
   - *Deskripsi*: Stealer selalu mencoba mencuri dari Worker 0, lalu 1, lalu 2. 
   - *Mengapa Berbahaya*: Menimbulkan efek "Thundering Herd". Jika semua worker nganggur, semuanya akan menyerbu Worker 0 secara bersamaan, memicu false sharing dan kontensi CAS di algoritma Stealer. (Tokio menggunakan randomisasi PNRG fast untuk memilih target stealer).

## Edge Cases & Defensive Programming

- **ABA Problem di Stealer**: Chase-Lev queue mengatasi *ABA problem* pada pointer operasi dengan epoch-based reclamation atau cyclic buffer arrays. Memakai `crossbeam_deque` menangani ini secara internal.
- **LIFO/FIFO Starvation**: Push lokal di LIFO memberi *cache hit* lebih baik. Namun LIFO murni bisa menyebabkan *starvation* di mana tugas lama di dasar deque (bottom) tidak pernah dijalankan (jika steal jarang terjadi). Menggabungkan LIFO lokal dan FIFO stealing biasanya optimal.
