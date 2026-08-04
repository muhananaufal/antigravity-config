# Greenfield Protocol — Inisiasi Proyek dari Nol (Dynamic Swarm Scaling)

> Dipicu dari `SKILL.md` saat membuat project baru dari nol.

LLM secara biologis akan mengambil jalan pintas jika dihadapi pada bacaan ratusan file referensi. Untuk menjamin standar Top 1% diterjemahkan 100% saat **membuat project baru dari nol**, WAJIB menerapkan protokol **Dynamic Swarm Scaling**:

1. **Fase Inisialisasi (DILARANG MENEBAK / HALUSINASI):** Agen Utama DILARANG KERAS menulis kode atau langsung menerbitkan `implementation_plan.md` tanpa memobilisasi tim Subagent Swarm untuk meresap referensi yang relevan.
2. **Dynamic Swarm Summon (Wajib model tier `pro`):** Agen Utama wajib menggunakan tool `invoke_subagent` untuk men-spawn minimal 3 hingga >8 subagent secara paralel sesuai kompleksitas proyek (Dynamic Scaling):
   *   **3 Subagent Core Tetap (Mandatory Core Coverage):** Ditugaskan membaca seluruh file di domain fundamental (Arsitektur, Database/Storage, Keamanan OWASP, Konkurensi, dan DevOps/Container).
   *   **Subagent Niche Dinamis (Elastis 1 Subagent per Domain Terdeteksi):** Agen memantau tabel *Auto-Detect Niche* pada skill terkait. Untuk setiap topik spesifik yang cocok dengan tuntutan tugas (misal K8s Operators, HFT zero-alloc, Fintech ledgers, atau AI Scout), panggil **1 Subagent Dedikatif terpisah**.
3. **Konsolidasian & Grilling:** Agen Utama merangkum temuan para subagent dan menghadirkan dokumen `implementation_plan.md` dengan opsi teknis netral untuk disetujui user ("Gasskan").
4. **Fase Implementasi:** Eksekusi kode dengan kepatuhan penuh pada standar mahardika yang telah diekstrak.
5. **Day-0 Greenfield Production-Ready Quintet (Hukum Wajib Inisiasi Proyek Baru):** Saat menginisialisasi proyek baru dari nol (Greenfield), WAJIB secara default menghasilkan 5 pilar fondasi Day-0 berikut di root proyek tanpa perlu diperingatkan ulang:
   - **Pilar 1: Modular 3-Tier Container Topology:** Tier 1 Core (`docker-compose.yml` untuk DB & Cache), Tier 2 Telemetry (`profiles: [telemetry]` untuk OTel Collector, Prometheus RED, Grafana, Loki), dan Tier 3 Stress Harness (`profiles: [stress]` dengan `grafana/k6`). *(DILARANG auto-run `docker build`/`up` tanpa izin user demi menjaga efisiensi RAM/CPU).*
   - **Pilar 2: Fail-Fast Type-Safe Configuration:** Berkas `.env.example` bersih tanpa secret asli + validasi skema env ketat saat startup (wajib *crash on boot* jika env hilang/invalid sebelum membuka port HTTP atau koneksi database pool).
   - **Pilar 3: Graceful Shutdown & Signal Trapping:** Handler `SIGINT` & `SIGTERM` terpusat (tolak koneksi baru, beri grace period 5–15 detik untuk in-flight requests, tutup DB/Redis pool, dan flush buffer log/OTel traces sebelum exit code 0).
   - **Pilar 4: Database Migration & Idempotent Seeder Baseline:** Direktori `migrations/` up/down perdana + skrip seeder idempotent (`seed.sql` / framework seeder) untuk inisiasi akun/data master tanpa duplikasi error.
   - **Pilar 5: Unified Task Runner (`Makefile` / `Taskfile.yml`):** Standarisasi perintah harian developer (`make dev`, `make infra-up`/`down`, `make telemetry-up`, `make migrate`, `make seed`, `make test`, `make stress`).
