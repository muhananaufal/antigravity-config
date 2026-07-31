# Drop Check (Dropck) & May Dangle Eyepatch

## Konsep Utama
Drop Check (Dropck) adalah aturan borrow checker yang berjalan saat destruksi objek (via trait `Drop`). Tujuannya adalah mencegah memanggil method pada data yang sudah dihancurkan.
Aturan ketat Dropck: "Jika Anda memanggil Drop pada tipe `T` yang memiliki parameter generik (Lifetime atau Type), Anda tidak boleh mengakses data yang memiliki lifetime yang sama atau lebih pendek, karena itu mungkin sudah dealokasi".
- `#[may_dangle]` (Nightly Only / Unstable, disebut Eyepatch): Atribut untuk bypass aturan ketat Dropck. Ini memberitahu compiler: "Percayalah padaku, saat fungsi Drop dipanggil, aku tidak akan menyentuh atau mendereferensi data di dalam tipe parametrik ini".
- PhantomData sangat vital di sini untuk memberi tahu compiler siapa yang secara logikal "dimiliki" (owned) sehingga urutan drop dijamin aman.

**Kapan Digunakan:**
Menulis custom data structures standar (seperti implementasi internal `std::vec::Vec`, `LinkedList`, dll), mengelola resource FFI, dan men-bypass deadlocks lifetime ketat di sistem arena memory.

## Arsitektur / Flow
```text
Urutan Drop Otomatis:
Struct {
   a: String,  <-- 1. Struct di-drop
   b: Vec<T>,  <-- 2. Field A di-drop (FIFO urutan deklarasi)
}              <-- 3. Field B di-drop

Jika Dropck aktif dan kita memiliki `impl<T> Drop for Vec<T>`, 
compiler cemas kita mungkin memanggil method T di dalam blok Drop,
kecuali kita pasang eyepatch #[may_dangle].
```

## Implementasi Production-Ready (Teoritis / Fitur Unstable)

*Catatan: `#![feature(dropck_eyepatch)]` hanya bisa digunakan di Nightly Rust compiler.*

```rust
#![feature(dropck_eyepatch)]

use std::ptr::NonNull;
use std::alloc::{alloc, dealloc, Layout};
use std::marker::PhantomData;

/// Custom Vec minimal yang mendemonstrasikan bypass Dropck.
pub struct MyVec<T> {
    ptr: NonNull<T>,
    cap: usize,
    len: usize,
    // Menjamin MyVec secara logikal memiliki (owns) elemen bertipe T 
    // demi perhitungan rules Dropck yang akurat.
    _marker: PhantomData<T>,
}

impl<T> MyVec<T> {
    pub fn new() -> Self {
        Self {
            ptr: NonNull::dangling(),
            cap: 0,
            len: 0,
            _marker: PhantomData,
        }
    }
    // Implementasi push, pop diabaikan demi fokus pada Dropck
}

/// Secara normal, Dropck akan menolak kode jika MyVec menyimpan reference (mis. MyVec<&'a str>)
/// dan di-drop BERSAMAAN dengan berakhirnya lifetime &'a.
/// Dengan #[may_dangle], kita berjanji `drop` tidak akan menjalankan metode apapun pada T
/// yang membutuhkan T untuk hidup.
unsafe impl<#[may_dangle] T> Drop for MyVec<T> {
    fn drop(&mut self) {
        if self.cap != 0 {
            // Kita drop elemen demi elemen secara eksplisit
            while self.len > 0 {
                self.len -= 1;
                unsafe {
                    // Berbahaya: Ini memanggil drop() dari T.
                    // Jika T adalah struct yang implement Drop, ini dipanggil.
                    // Jika T adalah trait object dengan lifetime pendek, ini aman
                    // SELAMA implementasi drop dari T tidak menelusuri dangling pointers.
                    std::ptr::drop_in_place(self.ptr.as_ptr().add(self.len));
                }
            }
            
            // Dealokasi memori heap utama
            let layout = Layout::array::<T>(self.cap).unwrap();
            unsafe {
                dealloc(self.ptr.as_ptr() as *mut u8, layout);
            }
        }
    }
}
```

## Anti-Patterns

1. **Mengakses Nilai di dalam `#[may_dangle] Drop`:**
   Mencetak nilai log menggunakan parameter `T` saat `Drop` jika `T` ditandai dengan `#[may_dangle]`.
   *Mengapa Berbahaya:* Atribut may_dangle adalah kontrak "mata tertutup". Jika Anda memanggil `println!("{}", value_t)` di `drop`, Anda membaca memori yang kemungkinan besar sudah di-dealokasi atau pointer dangling. UB (Undefined Behavior) akan terjadi.

2. **Melupakan `PhantomData` pada Custom Container yang Menggunakan Unsafe Pointers:**
   Membuat struktur koleksi tipe pointer (seperti `*mut T`) tetapi tidak menaruh `PhantomData<T>`.
   *Mengapa Berbahaya:* Jika tipe data koleksi Anda tidak secara otomatis memicu Drop pada data `T`, dan Anda tidak menggunakan PhantomData, Rust compiler berasumsi koleksi Anda TIDAK memiliki memori tersebut. Ini bisa merusak keamanan thread, subtyping variance, dan melewatkan rule Drop Check krusial di struct yang di-nesting.

## Edge Cases & Defensive Engineering
- **Stable Rust Alternative:** Karena `#[may_dangle]` tidak stabil, programmer sering membungkus container pointer unsafe mereka di dalam standard struct jika memungkinkan. Anda tidak dapat membuat tipe bypass dropck di stable Rust, jadi perancangan arsitektur lifetime di luar crate standar harus direncanakan lebih ketat agar lifetime koleksi selalu outlive (berumur lebih panjang) dari data yang ditunjuk.
