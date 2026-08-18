# Brownfield NestJS — Protokol Forensik & Blast Radius Repo Eksisting

> [!WARNING]
> **SSOT Override:** Segala instruksi di file ini (termasuk pembentukan Swarm subagent, Day-0 Quintet, RFC, dan Matriks) **TUNDUK** pada pengecualian di AGENTS.md §2 dan §7. Jika proyek berukuran kecil atau sekadar edit minor, **ABAIKAN** instruksi berat di file ini dan langsung tulis kode. DILARANG spawn subagent untuk tugas yang tidak memenuhi syarat di §7.

> Dipicu dari `SKILL.md` saat tambah fitur / refactor / optimasi / audit pada repo ber-`package.json`. **Baseline regresi (§3.4 `AGENTS.md`) WAJIB tuntas lebih dulu.**

**DILARANG:** Big Bang Rewrite · "Frankenstein Codebase" · Mengubah kode tanpa memetakan Blast Radius.

---

## 1. Rekonesans Forensik — Bentuk Tim Sesuai Kenyataan Repo

Pindai struktur direktori + `package.json` + `nest-cli.json` **dulu**, baru sebar subagent paralel (1 per domain, sesuai `AGENTS.md` §7):

| Kondisi Repo | Fokus Audit Subagent | Target Berkas & Concern |
| :--- | :--- | :--- |
| Monorepo Nx / Bounded Contexts | **Module Isolation Auditor** | Cross-module tight coupling, cyclic module dependencies, `forwardRef()` abuse |
| Express vs Fastify | **Fastify Migration Auditor** | Middleware Express liar, direct `req.raw` manipulation, serialization overhead |
| Prisma / TypeORM / Drizzle | **ORM & N+1 Hunter** | Missing `include`/`relations`, unbounded query loops, connection pool limits |
| BullMQ / Kafka / Microservices | **Queue & Event Auditor** | Missing job idempotency, unhandled DLQ, outbox pattern absence |
| Provider `Scope.REQUEST` banyak | **DI Performance Auditor** | Memory leak per-request, performance bottleneck cascading across DI graph |

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
2. **Untyped `any` bypass:** Pelanggaran fatal terhadap Gerbang Mutlak `AGENTS.md` §0.4 (termasuk DTO tanpa validasi runtime `class-validator`/`zod`).
3. **Kebocoran lifecycle:** `enableShutdownHooks()` absen $\rightarrow$ pool DB & broker tidak tertutup saat SIGTERM.
4. **Circular dependency:** `forwardRef()` bertebaran $\rightarrow$ gejala domain boundary bocor.
5. **`Scope.REQUEST` menular:** satu provider request-scoped memaksa SELURUH rantai injeksi di atasnya ikut dibuat ulang per request. Biaya instansiasi meledak diam-diam, dan bocornya baru terlihat sebagai memori naik di bawah beban.

---

