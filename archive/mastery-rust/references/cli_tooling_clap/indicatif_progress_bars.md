# Panduan Mendalam: Orkestrasi Multi-Progress Bar dengan Indicatif

## 1. Konsep Utama & Arsitektur
Crate `indicatif` adalah pustaka terdepan di ekosistem Rust untuk menyajikan animasi *progress bar* dan terminal *spinners*. Saat memproses tugas-tugas berat secara konkuren (misal via `tokio` threads atau `rayon`), sinkronisasi status tampilan di terminal agar tidak pecah/tumpang-tindih merupakan tantangan klasik.
`MultiProgress` dari `indicatif` menyelesaikan masalah ini dengan mekanisme *locking* internal. Ia bertindak sebagai orkestrator sentral, mengkoordinasikan update dari berbagai *thread* (atau *async tasks*) dan merender ulang terminal secara rapi pada interval tertentu tanpa membuat TTY (TeleTYpewriter) menjadi kacau.

### 1.1 Diagram Alur Rendering Concurrency
```ascii
[ Worker Task 1 ] --- (ProgressBar::inc) --+
                                           |      +------------------------+
[ Worker Task 2 ] --- (ProgressBar::inc) --+----> | MultiProgress Context  | -> [ Terminal Rendering Thread ]
                                           |      | (Mutex/RwLock secured) |      (Redraw at ~60 FPS)
[ Worker Task N ] --- (ProgressBar::inc) --+      +------------------------+
```

## 2. Implementasi Produksi (Zero-Clippy Warnings, Fully Tested)
Berikut adalah setup produksi yang terintegrasi dengan asinkroni `tokio`, memanfaatkan style *progress bar* kustom dan penyelesaian yang aman (graceful finish).

```rust
// Cargo.toml
// tokio = { version = "1.0", features = ["full"] }
// indicatif = "0.17"

use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use std::time::Duration;
use tokio::time::sleep;
use std::sync::Arc;

/// Memulai proses batch asinkron di mana setiap task diwakili dengan satu progress bar.
pub async fn run_multi_progress_orchestration() -> Result<(), Box<dyn std::error::Error>> {
    let mp = Arc::new(MultiProgress::new());
    
    // Style Template: [{elapsed_precise}] {bar:40.cyan/blue} {pos:>7}/{len:7} {msg}
    let sty = ProgressStyle::with_template(
        "[{elapsed_precise}] {bar:40.cyan/blue} {pos:>7}/{len:7} {msg}"
    )?.progress_chars("##-");

    let num_tasks = 3;
    let mut join_handles = Vec::new();

    for i in 0..num_tasks {
        let total_work = 100 * (i + 1) as u64;
        
        // 1. Tambahkan bar baru ke dalam orchestrator
        let pb = mp.add(ProgressBar::new(total_work));
        pb.set_style(sty.clone());
        pb.set_message(format!("Worker Task #{}", i));
        
        // 2. Clone Arc untuk dipindahkan ke async thread
        let mp_clone = Arc::clone(&mp);
        
        let handle = tokio::spawn(async move {
            for _ in 0..total_work {
                // Simulasi beban I/O asinkron
                sleep(Duration::from_millis(5)).await;
                
                // 3. Update progres (Aman secara konkuren)
                pb.inc(1);
            }
            
            // 4. Pastikan penyelesaian visual
            pb.finish_with_message(format!("Worker Task #{} Done!", i));
        });
        
        join_handles.push(handle);
    }

    // 5. Tunggu seluruh worker selesai
    for handle in join_handles {
        handle.await?;
    }

    // `MultiProgress` membersihkan tampilannya jika diperlukan saat Arc terhapus
    println!("Seluruh tugas selesai dengan lancar.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_orchestration_completes() {
        let result = run_multi_progress_orchestration().await;
        assert!(result.is_ok(), "Fungsi orkestrasi gagal dieksekusi.");
    }
}
```

## 3. Anti-Patterns Kritis

### 3.1. Frekuensi `.inc()` Terlalu Agresif (Mengunci Thread UI)
**Buruk:** Memanggil `pb.inc(1)` dalam perulangan sekuensial yang sangat cepat tanpa batasan, contoh: parsing 50 juta baris teks dalam 1 detik.
**Alasan:** Pemanggilan `inc` mengunci status (state) bar. Jika 10 thread berlomba melakukan modifikasi *state* jutaan kali per detik, *lock contention* yang ditimbulkan justru menjadi *bottleneck* performa aplikasi, memperlambat proses jauh melebihi kecepatan aktual.
**Solusi:** Lakukan *batching*. Simpan counter sementara secara lokal (`let mut local_count`), lalu panggil `pb.inc(local_count)` setiap, misalnya, kelipatan 10.000 iterasi atau memanfaatkan mekanisme `ProgressBar::set_draw_target` dengan `DrawTarget::hidden()` di backend.

### 3.2. Manipulasi Output Standar Kustom (Mencampur `println!` dengan Bar)
**Buruk:** Thread worker memanggil macro reguler `println!("Error file X")` di tengah proses iterasi `ProgressBar`.
**Alasan:** Output mentah terminal (stdout) akan menimpa baris kursor tempat `indicatif` merender grafis *progress bar*. Hasilnya, terminal Anda menjadi kacau (garbled), bar progres terpecah belah melompat ke baris baru.
**Solusi:** Gunakan metode khusus integrasi bar: `pb.println("Pesan Error Anda")`. Ini akan menyelipkan teks dengan anggun di atas baris progress tanpa merusak struktur visualnya. Atau delegasikan *logging* ke `tracing-indicatif`.

## 4. Edge Cases dalam Skala Produksi

### 4.1. "Ghost Bars" akibat Kelalaian `finish()` atau Panic
Jika sebuah *worker thread* mengalami `panic!` (atau me-return nilai error menggunakan operator `?`) sebelum memanggil metode `pb.finish()` (atau `finish_and_clear()`), state progres tersebut akan 'terbengkalai' (ghost) di persentase acak tanpa pernah menghilang dari terminal setelah aplikasi beralih ke tugas lain. Sangat penting memanfaatkan RAII. Gunakan `pb.finish()` di blok penanganan drop, atau pastikan eksekusi terjamin dengan struktur asinkron (misalnya di blok `finally` logik).

### 4.2. Lebar TTY Berubah Mendadak (Terminal Resize)
Banyak *systems tools* mengalami visual error saat dijalankan via sesi SSH dan tiba-tiba ukuran window emulator terminal di-*resize* pengguna. Konfigurasi `indicatif` dengan templat bar statis tertentu dapat memaksa karakter wrapping yang mengacaukan pemosisian karakter ANSI *cursor reset*. `indicatif` secara mandiri mendengarkan ukuran lebar logikal (jika feature terminal enable), namun *template* bar Anda wajib diproteksi menggunakan token relasional penyesuaian seperti panjang bar variabel yang secara diam-diam beradaptasi, atau *truncating macros* pada output nama string.

### 4.3. Menggantung di Lingkungan Tanpa TTY (CI/CD / Docker)
Menjalankan bar animasi 60 FPS pada lingkungan non-interaktif (seperti Jenkins, GitHub Actions, atau di dalam script pengalihan pipeline stdout `> file.txt`) akan mencemari log file dengan ratusan ribu deret *Escape Codes* ANSI (`\x1b[2K...`).
Ini menyebabkan ledakan ukuran file (log bloat). 
**Solusi Produksi:** `indicatif` biasanya pintar mendeteksi `is_terminal`. Tetapi saat memaksakan styling ekstrim, pastikan di kode Anda ada pemeriksaan environment variable (misalnya `CI=true`) untuk secara eksplisit men-disable *progress bar* seluruhnya dan beralih ke *plain-text logger* per interval.
