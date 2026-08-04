# Greenfield Protocol & Swarm — NestJS

> Dipicu dari `SKILL.md` saat inisiasi proyek NestJS baru, atau saat operasi besar yang melibatkan >3 berkas / >3 domain.

## HUKUM MUTLAK DAY-0 GREENFIELD BOOTSTRAP (5 PILAR PRODUCTION-READY)

Setiap inisiasi proyek baru (Greenfield) di NestJS WAJIB secara default meracik 5 pilar fondasi Day-0 berikut di root proyek:

- **Pilar 1: Modular 3-Tier Container Topology:** Tier 1 Core (`docker-compose.yml` Postgres & Redis Valkey), Tier 2 Telemetry (`profiles: [telemetry]` OTel Collector, Prometheus RED, Grafana, Loki), Tier 3 Stress Harness (`profiles: [stress]` `grafana/k6`). *(DILARANG auto-run `docker build`/`up` tanpa izin user).*
- **Pilar 2: Fail-Fast Type-Safe Configuration:** `.env.example` bersih + `ConfigModule` berpagar `validationSchema` (Zod/Joi/class-validator) saat bootstrap (WAJIB *crash on boot* jika env hilang sebelum listen port HTTP).
- **Pilar 3: Graceful Shutdown & Lifecycle Hooks:** WAJIB mengaktifkan `app.enableShutdownHooks()` untuk menangkap `SIGINT`/`SIGTERM`, mendrain koneksi Fastify, menutup Prisma/Drizzle pool, dan mem-flush OTel Tracing SDK.
- **Pilar 4: Database Migration & Idempotent Seeder Baseline:** Direktori `prisma/migrations` / `drizzle` + skrip `prisma/seed.ts` atau database seeder untuk inisiasi akun admin awal.
- **Pilar 5: Unified Task Runner (`Makefile` / `package.json` scripts):** Perintah baku `make dev` (Nest Fastify hot-reload), `make infra-up`/`down`, `make telemetry-up`, `make migrate`, `make seed`, `make test` (Jest), `make stress` (k6).

## Protokol Swarm Paralel & Cara Pengambilan Ilmu

Sebagai AI dengan keunggulan penalaran kelas Principal, **DILARANG KERAS MENGAWANG ATAU MENGARANG DARI HAFALAN LLM MENTAH** saat menghadapi kasus kompleks. Pastikan Anda mengaktifkan **Swarm Research Protocol**:

1. **Pemeta Rujukan lokal Pertama (Local-First):** Jika Anda berhadapan dengan masalah optimasi GraphQL, panggil tool `list_dir` untuk mengecek direktori `references/api_graphql_federation/`, lalu gunakan `view_file` atau `grep_search` untuk menanamkan isi rujukan ke dalam penalaran Anda.
2. **Spawne Armada Subagent Secara Paralel:** Untuk operasi besar yang melibatkan >3 file atau >3 domain sekaligus, jangan ragu untuk memantulkan spesifikasi JSON deklaratif tool `invoke_subagent` dengan array armada spesialis (menggunakan Workspace Mode `share` dan Model Tier `pro`).
3. **Ketaatan Tanpa Sisa:** Kode yang Anda atau Subagent ciptakan berdasarkan ilmu dari rujukan ekosistem ini WAJIB mencerminkan standar yang sama: 100% type-safe, kompilabel, lulus uji unit tes (Jest/SWC/Fastify Inject), dan menakdirkan keandalan militer!
