---
name: golang-mastery
description: Gunakan skill ini ketika merancang arsitektur, konkurensi, DB/SQLC, gRPC, HFT, testing, security, distributed systems, K8s Operators, Linux Systems Programming, atau runtime internals di Golang.
---

# Golang Mastery

SSOT arsitektur & rekayasa sistem Golang enterprise & high-throughput (28 Domain, 198 File Mahakarya).

## 🔁 Greenfield Protocol (Init Proyek dari Nol — Dynamic Swarm Scaling)

LLM secara alami akan mengambil jalan pintas (laziness) jika disuruh membaca puluhan file. Untuk menjamin standar Top 1% diterapkan 100% tanpa halusinasi, **WAJIB gunakan protokol Dynamic Swarm Subagent (Elastis)** saat inisialisasi **project baru dari nol (empty folder / new repository)**:

1. **Fase Inisialisasi (DILARANG MENEBAK):** Saat user meminta inisiasi project baru, Agen Utama DILARANG membuat `implementation_plan.md` langsung.
2. **Dynamic Swarm Summon (`pro` tier):** Agen Utama WAJIB memanggil `invoke_subagent` untuk men-spawn minimal 4 hingga >8 subagent secara paralel sesuai kompleksitas proyek (Dynamic Scaling):
   - **3 Subagent Core Tetap (Mandatory Core Coverage):**
     - **Subagent 1 (Infra & Data Core):** Wajib `view_file` ke SEMUA file di `arch_patterns/`, `db_sqlc/`, dan `devops_control_planes/`.
     - **Subagent 2 (API & Logic Core):** Wajib `view_file` ke SEMUA file di `microservices_grpc/`, `testing_quality/`, dan `concurrency/`.
     - **Subagent 3 (Security & Resilience Core):** Wajib `view_file` ke SEMUA file di `security_owasp/`, `observability_resilience/`, `distributed_patterns_resilience/`, dan `caching_strategy/`.
   - **Subagent Niche DINAMIS (1 Subagent per Domain Terdeteksi):** 
     - Agen utama mengecek tabel **Auto-Detect** di bawah. Untuk **SETIAP 1 domain niche** yang cocok dengan proyek (misal: `fintech_reliability/`, `hft_zero_alloc/`, `realtime_networking/`), Wajib spawn **1 Subagent Dedikatif terpisah**. (Jika terdeteksi 4 domain niche, maka summon 3 Core + 4 Niche = **7 Subagents paralel**!).
3. **Wait & Compile:** Agen Utama menunggu semua subagent melapor, merangkumnya, lalu membuat `implementation_plan.md` dengan opsi *Zero-Steering Grilling*.
5. **Day-0 Greenfield Production-Ready Quintet (Hukum Wajib Inisiasi Proyek Baru):** Setiap inisialisasi proyek baru (Greenfield) di Golang WAJIB secara default menghasilkan 5 pilar fondasi Day-0 berikut di root proyek:
   - **Pilar 1: Modular 3-Tier Container Topology:** Tier 1 Core (`docker-compose.yml` DB PostgreSQL/Valkey), Tier 2 Telemetry (`profiles: [telemetry]` OTel Collector, Prometheus, Grafana, Loki), Tier 3 Stress Harness (`profiles: [stress]` `grafana/k6`). *(Dilarang auto-run `docker build`/`up` tanpa izin user).*
   - **Pilar 2: Fail-Fast Type-Safe Configuration:** `.env.example` bersih + validasi `envconfig`/`caarlos0/env` saat boot (wajib panic/log.Fatal sebelum `net.Listen` atau `sql.Open` jika env invalid).
   - **Pilar 3: Graceful Shutdown Protocol:** `signal.NotifyContext` menangkap `SIGINT`/`SIGTERM`, server `Shutdown(ctx)` dengan timeout 5-15s, `db.Close()`, serta OTel `tp.Shutdown(ctx)` dan logger sync.
   - **Pilar 4: Migration & Idempotent Seeder Baseline:** Folder `migrations/` (`golang-migrate`/`goose`) + `seed.sql` data inisial.
   - **Pilar 5: Unified Task Runner (`Makefile`):** Perintah baku `make dev` (air hot-reload), `make infra-up`/`down`, `make telemetry-up`, `make migrate`, `make seed`, `make test`, `make stress`.

## 🏛️ Brownfield Protocol (Legacy / Refactoring / Tambah Fitur di Repo Eksisting)

Saat user meminta **penambahan fitur baru, modifikasi, optimasi, atau audit** pada **codebase yang sudah ada (Legacy/Existing Project)**, DILARANG memaksakan *Big Bang Rewrite*, penciptaan "Frankenstein Codebase", atau pemakaian daftar subagent statis yang tidak relevan. Gunakan protokol **Dynamic Reconnaissance & Partitioning**:

1. **Intai & Pembelahan Subagent secara 100% Dinamis (Dynamic Hybrid Swarm):**
   Agen Utama DILARANG mematok nama atau jumlah peran subagent secara kaku. Pertama, lirik struktur direktori root dan dependency (`go.mod`/config) dari repository user. Setelah itu, spawn tim Subagent ber-model `pro` (dari 3 hingga >10 secara elastis) dengan strategi pembagian yang benar-benar selaras dengan kenyataan repo asli:
   - **Pembagian Berbasis Modul / Folder:** Jika project user dibagi menjadi beberapa modul/domain (misal: `/order`, `/user`, `/catalog`, `/payment`), spawn **1 Subagent Auditor terpisah untuk membedah masing-masing folder/modul**.
   - **Pembagian Berbasis Tech Stack di `go.mod`:** Jika mendeteksi library tertentu di `go.mod` (misal `gorm.io/gorm`, `kafka-go`, atau `graphql`), spawn subagent auditor dengan misi spesifik memburu kerentanan library tersebut (misal N+1 GORM Hunter, atau Kafka DLQ Auditor). Jika TIDAK ADA fitur finansial/uang, DILARANG memanggil spesialis fintech/moneter!
   - **Pembagian Berbasis Volume File:** Jika satu folder/package sangat padat (>30 file), pecah audit atas folder tersebut ke beberapa subagent berdasarkan sub-package atau fungsi eksekusi (misal: Subagent A fokus layer Handler/API, Subagent B fokus layer Query/Repository).
   - **Mastery Standard Matcher (Subagent Dedikatif):** Tugas subagent ini murni mengkonsolidasi seluruh laporan kecacatan dari para auditor di atas, lalu menarik dan membaca HANYA file di direktori `references/` kita yang **spesifik bisa menjadi obat pencerah untuk menyembuhkan temuan tersebut** (wajib membedah `zero_downtime_migrations.md` jika audit menemukan skema DB lama yang harus diubah).
2. **Zero-Steering Grilling (Opsi Evolusi / Penambahan Fitur):**
   Agen Utama merangkum laporan dari seluruh tim spesialis dan menyajikan ≥3 opsi netral beserta trade-off untuk user (Gasskan):
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
| Streaming Excel 1 Juta baris (`excelize`), govips JIT image, FFmpeg video HLS, chromedp PDF | `media_asset_pipeline/` |
| Katalog dinamis `x/text`, format uang/mata uang ICU, propagasi zona waktu Context, multi-region router | `i18n_localization/` |



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
| **Docker & DevOps** | `references/devops_control_planes/` | semua, termasuk `modular_3tier_container_topology.md` |
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
| Streaming Excel 1 Juta baris (`excelize`), govips JIT image resizing, FFmpeg video HLS, chromedp PDF | `references/media_asset_pipeline/` |
| Katalog terjemahan `x/text`, format mata uang & bilangan ICU, propagasi zona waktu Context, multi-region routing | `references/i18n_localization/` |

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
