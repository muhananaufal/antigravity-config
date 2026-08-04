# Analisis Trade-Off: Kapan MENGGUNAKAN dan KAPAN MENGHINDARI NestJS

> Dipicu dari `SKILL.md` saat mengambil keputusan arsitektur atau saat menjalankan *Critical Challenger Mode* terhadap pilihan stack.

Sebagai perwira bersponsor *Critical Challenger Mode*, kita wajib menakar kelemahan sistem secara jujur dan transparan:

## Keunggulan Ekstrem NestJS (Why We Champion It)

1. **Kedisiplinan Enterprise Mutlak di Dunia Node.js:** Menembak mati kekacauan arsitektur *spaghetti code* khas JavaScript tradisional dengan pola rancang bangun berskill murni ala Spring Boot (DI, Interceptors, Guards, dan Decorator modular).
2. **Kekuatan I/O Throughput Tinggi bermodorkan Fastify & Bun:** Mengemas skalabilitas jaringan asinkronus tercepat dunia berbantuan Fastify engine dan kompatibilitas Bun Runtime, mencetak rekor jutaan RPS untuk API monosit maupun microservices.
3. **Isomorfisme Fullstack:** Memungkinkan tim engineering memakai satu bahasa statikal murni (TypeScript) bersandar pembagian kontrak DTO Zod / OpenAPI yang sinkron sejati dari antarmuka frontend (Next.js) hingga mikroservice terbawah!

## Kelemahan & Batasan (When to Challenge and Pivot)

1. **Bottleneck Single-Threaded pada Komputasi Berat (CPU-Bound):** Jika sistem diproyeksikan 80% pekerjaannya adalah komputasi matematika berat, enkode video murni di proses lokal, atau kriptografi jutaan loop, **TANTANG USER ATAS RESIKO BOTTLENECK INTEL!** Sarankan untuk memutar proses tersebut di **Rust / Golang**, atau pasangkan bridge biner via `napi-rs` / `Piscina Worker Threads`.
2. **Overhead Memori Heap & Cold Start pada Serverless:** Ukuran jejak memori V8 Heap awal dan waktu muat reflection (*Metadata Reflection Engine*) NestJS tergolong cukup besar untuk platform Function-as-a-Service (FaaS / AWS Lambda) berfrekuensi panggil jarang. Tanpa kompilasi *SWC/esbuild micro bundle* dan teknik *provisioned concurrency warm-up*, latensi *Cold Start* bisa menyiksa pengguna!
3. **Kutukan Ilusi Runtime TypeScript (Type Erasure):** INGAT BAHWA SECRETO TIPE DATA TYPESCRIPT MUSNAH DI COMPILER! Di runtime, V8 mengeksekusi JavaScript mentah. Jika developer luput memasang pipa validasi skema eksternal (*Zod/TypeBox*), muatan JSON jahat berpotensi merusakkan alur database tanpa diantisipasi tipe compile-time!
