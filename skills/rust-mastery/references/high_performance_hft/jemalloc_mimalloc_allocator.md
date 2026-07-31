# Jemalloc & Mimalloc Custom Allocators

## Konsep Utama dan Penggunaan
Allocator *default* (malloc dari libc) tidak didesain khusus untuk konkurensi ekstrem, performa multi-threading tinggi, atau fragmentasi memori yang ketat di bawah tekanan. Pada sistem HFT atau database besar (seperti TiKV), allocator default akan mengalami *lock contention* dan fragmentasi kronis.

*jemalloc* dan *mimalloc* (buatan Microsoft) menyelesaikan ini melalui **Per-Thread Caches** (sehingga alokasi sering kali *lock-free*) dan manajemen segmen memori (Arenas/NUMA nodes) yang cerdas. Dalam Rust, kita bisa mengganti global allocator cukup dengan beberapa baris kode untuk mendapatkan peningkatkan performa *throughput* hingga 20-30% pada beban berat.

## Arsitektur: Per-Thread Arena Allocation
```text
[ Thread 1 ]         [ Thread 2 ]         [ Thread 3 ]
     |                    |                    |
[ T-Cache 1]         [ T-Cache 2]         [ T-Cache 3]  <- Lock-free allocation
     |                    |                    |
======================================================
     [ Global Arena 1 (NUMA 0) ]  [ Global Arena 2 (NUMA 1) ] <- Fallback/Slab
```

## Kode Production-Ready: Mimalloc Setup
```rust
// Secara umum diletakkan di src/main.rs atau src/lib.rs

#[cfg(not(target_env = "msvc"))]
use tikv_jemallocator::Jemalloc;

// Contoh menggunakan mimalloc:
use mimalloc::MiMalloc;

// Set MiMalloc sebagai allocator global. 
// Atribut ini memberi tahu Rust untuk merutekan seluruh heap allocations (Box, Vec, String)
// melalui Mimalloc, menghindari libc malloc sama sekali.
#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

/// Struktur yang mensimulasikan HFT order book allocation-heavy workload.
pub struct OrderBook {
    orders: Vec<Box<Order>>,
}

pub struct Order {
    pub id: u64,
    pub price: f64,
    pub volume: f64,
}

impl OrderBook {
    pub fn new() -> Self {
        // Melakukan pre-alokasi besar. Mimalloc akan menangani memori
        // dalam blok/arena besar dengan efisien.
        Self {
            orders: Vec::with_capacity(1_000_000),
        }
    }

    pub fn insert_order(&mut self, order: Order) {
        // Pembuatan Box memanggil allocator global.
        // Berkat per-thread cache pada MiMalloc, operasi ini O(1) dan lock-free
        // dalam mayoritas skenario.
        self.orders.push(Box::new(order));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_orderbook_allocation() {
        let mut book = OrderBook::new();
        for i in 0..10_000 {
            book.insert_order(Order {
                id: i,
                price: 100.0,
                volume: 5.0,
            });
        }
        assert_eq!(book.orders.len(), 10_000);
    }
}
```

## Anti-Patterns

1. **Allocating di Hot Path HFT**
   - *Bahaya*: Mengandalkan Jemalloc/Mimalloc dan merasa aman mengalokasikan data dalam *critical loop* microsecond latency HFT. Sekalipun cepat, alokasi heap tetap memerlukan interaksi *syscall* (seperti `mmap` atau `sbrk`) ketika T-Cache habis.
   - *Solusi*: Dalam jalur latensi kritis, prasyarat utama adalah **Zero Allocation**. Gunakan *Object Pools* atau *Ring Buffers* yang telah dialokasikan (pre-allocated) pada saat *startup*. Allocator bagus hanya membantu saat startup atau *cold paths*.

2. **Drop (Deallocation) di Thread yang Berbeda**
   - *Bahaya*: Mengalokasikan sebuah objek di Thread A, lalu mengirimkan *ownership* ke Thread B via channel, di mana objek tersebut di-*drop*. Ini memaksa thread lokal cache untuk mensinkronisasi pengembalian memori ke arena thread asal (cross-thread deallocation), menimbulkan latensi.
   - *Solusi*: Batasi *cross-thread deallocation*. Jika mengirim data antar-thread, usahakan mengembalikan objek tersebut ke *pool* di thread asalnya, atau gunakan arsitektur *message passing* tanpa transfer *heap ownership*.

## Edge Cases & Defensive Engineering
- **NUMA Awareness**: Pada server HFT dual-socket CPU, mengalokasikan memori pada node NUMA yang salah akan memperlambat akses memori. Jemalloc mendukung alokasi sadar NUMA.
- **Profiling**: Memori bocor atau fragmentasi dalam Rust (terutama Arc cycles) sulit dilacak. Jemalloc terintegrasi sangat baik dengan fitur *heap profiling* bawaannya (`MALLOC_CONF="prof:true"`). Pastikan untuk mengonfigurasi ini dalam lingkungan QA.
- **Linux OOM Killer**: Kinerja alokator bisa merangsang kernel Linux *overcommit*. Selalu pastikan server Linux telah dituning (`vm.overcommit_memory = 2`) agar sistem menolak alokasi alih-alih me-reboot aplikasi melalui OOM Killer.
