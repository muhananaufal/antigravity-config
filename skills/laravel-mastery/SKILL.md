---
name: laravel-mastery
description: Gunakan skill ini ketika merancang arsitektur, API resources, Sanctum/Passport auth, Eloquent DB, Horizon, Reverb, Octane, Livewire/Inertia, Fintech/Cashier, AI Scout, Multi-Tenancy, microservices gRPC, AWS Vapor/Lambda cloud native, Caching L1/L2 CDN, Distributed Saga jobs, Zero-Trust security, atau testing di Laravel.
---

# Laravel Mastery

SSOT arsitektur & rekayasa Laravel enterprise, SaaS high-throughput, dan resilient cloud-native PHP (26 Domain, 131 File Mahakarya).

## 🚦 Protokol Eksekusi (WAJIB dibaca sesuai situasi)

> **SEBELUM membuka tabel di bawah:** Jika ini adalah proyek baru atau keputusan arsitektur besar, WAJIB lewati `master_decision_tree.md` (`~/.gemini/config/skills/master-decision-tree/SKILL.md`) terlebih dahulu. DILARANG langsung memilih Laravel sebagai stack tanpa justifikasi dari Decision Tree.

| Situasi | WAJIB baca dulu sebelum menulis apa pun |
| :--- | :--- |
| Inisiasi project baru dari nol (empty folder / new repository) | `references/_protocol/greenfield.md` |
| Tambah fitur / modifikasi / optimasi / audit di repo eksisting | `references/_protocol/brownfield.md` |

DILARANG membuat dokumen RFC (`docs/rfc/`) atau menulis kode sebelum protokol yang relevan dibaca tuntas.

## 📦 Core References (WAJIB Baca Setiap Project Laravel)

Domain fondasi yang hampir selalu relevan, apa pun bentuk tasknya:

| Domain | Referensi | Cakupan |
| :--- | :--- | :--- |
| **Code Quality & Governance** | `references/code_quality_governance/` | Pint, PHPStan level 9, arsitektur berlapis, konvensi tim |
| **Testing Otomatis** | `references/testing_automated/` | Pest v3, feature/unit/arch test, factory & seeder, mocking |
| **DevOps & Deployment** | `references/devops_deployment/` | Docker Octane/FrankenPHP, CI/CD, zero-downtime deploy, health probe |

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
