# Brownfield Rust — Protokol Forensik & Blast Radius Repo Eksisting

> [!WARNING]
> **SSOT Override:** Segala instruksi di file ini (termasuk pembentukan Swarm subagent, Day-0 Quintet, RFC, dan Matriks) **TUNDUK** pada pengecualian di AGENTS.md §2 dan §7. Jika proyek berukuran kecil atau sekadar edit minor, **ABAIKAN** instruksi berat di file ini dan langsung tulis kode. DILARANG spawn subagent untuk tugas yang tidak memenuhi syarat di §7.

> Dipicu dari `SKILL.md` saat tambah fitur / refactor / optimasi / audit pada repo ber-`Cargo.toml`. **Baseline regresi (§3.4 `AGENTS.md`) WAJIB tuntas lebih dulu.**

**DILARANG:** Big Bang Rewrite · "Frankenstein Codebase" · Mengubah kode tanpa memetakan Blast Radius.

---

## 1. Rekonesans Forensik — Bentuk Tim Sesuai Kenyataan Repo

Pindai struktur direktori + `Cargo.toml` (termasuk workspace crates) **dulu**, baru sebar subagent paralel (1 per domain, sesuai `AGENTS.md` §7):

| Kondisi Repo | Fokus Audit Subagent | Target Berkas & Concern |
| :--- | :--- | :--- |
| Workspace / Crates (`crates/api`, `crates/db`) | **Crate Boundary Auditor** | Trait coupling, cyclic dependency, public API breaking change |
| `tokio` async intensif | **Tokio Concurrency Auditor** | Cancellation safety pada `tokio::select!`, blocking I/O tanpa `spawn_blocking`, deadlock `Mutex` melintasi `.await` |
| `sqlx` / `sea-orm` terdeteksi | **DB & N+1 Hunter** | Loop query tanpa join, koneksi tanpa pool limit, migrasi tanpa fallback |
| Blok `unsafe` / FFI terdeteksi | **Unsafe Provenance Auditor** | Pointer aliasing, transmute hazard, kepatuhan Stacked Borrows / Miri |
| Broker terdeteksi (`rdkafka`, `async-nats`, `lapin`) | **Broker & DLQ Auditor** | Ack hilang saat task dibatalkan, Transactional Outbox absen, DLQ tanpa jalur replay |

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
4. **`unwrap()` di jalur produksi:** Pelanggaran fatal terhadap Gerbang Mutlak `AGENTS.md` §0.4. Gunakan `thiserror`/`anyhow` dengan propagasi eksplisit — kecuali di dalam test, di mana `unwrap()` justru idiomatik.
5. **Siklus `Arc<T>`:** dua struktur yang saling memegang `Arc` tidak pernah mencapai count nol. Memori bocor tanpa satu pun `unsafe`. Pemutusnya `Weak<T>`.

---

