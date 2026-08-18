---
name: meta-debug
description: Gunakan saat ada yang rusak dan penyebabnya belum diketahui — test merah, error runtime, perilaku tidak sesuai harapan, data yang salah entah dari mana, sesuatu yang "tadi jalan", atau bug yang kambuh setelah diperbaiki. Gunakan juga saat Anda sudah dua kali menebak perbaikan dan keduanya meleset, atau saat Anda tergoda mengubah kode sebelum bisa menjelaskan MENGAPA kode itu gagal.
---

<!-- description = KONDISI PEMICU + gejala, bukan ringkasan alur kerja.
     Bila ia meringkas empat fase di bawah, agen bisa bertindak dari
     description saja dan melewati justru bagian yang paling sering dilanggar. -->

# 🔬 meta-debug — Debugging Sistematis

> **Hukum tunggal skill ini: DILARANG MEMPERBAIKI SEBELUM AKAR MASALAH DITEMUKAN.**
>
> Diserap dari `superpowers/systematic-debugging` (2026-08-18), diselaraskan dengan `AGENTS.md` §0.4 (Proof-of-Defect) dan §5.6 (Circuit Breaker).

Menebak perbaikan terasa lebih cepat. Ia tidak. Tebakan yang meleset meninggalkan perubahan yang tidak Anda pahami di dalam kode, dan tebakan berikutnya kini berdiri di atasnya. Prosedur di bawah lebih cepat justru saat sedang terdesak.

**Hubungan dengan §0.4:** Proof-of-Defect membuktikan bug itu **ada**. Skill ini menemukan **mengapa** ia ada. Reproduksi yang MERAH adalah keluaran Fase 1, bukan pengganti Fase 1–3.

---

## §0. Gerbang

1. **DILARANG menyentuh kode perbaikan sebelum Fase 1–3 tuntas.** Termasuk perbaikan yang "sudah jelas".
2. **Hipotesis WAJIB ditulis sebelum diuji.** Hipotesis yang hanya ada di kepala akan diam-diam berubah bentuk agar cocok dengan hasil apa pun.
3. **Satu perbaikan satu waktu.** Dua perubahan sekaligus membuat Anda tidak pernah tahu mana yang bekerja — dan bila lulus, Anda mewariskan satu perubahan tak-terpahami ke masa depan.
4. **Setiap klaim penyebab berlabel epistemik** (`AGENTS.md` §3). "Saya menduga race condition" adalah `[spekulasi]` sampai ada jejak yang menunjukkannya.

---

## §1. Empat Fase

### Fase 1 — Investigasi Akar Masalah

1. **Baca pesan error sampai habis.** Termasuk stack trace penuh dan pesan yang tampak membosankan. Pesan error kerap sudah memuat jawabannya; melewatinya adalah cara termahal menghemat sepuluh detik.
2. **Reproduksi secara konsisten.** Bug yang belum bisa dipanggil sesuka hati belum bisa didebug — yang Anda lakukan sesudahnya cuma menunggu keberuntungan.
3. **Periksa perubahan terakhir.** `git log`, `git diff`, `git bisect` bila perlu. "Tadi jalan" adalah petunjuk paling berharga yang sering diabaikan.
4. **Sistem multi-komponen → pasang log diagnostik di TIAP batas.** Isolasi komponen mana yang menerima data benar dan mana yang meneruskan data salah.
5. **Telusuri aliran data MUNDUR** dari nilai yang salah ke asalnya. Bukan maju dari tempat yang Anda curigai.

### Fase 2 — Analisis Pola

> Fase yang paling sering dilewati, dan paling sering menyelesaikan masalah.

1. **Cari kode serupa yang JALAN** di dalam repo yang sama.
2. **Bandingkan yang jalan dan yang rusak secara TUNTAS** — bukan sekilas.
3. **Catat SETIAP perbedaan**, termasuk yang terlihat tidak penting. Yang terlihat tidak penting itulah yang biasanya penyebabnya; kalau ia terlihat penting, Anda sudah menemukannya sejak tadi.
4. **Petakan dependensi dan asumsi** kedua sisi: versi library, urutan inisialisasi, konteks eksekusi, konfigurasi.

### Fase 3 — Hipotesis & Pengujian

1. **Tulis hipotesis spesifik.** Bukan "ada yang salah di auth", melainkan "token divalidasi sebelum refresh selesai, jadi klaim `exp` yang dibaca masih milik token lama".
2. **Uji dengan perubahan SEKECIL mungkin** — sering cukup satu log, bukan perbaikan.
3. **Verifikasi hasilnya sebelum melangkah.**
4. **Hipotesis gugur → kembali ke Fase 1 atau 2.** DILARANG menambal hipotesis agar tetap hidup.

### Fase 4 — Implementasi

1. **Tulis test yang gagal lebih dulu** (`AGENTS.md` §0.4). Saksikan ia MERAH.
2. **Satu perbaikan terarah** pada akar masalah, bukan pada gejalanya.
3. **Verifikasi sesuai `AGENTS.md` §5.5** — jalankan segar, baca output penuh, lampirkan buktinya.
4. **Ragu test-nya sahih → Revert-to-Fail.**

---

## §2. Eskalasi — gagal 3× artinya pertanyaannya yang salah

**Bila 3 percobaan perbaikan gagal, BERHENTI menambah percobaan keempat.** Pola itu bukan tanda Anda kurang teliti; ia tanda **asumsi arsitekturalnya yang keliru**.

Yang WAJIB dilakukan, bukan mencoba lagi:

1. Nyatakan ke user bahwa 3 percobaan gagal dan sebutkan apa saja yang sudah dicoba.
2. Naikkan pertanyaannya: bukan lagi "kenapa baris ini salah", melainkan **"apakah rancangan ini memang bisa benar?"**
3. Sajikan apa yang sudah terbukti BUKAN penyebabnya — daftar itu sama berharganya dengan penyebabnya.

Ini melengkapi Circuit Breaker `AGENTS.md` §5.6, tidak menggantikannya:

| Ronde | Aksi |
| :--- | :--- |
| 1–3 | Debugging normal, prosedur §1 |
| **3× gagal** | **Ganti JENIS pertanyaan** — curigai arsitekturnya, lapor ke user |
| 4–5 | Ganti strategi/riset mendalam. Di Antigravity: kerahkan agen dengan model lebih kuat, framing "implementer sebelumnya gagal 3 kali, sekarang tugas ini milikmu" |
| >5 | STOP total. Tinggalkan jejak dan minta arahan |

Circuit Breaker hanya menghitung. Gerbang 3× ini mengubah pertanyaannya — itu bedanya, dan itu yang membuat ronde 4–5 tidak sekadar mengulang ronde 1–3 dengan lebih keras.

---

## §3. Bendera Merah — kembali ke prosedur bila Anda menangkap diri sedang…

| Pikiran | Artinya |
| :--- | :--- |
| "Coba ubah ini dulu, siapa tahu" | Anda menebak, bukan menguji hipotesis |
| Mengusulkan solusi sebelum bisa menjelaskan aliran datanya | Fase 1 belum selesai |
| Memperbaiki dua hal sekaligus | Hasilnya tidak akan bisa ditafsirkan |
| "Kemungkinan besar karena X" tanpa jejak | `[spekulasi]` yang menyamar jadi diagnosis |
| "Yang penting hijau dulu" | Anda menambal gejala; bug-nya akan kembali dengan wajah lain |
| Menghapus test yang merah | Pelanggaran §0.3 dan §5.5 sekaligus |

---

## §4. Keluaran

Sebelum menyatakan selesai, laporkan empat hal ini — tanpa satu pun boleh kosong:

```markdown
**Akar masalah:** <mekanismenya, berlabel [fakta:path:baris]>
**Bukti:** <jejak/log/diff yang menunjukkannya, bukan penalaran>
**Perbaikan:** <satu perubahan terarah + mengapa ia menyentuh akar, bukan gejala>
**Verifikasi:** <perintah yang dijalankan segar + output apa adanya + exit code>
**Regression test:** <path test yang mengunci bug ini agar tidak kembali>
```

Akar masalah yang tidak bisa Anda tulis dalam satu kalimat mekanis berarti belum ditemukan — yang Anda punya baru korelasi.
