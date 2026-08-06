---
name: rust-mastery
description: Gunakan skill ini ketika merancang arsitektur, Borrow Checker memory safety, Tokio async, Traits & Generics, Unsafe Rust & FFI, Axum microservices, HFT zero-cost abstractions, WebAssembly/eBPF, Tauri/Bevy/Blockchain, LLVM internals, Lock-free structures, atau Custom Allocators di Rust.
---

# Rust Mastery

SSOT arsitektur & rekayasa sistem Rust enterprise, systems programming, dan ultra-low latency (31 Domain, 191 File Mahakarya).

## 🚦 Protokol Eksekusi (WAJIB dibaca sesuai situasi)

> **SEBELUM membuka tabel di bawah:** Jika ini adalah proyek baru atau keputusan arsitektur besar, WAJIB lewati `master_decision_tree.md` (`~/.gemini/config/skills/master-decision-tree/SKILL.md`) terlebih dahulu. DILARANG langsung memilih Rust sebagai stack tanpa justifikasi dari Decision Tree.

| Situasi | WAJIB baca dulu sebelum menulis apa pun |
| :--- | :--- |
| Inisiasi project baru dari nol (empty folder / new repository) | `references/_protocol/greenfield.md` |
| Tambah fitur / modifikasi / optimasi / audit di repo eksisting | `references/_protocol/brownfield.md` |

DILARANG membuat dokumen RFC (`docs/rfc/`) atau menulis kode sebelum protokol yang relevan dibaca tuntas.

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

## 🛠️ Automated Quality Gate & Verification Commands

Sebelum melaporkan tugas selesai, WAJIB jalankan perintah verifikasi ketat berikut di terminal:

```bash
# 1. Code Formatting Check
cargo fmt -- --check

# 2. Strict Linter Zero-Tolerance Warning
cargo clippy --all-targets --all-features -- -D warnings

# 3. Comprehensive Test Suite Execution
cargo test --all-targets --all-features

# 4. Undefined Behavior (UB) & Memory Safety Audit (Khusus jika menyentuh blok `unsafe`)
cargo miri test

# 5. Dependency Vulnerability Audit
cargo audit
```
