---
name: master-decision-tree
description: Gunakan skill ini ketika merancang arsitektur sistem baru, memilih tech-stack, membuat proyek dari nol, atau menambahkan komponen arsitektur besar (message broker, caching strategy, pecah monolit). WAJIB dilewati sebelum memilih bahasa/framework apa pun.
---

# 🌳 Master Decision Tree — Principal Engineering Architectural Guide

> **Filosofi:** Dokumen ini adalah peta keputusan arsitektural yang bersifat **language-agnostic** (bebas bahasa pemrograman). Ia tidak bertanya "Pakai Go atau Laravel?", melainkan bertanya "Apa masalah bisnisnya?" — lalu mengarahkan Anda ke solusi yang tepat beserta referensi spesifik di perpustakaan keempat bahasa kita (Golang, Rust, Laravel, NestJS).
>
> **Kapan Dibaca:** Sebelum menulis dokumen RFC (`docs/rfc/`) untuk proyek baru (Greenfield) ATAU sebelum merancang fitur besar di proyek eksisting (Brownfield). Agen AI WAJIB melewati pohon ini sebelum memilih stack atau arsitektur.
>
> **Cara Membaca:** Ikuti pohon dari atas ke bawah. Setiap NODE adalah pertanyaan. Jawab, lalu ikuti cabangnya. Berhenti di DAUN (leaf) yang memberikan keputusan final beserta rujukan domain.

---

## BAGIAN 0: META-DECISION — GREENFIELD vs BROWNFIELD

```
ROOT: Apakah ini proyek baru dari nol (Greenfield)?
├── YA ─────────── Lanjut ke BAGIAN 1 (Compute Model Selection)
│                   Anda akan memilih fondasi dari awal.
│
└── TIDAK (Brownfield / Legacy) ──┐
    │                              │
    ├── Apakah fitur baru ini bisa hidup di dalam arsitektur yang sudah ada
    │   TANPA melanggar batasan performa/keamanan?
    │   ├── YA ── Gunakan bahasa & framework yang sudah ada.
    │   │         Lanjut ke BAGIAN 2+ untuk keputusan domain spesifik.
    │   │
    │   └── TIDAK (Contoh: sistem legacy PHP diminta handle 50k req/s,
    │             atau monolit Node.js diminta proses video encoding)
    │         │
    │         ├── Apakah bisa di-refactor secara bertahap (Strangler Fig)?
    │         │   ├── YA ── Potong satu bounded context, buat microservice baru.
    │         │   │         Lanjut ke BAGIAN 1 untuk memilih bahasa microservice tsb.
    │         │   │
    │         │   └── TIDAK (terlalu kusut, zero test coverage, bus factor 0)
    │         │         └── Evaluasi rewrite. Lanjut ke BAGIAN 1.
    │         │             ⚠️ PERINGATAN: Full rewrite adalah keputusan bisnis,
    │         │             bukan keputusan teknis. Wajib approval stakeholder.
```

---

## BAGIAN 1: COMPUTE MODEL — PEMILIHAN RUNTIME & BAHASA

> Node ini HANYA untuk proyek baru atau microservice baru yang dipotong dari monolit.
> Jika Anda sudah punya codebase, lewati bagian ini.

```
NODE 1.1: Apa CONSTRAINT (batasan) paling dominan dari sistem ini?
│
├── A) TIME-TO-MARKET (Harus rilis < 4 minggu, tim kecil 1-3 orang)
│   │
│   ├── Butuh Admin Panel / CMS / Dashboard internal?
│   │   ├── YA ── 🔴 LARAVEL + Filament/Nova
│   │   │         Ref: laravel-mastery → ecosystem_firstparty/
│   │   └── TIDAK
│   │       ├── Tim kuat di TypeScript/React?
│   │       │   ├── YA ── 🟢 NESTJS + Prisma
│   │       │   │         Ref: nestjs-mastery → core_arch_patterns/
│   │       │   └── TIDAK ── 🔴 LARAVEL (default tercepat)
│   │
├── B) THROUGHPUT EKSTREM (> 50k req/s, < 10ms p99 latency)
│   │
│   ├── Butuh memory safety guarantee (finansial, medical, aerospace)?
│   │   ├── YA ── 🦀 RUST + Axum
│   │   │         Ref: rust-mastery → web_microservices/, high_performance_hft/
│   │   └── TIDAK
│   │       └── 🔵 GOLANG (rasio performa/produktivitas terbaik)
│   │           Ref: golang-mastery → concurrency/, microservices_grpc/
│   │
├── C) EKOSISTEM INFRASTRUKTUR (K8s Operator, CLI Tools, DevOps Tooling)
│   │   └── 🔵 GOLANG (bahasa ibu Kubernetes, Docker, Terraform)
│   │       Ref: golang-mastery → cloud_native_k8s_operators/, cli_tooling/
│   │
├── D) SYSTEMS PROGRAMMING (OS-level, embedded, kernel module, game engine)
│   │   └── 🦀 RUST (satu-satunya pilihan yang aman)
│   │       Ref: rust-mastery → unsafe_ffi_internals/, compiler_llvm_internals/
│   │
├── E) FULL-STACK MONOLITH (Backend + Frontend dalam satu repo, satu deploy)
│   │   └── 🔴 LARAVEL + Inertia.js/Livewire
│   │       Ref: laravel-mastery → inertia_livewire/
│   │
└── F) ENTERPRISE TYPESCRIPT (Tim besar, DI/IoC wajib, standarisasi ketat)
        └── 🟢 NESTJS + Fastify
            Ref: nestjs-mastery → core_arch_patterns/, http_engine_fastify/
```

---

## BAGIAN 2: DATA PERSISTENCE — STRATEGI PENYIMPANAN DATA

```
NODE 2.1: Apa NATURE (sifat) data utama sistem ini?
│
├── A) RELASIONAL (User, Order, Product — ada foreign key, butuh JOIN)
│   │
│   ├── Butuh compile-time SQL validation (zero runtime SQL error)?
│   │   ├── YA ── 🦀 SQLx (Rust) atau 🔵 SQLC (Go)
│   │   │         Ref: rust → db_persistence_sqlx/ | golang → db_sqlc/
│   │   └── TIDAK
│   │       ├── Butuh rapid prototyping (schema auto-migrate)?
│   │       │   ├── YA ── 🔴 Eloquent (Laravel) atau 🟢 Prisma (NestJS)
│   │       │   │         Ref: laravel → db/ | nestjs → db_persistence_orm/
│   │       │   └── TIDAK ── Gunakan query builder / raw SQL di bahasa apapun
│   │
├── B) DOKUMEN (JSON fleksibel, nested, schema-less)
│   │   ├── Butuh transaksi ACID lintas dokumen?
│   │   │   ├── YA ── PostgreSQL JSONB (bukan MongoDB!)
│   │   │   │         Alasan: Postgres memberi ACID + JSON sekaligus.
│   │   │   └── TIDAK ── MongoDB bisa dipertimbangkan
│   │   │                 Ref: nestjs → db_persistence_orm/ (Mongoose section)
│   │
├── C) TIME-SERIES (Sensor IoT, metrik, log, analytics per waktu)
│   │   └── TimescaleDB (ekstensi Postgres) atau InfluxDB
│   │       Ref: laravel → spatial_timeseries_db/
│   │
├── D) GRAPH (Social network, recommendation engine, dependency tree)
│   │   └── Neo4j atau PostgreSQL recursive CTE
│   │       (Belum ada domain khusus — gunakan web search)
│   │
├── E) KEY-VALUE / CACHE (Session, rate limiter, leaderboard)
│   │   └── Redis / Valkey (Lanjut ke NODE 2.2)
│   │
└── F) SEARCH INDEX (Full-text search, faceted filtering, typo tolerance)
        │
        ├── Data < 1 juta dokumen dan butuh setup cepat?
        │   └── Meilisearch
        │       Ref: nestjs → search_engine_catalog_indexing/
        ├── Data > 10 juta dokumen, butuh aggregation pipeline?
        │   └── Elasticsearch / OpenSearch
        │       Ref: nestjs → search_engine_catalog_indexing/
        └── Hanya butuh basic search di kolom teks?
            └── PostgreSQL Full-Text Search (pg_trgm + tsvector)
                Tidak perlu infrastruktur tambahan.
```

```
NODE 2.2: CACHING — Apakah sistem ini membaca data yang sama berulang kali?
│
├── TIDAK (Setiap request unik, data selalu berubah)
│   └── JANGAN pasang cache. Cache yang salah lebih berbahaya dari tidak ada cache.
│
├── YA, tapi data berubah < setiap 5 menit
│   │
│   ├── L1: In-Process Memory Cache (Tercepat, ~1μs)
│   │   ├── 🔵 Go: github.com/dgraph-io/ristretto atau patrickmn/go-cache
│   │   ├── 🦀 Rust: moka (async-compatible, TTL, max-capacity)
│   │   ├── 🟢 NestJS: @nestjs/cache-manager (in-memory store)
│   │   └── 🔴 Laravel: Octane in-memory cache (hanya jika pakai Octane/Swoole)
│   │
│   ├── L2: Redis / Valkey (Shared across instances, ~1ms)
│   │   Ref: golang → caching_strategy/ | laravel → caching_strategy_cdn/
│   │   Ref: nestjs → caching_strategy_cdn/ | rust → caching_strategy_cdn/
│   │
│   └── ⚠️ WAJIB tangani: Cache Stampede (Dogpile Effect)
│       Ketika cache expire, 10,000 request serentak menghantam DB.
│       Solusi: Singleflight (Go), Atomic Lock (Laravel), Mutex (NestJS/Rust)
│       Ref: Semua bahasa punya section ini di domain caching masing-masing.
│
└── YA, dan data ini bersifat PUBLIK + jarang berubah (aset statis, halaman marketing)
    └── L3: CDN Edge Cache (Cloudflare, CloudFront)
        Ini BUKAN urusan kode aplikasi. Ini urusan infra/DevOps.
        Set header: Cache-Control, ETag, Stale-While-Revalidate.
```

---

## BAGIAN 3: ASYNCHRONOUS PROCESSING — BACKGROUND JOBS & MESSAGING

> **⚠️ HUKUM BESI:** `go func()`, `tokio::spawn()`, `setTimeout()` BUKAN background job.
> Mereka memberikan NOL durabilitas. Server mati = job hilang tanpa jejak.
> Ini adalah ANTI-PATTERN untuk tugas apa pun yang tidak boleh hilang.

```
NODE 3.1: Apakah tugas ini HARUS selesai meskipun server restart/crash/OOM?
│
├── YA (Email verifikasi, invoice PDF, webhook payment, mutasi saldo)
│   │
│   ├── NODE 3.1.1: Berapa lama tugas ini berjalan?
│   │   │
│   │   ├── < 30 detik (Kirim email, resize gambar, push notifikasi)
│   │   │   └── DURABLE TASK QUEUE
│   │   │       ├── 🔵 Go: Asynq (Redis-backed) atau River (Postgres-backed)
│   │   │       ├── 🦀 Rust: Apalis + Redis/Postgres
│   │   │       ├── 🟢 NestJS: BullMQ (Redis-backed)
│   │   │       └── 🔴 Laravel: Horizon + Redis Queue
│   │   │       Ref: Semua bahasa → background_jobs_*/
│   │   │
│   │   ├── 30 detik – 30 menit (Export Excel 100k baris, batch processing)
│   │   │   └── DURABLE TASK QUEUE + PROGRESS TRACKING + RETRY dengan DLQ
│   │   │       Tambahkan: Dead Letter Queue agar job yang gagal 3x
│   │   │       tidak hilang, melainkan diparkir untuk investigasi manual.
│   │   │
│   │   └── > 30 menit atau MULTI-STEP (Order fulfillment, onboarding flow)
│   │       └── WORKFLOW / SAGA ORCHESTRATOR
│   │           ├── 🔵 Go: Temporal.io SDK
│   │           ├── 🦀 Rust: Temporal.io SDK (atau custom saga via Apalis)
│   │           ├── 🟢 NestJS: Temporal.io atau custom CQRS Saga
│   │           └── 🔴 Laravel: Custom Saga via Job Chains + DB State Machine
│   │           Ref: nestjs → workflow_orchestration_temporal/
│   │           Ref: laravel → background_jobs_saga/
│   │
│   └── NODE 3.1.2: Apakah tugas ini melibatkan KOORDINASI antar-service?
│       │
│       ├── YA (Service A debit saldo → Service B kirim barang → Service C kirim email)
│       │   └── SAGA PATTERN (Orchestration atau Choreography)
│       │       ├── Orchestration: Satu "Saga Coordinator" mengatur urutan.
│       │       │   Lebih mudah di-debug. Gunakan Temporal atau custom state machine.
│       │       └── Choreography: Setiap service emit event, service lain bereaksi.
│       │           Lebih loosely coupled. Gunakan Kafka/NATS + Transactional Outbox.
│       │       Ref: golang → distributed_patterns_resilience/
│       │       Ref: nestjs → cqrs_event_sourcing/, workflow_orchestration_temporal/
│       │
│       └── TIDAK (Satu service saja)
│           └── Cukup Durable Task Queue (kembali ke NODE 3.1.1)
│
└── TIDAK (Tugas ringan, boleh hilang tanpa dampak bisnis)
    │
    ├── Apakah bahasa Anda mendukung lightweight concurrency?
    │   ├── 🔵 Go: `go func() { ... }()` ── BOLEH, goroutine sangat murah (~4KB).
    │   ├── 🦀 Rust: `tokio::spawn(async { ... })` ── BOLEH, task Tokio sangat ringan.
    │   ├── 🟢 NestJS: `setImmediate()` atau `Promise.all()` ── BOLEH untuk I/O-bound.
    │   │   ⚠️ CPU-bound → WAJIB pindah ke Worker Thread (Piscina).
    │   │   Ref: nestjs → concurrency_runtime_internals/
    │   └── 🔴 Laravel: TIDAK BISA fire-and-forget secara native.
    │       PHP mati setelah response. WAJIB masuk Queue meskipun ringan.
    │       Ref: laravel → concurrency/, background_jobs_saga/
    │
    └── Contoh tugas ringan yang boleh fire-and-forget:
        - Increment view counter (eventual consistency OK)
        - Pre-warm cache di background
        - Non-critical analytics event
```

```
NODE 3.2: INTER-SERVICE MESSAGING — Bagaimana service berkomunikasi?
│
├── SINKRON (Request-Response, caller menunggu jawaban)
│   │
│   ├── Internal (service-to-service di dalam cluster)
│   │   ├── Butuh streaming atau performa tinggi?
│   │   │   ├── YA ── gRPC (Protobuf, HTTP/2, bidirectional streaming)
│   │   │   │         Ref: golang → microservices_grpc/ | rust → networking_protocols_grpc/
│   │   │   └── TIDAK ── REST/HTTP cukup. Jangan over-engineer.
│   │   │
│   │   └── ⚠️ WAJIB pasang: Timeout, Retry, Circuit Breaker.
│   │       Tanpa ini, satu service lambat akan melumpuhkan seluruh cluster.
│   │       Ref: golang → distributed_patterns_resilience/
│   │
│   └── Eksternal (ke client / 3rd party)
│       └── REST API (standar industri untuk public API)
│           Ref: semua bahasa → domain api masing-masing
│
└── ASINKRON (Fire event, tidak menunggu jawaban)
    │
    ├── Butuh ordering guarantee (urutan pesan dijamin)?
    │   ├── YA ── Apache Kafka (partitioned log, consumer groups)
    │   │         Ref: nestjs → message_brokers_event_streaming/
    │   └── TIDAK
    │       ├── Butuh complex routing (fanout, topic, dead letter)?
    │       │   ├── YA ── RabbitMQ (AMQP, exchange routing, DLQ)
    │       │   │         Ref: nestjs → message_brokers_event_streaming/
    │       │   └── TIDAK
    │       │       └── Redis Pub/Sub atau NATS (ultra-simple, ultra-fast)
    │       │           Ref: nestjs → message_brokers_event_streaming/
    │
    └── ⚠️ WAJIB pasang: Transactional Outbox Pattern
        Jangan pernah menulis ke DB lalu publish event secara terpisah.
        Jika DB commit sukses tapi publish gagal (atau sebaliknya), data Anda
        akan INKONSISTEN selamanya. Tulis event ke tabel outbox, lalu relay.
        Ref: golang → distributed_patterns_resilience/
```

---

## BAGIAN 4: API DESIGN — KONTRAK DENGAN DUNIA LUAR

```
NODE 4.1: Siapa KONSUMEN utama API ini?
│
├── A) Frontend Web/Mobile (React, Flutter, Swift)
│   │
│   ├── Butuh fleksibilitas query tinggi (client menentukan field yang diminta)?
│   │   ├── YA ── GraphQL
│   │   │   ├── 🟢 NestJS: Apollo + Code-First (ekosistem terkuat)
│   │   │   │   Ref: nestjs → api_graphql_federation/
│   │   │   ├── 🔵 Go: gqlgen (schema-first, code-gen, type-safe)
│   │   │   ├── 🦀 Rust: async-graphql (macro-based, performant)
│   │   │   └── 🔴 Laravel: Lighthouse PHP
│   │   │
│   │   │   ⚠️ GraphQL BUKAN silver bullet:
│   │   │   - Caching HTTP standar (CDN) tidak bekerja (semua POST ke /graphql)
│   │   │   - N+1 query SANGAT mudah terjadi tanpa DataLoader
│   │   │   - File upload rumit (butuh multipart spec tambahan)
│   │   │   - Jangan pakai GraphQL jika API Anda sederhana (< 20 endpoint)
│   │   │
│   │   └── TIDAK ── REST API (standar, cacheable, tooling melimpah)
│   │
│   └── Butuh real-time updates (chat, live dashboard, notifikasi)?
│       ├── Data stream satu arah (server → client)?
│       │   └── Server-Sent Events (SSE) — lebih sederhana dari WebSocket
│       │       Ref: nestjs → realtime_websocket_sse/
│       └── Data stream dua arah (chat, collaborative editing)?
│           └── WebSocket
│               ├── 🟢 NestJS: @nestjs/websockets Gateway
│               ├── 🔵 Go: gorilla/websocket atau nhooyr/websocket
│               ├── 🦀 Rust: tokio-tungstenite
│               └── 🔴 Laravel: Reverb (first-party sejak Laravel 11)
│               Ref: nestjs → realtime_websocket_sse/ | laravel → realtime_eventing/
│
├── B) Service lain (Microservice internal)
│   └── Lihat NODE 3.2 (Inter-Service Messaging)
│
├── C) Partner / 3rd Party (Public API)
│   │
│   ├── WAJIB: API Versioning dari hari pertama.
│   │   ├── URL Path versioning: /api/v1/users (paling umum, paling mudah)
│   │   ├── Header versioning: Accept: application/vnd.myapi.v1+json
│   │   └── Jangan pernah merilis public API tanpa versioning.
│   │       Ref: nestjs → api_versioning_gateway_routing/
│   │
│   └── WAJIB: Rate Limiting, API Key, Webhook Signature Verification
│       Ref: semua bahasa → domain security masing-masing
│
└── D) CLI / Internal Script
    └── gRPC atau bahkan direct function call. REST overkill untuk internal tooling.
```

---

## BAGIAN 5: AUTHENTICATION & AUTHORIZATION

```
NODE 5.1: Siapa yang mengautentikasi?
│
├── A) End User (Browser / Mobile App)
│   │
│   ├── Apakah ada identity provider eksternal (Google, GitHub, corporate SSO)?
│   │   ├── YA ── OAuth2 + OIDC (OpenID Connect)
│   │   │   ├── 🟢 NestJS: Passport.js + OIDC Strategy
│   │   │   ├── 🔵 Go: coreos/go-oidc + oauth2 stdlib
│   │   │   ├── 🦀 Rust: openidconnect-rs
│   │   │   └── 🔴 Laravel: Socialite (social login) + Passport (full OAuth2 server)
│   │   │   Ref: nestjs → identity_iam_sso_mfa/ | laravel → security/
│   │   │
│   │   └── TIDAK (self-managed authentication)
│   │       │
│   │       ├── Stateless (API untuk mobile / SPA)?
│   │       │   └── JWT (access token short-lived) + Refresh Token (HTTP-only cookie)
│   │       │       ⚠️ JANGAN simpan JWT di localStorage (XSS vulnerable)
│   │       │       ⚠️ JANGAN buat JWT yang expire > 15 menit
│   │       │       Ref: nestjs → security_owasp_zerotrust/
│   │       │
│   │       └── Stateful (Server-rendered, Monolith)?
│   │           └── Session-based auth (cookie + server-side session store di Redis)
│   │               ├── 🔴 Laravel: Sanctum (SPA + API hybrid) — paling mudah
│   │               └── 🟢 NestJS: express-session + connect-redis
│   │
│   └── NODE 5.1.1: AUTHORIZATION — Apa model izinnya?
│       │
│       ├── Sederhana (Admin / User / Guest — 3-5 role tetap)
│       │   └── Role-Based Access Control (RBAC)
│       │       ├── 🔴 Laravel: Spatie Permission (de facto standard)
│       │       ├── 🟢 NestJS: @nestjs/passport + custom RolesGuard
│       │       ├── 🔵 Go: casbin (policy engine)
│       │       └── 🦀 Rust: casbin-rs
│       │
│       ├── Kompleks (izin per-resource, per-tenant, conditional)
│       │   └── Attribute-Based Access Control (ABAC) atau Policy Engine
│       │       ├── 🔵 Go: Open Policy Agent (OPA) + Rego
│       │       ├── 🟢 NestJS: CASL.js (isomorphic authorization)
│       │       └── Casbin (semua bahasa) dengan model ABAC
│       │
│       └── Multi-Tenant (setiap tenant hanya lihat datanya sendiri)
│           └── Row-Level Security (RLS) di Postgres + tenant_id di setiap query
│               Ref: nestjs → multi_tenancy_architecture/
│               Ref: laravel → multitenancy_saas/
│
├── B) Service-to-Service (Microservice internal)
│   │
│   ├── Dalam cluster yang sama (trusted network)?
│   │   └── mTLS (mutual TLS) atau SPIFFE/SPIRE workload identity
│   │       Ref: golang → cybersecurity_zerotrust/
│   │
│   └── Lintas network / internet?
│       └── API Key + HMAC signature + IP allowlist
│
└── C) Machine / IoT Device
    └── Certificate-based auth (X.509) atau Pre-Shared Key
```

---

## BAGIAN 6: OBSERVABILITY — LOGGING, TRACING, METRICS

> **HUKUM BESI:** `console.log()`, `fmt.Println()`, `println!()`, `dd()` di production
> adalah ANTI-PATTERN. Titik. Tanpa pengecualian.

```
NODE 6.1: Logging — Bagaimana aplikasi ini melaporkan kejadian?
│
├── WAJIB (Baseline mutlak untuk SEMUA sistem, SEMUA bahasa):
│   │
│   ├── 1. STRUCTURED JSON LOGGING (bukan string interpolasi)
│   │   ├── 🔵 Go: slog (stdlib Go 1.21+) atau zerolog
│   │   ├── 🦀 Rust: tracing + tracing-subscriber (JSON layer)
│   │   ├── 🟢 NestJS: Pino (zero-allocation, async destination)
│   │   └── 🔴 Laravel: Monolog JSON formatter
│   │   Ref: golang → observability_resilience/ | rust → observability_telemetry_tracing/
│   │   Ref: nestjs → observability_apm_metrics/ | laravel → observability_apm/
│   │
│   │   ✅ BENAR: logger.info("payment_processed", { user_id, amount, currency })
│   │   ❌ SALAH: logger.info(`User ${userId} paid $${amount}`)
│   │   Alasan: Yang pertama bisa di-query di Datadog/ELK sebagai angka.
│   │           Yang kedua hanya string mati yang tidak bisa di-aggregate.
│   │
│   ├── 2. CORRELATION ID (Request ID yang menembus seluruh call chain)
│   │   Setiap HTTP request masuk → generate UUID → lampirkan ke semua log.
│   │   Jika request memanggil 5 service, ke-5 service HARUS punya ID yang sama.
│   │
│   └── 3. SENSITIVE DATA REDACTION
│       JANGAN PERNAH log: password, credit card PAN, API secret, PII.
│       Gunakan skip/redact di logger config.
│
├── NODE 6.1.1: Distributed Tracing — Butuh melacak request lintas service?
│   │
│   ├── Sistem monolith (satu service)?
│   │   └── Correlation ID di log sudah CUKUP. Jangan over-engineer.
│   │
│   └── Microservices (> 1 service)?
│       └── WAJIB: OpenTelemetry (OTLP) + Jaeger/Tempo/Datadog
│           ├── Propagate trace context via HTTP headers (traceparent)
│           ├── Setiap service WAJIB meneruskan context, bukan membuat baru
│           └── ⚠️ Di async runtime (Tokio/Goroutine), context bisa HILANG
│               saat spawn task baru. WAJIB propagate secara eksplisit.
│               Ref: rust → observability_telemetry_tracing/
│               Ref: golang → observability_resilience/
│
└── NODE 6.1.2: Metrics — Butuh dashboard performa (RED metrics)?
    │
    ├── YA ── Prometheus + Grafana
    │   Expose /metrics endpoint. Scrape dengan Prometheus.
    │   Track: Request Rate, Error Rate, Duration (RED).
    │   Ref: nestjs → observability_apm_metrics/
    │
    └── TIDAK (Sistem kecil, belum butuh)
        └── Minimal pasang health check endpoint (/healthz, /readyz)
            untuk load balancer dan container orchestrator.
```

---

## BAGIAN 7: DEPLOYMENT & CONTAINERIZATION

```
NODE 7.1: Bagaimana aplikasi ini akan di-deploy?
│
├── A) CONTAINER (Docker + K8s / ECS / Cloud Run)
│   │
│   ├── ⚠️ WAJIB untuk SEMUA bahasa:
│   │   ├── Multi-stage build (pisahkan build stage dan runtime stage)
│   │   ├── Non-root user (JANGAN jalankan sebagai root di container)
│   │   ├── SIGTERM graceful shutdown handler
│   │   ├── Health check endpoint (/healthz)
│   │   └── Image scanning (Trivy, Snyk) di CI pipeline
│   │
│   ├── Catatan per bahasa:
│   │   ├── 🔵 Go: Binary statis → `FROM scratch` atau `distroless` BISA.
│   │   │   Tapi tetap butuh ca-certificates dan tzdata jika akses HTTPS/timezone.
│   │   │   Ref: golang → devops_control_planes/
│   │   │
│   │   ├── 🦀 Rust: Kompilasi LAMBAT (~5-15 menit tanpa cache).
│   │   │   WAJIB pakai cargo-chef untuk layer caching dependensi.
│   │   │   Target musl untuk static binary, atau distroless untuk glibc.
│   │   │   Ref: rust → docker_container_standards/
│   │   │
│   │   ├── 🟢 NestJS: WAJIB pakai corepack + pnpm untuk cache node_modules.
│   │   │   Jangan COPY seluruh node_modules — salin package.json dulu, install,
│   │   │   baru COPY source code (agar layer cache efektif).
│   │   │   Ref: nestjs → docker_container_standards/
│   │   │
│   │   └── 🔴 Laravel: Gunakan FrankenPHP atau Octane (Swoole/RoadRunner).
│   │       php-fpm tradisional di container = boros resource.
│   │       Ref: laravel → devops_deployment/
│   │
│   └── Apakah butuh orchestration (auto-scaling, rolling deploy, self-healing)?
│       ├── YA, dan tim punya K8s expertise ── Kubernetes
│       ├── YA, tapi tim kecil / tidak mau kelola K8s ── Cloud Run / ECS Fargate
│       └── TIDAK ── Docker Compose di VPS sudah cukup. Jangan over-engineer.
│
├── B) SERVERLESS (AWS Lambda, Cloudflare Workers, Vercel)
│   │
│   ├── ⚠️ Pertimbangkan Cold Start:
│   │   ├── 🦀 Rust + Cargo Lambda: ~10-30ms (sangat cepat)
│   │   ├── 🔵 Go: ~50-100ms (cepat)
│   │   ├── 🟢 NestJS: ~300-800ms (lambat, butuh lazy module loading)
│   │   └── 🔴 Laravel + Vapor: ~200-500ms (medium, butuh Octane)
│   │   Ref: rust → cloud_provider_sdk_serverless/
│   │   Ref: laravel → cloud_provider_aws_vapor/
│   │
│   └── ⚠️ Serverless BUKAN untuk:
│       - WebSocket / long-lived connection
│       - Background job > 15 menit
│       - Sistem yang butuh local filesystem persistent
│
└── C) BARE METAL / VPS (Tradisional)
    └── Gunakan systemd + reverse proxy (Nginx/Caddy).
        Paling sederhana. Cocok untuk MVP dan budget terbatas.
```

---

## BAGIAN 8: SCALING & RESILIENCE — KETIKA SISTEM HARUS TUMBUH

```
NODE 8.1: Di mana BOTTLENECK (titik tersedak) sistem Anda?
│
├── A) DATABASE (Query lambat, connection pool habis, lock contention)
│   │
│   ├── Langkah 1: Sudah pasang index yang tepat? (EXPLAIN ANALYZE!)
│   │   └── 80% masalah performa DB terselesaikan hanya dengan index yang benar.
│   │
│   ├── Langkah 2: Sudah pasang connection pool dengan limit yang wajar?
│   │   Rumus: ((CPU Cores * 2) + Effective Disk Spindles) ≈ max_connections
│   │   ├── 🔵 Go: pgxpool (built-in pool management)
│   │   ├── 🦀 Rust: SQLx PgPool (max_connections + acquire_timeout)
│   │   ├── 🟢 NestJS: Prisma connection pool atau PgBouncer eksternal
│   │   └── 🔴 Laravel: config/database.php pool settings
│   │
│   ├── Langkah 3: Read Replicas (pisahkan traffic baca dan tulis)
│   │   Mayoritas aplikasi 80% READ, 20% WRITE.
│   │   Arahkan SELECT ke replica, INSERT/UPDATE ke primary.
│   │
│   ├── Langkah 4 (Extreme): CQRS — Command Query Responsibility Segregation
│   │   Pisahkan model TULIS (normalized) dan model BACA (denormalized).
│   │   ⚠️ JANGAN pakai CQRS jika langkah 1-3 belum dicoba.
│   │   Ref: nestjs → cqrs_event_sourcing/
│   │
│   └── Langkah 5 (Nuclear): Database Sharding
│       Pecah data berdasarkan tenant_id atau region.
│       ⚠️ Ini adalah keputusan yang TIDAK BISA di-undo dengan mudah.
│       Pastikan Anda benar-benar sudah kehabisan opsi vertikal.
│
├── B) COMPUTE (CPU 100%, proses lambat, event loop blocked)
│   │
│   ├── Apakah ini CPU-bound (kalkulasi, enkripsi, image processing)?
│   │   ├── 🔵 Go: goroutine sudah M:N multiplexed. Go handles this natively.
│   │   ├── 🦀 Rust: tokio::task::spawn_blocking() untuk offload ke thread pool
│   │   ├── 🟢 NestJS: Piscina Worker Threads (WAJIB untuk CPU-bound)
│   │   │   ⚠️ JANGAN blokir Event Loop Node.js. Ini mematikan SEMUA client.
│   │   │   Ref: nestjs → concurrency_runtime_internals/
│   │   └── 🔴 Laravel: Tidak ada parallelism. Delegasi ke Queue Worker.
│   │
│   └── Apakah ini I/O-bound (menunggu DB, API eksternal, disk)?
│       └── Semua bahasa modern sudah async untuk I/O. Pastikan Anda tidak
│           melakukan blocking I/O di async context (common mistake).
│
├── C) NETWORK (API Gateway overwhelmed, connection limit)
│   │
│   ├── Rate Limiting (lindungi dari abuse)
│   │   ├── Token Bucket atau Sliding Window di Redis
│   │   ├── Terapkan per-user, per-IP, dan per-endpoint
│   │   └── Ref: semua bahasa → domain security masing-masing
│   │
│   ├── Load Balancing
│   │   └── Nginx / HAProxy / Cloud LB di depan instance aplikasi
│   │
│   └── Circuit Breaker (lindungi dari cascading failure)
│       Jika dependency (DB, API partner) gagal, JANGAN terus retry.
│       Buka circuit, return fallback, lalu coba lagi setelah cooldown.
│       ├── 🔵 Go: sony/gobreaker
│       ├── 🦀 Rust: Custom atau tower middleware
│       ├── 🟢 NestJS: @nestjs/terminus + custom interceptor
│       └── 🔴 Laravel: Custom middleware
│       Ref: golang → distributed_patterns_resilience/
│
└── D) CONCURRENCY (Race condition, double-submit, inventory oversell)
    │
    ├── Optimistic Locking (version number di DB row)
    │   Cocok jika collision jarang terjadi. Retry on conflict.
    │   Ref: semua bahasa → domain db masing-masing
    │
    ├── Pessimistic Locking (SELECT FOR UPDATE)
    │   Cocok jika collision sering terjadi (flash sale, inventory).
    │   ⚠️ Hati-hati deadlock. Selalu lock resources dalam urutan yang sama.
    │
    ├── Distributed Lock (Redis / etcd)
    │   Cocok jika sistem multi-instance dan butuh mutual exclusion.
    │   ├── 🔵 Go: go-redsync/redsync
    │   ├── 🟢 NestJS: ioredis + Redlock algorithm
    │   └── 🔴 Laravel: Cache::lock() (built-in, Redis-backed)
    │
    └── Idempotency Key
        Setiap request mutasi WAJIB punya unique key (UUID dari client).
        Jika key sudah pernah diproses, return hasil lama. Jangan proses ulang.
        Ini SATU-SATUNYA cara aman menangani double-submit dan webhook retry.
        Ref: golang → distributed_patterns_resilience/ (idempotency_key_engine)
        Ref: laravel → background_jobs_saga/
```

---

## BAGIAN 9: SECURITY POSTURE — PERTAHANAN BERLAPIS

```
NODE 9.1: Level keamanan apa yang dibutuhkan?
│
├── BASELINE (Wajib untuk SEMUA sistem, tanpa pengecualian)
│   │
│   ├── Input Validation: Validasi SEMUA input dari client. Trust nothing.
│   ├── SQL Injection: Gunakan parameterized query. JANGAN string concatenation.
│   ├── XSS: Escape output HTML. Set Content-Security-Policy header.
│   ├── CSRF: Token untuk form submission (atau SameSite cookie).
│   ├── CORS: Whitelist origin. JANGAN Access-Control-Allow-Origin: *
│   ├── Password: Argon2id (pilihan utama) atau bcrypt. JANGAN MD5/SHA.
│   ├── Secrets: .env + validation saat boot. JANGAN hardcode di source code.
│   ├── Dependencies: Audit reguler (npm audit, cargo audit, composer audit).
│   └── HTTPS: Everywhere. No exceptions.
│   Ref: semua bahasa → domain security masing-masing
│
├── ELEVATED (Sistem yang menyimpan data sensitif: PII, finansial, medical)
│   │
│   ├── Semua BASELINE +
│   ├── Encryption at rest (DB encryption, S3 SSE)
│   ├── Audit trail / immutable activity log (siapa mengubah apa, kapan)
│   ├── PII tokenization (simpan token, bukan data asli)
│   ├── Webhook signature verification (HMAC-SHA256)
│   └── Penetration testing reguler
│   Ref: nestjs → security_owasp_zerotrust/
│   Ref: laravel → zero_trust_enterprise_security/
│
└── FORTRESS (Regulasi ketat: PCI-DSS, HIPAA, SOC2, atau fintech)
    │
    ├── Semua ELEVATED +
    ├── mTLS untuk service-to-service communication
    ├── SPIFFE/SPIRE workload identity
    ├── Hardware Security Module (HSM) untuk key management
    ├── SOC2 audit ledger dengan HMAC chain (tamper-evident)
    ├── Zero-trust network: deny-by-default, explicit allow
    └── Compliance-driven logging retention policy
    Ref: golang → cybersecurity_zerotrust/
    Ref: rust → zero_trust_enterprise_security/
```

---

## BAGIAN 10: TESTING STRATEGY — PIRAMIDA PENGUJIAN

```
NODE 10.1: Bagaimana strategi pengujian yang tepat?
│
├── SEMUA SISTEM WAJIB (Non-negotiable):
│   │
│   ├── Unit Tests: Fungsi bisnis inti (kalkulasi harga, validasi, authorization)
│   │   Target: > 80% coverage untuk business logic layer.
│   │   JANGAN test getter/setter atau framework internals.
│   │
│   ├── Integration Tests: API endpoint → DB → response
│   │   Gunakan real database (Testcontainers) bukan mock DB.
│   │   ├── 🔵 Go: testcontainers-go + httptest
│   │   ├── 🦀 Rust: sqlx::test (auto-rollback per test) + tower::ServiceExt
│   │   ├── 🟢 NestJS: @nestjs/testing + Fastify inject + Testcontainers
│   │   └── 🔴 Laravel: RefreshDatabase trait + Pest
│   │   Ref: semua bahasa → domain testing masing-masing
│   │
│   └── Linter / Static Analysis: Jalankan di CI, block merge jika gagal.
│       ├── 🔵 Go: golangci-lint (wajib)
│       ├── 🦀 Rust: clippy + cargo fmt (wajib)
│       ├── 🟢 NestJS: eslint + tsc --noEmit (wajib)
│       └── 🔴 Laravel: PHPStan level 8+ + Pint (wajib)
│
├── SESUAI KEBUTUHAN:
│   │
│   ├── Contract Tests (Microservices yang saling berkomunikasi)
│   │   Pastikan perubahan schema di Service A tidak memecahkan Service B.
│   │   Tool: Pact (language-agnostic)
│   │   Ref: nestjs → testing_quality_qa/
│   │
│   ├── Property-Based Tests (Algoritma kompleks, parser, serializer)
│   │   Generate input acak, validasi invariant (hukum yang harus selalu benar).
│   │   ├── 🔵 Go: rapid
│   │   ├── 🦀 Rust: proptest
│   │   └── 🟢 NestJS: fast-check
│   │   Ref: rust → testing_fuzzing_benchmarking/ | golang → testing_quality/
│   │
│   ├── Load / Stress Tests (Sistem yang punya SLA performa)
│   │   Tool: k6, vegeta (Go), wrk, locust
│   │   Jalankan SEBELUM rilis, bukan setelah production mati.
│   │
│   └── Chaos Tests (Sistem distributed yang butuh high availability)
│       Sengaja matikan service, inject latency, corrupt network.
│       Tool: Chaos Monkey, LitmusChaos, toxiproxy
│       Ref: nestjs → chaos_engineering_resilience/
│
└── ⚠️ ANTI-PATTERN:
    - Mocking SEMUA dependency → test lulus tapi production meledak.
    - Test yang bergantung pada urutan eksekusi → flaky test nightmare.
    - Test tanpa assertion → test "hijau" tapi tidak menguji apa-apa.
```

---

## EPILOG: CARA MENGGUNAKAN DOKUMEN INI

1. **Greenfield:** Mulai dari BAGIAN 0 → BAGIAN 1 (pilih bahasa) → telusuri BAGIAN 2-10 sesuai kebutuhan.
2. **Brownfield:** Mulai dari BAGIAN 0 → lewati BAGIAN 1 → langsung ke BAGIAN yang relevan dengan fitur baru.
3. **Audit Arsitektur:** Baca BAGIAN 6 (Observability), 9 (Security), 10 (Testing) untuk mengecek apakah sistem eksisting sudah memenuhi baseline.

> **Ingat:** Pohon ini adalah KOMPAS, bukan PETA. Ia memberi arah, bukan langkah-langkah kode spesifik. Setelah Anda menemukan arah yang tepat dari pohon ini, baru buka referensi domain spesifik di `SKILL.md` masing-masing bahasa untuk mendapatkan kode dan arsitektur detail.

## 🔗 Posisi dalam Rantai Kerja

Pohon ini adalah **tahap 2** dari enam. Keputusan yang Anda ambil di sini menjadi masukan untuk dokumen RFC, bukan izin untuk mulai menulis kode.

| # | Tahap | Dokumen |
| :-: | :--- | :--- |
| 1 | Routing task | `AGENTS.md` §2 |
| 2 | **Pilih stack & arsitektur** | **`master-decision-tree/SKILL.md` — Anda di sini** |
| 3 | Tulis `docs/rfc/YYYYMMDD-<fitur>.md` + katalog | `templates/SKILL.md` bagian 1–2 |
| 4 | **BERHENTI — tunggu user mengetik "Gasskan"** | `AGENTS.md` §0.5 · **GERBANG MUTLAK** |
| 5 | Branch, atomic commit, merge | `git-workflow/SKILL.md` bagian 1–5 |
| 6 | Patch Receipt + centang Kanban di RFC | `templates/SKILL.md` bagian 6 |

> Nomor **§** selalu merujuk `AGENTS.md`. Untuk seksi milik skill lain dipakai kata "bagian".

**Empat rute §2 `AGENTS.md` MENGGUGURKAN tahap 3–4. DILARANG memaksakan RFC di sana:**

| Rute §2 | Yang berlaku |
| :--- | :--- |
| Proyek baru **kecil** (4 syarat §2) | RFC & Day-0 Quintet DILARANG dipaksakan → langsung tahap 5 |
| Edit **≤3 berkas**, bugfix, refactor minor, investigasi | DILARANG bikin RFC → langsung tahap 5. Bugfix tetap WAJIB Proof-of-Defect (§0.6) |
| **In-Flight Fix** — >3 berkas tapi berasal dari RFC yang SUDAH disetujui | **DILARANG buat RFC kedua.** Catat perubahannya di seksi task RFC yang sedang aktif |
| **Emergency Pause** — blocker arsitektural kritis di tengah eksekusi | BERHENTI. Susun `docs/rca/YYYYMMDD-<insiden>.md` (`templates/SKILL.md` bagian 3), lapor ke user, jangan putuskan sepihak |

---

## LANGKAH WAJIB BERIKUTNYA SETELAH KEPUTUSAN ARSITEKTUR

**DILARANG melompat dari pohon ini langsung ke `git checkout -b`.** Urutannya:

1. **Tuangkan keputusan ke dokumen RFC.** Buka `~/.gemini/config/skills/templates/SKILL.md` bagian 1 dan isi kerangkanya. Opsi arsitektur yang Anda temukan di pohon ini masuk ke **bab 2 dokumen RFC — "Eksplorasi Arsitektur & Trade-off Matrix"** — WAJIB ≥3 opsi netral, tanpa label "(Recommended)" sepihak. Perbarui juga katalog `docs/rfc/README.md` (kerangkanya di `templates` bagian 2).

2. **BERHENTI. Tunggu "Gasskan".** Ini Gerbang Mutlak §0.5 `AGENTS.md`, bukan formalitas. Membuat branch dan menulis kode sebelum kata itu diucapkan adalah pelanggaran, sekalipun keputusan arsitekturnya sudah benar.
   *Pengecualian:* jalur **proyek kecil** (§2 `AGENTS.md`) dan **edit ≤3 berkas** memang menggugurkan RFC — di situ lanjut langsung ke langkah 3.

3. **Baru buka skill `git-workflow`** (`~/.gemini/config/skills/git-workflow/SKILL.md`):
   - Greenfield → protokol §3 (mulai Langkah 0: buat `.gitignore` **sebelum berkas apa pun**)
   - Brownfield → protokol §4 (mulai `git pull --rebase`)

4. **Buat branch kerja** sesuai Git Flow §1 — namanya WAJIB sama dengan field **Target Branch** di dokumen RFC:
   ```
   git checkout -b feature/<nama-fitur>   # untuk fitur baru
   git checkout -b fix/<nama-bug>         # untuk perbaikan bug
   git checkout -b refactor/<nama-scope>  # untuk refactoring
   ```

   DILARANG menulis kode di `main` atau `develop` secara langsung.
