# Architecture Pattern: Master Bundles + Progressive Disclosure

Dokumen ini menjelaskan pola arsitektur standar untuk merancang Skill Bundles di Antigravity.

---

## 1. Prinsip Dasar Arsitektur

### 1.1. Kenapa Tidak Boleh Membuat 1 Skill per Sub-Topik (*Micro-Skill Trap*)
- Setiap skill yang terdaftar di `.gemini/config/skills/` akan memakan **~75 token** pada system prompt di **SETIAP percakapan baru**.
- Jika membuat 26+ folder skill mikro, total konsumsi bisa mencapai **3.000+ token (15%+ budget)** — membuang budget untuk registri semata.
- Terlalu banyak skill dengan deskripsi mirip menyebabkan **Routing Ambiguity** — AI bingung memilih skill mana yang harus di-trigger.

### 1.2. Kenapa Tidak Boleh Menggabungkan Semua ke 1 File Raksasa (*Fat-Skill Trap*)
- File `SKILL.md` yang berisi >500 baris akan menyebabkan **Context Window Waste** — AI dipaksa membaca seluruh file padahal hanya butuh 1 sub-topik.
- Instruksi di baris ke-400+ berisiko diabaikan oleh LLM (*Instruction Drift*).

### 1.3. Solusi: Master Bundles + Sub-Folder Domain + Progressive Disclosure
- **Master Bundle**: 1 folder skill per *bahasa/ekosistem* (bukan per sub-topik). Berisi `SKILL.md` ultra-ringkas (~25-35 baris) sebagai indeks + tabel pemicu wildcard.
- **Sub-Folder Domain**: Sub-topik dikelompokkan berdasarkan **kesamaan semantik/fungsional** ke dalam sub-folder di `references/<domain>/`.
- **Progressive Disclosure**: Agent membaca SELURUH file di sub-folder domain yang bersangkutan via `view_file` saat dibutuhkan, bukan membaca 1 file saja.

---

## 2. Penentuan Jumlah Master Bundles

### 2.1. Aturan Pengelompokan Master Bundle
- Kelompokkan berdasarkan **Bahasa/Ekosistem**, bukan per domain teknis kecil.
- **Golden Range**: 3 – 6 Master Skill Bundles total per instalasi.
- Tiap Master Bundle dapat memiliki **5 – 20 sub-folder domain** di dalam `references/`.

### 2.2. Contoh Struktur Master Bundle (BENAR vs SALAH)
```
❌ SALAH (Micro-Skill / Flat — 26 Folder di config/skills/):
   golang-concurrency-engineering/
   golang-db-sqlc-storage/
   golang-security-owasp/
   laravel-api-mastery/
   laravel-db-mastery/
   ... (26 folder total)

✅ BENAR (Master Bundle — 3 Folder di config/skills/):
   golang-mastery/
   ├── SKILL.md
   └── references/
       ├── arch_patterns/          ← Sub-folder domain 1
       │   ├── clean_architecture.md
       │   └── modular_monolith.md
       ├── concurrency/            ← Sub-folder domain 2
       │   ├── goroutine_lifecycle_leaks.md
       │   └── channels_pipelines.md
       └── security_owasp/        ← Sub-folder domain 3
           ├── jwt_dual_token_auth.md
           └── casbin_rbac_abac.md

   laravel-mastery/
   ├── SKILL.md
   └── references/
       ├── arch/
       ├── api/
       └── security/

   skill-engineering-mastery/
   ├── SKILL.md
   └── references/
```

---

## 3. Penentuan Jumlah Sub-Folder Domain & File per Domain

### 3.1. Aturan Pemecahan Sub-Folder Domain
- Kelompokkan berdasarkan **Kesamaan Semantik & Fungsional**, bukan sekedar jumlah file.
- **Uji validitas pemecahan**: Jika ada file *Cross-Cutting Concern* (dibutuhkan oleh lebih dari 1 domain), DILARANG memecah — simpan bersama di 1 domain yang lebih luas.
- **Uji validitas penggabungan**: Jika 2 domain sering dipanggil bersamaan di >80% skenario, gabungkan menjadi 1 domain.

### 3.2. Golden Range Jumlah File per Domain
- **Minimum**: 2 file per domain (jika kurang, gabungkan ke domain lain).
- **Maksimum**: 8 file per domain (jika lebih, pertimbangkan pecah berdasarkan semantik bukan angka semata).
- **Ideal**: 4-6 file per domain.

---

## 4. Aturan Cross-Cutting Concern (Anti-Premature Split)

### 4.1. Definisi Cross-Cutting Concern
File referensi dikatakan *cross-cutting* jika ia **dibutuhkan oleh lebih dari 1 sub-folder domain** secara bersamaan. Contoh:
- `api_versioning_contracts.md` → dibutuhkan saat membuat REST API **dan** saat membuat gRPC. Tidak bisa dimasukkan ke salah satu tanpa merugikan yang lain.
- `clean_architecture.md` → dibutuhkan saat membangun Monolith **dan** saat menggunakan Event-Driven Outbox Pattern bersamaan.

### 4.2. Uji Validasi Sebelum Memecah Domain

Sebelum memecah 1 sub-folder domain menjadi 2, WAJIB jawab 2 pertanyaan ini:

| Pertanyaan | Jika YA | Jika TIDAK |
| :--- | :--- | :--- |
| Apakah ada file di domain ini yang dibutuhkan oleh **kedua** hasil pecahan secara bersamaan? | ❌ **JANGAN PECAH** — simpan di 1 domain yang lebih luas | ✅ Boleh lanjut evaluasi |
| Apakah dua kelompok file ini memiliki **use-case / paradigma yang 100% berbeda** dan tidak pernah dipanggil bersamaan? | ✅ **PECAH** — keduanya benar-benar independent | ❌ **JANGAN PECAH** — terlalu berisiko tumpang tindih |

### 4.3. Contoh Nyata: Worth It vs Tidak Worth It

```
✅ WORTH IT — Pemecahan `distributed_systems` (9 file → 2 domain):
   distributed_consensus_storage/ (Raft, LSM, WAL, Gossip, VectorClocks)
   distributed_patterns_resilience/ (Saga, ConsistentHashing, MultiTenancy, FeatureFlags)
   → Zero overlap: developer yang butuh Saga Pattern TIDAK PERNAH butuh LSM Storage Engine bersamaan.

❌ TIDAK WORTH IT — Pemecahan `microservices_grpc` (6 file → 2 domain):
   api_web_protocols/ (REST, GraphQL, Webhooks)
   grpc_rpc/ (gRPC Protobuf, Interceptors, api_versioning_contracts)
   → ada api_versioning_contracts.md yang cross-cutting: dibutuhkan REST DAN gRPC sekaligus.
   → Membagi ini menyebabkan ambiguitas penempatan file.
```

---

## 5. Struktur Folder & Naming Convention

### 4.1. Struktur Folder Standar
```
.gemini/config/skills/
└── {ecosystem}-mastery/           ← 1 Master Bundle per ekosistem/bahasa
    ├── SKILL.md                   ← Protocol + Routing Table wildcard (25-35 baris)
    └── references/
        ├── {domain_a}/            ← Sub-folder domain (semantik homogen)
        │   ├── topic_1.md
        │   └── topic_2.md
        └── {domain_b}/
            ├── topic_3.md
            └── topic_4.md
```

### 4.2. Naming Convention
- **Folder Master Bundle**: `{ecosystem}-mastery` (misal: `golang-mastery`, `laravel-mastery`).
- **Sub-folder domain**: `{domain_semantik}` lowercase, underscore (misal: `arch_patterns`, `db_sqlc`, `security_owasp`).
- **File referensi**: `{nama_deskriptif}.md` — DILARANG prefix angka (`01_`, `02_`).
- Semua lowercase, underscore sebagai pemisah kata.
