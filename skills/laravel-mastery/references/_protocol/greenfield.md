# Greenfield Protocol — Init Proyek Laravel dari Nol (Dynamic Swarm Scaling)

> Dipicu dari `SKILL.md` saat user meminta inisiasi project baru dari nol (empty folder / new repository / `composer create-project`).

LLM secara alami akan mengambil jalan pintas (laziness) dan berisiko memicu hutang teknis seperti *N+1 query*, struktur *Fat Controller*, dan *State Leak* di Laravel Octane jika disuruh membaca puluhan file secara sekuensial. Untuk menjamin standar Top 1% diterapkan 100% tanpa halusinasi, **WAJIB gunakan protokol Dynamic Swarm Subagent (Elastis)** saat inisialisasi **project baru dari nol (empty folder / new repository / composer create-project)**:

1. **HUKUM MUTLAK DAY-0 GREENFIELD BOOTSTRAP (5 PILAR PRODUCTION-READY):** Setiap inisiasi proyek baru (Greenfield) di Laravel WAJIB secara default meracik 5 pilar fondasi Day-0 berikut di root proyek:
   - **Pilar 1: Modular 3-Tier Container Topology:** Tier 1 Core (`docker-compose.yml` untuk FrankenPHP/Octane + Postgres/Valkey Redis), Tier 2 Telemetry (`profiles: [telemetry]` untuk OTel, Prometheus RED, Grafana, Loki), dan Tier 3 Stress Harness (`profiles: [stress]` dengan `grafana/k6`). *(DILARANG auto-run `docker build`/`up` tanpa konfirmasi user).*
   - **Pilar 2: Fail-Fast Configuration:** `.env.example` bersih + validasi konfigurasi ketat via `config()` yang aman (WAJIB throw exception saat boot jika env WAJIB tidak ada sebelum melayani request).
   - **Pilar 3: Graceful Lifecycle & Octane Sandbox Isolation:** Pembersihan state leak Octane (`flush` services di `config/octane.php`), penanganan sinyal graceful shutdown worker queue & Octane container, serta flushing buffer log ke Loki.
   - **Pilar 4: Migration & Idempotent Seeder Baseline:** `database/migrations/` lengkap + `database/seeders/DatabaseSeeder.php` idempotent untuk inisiasi akun admin awal.
   - **Pilar 5: Unified Task Runner (`Makefile` / `composer scripts`):** Perintah baku `make dev` (Octane/FrankenPHP), `make infra-up`/`down`, `make telemetry-up`, `make migrate`, `make seed`, `make test` (Pest), `make stress` (k6).
2. **Fase Inisialisasi (DILARANG MENEBAK / HALUSINASI):** Saat user meminta inisiasi project baru, Agen Utama DILARANG langsung menulis kode atau membuat `implementation_plan.md` tanpa konsultasi referensi.
3. **Dynamic Swarm Summon (`pro` tier):** Agen Utama WAJIB memanggil `invoke_subagent` untuk men-spawn minimal 3 hingga >8 subagent secara paralel sesuai kompleksitas proyek (Dynamic Scaling):
   - **3 Subagent Core Tetap (Mandatory Core Coverage):**
     - **Subagent 1 (Arch, DB, Caching & Cloud DevOps Core):** WAJIB `view_file` ke SEMUA file di `references/arch/`, `references/db/`, `references/caching_strategy_cdn/`, `references/devops_deployment/`, `references/cloud_provider_aws_vapor/`, dan `references/legacy_refactoring/`.
     - **Subagent 2 (API, Concurrency, Saga & Governance Core):** WAJIB `view_file` ke SEMUA file di `references/api/`, `references/concurrency/`, `references/background_jobs_saga/`, `references/testing_automated/`, dan `references/code_quality_governance/`.
     - **Subagent 3 (Runtime, Observability & Security Core):** WAJIB `view_file` ke SEMUA file di `references/php_runtime_internals/`, `references/observability_apm/`, `references/security/`, `references/zero_trust_enterprise_security/`, dan `references/microservices_mesh/`.
   - **Subagent Niche DINAMIS (1 Subagent per Domain Terdeteksi):**
     - Agen utama mengecek tabel **Auto-Detect Niche Domain** di `SKILL.md`. Untuk **SETIAP 1 domain niche** yang cocok dengan proyek (misal: `fintech_ecommerce/`, `inertia_livewire/`, `multitenancy_saas/`), WAJIB spawn **1 Subagent Dedikatif terpisah**. (Jika terdeteksi 3 domain niche, maka summon 3 Core + 3 Niche = **6 Subagents paralel**!).
4. **Wait & Compile:** Agen Utama menunggu semua subagent melapor, merangkumnya, lalu membuat `implementation_plan.md` dengan opsi *Zero-Steering Grilling*.
5. **Fase Implementasi (Coding):** Agen mematuhi standar yang sudah diekstrak subagent dan menggunakan `view_file` ke referensi spesifik HANYA jika butuh contoh kode spesifik.
