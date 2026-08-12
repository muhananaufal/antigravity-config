# Greenfield Laravel — Protokol Init

> [!WARNING]
> **SSOT Override:** Segala instruksi di file ini (termasuk pembentukan Swarm subagent, Day-0 Quintet, RFC, dan Matriks) **TUNDUK** pada pengecualian di AGENTS.md §2 dan §7. Jika proyek berukuran kecil atau sekadar edit minor, **ABAIKAN** instruksi berat di file ini dan langsung tulis kode. DILARANG spawn subagent untuk tugas yang tidak memenuhi syarat di §7.

> Dipicu dari `SKILL.md` saat proyek baru dari nol (`composer create-project`). **Gerbang Klarifikasi (§2 `AGENTS.md`) WAJIB tuntas lebih dulu.**

## 1. Riset — sebar subagent tier `pro`

| Subagent (1 per domain - sesuai `AGENTS.md` §7) | WAJIB baca SELURUH berkas di |
| :--- | :--- |
| Subagents Core | Domain dari tabel **Core References** di `SKILL.md` |
| Subagents Niche | Domain dari tabel **Auto-Detect** di `SKILL.md` |


## 2. Day-0 Quintet (HANYA jika proyek besar/menengah - lihat AGENTS.md §2)

| Pilar | Isi wajib |
| :--- | :--- |
| Container 3-tier | `docker-compose.yml` FrankenPHP/Octane + Postgres/Valkey · profile `telemetry` OTel+Prometheus RED+Grafana+Loki · profile `stress` k6. **DILARANG auto-run `docker build`/`up`.** |
| Config fail-fast | `.env.example` bersih + validasi ketat lewat `config()`. WAJIB throw exception saat boot bila env wajib hilang, sebelum melayani request. |
| Lifecycle & isolasi Octane | Bersihkan state leak (`flush` services di `config/octane.php`) · graceful shutdown worker queue & container Octane · flush buffer log ke Loki |
| Migrasi & seeder | `database/migrations/` lengkap + `database/seeders/DatabaseSeeder.php` idempotent untuk akun admin awal |
| Task runner | `Makefile`/`composer scripts`: `dev` (Octane/FrankenPHP) · `infra-up`/`down` · `telemetry-up` · `migrate` · `seed` · `test` (Pest) · `stress` (k6) |

## 3. Fase implementasi

Patuhi standar yang sudah diekstrak subagent. `view_file` ke referensi spesifik HANYA bila butuh contoh kode konkret.
