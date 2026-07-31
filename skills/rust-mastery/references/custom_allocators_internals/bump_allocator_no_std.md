# Bump Allocator untuk `#![no_std]`

Bump allocator (juga dikenal sebagai arena atau linear allocator) adalah strategi alokasi memori paling sederhana dan tercepat. Alokator ini mengalokasikan memori secara linear dengan menggeser sebuah pointer, dan tidak mendukung dealokasi individual (dealokasi dilakukan secara massal saat seluruh region di-reset). Ini sangat ideal untuk sistem embedded `#![no_std]` atau fase kompilasi di mana alokasi berumur pendek mendominasi.

## Arsitektur & Alur Kerja

```text
       Heap Region
[=========================]
 ^         ^              ^
 |         |              |
Start     Next          End
           (Bump Pointer)

Alokasi baru bergeser dari Next ke arah End.
Jika Next + ukuran > End, maka Out of Memory (OOM).
```

## Implementasi Production-Ready

```rust
#![no_std]
use core::alloc::{GlobalAlloc, Layout};
use core::cell::UnsafeCell;
use core::ptr;

/// Bump allocator sederhana yang thread-unsafe.
/// Untuk sistem multi-core, gunakan Mutex/Spinlock untuk sinkronisasi.
pub struct BumpAllocator {
    start: usize,
    end: usize,
    next: UnsafeCell<usize>,
}

unsafe impl Sync for BumpAllocator {}

impl BumpAllocator {
    pub const fn empty() -> Self {
        BumpAllocator {
            start: 0,
            end: 0,
            next: UnsafeCell::new(0),
        }
    }

    /// Inisialisasi heap region (biasanya dipanggil sekali saat boot).
    /// `heap_start` dan `heap_size` biasanya didapat dari linker script symbol.
    pub unsafe fn init(&mut self, heap_start: usize, heap_size: usize) {
        self.start = heap_start;
        self.end = heap_start.saturating_add(heap_size);
        *self.next.get() = heap_start;
    }

    /// Align up memori agar sesuai dengan alignment yang diminta.
    fn align_up(addr: usize, align: usize) -> usize {
        (addr + align - 1) & !(align - 1)
    }
}

unsafe impl GlobalAlloc for BumpAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let current_next = *self.next.get();
        let alloc_start = Self::align_up(current_next, layout.align());
        
        let alloc_end = match alloc_start.checked_add(layout.size()) {
            Some(end) => end,
            None => return ptr::null_mut(), // Integer overflow
        };

        if alloc_end <= self.end {
            *self.next.get() = alloc_end;
            alloc_start as *mut u8
        } else {
            ptr::null_mut() // Out of memory
        }
    }

    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {
        // Bump allocator tidak mendealokasi secara individual.
        // Operasi ini adalah no-op. Dealokasi terjadi dengan me-reset `next` ke `start`.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::alloc::Layout;

    #[test]
    fn test_bump_allocation() {
        let mut heap = [0u8; 1024];
        let mut allocator = BumpAllocator::empty();
        unsafe {
            allocator.init(heap.as_mut_ptr() as usize, heap.len());
        }

        let layout = Layout::from_size_align(8, 8).unwrap();
        unsafe {
            let ptr1 = allocator.alloc(layout);
            assert!(!ptr1.is_null());
            assert_eq!(ptr1 as usize % 8, 0);

            let ptr2 = allocator.alloc(layout);
            assert!(!ptr2.is_null());
            assert_eq!((ptr2 as usize) - (ptr1 as usize), 8);
        }
    }
}
```

## Anti-Pattern Terlarang

1. **Mengabaikan Alignment (`Layout::align()`):**
   *Mengapa berbahaya:* Arsitektur ARM (biasa di embedded) akan panic/HardFault jika melakukan *unaligned memory access*. Menambahkan ukuran langsung ke pointer tanpa `align_up` adalah kesalahan fatal.
2. **Tidak Melindungi Terhadap Integer Overflow:**
   *Mengapa berbahaya:* Jika `alloc_start + layout.size()` melewati batas `usize::MAX`, ini akan wrap-around dan meloloskan cek OOM (`<= self.end`), menyebabkan alokator memberikan memori yang tumpang tindih atau out-of-bounds, yang memicu kerentanan eksploitasi (heap overflow).

## Edge Cases & Defensive Programming

- **Linker Symbol Alignment:** Saat mengambil alamat heap dari linker symbol, alamat awal mungkin tidak *page-aligned*. Validasi alamat awal sebelum memasukkannya ke `init()`.
- **Zero-Sized Types (ZST):** Layout berukuran `0` bisa di-request. Implementasi di atas akan merespons dengan me-return alamat unik atau menggeser bump pointer sebesar 0 (aman, tetapi perlu diperhatikan agar tidak mengakses memori yang dikembalikan).
