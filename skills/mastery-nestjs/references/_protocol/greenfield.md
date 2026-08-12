# Greenfield & Swarm NestJS — Protokol

> [!WARNING]
> **SSOT Override:** Segala instruksi di file ini (termasuk pembentukan Swarm subagent, Day-0 Quintet, RFC, dan Matriks) **TUNDUK** pada pengecualian di AGENTS.md §2 dan §7. Jika proyek berukuran kecil atau sekadar edit minor, **ABAIKAN** instruksi berat di file ini dan langsung tulis kode. DILARANG spawn subagent untuk tugas yang tidak memenuhi syarat di §7.
> Dipicu dari `SKILL.md` saat inisiasi proyek baru, ATAU saat operasi menyentuh >3 berkas / >3 domain. **Gerbang Klarifikasi (§2 `AGENTS.md`) WAJIB tuntas lebih dulu.**

## 1. Riset — sebar subagent tier `pro`

| Subagent (1 per domain - sesuai `AGENTS.md` §7) | WAJIB baca SELURUH berkas di |
| :--- | :--- |
| Subagents Core | Domain dari tabel **Core References** di `SKILL.md` |
| Subagents Niche | Domain dari tabel **Auto-Detect** di `SKILL.md` |

**DILARANG mengarang dari hafalan LLM mentah.** Local-first: `list_dir` ke `references/<domain>/`, lalu baca isinya sampai tuntas sebelum menalar. Hasil kerja agen maupun subagen WAJIB 100% type-safe, kompilabel, dan lulus Jest/SWC/Fastify Inject.

## 2. Day-0 Quintet (HANYA jika proyek besar/menengah - lihat AGENTS.md §2)

| Pilar | Isi wajib |
| Container 3-tier | `docker-compose.yml` Postgres & Redis Valkey · profile `telemetry` OTel+Prometheus RED+Grafana+Loki · profile `stress` k6. **DILARANG auto-run `docker build`/`up`.** |
| Config fail-fast | `.env.example` + `ConfigModule` berpagar `validationSchema` (Zod/Joi/class-validator). WAJIB *crash on boot* bila env hilang, sebelum listen port HTTP. |
| Graceful shutdown | `app.enableShutdownHooks()` tangkap SIGINT/SIGTERM · drain koneksi Fastify · tutup pool Prisma/Drizzle · flush OTel Tracing SDK |
| Migrasi & seeder | `prisma/migrations` / `drizzle` + `prisma/seed.ts` idempotent untuk akun admin awal |
| Task runner | `Makefile`/`package.json` scripts: `dev` (Nest Fastify hot-reload) · `infra-up`/`down` · `telemetry-up` · `migrate` · `seed` · `test` (Jest) · `stress` (k6) |

## 3. Fase implementasi

Patuhi standar yang sudah diekstrak subagent. `view_file` ke referensi spesifik HANYA bila butuh contoh kode konkret — Day-0 Quintet sudah mengunci fondasinya.

Urutan aman: `core_arch_patterns/` menetapkan Bounded Context & batas Ports/Adapters → `db_persistence_orm/` mengunci skema Prisma/Drizzle → `validation_serialization/` mengunci DTO di pintu masuk → baru controller. DILARANG menulis controller sebelum DTO bervalidasi runtime terkunci: tipe TypeScript MUSNAH saat compile, jadi controller tanpa Zod/class-validator adalah lubang terbuka, bukan sekadar utang gaya.
