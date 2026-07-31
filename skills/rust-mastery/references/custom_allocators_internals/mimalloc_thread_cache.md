# Mimalloc & Per-Thread Cache Design

Mimalloc (dikembangkan oleh Microsoft) berfokus pada fitur thread-local free list yang terisolasi dengan kuat untuk meminimalisasi lock contention. Performanya sangat bersaing (atau lebih baik) dari jemalloc dalam sistem highly concurrent dan coroutine/async workloads (seperti Tokio `spawn` heavy loads).

## Arsitektur Thread Cache

```text
 Thread 1 Local Heap        Thread 2 Local Heap
 [ TLAB (Thread Local       [ TLAB ]
   Allocation Buffer) ]     
      |                        |
 +--------------------------------+
 | OS Virtual Memory (mmap/sbrk)  |
 +--------------------------------+
```
Setiap thread di mimalloc mendelegasikan alokasinya secara eksklusif ke heap thread-lokal. Jika Thread A mengalokasikan dan Thread B mendealokasikan, blok dikembalikan ke *local free list* milik Thread A dengan teknik *lock-free deferred freeing*, meminimalisasi blocking global.

## Implementasi Production-Ready

```toml
[dependencies]
mimalloc = "0.1"
```

```rust
use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

/// API diagnostik sys mimalloc untuk integrasi advanced
#[cfg(feature = "mimalloc-sys")]
pub fn dump_mimalloc_stats() {
    unsafe {
        // mimalloc-sys mengekspos API FFI langsung.
        // `mi_stats_print` mencetak status internal (fragmentasi, tcache, 
        // waktu eksekusi malloc) ke stderr/stdout.
        // mimalloc_sys::mi_stats_print(std::ptr::null_mut());
    }
}

/// Implementasi wrapper aman (Contoh conceptual penggunaan allocator secure)
/// Mimalloc memiliki fitur `mi_zalloc` (zero allocated memory).
pub fn allocate_secure_buffer(size: usize) -> Vec<u8> {
    // Standar `vec![0; size]` biasanya akan menggunakan OS zero-pages 
    // atau memset melalui allocator standar. 
    // mimalloc sangat efisien menangani permintaan alloc-and-zero.
    vec![0; size]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn test_concurrent_allocation_mimalloc() {
        // Membuktikan bahwa alokasi dari thread berbeda menggunakan 
        // local heap yang di-handle dengan baik oleh mimalloc
        let handles: Vec<_> = (0..10).map(|_| {
            thread::spawn(|| {
                let mut data = allocate_secure_buffer(1024 * 64);
                data[0] = 1;
                data.iter().sum::<u8>()
            })
        }).collect();

        let sum: u8 = handles.into_iter().map(|h| h.join().unwrap()).sum();
        assert_eq!(sum, 10);
    }
}
```

## Fitur Secure & Edge Cases Mimalloc

Mimalloc memiliki varian *secure* yang bisa diaktifkan pada build level (melalui C flags `MI_SECURE=1`).
- Mengaktifkan **guard pages**: mencegah buffer overflow ke struktur data heap allocator.
- Mengaktifkan **randomized block allocation**: menyulitkan serangan *heap exploitation* eksploitasi use-after-free karena alamat berikutnya teracak.

## Anti-Pattern Terlarang

1. **Leak Thread Heap via Thread Pool Kustom:**
   *Mengapa berbahaya:* Jika Anda membuat thread manual via API OS dan tidak membiarkan Rust runtime memanggil thread teardown saat exit, local heap milik thread (`mi_heap_t`) tidak dapat dihancurkan dengan benar secara transparan. Jika menggunakan thread-pool dari crate ternama (`rayon`, `tokio`), ini sudah tertangani.
2. **False Sharing dari Padding Object:**
   *Mengapa berbahaya:* Meskipun mimalloc mencegah lock contention di layer heap, jika program membagikan pointer ke data L1 cache line yang sama antar thread, CPU stall (false sharing) tetap terjadi. Selalu selaraskan (align) struct concurrency-heavy ke `#[repr(align(64))]`.

## Defensive Programming

- **Memory Abandonment:** Jika thread 1 melempar panic (unwinding) dan memiliki struktur dialokasikan di TLAB-nya yang ter-transfer kepemilikannya ke Thread 2 (contoh channel MPSC), mimalloc menggunakan mekanisme internal "abandoned memory queue" yang secara berkala di-garbage-collect oleh thread lain. Ini menjamin sistem tidak akan crash atau leak dalam sistem asinkron/message passing.
