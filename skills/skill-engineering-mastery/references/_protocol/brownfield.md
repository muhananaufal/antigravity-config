# Brownfield — Protokol Forensik & Blast Radius Repo Eksisting

> [!WARNING]
> **SSOT Override:** Segala instruksi di file ini (termasuk pembentukan Swarm subagent, Day-0 Quintet, RFC, dan Matriks) **TUNDUK** pada pengecualian di AGENTS.md §2 dan §7. Jika proyek berukuran kecil atau sekadar edit minor, **ABAIKAN** instruksi berat di file ini dan langsung tulis kode. DILARANG spawn subagent untuk tugas yang tidak memenuhi syarat di §7.

> Dipicu dari `SKILL.md` saat menghadapi repo yang sudah ada (`go.mod`, `Cargo.toml`, `composer.json`, `package.json`, dll). **Baseline regresi (§3.4 `AGENTS.md`) WAJIB tuntas lebih dulu.**

**DILARANG:** Big Bang Rewrite · "Frankenstein Codebase" · Mengubah kode tanpa memetakan Blast Radius.

---

## 1. Rekonesans Forensik — Bentuk Tim Sesuai Kenyataan Repo

Pindai direktori root + manifest dependency **dulu**, baru sebar subagent paralel (1 per domain, sesuai `AGENTS.md` §7):

| Kondisi Repo | Bentuk Subagent | Target Audit & Concern |
| :--- | :--- | :--- |
| Modul/domain terpisah (`/Modules/Order`, `/crates/storage`, `/pkg/auth`) | **Domain Boundary Auditor** | Coupling antar modul, siklus import, isolasi data |
| Framework / ORM / Broker terdeteksi di manifest | **Runtime & Specialized Hunter** | GORM/Eloquent/Prisma $\rightarrow$ N+1 Hunter · Octane $\rightarrow$ State Leak Auditor · Tokio $\rightarrow$ Cancellation Hazard Hunter · Kafka $\rightarrow$ DLQ Auditor |
| Satu folder >30 berkas | **Layer Auditor** | Pecah ke 2–3 subagent per sub-fungsi (Handler vs Repository vs Service) |

---

## 2. Matriks Blast Radius & Forensic Audit (Wajib Sebelum RFC)

Subagent auditor wajib menyusun tabel forensik ini sebelum opsi arsitektur diajukan:

```markdown
### 🔍 Forensic Blast Radius Matrix
| Komponen yang Disentuh | Modul / Service Downstream Terdampak | Potensi Risiko / Failure Mode | Mitigasi Defensif (Guardrail) |
| :--- | :--- | :--- | :--- |
| Core Service / Repository | Downstream Worker & API Controller | Data inconsistency, lock contention | Transaction boundary & Idempotency key |
| Database Schema / Migration | Client API & Reporting Service | Broken query / Null constraint violation | Expand & Contract Migration Pattern |
```

---

## 3. Sajikan Opsi Arsitektur

Patuhi mutlak **Challenger Procedure di `AGENTS.md` §4** (minimal 3 opsi netral, tanpa label rekomendasi sepihak). Tuangkan opsi terpilih ke dalam `docs/rfc/YYYYMMDD-<fitur>.md` dan update `docs/rfc/README.md`.
