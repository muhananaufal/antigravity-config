---
name: mastery-laravel
description: Gunakan skill ini ketika merancang arsitektur, API resources, Sanctum/Passport auth, Eloquent DB, Horizon, Reverb, Octane, Livewire/Inertia, Fintech/Cashier, AI Scout, Multi-Tenancy, microservices gRPC, AWS Vapor/Lambda cloud native, Caching L1/L2 CDN, Distributed Saga jobs, Zero-Trust security, atau testing di Laravel.
---

# Laravel Mastery (L8 Neutral Encyclopedia)

SSOT arsitektur & rekayasa Laravel enterprise, SaaS high-throughput, dan resilient cloud-native PHP (27 Domain, 136 File Mahakarya). Dokumen ini BUKAN sekadar tutorial SWE; ini adalah **Fakta Objektif Netral** yang memfasilitasi 5 POV Principal Roles (Architect, SWE, QA, DevOps, DBA).

## 👓 Matriks Lensa Principal (Multi-POV)

Gunakan *lensa* spesifik saat membaca file referensi di direktori ini, sesuai dengan peran Anda saat ini:

| Role Aktif | Lensa Fokus Utama di Ekosistem Laravel |
| :--- | :--- |
| **Architect** | Topologi Queue (Horizon/SQS), pola Modular Monolith/Hexagonal, *Event-Driven Pub/Sub*, dan isolasi *Microservices* via gRPC/Swoole. |
| **SWE** | Pola *FormRequest → Action → Model*, pencegahan *State Leak* di Octane, manajemen *Job $afterCommit*, dan arsitektur *Pest Arch Test*. |
| **DevOps** | *Serverless* AWS Vapor, orkestrasi FrankenPHP/Octane *non-root*, `opcache` JIT tuning, Prometheus *scraping*, dan *Zero-Downtime Deploy*. |
| **DBA** | Optimasi N+1 Eloquent (`->with()`), *Multi-Tenancy RLS* (Row-Level Security) per skema, migrasi basis data *zero-lock*, dan replikasi DB. |
| **QA (Red Team)** | *Pest Mutation Testing*, *Race Condition* di *Job Workers*, serangan *Mass Assignment* (`$fillable`), dan IDOR *bypassing* via *Model Binding*. |

## 🏛️ Pilar Arsitektur Mutlak

| Pilar | Hukumnya |
| :--- | :--- |
| **Tidak Ada Fire-and-Forget** | Proses PHP mati setelah response — tidak ada padanan `go func()`. Tugas asinkron sekecil apa pun WAJIB masuk Queue + Horizon. Menjalankannya "di belakang" bukan pilihan yang lambat, melainkan pilihan yang tidak ada. |
| **Lapisan Tegas** | `FormRequest → Controller → Action/Service → Repository → Model`. Controller hanya menerjemahkan HTTP; business logic DILARANG tinggal di sana. |
| **Query Selalu Berbatas** | `->with()` eager loading dan `->paginate()` di setiap listing. `->get()` telanjang berfungsi mulus sampai baris ke sejuta, lalu menghabiskan memori proses sekaligus. |
| **Octane Tidak Memaafkan State** | Properti `static` mutable dan singleton stateful bocor **antar-request** — kelas bug yang tidak pernah ada di php-fpm. Data satu pengguna sampai ke pengguna berikutnya. |
| **Transaksi Mendahului Job** | Job yang menyentuh data transaksi pemanggilnya WAJIB `$afterCommit`. Tanpa itu worker mengambil job sebelum commit dan gagal mencari baris yang belum ada. |

## 🚦 Protokol Eksekusi

Patuhi mutlak **Tabel Routing Task di `AGENTS.md` §2** untuk menentukan kapan harus membaca `references/_protocol/greenfield.md`, `brownfield.md`, atau `tradeoff.md`.
> **Pengecualian Mutlak:** Jika ini adalah proyek baru atau keputusan arsitektur besar, WAJIB lewati meta-decision (`~/.gemini/config/skills/meta-decision/SKILL.md`) terlebih dahulu sesuai `role-architect/SKILL.md` §1.5.

## 📦 Core References (WAJIB Baca Setiap Project Laravel)

Domain fondasi yang hampir selalu relevan, apa pun bentuk tasknya:

| Domain | Referensi | Cakupan |
| :--- | :--- | :--- |
| **Arsitektur Aplikasi** | `references/arch/` | Hexagonal, Modular Monolith, Service-Repository, IoC container & providers, CQRS, Event-Driven, Event Sourcing aggregate roots, Spatie Laravel Data |
| **Database & Eloquent** | `references/db/` | Eloquent relationships, query optimization, migrations, model observers & event subscribers, caching & replication, advanced patterns |
| **Lapisan API** | `references/api/` | Routing & versioning, API Resources formatting, error handling, HTTP kernel & middleware pipeline, webhooks, Spatie Query Builder, GraphQL Lighthouse, Precognition, BFF cookie-state gateway, endpoint testing |
| **Keamanan Aplikasi** | `references/security/` | Authentication, authorization blueprint, ACL, Spatie Permission roles, input validation, cryptography, file uploads, audit logging, API security |
| **Code Quality & Governance** | `references/code_quality_governance/` | Pint, PHPStan level 9, arsitektur berlapis, konvensi tim |
| **Testing Otomatis** | `references/testing_automated/` | Pest v3, feature/unit/arch test, factory & seeder, mocking |
| **DevOps & Deployment** | `references/devops_deployment/` | Docker Octane/FrankenPHP, CI/CD, zero-downtime deploy, health probe |
| **API Versioning & OpenAPI** | `references/api_versioning_openapi/` | `Route::prefix('api/v1')`, L5-Swagger/Scribe docs, backward compatibility |

## 🎯 Context References (Baca Sesuai Kebutuhan)

| Konteks / Keyword | Baca Referensi |
| :--- | :--- |
| Queue worker, Horizon, race condition, atomic lock, concurrency | `references/concurrency/` |
| Distributed Saga transaction rollback, Idempotency ledger, background workers | `references/background_jobs_saga/` |
| Octane state leak, opcache/JIT, memory footprint, internals PHP 8 | `references/php_runtime_internals/` |
| Repo lawas, migrasi bertahap, strangler fig, skema DB warisan | `references/legacy_refactoring/` |
| Service mesh, komunikasi antar-service, gRPC/HTTP internal, sidecar | `references/microservices_mesh/` |
| Caching L1 Octane RAM + L2 Redis, Cache Stampede dogpile protection | `references/caching_strategy_cdn/` |

## 🔍 Auto-Detect Niche Domain (Scan dari Task)

Agent WAJIB mencocokkan nature of task ke domain berikut **secara proaktif**:

| Jika task melibatkan... | Otomatis baca domain Niche |
| :--- | :--- |
| Inertia.js (Vue/React), Livewire v3, Alpine.js reactive state, PWA offline service workers | `references/inertia_livewire/` |
| SaaS Multi-Tenancy, database segregation per tenant, subdomain middleware routing guards | `references/multitenancy_saas/` |
| AI Integration, Laravel Scout Typesense search, Vector Embeddings, LLM Prompt pipelines | `references/ai_search_infra/` |
| Fintech, E-Commerce, Double-Entry financial ledgers, Stripe Cashier, Idempotent webhooks | `references/fintech_ecommerce/` |
| Spatial GIS PostGIS database, Timeseries metrics analytics, InfluxDB / TimescaleDB storage | `references/spatial_timeseries_db/` |
| Filament v3 Admin panel, Laravel Prompts CLI tools, Precognition real-time form validation | `references/ecosystem_firstparty/` |
| Spatie packages: Permission roles, Media Library, Query Builder, Spatie Data DTOs, Health probes | `references/ecosystem_extended/` |
| Real-time eventing, Reverb WebSockets Pub/Sub, Laravel Echo client, Server-Sent Events (SSE) | `references/realtime_eventing/` |
| AWS S3 presigned direct uploads, SQS/SNS event pub/sub, AWS Secrets Manager injection, Vapor serverless | `references/cloud_provider_aws_vapor/` |
| OWASP API Top 10 hardening, GDPR PII Tokenization vault, mTLS workload identity, SOC2 HMAC audit ledger | `references/zero_trust_enterprise_security/` |
| Prometheus / Grafana metrics scraping, Monolog ELK / Datadog non-blocking JSON pipeline, Sentry scrubbing | `references/observability_apm/` |
| Streaming Excel 1 Juta baris tanpa OOM (OpenSpout), libvips JIT Image resizing, FFmpeg video HLS transcoding | `references/media_asset_pipeline/` |
| Dynamic Redis translation bundles, ICU Intl timezone & currency formatting, Multi-Region SEO Hreflang routing | `references/i18n_localization/` |

## ✅ Terdesentralisasi Quality Gate (Per-Role)

**Gerbang Global (WAJIB bagi semua role yang mengubah kode/infrastruktur):**
```
powershell -NoProfile -ExecutionPolicy Bypass -File ~/.gemini/config/scripts/quality_gate.ps1 -Full
```

Sebagai agen otonom, WAJIB periksa bagian di bawah ini sesuai dengan peran aktif Anda. DILARANG mencentang tugas `[x]` bila gerbang *role* Anda belum terpenuhi secara spesifik.

### 🏛️ `[ ]` Gerbang Architect (PM)
- **Modularity:** Tidak ada *circular dependency* antar modul. Logika bisnis terisolasi dari Framework (Hexagonal/Action pattern).
- **Topology:** Semua *side-effect* asinkron wajib dideklarasikan ke dalam arsitektur antrean (Horizon/SQS), tidak ada *Fire-and-Forget*.
- **Observability:** Format log adalah Monolog JSON terstruktur dan metrik terekspos.

### ⚙️ `[ ]` Gerbang SWE
- **Lint & Types:** `./vendor/bin/phpstan analyse --level=9` (Nol Error) & `pint --test` (Lulus).
- **Test Suite:** `php artisan test` (Pest) lulus 100%, termasuk pengujian arsitektur (*Arch Test*).
- **State Leak:** Nol properti `static` mutable. Aplikasi kebal dari bug *State Leak* khas Octane/Swoole.
- **Job Integrity:** *Job* yang menyentuh data transaksi wajib mengimplementasikan `$afterCommit`.

### 🛡️ `[ ]` Gerbang QA (Red Team)
- **Mass Assignment:** Model dilindungi `$fillable`/`$guarded` ketat, tidak bisa diinjeksi via parameter liar.
- **IDOR Proof:** *Route model binding* divalidasi oleh *Policy/Gate* atau dibatasi lingkup relasinya.
- **Race Condition:** Antrean *Job* (*Workers*) tidak menabrak *database lock* secara *deadlock* di bawah tekanan tinggi.

### 🌩️ `[ ]` Gerbang DevOps
- **Distroless & Security:** Kontainer FrankenPHP/Octane berjalan murni sebagai `nonroot`. File konfigurasi seperti `.env` dan `tests/` masuk ke `.dockerignore`.
- **Graceful Shutdown:** *Worker Queue* merespons `SIGTERM` secara anggun tanpa memotong *job* di tengah jalan.
- **Health Checks:** *Endpoint* `/health` (Spatie Health) beroperasi akurat sebelum *Load Balancer* mengalirkan trafik.

### 🗄️ `[ ]` Gerbang DBA
- **N+1 Eradication:** Eager loading (`->with()`) dipastikan eksis pada setiap rute *listing*/koleksi.
- **Zero-Downtime Migration:** Migrasi DDL (*Data Definition Language*) dilakukan tanpa *table lock* berkepanjangan (misal: kolom baru `nullable`).
- **Memory Constraint:** `->paginate()` wajib dipakai untuk operasi data masif, dilarang menggunakan `->get()` telanjang yang berisiko OOM.
