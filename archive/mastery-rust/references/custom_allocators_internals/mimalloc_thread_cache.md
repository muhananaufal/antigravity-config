# Mimalloc Thread Cache

Microsoft's `mimalloc` adalah salah satu system allocator paling mutakhir, dirancang dengan filosofi ekstrem seputar *Thread-Local Caching* (Tcache) dan *Sharding*. Berbeda dengan global allocator glibc standar yang harus mengakuisisi atomic lock saat thread membutuhkan memori, mimalloc memastikan bahwa 99% fungsi alokasi berjalan sebagai operasi inkremental (pointer bump) murni di dalam memori cache spesifik milik thread pemanggil (Thread-Local Free List).

Hal ini membuat aplikasi Rust yang sangat paralel memecahkan bottleneck sinkronisasi, memungkinkan pergerakan latensi konstan hingga level mikrodetik. 

## Arsitektur Free-List Per-Thread & Cross-Thread Freeing

```ascii
[ Thread 1 CPU Core ]                  [ Thread 2 CPU Core ]
         |                                      |
+--------------------+                 +--------------------+
| Thread Local Cache |                 | Thread Local Cache |
| - Page 1 (32b)     |                 | - Page X (128b)    |
| - Page 2 (64b)     |                 | - Page Y (256b)    |
|                    |                 |                    |
| Fast Free List ptr |                 | Fast Free List ptr |
+--------------------+                 +--------------------+
         |   ^                                  |   ^
 (Local  |   | (Local                   (Cross- |   | (Delayed
  Alloc) v   |  Free)                   Thread) v   |  Free / GC)
+--------------------+                 +--------------------+
| Local Heap Segment |                 | Local Heap Segment |
+--------------------+                 +--------------------+
         \                                      /
          \----> [ Global OS Memory Pages ] <---/
```

## Produksi-Ready Code: Eksplorasi Thread-Local Overhead via Mimalloc

Kode ini meng-emulasikan pola alokasi intensif yang dipisahkan antar thread vs alokasi *cross-thread free* untuk menunjukkan dampak pada pipeline thread local dari allocator modern.

```rust
#[cfg(feature = "mimalloc")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use std::thread;
use std::sync::mpsc;
use std::time::Duration;

/// Struktur yang mensimulasikan message berat di Rust
/// dialokasikan di heap
pub struct BoxedPayload {
    data: Box<[u8]>,
}

impl BoxedPayload {
    pub fn new(size: usize) -> Self {
        // Alokasi terjadi pada Thread Cache (Tcache) milik thread pemanggil saat ini.
        Self {
            data: vec![0u8; size].into_boxed_slice(),
        }
    }
}

/// Mensimulasikan pipeline "Cross-Thread Freeing"
/// Ini adalah pola yang MENDEGRADASI performa Mimalloc
/// karena Thread B membebaskan blok memori milik Thread A.
pub fn simulate_cross_thread_alloc_free(msg_count: usize, size: usize) {
    let (tx, rx) = mpsc::sync_channel(1000);
    
    // Thread Produser: Mengalokasikan objek dalam loop ketat
    let producer = thread::spawn(move || {
        for _ in 0..msg_count {
            let payload = BoxedPayload::new(size);
            tx.send(payload).expect("Channel closed");
        }
    });

    // Thread Konsumer: Menghancurkan (Free) objek yang dibuat oleh Produser
    let consumer = thread::spawn(move || {
        let mut consumed = 0;
        while let Ok(_payload) = rx.recv() {
            // Drop secara implisit memanggil `free()`.
            // Mimalloc mendeteksi bahwa memori ini milik segmen thread Produser.
            // Memori tidak bisa dikembalikan ke Fast List Thread Konsumer, 
            // melainkan masuk ke "Delayed Free List" atomik milik Produser.
            consumed += 1;
        }
        assert_eq!(consumed, msg_count);
    });

    producer.join().unwrap();
    consumer.join().unwrap();
}

/// Mensimulasikan pipeline murni Thread-Local Allocation/Freeing
/// Pola OPTIMAL untuk allocator modern.
pub fn simulate_local_alloc_free(msg_count: usize, size: usize) {
    let worker = thread::spawn(move || {
        let mut count = 0;
        for _ in 0..msg_count {
            // Alokasi dan Deallokasi terjadi pada thread yang SAMA
            // Operasi ini nyaris zero-cost (pure pointer bump di Tcache)
            let _payload = BoxedPayload::new(size);
            count += 1;
        }
        assert_eq!(count, msg_count);
    });

    worker.join().unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cross_thread_memory() {
        // Test cross-thread pattern, expects no panic and memory cleanliness
        simulate_cross_thread_alloc_free(5000, 1024);
    }
    
    #[test]
    fn test_local_thread_memory() {
        simulate_local_alloc_free(5000, 1024);
    }
}
```

## Anti-Patterns

1. **Pembuatan Objek Skala Besar untuk Thread Lain (Cross-Thread Freeing Bomb)**
   **Mengapa berbahaya:** Jika Thread A (Web socket handler) melakukan `serde_json::from_slice` sehingga mengalokasikan 100 ribu string (`String`, `Vec<u8>`), dan mengoper string ini ke Thread B (Database writer) via channel, Thread B harus me-free string tersebut. Pada mimalloc, `free` lintas thread memaksa *Atomic Compare-And-Swap (CAS)* yang memicu cache-line bouncing (False Sharing) di L3 Cache CPU, mengubah allocator O(1) Anda menjadi O(N) dengan resiko latensi parah.
   **Solusi:** Batasi batas cross-thread freeing. Klon data di batas pool (mengubah pemilik memori segment) atau gunakan *bump arena* (seperti `Bumpalo`) untuk parse data, sehingga destuksi bulk terjadi seketika di thread pembuatnya.

2. **Memanfaatkan Terlalu Banyak Thread Transient (Sering Dibuat dan Dihancurkan)**
   **Mengapa berbahaya:** Ketika thread mati (destroyed), mimalloc harus "meninggalkan" (abandon) heap local milik thread tersebut, mereset statusnya, dan menempatkannya ke antrean global agar bisa direklamasi thread lain. Siklus spawn dan destroy thread berfrekuensi tinggi membanjiri OS dengan overhead manajerial arena memory. 
   **Solusi:** Selalu gunakan Thread Pool persisten (`tokio::spawn` pada multi-thread runtime atau `rayon`) agar cache memory dan segment Tcache tetap "hangat" seumur hidup layanan.

## Edge Cases dan Defensive Programming

1. **Memory Bloat akibat Delayed Free Queue:**
   Ketika "Cross-Thread Freeing Bomb" terjadi, Thread B menumpuk pointer di struktur *Delayed Free* (semacam kotak surat atomik) milik Thread A. Masalahnya: Thread A *harus mengalokasikan (malloc) atau membebaskan (free) memori baru* agar secara proaktif memeriksa dan mengosongkan antrean delayed free ini (garbage collection step). Jika Thread A idle (misal sedang blocked pada Socket Read), memori yang sudah di-free Thread B sebenarnya tertahan dan belum kembali ke OS. Ini menghasilkan semacam "Phantom Memory Leak" yang membesarkan RSS memory.

2. **Secure/Hardened Environments (Linux `mprotect`):**
   Mimalloc default agresif mendelegasikan dan menjaga blok memory secara lazily. Di beberapa system hardened (SELinux atau seccomp), panggilan `mmap` berulang atau manipulasi address space yang tidak lazim dapat disensor oleh kernel, menyebabkan abort `mmap-failed`. Parameter kompilasi fitur mimalloc yang statis (secure override) diperlukan di env ter-isolasi militer/keuangan tersebut.

3. **Injeksi LD_PRELOAD dengan Rust `global_allocator`:**
   Mencampur library kompilasi C++ yang menggunakan `.so` yang memaksa `mimalloc` (lewat flag LD_PRELOAD di docker) dengan kode Rust yang juga meng-link `mimalloc` sebagai `[global_allocator]` dapat merusak state registri POSIX thread-local storage (`TLS`). Salah satu (biasanya allocator Rust) akan crash dengan invalid pointer jika memori disilang pada FFI boundary.
