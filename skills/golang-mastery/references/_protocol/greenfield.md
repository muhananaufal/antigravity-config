# Greenfield Protocol — Init Proyek Go dari Nol (Dynamic Swarm Scaling)

> Dipicu dari `SKILL.md` saat user meminta inisiasi project baru dari nol (empty folder / new repository).

LLM secara alami akan mengambil jalan pintas (laziness) jika disuruh membaca puluhan file. Untuk menjamin standar Top 1% diterapkan 100% tanpa halusinasi, **WAJIB gunakan protokol Dynamic Swarm Subagent (Elastis)** saat inisialisasi **project baru dari nol (empty folder / new repository)**:

1. **Fase Inisialisasi (DILARANG MENEBAK):** Saat user meminta inisiasi project baru, Agen Utama DILARANG membuat `implementation_plan.md` langsung.
2. **Dynamic Swarm Summon (`pro` tier):** Agen Utama WAJIB memanggil `invoke_subagent` untuk men-spawn minimal 4 hingga >8 subagent secara paralel sesuai kompleksitas proyek (Dynamic Scaling):
   - **3 Subagent Core Tetap (Mandatory Core Coverage):**
     - **Subagent 1 (Infra & Data Core):** WAJIB `view_file` ke SEMUA file di `arch_patterns/`, `db_sqlc/`, dan `devops_control_planes/`.
     - **Subagent 2 (API & Logic Core):** WAJIB `view_file` ke SEMUA file di `microservices_grpc/`, `testing_quality/`, dan `concurrency/`.
     - **Subagent 3 (Security & Resilience Core):** WAJIB `view_file` ke SEMUA file di `security_owasp/`, `observability_resilience/`, `distributed_patterns_resilience/`, dan `caching_strategy/`.
   - **Subagent Niche DINAMIS (1 Subagent per Domain Terdeteksi):**
     - Agen utama mengecek tabel **Auto-Detect Context Domain** di `SKILL.md`. Untuk **SETIAP 1 domain niche** yang cocok dengan proyek (misal: `fintech_reliability/`, `hft_zero_alloc/`, `realtime_networking/`), WAJIB spawn **1 Subagent Dedikatif terpisah**. (Jika terdeteksi 4 domain niche, maka summon 3 Core + 4 Niche = **7 Subagents paralel**!).
3. **Wait & Compile:** Agen Utama menunggu semua subagent melapor, merangkumnya, lalu membuat `implementation_plan.md` dengan opsi *Zero-Steering Grilling*.
4. **Day-0 Greenfield Production-Ready Quintet (Hukum WAJIB Inisiasi Proyek Baru):** Setiap inisialisasi proyek baru (Greenfield) di Golang WAJIB secara default menghasilkan 5 pilar fondasi Day-0 berikut di root proyek:
   - **Pilar 1: Modular 3-Tier Container Topology:** Tier 1 Core (`docker-compose.yml` DB PostgreSQL/Valkey), Tier 2 Telemetry (`profiles: [telemetry]` OTel Collector, Prometheus, Grafana, Loki), Tier 3 Stress Harness (`profiles: [stress]` `grafana/k6`). *(DILARANG auto-run `docker build`/`up` tanpa izin user).*
   - **Pilar 2: Fail-Fast Type-Safe Configuration:** `.env.example` bersih + validasi `envconfig`/`caarlos0/env` saat boot (WAJIB panic/log.Fatal sebelum `net.Listen` atau `sql.Open` jika env invalid).
   - **Pilar 3: Graceful Shutdown Protocol:** `signal.NotifyContext` menangkap `SIGINT`/`SIGTERM`, server `Shutdown(ctx)` dengan timeout 5-15s, `db.Close()`, serta OTel `tp.Shutdown(ctx)` dan logger sync.
   - **Pilar 4: Migration & Idempotent Seeder Baseline:** Folder `migrations/` (`golang-migrate`/`goose`) + `seed.sql` data inisial.
   - **Pilar 5: Unified Task Runner (`Makefile`):** Perintah baku `make dev` (air hot-reload), `make infra-up`/`down`, `make telemetry-up`, `make migrate`, `make seed`, `make test`, `make stress`.
