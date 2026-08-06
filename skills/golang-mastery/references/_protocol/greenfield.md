# Greenfield Go — Protokol Init

> Dipicu dari `SKILL.md` saat proyek baru dari nol. **Gerbang Klarifikasi (§2 `AGENTS.md`) WAJIB tuntas lebih dulu.**

## 1. Riset — sebar subagent tier `pro`

| Subagent | WAJIB baca SELURUH berkas di |
| :--- | :--- |
| Infra & Data | `arch_patterns/` `db_sqlc/` `devops_control_planes/` |
| API & Logic | `microservices_grpc/` `testing_quality/` `concurrency/` |
| Security & Resilience | `security_owasp/` `observability_resilience/` `distributed_patterns_resilience/` `caching_strategy/` |
| +1 per domain niche | sesuai tabel Auto-Detect di `SKILL.md` |

3 core WAJIB, niche elastis — 4 niche terdeteksi berarti 7 subagent paralel. DILARANG menulis dokumen RFC (`docs/rfc/`) sebelum semua subagent melapor.

## 2. Day-0 Quintet — WAJIB ada di root

| Pilar | Isi wajib |
| :--- | :--- |
| Container 3-tier | `docker-compose.yml` Postgres/Valkey · profile `telemetry` OTel+Prometheus+Grafana+Loki · profile `stress` k6. **DILARANG auto-run `docker build`/`up`.** |
| Config fail-fast | `.env.example` + `envconfig`/`caarlos0/env`. WAJIB panic sebelum `net.Listen` / `sql.Open` bila env invalid. |
| Graceful shutdown | `signal.NotifyContext` tangkap SIGINT/SIGTERM · `Shutdown(ctx)` 5–15 detik · `db.Close()` · OTel `tp.Shutdown(ctx)` · logger sync |
| Migrasi & seeder | `migrations/` (`golang-migrate`/`goose`) + `seed.sql` idempotent |
| Task runner | `Makefile`: `dev` (air) · `infra-up`/`down` · `telemetry-up` · `migrate` · `seed` · `test` · `stress` |
