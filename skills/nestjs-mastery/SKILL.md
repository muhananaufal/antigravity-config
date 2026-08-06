---
name: nestjs-mastery
description: Gunakan skill ini ketika merancang arsitektur Enterprise TypeScript, Dependency Injection IoC internals, Hexagonal Ports & Adapters, Fastify Engine tuning, Prisma/Drizzle ORM performance, Microservices gRPC/Kafka/NATS, Apollo GraphQL Federation v2, Multi-Tenancy RLS, AI Scout/pgvector/LangChain, Fintech ACID 2PC, atau Zero-Trust security di NestJS.
---

# NestJS Enterprise Mastery

SSOT arsitektur backend TypeScript enterprise (36 Domain, 138 Berkas). Zero-Tolerance: DILARANG `// TODO`, secret statis di kode, dan `any` bypass.

## 🏛️ Pilar Arsitektur Mutlak

| Pilar | Hukumnya |
| :--- | :--- |
| **Fastify First** | `@nestjs/platform-fastify` adalah adapter HTTP utama. Express DILARANG jadi default — lamban dan boros I/O. |
| **Hexagonal & DDD** | Direktori WAJIB dipisah per *Bounded Context* + *Ports & Adapters*. Business logic di core, buta terhadap DB eksternal maupun protokol HTTP/gRPC. |
| **Zero `any` Bypass** | `any` / `Object` / `unknown` tanpa validasi runtime ketat (Zod, Ajv, TypeBox, atau class-validator `whitelist: true`) DILARANG. |
| **Non-Blocking Event Loop** | Komputasi CPU-bound masif (hashing, kriptografi, Excel gb-scale) WAJIB keluar dari main event loop → Piscina Worker Threads atau `napi-rs`. |
| **Zero-Trust & OWASP** | JWKS asimetris / OIDC di HTTP-Only Secure Cookie · RBAC/ABAC lewat `Reflector` · throttling Redis Valkey di pintu masuk. |

## 🚦 Protokol Eksekusi (WAJIB dibaca sesuai situasi)

> **SEBELUM membuka tabel di bawah:** Jika ini adalah proyek baru atau keputusan arsitektur besar, WAJIB lewati `master_decision_tree.md` (`~/.gemini/config/skills/master-decision-tree/SKILL.md`) terlebih dahulu. DILARANG langsung memilih NestJS sebagai stack tanpa justifikasi dari Decision Tree.

| Situasi | WAJIB baca dulu sebelum menulis apa pun |
| :--- | :--- |
| Inisiasi project baru dari nol | `references/_protocol/greenfield.md` |
| Tambah fitur / refactor / optimasi / audit di repo eksisting | `references/_protocol/brownfield.md` |
| Operasi menyentuh >3 berkas atau >3 domain | `references/_protocol/greenfield.md` bagian **Swarm Research Protocol** |
| Keputusan arsitektur / menantang pilihan stack (Challenger Mode) | `references/_protocol/tradeoff.md` |

DILARANG membuat dokumen RFC (`docs/rfc/`) atau menulis kode sebelum protokol yang relevan dibaca tuntas.

---

## 🗺️ Matriks Routing Rujukan Ilmu Kasta Tertinggi (36 Domain Silos - 138 Berkas)

Cocokkan tugas ke domain di bawah, lalu baca rujukannya. Taksonomi 3-Tier, akses acak — DILARANG dibaca berurutan.

### Tier I: Core Foundation & Application Infrastructure (15 Domain)
*(Ilmu fondasi WAJIB yang bergelar Fardu Ain untuk diimplementasikan pada 100% produksi aplikasi NestJS Enterprise)*
| Nama Domain | Direktori Referensi | Rujukan Utama yang Tersedia (SSOT) |
| :--- | :--- | :--- |
| **Core Arch Patterns** | `references/core_arch_patterns/` | DI IoC Container Internals, Hexagonal Ports/Adapters, Modular DDD, CQRS Event Sourcing, Dynamic Modules `forRootAsync` |
| **HTTP Engine Fastify** | `references/http_engine_fastify/` | Express to Fastify Migration, JSON Schema Ajv Speed, Fastify Multipart Big Uploads, WebSocket Fastify Ws Adapter |
| **DB & Persistence ORM** | `references/db_persistence_orm/` | Prisma Tuning & PgBouncer, Drizzle ORM Zero-Overhead SQL, TypeORM `@Transactional` Decorators, MongoDB Mongoose Virtuals, Redis Valkey In-Memory Lock, Zero-Downtime Migrations |
| **Validation Serialization** | `references/validation_serialization/` | class-validator Transformer Deep Dive, High Performance Zod TypeBox Pipes, Custom Decorators Async Validators, DTO Security Shield Payload Stripping |
| **Configuration Env Management** | `references/configuration_env_management/` | Zod Joi Schema Validation Env Startup, HashiCorp Vault Dynamic Secret Injection, Namespace Config `registerAs` Injection |
| **Security OWASP Zero-Trust** | `references/security_owasp_zerotrust/`| JWKS OIDC Stateless Auth, RBAC/ABAC Reflector Guards, OWASP Top 10 Fastify Helmet, DDOS Mitigation Redis Throttler, SQLi/NoSQLi Injection Prevention, Argon2id Password Hashing Encryption |
| **Identity IAM, SSO & Passkeys**| `references/identity_iam_sso_mfa/` | Passkeys FIDO2 WebAuthn Biometric, OAuth2 OIDC Social SSO PKCE, TOTP MFA SMS OTP Throttling, Session Revocation Device Tracking |
| **Testing Quality QA** | `references/testing_quality_qa/` | Jest SWC Supercharged Suite, E2E Fastify Inject Testing, Mocking DI Container Overrides, Pact Contract Testing, Testcontainers Docker QA |
| **Observability & APM** | `references/observability_apm_metrics/` | OTel Distributed Tracing gRPC, Prometheus RED Metrics, Pino Zero-Allocation JSON Logger, Global Exception Filter RFC 7807, AsyncLocalStorage Context Tracking |
| **Structured Logging Telemetry** | `references/structured_logging_telemetry/` | Pino Async Destination Elasticsearch, Sentry Error Source Maps, Winston Daily Rotate Retention, Audit Trail Immutable User Activity Log |
| **Caching Strategy CDN** | `references/caching_strategy_cdn/` | Multi-Tier Cache Manager Valkey, Cache Stampede Dogpile Atomic Locks, Tenant Tagged Cache Invalidation, CDN Stale-While-Revalidate ETag |
| **File Storage & Object CDN** | `references/file_storage_object_cdn/` | S3 R2 Presigned Direct Upload, Multipart Chunked Resumable Streams, Sharp Image Worker Pipeline, Secure ACL Expiring Document Links |
| **Omnichannel Notifications** | `references/omnichannel_notifications_mail/`| Email Engine Resend SES DKIM, FCM APNs Push Notifications Batching, WhatsApp Twilio SMS OTP Fallback, In-App Notification Center Inbox |
| **Concurrency & Runtime**| `references/concurrency_runtime_internals/`| V8 Libuv Event Loop Phases, Worker Threads Piscina Offloading, Bun Runtime Dual-Compat, OOM Heap Snapshot Memory Leak Hunting |
| **Background Jobs Queues** | `references/background_jobs_queues/` | BullMQ Advanced Queue Workers, Distributed Lock Cron Scheduling, Exponential Backoff Retry DLQ Strategy, Queue Job Observability Arena |
| **Docker Container Standards** | `references/docker_container_standards/`| modular_3tier_container_topology.md, Multi-Stage Distroless Alpine, Non-Root User SIGTERM Hooks, Corepack Pnpm Docker Caching, K8s Terminus Health Probes |

### Tier II: Distributed Systems, Async & Cloud Scale (13 Domain)
*(Ilmu arsitektur skala besar yang dipanggil saat aplikasi berkembang ke Mikroservice, Event-Driven Monorepo, & High-Concurrency)*
| Nama Domain | Direktori Referensi | Rujukan Utama yang Tersedia (SSOT) |
| :--- | :--- | :--- |
| **Microservices gRPC** | `references/microservices_grpc/` | Protobuf Evolution ts-proto, gRPC Streaming Bidirectional, Deadline Circuit Breaker Interceptor, Transactional Outbox Saga gRPC |
| **Message Brokers Event Stream** | `references/message_brokers_event_streaming/`| Kafka Consumer Groups & Commit Offset, RabbitMQ AMQP DLQ Topic Routing, NATS JetStream Distributed Persistence, Redis Streams Event Sourcing Log |
| **API GraphQL Federation** | `references/api_graphql_federation/`| Code-First vs Schema-First GraphQL, Apollo Federation v2 Subgraph, DataLoader N+1 Mitigation |
| **Realtime WebSocket SSE** | `references/realtime_websocket_sse/` | WebSocket Gateway WsGuard Security, Server-Sent Events SSE AI Streaming, Redis PubSub Ws Adapter Cluster, Heartbeat Ping Pong Connection Harvesting |
| **CQRS Event Sourcing** | `references/cqrs_event_sourcing/` | NestJS CQRS Command/Query Bus Setup, EventStoreDB Append Events Stream, Read Model Projection Denormalization |
| **Search Engine & Catalog Sync**| `references/search_engine_catalog_indexing/`| Meilisearch Faceted Catalog Engine, Elasticsearch OpenSearch Aggregation, CDC Debezium Zero-Downtime Sync, Synonyms Prominence Scoring |
| **API Gateway & Versioning** | `references/api_versioning_gateway_routing/`| Enterprise API Versioning Strategies, API Gateway Reverse Proxy Upstream, Tenant Quota Metered Billing Redis |
| **Workflow & Temporal Sagas** | `references/workflow_orchestration_temporal/`| Temporal.io SDK Long-Running Sagas, Finite State Machines XState Orders, Compensation Workflows Human-In-Loop |
| **Multi-Tenancy Architecture** | `references/multi_tenancy_architecture/` | Postgres RLS Row Level Security, Schema Based Tenant Isolation Prisma, Dedicated Database Dynamic Datasink |
| **Serverless AWS Lambda Cloud** | `references/serverless_aws_lambda_cloud/` | Serverless Express AWS Lambda Handler, SQS/SNS Lambda Worker Microservice, Cold Start Mitigation Lazy Modules |
| **Monorepo Nx Workspaces** | `references/monorepo_nx_workspaces/` | Nx Workspaces Shared Library Architecture, Affected Build Test CI/CD Caching, Dependency Graph Boundary Enforcement |
| **DevOps K8s GitOps** | `references/devops_k8s_gitops/` | Helm Charts K8s Manifest Blueprint, ConfigMap Secret Volume Reloading (Zero-Downtime), HPA Custom Metrics Prometheus Scaling |

### Tier III: Niche Verticals & Advanced Metaprogramming (8 Domain)
*(Ilmu spesialis tingkat dewa yang dipicu saat menemukenali kebutuhan vertikal industri atau tuning ketahanan ekstrim)*
| Nama Domain | Direktori Referensi | Rujukan Utama yang Tersedia (SSOT) |
| :--- | :--- | :--- |
| **AI Vector RAG Integration** | `references/ai_vector_rag_integration/` | pgvector Pinecone LangChain TS, Streaming LLM Responses SSE WebSocket, Embedding Batch Processor BullMQ, AI Tool Calling Decorator Reflection |
| **Fintech Payment Gateways** | `references/fintech_payment_gateways/` | Webhook Idempotency Signature Verification, Two-Phase Commit 2PC Distributed Transactions, BigInt Zero-Trust Currency Accounting, Ledger Append-Only Immutable Records |
| **OpenAPI Documentation** | `references/openapi_documentation/` | OpenAPI 3.1 Automation CLI Plugin, Secure Endpoints Bearer ApiKey Docs, Auto-Generate Client SDK TypeScript, Swagger UI Custom Theme Branding |
| **I18n Localization** | `references/i18n_localization/` | nestjs-i18n Enterprise Setup, Zero-Copy ICU Message Formatting, Localized Exception Filter Errors |
| **CLI Scripting Commander** | `references/cli_scripting_commander/` | nest-commander CLI Workspaces, Interactive Prompts Seeding Scripts, Background Daemon Orchestration |
| **Low Level Addons N-API**| `references/low_level_addons_napi/` | napi-rs Rust Binding Integration, Zero-Overhead Crypto Hashing Bridges, Memory Buffer Ownership Sharing |
| **Chaos Engineering Resilience**| `references/chaos_engineering_resilience/`| Fault Injection Custom Interceptors, Circuit Breaker Graceful Degradation, Bulkhead Pattern Concurrency Isolation |
| **Meta-Programming Decorators**| `references/meta_programming_decorators/`| Reflector Metadata Engine Deep Dive, Custom Method Parameter Decorators, Metadata Reflection Boilerplate Abstraction |

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

> Skrip di `scripts/` bundle ini mengaudit mutu **berkas referensi mastery**, bukan kode proyek user — itu wilayah `skill-engineering-mastery`. DILARANG memakainya sebagai gerbang mutu proyek.

---
*Manifes `nestjs-mastery` ini adalah Single Source of Truth (SSOT). Jadikan hukum kepatuhannya sebagai jembatan melompati kemegahan arsitektur dunia nyata!*
