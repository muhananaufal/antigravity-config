# Blueprint Dockerfile Multi-Stage & Distroless Alpine untuk NestJS

## Pendahuluan: Efisiensi Kontainer Skala Ekstrem

Di era Cloud Native, ukuran image Docker dan luas permukaan serangan (attack surface) adalah metrik krusial. Image yang membengkak memperlambat proses deployment (pull/push time), mengonsumsi bandwidth secara berlebihan, dan sering kali menyertakan utilitas sistem operasi yang tidak diperlukan, yang dapat dieksploitasi oleh peretas. Blueprint ini menetapkan standar tertinggi (Top 1%) untuk aplikasi NestJS dengan memanfaatkan **Multi-Stage Build** dan image **Google Distroless Node** atau Alpine versi mikro, memangkas ukuran akhir hingga di bawah 80MB.

## Diagram ASCII: Arsitektur Multi-Stage Layer Pruning

```ascii
[ Docker Build Context ]
          |
          v
+-----------------------+      +-----------------------+      +-----------------------+
| Stage 1: deps-stage   |      | Stage 2: build-stage  |      | Stage 3: production   |
| (Node.js Alpine)      | ---> | (Node.js Alpine)      | ---> | (Google Distroless)   |
|                       |      |                       |      |                       |
| - Salin package.json  |      | - Salin seluruh source|      | - Salin node_modules/ |
| - Install dependencies|      | - nest build          |      |   (produksi saja)     |
|   (termasuk devDeps)  |      | - Hasilkan /dist      |      | - Salin /dist         |
+-----------------------+      +-----------------------+      +-----------------------+
          |                              |                              |
          | (Cache)                      | (Pruned)                     | (Final Image)
          v                              v                              v
[ Layer Sementara Dibuang ]    [ Source Code & DevDeps ]      [ Image Mikro (<80MB)   ]
                               [ Dibuang dari Image    ]      [ Tanpa Shell/Utils OS  ]
```

## Implementasi Blueprint Dockerfile Multi-Stage

Blueprint ini menggunakan Node.js Alpine untuk tahap kompilasi dan Google Distroless Node 20 untuk tahap eksekusi produksi murni. Google Distroless tidak memiliki package manager, shell, atau program standar lainnya, sehingga menjadikannya sangat aman.

```dockerfile
# -----------------------------------------------------------------------------
# STAGE 1: Dependencies (deps-stage)
# -----------------------------------------------------------------------------
FROM node:20.11.1-alpine3.19 AS deps-stage
WORKDIR /usr/src/app

# Gunakan corepack untuk manajemen pnpm
RUN corepack enable && corepack prepare pnpm@8.15.3 --activate

# Salin file manifes saja untuk memanfaatkan cache layer Docker
COPY package.json pnpm-lock.yaml ./

# Install dependensi menggunakan cache mount pnpm
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# STAGE 2: Build (build-stage)
# -----------------------------------------------------------------------------
FROM node:20.11.1-alpine3.19 AS build-stage
WORKDIR /usr/src/app

RUN corepack enable && corepack prepare pnpm@8.15.3 --activate

# Salin deps dari stage sebelumnya
COPY --from=deps-stage /usr/src/app/node_modules ./node_modules
COPY . .

# Kompilasi aplikasi NestJS TypeScript -> JavaScript
RUN pnpm run build

# Hapus seluruh modul, dan install ulang HANYA untuk dependensi produksi
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile

# -----------------------------------------------------------------------------
# STAGE 3: Production (production)
# -----------------------------------------------------------------------------
# Gunakan Google Distroless Node 20 (Non-Root by default pada versi tertentu)
FROM gcr.io/distroless/nodejs20-debian12:nonroot AS production
WORKDIR /usr/src/app

# Atur Environment Variables untuk Produksi
ENV NODE_ENV=production
ENV PORT=3000

# Salin hanya biner kompilasi dan dependensi produksi murni
COPY --from=build-stage --chown=nonroot:nonroot /usr/src/app/node_modules ./node_modules
COPY --from=build-stage --chown=nonroot:nonroot /usr/src/app/dist ./dist

# Ekspos port aplikasi
EXPOSE 3000

# Eksekusi biner JavaScript langsung via engine V8
CMD ["dist/main.js"]
```

## Anti-Patterns Kritis & Praktik Terbaik

### ❌ Anti-Pattern 1: Menggunakan Image Base `node:latest` Lengkap
Image `node:latest` didasarkan pada distribusi Linux penuh (seperti Debian/Ubuntu) yang berisi ratusan megabyte utilitas yang tidak akan pernah digunakan oleh aplikasi Node.js, seperti `curl`, `wget`, compiler C++, dll.
```dockerfile
# ❌ SALAH: Image membengkak >1GB, attack surface sangat luas
FROM node:latest
WORKDIR /app
COPY . .
RUN npm install && npm run build
CMD ["npm", "run", "start:prod"]
```

### ✅ Solusi 1: Google Distroless
Gunakan `gcr.io/distroless/nodejs20-debian12`. Image ini memotong lapisan OS hingga menyisakan Node.js runtime saja. Peretas yang berhasil menemukan celah RCE (Remote Code Execution) tidak akan menemukan `/bin/sh` untuk mengeksekusi eksploitasi mereka.

### ❌ Anti-Pattern 2: Tidak Memisahkan Dependencies Produksi dan Development
Membawa `devDependencies` seperti `@nestjs/cli`, `jest`, atau `ts-node` ke kontainer produksi membuang ruang penyimpanan memori dan berisiko pada injeksi celah keamanan dari pustaka development.
```dockerfile
# ❌ SALAH: Menyimpan typescript dan CLI di final image
RUN npm install
COPY . .
RUN npm run build
CMD ["node", "dist/main.js"]
```

### ✅ Solusi 2: Layer Pruning di Multi-Stage
Gunakan multi-stage untuk mengeksekusi build, lalu bersihkan `node_modules` dan panggil instalasi ulang *hanya* untuk produksi (`npm ci --omit=dev` atau `pnpm install --prod`).

## Analisis Trade-Off

### Kelebihan
1. **Keamanan Maksimal:** Tidak adanya shell (`/bin/sh` atau `/bin/bash`) di lingkungan Distroless menyulitkan peretas meluncurkan *reverse shell* walau celah injeksi ditemukan.
2. **Kecepatan Pull Image:** Image akhir yang kurang dari 80MB mengurangi durasi pull dan restart kontainer di ekosistem Kubernetes, mempercepat pemulihan dari node crash.
3. **Penghematan Storage Cloud:** Registry kontainer ECR/GCR tidak akan terkuras oleh versi gigabyte untuk setiap deployment versi aplikasi baru.

### Kekurangan
1. **Sulit Di-debug secara Interaktif:** Tanpa shell, Anda tidak dapat menjalankan `docker exec -it <container> /bin/sh` untuk menganalisis log file atau menginspeksi environment di dalam kontainer yang berjalan.
2. **Kompatibilitas Pustaka Native:** Pustaka Node.js yang melakukan kompilasi modul C++ native pada runtime (misalnya `bcrypt`, `canvas`, atau `node-gyp` generik) mungkin bermasalah saat dipindah ke Alpine/Distroless jika dependensi shared library `.so` tidak disalin dengan benar.
3. **Kurva Pembelajaran DevSecOps:** Membuat build script yang presisi pada Multi-Stage membutuhkan pemahaman mendalam tentang siklus hidup layer Docker.

## Production Edge Cases

1. **C/C++ Addons Incompatibility:** Jika Anda menggunakan `bcrypt`, dependensi tersebut harus di-build di stage yang sepadan dengan OS final. Jika stage 2 adalah Alpine (musl libc) dan stage 3 adalah Debian Distroless (glibc), biner `bcrypt` akan gagal dimuat (segfault) di produksi. Solusi: Pastikan `build-stage` menggunakan Debian slim, bukan Alpine, jika final image adalah Distroless Debian.
2. **Missing CA Certificates:** Distroless umumnya sudah menyediakan CA certs, tetapi untuk koneksi SSL/TLS ke layanan eksternal usang atau internal mTLS, Anda mungkin perlu menyalin sertifikat tambahan ke `/etc/ssl/certs/` secara eksplisit pada Dockerfile.
3. **Timezone Data:** Distroless tidak membawa data *timezone* IANA yang lengkap secara bawaan. Jika aplikasi NestJS memanipulasi tanggal berdasarkan zona waktu spesifik tanpa pustaka seperti `date-fns-tz` (hanya mengandalkan OS), Anda harus menyalin direktori `/usr/share/zoneinfo` dari tahap build ke image produksi.
