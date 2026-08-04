# Greenfield Protocol — Init Proyek Rust dari Nol (Dynamic Swarm Scaling)

> Dipicu dari `SKILL.md` saat user meminta inisiasi project baru dari nol (empty folder / new repository / `cargo new`).

**HUKUM MUTLAK DAY-0 GREENFIELD BOOTSTRAP (5 PILAR PRODUCTION-READY):**
*Setiap inisialisasi proyek baru (Greenfield) di Rust WAJIB secara default meracik 5 pilar fondasi Day-0 berikut di root proyek:*
1. **Modular 3-Tier Container Topology:** Tier 1 Core (`docker-compose.yml` Postgres/Valkey), Tier 2 Telemetry (`profiles: [telemetry]` OTel Collector, Prometheus, Grafana, Loki), Tier 3 Stress Harness (`profiles: [stress]` `grafana/k6`). *(DILARANG auto-execute build/up tanpa konfirmasi user).*
2. **Fail-Fast Type-Safe Configuration:** `.env.example` bersih + deserialisasi strongly-typed `envy`/`config-rs` saat boot (WAJIB panic / return error deskriptif sebelum binding Axum listener atau koneksi DB pool).
3. **Graceful Shutdown Protocol:** `tokio::signal::ctrl_c()` & Unix signal stream handler, Axum `with_graceful_shutdown()`, penutupan pool `sqlx`, dan flushing tracing subscriber buffer OTLP.
4. **Migration & Idempotent Seeder Baseline:** Folder `migrations/` (`sqlx-cli` / `diesel`) + `seed.sql` data inisial.
5. **Unified Task Runner (`Makefile` / `cargo-make`):** Perintah baku `make dev` (`cargo watch -x run`), `make infra-up`/`down`, `make telemetry-up`, `make migrate`, `make test`, `make stress`.

LLM secara alami akan mengambil jalan pintas (laziness) dan berisiko menghasilkan kode yang gagal compile (*Borrow Checker / Lifetime error*) atau *Undefined Behavior* di block `unsafe` jika disuruh membaca puluhan file seiring waktu. Untuk menjamin standar Top 1% diterapkan 100%, **WAJIB gunakan protokol Dynamic Swarm Subagent (Elastis)** saat inisialisasi **project baru dari nol (empty folder / new repository / cargo new)**:

1. **Fase Inisialisasi (DILARANG MENEBAK / HALUSINASI):** Saat user meminta inisiasi project baru, Agen Utama DILARANG langsung membuat kode atau `implementation_plan.md` tanpa konsultasi referensi.
2. **Dynamic Swarm Summon (`pro` tier):** Agen Utama WAJIB memanggil `invoke_subagent` untuk men-spawn minimal 3 hingga >8 subagent secara paralel sesuai kompleksitas proyek (Dynamic Scaling):
   - **3 Subagent Core Tetap (Mandatory Core Coverage):**
     - **Subagent 1 (Memory, Traits & Unsafe Core):** WAJIB `view_file` ke SEMUA file di `references/core_memory_ownership/`, `references/type_system_traits/`, `references/unsafe_ffi_internals/`, dan `references/docker_container_standards/`.
     - **Subagent 2 (Async, Web & Reliability Core):** WAJIB `view_file` ke SEMUA file di `references/async_tokio_concurrency/`, `references/web_microservices/`, `references/error_handling_resilience/`, dan `references/testing_fuzzing_benchmarking/`.
     - **Subagent 3 (Performance, Security & Storage Core):** WAJIB `view_file` ke SEMUA file di `references/high_performance_hft/`, `references/distributed_consensus_storage/`, `references/networking_protocols_grpc/`, dan `references/cybersecurity_cryptography/`.
   - **Subagent Niche DINAMIS (1 Subagent per Domain Terdeteksi):**
     - Agen utama mengecek tabel **Auto-Detect Niche Domain** di `SKILL.md`. Untuk **SETIAP 1 domain niche** yang cocok dengan proyek (misal: `wasm_systems/`, `blockchain_smart_contracts/`, `game_engine_bevy/`), WAJIB spawn **1 Subagent Dedikatif terpisah**. (Jika terdeteksi 3 domain niche, maka summon 3 Core + 3 Niche = **6 Subagents paralel**!).
3. **Wait & Compile:** Agen Utama menunggu semua subagent melapor, merangkumnya, lalu membuat `implementation_plan.md` dengan opsi *Zero-Steering Grilling*.
4. **Fase Implementasi (Coding):** Agen mematuhi standar yang sudah diekstrak subagent dan menggunakan `view_file` ke referensi spesifik HANYA jika butuh contoh kode spesifik.
