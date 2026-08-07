# Blueprint Arsitektur Skill Bundle Skala Enterprise (Mahakarya Abadi)

Dokumen ini adalah cetak biru absolut—sebuah mahakarya abadi—untuk merancang, menyusun, dan mengembangkan ekosistem *Skill Bundle* skala enterprise di dalam lingkungan Antigravity. Arsitektur ini diadaptasi dari kesuksesan luar biasa "Holy Trinity" (Golang dengan 28 domain, Rust dengan 31 domain, dan Laravel dengan 26 domain). Kami tidak menerima arsitektur yang medioker, dangkal, atau tidak terstruktur. Setiap panduan di sini bersifat mutlak dan tidak boleh diabaikan.

## 1. Filosofi "Holy Trinity" dan Ekstrapolasi Universal

Keberhasilan pola ini membuktikan bahwa sebuah *Skill Bundle* tidak boleh diperlakukan sebagai sekadar kumpulan prompt teks biasa. Ini adalah mesin pendorong agen AI yang sangat terspesialisasi.

> **Catatan penamaan:** istilah "Holy Trinity" berasal dari masa ketika hanya ada tiga bundle
> bahasa. Sejak `nestjs-mastery` bergabung, ekosistem ini **kuartet**. Angka di bawah diverifikasi
> per 2026-08-07; jalankan `scripts/audit_references.ps1` untuk menghitung ulang — skrip itu
> memblokir bila klaim di `SKILL.md` menyimpang dari disk.

- **Golang (30 Domain, 221 File, 3.893 KB):** Mendominasi ranah konkurensi, arsitektur distributed system, cloud-native K8s operators, dan high-frequency trading.
- **Rust (34 Domain, 195 File, 1.257 KB):** Menguasai keamanan memori (borrow checker), eBPF, WebAssembly, komputasi presisi tinggi, CI/CD acceleration, dan Distroless multi-stage containers.
- **Laravel (27 Domain, 136 File, 2.075 KB):** Merajai produktivitas pengembangan web enterprise, arsitektur event-driven (Horizon/Reverb), SaaS multi-tenancy, dan monolithic modular.
- **NestJS (36 Domain, 139 File, 1.633 KB):** Menguasai Enterprise TypeScript — DI/IoC internals, Hexagonal Ports & Adapters, Fastify engine, GraphQL Federation, dan multi-tenancy RLS.

Pendekatan ini wajib dipetakan ulang untuk setiap bahasa/framework masa depan, seperti Python (AI/ML Pipeline, FastAPI Async, PyTorch internals), TypeScript (Strict Typing, Next.js App Router, NestJS Microservices, Bun/Deno runtimes), C++ (Low-Level Systems, Unreal Engine, HFT low-latency memory pools), hingga DevOps Kubernetes (Operator SDK, GitOps, Service Mesh, Terraform Infrastructure-as-Code).

## 2. Konvensi Struktur Direktori Standar Enterprise

Sebuah direktori Skill Bundle enterprise wajib memisahkan ranah **Core** (inti yang mutlak harus dibaca agen saat inisialisasi) dengan ranah **Niche** (domain spesifik yang hanya dimuat secara lazily/on-demand oleh subagent).

### Diagram ASCII: Struktur Direktori Emas ("The Holy Trinity Architecture")

```ascii
<nama-skill-bundle>-mastery/
├── SKILL.md                          [WAJIB] Gerbang utama, manifesto, aturan inti, dan tabel rute Swarm.
│                                     # CATATAN: bundle TIDAK punya scripts/ sendiri. Audit mutu
│                                     # referensi dijalankan terpusat dari repositori config:
│                                     #   scripts/audit_references.ps1 -Skill <nama-bundle>
│                                     # Lima salinan logika audit yang sama adalah utang
│                                     # pemeliharaan dan melanggar KISS (AGENTS.md section 6).
├── examples/                         [OPSIONAL] Referensi implementasi tingkat dewa (bukan hello world!).
│   ├── enterprise_hexagonal_arch/
│   └── domain_driven_design_saga/
├── resources/                        [OPSIONAL] Aset statis, skema DB, atau definisi protobuf gRPC.
└── references/                       [WAJIB] Ensiklopedia pengetahuan mendalam berspesifikasi Top 1%.
    ├── 01_core_arch_patterns/        [CORE] Arsitektur Clean/Hexagonal/Modular, DDD, & SOLID rules.
    ├── 02_db_persistence_orm/        [CORE] SQL tuning, N+1 query protection, Zero-Downtime Migrations.
    ├── 03_concurrency_runtime/       [CORE] Async/Await, goroutines/tokio, Worker pools, race protection.
    ├── 04_security_owasp_zerotrust/    [CORE] OWASP API Top 10, JWT/OIDC, mTLS, RBAC/ABAC policy.
    ├── 05_testing_quality_qa/        [CORE] Unit test harness, integration mocking, mutation & fuzz test.
    ├── 06_observability_apm_metrics/ [CORE] OpenTelemetry tracing, Prometheus RED, structured logs JSON.
    ├── 07_caching_strategy_cdn/      [CORE/NICHE] RAM L1 moka/octane, L2 Redis Valkey, stampede locks.
    ├── 08_docker_container_standards/ [CORE] Multi-stage Distroless, non-root execution, layer caching.
    ├── 09_ci_cd_pipeline_automation/ [NICHE] Fast test running, S3 cloud cache, cross-compilation, SBOM.
    ├── 10_i18n_localization_intl/     [NICHE] Unicode ICU4X, currency zero-copy formatting, dynamic SEO.
    └── ... <hingga 26 - 31 domain>   [NICHE] Dedikatif! Dipanggil via Dynamic Swarm berdasar auto-detect.
```

## 3. Aturan Tata Rasa Penamaan Ekosistem

Konsistensi adalah nyawa dari sebuah ekosistem. Aturan penamaan wajib mengikuti kaidah abadi berikut:
- **Nama Skill Bundle:** Menggunakan format `<teknologi>-mastery` atau `<domain>-engineering-mastery` (kebab-case). Contoh: `python-mastery`, `kubernetes-ops-mastery`, `devops-cloud-mastery`.
- **File Referensi Markdown:** Menggunakan `snake_case.md`, sangat deskriptif, lugas, dan bebas singkatan membingungkan. Jika menunjukkan struktur hierarki pengetahuan, disajikan dalam sub-folder penamaan jelas (misal: `references/<domain>/topic_name.md`).
- **Skrip Eksekusi:** Gunakan kata kerja imperatif + objek + ekstensi native shell (`.ps1` untuk PowerShell Windows, `.sh` untuk Bash Linux/macOS). Contoh: `audit_rust_supreme.ps1`, `verify_200_files.sh`.

## 4. Pemisahan Mutlak: Core vs Niche

Kegagalan terbesar dalam merancang agen AI adalah *Context Window Pollution* (memasukkan ribuan baris instruksi dari domain yang tidak relevan ke dalam prompt utama).
- **Ranah Core (Wajib Baca):** Berisi prinsip-prinsip arsitektur yang berlaku universal di seluruh proyek (misal: struktur logging, penanganan error & exception, injeksi dependensi, aturan keamanan OWASP Top 10, dan verifikasi CI). Agen induk maupun Subagent Core tetap harus menyerap materi ini.
- **Ranah Niche (Dedikatif & Situasional):** Berisi instruksi teknis sangat spesifik (misal: implementasi WebRTC real-time eventing, integrasi Stripe Cashier fintech ledger, custom LLM compiler AST, atau simulasi game engine). Ini HANYA boleh dipanggil melalui *Subagent Swarm* secara spesifik berdasarkan deteksi kebutuhan dari task user atau file manifest proyek (`go.mod`, `Cargo.toml`, `composer.json`).

## 5. Pemetaan Detail 31 Domain Standar Dunia (Template Universal)

Untuk memastikan kesejatian ekosistem Antigravity saat membangun skill baru (misalnya `python-mastery` atau `typescript-mastery`), berikut adalah tabel matriks pemetaan universal 31 domain yang siap diadaptasi:

| Rumpun Domain | Kode Domain | Deskripsi Pembahasan Mutlak di Dalam Referensi |
| :--- | :--- | :--- |
| **Core Systems** | `core_arch_patterns/` | Clean Architecture, Hexagonal Port & Adapters, Modular Monolith vs Microservices |
| **Core Systems** | `db_persistence_engine/` | Connection pooling, SQL index execution plan, Zero-downtime migrations, N+1 hunters |
| **Core Systems** | `concurrency_async_model/` | Async event loop, thread pool workers, mutex lock vs channel actors, cancellation safety |
| **Core Systems** | `security_owasp_zerotrust/`| OWASP Top 10 hardening, PII vaulting, JWT HMAC signatures, SOC2 compliance ledgers |
| **Core Systems** | `testing_qa_fuzzing/` | Property-based testing, LLVM libFuzzer/Afl++, snapshot AST asserting, E2E k6 SLA |
| **Core Systems** | `observability_apm_mesh/`| OTel correlation IDs, Prometheus RED metrics, Non-blocking ELK JSON logs, Sentry tracing |
| **Core Systems** | `devops_container_docker/` | Distroless multi-stage image <20MB, Non-root runtime UID 10001, OOM cgroup tuning |
| **Niche Scaling**| `caching_ram_redis_cdn/` | L1 thread-local RAM, L2 Redis Valkey clustering, Cache Stampede dogpile lock protection |
| **Niche Scaling**| `distributed_saga_outbox/` | Transactional Outbox pattern, Saga compensating rollback ledgers, DLQ replay handlers |
| **Niche Cloud**  | `cloud_native_k8s_operator/`| Custom Resource Definitions (CRDs), Reconciler controller loop, Admission webhooks RBAC |
| **Niche Cloud**  | `cloud_provider_serverless/` | AWS SDK direct integration, S3 range parallel reads, Lambda <10ms cold start strategies |
| **Niche Pipeline**| `ci_cd_release_pipeline/` | Nextest CI speedup, S3 remote build layer cache, Cross-compile targets, SBOM supply chain |
| **Niche Pipeline**| `media_asset_pipeline/` | Streaming 1 Juta baris Excel/CSV tanpa OOM, JIT image resizing (vips), FFmpeg video HLS |
| **Niche Locale** | `i18n_localization_intl/` | Unicode ICU engines, zero-copy formatting uang/timezone bebas sesat IEEE-754, Hreflang |
| **Niche Special**| `hft_zero_alloc_simd/` | Branch prediction CPU pipeline, SIMD vectorization intrinsics, Zero-copy byte slices |
| **Niche Special**| `ai_search_vector_infra/`| Vector database ONNX embedding pipeline, LLM prompt orchestration, semantic keyword indexing|
| **Niche Special**| `wasm_ebpf_systems/` | WebAssembly edge compute, eBPF XDP network interceptor, Sandbox execution security |

## 6. Template Skrip Scaffolder & Linter Konfigurasi Folder (Bash/PowerShell)

Berikut adalah contoh skrip otomatisasi riil yang wajib disertakan di dalam setiap direktori `scripts/` sebuah skill bundle baru untuk membuat kerangka direktori 31 domain secara presisi tanpa campur tangan manual:

```powershell
# generate_bundle_domains.ps1 — Generator Kerangka Domain Kasta Sultan
param([string]$SkillName = "python-mastery", [string]$Destination = "C:\Users\muhan\.gemini\config\skills")

$bundlePath = Join-Path -Path $Destination -ChildPath $SkillName
$refPath = Join-Path -Path $bundlePath -ChildPath "references"

$domains = @(
    "core_arch_patterns", "db_persistence_engine", "concurrency_async_model", 
    "security_owasp_zerotrust", "testing_qa_fuzzing", "observability_apm_mesh", 
    "devops_container_docker", "caching_ram_redis_cdn", "distributed_saga_outbox", 
    "cloud_native_k8s_operator", "cloud_provider_serverless", "ci_cd_release_pipeline", 
    "media_asset_pipeline", "i18n_localization_intl", "hft_zero_alloc_simd",
    "ai_search_vector_infra", "wasm_ebpf_systems", "realtime_eventing_pubsub",
    "fintech_ledger_payment", "multitenancy_saas_routing", "gui_desktop_ipc",
    "lockfree_atomic_structures", "cli_tooling_dashboard", "ast_metaprogramming_compiler",
    "blockchain_consensus_storage", "game_engine_simulation", "embedded_iot_edge",
    "advanced_networking_protocol", "legacy_refactoring_strangler", "custom_allocators_internals",
    "zero_downtime_operations"
)

Write-Host "🚀 Deploying $SkillName blueprint with $($domains.Count) domains..." -ForegroundColor Cyan
New-Item -Path $refPath -ItemType Directory -Force | Out-Null
New-Item -Path (Join-Path -Path $bundlePath -ChildPath "scripts") -ItemType Directory -Force | Out-Null

foreach ($d in $domains) {
    $dir = Join-Path -Path $refPath -ChildPath $d
    New-Item -Path $dir -ItemType Directory -Force | Out-Null
    Write-Host " ✅ Created domain: references/$d" -ForegroundColor Green
}
Write-Host "🏆 Architecture deploy successfully completed!" -ForegroundColor Yellow
```

## 7. Anti-Patterns Kritis (Zero-Tolerance Rules)

Berikut adalah kesalahan fatal yang dilarang keras dan melanggar hukum rekayasa di Antigravity:

❌ **Anti-Pattern 1: God File (SKILL.md Raksasa Tanpa Rute)**
*   **Salah (❌):** Menaruh 5.000 baris instruksi untuk 31 domain berbeda secara tumpang tindih ke dalam satu file `SKILL.md`. Ini membebani memori jangka pendek LLM, memicu *attention sink*, dan menyebabkan AI berhalusinasi atau melupakan instruksi kritis di bagian tengah.
*   **Benar (✅):** `SKILL.md` dibiarkan ramah token (~120–160 baris), hanya memadai manifesto *Core Protocol*, panduan *Swarm Dispatcher Routing*, tabel Auto-Detect Niche, dan resep verifikasi terminal. Seluruh materi detail teknis dipecah merata ke direktori `references/`.

❌ **Anti-Pattern 2: File Stubs Tipis & Pemalas**
*   **Salah (❌):** Membuat file referensi seperti `references/<domain>/topic.md` yang hanya berisi 18 baris narasi pendek "Gunakan library X dan pastikan koneksi stabil." Ini adalah sampah digital yang merugikan.
*   **Benar (✅):** File referensi harus berbobot dan padat (>130 baris), membedah internal arsitektur, diagram ASCII, *Connection Lifetime*, *Heartbeat Ping/Pong*, pencegahan *Memory Leaks di Goroutine/Event Loop*, *Horizontal Scaling dengan Redis Pub/Sub*, dan contoh implementasi kode produksi lengkap yang bebas dari tulisan `// TODO`.

## 8. Production Edge Cases

Arsitektur skill bundle ini dirancang tahan banting menghadapi situasi lapangan terberat:

### 1. Edge Case 1: Polyglot Monorepo Gila
*   **Kondisi:** Repositori proyek user adalah monorepo raksasa berisi backend Golang (`/backend-api`), frontend TypeScript Next.js (`/web-portal`), dan intelligent microservices Python (`/ml-engine`).
*   **Penanganan:** Agen Utama dilarang memuat seluruh skill secara buta. Agen wajib mengeksekusi skrip pemindaian per-direktori, lalu membelah tim Subagent Swarm yang terikat secara spesifik pada masing-masing *sub-directory* dengan konteks terisolasi. Agen Utama bertindak sebagai jenderal konsolidasi laporan silang domain.

### 2. Edge Case 2: Batas Kuota Token Model (Context Window Limit Hit)
*   **Kondisi:** Proyek melibatkan pembedahan >200 file referensi dan pembacaan seluruh teks referensi secara serentak akan menembus batas kuota token model utama.
*   **Penanganan:** Terapkan teknik *Progressive Disclosure & Parallel Partitioning*. Agen Utama mengutus tim Subagent bermodel `pro` ke ruang percakapan yang terpisah secara asinkron. Masing-masing Subagent bertugas membaca 2-4 file spesifik, merangkum intisari kodenya, dan memberikan esensi presisi kepada Parent Agent tanpa memicu kebocoran konteks.

### 3. Edge Case 3: Proyek Legacy Tanpa Standar (Spaghetti Code / Brownfield Hazard)
*   **Kondisi:** Mengimplementasikan standar arsitektur Clean/Hexagonal pada repositori kuno tanpa aturan jelas. Menghidupkan seluruh aturan linter secara serentak akan meledakkanribuan *error terminal* yang menakutkan developer asli.
*   **Penanganan:** DILARANG MEMAKSAKAN *BIG BANG REWRITE*! Terapkan resep *Strangler Fig Pattern* atau *Native Consistent Extension*. Subagent auditor menanamkan isolasi pada modul baru agar 100% patuh standar Top 1%, sementara modul lama dijaga kesetiaan antarmukanya melalui proxy/facade hingga operasi bedah refactoring disetujui user.
