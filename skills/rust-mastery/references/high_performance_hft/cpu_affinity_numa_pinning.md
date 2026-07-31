# CPU Affinity & NUMA Pinning

## Konsep Utama dan Penggunaan
Scheduler Sistem Operasi (Linux/Windows) bebas memindahkan thread antar *core* kapan saja untuk mengelola beban. Namun, perpindahan core berarti *Cache Misses* (L1/L2 dari core lama tertinggal) yang merusak performa *nanosecond*. 

Thread Pinning (Affinity) memaksa satu thread aplikasi menetap di satu core spesifik selamanya. Pada server multi-socket, **NUMA (Non-Uniform Memory Access)** menjadi dominan; core pada Socket 0 akan sangat lambat mengakses RAM yang tersambung di Socket 1. Kita juga bisa memanfaatkan *HugePages* untuk menghindari saturasi *TLB (Translation Lookaside Buffer)* memori, esensial pada HFT di mana database in-memory berukuran gigabyte diakses terus-menerus.

## Arsitektur: NUMA Node dan Memory
```text
     [ Socket 0 / Node 0 ]            [ Socket 1 / Node 1 ]
     /    |      |      \             /    |      |      \
 [Core 0] ..  [Core 15]           [Core 16] .. [Core 31]
     \    |      |      /             \    |      |      /
  (Fast) [ RAM Bank 0 ] <======QPI======> [ RAM Bank 1 ] (Fast)
              |                                 |
              +--- Akses ini LAMBAT (Remote) ---+
```

## Kode Production-Ready: Core Pinning & Thread Isolation
```rust
use core_affinity::CoreId;
use std::thread;

/// Mengunci thread utama (atau worker thread) ke Core spesifik
/// Sangat disarankan untuk memisahkan thread I/O kernel dan thread aplikasi
/// HFT menggunakan `isolcpus` di boot parameter kernel.
pub fn pin_thread_to_core(core_id: usize) -> Result<(), &'static str> {
    // Ambil daftar topologi core yang tersedia di OS
    let core_ids = core_affinity::get_core_ids().ok_or("Failed to retrieve core topologies")?;
    
    // Cari core yang dimaksud
    let target_core = core_ids.into_iter().find(|c| c.id == core_id);

    if let Some(core) = target_core {
        // Panggil sistem (sched_setaffinity) untuk mengunci thread aktif saat ini
        if core_affinity::set_for_current(core) {
            println!("Successfully pinned thread to CPU Core {}", core_id);
            Ok(())
        } else {
            Err("Failed to set core affinity (Permissions issue?)")
        }
    } else {
        Err("Core ID not found in system")
    }
}

pub fn spawn_trading_engine_thread() {
    thread::spawn(|| {
        // Idealnya, core genap (mis. 2, 4) adalah physical cores,
        // sedangkan core ganjil (3, 5) adalah logical hyper-threads pasangannya.
        // HFT menghindari penggunaan core logical untuk kestabilan clock.
        pin_thread_to_core(2).unwrap();
        
        // Mulai infinite loop kritikal
        loop {
            // Poll for packets, process signal, send order
            std::hint::spin_loop();
            break; // Untuk mencegah infinite run saat tes
        }
    }).join().unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_core_pinning() {
        // Pin ke core 0 sering kali aman pada mayoritas OS.
        // Meski tidak menjamin keberhasilan (tergantung OS perms),
        // fungsi tidak panik
        let _ = pin_thread_to_core(0);
    }
}
```

## Anti-Patterns

1. **Pinning Thread ke Core yang Sama dengan Interrupt OS (NIC IRQ)**
   - *Bahaya*: Jika Anda mengunci thread trading ke Core 0, padahal Kernel Linux mendelegasikan tugas *Hardware Interrupt* (IRQ) dari kartu jaringan ke Core 0, thread Anda akan terus-menerus diinterupsi oleh kernel (preempted). Latensi akan sangat *jittery*.
   - *Solusi*: Konfigurasi OS via `isolcpus` atau `tuna` untuk mengisolasi core tertentu secara eksklusif bagi aplikasi. Arahkan IRQ NIC ke core lain (contoh: Core 1-2 untuk OS, Core 3-7 isolasi murni).

2. **Membuat Thread NUMA-Blind**
   - *Bahaya*: Mem-*pin* Thread di Core Socket 0, namun *memory buffer* diinisialisasi secara tidak sengaja oleh main thread yang berjalan di Core Socket 1. Setiap *load/store* data harus menyeberangi bus interkoneksi QPI lambat.
   - *Solusi*: Selalu inisialisasi / alokasi struktur data di dalam *closure thread yang sudah dipin*. Alokator lokal sistem operasi (First-Touch Policy) secara default meletakkan RAM secara fisik berdekatan dengan NUMA node tempat thread *pertama kali menulis ke memori tersebut*.

## Edge Cases & Defensive Engineering
- **Hyper-Threading (SMT)**: Di environment latensi rendah, Hyper-Threading biasanya dinonaktifkan di level BIOS. Dua logical thread yang berbagi satu physical core berebut sumber daya *L1 Cache* dan *Execution Units*. 
- **HugePages**: Untuk buffer raksasa, mengalokasikan banyak memori kecil menguras cache TLB (Translation Lookaside Buffer). Linux mendukung buffer halaman berukuran 2MB dan 1GB (HugePages). Di Rust, Anda harus menggunakan crate `mmap` dan passing opsi *MAP_HUGETLB* di backend C FFI untuk alokasi manual *ring buffer* bebas penalti TLB *misses*.
