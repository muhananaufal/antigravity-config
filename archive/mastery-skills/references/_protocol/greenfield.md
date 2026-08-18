# Greenfield — Protokol Init Proyek dari Nol

> [!WARNING]
> **SSOT Override:** Segala instruksi di file ini (termasuk pembentukan Swarm subagent, Day-0 Quintet, RFC, dan Matriks) **TUNDUK** pada pengecualian di AGENTS.md §2 dan §7. Jika proyek berukuran kecil atau sekadar edit minor, **ABAIKAN** instruksi berat di file ini dan langsung tulis kode. DILARANG spawn subagent untuk tugas yang tidak memenuhi syarat di §7.

> Dipicu dari `SKILL.md` saat membuat proyek baru dari nol. **Gerbang Klarifikasi (§2 `AGENTS.md`) WAJIB tuntas lebih dulu.**

## 1. Riset — sebar subagent tier `pro`

| Subagent (1 per domain - sesuai `AGENTS.md` §7) | Cakupan bacaan |
| :--- | :--- |
| Subagents Core | Domain dari tabel **Core References** di `SKILL.md` stack terkait |
| Subagents Niche | Domain dari tabel **Auto-Detect** di `SKILL.md` stack terkait |

DILARANG menulis kode atau menerbitkan dokumen RFC (`docs/rfc/`) sebelum seluruh subagent melapor.

## 2. Day-0 Quintet (HANYA jika proyek besar/menengah - lihat AGENTS.md §2)

| Pilar | Isi wajib |
| :--- | :--- |
| Container 3-tier | `docker-compose.yml` DB & cache · profile `telemetry` OTel+Prometheus RED+Grafana+Loki · profile `stress` k6. **DILARANG auto-run `docker build`/`up`** demi menjaga RAM/CPU. |
| Config fail-fast | `.env.example` bersih tanpa secret asli + validasi skema env ketat. WAJIB *crash on boot* bila env hilang/invalid, sebelum membuka port HTTP atau pool DB. |
| Graceful shutdown | Handler SIGINT & SIGTERM terpusat: tolak koneksi baru · grace period 5–15 detik untuk in-flight request · tutup pool DB/Redis · flush log & OTel trace · exit code 0 |
| Migrasi & seeder | `migrations/` up/down perdana + seeder idempotent (`seed.sql` atau seeder framework) untuk data master tanpa error duplikasi |
| Task runner | `Makefile`/`Taskfile.yml`: `dev` · `infra-up`/`down` · `telemetry-up` · `migrate` · `seed` · `test` · `stress` |

## 3. Fase implementasi

Eksekusi dengan kepatuhan penuh pada standar yang telah diekstrak subagent.
