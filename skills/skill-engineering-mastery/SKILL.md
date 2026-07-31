---
name: skill-engineering-mastery
description: Gunakan skill ini ketika membuat, merancang, atau merestrukturisasi Skill Bundles baru untuk domain/bahasa/framework apa pun (misal Golang, Rust, Python, DevOps, dll).
---

# Skill Engineering Mastery

SSOT standar pembuatan & audit Skill Bundles di ekosistem Antigravity.

## 🔁 Protocol & Routing Table

1. WAJIB `view_file` SELURUH file referensi di `references/` sebelum merespon — DILARANG mengarang dari hafalan LLM.
2. WAJIB sajikan minimal 2-3 opsi arsitektur netral + trade-off saat Grilling.

## 📐 Quality Bar untuk Reference Files (Top 1%)

Setiap file referensi yang dibuat WAJIB memenuhi semua kriteria berikut:

| Kriteria | Standar Minimum |
| :--- | :--- |
| **Ukuran file** | 8–15 KB per file (konten padat, bukan padding) |
| **Diagram ASCII** | ≥1 diagram arsitektur/flow yang informatif per file |
| **Kode production-ready** | Import lengkap, error handling, context propagation — bisa dikompilasi |
| **Unit test** | `func Test...` (Go) / `#[cfg(test)]` (Rust) yang relevan per file |
| **Anti-patterns** | ≥2 anti-pattern SPESIFIK dengan penjelasan MENGAPA berbahaya + kode salah vs benar |
| **Edge cases** | ≥3 edge case dengan defensive programming konkrit per file |
| **Bahasa** | Narasi Bahasa Indonesia, kode & identifier teknis Bahasa Inggris |
| **Spesifisitas** | Konten spesifik per topik — DILARANG generic boilerplate |

## 🏗️ Struktur Skill Bundle

```
<skill-name>/
├── SKILL.md              # Frontmatter YAML + Protocol Rules + Routing Table
└── references/
    ├── <domain-1>/       # Sub-folder per domain (5–10 file per domain)
    │   ├── topic_a.md
    │   └── topic_b.md
    └── <domain-2>/
        └── ...
```

**Panduan jumlah domain & file:**
- Skill baru (bahasa/framework): 15–25 domain, 5–10 file per domain → total ~120–200 file
- Skill niche (tool/library): 5–10 domain, 5–8 file per domain → total ~30–80 file
- Domain prioritas tinggi (core, concurrency, DB): 8–10 file
- Domain niche (embedded, game, AI): 5–6 file

## 🤖 Workflow Pembuatan Paralel (Subagent)

Untuk skill bundle besar (>50 file), gunakan subagent paralel:
1. Define `<lang>-writer` subagent dengan quality bar di atas sebagai system prompt
2. Kelompokkan domain menjadi batch 2–3 domain per subagent
3. Spawn maksimal 5 subagent paralel (hindari quota exhaustion)
4. Verifikasi dengan PowerShell setelah semua selesai:
   ```powershell
   $files = Get-ChildItem -Recurse -File "$baseDir\*.md"
   ($files | Select-String "func Test" -List).Count   # unit tests
   ($files | Select-String "Edge Cases" -List).Count  # edge cases
   ($files | Select-String "Anti-Pattern" -List).Count # anti-patterns
   ```

| Topik Task | WAJIB Baca File Referensi |
| :--- | :--- |
| Desain arsitektur, folder structure, naming convention, jumlah domain | `references/architecture_pattern.md` |
| Menulis `SKILL.md`, YAML frontmatter, trigger words, routing table | `references/skill_md_template.md` |
| Cara research, menggali sumber, query search_web, verifikasi konten | `references/research_mining_methodology.md` |
| Standar penulisan file `references/`, format konten, depth level | `references/reference_file_standards.md` |
| Contoh konkret file referensi sempurna untuk ditiru | `references/golden_reference_example.md` |
| Mencegah kesalahan umum LLM, self-correction checklist | `references/failure_modes_self_correction.md` |
| Menghitung estimasi token budget, optimasi efisiensi system prompt | `references/token_budget_optimization.md` |
| Verifikasi & audit kualitas sebelum mendeklarasikan skill bundle selesai | `references/quality_audit_checklist.md` |
