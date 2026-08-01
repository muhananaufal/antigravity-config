---
name: rust-mastery
description: Gunakan skill ini ketika merancang arsitektur, Borrow Checker memory safety, Tokio async, Traits & Generics, Unsafe Rust & FFI, Axum microservices, HFT zero-cost abstractions, WebAssembly/eBPF, Tauri/Bevy/Blockchain, LLVM internals, Lock-free structures, atau Custom Allocators di Rust.
---

# Rust Mastery

SSOT arsitektur & rekayasa sistem Rust enterprise, systems programming, dan ultra-low latency (31 Domain, 190 File Mahakarya).

## 🔁 Greenfield Protocol (Init Proyek dari Nol — Dynamic Swarm Scaling)

LLM secara alami akan mengambil jalan pintas (laziness) dan berisiko menghasilkan kode yang gagal compile (*Borrow Checker / Lifetime error*) atau *Undefined Behavior* di block `unsafe` jika disuruh membaca puluhan file seiring waktu. Untuk menjamin standar Top 1% diterapkan 100%, **WAJIB gunakan protokol Dynamic Swarm Subagent (Elastis)** saat inisialisasi **project baru dari nol (empty folder / new repository / cargo new)**:

1. **Fase Inisialisasi (DILARANG MENEBAK / HALUSINASI):** Saat user meminta inisiasi project baru, Agen Utama DILARANG langsung membuat kode atau `implementation_plan.md` tanpa konsultasi referensi.
2. **Dynamic Swarm Summon (`pro` tier):** Agen Utama WAJIB memanggil `invoke_subagent` untuk men-spawn minimal 3 hingga >8 subagent secara paralel sesuai kompleksitas proyek (Dynamic Scaling):
   - **3 Subagent Core Tetap (Mandatory Core Coverage):**
     - **Subagent 1 (Memory, Traits & Unsafe Core):** Wajib `view_file` ke SEMUA file di `references/core_memory_ownership/`, `references/type_system_traits/`, `references/unsafe_ffi_internals/`, dan `references/docker_container_standards/`.
     - **Subagent 2 (Async, Web & Reliability Core):** Wajib `view_file` ke SEMUA file di `references/async_tokio_concurrency/`, `references/web_microservices/`, `references/error_handling_resilience/`, dan `references/testing_fuzzing_benchmarking/`.
     - **Subagent 3 (Performance, Security & Storage Core):** Wajib `view_file` ke SEMUA file di `references/high_performance_hft/`, `references/distributed_consensus_storage/`, `references/networking_protocols_grpc/`, dan `references/cybersecurity_cryptography/`.
   - **Subagent Niche DINAMIS (1 Subagent per Domain Terdeteksi):** 
     - Agen utama mengecek tabel **Auto-Detect Niche Domain** di bawah. Untuk **SETIAP 1 domain niche** yang cocok dengan proyek (misal: `wasm_systems/`, `blockchain_smart_contracts/`, `game_engine_bevy/`), WAJIB spawn **1 Subagent Dedikatif terpisah**. (Jika terdeteksi 3 domain niche, maka summon 3 Core + 3 Niche = **6 Subagents paralel**!).
3. **Wait & Compile:** Agen Utama menunggu semua subagent melapor, merangkumnya, lalu membuat `implementation_plan.md` dengan opsi *Zero-Steering Grilling*.
4. **Fase Implementasi (Coding):** Agen mematuhi standar yang sudah diekstrak subagent dan menggunakan `view_file` ke referensi spesifik HANYA jika butuh contoh kode spesifik.

## 🏛️ Brownfield Protocol (Legacy / Refactoring / Tambah Fitur di Repo Eksisting)

Saat user meminta **penambahan fitur baru, modifikasi, optimasi, atau audit** pada **codebase yang sudah ada (Legacy/Existing Project / Repo yang sudah punya `Cargo.toml`)**, DILARANG memaksakan *Big Bang Rewrite*, penciptaan "Frankenstein Codebase", atau pemakaian daftar subagent statis yang tidak relevan. Gunakan protokol **Dynamic Reconnaissance & Partitioning**:

1. **Intai & Pembelahan Subagent secara 100% Dinamis (Dynamic Hybrid Swarm):**
   Agen Utama DILARANG mematok nama atau jumlah peran subagent secara kaku. Pertama, lirik struktur direktori root, `Cargo.toml` (termasuk *workspace crates*), dan file konfigurasi lokal. Setelah itu, spawn tim Subagent ber-model `pro` (dari 3 hingga >10 secara elastis) dengan strategi pembagian yang benar-benar selaras dengan kenyataan repo asli:
   - **Pembagian Berbasis Workspace / Crates / Modul:** Jika project user berbentuk Cargo Workspace atau dibagi menjadi beberapa modul (`/crates/api`, `/crates/domain`, `/crates/storage`), spawn **1 Subagent Auditor terpisah untuk membedah masing-masing crate/modul**.
   - **Pembagian Berbasis Tech Stack di `Cargo.toml`:** 
     - Jika mendeteksi `tokio`, spawn *Tokio Concurrency Auditor* (fokus mencari bahaya *Cancellation Safety* pada `tokio::select!`, kebocoran *blocking I/O* di worker thread tanpa `spawn_blocking`, dan *deadlock* pada `Mutex` melintasi titik `.await`).
     - Jika mendeteksi `sqlx` / `sea-orm`, spawn *DB & N+1 Query Hunter* (fokus mencari N+1 loop query, unpooled DB connections, atau skema tanpa migrasi aman).
     - Jika mendeteksi blok `unsafe` / FFI, spawn *Unsafe Provenance Auditor* (memeriksa pointer aliasing, transmute hazards, dan kepatuhan Stacked Borrows / Miri).
     - Jika TIDAK ADA fitur blockchain atau game, DILARANG KERAS memanggil spesialis kripto/game!
   - **Pembagian Berbasis Volume File:** Jika satu modul/crate sangat padat (>30 file), pecah audit atas crate tersebut ke beberapa subagent berdasarkan fungsionalitas (misal: Subagent A fokus API Handler & Middleware, Subagent B fokus DB Repositories & Entities).
   - **Mastery Standard Matcher (Subagent Dedikatif):** Tugas subagent ini murni mengkonsolidasi seluruh laporan kecacatan dari para auditor di atas, lalu menarik dan membaca HANYA file di direktori `references/` kita yang **spesifik bisa menjadi obat untuk menyembuhkan celah/bug tersebut**.
2. **Zero-Steering Grilling (Opsi Evolusi / Penambahan Fitur):**
   Agen Utama merangkum laporan dari seluruh tim spesialis dan menyajikan ≥3 opsi netral beserta trade-off untuk user (Gasskan):
   - **Opsi 1: Native Consistent Extension (KISS):** Tanam fitur baru dengan mematuhi pola asli arsitektur repo tersebut, NAMUN disuntikkan perlindungan standar Top 1% (wajib `thiserror`, timeout di external calls, `Arc<T>` bebas sirkulasi maut dengan `Weak<T>`, dan zero clippy warnings).
   - **Opsi 2: Strangler Fig Pattern (Workspace / Modular Isolation):** Fitur/modul baru didirikan secara independen sebagai crate baru di Cargo Workspace atau modul terisolasi berstandar Top 1% tanpa merusak kode lama.
   - **Opsi 3: Surgical Rewrite & Hardening:** Jika modul lama terkait sudah terlalu cacat (misal modul concurrency lawas penuh *race condition* atau bocor memori di blok `unsafe`), ajukan operasi bedah modul lama sekaligus merancang fitur barunya berpadu berstandar Top 1%.

### 🔍 Auto-Detect Niche Domain (Scan dari Task)

Agent wajib mencocokkan nature of task ke domain berikut **secara proaktif**:

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
| Apalis background queue workers, Transactional Outbox pattern, Distributed Saga compensating rollback, DLQ | `references/background_jobs_saga/` |
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
