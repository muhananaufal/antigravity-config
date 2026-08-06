# Greenfield Laravel — Protokol Init

> Dipicu dari `SKILL.md` saat proyek baru dari nol (`composer create-project`). **Gerbang Klarifikasi (§2 `AGENTS.md`) WAJIB tuntas lebih dulu.**

## 1. Riset — sebar subagent tier `pro`

| Subagent | WAJIB baca SELURUH berkas di |
| :--- | :--- |
| Arch, DB, Caching & Cloud DevOps | `arch/` `db/` `caching_strategy_cdn/` `devops_deployment/` `cloud_provider_aws_vapor/` `legacy_refactoring/` |
| API, Concurrency, Saga & Governance | `api/` `concurrency/` `background_jobs_saga/` `testing_automated/` `code_quality_governance/` |
| Runtime, Observability & Security | `php_runtime_internals/` `observability_apm/` `security/` `zero_trust_enterprise_security/` `microservices_mesh/` |
| +1 per domain niche | sesuai tabel Auto-Detect di `SKILL.md` |

3 core WAJIB, niche elastis — 3 niche terdeteksi berarti 6 subagent paralel. DILARANG menulis kode atau dokumen RFC (`docs/rfc/`) sebelum semua subagent melapor.

## 2. Day-0 Quintet — WAJIB ada di root

| Pilar | Isi wajib |
| :--- | :--- |
| Container 3-tier | `docker-compose.yml` FrankenPHP/Octane + Postgres/Valkey · profile `telemetry` OTel+Prometheus RED+Grafana+Loki · profile `stress` k6. **DILARANG auto-run `docker build`/`up`.** |
| Config fail-fast | `.env.example` bersih + validasi ketat lewat `config()`. WAJIB throw exception saat boot bila env wajib hilang, sebelum melayani request. |
| Lifecycle & isolasi Octane | Bersihkan state leak (`flush` services di `config/octane.php`) · graceful shutdown worker queue & container Octane · flush buffer log ke Loki |
| Migrasi & seeder | `database/migrations/` lengkap + `database/seeders/DatabaseSeeder.php` idempotent untuk akun admin awal |
| Task runner | `Makefile`/`composer scripts`: `dev` (Octane/FrankenPHP) · `infra-up`/`down` · `telemetry-up` · `migrate` · `seed` · `test` (Pest) · `stress` (k6) |

## 3. Fase implementasi

Patuhi standar yang sudah diekstrak subagent. `view_file` ke referensi spesifik HANYA bila butuh contoh kode konkret.
