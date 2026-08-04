# Brownfield Rust — Protokol Repo Eksisting

> Dipicu dari `SKILL.md` saat tambah fitur / refactor / optimasi / audit pada repo ber-`Cargo.toml`. **Baseline regresi (§3.4 `AGENTS.md`) WAJIB tuntas lebih dulu.**

**DILARANG:** Big Bang Rewrite · "Frankenstein Codebase" · daftar subagent statis yang tidak relevan dengan repo.

## 1. Rekonesans — bentuk tim sesuai kenyataan repo

Lirik struktur direktori + `Cargo.toml` (termasuk workspace crates) **dulu**, baru sebar subagent tier `pro` (3–10, elastis):

| Kondisi repo | Bentuk subagent |
| :--- | :--- |
| Cargo Workspace / modul terpisah (`/crates/api`, `/crates/storage`) | 1 auditor per crate |
| `tokio` terdeteksi | **Tokio Concurrency Auditor** — cancellation safety pada `tokio::select!`, blocking I/O tanpa `spawn_blocking`, deadlock `Mutex` melintasi `.await` |
| `sqlx` / `sea-orm` terdeteksi | **DB & N+1 Hunter** — loop query, koneksi tanpa pool, skema tanpa migrasi aman |
| Blok `unsafe` / FFI terdeteksi | **Unsafe Provenance Auditor** — pointer aliasing, transmute hazard, kepatuhan Stacked Borrows / Miri |
| Satu crate >30 berkas | Pecah per fungsi: Handler & Middleware vs Repository & Entity |
| **Selalu, tepat 1** | **Mastery Standard Matcher** — konsolidasi seluruh temuan auditor, lalu baca HANYA referensi yang jadi obatnya |

DILARANG memanggil spesialis kripto/game bila repo tidak punya fitur blockchain atau game.

## 2. Sajikan ≥3 opsi — Zero-Steering Grilling

| Opsi | Kapan cocok | Konsekuensi |
| :--- | :--- | :--- |
| **Native Consistent Extension** (KISS) | Pola repo masih sehat | Cepat & konsisten. WAJIB tetap suntik `thiserror`, timeout di panggilan eksternal, `Weak<T>` pemutus siklus `Arc<T>`, zero clippy warning. |
| **Strangler Fig** | Modul baru bisa berdiri sendiri | Crate baru di workspace atau modul terisolasi berstandar Top 1%, kode lama tidak disentuh. |
| **Surgical Rewrite & Hardening** | Modul lama fatal (race condition, bocor memori di `unsafe`) | Bedah modul lama sekalian bangun fitur barunya. Paling mahal, paling bersih. |

DILARANG memberi label "(Recommended)" sepihak — lihat §4 `AGENTS.md`.
