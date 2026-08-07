---
name: nestjs-mastery
description: Gunakan skill ini ketika merancang arsitektur Enterprise TypeScript, Dependency Injection IoC internals, Hexagonal Ports & Adapters, Fastify Engine tuning, Prisma/Drizzle ORM performance, Microservices gRPC/Kafka/NATS, Apollo GraphQL Federation v2, Multi-Tenancy RLS, AI Scout/pgvector/LangChain, Fintech ACID 2PC, atau Zero-Trust security di NestJS.
---

# NestJS Enterprise Mastery

SSOT arsitektur backend TypeScript enterprise (36 Domain, 139 Berkas). Zero-Tolerance: DILARANG `// TODO`, secret statis di kode, dan `any` bypass.

## 🏛️ Pilar Arsitektur Mutlak

| Pilar | Hukumnya |
| :--- | :--- |
| **Fastify First** | `@nestjs/platform-fastify` adalah adapter HTTP utama. Express DILARANG jadi default — lamban dan boros I/O. |
| **Hexagonal & DDD** | Direktori WAJIB dipisah per *Bounded Context* + *Ports & Adapters*. Business logic di core, buta terhadap DB eksternal maupun protokol HTTP/gRPC. |
| **Zero `any` Bypass** | `any` / `Object` / `unknown` tanpa validasi runtime ketat (Zod, Ajv, TypeBox, atau class-validator `whitelist: true`) DILARANG. |
| **Non-Blocking Event Loop** | Komputasi CPU-bound masif (hashing, kriptografi, Excel gb-scale) WAJIB keluar dari main event loop → Piscina Worker Threads atau `napi-rs`. |
| **Zero-Trust & OWASP** | JWKS asimetris / OIDC di HTTP-Only Secure Cookie · RBAC/ABAC lewat `Reflector` · throttling Redis Valkey di pintu masuk. |

## 🚦 Protokol Eksekusi (WAJIB dibaca sesuai situasi)

> **SEBELUM membuka tabel di bawah:** Jika ini adalah proyek baru atau keputusan arsitektur besar, WAJIB lewati Master Decision Tree (`~/.gemini/config/skills/master-decision-tree/SKILL.md`) terlebih dahulu. DILARANG langsung memilih NestJS sebagai stack tanpa justifikasi dari Decision Tree.

| Situasi | WAJIB baca dulu sebelum menulis apa pun |
| :--- | :--- |
| Inisiasi project baru dari nol | `references/_protocol/greenfield.md` |
| Tambah fitur / refactor / optimasi / audit di repo eksisting | `references/_protocol/brownfield.md` |
| Keputusan arsitektur / menantang pilihan stack (Challenger Mode §4) | `references/_protocol/tradeoff.md` |
| Proyek berada di dalam repo Git — branching, atomic commit, Conventional Commits | `~/.gemini/config/skills/git-workflow/SKILL.md` (§3.9 `AGENTS.md`) |

DILARANG membuat dokumen RFC (`docs/rfc/`) atau menulis kode sebelum protokol yang relevan dibaca tuntas.

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

## 🛡️ Penegakan Mutu & Quality Gates (Zero-Tolerance)

DILARANG mengubah status task jadi `[x]` sebelum SEMUA gerbang ini lulus.

| Gerbang | Perintah | Kriteria lulus |
| :--- | :--- | :--- |
| **Global Quality Gate** | `powershell -NoProfile -ExecutionPolicy Bypass -File ~/.gemini/config/scripts/quality_gate.ps1 -Full` | nol placeholder, nol credential hardcode, test lulus |
| TypeScript | `tsc --noEmit` | nol error |
| Linter | `eslint .` | nol warning |
| Test | `jest` / SWC | nol kegagalan |

> **PENTING:** Global Quality Gate (`quality_gate.ps1`) adalah gerbang primer yang WAJIB dijalankan. Tabel bahasa di atas adalah pelengkap spesifik NestJS — tidak menggantikan global gate.

Ditolak bila ditemukan: warning kompilasi TypeScript · kegagalan ESLint · unit test Jest/SWC gagal · placeholder malas (`// TODO`, `// FIXME`) · kredensial statis yang tidak diambil dari `.env`.

> Audit mutu **berkas referensi mastery** dijalankan terpusat lewat `scripts/audit_references.ps1 -Skill nestjs-mastery`, bukan dari direktori `scripts/` di dalam bundle ini (tidak ada). Sasarannya berbeda dari `quality_gate.ps1` yang mengadili kode proyek user — DILARANG saling menggantikan.

---
*Manifes `nestjs-mastery` ini adalah Single Source of Truth (SSOT). Jadikan hukum kepatuhannya sebagai jembatan melompati kemegahan arsitektur dunia nyata!*
