# `tracing` Structured Logging

## Konsep Utama
`tracing` adalah framework instrumentasi untuk aplikasi Rust yang berfokus pada asynchrony dan logging terstruktur (structured logging). Dibandingkan macro standar seperti `log::info!`, `tracing` memiliki konsep *Spans* yang merekam rentang waktu pelaksanaan tugas. Ia mendukung propagasi konteks lintas task Tokio, menjadikannya standar esensial untuk mengidentifikasi bottleneck dan tracing request dalam distributed systems maupun aplikasi CLI kompleks.

## Arsitektur & Flow
```ascii
[ #[instrument] / tracing::info! ] -> [Event/Span Data]
         |
         v
[tracing-core (Dispatcher)]
         |
         v
[tracing-subscriber (Registry)] -> [EnvFilter (RUST_LOG="info")]
         |
         +--> [FmtLayer (Console text)]
         +--> [JsonLayer (File/Logstash)]
```

## Production-Ready Code
```rust
use std::time::Duration;
use tracing::{debug, error, info, instrument, span, Level};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

/// Inisialisasi subscriber global dengan dukungan JSON atau Console
pub fn init_telemetry(json_format: bool) {
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,my_app=debug"));

    if json_format {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(fmt::layer().json().with_current_span(true))
            .init();
    } else {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(fmt::layer().with_ansi(true).with_target(false))
            .init();
    }
}

#[instrument(skip(sensitive_data), fields(task_id = %id))]
pub async fn process_job(id: u64, sensitive_data: &str) -> Result<(), String> {
    info!("Memulai proses job");
    
    let db_span = span!(Level::DEBUG, "database_operation");
    let _enter = db_span.enter();
    
    debug!("Mengambil data...");
    tokio::time::sleep(Duration::from_millis(50)).await; // Simulasi IO
    
    // Keluar dari context span db explicitly (atau akan otomatis saat dropped)
    drop(_enter); 

    if id == 0 {
        error!("ID 0 tidak valid");
        return Err("Invalid ID".to_string());
    }

    info!(job_status = "success", "Proses job selesai");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    
    // Unit test tracing output secara langsung sulit,
    // kita memverifikasi bahwa logika utamanya tidak error.
    #[tokio::test]
    async fn test_process_job() {
        // init_telemetry(false); // Jangan diinit di test secara global agar tidak conflict
        let result = process_job(1, "secret_token").await;
        assert!(result.is_ok());
    }
    
    #[tokio::test]
    async fn test_process_job_fail() {
        let result = process_job(0, "secret").await;
        assert!(result.is_err());
    }
}
```

## Anti-Patterns
1. **Tidak melewatkan parameter sensitif di `#[instrument]`**: 
   *Mengapa Berbahaya:* Jika argumen seperti token atau password otomatis dilog, hal ini menimbulkan celah keamanan. Selalu gunakan `skip(password)` pada macro.
2. **Menahan Guard Span melintasi `.await`**:
   *Mengapa Berbahaya:* Jika kita menyimpan `span.enter()` guard dan melakukan `await`, span tersebut akan tercampur dengan eksekusi concurrent lainnya di thread yang sama pada tokio worker. Gunakan `.instrument(span)` pada future, atau macro `#[instrument]` yang otomatis menangani ini.

## Edge Cases & Defensive Programming
- **Performa vs Verbosity**: Logging dalam level `TRACE` pada hot path sangat mempengaruhi throughput (terutama pengalokasian memori untuk field struct). Gunakan filter dinamis via `EnvFilter` untuk membatasinya pada runtime.
- **Inisialisasi Ganda**: Pemanggilan `tracing_subscriber::registry().init()` dua kali akan menyebabkan panic. Definisikan inisialisasi pada bootstrap aplikasi (e.g., awal dari `main`).
