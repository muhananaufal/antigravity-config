# `anyhow`: Type-Erased Error Chaining & Context

## 1. Konsep Utama & Kapan Digunakan
`anyhow::Error` adalah tipe error berbasis trait object (`Box<dyn std::error::Error>`) yang telah dioptimasi dan sangat ergonomis. Ia menghapus tipe asli dari error (type erasure), namun memungkinkan Anda untuk dengan mudah menambahkan string context (seperti breadcrumbs) ke stack error tersebut.

Gunakan `anyhow` ketika:
- Anda membuat aplikasi *binary* (CLI, Web Server endpoint handler), BUKAN library publik.
- Pemanggil (caller) tidak peduli dengan jenis error spesifik dan tidak akan melakukan percabangan `match` untuk me-recover dari error.
- Tujuan utamanya adalah melaporkan error ke end-user atau logging system dengan trace sedetail mungkin ("gagal melakukan A, karena B, disebabkan oleh C").

## 2. Arsitektur / Flow

```ascii
[ io::Error (File not found) ] 
        |
        +-- .with_context(|| "Failed to read config file")
        v
[ anyhow::Error ] 
        |
        +-- .context("Failed to initialize server application")
        v
[ anyhow::Error (Printed at main) ]
Error: Failed to initialize server application
Caused by:
    0: Failed to read config file
    1: No such file or directory (os error 2)
```

## 3. Kode Rust Production-Ready

```rust
use anyhow::{Context, Result, bail, ensure};
use std::path::Path;

#[derive(serde::Deserialize)]
struct Config {
    port: u16,
    log_level: String,
}

/// Fungsi aplikasi yang menggunakan anyhow::Result.
/// Tipe Result ini ekuivalen dengan std::result::Result<T, anyhow::Error>
fn load_app_config(path: impl AsRef<Path>) -> Result<Config> {
    let path = path.as_ref();
    
    // bail! makro ekuivalen dengan return Err(anyhow!("..."))
    if !path.exists() {
        bail!("Configuration path does not exist: {}", path.display());
    }

    // .with_context dievaluasi lazily (closure), cocok untuk path.display()
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read raw bytes from {}", path.display()))?;

    // .context dievaluasi langsung (eager), aman untuk string literal
    let config: Config = serde_json::from_str(&content)
        .context("Configuration file contains invalid JSON schema")?;

    // ensure! makro mirip dengan assert!, namun me-return error alih-alih panic
    ensure!(
        config.port > 1024,
        "Port must be greater than 1024, got {}", 
        config.port
    );

    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_port_validation() {
        let content = r#"{"port": 80, "log_level": "info"}"#;
        // Mocking file behavior omitted for brevity
        // ...
    }
}
```

## 4. Anti-Pattern Spesifik
1. **Menggunakan `.context()` dengan kalkulasi alokasi string yang mahal.**
   - *Bahaya*: `.context(format!("..."))` akan mengevaluasi dan mengalokasikan string `format!` *walaupun* fungsi berhasil (`Ok`). Ini membuang CPU cycle di happy path (hot path).
   - *Solusi*: Selalu gunakan `.with_context(|| format!("..."))` jika string context memerlukan alokasi.
2. **Mengembalikan `anyhow::Result` di public API library.**
   - *Bahaya*: Konsumen library tidak bisa mengambil aksi spesifik (misal: retry saat `TimeoutError`) tanpa melakukan string matching pada error, yang sangat rapuh (brittle).
   - *Solusi*: Gunakan `thiserror` untuk library, `anyhow` murni untuk aplikasi akhir.

## 5. Edge Cases & Defensive Programming
- **Downcasting**: Jika pada suatu titik langka Anda benar-benar butuh melihat tipe error aslinya, `anyhow::Error` mendukung downcasting melalui method `.downcast_ref::<T>()`.
- **Ecosystem compat**: Pastikan Anda mengaktifkan feature `backtrace` jika Anda ingin mengcapture stack traces penuh secara otomatis saat error dibuat, sangat krusial untuk CLI yang crash dengan error rumit.
