# Manual RawWaker & VTable Implementation

## Konsep Utama
Di balik layar, trait `Waker` di Rust adalah sebuah jembatan (wrapper) ke pointer `RawWaker` dan tabel fungsi virtual (`RawWakerVTable`). Karena Rust tidak memaksa garbage collector atau runtime standar, `Waker` didesain untuk menjadi sangat fleksibel (mendukung `Arc`, alokasi statis, atau model kustom). Implementasi VTable mengharuskan kita mengelola *reference counting* dan *drop semantics* secara aman menggunakan block `unsafe`. Fungsi `wake_by_ref` digunakan untuk polling internal executor, sementara `wake` akan mengonsumsi waker.

## Arsitektur & VTable Flow

```text
    +-----------+             +-----------------+
    |   Waker   | ----------> |   RawWaker      |
    +-----------+             +-----------------+
                                /             \
                   data: *const ()         vtable: &RawWakerVTable
                          |                        |
                          v                        v
             +--------------------+      +--------------------+
             | Arc<Task> (Custom) |      | clone()            |
             | - atomic count     |      | wake()             |
             | - state            |      | wake_by_ref()      |
             +--------------------+      | drop()             |
                                         +--------------------+
```

## Production-Ready Code

```rust
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{RawWaker, RawWakerVTable, Waker};
use std::mem;

/// Representasi Task yang akan dibungkus ke dalam Waker
pub struct MyTask {
    /// Flag penanda task siap dijalankan ulang (di-wake)
    is_awake: AtomicBool,
}

impl MyTask {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            is_awake: AtomicBool::new(false),
        })
    }
}

/// Fungsi untuk mem-bangunkan (wake) task
fn wake_task(task: &MyTask) {
    task.is_awake.store(true, Ordering::SeqCst);
    // Di executor nyata, kita akan memasukkan task ke dalam run-queue di sini
}

// -------------------------------------------------------------
// VTable Functions Implementation (Membutuhkan unsafe karena *const ())
// -------------------------------------------------------------

unsafe fn waker_clone(data: *const ()) -> RawWaker {
    // Increment Arc refcount
    let arc = Arc::from_raw(data as *const MyTask);
    // Hindari drop pada clone, biarkan Arc tetap hidup setelah blok ini
    let cloned_arc = arc.clone();
    mem::forget(arc); 
    
    RawWaker::new(Arc::into_raw(cloned_arc) as *const (), &VTABLE)
}

unsafe fn waker_wake(data: *const ()) {
    // Konsumsi refcount dari Arc
    let arc = Arc::from_raw(data as *const MyTask);
    wake_task(&arc);
    // arc akan otomatis di-drop (decrement refcount) di akhir scope
}

unsafe fn waker_wake_by_ref(data: *const ()) {
    // Buat referensi tanpa mengambil kepemilikan (tidak consume arc)
    let arc = Arc::from_raw(data as *const MyTask);
    wake_task(&arc);
    // Sangat penting: kita tidak boleh mendrop Arc di sini
    mem::forget(arc);
}

unsafe fn waker_drop(data: *const ()) {
    // Decrement refcount secara eksplisit dengan men-drop arc
    drop(Arc::from_raw(data as *const MyTask));
}

static VTABLE: RawWakerVTable = RawWakerVTable::new(
    waker_clone,
    waker_wake,
    waker_wake_by_ref,
    waker_drop,
);

/// Konstruksi `Waker` kustom
pub fn create_waker(task: Arc<MyTask>) -> Waker {
    let raw = RawWaker::new(Arc::into_raw(task) as *const (), &VTABLE);
    // unsafe diperlukan karena Waker::from_raw butuh jaminan validitas
    unsafe { Waker::from_raw(raw) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_custom_waker_lifecycle() {
        let task = MyTask::new();
        assert_eq!(Arc::strong_count(&task), 1);
        
        let waker = create_waker(task.clone());
        assert_eq!(Arc::strong_count(&task), 2);
        
        let waker2 = waker.clone();
        assert_eq!(Arc::strong_count(&task), 3);
        
        waker2.wake_by_ref();
        assert!(task.is_awake.load(Ordering::SeqCst));
        
        waker.wake(); // konsumsi `waker`
        assert_eq!(Arc::strong_count(&task), 1); // 1 milik tes (task)
    }
}
```

## Anti-Patterns

1. **Memory Leak via `mem::forget` yang Salah**
   - *Deskripsi*: Melakukan `Arc::into_raw` tapi lupa menggunakan `Arc::from_raw` di fungsi `drop` atau `wake`. 
   - *Mengapa Berbahaya*: Executor menciptakan ribuan task, jika refcount bocor, memory allocation task (beserta stack/heap futures-nya) tidak akan pernah dibebaskan (Out Of Memory).

2. **Double Free pada `wake_by_ref`**
   - *Deskripsi*: Memanggil `Arc::from_raw` di dalam fungsi `wake_by_ref` tapi lupa memanggil `mem::forget` sebelum block berakhir.
   - *Mengapa Berbahaya*: Blok akan memicu destruktor Arc (decrement), padahal pemanggil `wake_by_ref` berasumsi kepemilikannya tetap utuh. Ini menyebabkan use-after-free dan Segfault di runtime.

## Edge Cases & Defensive Programming

- **Concurrency Tearing pada Wake**: Waker bisa dipanggil dari berbagai thread secara bersamaan. Jika internal waker memutasi data, pastikan itu atomic atau diproteksi Mutex. (Contoh: task scheduling queue bisa mengalami race condition jika Waker dimasukkan berkali-kali).
- **ZSTs dan Dummy Wakers**: Jika membuat "No-op Waker", berikan implementasi yang tidak melakukan manipulasi pointer dan amankan dengan `std::ptr::null()`, tapi pastikan akses tidak pernah di-dereference.
