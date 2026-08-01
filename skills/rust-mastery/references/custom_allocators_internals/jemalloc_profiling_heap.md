# Jemalloc Profiling dan Heap Analysis

Dalam ekosistem Production skala besar (seperti Database Node atau Router HFT), *Memory Leak* (kebocoran memori lambat) sangat sulit dideteksi karena tidak langsung menyebabkan crash. Jemalloc memberikan kapabilitas **Active Heap Profiling** di runtime. 

Ini memungkinkan proses aplikasi Rust untuk membuang cuplikan alokasi (Heap Dump) pada disk berdasarkan interval atau intervensi sinyal (SIGUSR). File heap dump ini (file `.heap`) kemudian diurai menggunakan `jeprof` (mirip pprof) untuk memvisualisasikan hirarki pemanggilan fungsi (Flamegraph / Call Graph) mana yang bertanggung jawab mengkonsumsi memori tersebut.

## Pipeline Diagnostik Jemalloc Heap Dump

```ascii
[ Running Rust Service ]   ---(env MALLOC_CONF="prof:true,...")---> [ Jemalloc Core Engine ]
            |                                                               |
(Trigger via MALLCTL "prof.dump")                                           |
            v                                                               |
  [ Jemalloc ctl write ] <--------------------------------------------------+
            |
            v
 [ heap_profile.0.heap ] (File Dump Binary)
            |
            v
  $ jeprof --pdf binary heap_profile.0.heap > leak.pdf
            |
            v
 [ Flamegraph / Call Graph ] (Menunjukkan fungsi Rust penyebab leak)
```

## Produksi-Ready Code: Active Jemalloc Profiler API

Untuk kode ini, kita harus menyertakan dependency:
`tikv-jemallocator = "0.5"`
`tikv-jemalloc-ctl = "0.5"`

Dan environment harus dijalankan dengan: 
`MALLOC_CONF="prof:true,prof_active:true"`

```rust
use std::ffi::CString;

// Simulasi Crate jemallocator & jemalloc-ctl (mock untuk kemandirian kompilasi test)
// Dalam production, hapus module mock ini dan gunakan:
// use tikv_jemalloc_ctl::{prof, epoch};
pub mod mock_jemalloc_ctl {
    pub struct ProfDump;
    impl ProfDump {
        pub fn write(path: &[u8]) -> Result<(), String> {
            Ok(())
        }
    }
    
    pub struct Epoch;
    impl Epoch {
        pub fn advance() -> Result<(), String> { Ok(()) }
    }
}

use mock_jemalloc_ctl::{Epoch, ProfDump};

/// Memicu dumping profil heap memory dari Jemalloc ke file lokal.
/// Fungsi ini dirancang untuk dipanggil melalui sinyal intervensi
/// atau diagnostic HTTP endpoint (misal /debug/heapdump).
pub fn trigger_heap_dump(file_prefix: &str) -> Result<String, String> {
    // 1. Dapatkan epoch waktu UNIX untuk penamaan file yang unik
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
        
    let dump_filename = format!("{}_dump_{}.heap", file_prefix, timestamp);
    let c_filename = CString::new(dump_filename.clone())
        .map_err(|e| format!("CString error: {}", e))?;

    // 2. Advance Jemalloc internal Epoch
    // Ini menginstruksikan manajemen statis Jemalloc untuk mem-flush metrik
    // dan mensinkronisasikan keadaan agregasi dari thread-local cache.
    Epoch::advance().map_err(|e| format!("Failed to advance epoch: {:?}", e))?;

    // 3. Menulis struktur heap
    // Ini akan menulis sampel alokasi yang sedang hidup (active allocations)
    // yang belum dibebaskan ke file lokal.
    ProfDump::write(c_filename.as_bytes_with_nul())
        .map_err(|e| format!("Failed to write heap dump: {:?}", e))?;
        
    Ok(dump_filename)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_trigger_heap_dump() {
        // Melakukan trigger dummy test
        let result = trigger_heap_dump("prod_service");
        assert!(result.is_ok());
        let filename = result.unwrap();
        assert!(filename.starts_with("prod_service_dump_"));
        assert!(filename.ends_with(".heap"));
    }
}
```

## Anti-Patterns

1. **Membiarkan `prof:true` Terbuka di Hot Path Produksi Tanpa Sampling Khusus**
   **Mengapa berbahaya:** Jika flag `MALLOC_CONF="prof:true"` dibiarkan menyala, Jemalloc akan melakukan instrumentasi pemanggilan `malloc()` melalui stack trace unwind (biasanya libunwind) *setiap* kali memori dialokasikan. Hal ini menaikkan *latency* fungsi `malloc` hingga 5-10x lipat dan merusak performa throughput secara fatal.
   **Solusi:** Gunakan `prof_active:false` di awal, dan aktifkan melalui `MALLCTL` secara dinamis, serta batasi sampel dengan `lg_prof_sample` (misalnya 1 sampel tiap 512 KB alokasi).

2. **Meminta Profiling Tanpa Memperbarui Jemalloc Epoch**
   **Mengapa berbahaya:** Jemalloc menyembunyikan perhitungan statisnya di level cache *thread-local*. Jika Anda membaca metadata mallctl `stats.allocated` atau men-dump profiling tanpa memanggil `epoch.advance()`, Anda hanya membaca "cache data kuno" dari masa lalu. Heap dump tidak akan representatif dan menyesatkan penyelidikan memory leak.

## Edge Cases dan Defensive Programming

1. **Kegagalan Call Graph karena Missing DWARF / Frame Pointers:**
   Jika binary Rust dikompilasi pada mode `--release` murni (tanpa debug info / stripped) dan register kompilasi men-disable frame pointer (behavior standar di sistem x86 Linux), `jeprof` tidak dapat merangkai fungsi *stack-trace* dengan akurat saat `malloc` dipanggil. Leak akan terasosiasi dengan memori heksadesimal misterius (`0x00AFA..`). Di `Cargo.toml`, produksi profil-ready mutlak membutuhkan: `[profile.release] debug = 1` atau `force-frame-pointers = true`.

2. **No Space Left On Device Error:**
   Membuat dump file bisa sangat besar jika banyak sampel diambil atau callstack panjang. Pada container Kubernetes dengan rootfs transient yang terbatas (misal 50MB sisanya), pemanggilan `ProfDump::write` akan melempar System Error (ENOSPC), dan di beberapa implementasi ctl C FFI ini bisa menjadi fatal error di log C-stderr atau abort program jika unhandled. Path eksklusif dump seperti di mount `tmpfs` perlu disiapkan.

3. **Background Dump Konkurensi Kritis:**
   Menjalankan heap dump adalah operasi sinkronus berat (I/O syscall) yang menghambat thead pemanggil. Jika fungsi ini dieksekusi tepat dari dalam *Actor* atau thread pemroses asynchronous di tokio runtime (hot thread scheduler), thread tersebut akan terblokir selama detik-detik penting, memicu timeout rantai microservices. Pastikan memindahkannya ke `tokio::task::spawn_blocking`.
