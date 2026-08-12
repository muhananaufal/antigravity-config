# Tracing-Error & Span Instrumentation (Distributed Debugging)

Dalam arsitektur *Distributed Async Services* berbasis tokio, eksekusi kode Anda tidak lagi sekuensial pada satu OS Thread. Sebuh *Future* dapat memulai tugas di Thread A, terputus (yield) pada pemanggilan I/O socket, dan dilanjutkan (resume) di Thread B. Kondisi perpindahan (Context Switch Asinkron) ini menyebabkan log backtrace OS (yang terikat pada thread-local call stack) menjadi tidak valid atau hancur!

Crate `tracing` (beserta `tracing-error` dan `SpanTrace`) merespons hal ini dengan merekam "Pohon Eksekusi Logis" (Logical Call Tree). Setiap kali tugas asinkron didelegasikan, span konteks ini direkatkan secara implisit, memastikan log error memiliki metadata korelatif seperti *Trace ID* lintas service RPC atau gRPC, menjadikannya standar industri di Rust (dipelopori oleh tim tokio & Linkerd).

## Arsitektur Async Span Trace Instrumentasi

```ascii
[ HTTP Request Inbound: Trace ID 99-xyz ] ---> (Creates Root Span)
                  |
         +--------+---------+ (tokio::spawn)
         |                  |
[ DB Query Span ]  [ External API Span ] ---> (Yields / Awaits...)
         |                  |
         v                  v (Resumes on entirely different CPU threads!)
(Error SqlTimeout)  (Success 200 OK)
         |
[ tracing-error menangkap SpanTrace ]
         |
"Error: DB Query Failed"
 Context Spans:
   - Root Span (Trace ID: 99-xyz, uri: /login)
   - DB Query Span (table: users, connection_id: 12)
```

## Produksi-Ready Code: Tokio Instrumentasi Error Span

Kode di bawah merepresentasikan penanganan request asinkron yang melacak status context span dengan integrasi penuh pada `tracing` macros dan injeksi `SpanTrace` ke dalam custom error.

```rust
use tracing::{info, error, instrument, span, Level};
use tracing_error::{TracedError, InstrumentResult, SpanTrace};
use std::fmt;

// Dependency Setup:
// tracing = "0.1"
// tracing-subscriber = { version = "0.3", features = ["env-filter"] }
// tracing-error = "0.2"
// tokio = { version = "1", features = ["full"] }

/// Error Bisnis kita yang akan mengkapsulasi jejak SpanTrace logis.
#[derive(Debug)]
pub struct AppError {
    message: String,
    // SpanTrace akan merekam hierarki asinkron `tracing` saat error dipicu
    span_trace: SpanTrace,
}

impl std::error::Error for AppError {}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "App Error: {}", self.message)?;
        // Kita juga bisa mencetak SpanTrace secara rapi
        writeln!(f, "{}", self.span_trace)
    }
}

/// Fungsi asinkron yang diinstrumentasi.
/// Atribut #[instrument] secara otomatis akan mem-wrap seluruh blok future
/// dalam sebuah Span berlevel INFO yang memiliki field argumen fungsinya (`user_id`).
#[instrument(level = "info", skip(db_password), fields(action = "database_lookup"))]
pub async fn query_database(user_id: u32, db_password: &str) -> Result<String, AppError> {
    // Simulasi delay asinkron (Bisa di-schedule di thread mana pun)
    info!("Starting database transaction for user {}", user_id);
    
    // Anggap gagal karena network
    let network_failure = true;
    
    if network_failure {
        let err = AppError {
            message: "Connection refused from DB node".into(),
            // Tangkap hirarki span (tracing logical context) secara real-time
            span_trace: SpanTrace::capture(),
        };
        error!(error = ?err, "Database operation aborted");
        return Err(err);
    }
    
    Ok("Data record".into())
}

/// Mensimulasikan handler tokio HTTP teratas
#[instrument(name = "http_request", fields(http.method = "GET", http.url = "/api/v1/users"))]
pub async fn handler_api_request() -> Result<(), AppError> {
    // Memanggil operasi bersarang (nested span).
    // Bahkan jika ini dieksekusi concurrent dengan tokio::spawn,
    // metadata instrumentasi induk tetap mengikuti child task.
    query_database(404, "secret_password").await?;
    
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_traced_error_span_capture() {
        // Kita tidak mensetup global tracing subscriber untuk tes ringan ini,
        // Tapi kita bisa memverifikasi flow errornya
        let result = handler_api_request().await;
        assert!(result.is_err());
        
        let err = result.unwrap_err();
        // Memastikan error membungkus SpanTrace (meski kosongan di unit test murni)
        assert!(err.message.contains("Connection refused"));
    }
}
```

## Anti-Patterns

1. **Pemanggilan `tracing::Span::enter()` tanpa `Drop` Guard di Async Blok**
   **Mengapa berbahaya:** Jika Anda menggunakan kode imperatif manual `let _guard = span.enter();` di dalam blok fungsi `async fn` dan di dalam blok tersebut Anda memanggil `.await` untuk future asinkron, Guard itu akan terbawa melintasi batas context switch (Await Point). Ini mengacaukan manajemen Context Span milik thread Tokio, mencampur aduk log request milik User A kepada log request milik User B!
   **Solusi:** Untuk asinkron, gunakan atribut `#[instrument]` di atas fungsi asinkron ATAU kombinasikan dengan trait `.instrument(span)` pada akhir instance eksekusi `.await`.

2. **Instrumentasi Terhadap Fungsi CPU Tight Loop atau Sangat Panas**
   **Mengapa berbahaya:** Menyematkan `#[instrument]` pada fungsi konversi skalar matematis yang dipanggil puluhan ribu kali per detik di HFT akan memblokir CPU karena instrumentasi membuat heap memory struct span, mendaftarkannya di registry global, dan menghancurkannya. Beban "Logging overhead" akan melumpuhkan aplikasi murni karena spam log.

## Edge Cases dan Defensive Programming

1. **Memori Bocor karena Filter Subscriber yang Buruk:**
   Jika `tracing_subscriber` global dikonfigurasi untuk menangkap setiap level `TRACE` atau memegang struktur span seumur hidup (misal custom exporter open-telemetry yang tersendat network saat export gRPC), span memory struct akan bertumpuk menembus RAM server hingga OOM (Out-of-Memory). Terapkan batas retensi memori atau fallback membuang log (Drop policy) pada exporter tracer Anda.

2. **Penggunaan `.instrument()` pada spawned Tasks tokio::spawn:**
   Secara default, tokio task spawn "lepas jangkauan" dari hierarki Span tempat ia dipanggil karena ia dieksekusi secara independen. Agar log terhubung di Splunk/Datadog, Anda MUTLAK harus menghubungkannya kembali: 
   `tokio::spawn(async move { ... }.instrument(tracing::Span::current()));`

3. **Kehilangan Kredensial Sensitif di Log:**
   Atribut `#[instrument]` secara naif melog semua paramater fungsi ke dalam JSON metadata span. Jika ada parameter `api_key: String` atau `password: String`, password tersebut akan tersimpan dalam teks polos di server Elasticsearch (Log Leak Security Breach). Gunakan flag macro paramater `skip(api_key)` seperti yang dicontohkan di kode!
