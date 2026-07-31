# Token Budget Optimization: Panduan Efisiensi System Prompt

Dokumen ini berisi panduan untuk menjaga konsumsi token pada system prompt tetap efisien saat mengelola Skill Bundles di Antigravity.

---

## 1. Arsitektur Token: Apa yang Masuk ke System Prompt

### 1.1. Komponen System Prompt per Skill Bundle

| Komponen | Estimasi Token | Dibaca Setiap Percakapan? |
| :--- | :--- | :--- |
| `name` di YAML frontmatter | ~5–10 token | ✅ Ya — selalu |
| `description` di YAML frontmatter | ~40–80 token | ✅ Ya — selalu |
| Isi `SKILL.md` (di luar YAML) | ~0 token | ❌ Tidak — hanya saat trigger |
| Isi `references/<domain>/*.md` | ~0 token | ❌ Tidak — hanya saat dibutuhkan |

**Insight kritis:** Yang membebani system prompt bukanlah isi `SKILL.md` atau file referensi, melainkan YAML frontmatter yang terdaftar. Ini berarti jumlah Master Bundles (bukan jumlah file referensi) yang menentukan overhead.

### 1.2. Diagram: Token Flow di System Prompt

```
System Prompt
├── AGENTS.md rules (~200-400 token) — selalu dimuat
├── Skill Bundle #1 YAML (~75 token) — selalu dimuat
│   └── golang-mastery: name + description
├── Skill Bundle #2 YAML (~75 token) — selalu dimuat
│   └── rust-mastery: name + description
├── Skill Bundle #3 YAML (~75 token) — selalu dimuat
│   └── skill-engineering-mastery: name + description
└── (SKILL.md isi + references → dibaca via view_file, tidak memakan budget)

Total Overhead: ~225 token dari skill bundles (~1.1% dari 20K budget)
```

---

## 2. Kalkulasi Token Budget

### 2.1. Rumus Estimasi

```
Total Token Skill = Jumlah_Master_Bundles × ~75 token
```

**Perbandingan arsitektur:**

| Arsitektur | Jumlah Bundle | Token | % Budget (20K) | Status |
|---|---|---|---|---|
| ✅ Master Bundle (saat ini) | 3 | ~225 | ~1.1% | Optimal |
| ⚠️ Sedikit lebih banyak | 6 | ~450 | ~2.25% | Masih aman |
| 🟡 Mulai berat | 12 | ~900 | ~4.5% | Perhatikan |
| ❌ Micro-Skill lama (26 folder) | 26 | ~1.950 | ~10-15% | Berbahaya |

### 2.2. Threshold Rekomendasi per Kategori

| Kategori | Target Budget | Status |
| :--- | :---: | :--- |
| **AGENTS.md rules** | < 5% | 🟢 Sehat |
| **Total Skills (semua YAML)** | < 3% | 🟢 Sehat |
| **MCP Tools** | < 2% | 🟢 Sehat |
| **Total Customization** | < 10% | 🟢 Optimal |
| **Total Customization** | 10–25% | 🟡 Hati-hati |
| **Total Customization** | > 25% | 🔴 Risiko auto-truncation |

---

## 3. Optimasi Deskripsi YAML

### 3.1. Teknik Kompresi Tanpa Kehilangan Trigger Accuracy

Gunakan teknik berikut untuk mempersingkat deskripsi tanpa mengorbankan cakupan topik:

| Teknik | Sebelum | Sesudah |
|---|---|---|
| **Hapus kata kerja redundan** | `membuat, merancang, membangun, mengimplementasikan` | `merancang` |
| **Gabungkan domain serumpun** | `concurrency, goroutine, channel, mutex, waitgroup` | `konkurensi` |
| **Singkat nama ekosistem** | `di Laravel PHP framework` | `di Laravel` |
| **1 kata kunci per domain** | `PostgreSQL, pgx, sqlc, migrations, pool` | `DB/SQLC` |

### 3.2. Contoh Kompresi Nyata

```yaml
# ❌ SEBELUM — 85 kata, ~120 token, terlalu verbose
description: Gunakan skill ini secara otomatis ketika user meminta untuk membuat,
  merancang, membangun, mengimplementasikan, menstandardisasi, atau memformat API
  Resources JSON, menangani Exception global dan error handling, mengkonfigurasi
  otentikasi Laravel Sanctum token-based, membangun webhook architecture, membuat
  OpenAPI atau Swagger documentation, atau menguji dan testing REST API endpoint
  di Laravel framework PHP.

# ✅ SESUDAH — 25 kata, ~35 token, same trigger coverage
description: Gunakan skill ini ketika merancang arsitektur, API resources,
  otentikasi Sanctum, Eloquent DB, konkurensi, security, testing, atau
  refactoring legacy code di Laravel.
```

**Saving: ~85 token (-71%) tanpa kehilangan trigger accuracy.**

---

## 4. Anti-Patterns Token Budget

### ❌ Anti-Pattern 1: Mendaftarkan Sub-Folder Domain sebagai Skill Terpisah

```
# SALAH — 8 skill terpisah, ~600 token overhead:
config/skills/
├── golang-concurrency/     ← YAML #1, ~75 token
├── golang-database/        ← YAML #2, ~75 token
├── golang-grpc/            ← YAML #3, ~75 token
├── golang-security/        ← YAML #4, ~75 token
├── golang-testing/         ← YAML #5, ~75 token
├── golang-hft/             ← YAML #6, ~75 token
├── golang-k8s/             ← YAML #7, ~75 token
└── golang-distributed/     ← YAML #8, ~75 token

# BENAR — 1 master bundle, ~75 token overhead:
config/skills/
└── golang-mastery/
    └── references/
        ├── concurrency/    ← 0 token overhead
        ├── db_sqlc/        ← 0 token overhead
        ├── security_owasp/ ← 0 token overhead
        └── ...             ← 0 token overhead
```

**Kenapa berbahaya:** 8 micro-skills = 8× overhead vs 1 master bundle. Dan karena deskripsi YAML masing-masing pendek, trigger accuracy justru LEBIH BURUK (setiap skill hanya mencakup sebagian topik).

### ❌ Anti-Pattern 2: Deskripsi YAML yang Menduplikasi Konten SKILL.md

```yaml
# SALAH — routing table di dalam YAML description (sangat boros token):
description: Gunakan skill ini ketika: (1) concurrency → references/concurrency/*.md,
  (2) database → references/db_sqlc/*.md, (3) grpc → references/microservices_grpc/*.md
  ...setiap domain disebutkan eksplisit...

# BENAR — trigger words saja di YAML, routing table ada di SKILL.md:
description: Gunakan skill ini ketika merancang konkurensi, DB/SQLC, gRPC, HFT,
  atau distributed systems di Golang.
```

---

## 5. Kapan Harus Konsolidasi atau Pisah

### Kondisi Konsolidasi (Gabung Bundle)
- Total skill bundles > 6 → pertimbangkan penggabungan ekosistem yang overlap.
- Dua bundle sering di-trigger bersamaan di > 80% skenario → gabungkan.
- Total token skills > 3% budget → audit dan kompres YAML.

### Kondisi Pemisahan (Buat Bundle Baru)
- Ekosistem benar-benar berbeda (Go vs Rust vs Python vs DevOps) — zero overlap.
- Tim berbeda menggunakan ekosistem berbeda dan tidak pernah perlu keduanya bersamaan.
- Skill baru memiliki ≥ 5 domain referensi yang tidak relevan dengan bundle manapun.

### Edge Case: Skill Niche vs Master Bundle

| Tipe Skill | Jumlah Domain | Jumlah File | Token | Keputusan |
|---|---|---|---|---|
| **Master Bundle** (Go, Rust) | 15–25 | 100–200 | ~75 token | Satu bundle |
| **Niche Skill** (k6 load testing, Terraform) | 3–8 | 15–40 | ~75 token | Satu bundle juga |
| **Meta-Skill** (skill-engineering) | 1 (flat) | 6–10 | ~75 token | Satu bundle |

**Insight:** Bahkan skill kecil tetap cukup satu Master Bundle — jangan dipecah hanya karena file-nya sedikit.
