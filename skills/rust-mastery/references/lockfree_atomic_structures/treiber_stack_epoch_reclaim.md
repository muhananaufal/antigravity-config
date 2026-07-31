# Treiber Stack & Epoch-Based Reclamation

## Konsep Utama
Treiber Stack adalah struktur data stack (LIFO) lock-free fundamental berbasis instruksi *Compare-And-Swap* (CAS). Saat kita melakukan konkurensi dengan pop, ada masalah memori fatal yaitu "Use-After-Free" dan fenomena ABA Problem (di mana thread gagal menyadari bahwa struktur node yang dipopulasi telah didaur ulang). Rust menyelesaikannya secara aman dan efisien menggunakan teknik *Epoch-Based Memory Reclamation* dari crate `crossbeam_epoch`. Daripada mendealokasikan node segera saat dipop, pointer "ditandai" sebagai pensiun, dan memori aslinya baru dibuang setelah dijamin tidak ada lagi thread aktif yang melihat node tersebut (quiescent state).

## Arsitektur & Epoch Flow

```text
                  +---------------------------+
                  |   AtomicPtr (HEAD)        |
                  +---------------------------+
                         |
           (CAS fail - Retry)    (CAS success)
                         v             |
             +-------------+           v
             | New Node    | ------> +-------------+
             +-------------+         | Old Node A  |
                                     +-------------+
                                           |
    Epoch Protection:                      v
    - Pinned threads list            +-------------+
    - Retiring lists                 | Old Node B  |
    - Deferred drop()                +-------------+
```

## Production-Ready Code

```rust
use crossbeam_epoch::{self as epoch, Atomic, Owned, Shared};
use std::sync::atomic::Ordering::{Acquire, Release};

/// Node untuk Treiber Stack
struct Node<T> {
    data: T,
    next: Atomic<Node<T>>, // Pointer crossbeam yang memahami guard dan epoch
}

pub struct TreiberStack<T> {
    head: Atomic<Node<T>>,
}

impl<T> TreiberStack<T> {
    pub fn new() -> Self {
        Self {
            head: Atomic::null(),
        }
    }

    /// Push elemen ke stack (Lock-free)
    pub fn push(&self, data: T) {
        let mut node = Owned::new(Node {
            data,
            next: Atomic::null(),
        });

        // Pin thread ini pada epoch aktif untuk proteksi operasi r/w
        let guard = epoch::pin();

        loop {
            // Ambil snapshot head terkini
            let head = self.head.load(Acquire, &guard);
            // Setup pointer next node baru ke head lama
            node.next.store(head, Release);

            // Coba tukar node baru jadi head jika head belum berubah (CAS)
            match self.head.compare_exchange(head, node, Release, Acquire, &guard) {
                Ok(_) => break,          // Berhasil
                Err(e) => node = e.new,  // Gagal, ambil balik node (ownership), dan retry
            }
        }
    }

    /// Pop elemen dari stack, mendefer penghapusan memori node.
    pub fn pop(&self) -> Option<T> {
        let guard = epoch::pin();

        loop {
            let head = self.head.load(Acquire, &guard);
            
            // Evaluasi dereference secara safe melalui Epoch Guard
            let h = unsafe { head.as_ref() }?;

            let next = h.next.load(Acquire, &guard);

            if self.head.compare_exchange(head, next, Release, Acquire, &guard).is_ok() {
                // CAS berhasil! Defer destruction untuk Node secara aman dengan epoch guard.
                unsafe {
                    guard.defer_destroy(head);
                    // Kita bisa mengekstrak copy (jika T: Clone), atau dalam praktek
                    // ptr::read yang harus hati-hati. Untuk aman, ekstrak pointer
                    return Some(std::ptr::read(&h.data));
                }
            }
        }
    }
}

impl<T> Drop for TreiberStack<T> {
    fn drop(&mut self) {
        while self.pop().is_some() {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::sync::Arc;

    #[test]
    fn test_concurrent_treiber_stack() {
        let stack = Arc::new(TreiberStack::new());
        let mut handles = vec![];

        for i in 0..10 {
            let s = stack.clone();
            handles.push(thread::spawn(move || {
                s.push(i);
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        let mut count = 0;
        while stack.pop().is_some() {
            count += 1;
        }
        assert_eq!(count, 10);
    }
}
```

## Anti-Patterns

1. **`Box::into_raw` & Manual `drop` pada Lock-Free Pop**
   - *Deskripsi*: Melakukan `std::ptr::drop_in_place(head_ptr)` seketika CAS berhasil merubah head, tanpa Epoch protection.
   - *Mengapa Berbahaya*: ABA Problem & Segfault. Thread B mungkin sedang tertunda sebelum memanggil `.next()` pada `head_ptr` yang sama. Thread A me-pop dan men-drop memori, Thread B hidup lagi dan men-dereference dead pointer. Memory corruption seketika.

2. **Memegang Epoch `Guard` Terlalu Lama**
   - *Deskripsi*: Memanggil `let guard = epoch::pin();` di awal request asinkron atau komputasi lambat berdurasi menit.
   - *Mengapa Berbahaya*: Crate `crossbeam_epoch` mengumpulkan sampah memory (reclamation) HANYA JIKA epoch global bisa dimajukan (semua guard pada epoch lama sudah dibebaskan). Jika satu guard dipertahankan, heap memori akan membengkak, karena semua `defer_destroy` dari seluruh stack terjebak, OOM cepat atau lambat.

## Edge Cases & Defensive Programming

- **`ptr::read` pada Copy-less Type**: Pada `pop`, Anda mengambil isi data dari node yang memorinya sudah "ditugaskan hancur". `ptr::read` harus sangat hati-hati agar Drop untuk T (misalnya String) tidak dieksekusi ganda (oleh destructor Node asli). Crate `crossbeam` mendrop hanya pointer allocation pada `defer_destroy` jika dikonfigurasi dengan benar (atau menggunakan struktur ManuallyDrop didalam Node).
- **CPU Relax**: Jika kontensi tinggi (CAS gagal terus karena traffic ekstrem), tambahkan `std::hint::spin_loop()` pada klausa Err dari compare_exchange untuk menghemat power CPU dan branch prediction.
