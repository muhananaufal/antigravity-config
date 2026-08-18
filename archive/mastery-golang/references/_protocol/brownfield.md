# Brownfield Go — Protokol Forensik & Blast Radius Repo Eksisting

> [!WARNING]
> **SSOT Override:** Segala instruksi di file ini (termasuk pembentukan Swarm subagent, Day-0 Quintet, RFC, dan Matriks) **TUNDUK** pada pengecualian di AGENTS.md §2 dan §7. Jika proyek berukuran kecil atau sekadar edit minor, **ABAIKAN** instruksi berat di file ini dan langsung tulis kode. DILARANG spawn subagent untuk tugas yang tidak memenuhi syarat di §7.

> Dipicu dari `SKILL.md` saat tambah fitur / refactor / optimasi / audit pada repo ber-`go.mod`. **Baseline regresi (§3.4 `AGENTS.md`) WAJIB tuntas lebih dulu.**

**DILARANG:** Big Bang Rewrite · "Frankenstein Codebase" · Mengubah kode tanpa memetakan Blast Radius.

---

## 1. Rekonesans Forensik — Bentuk Tim Sesuai Kenyataan Repo

Pindai struktur direktori + `go.mod` **dulu**, baru sebar subagent paralel (1 per domain, sesuai `AGENTS.md` §7):

| Kondisi Repo | Fokus Audit Subagent | Target Berkas & Concern |
| :--- | :--- | :--- |
| Modul/Domain terpisah (`internal/order`, `pkg/auth`) | **Domain Boundary Auditor** | Coupling antar-package, isolasi dependensi, cyclic imports |
| `gorm.io/gorm` terdeteksi | **GORM N+1 & Lock Hunter** | Preload absen, query dalam loop, transaction locking |
| `sqlx` / `database/sql` | **Raw SQL & Index Auditor** | Parameter binding SQLi, table scan tanpa index, leak `rows.Close()` |
| `segmentio/kafka-go` / RabbitMQ | **Broker & DLQ Auditor** | Message ack leak, outbox pattern absen, DLQ failure |
| Goroutine / Channel intensif | **Concurrency & Race Auditor** | Unbuffered channel deadlock, goroutine leak tanpa `context.Context` |

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

## 3. Bahaya Khas Go yang WAJIB Diperiksa

1. **Goroutine leak:** `go func()` tanpa `context.Context` atau tanpa jalur keluar — goroutine menumpuk diam-diam sampai OOM. Setiap goroutine baru WAJIB punya pembatalan **dan** `defer recover()`.
2. **Panggilan eksternal tanpa timeout:** DB, Redis, gRPC, HTTP client tanpa `context.WithTimeout`. Satu dependensi lambat melumpuhkan seluruh layanan lewat pool yang habis.
3. **Pool koneksi default tak terbatas:** `SetMaxOpenConns`/`SetMaxIdleConns`/`SetConnMaxLifetime` absen. Beban puncak membuka ribuan koneksi dan menjatuhkan database, bukan aplikasinya.
4. **Untyped bypass & error yang ditelan:** Pelanggaran fatal terhadap Gerbang Mutlak `AGENTS.md` §0.4 dan §6.
5. **`go func()` disangka background job:** ia memberi NOL durabilitas (`LEARNED.md`). Server mati = pekerjaan hilang tanpa jejak. Tugas yang tidak boleh hilang WAJIB masuk queue durabel (Asynq/River).

---

