# Greenfield Rust — Protokol Init

> [!WARNING]
> **SSOT Override:** Segala instruksi di file ini (termasuk pembentukan Swarm subagent, Day-0 Quintet, RFC, dan Matriks) **TUNDUK** pada pengecualian di AGENTS.md §2 dan §7. Jika proyek berukuran kecil atau sekadar edit minor, **ABAIKAN** instruksi berat di file ini dan langsung tulis kode. DILARANG spawn subagent untuk tugas yang tidak memenuhi syarat di §7.

> Dipicu dari `SKILL.md` saat proyek baru dari nol (`cargo new`). **Gerbang Klarifikasi (§2 `AGENTS.md`) WAJIB tuntas lebih dulu.**

## 1. Riset — sebar subagent tier `pro`

| Subagent (1 per domain - sesuai `AGENTS.md` §7) | WAJIB baca SELURUH berkas di |
| :--- | :--- |
| Subagents Core | Domain dari tabel **Core References** di `SKILL.md` |
| Subagents Niche | Domain dari tabel **Auto-Detect** di `SKILL.md` |


## 2. Day-0 Quintet (HANYA jika proyek besar/menengah - lihat AGENTS.md §2)

| Pilar | Isi wajib |
| :--- | :--- |
| Container 3-tier | `docker-compose.yml` Postgres/Valkey · profile `telemetry` OTel+Prometheus+Grafana+Loki · profile `stress` k6. **DILARANG auto-run build/up.** |
| Config fail-fast | `.env.example` + deserialisasi strongly-typed `envy`/`config-rs`. WAJIB panic / error deskriptif sebelum binding listener Axum atau koneksi pool DB. |
| Graceful shutdown | `tokio::signal::ctrl_c()` + handler sinyal Unix · Axum `with_graceful_shutdown()` · tutup pool `sqlx` · flush tracing subscriber OTLP |
| Migrasi & seeder | `migrations/` (`sqlx-cli`/`diesel`) + `seed.sql` idempotent |
| Task runner | `Makefile`/`cargo-make`: `dev` (`cargo watch -x run`) · `infra-up`/`down` · `telemetry-up` · `migrate` · `test` · `stress` |

## 3. Fase implementasi

Patuhi standar yang sudah diekstrak subagent. `view_file` ke referensi spesifik HANYA bila butuh contoh kode konkret.
