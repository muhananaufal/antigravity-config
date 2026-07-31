# Lock-Free Sync Primitives & Atomic Operations

## Konsep Utama
Operasi *Lock-Free* menggunakan instruksi hardware secara langsung (seperti Compare-And-Swap/CAS pada x86/ARM) melalui *atomics* (`std::sync::atomic::*`). Ini jauh lebih cepat dibanding `Mutex` karena tidak pernah mengistirahatkan (*sleep*) thread ke level sistem operasi.

Dalam sistem latensi sangat rendah (HFT, game engine network loop, garbage collector kustom), memori sinkronisasi yang dikelola dengan benar menghindari overhead syscall. Terdapat tipe data atomic seperti `AtomicUsize`, `AtomicBool`, `AtomicPtr`.

Tantangan utama adalah **Memory Ordering**:
- `Relaxed`: Tidak ada garansi ordering memori selain nilai atomik itu sendiri. Sangat cepat.
- `Acquire` & `Release`: Memasangkan ini memastikan bahwa operasi memori yang terjadi sebelum `Release` di Thread A, akan terlihat secara kasat mata setelah `Acquire` di Thread B (Release-Acquire semantics).
- `SeqCst` (Sequentially Consistent): Garansi paling ketat, semua thread menyepakati urutan operasi yang sama. Memiliki overhead performa tertinggi karena barrier CPU penuh.

## Arsitektur & Flow (Release-Acquire Lock-Free Flag)
```ascii
Thread 1 (Producer)                      Thread 2 (Consumer)
[Write Data struct]                       
      |                                        
      v                                        
AtomicBool::store(true, Release)  ----> AtomicBool::load(Acquire)
                                            | (Jika True)
                                            v
                                        [Read Data struct secara aman]
```

## Kode Production-Ready

```rust
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Sebuah Spin-Lock sederhana yang tidak bergantung pada system scheduler.
/// PERINGATAN: Spinlock hanya boleh digunakan jika waktu pegang lock (critical section)
/// SANGAT KECIL (beberapa instruksi CPU saja).
pub struct SpinLock {
    state: AtomicUsize,
}

const UNLOCKED: usize = 0;
const LOCKED: usize = 1;

impl SpinLock {
    pub fn new() -> Self {
        Self {
            state: AtomicUsize::new(UNLOCKED),
        }
    }

    pub fn lock(&self) {
        // Gunakan instruksi 'yield' (Hint backoff) agar CPU tidak overheat 
        // saat loop terlalu kencang menunggu lock terbuka.
        let mut backoff = 1;
        
        // compare_exchange_weak (CAS) lebih efisien pada platform ARM 
        // daripada compare_exchange biasa untuk operasi dalam loop.
        while self.state.compare_exchange_weak(
            UNLOCKED,
            LOCKED,
            Ordering::Acquire, // Lock memori untuk baca sesudahnya
            Ordering::Relaxed, // Jika gagal ambil lock, tidak peduli ordering
        ).is_err() {
            for _ in 0..backoff {
                std::hint::spin_loop(); // Instruksi PAUSE (x86) / YIELD (ARM)
            }
            // Peningkatan backoff eksponensial dengan batas maksimal
            backoff = std::cmp::min(backoff << 1, 64);
        }
    }

    pub fn unlock(&self) {
        // Release memastikan semua write yang dilakukan saat lock dipegang
        // terlihat oleh thread yang melakukan Acquire berikutnya.
        self.state.store(UNLOCKED, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn test_spinlock_concurrency() {
        let lock = Arc::new(SpinLock::new());
        // Menggunakan pointer telanjang dan unsafe hanya untuk simulasi 
        // mutable sharing (pada kenyataannya kita pakai UnsafeCell)
        let data = Arc::new(AtomicUsize::new(0));

        let mut handles = vec![];

        for _ in 0..10 {
            let lock_clone = lock.clone();
            let data_clone = data.clone();
            
            handles.push(thread::spawn(move || {
                for _ in 0..1000 {
                    lock_clone.lock();
                    // CRITICAL SECTION (Harus sangat cepat)
                    let current = data_clone.load(Ordering::Relaxed);
                    data_clone.store(current + 1, Ordering::Relaxed);
                    lock_clone.unlock();
                }
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(data.load(Ordering::Relaxed), 10000);
    }
}
```

## Anti-Patterns

1. **Selalu menggunakan `Ordering::SeqCst` untuk semuanya**
   - **Bahaya:** Meskipun aman, menaruh *Sequentially Consistent barrier* di mana-mana (terutama di arsitektur ARM) membunuh performa dan mengalahkan tujuan awal menggunakan lock-free data structure (menjadi sama lambatnya dengan Mutex).
   - **Solusi:** Analisis kebutuhan. Gunakan `Relaxed` untuk hitungan counter independen. Gunakan `Release/Acquire` untuk perlindungan flag data.

2. **Spinning Tanpa `std::hint::spin_loop()`**
   - **Bahaya:** `while !flag.load(Ordering::Relaxed) {}` (tight loop) akan memaksa CPU berlari 100%, menghasilkan panas (*thermal throttling*), dan merampas *memory bandwidth* dari thread yang sebenarnya sedang mengerjakan tugas (yang berpotensi membuat thread tersebut lambat melepaskan flag).
   - **Solusi:** Selalu gunakan `std::hint::spin_loop()` di dalam tight spin loop.

## Edge Cases & Defensive Programming
- **The ABA Problem:** Jika Anda menggunakan `AtomicPtr` dengan CAS, berhati-hatilah dengan masalah ABA (Thread 1 melihat A, Thread 2 mengubah A -> B -> A, Thread 1 mengira tidak ada perubahan). Untuk struktur data lock-free dinamis, gunakan teknik seperti *Epoch-Based Reclamation* (crate `crossbeam-epoch`) atau *Hazard Pointers* untuk menghindari UAF (Use-After-Free) atau ABA.
- **compare_exchange_weak vs compare_exchange:** Pada loop panjang, `_weak` lebih disarankan karena mungkin gagal secara spurious tanpa alasan logika (karena interupsi cache/hardware), namun memberikan efisiensi opcode di ARM LL/SC (Load-Link / Store-Conditional).
