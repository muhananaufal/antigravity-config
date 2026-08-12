# Greenfield Go — Protokol Init

> [!WARNING]
> **SSOT Override:** Segala instruksi di file ini (termasuk pembentukan Swarm subagent, Day-0 Quintet, RFC, dan Matriks) **TUNDUK** pada pengecualian di AGENTS.md §2 dan §7. Jika proyek berukuran kecil atau sekadar edit minor, **ABAIKAN** instruksi berat di file ini dan langsung tulis kode. DILARANG spawn subagent untuk tugas yang tidak memenuhi syarat di §7.

> Dipicu dari `SKILL.md` saat proyek baru dari nol. **Gerbang Klarifikasi (§2 `AGENTS.md`) WAJIB tuntas lebih dulu.**

## 1. Riset — sebar subagent tier `pro`

| Subagent (1 per domain - sesuai `AGENTS.md` §7) | WAJIB baca SELURUH berkas di |
| :--- | :--- |
| Subagents Core | Domain dari tabel **Core References** di `SKILL.md` |
| Subagents Niche | Domain dari tabel **Auto-Detect** di `SKILL.md` |


## 2. Day-0 Quintet (HANYA jika proyek besar/menengah - lihat AGENTS.md §2)

| Pilar | Isi wajib |
| :--- | :--- |
| Container 3-tier | `docker-compose.yml` Postgres/Valkey · profile `telemetry` OTel+Prometheus+Grafana+Loki · profile `stress` k6. **DILARANG auto-run `docker build`/`up`.** |
| Config fail-fast | `.env.example` + `envconfig`/`caarlos0/env`. WAJIB panic sebelum `net.Listen` / `sql.Open` bila env invalid. |
| Graceful shutdown | `signal.NotifyContext` tangkap SIGINT/SIGTERM · `Shutdown(ctx)` 5–15 detik · `db.Close()` · OTel `tp.Shutdown(ctx)` · logger sync |
| Migrasi & seeder | `migrations/` (`golang-migrate`/`goose`) + `seed.sql` idempotent |
| Task runner | `Makefile`: `dev` (air) · `infra-up`/`down` · `telemetry-up` · `migrate` · `seed` · `test` · `stress` |

## 3. Fase implementasi

Patuhi standar yang sudah diekstrak subagent. `view_file` ke referensi spesifik HANYA bila butuh contoh kode konkret — Day-0 Quintet sudah mengunci fondasinya, jadi membaca ulang seluruh domain di fase ini membakar token tanpa menambah keputusan.

Urutan aman: `arch_patterns/` menentukan batas paket → `db_sqlc/` mengunci skema & query → `microservices_grpc/` membuka transport. DILARANG menulis handler sebelum skema terkunci (Contract-First, `AGENTS.md` §7).
