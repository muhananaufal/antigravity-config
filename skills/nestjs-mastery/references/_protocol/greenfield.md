# Greenfield & Swarm NestJS — Protokol

> Dipicu dari `SKILL.md` saat inisiasi proyek baru, ATAU saat operasi menyentuh >3 berkas / >3 domain. **Gerbang Klarifikasi (§2 `AGENTS.md`) WAJIB tuntas lebih dulu.**

## 1. Swarm Research Protocol

**DILARANG mengarang dari hafalan LLM mentah.** Urutannya:

| Langkah | Aksi |
| :--- | :--- |
| Local-first | `list_dir` ke `references/<domain>/` yang relevan, lalu `view_file` / `grep_search` untuk menanamkan isinya ke penalaran |
| Operasi >3 berkas atau >3 domain | WAJIB `invoke_subagent` dengan array armada spesialis — Workspace Mode `share`, Model Tier `pro` |
| Hasil kerja agen maupun subagen | WAJIB 100% type-safe, kompilabel, lulus Jest/SWC/Fastify Inject |

## 2. Day-0 Quintet — WAJIB ada di root

| Pilar | Isi wajib |
| :--- | :--- |
| Container 3-tier | `docker-compose.yml` Postgres & Redis Valkey · profile `telemetry` OTel+Prometheus RED+Grafana+Loki · profile `stress` k6. **DILARANG auto-run `docker build`/`up`.** |
| Config fail-fast | `.env.example` + `ConfigModule` berpagar `validationSchema` (Zod/Joi/class-validator). WAJIB *crash on boot* bila env hilang, sebelum listen port HTTP. |
| Graceful shutdown | `app.enableShutdownHooks()` tangkap SIGINT/SIGTERM · drain koneksi Fastify · tutup pool Prisma/Drizzle · flush OTel Tracing SDK |
| Migrasi & seeder | `prisma/migrations` / `drizzle` + `prisma/seed.ts` idempotent untuk akun admin awal |
| Task runner | `Makefile`/`package.json` scripts: `dev` (Nest Fastify hot-reload) · `infra-up`/`down` · `telemetry-up` · `migrate` · `seed` · `test` (Jest) · `stress` (k6) |
