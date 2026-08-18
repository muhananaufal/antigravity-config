# Distribusi Caching L2 dengan Redis/Valkey via fred.rs

## Pendahuluan

Caching L1 (Local/In-Memory) menangani latensi ultra-rendah untuk single-node, namun pada arsitektur sistem terdistribusi modern, kita membutuhkan Caching L2 (Distributed Cache) sebagai SSOT (Single Source of Truth) *intermediate* sebelum membentur database utama. L2 Cache menghindari situasi di mana puluhan *instance* microservice secara simultan memukul (query) backend secara duplikatif akibat *cache miss* independen di L1 masing-masing.

Redis dan suksesor open-source murninya, **Valkey**, menjadi standar industri de-facto untuk Caching L2 berkecepatan tinggi. Dalam ekosistem Rust asinkron, pustaka `fred.rs` jauh mengungguli alternatif konvensional (seperti `redis-rs`) dalam hal performa, skalabilitas (terutama untuk arsitektur *Cluster* dan *Sentinel*), serta efisiensi pipelining di bawah kerangka *runtime* Tokio.

## Arsitektur & Topologi Valkey/Redis Cluster

Diagram ASCII ini memperlihatkan interaksi antara kumpulan aplikasi Rust dan node Redis/Valkey yang didistribusikan dalam konfigurasi master-replica berskala besar.

```text
 +---------------------------------------------------------------------------------+
 |                           DISTRIBUTED MICROSERVICES                             |
 |                                                                                 |
 |  [ Rust App Node 1 ]      [ Rust App Node 2 ]        [ Rust App Node N ]        |
 |  (fred connection pool)   (fred connection pool)     (fred connection pool)     |
 +-----------+-------------------------+----------------------------+--------------+
             |                         |                            |
             +--------------------+    |   +------------------------+
                                  v    v   v
 +---------------------------------------------------------------------------------+
 |                            REDIS / VALKEY CLUSTER                               |
 |                                                                                 |
 |   [ Master Node A ] <------ (Gossip / Cluster Bus) ------> [ Master Node B ]    |
 |   (Hash Slots 0-5460)                                      (Hash Slots 5461-X)  |
 |          ^                                                        ^             |
 |          | Async replication                                      |             |
 |          v                                                        v             |
 |   [ Replica Node A1 ]                                      [ Replica Node B1 ]  |
 +---------------------------------------------------------------------------------+
```

## Implementasi Kode Produksi (Idiomatis)

Implementasi menggunakan `fred` ini mendemonstrasikan perutean data secara asinkron (Tokio), deserialisasi JSON (via `serde_json`), serta teknik *pipelining* untuk menghindari latensi koneksi berulang (round-trip time / RTT). Pustaka `fred` memiliki antarmuka khusus yang mendukung *Auto-Reconnect* and *Cluster topology discovery* secara mandiri.

```rust
use fred::prelude::*;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use thiserror::Error;

/// Error khusus untuk domain Caching L2
#[derive(Debug, Error)]
pub enum CacheError {
    #[error("Redis Operation Error: {0}")]
    Redis(#[from] RedisError),
    #[error("Serialization Error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("Cache Miss")]
    Miss,
}

/// Struktur data produk dalam katalog yang akan disimpan di L2.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CatalogProduct {
    pub id: uuid::Uuid,
    pub name: String,
    pub stock: u32,
    pub price: f64,
}

/// Manager untuk Caching L2 menggunakan Redis/Valkey.
pub struct DistributedCache {
    client: RedisClient,
}

impl DistributedCache {
    /// Inisialisasi pool koneksi ke Valkey/Redis (Cluster atau Standalone).
    pub async fn new(connection_url: &str) -> Result<Self, CacheError> {
        // Konfigurasi koneksi Redis menggunakan ClientConfig.
        // Konfigurasi ini mendeteksi topologi klaster secara otomatis jika digunakan
        // dengan antarmuka yang tepat, namun di sini kita gunakan antarmuka umum (from_url).
        let config = RedisConfig::from_url(connection_url)?;
        let policy = ReconnectPolicy::new_exponential(0, 100, 30_000, 2);
        
        let client = RedisClient::new(config, None, None, None);
        
        // Memulai background event-loop dari fred client.
        // Hal ini bersifat non-blocking dan krusial agar client dapat memproses multiplexing koneksi.
        let _ = client.connect();
        client.wait_for_connect().await?;

        Ok(Self { client })
    }

    /// Setel objek kompleks ke dalam Cache L2 dengan batasan kedaluwarsa waktu (Expiration TTL).
    pub async fn set_product(&self, product: &CatalogProduct, ttl_seconds: i64) -> Result<(), CacheError> {
        let key = format!("product:{}", product.id);
        // Melakukan Serialisasi objek berstruktur Rust menjadi JSON String
        let json_data = serde_json::to_string(product)?;
        
        // Menuliskan data ke Valkey/Redis bersamaan dengan instruksi Expiration (EX) 
        // secara atomik tanpa memisahkan perintah SET dan EXPIRE.
        let expiration = Expiration::EX(ttl_seconds);
        self.client
            .set::<(), _, _>(key, json_data, Some(expiration), None, false)
            .await?;
            
        Ok(())
    }

    /// Ambil dan deserialisasi objek dari Cache L2.
    pub async fn get_product(&self, product_id: &uuid::Uuid) -> Result<CatalogProduct, CacheError> {
        let key = format!("product:{}", product_id);
        
        // Melakukan kueri GET ke L2.
        let value: Option<String> = self.client.get(key).await?;
        
        match value {
            Some(json_data) => {
                let product: CatalogProduct = serde_json::from_str(&json_data)?;
                Ok(product)
            }
            None => Err(CacheError::Miss),
        }
    }
}
```

## Unit Test dan Integration Test

Pengujian ini memvalidasi penyimpanan, pengambilan, dan kondisi khusus seperti serialisasi dan kedaluwarsa. 
*(Catatan: Dalam lingkungan CI/CD sejati, pengujian akan menggunakan Testcontainers untuk memunculkan server Redis).*

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    // Membutuhkan node redis/valkey yang berjalan lokal di port 6379
    // `ignore` digunakan agar tidak merusak build pipeline yang tidak memiliki redis terinstal.
    #[tokio::test]
    #[ignore]
    async fn test_distributed_cache_flow() {
        let cache_url = "redis://127.0.0.1:6379/1";
        let cache = DistributedCache::new(cache_url).await.expect("Koneksi Redis Gagal");

        let product_id = Uuid::new_v4();
        let product = CatalogProduct {
            id: product_id,
            name: "SuperRust Compiler Book".to_string(),
            stock: 42,
            price: 15.99,
        };

        // Tes Penyimpanan (Write)
        let set_res = cache.set_product(&product, 60).await;
        assert!(set_res.is_ok(), "Gagal melakukan SET");

        // Tes Pengambilan (Read)
        let get_res = cache.get_product(&product_id).await.unwrap();
        assert_eq!(get_res, product, "Ketidakcocokan Data Serialisasi");

        // Tes Miss (Non-existent)
        let missing_id = Uuid::new_v4();
        let miss_res = cache.get_product(&missing_id).await;
        assert!(matches!(miss_res, Err(CacheError::Miss)));
    }
}
```

## Anti-Patterns Kritis

1. **Sinkronisasi RTT (Iterasi Sinkron / MGET bypass):**
   Mengeksekusi ribuan perintah `GET` dalam `for loop` sekadar menunggu hasil satu-per-satu (*sequential awaits*) tanpa menggunakan konstruksi *pipeline* multiplexing `fred` atau *batch commands* (mis. MGET). Praktik ini akan memicu latensi tinggi (N x RTT) secara masif.
2. **Pengabaian Koneksi Mati (Dead Conn Bypass):**
   Tidak menyertakan `ReconnectPolicy` atau mendesain mekanisme retry (*Circuit Breaker*). Jika node Redis mati/hancur sekejap, layanan Rust yang minim toleransi kegagalan (resilience) akan *panic* atau menyebarkan 500 HTTP Errors secara berantai ke *end-user*, alih-alih me-bypass sementara menuju *database* utama (*graceful degradation*).

## Production Edge Cases

1. **Massive Payload / Big Key Taint:**
   Melakukan *caching* terhadap respons agregat API raksasa (>5 MB per JSON, misalnya *list of users*) ke dalam satu key Redis (sebut saja "Big Key"). Pengambilan key ini memblokir event loop (baik di Redis maupun serde di Rust) dan melahap memori. Solusi: Gunakan *Pagination Caching* atau pisahkan metadata.
2. **Network Partitions (Split-Brain Valkey):**
   Pada pengaturan *Cluster* atau *Sentinel* multi-Zonasi, perpecahan koneksi (*Network Partition*) dapat memicu kueri Rust mengarah pada *Node Master* yang sudah berstatus kadaluwarsa (Stale Master). `fred` membutuhkan tuning timeout yang agresif untuk mendeteksi *dead sockets* agar dapat meresolusi topologi cluster terkini.
3. **Thundering Herd Akibat Expiration Bersamaan:**
   Banyak *keys* populer di-setel dengan waktu TTL yang sama persis saat startup layanan. Ribuan key akan kadaluwarsa tepat dalam milidetik yang sama, menendang gelombang beban yang masif ke Database backend (Cache Stampede). Solusi: Implementasikan "Jitter" atau pengacakan acak (Randomized TTL Offset: misal dasar 60 menit + (0..10) menit acak).
