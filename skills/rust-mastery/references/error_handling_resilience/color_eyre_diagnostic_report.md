# `color-eyre`: Diagnostic & Panic Reporting

## 1. Konsep Utama & Kapan Digunakan
Sementara `anyhow` bagus untuk context chaining sederhana, `color-eyre` adalah versi "steroid" yang didesain untuk pelaporan error konsol tingkat dewa. Ia menangkap backtrace penuh, SpanTrace (dari crate `tracing-error`), environment data, panic message, lalu memformatnya dalam terminal UI yang penuh warna dan terstruktur rapi.

Gunakan `color-eyre` (atau varian stabilnya `stable-eyre`) ketika:
- Membangun CLI tool (Command Line Interface).
- Aplikasi memiliki developer/operator lokal yang membaca `stderr`/log dan membutuhkan petunjuk diagnostik mendalam untuk membedakan kesalahan setup (salah variabel environment, izin file) dari bug kode.

## 2. Arsitektur / Flow

```ascii
[ Panic / Err! ]
       | (Di-capture oleh Eyre Handler / Panic Hook)
       v
[ Kumpulkan Konteks ] ---> Backtrace OS (Thread call stack)
                      ---> SpanTrace (Tracing boundaries)
                      ---> Sugesti / Custom Sections
       |
       v
[ Console Output (Colorful, Structured) ]
```

## 3. Kode Rust Production-Ready

```rust
use color_eyre::{
    eyre::{eyre, WrapErr},
    Result, Section,
};
use std::env;

/// Konfigurasi handler global di awal fungsi `main`.
pub fn setup_eyre() -> Result<()> {
    // Instalasi panic hook & error reporter
    color_eyre::install()?;
    Ok(())
}

fn read_api_key() -> Result<String> {
    env::var("APP_API_KEY")
        // WrapErr ekuivalen dengan .context() milik anyhow
        .wrap_err("Failed to read the API Key from environment")
        // Section mengizinkan penambahan saran/dokumentasi ke terminal output!
        .suggestion("Did you forget to source your .env file or export APP_API_KEY?")
        .with_note(|| format!("Current environment count: {}", env::vars().count()))
}

pub fn run_cli_app() -> Result<()> {
    let _api_key = read_api_key()?;
    
    // ... complex logic ...
    
    // eyre! makro ekuivalen anyhow! untuk me-return ad-hoc error
    Err(eyre!("Application encountered unrecoverable state"))
        .suggestion("Please report this bug to github.com/my-org/app/issues")
}

// fn main() -> Result<()> {
//     setup_eyre()?;
//     run_cli_app()
// }
```

## 4. Anti-Pattern Spesifik
1. **Menggunakan `color-eyre` di dalam library crate (bukan binary/executable).**
   - *Bahaya*: Library Anda memaksa konsumen akhir menginstal global handler `color-eyre`, mengubah cara seluruh aplikasi konsumen menangani panic/error.
   - *Solusi*: Hanya gunakan `color-eyre` atau install hook di crate level `bin` (executable `main.rs`). Library tetap menggunakan `thiserror`.
2. **Membiarkan `.env` file terbaca secara tersembunyi.**
   - *Bahaya*: Output panic membeberkan terlalu banyak info environment yang mungkin memuat secret.
   - *Solusi*: Kontrol visibilitas trace dengan environment flag (misal `RUST_BACKTRACE=1`), jangan ekspose sensitif section by default di production release, `color_eyre` lebih diperuntukkan CLI tooling.

## 5. Edge Cases & Defensive Programming
- **Hook Conflicts**: Memanggil `color_eyre::install()` dua kali akan menyebabkan error. Pastikan handler ini di-setup persis sekali di paling atas fungsi `main()`.
- **Custom Section**: Memanfaatkan trait `Section` (`suggestion`, `note`, `warning`) akan sangat mengurangi tiket support dari user. Jika ada file config hilang, berikan link dokumentasi di `suggestion`.
- **`stable-eyre`**: Jika Anda menargetkan versi Rust stable murni tanpa fitur nightly (biasanya backtrace UI butuh API lebih baru), Anda mungkin perlu bergantung pada konfigurasi fallback. `color-eyre` sudah cukup baik menangani fallback, namun test kompilasi Anda.
