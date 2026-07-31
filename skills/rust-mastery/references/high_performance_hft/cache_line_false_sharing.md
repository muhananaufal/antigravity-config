# Cache Line dan False Sharing

## Konsep Utama dan Penggunaan
Dalam arsitektur CPU modern, memori tidak diambil byte-per-byte, melainkan dalam bentuk *cache line* (biasanya 64 bytes). **False sharing** terjadi ketika dua *thread* pada *core* CPU yang berbeda sering memodifikasi variabel independen, tetapi variabel-variabel tersebut kebetulan berada dalam satu cache line yang sama. 

Akibat dari protokol koherensi cache (misal: MESI), jika satu core memodifikasi datanya, cache line di-invalidasi di semua core lain, memaksa mereka mengambil ulang data dari L3/RAM. Dalam HFT, ini adalah *latency killer*. Kita menggunakan `crossbeam_utils::CachePadded<T>` atau `#[repr(align(64))]` untuk memisahkan memori secara fisik.

## Arsitektur: Protokol MESI & Cache Line
```text
[ Core 1 ]               [ Core 2 ]
    |                        |
[ L1 Cache ]             [ L1 Cache ]
[ X | Y ] <~ cache line  [ X | Y ]
    |                        |
-----------------------------------
            [ L3 Cache ]

Jika Core 1 mengubah 'X', maka seluruh cache line [X|Y] 
pada L1 Core 2 di-invalidasi. Jika Core 2 ingin membaca 'Y', 
terjadi "cache miss" meskipun 'Y' tidak berubah! (False Sharing)
```

## Kode Production-Ready: Counter Bebas False Sharing
```rust
use crossbeam_utils::CachePadded;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;

/// Menggunakan `CachePadded` untuk memastikan setiap `AtomicU64` berada 
/// di cache line terpisah (align ke 64 bytes atau lebih tinggi).
pub struct PerformanceCounters {
    // Thread 1 sering memodifikasi trades_executed
    pub trades_executed: CachePadded<AtomicU64>,
    // Thread 2 sering memodifikasi messages_parsed
    pub messages_parsed: CachePadded<AtomicU64>,
}

impl PerformanceCounters {
    pub fn new() -> Self {
        Self {
            trades_executed: CachePadded::new(AtomicU64::new(0)),
            messages_parsed: CachePadded::new(AtomicU64::new(0)),
        }
    }
}

impl Default for PerformanceCounters {
    fn default() -> Self {
        Self::new()
    }
}

pub fn simulate_work(counters: &'static PerformanceCounters) {
    let t1 = thread::spawn(move || {
        for _ in 0..1_000_000 {
            counters.trades_executed.fetch_add(1, Ordering::Relaxed);
        }
    });

    let t2 = thread::spawn(move || {
        for _ in 0..1_000_000 {
            counters.messages_parsed.fetch_add(1, Ordering::Relaxed);
        }
    });

    t1.join().unwrap();
    t2.join().unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_padded_counters() {
        // Dibuat static agar memiliki lifetime yang aman untuk simulasi test sederhana
        lazy_static::lazy_static! {
            static ref COUNTERS: PerformanceCounters = PerformanceCounters::new();
        }
        
        simulate_work(&COUNTERS);
        assert_eq!(COUNTERS.trades_executed.load(Ordering::Relaxed), 1_000_000);
        assert_eq!(COUNTERS.messages_parsed.load(Ordering::Relaxed), 1_000_000);
    }
}
```

## Anti-Patterns

1. **Membuat Struct Atomics Tanpa Padding (False Sharing Default)**
   - *Bahaya*: Deklarasi `struct Counters { a: AtomicU64, b: AtomicU64 }` akan membuat `a` dan `b` bersebelahan dalam memori (jarak 8 bytes). Mutasi konstan dari multi-core akan men-trigger *cache bouncing* terus menerus.
   - *Solusi*: Selalu bungkus atomics independen yang diakses thread berbeda dengan `CachePadded` atau sejajarkan `#[repr(align(64))]`.

2. **Padding Berlebihan (Cache Polution)**
   - *Bahaya*: Menggunakan `CachePadded` di semua tempat secara membabi buta membengkakkan ukuran memori dan merusak *data locality*, menghancurkan keuntungan pre-fetcher L1/L2.
   - *Solusi*: Hanya lakukan padding pada variabel yang **sering di-mutasi secara konkuren** oleh thread berbeda. Variabel yang *read-only* justru harus dikemas (packed) serapat mungkin.

## Edge Cases & Defensive Engineering
- **Deteksi dengan `perf`**: Gunakan `perf stat -e cache-misses,cache-references` atau `perf c2c` di Linux untuk membuktikan adanya false sharing. Jika tidak diukur, padding sering kali menjadi optimasi prematur yang sia-sia.
- **Arsitektur Cache Non-Standar**: Mayoritas x86 dan ARM memiliki cache line 64-byte. Beberapa CPU eksotis atau Apple Silicon generasi tertentu bisa memiliki 128-byte cache line. `crossbeam_utils::CachePadded` didesain secara portabel, namun pada lingkungan super-terspesialisasi HFT, Anda mungkin perlu menulis padding manual berbasis target.
