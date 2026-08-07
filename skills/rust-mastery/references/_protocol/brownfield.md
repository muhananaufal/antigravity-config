# Brownfield Rust — Protokol Forensik & Blast Radius Repo Eksisting

> Dipicu dari `SKILL.md` saat tambah fitur / refactor / optimasi / audit pada repo ber-`Cargo.toml`. **Baseline regresi (§3.4 `AGENTS.md`) WAJIB tuntas lebih dulu.**

**DILARANG:** Big Bang Rewrite · "Frankenstein Codebase" · Mengubah kode tanpa memetakan Blast Radius.

---

## 1. Rekonesans Forensik — Bentuk Tim Sesuai Kenyataan Repo

Pindai struktur direktori + `Cargo.toml` (termasuk workspace crates) **dulu**, baru sebar subagent tier `pro` (3–10, elastis):

| Kondisi Repo | Fokus Audit Subagent | Target Berkas & Concern |
| :--- | :--- | :--- |
| Workspace / Crates (`crates/api`, `crates/db`) | **Crate Boundary Auditor** | Trait coupling, cyclic dependency, public API breaking change |
| `tokio` async intensif | **Tokio Concurrency Auditor** | Cancellation safety pada `tokio::select!`, blocking I/O tanpa `spawn_blocking`, deadlock `Mutex` melintasi `.await` |
| `sqlx` / `sea-orm` terdeteksi | **DB & N+1 Hunter** | Loop query tanpa join, koneksi tanpa pool limit, migrasi tanpa fallback |
| Blok `unsafe` / FFI terdeteksi | **Unsafe Provenance Auditor** | Pointer aliasing, transmute hazard, kepatuhan Stacked Borrows / Miri |
| **Selalu, tepat 1** | **Mastery Standard Matcher** | Konsolidasi seluruh temuan auditor, baca `references/` yang relevan, lalu susun Matriks Blast Radius |

---

## 2. Matriks Blast Radius & Forensic Audit (Wajib Sebelum RFC)

Subagent auditor wajib menyusun tabel forensik ini sebelum opsi arsitektur diajukan:

```markdown
### 🔍 Forensic Blast Radius Matrix
| Komponen yang Disentuh | Modul / Downstream Crate Terdampak | Potensi Risiko / Failure Mode | Mitigasi Defensif (Guardrail) |
| :--- | :--- | :--- | :--- |
| Trait definition di `core_traits` | Seluruh crates implementer downstream | Breaking trait signature / compilation failure | Tambahkan default method / Extension Trait |
| `tokio::sync::Mutex` | Axum HTTP request handling loop | Async task starvation saat lock ditahan lintas `.await` | Ganti ke parking_lot Mutex non-async atau batasi scope guard |
```

---

## 3. Bahaya Khas Rust yang WAJIB Diperiksa

1. **`Mutex` ditahan lintas `.await`:** guard yang hidup melewati titik await menahan lock selama task tersuspensi — starvation, dan pada `tokio::sync::Mutex` bisa berujung deadlock. Persempit scope guard, atau pakai `parking_lot::Mutex` non-async.
2. **Blocking I/O di dalam async:** operasi berkas, kriptografi berat, atau panggilan sinkron tanpa `spawn_blocking` membekukan seluruh worker thread runtime, bukan hanya task itu.
3. **Cancellation hazard pada `tokio::select!`:** cabang yang kalah dibatalkan **di tengah jalan**. Future yang tidak cancel-safe akan kehilangan data yang sudah diambil dari socket atau channel.
4. **`unwrap()` di jalur produksi:** panic pada `None`/`Err` mematikan task, dan di banyak konfigurasi ikut mematikan proses. Gunakan `thiserror`/`anyhow` dengan propagasi eksplisit — kecuali di dalam test, di mana `unwrap()` justru idiomatik.
5. **Siklus `Arc<T>`:** dua struktur yang saling memegang `Arc` tidak pernah mencapai count nol. Memori bocor tanpa satu pun `unsafe`. Pemutusnya `Weak<T>`.

---

## 4. Sajikan ≥3 Opsi Arsitektur — Zero-Steering Grilling

| Opsi | Kapan Cocok | Konsekuensi & Guardrail |
| :--- | :--- | :--- |
| **Native Consistent Extension** (KISS) | Pola repo masih sehat | Cepat & konsisten. WAJIB tetap suntik `thiserror`, timeout di panggilan eksternal, `Weak<T>` pemutus siklus `Arc<T>`, zero clippy warning. |
| **Strangler Fig** | Modul baru bisa berdiri sendiri | Crate baru di workspace atau modul terisolasi berstandar Top 1%, kode lama tidak disentuh. |
| **Surgical Rewrite & Hardening** | Modul lama fatal (race condition, bocor memori di `unsafe`) | Bedah modul lama sekalian bangun fitur barunya. Paling mahal, paling bersih. |

DILARANG memberi label "(Recommended)" sepihak — lihat §4 `AGENTS.md`. Tuangkan opsi terpilih ke dalam `docs/rfc/YYYYMMDD-<fitur>.md` dan update `docs/rfc/README.md`.
