# Observability, Tracing & OpenTelemetry (Top 1% Architecture)

## 1. Fundamental Law & Mechanical Sympathy

Dalam sistem mikro-layanan (*Microservices*), kegagalan tidak pernah tunggal dan linier; ia bersifat menyebar (*cascading*) menembus batas-batas jaringan asinkron. Pendekatan log konvensional (`println!` atau `log::info!`) tidak berguna karena tidak mampu melacak benang merah (*Context Propagation*) dari satu *request* pengguna saat melewati ratusan peralihan *Thread* asinkron. Ekosistem `tracing` di Rust diciptakan untuk memecahkan masalah ini. Ia didasarkan pada konsep **Spans** (Rentang Waktu Logis) dan **Events** (Titik Kejadian). 

Secara mekanik (*Mechanical Sympathy*), *Tracing* Rust memisahkan arsitektur menjadi dua kubu: **Instrumentation** (Makro yang menyisipkan *Span* ke dalam logika Anda) dan **Subscriber** (Mesin pemrosesan di latar belakang yang menangkap, memformat, dan mengekspor *Span* tersebut). Memanggil makro `tracing::info!()` sangatlah ringan (*Zero-Cost Abstraction* jika dimatikan) karena ia memblokir *Thread* serendah mungkin dan mendelegasikan penulisan log *(I/O disk / Network HTTP ke OTLP)* kepada *Subscriber* yang beroperasi pada *thread* terpisah secara asinkron. Penguasaan atas OTLP (*OpenTelemetry Protocol*) adalah satu-satunya jembatan agar metrik Rust dapat dicerna oleh Datadog, Prometheus, atau Jaeger di kelas *Enterprise*.

## 2. Top 1% Production Architecture

Arsitektur produksi mewajibkan standarisasi struktur log menjadi JSON dan perambatan jejak korelasi (*Trace Correlation ID*) secara mulus dari Gerbang API (API Gateway) hingga ke dasar pangkalan data (Database).

### 2.1 The Global Subscriber Registry
Di awal aplikasi (`main.rs`), Anda wajib membangun tumpukan (*stack*) lapisan observasi (Layers) dan mendaftarkannya secara global.

```rust
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use tracing_subscriber::fmt;

pub fn init_telemetry() {
    // 1. EnvFilter: Mengontrol tingkat log berdasarkan variabel RUST_LOG (misal: "info,my_app=debug")
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));

    // 2. FmtLayer: Memformat log menjadi JSON untuk mesin ELK (Elasticsearch/Logstash/Kibana)
    let formatting_layer = fmt::layer()
        .json()
        .flatten_event(true)
        .with_target(false)
        .with_span_list(true);

    // 3. (Opsional) OTLP Exporter untuk OpenTelemetry ke Jaeger/Datadog
    // let tracer = opentelemetry_otlp::new_pipeline()...

    // Menyusun lapisan-lapisan dan menjadikannya Subscriber Global
    tracing_subscriber::registry()
        .with(env_filter)
        .with(formatting_layer)
        .init();
}
```

### 2.2 Asynchronous Span Instrumentation
Melacak pergerakan fungsi *async* di Tokio membutuhkan makro `#[instrument]`. Ini secara otomatis menciptakan *Span* (rentang waktu: mulai hingga fungsi berakhir) dan melampirkan seluruh argumen fungsi ke dalam log tanpa campur tangan manual.

```rust
use tracing::{info, instrument};
use uuid::Uuid;

pub struct PaymentProcessor;

impl PaymentProcessor {
    // MAHA-OPUS: Macro ini otomatis mengaitkan 'user_id' dan 'amount' ke setiap log di dalam fungsi
    #[instrument(
        name = "process_payment_transaction",
        skip(self, credit_card_pan), // Jangan pernah me-log data sensitif (PAN kartu kredit)!
        fields(currency = "USD")
    )]
    pub async fn charge(&self, user_id: Uuid, amount: f64, credit_card_pan: &str) -> Result<(), String> {
        info!("Starting payment authorization"); // Automatically tagged with user_id, amount, currency

        // Simulasikan panggilan I/O asinkron.
        // Konteks Span TETAP menempel meskipun Tokio memindahkan eksekusi ini ke Thread lain!
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        info!("Payment authorized successfully");
        Ok(())
    }
}
```

## 3. Failure & Edge-Case Anomaly Matrix

| Kelas Anomali | Gejala / Dampak Mutlak | Matriks Mitigasi (Top 1% Tactic) |
| :--- | :--- | :--- |
| **Async Context Loss** | Anda menggunakan `.spawn()` di Tokio untuk memisahkan tugas latar belakang, namun log di dalam tugas tersebut tiba-tiba kehilangan *Trace ID* (putus dari rantai korelasi *request* utama). | Anda WAJIB mempropagasi konteks secara eksplisit saat membelah *thread*. Gunakan `tracing::Instrument` trait dan sambungkan dengan `.instrument(tracing::Span::current())` pada *Future* sebelum memanggil `tokio::spawn(future)`. |
| **Performance Degradation (Disk I/O Bottleneck)** | Aplikasi merespons lambat; utilisasi CPU penuh. Profiler menunjukkan program Rust menghabiskan 60% waktunya menunggu pemblokiran antarmuka konsol standard (STDOUT Mutex Lock). | *Subscriber* baku di Rust memblokir *Thread* setiap kali menulis teks ke konsol/disk. Di lingkungan produksi dengan kueri masif, JANGAN mencetak log secara sinkron. Bungkus *Writer* Anda dengan `tracing_appender::non_blocking`, yang akan menaruh pesan log ke dalam antrean (Queue) memori, membebaskan *Thread* utama. |
| **Log Flooding & Bill Shock** | Tagihan *Datadog / CloudWatch* Anda meledak puluhan ribu Dolar. | Gunakan `EnvFilter` secara ketat (`RUST_LOG=info,my_crate=debug,hyper=warn`). Pustaka pihak ketiga seperti `hyper` atau `sqlx` seringkali sangat bising di tingkat `info`. Bungkam mereka. |

## 4. High-Assurance Testing

Menguji telemetri seringkali rumit, namun Anda dapat merutekan keluaran log Rust ke dalam bufer memori internal (*buffer*) selama pengujian Unit, lalu menegaskan (*assert*) isinya.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::FmtSubscriber;
    use std::sync::{Arc, Mutex};

    // Buffer sink untuk menangkap log di RAM selama test
    #[derive(Clone, Default)]
    struct MockWriter {
        logs: Arc<Mutex<String>>,
    }

    impl std::io::Write for MockWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.logs.lock().unwrap().push_str(&String::from_utf8_lossy(buf));
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }

    #[tokio::test]
    async fn test_payment_logs_do_not_contain_credit_card() {
        // Arrange
        let mock_writer = MockWriter::default();
        let subscriber = FmtSubscriber::builder()
            .with_writer(move || mock_writer.clone()) // Inject buffer
            .finish();
        
        // Wrap test execution inside the subscriber boundary
        tracing::subscriber::with_default(subscriber, || {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            runtime.block_on(async {
                let processor = PaymentProcessor;
                
                // Act
                let _ = processor.charge(Uuid::new_v4(), 100.0, "1234-5678-9012-3456").await;
            });
        });

        // Assert: Ensure PAN is redacted/skipped
        let logs_captured = mock_writer.logs.lock().unwrap();
        assert!(!logs_captured.contains("1234-5678"));
        assert!(logs_captured.contains("Starting payment authorization"));
    }
}
```

## 5. Anti-Patterns & "When NOT to Use" Matrix

### Anti-Pattern: String Interpolation di dalam Log Macro
Sebuah dosa fatal yang sering dilakukan *programmer* asal C#/Node.js adalah menjejalkan variabel menggunakan fungsi format standar: `info!("User {} paid ${}", user_id, amount);`.

**Mengapa ini fatal?**
- **Pros:** Nyaman dibaca di konsol lokal.
- **Cons (1):** Menghancurkan pilar *Structured Logging* (JSON). Sistem Datadog/ELK akan membaca itu sebagai *string* tunggal "User 123 paid $50". Anda tidak bisa melakukan *Query* analitik "Berapa total *amount* hari ini?".
- **Top 1% Fix:** Selalu deklarasikan properti sebagai kolom logis (*Key-Value Pairs*): `info!(user_id = %user.id, amount = amount, "User executed payment");`. ELK akan dapat mengindeks properti `"amount": 50` secara numerik!

**Kapan `#[instrument]` TIDAK Boleh Digunakan:**
- **Fungsi Panas (Hot Loops/Render Functions):** Jangan letakkan makro instrumentasi di fungsi perakitan kalkulasi *Hash* atau pengulangan *Loop* yang dipanggil 10,000 kali per detik. Biaya pembuatan dan penghancuran (*drop*) objek *Span* akan membuat beban siklus CPU meledak. Cukup instrumentasikan batas paling atas (misal fungsi *Handler*).
