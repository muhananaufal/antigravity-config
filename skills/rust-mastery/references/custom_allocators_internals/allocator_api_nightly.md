# Allocator API (Nightly)

`allocator_api` (`#![feature(allocator_api)]`) memperkenalkan kapabilitas agar koleksi standar Rust (seperti `Vec`, `Box`, `BTreeMap`) dapat menggunakan alokator spesifik per-instansi. Ini berarti Anda tidak lagi dibatasi oleh sebuah `#[global_allocator]`. 

Contoh penggunaannya ada di pengembangan game (menggunakan ring buffer per-frame) atau simulasi HFT (memori pra-alokasi untuk message).

## Arsitektur & Alur Kerja

```text
                      Vec<T, A: Allocator>
                    /                      \
      A = GlobalAlloc (Default)      A = ArenaAlloc (Custom)
         /             \                   /              \
    Heap OS       System Paging    Ring Buffer      Stack Buffer
```
*Tipe allocator `A` dimasukkan sebagai parameter generik (atau zero-sized type) di koleksi.*

## Implementasi Production-Ready

```rust
#![feature(allocator_api)]
// Untuk bisa dikompilasi, file ini HARUS berada di nightly compiler.
use std::alloc::{AllocError, Allocator, Global, Layout};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Alokator kustom yang melacak metrik (jumlah byte dialokasikan).
/// Ia meneruskan alokasi ke Global allocator (pola komposit/fallback).
#[derive(Default, Debug)]
pub struct TrackingAllocator {
    pub total_allocated: AtomicUsize,
}

unsafe impl Allocator for TrackingAllocator {
    fn allocate(&self, layout: Layout) -> Result<NonNull<[u8]>, AllocError> {
        let result = Global.allocate(layout)?;
        self.total_allocated.fetch_add(layout.size(), Ordering::SeqCst);
        Ok(result)
    }

    unsafe fn deallocate(&self, ptr: NonNull<u8>, layout: Layout) {
        self.total_allocated.fetch_sub(layout.size(), Ordering::SeqCst);
        Global.deallocate(ptr, layout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::vec::Vec;

    #[test]
    fn test_custom_allocator_vec() {
        let tracker = TrackingAllocator::default();
        
        {
            // Vec dialokasikan menggunakan alokator pelacak
            let mut my_vec: Vec<u64, &TrackingAllocator> = Vec::new_in(&tracker);
            my_vec.push(10);
            my_vec.push(20);
            
            // 2 elemen * 8 bytes (u64) = 16 (atau lebih karena capacity growth)
            assert!(tracker.total_allocated.load(Ordering::SeqCst) >= 16);
        }
        
        // Ketika my_vec drop, memori didrop melalui deallocate, metrik harus turun ke 0.
        assert_eq!(tracker.total_allocated.load(Ordering::SeqCst), 0);
    }
}
```

## Anti-Pattern Terlarang

1. **Menyatukan Tipe dengan Alokator Berbeda dalam Parameter yang Sama:**
   *Mengapa berbahaya:* `Vec<T, Global>` dan `Vec<T, &TrackingAllocator>` adalah dua tipe yang BERBEDA secara sistem tipe (type system). Anda tidak bisa mem-pass `Vec` dengan custom allocator ke fungsi yang mengekspektasikan `Vec<T>` (karena defaultnya adalah `Global`).
   *Solusi:* Ubah signature fungsi menjadi menerima slice `&[T]` alih-alih `&Vec<T>`.
2. **Tidak Implementasi Drop yang Tepat pada Allocator Stateful:**
   *Mengapa berbahaya:* Jika alokator custom menyimpan state internal (contoh: arena di memory-mapped file), dan objek yang dialokasikan di dalam arena me-referensi keluar, ketika arena di-drop, use-after-free bisa timbul. Untungnya Rust allocator bounds mengaitkan lifetime `&A` ke koleksi (seperti dicontohkan dengan `Vec::new_in(&tracker)`).

## Edge Cases & Defensive Programming

- **Zero-Sized Types:** Sama seperti Global alloc, custom allocator harus menolak layout `size == 0` atau tidak mengalokasikan byte, namun Rust `Vec` otomatis men-short-circuit layout berukuran nol dan tidak memanggil `allocate()`. 
- **ZST vs Stateful Allocators:** Menggunakan reference `&Allocator` meningkatkan ukuran `Vec` (24 bytes + 8 bytes referensi). Jika memungkinkan, rancang allocator Anda tanpa state (ZST), sehingga ia tidak mengonsumsi ruang ekstra dalam `sizeof(Vec)`.
