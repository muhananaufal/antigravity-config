---
name: laravel-mastery
description: Gunakan skill ini ketika merancang arsitektur, API resources, Sanctum/Passport auth, Eloquent DB, Horizon, Reverb, Octane, Livewire/Inertia, Fintech/Cashier, AI Scout, Multi-Tenancy, microservices gRPC, atau testing di Laravel.
---

# Laravel Mastery

SSOT arsitektur & rekayasa Laravel enterprise & SaaS high-throughput.

## 🔁 Protocol & Routing Table
1. WAJIB `view_file` pada SELURUH file referensi di `references/<domain>/` yang bersangkutan tanpa ada yang terlewat sebelum merespon/menulis kode (DILARANG baca sebagian file lalu mengarang dari hafalan LLM).
2. DILARANG mengunci 1 default sepihak atau memberi label "(Recommended)". WAJIB sajikan minimal 2-3 opsi netral + trade-off saat Grilling.
3. WAJIB menyertakan Unit Testing (`Pest` / `PHPUnit`) pada modul logika bisnis utama (Auth, Payment, Order State Transitions) sebelum melaporkan tugas selesai.
4. WAJIB menerapkan Clean Architecture: pemisahan layer **FormRequest → Controller → Service/Action → Repository → Model**. DILARANG menumpuk logika bisnis di Controller.
5. WAJIB memuat seluruh kredensial & konfigurasi (JWT secret, DB URL, API Keys) via `.env` / `config/*.php`. DILARANG hardcode langsung di kode sumber.
6. WAJIB menggunakan Strongly-Typed Error Propagation (Custom Exceptions / `abort()` spesifik). DILARANG menyapu semua error menjadi `500 Server Error` generik.
7. WAJIB memasang Graceful Shutdown handler untuk Queue Workers via `SIGTERM` signal handling (`pcntl_signal`) + flag `--stop-when-empty`. DILARANG langsung `kill -9` tanpa memberi kesempatan job yang sedang berjalan untuk selesai.
8. WAJIB melakukan Self-Review Gate (pengecekan N+1 query via Laravel Debugbar/Telescope, Race Condition, linter `PHPStan level 9`) sebelum melaporkan tugas selesai.
9. WAJIB memvalidasi & mensanitasi seluruh payload request masuk via `FormRequest` dengan rules yang ketat sebelum menyentuh layer Service/Database.
10. WAJIB menerapkan Pagination (`->paginate()` / `->cursorPaginate()`) pada semua endpoint yang mengembalikan list data Eloquent.
11. WAJIB menyertakan prefix versi pada semua route API (`/api/v1/`, `/api/v2/`) sejak awal proyek.
12. WAJIB memasang HTTP Request Logging (Laravel Telescope / `Log::channel('daily')`) & Metrics monitoring pada setiap request masuk.
13. WAJIB audit N+1 Query dengan menggunakan `->with()` (Eager Loading) untuk setiap relasi Eloquent yang diakses dalam loop.
14. WAJIB melakukan OWASP Security Checklist sebelum selesai: periksa SQL Injection, IDOR (Insecure Direct Object Reference), Mass Assignment (`$fillable`), & Broken Authentication secara eksplisit.
15. WAJIB memasang Rate Limiting (`throttle` middleware) pada semua endpoint publik (Auth login, Register, Password Reset) untuk mencegah brute-force & DDoS.
16. WAJIB memastikan semua Database Migration aman untuk Zero-Downtime Deployment: kolom baru WAJIB `nullable()`, DILARANG langsung `->rename()` / `->dropColumn()` tanpa migration bertahap.
17. WAJIB memasang Circuit Breaker (timeout + retry + fallback via `Http::timeout()->retry()`) pada setiap pemanggilan external service (payment gateway, email/SMS provider, third-party API).
18. WAJIB mendokumentasikan seluruh endpoint REST via OpenAPI/Swagger spec (`L5-Swagger` / `Scribe`) sejak awal proyek, bukan sebagai langkah terakhir.
19. WAJIB mempropagasi Correlation ID (`X-Request-ID` header) pada setiap request masuk via middleware dan meneruskannya ke seluruh log entries (`Log::withContext()`) untuk traceability debugging.
20. WAJIB menyediakan endpoint Health Check (`/health`) pada setiap service untuk integrasi load balancer & Kubernetes pod lifecycle.
21. WAJIB mengonfigurasi Database Connection Pool secara eksplisit di `config/database.php` (`pool.min`, `pool.max` di Octane, atau koneksi idle via `DB::disconnect()`) dan DILARANG menggunakan default tanpa batas.
22. WAJIB menjaga Backward Compatibility pada API yang sudah dirilis. Perubahan breaking DILARANG dilakukan di versi yang sama — WAJIB buat versi baru (`v2`).
23. WAJIB menetapkan Response Time Budget / SLA target (misal p99 < 200ms) dan memverifikasi dengan load testing tool (`k6` / `Locust` / `Apache Bench`) sebelum deploy ke production.
24. DILARANG menambahkan konten filler/padding tanpa nilai teknis ke dalam file referensi. Setiap baris di file referensi WAJIB mengandung pengetahuan teknis yang actionable.
25. WAJIB mengimplementasikan Idempotency Key pada setiap endpoint POST yang mengubah state (payment, order creation, transfer). Gunakan unique key per request yang disimpan di cache/DB untuk mencegah double-processing.
26. WAJIB mengaktifkan `Model::shouldBeStrict(! app()->isProduction())` di `AppServiceProvider` (mencakup `preventLazyLoading`, `preventSilentlyDiscardedAttributes`, `preventAccessingMissingAttributes`) untuk mendeteksi N+1 query & silently discarded attributes di dev/testing.
27. WAJIB mencegah State Leak pada Laravel Octane / Persistent Runtimes: DILARANG menyimpan request-scoped state pada static property atau singleton instances. Daftarkan service bermutasi pada array `flush` di `config/octane.php` atau reset listener per request.
28. WAJIB menggunakan Transactional Job Dispatch (`$afterCommit = true` / `DB::afterCommit()`): Setiap event atau queue job yang didispatch di dalam `DB::transaction()` WAJIB diset `$afterCommit = true` atau dibungkus `DB::afterCommit()` untuk mengeliminasi race condition di mana queue worker mencoba membaca record DB sebelum transaction dikomit.
29. WAJIB mengonfigurasi Job Resilience & Concurrency Lock (`ShouldBeUnique` & `$tries`): Setiap Queue Job WAJIB menentukan atribut `$tries`, `$backoff`, `$timeout`, dan `$failOnTimeout = true`. Job yang memanipulasi saldo/stok WAJIB mengimplementasikan `ShouldBeUnique` atau Redis Lock (`Cache::lock()`).
30. WAJIB menyaring Data Sensitif pada Logging & Telemetry: DILARANG mencatat password, token, nomor kartu kredit, atau PII pada `Log::info()` / context log. Konfigurasikan `$hidden` pada Model dan filter log context di `config/logging.php`.


| Topik Task | WAJIB Baca SELURUH File Referensi di Domain |
| :--- | :--- |
| Modular Monolith Architecture, Domain-Driven Design (DDD), Service Repository Pattern, Action Pattern, Pipeline Pattern | `references/arch/*.md` |
| REST API Standards, API Resources Transformers, Sanctum Token Auth, Passport OAuth2, Rate Limiting Throttling | `references/api/*.md` |
| Eloquent Performance, Complex Query Optimization, Database Indexing, Transactions Deadlocks, Spatial Timeseries DB | `references/db/*.md` |
| Queue Workers, Horizon Dashboard, Event Listeners, Job Batching Chaining, Reverb WebSockets Realtime | `references/concurrency/*.md` |
| Octane High-Performance Engine (Swoole/FrankenPHP), Swoole Table Caching, OpenTelemetry Distributed Tracing | `references/php_runtime_internals/*.md` |
| Automated Testing, Pest v3 Architecture Testing, Parallel Testing, Mocking HTTP Services, Browser Dusk Testing | `references/testing_automated/*.md` |
| Security Hardening, OWASP Vulnerabilities, Encryption Vault, Role Permission RBAC, Rate Limiting Security Guards | `references/security/*.md` |
| Code Quality Governance, PHPStan Level 9 Static Analysis, Pint Formatting, Rector Automated Upgrades | `references/code_quality_governance/*.md` |
| DevOps Deployment, Forge Envoy Automation, Docker Devcontainers, Zero-Downtime Deployment Pipelines | `references/devops_deployment/*.md` |
| Inertia.js Vue/React Integration, Livewire v3 Components, Alpine.js State Management, PWA Offline Service Workers | `references/inertia_livewire/*.md` |
| Multi-Tenancy SaaS Architecture, Single/Multi Database Tenant Isolation, Tenant Middleware Routing Guards | `references/multitenancy_saas/*.md` |
| Microservices Mesh, gRPC PHP Services, RabbitMQ Messaging Broker, Event-Driven Microservices Architecture | `references/microservices_mesh/*.md` |
| AI Integration, Laravel Scout Typesense Search, Vector Database Embeddings, LLM Prompt Engineering Pipelines | `references/ai_search_infra/*.md` |
| Fintech E-Commerce, Double-Entry Financial Ledgers, Stripe Cashier Subscriptions, Idempotent Payment Webhooks | `references/fintech_ecommerce/*.md` |
| Spatial GIS Database, Timeseries Metrics Analytics, PostGIS Queries, InfluxDB Timescale Storage Integration | `references/spatial_timeseries_db/*.md` |
| First-Party Ecosystem, Filament v3 Admin Architecture, Laravel Prompts CLI, Precognition Form Validation, Pail Logs | `references/ecosystem_firstparty/*.md` |
| Extended Ecosystem Packages, Spatie Permissions Roles, Spatie Media Library, Spatie Query Builder, Spatie Data & Health | `references/ecosystem_extended/*.md` |
| Legacy Codebase Refactoring, Monolith Decomposition, Strangler Fig Pattern, Safe Database Migration Strategies | `references/legacy_refactoring/*.md` |
| Realtime Eventing Engine, Reverb WebSockets PubSub, Echo Client Integration, Server-Sent Events (SSE) Streaming | `references/realtime_eventing/*.md` |

## 🛠️ Automated Quality Gate & Verification Commands

Sebelum melaporkan tugas selesai, jalankan perintah verifikasi wajib berikut:

```bash
# 1. Code Style Formatting & Linting (Laravel Pint)
./vendor/bin/pint --test

# 2. Static Analysis Level 9 (PHPStan)
./vendor/bin/phpstan analyse --level=9 app/

# 3. Unit & Architectural Testing (Pest v3)
php artisan test --arch

# 4. Dependency Vulnerability Security Audit
composer audit
```

