# Brownfield — Protokol Forensik & Blast Radius Repo Eksisting

> Dipicu dari `SKILL.md` saat menghadapi repo yang sudah ada (`go.mod`, `Cargo.toml`, `composer.json`, `package.json`, dll). **Baseline regresi (§3.4 `AGENTS.md`) WAJIB tuntas lebih dulu.**

**DILARANG:** Big Bang Rewrite · "Frankenstein Codebase" · Mengubah kode tanpa memetakan Blast Radius.

---

## 1. Rekonesans Forensik — Bentuk Tim Sesuai Kenyataan Repo

Pindai direktori root + manifest dependency **dulu**, baru sebar subagent tier `pro` (3–10, elastis):

| Kondisi Repo | Bentuk Subagent | Target Audit & Concern |
| :--- | :--- | :--- |
| Modul/domain terpisah (`/Modules/Order`, `/crates/storage`, `/pkg/auth`) | **Domain Boundary Auditor** | Coupling antar modul, siklus import, isolasi data |
| Framework / ORM / Broker terdeteksi di manifest | **Runtime & Specialized Hunter** | GORM/Eloquent/Prisma $\rightarrow$ N+1 Hunter · Octane $\rightarrow$ State Leak Auditor · Tokio $\rightarrow$ Cancellation Hazard Hunter · Kafka $\rightarrow$ DLQ Auditor |
| Satu folder >30 berkas | **Layer Auditor** | Pecah ke 2–3 subagent per sub-fungsi (Handler vs Repository vs Service) |
| **Selalu, tepat 1** | **Mastery Standard Matcher** | Konsolidasi seluruh temuan auditor, baca `references/` yang relevan, lalu susun Matriks Blast Radius |

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

## 3. Sajikan ≥3 Opsi Arsitektur — Zero-Steering Grilling

| Opsi | Kapan Cocok | Konsekuensi & Guardrail |
| :--- | :--- | :--- |
| **Native Consistent Extension** (KISS) | Pola repo masih sehat | Konsisten dengan tim developer lama. WAJIB tetap suntik parameterized query, timeout, zero lint warning. |
| **Strangler Fig** | Modul baru bisa berdiri sendiri | Lingkungan terisolasi berstandar modern, tersambung ke kode kuno hanya lewat facade/proxy. |
| **Surgical Rewrite & Hardening** | Modul lama fatal (mis. race condition ekstrem di modul pembayaran) | Bedah modul lama sejalan dengan pembangunan fitur barunya. |

DILARANG memberi label "(Recommended)" sepihak — lihat §4 `AGENTS.md`. Tuangkan opsi terpilih ke dalam `docs/rfc/YYYYMMDD-<fitur>.md` dan update `docs/rfc/README.md`.
