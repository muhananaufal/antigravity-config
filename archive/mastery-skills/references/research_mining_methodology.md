# Research & Mining Methodology: Eksplorasi Pengetahuan Kelas Principal (Top 1%)

Dokumen ini mendefinisikan standar absolut (Zero-Tolerance) bagi AI Agent dalam menambang pengetahuan, membedah basis kode, dan melakukan riset domain. Sebagai AI dengan tingkat keahlian Principal Engineer, dilarang keras mengandalkan hafalan LLM yang rentan basi (halusinasi) atau langsung melakukan pencarian web sebelum menguras habis seluruh sumber daya yang tersedia secara lokal. Pengetahuan lokal adalah *Single Source of Truth* (SSOT).

## 1. Hirarki Penambangan Pengetahuan

Protokol penambangan informasi wajib mengikuti urutan prioritas yang kaku dan tidak dapat ditawar:
1. **Lokal Pertama (Local-First):** Menggunakan tool `list_dir`, `view_file`, dan `grep_search` pada folder proyek lokal, folder `references`, dan dokumentasi `.md` yang terlampir.
2. **Repositori Kode & Dependensi:** Membedah folder `vendor`, `node_modules`, atau direktori cache dependensi untuk melihat implementasi nyata *source code* (menggali *internals*).
3. **Pencarian Web (Fallback Terakhir):** Hanya diizinkan jika dua langkah pertama telah terbukti gagal menghasilkan informasi yang relevan dan terkini. Harus difilter untuk hindari tutorial "Hello World" yang dangkal.

### Diagram: Alur Ekstraksi Referensi Principal Engineer

```ascii
+-------------------------------------------------------------+
|               START: Request Membutuhkan Konteks            |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
|  Fase 1: Audit Referensi Lokal (Zero-Tolerance Bypass)      |
|  - list_dir: Pemetaan struktur folder proyek & referensi    |
|  - grep_search: Mencari pola kunci, arsitektur, config      |
|  - view_file: Ekstraksi penuh file dokumentasi & kode       |
+-------------------------------------------------------------+
                              |
                 Apakah Konteks Cukup & Kuat?
                 /                          \
             [YA]                          [TIDAK]
              |                               |
              v                               v
+-----------------------------+ +-----------------------------+
| Fase 2A: Analisis Internals | | Fase 2B: Pembedahan Library |
| - Baca src internal         | | - Cari dependencies asli    |
| - Ekstrak best practices    | | - Hindari reinvent wheel    |
+-----------------------------+ +-----------------------------+
              |                               |
        Apakah Menemukan Standard Industri Top 1%?
                 /                          \
             [YA]                          [TIDAK]
              |                               |
              v                               v
+-----------------------------+ +-----------------------------+
| Fase 3A: Implementasi Kode  | | Fase 3B: Web Search (Akhir) |
| - Tulis dengan presisi      | | - Tanpa tutorial dangkal    |
| - Tanpa TODO/Placeholder    | | - Cari repositori resmi     |
+-----------------------------+ +-----------------------------+
                              |
                              v
+-------------------------------------------------------------+
|            END: Eksekusi Kode Production-Ready              |
+-------------------------------------------------------------+
```

## 2. Eksploitasi Tool Navigasi Presisi (Critical Instruction 1)

AI dilarang keras memicu eksekusi Bash/PowerShell yang primitif (seperti `cat`, `ls`, `grep`) apabila *native tools* agen tersedia. Hal ini untuk meminimalisir overhead dan menjaga integritas output JSON dari native tools.

*   **`list_dir`**: Gunakan untuk pemetaan awal secara rekursif (terbatas) untuk memahami topologi repositori tanpa mengeksekusi shell `ls -R` yang tidak stabil formatnya.
*   **`grep_search`**: Eksekusi penambangan selektif yang mendukung regex `isRegex: true`. Wajib dimanfaatkan saat mencari deklarasi tipe, fungsi *deprecated*, atau kebocoran kredensial hardcoded. Pengganti absolut untuk shell `grep`.
*   **`view_file`**: Ekstraksi konten *byte-for-byte*. Bila file berukuran raksasa, manfaatkan paginasi (start line, end line, byte offset) daripada sekadar mencetak semuanya via `cat` yang merusak konteks buffer.

## 3. Strategi Regex Advanced dengan `grep_search`

Agar tidak tenggelam dalam lautan kode saat membedah arsitektur asing, gunakan pola eksekusi regex teruji berikut saat memanggil `grep_search`:

| Target Investigasi | Pola Regex (`Query`) | `IsRegex` | Tujuan Audit & Penambangan |
| :--- | :--- | :---: | :--- |
| **Pemburu N+1 Query** | `(Range\|for).*(\.Query\|\.Find\|\.Select)` | `true` | Menemukan panggilan DB yang terjebak di dalam loop interasi. |
| **Hardcoded Secrets** | `(?i)(password\|secret\|api_key)\s*[:=]\s*["'][^"']+["']`| `true` | Mengaudit string statis yang menyimpan kredensial di kode aplikasi. |
| **Untyped Bypass** | `(interface\{\}\|any\|Dict\[Any\])` | `true` | Melacak penggunaan tipe data rapuh yang mengancam type-safety. |
| **Goroutine Leak** | `go\s+func\(.*\{` | `true` | Memastikan pemanggilan thread asinkron dilengkapi channel cancellation. |
| **Route Definitions** | `(r|router|app)\.(GET|POST|PUT|DELETE|Any)\(` | `true` | Memetakan seluruh antarmuka endpoint REST di backend Go/Node. |

## 4. Pembedahan Kode Kualitas Open-Source

Daripada membaca panduan tutorial abal-abal, Principal Engineer Top 1% menganalisis *source code* secara langsung. 
Jika kita membutuhkan implementasi *Retry Mechanism*, jangan tanya web; baca implementasi di `net/http` atau library tangguh (misal: *Polly* di C# atau *hashicorp/go-retryablehttp* di Go).

### Aturan Ekosistem Library
Dilarang menciptakan roda berulang kali (*reinventing the wheel*). 
*   **Wajib:** Periksa `go.mod`, `package.json`, atau `Cargo.toml`.
*   **Wajib:** Prioritaskan standard library, lalu library tier-1 ekosistem yang teruji pertempuran (battle-tested).
*   **Haram:** Menggunakan library antah berantah yang tidak pernah di-maintain, dengan sedikit *stars* Github, hanya demi efisiensi satu baris yang berujung *security vulnerability*.

## 5. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Web Search Bypass (Kemalasan Fatal)
AI langsung menggunakan alat pencarian web atau hafalan internal sebelum menyentuh file lokal yang kaya informasi.

```json
// CONTOH SALAH (Mengabaikan referensi lokal, langsung web search):
{
  "toolName": "search_web",
  "arguments": {
    "query": "How to configure standard database connection in this project"
  }
}
```

```json
// CONTOH BENAR (Audit Lokal Mendalam via native tooling):
{
  "step 1": {
    "toolName": "list_dir",
    "arguments": { "DirectoryPath": "C:/project/config" }
  },
  "step 2": {
    "toolName": "grep_search",
    "arguments": { "SearchPath": "C:/project/config", "Query": "database", "IsRegex": false }
  }
}
```

### ❌ Anti-Pattern 2: Pelanggaran Terminal Primitive
AI menggunakan tool eksekusi command shell alih-alih tool native agen yang direkomendasikan sistem, melanggar *Critical Instruction 1*.

```json
// CONTOH SALAH (Menggunakan bash/powershell command tool untuk inspeksi file dasar):
{
  "toolName": "run_command",
  "arguments": {
    "CommandLine": "cat /references/guidelines.md | grep 'security'",
    "Cwd": "C:/"
  }
}
```

```json
// CONTOH BENAR (Menggunakan native AI grep_search tool yang terstruktur & steril):
{
  "toolName": "grep_search",
  "arguments": {
    "SearchPath": "C:/references/guidelines.md",
    "Query": "security",
    "IsRegex": false
  }
}
```

## 6. Production Edge Cases

### Edge Case 1: Dokumentasi Online Mismatch dengan Kode Disk Lokal
**Skenario:** Versi library yang diinstal secara lokal (misal v1.2) memiliki signature fungsi yang berbeda dengan dokumentasi web terbaru (v2.0). 
**Resolusi:** *Lokal adalah SSOT.* Wajib melakukan `grep_search` pada folder dependensi instalasi lokal (`node_modules/library-x` atau `vendor/`) untuk memastikan signature fungsi dan *deprecated flags* sesuai dengan kenyataan yang akan di-*compile* atau di-jalankan, bukan berhalusinasi dari dokumentasi internet terbaru.

### Edge Case 2: Keterbatasan Perizinan Saat Inspeksi
**Skenario:** Agen mencoba melakukan `list_dir` atau `view_file` pada direktori sensitif (`.git`, sertifikat SSL server lokal) atau file terkunci oleh *process* lain.
**Resolusi:** Tangkap error secara cerdas tanpa panik. Analisis apakah file tersebut mutlak diperlukan. Jika iya, gunakan tool `ask_permission` dengan cakupan *directory* seminimal mungkin (*narrowest scope*), atau laporkan kepada pengguna bahwa file *lock* menghalangi inspeksi. Jangan pernah meminta *root/admin* secara membabi buta.

### Edge Case 3: Berhadapan dengan Monolith File Raksasa (Mega-Files)
**Skenario:** `view_file` pada `legacy_god_object.cs` yang memiliki 80.000 baris, memicu pemotongan konteks (truncation) dan kehilangan token secara drastis.
**Resolusi:** Jangan panik dan mengeksekusi paginasi buta yang memakan waktu. Segera beralih ke `grep_search` dengan fitur `MatchPerLine: true` menggunakan ekspresi reguler untuk menemukan batas blok kode spesifik (seperti definisi fungsi awal), lalu gunakan `view_file` dengan argumen `StartLine` dan `EndLine` untuk merangkum scope eksak, tanpa membaca ribuan baris sampah yang tidak diperlukan.

## 7. Analisis Trade-Off: Local-First Research vs Live Web Search

Mengapa kita bersikeras memilih riset lokal (Local-First) dibandingkan langsung mencarinya di mesin penelusuran internet? Berikut adalah analisis objektifnya:

**Kelebihan (Local-First Research):**
1. **Konteks Eksak & Nyata:** Kode lokal adalah apa yang akan di-build oleh compiler saat ini. Tidak peduli apa kata internet, jika file lokal mengatakan `v1.4.2`, itulah kebenaran mutlaknya.
2. **Kecepatan dan Latensi Nol:** Memanggil `grep_search` di disk membutuhkan milidetik, sedangkan penelusuran web membutuhkan koneksi HTTP, parsing halaman HTML, dan ekstraksi teks yang membuang kuota token.
3. **Privasi & Keamanan (Zero Leak):** Kode milik perusahaan atau pengguna tidak akan pernah dikirimkan sebagai *query string* ke mesin pencari eksternal (OWASP Data Leakage Prevention).

**Kekurangan / Kelemahan (Local-First Research):**
1. **Keterbatasan Cakupan:** Jika dokumentasi lokal tidak lengkap atau pengembang asli tidak pernah menulis komentar, agen tidak akan mendapatkan jawaban mutlak dari disk.
2. **Risiko Echo-Chamber:** Jika kode base asli sudah buruk (mengandung bug atau anti-pattern kuno), riset murni dari disk lokal bisa membuat agen meniru pola salah tersebut berulang kali tanpa tahu standar industri terbaru yang jauh lebih baik di internet.
3. **Overhead Pemindaian Disk:** Pada proyek super monolit (berukuran >10 GB), melakukan pencarian regex liar dapat menyebabkan beban I/O tinggi pada mesin pengguna.

## Kesimpulan Operasional
Hukum ini bersifat absolut. Penjelajahan harus berbasis fakta lokal, referensi kode sejati (*internals*), dan penghindaran *wheel-reinventing*. Eksekusi alat native harus lebih dulu mendominasi atas eksekusi shell mentah, memastikan setiap langkah yang diambil adalah langkah Principal Engineer Top 1%.
