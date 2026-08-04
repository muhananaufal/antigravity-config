# Brownfield — Protokol Repo Eksisting

> Dipicu dari `SKILL.md` saat menghadapi repo yang sudah ada (`go.mod`, `Cargo.toml`, `composer.json`, `package.json`, dll). **Baseline regresi (§3.4 `AGENTS.md`) WAJIB tuntas lebih dulu.**

**DILARANG:** Big Bang Rewrite · "Frankenstein Codebase" · daftar subagent statis lawas yang tidak relevan.

## 1. Rekonesans — bentuk tim sesuai kenyataan repo

Pindai direktori root + manifest dependency **dulu**, baru sebar subagent tier `pro` (3–10, elastis):

| Kondisi repo | Bentuk subagent |
| :--- | :--- |
| Modul/domain terpisah (`/Modules/Order`, `/crates/storage`, `/pkg/auth`) | 1 auditor per modul/folder |
| Library khas terdeteksi di manifest | Auditor pemburu bug khas library itu — GORM → N+1 Hunter · Octane → State Leak Auditor · Tokio → Cancellation Hazard Hunter · Kafka → DLQ Auditor · GraphQL → resolver N+1 |
| Satu folder >30 berkas | Pecah ke 2–3 subagent per sub-fungsi (Handler vs Repository vs Service) |
| **Selalu, tepat 1** | **Mastery Standard Matcher** — konsolidasi seluruh temuan auditor, lalu baca HANYA berkas `references/` yang jadi obat untuk temuan itu |

DILARANG memukul rata memanggil spesialis kripto/AI bila repo tidak punya fitur uang atau AI.

## 2. Sajikan ≥3 opsi — Zero-Steering Grilling

| Opsi | Kapan cocok | Konsekuensi |
| :--- | :--- | :--- |
| **Native Consistent Extension** (KISS) | Ekspresi codebase setempat masih sehat | Konsisten dengan tim developer lama. WAJIB tetap suntik parameterized query, timeout, zero lint warning. |
| **Strangler Fig** | Modul baru bisa berdiri sendiri | Lingkungan terisolasi berstandar modern, tersambung ke kode kuno hanya lewat facade/proxy. |
| **Surgical Rewrite & Hardening** | Modul lama berlumur cacat fatal (mis. race condition ekstrem di modul pembayaran) | Bedah modul lama sejalan dengan pembangunan fitur barunya. |

DILARANG memberi label "(Recommended)" sepihak — lihat §4 `AGENTS.md`.
