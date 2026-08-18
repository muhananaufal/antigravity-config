# Buku Suci Protokol Subagent Swarm Dinamis

Dokumen absolut ini membongkar rahasia tata kelola *Subagent Swarm* secara dinamis dalam ekosistem Antigravity. Mengandalkan metode primitif agen tunggal atau membatasi *swarm* dengan kuota statis adalah resep jitu menuju kegagalan, halusinasi memori, dan penyelesaian tugas setengah matang. Kami menerapkan standar arsitektur Top 1%.

## 1. Mitos Kuota Statis vs Keharusan Skalabilitas Dinamis

Banyak sistem membatasi pemanggilan subagent menjadi maksimal 3 atau 5 agen secara statis untuk "menghemat resource". Ini adalah kegagalan fatal!
- **Dampak Buruk Kuota Statis:** Memaksa 1 agen menangani 3 domain rumit sekaligus (misal: ORM Migration, GraphQL Resolvers, Redis Caching). Akibatnya, LLM melupakan instruksi kritis (context drop), menghasilkan kode rapuh (halusinasi), dan malas menelusuri ratusan file (`grep_search` fatigue).
- **Protokol Dinamis (Elastis):** Kami menetapkan bahwa *Swarm* harus berskala dinamis, dari minimal 3 hingga >10 secara paralel, bergantung pada ukuran tugas. Setiap agen HANYA diberi 1 tanggung jawab spesifik (Single Responsibility Principle). Jika kita mendeteksi 7 modul di aplikasi, kita *spawn* 7 agen `pro` secara paralel.

## 2. Strategi Pemanggilan Tim Tier `pro` Secara Elastis

Dalam arsitektur *Dynamic Swarm*, model tier `pro` wajib digunakan untuk tugas-tugas konseptual dan struktural.
- **Master Orchestrator (Induk):** Menganalisis *request* awal pengguna. Mengidentifikasi jumlah titik injeksi.
- **Spawning Elastis:** Induk akan melakukan `invoke_subagent` dengan array dinamis. Contoh: Untuk merombak sistem *Auth* yang melibatkan DB, JWT, Middleware, dan Frontend API.
  - Subagent 1: `DB_Schema_Architect` (Tier `pro`)
  - Subagent 2: `JWT_Security_Auditor` (Tier `pro`)
  - Subagent 3: `Middleware_Integrator` (Tier `pro`)
  - Subagent 4: `Frontend_API_Consumer` (Tier `pro`)
- **Pengecualian:** Model tier `flash` HANYA diizinkan untuk subagent pencari (misal `Code_Grep_Scout`), yang tugasnya murni membaca ribuan baris kode dengan cepat untuk memetakan nama variabel tanpa logika penulisan.

## 3. Strategi Pembelahan Tugas (Task Partitioning)

Bagaimana cara menentukan berapa banyak subagent yang dibutuhkan? Gunakan dua metode ini secara kombinasi:

### A. Volume-Based Partitioning (Modul/Folder/Volume)
Digunakan saat direktori proyek sudah terstruktur dengan baik.
- **Pola:** Pisahkan subagent berdasarkan batas-batas Domain-Driven Design (DDD) atau arsitektur microservice.
- **Eksekusi:** Jika folder `/internal/app/` memiliki sub-folder `users`, `orders`, `payments`, `inventory`, panggil 4 subagent yang masing-masing menggunakan Workspace Mode `share` untuk bekerja eksklusif pada folder-folder tersebut secara mandiri dan simultan.

### B. Tech-Detection Partitioning (Manifes)
Digunakan saat menganalisis proyek untuk menentukan spesialisasi *skill* apa yang dipanggil.
- **Pola:** Baca `go.mod`, `Cargo.toml`, atau `composer.json` dengan subagent intelijen (`Dependency_Scout`).
- **Eksekusi:** Intelijen melapor balik: "Ditemukan `gorm`, `gin`, dan `grpc`." Master Orchestrator lalu men-spawn tiga agen `pro` dengan peran: `Gorm_Specialist`, `Gin_Router_Specialist`, dan `gRPC_Protocol_Specialist`.

## 4. Diagram ASCII: Dynamic Swarm Decision Tree

```ascii
                          [ USER REQUEST ]
                                |
                   (Master Orchestrator Analysis)
                                |
             +------------------+------------------+
             |                                     |
    [Analisis Direktori]                   [Analisis Manifes]
    (Folder/Volume Split)                 (Tech/Dep Detection)
             |                                     |
    Ditemukan 5 Domain Bounded            Ditemukan 4 Teknologi Kritis
             |                                     |
   +---------+---------+                 +---------+---------+
   |         |         |                 |         |         |
 Agent A  Agent B   Agent C           Agent X   Agent Y   Agent Z
(Orders) (Payment) (Users)           (Kafka)   (Redis)    (SQL)
   |         |         |                 |         |         |
   +---------+---------+                 +---------+---------+
             |                                     |
             +------------------+------------------+
                                |
                     [ Isolasi Komunikasi ]
                  (Send Message ke Master Orck)
                                |
                     [ Merging & Resolusi ]
                      (Automated Test Gate)
```

## 5. Teknik Zero-Steering Grilling

Saat agen dihadapkan pada persimpangan arsitektur, DILARANG mengambil keputusan sepihak yang buta. Induk wajib menerapkan metode *Zero-Steering Grilling*.
- **Native Consistent Extension:** Apakah kita melanjutkan struktur kode yang buruk namun konsisten dengan sisa proyek?
- **Strangler Fig:** Apakah kita memotong rute API yang lama, menyisipkan rute baru yang bersih dengan NGINX reverse-proxy / routing logic, perlahan mematikan yang lama?
- **Surgical Rewrite:** Apakah modul ini cukup terisolasi sehingga bisa dihancurkan dan ditulis ulang total dari nol dalam 1 PR?

Master Orchestrator wajib membuat *Artifact* (misal: `architectural_options.md`) menjabarkan trade-off (min. 3 pros & 3 cons per opsi) dan memaksa pengguna untuk menjawab sebelum menskalakan Swarm.

## 6. Isolasi Komunikasi (Zero Token Pollution)

- **Masalah:** Jika 10 subagent saling berceloteh atau mengirim ratusan baris kode ke Master Orchestrator melalui `send_message`, *context window* agen induk akan langsung kehabisan napas (Context Collapse).
- **Solusi Taktis (Wajib Diterapkan):** 
  - Subagent DILARANG KERAS menyematkan *diff* kode panjang atau *raw source code* dalam pesannya.
  - Subagent wajib merangkum temuannya secara singkat.
  - Jika subagent menghasilkan kode/analisis besar, subagent WAJIB menyimpannya ke *Artifact* atau file di dalam `scratch/`, lalu hanya mengirim **path absolut file tersebut** (misal `C:\path\to\result.md`) kepada Master Orchestrator. Master Orchestrator kemudian membaca file tersebut secara parsial (dengan offset/batasan baris) jika diperlukan, menjaga ruang token tetap steril!

## 7. Blueprint Spesifikasi Tooling (JSON Schema & Workspace Protocols)

Mengelola armada agen mandiri di dalam ekosistem Antigravity berakar pada pemahaman mendalam terhadap arsitektur panggilan tool deklaratif. Ini BUKAN tentang pemrograman multi-threading biasa (seperti goroutines atau pthreads di backend), melainkan tentang bagaimana **Parent AI Agent (Master Orchestrator)** menyinkronisasikan eksekusi kognitif paralel dengan memanfaatkan spesifikasi tool JSON berskill kasta tertinggi.

### A. Contoh Blueprint Payload `invoke_subagent` (Multi-Domain Swarm Execution)
Saat Master Orchestrator membedah monorepo kompleks, pembelahan agen dilakukan secara paralel dalam satu kali pemanggilan tool `invoke_subagent` dengan array `Subagents` yang presisi. Berikut adalah cetak biru mutlak struktur spesifikasi muatan JSON-nya:

```json
{
  "toolSummary": "Swarm Parallel Dispatch",
  "toolAction": "Spawning 4 Pro Subagents for E-Commerce Overhaul",
  "Subagents": [
    {
      "TypeName": "self",
      "Role": "Database Migration & SQLC Specialist",
      "Model": "pro",
      "Workspace": "share",
      "Prompt": "Kamu adalah DBA Top 1%. Tugasmu murni membedah folder `C:/project/db` dan mengupdate skema migrasi PostgreSQL untuk mendukung skema e-commerce (Products, Carts, Orders) dengan Zero-Downtime Migrations. DILARANG MERUBAH FOLDER LAIN. Pasang proteksi N+1 dan index B-Tree pada foreign keys. Lakukan build check dan laporkan kesimpulan padat balik ke saya."
    },
    {
      "TypeName": "self",
      "Role": "JWT Zero-Trust Security Architect",
      "Model": "pro",
      "Workspace": "share",
      "Prompt": "Kamu adalah Principal Security Architect. Tugasmu murni mengaudit dan memperketat lapisan otentikasi di `C:/project/auth` menggunakan standar OWASP Top 10. Pasang verifikasi HMAC berantai, HTTP-Only Cookie fallback, dan proteksi Token Revocation List (TRL) di Redis. Lakukan linter dan lapor balik."
    },
    {
      "TypeName": "self",
      "Role": "gRPC Service Engine Integrator",
      "Model": "pro",
      "Workspace": "share",
      "Prompt": "Kamu adalah gRPC Microservices Architect. Tugasmu merubah file definisi `.proto` di `C:/project/proto` dan meregenerasi stub server/client untuk komunikasi antar modul pesanan dan inventory secara atomik dengan timeout serta circuit breaker."
    },
    {
      "TypeName": "research",
      "Role": "Codebase N+1 & Bad Practice Hunter",
      "Model": "pro",
      "Workspace": "inherit",
      "Prompt": "Kamu adalah Auditor Internal. Gunakan `grep_search` dengan regex untuk menelusuri seluruh direktori `C:/project/src` dan berburu query N+1, hardcoded credential, dan goroutine leaks. Simpan laporanmu ke `C:/project/scratch/audit_report.md` dan kirimkan PURE ABSOLUTE PATH file tersebut tanpa mencetak isinya."
    }
  ]
}
```

### B. Matriks Isolasi Ruang Kerja (Workspace Mode Selection)
Kegagalan terbesar saat mengoperasikan banyak agen secara bersamaan adalah bentrok modifikasi file (*File Collision / Merge Conflict*). Master Orchestrator WAJIB memilih mode ruang kerja yang tepat untuk setiap Subagent:

| Workspace Mode | Karakteristik Isolasi | Kasus Penggunaan Terbaik (Best Practice) | Risiko / Trade-Off |
| :--- | :--- | :--- | :--- |
| **`inherit`** *(Default)* | Menggunakan ruang kerja dan direktori kerja persis milik Parent Agent. Tidak ada duplikasi atau isolasi. | Sangat cocok untuk agen *read-only* / auditor (`research`) yang hanya meninjau file, atau tugas perbaikan 1 file yang sekuensial. | **Bahaya Kritis:** Jika 3 agen `inherit` mengedit file yang sama serentak, terjadi rasialisme disket (*race condition*) yang merusak file! |
| **`branch`** | Menciptakan Git branch baru atau mengklon direktori ke ruang terisolasi mandiri. | Sangat disarankan untuk eksperimen refactoring skala besar atau modifikasi berisiko tinggi yang mungkin perlu dibatalkan (*revert*). | **Konsumsi Storage:** Membantu isolasi total, namun memerlukan rekONSILIASI (git merge/rebase) dan menghabiskan I/O disk lokal pada repo raksasa. |
| **`share`** *(Recommended)* | Menggunakan underlying repository yang sama (seperti fitur *Git Worktree* atau *hg share*), memungkinkan perpindahan branch secara independen tanpa menduplikasikan direktori storage .git abtrak. | **Pilihan Emas untuk Swarm Paralel:** Setiap Subagent spesialis beroperasi pada direktori modular spesifiknya sendiri dalam kecepatan tinggi tanpa duplikasi storage eksekusi! | Memerlukan kedisiplinan pembagian tanggung jawab folder (DDD boundaries) agar agen A tidak menyentuh folder milik agen B. |

### C. Protokol Sinkronisasi Asinkron Tanpa Polling (Reactive Wakeup Protocol)
Dalam ekosistem Antigravity modern, Master Orchestrator dibebaskan dari dosa *CPU polling loop*:
- **DILARANG KERAS POLLING:** Setelah memantulkan instruksi via `invoke_subagent`, agen induk TIDAK BOLEH melakukan perputaran `schedule`, `sleep`, atau memikir berulang kali ("Apakah agen sudah selesai? Mari saya cek lagi"). Ini adalah penghinaan terhadap efisiensi token!
- **Reactive Wakeup:** Sistem runtime dibekali mekanisme bangun reaktif. Setelah memanggil armada agen, Parent Agent cukup mengakhiri gilirannya (*end turn*) tanpa memanggil tool lanjutan. Ketika ada subagent yang menyelesaikan tugasnya atau melontarkan pesan balik melalui tool `send_message`, sistem akan menyemburkan pemberitahuan langsung ke dalam *context window* Parent Agent dan menyalakannya secara otomatis untuk mengkonsolidasi hasil!
- **Manajemen Anomali:** Alat `manage_subagents` (`Action: 'list'`, `'kill'`, `'kill_all'`) hanya diputus saatParent Agent disenggol oleh notifikasi kegagalan liveness (atau saat operasi re-akuisisi paksa dari interupsi pengguna).


## 8. Anti-Patterns Kritis (Zero-Tolerance)

❌ **Anti-Pattern 1: Membebani 1 Agen dengan 200 File**
**Salah:** Menyuruh satu subagent melakukan "Review seluruh folder `/src`" yang berisi 200 file. Subagent akan kehabisan waktu, memotong (truncate) pikiran, dan melewatkan masalah kritis.
**Benar:** Gunakan `list_dir` untuk menghitung file. Jika >20 file, pecah menjadi 5 kelompok, dan lepaskan 5 subagent spesialis.

❌ **Anti-Pattern 2: Broad/Vague Prompt ke Subagent**
**Salah:** Master Orchestrator mengirim `Prompt`: "Tolong bereskan database."
**Benar:** Prompt wajib bersifat laser-focused: "Kamu adalah `Postgres_Optimization_Agent`. Analisis file `repository/user_repo.go`. Cari query N+1. Buat batching function menggunakan `sqlc`. Simpan hasilnya di `scratch/fix.go` dan laporkan absolute path-nya ke saya."

## 9. Production Edge Cases

1. **Edge Case 1: Subagent Timeout / Terjebak Infinite Loop**
   - **Kondisi:** Salah satu agen dari 10 agen yang di-spawn mengalami masalah dan terjebak me-run linter yang sama tanpa henti, memakan resource.
   - **Penanganan:** Master Orchestrator WAJIB menggunakan `manage_subagents` dengan aksi `kill` atau mengatur `TimerCondition` pada `schedule` untuk melakukan liveness check. Jika agen tidak merespons dalam 5 menit, kill, catat sebagai kegagalan parsial, dan laporkan.

2. **Edge Case 2: Teknologi Campuran (Polyglot) yang Bentrok**
   - **Kondisi:** Subagent A (Rust) sedang mengupdate gRPC protobuf definitions. Subagent B (Golang) secara bersamaan mencoba membaca protobuf yang sama untuk re-generate kode, menimbulkan *Race Condition* di File System.
   - **Penanganan:** Master Orchestrator harus bertindak sebagai *Mutex Lock*. Pembagian tugas harus sekuensial pada sumber daya bersama: Rust merubah `.proto` -> Selesai -> Master Orchestrator menerima status -> Master Orchestrator men-spawn Golang agent untuk regenerasi kode.

3. **Edge Case 3: Batas API Rate Limit (Quota Exceeded)**
   - **Kondisi:** Menskalakan 20 agen `pro` secara serentak memicu pemblokiran API Rate Limit atau menghabiskan budget pengguna (jika tidak unlimited).
   - **Penanganan:** Tetapkan "Max Concurrent Pro Agents" ke batas aman (misal 5, menggunakan `SetLimit`). Jika ada 15 tugas, masukkan ke dalam Queue internal Master Orchestrator, dan spawn gelombang berikutnya hanya ketika ada agen yang selesai (*Rolling Spawn*).

## 10. Analisis Trade-Off: Greenfield vs Brownfield Protocols

Setiap protokol penyergapan proyek memiliki kelebihan dan kekurangan struktural yang wajib dipahami oleh Arsitek Induk:

**Kelebihan (Greenfield Dynamic Swarm):**
1. **Kecepatan Paralel Maksimal:** Dapat merilis struktur 15 modul dalam hitungan menit karena tidak ada dependensi legacy yang menghambat.
2. **Kepatuhan Standar Murni (100% Top 1%):** Sejak awal kode didikte oleh linter terkejam tanpa pengecualian atau *tech debt*.
3. **Isolasi Penuh:** Setiap subagent bekerja pada direktori kosong mandiri yang bebas dari *file lock contention*.

**Kekurangan (Greenfield Dynamic Swarm):**
1. **Risiko Over-Engineering:** Bisa memicu pembuatan arsitektur yang terlalu kompleks untuk kebutuhan yang sebenarnya simpel (jika pembicaraan awal tidak divalidasi).
2. **Biaya Token Tinggi di Awal:** Membangun seluruh fondasi dari 0 membutuhkan konsumsi token serentak yang intensif.

**Kelebihan (Brownfield Reconnaissance & Strangler Fig):**
1. **Keamanan Operasional (Zero Downtime):** Proyek legacy user tidak rusak; fitur eksisting tetap stabil tanpa terpengaruh eksperimen refactor.
2. **Efisiensi Fokus:** Bedah hanya dilakukan di titik sakit (*pain points*) yang terdeteksi via `grep_search`.

**Kekurangan (Brownfield Reconnaissance):**
1. **Kompleksitas Isolasi:** Membutuhkan penulisan *wrapper*, *adapter*, atau *facade* ganda agar kode baru yang type-safe bisa berbicara dengan kode lawas yang rapuh.
2. **Durasi Eksekusi Lebih Lambat:** Waktu subagent banyak dihabiskan untuk membaca dan memverifikasi keterkaitan (*dependency graph*) sebelum menulis satu baris kode pun.
