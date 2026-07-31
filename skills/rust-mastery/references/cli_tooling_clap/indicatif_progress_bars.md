# `indicatif` Progress Bars

## Konsep Utama
`indicatif` adalah library terbaik untuk menampilkan bar progres (progress bars) di terminal Rust. Fitur kuncinya meliputi pembuatan bar tunggal maupun `MultiProgress` bar, kalkulasi perhitungan sisa waktu (ETA), pengukuhan spinner, dan integrasi mulus dengan macro logging dan runtime asinkron (Tokio). Ini sangat vital untuk memberikan feedback pada tool CLI yang melakukan long-running tasks.

## Arsitektur & Flow
```ascii
[Task Worker 1] --update()--> [ProgressBar 1]
                                     | (Draws to)
[Task Worker 2] --update()--> [ProgressBar 2]
                                     |
                                     v
                          [MultiProgress Tracker] -> [Terminal TTY]
```

## Production-Ready Code
```rust
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use std::time::Duration;
use std::sync::Arc;
use tokio::task;

pub async fn run_concurrent_downloads() -> Result<(), Box<dyn std::error::Error>> {
    let m = MultiProgress::new();
    
    let style = ProgressStyle::with_template(
        "[{elapsed_precise}] {bar:40.cyan/blue} {pos:>7}/{len:7} {msg} [{eta_precise}]"
    )?.progress_chars("##-");

    let mut handles = vec![];

    for i in 0..3 {
        // Buat bar baru, tambahkan ke tracker multiprogress
        let pb = m.add(ProgressBar::new(100));
        pb.set_style(style.clone());
        pb.set_message(format!("File #{}", i));

        let h = task::spawn(async move {
            for j in 0..100 {
                // Simulasi network I/O
                tokio::time::sleep(Duration::from_millis(50)).await;
                pb.inc(1);
            }
            pb.finish_with_message(format!("File #{} Done", i));
        });
        handles.push(h);
    }

    // Tunggu semua task selesai
    for h in handles {
        h.await?;
    }
    
    // Clear the tracker from the terminal once done
    m.clear()?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_style_compilation() {
        let style = ProgressStyle::with_template(
            "[{elapsed_precise}] {bar:40.cyan/blue} {pos:>7}/{len:7} {msg}"
        );
        assert!(style.is_ok(), "Template progress bar tidak valid");
    }
}
```

## Anti-Patterns
1. **Pencetakan (print!/println!) saat Progress Bar Aktif**: 
   *Mengapa Berbahaya:* Jika Anda memanggil macro standar print, output teks tersebut akan menimpa dan memecah rendering bar progress, mengakibatkan "ghost bars" (artefak rendering berantakan). Gunakan `ProgressBar::println()` atau `MultiProgress::println()` untuk mencetak di atas bar tanpa merusaknya.
2. **Cloning `ProgressBar` berlebihan dalam loop**:
   *Mengapa Berbahaya:* `ProgressBar` menggunakan internal arc/mutex. Mem-clone itu aman, tapi update frekuensi yang terlalu ekstrim di loop ketat tanpa mem-batch (misalnya `pb.inc(1)` setiap 1 nanodetik) akan menyebabkan lock contention dan bottleneck CPU yang parah.

## Edge Cases & Defensive Programming
- **Progress Tracking di CI (Non-TTY)**: Secara otomatis, indicatif tidak akan menggambar apa-apa jika lingkungan mendeteksi CI atau non-TTY environment (seperti redirection ke file). Namun, di beberapa tool, template masih bisa bocor. Pertimbangkan flag `.is_hidden()` yang mengembalikan true di kondisi tersebut.
- **Template Errors**: Macro template indicatif parse pada run-time. Validasi template string secara ketat di unit test agar CLI tidak panic sesaat sebelum memulai proses.
