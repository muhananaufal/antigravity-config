---
name: skill-engineering-mastery
description: Gunakan skill ini ketika membuat, merancang, mengaudit, atau merestrukturisasi Skill Bundles baru untuk domain, bahasa programming, atau framework apa pun (misal Golang, Rust, Python, Laravel, TypeScript, DevOps, dll) di ekosistem Antigravity.
---

# Skill Engineering Mastery (Meta-Mastery Engine 2.0)

SSOT arsitektur, standar penulisan mahakarya, protokol *Dynamic Swarm Subagent*, dan sistem pengawasan tata kelola kualitas (*Automated Quality Governance*) untuk seluruh perancangan dan evolusi Skill Bundles di ekosistem Antigravity. Jantung mutlak rekayasa AI berspesifikasi Top 1% Global Engineer.

---

## 💎 1. Filosofi Inti & Challenger Mode (Anti-Yes-Man & Proactive Auditor)
Setiap penciptaan atau modifikasi skill bundle WAJIB ditaruh di bawah hukum penegakan kasta tertinggi:
1. **Critical Challenger POV:** DILARANG BERSICHER YES-MAN! Jangan pernah tunduk pada godaan shortcut AI (laziness), perlakuan bertele-tele (fluffy narrative), atau persetujuan buta atas instruksi berisiko. Jika rancangan atau skop skill tidak rasional, tantang secara profesional dengan menyodorkan ≥3 opsi standar industri abadi.
2. **Zero-Steering Grilling:** Dalam penyajian opsi arsitektur atau pembagian domain, WAJIB sajikan minimal 3 opsi teknis netral lengkap dengan trade-off absolut (≥3 kelebihan & ≥3 kekurangan). DILARANG menuliskan label "(Recommended)" secara sepihak; biarkan fakta teknis dan diskusi bersama user yang menentukan jalan eksekusi ("Gasskan").
3. **Swarm Reference Loading (Anti-Halusinasi):** DILARANG KERAS merancang, mengarang kode, atau menjawab instruksi pemrograman hanya mengandalkan ingatan hafalan LLM atau langsung memanggil `search_web` sebelum seluruh referensi lokal yang ada dibedah tuntas.

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

### Panduan Jumlah Domain & File (Standar Kasta Sultan):
*   **Skill Bahasa Backend Utama (ekosistem kelas berat seperti Golang, Rust, Laravel, Python, Java, C++):** WAJIB menargetkan **26–31 Domain** dengan **4–10 file per domain (total ~130–200 file mahakarya, 1.5 - 2.5 MB Murni)**. 
    *   *Domain WAJIB Terpeta:* Concurrency/Async, Persistence & SQL, Clean Architecture, Security OWASP, Testing & Fuzzing, Cloud-Native K8s Operators, Cloud Provider Serverless SDK, Multilevel Caching RAM/Redis/CDN, Distributed Jobs & Saga Rollbacks, Zero-Trust Enterprise Security, Media Asset Pipeline (SIMD/Streaming), CI/CD Pipeline & SBOM Supply Chain Defense, serta Internasionalisasi i18n/ICU Intl.
*   **Skill Framework Frontend / Tooling Khusus (React, Vue, Docker, Tailwind, Terraform):** 10–15 Domain, 4–8 file per domain → total ~40–100 file mahakarya.
*   **Skill Niche / Library Ekstra (Pinia, Axios, Redis Client, Zustand):** 5–8 Domain, 4–6 file per domain → total ~25–50 file.

---

## 🚦 4. Protokol Eksekusi (WAJIB dibaca sesuai situasi)

| Situasi | WAJIB baca dulu sebelum menulis apa pun |
| :--- | :--- |
| Inisiasi project baru dari nol (empty folder / new repository) | `references/_protocol/greenfield.md` |
| Tambah fitur / modifikasi / optimasi / audit di repo eksisting | `references/_protocol/brownfield.md` |

DILARANG membuat `implementation_plan.md` atau menulis kode sebelum protokol yang relevan dibaca tuntas.

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
$path = "C:\Users\muhan\.gemini\config\skills\<skill-folder-name>\references"
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
> **🏁 BERPEGANG TEGUH PADA PRINSIP: KEUNGGULAN SEJATI TERLAHIR DARI KETIDAKPUASAN TERHADAP MEDIOKRITAS DAN PENOLAKAN JALAN PINTAS!**
