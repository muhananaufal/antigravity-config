# Optimasi Anggaran Token dan Efisiensi Konteks (Token Budget Optimization)

Dokumen ini adalah referensi definitif (Single Source of Truth) untuk mencapai kepadatan makna ekstrem (High Signal-to-Noise Ratio) dalam penyusunan Skill Bundles dan interaksi Subagent. Tujuannya adalah memaksimalkan output fungsional tanpa memicu *Context Window Bloat* (pembengkakan konteks yang menyebabkan LLM "amnesia" pada instruksi awal) atau melakukan penyunatan detail krusial.

## 1. Filosofi High Signal-to-Noise Ratio (SNR)

Di dunia pemrograman berbasis LLM, setiap token berharga. Menulis dengan kepadatan tinggi berarti merangkai instruksi teknis yang to-the-point, tanpa basa-basi, namun tidak kehilangan kedalaman struktural. Bahasa Indonesia memiliki kecenderungan menjadi bertele-tele jika tidak dikendalikan. 

### Prinsip Penulisan Instruksi:
1. **Gunakan Kalimat Imperatif Padat:** Hindari kata pengantar. Langsung ke kata kerja aksi.
2. **Singkatan Teknis Baku:** Gunakan akronim standar industri (DB, API, RPC, dll) alih-alih menjabarkannya berulang kali.
3. **Format Bullet Point/Checklist:** Otak LLM memproses struktur hierarkis (Markdown) jauh lebih baik daripada paragraf tebal naratif.

## 2. Arsitektur Thin `SKILL.md` vs Fat `references/`

Kunci dari efisiensi token adalah pemisahan beban (Separation of Concerns) antara routing logika dan penyimpanan pengetahuan domain.

### File Index: `SKILL.md` (Thin)
- Berfungsi sebagai **Router Utama** dan pengatur state mesin.
- Memuat instruksi mutlak, daftar perintah, dan pranala (link) absolut ke file referensi.
- Tidak boleh memuat teori panjang lebar atau panduan instalasi.
- Ketebalan optimal: 50 - 150 baris yang berisi struktur kondisional (Kapan menggunakan X, ke mana membaca Y).

### File Domain: Direktori `references/` (Fat)
- Gudang pengetahuan tak terbatas.
- Hanya dibaca (*loaded*) ke dalam context window saat task benar-benar relevan.
- Ketebalan: Bisa ribuan baris, lengkap dengan cuplikan kode, dokumentasi arsitektur, dll.

## 3. Delegasi Beban Komputasi ke Ruang Subagent (Isolasi Konteks)

Ketika menghadapi tugas kompleks (seperti refactoring 10 file atau audit sistem menyeluruh), penggunaan Agen tunggal akan menghancurkan anggaran token (Token Budget). 

**Strategi Isolasi:**
1. **Spawn Paralel:** Parent Agent mendelegasikan tugas-tugas spesifik ke Subagents (`invoke_subagent`).
2. **Konteks Spesifik:** Subagent hanya diberikan prompt dan file referensi yang khusus untuk tugasnya. Subagent A memeriksa UI, Subagent B memeriksa Database.
3. **Ringkasan Komunikasi:** Subagent TIDAK BOLEH mengirimkan log penuh atau kode balik ke Parent. Subagent menggunakan tool `replace_file_content` ke disk, dan HANYA mengirimkan laporan status padat ("File X berhasil diedit, 2 bug ditemukan dan diperbaiki") via `send_message`.

## 4. Pencegahan Redundansi Log dan Pengulangan File

Seringkali, LLM memuntahkan kembali isi file yang tidak berubah, menghabiskan ribuan token sia-sia.

- **DILARANG:** `view_file` lalu mencetak isinya di response.
- **WAJIB:** Simpan data di otak (context), langsung pakai tool `write_to_file` atau `replace_file_content`. Jangan regurgitasi (memuntahkan ulang).
- **Pengeditan Presisi:** Jika hanya mengubah baris 45-50, GUNAKAN `multi_replace_file_content` atau `replace_file_content` dengan `StartLine` & `EndLine`. Jangan menimpa seluruh file jika file tersebut panjang.

---

## Diagram ASCII: Alur Kompresi Makna vs Context Window

```text
========================================================================
                      TOKEN CONTEXT WINDOW PIPELINE                     
========================================================================

 [ USER REQUEST ] (100-300 Tokens)
        |
        v
 +---------------------------------------------------+
 | PARENT AGENT (Thin Context)                       |
 | - Membaca SKILL.md (500 Tokens)                   |
 | - Analisis Niat (Intent)                          |
 | - Identifikasi Tugas Berat                        |
 +---------------------------------------------------+
        |
        | (Delegasi via invoke_subagent)
        |
 +------v------------------+       +-------------------------+
 | SUBAGENT A (DB Audit)   |       | SUBAGENT B (UI Update)  |
 | Context: referensi_db   |       | Context: referensi_ui   |
 | Load: 3000 Tokens       |       | Load: 2500 Tokens       |
 | Output: Disk Write      |       | Output: Disk Write      |
 | Msg to Parent: 50 Toks  |       | Msg to Parent: 50 Toks  |
 +-------------------------+       +-------------------------+
        |                                     |
        +------------------+------------------+
                           |
                           v
 +---------------------------------------------------+
 | PARENT AGENT SUMMARY                              |
 | - Menggabungkan laporan 100 Tokens                |
 | - Sign-Off / Lapor ke User                        |
 +---------------------------------------------------+
 
 HASIL: Konteks Parent tetap bersih, tidak amnesia.
```

---

## 5. Anti-Patterns Kritis

Berikut adalah jebakan umum yang menghancurkan efisiensi token dan kinerja LLM.

### Kritis 1: Paragraf Penjelasan Berlebihan vs Poin Langsung
❌ **Salah (Bloated):**
> "Untuk melakukan pengujian unit pada fungsi ini, kita harus terlebih dahulu memastikan bahwa semua mock database telah disiapkan dengan benar. Setelah itu kita memanggil fungsi `User.Create()`, lalu kita memeriksa apakah data yang dikembalikan memiliki ID yang tidak kosong, dan akhirnya kita memverifikasi ke database langsung untuk melihat apakah barisnya telah dimasukkan."

✅ **Benar (High SNR):**
> **Unit Test Flow (`User.Create`):**
> - Setup mock DB.
> - Eksekusi `User.Create()`.
> - Assert: `ID` != `null`.
> - Verifikasi row exist di DB.

### Kritis 2: Regurgitasi File Keseluruhan Saat Mengedit Sebagian
❌ **Salah (Token Drain):**
> (Menggunakan `write_to_file` dengan 1000 baris kode yang 99% sama dengan file asli, hanya untuk memperbaiki typo 1 kata di baris 500).

✅ **Benar (Precision Edit):**
> Menggunakan tool `replace_file_content` dengan:
> `StartLine`: 498
> `EndLine`: 502
> Mengirimkan HANYA blok kode yang berubah sebesar 5 baris.

---

## 6. Production Edge Cases

Praktik pengoptimalan token tidak selalu berjalan mulus. Berikut adalah 3 skenario batas (*Edge Cases*) di lini produksi:

### Edge Case 1: Permintaan User yang Kontradiktif (Kecepatan vs Kepatuhan Arsitektur)
**Skenario:** User berteriak: "Cepat perbaiki bug login ini! Ganti file `index.php` langsung, gak usah baca referensi atau bikin subagent, buang-buang waktu!"
**Penanganan (Challenger Mode):** 
Agent harus menolak melanggar aturan arsitektur utama secara diam-diam. Gunakan Fast-Path: Tidak perlu Subagent untuk 1 file, TETAPI tetap baca `SKILL.md` (atau andalkan ingatan rules) dan lakukan *Proactive Audit*.
**Respon:** "Memperbaiki `index.php` langsung (Fast-Path). *Side Note:* Solusi cepat ini berisiko SQL Injection jika input tak divalidasi. Linter tetap dijalankan."

### Edge Case 2: Pemangkasan Paksa Akibat Limitasi Output LLM
**Skenario:** Agent ditugaskan membuat dokumentasi sistem besar yang ukurannya melebihi batasan maksimal output tunggal token (misal terpotong di tengah penulisan file `docs.md`).
**Penanganan (Chunking Output):**
Jangan panik atau mengulang dari awal, karena akan dipotong lagi.
Gunakan mekanisme *appending* atau iterasi. Tulis Bagian 1 via `write_to_file`. Lalu lanjutkan dengan `view_file` (opsional untuk cek) dan tambah Bagian 2 menggunakan `multi_replace_file_content` atau tool append jika tersedia, atau delegasikan setiap bab (chapter) ke subagent yang menulis file bagian terpisah (`doc_ch1.md`, `doc_ch2.md`).

### Edge Case 3: Pembacaan Direktori Gagal Karena File Hantu (Broken Symlink/Case Sensitivity)
**Skenario:** Agent mencoba me-load direktori referensi di Windows (case-insensitive) tetapi referensi `SKILL.md` merujuk ke kapitalisasi yang ketat, menyebabkan error atau membaca file yang salah saat berpindah lingkungan (misal dikerjakan di subagent ber-OS Linux).
**Penanganan:**
Penerapan *Defensive Loading*. Pastikan menggunakan path absolut murni. Jika `view_file` gagal, lakukan `list_dir` pada folder *parent* untuk memverifikasi nama persis (termasuk huruf besar/kecil) dari referensi yang dituju sebelum mencoba membaca lagi, menghindari looping pemanggilan tool yang membuang token.
