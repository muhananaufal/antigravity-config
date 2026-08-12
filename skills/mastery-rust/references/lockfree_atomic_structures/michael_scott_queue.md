# Michael-Scott MPMC Queue & Linearizability

## Konsep Utama
Antrian MPMC (Multi-Producer Multi-Consumer) Michael-Scott adalah algoritma klasik queue berbasis lock-free. Menggunakan dua penunjuk atomik, `Head` dan `Tail`, yang masing-masing memuat status antrian. Queue ini didesain menggunakan dummy node awal agar head dan tail tak pernah null. Tantangan utamanya adalah operasi push membutuhkan _dua_ tahap CAS (satu untuk menyambung node, satu untuk memajukan Tail). Jika Thread A tertunda di tahap pertama, Thread B yang datang _wajib membantunya_ memajukan tail agar tidak deadlock. Semua interaksi atomik dijaga dengan _linearizability_ (setiap efek thread tampak terjadi seketika di waktu yang disepakati).

## Arsitektur & Two-Pointer Flow

```text
    Initial State:
    Head ---> [ Dummy ] <--- Tail
                | next: null

    Thread A Pushing Node X (Step 1 - CAS Next):
    Head ---> [ Dummy ]      Tail ---> [ Dummy ]
                | next ----------------> [ Node X ] (next: null)

    Thread A Pushing Node X (Step 2 - CAS Tail):
    Head ---> [ Dummy ]
                | next --------> [ Node X ] <--- Tail
```

## Production-Ready Code

```rust
use crossbeam_epoch::{self as epoch, Atomic, Owned, Shared};
use std::sync::atomic::Ordering::{Acquire, Release, Relaxed};
use std::ptr;

struct Node<T> {
    data: Option<T>,
    next: Atomic<Node<T>>,
}

pub struct MsQueue<T> {
    head: Atomic<Node<T>>,
    tail: Atomic<Node<T>>,
}

impl<T> MsQueue<T> {
    pub fn new() -> Self {
        // Alokasi dummy node
        let dummy = Owned::new(Node {
            data: None,
            next: Atomic::null(),
        });
        
        let dummy = dummy.into_shared(unsafe { epoch::unprotected() });
        
        Self {
            head: Atomic::from(dummy),
            tail: Atomic::from(dummy),
        }
    }

    pub fn push(&self, data: T) {
        let mut node = Owned::new(Node {
            data: Some(data),
            next: Atomic::null(),
        });
        
        let guard = epoch::pin();

        loop {
            let tail = self.tail.load(Acquire, &guard);
            let tail_ref = unsafe { tail.as_ref() }.unwrap();
            let next = tail_ref.next.load(Acquire, &guard);

            // Validasi apakah tail belum tertinggal
            if tail == self.tail.load(Acquire, &guard) {
                if next.is_null() {
                    // Coba pasang node ke ujung akhir queue (Step 1)
                    match tail_ref.next.compare_exchange(
                        next, node, Release, Relaxed, &guard
                    ) {
                        Ok(shared_node) => {
                            // Step 2: Coba majukan tail pointer global
                            let _ = self.tail.compare_exchange(
                                tail, shared_node, Release, Relaxed, &guard
                            );
                            return;
                        }
                        Err(e) => {
                            node = e.new; // Retri CAS jika gagal
                        }
                    }
                } else {
                    // Tail tertinggal! Bantu thread lain memajukan tail (Cooperation)
                    let _ = self.tail.compare_exchange(
                        tail, next, Release, Relaxed, &guard
                    );
                }
            }
        }
    }

    pub fn pop(&self) -> Option<T> {
        let guard = epoch::pin();
        
        loop {
            let head = self.head.load(Acquire, &guard);
            let tail = self.tail.load(Acquire, &guard);
            let head_ref = unsafe { head.as_ref() }.unwrap();
            let next = head_ref.next.load(Acquire, &guard);

            if head == self.head.load(Acquire, &guard) {
                if head == tail {
                    if next.is_null() {
                        return None; // Queue kosong
                    }
                    // Tail tertinggal, bantu perbarui
                    let _ = self.tail.compare_exchange(
                        tail, next, Release, Relaxed, &guard
                    );
                } else {
                    // Coba cabut head (dengan menggeser pointer head ke next)
                    if self.head.compare_exchange(
                        head, next, Release, Relaxed, &guard
                    ).is_ok() {
                        let next_ref = unsafe { next.as_ref() }.unwrap();
                        let result = unsafe { ptr::read(&next_ref.data) };
                        
                        unsafe { guard.defer_destroy(head); }
                        return result;
                    }
                }
            }
        }
    }
}

impl<T> Drop for MsQueue<T> {
    fn drop(&mut self) {
        while self.pop().is_some() {}
        // Hapus dummy pointer tersisa yang tidak tertangkap pop
        let guard = unsafe { epoch::unprotected() };
        let head = self.head.load(Relaxed, guard);
        unsafe { guard.defer_destroy(head) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn test_ms_queue_mpmc() {
        let queue = Arc::new(MsQueue::new());
        let q_clone = queue.clone();
        
        let prod = thread::spawn(move || {
            for i in 0..100 {
                q_clone.push(i);
            }
        });

        let q_clone2 = queue.clone();
        let cons = thread::spawn(move || {
            let mut sum = 0;
            let mut expected_sum = (0..100).sum();
            loop {
                if let Some(val) = q_clone2.pop() {
                    sum += val;
                    if sum == expected_sum { break; }
                }
            }
        });

        prod.join().unwrap();
        cons.join().unwrap();
    }
}
```

## Anti-Patterns

1. **Selfish Producer tanpa Bantuan Tail (No-Cooperation)**
   - *Deskripsi*: Thread produsen merubah _next_ dengan CAS, tapi gagal memajukan _tail_ dan membiarkan struktur antrian cacat. Produsen baru langsung loop dan panik mencari next yang null.
   - *Mengapa Berbahaya*: Liveness Failure! Tanpa blok klausa "Bantu memajukan tail thread lain", seluruh queue membeku secara permanen, thread akan spinning/deadlock 100% CPU time.

2. **CAS ABA di Operasi Pop tanpa Epoch**
   - *Deskripsi*: Pop diimplementasikan sebagai pointer murni `usize` lalu dicek via CAS, padahal Node baru sudah dialokasi di memori (pointer address) yang sama persis dengan yang barusan dipop.
   - *Mengapa Berbahaya*: Thread A melihat pop (Next-C) dan head (Node-B). Tertidur. Thread X masuk, modifikasi Queue jadi Node-B -> Node-D. Thread A bangun, CAS Node-B sukses (padahal epoch & antriannya sudah berbeda!), Next-C dimajukan, memory corrupted.

## Edge Cases & Defensive Programming

- **Memory Leak Dummy Node**: Dummy node di MS Queue harus dibersihkan pada Drop, karena dummy terakhir takkan tersentuh `pop`. Kegagalan membuangnya berarti memory leak seumur hidup struct.
- **`ptr::read` and Ownership**: Di iterasi pop MS Queue, data aslinya menempel pada node `next`, bukan dummy node (head saat ini yang akan dipop dan dimusnahkan sebenarnya adalah dummy, yang baru menjadi dummy pengganti). Penggunaan `ptr::read` mutlak perlu ketelitian offset.
