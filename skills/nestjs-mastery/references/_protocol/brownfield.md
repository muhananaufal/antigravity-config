# Brownfield NestJS — Protokol Repo Eksisting

> Dipicu dari `SKILL.md` saat tambah fitur / refactor / optimasi / audit pada repo ber-`package.json`. **Baseline regresi (§3.4 `AGENTS.md`) WAJIB tuntas lebih dulu.**

**DILARANG:** Big Bang Rewrite · "Frankenstein Codebase" · daftar subagent statis yang tidak relevan dengan repo.

## 1. Rekonesans — bentuk tim sesuai kenyataan repo

Lirik struktur direktori + `package.json` + `nest-cli.json` **dulu**, baru sebar subagent tier `pro` (3–10, elastis):

| Kondisi repo | Bentuk subagent |
| :--- | :--- |
| Monorepo Nx / `apps/` + `libs/`, atau modul per Bounded Context | 1 auditor per app/lib/modul |
| `@nestjs/platform-express` masih dipakai | **Fastify Migration Auditor** — petakan middleware & tipe `Request`/`Reply` yang mengunci ke Express, hitung ongkos pindah |
| `@prisma/client` / `typeorm` / `drizzle-orm` terdeteksi | **N+1 & Query Hunter** — relasi tanpa `include`/`relations`, query di dalam loop, pagination hilang, koneksi tanpa pool |
| `@nestjs/bullmq` / `bull` terdeteksi | **Queue Reliability Auditor** — job tanpa idempotensi, retry tanpa backoff, DLQ tidak ada, job di-enqueue sebelum transaksi commit |
| `@nestjs/microservices` / Kafka / NATS terdeteksi | **Transport Auditor** — deadline & timeout hilang, ack manual bocor, outbox pattern absen |
| `@nestjs/graphql` terdeteksi | **Resolver N+1 Auditor** — DataLoader absen, field resolver memanggil DB per item |
| Provider ber-`Scope.REQUEST` banyak | **DI Scope Auditor** — request-scoped menular ke seluruh rantai dependensi dan membunuh performa |
| Endpoint API/Web terdeteksi | **Security & OWASP Auditor** — `ValidationPipe` tanpa `whitelist: true`, IDOR, mass assignment lewat DTO longgar, throttling absen |
| Satu folder >30 berkas (`src/modules`, `src/controllers`) | Pecah ke 2–3 subagent per grup modul |
| **Selalu, tepat 1** | **Mastery Standard Matcher** — konsolidasi seluruh temuan auditor, lalu baca HANYA referensi yang jadi obatnya. WAJIB membedah `db_persistence_orm/zero_downtime_schema_migrations.md` bila skema DB lawas ikut berubah. |

DILARANG memanggil spesialis fintech/AI bila repo tidak punya fitur pembayaran atau AI.

## 2. Bahaya khas NestJS yang WAJIB diperiksa

| Bahaya | Gejalanya |
| :--- | :--- |
| **Event loop terblokir** | Hashing, kriptografi, parsing Excel/CSV besar dijalankan di main thread tanpa Piscina atau `napi-rs` |
| **`any` bypass** | DTO tanpa validasi runtime; `ValidationPipe` tanpa `whitelist: true` sehingga payload liar tembus |
| **Kebocoran lifecycle** | `onModuleDestroy` / `enableShutdownHooks()` absen → pool DB & koneksi broker tidak ditutup saat SIGTERM |
| **Circular dependency** | `forwardRef()` bertebaran — gejala Bounded Context yang bocor, bukan solusi |
| **Config tanpa validasi** | `ConfigModule` tanpa `validationSchema` → aplikasi hidup dengan env salah dan gagal di produksi |

## 3. Sajikan ≥3 opsi — Zero-Steering Grilling

| Opsi | Kapan cocok | Konsekuensi |
| :--- | :--- | :--- |
| **Native Consistent Extension** (KISS) | Pola repo masih sehat, tim lama harus tetap paham | Cepat & konsisten. WAJIB tetap suntik DTO ber-Zod/class-validator, `ValidationPipe whitelist`, index DB, dan timeout di panggilan eksternal. |
| **Strangler Fig** | Modul baru bisa berdiri sendiri | Modul baru berpola Hexagonal (Ports & Adapters) di dalam repo yang sama, tersambung ke modul lawas hanya lewat interface/facade. Kode lama utuh. |
| **Surgical Rewrite & Hardening** | Modul lama fatal (race condition pada queue, transaksi uang tanpa idempotensi, event loop terblokir masif) | Bedah modul lama sekalian bangun fitur barunya. Paling mahal, paling bersih. |

DILARANG memberi label "(Recommended)" sepihak — lihat §4 `AGENTS.md`.
