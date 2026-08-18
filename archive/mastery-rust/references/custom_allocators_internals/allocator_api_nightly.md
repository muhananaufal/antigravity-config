# Allocator API (Nightly) dan Custom Box

Fitur Nightly Rust `#![feature(allocator_api)]` merevolusi fleksibilitas memori dalam Systems Programming. Selama ini, struktur data koleksi generik seperti `Box`, `Vec`, dan `String` diasumsikan secara statis dialokasikan pada Sistem Global Allocator (heap standar). 

Dengan `allocator_api`, Rust memperbolehkan kita menginjeksi antarmuka *Local Allocator* ke dalam koleksi tipe tersebut. Hal ini melahirkan desain canggih seperti **Arena Allocators per-koneksi TCP**, alokasi memori berbaris (Bump allocators) untuk deserialisasi nol-fragmentasi (zero-fragmentation), hingga mapping koleksi langsung pada file memory-mapped (mmap).

## Arsitektur Parameterisasi Global vs Local Allocator

```ascii
[ Standard Vec<T> / Box<T> ]      [ Nightly Vec<T, A> / Box<T, A> ]
    (Global Allocator)                 (Custom Allocator)
+-----------------------+         +-------------------------------+
|  std::alloc::Global   |         | struct Arena (Local Instance) |
+-----------------------+         +-------------------------------+
            |                                     |
            v                                     v
[ Global Heap Manager ]           [ Pre-allocated Arena Chunk ]
 (Slower, thread-safe,             (Extremely fast, bump ptr,
   susceptible to frag)              bump down, single-threaded)
```

## Produksi-Ready Code: Custom Local Arena Allocator dengan `Box::new_in`

Kode ini mendemonstrasikan arena bump-pointer allocator yang ringkas dengan dukungan trait `Allocator` nightly.

```rust
#![feature(allocator_api)]
#![feature(nonnull_slice_from_raw_parts)]
#![feature(alloc_layout_extra)]

use std::alloc::{AllocError, Allocator, Global, Layout};
use std::cell::Cell;
use std::ptr::NonNull;

/// BumpArena adalah allocator cepat tanpa-fragmentasi
/// yang mengalokasikan data secara linear.
/// Semua memori akan dikembalikan utuh (bulk free) saat Arena ini drop.
pub struct BumpArena {
    // Alokasi memori heap statis yang akan dipotong-potong
    memory: NonNull<[u8]>,
    // Offset saat ini untuk alokasi baru
    offset: Cell<usize>,
}

impl BumpArena {
    pub fn new(size: usize) -> Self {
        // Alokasi memori besar menggunakan Global allocator sebagai base kita
        let layout = Layout::array::<u8>(size).unwrap();
        // SAFETY: Alokasi dicek OOM
        let ptr = Global.allocate(layout).expect("OOM on Arena creation");
        
        Self {
            memory: ptr,
            offset: Cell::new(0),
        }
    }
}

unsafe impl Allocator for BumpArena {
    fn allocate(&self, layout: Layout) -> Result<NonNull<[u8]>, AllocError> {
        let current_offset = self.offset.get();
        let arena_len = self.memory.len();
        
        // Memastikan alignment (kelipatan memori per tipe)
        // Cth: f64 harus di-align ke alamat genap 8 byte
        let alignment = layout.align();
        let align_offset = (current_offset + alignment - 1) & !(alignment - 1);
        
        let new_offset = align_offset + layout.size();
        if new_offset > arena_len {
            // Memory Arena habis!
            return Err(AllocError);
        }
        
        self.offset.set(new_offset);
        
        // SAFETY: Melakukan kalkulasi alamat pointer dasar dan menaikkannya
        unsafe {
            let base_ptr = self.memory.as_ptr() as *mut u8;
            let start_ptr = base_ptr.add(align_offset);
            
            // Konversi ke slice pointer NonNull
            let slice_ptr = core::ptr::slice_from_raw_parts_mut(start_ptr, layout.size());
            Ok(NonNull::new_unchecked(slice_ptr))
        }
    }

    unsafe fn deallocate(&self, _ptr: NonNull<u8>, _layout: Layout) {
        // No-Op! (Ini Bump Allocator, kita tidak membebaskan memori 
        // individual, kita membersihkan SEMUANYA sekaligus saat BumpArena didrop)
    }
}

impl Drop for BumpArena {
    fn drop(&mut self) {
        unsafe {
            let layout = Layout::array::<u8>(self.memory.len()).unwrap();
            Global.deallocate(self.memory.cast(), layout);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_custom_allocator_box() {
        // Alokasi arena 1 Megabyte
        let arena = BumpArena::new(1024 * 1024);
        
        // Gunakan alloc_api: Box dialokasikan *di dalam* Arena, bukan Heap global
        let my_int_in_arena = Box::new_in(42_u64, &arena);
        assert_eq!(*my_int_in_arena, 42);
        
        // Vec dialokasikan di Arena yang sama!
        let mut vec_in_arena = Vec::new_in(&arena);
        vec_in_arena.push(100);
        vec_in_arena.push(200);
        assert_eq!(vec_in_arena.len(), 2);
    }
}
```

## Anti-Patterns

1. **Mengabaikan Trait Layout `align()` dalam Allocator Custom**
   **Mengapa berbahaya:** Jika allocator sekadar menambah offset berdasar `layout.size()` tanpa mem-padding alamat untuk memenuhi `layout.align()`, kompilator akan menghasilkan Unaligned Memory Access (Undefined Behavior). Di arsitektur ARM, mengakses nilai 64-bit pada alamat ganjil memicu *Bus Error (SIGBUS)* atau crash sistem, dan pada x86 menghancurkan performa vector instruksi.
   
2. **Deallokasi Parsial dengan No-Op Fallback di Loop**
   **Mengapa berbahaya:** Menggunakan custom allocator seperti BumpArena pada worker thread (misal web server loop) yang tidak pernah didrop akan menyebabkan Out-Of-Memory (OOM) instan. Karena pointer sekadar ditambahkan (bump up) selamanya, loop yang berjalan lama akan mengekshaust kapasitas pool, menyebabkan server mati.

## Edge Cases dan Defensive Programming

1. **Penanganan Drop Koleksi vs Allocator:**
   Ketika `Box::new_in(T, &arena)` digunakan, jika Box didrop, ia akan memanggil fungsi `T::drop` lalu memanggil `arena.deallocate()`. Karena deallokasi pada `BumpArena` adalah No-Op, referensi ini aman. Tetapi, jika memori `BumpArena` didestruksi *sebelum* `Box` atau `Vec` tersebut selesai digunakan, Box akan menjadi pointer menggantung (Dangling Pointer) yang memicu UB. Sistem lifetime Rust (seperti reference `&'a arena`) memitigasi isu ini secara statis.

2. **Re-Alokasi (`grow` dan `shrink`):**
   `Vec` sering merealokasi array-nya. Jika Arena allocator tidak melacak atau menyediakan optimasi grow (in-place resize), memanggil `vec.push()` akan meninggalkan jejak array lama sebagai "memori terbuang" dalam Bump Arena karena tipe memori ini tidak bisa didealokasi secara individual (memori *fragmentasi spasial* parah).

3. **Fallback Global Memory (Multi-Tier Allocator):**
   Di production, jika Arena penuh (OOM pada Arena), *graceful degradation* biasanya meminta allocator beralih sementara ke Global allocator untuk request tersebut. Desain `BumpArena` di atas melempar `AllocError` yang menyebabkan panic instan pada API standar seperti `Vec::push` yang mengharuskan penggunaan API infallability `Vec::try_reserve`.
