---
name: mastery-rust
description: Gunakan skill ini ketika merancang arsitektur, Borrow Checker memory safety, Tokio async, Traits & Generics, Unsafe Rust & FFI, Axum microservices, HFT zero-cost abstractions, WebAssembly/eBPF, Tauri/Bevy/Blockchain, LLVM internals, Lock-free structures, atau Custom Allocators di Rust.
---

# Rust Mastery (L8 Neutral Encyclopedia)

SSOT arsitektur & rekayasa sistem Rust enterprise, systems programming, dan ultra-low latency (34 Domain, 195 File Mahakarya). Dokumen ini BUKAN sekadar tutorial SWE; ini adalah **Fakta Objektif Netral** yang memfasilitasi 5 POV Principal Roles (Architect, SWE, QA, DevOps, DBA).

## 👓 Matriks Lensa Principal (Multi-POV)

Gunakan *lensa* spesifik saat membaca file referensi di direktori ini, sesuai dengan peran Anda saat ini:

| Role Aktif | Lensa Fokus Utama di Ekosistem Rust |
| :--- | :--- |
| **Architect** | Desain *Trait* & *Generics*, abstraksi lapisan batas (*Traits* sebagai kontrak), gRPC/Tonic *Microservices*, dan topologi *Message Broker*. |
| **SWE** | *Borrow Checker* / Lifetimes, pencegahan blokade *Event Loop* (Tokio `spawn_blocking`), *Cancel-Safety* dalam `select!`, dan pemutusan siklus `Arc`/`Rc` dengan `Weak`. |
| **DevOps** | *Cargo release profiles*, *musl static builds*, *distroless* container dengan `cargo-chef`, `RUST_LOG` OpenTelemetry, dan *Graceful Shutdown*. |
| **DBA** | Optimasi koneksi `sqlx::PgPool`, makro *compile-time queries*, *Prepared Statements*, dan pencegahan *connection starvation*. |
| **QA (Red Team)** | Pengujian *Undefined Behavior* di blok `unsafe` menggunakan `Miri`, eksekusi *Fuzzing* (`cargo fuzz`), dan pendeteksian *deadlock* pada `tokio::sync::Mutex`. |

## 🏛️ Pilar Arsitektur Mutlak

| Pilar | Hukumnya |
| :--- | :--- |
| **Propagasi Error Eksplisit** | `thiserror` di pustaka, `anyhow` di biner. Penggunaan `unwrap()` di jalur produksi tunduk pada larangan Gerbang Mutlak `AGENTS.md` §0.4 (di dalam test, `unwrap()` idiomatik). |
| **Async Tidak Boleh Diblokir** | `Mutex` guard DILARANG hidup melintasi `.await`. Komputasi berat dan blocking I/O WAJIB `spawn_blocking` — kalau tidak, satu worker thread runtime membeku bersama semua task di atasnya. |
| **Cancel-Safety Disengaja** | Setiap cabang `tokio::select!` diperiksa: cabang yang kalah dibatalkan **di tengah jalan**. Future yang tidak cancel-safe kehilangan data yang sudah ditarik dari socket. |
| **Kepemilikan Bukan Kebetulan** | Siklus `Arc<T>` diputus `Weak<T>`. Memori bisa bocor tanpa satu baris `unsafe` pun — borrow checker tidak menjaga Anda dari siklus. |
| **`unsafe` Terkurung & Terbukti** | Setiap blok `unsafe` dibungkus antarmuka aman, diberi komentar invariant-nya, dan diverifikasi `cargo miri test`. Tanpa Miri, itu harapan, bukan jaminan. |

## 🚦 Protokol Eksekusi

Patuhi mutlak **Tabel Routing Task di `AGENTS.md` §2** untuk menentukan kapan harus membaca `references/_protocol/greenfield.md`, `brownfield.md`, atau `tradeoff.md`.
> **Pengecualian Mutlak:** Jika ini adalah proyek baru atau keputusan arsitektur besar, WAJIB lewati meta-decision (`~/.gemini/config/skills/meta-decision/SKILL.md`) terlebih dahulu sesuai `role-architect/SKILL.md` §1.5.

## 📦 Core References (WAJIB Baca Setiap Project Rust)

Domain fondasi yang hampir selalu relevan, apa pun bentuk tasknya:

| Domain | Referensi | Cakupan |
| :--- | :--- | :--- |
| **Memory & Ownership** | `references/core_memory_ownership/` | Borrow checker, lifetime, `Arc`/`Rc`/`Weak`, interior mutability, pemutus siklus |
| **Type System & Traits** | `references/type_system_traits/` | Generics, trait object vs static dispatch, GAT, blanket impl, newtype |
| **Error Handling** | `references/error_handling_resilience/` | `thiserror`/`anyhow`, error boundary, retry & backoff, graceful degradation |
| **Testing & Fuzzing** | `references/testing_fuzzing_benchmarking/` | Unit/integration, `proptest`, `cargo fuzz`, `criterion` benchmark |
| **Docker & Container** | `references/docker_container_standards/` | Multi-stage, distroless, non-root, SIGTERM, `modular_3tier_container_topology.md` |

## 🎯 Context References (Baca Sesuai Kebutuhan)

| Konteks / Keyword | Baca Referensi |
| :--- | :--- |
| `async`/`await`, Tokio runtime, `select!`, cancellation safety, `spawn_blocking` | `references/async_tokio_concurrency/` |
| Axum/Actix handler, middleware, extractor, REST API, state sharing | `references/web_microservices/` |
| API Versioning, utoipa OpenAPI spec, Swagger UI, route namespacing (`/api/v1`) | `references/api_versioning_openapi/` |
| Database Postgres, SQLx compile-time queries, connection pool, SeaORM | `references/db_persistence_sqlx/` |
| Tracing, OpenTelemetry, OTLP, Datadog, Prometheus, structured JSON logs | `references/observability_telemetry_tracing/` |
| Apalis background queue workers, Transactional Outbox pattern, Distributed Saga compensating rollback, DLQ | `references/background_jobs_saga/` |
| gRPC/tonic, protobuf, QUIC, WebSocket, protokol biner kustom | `references/networking_protocols_grpc/` |
| Latensi mikrodetik, zero-alloc, SIMD, cache line, order book, HFT | `references/high_performance_hft/` |
| Raft, etcd, LSM tree, WAL, sled/RocksDB, replikasi & konsensus | `references/distributed_consensus_storage/` |
| Kriptografi, hashing password, TLS/mTLS, signing, secret management | `references/cybersecurity_cryptography/` |
| Blok `unsafe`, FFI/C ABI, pointer provenance, `transmute`, Miri | `references/unsafe_ffi_internals/` |

## 🔍 Auto-Detect Niche Domain (Scan dari Task)

Agent WAJIB mencocokkan nature of task ke domain berikut **secara proaktif**:

| Jika task melibatkan... | Otomatis baca domain Niche |
| :--- | :--- |
| WebAssembly (WASM), WASI serverless, eBPF XDP/TC, JS interop (`wasm-bindgen`) | `references/wasm_systems/` |
| Blockchain, smart contracts, Solana Anchor, Substrate pallets, EVM simulators, Merkle trie | `references/blockchain_smart_contracts/` |
| Game server/client, Bevy ECS App/World/System, Tick-loops, real-time physics simulation | `references/game_engine_bevy/` |
| GUI Desktop, Tauri v2 IPC, egui immediate mode, wgpu cross-platform GPU, Mobile (iOS/Android) | `references/gui_desktop_tauri/` |
| Compiler design, LLVM IR via Inkwell, AST transformations, LTO optimization, struct alignment | `references/compiler_llvm_internals/` |
| Custom memory allocators, bump allocation, slab pools, `GlobalAlloc` implementations, arena tracing | `references/custom_allocators_internals/` |
| Lock-free atomic structures, epoch-based memory reclamation (Crossbeam), MPMC wait-free queues | `references/lockfree_atomic_structures/` |
| Big Data Analytics, Polars DataFrames, Apache Arrow IPC, DuckDB FFI, Parquet reader, Vector HNSW | `references/data_engineering_polars/` |
| CLI / TUI tooling, Clap derive, Ratatui dashboards, Crossterm event loops, structured progress bars | `references/cli_tooling_clap/` |
| Custom async executors, raw Wakers, epoll mio reactors, Chase-Lev work stealing deques, io_uring | `references/async_executor_internals/` |
| Advanced procedural macros, custom Derive / Attribute macros, AST manipulation via `syn` & `quote` | `references/advanced_procmacro_engineering/` |
| Kubernetes CRDs, kube-rs reconcilers, Admission Webhook validators, Helm Deployment RBAC | `references/cloud_native_k8s_operators/` |
| AWS SDK for Rust (`aws-sdk-s3`/`sqs`/`sns`/`secretsmanager`), Cargo Lambda serverless <10ms cold start | `references/cloud_provider_sdk_serverless/` |
| moka L1 RAM cache, fred/redis Valkey cluster, Singleflight stampede locks, ETag CDN edge headers | `references/caching_strategy_cdn/` |
| Governor GCRA API rate limiting, casbin RBAC/ABAC policy, OIDC JWT token vaults, SOC2 HMAC audit ledger | `references/zero_trust_enterprise_security/` |
| SIMD fast image resizing, Apache Parquet/CSV 10M streaming, ffmpeg-next video HLS, headless_chrome PDF | `references/media_asset_pipeline/` |
| CI/CD acceleration via cargo-nextest, sccache AWS S3 cloud cache, cargo-zigbuild cross compile, cargo-deny SBOM | `references/ci_cd_pipeline_cargo/` |
| Unicode ICU4X zero-alloc engine, Mozilla Project Fluent localization, Axum locale routing, zero-copy formatting | `references/i18n_localization_icu/` |

## ✅ Terdesentralisasi Quality Gate (Per-Role)

**Gerbang Global (WAJIB bagi semua role yang mengubah kode/infrastruktur):**
```
powershell -NoProfile -ExecutionPolicy Bypass -File ~/.gemini/config/scripts/quality_gate.ps1 -Full
```

Sebagai agen otonom, WAJIB periksa bagian di bawah ini sesuai dengan peran aktif Anda. DILARANG mencentang tugas `[x]` bila gerbang *role* Anda belum terpenuhi secara spesifik.

### 🏛️ `[ ]` Gerbang Architect (PM)
- **Trait Contracts:** Antarmuka komponen abstrak (Ports & Adapters) harus bergantung pada *Traits* (misal: `Repository` trait), bukan implementasi konkrit.
- **Observability:** `tracing` JSON terstruktur + OpenTelemetry OTLP terintegrasi murni (tidak membocorkan PII/token).
- **Security Blueprint:** Validasi konfigurasi *(secrets)* terdeserialisasi aman dan akan memicu *panic* di awal (*fail-fast*) jika tidak valid.

### ⚙️ `[ ]` Gerbang SWE
- **Lint & Test:** `cargo fmt -- --check`, `cargo clippy -D warnings`, dan `cargo test` lulus 100%.
- **Safety:** Nol `.unwrap()` di jalur produksi (`thiserror`/`anyhow` diwajibkan). Siklus referensi `Arc<T>` diputus dengan `Weak<T>`.
- **Async Hygiene:** Tidak ada `Mutex` yang terkunci melintasi batas `.await`. Operasi berat/lambat dipindah via `tokio::task::spawn_blocking`.
- **Cancel-Safety:** Semua operasi di dalam `tokio::select!` telah dipastikan aman dari *cancellation*.

### 🛡️ `[ ]` Gerbang QA (Red Team)
- **UB Miri:** `cargo miri test` WAJIB lulus 100% jika ada modifikasi kode yang menyentuh blok `unsafe`.
- **Fuzzing & Chaos:** Validasi input *Fuzzing* (via `cargo fuzz` / `proptest`) tidak memicu `panic!` atau korupsi memori.
- **CVE Free:** Hasil `cargo audit` bersih dari kerentanan kritis.

### 🌩️ `[ ]` Gerbang DevOps
- **Build Efficiency:** Memakai `cargo-chef` untuk abstraksi *layer caching* (tanpanya *build* Rust memakan waktu belasan menit).
- **Distroless & Container:** *Build* memakai target `musl` untuk biner statis (`FROM scratch` / `alpine`), atau glibc *distroless*. Wajib dijalankan sebagai **nonroot**.
- **Graceful Shutdown:** *Axum/Actix* memakai metode `with_graceful_shutdown()` yang menyadap `SIGTERM` secara akurat.

### 🗄️ `[ ]` Gerbang DBA
- **Pool Tuning:** `sqlx::PgPool` memiliki nilai spesifik pada `max_connections` dan `acquire_timeout` (mencegah *connection storm*).
- **Type-Safe Queries:** `sqlx::query!` atau makro *compile-time* memvalidasi kueri sejak proses kompilasi.
- **Zero-Downtime Migration:** Migrasi DDL (Data Definition Language) tidak menimbulkan *lock* berkepanjangan pada tabel PostgreSQL produksi.
