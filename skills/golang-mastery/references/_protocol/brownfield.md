# Brownfield Go — Protokol Repo Eksisting

> Dipicu dari `SKILL.md` saat tambah fitur / refactor / optimasi / audit. **Baseline regresi (§3.3 `AGENTS.md`) WAJIB tuntas lebih dulu.**

**DILARANG:** Big Bang Rewrite · "Frankenstein Codebase" · daftar subagent statis yang tidak relevan dengan repo.

## 1. Rekonesans — bentuk tim sesuai kenyataan repo

Lirik struktur direktori + `go.mod` **dulu**, baru sebar subagent tier `pro` (3–10, elastis):

| Kondisi repo | Bentuk subagent |
| :--- | :--- |
| Terbagi modul/domain (`/order`, `/user`, `/payment`) | 1 auditor per modul |
| `gorm.io/gorm` terdeteksi | N+1 GORM Hunter |
| `kafka-go` terdeteksi | Kafka DLQ Auditor |
| `graphql` terdeteksi | Auditor resolver & N+1 |
| Satu folder >30 berkas | Pecah per layer: Handler/API vs Query/Repository |
| **Selalu, tepat 1** | **Mastery Standard Matcher** — konsolidasi seluruh temuan auditor, lalu baca HANYA referensi yang jadi obatnya. WAJIB membedah `zero_downtime_migrations.md` bila skema DB lama ikut berubah. |

DILARANG memanggil spesialis fintech/moneter bila repo tidak punya fitur uang.

## 2. Sajikan ≥3 opsi — Zero-Steering Grilling

| Opsi | Kapan cocok | Konsekuensi |
| :--- | :--- | :--- |
| **Native Consistent Extension** (KISS) | Pola repo masih sehat, tim lama harus tetap paham | Cepat & konsisten. WAJIB tetap suntik timeout, parameterized query, RED metrics, index DB. |
| **Strangler Fig** | Modul baru bisa berdiri sendiri | Modul baru pakai `internal/` Clean/SQLC, tersambung ke legacy hanya lewat facade/proxy. Kode lama utuh. |
| **Surgical Rewrite** | Modul lama fatal (race condition, pembayaran rentan) | Bedah modul lama sekalian bangun fitur barunya. Paling mahal, paling bersih. |

DILARANG memberi label "(Recommended)" sepihak — lihat §4 `AGENTS.md`.
