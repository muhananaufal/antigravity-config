# 📜 MAHA-RENCANA ESKALASI CLAUDE OPUS 20X MAX THINKING
### Master Blueprint & Roadmap Standardisasi Domain Niche (Golang, Rust, Laravel, NestJS)
**Dokumen Rujukan Masa Depan (SSOT Escalation Blueprint)**

---

## 1. PENDAHULUAN & FILOSOFI ESKALASI

Dokumen ini adalah **panduan rencana induk (Master Execution Plan)** untuk meningkatkan seluruh domain *niche* yang belum ditingkatkan di masa depan menggunakan **Claude Opus 20x Max Thinking**. 

Tujuan eskalasi ini adalah mengubah seluruh berkas referensi di repositori `~/.gemini/config/skills/` menjadi **Living Enterprise Knowledge Brain (Top 0.01% Standard)** yang setara dengan Core Domain Golang yang telah selesai disempurnakan.

---

## 2. STANDAR ANATOMI 5-LAPISAN WAJIB (THE 5-LAYER ANATOMY)

Setiap berkas `.md` yang dieskalasi di masa depan **WAJIB MENGIKUTI STRUKTUR 5 LAPISAN INI TANPA TERKECUALI**:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Layer 1: Landasan Filosofis, Mekanika Kernel & Hukum Dasar (The "Why")   │
│   - Mengapa pendekatan naif industri gagal pada beban ekstrem           │
│   - Landasan matematis, CPU cache-line, memory fences, OS syscalls      │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 2: Arsitektur Produksi Top 1% (The "How")                         │
│   - Kode 100% Bahasa Inggris (Identifier, Logs, Error Strings, DTO)     │
│   - Zero-allocation, type-safe, strict interface segregation, fail-fast │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 3: Matriks Kegagalan & Edge-Case Ekstrem                          │
│   - Anomali terdistribusi (Split-Brain, Clock Skew, Ghost Writes)       │
│   - Race condition, GC pauses, memory leaks, serialization poisons      │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 4: Pengujian Mutu Tertinggi (High-Assurance Testing)              │
│   - Property-Based Testing (Invariants, Monotonicity, Conservation)     │
│   - Deterministic concurrency, Testcontainers nyata, statistical bench  │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 5: Anti-Patterns & Matriks "Kapan DILARANG Menggunakan"           │
│   - Analisis trade-off jujur (≥3 kelebihan DAN ≥3 kekurangan)           │
│   - Batas skalabilitas dan skenario larangan penggunaan                 │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. ATURAN KEBERSIHAN KODE MUTLAK (ZERO-TOLERANCE RULES)

1. **Kode 100% Bahasa Inggris Murni:**
   - Seluruh identifier (`struct`, `type`, `func`, `interface`, `class`, `variable`, `constant`).
   - Seluruh string literal di dalam kode: pesan error (`fmt.Errorf`, `errors.New`), pesan log (`slog`, `zerolog`, `tracing`), SQL queries, Protobuf tags, dan JSON keys WAJIB berbahasa Inggris standar industri.
   - *Bahasa Indonesia HANYA digunakan pada narasi penjelasan Markdown di luar blok kode dan komentar kode (`// ...`).*
2. **Zero Untyped Bypass:**
   - Go: Nol `any` / raw `interface{}` tanpa penanganan type assertion yang aman.
   - Rust: Nol unchecked `unwrap()` / unchecked raw pointers.
   - TypeScript (NestJS): Nol `any`, nol `@ts-ignore`.
   - PHP (Laravel): Strict types `declare(strict_types=1);` pada setiap file.
3. **Zero Hardcoded Secrets & Zero Placeholders:**
   - Tidak boleh ada `// TODO`, `// implement later`, atau string rahasia statis.

---

## 4. INVENTARISASI DOMAIN & RENCANA ESKALASI LINTAS MASTERY

---

### A. GOLANG MASTERY (`~/.gemini/config/skills/golang-mastery/references/`)
*(Status Core: **100% Complete & Sanitized**. Status Niche: **Menunggu Eskalasi Masa Depan**)*

| No | Domain Niche | Direktori | Fokus Materi & Edge-Cases Kritis untuk Eskalasi Opus 20x |
| :---: | :--- | :--- | :--- |
| 1 | **HFT & Zero-Alloc** | `hft_zero_alloc/` | Lock-free SPSC/MPMC Ring Buffers, CPU cache-line padding (64B `_ [64]byte`), CPU affinity pinning, zero-alloc serialization, custom arena allocators. |
| 2 | **Linux Systems** | `system_programming_linux/` | Direct syscalls via `x/sys/unix`, epoll event loops, `io_uring` ring buffer, cgroups v2 resource controller, Linux namespace virtualization. |
| 3 | **AI & Data Infra** | `ai_data_infra/` | pgvector cosine indexing, SIMD vector quantization, chunking streaming pipelines, LLM token streaming backpressure, in-memory embedding cache. |
| 4 | **Distributed Consensus** | `distributed_consensus_storage/` | Raft consensus state machine, log compaction & snapshotting, split-brain quorum prevention, linearizable reads, WAL crash-recovery. |
| 5 | **Realtime Networking** | `realtime_networking/` | Epoll WebSocket gateways (1M+ concurrent TCP), Gorilla vs `gobwas/ws` zero-copy, heartbeat pings with monotonic clock, broadcast rings. |
| 6 | **Advanced Networking** | `advanced_networking_protocols/` | QUIC / HTTP/3 via `quic-go`, UDP connectionless framing, raw packet filtering, TLS 1.3 session resumption, custom TCP wire framing. |
| 7 | **Fintech Reliability** | `fintech_reliability/` | Double-entry bookkeeping ledgers (DEB), Two-Phase Commit (2PC), strict balance constraints (`CHECK (balance >= 0)`), precision integer cents. |
| 8 | **K8s Cloud Native** | `cloud_native_k8s_operators/` | Kubebuilder reconciliation loops, Controller-Runtime cache watches, CRD schema validation, finalizers lifecycle, dynamic admission webhooks. |
| 9 | **Cloud Provider SDK** | `cloud_provider_sdk/` | AWS SDK v2 connection pooling, S3 multipart chunk upload with retry resume, DynamoDB single-table design, GCP Pub/Sub pull streaming. |
| 10 | **Background Jobs** | `background_jobs_worker/` | Asynq Redis-backed distributed queues, priority queues, dynamic rate limiters, cron jittering, exponential backoff with dead-letter queue. |
| 11 | **AST Metaprogramming** | `ast_metaprogramming/` | `go/ast` parser, `go/types` type checking, custom code generators, compile-time AST linters, automated architecture boundary checkers. |
| 12 | **Runtime Internals** | `runtime_internals/` | Go GMP scheduler internals (Goroutine, M-thread, P-processor), GC tri-color mark-and-sweep, write barriers, stack growth mechanism ($2\text{KB} \rightarrow 1\text{GB}$). |
| 13 | **Cybersecurity ZeroTrust** | `cybersecurity_zerotrust/` | SPIFFE/SPIRE workload identities, mTLS dynamic SAN validation, AppArmor profiles, seccomp BPF syscall filtering, rootless containers. |
| 14 | **Embedded & TinyGo** | `embedded_tinygo/` | Microcontroller bare-metal programming, I2C/SPI bus communication, memory-constrained heapless runtime, interrupt handlers (ISR). |
| 15 | **Media & Asset** | `media_asset_pipeline/` | FFmpeg Go bindings, streaming video HLS/DASH chunking, image transcoding with Libvips zero-copy, S3 streaming uploads. |
| 16 | **Game Backend** | `game_backend/` | Spatial grid partitioning, UDP state synchronization, client-side prediction reconciliation, entity-component-system (ECS) in Go. |
| 17 | **CI/CD Pipeline** | `ci_cd_pipeline/` | GitHub Actions multi-arch builds, cross-compilation matrix, caching strategies, automated SBOM generation (`syft`), container signing (`cosign`). |
| 18 | **CLI Tooling** | `cli_tooling/` | Cobra/Viper modular CLI, bubbletea TUI terminal engines, terminal raw mode, signal interrupt handlers, shell auto-completion generators. |
| 19 | **i18n Localization** | `i18n_localization/` | CLDR pluralization rules, ICU message formatting, fast locale resolution, translation catalogue caching, zero-alloc formatting. |
| 20 | **Engineering Practice** | `engineering_practice/` | Trunk-based development, semantic release automation, feature flagging with OpenFeature, post-mortem incident RCA frameworks. |

---

### B. RUST MASTERY (`~/.gemini/config/skills/rust-mastery/references/`)
*(Total: **32 Domain Directories** Menunggu Eskalasi)*

| No | Domain Group | Direktori | Target Desain & Standar Industri yang Wajib Diterapkan |
| :---: | :--- | :--- | :--- |
| 1 | **Core Memory & Ownership** | `core_memory_ownership/` | Borrow checker zero-cost abstraction, Lifetimes (`'a`, `'static`, subtyping, covariance/contravariance), Smart pointers (`Rc`, `Arc`, `Box`, `Pin`). |
| 2 | **Lock-Free & Atomics** | `lockfree_atomic_structures/` | Hardware memory orderings (`Relaxed`, `Acquire`, `Release`, `SeqCst`), Treiber Stack, Michael-Scott Queue, Crossbeam epoch-based memory reclamation. |
| 3 | **Async Tokio Runtime** | `async_tokio_concurrency/`, `async_executor_internals/` | Tokio multi-thread scheduler work-stealing, cooperative scheduling (`tokio::task::yield_now`), Pin projection, custom async Waker engines. |
| 4 | **Type System & Generics** | `type_system_traits/` | Trait objects (`dyn Trait` vs static dispatch), Associated Types, Const Generics, PhantomData markers, HRTB (Higher-Rank Trait Bounds `for<'a>`). |
| 5 | **Unsafe & FFI Internals** | `unsafe_ffi_internals/`, `custom_allocators_internals/` | Strict provenance, Unaligned memory accesses, Miri undefined behavior verification, C FFI boundaries, Custom GlobalAlloc arenas. |
| 6 | **High-Performance HFT** | `high_performance_hft/` | L1/L2 cache prefetching, SIMD vectorization (`std::simd`), branch prediction hints (`cold`, `likely`), core pinning via `core_affinity`. |
| 7 | **Web & Microservices** | `web_microservices/`, `networking_protocols_grpc/` | Axum tower middleware, Tonic gRPC streaming, zero-copy deserialization via `rkyv`/`serde`, Keyset pagination. |
| 8 | **Zero-Trust Security & Crypto** | `cybersecurity_cryptography/`, `zero_trust_enterprise_security/` | Ring/Rustls cryptography, Constant-time comparisons (`subtle`), Zeroize sensitive memory wipes, memory-safe TLS 1.3 stacks. |
| 9 | **Compiler & LLVM** | `compiler_llvm_internals/`, `advanced_procmacro_engineering/` | LLVM optimization passes, inline assembly (`asm!`), Procedural Derive Macros with `syn` & `quote`, AST token manipulation. |
| 10 | **Tauri, Bevy & WASM** | `gui_desktop_tauri/`, `game_engine_bevy/`, `wasm_systems/` | Tauri IPC security models, Bevy ECS parallel query scheduling, WASM/WASI runtime sandboxing via Wasmtime. |
| 11 | **Distributed & Storage** | `distributed_consensus_storage/`, `data_engineering_polars/` | Raft in Rust (`async-raft`), LSM-Tree persistent storage engines, Arrow/Polars zero-copy columnar memory analytics. |

---

### C. LARAVEL MASTERY (`~/.gemini/config/skills/laravel-mastery/references/`)
*(Total: **27 Domain Directories** Menunggu Eskalasi)*

| No | Domain Group | Direktori | Target Desain & Standar Industri yang Wajib Diterapkan |
| :---: | :--- | :--- | :--- |
| 1 | **Clean Architecture & Domain** | `arch/`, `api/` | Hexagonal Ports & Adapters in PHP 8.3+, Typed Data Transfer Objects (DTO), Domain Action classes, API Resources with conditional relations. |
| 2 | **Database & Eloquent Internals** | `db/`, `spatial_timeseries_db/` | Eloquent lazy-loading N+1 prevention (`Model::preventLazyLoading()`), Composite index design, Custom Eloquent Builders, PostGIS & Timescale. |
| 3 | **Distributed Queues & Saga** | `background_jobs_saga/` | Horizon Redis worker topologies, Idempotent Job handling, Distributed Saga orchestration for multi-step checkout, Job batching & chaining. |
| 4 | **High-Concurrency Engine** | `concurrency/`, `php_runtime_internals/` | Laravel Octane (FrankenPHP / Swoole) memory leak prevention, State resetters, OPcache JIT compilation tuning, Fibers concurrency. |
| 5 | **Fintech & E-Commerce** | `fintech_ecommerce/` | Cashier payment gateway webhooks with cryptographic validation, Double-entry transaction ledgers, Database pessimistic row-locking on checkout. |
| 6 | **Zero-Trust Security & IAM** | `security/`, `zero_trust_enterprise_security/` | Sanctum / Passport token lifecycle, Casbin / Policy authorization, Rate limiting with sliding window, Content Security Policy headers. |
| 7 | **Multi-Tenancy SaaS** | `multitenancy_saas/` | Database-per-tenant vs Single-DB RLS, Dynamic tenant connection switching, Storage path isolation, Tenant cache prefixing. |
| 8 | **Automated Testing Excellence** | `testing_automated/`, `code_quality_governance/` | Pest PHP architecture tests (`arch()`), Database transactions vs RefreshDatabase, Mocking boundaries, Mutation testing with Infection. |

---

### D. NESTJS MASTERY (`~/.gemini/config/skills/nestjs-mastery/references/`)
*(Total: **37 Domain Directories** Menunggu Eskalasi)*

| No | Domain Group | Direktori | Target Desain & Standar Industri yang Wajib Diterapkan |
| :---: | :--- | :--- | :--- |
| 1 | **Enterprise IoC & Architecture**| `core_arch_patterns/`, `cqrs_event_sourcing/` | Hexagonal Clean Architecture, Custom Dynamic Modules, IoC Scope lifecycle (Singleton vs Request-Scoped memory leak traps), CQRS bus. |
| 2 | **HTTP Engine & Fastify** | `http_engine_fastify/`, `validation_serialization/` | Fastify adapter engine, Schema-based JSON serialization via `fast-json-stringify`, `class-validator` fail-fast pipelines with DTO stripping. |
| 3 | **ORM & Persistence Layer** | `db_persistence_orm/` | Prisma & Drizzle ORM performance tuning, Connection pool bounds, Multi-tenant Row-Level Security, Database transaction isolation. |
| 4 | **Microservices & Federation** | `microservices_grpc/`, `api_graphql_federation/` | NestJS gRPC microservices, Apollo GraphQL Federation v2 Subgraphs, NATS/Kafka event streaming with consumer group rebalancing. |
| 5 | **Distributed Workflows** | `workflow_orchestration_temporal/`, `background_jobs_queues/` | BullMQ Redis distributed workers, Temporal.io TypeScript deterministic workflows, Idempotent event consumers. |
| 6 | **Zero-Trust Security & Identity** | `security_owasp_zerotrust/`, `identity_iam_sso_mfa/` | Passport JWT RS256 strategies, Keycloak / Auth0 OIDC PKCE flows, Casbin RBAC/ABAC guards, CSP & Helmet security middleware. |
| 7 | **Observability & SRE** | `observability_apm_metrics/`, `structured_logging_telemetry/` | OpenTelemetry NodeSDK tracing, Prometheus `@willsoto/nestjs-prometheus` RED metrics, Pino zero-allocation structured JSON logging. |
| 8 | **Testing Quality & Chaos** | `testing_quality_qa/`, `chaos_engineering_resilience/` | Jest / Vitest integration testing with Testcontainers, E2E Supertest harness, Fault injection with Chaos engineering. |

---

## 5. PROTOKOL EKSEKUSI ESKALASI SURGICAL DI MASA DEPAN

Ketika user memutuskan untuk mengeksekusi peningkatan pada domain-domain di atas, **DILARANG KERAS** melakukan "Blanket Rewrite" (menulis ulang dari nol yang berisiko menghapus kedalaman arsitektur asli). Ikuti **Protokol 4 Langkah Surgical Baku**:

```
[ Langkah 1: Full Context Loading ]
  - Pindai dan muat *seluruh* isi file asli (yang biasanya berukuran 15KB-30KB) ke dalam memori agen.
  - Dilarang keras merangkum atau memotong penjelasan teoritis yang sudah ada.

[ Langkah 2: Opus 20x Gap Analysis ]
  - Analisis bagian mana dari 5-Layer Anatomy yang masih kurang (biasanya Edge-Case Matrix atau High-Assurance Testing).
  - Identifikasi string/log/error dalam blok kode yang masih berbahasa Indonesia.

[ Langkah 3: Surgical Injection & Sanitization ]
  - Suntikkan materi tambahan (Math models, failure matrix) ke bagian yang relevan TANPA menghapus teks asli.
  - Ubah blok kode menjadi 100% Bahasa Inggris murni.
  
[ Langkah 4: Verification & Anti-Truncation Gate ]
  - Pastikan ukuran file hasil (output) HARUS SAMA BESAR ATAU LEBIH BESAR dari file asli. Jika menyusut, batalkan!
  - Pastikan lolos quality gate (nol TODO, nol credential hardcode).
```

---

## 6. TEMPLATE PROMPT UNTUK SUBAGENT / CLAUDE CODE DI MASA DEPAN

Gunakan format prompt berikut saat memicu proses eskalasi per domain:

```markdown
Kamu adalah Principal Systems Architect & Performance Engineer (Top 1% Global Standard).
Tugasmu adalah melakukan "Surgical Enhancement" pada berkas referensi di domain: `<DOMAIN_PATH>`.

🚨 ATURAN MUTLAK (ANTI-TRUNCATION):
File asli memiliki kedalaman teknis yang luar biasa (berkisar 15KB-30KB). KAMU DILARANG MERINGKAS, MEMOTONG, ATAU MENULIS ULANG DARI NOL! Tugasmu adalah MEMPERTAHANKAN 100% narasi asli, lalu MENAMBAHKAN kedalaman dan MENSANITASI kodenya. Hasil akhirmu HARUS lebih panjang dan padat dari aslinya.

PERSYARATAN WAJIB (OPUS 20X MAX THINKING BLUEPRINT):
1. Lengkapi Struktur 5-Lapisan (jika ada yang kurang pada file asli):
   - Layer 1: Fundamental Law & Mechanical Sympathy (Kernel/Memory/Math)
   - Layer 2: Top 1% Production Architecture
   - Layer 3: Failure & Edge-Case Anomaly Matrix
   - Layer 4: High-Assurance Testing (Property-Based, Deterministic, Zero-Alloc)
   - Layer 5: Anti-Patterns & "When NOT to Use" Matrix (≥3 Pros, ≥3 Cons)
2. Aturan Bahasa:
   - SELURUH blok kode (Identifier, Struct, Error String, Log String, Queries) WAJIB 100% Bahasa Inggris murni.
   - Narasi penjelasan Markdown dan komentar kode menggunakan Bahasa Indonesia teknis mendalam.
3. Standar Kualitas:
   - Nol `// TODO`, nol placeholder, nol untyped bypasses.

Gunakan tool `multi_replace_file_content` untuk mengubah blok kode secara presisi tanpa merusak markdown di sekitarnya. Jika menggunakan `write_to_file`, pastikan seluruh teks asli disertakan! Laporkan selesai setelah diverifikasi. Gasskan!
```

---
*Dokumen ini bersifat definitif dan siap dipanggil kapan pun proses eskalasi domain niche dimulai.*
