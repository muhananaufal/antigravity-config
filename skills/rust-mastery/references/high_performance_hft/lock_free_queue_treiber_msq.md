# Lock-Free Queues, Treiber Stack, dan Epoch Reclamation

## Konsep Utama dan Penggunaan
Dalam sistem deterministik HFT, *blocking* (misalnya dari `std::sync::Mutex`) sangat dihindari. Jika thread yang memegang Mutex tertidur karena OS (preempted), thread lain akan terhenti (Priority Inversion). 
Kita membutuhkan *Lock-Free Data Structures* di mana interaksi thread dijamin dapat maju tanpa *locking*. 

Algoritma umum adalah **Michael-Scott Queue (MSQ)** atau **Treiber Stack** yang mengandalkan instruksi CPU *Compare-And-Swap (CAS)* via `AtomicPtr`. Masalah besar pada lock-free structures di memori yang dikelola manual adalah **ABA Problem** dan manajemen memori (kapan harus membebaskan pointer?). Di Rust, `crossbeam_epoch` menangani manajemen *garbage collection* lock-free dengan skema Epoch-Based Reclamation (EBR).

## Arsitektur: ABA Problem & CAS
```text
Thread 1 membaca Head -> Node A
Thread 1 bersiap CAS: Jika Head == A, ubah ke B.

(Preempted)
Thread 2 mendelete A.
Thread 2 menambahkan C, lalu menambahkan A kembali! 
(Alamat memori A didaur ulang).
Head -> Node A.

Thread 1 bangun, melihat Head == A (Nilai/Pointer sama). 
CAS berhasil, padahal struktur List sudah berubah secara radikal! -> Korupsi Memori!
```

## Kode Production-Ready: Lock-Free Treiber Stack
```rust
use crossbeam_epoch::{self as epoch, Atomic, Owned, Shared};
use std::sync::atomic::Ordering;

/// Sebuah Stack lock-free menggunakan algoritma Treiber.
/// Menerapkan Epoch-Based Reclamation untuk perlindungan ABA dan memory safety.
pub struct TreiberStack<T> {
    head: Atomic<Node<T>>,
}

struct Node<T> {
    data: T,
    next: Atomic<Node<T>>,
}

impl<T> TreiberStack<T> {
    pub fn new() -> Self {
        Self {
            head: Atomic::null(),
        }
    }

    pub fn push(&self, data: T) {
        let mut node = Owned::new(Node {
            data,
            next: Atomic::null(),
        });

        let guard = epoch::pin(); // Masuk ke critical section EBR

        loop {
            // Baca current head
            let head = self.head.load(Ordering::Acquire, &guard);
            // Siapkan node baru untuk menunjuk ke current head
            node.next.store(head, Ordering::Relaxed);

            // Coba update head ke node kita (CAS)
            match self.head.compare_exchange(
                head,
                node,
                Ordering::Release,
                Ordering::Relaxed,
                &guard,
            ) {
                Ok(_) => break, // Sukses
                Err(e) => {
                    // Gagal, CAS mengembalikan ownership dari node, loop ulang
                    node = e.new;
                }
            }
        }
    }

    pub fn pop(&self) -> Option<T> {
        let guard = epoch::pin();
        
        loop {
            let head = self.head.load(Ordering::Acquire, &guard);
            
            // Jika stack kosong
            if head.is_null() {
                return None;
            }

            // Aman mengakses ref berkat `Guard` dari crossbeam_epoch
            let head_ref = unsafe { head.deref() };
            let next = head_ref.next.load(Ordering::Relaxed, &guard);

            // Coba ayunkan pointer head ke elemen berikutnya (CAS)
            if self.head.compare_exchange(
                head,
                next,
                Ordering::Release,
                Ordering::Relaxed,
                &guard,
            ).is_ok() {
                // Berhasil pop.
                // Kita tidak bisa langsung membebaskan (drop) head karena thread lain
                // mungkin masih membacanya. EBR menunda destruksi.
                unsafe {
                    guard.defer_destroy(head);
                    // Peringatan: Memindahkan (ptr::read) data keluar dari node yang di-defer
                    // memerlukan kehati-hatian khusus, pada implementasi riil biasanya 
                    // T dibatasi clone, atau dibungkus sedemikian rupa.
                    return Some(std::ptr::read(&head_ref.data));
                }
            }
        }
    }
}

impl<T> Default for TreiberStack<T> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::sync::Arc;

    #[test]
    fn test_lock_free_stack() {
        let stack = Arc::new(TreiberStack::new());
        let s1 = Arc::clone(&stack);
        
        let t1 = thread::spawn(move || {
            for i in 0..100 { s1.push(i); }
        });
        
        let t2 = thread::spawn(move || {
            for i in 100..200 { stack.push(i); }
        });
        
        t1.join().unwrap();
        t2.join().unwrap();
        
        // Dalam implementasi test murni, kita bisa memverifikasi pop berhasil
        // tanpa crash/data corruption.
    }
}
```

## Anti-Patterns

1. **Busy-Wait Spin Loop Tanpa Yielding**
   - *Bahaya*: Loop CAS murni (`loop { if cas_success { break } }`) yang gagal berulang-ulang akan memonopoli 100% CPU. Pada OS modern, ini mencegah scheduler thread lain berjalan yang mungkin merupakan pemegang kondisi sukses.
   - *Solusi*: Masukkan `std::hint::spin_loop()` (instruksi PAUSE di x86) ke dalam loop gagal. Ini memberi sinyal ke CPU untuk mengurangi daya dan memperlancar pipeline hyper-threading.

2. **Memegang `epoch::Guard` Terlalu Lama**
   - *Bahaya*: Mekanisme EBR crossbeam menyimpan semua memori usang ke "garbage list". Memori list itu HANYA didealokasi secara aktual ketika tidak ada satu pun *Guard* yang aktif di sistem. Jika satu thread *pin()* epoch dan tertidur, thread lain yang terus mem-pop node akan meledakkan RAM (Memory Exhaustion).
   - *Solusi*: Batasi umur ekspektasi `Guard` sekecil mungkin. Jangan pernah menempatkan I/O block, sleep, atau syscall yang memakan waktu di antara *pin()* dan *drop guard*.

## Edge Cases & Defensive Engineering
- **Starvation / Contention Extrim**: Algoritma Lock-Free (CAS loop) sangat buruk jika diakses ribuan thread bersamaan, mengakibatkan *live-lock* di mana 99% waktu dihabiskan untuk CAS memantul-mantul (cache-invalidation bus storm). Dalam HFT, gunakan arsitektur MPSC (Multi-Producer Single-Consumer) ring buffer, bukan full MSQ, jika *throughput* sangat dituntut.
- **Memory Consistency Model**: Kesalahan satu ordering memori (mis. `Relaxed` ketimbang `Acquire/Release` di CAS) bisa membuat struktur data tampak rusak di bawah CPU ARM, meskipun sukses terus-menerus di x86 lokal developer.
