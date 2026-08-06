# Brownfield Go — Protokol Forensik & Blast Radius Repo Eksisting

> Dipicu dari `SKILL.md` saat tambah fitur / refactor / optimasi / audit pada repo ber-`go.mod`. **Baseline regresi (§3.4 `AGENTS.md`) WAJIB tuntas lebih dulu.**

**DILARANG:** Big Bang Rewrite · "Frankenstein Codebase" · Mengubah kode tanpa memetakan Blast Radius.

---

## 1. Rekonesans Forensik — Bentuk Tim Sesuai Kenyataan Repo

Pindai struktur direktori + `go.mod` **dulu**, baru sebar subagent tier `pro` (3–10, elastis):

| Kondisi Repo | Fokus Audit Subagent | Target Berkas & Concern |
| :--- | :--- | :--- |
| Modul/Domain terpisah (`internal/order`, `pkg/auth`) | **Domain Boundary Auditor** | Coupling antar-package, isolasi dependensi, cyclic imports |
| `gorm.io/gorm` terdeteksi | **GORM N+1 & Lock Hunter** | Preload absen, query dalam loop, transaction locking |
| `sqlx` / `database/sql` | **Raw SQL & Index Auditor** | Parameter binding SQLi, table scan tanpa index, leak `rows.Close()` |
| `segmentio/kafka-go` / RabbitMQ | **Broker & DLQ Auditor** | Message ack leak, outbox pattern absen, DLQ failure |
| Goroutine / Channel intensif | **Concurrency & Race Auditor** | Unbuffered channel deadlock, goroutine leak tanpa `context.Context` |
| **Selalu, tepat 1** | **Mastery Standard Matcher** | Konsolidasi seluruh temuan auditor, baca `references/` yang relevan, lalu susun Matriks Blast Radius |

---

## 2. Matriks Blast Radius & Forensic Audit (Wajib Sebelum RFC)

Subagent auditor wajib menyusun tabel forensik ini sebelum opsi arsitektur diajukan:

```markdown
### 🔍 Forensic Blast Radius Matrix
| Komponen yang Disentuh | Modul / Service Downstream Terdampak | Potensi Risiko / Failure Mode | Mitigasi Defensif (Guardrail) |
| :--- | :--- | :--- | :--- |
| `internal/order/repo.go` | `payment_worker`, `invoice_generator` | Lock contention pada row `orders` | SELECT FOR UPDATE SKIP LOCKED / Index |
| Skema DB `users` table | `auth_middleware`, `reporting_batch` | Kolom baru memicu error pada query `SELECT *` legacy | Expand & Contract (Nullable column) |
```

---

## 3. Sajikan ≥3 Opsi Arsitektur — Zero-Steering Grilling

| Opsi | Kapan Cocok | Konsekuensi & Guardrail |
| :--- | :--- | :--- |
| **Native Consistent Extension** (KISS) | Pola repo masih sehat, tim lama harus tetap paham | Cepat & konsisten. WAJIB tetap suntik `context.WithTimeout`, parameterized query, RED metrics, index DB. |
| **Strangler Fig** | Modul baru bisa berdiri sendiri | Modul baru pakai `internal/` Clean/SQLC, tersambung ke legacy hanya lewat facade/interface. Kode lama utuh. |
| **Surgical Rewrite & Hardening** | Modul lama fatal (race condition, pembayaran rentan) | Bedah modul lama sekalian bangun fitur barunya. Paling mahal, paling bersih. |

DILARANG memberi label "(Recommended)" sepihak — lihat §4 `AGENTS.md`. Tuangkan opsi terpilih ke dalam `docs/rfc/YYYYMMDD-<fitur>.md` dan update `docs/rfc/README.md`.
