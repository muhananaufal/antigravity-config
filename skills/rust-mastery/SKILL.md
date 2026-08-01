---
name: rust-mastery
description: Gunakan skill ini ketika merancang arsitektur, Borrow Checker memory safety, Tokio async, Traits & Generics, Unsafe Rust & FFI, Axum microservices, HFT zero-cost abstractions, WebAssembly/eBPF, Tauri/Bevy/Blockchain, LLVM internals, Lock-free structures, atau Custom Allocators di Rust.
---

# Rust Mastery

SSOT arsitektur & rekayasa Rust systems & enterprise.

## 🔁 Protocol & Routing Table

**Core Protocol:**
1. WAJIB `view_file` SELURUH file referensi di `references/<domain>/` yang relevan — DILARANG mengarang dari hafalan LLM.
2. WAJIB sajikan minimal 2-3 opsi netral + trade-off saat Grilling — DILARANG langsung rekomendasikan 1 opsi.

**Rust-Specific Quality Gate:**
3. WAJIB `cargo test` + `cargo clippy -- -D warnings` — zero warning/error sebelum lapor selesai.
4. WAJIB `cargo miri test` pada setiap blok `unsafe` — buktikan bebas Undefined Behavior (UB).
5. WAJIB unit test `#[cfg(test)]` pada modul logika bisnis utama (Auth, Payment, State Machine).
6. WAJIB Clean Architecture: **DTO → Handler → Service → Repository/Entity**. DILARANG logika bisnis di Handler.
7. WAJIB Strongly-Typed Error: `thiserror` Custom Enum. DILARANG `map_err(|_| ...)` generik.
8. WAJIB Graceful Shutdown: `tokio::signal::ctrl_c` + SIGTERM handler + drain DB/Redis sebelum exit.
9. WAJIB validasi & sanitasi payload masuk sebelum menyentuh layer Service/DB (`validator` crate).
10. WAJIB Tokio Cancellation Safety: semua branch `tokio::select!` WAJIB cancellation-safe — DILARANG mutable state melintasi `await` di branch yang bisa dibatalkan.
11. WAJIB isolasi blocking I/O & heavy CPU dari Tokio worker thread via `tokio::task::spawn_blocking()`.
12. WAJIB cegah Reference Cycle: gunakan `Weak<T>` untuk back-reference di data structure berarah/callback — DILARANG circular `Arc<T>`.
13. WAJIB konfigurasi Connection Pool eksplisit (max_connections, idle_timeout, lifetime) — DILARANG default tanpa batas.

**API & System Design:**
14. WAJIB prefix versi API (`/api/v1/`) + Pagination (cursor/offset) pada semua list endpoint.
15. WAJIB Idempotency Key (Redis/DB) pada POST yang mutate state — cegah double-processing.
16. WAJIB OpenAPI spec (`utoipa`/`swagger-ui`) sejak awal, bukan afterthought.
17. WAJIB Correlation ID (`X-Request-ID`) propagasi ke semua downstream + `tracing::Span`.
18. WAJIB Health Check (`/health`) + Readiness Probe (`/ready`) pada setiap service.
19. WAJIB Backward Compatibility — breaking change harus versi baru (`v2`), bukan patch di versi yang sama.
20. WAJIB Zero-Downtime Migration — kolom baru `nullable`, DILARANG rename/drop langsung.

**Observability & Security:**
21. WAJIB `TraceLayer::new_for_http()` + RED Metrics (Rate/Error/Duration) per service.
22. WAJIB `tracing` structured logging — DILARANG log struct berisi token/key/PII. Gunakan `skip` directive atau custom formatter.
23. WAJIB Circuit Breaker + timeout + retry pada semua external service calls.
24. WAJIB Rate Limiting pada endpoint publik (auth, register, reset password).
25. WAJIB OWASP Checklist: SQL Injection, IDOR, Mass Assignment, Broken Auth — eksplisit sebelum selesai.
26. WAJIB audit N+1 Query di setiap loop DB — gunakan batch query atau `JOIN`.
27. WAJIB p99 < 200ms SLA — verifikasi dengan `cargo criterion` sebelum deploy.

**Docker & Container (Startup Standard):**
28. WAJIB Multi-Stage Build: `builder` (rust:1.82-alpine / rust:1.82-slim) → `runtime` (gcr.io/distroless/cc-debian12 atau scratch) — binary Rust di-strip (`strip`/`cargo-strip`) sebelum dikopi ke stage final, image final DILARANG contain Cargo/rustc.
29. WAJIB Non-Root User: `USER nonroot:nonroot` (distroless) atau `adduser -D appuser` (alpine) — DILARANG run sebagai root di production container.
30. WAJIB `.dockerignore` eksplisit: exclude `.git/`, `target/`, `tests/`, `benches/`, `docs/` — `target/` terutama critical karena bisa 10GB+, DILARANG COPY tanpa filter.
31. WAJIB Health Check di Dockerfile: `HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["/bin/grpc_health_probe","-addr=:50051"]` atau HTTP `wget` sesuai protokol service.
32. WAJIB `SIGTERM` Graceful Shutdown di container: gunakan `ENTRYPOINT ["/app"]` (exec form) — Tokio harus handle `tokio::signal::unix::signal(SignalKind::terminate())` secara eksplisit.
33. WAJIB Environment Config via `ENV` / `ARG` — DILARANG hardcode credentials/secrets di Dockerfile. Gunakan Docker Secrets atau secret manager.
34. WAJIB Resource Limits di `docker-compose.yml` / K8s manifest: `deploy.resources.limits.memory`, `cpus` — Rust service tanpa memory limit tetap bisa OOM jika ada leak di unsafe block.
35. WAJIB `docker-compose.yml` menyediakan `healthcheck`, `depends_on.condition: service_healthy`, dan `restart: unless-stopped` untuk semua service dependencies (DB, Redis, etc.).

| Topik Task | Domain Referensi |
| :--- | :--- |
| Borrow checker NLL, lifetime variance, smart pointers (Box/Rc/Arc/Weak), interior mutability (Cell/RefCell/UnsafeCell), Cow<'a,B>, LazyLock, Pin<P> + Unpin, PhantomData variance, dropck eyepatch | `references/core_memory_ownership/` |
| Tokio runtime M:N scheduler, async channels (mpsc/oneshot/broadcast/watch), tokio::select! cancellation safety, lock-free atomics ordering, spawn_blocking, async-stream, parking_lot, graceful shutdown JoinSet | `references/async_tokio_concurrency/` |
| dyn Trait vtable, monomorphization vs GC-shape, typestate PhantomData, orphan rules newtype, GATs HRTB for<'a>, min_specialization, derive macro internals, sealed traits, #[non_exhaustive] | `references/type_system_traits/` |
| *const/*mut provenance model, transmute safety, C-FFI bindgen/cbindgen, MaybeUninit, Pin projection, Stacked Borrows, inline asm!, GlobalAlloc custom allocator, Miri UB detection | `references/unsafe_ffi_internals/` |
| Axum Router::with_state, custom FromRequest extractor, Tower Service/Layer middleware, SQLx compile-time query, SeaORM ActiveModel, JWT Tower middleware, tonic gRPC streaming, governor rate limit, OpenTelemetry | `references/web_microservices/` |
| Zero-cost abstractions, SIMD std::simd + portable-simd, jemalloc/mimalloc, #![no_std] bare-metal, CachePadded false sharing, branch prediction, const generics, Profile-Guided Optimization | `references/high_performance_hft/` |
| wasm-bindgen JS interop, WASI serverless, aya-rs eBPF (XDP/TC/kprobe), WASM SIMD128, shared memory multithreading, wasmtime runtime embedding | `references/wasm_systems/` |
| Result/Option monadic chaining, thiserror vs anyhow, panic recovery (std::panic::catch_unwind), backtrace symbolication, error context propagation | `references/error_handling_resilience/` |
| mockall, cargo-fuzz corpus management, proptest shrinking, criterion statistical benchmarks, insta snapshot testing, cargo-nextest | `references/testing_fuzzing_benchmarking/` |
| RocksDB/Sled/Pebble embedded, hashicorp/raft port, WAL CRC32 + fsync, LSM MemTable/SSTable, vector clocks CRDT, consistent hashing | `references/distributed_consensus_storage/` |
| tonic server/client streaming, s2n-quic QUIC transport, tokio-util FramedCodec, tokio-tungstenite WebSocket, NATS async-nats, Protocol Buffers prost | `references/networking_protocols_grpc/` |
| ring/aws-lc-rs AEAD, zk-SNARKs arkworks, SGX/Nitro secure enclave, rustls TLS 1.3, constant-time subtle crate, age encryption | `references/cybersecurity_cryptography/` |
| Polars DataFrame lazy API, DataFusion SQL query engine, Apache Arrow IPC, HNSW vector search, Parquet columnar reader, DuckDB FFI | `references/data_engineering_polars/` |
| clap derive CLI, ratatui TUI, tracing subscriber + fmt layers, indicatif progress bar, crossterm raw mode event loop | `references/cli_tooling_clap/` |
| Tauri v2 commands + IPC, egui immediate mode, wgpu cross-platform GPU, Tauri plugin system, mobile (iOS/Android) target | `references/gui_desktop_tauri/` |
| Bevy ECS App/World/System, multi-threaded scheduler par_iter, async asset loading, Bevy state machine, observer pattern | `references/game_engine_bevy/` |
| Anchor smart contracts, Substrate FRAME pallets, CosmWasm, REVM EVM simulator, Merkle Patricia Trie, Borsh serialization, MEV searcher | `references/blockchain_smart_contracts/` |
| LLVM IR passes via inkwell, struct alignment #[repr(C/packed/align)], LTO thin/fat, cargo-asm disassembly, vtable layout, dropck internals | `references/compiler_llvm_internals/` |
| Custom Future + RawWaker, epoll reactor (mio), Chase-Lev work-stealing deque, task-local storage, io_uring via tokio-uring | `references/async_executor_internals/` |
| Treiber lock-free stack, Michael-Scott queue, crossbeam epoch-based reclamation, SeqLock, AtomicCell, hazard pointers | `references/lockfree_atomic_structures/` |
| Bump allocator #![no_std], slab allocator fixed-size, typed-arena, GlobalAlloc trait impl, tracking allocator for leak detection | `references/custom_allocators_internals/` |
| syn VisitMut AST traversal, quote_spanned! error diagnostics, proc-macro attribute + derive, TokenStream manipulation, macro hygiene | `references/advanced_procmacro_engineering/` |
| Multi-stage Dockerfile (builder→distroless/cc-debian12/scratch), binary strip, non-root user, .dockerignore (target/ exclude), HEALTHCHECK, SIGTERM Tokio signal handler, docker-compose healthcheck + depends_on, resource limits, K8s-ready probe | `references/docker_container_standards/` |
