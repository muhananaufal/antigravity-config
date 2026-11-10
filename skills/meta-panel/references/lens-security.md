# Lensa 4 — Security (setara senior application security engineer)

Pendamping `SKILL.md` skill `meta-panel`. Dibuka saat request menyentuh auth, izin, role, data pribadi, upload, input bebas, URL keluar, laporan atau export, atau endpoint baru.

Lensa ini menjawab satu pertanyaan sebelum yang lain: **setelah perubahan ini, siapa yang bisa melakukan atau melihat sesuatu yang sebelumnya tidak bisa?** Sebagian besar celah di aplikasi bisnis bukan serangan canggih, melainkan izin yang melebar tanpa disadari.

---

## 1. Cara Berpikirnya

| Pertanyaan pemula | Pertanyaan senior |
| :--- | :--- |
| "Sudah pakai middleware auth?" | "Setelah login, apa yang mencegah user A membaca data user B di endpoint ini?" |
| "Input sudah divalidasi?" | "Input mana yang akhirnya sampai ke query, path berkas, perintah, HTML, atau URL keluar?" |
| "Password di-hash?" | "Rahasia apa yang sekarang lewat log, URL, pesan error, atau berkas yang ikut ter-commit?" |
| "Ada rate limit?" | "Rate limit itu dikunci ke apa, dan bisakah kuncinya dipalsukan?" |
| "Sudah aman?" | "Kalau ini bocor atau disalahgunakan, bagaimana kita tahu, dan dari catatan apa?" |

Kerangka sapuannya STRIDE, enam jenis ancaman dari Microsoft Threat Modeling:

```text
S  Spoofing                menyamar sebagai orang lain          -> autentikasi
T  Tampering               mengubah data yang bukan haknya      -> integritas, otorisasi tulis
R  Repudiation             menyangkal pernah melakukan sesuatu  -> jejak audit
I  Information disclosure  melihat yang bukan haknya            -> otorisasi baca, isi response
D  Denial of service       membuat layanan tidak bisa dipakai   -> batas ukuran, jumlah, waktu
E  Elevation of privilege  mendapat hak yang lebih tinggi       -> batas peran, mass assignment
```

Untuk tiap huruf, tanya: perubahan ini membuka jalan baru untuk itu atau tidak. Enam jawaban satu baris sudah merupakan sapuan; yang masuk panel hanya yang "ya".

---

## 2. Katalog Kasus Tepi

### 2.1 Otorisasi (paling sering kena)

| Cek | Skenario yang dicari |
| :--- | :--- |
| Tingkat objek | User mengganti id di URL atau body. Query-nya menyaring per pemilik, atau hanya mengandalkan "sudah login"? |
| Tingkat fungsi | Endpoint admin yang hanya disembunyikan di menu tapi tidak dijaga di route. |
| Tingkat properti | Response memuat kolom yang tidak boleh dilihat peran itu; request boleh mengisi kolom yang tidak boleh ia ubah (`role`, `is_admin`, `harga`, `status`). |
| Komponen izin bersama | Policy atau Gate yang dilonggarkan untuk satu jalur ikut melonggarkan jalur lain yang query-nya tidak dibatasi. |
| Cabang penyempit yang tidak pernah jalan | Kondisi di controller mengulang cek yang sama dengan penjaga endpoint, sehingga cabang "hanya milik sendiri" tidak pernah tereksekusi. |
| Role sakti | `Gate::before` atau bypass untuk role tertentu membuat semua test dan dokumentasi yang memakai role itu tidak berarti. |
| Izin dan fitur tidak sinkron | Permission ada di kamus tapi tidak dicek di mana pun, atau dicek tapi tidak ada di seeder. |
| Channel dan realtime | Otorisasi channel broadcast diuji dengan driver yang salah sehingga "ditolak" lulus karena alasan lain. |

### 2.2 Autentikasi dan sesi

| Cek | Skenario yang dicari |
| :--- | :--- |
| Pencabutan | Token atau sesi yang dicabut masih diterima karena di-cache. |
| Reset password | Kanal reset yang diasumsikan (email) ternyata tidak dipakai sistem ini; siapa sebenarnya yang bisa mereset, dan lewat mana. |
| Jawaban saat sumber akun mati | Komponen yang menjawab "user tidak ditemukan" saat database mati bisa membuat klien menghapus token semua orang. Telusuri apa yang dilakukan pemanggil dengan jawaban itu. |
| Sumber kebenaran akun | Dua sistem memegang password yang sama atau berbeda; aturan "akun lokal urusan lokal" berlaku untuk sistem mana. |
| Rate limit login | Dikunci ke IP dari header yang bisa dipalsukan, atau kuncinya jatuh ke IP karena urutan middleware. |

### 2.3 Input yang tidak dipercaya

| Tujuan input | Yang dicek |
| :--- | :--- |
| Query database | Dirangkai dari string atau lewat parameter. `ORDER BY`, nama kolom, dan `LIMIT` dari input sering terlewat. |
| HTML dan JavaScript | Teks user di dalam atribut, di dalam blok `<script>`, di dalam JSON yang disisipkan ke halaman. Uji escaping dengan mengecek karakter bahayanya (`<`, `>`, `&`, kutip), bukan dengan mencocokkan satu payload contoh. |
| Path berkas | Nama berkas dari user yang digabung ke direktori: `..`, path absolut, nama khusus sistem operasi. |
| Perintah shell | Daftar atau nama yang disisipkan ke perintah; newline dan spasi memecah perintah. |
| URL keluar | Server mengambil URL yang diberi user (webhook, impor dari URL, pratinjau tautan). |
| Deserialisasi dan decoder longgar | Field atau enum tak dikenal yang diam-diam diabaikan atau dijadikan nilai nol. |
| Upload | Tipe sebenarnya vs ekstensi, ukuran, tempat simpan yang bisa dieksekusi atau diakses publik, izin direktori. |
| Header | `X-Forwarded-For`, `Host`, `Origin` dipercaya tanpa daftar proxy tepercaya. |

### 2.4 Data sensitif

| Cek | Skenario yang dicari |
| :--- | :--- |
| Log | Password, token, isi `.env`, atau data pribadi tercetak saat debug (termasuk lewat mode jejak shell). |
| Pesan error | Stack trace, nama tabel, atau path server tampil ke user. |
| Repo | Kredensial, transkrip, atau salinan berkas proyek ikut ter-commit; URL remote yang menanam token. |
| Export dan laporan | Berkas export memuat kolom yang tidak tampil di layar; tautan unduhan bisa ditebak. |
| Dokumentasi | Contoh response yang dibuat dengan data atau akun sungguhan. |
| Alamat forensik | Menulis "bocor di commit X" di tempat publik justru menunjukkan alamatnya. |

### 2.5 Ketersediaan

| Cek | Skenario yang dicari |
| :--- | :--- |
| Tanpa batas | Endpoint daftar tanpa pagination, pencarian tanpa batas panjang, upload tanpa batas ukuran, impor tanpa batas baris. |
| Pekerjaan mahal yang bisa dipicu siapa saja | Export, laporan, kirim email, generate PDF tanpa throttle. |
| Kunci | Operasi yang mengunci tabel atau baris lama dan bisa dipicu berulang. |

### 2.6 Jejak dan pemulihan

| Cek | Skenario yang dicari |
| :--- | :--- |
| Siapa melakukan apa | Aksi penting (setujui, hapus, ubah izin, ubah nominal) tercatat dengan pelaku dan waktunya. |
| Jejak yang bisa dimatikan | Trigger atau kebijakan baris yang bisa dinonaktifkan oleh peran yang sama dengan peran aplikasi. |
| Pemicu kontrol | Rotasi rahasia dan peninjauan akses dijadwalkan atau dipicu peristiwa (orang keluar, perangkat dicurigai, sebelum go-live), bukan menunggu insiden pertama. |

---

## 3. Dua Daftar Rujukan

Dipakai sebagai daftar periksa silang setelah sapuan STRIDE, bukan untuk disalin ke panel.

**OWASP Top 10:2021 (aplikasi web):** A01 Broken Access Control · A02 Cryptographic Failures · A03 Injection · A04 Insecure Design · A05 Security Misconfiguration · A06 Vulnerable and Outdated Components · A07 Identification and Authentication Failures · A08 Software and Data Integrity Failures · A09 Security Logging and Monitoring Failures · A10 Server Side Request Forgery. Situs OWASP menyebut ada kandidat rilis 2025; daftar barunya belum dibuka saat berkas ini ditulis.

**OWASP API Security Top 10:2023:** API1 Broken Object Level Authorization · API2 Broken Authentication · API3 Broken Object Property Level Authorization · API4 Unrestricted Resource Consumption · API5 Broken Function Level Authorization · API6 Unrestricted Access to Sensitive Business Flows · API7 Server Side Request Forgery · API8 Security Misconfiguration · API9 Improper Inventory Management · API10 Unsafe Consumption of APIs.

Dua daftar itu sama-sama menaruh kontrol akses di urutan pertama. Kalau waktu hanya cukup untuk satu bagian katalog, kerjakan 2.1.

---

## 4. Cara Mengecek di Kode

1. **Cari penjaganya.** Untuk tiap endpoint yang tersentuh: middleware apa, policy atau gate apa, dan di baris mana query dibatasi per pemilik.
2. **Cari semua pemakai penjaga itu** (peta keterkaitan 2.1 dan 2.3) sebelum mengubahnya.
3. **Ikuti input sampai tujuannya.** Dari parameter request ke query, path, perintah, HTML, atau URL keluar. Sebut berkas tempat ia mendarat.
4. **Baca source library untuk perilaku bawaan yang menyangkut keamanan** sebelum mengandalkannya: proxy tepercaya, opsi decoder, urutan middleware. Tiga kejadian di proyek user berasal dari bawaan yang tidak seperti dugaan.
5. **Uji dengan aktor sungguhan.** Rencana test otorisasi memakai user dengan izin eksplisit tanpa role sakti, dan dua user berbeda untuk cek milik orang lain.

---

## 5. Contoh Temuan

**Ditolak:**
> Security: pastikan otorisasi dan validasi input sudah benar. Perhatikan OWASP.

**Layak dikirim:**
> Setelah `presence>report` dibuka untuk karyawan, karyawan biasa yang membuka `/presence/report` melihat presensi seluruh karyawan. Cabang "hanya milik sendiri" di controller memeriksa izin yang sama dengan penjaga route, jadi tidak pernah jalan (sudah saya baca di controller; tiga test yang ada login sebagai `developer` yang mem-bypass semuanya, jadi tidak menangkap ini). Usul: batasi query per user untuk pemegang izin biasa, dan tambah test dengan aktor karyawan.

**Ditolak (kontrol reaktif):**
> Rotasi secret bila sudah pernah bocor.

Kontrol keamanan dipicu jadwal dan peristiwa berisiko, bukan menunggu insiden.

---

## 6. Anti-Pattern

**Anti-Pattern 1: menyamakan "sudah login" dengan "boleh".** Middleware auth menjawab siapa; ia tidak menjawab boleh melihat data siapa.

**Anti-Pattern 2: menyembunyikan di menu.** Tombol yang tidak tampil bukan penjaga. Penjaganya di endpoint.

**Anti-Pattern 3: menguji penolakan dengan satu payload.** Encoder yang mengubah satu karakter membuat payload contoh tidak cocok sementara celahnya tetap terbuka.

**Anti-Pattern 4: menambal dengan melebarkan hak.** Memberi peran aplikasi hak lebih supaya sebuah kunci atau kebijakan bisa jalan. Cari cara yang tidak menambah hak.

**Anti-Pattern 5: mengandalkan bawaan library dari ingatan.** Bawaan berubah antar versi dan sering lebih longgar dari dugaan. Baca source yang terpasang.

---

## 7. Edge Case

**Edge Case 1: endpoint yang belum pernah dipanggil.** Kode integrasi tanpa pemanggil belum terbukti bekerja, termasuk pengecekan keamanannya. Perlakukan sebagai hipotesis.

**Edge Case 2: dua jalur ke data yang sama.** Web dan API, atau halaman dan export. Menjaga satu jalur tidak menjaga yang lain; telusuri FormRequest, policy, dan service di kedua jalur sebelum menyatakan keduanya sama atau berbeda.

**Edge Case 3: lingkungan dev yang terbuka.** Alamat `*.localhost` dan akun uji sering memakai password sederhana. Password tidak ditulis ke berkas mana pun, termasuk laporan dan daftar periksa.

**Edge Case 4: vektor uji yang mirip rahasia.** Pemindai rahasia menandai contoh publik sebagai kebocoran dan memindai tiap commit. Tandai sejak awal, jangan menghapus pemeriksaannya.

**Edge Case 5: perubahan izin lewat migrasi atau seeder.** Menghapus permission yang masih dipakai, atau membuatnya di tempat yang bukan konvensi proyek. Cek cara proyek ini mengelola permission sebelum menyusun urutan.

**Edge Case 6: user meminta sesuatu yang membuka data.** "Buka modul ini untuk API." Yang dipanel bukan boleh atau tidak, melainkan di titik mana dibuka supaya jalur lain tidak ikut terbuka.

---

## 8. Sumber

- STRIDE: Microsoft Learn, "Threats - Microsoft Threat Modeling Tool" (dibuka 2026-11-10).
- OWASP Top 10:2021 (top10.owasp.org/2021) dan OWASP API Security Top 10:2023 (api-security.owasp.org), dibuka 2026-11-10.
- Go security best practices (go.dev/doc/security/best-practices), dibuka 2026-11-10: `govulncheck`, fuzzing, race detector, `go vet`.
- Kejadian di proyek user dari `shared/LEARNED.md`: OffPolicy dan presensi (altrms), `X-Forwarded-For` di gin, `DiscardUnknown` di connect-go, urutan throttle dan route binding (pentahoot), escaping `json_encode` (manunggal-purchasing), kredensial di repo config, kebocoran lewat `bash -x`, pemicu rotasi (pentamoo-sso).
