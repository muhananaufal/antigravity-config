# Brownfield Protocol — Legacy / Refactoring / Tambah Fitur di Repo Rust Eksisting

> Dipicu dari `SKILL.md` saat user meminta penambahan fitur baru, modifikasi, optimasi, atau audit pada repo yang sudah punya `Cargo.toml`.

Saat user meminta **penambahan fitur baru, modifikasi, optimasi, atau audit** pada **codebase yang sudah ada (Legacy/Existing Project / Repo yang sudah punya `Cargo.toml`)**, DILARANG memaksakan *Big Bang Rewrite*, penciptaan "Frankenstein Codebase", atau pemakaian daftar subagent statis yang tidak relevan. Gunakan protokol **Dynamic Reconnaissance & Partitioning**:

1. **Intai & Pembelahan Subagent secara 100% Dinamis (Dynamic Hybrid Swarm):**
   Agen Utama DILARANG mematok nama atau jumlah peran subagent secara kaku. Pertama, lirik struktur direktori root, `Cargo.toml` (termasuk *workspace crates*), dan file konfigurasi lokal. Setelah itu, spawn tim Subagent ber-model `pro` (dari 3 hingga >10 secara elastis) dengan strategi pembagian yang benar-benar selaras dengan kenyataan repo asli:
   - **Pembagian Berbasis Workspace / Crates / Modul:** Jika project user berbentuk Cargo Workspace atau dibagi menjadi beberapa modul (`/crates/api`, `/crates/domain`, `/crates/storage`), spawn **1 Subagent Auditor terpisah untuk membedah masing-masing crate/modul**.
   - **Pembagian Berbasis Tech Stack di `Cargo.toml`:**
     - Jika mendeteksi `tokio`, spawn *Tokio Concurrency Auditor* (fokus mencari bahaya *Cancellation Safety* pada `tokio::select!`, kebocoran *blocking I/O* di worker thread tanpa `spawn_blocking`, dan *deadlock* pada `Mutex` melintasi titik `.await`).
     - Jika mendeteksi `sqlx` / `sea-orm`, spawn *DB & N+1 Query Hunter* (fokus mencari N+1 loop query, unpooled DB connections, atau skema tanpa migrasi aman).
     - Jika mendeteksi blok `unsafe` / FFI, spawn *Unsafe Provenance Auditor* (memeriksa pointer aliasing, transmute hazards, dan kepatuhan Stacked Borrows / Miri).
     - Jika TIDAK ADA fitur blockchain atau game, DILARANG KERAS memanggil spesialis kripto/game!
   - **Pembagian Berbasis Volume File:** Jika satu modul/crate sangat padat (>30 file), pecah audit atas crate tersebut ke beberapa subagent berdasarkan fungsionalitas (misal: Subagent A fokus API Handler & Middleware, Subagent B fokus DB Repositories & Entities).
   - **Mastery Standard Matcher (Subagent Dedikatif):** Tugas subagent ini murni mengkonsolidasi seluruh laporan kecacatan dari para auditor di atas, lalu menarik dan membaca HANYA file di direktori `references/` kita yang **spesifik bisa menjadi obat untuk menyembuhkan celah/bug tersebut**.
2. **Zero-Steering Grilling (Opsi Evolusi / Penambahan Fitur):**
   Agen Utama merangkum laporan dari seluruh tim spesialis dan menyajikan ≥3 opsi netral beserta trade-off untuk user (Gasskan):
   - **Opsi 1: Native Consistent Extension (KISS):** Tanam fitur baru dengan mematuhi pola asli arsitektur repo tersebut, NAMUN disuntikkan perlindungan standar Top 1% (WAJIB `thiserror`, timeout di external calls, `Arc<T>` bebas sirkulasi maut dengan `Weak<T>`, dan zero clippy warnings).
   - **Opsi 2: Strangler Fig Pattern (Workspace / Modular Isolation):** Fitur/modul baru didirikan secara independen sebagai crate baru di Cargo Workspace atau modul terisolasi berstandar Top 1% tanpa merusak kode lama.
   - **Opsi 3: Surgical Rewrite & Hardening:** Jika modul lama terkait sudah terlalu cacat (misal modul concurrency lawas penuh *race condition* atau bocor memori di blok `unsafe`), ajukan operasi bedah modul lama sekaligus merancang fitur barunya berpadu berstandar Top 1%.
