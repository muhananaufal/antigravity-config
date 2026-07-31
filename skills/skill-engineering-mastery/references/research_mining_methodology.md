# Research & Knowledge Mining Methodology

Dokumen ini menjelaskan proses sistematis untuk menggali, memverifikasi, dan mengekstrak pengetahuan berkualitas tinggi (*Principal/Staff Engineer grade*) yang akan menjadi isi file referensi di folder `references/`.

---

## 1. Prinsip Dasar: Kenapa Proses Research Ini Krusial

LLM memiliki pengetahuan bawaan (*parametric knowledge*) yang luas namun:
- **Bisa Usang**: Informasi training data mungkin sudah ketinggalan versi (misal: Go 1.18 vs Go 1.23 punya fitur berbeda).
- **Bisa Dangkal**: LLM cenderung memberikan jawaban "tutorial blog level" jika tidak dipaksa mendalami.
- **Bisa Halusinasi**: LLM bisa menghasilkan API/fungsi/pattern yang tidak pernah ada.

**Solusi**: Setiap kali menulis konten file referensi, Agent WAJIB mengikuti hierarki fallback berikut **secara berurutan**:
1. **Skill-First**: Baca SELURUH file referensi di skill bundle yang relevan (`references/<domain>/*.md`) terlebih dahulu. Jika informasi sudah ditemukan di sana → gunakan, tidak perlu lanjut ke langkah berikutnya.
2. **Search-Web**: HANYA jalankan `search_web` jika sudah benar-benar yakin bahwa informasi yang dibutuhkan tidak ada di skill bundle manapun.

> **⏱️ Waktu Bukan Constraint — Kualitas Adalah Satu-Satunya Metric:**
> Task generasi skill bundle boleh memakan waktu 1 jam, 1 hari, atau lebih. DILARANG mempercepat proses dengan mengorbankan kedalaman research, kelengkapan kode, atau kualitas edge-cases. Setiap domain harus diselesaikan dengan standar yang **identik** dengan domain pertama — tidak ada penurunan kualitas yang dapat diterima di domain ke-N hanya karena task sudah berjalan lama.

---

## 2. Hirarki Sumber Pengetahuan (Wajib Diikuti Berurutan)

Saat mencari materi untuk 1 file referensi, ikuti urutan prioritas ini:

### Prioritas 1 — Official Specification & Source Code (SSOT Mutlak)
- **Apa**: Dokumentasi resmi bahasa/framework, RFC specs, dan source code runtime/compiler.
- **Contoh Query `search_web`**:
  - `"golang.org spec memory model"` ← untuk Go memory model.
  - `"laravel framework source code Illuminate Database Query Builder"` ← untuk internal Laravel query builder.
  - `"RFC 7807 Problem Details for HTTP APIs"` ← untuk standar error format API.
  - `"Go runtime source malloc.go mheap"` ← untuk Go memory allocator internals.
- **Cara Ekstraksi**: Baca halaman dokumentasi resmi via `read_url_content`, lalu rangkum poin-poin kritis.

### Prioritas 2 — Industry Style Guides & Engineering Standards
- **Apa**: Panduan gaya kode dan arsitektur dari perusahaan besar yang sudah teruji di skala produksi.
- **Contoh Query `search_web`**:
  - `"Uber Go style guide best practices"` ← standar kode Go Uber.
  - `"Google Go code review guidelines"` ← standar code review Google.
  - `"HashiCorp Terraform plugin architecture go-plugin"` ← arsitektur plugin HashiCorp.
  - `"CockroachDB engineering blog raft consensus Go"` ← implementasi Raft di Go.
  - `"Cloudflare engineering blog Go concurrency patterns"` ← pola concurrency Cloudflare.
- **Cara Ekstraksi**: Identifikasi aturan/pattern yang konsisten di >2 perusahaan besar → jadikan standar di file referensi kita.

### Prioritas 3 — Engineering Blogs & Conference Talks
- **Apa**: Blog teknis dari perusahaan besar, presentasi GopherCon/KubeCon, dan paper akademis.
- **Contoh Query `search_web`**:
  - `"GopherCon talk advanced concurrency patterns slides"`.
  - `"Stripe engineering blog idempotency key design"`.
  - `"Shopify engineering blog flash sale race condition prevention"`.
- **Cara Ekstraksi**: Cross-reference klaim di blog dengan dokumentasi resmi. Jika cocok, adopsi. Jika kontradiksi, prioritaskan dokumentasi resmi.

### Prioritas 4 — Verified Community Knowledge (Fallback Terakhir)
- **Apa**: Artikel komunitas, Stack Overflow answers, tutorial yang sudah diverifikasi.
- **Aturan Ketat**: HANYA gunakan jika Prioritas 1-3 tidak memiliki informasi yang dibutuhkan.
- **Cara Verifikasi**: Pastikan informasi dari sumber komunitas dikonfirmasi oleh minimal 1 sumber dari Prioritas 1 atau 2.

---

## 3. Workflow Research Sistematis per File Referensi

Untuk setiap file referensi yang akan ditulis, ikuti workflow ini:

### Tahap 3.1 — Identifikasi Sub-Topik & Kata Kunci
```
Input: Nama file referensi (misal: "goroutine_lifecycle_leaks.md")
   ↓
Output: Daftar kata kunci research
   ├── "Go goroutine lifecycle management"
   ├── "Go goroutine leak detection goleak"
   ├── "Go goroutine leak pprof diagnosis"
   ├── "Go context cancellation goroutine cleanup"
   └── "Uber Go goroutine leak prevention best practices"
```

### Tahap 3.2 — Eksekusi Research (search_web + read_url_content)
```
Untuk setiap kata kunci:
   ├── Jalankan search_web("{kata kunci}")
   ├── Dari hasil search, pilih 2-3 URL paling relevan (prioritaskan docs resmi & engineering blogs)
   ├── Jalankan read_url_content("{url}") untuk mengekstrak konten
   └── Catat poin-poin kritis dalam format bullet points
```

### Tahap 3.3 — Cross-Reference & Verifikasi
```
Untuk setiap klaim/pattern yang akan ditulis:
   ├── Apakah klaim ini didukung oleh dokumentasi resmi? → ✅ Tulis
   ├── Apakah klaim ini hanya dari 1 blog tanpa konfirmasi? → ⚠️ Verifikasi ulang
   └── Apakah klaim ini kontradiksi dengan docs resmi? → ❌ Buang
```

### Tahap 3.4 — Penulisan Konten Final
```
Setelah research & verifikasi selesai:
   ├── Tulis konten mengikuti standar di reference_file_standards.md
   ├── Sertakan contoh kode production-ready
   ├── Sertakan anti-pattern (pola yang SALAH)
   └── Sertakan edge-case handling
```

---

## 4. Teknik Query search_web yang Efektif

### 4.1. Formula Query Optimal
```
"{bahasa/framework} {topik spesifik} {konteks industri/best practice}"
```

### 4.2. Contoh Query BAIK vs BURUK

| ❌ Query Buruk (Terlalu Umum) | ✅ Query Baik (Spesifik & Terarah) |
| :--- | :--- |
| `"golang concurrency"` | `"Go goroutine leak detection uber goleak pprof"` |
| `"laravel database"` | `"Laravel Eloquent N+1 query prevention eager loading best practices"` |
| `"rust memory"` | `"Rust ownership borrow checker lifetime annotation patterns"` |
| `"API error handling"` | `"RFC 7807 Problem Details HTTP API error format implementation"` |

### 4.3. Query untuk Menemukan Anti-Patterns
Tambahkan kata kunci negatif untuk menemukan kesalahan umum:
```
"{bahasa} {topik} common mistakes pitfalls anti-pattern"
"{bahasa} {topik} what NOT to do production"
```

---

## 5. Batasan & Aturan Etika Research

1. **DILARANG** menulis konten berdasarkan asumsi atau "tebakan terdidik" LLM tanpa verifikasi.
2. **DILARANG** meng-copy-paste konten panjang dari sumber tanpa reformulasi dan adaptasi ke format standar kita.
3. **WAJIB** menyesuaikan semua contoh kode agar memenuhi standar Zero-Placeholder & Production-Ready.
4. **WAJIB** menggunakan versi terbaru dari bahasa/framework (misal: Go 1.23+, Laravel 11+, Rust 2024 edition) kecuali ada alasan teknis untuk backward compatibility.
