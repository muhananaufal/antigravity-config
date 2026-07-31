---
name: golang-mastery
description: Gunakan skill ini ketika merancang arsitektur, konkurensi, DB/SQLC, gRPC, HFT, testing, security, distributed systems, K8s Operators, Linux Systems Programming, atau runtime internals di Golang.
---

# Golang Mastery

SSOT arsitektur & rekayasa sistem Golang enterprise & high-throughput.

## 🔁 Protocol & Routing Table

**Core Protocol:**
1. WAJIB `view_file` SELURUH file referensi di `references/<domain>/` yang relevan — DILARANG mengarang dari hafalan LLM.
2. WAJIB sajikan minimal 2-3 opsi netral + trade-off saat Grilling — DILARANG langsung rekomendasikan 1 opsi.

**Go-Specific Quality Gate:**
3. WAJIB `go test -race ./...` — buktikan bebas data race sebelum lapor selesai.
4. WAJIB `golangci-lint run` — zero lint error sebelum merge.
5. WAJIB unit test `_test.go` pada modul bisnis utama (Auth, Payment, Order State Machine).
6. WAJIB Clean Architecture: **DTO → Handler → Service → Repository**. DILARANG logika bisnis di Handler.
7. WAJIB Strongly-Typed Error: `errors.As` / Sentinel Errors. DILARANG return `nil` tanpa konteks error.
8. WAJIB Graceful Shutdown: `os.Signal` + `context.WithCancel` + drain DB/Redis sebelum exit.
9. WAJIB validasi & sanitasi payload masuk sebelum menyentuh layer Service/DB (`go-playground/validator`).
10. WAJIB `context.WithTimeout` pada SEMUA panggilan DB, Redis, gRPC, HTTP Client — DILARANG `context.Background()` di execution path.
11. WAJIB `defer recover()` pada setiap goroutine baru yang di-spawn — DILARANG unhandled panic.
12. WAJIB `SetMaxOpenConns` / `SetMaxIdleConns` / `SetConnMaxLifetime` — DILARANG default pool tanpa batas.
13. WAJIB `sync.Pool` reset buffer (`b.Reset()` + cap check ≤ 64KB) sebelum dikembalikan ke pool.

**API & System Design:**
14. WAJIB prefix versi API (`/api/v1/`) + Pagination (cursor/offset) pada semua list endpoint.
15. WAJIB Idempotency Key (Redis/DB) pada POST yang mutate state — cegah double-processing.
16. WAJIB OpenAPI spec (`swaggo`/`ogen`) sejak awal, bukan afterthought.
17. WAJIB Correlation ID (`X-Request-ID`) propagasi ke semua downstream + log entries.
18. WAJIB Health Check (`/health`) + Readiness Probe (`/ready`) pada setiap service.
19. WAJIB Backward Compatibility — breaking change harus versi baru (`v2`), bukan patch di versi yang sama.
20. WAJIB Zero-Downtime Migration — kolom baru `nullable`, DILARANG rename/drop langsung.

**Observability & Security:**
21. WAJIB RED Metrics (Rate/Error/Duration) + OpenTelemetry distributed tracing per service.
22. WAJIB Structured Logging (`zerolog`/`slog`) — DILARANG log struct berisi token/password/PII secara raw.
23. WAJIB Circuit Breaker + timeout + retry pada semua external service calls.
24. WAJIB Rate Limiting pada endpoint publik (auth, register, reset password).
25. WAJIB OWASP Checklist: SQL Injection, IDOR, Mass Assignment, Broken Auth — eksplisit sebelum selesai.
26. WAJIB audit N+1 Query di setiap loop DB. Gunakan batch query atau eager loading.
27. WAJIB p99 < 200ms SLA — verifikasi dengan `go test -bench` sebelum deploy.

| Topik Task | Domain Referensi |
| :--- | :--- |
| GMP scheduler, work-stealing, SIGURG preemption, memory allocator (mcache/mcentral/mheap), GC tri-color, escape analysis, generics GC-shape stenciling, CGO ABI, goroutine stack growth, PGO build | `references/runtime_internals/` |
| Goroutine leak detection (`goleak`), channel fan-out/fan-in, sync primitives (Mutex/RWMutex/Pool/Once), context timeout/cancellation, atomic lock-free, errgroup, singleflight, distributed Redis lock, race detector | `references/concurrency/` |
| sqlc + pgx/v5, ACID isolation levels, pessimistic/optimistic locking, advisory locks, zero-downtime migration, multi-layer cache (L1/L2/L3), N+1 query, connection pool tuning, TimescaleDB | `references/db_sqlc/` |
| gRPC protobuf patterns, interceptor chaining, bidirectional streaming, Chi middleware stack, GraphQL gqlgen + dataloader, API versioning, service mesh LB, webhook HMAC, OpenAPI ogen | `references/microservices_grpc/` |
| Zero-allocation patterns (sync.Pool), limit orderbook matching, SIMD assembly Plan9, memory arena, lock-free ring buffer, CPU cache alignment, zero-copy sendfile/splice, FIX feed parser | `references/hft_zero_alloc/` |
| OpenTelemetry tracing + OTLP, Prometheus RED metrics, zerolog structured logging, circuit breaker (gobreaker), graceful shutdown drain, token bucket rate limiting, health check, baggage propagation | `references/observability_resilience/` |
| OWASP input validation, JWT dual-token RS256, Casbin RBAC/ABAC, AES-256-GCM, Argon2id, audit log HMAC chain, mTLS + SPIFFE, HashiCorp Vault dynamic secrets | `references/security_owasp/` |
| testify table-driven tests, gomock/moq interface mocking, testcontainers-go, benchmarking + pprof, native Go fuzzing, govulncheck + gosec, property-based testing (rapid), E2E httptest | `references/testing_quality/` |
| Saga orchestration/choreography, transactional outbox, consistent hashing ring, idempotency key engine, multi-tenancy RLS, Temporal workflow, CQRS + event sourcing, feature flags | `references/distributed_patterns_resilience/` |
| Raft consensus (hashicorp/raft), LSM pebble, WAL CRC32 + group commit, etcd client watches/leases, gossip memberlist, vector clocks + HLC, groupcache, BadgerDB | `references/distributed_consensus_storage/` |
| Double-entry ledger, decimal arithmetic (shopspring), payment idempotency, ISO 20022/SWIFT, PCI-DSS tokenization (FPE), reconciliation engine, pricing rule engine, ClickHouse OLAP | `references/fintech_reliability/` |
| WebSocket gnet/epoll, eBPF cilium-go XDP/TC, custom binary protocol framing, raw sockets gopacket, Kafka EOS + DLQ, TCP socket options, NATS JetStream pull consumer | `references/realtime_networking/` |
| epoll non-blocking via `golang.org/x/sys/unix`, cgroups v2 + namespaces, seccomp BPF, inotify fsnotify, Unix domain socket SCM_RIGHTS, exec subprocess, POSIX signal handling | `references/system_programming_linux/` |
| controller-runtime Reconciler, CRD kubebuilder markers, admission webhooks (CustomValidator/CustomDefaulter), client-go SharedInformer + WorkQueue, OLM CSV, Helm chart Go testing | `references/cloud_native_k8s_operators/` |
| QUIC/HTTP3 quic-go, WireGuard userspace wgctrl, NATS cluster JetStream R=3, MQTT paho + mochi-broker, ConnectRPC tri-protocol, miekg/dns, SOCKS5 proxy | `references/advanced_networking_protocols/` |
| Clean hexagonal architecture, DDD aggregate/repository, CQRS event store PostgreSQL, modular monolith `internal/`, event-driven watermill, dependency injection wire/fx | `references/arch_patterns/` |
| go/ast traversal, custom linter `analysis.Analyzer`, code gen text/template + go/format, wazero WASM plugin, reflect.StructOf dynamic struct, protoc plugin protogen | `references/ast_metaprogramming/` |
| SPIFFE/SPIRE workload identity, OPA rego policy engine, cosign keyless signing + SBOM, network CVE scanning, Vault secrets rotation, security fuzzing | `references/cybersecurity_zerotrust/` |
| Custom Terraform provider (plugin-framework), Kubernetes CNI plugin netlink, Flux GitOps source-controller, Backstage catalog module, Crossplane composition upjet | `references/devops_control_planes/` |
| TinyGo target boards + machine package, GPIO interrupt PWM ADC, I2C/SPI peripheral driver, MQTT edge QoS, TinyGo WASM + syscall/js DOM | `references/embedded_tinygo/` |
| Authoritative game server UDP, fixed-timestep tick loop, spatial hash grid + quadtree, snapshot interpolation + dead reckoning, Redis session state + leaderboard ZADD | `references/game_backend/` |
| HNSW vector search, LLM proxy SSE streaming + tiktoken, Apache Arrow RecordBatch, DataFusion CGO FFI, watermill stream pipeline, ONNX embedding, pgvector hybrid search | `references/ai_data_infra/` |
