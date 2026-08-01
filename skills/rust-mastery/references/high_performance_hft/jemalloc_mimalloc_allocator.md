# Jemalloc & Mimalloc Custom Allocators

Dalam aplikasi Rust berskala intensif (High-Frequency Trading, Web Servers berbeban tinggi), System Allocator bawaan (`glibc` `malloc`) sering mengalami kontensi lock global antar thread dan fragmentasi heap parah setelah uptime berbulan-bulan. 

Sebagai gantinya, Systems Engineer di Rust memanfaatkan arsitektur custom global allocator seperti **jemalloc** (diciptakan oleh Jason Evans, di-tuning untuk FreeBSD/Meta) atau **mimalloc** (dari Microsoft, berfokus pada thread-local free lists). Keduanya memitigasi latensi alokasi, menghapus kontensi lewat arena per-thread, dan meminimalkan TLB misses.

## Arsitektur Thread-Local Cache (Mimalloc/Jemalloc)

```ascii
[ Thread 1 ]                 [ Thread 2 ]
   | (malloc)                   | (malloc)
   v                            v
[ Thread Cache (Tcache) ]    [ Thread Cache (Tcache) ]
   | (empty/flush)              |
   v                            v
[ Local Arena/Magazine ]     [ Local Arena/Magazine ]
   |                            |
   +----------+      +----------+
              |      | (Global Lock Fallback - jarang terjadi)
              v      v
      [ Global Heap / OS mmap ]
```

## Produksi-Ready Code: Konfigurasi Jemallocator dan Mimalloc

Di Rust, mengatur global allocator sangat mudah lewat atribut `#[global_allocator]`. Kode berikut mensimulasikan deklarasi bersyarat agar kita bisa meng-compile dengan allocator yang berbeda berdasarkan feature flag, serta mengatur parameter konfigurasi jemalloc.

```rust
// File: src/allocator_setup.rs
// Feature flags di Cargo.toml:
// [features]
// use_jemalloc = ["tikv-jemallocator"]
// use_mimalloc = ["mimalloc"]

#[cfg(feature = "use_jemalloc")]
use tikv_jemallocator::Jemalloc;

#[cfg(feature = "use_mimalloc")]
use mimalloc::MiMalloc;

// 1. Global Allocator Override via Jemalloc
// Konfigurasi `Jemalloc` dapat di-tune lebih lanjut menggunakan variabel lingkungan
// `MALLOC_CONF`, misalnya: `MALLOC_CONF="background_thread:true,metadata_thp:auto,dirty_decay_ms:5000"`
#[cfg(feature = "use_jemalloc")]
#[global_allocator]
static GLOBAL: Jemalloc = Jemalloc;

// 2. Global Allocator Override via Mimalloc
// Mimalloc memiliki keamanan thread-local yang sangat agresif.
#[cfg(feature = "use_mimalloc")]
#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

// (Fallback ke System allocator jika tidak ada feature yang diaktifkan)

/// Simulasi eksekusi dengan alokasi frekuensi tinggi
pub fn allocate_heavy_load() -> usize {
    let mut sum = 0;
    
    // Alokasi banyak objek kecil (stress test the thread local cache)
    let mut allocations = Vec::with_capacity(1_000);
    for i in 0..10_000 {
        // Alokasi string (Boxed) dan memicu malloc()
        let val = format!("Data payload chunk {}", i);
        allocations.push(val);
        
        // Membersihkan agar memory tidak bocor, memicu free()
        if allocations.len() >= 1000 {
            for v in allocations.drain(..) {
                sum += v.len();
            }
        }
    }
    
    sum
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_heavy_allocation_throughput() {
        let result = allocate_heavy_load();
        assert!(result > 0, "Allocations failed to sum correctly");
    }
}
```

## Anti-Patterns

1. **Membiarkan Default `MALLOC_CONF` di Jemalloc (Tanpa Background Threads)**
   **Mengapa berbahaya:** Jemalloc akan menyimpan halaman memori kotor (dirty pages) terlalu lama sebelum memanggil OS `madvise` untuk merilisnya kembali (Purging). Di HFT atau server, jika purging terjadi mendadak di thread utama (saat *decay time* habis), thread tersebut akan hang selama milidetik.
   **Solusi:** Harus mengaktifkan `background_thread:true` agar purging memori diserahkan ke thread OS background khusus secara asinkron.

2. **Membuat Struktur Data Referensi Silang antar Thread di Mimalloc**
   **Mengapa berbahaya:** Kekuatan mimalloc ada pada arsitektur bebas kunci thread-local. Jika Thread A mengalokasikan string, lalu mengirimnya via channel ke Thread B, dan Thread B mem-free string tersebut, mimalloc harus menggunakan antrean atomik lambat (delayed frees) untuk mengembalikan memori itu ke pool Thread A. Jika frekuensinya tinggi, Anda merusak performa cache mimalloc.
   **Solusi:** Objek yang dikirim lintas-thread (cross-thread free) harus diminimalkan.

## Edge Cases dan Defensive Programming

1. **Huge Pages (THP) De-fragmentation Lockup:**
   Linux Transparent Huge Pages (THP) sering bertabrakan dengan memori allocator karena kernel akan secara sinkron meng-compact 4KB pages menjadi 2MB pages (page defrag). Hal ini bisa mengunci (freeze) thread HFT Anda saat melakukan `malloc`. Selalu nonaktifkan THP sistem `echo never > /sys/kernel/mm/transparent_hugepage/enabled` atau gunakan metadata_thp spesifik di jemalloc.

2. **Memory Leaks yang Tersembunyi karena TCache:**
   Jika sebuah thread mengalokasikan 100MB lalu melakukan de-alokasi, jemalloc/mimalloc tidak serta-merta mengembalikan memori tersebut ke OS (RSS sistem tidak turun). Memori ini ditahan di TCache (Thread Cache) untuk mempercepat malloc berikutnya. Jangan panik (mengira memory leak) saat melihat metrik RSS OS. Gunakan `mallctl` jemalloc untuk memeriksa fragmentasi *active* vs *allocated*.

3. **C-FFI Allocator Mismatch:**
   Jika program Rust di-link dengan library C (misalnya OpenSSL) dan library C tersebut memakai `malloc()` bawaan libc (Glibc), maka de-alokasi harus memakai `free()` Glibc. Jika Anda passing pointer Glibc dan Rust membebaskannya menggunakan memori de-allocator Jemalloc (karena `GLOBAL`), Anda akan memicu *Segmentation Fault* atau memori korupsi brutal.
