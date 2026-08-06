---
name: golang-mastery
description: Gunakan skill ini ketika merancang arsitektur, konkurensi, DB/SQLC, gRPC, HFT, testing, security, distributed systems, K8s Operators, Linux Systems Programming, atau runtime internals di Golang.
---

# Golang Mastery

SSOT arsitektur & rekayasa sistem Golang enterprise & high-throughput (30 Domain, 221 File Mahakarya).

## 🚦 Protokol Eksekusi (WAJIB dibaca sesuai situasi)

> **SEBELUM membuka tabel di bawah:** Jika ini adalah proyek baru atau keputusan arsitektur besar, WAJIB lewati `master_decision_tree.md` (`~/.gemini/config/skills/master-decision-tree/SKILL.md`) terlebih dahulu. DILARANG langsung memilih Go sebagai stack tanpa justifikasi dari Decision Tree.

| Situasi | WAJIB baca dulu sebelum menulis apa pun |
| :--- | :--- |
| Inisiasi project baru dari nol (empty folder / new repository) | `references/_protocol/greenfield.md` |
| Tambah fitur / modifikasi / optimasi / audit di repo eksisting | `references/_protocol/brownfield.md` |

DILARANG membuat dokumen RFC (`docs/rfc/`) atau menulis kode sebelum protokol yang relevan dibaca tuntas.

## 🔍 Auto-Detect Context Domain (Scan dari Task)

Agent WAJIB mencocokkan nature of task ke domain berikut **secara proaktif**:

| Jika task melibatkan... | Otomatis baca |
| :--- | :--- |
| Payment, transaksi, ledger, refund, wallet, checkout | `fintech_reliability/` |
| Kafka, NATS, WebSocket, real-time, event stream, pub/sub | `realtime_networking/` |
| AWS, GCP, S3, Lambda, SQS, Secrets Manager, cloud | `cloud_provider_sdk/` |
| K8s, Helm, CRD, Operator, cluster, pod, deployment manifest | `cloud_native_k8s_operators/` |
| CI/CD, GitHub Actions, GitLab CI, release, deploy pipeline | `ci_cd_pipeline/` |
| Saga, outbox, CQRS, event sourcing, distributed tx | `distributed_patterns_resilience/` (full) |
| Performance, profiling, pprof, GC pressure, memory leak | `runtime_internals/` |
| Search, vector, AI/ML inference, embedding, ONNX | `ai_data_infra/` |
| Low-latency, HFT, zero-alloc, matching engine, order book | `hft_zero_alloc/` |
| Linux syscall, epoll, cgroups, seccomp, raw socket | `system_programming_linux/` |
| Security audit, zero-trust, OPA, SPIFFE, cosign, SBOM | `cybersecurity_zerotrust/` |
| CLI, subcommand, flag, TUI, distribusi biner, `--version` | `cli_tooling/` |
| Code generation, AST, linter custom, WASM plugin | `ast_metaprogramming/` |
| Game server, multiplayer, tick loop, leaderboard | `game_backend/` |
| Distributed consensus, Raft, etcd, WAL, BadgerDB | `distributed_consensus_storage/` |
| IoT, embedded, TinyGo, GPIO, edge device | `embedded_tinygo/` |
| QUIC, WireGuard, DNS, MQTT, raw TCP protocol | `advanced_networking_protocols/` |
| Streaming Excel 1 Juta baris (`excelize`), govips JIT image, FFmpeg video HLS, chromedp PDF | `media_asset_pipeline/` |
| Katalog dinamis `x/text`, format uang/mata uang ICU, propagasi zona waktu Context, multi-region router | `i18n_localization/` |
| Insiden, postmortem, on-call, SLO, error budget, ADR, design doc, standar code review | `engineering_practice/` |
| Login, SSO, OAuth2, OIDC, CORS, CSRF, CSP, session cookie | `security_owasp/` |

## 📦 Core References (WAJIB Baca Setiap Project)

Domain yang hampir selalu relevan untuk Go service manapun:

| Domain | Referensi | File Spesifik |
| :--- | :--- | :--- |
| **Concurrency** | `references/concurrency/` | semua |
| **DB & Cache** | `references/db_sqlc/` | semua |
| **API & gRPC** | `references/microservices_grpc/` | semua |
| **Observability** | `references/observability_resilience/` | semua |
| **Security** | `references/security_owasp/` | semua |
| **Testing** | `references/testing_quality/` | semua |
| **Background Jobs** | `references/background_jobs_worker/` | semua |
| **Caching Strategy** | `references/caching_strategy/` | semua |
| **Architecture** | `references/arch_patterns/` | semua |
| **Docker & Deploy** | `references/devops_control_planes/` | `docker_container_go.md`, `kubernetes_deployment_go.md`, `modular_3tier_container_topology.md` |
| **Resilience Patterns** | `references/distributed_patterns_resilience/` | `retry_backoff_jitter.md`, `idempotency_key_engine.md`, `bulkhead_isolation.md` |
| **Caching** | `references/caching_strategy/` | `cache_aside_singleflight.md`, `multilevel_cache_l1l2.md` |

---

## 🎯 Context References (Baca Sesuai Kebutuhan)

| Konteks / Keyword | Baca Referensi |
| :--- | :--- |
| Menetapkan SLO, error budget, burn-rate alert, keputusan paging | `references/engineering_practice/slo_error_budget.md` |
| Keputusan arsitektur yang perlu dicatat & dipertahankan | `references/engineering_practice/adr_decision_records.md` |
| Insiden produksi, postmortem, severity, MTTD/MTTM, on-call | `references/engineering_practice/incident_postmortem.md` |
| Melakukan code review, menyusun standar review, linter kustom tim | `references/engineering_practice/code_review_go.md` |
| Menulis design doc / RFC fitur besar sebelum implementasi | `references/engineering_practice/technical_design_doc.md` |
| Merancang error: sentinel vs tipe, `%w`, memetakan galat ke status, klasifikasi retry | `references/arch_patterns/error_handling_strategy.md` |
| Pagination, cursor vs offset, halaman dalam lambat, item terlewat/ganda | `references/microservices_grpc/pagination_patterns.md` |
| Profiling berkelanjutan, membandingkan profil, label pprof, "baris kode mana" | `references/observability_resilience/continuous_profiling.md` |
| Manifest K8s Go: `GOMEMLIMIT`, throttling CPU, probe, PDB, HPA, grace period | `references/devops_control_planes/kubernetes_deployment_go.md` |
| IaC lanjutan: Crossplane, provider Terraform, CNI plugin, GitOps, Backstage | `references/devops_control_planes/` |
| Login SSO, authorization code + PKCE, verifikasi ID token, refresh token | `references/security_owasp/oauth2_oidc_flow.md` |
| CORS, preflight, CSRF, `SameSite`, CSP, HSTS, header keamanan respons | `references/security_owasp/web_security_headers.md` |
| Query lambat, membaca `EXPLAIN ANALYZE`, memilih index komposit, `Seq Scan` | `references/db_sqlc/index_design_explain_analyze.md` |
| Read replica, replication lag, read-after-write, routing baca/tulis | `references/db_sqlc/read_replica_routing.md` |
| Sharding, shard key, partisi tabel, fan-out query, rebalancing | `references/db_sqlc/sharding_partitioning.md` |
| Test konkurensi rapuh, `time.Sleep` di test, deadlock menggantung di CI | `references/testing_quality/synctest_deterministic_concurrency.md` |
| Streaming data besar tanpa materialisasi, iterator kustom, `iter.Seq` | `references/runtime_internals/iterators_range_over_func.md` |
| Perbaikan performa dari profil produksi tanpa mengubah kode | `references/runtime_internals/pgo_profile_guided_optimization.md` |
| Menghapus berkas `utils`, interning string, cache yang tidak menahan memori | `references/runtime_internals/stdlib_modern_slices_maps_sync.md` |
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
