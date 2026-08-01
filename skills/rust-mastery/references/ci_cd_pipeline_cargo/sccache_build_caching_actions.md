# Sccache Build Caching & GitHub Actions: Memangkas Durasi Kompilasi

Kompilasi Rust terkenal lambat karena arsitektur LLVM monomorphization dan analisis peminjaman (borrow checker) yang kompleks. Untuk lingkungan Continuous Integration (CI), mengkompilasi dependensi pihak ketiga (krat dari `crates.io`) berulang kali pada setiap eksekusi adalah pemborosan waktu dan biaya komputasi yang masif. **`sccache`** (C/C++ and Rust compiler cache) mirip dengan `ccache` tetapi mendukung penyimpanan cloud terdistribusi (Amazon S3, GCS, Redis, atau GitHub Actions Cache API).

## Arsitektur Caching Sccache Terdistribusi

```ascii
=============================================================================================
                       [ CI Runner A (PR #101) ]       [ CI Runner B (PR #102) ]
                             |             ^                 |             ^
                         Cache Miss    Cache Hit         Cache Miss    Cache Hit
                             v             |                 v             |
                         +---------------------------------------------------+
                         |                   sccache deamon                  |
                         +---------------------------------------------------+
                                         |                   ^
                                      PUT / GET          PUT / GET
                                         v                   |
+-------------------+            +-------------------------------------------+
| GitHub Actions    |   <----    | S3 Bucket / GHA Cache Backend (Remote)    |
| Cache API (GHA)   |            | (Menyimpan Object Files `.o` & `.rmeta`)  |
+-------------------+            +-------------------------------------------+
=============================================================================================
```

Sccache menengahi panggilan ke `rustc`. Jika hash dari input sumber (file `.rs`, flags compiler, environment) cocok dengan yang ada di remote cache, ia langsung mengunduh hasil biner tanpa mengaktifkan compiler LLVM.

## Konfigurasi GitHub Actions & Sccache S3 Backend

Skrip CI berikut mengimplementasikan `sccache` dengan memanfaatkan Action resmi Mozilla dan konfigurasi backend Amazon S3 (atau setara dengan minio) untuk cache silang yang persisten.

```yaml
# File: .github/workflows/sccache-ci.yml
name: "Optimized Sccache Build CI"

on:
  push:
    branches: ["main"]
  pull_request:

env:
  # Konfigurasi Rust untuk sccache
  RUSTC_WRAPPER: "sccache"
  # Sccache Configuration (AWS S3 Backend)
  SCCACHE_BUCKET: "my-rust-ci-cache"
  SCCACHE_REGION: "us-east-1"
  SCCACHE_ENDPOINT: "s3.us-east-1.amazonaws.com"
  SCCACHE_S3_KEY_PREFIX: "ci-cache"
  # Gunakan GHA Cache API jika S3 tidak tersedia (opsi alternatif)
  # SCCACHE_GHA_ENABLED: "true"

jobs:
  build_and_test:
    name: "Fast Build with Sccache"
    runs-on: ubuntu-latest
    
    # IAM Roles for Service Accounts via OIDC (Zero-Trust AWS)
    permissions:
      id-token: write
      contents: read

    steps:
      - name: "Checkout Code"
        uses: actions/checkout@v4

      - name: "Configure AWS Credentials via OIDC"
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/GitHubActionsRustCIRole
          aws-region: us-east-1

      - name: "Install Rust Toolchain"
        uses: dtolnay/rust-toolchain@stable

      - name: "Install Sccache"
        uses: mozilla-actions/sccache-action@v0.0.4

      - name: "Start sccache server"
        run: sccache --start-server

      - name: "Compile Application"
        run: cargo build --workspace --release

      - name: "Run Tests"
        run: cargo test --workspace

      - name: "Sccache Statistics"
        run: sccache --show-stats
        if: always()

      - name: "Stop sccache server"
        run: sccache --stop-server
        if: always()
```

## Unit / Verification Test (Integritas Sccache)

Skrip Rust berikut dapat dimasukkan sebagai pre-commit atau xtask untuk memastikan developer / CI tidak sengaja mematikan konfigurasi build lokal jika menggunakan wrapper statis.

```rust
// File: xtask/src/verify_sccache.rs
use std::env;

pub fn verify_ci_environment() {
    let is_ci = env::var("CI").is_ok();
    if is_ci {
        let rustc_wrapper = env::var("RUSTC_WRAPPER").unwrap_or_default();
        assert_eq!(
            rustc_wrapper, "sccache",
            "FATAL: Di lingkungan CI, RUSTC_WRAPPER harus diatur ke sccache untuk menghemat durasi build!"
        );
        
        // Memeriksa keberadaan backend konfigurasi
        let s3_bucket = env::var("SCCACHE_BUCKET").is_ok();
        let gha_enabled = env::var("SCCACHE_GHA_ENABLED") == Ok("true".to_string());
        
        assert!(
            s3_bucket || gha_enabled,
            "Sccache memerlukan konfigurasi backend persisten (S3 atau GHA API)!"
        );
        
        println!("✅ Sccache Build Verification Lulus!");
    }
}
```

## ❌ vs ✅ Anti-Patterns

### Anti-Pattern 1: Menyertakan Informasi Waktu Absolut di Macro
**❌ Salah:** Menggunakan macro kompilasi yang menyertakan timestamp dinamis yang berubah setiap detik. Ini menghasilkan hash input yang selalu berbeda, merusak cache rate 100%.
```rust
// ❌ BAD: Setiap detik kode ini dicompile, hash source-nya berubah
const BUILD_TIME: &str = env!("CURRENT_DATETIME"); // Misal disuntik dari build.rs dengan waktu sekarang
```

**✅ Benar:** Suntikkan timestamp secara stabil, misalnya menggunakan Commit SHA git, atau hindari di dev/CI profile, injeksi hanya pada mode rilis produksi di akhir tahap Docker.
```rust
// ✅ GOOD: Commit SHA konsisten untuk commit yang sama
const COMMIT_SHA: &str = env!("GIT_COMMIT_SHA");
```

### Anti-Pattern 2: Membersihkan Target Directory Bersamaan dengan Sccache
**❌ Salah:** Menjalankan `cargo clean` secara buta sebelum build di CI. Sccache mengurus cache object compiler, tetapi *cargo* sendiri juga melacak dependency tree di direktori `target/`. Sccache tidak men-cache tahap *linking* final yang lama.
**✅ Benar:** Biarkan actions cache (seperti `rust-cache` atau GitHub setup action) juga me-restore direktori `target/` untuk menghindari link ulang berulang-ulang, gunakan sccache sebagai suplemen layer jaringan terpusat.

## ⚠️ Production Edge Cases

1. **S3 Rate Limits (503 Slow Down):**
   Saat monorepo berukuran ratusan crate (seperti substrat blockchain) dikompilasi oleh puluhan *concurrent runners*, request GET/PUT ke Amazon S3 bisa melebihi limit TPS AWS per prefix.
   *Solusi:* Konfigurasikan struktur folder sccache untuk membagi key (`SCCACHE_S3_KEY_PREFIX`). Pastikan IAM role OIDC membatasi akses pada bucket tertentu dengan `s3:PutObject` rate limiting, dan gunakan Sccache dengan fitur `--max-frame-size` dioptimalkan, atau pindahkan backend ke Redis / Memcached internal CI.

2. **Perbedaan Opsi Compiler Siluman (Silent Compiler Flags Drift):**
   Developer menambahkan flags `-C target-cpu=native` ke `RUSTFLAGS` lokal tetapi tidak di CI. `sccache` akan mendeteksi flags tersebut berbeda, sehingga menghasilkan `Cache Miss` padahal kodenya sama.
   *Solusi:* Hardcode konfigurasi `rustflags` secara deklaratif di `.cargo/config.toml` dan larang mutasi via environment variable, atau standarisasi menggunakan profil Cargo eksplisit.

3. **Disk Space Exhaustion (EBS Volume Penuh):**
   Sccache menyimpan cache lokal transien sebelum diunggah/diunduh. Di AWS EC2 / self-hosted runners, direktori `~/.cache/sccache` akan membengkak gila-gilaan mencapai puluhan GB jika tidak ada kebijakan eviksi (LRU).
   *Solusi:* Selalu konfigurasikan limit cache lokal: `SCCACHE_CACHE_SIZE: "50G"`. Daemons Sccache akan secara otomatis menghapus file yang paling jarang digunakan (LRU eviction).
