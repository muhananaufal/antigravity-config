# Reference File Standards: Standar Kualitas Konten File Referensi

Dokumen ini menetapkan standar kualitas untuk setiap file referensi di folder `references/` agar kontennya setara dengan pengetahuan **Principal/Staff Engineer tingkat industri**.

---

## 1. Prinsip Utama Penulisan Konten Referensi

### 1.1. Source-Code Level Mining (Bukan Rangkuman AI Pasaran)
- **DILARANG** menulis penjelasan umum yang bisa ditemukan di tutorial blog pemula.
- **WAJIB** menggali pengetahuan dari sumber tingkat rendah:
  - Dokumentasi resmi bahasa/framework (Go spec, Laravel docs, Rust reference).
  - Source code runtime/compiler (misal: Go `src/runtime/`, Laravel `vendor/laravel/framework/src/`).
  - Style guide industri teruji (Uber Go Style Guide, Google Go Best Practices, Airbnb JS Style Guide).
  - RFC & spesifikasi protokol (RFC 7807 untuk error format, RFC 7540 untuk HTTP/2, dll).
- **Gunakan `search_web`** untuk menemukan dan memverifikasi informasi dari sumber resmi sebelum menulis.

### 1.2. Zero-Placeholder Code Standard
Setiap contoh kode dalam file referensi WAJIB memenuhi kriteria:

| Kriteria | Aturan |
| :--- | :--- |
| **Executable** | Kode harus bisa di-copy-paste dan langsung berjalan (dengan dependensi yang disebutkan). |
| **Production-Ready** | Tidak boleh ada `// TODO`, `panic()`, variabel `dummy`, atau `fmt.Println("debug")`. |
| **Error Handling** | Setiap operasi yang bisa gagal WAJIB ditangani (`if err != nil`, `try-catch`, dll). |
| **Context-Aware** | Untuk bahasa yang mendukung context (Go, dll), selalu propagasi `ctx context.Context`. |
| **Type-Safe** | Tidak boleh ada `any`, `interface{}` tanpa assertion, atau `mixed` tanpa validasi. |
| **Unit Test** | WAJIB sertakan `func Test...` (Go) / `#[cfg(test)]` (Rust) / test method per file. Test WAJIB spesifik per topik — bukan sekadar smoke test. |

### 1.3. Anti-Pattern Coverage
Setiap file referensi WAJIB menyertakan **minimal 2 anti-pattern SPESIFIK** dengan:
- Kode contoh yang SALAH (❌) beserta penjelasan MENGAPA berbahaya.
- Kode perbaikan yang BENAR (✅).
- DILARANG anti-pattern generik ("jangan hardcode") tanpa contoh konkret topik tersebut.

### 1.4. Defensive Edge-Case Coverage
Setiap file referensi WAJIB mencakup **minimal 3 edge-case spesifik** untuk topik tersebut:
- Input kosong/null/zero-value.
- Timeout & cancellation.
- Concurrent access & race condition.
- Resource cleanup (defer, finally, dispose).
- Skenario batas (integer overflow, connection exhaustion, dll) yang relevan per topik.

---

## 2. Struktur Internal File Referensi

Setiap file referensi di `references/` WAJIB mengikuti struktur berikut:

```markdown
# {Judul Sub-Topik}

{1-2 paragraf penjelasan singkat mengapa topik ini penting dan kapan digunakan.}

---

## 1. {Konsep Utama / Teori Inti}
{Penjelasan konsep fundamental. WAJIB menyertakan Diagram Alur / Arsitektur ASCII (ASCII Flow & Architecture Diagram) untuk memvisualisasikan alur data, lifecycle, atau layer boundaries.}

## 2. {Implementasi Production-Ready}
{Contoh kode lengkap yang siap digunakan di production.}

## 3. {Anti-Patterns & Kesalahan Umum}
{Pola yang SALAH beserta penjelasan mengapa salah dan cara memperbaikinya.}

## 4. {Edge Cases & Defensive Handling}
{Penanganan skenario tepi yang sering diabaikan.}
```

---

## 3. Ukuran & Kedalaman Ideal File Referensi

| Metrik | Standar |
| :--- | :--- |
| **Minimum** | 5 KB / ~120 baris (di bawah ini konten terlalu dangkal) |
| **Target** | **8–15 KB** / ~200–400 baris (standar top 1%) |
| **Maksimum** | 20 KB (jika lebih, pecah menjadi 2 file terpisah) |

**Checklist kedalaman per file:**
- [ ] Diagram ASCII ≥1 (arsitektur/flow yang informatif)
- [ ] Kode production-ready ≥1 (bisa dikompilasi, import lengkap)
- [ ] Unit test ≥1 yang relevan per topik
- [ ] Anti-pattern ≥2 (spesifik per topik, kode salah + benar)
- [ ] Edge cases ≥3 (konkrit, bukan generic)

> **Catatan**: File berukuran 3-5 KB hampir pasti terlalu dangkal untuk referensi tingkat Principal/Staff Engineer. Target minimum yang realistis adalah 8 KB.

---

## 4. Bahasa Penulisan

- **Penjelasan / narasi**: Bahasa Indonesia (mengikuti aturan global `AGENTS.md`).
- **Kode program, nama variabel, istilah teknis**: Bahasa Inggris.
- **Komentar di dalam kode**: Bahasa Inggris (agar universal dan tidak memerlukan translasi jika di-copy ke production).

---

## 5. Sumber Pengetahuan yang Wajib Dirujuk

Saat menulis konten file referensi, gunakan hirarki sumber berikut:

1. **Prioritas 1 (SSOT Utama)**: Dokumentasi resmi & source code bahasa/framework.
2. **Prioritas 2 (Industry Standard)**: Style guide perusahaan besar (Uber, Google, HashiCorp, Cloudflare, CockroachDB).
3. **Prioritas 3 (Verified Community)**: Blog engineering perusahaan besar, RFC specifications, paper akademis.
4. **Prioritas 4 (Fallback)**: Artikel komunitas yang sudah diverifikasi kebenarannya via `search_web`.

**DILARANG**: Menulis berdasarkan "asumsi umum" atau "pengetahuan bawaan LLM" tanpa verifikasi dari sumber di atas.
