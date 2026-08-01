# Cache Stampede Protection menggunakan Pattern Singleflight

## Pendahuluan

*Cache Stampede* (atau sering disebut *Thundering Herd Problem*) adalah krisis sistemik yang menjangkit sistem terdistribusi manakala kunci *cache* yang sangat panas (hot key) mendadak kedaluwarsa. Tanpa mekanisme proteksi, puluhan hingga ribuan permintaan masuk untuk *key* tersebut (dalam sepersekian detik) mengalami *cache miss* secara simultan. Akibatnya, seluruh ribuan permintaan itu mendobrak pertahanan cache dan memukul sumber data asli (Database SQL, GraphQL eksternal) untuk data yang identik secara persis. Situasi berujung pada *bottleneck IO*, *database lock escalation*, hingga tumbangnya sistem sepenuhnya (*Cascading Failures*).

Di Rust, kita mengatasi hal ini menggunakan pola **Singleflight**. Singleflight menahan *concurrent caller* untuk berfusi (coalesce) menjadi satu panggilan latar (background worker call) menuju database. Panggilan lain cukup memantau hasil eksekusi pekerja tersebut, lalu nilai tersebut disiarkan (*broadcast*) kepada para penanti.

## Arsitektur & Topologi Singleflight

Diagram ASCII ini mencontohkan resolusi Singleflight asinkron.

```text
 +---------------+                                       +-----------------------+
 | Req 1 (T=0ms) |------+                                |                       |
 +---------------+      |                                |                       |
                        v                                v                       |
 +---------------+    +-------------------+    +-------------------+      +--------------+
 | Req 2 (T=2ms) |--->| SINGLEFLIGHT      |--->| DB Fetching Task  |----->| RDBMS / API  |
 +---------------+    | MUTEX/WATCHER     |    +-------------------+      +--------------+
                      | (Key: 'top_news') |              |                       |
 +---------------+    |                   |              v                       |
 | Req 3 (T=4ms) |--->| Status: "PENDING" |<-------(Broadcast Data)--------------+
 +---------------+    +-------------------+              |
                        |       |       |                |
<---(Respond Req 1)-----+       |       +--(Respond Req 3)
                                |
<---(Respond Req 2)-------------+
```

## Implementasi Kode Produksi (Idiomatis)

Meskipun pustaka cache (seperti `moka`) memiliki *internal singleflight*, sering kali kita memerlukan Singleflight abstrak untuk tugas I/O generik (terutama perutean di lapis jaringan). Pustaka `async-rx` atau implementasi murni *Custom Singleflight* dengan `tokio::sync::broadcast` merupakan arsitektur kokoh yang disajikan dalam pola produksi di bawah ini:

```rust
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};
use tokio::task;
use std::pin::Pin;

/// Hasil eksekusi fungsi yang bisa di-clone untuk di-broadcast
/// Kriteria generik T dan Error (E) harus menerapkan trait Clone
pub type SingleflightResult<T, E> = Result<T, E>;

/// Manajemen Status Pengerjaan (Worker State)
struct CallState<T, E> {
    // Channel siaran, mendistribusikan value ke banyak receiver
    broadcaster: broadcast::Sender<SingleflightResult<T, E>>,
}

/// Struktur Utama Singleflight Group
pub struct SingleflightGroup<T, E> {
    // Peta yang melacak aktivitas asinkron dengan Key string
    calls: Arc<Mutex<HashMap<String, Arc<CallState<T, E>>>>>,
}

impl<T, E> Clone for SingleflightGroup<T, E> {
    fn clone(&self) -> Self {
        Self {
            calls: self.calls.clone(),
        }
    }
}

impl<T, E> SingleflightGroup<T, E>
where
    T: Clone + Send + Sync + 'static,
    E: Clone + Send + Sync + 'static,
{
    pub fn new() -> Self {
        Self {
            calls: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Metode Do mengeksekusi fetch asinkron.
    /// Jika call untuk 'key' ini sudah sedang berlangsung, maka akan join ke antrean siaran (Receiver).
    pub async fn do_call<F, Fut>(&self, key: &str, fetcher: F) -> SingleflightResult<T, E>
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = SingleflightResult<T, E>> + Send + 'static,
    {
        let mut map = self.calls.lock().await;

        if let Some(state) = map.get(key) {
            // Pekerjaan identik sedang berjalan. Bergabunglah dengan Broadcast Receiver.
            let mut rx = state.broadcaster.subscribe();
            drop(map); // Lepaskan kunci sinkronisasi Map agar tidak memblokir yang lain.
            
            // Tunggu nilai untuk dibroadcast.
            // .expect() aman di sini asumsi broadcaster tidak didrop sebelum mengirim.
            return rx.recv().await.expect("Singleflight worker terhenti paksa");
        }

        // Pekerjaan belum berjalan, inisialisasi broadcaster.
        // Kapasitas 1 sudah cukup karena kita mengirimkan satu nilai final (hit atau miss).
        let (tx, _) = broadcast::channel(1);
        let state = Arc::new(CallState { broadcaster: tx.clone() });

        map.insert(key.to_string(), state);
        drop(map); // Rilis Lock secepat mungkin.

        // Laksanakan pekerjaan nyata di blok ini (Fetch Database).
        let result = fetcher().await;

        // Pekerjaan selesai. Kirim siaran.
        let _ = tx.send(result.clone());

        // Bersihkan state dari peta karena sudah dieksekusi tuntas.
        let mut map = self.calls.lock().await;
        map.remove(key);

        result
    }
}
```

## Unit Test dan Integration Test

Uji coba integrasi difokuskan pada membuktikan fusi konkuren: memicu sejumlah *task* secara paralel namun hanya memicu eksekusi *database logic* persis satu kali.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::time::sleep;

    #[tokio::test]
    async fn test_singleflight_stampede_protection() {
        let sf: SingleflightGroup<String, String> = SingleflightGroup::new();
        let db_hit_counter = Arc::new(AtomicUsize::new(0));

        let mut tasks = Vec::new();
        
        // Simulasikan 1000 permintaan masuk dalam waktu bersamaan untuk Key yang sama ("hot_item")
        for i in 0..1000 {
            let sf_clone = sf.clone();
            let counter_clone = db_hit_counter.clone();
            
            let task = tokio::spawn(async move {
                let key = "hot_item";
                
                sf_clone.do_call(key, move || async move {
                    // Blok di sini menyimulasikan I/O database yg berat
                    counter_clone.fetch_add(1, Ordering::SeqCst);
                    sleep(Duration::from_millis(150)).await;
                    Ok(format!("Data berharga hasil fetch DB {}", i)) // Value ini di-broadcast
                }).await
            });
            
            tasks.push(task);
        }

        for t in tasks {
            let res = t.await.unwrap();
            assert!(res.is_ok());
        }

        // PERLINDUNGAN STAMPEDE TERBUKTI:
        // Dari 1000 iterasi request konkuren, fetcher I/O database HANYA dipicu SEKALI!
        assert_eq!(db_hit_counter.load(Ordering::SeqCst), 1);
    }
}
```

## Anti-Patterns Kritis

1. **Membiarkan Mutex Map Terkunci Selama Operasi I/O (Lock Retention):**
   Memegang referensi `MutexGuard` (mis. dari `self.calls.lock().await`) pada lingkup di dalam eksekusi I/O (`fetcher().await`). Ini secara fatal mengakibatkan *semua* _requests_ ke keys API lainnya macet (*serialized*), menyabotase seluruh paralelisme runtime Node (Starvation/Deadlock). Lock hanya boleh digunakan sesaat untuk membaca atau menulis map di memori (`HashMap`), dan *harus* langsung dilepas/drop.
2. **Ketiadaan Propagasi Error yang Tepat:**
   Ketika `fetcher` gagal, broadcaster *tidak* menyebarkan rincian error (`Result::Err`), melainkan mengabaikan kesalahan (misalnya dengan mem-`panic`), menyebabkan ratusan _awaiters_ pada channel _subscribe_ menggantung mati secara abadi tanpa timbal balik, mengunci memory dan TCP Socket.

## Production Edge Cases

1. **Panic Dalam Worker Asynchronous Task:**
   Jika kode `fetcher` panik karena pembagian nol atau error fatal, worker utama (leader) tumbang sebelum menyelesaikan siaran, dan `tx` didrop. *Awaiters* akan mendapatkan error `RecvError::Closed`. Solusi produksi: Harus menyertakan skema pengikutsertaan *restart/retry leader* dalam penanganan *Closed error*.
2. **Parameter Mismatches (Key Collision Overlap):**
   String *key* digunakan untuk menyatukan _request_ paralel. Jika variabel identitas yang membentuk *Key* tidak memperhitungkan semua konteks _request_ (contoh: mengabaikan parameter bahasa `locale_en` versus `locale_id` yang melempar _key_ yang sama), maka para requester akan mendapatkan *response* data dengan bahasa asing secara silang (karena berbagi data L1 Singleflight *cross-contamination*).
3. **Throttling Broadcast Memory (Overcapacity Queue):**
   *Singleflight* akan mengakumulasikan pemesan pada `broadcast::Sender` channel. Jika eksekusi I/O terlalu lama (misal 15 menit macet di database), ribuan memori pointer dari penanti channel ini menumpuk di sisi aplikasi (Leakage tertunda). Sistem harus dipasangkan dengan Timeout Lapis Menengah menggunakan `tokio::time::timeout` agar penanti gugur (*drop connection/cancel*) mandiri saat terjadi SLA terlampaui (mis: Timeout > 5 detik).
