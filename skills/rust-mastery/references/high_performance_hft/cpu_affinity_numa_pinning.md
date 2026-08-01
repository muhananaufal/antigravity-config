# CPU Affinity & NUMA Pinning

Dalam High-Frequency Trading (HFT) dan sistem deterministik low-latency, intervensi OS seperti context switching, thread migration antar core, dan page fault dapat menyebabkan jitter dalam skala mikrosekon. Mengatasi hal ini memerlukan strategi Thread Pinning (CPU Affinity) dan isolasi NUMA (Non-Uniform Memory Access) node.

Dengan memaku (pinning) sebuah thread ke core fisik tertentu (umumnya core terisolasi yang diatur via flag boot kernel `isolcpus`), kita memastikan memori tetap hangat di cache L1/L2 core tersebut. Selain itu, alokasi memori NUMA menjamin memori berada pada modul RAM fisik yang menempel langsung ke soket CPU tersebut (menghindari lintasan QPI/UPI yang lambat).

## Arsitektur NUMA & Cache Locality

```ascii
      [ NUMA Node 0 ]                     [ NUMA Node 1 ]
   +-------------------+               +-------------------+
   | Core0 Core1 Core2 | <--- UPI ---> | Core3 Core4 Core5 |
   |  [L1/L2 Cache]    |  (Inter-    |  [L1/L2 Cache]    |
   |        |          |   Connect)    |        |          |
   |  [  RAM Bank A ]  |               |  [  RAM Bank B ]  |
   +-------------------+               +-------------------+
           ^
    Pinned Thread (Fast memory access to Bank A)
```

## Produksi-Ready Code: Thread Pinning menggunakan `core_affinity`

Kode berikut mensimulasikan worker thread kritis HFT yang mengunci dirinya sendiri ke core tertentu, lalu melakukan inisialisasi lokal agar memori dialokasikan secara lokal pada NUMA node tersebut.

```rust
use std::thread;
use std::time::Duration;

/// Crate `core_affinity` adalah standar *de facto* untuk mengontrol afinitas di Rust.
/// Dalam production, pastikan dependency: core_affinity = "0.8"
/// Di sini kita menggunakan interface mock yang menyerupai crate aslinya 
/// agar standalone testable.

pub mod mock_core_affinity {
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct CoreId { pub id: usize }

    pub fn get_core_ids() -> Option<Vec<CoreId>> {
        Some(vec![CoreId { id: 0 }, CoreId { id: 1 }, CoreId { id: 2 }, CoreId { id: 3 }])
    }

    pub fn set_for_current(core_id: CoreId) -> bool {
        // Simulasi setting afinitas OS
        true
    }
}

pub struct CriticalWorker {
    core_id: usize,
    name: String,
}

impl CriticalWorker {
    pub fn new(core_id: usize, name: &str) -> Self {
        Self {
            core_id,
            name: name.to_string(),
        }
    }

    pub fn spawn(self) -> thread::JoinHandle<()> {
        thread::Builder::new()
            .name(self.name.clone())
            .spawn(move || {
                // 1. Dapatkan daftar Core logical OS
                let cores = mock_core_affinity::get_core_ids()
                    .expect("Failed to retrieve logical cores on this OS");
                
                // 2. Cari core target
                let target_core = cores.into_iter()
                    .find(|c| c.id == self.core_id)
                    .unwrap_or_else(|| panic!("Core ID {} not found!", self.core_id));
                
                // 3. Eksekusi syscall pinning
                let success = mock_core_affinity::set_for_current(target_core);
                assert!(success, "Failed to pin thread to core {}", self.core_id);
                
                // 4. Inisialisasi struktur memori besar SETELAH di-pin.
                // Hal ini menjamin bahwa OS kernel fault allocator menempatkan page
                // fisik di NUMA node yang tepat tempat core ini berlokasi.
                let mut data_buffer = vec![0u8; 1024 * 1024]; // 1MB buffer
                
                // "Sentuh" memori untuk memaksa OS melunasi page fault (demand paging)
                for byte in data_buffer.iter_mut() {
                    *byte = 0xAA;
                }
                
                // 5. Eksekusi hot loop (Simulasi)
                self.hot_loop(&mut data_buffer);
            })
            .expect("Failed to spawn thread")
    }
    
    #[inline(never)]
    fn hot_loop(&self, _buffer: &mut [u8]) {
        // Logika high frequency trading...
        // Dalam dunia nyata ini berupa infinite loop menerima dari ring buffer.
        for _i in 0..100 {
            std::hint::black_box(1 + 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_worker_pinning() {
        let worker = CriticalWorker::new(1, "engine-thread-1");
        let handle = worker.spawn();
        let result = handle.join();
        assert!(result.is_ok(), "Thread panicked during execution");
    }
}
```

## Anti-Patterns

1. **Alokasi Memori Dulu, Pinning Kemudian**
   **Mengapa berbahaya:** Jika alokasi thread (misal arena besar atau pre-allocated buffers) dilakukan *sebelum* thread di-pin ke core spesifiknya, OS mengalokasikan page memori fisik di NUMA node dari thread parent. Saat child thread dipin ke NUMA node berbeda, semua akses memori memicu *remote NUMA access* lewat inter-connect, menghancurkan latency (peningkatan akses >40% lebih lambat).
   ```rust
   // ANTI-PATTERN
   let data = vec![0u8; 1_000_000]; // Dialokasikan di NUMA Parent
   thread::spawn(move || {
       pin_to_core(5); // Pindah ke NUMA lain
       process(data);  // Cross-NUMA node penalty!
   });
   ```

2. **Mem-pin Thread ke Core yang Meng-handle IRQ (Interrupts)**
   **Mengapa berbahaya:** OS memetakan Network Card (NIC) Hardware Interrupts ke CPU core tertentu. Jika worker thread di-pin ke core yang sama dengan penerima IRQ NIC, thread Anda akan sering di-preempt (interupsi hard) puluhan ribu kali per detik oleh kernel OS, menciptakan jitter nanosekon. Kernel isolcpus boot args mutlak dibutuhkan.

## Edge Cases dan Defensive Programming

1. **Hyperthreading (SMT) Interference:**
   Mem-pin thread ke core fisik 0, sementara core logical saudaranya (hyperthread, misal core 12 di sistem 12-core) masih dieksekusi proses sistem, akan memicu pembagian (sharing) L1 dan L2 cache secara hardware. Solusi HFT produksi adalah men-disable SMT di BIOS atau tidak memakai thread sibling.

2. **Gagal Pinning di Container (Docker/K8s):**
   Jika service dijalankan di cgroups dengan cpuset yang dibatasi (docker `--cpuset-cpus`), melakukan `set_for_current` pada core di luar cpuset mask akan mengembalikan `false` atau error EPERM. Selalu asumsikan fail dan abort segera di sistem HFT daripada terdegradasi secara sembunyi-sembunyi.

3. **Demand Paging Keterlambatan:**
   Meski thread dipin dan vektor dialokasikan, OS Linux default menganut *lazy allocation*. Akses pertama ke halaman memori akan memicu minor page fault. `mlockall(MCL_CURRENT | MCL_FUTURE)` dan *pre-faulting* iterasi memori (menyentuh tiap halaman) seperti yang dicontohkan mutlak diperlukan sebelum sesi trading aktif.
