---
name: skill-engineering-mastery
description: Gunakan skill ini ketika membuat, merancang, mengaudit, atau merestrukturisasi Skill Bundles baru untuk domain, bahasa programming, atau framework apa pun (misal Golang, Rust, Python, Laravel, TypeScript, DevOps, dll) di ekosistem Antigravity.
---

# Skill Engineering Mastery (Meta-Mastery Engine 2.0)

SSOT perancangan & evolusi Skill Bundle: standar penulisan, protokol swarm, dan tata kelola kualitas otomatis.

## 💎 1. Filosofi Inti & Challenger Mode

| Hukum | Isinya |
| :--- | :--- |
| **Critical Challenger POV** | DILARANG yes-man, DILARANG shortcut (laziness), DILARANG narasi bertele-tele. Rancangan atau skop skill tidak rasional → tantang profesional dengan ≥3 opsi standar industri. |
| **Zero-Steering Grilling** | Saat menyajikan opsi arsitektur atau pembagian domain: WAJIB ≥3 opsi netral, tiap opsi ≥3 kelebihan & ≥3 kekurangan. DILARANG label "(Recommended)" sepihak — biarkan fakta teknis dan diskusi user yang memutuskan ("Gasskan"). |
| **Swarm Reference Loading** | DILARANG merancang, menulis kode, atau menjawab dari hafalan LLM. DILARANG `search_web` sebelum SELURUH referensi lokal dibedah tuntas. |
| **Sinkronisasi Sistem Wajib** | Setiap skill bahasa baru yang dibuat WAJIB terintegrasi ke: (1) `master_decision_tree.md` Bagian 1, (2) `AGENTS.md` §3.5, (3) `shared/tool-claude-code.md`. Tanpa integrasi ini, skill baru menjadi pulau terisolasi yang tidak pernah dipicu oleh sistem. |
| **Git Workflow Non-Negotiable** | Semua skill bahasa WAJIB menyertakan pointer ke `git-workflow/SKILL.md` dan `master_decision_tree.md` di bagian Protokol Eksekusi. Subagent yang dihasilkan dari skill ini DILARANG menulis file — hanya Main Agent yang boleh. |

---

## 📐 2. Zero-Tolerance Quality Bar untuk File Referensi (Top 1%)
Setiap file markdown (`.md`) yang ditempatkan di dalam direktori `references/` sebuah skill bundle WAJIB tunduk pada standar tanpa kompromi berikut:

| Kriteria Mutu | Standar WAJIB Zero-Tolerance Top 1% |
| :--- | :--- |
| **Kedalaman & Ukuran** | **≥130 - 200+ baris (target 12–20 KB per file)** murni materi teknis padat, mendalam, dan berbobot (*High Signal-to-Noise*). DILARANG KERAS ada padding kata kosong atau komentar bertele-tele hanya untuk memenuhi baris. |
| **Zero Placeholders** | **0 FLAGGED / 0 TODO:** DILARANG KERAS mencantumkan `// TODO`, `// TBD`, `// implementation logic here`, `# dst`, atau kode kosong. File tipis / stubs sampah (<90 baris) adalah KECACATAN FATAL yang harus dilenyapkan seketika! |
| **Diagram ASCII** | **≥1 Diagram ASCII Arsitektur/Alur Kerja** yang informatif, komprehensif, dan elegan per berkas untuk memetakan alur eksekusi, memori, atau topologi sistem. |
| **Kode Produksi Idiomatis** | Seluruh contoh kode WAJIB valid syntax, menyertakan import lengkap, type-safety ketat, penanganan error (*defensive programming*), context propagation, dan siap dikompilasi / dijalankan di lingkungan produksi riil. |
| **Unit & Verification Test** | WAJIB melampirkan blok tes pengujian nyata (`func Test...` di Go, `#[test]` di Rust, `test('...')` di Pest/Laravel, atau bash verifier script) yang memverifikasi behavior rumit di luar *happy path*. |
| **Anti-Patterns & Trade-Offs** | WAJIB mencantumkan **≥2 Anti-Patterns kritis spesifik domain**, dilengkapi blok kode perbandingan **❌ BAD / SALAH vs ✅ GOOD / BENAR** serta penjelasan mendalam MENGAPA hal tersebut berakibat fatal (memory leak, N+1 query, OWASP hazard). |
| **Production Edge Cases** | WAJIB mencantumkan **≥3 Kasus Tepi Produksi (Edge Cases)** yang mengupas cara penanganan kondisi ekstrem (timeout DB lock, network partition, DST timezone jumps, atau OOM memory pressure). |
| **Bahasa & Tata Rasa** | Penjelasan naratif WAJIB menggunakan **Bahasa Indonesia** yang lugas dan berwibawa, sedangkan seluruh kode, variabel, config, dan istilah teknis tetap dalam Bahasa Inggris standar industri. |

---

## 🏛️ 3. Arsitektur & Skop Domain Skill Bundle ("The Holy Trinity Blueprint")
Struktur direktori sebuah skill bundle diatur dalam tata susunan modular bermutu tinggi:

```
<skill-name>/
├── SKILL.md              # Frontmatter YAML + Dynamic Swarm Protocols + Routing Table
└── references/           # Direktori referensi ilmu (tersusun bertingkat berdasar domain)
    ├── <domain-core-1>/  # Rumpun Core WAJIB (misal: arch, db_sqlc, concurrency, security)
    │   ├── topic_a.md
    │   └── topic_b.md
    ├── <domain-niche-1>/ # Rumpun Niche Situasional (misal: hft_zero_alloc, k8s_operators)
    │   └── ...
    └── ...
```

### Panduan Jumlah Domain & Berkas

| Kelas skill | Domain | Berkas/domain | Total |
| :--- | :--- | :--- | :--- |
| Bahasa backend utama (Go, Rust, Laravel, Python, Java, C++) | 26–31 | 4–10 | ~130–200 berkas · 1,5–2,5 MB |
| Framework frontend / tooling (React, Vue, Docker, Tailwind, Terraform) | 10–15 | 4–8 | ~40–100 berkas |
| Niche / library (Pinia, Axios, Redis Client, Zustand) | 5–8 | 4–6 | ~25–50 berkas |

**Domain WAJIB terpeta pada skill bahasa backend utama:** Concurrency/Async · Persistence & SQL · Clean Architecture · Security OWASP · Testing & Fuzzing · Cloud-Native K8s Operators · Cloud Provider Serverless SDK · Multilevel Caching RAM/Redis/CDN · Distributed Jobs & Saga Rollback · Zero-Trust Enterprise Security · Media Asset Pipeline (SIMD/Streaming) · CI/CD & SBOM Supply Chain Defense · i18n/ICU Intl.

---

## 🚦 4. Protokol Eksekusi (WAJIB dibaca sesuai situasi)

| Situasi | WAJIB baca dulu sebelum menulis apa pun |
| :--- | :--- |
| Inisiasi project baru dari nol (empty folder / new repository) | `references/_protocol/greenfield.md` |
| Tambah fitur / modifikasi / optimasi / audit di repo eksisting | `references/_protocol/brownfield.md` |

DILARANG membuat dokumen RFC (`docs/rfc/`) atau menulis kode sebelum protokol yang relevan dibaca tuntas.

## 🧭 5. Routing Table (WAJIB Baca Sebelum Perancangan mau pun Audit Skill Bundle)
Sebelum Anda merilis, mengedit, atau membangun sebuah Skill Bundle baru, **WAJIB konsultasikan tabel panduan rute referensi lokal ini menggunakan tool `view_file`**:

| Topik Task & Tantangan Rekayasa Skill | WAJIB Baca File Referensi Lokal |
| :--- | :--- |
| Desain arsitektur skill bundle, struktur folder, tata nama, & konvensi 26–31 domain Holy Trinity | `references/architecture_pattern.md` |
| Menulis dan memoles `SKILL.md`, YAML frontmatter, pilar Greenfield/Brownfield, & Auto-Detect table | `references/skill_md_template.md` |
| Pedoman rekayasa integrasi tata kelola Swarm Dinamis, pembelahan agen elastis, & Brownfield Grilling | `references/dynamic_swarm_protocols.md` **[NEW & CRITICAL]** |
| Hukum standar penulisan file referensi `.md`, batas ≥130 baris, zero TODO, diagram ASCII, & trade-offs | `references/reference_file_standards.md` |
| Spesimen cetak biru berkas referensi sempurna 100% tanpa ringkasan untuk ditiru (*The Golden Blueprint*) | `references/golden_reference_example.md` |
| Pengawasan dan audit otomatis PowerShell/Terminal, penghitungan AvgKB, & tata kelola `quality_tracker.md` | `references/automated_quality_governance.md` **[NEW & CRITICAL]** |
| Metodologi penambangan ilmu lokal vs fallback web, pembedahan kode open-source, & ekstraksi internals | `references/research_mining_methodology.md` |
| Diagnosis kegagalan AI (laziness, shortcut, flattery, hallucination) & penegakan *Self-Review Gate* | `references/failure_modes_self_correction.md` |
| Efisiensi token budget, High Signal-to-Noise ratio Bahasa Indonesia, & pencegahan context bloat | `references/token_budget_optimization.md` |
| 7 Lapis Daftar Periksa (*Pre-Flight Sign-Off Checklist*) sebelum menyatakan tugas pemrograman/skill selesai | `references/quality_audit_checklist.md` |

---

## 🛠️ 6. Automated Quality Governance (Eksekusi Terminal WAJIB Sebelum Selesai)
Sebelum melaporkan pekerjaan rekayasa skill bundle selesai, WAJIB jalankan skrip inspektor pemburu cacat di terminal untuk membaptis keabsahan materi Anda (hukum **0 FLAGGED FILES**):

```powershell
# Skrip Pemotong Leher File Tipis & Pembahak // TODO (Zero-Tolerance Audit di Windows PowerShell)
$SkillFolder = "golang-mastery" # Ganti dengan nama folder skill yang diaudit
$path = "C:\Users\muhan\.gemini\config\skills\$SkillFolder\references"
$files = Get-ChildItem -Path $path -Recurse -Filter '*.md'
$flagged = @()
$totalSize = 0; $totalFiles = 0

foreach ($f in $files) {
    $sizeKB = $f.Length / 1KB; $totalSize += $sizeKB; $totalFiles++
    $content = @(Get-Content -Path $f.FullName) -join "`n"
    $lines = @(Get-Content -Path $f.FullName).Count
    $todo = ($content -match "//\s*TODO" -or $content -match "//\s*TBD" -or $content -match "#\s*TODO")
    if ($lines -lt 120 -or $todo) { $flagged += "$($f.Directory.Name)/$($f.Name) (Lines: $lines, TODO: $todo)" }
}

Write-Host "Total Files: $totalFiles | Avg Size: $([math]::Round($totalSize / $totalFiles, 2)) KB"
if ($flagged.Count -gt 0) { Write-Host "❌ FLAGGED ($($flagged.Count)):" -ForegroundColor Red; $flagged } 
else { Write-Host "✅ ZERO FLAGGED FILES! 100% TOP 1% VERIFIED!" -ForegroundColor Green }
```

---

## 🖧 7. SOP Integrasi Skill Bahasa Baru ke Ekosistem

Setiap kali skill bahasa baru (misal: Python, Java, Swift) selesai dibuat, WAJIB menyelesaikan **5-langkah integrasi** berikut sebelum skill dianggap production-ready:

| Langkah | Aksi | File yang Diubah |
| :--- | :--- | :--- |
| **1. Decision Tree** | Tambahkan bahasa baru ke Bagian 1 (NODE 1.1) `master_decision_tree.md` dengan constraint dan use case yang tepat | `~/.gemini/config/skills/master-decision-tree/SKILL.md` |
| **2. AGENTS.md** | Tambahkan nama bahasa ke daftar domain bermastery di §3.5 (contoh: "Go / Rust / Laravel / NestJS / **Python**") | `~/.gemini/config/AGENTS.md` §3.5 |
| **3. Claude Code Adaptor** | Tambahkan bahasa ke tabel penerjemah istilah di `shared/tool-claude-code.md` jika ada padanan tool yang berbeda | `~/.gemini/config/shared/tool-claude-code.md` |
| **4. Skill SKILL.md** | Pastikan SKILL.md bahasa baru memuat: pointer ke `master_decision_tree.md`, pointer ke `git-workflow/SKILL.md`, Protokol Eksekusi Greenfield/Brownfield, Quality Gate commands | `skills/<bahasa>-mastery/SKILL.md` |
| **5. Verifikasi** | Trace alur: User input → AGENTS.md routing → master_decision_tree → SKILL.md baru → greenfield/brownfield protocol. Semua link harus terhubung. | Manual cross-check |

> **DILARANG** merilis skill bahasa baru sebelum kelima langkah ini selesai. Skill yang tidak terintegrasi ke routing global tidak akan pernah dipicu secara otomatis oleh sistem.
