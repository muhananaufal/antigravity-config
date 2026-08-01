# 🚀 Rust Docker: Distroless & Scratch Multi-Stage Builds (Standar Sultan)

## 1. Konsep Multi-Stage & Membedah Musl vs Glibc
Membangun container Rust untuk production menuntut tingkat kebersihan dan keamanan tingkat tinggi. Menggunakan base image standar seperti `rust:1.75` atau `ubuntu` akan menghasilkan docker image bengkak (ratusan Megabyte) yang rentan terhadap CVE OS level. Pendekatan "Kasta Sultan" mewajibkan **Multi-Stage Builds**: proses kompilasi berjalan di tahap `builder`, sedangkan hasil kompilasi statis dipindahkan ke image super-kecil `scratch` (0 MB OS, murni hampa) atau `distroless` untuk runtime. 

Ada dua arsitektur utama:
1. **GLIBC (GNU C Library)**: Library standar Linux. Umumnya di-link secara dinamis (dynamic linking). Jika memaksa static, rentan masalah kompatibilitas nsswitch/DNS.
2. **MUSL (musl-libc)**: Implementasi libc yang ringan, didesain untuk kompilasi fully-static 100% tanpa dependensi host OS. Sangat sempurna untuk image `scratch`.

### Diagram ASCII: Alur Multi-Stage Build
```text
+--------------------------------------------------------------------------+
| STAGE 1: Builder Environment (rust:1.75-alpine)                          |
|   +------------------------------------------------------------------+   |
|   | 1. Install rustup target `x86_64-unknown-linux-musl`             |   |
|   | 2. Copy Cargo.toml & lock, fetch dependencies                    |   |
|   | 3. Copy Source Code                                              |   |
|   | 4. cargo build --release --target x86_64-unknown-linux-musl      |   |
|   | 5. strip binary (membuang debug symbols) -> Size turun drastis!  |   |
|   +------------------------------------------------------------------+   |
+-------------------------------------|------------------------------------+
                                      | (Hanya memindahkan 1 file binary)
+-------------------------------------v------------------------------------+
| STAGE 2: Runtime Environment (scratch)                                   |
|   +------------------------------------------------------------------+   |
|   | 1. Inject /etc/ssl/certs/ca-certificates.crt (agar TLS jalan)    |   |
|   | 2. Inject /etc/passwd (user & group non-root rakitan)            |   |
|   | 3. COPY --from=builder /app/target/.../release/binary /app/bin   |   |
|   | 4. USER 10001:10001                                              |   |
|   | 5. ENTRYPOINT ["/app/bin"]                                       |   |
|   +------------------------------------------------------------------+   |
+--------------------------------------------------------------------------+
```

## 2. Dockerfile Produksi (Scratch & Musl-Libc)
Berikut adalah Dockerfile yang memproduksi image akhir di bawah 15MB:

```dockerfile
# STAGE 1: Builder
FROM rust:1.75-alpine AS builder

# Install dependensi sistem untuk kompilasi static
RUN apk add --no-cache musl-dev gcc lld

# Tambahkan target musl
RUN rustup target add x86_64-unknown-linux-musl

WORKDIR /usr/src/app

# Teknik caching dasar (lebih advance ada di file cargo_chef)
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release --target x86_64-unknown-linux-musl
RUN rm -rf src

# Copy source code asli dan build
COPY src ./src
# Touch agar rustc tahu source code berubah dan perlu di-build ulang, bukan pakai dummy
RUN touch src/main.rs
RUN cargo build --release --target x86_64-unknown-linux-musl

# Strip debug symbols untuk ukuran super kecil
RUN apk add --no-cache binutils && \
    strip /usr/src/app/target/x86_64-unknown-linux-musl/release/my_rust_service

# Siapkan dummy passwd untuk eksekusi non-root di scratch
RUN echo "nonroot:x:10001:10001:nonroot:/tmp:/sbin/nologin" > /etc/passwd.dummy

# STAGE 2: Runtime
FROM scratch

# Set environment agar program tahu ini production
ENV RUST_ENV=production

# Copy Root CA certificates (wajib jika app Anda melakukan request HTTPS ke luar)
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Copy user definition
COPY --from=builder /etc/passwd.dummy /etc/passwd

# Copy the static binary
COPY --from=builder /usr/src/app/target/x86_64-unknown-linux-musl/release/my_rust_service /my_rust_service

# Gunakan non-root user
USER 10001:10001

# Eksekusi binary
ENTRYPOINT ["/my_rust_service"]
```

## 3. Skrip Verifikasi & Testing (Bash)
Untuk membuktikan bahwa ukuran container <15MB dan berjalan murni static:

```bash
#!/bin/bash
set -e

IMAGE_NAME="my_rust_service:scratch"

echo "[*] Building image $IMAGE_NAME..."
docker build -t $IMAGE_NAME .

echo "[*] Verifying Image Size..."
SIZE_BYTES=$(docker inspect -f "{{ .Size }}" $IMAGE_NAME)
SIZE_MB=$(echo "scale=2; $SIZE_BYTES / 1024 / 1024" | bc)

echo "-> Image Size is $SIZE_MB MB"

if (( $(echo "$SIZE_MB > 15.0" | bc -l) )); then
    echo "❌ ERROR: Image size is greater than 15MB!"
    exit 1
else
    echo "✅ SUCCESS: Image size is under 15MB!"
fi

echo "[*] Verifying Execution (Dry Run)..."
docker run --rm -d --name test_rust_app $IMAGE_NAME
sleep 2

if docker ps -f name=test_rust_app | grep -q test_rust_app; then
    echo "✅ SUCCESS: Container is running."
    docker stop test_rust_app
else
    echo "❌ ERROR: Container failed to start (maybe missing dynamic libs)."
    docker logs test_rust_app || true
    exit 1
fi
```

## 4. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menggunakan GLIBC dengan Scratch tanpa Statically Linked Libc
Mengkompilasi secara standar (`cargo build --release`) lalu melemparnya ke `scratch`.
**Masalah**: Binary standar secara dinamis terhubung ke `ld-linux.so` dan `libc.so.6`. Saat dieksekusi di `scratch`, kernel Linux akan protes: `standard_init_linux.go:211: exec user process caused "no such file or directory"`.
**Solusi (✅)**: Selalu gunakan target MUSL (`x86_64-unknown-linux-musl`) jika target akhirnya adalah `scratch` atau image alpine.

### ❌ Anti-Pattern 2: Melupakan TLS / CA Certificates di Scratch
Aplikasi Rust memanggil API eksternal (misal Stripe via HTTPS).
**Masalah**: Di dalam `scratch`, tidak ada `/etc/ssl/certs`. Eksekusi reqwest/Hyper HTTPS akan `Panic` karena gagal memverifikasi sertifikat SSL.
**Solusi (✅)**: Salin `ca-certificates.crt` dari container builder ke container runtime seperti pada Dockerfile di atas.

## 5. Production Edge Cases

1. **DNS Resolving Glitches (musl vs glibc)**: 
   `musl-libc` menggunakan implementasi DNS resolver bawaan yang terkadang tidak mendukung spesifikasi kompleks (seperti mode IPv6 fallback lama atau search domain berantai panjang di `/etc/resolv.conf` Kubernetes). Jika DNS di K8s sering putus, pertimbangkan menggunakan base `gcr.io/distroless/cc-debian12` (glibc base but stripped down) daripada murni scratch musl, atau kompilasi static glibc.

2. **Panics Tidak Memiliki Stack Trace Simbolik**:
   Karena binary sudah di-`strip` (debug symbols dibuang demi size), jika aplikasi panic di production, log-nya hanya akan berisi memory address mentah (contoh: `0x7f8a9b8`). **Mitigasi**: Pertimbangkan mengaktifkan `debug = 1` di profil release Cargo untuk stacktrace basic dengan penalti size sekitar 2-5MB, atau integrasikan Sentry untuk crash reporting yang memisahkan debug symbols secara remote.

3. **Time-Zone (TZData) Missing di Scratch**:
   Jika aplikasi Rust menangani konversi waktu menggunakan library `chrono` yang mengandalkan database timezone sistem (contoh `chrono::Local::now()`), ia akan fallback ke UTC tanpa error, namun merusak logika bisnis yang berharap `Asia/Jakarta`. **Mitigasi**: Anda wajib menyalin file TZ database dari stage builder: `COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo` dan set `ENV TZ=Asia/Jakarta`.
