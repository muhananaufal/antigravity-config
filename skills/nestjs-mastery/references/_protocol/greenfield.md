# Greenfield & Swarm NestJS — Protokol

> Dipicu dari `SKILL.md` saat inisiasi proyek baru, ATAU saat operasi menyentuh >3 berkas / >3 domain. **Gerbang Klarifikasi (§2 `AGENTS.md`) WAJIB tuntas lebih dulu.**

## 1. Riset — sebar subagent tier `pro`

| Subagent | WAJIB baca SELURUH berkas di |
| :--- | :--- |
| Arsitektur, Data & Container | `core_arch_patterns/` `db_persistence_orm/` `configuration_env_management/` `docker_container_standards/` |
| HTTP, Validasi, Jobs & Aset | `http_engine_fastify/` `validation_serialization/` `background_jobs_queues/` `caching_strategy_cdn/` `file_storage_object_cdn/` `omnichannel_notifications_mail/` `testing_quality_qa/` |
| Keamanan, Observability & Runtime | `security_owasp_zerotrust/` `identity_iam_sso_mfa/` `observability_apm_metrics/` `structured_logging_telemetry/` `concurrency_runtime_internals/` |
| +1 per domain niche | sesuai Tier II & Tier III pada matriks routing di `SKILL.md` |

Ketiga kelompok di atas mencakup **seluruh 16 domain Tier I** — Fardu Ain, tanpa kecuali.
3 core WAJIB, niche elastis — 3 niche terdeteksi berarti 6 subagent paralel. DILARANG menulis kode atau dokumen RFC (`docs/rfc/`) sebelum semua subagent melapor.

**DILARANG mengarang dari hafalan LLM mentah.** Local-first: `list_dir` ke `references/<domain>/`, lalu baca isinya sampai tuntas sebelum menalar. Hasil kerja agen maupun subagen WAJIB 100% type-safe, kompilabel, dan lulus Jest/SWC/Fastify Inject.

## 2. Day-0 Quintet — WAJIB ada di root

| Pilar | Isi wajib |
| :--- | :--- |
| Container 3-tier | `docker-compose.yml` Postgres & Redis Valkey · profile `telemetry` OTel+Prometheus RED+Grafana+Loki · profile `stress` k6. **DILARANG auto-run `docker build`/`up`.** |
| Config fail-fast | `.env.example` + `ConfigModule` berpagar `validationSchema` (Zod/Joi/class-validator). WAJIB *crash on boot* bila env hilang, sebelum listen port HTTP. |
| Graceful shutdown | `app.enableShutdownHooks()` tangkap SIGINT/SIGTERM · drain koneksi Fastify · tutup pool Prisma/Drizzle · flush OTel Tracing SDK |
| Migrasi & seeder | `prisma/migrations` / `drizzle` + `prisma/seed.ts` idempotent untuk akun admin awal |
| Task runner | `Makefile`/`package.json` scripts: `dev` (Nest Fastify hot-reload) · `infra-up`/`down` · `telemetry-up` · `migrate` · `seed` · `test` (Jest) · `stress` (k6) |

## 3. Fase implementasi

Patuhi standar yang sudah diekstrak subagent. `view_file` ke referensi spesifik HANYA bila butuh contoh kode konkret — Day-0 Quintet sudah mengunci fondasinya.

Urutan aman: `core_arch_patterns/` menetapkan Bounded Context & batas Ports/Adapters → `db_persistence_orm/` mengunci skema Prisma/Drizzle → `validation_serialization/` mengunci DTO di pintu masuk → baru controller. DILARANG menulis controller sebelum DTO bervalidasi runtime terkunci: tipe TypeScript MUSNAH saat compile, jadi controller tanpa Zod/class-validator adalah lubang terbuka, bukan sekadar utang gaya.
