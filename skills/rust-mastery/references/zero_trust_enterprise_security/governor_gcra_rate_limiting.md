# Referensi Mutakhir: Implementasi Rate Limiting GCRA menggunakan Governor di Lingkungan Zero Trust

## 1. Pendahuluan
Dalam arsitektur Zero Trust Enterprise Security, setiap request wajib divalidasi dan diatur limitasinya secara ketat terlepas dari asalnya (internal maupun eksternal). Algoritma Generic Cell Rate Algorithm (GCRA) menawarkan pendekatan yang sangat presisi untuk rate limiting dibandingkan pendekatan Token Bucket tradisional atau Sliding Window. Di ekosistem Rust, _crate_ `governor` memberikan implementasi GCRA yang sangat optimal, thread-safe, dan tanpa lock-contention (lock-free) yang berarti, sehingga ideal untuk gateway keamanan Zero Trust yang harus memproses puluhan ribu RPS (Requests Per Second).

## 2. Diagram Arsitektur GCRA
Berikut adalah diagram konseptual aliran validasi rate limiting menggunakan Governor:

```text
    [Klien Eksternal/Internal] 
            |
            | Request (Token/IP)
            v
    +-----------------------------------------------+
    | API Gateway / Ingress Controller              |
    |                                               |
    |  +-----------------------------------------+  |
    |  | Ekstraksi Kunci (e.g., Client ID)       |  |
    |  +-----------------------------------------+  |
    |            |                                  |
    |            v                                  |
    |  +-----------------------------------------+  |
    |  | DashMap Kunci -> Governor Rate Limiter  |  |
    |  | (In-Memory, Lock-Free / Redis-Backed)   |  |
    |  +-----------------------------------------+  |
    |            |                                  |
    |            v                                  |
    |    [ Pengecekan GCRA (check_and_keep) ]       |
    |       /                        \              |
    |  [ Diizinkan ]             [ Ditolak ]        |
    +-------+-------------------------+-------------+
            |                         |
            | Diteruskan ke           | Response HTTP 429
            v                         v
   [ Microservices ]            [ Log Audit ]
```

## 3. Implementasi Produksi Idiomatis
Implementasi ini menggunakan `governor` dan `dashmap` untuk menyimpan status limiter tiap klien secara konkruen di memori. Dalam skenario produksi sebenarnya, untuk state terdistribusi bisa menggunakan Redis.

```rust
use dashmap::DashMap;
use governor::{
    clock::DefaultClock,
    state::{InMemoryState, NotKeyed},
    Quota, RateLimiter,
};
use std::num::NonZeroU32;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;

/// Error khusus untuk komponen Rate Limiter
#[derive(Debug, Error)]
pub enum RateLimitError {
    #[error("Terlalu banyak request. Coba lagi dalam {0} ms")]
    TooManyRequests(u64),
    #[error("Kunci klien tidak valid atau kosong")]
    InvalidClientKey,
}

/// Struktur utama untuk mengelola Rate Limiter per Klien
pub struct EnterpriseRateLimiter {
    /// Map konkruen yang menyimpan RateLimiter untuk tiap client_id
    limiters: DashMap<String, Arc<RateLimiter<NotKeyed, InMemoryState, DefaultClock>>>,
    /// Konfigurasi Quota dasar: burst size dan laju pergerakan (replenish rate)
    quota: Quota,
}

impl EnterpriseRateLimiter {
    /// Membuat instance baru dari EnterpriseRateLimiter
    /// `max_burst`: Jumlah maksimal request yang bisa dilakukan sekaligus dalam satu waktu.
    /// `replenish_rate_ms`: Waktu (dalam milidetik) yang dibutuhkan untuk menambah 1 token.
    pub fn new(max_burst: u32, replenish_rate_ms: u64) -> Self {
        let burst_size = NonZeroU32::new(max_burst).unwrap_or(NonZeroU32::new(1).unwrap());
        let quota = Quota::with_period(Duration::from_millis(replenish_rate_ms))
            .expect("Periode waktu tidak boleh nol")
            .allow_burst(burst_size);

        Self {
            limiters: DashMap::new(),
            quota,
        }
    }

    /// Mengecek apakah request dari `client_id` diizinkan.
    pub async fn check_request(&self, client_id: &str) -> Result<(), RateLimitError> {
        if client_id.trim().is_empty() {
            return Err(RateLimitError::InvalidClientKey);
        }

        // Ambil atau buat limiter baru untuk client_id ini jika belum ada
        let limiter = self.limiters
            .entry(client_id.to_string())
            .or_insert_with(|| Arc::new(RateLimiter::direct(self.quota)))
            .value()
            .clone();

        match limiter.check() {
            Ok(_) => Ok(()),
            Err(not_until) => {
                let wait_time = not_until.wait_time_from(DefaultClock::default().now());
                Err(RateLimitError::TooManyRequests(wait_time.as_millis() as u64))
            }
        }
    }

    /// Secara manual membersihkan entri dari memori untuk menghindari memory leak (jika kunci sangat dinamis)
    pub fn remove_client(&self, client_id: &str) {
        self.limiters.remove(client_id);
    }
    
    /// Mengembalikan total klien yang sedang dilacak
    pub fn tracked_clients_count(&self) -> usize {
        self.limiters.len()
    }
}
```

## 4. Pengujian (Unit & Integration Tests)
Pengujian untuk memastikan implementasi limiter berfungsi sesuai kuota dan menolak permintaan yang berlebih.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{sleep, Duration};

    #[tokio::test]
    async fn test_rate_limiter_allows_under_burst() {
        let limiter = EnterpriseRateLimiter::new(3, 100);
        let client_id = "client-alpha";

        assert!(limiter.check_request(client_id).await.is_ok());
        assert!(limiter.check_request(client_id).await.is_ok());
        assert!(limiter.check_request(client_id).await.is_ok());
    }

    #[tokio::test]
    async fn test_rate_limiter_blocks_over_burst() {
        let limiter = EnterpriseRateLimiter::new(2, 500);
        let client_id = "client-beta";

        assert!(limiter.check_request(client_id).await.is_ok());
        assert!(limiter.check_request(client_id).await.is_ok());
        
        let err = limiter.check_request(client_id).await;
        assert!(err.is_err());
        match err {
            Err(RateLimitError::TooManyRequests(ms)) => {
                assert!(ms > 0);
            },
            _ => panic!("Expected TooManyRequests error"),
        }
    }

    #[tokio::test]
    async fn test_rate_limiter_replenishes_over_time() {
        let limiter = EnterpriseRateLimiter::new(1, 100);
        let client_id = "client-gamma";

        assert!(limiter.check_request(client_id).await.is_ok());
        assert!(limiter.check_request(client_id).await.is_err());

        // Tunggu lebih lama dari replenish rate (100ms)
        sleep(Duration::from_millis(150)).await;

        assert!(limiter.check_request(client_id).await.is_ok());
    }
    
    #[tokio::test]
    async fn test_invalid_client_key() {
        let limiter = EnterpriseRateLimiter::new(10, 100);
        let err = limiter.check_request("").await;
        assert!(matches!(err, Err(RateLimitError::InvalidClientKey)));
    }
}
```

## 5. Anti-Patterns Kritis

1. **Menggunakan String sebagai Key pada Sistem Global dengan Mutex Berantai**
   *Penjelasan:* Menggunakan `Mutex<HashMap<String, RateLimiter>>` dalam konteks *highly concurrent* akan menciptakan *lock contention* yang masif. Setiap *request* sekecil apa pun akan saling memblokir (*blocking*) thread saat mengambil kunci map, menghancurkan *throughput*.
   *Solusi:* Gunakan *concurrent data structures* seperti `DashMap` atau *sharded mutex*.

2. **Gagal Membersihkan State Limiter Klien Inaktif (Memory Leak)**
   *Penjelasan:* Pada lingkungan dengan kunci dinamik yang tak terbatas (misalnya, alamat IP dari bot-net), *entry* baru di map akan terus bertambah selamanya jika menggunakan state *in-memory*. Tanpa mekanisme ekskresi otomatis (TTL) atau siklus pembersihan manual (Garbage Collection), proses Rust pada akhirnya akan kehabisan memori (*OOM Kills*).
   *Solusi:* Gunakan *cache map* dengan dukungan TTL bawaan seperti `moka` atau simpan di Redis untuk skala horizontal yang memadai.

## 6. Production Edge Cases

1. **Sinkronisasi Clock Drift Antar Node**
   *Penjelasan:* Saat GCRA dijalankan secara terdistribusi (misalnya melalui ekstensi Redis), asimetri waktu sistem (*clock drift*) antar node microservice dapat merusak perhitungan matematis algoritma GCRA, mengakibatkan request sah tertolak prematur.
   *Penanganan:* Pastikan NTP terkonfigurasi dengan daemon agresif seperti `chronyd` di semua *node*, atau andalkan sepenuhnya waktu server Redis (*Redis Time*).

2. **Distorsi Burst akibat Jeda I/O (Asynchronous Pause)**
   *Penjelasan:* Jika kode setelah pemicu rate limiter melakukan iterasi atau blok I/O asinkron yang panjang, limiter mungkin memberikan izin untuk gelombang *request* berikutnya sebelum yang sebelumnya tuntas, menciptakan efek penumpukan beban lokal (Thundering Herd).
   *Penanganan:* Kombinasikan *rate limiting* awal dengan manajemen konkruensi ekor (*tail concurrency limit*) seperti *semaphore* per-klien atau proteksi *circuit breaker*.

3. **Penolakan Layanan (*Denial of Service*) Berbasis Pengisian Cache (Cache Filling)**
   *Penjelasan:* Penyerang jahat dapat mengeksploitasi parameter *client ID* dengan menggunakan parameter yang terus-menerus berubah, memaksa *limiter* mereservasi ruang memori untuk kunci acak terus-menerus (jika *key* berbasis string dari parameter `X-Forwarded-For`).
   *Penanganan:* Letakkan WAF di depan layanan yang hanya mengizinkan IP atau subjek terautentikasi (JWT) yang diotorisasi, dan batasi jumlah kunci unik maksimum yang bisa dicatat per satuan waktu.
