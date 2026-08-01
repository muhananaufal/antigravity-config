---
name: laravel-mastery
description: Gunakan skill ini ketika merancang arsitektur, API resources, Sanctum/Passport auth, Eloquent DB, Horizon, Reverb, Octane, Livewire/Inertia, Fintech/Cashier, AI Scout, Multi-Tenancy, microservices gRPC, AWS Vapor/Lambda cloud native, Caching L1/L2 CDN, Distributed Saga jobs, Zero-Trust security, atau testing di Laravel.
---

# Laravel Mastery

SSOT arsitektur & rekayasa Laravel enterprise, SaaS high-throughput, dan resilient cloud-native PHP (26 Domain, 130 File Mahakarya).

## 🔁 Greenfield Protocol (Init Proyek dari Nol — Dynamic Swarm Scaling)

LLM secara alami akan mengambil jalan pintas (laziness) dan berisiko memicu hutang teknis seperti *N+1 query*, struktur *Fat Controller*, dan *State Leak* di Laravel Octane jika disuruh membaca puluhan file secara sekuensial. Untuk menjamin standar Top 1% diterapkan 100% tanpa halusinasi, **WAJIB gunakan protokol Dynamic Swarm Subagent (Elastis)** saat inisialisasi **project baru dari nol (empty folder / new repository / composer create-project)**:

1. **Fase Inisialisasi (DILARANG MENEBAK / HALUSINASI):** Saat user meminta inisiasi project baru, Agen Utama DILARANG langsung menulis kode atau membuat `implementation_plan.md` tanpa konsultasi referensi.
2. **Dynamic Swarm Summon (`pro` tier):** Agen Utama WAJIB memanggil `invoke_subagent` untuk men-spawn minimal 3 hingga >8 subagent secara paralel sesuai kompleksitas proyek (Dynamic Scaling):
   - **3 Subagent Core Tetap (Mandatory Core Coverage):**
     - **Subagent 1 (Arch, DB, Caching & Cloud DevOps Core):** Wajib `view_file` ke SEMUA file di `references/arch/`, `references/db/`, `references/caching_strategy_cdn/`, `references/devops_deployment/`, `references/cloud_provider_aws_vapor/`, dan `references/legacy_refactoring/`.
     - **Subagent 2 (API, Concurrency, Saga & Governance Core):** Wajib `view_file` ke SEMUA file di `references/api/`, `references/concurrency/`, `references/background_jobs_saga/`, `references/testing_automated/`, dan `references/code_quality_governance/`.
     - **Subagent 3 (Runtime, Observability & Security Core):** Wajib `view_file` ke SEMUA file di `references/php_runtime_internals/`, `references/observability_apm/`, `references/security/`, `references/zero_trust_enterprise_security/`, dan `references/microservices_mesh/`.
   - **Subagent Niche DINAMIS (1 Subagent per Domain Terdeteksi):** 
     - Agen utama mengecek tabel **Auto-Detect Niche Domain** di bawah. Untuk **SETIAP 1 domain niche** yang cocok dengan proyek (misal: `fintech_ecommerce/`, `inertia_livewire/`, `multitenancy_saas/`), WAJIB spawn **1 Subagent Dedikatif terpisah**. (Jika terdeteksi 3 domain niche, maka summon 3 Core + 3 Niche = **6 Subagents paralel**!).
3. **Wait & Compile:** Agen Utama menunggu semua subagent melapor, merangkumnya, lalu membuat `implementation_plan.md` dengan opsi *Zero-Steering Grilling*.
4. **Fase Implementasi (Coding):** Agen mematuhi standar yang sudah diekstrak subagent dan menggunakan `view_file` ke referensi spesifik HANYA jika butuh contoh kode spesifik.

## 🏛️ Brownfield Protocol (Legacy / Refactoring / Tambah Fitur di Repo Eksisting)

Saat user meminta **penambahan fitur baru, modifikasi, optimasi, atau audit** pada **codebase yang sudah ada (Legacy/Existing Project / Repo yang sudah punya `composer.json`)**, DILARANG memaksakan *Big Bang Rewrite*, penciptaan "Frankenstein Codebase", atau pemakaian daftar subagent statis yang tidak relevan. Gunakan protokol **Dynamic Reconnaissance & Partitioning**:

1. **Intai & Pembelahan Subagent secara 100% Dinamis (Dynamic Hybrid Swarm):**
   Agen Utama DILARANG mematok nama atau jumlah peran subagent secara kaku. Pertama, lirik struktur direktori root, `composer.json`, dan file konfigurasi/framework lokal. Setelah itu, spawn tim Subagent ber-model `pro` (dari 3 hingga >10 secara elastis) dengan strategi pembagian yang benar-benar selaras dengan kenyataan repo asli:
   - **Pembagian Berbasis Modul / Domain / Package:** Jika project user dibangun dalam struktur modular (`/Modules/Order`, `/Modules/Billing`) atau DDD, spawn **1 Subagent Auditor terpisah untuk membedah masing-masing modul/domain**.
   - **Pembagian Berbasis Tech Stack di `composer.json` & Config:** 
     - Jika mendeteksi `laravel/octane`, spawn *Octane State Leak Auditor* (fokus mencari kebocoran memori pada `static` property atau service bertipe singleton tanpa pembatalan rejeksi di `config/octane.php`).
     - Jika mendeteksi penggunaan Eloquent intensif / Queue, spawn *Eloquent Performance & N+1 Hunter* (fokus berburu *N+1 queries* tanpa eager loading `->with()`, missing pagination, dan missing `$afterCommit = true` pada job di dalam `DB::transaction()`).
     - Jika mendeteksi endpoint API/Web, spawn *Security & OWASP Auditor* (memeriksa kerentanan IDOR, Mass Assignment `$fillable`, SQL Injection pada raw queries, dan rate limiting).
     - Jika TIDAK ADA fitur SaaS Multi-Tenancy atau AI Scout, DILARANG memanggil spesialis tenant/AI!
   - **Pembagian Berbasis Volume File:** Jika satu folder (misal `/app/Http/Controllers` atau `/app/Services`) terisi padat (>30 file), pecah audit folder tersebut ke 2-3 subagent secara paralel berdasarkan grup rute/fungsi.
   - **Mastery Standard Matcher (Subagent Dedikatif):** Tugas subagent ini murni mengkonsolidasi seluruh laporan kecacatan dari para auditor di atas, lalu menarik dan membaca HANYA file di direktori `references/` kita yang **spesifik bisa menjadi obat untuk menyembuhkan celah/bug tersebut** (wajib membedah strategi migrasi aman di `legacy_refactoring/` jika menyentuh skema DB lawas).
2. **Zero-Steering Grilling (Opsi Evolusi / Penambahan Fitur):**
   Agen Utama merangkum laporan dari seluruh tim spesialis dan menyajikan ≥3 opsi netral beserta trade-off untuk user (Gasskan):
   - **Opsi 1: Native Consistent Extension (KISS):** Tanam fitur baru dengan mematuhi pola asli arsitektur repo tersebut, NAMUN disuntikkan perlindungan standar Top 1% (wajib `FormRequest` validation, `->paginate()`, eager loading, k6 SLAs, dan zero PHPStan level 9 error pada kode baru).
   - **Opsi 2: Strangler Fig Pattern (Modular Monolith / Clean Isolation):** Fitur/modul baru didirikan secara independen menggunakan lapisan Clean Architecture kita (**FormRequest → Controller → Action/Service → Repository → Model**) tanpa merusak struktur lawas.
   - **Opsi 3: Surgical Rewrite & Hardening:** Jika modul lama terkait sudah terlalu cacat (misal modul pembayaran atau inventaris penuh N+1 dan race condition ekstrim pada Horizon/Queue), ajukan operasi bedah modul lama sekaligus merancang fitur barunya berpadu berstandar Top 1%.

### 🔍 Auto-Detect Niche Domain (Scan dari Task)

Agent wajib mencocokkan nature of task ke domain berikut **secara proaktif**:

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
| Caching L1 Octane RAM + L2 Redis, Cache Stampede dogpile protection, CDN Cloudflare edge invalidation | `references/caching_strategy_cdn/` |
| AWS S3 presigned direct uploads, SQS/SNS event pub/sub, AWS Secrets Manager injection, Vapor serverless | `references/cloud_provider_aws_vapor/` |
| Distributed Saga transaction rollback, Idempotency ledger, memory-leak proof custom artisan daemons | `references/background_jobs_saga/` |
| OWASP API Top 10 hardening, GDPR PII Tokenization vault, mTLS workload identity, SOC2 HMAC audit ledger | `references/zero_trust_enterprise_security/` |
| Prometheus / Grafana metrics scraping, Monolog ELK / Datadog non-blocking JSON pipeline, Sentry scrubbing | `references/observability_apm/` |
| Streaming Excel 1 Juta baris tanpa OOM (OpenSpout), libvips JIT Image resizing, FFmpeg video HLS transcoding | `references/media_asset_pipeline/` |
| Dynamic Redis translation bundles, ICU Intl timezone & currency formatting, Multi-Region SEO Hreflang routing | `references/i18n_localization/` |

## 🛠️ Automated Quality Gate & Verification Commands

Sebelum melaporkan tugas selesai, WAJIB jalankan perintah verifikasi ketat berikut di terminal:

```bash
# 1. Code Style Formatting & Linting (Laravel Pint)
./vendor/bin/pint --test

# 2. Maximum Static Analysis Level 9 (PHPStan)
./vendor/bin/phpstan analyse --level=9 app/

# 3. Unit, Functional & Architectural Testing (Pest v3)
php artisan test --arch

# 4. Dependency Security Vulnerability Audit
composer audit
```
