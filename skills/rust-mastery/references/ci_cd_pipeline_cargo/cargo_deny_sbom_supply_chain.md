# Cargo Deny & SBOM: Pertahanan Rantai Suplai Zero-Trust CI

Rantai pasokan perangkat lunak (Software Supply Chain) adalah vektor serangan paling rentan di era modern (misalnya insiden Log4j atau pengambilalihan maintainer NPM). Di ekosistem Rust, audit lisensi, deteksi keamanan (CVE), pelarangan sumber tak tepercaya, dan pembuatan Software Bill of Materials (SBOM) wajib diintegrasikan ke jantung CI. **`cargo-deny`** adalah alat mutlak untuk mengkarantina ketergantungan beracun, sementara format standar **SPDX SBOM via Syft** memastikan kepatuhan regulasi industri (seperti pedoman keamanan cyber institusi perbankan & pemerintah).

## Arsitektur Zero-Trust Validation CI

```ascii
=============================================================================================
[ Pull Request Masuk ] -> CI Triggered
       |
       v
+------------------+     [ cargo-deny rules ]                 [ RustSec Advisory DB ]
| cargo deny check | <--- deny.toml (Policy)     ----->       (Vulnerability Database)
+------------------+     - Ban list (crates)                  - RUSTSEC-202X-XXXX
       |                 - License whitelist (MIT/Apache)     - yanked crates
       |                 - Multiple version ban
       v
[ LULUS (Validasi Kepatuhan) ] -> ❌ GAGAL CI JIKA DITEMUKAN KERENTANAN ATAU LISENSI GPL!
       |
       v
+------------------+     
| Syft SBOM Gen    | ----> Memindai Cargo.lock & Binary
+------------------+
       |
       v
[ sbom-spdx.json ]  ----> Ditandatangani (Sigstore/Cosign) & Disimpan sebagai Artifact
=============================================================================================
```

## Kebijakan Kepatuhan: `deny.toml`

Konfigurasi ini melarang lisensi Copyleft untuk proyek komersial pro-prietary, menolak versi yang sudah di-yank, dan melarang dependensi usang dengan versi ganda.

```toml
# File: deny.toml

# =======================================================
# 1. License Policy (Kepatuhan Legal)
# =======================================================
[licenses]
# Mengizinkan hanya lisensi permisi standar komersial
allow = [
    "MIT",
    "Apache-2.0",
    "BSD-3-Clause",
    "BSD-2-Clause",
    "ISC",
]
# Keras terhadap lisensi Copyleft jika Anda bukan open-source (GPL akan "menginfeksi" kode proprietary)
deny = [
    "GPL-1.0-or-later",
    "GPL-2.0-or-later",
    "GPL-3.0-or-later",
    "AGPL-3.0-or-later",
]
confidence-threshold = 0.93

# =======================================================
# 2. Vulnerability Policy (Audit Keamanan)
# =======================================================
[advisories]
vulnerability = "deny"
unmaintained = "warn"
yanked = "deny"
ignore = [
    # Jika ada false-positive atau belum ada patch, kita bisa mengabaikan ID RUSTSEC spesifik (dengan komentar alasan jelas)
    # "RUSTSEC-2023-0071", # Contoh: Terjadi di build-time library internal, risiko 0.
]

# =======================================================
# 3. Bans (Pelarangan Krate Berbahaya)
# =======================================================
[bans]
multiple-versions = "warn"
wildcards = "allow"
highlight = "all"
workspace-default-features = "warn"

[[bans.skip]]
name = "syn" # Pengecualian: Wajar memiliki beberapa versi `syn` di macro-heavy repo.

# =======================================================
# 4. Sources (Registry yang Divalidasi)
# =======================================================
[sources]
unknown-registry = "deny"
unknown-git = "deny"
allow-registry = ["https://github.com/rust-lang/crates.io-index"]
allow-git = [
    # Hanya izinkan git repo internal korporat
    "https://github.com/MyCompany/private-rust-core"
]
```

## Implementasi CI GitHub Actions: Security Gate & SBOM

Pipeline ini bertindak sebagai penjaga gerbang yang memblokir PR beracun dan menghasilkan bukti kriptografis SBOM.

```yaml
# File: .github/workflows/security-sbom.yml
name: "Supply Chain Security & SBOM"

on:
  pull_request:
  push:
    branches: ["main"]

jobs:
  audit_and_compliance:
    name: "Zero-Trust Cargo Deny"
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: "Run Cargo Deny (Security, Licenses, Bans)"
        uses: EmbarkStudios/cargo-deny-action@v2
        with:
          # Memeriksa semua aturan: advisories, bans, licenses, sources
          command: check all

      - name: "Run Cargo Audit (Extra Redundancy)"
        # Sebagai pengaman ganda khusus kerentanan keamanan
        uses: rustsec/audit-check@v1.4.1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

  generate_sbom:
    name: "SBOM Generation (Syft)"
    needs: audit_and_compliance
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: "Generate SBOM via Anchore Syft"
        uses: anchore/sbom-action@v0
        with:
          # Format SPDX standard industri
          format: spdx-json
          output-file: "target/sbom.spdx.json"

      - name: "Archive SBOM Artifact"
        uses: actions/upload-artifact@v4
        with:
          name: sbom-artifact
          path: target/sbom.spdx.json
```

## Unit / Verification Test (Konsep Validasi Supply Chain)

Pengujian konseptual jika skrip Rust internal harus memverifikasi integritas lockfile secara paksa.

```rust
// File: xtask/src/verify_supply_chain.rs
use std::fs;

pub fn verify_cargo_lock_integrity() {
    let cargo_toml = fs::read_to_string("Cargo.toml").expect("Missing Cargo.toml");
    let cargo_lock = fs::read_to_string("Cargo.lock").expect("Missing Cargo.lock");

    // Jangan pernah biarkan dependency dikonfigurasi menggunakan versi wildcard "*"
    assert!(
        !cargo_toml.contains("*\""),
        "FATAL: Ketergantungan Wildcard (*) ditemukan di Cargo.toml. Ini menghancurkan determinisme dan keamanan supply chain!"
    );

    // Mencegah repo eksternal HTTP tidak terenkripsi
    assert!(
        !cargo_toml.contains("http://"),
        "FATAL: Ditemukan sumber dependensi http (tidak aman), gunakan https!"
    );

    println!("✅ Kepatuhan Permukaan Supply Chain Dasar Lulus!");
}
```

## ❌ vs ✅ Anti-Patterns

### Anti-Pattern 1: Mengabaikan Penggandaan Versi (Bloatware)
**❌ Salah:** Membiarkan 4 versi berbeda dari `tokio` atau `rand` masuk ke dalam pohon dependensi (karena crate bawahan menggunakan versi beraneka ragam). Ini meningkatkan waktu kompilasi 400% dan menambah ukuran binary.
**✅ Benar:** Aktifkan `multiple-versions = "deny"` di *cargo-deny*. Paksa resolusi versi yang seragam, atau buat PR ke library pihak ketiga untuk memperbarui crate mereka.

### Anti-Pattern 2: Menutupi Peringatan Keamanan dengan Kebutaan (Blind Ignore)
**❌ Salah:** Menggunakan skrip custom `cargo audit || true` (fail open) untuk membiarkan CI lolos meskipun ada kerentanan tingkat tinggi, hanya karena tenggat waktu fitur mepet.
**✅ Benar:** Pipeline keamanan wajib *fail-closed* (menggagalkan CI). Jika vulnerability tidak ada patch, tambahkan bypass ID secara sadar dengan justifikasi di `deny.toml` (contoh: diabaikan sementara hingga patch dirilis hari jumat karena terisolasi secara internal).

## ⚠️ Production Edge Cases

1. **Konflik Dual-License (MIT ATAU GPL):**
   Crate mendeklarasikan lisensi seperti `license = "MIT OR GPL-3.0"`. Pengurai (parser) naif mungkin panik dan memblokirnya, padahal kita bisa secara legal memilih MIT.
   *Solusi:* `cargo-deny` menangani ekspresi SPDX dengan baik. Namun, pengembang wajib memvalidasi ekspresi boolean pada `deny.toml` sehingga jika satu opsi lisensi "allow" terpenuhi, crate tetap lolos.

2. **Supply Chain Disguised Fork (Pemalsuan Identitas Crate):**
   Penyerang merilis crate `reqwests` (typo dari `reqwest`) yang lolos Cargo Audit karena tidak memiliki CVE terdaftar (baru). 
   *Solusi:* `cargo-deny` tidak melindungi dari serangan *typosquatting* secara mandiri. Ini membutuhkan kebijakan tinjauan kode manual pada `Cargo.toml` PR, pembatasan sumber (source list whitelist), serta perlindungan kepatuhan organisasi dengan mengaktifkan sandboxing build env.

3. **Inkonsistensi SBOM pada Binary Statically Linked vs Dynamic:**
   Pembangkit SBOM seperti `syft` biasanya memindai direktori (seperti `Cargo.lock`). Namun, jika dalam CI Anda menyuntikkan C/C++ library dari SO host saat linking, Syft mungkin luput memetakannya karena itu di luar naungan Cargo.
   *Solusi:* Untuk audit berstandar DoD tingkat militer, integrasikan Syft untuk menelan (ingest) binary akhir yang dikompilasi (bukan hanya source directory) menggunakan alat forensik biner tingkat lanjut seperti `Trivy`, untuk mengekstrak jejak library statis C yang bersemayam dalam executable Rust.
