# Greenfield Rust — Protokol Init

> Dipicu dari `SKILL.md` saat proyek baru dari nol (`cargo new`). **Gerbang Klarifikasi (§2 `AGENTS.md`) WAJIB tuntas lebih dulu.**

## 1. Riset — sebar subagent tier `pro`

| Subagent | WAJIB baca SELURUH berkas di |
| :--- | :--- |
| Memory, Traits & Unsafe | `core_memory_ownership/` `type_system_traits/` `unsafe_ffi_internals/` `docker_container_standards/` |
| Async, Web & Reliability | `async_tokio_concurrency/` `web_microservices/` `error_handling_resilience/` `testing_fuzzing_benchmarking/` |
| Performance, Security & Storage | `high_performance_hft/` `distributed_consensus_storage/` `networking_protocols_grpc/` `cybersecurity_cryptography/` |
| +1 per domain niche | sesuai tabel Auto-Detect di `SKILL.md` |

3 core WAJIB, niche elastis — 3 niche terdeteksi berarti 6 subagent paralel. DILARANG menulis kode atau dokumen RFC (`docs/rfc/`) sebelum semua subagent melapor.

## 2. Day-0 Quintet — WAJIB ada di root

| Pilar | Isi wajib |
| :--- | :--- |
| Container 3-tier | `docker-compose.yml` Postgres/Valkey · profile `telemetry` OTel+Prometheus+Grafana+Loki · profile `stress` k6. **DILARANG auto-run build/up.** |
| Config fail-fast | `.env.example` + deserialisasi strongly-typed `envy`/`config-rs`. WAJIB panic / error deskriptif sebelum binding listener Axum atau koneksi pool DB. |
| Graceful shutdown | `tokio::signal::ctrl_c()` + handler sinyal Unix · Axum `with_graceful_shutdown()` · tutup pool `sqlx` · flush tracing subscriber OTLP |
| Migrasi & seeder | `migrations/` (`sqlx-cli`/`diesel`) + `seed.sql` idempotent |
| Task runner | `Makefile`/`cargo-make`: `dev` (`cargo watch -x run`) · `infra-up`/`down` · `telemetry-up` · `migrate` · `test` · `stress` |

## 3. Fase implementasi

Patuhi standar yang sudah diekstrak subagent. `view_file` ke referensi spesifik HANYA bila butuh contoh kode konkret.
