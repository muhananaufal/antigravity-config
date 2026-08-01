# Cross Compilation & Zigbuild: Menaklukkan Build Lintas Arsitektur

Kompilasi silang (cross-compilation) dalam Rust sering kali memicu frustrasi, bukan karena `rustc` gagal menghasilkan arsitektur target, melainkan karena absennya C linker (misal glibc, musl, CGO) yang valid untuk arsitektur target di sistem host. Di masa lalu, komunitas mengandalkan kontainer `cross`, namun pendekatan modern yang revolusioner adalah menggunakan kompiler Zig sebagai C/C++ linker universal bebas hambatan (Zero-Friction Linker) melalui perangkat **`cargo-zigbuild`**.

## Arsitektur Linking: cargo vs cargo-zigbuild

```ascii
=============================================================================================
[ Standar cargo cross-compile ]
(Host: x86_64 Linux -> Target: aarch64 macOS)
  rustc --target aarch64-apple-darwin
    |
    v (Butuh aarch64-apple-darwin-cc) -> ❌ ERROR: Linker not found! Developer menangis.

[ cargo-zigbuild ]
(Host: x86_64 Linux -> Target: aarch64 macOS / arm64 Linux / Windows x86_64)
  cargo zigbuild --target aarch64-apple-darwin
    |
    v (Rust LLVM IR)
  Zig Compiler (Universal C/C++ Linker)
    |-- Bawaan: musl libc, glibc headers (versi bervariasi), Windows SDK minimal
    |-- Otomatis mendeteksi target ABI
    v
  ✅ Binary Lintas Platform Sukses (Tanpa instalasi toolchain C khusus)
=============================================================================================
```

`cargo-zigbuild` membungkus `cargo` dan merutekan ulang tahap eksekusi linker ke `zig cc` dan `zig c++`. Zig menyimpan ratusan header standar libc, libc++, dan musl dalam satu binary kecil (cache), memungkinkan penyatuan (linking) ke sistem operasi apapun.

## Konfigurasi Lintas Kompilasi dengan GitHub Actions

Berikut pipeline canggih yang menghasilkan binary produksi rilis untuk x86 Linux (glibc), ARM64 Linux (musl), macOS (Apple Silicon M1/M2/M3), dan Windows x86_64 dari satu host Ubuntu.

```yaml
# File: .github/workflows/cross-zigbuild.yml
name: "Matrix Cross Compilation Production Release"

on:
  release:
    types: [created]

jobs:
  build:
    name: Build for ${{ matrix.target }}
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        include:
          - target: x86_64-unknown-linux-gnu
            os: linux
          - target: aarch64-unknown-linux-musl
            os: linux
          - target: aarch64-apple-darwin
            os: macos
          - target: x86_64-pc-windows-gnu
            os: windows

    steps:
      - name: "Checkout Source"
        uses: actions/checkout@v4

      - name: "Setup Rust Toolchain"
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}

      # Memanfaatkan pip untuk menginstal cargo-zigbuild (lebih cepat dari cargo install)
      - name: "Install Zig Compiler and cargo-zigbuild"
        uses: korandoru/setup-zig@v1
        with:
          zig-version: 0.11.0
      
      - name: "Install Cargo Zigbuild"
        run: pip3 install cargo-zigbuild

      - name: "Cross Compile with Zigbuild"
        # Kita bisa mengatur target versi glibc secara spesifik, misal glibc 2.17 untuk RHEL 7
        run: cargo zigbuild --release --target ${{ matrix.target }}
        # Jika target x86_64 linux glibc, zigbuild membolehkan syntax --target x86_64-unknown-linux-gnu.2.17

      - name: "Archive Artifacts"
        uses: actions/upload-artifact@v4
        with:
          name: binary-${{ matrix.target }}
          path: target/${{ matrix.target }}/release/my_rust_app${{ matrix.os == 'windows' && '.exe' || '' }}
```

## Unit / Verification Test (Linker Integrity Check)

Memverifikasi bahwa binary yang dihasilkan untuk target linux `musl` benar-benar statically linked dan bebas dari dependensi shared library host.

```rust
// File: xtask/src/verify_cross.rs
use std::process::Command;
use std::path::Path;

pub fn verify_static_linking(target_path: &str) {
    let binary_path = Path::new(target_path);
    assert!(binary_path.exists(), "Binary hasil kompilasi hilang!");

    // Menjalankan perintah `ldd` untuk memverifikasi binary musl
    let output = Command::new("ldd")
        .arg(binary_path)
        .output()
        .expect("Gagal menjalankan ldd");

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let stderr_str = String::from_utf8_lossy(&output.stderr);

    // ldd biasanya mengeluarkan peringatan 'not a dynamic executable' jika itu 100% statis (musl)
    let is_static = stdout_str.contains("not a dynamic executable") || stderr_str.contains("not a dynamic executable");
    
    assert!(
        is_static,
        "FATAL: Binary kompilasi musl ini masih melampirkan dinamis library! Ini merusak portabilitas server."
    );
    
    println!("✅ Binary terverifikasi terkompilasi statis sepenuhnya!");
}
```

## ❌ vs ✅ Anti-Patterns

### Anti-Pattern 1: Instalasi Hardcoded `gcc-aarch64-linux-gnu`
**❌ Salah:** Mengacaukan sistem host dengan menginstal set toolchain C lintas arsitektur menggunakan apt-get (misal `gcc-mingw-w64`). Ini kaku, sulit diperbarui, dan sering gagal menautkan header C++.
**✅ Benar:** Cukup gunakan `cargo zigbuild --target <TARGET>`. Zig mengelola semua rantai linker dan header OS dalam sandboxed abstraksinya sendiri secara mulus.

### Anti-Pattern 2: Masalah OpenSSL CGO saat Kompilasi Silang
**❌ Salah:** Mengandalkan library `openssl-sys` (C binding) lalu mencoba cross-compile. Proses akan runtuh karena Zig akan kebingungan mencari binary library OpenSSL statis untuk aarch64 pada host x86.
```toml
# ❌ BAD: Memerlukan libssl-dev host dan sangat sulit di-cross-compile
reqwest = { version = "0.11", features = ["native-tls"] }
```
**✅ Benar:** Gunakan `rustls` (Pure Rust TLS implementasi) untuk proyek yang membutuhkan kompilasi silang mulus tanpa C binding yang menyulitkan linker.
```toml
# ✅ GOOD: Kompilasi silang berjalan tanpa gangguan C library dependencies
reqwest = { version = "0.11", default-features = false, features = ["rustls-tls"] }
```

## ⚠️ Production Edge Cases

1. **Kompatibilitas macOS SDK (Apple Darwin Frameworks):**
   Meskipun `cargo-zigbuild` hebat, menautkan framework spesifik macOS (seperti `CoreAudio`, `Metal`) dari host Linux/Windows melanggar EULA Apple atau Zig kekurangan header spesifik tersebut.
   *Solusi:* Jika aplikasi mengeksekusi operasi GPU/Audio spesifik Mac, kompilasi macOS harus tetap dijalankan di mesin CI ber-OS macOS murni. Zigbuild pada Linux host optimal untuk CLI apps (tanpa UI).

2. **Glibc Versioning Crash (Kernel Panic Setengah Matang):**
   Anda mengompilasi binary di CI terbaru (glibc 2.35 Ubuntu 22.04), lalu melakukan deploy ke server lawas CentOS 7 (glibc 2.17). Binary akan mengalami *segmentation fault* `GLIBC_2.25 not found`.
   *Solusi:* Ini adalah keahlian utama `cargo-zigbuild`. Tentukan secara eksplisit glibc target minimum: `cargo zigbuild --target x86_64-unknown-linux-gnu.2.17`.

3. **Interoperabilitas dengan Build Script (`build.rs`) Kompleks:**
   Beberapa dependensi memiliki `build.rs` yang mencoba mengeksekusi binary lokal yang di-compile *untuk host*, atau salah mengidentifikasi arsitektur karena variabel lingkungan `TARGET` bertentangan dengan `HOST`.
   *Solusi:* Atur secara ketat `CC`, `CXX`, dan `AR` jika dependensi bersikeras menggunakan kompiler C. Namun umumnya, `cargo-zigbuild` menambal ini dengan membajak inisialisasi lingkungan cargo. Jika mentok, beralih ke kontainerisasi total via `cross`.
