# Brownfield NestJS — Protokol Forensik & Blast Radius Repo Eksisting

> Dipicu dari `SKILL.md` saat tambah fitur / refactor / optimasi / audit pada repo ber-`package.json`. **Baseline regresi (§3.4 `AGENTS.md`) WAJIB tuntas lebih dulu.**

**DILARANG:** Big Bang Rewrite · "Frankenstein Codebase" · Mengubah kode tanpa memetakan Blast Radius.

---

## 1. Rekonesans Forensik — Bentuk Tim Sesuai Kenyataan Repo

Pindai struktur direktori + `package.json` + `nest-cli.json` **dulu**, baru sebar subagent tier `pro` (3–10, elastis):

| Kondisi Repo | Fokus Audit Subagent | Target Berkas & Concern |
| :--- | :--- | :--- |
| Monorepo Nx / Bounded Contexts | **Module Isolation Auditor** | Cross-module tight coupling, cyclic module dependencies, `forwardRef()` abuse |
| Express vs Fastify | **Fastify Migration Auditor** | Middleware Express liar, direct `req.raw` manipulation, serialization overhead |
| Prisma / TypeORM / Drizzle | **ORM & N+1 Hunter** | Missing `include`/`relations`, unbounded query loops, connection pool limits |
| BullMQ / Kafka / Microservices | **Queue & Event Auditor** | Missing job idempotency, unhandled DLQ, outbox pattern absence |
| Provider `Scope.REQUEST` banyak | **DI Performance Auditor** | Memory leak per-request, performance bottleneck cascading across DI graph |
| **Selalu, tepat 1** | **Mastery Standard Matcher** | Konsolidasi seluruh temuan auditor, baca `references/` yang relevan, lalu susun Matriks Blast Radius |

---

## 2. Matriks Blast Radius & Forensic Audit (Wajib Sebelum RFC)

Subagent auditor wajib menyusun tabel forensik ini sebelum opsi arsitektur diajukan:

```markdown
### 🔍 Forensic Blast Radius Matrix
| Komponen yang Disentuh | Modul / Service Downstream Terdampak | Potensi Risiko / Failure Mode | Mitigasi Defensif (Guardrail) |
| :--- | :--- | :--- | :--- |
| Injectable Service Singleton | Seluruh Controller pengkonsumsi | Request state leak jika service menyimpan variable lokal | Stateless service design + Pure functions |
| Global ValidationPipe / DTO | Ingress API Endpoints | Incompatible payload structure memicu 400 Bad Request masif | Class-validator with whitelist & transform |
```

---

## 3. Bahaya Khas NestJS yang WAJIB Diperiksa
1. **Event loop terblokir:** Hashing, kriptografi, parsing CSV besar di main thread tanpa Worker Thread (`piscina`).
2. **Untyped `any` bypass:** DTO tanpa validasi runtime (`class-validator` / `zod`).
3. **Kebocoran lifecycle:** `enableShutdownHooks()` absen $\rightarrow$ pool DB & broker tidak tertutup saat SIGTERM.
4. **Circular dependency:** `forwardRef()` bertebaran $\rightarrow$ gejala domain boundary bocor.

---

## 4. Sajikan ≥3 Opsi Arsitektur — Zero-Steering Grilling

| Opsi | Kapan Cocok | Konsekuensi & Guardrail |
| :--- | :--- | :--- |
| **Native Consistent Extension** (KISS) | Pola repo masih sehat, tim lama harus tetap paham | Cepat & konsisten. WAJIB tetap suntik DTO Zod/class-validator, `ValidationPipe whitelist`, index DB, dan timeout di panggilan eksternal. |
| **Strangler Fig** | Modul baru bisa berdiri sendiri | Modul baru berpola Hexagonal (Ports & Adapters) di dalam repo yang sama, tersambung ke modul lawas hanya lewat interface/facade. Kode lama utuh. |
| **Surgical Rewrite & Hardening** | Modul lama fatal (race condition pada queue, transaksi uang tanpa idempotensi, event loop terblokir masif) | Bedah modul lama sekalian bangun fitur barunya. Paling mahal, paling bersih. |

DILARANG memberi label "(Recommended)" sepihak — lihat §4 `AGENTS.md`. Tuangkan opsi terpilih ke dalam `docs/rfc/YYYYMMDD-<fitur>.md` dan update `docs/rfc/README.md`.
