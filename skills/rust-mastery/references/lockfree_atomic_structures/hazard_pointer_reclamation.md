# Hazard Pointers & Memory Reclamation

## Konsep Utama
Dalam struktur data lock-free, penghapusan memori di tengah-tengah konukrensi adalah mimpi buruk (CBA/ABA problem). Sementara `crossbeam_epoch` memakai pendekatan *Epoch-based* (memajukan zaman/waktu), *Hazard Pointers* memakai pendekatan sentris per-thread. Setiap thread (Reader) memiliki alokasi "Hazard Slots" di Thread Local Storage. Saat membaca suatu memori dari struktur data bersama, thread menulis pointer tersebut ke slot hazard-nya (menandakannya sebagai "Berbahaya / Jangan Dihapus!"). Thread lain (Writer) dapat mencabut pointer utama (retire), tetapi ia *harus* memindai seluruh hazard slot semua thread yang berjalan. Jika tak ada thread yang men-slot pointer tsb, barulah fungsi drop dan deallocation (free) dijalankan. (Contoh implementasi: crate `haphazard`).

## Arsitektur & Hazard Protocol

```text
READER THREAD                             WRITER THREAD
=============                             =============
1. Read Global Head -> Ptr1               1. Modifies Global Head -> Ptr2
2. Store Ptr1 to Hazard Slot [0]          2. Retires Ptr1 (masuk ke Retire List)
3. Validate Ptr1 == Global Head           3. Batch threshold tercapai? Scan Global Hazard Slots
   (Tujuannya mencegah Writer retire         [ ] Thread 1 Hazard: Ptr1
   di sela-sela step 1 dan 2)                [ ] Thread 2 Hazard: Null
4. Read Data dari Ptr1                       => Ptr1 MATCH! Jangan di-drop (Delay).
5. Clear Hazard Slot [0] -> Null             => Writer melanjutkan pekerjaan, memori selamat.
```

## Production-Ready Code

*(Contoh menggunakan API abstraksi gaya `haphazard`)*

```rust
use std::sync::atomic::{AtomicPtr, Ordering};
use std::ptr;
// Menggunakan library haphazard (asumsikan library ditambahkan)
use haphazard::{HazardPointer, Domain};

struct Node<T> {
    val: T,
    next: AtomicPtr<Node<T>>,
}

pub struct HazardStack<T> {
    head: AtomicPtr<Node<T>>,
}

impl<T: Send + Sync + 'static> HazardStack<T> {
    pub fn new() -> Self {
        Self {
            head: AtomicPtr::new(ptr::null_mut()),
        }
    }

    /// Push lock-free konvensional (Tidak butuh hazard protection untuk alokasi baru)
    pub fn push(&self, val: T) {
        let mut new_node = Box::into_raw(Box::new(Node {
            val,
            next: AtomicPtr::new(ptr::null_mut()),
        }));

        loop {
            let curr_head = self.head.load(Ordering::Relaxed);
            unsafe { (*new_node).next.store(curr_head, Ordering::Relaxed) };

            if self.head.compare_exchange_weak(
                curr_head, new_node, Ordering::Release, Ordering::Relaxed
            ).is_ok() {
                break;
            }
        }
    }

    /// Pop membutuhkan hazard pointer untuk mencegah use-after-free
    pub fn pop(&self) -> Option<T> {
        let mut hp = HazardPointer::new(); // Mendaftarkan hazard slot ke domain global

        loop {
            // 1. Amankan pointer head ke hazard pointer
            // protect() me-load pointer lalu menyimpannya di slot hazard.
            // Loop internal protect menjamin Head tidak berubah sesaat sebelum hazard ter-register.
            let head_ptr = hp.protect(&self.head);
            
            if head_ptr.is_null() {
                return None;
            }

            // 2. Head terlindungi, aman dereference
            let next_ptr = unsafe { (*head_ptr).next.load(Ordering::Relaxed) };

            // 3. CAS modifikasi antrian
            if self.head.compare_exchange_weak(
                head_ptr as *mut _, next_ptr, Ordering::Release, Ordering::Relaxed
            ).is_ok() {
                // Berhasil mencabut! Pindahkan ke retire domain.
                // Hazard pointer kita sendiri menahan memory agar aman di return val
                let val = unsafe { std::ptr::read(&(*head_ptr).val) };
                
                // Segera beritahu sistem "pointer ini pensiun".
                // Domain akan secara asynchronous mendealokasikannya setelah
                // semua slot hazard di semesta program kita (semua thread) meng-clear pointer ini.
                unsafe { Domain::global().retire_ptr::<Node<T>>(head_ptr as *mut _) };
                
                return Some(val);
            }
        }
        // Di drop, `hp` otomatis dikosongkan (Hazard Slot dibebaskan).
    }
}
```

## Anti-Patterns

1. **Lupa Validasi Ulang di Manual Hazard Flow**
   - *Deskripsi*: Melakukan load pointer, menulis ke Hazard Slot, dan langsung nge-dereference (tanpa fungsi `.protect()`).
   - *Mengapa Berbahaya*: Saat thread memuat pointer dan sebelum menuliskannya ke hazard slot, thread terhenti lama oleh OS (Context switch). Thread lain mem-pop, men-retire, dan men-drop memory tersebut. Thread pertama bangun, menulis ke slot (terlambat!), dan mendereference *Garbage Memory* (Segfault).
   
2. **Memory Leak pada Custom Domain**
   - *Deskripsi*: Menampung sampah retire ke `Domain` thread lokal namun tidak pernah memanggil `Domain::reclaim()` atau garbage collection cycle.
   - *Mengapa Berbahaya*: Hazard pointer sangat responsif, tetapi jika list `retire` tidak secara deterministik dicicil (seringkali dilakukan otomatis jika memakai `global()` tapi manual jika custom domain), RAM akan cepat exhausted.

## Edge Cases & Defensive Programming

- **Jumlah Slot Terbatas**: Hazard pointer mengalokasi array hazard secara pre-allocated untuk fast path. Jika thread Anda bermanuver traversals Binary Tree lock-free dan mencoba melindungi 20 level pointer sekaligus, Anda butuh 20 Hazard Slot. Melampaui batas ini memicu dynamic allocation mematikan. Re-use hazard pointer `HazardPointer::reset()` di loop sangat dianjurkan.
- **Wait-Free vs Lock-Free**: Hazard Pointers adalah salah satu mekanisme *Wait-Free* read operations, karena bacaan thread tidak bisa ditahan oleh writer, tidak seperti Epoch Guard yang kadang harus wait/reclaim saat epoch stall.
