# Drop Check, `#[may_dangle]`, dan Variance di Rust

Konsep Drop Check (`dropck`) di Rust adalah mekanisme krusial pada kompilator yang menjamin memori ter-deallokasi secara aman tanpa memicu *Use-After-Free* (UAF) selama eksekusi destruktor (`Drop::drop`). Pada level Systems Engineering, pemahaman mendalam tentang `dropck`, `variance`, dan *destructor ordering* membedakan antara kode yang sekadar berjalan dengan yang benar-benar sound (aman secara teoritis memori).

Atribut nightly `#[may_dangle]` (sering disebut *dropck eyepatch*) mengizinkan kita untuk mem-bypass analisis ketat `dropck`. Ini esensial ketika merancang struktur data kustom (seperti `Vec` atau `Box` kustom) di mana kita tahu bahwa destruktor tidak akan pernah mengakses data yang dipinjam oleh generic type parameter tertentu, meskipun kompilator berasumsi sebaliknya.

## Arsitektur Memori & Drop Flow

```ascii
[ Stack Frame ]                           [ Heap Arena / Data ]
+---------------------+                   +-------------------+
| struct CustomBox<T> | --(UniquePtr)-->  | T (Data)          |
| - ptr: *mut T       |                   |                   |
| - _marker           |                   +-------------------+
+---------------------+
           |
      [ Drop Call ]
           |
           v
+-----------------------------------+
| 1. dropck checks lifetimes        |
|    - Is T strictly outliving Box? |
|    - If #[may_dangle], skip check |
| 2. Execute CustomBox::drop        |
|    - deallocate memory            |
|    - call T::drop (if needed)     |
+-----------------------------------+
```

## Produksi-Ready Code: Sound Custom Box dengan `#[may_dangle]`

Kode ini mengimplementasikan semantik memori yang aman menggunakan `#[may_dangle]`, menjamin kebenaran variance dan dropck.

```rust
#![feature(dropck_eyepatch)]
#![feature(allocator_api)]

use std::alloc::{AllocError, Allocator, Global, Layout};
use std::marker::PhantomData;
use std::ptr::{drop_in_place, NonNull};

/// CustomBox adalah smart pointer mirip Box, namun didesain untuk
/// menunjukkan manipulasi variance dan dropck yang eksplisit.
pub struct CustomBox<T, A: Allocator = Global> {
    ptr: NonNull<T>,
    alloc: A,
    // PhantomData menginformasikan kompilator bahwa CustomBox "memiliki" T,
    // sehingga memicu variance yang tepat (covariant terhadap T).
    _marker: PhantomData<T>,
}

impl<T> CustomBox<T> {
    /// Membuat alokasi heap baru untuk T.
    pub fn new(value: T) -> Self {
        Self::new_in(value, Global)
    }
}

impl<T, A: Allocator> CustomBox<T, A> {
    pub fn new_in(value: T, alloc: A) -> Self {
        let layout = Layout::new::<T>();
        // SAFETY: Alokasi dicek, dan memori diinisialisasi.
        let ptr = alloc.allocate(layout).expect("OOM").cast::<T>();
        unsafe {
            ptr.as_ptr().write(value);
        }
        Self {
            ptr,
            alloc,
            _marker: PhantomData,
        }
    }

    pub fn into_raw(self) -> NonNull<T> {
        let ptr = self.ptr;
        std::mem::forget(self);
        ptr
    }
}

// SAFETY: #[may_dangle] menyatakan bahwa implementasi Drop ini tidak akan
// mengakses data di dalam `T` secara langsung selain untuk mendestruksinya.
// Ini mencegah kompilator menolak kode jika T berisi reference yang sudah mati.
unsafe impl<#[may_dangle] T, A: Allocator> Drop for CustomBox<T, A> {
    fn drop(&mut self) {
        unsafe {
            // Kita drop instance T yang ada di dalam pointer.
            // Jika T adalah type yang punya referensi, kita hanya drop T-nya,
            // tidak membaca isi referensi tersebut.
            drop_in_place(self.ptr.as_ptr());
            
            // Deallokasi memori heap
            let layout = Layout::new::<T>();
            self.alloc.deallocate(self.ptr.cast(), layout);
        }
    }
}

impl<T, A: Allocator> std::ops::Deref for CustomBox<T, A> {
    type Target = T;
    fn deref(&self) -> &Self::Target {
        // SAFETY: pointer valid selama siklus hidup CustomBox.
        unsafe { self.ptr.as_ref() }
    }
}

impl<T, A: Allocator> std::ops::DerefMut for CustomBox<T, A> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        // SAFETY: mutable reference eksklusif.
        unsafe { self.ptr.as_mut() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Inspector<'a>(&'a Cell<bool>);
    
    impl<'a> Drop for Inspector<'a> {
        fn drop(&mut self) {
            self.0.set(true);
        }
    }

    #[test]
    fn test_custom_box_drop() {
        let flag = Cell::new(false);
        {
            let _bx = CustomBox::new(Inspector(&flag));
        }
        assert!(flag.get(), "Inspector should be dropped");
    }
    
    #[test]
    fn test_variance_covariance() {
        // Harus bisa mengonversi CustomBox<&'static str> ke CustomBox<&'a str>
        let s: &'static str = "hello";
        let bx: CustomBox<&'static str> = CustomBox::new(s);
        let _bx_shorter: CustomBox<&str> = bx;
    }
}
```

## Anti-Patterns

1. **Lupa Menambahkan `PhantomData<T>` pada Struct Unsafe**
   **Mengapa berbahaya:** Jika menggunakan `*mut T` atau `NonNull<T>` tanpa `PhantomData<T>`, kompilator menganggap tipe ini tidak memiliki (own) `T`. Akibatnya, `dropck` tidak akan mengecek apakah `T` didrop dengan benar, dan kompilator bisa mengubah variance menjadi *invariant*. Ini menyebabkan ergonomi lifetime hancur dan berpotensi memori tidak bersih.
   ```rust
   // ANTI-PATTERN
   pub struct BadBox<T> {
       ptr: NonNull<T>, // T is invariant, dropck is oblivious
   }
   ```

2. **Mengakses Data T pada Destruktor dengan `#[may_dangle]`**
   **Mengapa berbahaya:** `#[may_dangle]` adalah janji pada kompilator: "Saya tidak akan mengakses isi T saat T di-drop". Jika di dalam `drop()` Anda mencetak/membaca atribut dari `T`, namun `T` memegang referensi ke data yang sudah mati, ini adalah *Use-After-Free* (UB).
   ```rust
   // ANTI-PATTERN
   unsafe impl<#[may_dangle] T: std::fmt::Debug> Drop for BadBox<T> {
       fn drop(&mut self) {
           // UB! Kita membaca T padahal lifetime T mungkin sudah kedaluwarsa.
           println!("Dropping: {:?}", unsafe { self.ptr.as_ref() }); 
       }
   }
   ```

## Edge Cases dan Defensive Programming

1. **OOM (Out Of Memory) saat Instansiasi:**
   Saat alokasi heap via `Layout::new::<T>()` gagal di production (OOM), panic atau `expect("OOM")` bisa meruntuhkan seluruh service. Defensive approach: Sediakan API `try_new` yang mengembalikan `Result<CustomBox<T>, AllocError>` daripada selalu melakukan unwrap internal.
   
2. **Dropck Ordering dan Nested Self-References:**
   Rust mendestruksi variabel lokal dengan urutan kebalikan dari deklarasinya (LIFO). Jika sebuah `struct` memiliki field yang merujuk satu sama lain, atau ada tuple berantai, destruktor yang dijalankan di luar urutan bisa mengakibatkan akses dangling sebelum struct sepenuhnya mati. `#[may_dangle]` menghindari over-restriction, tetapi tidak memperbaiki logika akses terlarang.

3. **Panic dalam Destruktor T (Double Panic / Abort):**
   Jika saat memanggil `drop_in_place(self.ptr.as_ptr())` tipe `T` mengalami panic, dan thread saat itu sudah sedang unwind karena panic lain, proses akan abort seketika. Selalu minimalkan logika yang bisa memicu panic di dalam `Drop` instance yang dimanage memori tingkat rendah.
