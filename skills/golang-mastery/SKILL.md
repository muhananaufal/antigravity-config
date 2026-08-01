---
name: golang-mastery
description: Gunakan skill ini ketika merancang arsitektur, konkurensi, DB/SQLC, gRPC, HFT, testing, security, distributed systems, K8s Operators, Linux Systems Programming, atau runtime internals di Golang.
---

# Golang Mastery

SSOT arsitektur & rekayasa sistem Golang enterprise & high-throughput.

## 🔁 Greenfield Protocol (Init Proyek dari Nol — Swarm Research)

LLM secara alami akan mengambil jalan pintas (laziness) jika disuruh membaca puluhan file. Untuk menjamin standar Top 1% diterapkan 100% tanpa halusinasi, **WAJIB gunakan protokol Swarm Subagent** saat inisialisasi **project baru dari nol (empty folder / new repository)**:

1. **Fase Inisialisasi (DILARANG MENEBAK):** Saat user meminta inisiasi project baru, Agen Utama DILARANG membuat `implementation_plan.md` langsung.
2. **Spawn 4 Subagent `pro` Paralel:** Agen Utama WAJIB memanggil `invoke_subagent` untuk men-spawn 4 subagent sekaligus dengan pembagian tugas:
   - **Subagent 1 (Infra & Data):** Wajib `view_file` ke semua file di `arch_patterns/`, `db_sqlc/`, dan `devops_control_planes/`. Lapor rangkuman standar arsitektur.
   - **Subagent 2 (API & Code):** Wajib `view_file` ke semua file di `microservices_grpc/`, `testing_quality/`, dan `concurrency/`. Lapor standar API.
   - **Subagent 3 (Security & Scale):** Wajib `view_file` ke semua file di `security_owasp/`, `observability_resilience/`, `distributed_patterns_resilience/`, dan `caching_strategy/`. Lapor standar ketahanan.
   - **Subagent 4 (Context/Niche):** Agen utama wajib mendeteksi domain dari tabel **Auto-Detect** di bawah, lalu menugaskan Subagent 4 untuk membaca domain *niche* tersebut (misal `fintech_reliability/`, `background_jobs_worker/`, dll).
3. **Wait & Compile:** Agen Utama menunggu semua subagent melapor, merangkumnya, lalu membuat `implementation_plan.md` dengan opsi *Zero-Steering Grilling*.
4. **Fase Implementasi (Coding):** Agen mematuhi standar yang sudah diekstrak subagent dan menggunakan `view_file` ke referensi spesifik HANYA jika butuh kode spesifik (seperti detail sintaks).

## 🏛️ Brownfield Protocol (Legacy / Refactoring / Tambah Fitur di Repo Eksisting)

Saat user meminta **penambahan fitur baru, modifikasi, optimasi, atau audit** pada **codebase yang sudah ada (Legacy/Existing Project)**, DILARANG memaksakan *Big Bang Rewrite* atau menciptakan "Frankenstein Codebase". Gunakan protokol **Hybrid Swarm**:

1. **Fase Audit & Discovery (Spawn 3 Subagent `pro` Paralel):**
   - **Subagent 1 (Codebase & Architecture Auditor):** Gunakan `grep_search`, `list_dir`, dan `view_file` pada direktori project lokal user untuk memetakan struktur arsitektur, ORM/driver, pola koneksi DB, dan routing yang saat ini berjalan.
   - **Subagent 2 (Vulnerability & Anti-Pattern Hunter):** Scan codebase lokal untuk mencari penyakit fatal yang bisa memperburuk fitur baru: N+1 queries, panggilan DB/HTTP tanpa `context.WithTimeout`, penggunaan `float32/float64` untuk moneter/uang, *goroutine leak*, SQL Injection, atau hardcode credentials.
   - **Subagent 3 (Mastery Standard Matcher):** Meninjau temuan dari Subagent 1 & 2 serta spesifikasi fitur baru, lalu membaca file di direktori `references/` kita yang **relevan saja** untuk mengawal penambahan fitur / optimasi tersebut (terutama `zero_downtime_migrations.md` jika butuh ubah skema DB, `query_optimization_n_plus_one.md`, atau referensi niche terkait).
2. **Zero-Steering Grilling (Opsi Evolusi / Penambahan Fitur):**
   Agen Utama merangkum laporan audit dan menyajikan ≥3 opsi netral beserta trade-off untuk user (Gasskan):
   - **Opsi 1: Native Consistent Extension (KISS):** Tanam fitur baru dengan mematuhi pola asli/ekspresi arsitektur repo tersebut (agar tim developer lama tidak bingung), NAMUN disuntikkan perlindungan standar Top 1% (wajib timeout, parameterized queries, RED metrics, dan index DB). Cepat dan konsisten.
   - **Opsi 2: Strangler Fig Pattern (Modular Isolation):** Fitur/modul baru didirikan secara independen menggunakan arsitektur modern kita (`internal/` Modular Monolith/Clean/SQLC) tanpa merusak kode lama. Terhubung ke legacy hanya melalui interface facade/proxy.
   - **Opsi 3: Surgical Rewrite & Expansion:** Jika modul lama terkait sudah terlalu cacat (misal fitur baru bergantung pada modul pembayaran jadul yang fatal/rentan race condition), ajukan operasi bedah modul lama sekaligus merancang fitur barunya berpadu berstandar Top 1%.

### 🔍 Auto-Detect Context Domain (Scan dari Task)

Agent wajib mencocokkan nature of task ke domain berikut **secara proaktif**:

| Jika task melibatkan... | Otomatis baca |
| :--- | :--- |
| Payment, transaksi, ledger, refund, wallet, checkout | `fintech_reliability/` |
| Job async, queue, email/notif worker, scheduled task, cron | `background_jobs_worker/` |
| Kafka, NATS, WebSocket, real-time, event stream, pub/sub | `realtime_networking/` |
| AWS, GCP, S3, Lambda, SQS, Secrets Manager, cloud | `cloud_provider_sdk/` |
| K8s, Helm, CRD, Operator, cluster, pod, deployment manifest | `cloud_native_k8s_operators/` |
| CI/CD, GitHub Actions, GitLab CI, release, deploy pipeline | `ci_cd_pipeline/` |
| Cache Redis, in-memory cache, stampede, TTL, invalidation | `caching_strategy/` (full) |
| Saga, outbox, CQRS, event sourcing, distributed tx | `distributed_patterns_resilience/` (full) |
| Performance, profiling, pprof, GC pressure, memory leak | `runtime_internals/` |
| Search, vector, AI/ML inference, embedding, ONNX | `ai_data_infra/` |
| Low-latency, HFT, zero-alloc, matching engine, order book | `hft_zero_alloc/` |
| Linux syscall, epoll, cgroups, seccomp, raw socket | `system_programming_linux/` |
| Security audit, zero-trust, OPA, SPIFFE, cosign, SBOM | `cybersecurity_zerotrust/` |
| Code generation, AST, linter custom, WASM plugin | `ast_metaprogramming/` |
| Game server, multiplayer, tick loop, leaderboard | `game_backend/` |
| Distributed consensus, Raft, etcd, WAL, BadgerDB | `distributed_consensus_storage/` |
| IoT, embedded, TinyGo, GPIO, edge device | `embedded_tinygo/` |
| QUIC, WireGuard, DNS, MQTT, raw TCP protocol | `advanced_networking_protocols/` |



## 📦 Core References (Wajib Baca Setiap Project)

Domain yang hampir selalu relevan untuk Go service manapun:

| Domain | Referensi | File Spesifik |
| :--- | :--- | :--- |
| **Concurrency** | `references/concurrency/` | semua |
| **DB & Cache** | `references/db_sqlc/` | semua |
| **API & gRPC** | `references/microservices_grpc/` | semua |
| **Observability** | `references/observability_resilience/` | semua |
| **Security** | `references/security_owasp/` | semua |
| **Testing** | `references/testing_quality/` | semua |
| **Architecture** | `references/arch_patterns/` | semua |
| **Docker & DevOps** | `references/devops_control_planes/` | semua |
| **Resilience Patterns** | `references/distributed_patterns_resilience/` | `retry_backoff_jitter.md`, `idempotency_key_engine.md`, `bulkhead_isolation.md` |
| **Caching** | `references/caching_strategy/` | `cache_aside_singleflight.md`, `multilevel_cache_l1l2.md` |

---

## 🎯 Context References (Baca Sesuai Kebutuhan)

| Konteks / Keyword | Baca Referensi |
| :--- | :--- |
| Runtime internals, GC tuning, CGO, PGO, goroutine stack | `references/runtime_internals/` |
| Distributed transactions, saga, outbox, CQRS, feature flags, multi-tenancy | `references/distributed_patterns_resilience/` |
| Raft, etcd, LSM, WAL, gossip, vector clock, BadgerDB | `references/distributed_consensus_storage/` |
| Payment, ledger, decimal, ISO 20022, PCI-DSS, reconciliation, ClickHouse | `references/fintech_reliability/` |
| WebSocket, Kafka, NATS, eBPF, TCP, binary protocol | `references/realtime_networking/` |
| Zero-alloc, HFT, lock-free ring buffer, SIMD, CPU cache, FIX parser | `references/hft_zero_alloc/` |
| epoll, cgroups, seccomp, inotify, Unix socket, POSIX signal | `references/system_programming_linux/` |
| K8s Operator, CRD, admission webhook, client-go informer, Helm | `references/cloud_native_k8s_operators/` |
| QUIC, WireGuard, MQTT, ConnectRPC, DNS, SOCKS5 | `references/advanced_networking_protocols/` |
| SPIFFE, OPA, cosign, SBOM, Vault rotation, fuzzing | `references/cybersecurity_zerotrust/` |
| AST, custom linter, code gen, WASM plugin, protoc plugin | `references/ast_metaprogramming/` |
| TinyGo, GPIO, I2C/SPI, edge MQTT, WASM browser | `references/embedded_tinygo/` |
| Game server, tick loop, spatial hash, dead reckoning, leaderboard | `references/game_backend/` |
| HNSW, LLM proxy, Apache Arrow, DataFusion, pgvector, ONNX | `references/ai_data_infra/` |
| GitHub Actions, GitLab CI, GoReleaser, security scan CI, blue/green deploy, monorepo | `references/ci_cd_pipeline/` |
| AWS SDK v2 (S3/SQS/DynamoDB), GCP client, Lambda, Secrets Manager, SNS fanout | `references/cloud_provider_sdk/` |
| Background jobs, asynq, River (Postgres), cron distributed, worker pool, saga jobs | `references/background_jobs_worker/` |
| Cache-aside, singleflight, L1/L2 multilevel, Redis patterns, cache invalidation, CDN headers | `references/caching_strategy/` |

---

## ✅ Quality Gate (Checklist Sebelum Selesai)

**Go & Code Quality:**
- `go test -race ./...` — zero data race
- `golangci-lint run` — zero lint error
- Clean Architecture: `DTO → Handler → Service → Repository` — no business logic di Handler
- Strongly-Typed Error: `errors.As` / Sentinel Errors — no bare `nil` return
- `context.WithTimeout` pada SEMUA panggilan DB, Redis, gRPC, HTTP Client
- `defer recover()` pada setiap goroutine baru yang di-spawn
- `SetMaxOpenConns` / `SetMaxIdleConns` / `SetConnMaxLifetime` — no default unlimited pool

**API & System:**
- Prefix versi API (`/api/v1/`) + Pagination (cursor/offset)
- Idempotency Key (Redis/DB) pada POST yang mutate state
- OpenAPI spec (`swaggo`/`ogen`) sejak awal
- Correlation ID (`X-Request-ID`) propagasi ke semua downstream
- `/health` + `/ready` endpoint pada setiap service
- Zero-Downtime Migration — kolom baru `nullable`, no rename/drop langsung

**Observability & Security:**
- RED Metrics + OpenTelemetry tracing per service
- Structured Logging (`zerolog`/`slog`) — no PII/token di log
- Circuit Breaker + timeout + retry untuk semua external calls
- Rate Limiting pada endpoint publik
- OWASP: SQL Injection, IDOR, Mass Assignment, Broken Auth
- Audit N+1 Query — gunakan batch atau eager loading
- p99 < 200ms — verifikasi dengan `go test -bench`

**Docker & Container:**
- Multi-stage build: `golang:1.23-alpine` → `distroless/static-debian12:nonroot` atau `scratch`
- Non-root user — no `root` di production container
- `.dockerignore` eksplisit — no `.env*`, `.git/`, `*_test.go` ikut ter-COPY
- `ENTRYPOINT ["/app"]` exec form — no shell form (SIGTERM tidak sampai ke app)
- `HEALTHCHECK` di Dockerfile selaras dengan `/health` endpoint
- No hardcode credentials — gunakan `ENV` + secret manager
- Resource limits di `docker-compose.yml` / K8s manifest
- `depends_on.condition: service_healthy` untuk DB/Redis dependency
