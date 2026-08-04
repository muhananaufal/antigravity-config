# Brownfield Protocol — Legacy / Refactoring / Tambah Fitur di Repo Laravel Eksisting

> Dipicu dari `SKILL.md` saat user meminta penambahan fitur baru, modifikasi, optimasi, atau audit pada repo yang sudah punya `composer.json`.

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
   - **Mastery Standard Matcher (Subagent Dedikatif):** Tugas subagent ini murni mengkonsolidasi seluruh laporan kecacatan dari para auditor di atas, lalu menarik dan membaca HANYA file di direktori `references/` kita yang **spesifik bisa menjadi obat untuk menyembuhkan celah/bug tersebut** (WAJIB membedah strategi migrasi aman di `legacy_refactoring/` jika menyentuh skema DB lawas).
2. **Zero-Steering Grilling (Opsi Evolusi / Penambahan Fitur):**
   Agen Utama merangkum laporan dari seluruh tim spesialis dan menyajikan ≥3 opsi netral beserta trade-off untuk user (Gasskan):
   - **Opsi 1: Native Consistent Extension (KISS):** Tanam fitur baru dengan mematuhi pola asli arsitektur repo tersebut, NAMUN disuntikkan perlindungan standar Top 1% (WAJIB `FormRequest` validation, `->paginate()`, eager loading, k6 SLAs, dan zero PHPStan level 9 error pada kode baru).
   - **Opsi 2: Strangler Fig Pattern (Modular Monolith / Clean Isolation):** Fitur/modul baru didirikan secara independen menggunakan lapisan Clean Architecture kita (**FormRequest → Controller → Action/Service → Repository → Model**) tanpa merusak struktur lawas.
   - **Opsi 3: Surgical Rewrite & Hardening:** Jika modul lama terkait sudah terlalu cacat (misal modul pembayaran atau inventaris penuh N+1 dan race condition ekstrim pada Horizon/Queue), ajukan operasi bedah modul lama sekaligus merancang fitur barunya berpadu berstandar Top 1%.
