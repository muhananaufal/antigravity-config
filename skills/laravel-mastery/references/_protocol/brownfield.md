# Brownfield Laravel — Protokol Forensik & Blast Radius Repo Eksisting

> Dipicu dari `SKILL.md` saat tambah fitur / refactor / optimasi / audit pada repo ber-`composer.json`. **Baseline regresi (§3.4 `AGENTS.md`) WAJIB tuntas lebih dulu.**

**DILARANG:** Big Bang Rewrite · "Frankenstein Codebase" · Mengubah kode tanpa memetakan Blast Radius.

---

## 1. Rekonesans Forensik — Bentuk Tim Sesuai Kenyataan Repo

Pindai struktur direktori + `composer.json` + config framework **dulu**, baru sebar subagent tier `pro` (3–10, elastis):

| Kondisi Repo | Fokus Audit Subagent | Target Berkas & Concern |
| :--- | :--- | :--- |
| Modular / DDD (`Modules/Order`) | **Domain Boundary Auditor** | Cross-domain Eloquent query, direct model binding lintas modul |
| `laravel/octane` terdeteksi | **Octane State Leak Auditor** | Properti `static`, stateful singleton di Service Provider |
| Eloquent intensif / Queue | **Eloquent N+1 & Queue Hunter** | Query tanpa `->with()`, pagination hilang, job tanpa `$afterCommit` |
| Endpoint API/Web | **Security & OWASP Auditor** | IDOR, Mass Assignment `$fillable`, raw query SQLi, missing rate-limiting |
| **Selalu, tepat 1** | **Mastery Standard Matcher** | Konsolidasi seluruh temuan auditor, baca `references/` yang relevan, lalu susun Matriks Blast Radius |

---

## 2. Matriks Blast Radius & Forensic Audit (Wajib Sebelum RFC)

Subagent auditor wajib menyusun tabel forensik ini sebelum opsi arsitektur diajukan:

```markdown
### 🔍 Forensic Blast Radius Matrix
| Komponen yang Disentuh | Modul / Job Queue Downstream Terdampak | Potensi Risiko / Failure Mode | Mitigasi Defensif (Guardrail) |
| :--- | :--- | :--- | :--- |
| Model `User` / `Order` | Background Horizon Queue workers | Serialization payload pecah saat worker menjalankan job lama | Model $afterCommit & DTO primitives |
| Skema database Eloquent | Public REST API resources & Web views | Response API berubah tanpa sadar (regression) | API Resource wrapping + Feature test |
```

---

## 3. Sajikan ≥3 Opsi Arsitektur — Zero-Steering Grilling

| Opsi | Kapan Cocok | Konsekuensi & Guardrail |
| :--- | :--- | :--- |
| **Native Consistent Extension** (KISS) | Pola repo masih sehat | Cepat & konsisten. WAJIB tetap suntik `FormRequest` validation, `->paginate()`, eager loading, SLA k6, zero PHPStan level 9 error pada kode baru. |
| **Strangler Fig** | Modul baru bisa berdiri sendiri | Lapisan Clean Architecture: **FormRequest → Controller → Action/Service → Repository → Model**, struktur lawas tidak disentuh. |
| **Surgical Rewrite & Hardening** | Modul lama fatal (pembayaran/inventaris penuh N+1, race condition di Horizon/Queue) | Bedah modul lama sekalian bangun fitur barunya. Paling mahal, paling bersih. |

DILARANG memberi label "(Recommended)" sepihak — lihat §4 `AGENTS.md`. Tuangkan opsi terpilih ke dalam `docs/rfc/YYYYMMDD-<fitur>.md` dan update `docs/rfc/README.md`.
