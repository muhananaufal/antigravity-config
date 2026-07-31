# Common LLM Failure Modes & Self-Correction Protocol

Dokumen ini mendaftarkan kesalahan paling umum yang dilakukan AI (terutama model kecil/medium) saat menulis konten file referensi skill, beserta mekanisme koreksi mandiri (*self-correction*) yang WAJIB dijalankan sebelum mendeklarasikan file selesai.

---

## 1. Daftar Failure Modes & Cara Pencegahan

### FM-1: Tutorial Blog Syndrome (Konten Terlalu Dangkal)
- **Gejala**: File referensi terasa seperti artikel tutorial pemula. Tidak ada edge-case, tidak ada anti-pattern, kode contoh terlalu sederhana.
- **Contoh Buruk**: Menulis tentang "Go Channels" tapi hanya menunjukkan `ch := make(chan int)` dan `ch <- 42` tanpa membahas buffered vs unbuffered, deadlock prevention, atau context cancellation.
- **Pencegahan**: Setiap file referensi WAJIB memiliki minimal 4 section: Konsep, Implementasi Production-Ready, Anti-Patterns, dan Edge Cases. Jika salah satu section terasa tipis, itu pertanda konten masih dangkal — perluas dengan `search_web`.

### FM-2: Hallucinated API / Function
- **Gejala**: AI menulis nama fungsi, method, atau package yang tidak pernah ada di bahasa/framework tersebut.
- **Contoh Buruk**: `goroutine.Kill()` (tidak ada di Go), `Cache::atomicLock()` (tidak ada di Laravel, yang benar adalah `Cache::lock()`).
- **Pencegahan**: Setelah menulis kode contoh, lakukan self-check: *"Apakah setiap fungsi/method yang saya tulis benar-benar ada di dokumentasi resmi?"* Jika ragu, jalankan `search_web` untuk verifikasi. Jangan pernah menulis kode berdasarkan tebakan.

### FM-3: Copy-Paste Documentation Verbatim
- **Gejala**: AI menyalin teks dokumentasi resmi secara mentah tanpa reformulasi, kontekstualisasi, atau penambahan contoh production-ready.
- **Pencegahan**: Konten WAJIB direformulasi ke dalam format standar kita (narasi singkat → kode production-ready → anti-pattern → edge cases). Informasi dari docs resmi harus diadaptasi, bukan di-copy-paste.

### FM-4: Inconsistent Depth (Kedalaman Tidak Merata)
- **Gejala**: Section 1 ditulis sangat mendalam (50 baris), tapi Section 3 dan 4 hanya 5 baris masing-masing.
- **Pencegahan**: Sebelum mendeklarasikan selesai, hitung jumlah baris per section. Jika ada section yang kurang dari 15 baris, itu pertanda section tersebut perlu diperdalam.

### FM-5: Missing Error Handling in Code Examples
- **Gejala**: Kode contoh tidak menangani error. Misalnya di Go: `result := doSomething()` tanpa `result, err := doSomething()`.
- **Pencegahan**: Setiap operasi yang bisa gagal (I/O, network, database, file) WAJIB memiliki penanganan error eksplisit. Ini adalah standar mutlak — tidak ada pengecualian.

### FM-6: Scope Creep (Keluar dari Topik)
- **Gejala**: File referensi tentang "Database Migrations" tiba-tiba membahas "Redis Caching" atau "Authentication" yang seharusnya ada di file referensi lain.
- **Pencegahan**: Setiap file referensi harus fokus pada SATU sub-topik saja. Jika ingin merujuk topik lain, cukup tulis: *"Untuk detail tentang X, lihat file referensi `{nama_file}.md`."*

### FM-7: Placeholder & TODO Comments
- **Gejala**: Kode contoh mengandung `// TODO: implement this`, `panic("not implemented")`, `fmt.Println("debug")`, atau variabel bernama `dummy`, `test`, `foo`, `bar`.
- **Pencegahan**: Zero tolerance. Setiap baris kode harus production-ready. Jika belum bisa menulis implementasi lengkap, jangan tulis kode tersebut sama sekali — lakukan research lebih lanjut via `search_web`.

### FM-8: Outdated Version References
- **Gejala**: Menulis contoh kode untuk Go 1.18 padahal Go 1.23 sudah tersedia, atau menulis contoh Laravel 10 padahal Laravel 12 sudah ada.
- **Pencegahan**: Selalu gunakan `search_web` untuk mengecek versi terbaru bahasa/framework sebelum menulis kode. Jika ada breaking changes antara versi, sebutkan secara eksplisit.

### FM-9: Premature Domain Splitting (Pecah Berdasarkan Angka, Bukan Semantik)
- **Gejala**: Agent memecah 1 sub-folder domain menjadi 2 semata-mata karena jumlah file melebihi angka tertentu, tanpa mengevaluasi apakah ada file *cross-cutting* yang dibutuhkan oleh kedua hasil pecahan.
- **Contoh Buruk**: Memecah domain `microservices_grpc` (6 file) menjadi `api_web` dan `grpc_rpc`, padahal `api_versioning_contracts.md` dibutuhkan oleh REST API dan gRPC sekaligus — menyebabkan ambiguitas penempatan file.
- **Pencegahan**: Sebelum memecah domain, WAJIB jawab: *"Apakah ada file di domain ini yang dibutuhkan oleh kedua hasil pecahan secara bersamaan?"* Jika YA → **DILARANG PECAH**. Pecahan hanya sah jika dua kelompok file memiliki paradigma/use-case yang 100% independent (zero overlap). Lihat panduan lengkap di `architecture_pattern.md` Section 4.

### FM-10: Mid-Task Degradation Syndrome (Kualitas Menurun di Tengah Generasi)
- **Gejala**: Domain ke-1 dan ke-2 ditulis dengan research mendalam, kode production-ready, dan edge-cases lengkap. Namun mulai domain ke-4 atau ke-5, kualitas mulai turun drastis: konten diambil dari hafalan LLM tanpa `search_web`, kode contoh menjadi lebih dangkal, anti-pattern section mengecil, dan edge-cases mulai dihilangkan. Domain terakhir seringkali hanya 40-60% kualitas domain pertama.
- **Root Cause**: LLM mendeteksi pola repetitif pada task multi-domain panjang dan secara implisit memprioritaskan kecepatan penyelesaian di atas kualitas output.
- **Pencegahan**:
  1. **DILARANG** menganggap waktu sebagai constraint. Task generasi skill bundle boleh memakan waktu 1 jam, 1 hari, atau lebih — kualitas adalah satu-satunya metric keberhasilan.
  2. **WAJIB** jalankan Per-Domain Checkpoint Gate (lihat `quality_audit_checklist.md` Section 8) sebelum lanjut ke domain berikutnya. Jika domain saat ini belum lulus checkpoint → perbaiki dulu, jangan lanjut.
  3. **WAJIB** jalankan `search_web` untuk SETIAP domain secara independen — DILARANG mengisi domain ke-N dari hafalan domain ke-N-1 yang serupa.
  4. **WAJIB** jalankan Self-Correction Checklist (Section 2 dokumen ini) untuk SETIAP file referensi yang ditulis, bukan hanya file pertama.

---

## 2. Self-Correction Protocol (Wajib Dijalankan Sebelum Selesai)

Setelah selesai menulis 1 file referensi, Agent WAJIB menjalankan checklist koreksi mandiri berikut:

### Checklist Self-Correction (Per File Referensi):

```
□ DEPTH CHECK: Apakah setiap section memiliki kedalaman yang memadai (>15 baris)?
□ API VERIFY: Apakah setiap fungsi/method/package yang disebut benar-benar ada?
   → Jika ragu, jalankan search_web untuk verifikasi.
□ ERROR HANDLING: Apakah setiap operasi yang bisa gagal ditangani secara eksplisit?
□ ANTI-PATTERN: Apakah ada minimal 1 contoh pola SALAH (❌) dengan penjelasan?
□ EDGE CASES: Apakah ada minimal 1 skenario tepi yang ditangani?
□ ZERO PLACEHOLDER: Apakah ada komentar TODO, panic(), atau variabel dummy?
   → Jika ya, hapus dan ganti dengan implementasi nyata.
□ SCOPE FOCUS: Apakah konten tetap fokus pada 1 sub-topik tanpa keluar jalur?
□ LENGTH CHECK: Apakah total baris berada di rentang 100-400 baris?
   → Jika <100: konten terlalu dangkal, perluas.
   → Jika >400: konten terlalu lebar, pecah menjadi 2 file.
□ VERSION CHECK: Apakah kode contoh menggunakan versi terbaru bahasa/framework?
□ DOMAIN SPLIT CHECK: Jika memecah/mendesain sub-folder domain baru, sudahkah diverifikasi zero cross-cutting concern antar domain?
   → Jika ada file yang dibutuhkan oleh >1 domain hasil pecahan → DILARANG PECAH.
```

---

## 3. Teknik Peningkatan Kualitas untuk Model Kecil

### 3.1. Chain-of-Thought Explicit
Model kecil menghasilkan output lebih baik jika dipandu langkah demi langkah. Saat menulis file referensi:
1. Tulis section 1 (Konsep) terlebih dahulu, lalu review.
2. Tulis section 2 (Implementasi) terlebih dahulu, lalu review.
3. Tulis section 3 (Anti-Pattern) terlebih dahulu, lalu review.
4. Tulis section 4 (Edge Cases) terlebih dahulu, lalu review.
5. Gabungkan semua section, lalu jalankan Self-Correction Checklist.

### 3.2. Pattern Mimicry dari Golden Reference
Sebelum menulis file referensi baru, WAJIB baca `golden_reference_example.md` terlebih dahulu. Gunakan struktur, gaya penulisan, dan kedalaman konten dari contoh tersebut sebagai pola acuan.

### 3.3. Iterative Deepening via search_web
Jika merasa konten masih dangkal setelah menulis draft pertama:
1. Jalankan `search_web` dengan query spesifik tentang edge-case topik tersebut.
2. Tambahkan temuan baru ke section Anti-Pattern atau Edge Cases.
3. Ulangi sampai checklist Self-Correction terpenuhi 100%.
