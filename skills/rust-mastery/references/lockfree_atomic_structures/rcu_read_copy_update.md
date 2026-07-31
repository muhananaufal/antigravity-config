# RCU (Read-Copy-Update) & ArcSwap Pattern

## Konsep Utama
Read-Copy-Update (RCU) adalah teknik sinkronisasi legendaris yang berasal dari Linux Kernel, sangat cocok untuk struktur data yang *99.9% dibaca, dan hampir tidak pernah ditulis* (contoh: Routing Tables, Application Config, Load Balancer States). Dalam Rust, crate `arc-swap` mengimplementasikan pola RCU ini pada User-space. Asimetrinya esktrem: Reader berbiaya super rendah (mirip deref `Arc`, tanpa atomic mem-block loop besar). Writer memegang kelemahan terberat: ia mengkopi struktur data eksisting sepenuhnya (Copy), mengubahnya secara lokal, dan menukar (Update) pointernya dengan pointer global. Memori lama (Read) dipertahankan hingga semua reader "beristirahat" (Quiescent State / tidak ada lagi referensi Arc).

## Arsitektur & RCU Flow

```text
          ArcSwap (Global Reference)
                     |
  [ Reader 1 ]       |     [ Writer / Updater ]
   load()  |         v       1. load() -> Mendapat Arc<Config> (V1)
      \    +----> [ V 1 ]    2. Clone struktur V1 -> V2 (Copy)
       \          (Old Data) 3. Modifikasi V2 sesuai kebutuhan baru
       |                     4. store() -> Ganti pointer ArcSwap jadi V2 (Update)
  [ Reader 2 ]               5. Drop V1 -> Jika Reader 1 selesai membaca, 
                             V1 otomatis dide-alokasi (berkat Drop trait dari Arc).
       \         [ V 2 ]
        +------> (New Data)
```

## Production-Ready Code

```rust
use arc_swap::ArcSwap;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Konfigurasi global aplikasi
#[derive(Debug, PartialEq, Clone)]
pub struct AppConfig {
    pub maintenance_mode: bool,
    pub database_url: String,
    pub max_retries: u32,
}

pub struct ConfigManager {
    // ArcSwap mengoptimasi read path agar 10-20x lebih cepat dari RwLock::read()
    config: ArcSwap<AppConfig>,
}

impl ConfigManager {
    pub fn new(initial: AppConfig) -> Self {
        Self {
            config: ArcSwap::from_pointee(initial),
        }
    }

    /// Read sangat murah dan non-blocking. (O(1) wait-free)
    pub fn get_config(&self) -> Arc<AppConfig> {
        self.config.load().clone() // Clone untuk Arc sangat murah (Atomic increment)
    }

    /// RCU Write Path: Read-Copy-Update
    pub fn update_retries(&self, new_retries: u32) {
        // Crate arc_swap memiliki helper `rcu` yang melakukan
        // CAS (Compare-And-Swap) di level atas jika terjadi multi-writer race.
        self.config.rcu(|current_config| {
            // Copy (Clone keseluruhan data)
            let mut new_config = (**current_config).clone();
            // Update
            new_config.max_retries = new_retries;
            // Return struct baru, arc_swap akan menukarnya (Update atomik)
            new_config
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rcu_config_hot_reload() {
        let initial_cfg = AppConfig {
            maintenance_mode: false,
            database_url: "postgres://lo:5432".to_string(),
            max_retries: 3,
        };
        
        let manager = Arc::new(ConfigManager::new(initial_cfg));
        let reader_manager = manager.clone();

        // Background reader memverifikasi nilai lama terus menerus
        let reader = thread::spawn(move || {
            let cfg = reader_manager.get_config();
            assert_eq!(cfg.max_retries, 3);
            
            // Simulasi query database / proses panjang menggunakan `cfg` lama...
            thread::sleep(Duration::from_millis(50));
            // Selama Arc ini dipegang, memory `V1` tidak akan pernah didrop
            assert_eq!(cfg.max_retries, 3);
        });

        // Writer datang, melakukan hot-reload config (Update V2)
        thread::sleep(Duration::from_millis(10));
        manager.update_retries(10);
        
        // Writer mengecek konfigurasi baru
        assert_eq!(manager.get_config().max_retries, 10);

        reader.join().unwrap(); // Memory V1 dibebaskan saat reader usai.
    }
}
```

## Anti-Patterns

1. **Terlalu Sering Melakukan Update pada ArcSwap**
   - *Deskripsi*: Memakai `ArcSwap` untuk statistik counter/metric seperti menghitung total HTTP Request yang bertambah 5000 kali per detik.
   - *Mengapa Berbahaya*: Crate memicu siklus `clone` seluruh Memory Heap struct tersebut setiap kali dipanggil, ditambah sinkronisasi overhead CMS. Cache invalidation dan memory allocation churn (alloc/free) akan mencekik CPU Anda hingga drop performance. Gunakan `AtomicUsize` atau `Mutex` jika write-rate tinggi.

2. **Memegang Arc Hasil `.load()` Terlalu Lama secara Global**
   - *Deskripsi*: Worker thread me-load ArcSwap ke static variable statik Thread Local dan tak pernah men-dropnya, sebagai cache lokal abadi.
   - *Mengapa Berbahaya*: Arc Swap bergantung pada hukum referensi `Arc`. Jika ada 1 clone Arc lama yang tak pernah didrop di 1 thread, memori `V1` akan bocor/terkunci (tidak di-reclaim selamanya) walaupun `V2, V3, V100` sudah masuk.

## Edge Cases & Defensive Programming

- **Nested RCU Calls (Deadlock vs Livelock)**: Karena RCU pada `arc_swap::rcu` melandaskan diri pada back-off CAS retry (jika ada 2 writer balapan), meng-handle external call (seperti call database) di dalam lambda `.rcu(|curr| { ... })` akan fatal. Closure `rcu` harus secepat kilat murni *memory operations*. Jika ada operasi berat, letakkan sebelum rcu block.
- **Cache Line Bouncing**: Walau ArcSwap super cepat, `.load()` seringkali memodifikasi counter internal (untuk proteksi pointer sementara di beberapa fallback mode). Jika di-bombardir pada loop kosong, dapat terjadi inter-core thrashing. Selalu muat Arc config *sekali* di awal life-cycle Request, jangan memuat Arc di *dalam loop inner kalkulasi*.
