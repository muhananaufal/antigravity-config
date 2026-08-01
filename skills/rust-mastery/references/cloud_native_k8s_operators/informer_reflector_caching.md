# Panduan Arsitektur: Informers dan Reflectors di `kube-rs`

## 1. Pengantar dan Filosofi Desain

Dalam ekosistem Kubernetes, membangun custom operator atau controller yang tangguh membutuhkan akses ke state dari cluster tanpa secara konstan membanjiri Kubernetes API server dengan HTTP GET requests (polling). Pola *Client-go style* menggunakan **Informer** dan **Reflector** telah diadopsi secara luas di berbagai ekosistem, termasuk dalam crate `kube-rs` di Rust. 

Pola ini memungkinkan aplikasi lokal untuk menjaga cache yang konsisten dengan state API server melalui mekanisme *watch* (server-sent events). Reflector bertanggung jawab mendengarkan perubahan dari API, lalu menuliskannya ke cache lokal (Store). Informer bertindak sebagai jembatan yang memberitahu event handlers kita ketika ada perubahan state.

### Diagram Arsitektur: Aliran Data Informer & Reflector

```text
+-------------------+       HTTP WATCH        +-----------------------+
| Kubernetes API    | <---------------------- | Reflector (kube-rs)   |
| Server (etcd)     | ----------------------> | (List & Watch)        |
+-------------------+   Event (Add/Mod/Del)   +-----------------------+
                                                         |
                                                         v
+-------------------+                         +-----------------------+
| Controller logic /| <---------------------- | Local Cache (Store)   |
| Event Handlers    |      Notification       | (Thread-safe HashMap) |
+-------------------+                         +-----------------------+
```

## 2. Implementasi Produksi (Production-Ready)

Di bawah ini adalah implementasi lengkap, tanpa *placeholder*, menggunakan `kube-rs` versi modern (menggunakan `kube::runtime::watcher` dan `kube::runtime::reflector`).

```rust
use futures::{StreamExt, TryStreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::{
    api::{Api, ListParams},
    runtime::{reflector, watcher, WatchStreamExt},
    Client,
};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Representasi struktur internal yang membungkus cache (Store) 
/// sehingga dapat diakses dengan aman secara konkuren.
#[derive(Clone)]
pub struct PodCacheManager {
    store: reflector::Store<Pod>,
}

impl PodCacheManager {
    /// Membuat instance baru dari PodCacheManager yang mengelola state.
    pub fn new(store: reflector::Store<Pod>) -> Self {
        Self { store }
    }

    /// Mengambil data pod secara spesifik dari cache lokal O(1),
    /// TANPA memanggil jaringan (API server).
    pub fn get_pod_from_cache(&self, name: &str) -> Option<Pod> {
        self.store.get(&kube::runtime::reflector::ObjectRef::new(name))
            .map(|arc_pod| (*arc_pod).clone())
    }
    
    /// Mengambil semua pod yang saat ini ada di cache lokal.
    pub fn list_all_cached_pods(&self) -> Vec<Pod> {
        self.store.state().iter().map(|arc_pod| (*arc_pod).clone()).collect()
    }
}

/// Menjalankan sistem Reflector dan Informer untuk Pod di namespace spesifik.
pub async fn run_pod_reflector(
    client: Client,
    namespace: &str,
    cache_manager_hook: Arc<RwLock<Option<PodCacheManager>>>,
) -> Result<(), kube::Error> {
    let pods: Api<Pod> = Api::namespaced(client, namespace);
    let lp = ListParams::default();

    // Membangun watcher dan reflector (store cache)
    let (store, writer) = reflector::store();
    
    // Inisialisasi struct manager yang menyimpan referensi store
    let cache_manager = PodCacheManager::new(store);
    
    // Memberikan akses ke manager ini ke thread/sistem lain
    {
        let mut hook = cache_manager_hook.write().await;
        *hook = Some(cache_manager.clone());
    }

    // Eksekusi pipeline watcher stream dan reflector
    // watcher akan melakukan list lalu watch
    // reflector::reflector akan mengisi store dengan event-event tersebut.
    let stream = reflector(writer, watcher(pods, lp))
        .applied_objects() // hanya mempedulikan status terapan akhir
        .try_for_each(|pod| async move {
            let pod_name = pod.metadata.name.unwrap_or_else(|| "unknown".to_string());
            tracing::info!("Cache sinkronisasi berhasil untuk Pod: {}", pod_name);
            Ok(())
        });

    // Jalankan stream hingga terputus atau terjadi error fatal.
    // Dalam produksi nyata, biasanya dibungkus di dalam loop retry.
    if let Err(e) = stream.await {
        tracing::error!("Watcher/Reflector berhenti dengan error: {:?}", e);
        return Err(e);
    }

    Ok(())
}
```

## 3. Unit Test dan Integration Test

Berikut adalah implementasi testing yang mensimulasikan prilaku *reflector* dan *store* secara lokal dengan memanfaatkan tipe generik dan trait mock jika perlu. Di `kube-rs` kita bisa langsung menggunakan store reflector.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::Pod;
    use kube::core::ObjectMeta;
    use kube::runtime::reflector;

    #[test]
    fn test_pod_cache_manager_operations() {
        // Setup store lokal dan writer tanpa network call
        let (store, mut writer) = reflector::store();
        
        let pod = Pod {
            metadata: ObjectMeta {
                name: Some("test-pod-1".to_string()),
                namespace: Some("default".to_string()),
                ..Default::default()
            },
            ..Default::default()
        };

        // Simulasi Reflector menulis state awal ke cache
        writer.apply_watcher_event(&kube::runtime::watcher::Event::Applied(pod.clone()));

        let manager = PodCacheManager::new(store);

        // Uji cache hit
        let cached_pod = manager.get_pod_from_cache("test-pod-1");
        assert!(cached_pod.is_some());
        assert_eq!(cached_pod.unwrap().metadata.name.unwrap(), "test-pod-1");

        // Uji cache miss
        let missing_pod = manager.get_pod_from_cache("non-existent-pod");
        assert!(missing_pod.is_none());
        
        // Uji list cache
        let all_pods = manager.list_all_cached_pods();
        assert_eq!(all_pods.len(), 1);
    }
}
```

## 4. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Terlalu Mengandalkan Polling (GET/LIST secara Periodik)
Menggunakan `api.list()` setiap 5 detik di dalam loop untuk mengecek state. Ini mematikan API Server Kubernetes.
**Solusi (✅):** Gunakan pola `watcher` dan `reflector` seperti di atas, yang mempertahankan satu koneksi TCP panjang untuk HTTP Chunked Watch dan mempertahankan state lokal secara pasif.

### ❌ Anti-Pattern 2: Block/Heavy Compute di Stream Processor
Melakukan komputasi ekstensif (blocking) atau I/O jaringan di closure event Informer.
```rust
// ❌ BURUK: Memblokir stream tokio dan menyumbat watch event
watcher(api, lp).try_for_each(|p| async move {
    std::thread::sleep(std::time::Duration::from_secs(5)); 
    Ok(())
})
```
**Solusi (✅):** Lempar event ke queue/channel (seperti `tokio::sync::mpsc`) agar worker yang berdedikasi dapat meresponsnya, membiarkan watcher stream `kube-rs` tetap berjalan dengan sangat cepat.

## 5. Production Edge Cases

1. **Jaringan Terputus / "Resource Version Too Old" (410 Gone):**
   * **Masalah:** Watch connection dapat terputus kapan saja, atau etcd bisa menyingkirkan event dari riwayat jika diskoneksi berlangsung lama, mengakibatkan error `410 Gone`.
   * **Mitigasi:** Fungsi `watcher` `kube-rs` menangani hal ini secara internal. Ia otomatis akan beralih melakukan `List` (mengambil state baru sepenuhnya secara transparan) lalu melanjutkan proses `Watch`. Di ranah aplikasi, stream tidak boleh di-`unwrap` sembarangan; bungkus `.await` stream dengan logic retry/backoff (misal menggunakan library `backoff`).

2. **Memori Meledak Akibat Cache Terlalu Besar:**
   * **Masalah:** Melakukan caching semua `Pod` atau `ConfigMap` di cluster berukuran ribuan node. `reflector::Store` memakan memori RAM seiring dengan ukuran resource.
   * **Mitigasi:** Filter scope watcher sedetail mungkin melalui `ListParams`. Gunakan kombinasi seleksi `label_selector` atau `field_selector`, sehingga hanya me-load resource yang benar-benar diperhatikan oleh operator. 

3. **Sinkronisasi Split-Brain di Saat Inisialisasi:**
   * **Masalah:** Controller Anda dapat memproses logic bisnis yang bergantung pada dua store berbeda (contoh: Pods dan ConfigMaps). State mungkin memproses event di saat Pod Store sudah tersinkron namun ConfigMap Store masih kosong (sedang proses inisiasi).
   * **Mitigasi:** Jangan menyalakan reconciliation worker sebelum sinyal `store.state().len() > 0` terpenuhi, atau tunggu event inisialisasi yang menandakan bahwa fase *Initial List* sudah selesai sepenuhnya dari semua informer yang digunakan.
