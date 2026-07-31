# SeqLock (Sequence Lock) & Read-Optimized Data

## Konsep Utama
SeqLock adalah pola sinkronisasi yang brilian untuk sistem operasi atau struktur HFT (High-Frequency Trading) yang *Read-Heavy* namun tidak mentolerir write starvation. Intinya: **Reader tidak pernah mem-blokir** (tidak ada mutex atau atomic RW-lock count contention) dan tidak pernah menulis apa pun ke cache line (nol kontensi cache invalidation). Sebaliknya, diandalkan sebuah Sequence Number atomik. Writer mengubahnya jadi ganjil saat mengunci/menulis, dan mengubahnya jadi genap setelah selesai. Reader menyalin data dan memverifikasi (di awal & akhir) bahwa sequence masih genap dan tidak berubah selama penyalinan (jika berubah, spin/retry).

## Arsitektur & SeqLock Flow

```text
       WRITER                             READER (Lock-Free)
       ======                             ======
 1. seq.fetch_add(1) [Jadi GANJIL]    1. seq1 = seq.load()
 2. Write Data Payload                2. If seq1 is odd, spin.
 3. seq.fetch_add(1) [Jadi GENAP]     3. Read Data Payload
                                      4. seq2 = seq.load()
                                      5. If seq1 != seq2, retry from 1.
                                      6. Return Data.
```

## Production-Ready Code

```rust
use std::sync::atomic::{compiler_fence, AtomicUsize, Ordering};
use std::cell::UnsafeCell;
use std::hint::spin_loop;

pub struct SeqLock<T> {
    sequence: AtomicUsize,
    data: UnsafeCell<T>,
}

unsafe impl<T: Send> Send for SeqLock<T> {}
unsafe impl<T: Send + Sync> Sync for SeqLock<T> {}

impl<T: Copy> SeqLock<T> {
    pub fn new(val: T) -> Self {
        Self {
            sequence: AtomicUsize::new(0), // Harus genap!
            data: UnsafeCell::new(val),
        }
    }

    /// Read data tanpa perlu lock, optimis.
    pub fn read(&self) -> T {
        loop {
            // Acquire: Mencegah operasi memori selanjutnya reorder sebelum load seq.
            let seq = self.sequence.load(Ordering::Acquire);
            
            // Writer sedang beroperasi jika urutan ganjil
            if seq % 2 != 0 {
                spin_loop();
                continue;
            }

            // Baca Payload (Bypass alias checking - UnsafeCell)
            let val = unsafe { std::ptr::read(self.data.get()) };

            // Pastikan data payload copy selesai SEBELUM validasi sequence
            compiler_fence(Ordering::Acquire); // Hardware fence sudah ter-cover, butuh compiler fence agar register copy tidak lompat

            // Validasi seq2 terhadap seq1. Harus Acquire agar mencegah reordering baca payload ke bawahnya.
            let seq2 = self.sequence.load(Ordering::Acquire);

            // Cek modifikasi atau writer concurrent
            if seq == seq2 {
                return val;
            }
        }
    }

    /// Tulis data secara mutlak. Mutex/SpinLock untuk writer jika ada Multi-Writer harus dilakukan di luar,
    /// Fungsi write ini diasumsikan Single-Writer mutlak atau dikunci dari luar.
    pub fn write(&self, new_val: T) {
        // Increment sequence jadi ganjil (menandakan state write kotor)
        let seq = self.sequence.load(Ordering::Relaxed);
        self.sequence.store(seq + 1, Ordering::Release);

        // Tulis Payload
        unsafe { std::ptr::write(self.data.get(), new_val) };

        // Increment sequence jadi genap, melepaskan data agar bisa diakses
        self.sequence.store(seq + 2, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::sync::Arc;

    #[derive(Copy, Clone, Debug, PartialEq)]
    struct Config {
        threshold: u64,
        scale: f64,
    }

    #[test]
    fn test_seqlock_read_write() {
        let lock = Arc::new(SeqLock::new(Config { threshold: 10, scale: 1.0 }));
        
        let lock_clone = lock.clone();
        let writer = thread::spawn(move || {
            lock_clone.write(Config { threshold: 20, scale: 2.0 });
        });

        writer.join().unwrap();
        let val = lock.read();
        assert_eq!(val.threshold, 20);
        assert_eq!(val.scale, 2.0);
    }
}
```

## Anti-Patterns

1. **Compiler Reordering pada Payload Read**
   - *Deskripsi*: Melakukan load Sequence, lalu Read Data, lalu load Sequence tanpa membentengi mereka dengan `compiler_fence(Acquire)` (atau Ordering hardware jika arch lebih rileks).
   - *Mengapa Berbahaya*: Compiler LLVM dapat (dan akan!) mengoptimasi `ptr::read` ke register dan memindahkannya _setelah_ pembacaan `seq2`. Akibatnya, Anda lolos check Sequence (seq1 == seq2), NAMUN data yang di-read dibaca bertepatan dengan writer modifikasi (Data Race, half-written tearing bites).

2. **Membaca Non-Copy Type (Seperti String)**
   - *Deskripsi*: Menggunakan tipe Heap Allocation dinamis (String, Vec) di dalam data SeqLock.
   - *Mengapa Berbahaya*: SeqLock bergantung pada perulangan optimistis yang mengabaikan *state setengah-matang*. Jika pointer vector dibaca setengah, aplikasi akan Segfault! SeqLock _hanya_ aman untuk tipe POD (Plain Old Data / `Copy`), atau Trivial Type ukuran cache-line (max 64-128 bytes).

## Edge Cases & Defensive Programming

- **Write Tear-down Lock**: Kode write di atas asumsikan 1 Single Writer (SPMC). Jika Anda butuh MPMC, implementasikan *Spinlock / Mutex* standar yang MEMBUNGKUS operasi `write`, tanpa merusak esensi lock-free dari fungsi `read`.
- **Interrupts / Sinyal**: SeqLock sangat rapuh jika ada sinyal (seperti panic handler/Signal) terjadi di tengah _write_ (menyisakan odd sequence selamanya). Data struktur harus dikawal ketat dari abort sistem.
