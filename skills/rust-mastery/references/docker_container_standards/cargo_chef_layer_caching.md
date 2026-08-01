# 🚀 Cargo-Chef: Revolusi Layer Caching Docker (Kecepatan CI/CD Sultan)

## 1. Patologi Kinerja Kompilasi Docker Rust
Setiap kali `Dockerfile` menemui instruksi `COPY . .`, layer cache Docker terbongkar. Jika Anda mengubah satu baris komentar di `src/main.rs`, Docker akan mengulangi perintah `cargo build --release` dari nol. Mengompilasi library besar seperti `tokio`, `serde`, dan `reqwest` memakan waktu puluhan menit, meskipun *dependency* tidak ada yang berubah. Ini adalah pembunuhan massal bagi pipeline CI/CD (GitHub Actions / GitLab CI).

Solusi level sultan: **Cargo Chef**.
Alat ini dapat memisahkan *dependency graph* (resep) dari *source code* aplikasi Anda, meracik dependencies ke layer Docker yang terisolasi sempurna.

### Diagram ASCII: Alur Kerja Cargo Chef
```text
+---------------------------------------------------------------------------------+
| STAGE 1: PLANNER (Pencetak Resep)                                               |
|  $ cargo chef prepare --recipe-path recipe.json                                 |
|  (Menganalisa Cargo.toml + Cargo.lock, menghasilkan JSON murni berisi DAG deps) |
+---------------------------|-----------------------------------------------------+
                            | Menghasilkan recipe.json
+---------------------------v-----------------------------------------------------+
| STAGE 2: CACHER (Pemasak Dependencies)                                          |
|  $ cargo chef cook --release --recipe-path recipe.json                          |
|  (Docker akan MENG-CACHE layer ini selamanya selama Cargo.lock tidak berubah!)  |
|  (Semua crates di-download & dikompilasi hingga menjadi lib_*.rlib)             |
+---------------------------|-----------------------------------------------------+
                            | Menghasilkan folder /target dengan fully built libs
+---------------------------v-----------------------------------------------------+
| STAGE 3: BUILDER (Penyatuan App Code)                                           |
|  $ COPY . .                                                                     |
|  $ cargo build --release                                                        |
|  (Hanya mengompilasi kode buatan sendiri (src/*.rs). Selesai dalam < 15 detik) |
+---------------------------------------------------------------------------------+
```

## 2. Dockerfile Produksi Cargo Chef
Berikut adalah Dockerfile mutakhir yang memangkas waktu build CI/CD secara dramatis.

```dockerfile
# STAGE 1: Chef Planner
FROM rust:1.75 AS chef
# Kami sarankan meng-cache instalasi cargo-chef menggunakan fitur buildx Docker
USER root
RUN cargo install cargo-chef
WORKDIR /app

FROM chef AS planner
COPY . .
# Mengekstrak dependencies menjadi file resep kecil
RUN cargo chef prepare --recipe-path recipe.json

# STAGE 2: Cacher
FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
# Build dependencies saja. Layer ini akan di-cache habis-habisan oleh Docker!
RUN cargo chef cook --release --recipe-path recipe.json

# Sekarang baru salin source code aplikasi Anda
COPY . .
# Kompilasi aplikasi (karena crates dependensi sudah dikompilasi di layer atasnya)
RUN cargo build --release --bin my_awesome_api

# STAGE 3: Runtime
FROM debian:bookworm-slim AS runtime
WORKDIR /app
# Ambil binary-nya
COPY --from=builder /app/target/release/my_awesome_api /usr/local/bin
# Dependensi OS jika diperlukan (glibc/openssl dsb)
RUN apt-get update -y && apt-get install -y --no-install-recommends ca-certificates && apt-get autoremove -y && apt-get clean -y && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/local/bin/my_awesome_api"]
```

## 3. Unit Script Test (Bash Assertion)
Bukti bahwa caching berjalan mulus di Docker Buildx:

```bash
#!/bin/bash
set -e

echo "=== First Build (Cold Cache) ==="
time docker build -t chef_test:latest .

echo "=== Changing only application logic ==="
echo "// new comment" >> src/main.rs

echo "=== Second Build (Hot Cache) ==="
# Gunakan DOCKER_BUILDKIT untuk performa maksimum
time DOCKER_BUILDKIT=1 docker build -t chef_test:latest .

# Periksa log keluaran: Jika Anda melihat kata "CACHED" pada layer `cargo chef cook`,
# berarti build ini berhasil melewati tahap dependency compilation!
if DOCKER_BUILDKIT=1 docker build -t chef_test:latest . 2>&1 | grep -q 'CACHED.*cargo chef cook'; then
    echo "✅ LAYER CACHING SUCCESS: Dependencies are cached perfectly."
else
    echo "❌ LAYER CACHING FAILED: Dependencies recompiled."
    exit 1
fi
```

## 4. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Mengubah Cargo.toml Namun Lupa Lockfile
**Masalah**: Developer sering menambahkan dependencies dengan `cargo add rand` (mengupdate `Cargo.toml` & `Cargo.lock`), lalu me-revert `Cargo.toml` manual namun membiarkan `Cargo.lock` usang. Docker akan mengira resep berubah dan menghancurkan cache layer.
**Solusi (✅)**: Selalu commit `Cargo.lock`. Biarkan `cargo-chef` menangani keselarasan lockfile. Jangan ubah dependencies via teks editor secara brutal tanpa menjalankan `cargo check`.

### ❌ Anti-Pattern 2: `COPY . .` Sebelum `cargo chef cook`
Menempatkan `COPY . .` di baris atas pada STAGE 2.
**Masalah**: Seluruh mekanisme cargo chef tidak akan ada gunanya. Karena Docker layer membaca perubahan pada `src/main.rs`, ia membatalkan seluruh cache ke bawah, dan `cargo chef cook` tetap tereksekusi berulang.
**Solusi (✅)**: Pastikan `cargo chef cook` dipanggil hanya dengan berbekal `recipe.json`, BARU SETELAH ITU jalankan `COPY . .`.

## 5. Production Edge Cases

1. **Workspace Cargo Sangat Kompleks (Monorepo)**:
   Jika Anda memiliki Cargo workspace dengan 10 microservices, `cargo chef` mungkin merebus semua deps untuk semua services di tahap `cook`. Ini buang resource jika Anda hanya membuild 1 container. **Mitigasi**: Gunakan flag `--bin nama_service` pada `cargo chef cook` atau pisahkan workspace root Dockerfile per service context.

2. **C-Bindings dan Native Libraries (sys-crates)**:
   Crate seperti `rdkafka-sys`, `openssl-sys`, atau `libsqlite3-sys` sering membutuhkan header C dan instalasi OS (apt-get install libssl-dev). Jika tidak diletakkan sebelum instruksi `FROM chef AS builder`, kompilasi chef cook akan GAGAL. **Mitigasi**: Pastikan stage `builder` menginstall paket apt `build-essential`, `pkg-config`, `libssl-dev` dll, sebelum menjalankan `cargo chef cook`.

3. **Integritas Build-Script (`build.rs`) Cache Invalidation**:
   `cargo` menggunakan `build.rs` untuk generate protobuf atau bindings. Kadang `build.rs` bergantung pada file di luar direktori `src` (misal `proto/user.proto`). Cargo chef tidak mengetahui file `proto` tersebut unless dieksplisitkan. Ketika file proto berubah, binary tidak dire-build. **Mitigasi**: Tambahkan instruksi `println!("cargo:rerun-if-changed=proto/user.proto");` pada `build.rs` dan copy folder `proto` sebelum tahap kompilasi akhir.
