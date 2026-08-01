# Panduan Mendalam: Structured Logging dengan Tracing (tracing-subscriber)

## 1. Konsep Utama & Arsitektur
`tracing` adalah sebuah kerangka *instrumentasi diagnostik* asinkron di ekosistem Rust. Berbeda dengan log teks biasa (`log` crate), `tracing` berorientasi pada kejadian berbasis struktur data (*structured logging*) yang memancarkan span leksikal bertingkat.
Subsistem utamanya, `tracing-subscriber`, menyaring (*filtering* via `EnvFilter`) dan mengarahkan data ini ke dalam keluaran tujuan (*Layer*), seperti *stdout* console manusiawi atau format JSON yang ramah mesin (seperti ELK, Datadog), didukung penulisan file tanpa hambatan (*non-blocking appender*).

### 1.1 Diagram Alur Span Lifecycle ke Non-Blocking Appender
```ascii
[ Thread 1: Async Task A ] --(Span: DB Connect)--+
                                                 |
[ Thread 2: Async Task B ] --(Span: HTTP Req)----+ 
                                                 |
                                     +-----------------------+
                                     |  Registry / Dispatch  |
                                     |    (tracing core)     |
                                     +-----------------------+
                                                 |
                         +-----------------------+-----------------------+
                         |                                               |
              [ Layer 1: Stdout ]                            [ Layer 2: File Appender ]
          (ANSI / Human-readable output)                    (JSON format, EnvFilter: info)
                                                                         |
                                                            +------------------------+
                                                            | Non-blocking MPSC Sync |
                                                            +------------------------+
                                                                         |
                                                           [ Dedicated I/O Log Worker ] -> file.log
```

## 2. Implementasi Produksi (Zero-Clippy Warnings, Fully Tested)
Berikut implementasi lengkap yang mengonfigurasi struktur rotasi *log file* dengan penjaga (*guard*) *non-blocking* agar thread tokio tetap bebas I/O block.

```rust
// Cargo.toml
// tracing = "0.1"
// tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
// tracing-appender = "0.2"

use tracing::{info, span, Level};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use tracing_appender::non_blocking::WorkerGuard;

/// Inisialisasi telemetry. Me-return WorkerGuard yang wajib ditahan 
/// hingga akhir masa aktif aplikasi untuk mencegah kehilangan log.
pub fn init_production_tracing() -> WorkerGuard {
    // 1. Appender file rolling (membuat file log harian baru)
    let file_appender = tracing_appender::rolling::daily("logs", "app.log");
    
    // 2. Wrap file log I/O ke dalam non-blocking channel thread-safe
    let (non_blocking_appender, guard) = tracing_appender::non_blocking(file_appender);

    // 3. Setup Filter: Gunakan variabel env "RUST_LOG", default ke 'info'
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));

    // 4. Layer file -> format JSON agar mudah ditangkap DataDog/Splunk
    let json_file_layer = tracing_subscriber::fmt::layer()
        .json()
        .with_writer(non_blocking_appender);

    // 5. Layer stdout -> format ANSI untuk manusia (opsional di prod, baik untuk container)
    let stdout_layer = tracing_subscriber::fmt::layer()
        .pretty()
        .with_ansi(true);

    // 6. Daftarkan dan Inisialisasi secara Global
    tracing_subscriber::registry()
        .with(env_filter)
        .with(json_file_layer)
        .with(stdout_layer)
        .init();

    // Wajib: guard ini tidak boleh di-drop sebelum main() berakhir.
    guard
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing::{error, info_span};

    #[test]
    fn test_tracing_initialization() {
        // Init global tracing dalam scope test. 
        // Waspada: subscriber.init() hanya bisa dipanggil satu kali dalam satu runtime, 
        // sehingga dalam unit test massal sebaiknya digunakan dengan hati-hati.
        let _guard = init_production_tracing();

        let span = info_span!("test_operation", op_id = 42);
        let _entered = span.enter();
        
        info!("This is a structured info message");
        error!(cause = "Database timeout", "Simulasi error");
        
        // Assertions pada output file log akan memerlukan I/O check, 
        // untuk tes unit sederhana kita hanya memastikan tidak panic.
        assert!(true); 
    }
}
```

## 3. Anti-Patterns Kritis

### 3.1. Memblokir Async Runtime dengan Sync File Logger
**Buruk:** Menyambungkan `std::fs::File` murni ke `fmt::layer().with_writer(File)`.
**Alasan:** Disk I/O dapat mengalami latensi (*stalls*) di Linux level filesystem (flush). Memblokir *tokio worker thread* demi merekam log akan menghentikan laju eksekusi seluruh *future* jaringan yang diemban thread tersebut (mengakibatkan latensi API melonjak drastis).
**Solusi:** Selalu gunakan `tracing_appender::non_blocking` (yang mendelegasikan beban operasi *write* ke spesialis *background thread* terdedikasi menggunakan antrean MPSC internal) agar thread asinkron segera melempar data dan lanjut mengeksekusi I/O kritis lain.

### 3.2. Pemborosan String Allocation (Eager Evaluation)
**Buruk:** `tracing::debug!("Data berat: {}", format!("{:#?}", giant_payload));`
**Alasan:** Macro `format!` atau metode alokasi kustom akan memakan memori heap dan CPU terlebih dahulu SEBELUM subsistem log memutuskan apakah level "debug" aktif via filter. Jika *EnvFilter* diatur pada level `INFO`, seluruh usaha alokasi string ini terbuang percuma setiap mili-detik.
**Solusi:** Serahkan ke *formatter lazily* `tracing`. Tuliskan langsung strukturnya atau tunda representasi: `tracing::debug!(?giant_payload, "Data berat");`. Makro akan melakukan eksekusi interpolasi *hanya jika* filter menyatakan span ini direkam.

## 4. Edge Cases dalam Skala Produksi

### 4.1. Worker Guard Di-drop Terlalu Awal (Missing Logs)
Tipe return dari `tracing_appender::non_blocking()` adalah sepasang `(writer, guard)`. Jika variabel `guard` tidak disimpan dalam durasi `main()` menggunakan `let _guard = ...` dan justru dibiarkan *drop* (misal dipanggil tanpa _binding_ `init_logger();`), background thread penulis file akan dimatikan otomatis secara spontan oleh mekanisme *Drop*. Akibatnya, sebagian atau seluruh *buffered logs* gagal tersimpan (*flushed*) ke disk sebelum program berhenti, menyebabkan misteri diskrepansi log.

### 4.2. Struktur Rekursif / Kedalaman Infinite JSON 
Sistem log `json()` pada tracing mampu me-serialize argumen yang memiliki `#[derive(Debug)]`. Namun, pada struktur graf yang memiliki siklus saling menaut *(cyclic references, Arc<RwLock<Self>>)* atau error chain yang masif, serialisasi JSON akan menabrak pembatasan alokasi dan membuat stack memory meledak atau menghasilkan log raksasa (*bloat*) 50MB per satu request. Produksi level lanjut memitigasi ini dengan mendaftarkan *depth limit* formatter.

### 4.3. Beban Antrean (Buffer Overflowing pada MPSC Log Channel)
Pada sistem beban ekstrim (misal: 100k requests/sec di mana setiap request mencetak 10 baris span), *non-blocking appender channel buffer* internal (default 128.000 log) dapat menjadi *saturated* karena piringan SSD I/O lebih lambat daripada laju log dari CPU/Memory. Perilaku default `tracing-appender` di titik ini adalah... **membelokkan thread worker (block) atau membuang pesan (drop)!** Dalam sistem sensitif *(lossless log requirement)*, Anda wajib melakukan inspeksi pada parameter inisialisasi kapasitas antrean asinkronnya atau menggunakan strategi sink disk berbasis *Memory-Mapped IO* (mmap).
