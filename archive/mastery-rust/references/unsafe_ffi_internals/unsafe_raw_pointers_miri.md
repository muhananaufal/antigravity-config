# Pointer Provenance & Raw Pointers di Rust

## Konsep Utama
Dalam sistem `unsafe` Rust, *raw pointers* (`*const T` dan `*mut T`) adalah elemen fundamental untuk berinteraksi dengan memori tanpa pengawasan *borrow checker*. Rust beranjak dari model C di mana pointer hanya dianggap sebagai integer (alamat memori). Rust dan Miri (interpreter Rust) mengadopsi model **Strict Provenance** (saat ini *Stacked Borrows* / *Tree Borrows*). 

Provenance berarti setiap pointer tidak hanya memiliki alamat, tetapi juga "tag" atau "izin" yang melacak asal-usul pointer tersebut. Operasi konversi sembarangan antara integer dan pointer (seperti `T as *const _ as usize as *const _`) kehilangan provenance ini, memicu Undefined Behavior (UB) karena kompilator (LLVM) berasumsi pointer yang baru dibentuk tidak berhak mengakses lokasi memori asalnya. Makro `addr_of!` dan `addr_of_mut!` sangat krusial untuk membuat pointer ke lokasi tanpa menciptakan referensi intermediate yang dapat memicu UB jika data belum terinisialisasi atau tidak selaras (unaligned).

**Kapan Digunakan:**
- Interoperabilitas FFI dengan C/C++ yang mengirimkan raw pointers.
- Implementasi struktur data kustom (seperti `Box`, `Vec`, *Trees*).
- Membaca memori yang tidak diinisialisasi atau *unaligned data*.

## Arsitektur & Aliran: Strict Provenance
```ascii
[ Memori Fisik ]
   |
   v
[ Pointer A ] -- Alamat: 0x1000, Tag: { Alokasi X, Izin: Read/Write }
   | (transmute ke usize) -- HILANG PROVENANCE!
   v
[ Integer ] ---- Nilai: 0x1000
   | (cast ke pointer) -- PROVENANCE KOSONG / INVALID!
   v
[ Pointer B ] -- Alamat: 0x1000, Tag: { INVALID } -> UB jika di-deref!

Solusi: Strict Provenance API (ptr::with_addr)
[ Pointer A ] --(ptr::addr)--> Integer
    |
    +--(ptr::with_addr)--> [ Pointer B ] -- Mempertahankan Tag!
```

## Kode Production-Ready
Berikut adalah contoh struktur data `MemoryPool` sederhana yang menunjukkan penggunaan API *strict provenance* (tersedia di *nightly* atau melalui *polyfill* / *strict_provenance* module) dan `addr_of_mut!`.

```rust
#![cfg_attr(nightly, feature(strict_provenance))]

use std::ptr::{self, NonNull};
use std::alloc::{alloc, dealloc, Layout};
use std::mem;

/// Blok memori primitif yang dikelola secara manual.
pub struct RawMemoryBlock<T> {
    ptr: NonNull<T>,
    capacity: usize,
}

impl<T> RawMemoryBlock<T> {
    pub fn new(capacity: usize) -> Result<Self, &'static str> {
        if capacity == 0 {
            return Err("Capacity cannot be zero");
        }
        
        // Pastikan ukuran tidak overflow
        let layout = Layout::array::<T>(capacity).map_err(|_| "Layout error")?;
        
        // SAFETY: Layout terjamin non-zero dan valid.
        let raw_ptr = unsafe { alloc(layout) as *mut T };
        
        let ptr = NonNull::new(raw_ptr).ok_or("OOM: Allocation failed")?;
        
        Ok(Self { ptr, capacity })
    }

    /// Mendapatkan pointer ke elemen pada index tertentu menggunakan strict provenance.
    /// Mengembalikan None jika out of bounds.
    pub fn get_ptr_at(&self, index: usize) -> Option<*mut T> {
        if index >= self.capacity {
            return None;
        }

        let base_ptr = self.ptr.as_ptr();
        
        // SAFETY: 
        // 1. base_ptr valid dan berada dalam alokasi yang sama.
        // 2. index berada dalam bounds kapasitas.
        // Kita menggunakan `add` yang mempertahankan provenance dari base_ptr.
        let target_ptr = unsafe { base_ptr.add(index) };
        Some(target_ptr)
    }

    /// Menulis data ke lokasi yang belum diinisialisasi menggunakan addr_of_mut!
    /// untuk menghindari menciptakan intermediate reference jika T tidak selaras/valid.
    pub unsafe fn write_unaligned(&mut self, index: usize, val: T) {
        if let Some(target_ptr) = self.get_ptr_at(index) {
            // Kita bungkus pointer dalam struct dummy untuk demonstrasi addr_of_mut!
            struct Wrapper<T> {
                data: T,
            }
            
            // Cast pointer
            let wrapper_ptr = target_ptr as *mut Wrapper<T>;
            
            // SAFETY: Kita menggunakan addr_of_mut! untuk menghindari dereferencing
            // memory yang belum diinisialisasi. ptr::write mengabaikan nilai lama.
            unsafe {
                let data_field_ptr = ptr::addr_of_mut!((*wrapper_ptr).data);
                ptr::write_unaligned(data_field_ptr, val);
            }
        }
    }
}

impl<T> Drop for RawMemoryBlock<T> {
    fn drop(&mut self) {
        let layout = Layout::array::<T>(self.capacity).unwrap();
        // SAFETY: Pointer valid dan dialokasikan oleh global allocator dengan layout yang sama.
        unsafe {
            dealloc(self.ptr.as_ptr() as *mut u8, layout);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_raw_memory_block() {
        let mut block = RawMemoryBlock::<u32>::new(10).unwrap();
        
        unsafe {
            let ptr = block.get_ptr_at(0).unwrap();
            ptr::write(ptr, 42);
            assert_eq!(ptr::read(ptr), 42);
            
            block.write_unaligned(1, 100);
            let ptr1 = block.get_ptr_at(1).unwrap();
            assert_eq!(ptr::read_unaligned(ptr1), 100);
        }
    }
}
```

## Anti-Patterns

### 1. Pointer ke Integer dan Kembali tanpa Provenance
**Bahaya:** Mengambil alamat memori sebagai `usize`, memanipulasinya, dan mengubahnya kembali ke pointer (menggunakan `as *mut T`) memutus rantai *provenance*. Compiler (LLVM) akan mengasumsikan pointer baru tersebut tidak memiliki keterikatan dengan alokasi aslinya, dan akan mengoptimalkan akses seolah-olah pointer tersebut *dangling*, memicu Undefined Behavior (UB).
**Solusi:** Gunakan API *Strict Provenance* (e.g., `ptr::with_addr`) atau cukup lakukan aritmatika pointer (`pointer::add`, `pointer::sub`) daripada aritmatika integer.

```rust
// ANTI-PATTERN
let mut x = 5;
let ptr = &mut x as *mut i32;
let addr = ptr as usize;
let invalid_ptr = addr as *mut i32; 
// unsafe { *invalid_ptr = 10; } // UB menurut Miri!
```

### 2. Referensi pada Memori Uninitialized
**Bahaya:** Membuat referensi (`&T` atau `&mut T`) ke memori yang belum diinisialisasi memicu UB mutlak di Rust. Referensi mengharuskan data valid secara tipe dan layout.
**Solusi:** Selalu gunakan raw pointers dan `addr_of!` / `addr_of_mut!` saat berhadapan dengan memori yang berpotensi belum diinisialisasi.

```rust
// ANTI-PATTERN
let mut uninit = std::mem::MaybeUninit::<i32>::uninit();
// unsafe { let r = &mut *uninit.as_mut_ptr(); } // UB! Menciptakan &mut i32 ke uninit memory.
```

## Edge Cases & Defensive Engineering
- **Zero-Sized Types (ZSTs):** Saat menggunakan pointer offset (`.add()`), jika `T` adalah ZST, `.add()` tidak memajukan alamat aktual memori (offset selalu 0 byte). Pastikan alokasi/deallokasi menangani ZST dengan benar (tidak boleh memanggil `alloc` untuk ukuran 0). Pointer `NonNull::dangling()` sering digunakan untuk merepresentasikan heap ZST.
- **Null Pointers:** Rust tidak memiliki toleransi terhadap dereferencing Null. Gunakan `ptr::is_null()` sebelum akses atau gunakan `NonNull<T>` secara inheren di API Anda untuk mencegah pointer nol masuk dari FFI.
- **Miri UB Detection:** Selalu uji kode `unsafe` yang memanipulasi pointer dengan menjalankan `cargo miri test`. Miri melacak setiap byte, alokasi, dan Stacked Borrows violations yang tidak bisa ditangkap pada saat *runtime* biasa.
