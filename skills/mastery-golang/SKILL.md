---
name: mastery-golang
description: Gunakan skill ini ketika merancang arsitektur, konkurensi, DB/SQLC, gRPC, HFT, testing, security, distributed systems, K8s Operators, Linux Systems Programming, atau runtime internals di Golang.
---

# Golang Mastery (L8 Neutral Encyclopedia)

SSOT arsitektur & rekayasa sistem Golang enterprise & high-throughput (30 Domain, 221 File Mahakarya). Dokumen ini BUKAN sekadar tutorial SWE; ini adalah **Fakta Objektif Netral** yang memfasilitasi 5 POV Principal Roles (Architect, SWE, QA, DevOps, DBA).

## 👓 Matriks Lensa Principal (Multi-POV)

Gunakan *lensa* spesifik saat membaca file referensi di direktori ini, sesuai dengan peran Anda saat ini:

| Role Aktif | Lensa Fokus Utama di Ekosistem Golang |
| :--- | :--- |
| **Architect** | Batasan antar *package* (`internal/`), stabilitas antarmuka, kontrak gRPC (`.proto`), dan propagasi *Distributed Tracing* (OpenTelemetry). |
| **SWE** | *Mechanical Sympathy* (alokasi memori, escape analysis), manajemen *goroutine* berpemilik, mitigasi *Data Race*, dan struktur *Clean Architecture*. |
| **DevOps** | *Graceful shutdown* (`SIGTERM`), penyetelan `GOMEMLIMIT` & `GOGC`, probe K8s, metrik Prometheus, dan *build distroless* tanpa CGO. |
| **DBA** | Tuning *Connection Pool* (`SetMaxOpenConns`, `SetConnMaxLifetime`), isolasi transaksi SQLC, tipe data JSONB, dan manajemen *lock* DB via Go. |
| **QA (Red Team)** | *Fuzzing* target API (mencari *unhandled panic*), eksploitasi celah konkurensi (memanipulasi *race condition* HTTP), pengujian batas *timeout* `context`. |

## 🏛️ Pilar Arsitektur Mutlak

| Pilar | Hukumnya |
| :--- | :--- |
| **Konkurensi Berpemilik** | Setiap `go func()` WAJIB punya pemilik yang jelas: `context.Context` untuk pembatalan, `sync.WaitGroup` atau channel untuk penantian, dan `defer recover()`. Goroutine tanpa jalan keluar adalah kebocoran, bukan konkurensi. |
| **Durabilitas Bukan Goroutine** | `go func()` memberi NOL durabilitas. Tugas yang tidak boleh hilang (email, invoice, mutasi saldo) WAJIB masuk queue durabel — Asynq atau River. |
| **Batas Paket Tegas** | `DTO → Handler → Service → Repository`. Business logic DILARANG hidup di Handler, dan Repository DILARANG tahu soal HTTP. |
| **Error Bertipe** | Sentinel error + `%w` wrapping + `errors.As`. `if err != nil { return err }` tanpa konteks adalah ritual kosong yang menghapus jejak. |
| **Timeout di Setiap Batas** | Tidak ada panggilan DB, Redis, gRPC, atau HTTP tanpa `context.WithTimeout`. Satu dependensi lambat menghabiskan pool dan menjatuhkan seluruh layanan. |

## 🚦 Protokol Eksekusi

Patuhi mutlak **Tabel Routing Task di `AGENTS.md` §2** untuk menentukan kapan harus membaca `references/_protocol/greenfield.md`, `brownfield.md`, atau `tradeoff.md`.
> **Pengecualian Mutlak:** Jika ini adalah proyek baru atau keputusan arsitektur besar, WAJIB lewati meta-decision (`~/.gemini/config/skills/meta-decision/SKILL.md`) terlebih dahulu sesuai `role-architect/SKILL.md` §1.5.

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
| Raft, etcd, LSM, WAL, gossip, vector clock, BadgerDB | `references/distributed_consensus_storage/` |
| Payment, ledger, decimal, ISO 20022, PCI-DSS, reconciliation, ClickHouse | `references/fintech_reliability/` |
| WebSocket, Kafka, NATS, eBPF, TCP, binary protocol | `references/realtime_networking/` |
| Zero-alloc, HFT, lock-free ring buffer, SIMD, CPU cache, FIX parser | `references/hft_zero_alloc/` |
| epoll, cgroups, seccomp, inotify, Unix socket, POSIX signal | `references/system_programming_linux/` |
| K8s Operator, CRD, admission webhook, client-go informer, Helm | `references/cloud_native_k8s_operators/` |
| QUIC, WireGuard, MQTT, ConnectRPC, DNS, SOCKS5 | `references/advanced_networking_protocols/` |
| SPIFFE, OPA, cosign, SBOM, Vault rotation, fuzzing | `references/cybersecurity_zerotrust/` |
| AST, custom linter, code gen, WASM plugin, protoc plugin | `references/ast_metaprogramming/` |
| CLI, subcommand, flag parsing, TUI, distribusi biner, `--version` | `references/cli_tooling/` |
| TinyGo, GPIO, I2C/SPI, edge MQTT, WASM browser | `references/embedded_tinygo/` |
| Game server, tick loop, spatial hash, dead reckoning, leaderboard | `references/game_backend/` |
| HNSW, LLM proxy, Apache Arrow, DataFusion, pgvector, ONNX | `references/ai_data_infra/` |
| GitHub Actions, GitLab CI, GoReleaser, security scan CI, blue/green deploy, monorepo | `references/ci_cd_pipeline/` |
| AWS SDK v2 (S3/SQS/DynamoDB), GCP client, Lambda, Secrets Manager, SNS fanout | `references/cloud_provider_sdk/` |
| Streaming Excel 1 Juta baris (`excelize`), govips JIT image resizing, FFmpeg video HLS, chromedp PDF | `references/media_asset_pipeline/` |
| Katalog terjemahan `x/text`, format mata uang & bilangan ICU, propagasi zona waktu Context, multi-region routing | `references/i18n_localization/` |

---

## ✅ Terdesentralisasi Quality Gate (Per-Role)

**Gerbang Global (WAJIB bagi semua role yang mengubah kode/infrastruktur):**
```
powershell -NoProfile -ExecutionPolicy Bypass -File ~/.gemini/config/scripts/quality_gate.ps1 -Full
```

Sebagai agen otonom, WAJIB periksa bagian di bawah ini sesuai dengan peran aktif Anda. DILARANG mencentang tugas `[x]` bila gerbang *role* Anda belum terpenuhi secara spesifik.

### 🏛️ `[ ]` Gerbang Architect (PM)
- **Modularity:** Tidak ada *circular dependency*. Bisnis logic terisolasi murni di `internal/`.
- **API Contract:** OpenAPI spec (`swaggo`/`ogen`) atau kontrak gRPC (`.proto`) disepakati *sebelum* eksekusi.
- **Traceability:** Correlation ID (`X-Request-ID`) masuk ke *context* dan dipropagasi ke sistem hilir.

### ⚙️ `[ ]` Gerbang SWE
- **Data Race:** `go test -race ./...` wajib lulus 100%.
- **Goroutine Leak:** Semua `go func()` harus dilindungi `defer recover()` dan terikat `context.Context`.
- **Type-Safety:** Menggunakan `errors.As` dan *Sentinel Error*, tidak menggunakan `any` tanpa validasi.
- **Resilience:** Semua *external call* ke DB/Redis/HTTP API wajib memakai `context.WithTimeout`.

### 🛡️ `[ ]` Gerbang QA (Red Team)
- **Fuzzing Tuntas:** API menerima *dirty input* (tipe data aneh, JSON bersarang) tanpa mengalami *panic* 500.
- **Race Attack Meleset:** Menguji *endpoint* modifikasi (*checkout/payment*) dengan konkurensi brutal (100 request/detik) -> sistem harus merespons 429 atau 409 Conflict, bukan *double-spend*.

### 🌩️ `[ ]` Gerbang DevOps
- **Distroless & Security:** *Multi-stage build* ke `distroless` (atau `scratch`) dengan `CGO_ENABLED=0`. Kontainer berjalan sebagai `nonroot`.
- **Resource Aware:** Variabel `GOMEMLIMIT` selaras dengan *Memory Limit* Kubernetes.
- **Graceful Shutdown:** Aplikasi menangkap `SIGTERM` dan menunggu maksimal N detik sebelum membunuh koneksi. Liveness/Readiness probe akurat merujuk `/health`.

### 🗄️ `[ ]` Gerbang DBA
- **Pool Tuning:** `SetMaxOpenConns`, `SetMaxIdleConns`, dan `SetConnMaxLifetime` terkonfigurasi non-default (menghindari penumpukan *idle connection* di DB).
- **Zero-Downtime:** Semua skema migrasi tidak memiliki operasi *locking* tabel berat (misal `DROP` kolom berbarengan di DB besar).
- **Index Plan:** Query SQL yang dibuat SWE telah dipastikan aman lewat `EXPLAIN ANALYZE` (menghindari `Seq Scan`).
