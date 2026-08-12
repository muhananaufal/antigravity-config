# Cargo Nextest CI Acceleration: Arsitektur Pengujian Paralel Kecepatan Maksimal

Eksekusi pengujian (testing) di ekosistem Rust secara default menggunakan `cargo test`. Walaupun solid, arsitektur bawaan `cargo test` memiliki keterbatasan performa saat berhadapan dengan workspace atau monorepo besar karena penanganan multithreading-nya terbatas pada level thread tunggal di dalam binary test, bukan memparalelkan isolasi antar-test secara menyeluruh ke level proses. Inilah alasan mengapa **`cargo-nextest`** menjadi standar industri de facto untuk orkestrasi CI skala besar. `nextest` menawarkan model eksekusi per-proses yang diisolasi, pelaporan real-time, dan manajemen *flakiness* otomatis.

## Arsitektur Eksekusi cargo-nextest vs cargo test

```ascii
========================================================================================
[cargo test] - Arsitektur Threading Bawaan
----------------------------------------------------------------------------------------
Test Binary 1 (Thread Pool)
 ├── Test A (Thread 1) ──> Panics? ──> Bisa merusak stdout/stderr test lain
 ├── Test B (Thread 2)
 └── Test C (Thread 3)

[cargo-nextest] - Arsitektur Multi-Proses & Isolasi
----------------------------------------------------------------------------------------
Nextest Runner (Orchestrator)
 ├── Proses 1: Test A (Isolasi memori & stdout, status exit independen)
 ├── Proses 2: Test B
 └── Proses 3: Test C

+----------------+    +----------------+    +--------------------+
| CI Environment | -> | nextest config | -> | JUnit XML Exporter | -> [ CI Dashboard ]
+----------------+    +----------------+    +--------------------+
========================================================================================
```

Arsitektur isolasi proses memastikan bahwa memori yang bocor atau status global yang kotor dari satu pengujian tidak memengaruhi pengujian lainnya.

## Konfigurasi Lanjutan: `.config/nextest.toml`

Konfigurasi ini dirancang untuk mendefinisikan grup eksekusi berat dan strategi pengulangan otomatis (*auto-retries*) untuk tes integrasi yang rapuh.

```toml
# File: .config/nextest.toml

[profile.default]
# Secara default, ulangi tes yang gagal 1 kali untuk menangani flakiness jaringan/waktu
retries = 1
# Tampilkan stdout dan stderr segera saat tes gagal
failure-output = "immediate"
# Jangan batasi concurrency secara kaku, gunakan jumlah core logika, namun sisakan ruang
max-connections = "default"

[profile.ci]
# Di CI, kita lebih agresif dengan retry untuk integrasi, namun lebih teliti.
retries = { backoff = "exponential", count = 3, delay = "1s", max-delay = "10s" }
failure-output = "immediate-final"
# Simpan laporan sebagai JUnit
junit = { path = "target/nextest/ci/junit.xml" }

# Mengisolasi test berat (seperti E2E atau manipulasi database) agar tidak membebani CPU
[[profile.ci.overrides]]
filter = 'test(heavy_integration)'
threads-required = 4
retries = 2

# Membatasi test yang membutuhkan akses jaringan yang mungkin ter-rate-limit
[test-groups]
network_heavy = { max-threads = 2 }

[[profile.ci.overrides]]
filter = 'test(network_)'
test-group = 'network_heavy'
```

## Integrasi CI/CD: GitHub Actions YAML

Pipeline ini mengonfigurasi instalasi `nextest`, mengeksekusi test dalam profil CI, dan mengunggah hasil JUnit.

```yaml
# File: .github/workflows/nextest-ci.yml
name: "Nextest CI Pipeline"

on:
  push:
    branches: ["main"]
  pull_request:

jobs:
  test:
    name: "Cargo Nextest Parallel Execution"
    runs-on: ubuntu-latest
    steps:
      - name: "Checkout Code"
        uses: actions/checkout@v4

      - name: "Setup Rust Toolchain"
        uses: dtolnay/rust-toolchain@stable

      - name: "Cache Rust Dependencies"
        uses: Swatinem/rust-cache@v2

      - name: "Install Cargo Nextest"
        uses: taiki-e/install-action@nextest

      - name: "Run Tests with Nextest"
        run: cargo nextest run --profile ci --workspace --all-features
        env:
          # Variabel lingkungan standar untuk tuning Rust CI
          RUST_BACKTRACE: 1
          CARGO_TERM_COLOR: always

      - name: "Upload Test Results"
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: nextest-junit-report
          path: target/nextest/ci/junit.xml

      - name: "Publish Test Report"
        if: always()
        uses: mikepenz/action-junit-report@v4
        with:
          report_paths: 'target/nextest/ci/junit.xml'
```

## Unit / Verification Test (Mekanisme Penegakan)

Berikut adalah skrip untuk memastikan dependensi dan profil `nextest` tidak berubah di CI tanpa tinjauan.

```rust
// File: xtask/src/verify_nextest.rs
use std::fs;
use std::process::Command;

pub fn verify_nextest_configuration() {
    let config_path = ".config/nextest.toml";
    
    // Pastikan konfigurasi nextest ada
    assert!(
        fs::metadata(config_path).is_ok(),
        "FATAL: Konfigurasi .config/nextest.toml hilang dari repositori!"
    );

    let config_content = fs::read_to_string(config_path).expect("Gagal membaca config");
    
    // Verifikasi keberadaan pengaturan CI yang krusial
    assert!(
        config_content.contains("[profile.ci]"),
        "Profil CI tidak ditemukan di nextest.toml"
    );
    assert!(
        config_content.contains("junit ="),
        "Ekspor laporan JUnit wajib dikonfigurasi di profil CI"
    );
    
    // Verifikasi eksekusi dengan dry-run
    let status = Command::new("cargo")
        .args(&["nextest", "run", "--profile", "ci", "--dry-run"])
        .status()
        .expect("Gagal menjalankan cargo nextest dry-run");
        
    assert!(status.success(), "Nextest dry-run gagal, periksa konfigurasi!");
    
    println!("✅ Verifikasi Nextest CI Configuration Lulus!");
}
```

## ❌ vs ✅ Anti-Patterns

### Anti-Pattern 1: Mengabaikan Isolasi State Database
**❌ Salah:** Menggunakan database tunggal untuk semua tes secara paralel dengan status global. Saat `nextest` mengeksekusi secara terpisah, terjadi race-condition di tabel database.
```rust
// ❌ BAD: Memodifikasi state global yang diakses paralel
#[test]
fn test_user_creation() {
    DB::clear_users();
    DB::insert_user("alice");
    assert_eq!(DB::count(), 1); // Akan flaky jika tes lain memasukkan "bob"
}
```

**✅ Benar:** Menggunakan skema, transaksi terisolasi (rollback), atau Testcontainers untuk setiap proses nextest.
```rust
// ✅ GOOD: Isolasi per tes atau transaksi yang otomatis di-rollback
#[tokio::test]
async fn test_user_creation() {
    let mut tx = DB::begin_transaction().await;
    tx.insert_user("alice").await;
    assert_eq!(tx.count().await, 1);
    tx.rollback().await; // Perubahan diisolasi
}
```

### Anti-Pattern 2: Ketergantungan Output Standar (stdout)
**❌ Salah:** Mengasumsikan stdout dicetak berurutan, atau mencoba parsing stdout dari `println!` yang dieksekusi proses lain. `cargo test` biasanya menangkap ini, tetapi di `nextest`, stdout sepenuhnya terisolasi per proses dan hanya ditampilkan saat selesai/gagal.
**✅ Benar:** Gunakan mekanisme logging terstruktur (`tracing`) dengan writer yang thread/process-safe, dan simpan dalam file terpisah jika analisis pasca-eksekusi diperlukan.

## ⚠️ Production Edge Cases

1. **Race Condition dalam Alokasi Port Dinamis (Port Binding Conflicts):**
   Saat 20 proses test E2E spawn server web bersamaan.
   *Solusi:* Alih-alih hardcode port `8080`, mintalah OS untuk port acak dengan mengikat listener ke `127.0.0.1:0`, lalu ambil port yang ditetapkan dan teruskan ke test client.

2. **OOM (Out Of Memory) Killed oleh CI Runner:**
   Jika tes membutuhkan banyak RAM (misal memuat model ML besar), menjalankan *logical cores* jumlah maksimum proses akan membuat CI kehabisan memori.
   *Solusi:* Konfigurasikan `threads-required = 2` atau gunakan `test-groups` di `nextest.toml` untuk mengatur laju konkurensi (rate limit) tes yang berat memorinya.

3. **Inkonsistensi Timer/Sleep pada Test Flaky:**
   Di lingkungan CI yang padat, thread bisa di-suspend lebih lama dari durasi `tokio::time::sleep(10ms)`. Test yang mengandalkan sleep akan rapuh.
   *Solusi:* `nextest` auto-retry membantu (dengan `retries = 3`), tetapi solusi utama adalah menggunakan `tokio::time::pause()` atau polling (seperti makro `assert_eventually!`) alih-alih sleep absolut.
