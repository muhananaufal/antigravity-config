# mastery-nestjs -- ARSIP (dinonaktifkan sebagai skill)

> **Status:** korpus ini DIPENSIUNKAN dari jalur aktif pada 2026-08-18 (Lean Constitution v2).
> Frontmatter skill-nya sengaja dicabut supaya bundle ini TIDAK lagi ditawarkan sebagai skill
> oleh mesin discovery mana pun. Isinya tetap utuh dan boleh dikutip sebagai [fakta:path],
> tetapi TIDAK wajib dibaca sebelum menulis kode -- kewajiban verifikasi kini menunjuk sumber
> nyata (source library terpasang, dokumentasi resmi, kode proyek), lihat `AGENTS.md` section 0.1.
>
> **Cakupan asli:** Gunakan skill ini ketika merancang arsitektur Enterprise TypeScript, Dependency Injection IoC internals, Hexagonal Ports & Adapters, Fastify Engine tuning, Prisma/Drizzle ORM performance, Microservices gRPC/Kafka/NATS, Apollo GraphQL Federation v2, Multi-Tenancy RLS, AI Scout/pgvector/LangChain, Fintech ACID 2PC, atau Zero-Trust security di NestJS.

# NestJS Enterprise Mastery (L8 Neutral Encyclopedia)

SSOT arsitektur backend TypeScript enterprise (36 Domain, 139 Berkas). Dokumen ini BUKAN sekadar tutorial SWE; ini adalah **Fakta Objektif Netral** yang memfasilitasi 5 POV Principal Roles (Architect, SWE, QA, DevOps, DBA). Zero-Tolerance: DILARANG `// TODO`, secret statis di kode, dan `any` bypass.

## 👓 Matriks Lensa Principal (Multi-POV)

Gunakan *lensa* spesifik saat membaca file referensi di direktori ini, sesuai dengan peran Anda saat ini:

| Role Aktif | Lensa Fokus Utama di Ekosistem NestJS |
| :--- | :--- |
| **Architect** | Arsitektur *Hexagonal Ports & Adapters*, *CQRS/Event Sourcing*, Topologi *GraphQL Apollo Federation v2*, dan *gRPC Microservices*. |
| **SWE** | Injeksi Dependensi (IoC), siklus hidup *Event Loop Node.js*, pemindahan beban CPU ke *Piscina Worker Threads*, dan *Decorator* abstraksi. |
| **DevOps** | Orkestrasi K8s untuk *Fastify*, metrik *Prometheus RED*, *Multi-stage distroless* image, pencegahan OOM via *Terminus Health Checks*, dan *Graceful Shutdown*. |
| **DBA** | Optimasi *Prisma Connection Pooling* via *PgBouncer*, *Drizzle zero-overhead*, strategi *Multi-Tenancy RLS*, dan *Zero-Downtime Migrations*. |
| **QA (Red Team)** | Eksploitasi *Prototype Pollution*, serangan *ReDoS* (Regular Expression Denial of Service), mutasi API via *Jest/SWC*, dan *Chaos Testing* pada antrean *BullMQ*. |

## 🏛️ Pilar Arsitektur Mutlak

| Pilar | Hukumnya |
| :--- | :--- |
| **Fastify First** | `@nestjs/platform-fastify` adalah adapter HTTP utama. Express DILARANG jadi default — lamban dan boros I/O. |
| **Hexagonal & DDD** | Direktori WAJIB dipisah per *Bounded Context* + *Ports & Adapters*. Business logic di core, buta terhadap DB eksternal maupun protokol HTTP/gRPC. |
| **Validasi Runtime Ingress** | DTO wajib bervalidasi runtime (`class-validator` `whitelist: true`, Zod, Ajv, atau TypeBox) di setiap pintu masuk. Pelanggaran untyped bypass tunduk pada `AGENTS.md` §0.4. |
| **Non-Blocking Event Loop** | Komputasi CPU-bound masif (hashing, kriptografi, Excel gb-scale) WAJIB keluar dari main event loop → Piscina Worker Threads atau `napi-rs`. |
| **Zero-Trust & OWASP** | JWKS asimetris / OIDC di HTTP-Only Secure Cookie · RBAC/ABAC lewat `Reflector` · throttling Redis Valkey di pintu masuk. |

## 🚦 Protokol Eksekusi

Patuhi mutlak **Tabel Routing Task di `AGENTS.md` §2** untuk menentukan kapan harus membaca `references/_protocol/greenfield.md`, `brownfield.md`, atau `tradeoff.md`.
> **Pengecualian Mutlak:** Jika ini adalah proyek baru atau keputusan arsitektur besar, WAJIB lewati meta-decision (`~/.gemini/config/skills/meta-decision/SKILL.md`) terlebih dahulu sesuai `role-architect/SKILL.md` §1.5.

---

## 📦 Core References (WAJIB Baca Setiap Project NestJS)

Fondasi Fardu Ain — relevan di 100% produksi NestJS enterprise, apa pun bentuk tasknya.

| Domain | Referensi | Cakupan |
| :--- | :--- | :--- |
| **Arsitektur Inti** | `references/core_arch_patterns/` | IoC container internals, Hexagonal Ports/Adapters, DDD bounded context, CQRS, dynamic modules, interceptor RxJS |
| **HTTP Engine Fastify** | `references/http_engine_fastify/` | Migrasi Express→Fastify, JSON Schema Ajv, multipart upload besar, WebSocket adapter |
| **DB & Persistence ORM** | `references/db_persistence_orm/` | Prisma tuning, Drizzle zero-overhead, TypeORM transactional, Mongoose, Redis Valkey, zero-downtime migration |
| **Validasi & Serialisasi** | `references/validation_serialization/` | class-validator, Zod/TypeBox pipes, decorator async, payload stripping |
| **Konfigurasi & Env** | `references/configuration_env_management/` | Validasi skema env saat boot, Vault dynamic secret, namespace config |
| **Security OWASP Zero-Trust** | `references/security_owasp_zerotrust/` | JWKS/OIDC, RBAC/ABAC guard, OWASP Top 10, throttler DDoS, sanitasi injeksi, Argon2id |
| **Identity, SSO & Passkeys** | `references/identity_iam_sso_mfa/` | Passkeys FIDO2, OAuth2/OIDC PKCE, TOTP MFA, revokasi sesi & pelacakan perangkat |
| **Testing & QA** | `references/testing_quality_qa/` | Jest+SWC, E2E Fastify inject, mocking DI, mutation testing, Testcontainers |
| **Observability & APM** | `references/observability_apm_metrics/` | OTel tracing, Prometheus RED, Pino zero-alloc, exception filter, AsyncLocalStorage |
| **Structured Logging** | `references/structured_logging_telemetry/` | Pino async destination, Sentry source map, rotasi & retensi, audit trail imutabel |
| **Caching Strategy & CDN** | `references/caching_strategy_cdn/` | Cache multi-tier Valkey, proteksi stampede, invalidasi per tenant, CDN SWR/ETag |
| **File Storage & Object CDN** | `references/file_storage_object_cdn/` | Presigned upload S3/R2, multipart resumable, pipeline gambar Sharp, ACL kedaluwarsa |
| **Omnichannel Notifications** | `references/omnichannel_notifications_mail/` | Email DKIM, push FCM/APNs, WhatsApp/SMS OTP, notification center |
| **Concurrency & Runtime** | `references/concurrency_runtime_internals/` | Fase event loop V8/libuv, Worker Threads Piscina, runtime Bun, perburuan memory leak |
| **Background Jobs & Queues** | `references/background_jobs_queues/` | BullMQ worker, distributed lock cron, backoff & DLQ, observabilitas antrean |
| **Docker & Container** | `references/docker_container_standards/` | Multi-stage distroless, non-root + SIGTERM, cache pnpm/corepack, probe Terminus, topologi 3-tier |

## 🎯 Context References (Baca Sesuai Kebutuhan)

Dipicu saat sistem tumbuh ke mikroservice, event-driven, atau konkurensi tinggi.

| Konteks / Keyword | Baca Referensi |
| :--- | :--- |
| gRPC, Protobuf, deadline, circuit breaker antar-service | `references/microservices_grpc/` |
| Kafka, RabbitMQ, NATS, Redis Streams, DLQ, consumer group | `references/message_brokers_event_streaming/` |
| GraphQL, Apollo Federation, subgraph, DataLoader, N+1 resolver | `references/api_graphql_federation/` |
| WebSocket, SSE, real-time, chat, streaming, heartbeat | `references/realtime_websocket_sse/` |
| CQRS, command/query bus, event store, read model projection | `references/cqrs_event_sourcing/` |
| Search, katalog, faceted filter, Meilisearch, Elasticsearch, CDC | `references/search_engine_catalog_indexing/` |
| API versioning, gateway, reverse proxy, kuota tenant, metered billing | `references/api_versioning_gateway_routing/` |
| Saga panjang, Temporal, state machine order, kompensasi | `references/workflow_orchestration_temporal/` |
| Multi-tenant, RLS, isolasi skema per tenant, subdomain routing | `references/multi_tenancy_architecture/` |
| AWS Lambda, serverless, SQS/SNS, cold start | `references/serverless_aws_lambda_cloud/` |
| Monorepo, Nx, shared library, affected build, boundary enforcement | `references/monorepo_nx_workspaces/` |
| K8s, Helm, GitOps, ConfigMap reload, HPA autoscaling | `references/devops_k8s_gitops/` |

## 🔍 Auto-Detect Niche Domain (Scan dari Task)

Agent WAJIB mencocokkan nature of task ke domain berikut **secara proaktif**.

| Jika task melibatkan... | Otomatis baca |
| :--- | :--- |
| AI/LLM, RAG, embedding, pgvector, Pinecone, streaming jawaban | `references/ai_vector_rag_integration/` |
| Payment, webhook, ledger, saldo, 2PC, idempotency finansial | `references/fintech_payment_gateways/` |
| OpenAPI, Swagger, dokumentasi API, generate SDK client | `references/openapi_documentation/` |
| i18n, multi-bahasa, ICU, format mata uang & zona waktu | `references/i18n_localization/` |
| CLI, subcommand, seeder interaktif, daemon latar | `references/cli_scripting_commander/` |
| Native addon, napi-rs, jembatan Rust, buffer sharing, kripto cepat | `references/low_level_addons_napi/` |
| Chaos test, fault injection, bulkhead, degradasi terkendali | `references/chaos_engineering_resilience/` |
| Decorator kustom, Reflector, metadata, abstraksi boilerplate | `references/meta_programming_decorators/` |

---

## ✅ Terdesentralisasi Quality Gate (Per-Role)

**Gerbang Global (WAJIB bagi semua role yang mengubah kode/infrastruktur):**
```
powershell -NoProfile -ExecutionPolicy Bypass -File ~/.gemini/config/scripts/quality_gate.ps1 -Full
```

Sebagai agen otonom, WAJIB periksa bagian di bawah ini sesuai dengan peran aktif Anda. DILARANG mencentang tugas `[x]` bila gerbang *role* Anda belum terpenuhi secara spesifik.

### 🏛️ `[ ]` Gerbang Architect (PM)
- **Modularity:** Tidak ada `forwardRef()`. Logika bisnis (Hexagonal) murni buta terhadap HTTP (Fastify) dan DB (Prisma).
- **Topology:** Operasi berat asinkron masuk ke antrean eksternal (BullMQ/RabbitMQ).
- **Security Blueprint:** Validasi rahasia (*secret*) tersentralisasi via `ConfigModule` (`validationSchema`), sistem gagal *boot* jika invalid.

### ⚙️ `[ ]` Gerbang SWE
- **Type-Safety:** Nol `any`/`unknown` tanpa validasi. *Tipe TypeScript musnah saat compile*, DTO wajib bervalidasi *runtime* (Zod/class-validator `whitelist: true`).
- **Event Loop:** Komputasi CPU-bound (*hashing*, Excel) DILARANG berada di *main thread*. Pindahkan ke *Piscina Worker Threads* atau *napi-rs*.
- **Lint & Test:** `tsc --noEmit` & `eslint .` (Nol Error). Lulus `jest` dengan SWC.

### 🛡️ `[ ]` Gerbang QA (Red Team)
- **CVE Free:** Hasil `npm audit` / `osv-scanner` bebas dari kerentanan *Critical* atau *High*.
- **ReDoS Protected:** *Endpoint* yang menerima Regex (atau memproses string panjang) lolos dari jebakan *Event Loop Blocking*.
- **Authorization:** IDOR / BAC diuji. RBAC/ABAC terpasang via NestJS `Guard` dan *Reflector*.

### 🌩️ `[ ]` Gerbang DevOps
- **Distroless & Container:** *Multi-stage build* menggunakan pnpm caching layer, berjalan di atas *alpine* / *distroless* secara **non-root**.
- **Graceful Shutdown:** `app.enableShutdownHooks()` terpasang agar pool DB terputus bersih saat menerima `SIGTERM`.
- **Health Checks:** Terminus Terintegrasi di `/health` + `/ready`.

### 🗄️ `[ ]` Gerbang DBA
- **Pool Tuning:** *Connection Pool* Prisma / TypeORM tidak dibiarkan tak terbatas. Gunakan *PgBouncer* jika *deployment* serverless/lambda.
- **N+1 Eradication:** Kueri ORM memanfaatkan `include`/`relations` secara eksplisit, terbebas dari siklus *N+1 Query*.
- **Zero-Downtime:** Migrasi skema berjalan inkremental tanpa memicu *table lock* absolut di DB produksi.

> Audit mutu **berkas referensi mastery** dijalankan terpusat lewat `scripts/audit_references.ps1 -Skill mastery-nestjs`.

---
*Manifes `mastery-nestjs` ini adalah Single Source of Truth (SSOT). Jadikan hukum kepatuhannya sebagai jembatan melompati kemegahan arsitektur dunia nyata!*
