# Color-Eyre Diagnostic Report & Production Crash

Mengelola panic dan crash program di Production adalah mimpi buruk bila laporan error sekadar tulisan flat di terminal tanpa format. Crate `color-eyre` dan `eyre` merupakan iterasi agresif di atas `anyhow` yang mendesain pelaporan error berfokus pada **Manusia (Human-Centric Diagnostic Reports)**, lengkap dengan stacktrace kaya, parsing backtrace canggih, korelasi isu (misal menaruh issue tracker URL otomatis), dan metadata dari custom section trait.

Ini sangat krusial dalam program CLI Rust dan Agent systems di mana User menginginkan panduan solusi langsung saat *fatal crash* terjadi, bukan sekadar core-dump biner.

## Arsitektur Diagnostic Error Rendering

```ascii
[ Panic / Err! ] -->  std::panic::set_hook() / eyre::Result 
                                |
                   [ Color-Eyre Panic Handler ]
                                |
      +-------------------------+-------------------------+
      | Capture Backtrace       | Parse OS Info           |
      | Identify Root Error     | Gather Metadata         |
      | Add "Suggestion" Header | (e.g. Issue tracker ID) |
      +-------------------------+-------------------------+
                                |
                   [ Output Terminal (ANSI Styled) ]
                   "The application crashed violently!
                   Suggestion: Ensure Docker daemon is running...
                   Location: src/main.rs:45"
```

## Produksi-Ready Code: Custom Eyre Report dengan Metadata

```rust
use color_eyre::{eyre::eyre, eyre::WrapErr, Report, Result, Section, SectionExt};
use std::env;

/// Simulasi Setup Aplikasi Produksi
pub fn install_production_crash_reporter() -> Result<()> {
    // Instalasi panic hook untuk menangkap unhandled panics 
    // dengan pesan yang human-readable.
    color_eyre::config::HookBuilder::default()
        .issue_url(concat!(env!("CARGO_PKG_REPOSITORY"), "/issues/new"))
        .add_issue_metadata("version", env!("CARGO_PKG_VERSION"))
        .add_issue_metadata("os", std::env::consts::OS)
        .install()?;
        
    Ok(())
}

/// Simulasi Fungsi yang Gagal namun Membawa Metadata Solusi Eksplisit.
/// Kita menggunakan Trait `Section` dari color-eyre untuk menyuntikkan
/// teks saran teknis langsung ke print-out error.
pub fn load_system_config(filepath: &str) -> Result<String> {
    if !filepath.ends_with(".yaml") {
        return Err(eyre!("Configuration file must be a YAML formatted file"))
            // Menambahkan catatan yang dicetak di bawah error
            .note("We migrated from .json to .yaml since v2.0")
            // Menambahkan string "Suggestion" dengan tebal di terminal
            .suggestion("Run `app config migrate` to convert your old JSON file")
            // Menambahkan debug value dari param
            .with_section(|| format!("{}", filepath).header("Given Filepath:"));
    }
    
    // Simulasi IO failure murni
    std::fs::read_to_string(filepath)
        .wrap_err("Failed to perform I/O read on system configuration")
        .suggestion("Check if you have root permission to access /etc/")
}

pub fn app_run() -> Result<()> {
    let _cfg = load_system_config("/etc/app/config.json")
        .wrap_err("Application boot process failed early")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_diagnostic_report_sections() {
        // Abaikan instalasi hook di test karena hanya boleh di-install sekali
        let err_report = load_system_config("config.json").unwrap_err();
        
        let report_str = format!("{:?}", err_report);
        // Memastikan eyre report memasukkan metadata Section kita dengan benar
        assert!(report_str.contains("Given Filepath:"));
        assert!(report_str.contains("config.json"));
        assert!(report_str.contains("migrate` to convert"));
    }
}
```

## Anti-Patterns

1. **Memanggil `color_eyre::install()` berulang kali di multi-thread**
   **Mengapa berbahaya:** `install()` mendaftarkan global panic hook dan memory handler. Memanggilnya dua kali (misalnya di dalam inisialisasi Worker pool per-thread) akan memicu panic di dalam panic handler itu sendiri (Panic in panic loop), mengakibatkan proses crash keras (Abort) dengan core-dump fatal dan memutus aplikasi seketika tanpa mencetak satu log pun.
   **Solusi:** Panggil `install()` murni SATU kali di baris pertama blok `fn main()`.

2. **Memaksa `unwrap()` pada Production Path tanpa `WrapErr`**
   **Mengapa berbahaya:** Jika Anda menggunakan `color_eyre` namun tetap memakai `.expect("...")` di librari atau di dalam `app_run()`, stack trace akan ditangkap tapi tidak merangkai root error yang anggun. Eyre bersinar ketika Anda merangkai rantai dengan `.wrap_err()`. Menggunakan panic murni menghindari arsitektur Report Section yang kita desain (misal, tidak ada metadata `.suggestion()`).

## Edge Cases dan Defensive Programming

1. **Tidak Ada TTY / CI Output:**
   Ketika aplikasi Rust Anda di-deploy dalam container Kubernetes atau di Gitlab CI yang tidak mendukung output ANSI color, panic hook `color-eyre` bisa saja mengirim deretan kode `\x1b[31m` yang sangat kotor ke Kibana/Datadog logs system. Pastikan `color_eyre` terkonfigurasi untuk mematikan warna (Theme removal) secara otomatis via deteksi `atty::is(Stream::Stderr)` atau environment var `NO_COLOR=1`.

2. **Memory Overload saat Backtrace Parsing Berjalan:**
   Mem-parsing nama fungsi dari instruksi binary debug DWARF sangat intensif dan lambat. Jika aplikasi Anda adalah web server dengan 10_000 Request/second, dan Anda memunculkan Eyere Report (yang mengekstrak backtrace penuh) pada setiap error 404 (Not Found), CPU akan mencapai 100% karena parsing simbol debug, mematikan (DDoS) server Anda sendiri. Gunakan Eyre/Backtrace HANYA pada Crash/Panic fatal tingkat 500, bukan kontrol aliran bisnis reguler!

3. **Kehilangan Context dalam `tokio::spawn` Task:**
   Jika sebuah sub-task tokio mengalami unhandled error, Task tersebut hanya mati secara senyap, sementara Main runtime berjalan terus. Jika task tidak mengembalikan result dan Anda gagal `.await` dan meng-unwrap *JoinError*-nya, panic hook color_eyre mungkin tidak terhubung sempurna dan Report hilang tertelan void. Selalu gunakan helper pattern penanganan abort untuk task spawn!
