# Greenfield — Protokol Init Proyek dari Nol

> Dipicu dari `SKILL.md` saat membuat proyek baru dari nol. **Gerbang Klarifikasi (§2 `AGENTS.md`) WAJIB tuntas lebih dulu.**

## 1. Riset — sebar subagent tier `pro`

| Subagent | Cakupan bacaan |
| :--- | :--- |
| 3 core tetap | Arsitektur · Database/Storage · Keamanan OWASP · Konkurensi · DevOps/Container |
| +1 per domain niche | sesuai tabel Auto-Detect pada skill stack terkait (K8s Operator, HFT zero-alloc, Fintech ledger, AI Scout, dll) |

DILARANG menulis kode atau menerbitkan dokumen RFC (`docs/rfc/`) sebelum seluruh subagent melapor.

## 2. Day-0 Quintet — WAJIB ada di root

| Pilar | Isi wajib |
| :--- | :--- |
| Container 3-tier | `docker-compose.yml` DB & cache · profile `telemetry` OTel+Prometheus RED+Grafana+Loki · profile `stress` k6. **DILARANG auto-run `docker build`/`up`** demi menjaga RAM/CPU. |
| Config fail-fast | `.env.example` bersih tanpa secret asli + validasi skema env ketat. WAJIB *crash on boot* bila env hilang/invalid, sebelum membuka port HTTP atau pool DB. |
| Graceful shutdown | Handler SIGINT & SIGTERM terpusat: tolak koneksi baru · grace period 5–15 detik untuk in-flight request · tutup pool DB/Redis · flush log & OTel trace · exit code 0 |
| Migrasi & seeder | `migrations/` up/down perdana + seeder idempotent (`seed.sql` atau seeder framework) untuk data master tanpa error duplikasi |
| Task runner | `Makefile`/`Taskfile.yml`: `dev` · `infra-up`/`down` · `telemetry-up` · `migrate` · `seed` · `test` · `stress` |

## 3. Fase implementasi

Eksekusi dengan kepatuhan penuh pada standar yang telah diekstrak subagent.
