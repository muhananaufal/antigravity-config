# Quality Audit Checklist (7-Lapis Sign-Off Penerbangan)

Dokumen ini adalah instrumen wajib yang harus dilalui oleh setiap agen AI (maupun Subagent) sebelum mendeklarasikan sebuah tugas pengembangan, penyusunan Skill, atau perbaikan bug sebagai "Selesai" (`[x]`). Ini adalah *Pre-Flight Sign-Off Checklist* berstandar Top 1% Engineering, memastikan nol toleransi terhadap kode setengah matang.

## 1. Filosofi 7-Lapis Gate

Kualitas tidak datang dari harapan, melainkan dari pengujian tanpa belas kasihan. Sistem ini mencegah agen menjadi "Yes-Man" yang membiarkan utang teknis (technical debt) menumpuk di kode base user.

---

## 2. Diagram ASCII: 7-Lapis Quality Gate

```text
        +-------------------------------------------------+
        |           TUGAS SELESAI (KANDIDAT)              |
        +-----------------------+-------------------------+
                                |
 [GATE 1: TDD & LINTER] <-------+
 (Verifikasi Terminal)          | Lulus? --(Ya)--> Lanjut
                                v
 [GATE 2: ABSOLUTE SYNC] <------+
 (Rute Tabel vs Disk Folder)    | Lulus? --(Ya)--> Lanjut
                                v
 [GATE 3: ZERO PLACEHOLDER] <---+
 (No // TODO, No Fake Code)     | Lulus? --(Ya)--> Lanjut
                                v
 [GATE 4: KEPADATAN MINIMAL] <--+
 (>= 130 baris/file acuan)      | Lulus? --(Ya)--> Lanjut
                                v
 [GATE 5: NEUTRAL TRADE-OFF] <--+
 (>=3 Pro, >=3 Kontra)          | Lulus? --(Ya)--> Lanjut
                                v
 [GATE 6: SEC & EDGE-CASES] <---+
 (OWASP, Defensive Design)      | Lulus? --(Ya)--> Lanjut
                                v
 [GATE 7: KANBAN TRACKING] <----+
 (Update task.md)               | Lulus? --(Ya)--> [ DEPLOYMENT & SUCCESS ]
```

---

## 3. Rincian Checklist 7 Lapis

### Lapis 1: Verifikasi Linter/Test Otomatis di Terminal
Kode tidak boleh diserahkan jika belum lolos *syntax check* dan unit testing.
- **Tindakan:** Jalankan perintah `npm run lint`, `go test ./...`, `cargo test`, atau `php artisan test` menggunakan tool terminal `run_command`.
- **Standar Cekal:** Jika ada 1 warning yang bisa di-fix secara programatik, WAJIB diperbaiki. Jika tidak ada linter, agen WAJIB merekomendasikan setup linter kepada user.

### Lapis 2: Sinkronisasi Absolut (Routing SKILL.md vs Disk Folder)
Mencegah penyakit "Broken Link Hantu" di masa depan, layaknya trauma Docker image yang hilang.
- **Tindakan:** Setiap path direktori atau file markdown referensi yang ditulis di `SKILL.md` WAJIB dicek keberadaannya secara fisik menggunakan tool `list_dir`.
- **Standar Cekal:** Jika `SKILL.md` merujuk pada `references/<topic>.md` tapi file aslinya adalah `references/<topic_other>.md`, GAGAL Keras. Fix path-nya!

### Lapis 3: Pemindaian Zero `// TODO` & Placeholder
Kode atau dokumen tidak boleh meninggalkan pekerjaan rumah bagi user.
- **Tindakan:** Gunakan `grep_search` pada file yang baru diedit untuk mencari kata "TODO", "FIXME", "isi sendiri", "item lainnya", atau "contoh_saja".
- **Standar Cekal:** Jika ditemukan, agen harus mengisinya dengan implementasi aslinya atau menghapusnya jika memang tidak relevan. `API_KEY` harus ditangani via `.env`, bukan `// TODO: masukin key disini`.

### Lapis 4: Bukti Batas Minimal Kepadatan Materi
Khusus untuk penulisan dokumentasi teknis atau referensi AI (misal file di dalam direktori `references/`).
- **Tindakan:** Pastikan *line count* (jumlah baris) melampaui 130 baris teks dengan kepadatan makna yang tinggi (bukan sekedar spasi kosong/enter).
- **Standar Cekal:** Menulis dokumen referensi arsitektur yang kurang dari 130 baris berarti melakukan penyunatan ilmu. Elaborasikan pola arsitektur, edge-cases, dan diagram.

### Lapis 5: Analisis Trade-Off Netral
Setiap keputusan arsitektur (misal: memilih gRPC vs REST, PostgreSQL vs MongoDB) tidak boleh bersifat partisan buta.
- **Tindakan:** Setiap usulan utama dalam dokumen RFC (`docs/rfc/`) harus memuat minimal:
  - **3 Kelebihan (Pros):** Kenapa teknologi ini bagus?
  - **3 Kekurangan/Kelemahan (Cons/Trade-offs):** Apa harga yang harus dibayar? (Latency, kompleksitas DevOps, biaya komputasi).
- **Standar Cekal:** Menyematkan "(Recommended)" tanpa meninjau 3 kekurangan kritikal dari teknologi tersebut.

### Lapis 6: Kemamangamanan OWASP & Defensive Edge-Cases
Kode tidak boleh polos tanpa pertahanan diri.
- **Tindakan:** Audit input validation, parameter binding (mencegah SQLi), penanganan XSS (sanitasi output), Rate-Limiting, dan manajemen Memory/Goroutine leaks.
- **Standar Cekal:** Meretur response 500 error tanpa mask/obfuscation stack-trace ke end-user di mode produksi.

### Lapis 7: Status Kepantasan di Kanban Tracker
Penyelesaian administrasi.
- **Tindakan:** Edit seksi Batch Tasks pada dokumen RFC (`docs/rfc/`) atau task context dari `[/]` (WIP) menjadi `[x]` (Done).
- **Standar Cekal:** Melapor ke user selesai tapi file status Kanban belum di-update.

---

## 4. Template Checklist Sign-Off Markdown (Untuk Pull Request / Artifact Review)

Setiap agen yang menyerahkan hasil kerjanya kepada pengguna atau Parent Agent diwajibkan melampirkan matriks bukti validasi berikut pada dokumen `walkthrough.md` atau pesan penyelesaian:

```markdown
### 📋 Top 1% Engineering Quality Sign-Off Table

| Quality Gate | Status | Alat Bukti Verifikasi / Terminal Output | Keterangan Mandat |
| :--- | :---: | :--- | :--- |
| **Gate 1: Automated Linter & Test** | ✅ LULUS | `go test ./...` -> `ok 0.142s` / `clippy -- -D warnings` | Zero syntax warning / zero test failures. |
| **Gate 2: Absolute Path Sync** | ✅ LULUS | `list_dir` pada seluruh path di `SKILL.md` | Seluruh 31 domain dan file referensi exist di disk. |
| **Gate 3: Zero Placeholder Scan** | ✅ LULUS | `grep_search` untuk regex `//\s*TODO` -> `0 matches` | Tidak ada hutang teknis atau kode fiktif yang tersisa. |
| **Gate 4: Content Density >=130 Lines**| ✅ LULUS | Skrip `audit_final_trinity.ps1` -> `PASSED` | File referensi terverifikasi >130 baris padat bernutrisi. |
| **Gate 5: Neutral Trade-off Analysis** | ✅ LULUS | Terdapat 3 Pros & 3 Cons di opsi arsitektur | Evaluasi objektif tanpa pemaksaan rekomendasi buta. |
| **Gate 6: OWASP & Edge Case Defense** | ✅ LULUS | Proteksi SQLi, Rate-Limiting, OOM Recovery terpasang | Minimal 3 Edge Cases produksi teratasi di dalam kode. |
| **Gate 7: Kanban Board Sync** | ✅ LULUS | Batch Tasks RFC dan context tracker di-update | Seluruh item `[/]` resmi diketuk menjadi `[x]`. |
```

---

## 5. Anti-Patterns Kritis dalam Proses Audit

### Kritis 1: Phantom Testing (Bohong telah melakukan test)
❌ **Salah:**
Agen merespon: "Saya telah memverifikasi kode ini bebas bug dan semua test pass," tanpa memanggil tool `run_command` untuk membuktikannya.
✅ **Benar:**
Agen mengeksekusi `run_command: {CommandLine: "go test -v ./..."}`, lalu membaca output terminal. Baru melaporkan hasilnya secara faktual ke user.

### Kritis 2: Penipuan Kepadatan (Bloat Padding)
❌ **Salah:**
Mencapai batas 130+ baris dengan cara meletakkan 50 baris komentar yang menceritakan sejarah bahasa pemrograman atau menggunakan jarak enter 3 spasi antar paragraf.
✅ **Benar:**
Memenuhi baris dengan *Sub-chapters*, spesifikasi tipe data yang rigid, *State Machine diagrams*, dan penjabaran detail error handling (contoh-contoh JSON error code, status HTTP, dll).

---

## 6. Production Edge Cases dalam Implementasi Audit

### Edge Case 1: Linter Terjebak di Dependensi yang Hilang
**Skenario:** Agen mencoba menjalankan Gate 1 (`npm run lint`), tapi gagal karena `node_modules` belum di-install (`Command not found` atau `module not found`).
**Penanganan:**
Agen tidak boleh langsung menyerah dan men-skip Gate 1. Agen secara otomatis harus mendeteksi ketiadaan dependensi, lalu menjalankan `npm install`, `go mod tidy`, atau `cargo fetch` secara independen di background, barulah mengulangi perintah lint. Jika gagal parah karena masalah environment, catat sebagai *Blocking Issue* di *Side Note* untuk User.

### Edge Case 2: Sistem CI yang Gantung / Stagnan
**Skenario:** Menjalankan test suit raksasa menyebabkan task terminal menggantung lebih dari batas waktu wajar (misalnya ada test e2e yang butuh browser dan timeout tanpa ujung).
**Penanganan (Defensive Execution):**
Ketika menggunakan `run_command`, agen WAJIB mengerti konteks waktu. Jalankan test dengan flag timeout eksplisit (contoh: `go test -timeout 30s ./...`). Jika asinkron, gunakan `manage_task` (kill) bila menggantung, kemudian laporkan kepada user: "Test suite berjalan terlalu lama (>30s) dan diinterupsi; direkomendasikan menjalankan test secara terpisah pada pipeline CI."

### Edge Case 3: Refactoring Skala Besar Bertabrakan dengan Zero-Placeholder
**Skenario:** Agen diminta membuat boilerplate kerangka microservice berisi 20 endpoint API. Menulis implementasi *real* seluruh endpoint akan melebihi kapasitas token dan batas waktu dialog, sehingga godaan untuk menulis `// TODO: implement endpoint logic here` sangat tinggi.
**Penanganan:**
Ganti pendekatan menjadi implementasi bertahap (Incremental Delivery). Implementasikan 1 atau 2 endpoint *end-to-end* secara sempurna tanpa placeholder, lalu minta izin user (*RFC Path* pada PM Gate) sebelum melangkah ke batch endpoint berikutnya, atau delegasikan ke *swarm of Subagents* (Satu agen per 5 endpoint). Dilarang menyisakan komentar TODO di repositori master.

---

## 7. Analisis Trade-Off: 7-Lapis Quality Gate

Penerapan pengujian 7 lapis ini mengubah kultur ekosistem pengembangan secara drastis:

**Kelebihan (Pros):**
1. **Keandalan Ekstrem:** Nyaris tidak ada kemungkinan bug konyol (seperti syntax error atau broken link) tembus ke cabang produksi.
2. **Transparansi Audit:** Matriks bukti penegakan hukum memberikan keyakinan absolut bagi Tech Lead atau Auditor eksternal.
3. **Penyelarasan Mentalitas Tim:** Mengedukasi developer baru (maupun agen AI) bahwa penulisan tes dan handling keamanan bukanlah opsi, melainkan bagian intrinsik dari penulisan fitur.

**Kekurangan (Cons):**
1. **Overhead Waktu:** Memproses 7 lapis pengujian memakan waktu ekstra (bintang 5 butuh kesabaran), yang mungkin tidak cocok untuk hackathon 24 jam atau prototipe sekali pakai.
2. **Ketergantungan Toolchain:** Jika tool terminal di OS Windows user rusak atau tidak lengkap, gate ini bisa menjadi *blocker* menyengsarakan yang menghentikan progres.
3. **Beban Pemeliharaan Tes:** Ketika persyaratan bisnis bergeser, memperbaharui unit tes di Gate 1 agar terus lolos membutuhkan upaya yang tidak sedikit.
