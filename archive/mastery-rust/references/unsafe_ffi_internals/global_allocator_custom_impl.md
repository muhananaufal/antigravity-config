# Global Allocator & System Allocator

## Konsep Utama
Rust mengalokasikan dan mendealokasikan memori dinamis (heap) menggunakan _global allocator_. Secara *default*, ini ditangani oleh implementasi standar (`System`), yang pada akhirnya memanggil `malloc`/`free` di C atau HeapAPI di Windows. 

Anda bisa mengganti _global allocator_ ini menggunakan trait `std::alloc::GlobalAlloc` dan tag `#[global_allocator]`. Anda juga bebas menyediakan alokator kustom, seperti `jemalloc` (untuk performa multi-threading), `mimalloc`, atau *tracking allocator* untuk mendeteksi *memory leak* selama *testing*.

**Kapan Digunakan:**
- Optimalisasi alokasi memori berfrekuensi tinggi (menggunakan alokator pihak ketiga).
- Memonitor *memory leaks* atau mengukur *heap usage* secara *real-time*.
- *Embedded systems* (No-OS) di mana kita harus mengimplementasikan algoritma manajemen *heap* sendiri secara fisik (seperti algoritma Buddy Allocator).

## Arsitektur & Aliran: Tracking Allocator
```ascii
[ Aplikasi Rust (Box, Vec, String) ]
      |
    (Memanggil Global Allocator)
      |
      v
[ #[global_allocator] Custom Allocator ]
      | ---> Update Counter Byte ++ / --
      |
      v
[ System Allocator (malloc/free) ]
      |
    (OS Heap)
```

## Kode Production-Ready
Berikut adalah implementasi alokator memori yang membungkus *System Allocator* standar, dengan kemampuan melacak total alokasi byte *heap*.

```rust
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Struktur alokator kustom kita
pub struct TrackingAllocator {
    pub allocated_bytes: AtomicUsize,
    pub deallocated_bytes: AtomicUsize,
}

impl TrackingAllocator {
    pub const fn new() -> Self {
        Self {
            allocated_bytes: AtomicUsize::new(0),
            deallocated_bytes: AtomicUsize::new(0),
        }
    }
    
    pub fn current_usage(&self) -> usize {
        let alloc = self.allocated_bytes.load(Ordering::Relaxed);
        let dealloc = self.deallocated_bytes.load(Ordering::Relaxed);
        alloc.saturating_sub(dealloc)
    }
}

// SAFETY: 
// 1. Thread-safe: kita menggunakan AtomicUsize.
// 2. Mendelegasikan aktual alloc/dealloc ke `System` (allocator sistem operasi standar).
unsafe impl GlobalAlloc for TrackingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // PERINGATAN: Dilarang keras menggunakan println! atau alokasi lain 
        // (seperti Mutex yang mungkin mengalokasi memori) di sini.
        // Itu akan menyebabkan infinite recursion!
        
        let size = layout.size();
        // Lakukan pembukuan
        self.allocated_bytes.fetch_add(size, Ordering::SeqCst);
        
        // Panggil System Allocator sebenarnya
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let size = layout.size();
        self.deallocated_bytes.fetch_add(size, Ordering::SeqCst);
        
        System.dealloc(ptr, layout)
    }
}

// Di file main.rs atau lib.rs, aplikasikan ini:
// #[global_allocator]
// static GLOBAL_ALLOC: TrackingAllocator = TrackingAllocator::new();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tracking_allocator_mock() {
        let tracker = TrackingAllocator::new();
        
        // Kita tidak bisa menimpa #[global_allocator] untuk pengujian, 
        // tapi kita bisa menguji fungsionalitasnya secara manual:
        let layout = Layout::from_size_align(128, 8).unwrap();
        
        unsafe {
            let ptr = tracker.alloc(layout);
            assert!(!ptr.is_null());
            assert_eq!(tracker.current_usage(), 128);
            
            tracker.dealloc(ptr, layout);
            assert_eq!(tracker.current_usage(), 0);
        }
    }
}
```

## Anti-Patterns

### 1. Alokasi di Dalam Allocator (Infinite Loop)
**Bahaya:** Saat memprogram alokator Anda menggunakan trait `GlobalAlloc`, jika Anda memanggil log yang menggunakan formating kompleks, atau mengunci `Mutex` standar (yang berpotensi mengalokasikan struct di OS), itu akan mentrigger pemanggilan ulang terhadap global alokator itu sendiri. Hal ini memicu loop tak berujung dan akhirnya *stack overflow*.
**Solusi:** Fungsi `alloc` dan `dealloc` harus sangat _bare-bones_ dan deterministik. Gunakan `spin_lock` No-Std atau `Atomic` untuk sinkronisasi. Jangan pernah menggunakan `String`, `Box`, atau `format!`.

```rust
// ANTI-PATTERN
unsafe impl GlobalAlloc for BadAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // std::println!("Alokasi {:?}", layout.size()); // SANGAT BERBAHAYA! Println mengalokasikan buffer dan Mutex!
        std::alloc::System.alloc(layout)
    }
    // ...
}
```

### 2. Layout Alignment Mismatch
**Bahaya:** OS malloc menjamin alokasi disejajarkan menurut arsitektur (biasanya 8 atau 16 byte). Tetapi Rust mungkin meminta alokasi dengan `alignment` yang ekstrem seperti 64 byte (contoh, untuk vektor AVX-512 atau memory page alignment). Memanggil malloc standar tanpa penyesuaian untuk alignment ini (posix_memalign/aligned_alloc) adalah UB besar.
**Solusi:** `System.alloc(layout)` sudah menanganinya dengan aman. Jika membuat dari nol, pastikan Anda menggunakan instruksi *aligned allocation* OS yang relevan jika `layout.align() > MIN_ALIGN`.

## Edge Cases & Defensive Engineering
- **Out of Memory (OOM):** Jika `alloc` gagal mendapatkan memori, dilarang menyebabkan `panic!`. Anda **harus** mengembalikan null pointer (`ptr::null_mut()`). Mekanisme atas (seperti `alloc::alloc::handle_alloc_error`) akan menentukan apakah sistem harus aborsi atau mengembalikan indikator error pada level pengguna.
