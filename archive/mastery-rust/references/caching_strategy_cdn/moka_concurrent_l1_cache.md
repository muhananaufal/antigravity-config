# Caching L1 Konkuren dengan Moka di Rust

## Pendahuluan

Dalam arsitektur *high-performance* di Rust, L1 Cache bertindak sebagai garis pertahanan pertama (first line of defense) untuk mereduksi latensi dan beban CPU serta I/O. `moka` adalah pustaka cache *in-memory* mutakhir di ekosistem Rust yang terinspirasi oleh Caffeine (di Java). Moka memanfaatkan algoritma *eviction* W-TinyLFU (Window Tiny Least Frequently Used) yang sangat efisien dalam menjaga rasio *hit* yang tinggi, seraya memberikan throughput konkurensi maksimum tanpa masalah *lock contention* yang berarti.

Berbeda dengan sekadar menggunakan `std::collections::HashMap` yang dibungkus `Arc<RwLock<T>>` atau `tokio::sync::RwLock`, Moka menghindari kelemahan fatal berupa *global lock bottleneck* dan mengadopsi mekanisme *lock-free* *striped access* serta struktur *ring buffer* untuk pelacakan statistik secara asinkron.

## Arsitektur & Topologi L1 Cache (W-TinyLFU)

Diagram ASCII di bawah ini menggambarkan arsitektur internal Moka yang mengisolasi *thread* pembaca dari overhead pelacakan dan memberikan performa skalabilitas linier seiring bertambahnya core CPU.

```text
 +-----------------------------------------------------------------------------+
 |                              MOKA CACHE (L1)                                |
 |                                                                             |
 | +-------------------+    Asynchronous Log    +----------------------------+ |
 | | Read / Write      |=======================>| Policy Engine (W-TinyLFU)  | |
 | | Operations        |  (Ring Buffer / Queues)| - Window Cache (LRU)       | |
 | +-------------------+                        | - Main Cache (SLRU)        | |
 |          |                                   |   - Probationary Segment   | |
 |          |                                   |   - Protected Segment      | |
 |          v                                   +----------------------------+ |
 | +-------------------+                               |                       |
 | | Concurrent Hash   |<--- Eviction Commands --------+                       |
 | | Table (DashMap-   |                                                       |
 | | like striped map) |                                                       |
 | +-------------------+                                                       |
 +-----------------------------------------------------------------------------+
                            |     |     |
            +---------------+     |     +---------------+
            |                     |                     |
      [ CPU Core 1 ]        [ CPU Core 2 ]        [ CPU Core 3 ]
```

## Implementasi Kode Produksi (Idiomatis)

Kode di bawah ini menunjukkan cara mengintegrasikan Moka ke dalam layanan Rust asinkron (Tokio), mengatur kebijakan penggusuran (*eviction policies*), menangani entri kedaluwarsa secara otomatis (TTL/TTI), dan memastikan tidak ada blocking di *event loop*.

```rust
use moka::future::Cache;
use std::time::Duration;
use std::sync::Arc;
use tokio::time::sleep;

/// Merepresentasikan struktur data profil pengguna yang kompleks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserProfile {
    pub id: String,
    pub username: String,
    pub reputation: u64,
    pub permissions: Vec<String>,
}

/// Service untuk menangani caching L1 dari profil pengguna.
pub struct UserProfileService {
    // Moka Cache asinkron dengan konfigurasi Time-to-Live (TTL)
    // String sebagai key, dan UserProfile sebagai value.
    l1_cache: Cache<String, Arc<UserProfile>>,
}

impl UserProfileService {
    /// Konstruktor untuk service profil pengguna.
    /// Konfigurasi cache mendefinisikan batasan kapasitas dan waktu.
    pub fn new(max_capacity: u64, ttl_seconds: u64, tti_seconds: u64) -> Self {
        let cache = Cache::builder()
            // Kapasitas maksimal berdasarkan jumlah item
            .max_capacity(max_capacity)
            // Time to Live: waktu absolut entri hidup sejak dibuat/diperbarui
            .time_to_live(Duration::from_secs(ttl_seconds))
            // Time to Idle: waktu entri hidup sejak akses terakhir
            .time_to_idle(Duration::from_secs(tti_seconds))
            // Konfigurasi eviction listener asinkron (opsional untuk logging)
            .eviction_listener(|key, _value, cause| {
                println!("Evicted key {:?} karena {:?}", key, cause);
            })
            .build();

        Self { l1_cache: cache }
    }

    /// Mengambil profil dari cache. Jika tidak ada (miss), maka memanggil
    /// fungsi backend `fetch_from_database` lalu memasukkannya ke cache.
    pub async fn get_user_profile(&self, user_id: &str) -> Result<Arc<UserProfile>, String> {
        // `try_get_with` menangani cache miss dan cache stampede (singleflight built-in).
        // Jika ada banyak request dengan ID yang sama saat cache miss,
        // hanya SATU request yang akan mengeksekusi blok closure di bawah ini.
        let result = self
            .l1_cache
            .try_get_with(user_id.to_string(), async {
                self.fetch_from_database(user_id).await
            })
            .await;

        result.map_err(|e| format!("Gagal mengambil profil: {}", e))
    }

    /// Fungsi simulasi yang merepresentasikan panggilan I/O ke database atau layanan L2.
    /// Di production, ini mungkin sebuah koneksi HTTP atau query database (SQLx/SeaORM).
    async fn fetch_from_database(&self, user_id: &str) -> Result<Arc<UserProfile>, String> {
        // Simulasi latensi database I/O
        sleep(Duration::from_millis(50)).await;
        
        if user_id.is_empty() {
            return Err("User ID tidak valid".to_string());
        }

        let profile = UserProfile {
            id: user_id.to_string(),
            username: format!("user_{}", user_id),
            reputation: 100,
            permissions: vec!["read".to_string(), "write".to_string()],
        };

        println!("Database fetch dijalankan untuk ID: {}", user_id);
        Ok(Arc::new(profile))
    }
    
    /// Fungsi untuk invalidasi paksa dari luar (misal: webhook atau event)
    pub async fn invalidate(&self, user_id: &str) {
        self.l1_cache.invalidate(user_id).await;
    }
}
```

## Unit Test dan Integration Test

Pengujian berikut memvalidasi fungsionalitas caching dasar dan fitur perlindungan stampede yang merupakan keunggulan Moka asinkron.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::task;

    #[tokio::test]
    async fn test_cache_hit_and_miss() {
        let service = UserProfileService::new(100, 60, 60);
        let id = "test_123";

        // Iterasi pertama: Cache Miss -> harus ke DB
        let profile1 = service.get_user_profile(id).await.unwrap();
        assert_eq!(profile1.username, "user_test_123");

        // Iterasi kedua: Cache Hit -> instan dari memori
        let profile2 = service.get_user_profile(id).await.unwrap();
        // Memastikan pointer Arc yang direferensikan adalah identik
        assert!(Arc::ptr_eq(&profile1, &profile2));
    }
    
    #[tokio::test]
    async fn test_cache_invalidation() {
        let service = UserProfileService::new(10, 60, 60);
        let id = "user_invalidate";
        
        // Populasi awal
        let p1 = service.get_user_profile(id).await.unwrap();
        
        // Invalidasi paksa
        service.invalidate(id).await;
        
        // Populasi ulang (akan menciptakan instance Arc baru)
        let p2 = service.get_user_profile(id).await.unwrap();
        assert!(!Arc::ptr_eq(&p1, &p2));
    }
}
```

## Anti-Patterns Kritis

1. **Blocking Call dalam Asynchronous Context:**
   Menggunakan `moka::sync::Cache` di dalam `async fn` atau runtime Tokio akan memicu thread-blocking saat eviction terjadi, menurunkan kapabilitas runtime asinkron secara drastis. Selalu gunakan `moka::future::Cache` jika *caller* berada di lingkungan `async/await`.
2. **Ketiadaan Batasan (Unbounded Size / No TTL):**
   Membuat konfigurasi Cache tanpa `max_capacity` dan tanpa TTL dalam arsitektur berskala besar adalah jaminan Out-Of-Memory (OOM) fatal. Sistem caching L1 harus secara eksplisit mendefinisikan batas `max_capacity` dan kebijakan penggusuran.

## Production Edge Cases

1. **Cache Poisoning Akibat Negatif/Error State:**
   Apabila koneksi database L3/L2 putus (menghasilkan *timeout error*), dan kita secara tidak sengaja meletakkan `Result::Err` ke dalam struktur yang di-cache, seluruh request klien selanjutnya ke entri tersebut juga akan menerima "Error" hingga TTL habis. Solusinya: Pastikan Moka **hanya** menyimpan *cache* untuk sukses `Ok(T)`, hal mana otomatis ditangani oleh metode `try_get_with` Moka.
2. **Throttling CPU saat Mass Invalidation:**
   Jika ratusan ribu entri diinvalidasi secara bersamaan (melalui iterasi `invalidate_all()` berskala masif), Moka mungkin memerlukan *CPU cycle* signifikan untuk melakukan pembersihan *concurrent hashmap*. Solusinya: Hapus cache secara selektif atau operasikan skema *multi-tier caching* dengan *version keys*.
3. **Ghost Entries (Time-to-Idle Sinkhole):**
   Konfigurasi TTL yang terlalu panjang tetapi *Time-to-Idle* terlalu singkat dapat mengakibatkan hilangnya entri cache di tengah perputaran *request* rendah (misalnya traffic off-peak), sehingga menyebabkan cache miss yang tidak perlu saat lonjakan traffic tiba. Gunakan analitik akses yang tepat untuk menyeimbangkan TTL/TTI (misal: TTL=1jam, TTI=30menit).
