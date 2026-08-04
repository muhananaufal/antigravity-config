---
name: nestjs-mastery
description: Gunakan skill ini ketika merancang arsitektur Enterprise TypeScript, Dependency Injection IoC internals, Hexagonal Ports & Adapters, Fastify Engine tuning, Prisma/Drizzle ORM performance, Microservices gRPC/Kafka/NATS, Apollo GraphQL Federation v2, Multi-Tenancy RLS, AI Scout/pgvector/LangChain, Fintech ACID 2PC, atau Zero-Trust security di NestJS.
---

# NestJS Enterprise Mastery: Kasta Sultan & Top 1% Architecture

Selamat datang di mahakarya abadi **`nestjs-mastery`**, sebuah mesin pendorong kognitif yang didedikasikan untuk rekayasa backend TypeScript skala enterprise terkece di planet ini. Berpedoman tegak lurus pada hukum **Zero-Tolerance Top 1% Engineering**, skill ini mengharamkan kode serabutan ala tutorial murahan, menentang penggunaan placeholder (`// TODO`), melarang penyingkapan rahasia statis di kode, dan menodah kelemahan pengetikan data (`any` bypass).

---

## 🏛️ Filosofi Arsitektur Mutlak & Pilar Utama

1. **Fastify First Engine Dominant:** Express adalah legenda masa lalu yang lamban dan boros I/O. Di lingkungan enterprise ini, **Fastify (`@nestjs/platform-fastify`)** dipatok sebagai adapter HTTP utama murni untuk meluncurkan latensi eksekusi JSON berkecepatan tinggi dan skalabilitas koneksi bersamaan yang ekstrem.
2. **Kedisiplinan Hexagonal & Modular DDD:** Struktur direktori wajib dipisahkan berdasarkan pola *Domain-Driven Design (DDD) Bounded Contexts* dan *Hexagonal Ports & Adapters*. Business logic murni berada di tengah (core domain), sepenuhnya buta terhadap database eksternal maupun protokol HTTP/gRPC.
3. **Strict Type-Safety & Zero `any` Bypass:** TypeScript tidak berhak disalahgunakan sebagai JavaScript berbaju modern. Penggunaan `any`, `Object`, atau `unknown` tanpa pengecekan tipe refleksi eksternal yang ketat (*Zod*, *Ajv*, *TypeBox*, atau *class-validator* berlambang `whitelist: true`) adalah **DOSA BESAR**.
4. **Resilience & Non-Blocking Event Loop:** Node.js / Bun bekerja di atas V8 Single-Threaded Event Loop. Komputasi CPU-bound masif (seperti hashing, kriptografi, atau pemrosesan Excel gb-scale) **WAJIB DIASTRAKSI KELUAR DARI MAIN EVENT LOOP** ke kumpulan benang eksekusi (*Worker Threads pool via Piscina* atau *Rust N-API Addon via napi-rs*).
5. **Zero-Trust & OWASP API Security:** Tidak ada paket request yang dianggap aman secara default. Enkripsi otentikasi menggunakan JWKS asimetris / OIDC di HTTP-Only Secure Cookies, otentikasi metadata RBAC/ABAC murni via `Reflector`, dan mitigasi pembantaian DDOS dari pintu masuk dengan Redis Valkey Throttling.
6. **HUKUM MUTLAK DAY-0 GREENFIELD BOOTSTRAP (5 PILAR PRODUCTION-READY):** Setiap inisiasi proyek baru (Greenfield) di NestJS WAJIB secara default meracik 5 pilar fondasi Day-0 berikut di root proyek:
   - **Pilar 1: Modular 3-Tier Container Topology:** Tier 1 Core (`docker-compose.yml` Postgres & Redis Valkey), Tier 2 Telemetry (`profiles: [telemetry]` OTel Collector, Prometheus RED, Grafana, Loki), Tier 3 Stress Harness (`profiles: [stress]` `grafana/k6`). *(Dilarang auto-run `docker build`/`up` tanpa izin user).*
   - **Pilar 2: Fail-Fast Type-Safe Configuration:** `.env.example` bersih + `ConfigModule` berpagar `validationSchema` (Zod/Joi/class-validator) saat bootstrap (wajib *crash on boot* jika env hilang sebelum listen port HTTP).
   - **Pilar 3: Graceful Shutdown & Lifecycle Hooks:** Wajib mengaktifkan `app.enableShutdownHooks()` untuk menangkap `SIGINT`/`SIGTERM`, mendrain koneksi Fastify, menutup Prisma/Drizzle pool, dan mem-flush OTel Tracing SDK.
   - **Pilar 4: Database Migration & Idempotent Seeder Baseline:** Direktori `prisma/migrations` / `drizzle` + skrip `prisma/seed.ts` atau database seeder untuk inisiasi akun admin awal.
   - **Pilar 5: Unified Task Runner (`Makefile` / `package.json` scripts):** Perintah baku `make dev` (Nest Fastify hot-reload), `make infra-up`/`down`, `make telemetry-up`, `make migrate`, `make seed`, `make test` (Jest), `make stress` (k6).

---

## 🗺️ Matriks Routing Rujukan Ilmu Kasta Tertinggi (36 Domain Silos - 138 Berkas)

Ketika Anda dihadapkan pada tugas pengembangan, optimasi, atau perombakan sistem di proyek NestJS, panggil subagent atau navigasikan rujukan ilmu ekstrim Anda sesuai taksonomi **3-Tier Enterprise Architecture** (Core, Distributed/Cloud, dan Niche Verticals) berikut tanpa keterikatan penomoran alur sekuensial (Murni Modular Domain Random-Access):

### Tier I: Core Foundation & Application Infrastructure (15 Domain)
*(Ilmu fondasi wajib yang bergelar Fardu Ain untuk diimplementasikan pada 100% produksi aplikasi NestJS Enterprise)*
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
| **Docker Container Standards** | `references/docker_container_standards/`| modular_3tier_container_topology.md, Multi-Stage Distroless Alpine, Non-Root User SIGTERM Hooks, Corepack Pnpm Docker Caching, K8s Terminus Health Probes |

### Tier II: Distributed Systems, Async & Cloud Scale (13 Domain)
*(Ilmu arsitektur skala besar yang dipanggil saat aplikasi berkembang ke Mikroservice, Event-Driven Monorepo, & High-Concurrency)*
| Nama Domain | Direktori Referensi | Rujukan Utama yang Tersedia (SSOT) |
| :--- | :--- | :--- |
| **Microservices gRPC** | `references/microservices_grpc/` | Protobuf Evolution ts-proto, gRPC Streaming Bidirectional, Deadline Circuit Breaker Interceptor, Transactional Outbox Saga gRPC |
| **Message Brokers Event Stream** | `references/message_brokers_event_streaming/`| Kafka Consumer Groups & Commit Offset, RabbitMQ AMQP DLQ Topic Routing, NATS JetStream Distributed Persistence, Redis Streams Event Sourcing Log |
| **API GraphQL Federation** | `references/api_graphql_federation/`| Code-First vs Schema-First GraphQL, Apollo Federation v2 Subgraph, DataLoader N+1 Mitigation |
| **Realtime WebSocket SSE** | `references/realtime_websocket_sse/` | WebSocket Gateway WsGuard Security, Server-Sent Events SSE AI Streaming, Redis PubSub Ws Adapter Cluster, Heartbeat Ping Pong Connection Harvesting |
| **Background Jobs Queues** | `references/background_jobs_queues/` | BullMQ Advanced Queue Workers, Distributed Lock Cron Scheduling, Exponential Backoff Retry DLQ Strategy, Queue Job Observability Arena |
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

## 🤖 Protokol Swarm Paralel & Cara Pengambilan Ilmu

Sebagai AI dengan keunggulan penalaran kelas Principal, **DILARANG KERAS MENGAWANG ATAU MENGARANG DARI HAFALAN LLM MENTAH** saat menghadapi kasus kompleks. Pastikan Anda mengaktifkan **Swarm Research Protocol**:

1. **Pemeta Rujukan lokal Pertama (Local-First):** Jika Anda berhadapan dengan masalah optimasi GraphQL, panggil tool `list_dir` untuk mengecek direktori `references/api_graphql_federation/`, lalu gunakan `view_file` atau `grep_search` untuk menanamkan isi rujukan ke dalam penalaran Anda.
2. **Spawne Armada Subagent Secara Paralel:** Untuk operasi besar yang melibatkan >3 file atau >3 domain sekaligus, jangan ragu untuk memantulkan spesifikasi JSON deklaratif tool `invoke_subagent` dengan array armada spesialis (menggunakan Workspace Mode `share` dan Model Tier `pro`).
3. **Ketaatan Tanpa Sisa:** Kode yang Anda atau Subagent ciptakan berdasarkan ilmu dari rujukan ekosistem ini wajib mencerminkan standar yang sama: 100% type-safe, kompilabel, lulus uji unit tes (Jest/SWC/Fastify Inject), dan menakdirkan keandalan militer!

---

## 🛡️ Penegakan Mutu & Quality Gates (Zero-Tolerance)

Sebelum Anda melaporkan sebuah tugas perbaikan, migrasi, ataupun pembatalan fitur selesai (`[x]` pada Kanban Tracker), Anda **WAJIB** mengeksekusi instrumen penegak hukum yang bersemadi di direktori `scripts/`:

- **Di Windows OS (PowerShell):**
  Jalankan terminal command `run_command`:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\muhan\.gemini\config\skills\nestjs-mastery\scripts\audit_quality_gate.ps1
  ```
- **Di Linux / macOS (Bash):**
  Jalankan terminal command `run_command`:
  ```bash
  bash C:\Users\muhan\.gemini\config\skills\nestjs-mastery\scripts\quality_gate.sh
  ```

Skrip penegakan di atas akan langsung membantai dan memblokir eksekusi Anda apabila menemukenali adanya:
1. Peringatan kompilasi TypeScript atau linter kegagalan pada `phpstan/clippy/eslint`.
2. Kegagalan pada rangkaian unit test Jest/SWC lokal.
3. Kebatalan hukum kemangkrakkan teks malas (`// TODO`, `// FIXME`, atau komentar placeholder sejenis).
4. Kebocoran kredensial statis (`password: "..."`, `api_key: "..."`, atau rahasia yang tidak di-parse dari `.env`).

---

## ⚡ Analisis Trade-Off: Kapan MENGGUNAKAN dan KAPAN MENGHINATARI NestJS?

Sebagai perwira bersponsor *Critical Challenger Mode*, kita wajib menakar kelemahan sistem secara jujur dan transparan:

### Keunggulan Ekstrem NestJS (Why We Champion It):
1. **Kedisiplinan Enterprise Mutlak di Dunia Node.js:** Menembak mati kekacauan arsitektur *spaghetti code* khas JavaScript tradisional dengan pola rancang bangun berskill murni ala Spring Boot (DI, Interceptors, Guards, dan Decorator modular).
2. **Kekuatan I/O Throughput Tinggi bermodorkan Fastify & Bun:** Mengemas skalabilitas jaringan asinkronus tercepat dunia berbantuan Fastify engine dan kompatibilitas Bun Runtime, mencetak rekor jutaan RPS untuk API monosit maupun microservices.
3. **Isomorfisme Fullstack:** Memungkinkan tim engineering memakai satu bahasa statikal murni (TypeScript) bersandar pembagian kontrak DTO Zod / OpenAPI yang sinkron sejati dari antarmuka frontend (Next.js) hingga mikroservice terbawah!

### Kelemahan & Batasan (When to Challenge and Pivot):
1. **Bottleneck Single-Threaded pada Komputasi Berat (CPU-Bound):** Jika sistem diproyeksikan 80% pekerjaannya adalah komputasi matematika berat, enkode video murni di proses lokal, atau kriptografi jutaan loop, **TANTANG USER ATAS RESIKO BOTTLENECK INTEL!** Sarankan untuk memutar proses tersebut di **Rust / Golang**, atau pasangkan bridge biner via `napi-rs` / `Piscina Worker Threads`.
2. **Overhead Memori Heap & Cold Start pada Serverless:** Ukuran jejak memori V8 Heap awal dan waktu muat reflection (*Metadata Reflection Engine*) NestJS tergolong cukup besar untuk platform Function-as-a-Service (FaaS / AWS Lambda) berfrekuensi panggil jarang. Tanpa kompilasi *SWC/esbuild micro bundle* dan teknik *provisioned concurrency warm-up*, latensi *Cold Start* bisa menyiksa pengguna!
3. **Kutukan Ilusi Runtime TypeScript (Type Erasure):** INGAT BAHWA SECRETO TIPE DATA TYPESCRIPT MUSNAH DI COMPILER! Di runtime, V8 mengeksekusi JavaScript mentah. Jika developer luput memasang pipa validasi skema eksternal (*Zod/TypeBox*), muatan JSON jahat berpotensi merusakkan alur database tanpa diantisipasi tipe compile-time!

---
*Manifes `nestjs-mastery` ini adalah Single Source of Truth (SSOT). Jadikan hukum kepatuhannya sebagai jembatan melompati kemegahan arsitektur dunia nyata!*
