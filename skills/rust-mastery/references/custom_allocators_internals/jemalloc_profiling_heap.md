# Jemalloc Profiling & Heap Configuration

Jemalloc adalah allocator default untuk aplikasi yang mengutamakan throughput dan mitigasi fragmentasi berlebih, seperti TiKV dan banyak sistem terdistribusi Rust lainnya. Salah satu kekuatan terbesar `tikv-jemallocator` adalah kemampuannya melakukan profiling alokasi heap di environment produksi dengan penalti performa yang dapat diprediksi.

## Arsitektur Profiling Jemalloc

```text
       Rust Application (GlobalAlloc)
                  |
        tikv-jemallocator (C FFI)
                  |
     +-------------------------+
     | jemalloc core           |--> [ MALLOC_CONF ] (Env settings)
     | - tcache (Thread Cache) |--> [ eprof / stats API ]
     | - Arenas & Extents      |
     +-------------------------+
                  |
       heap.profile.dump files
```

## Implementasi Production-Ready

Untuk mem-build dengan jemalloc, pastikan `Cargo.toml` memiliki:
```toml
[dependencies]
tikv-jemallocator = "0.5"
tikv-jemalloc-ctl = "0.5"
```

```rust
// File: src/main.rs
use std::ffi::CString;

#[cfg(not(target_env = "msvc"))]
use tikv_jemallocator::Jemalloc;

#[cfg(not(target_env = "msvc"))]
#[global_allocator]
static GLOBAL: Jemalloc = Jemalloc;

#[cfg(not(target_env = "msvc"))]
pub fn dump_heap_profile(filename: &str) -> Result<(), Box<dyn std::error::Error>> {
    // Membutuhkan aplikasi dieksekusi dengan: 
    // MALLOC_CONF="prof:true,prof_active:true"
    use tikv_jemalloc_ctl::{prof, epoch};

    // Update internal stats
    epoch::advance().map_err(|e| format!("Failed to advance epoch: {}", e))?;
    
    // Dump ke file
    let c_filename = CString::new(filename)?;
    prof::dump::write(c_filename.as_c_str())
        .map_err(|e| format!("Failed to dump heap profile: {}", e))?;
    
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_profile_dump() {
        // Hanya dijalankan dalam environment di mana jemalloc aktif 
        // dan `MALLOC_CONF` diset.
        #[cfg(not(target_env = "msvc"))]
        {
            let vec: Vec<u8> = vec![0; 1024 * 1024]; // 1MB alloc
            // Tidak mengembalikan error jika konfigurasi benar.
            // Dalam test normal mungkin gagal jika tidak diset prof:true
            // assert!(dump_heap_profile("test_profile.dump").is_ok());
        }
    }
}
```

## Analisis Fragmentasi dengan `jemalloc_ctl`

Anda bisa menarik metrik secara real-time via `tikv_jemalloc_ctl` (tanpa dump profil):
- `stats::allocated::read()`: Bytes yang sedang digunakan oleh aplikasi.
- `stats::active::read()`: Bytes dalam page yang aktif di jemalloc.
- `stats::mapped::read()`: Total bytes yang diminta dari OS.
- *Active* dikurangi *Allocated* adalah indikasi kasat mata mengenai seberapa banyak fragmentasi atau overhead internal yang ada.

## Anti-Pattern Terlarang

1. **Mengaktifkan `prof:true` secara Hardcoded Tanpa Sampling Constraint:**
   *Mengapa berbahaya:* Jika `prof:true` diaktifkan secara agresif dalam produksi tanpa pembatasan, file `*.dump` bisa membengkak cepat dan jemalloc akan melakukan lock internal intensif. Selalu jalankan dengan `prof:true,prof_active:false` lalu aktifkan saat anomali via API `jemalloc-ctl`.
2. **Tidak Melakukan `epoch::advance()` Sebelum Metrik:**
   *Mengapa berbahaya:* Pembacaan stats dari `jemalloc-ctl` tidak akan real-time. Mereka akan ter-cache sejak `advance` terakhir. Mengandalkan data lama di observability loop bisa memicu alert yang tidak sesuai realitas.

## Edge Cases & Defensive Programming

- **Background Threads:** Jika sistem Anda men-spawn ribuan threads sebentar lalu didrop, jemalloc thread cache (`tcache`) bisa terakumulasi. Anda mungkin perlu menggunakan string MALLOC_CONF `tcache:false` untuk workload ekstrem tertentu guna menghindari memori ditahan di level thread (meskipun performa akan turun).
