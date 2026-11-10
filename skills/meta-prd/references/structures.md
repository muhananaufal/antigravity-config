# Acuan Susunan Dokumen

Pendamping `SKILL.md` skill `meta-prd`. Dibaca saat menentukan bagian apa saja yang masuk ke sebuah dokumen.

**Ini acuan, bukan kewajiban.** Tiap susunan di bawah adalah daftar pertanyaan yang biasanya perlu dijawab. Bagian tanpa isi nyata dibuang. Bagian yang tidak ada di sini boleh ditambah bila isinya menuntut. Yang tetap: bagian `00` Ringkasan di depan, dan daftar sumber di belakang.

Susunan di sini diturunkan dari template yang dipublikasikan dan dibuka saat berkas ini ditulis (2026-11-10); sumbernya di bagian 6.

---

## 1. Peta Keputusan

```text
Apa yang ditunggu pembaca dari dokumen ini?
|
+-- "Setuju atau tidak kita mengerjakan ini"      -> PRD
+-- "Setuju atau tidak dengan cara ini"           -> RFC
+-- "Catat kenapa kita memilih ini"               -> ADR
+-- "Apa yang kamu temukan"                       -> Laporan
+-- "Apa urutan kerjanya"                         -> Rencana
```

Satu dokumen menjawab satu baris. PRD yang separuh isinya rancangan tabel sebaiknya dipecah: PRD pendek, lalu RFC.

---

## 2. PRD

Menjawab: masalah apa, untuk siapa, apa ukuran berhasilnya, apa yang sengaja tidak dikerjakan.

| # | Bagian | Pertanyaan yang dijawab | Komponen yang cocok |
| :-- | :--- | :--- | :--- |
| 00 | Ringkasan | Apa usulannya dalam enam butir, dan apa batasnya | `.grid-2` + `.callout.warn` |
| 01 | Masalah | Apa yang rusak atau lambat hari ini, bagi siapa, seberapa sering. Dengan bukti dari sistem, bukan dari perkiraan | paragraf + `.stat` bila ada angka nyata |
| 02 | Pengguna | Siapa saja perannya, apa yang masing-masing butuhkan | `.card.persona` atau `.tabs` per peran |
| 03 | Tujuan dan ukuran berhasil | Apa yang berubah bila ini berhasil, dan bagaimana mengukurnya | tabel: tujuan, ukuran, cara mengukur |
| 04 | Cakupan | Apa yang dikerjakan, dengan prioritas | tabel kebutuhan ber-ID + `.pill p0`-`p2` |
| 05 | Di luar cakupan | Apa yang sengaja tidak dikerjakan dan kenapa | daftar pendek |
| 06 | Alur | Jalan user dari awal sampai akhir, per peran | `.flow` atau `.diagram` |
| 07 | Asumsi dan risiko | Apa yang dianggap benar tanpa bukti, dan apa akibatnya bila salah | tabel: asumsi, cara memverifikasi |
| 08 | Tahapan | Urutan rilis | `.roadmap` atau `ol.steps` |
| 09 | Keputusan yang dibutuhkan | Apa yang harus dijawab user sebelum lanjut | `.card.decision` |
| 10 | Daftar sumber | Dari mana tiap klaim | tabel bukti |

Bagian 03 dan 05 adalah yang paling sering dilewati dan paling sering disesali. Template PRD Atlassian menempatkan keduanya secara eksplisit: sasaran beserta ukuran keberhasilannya, dan daftar hal yang berada di luar cakupan.

---

## 3. RFC

Menjawab: bagaimana membangunnya, pilihan apa yang ditimbang, kenapa yang ini.

| # | Bagian | Pertanyaan yang dijawab | Komponen yang cocok |
| :-- | :--- | :--- | :--- |
| 00 | Ringkasan | Usulannya dalam satu paragraf | `.grid-2` |
| 01 | Latar dan motivasi | Masalah apa yang dipecahkan; tautkan ke PRD bila ada | paragraf |
| 02 | Keadaan sekarang | Bagaimana sistem bekerja hari ini, dengan rujukan berkas | tabel: area, sekarang, celah, bukti |
| 03 | Usulan | Rancangannya: kontrak, skema, alur | `.diagram`, `pre`, `dl.kv` |
| 04 | Pilihan yang ditimbang | Minimal tiga opsi, masing-masing dengan kelebihan, kekurangan, dan pembatal | `.card.option` |
| 05 | Kekurangan | Kenapa sebaiknya ini tidak dikerjakan | daftar jujur |
| 06 | Kompatibilitas dan migrasi | Apa yang rusak bagi pemakai lama; cara pindah dan cara mundur | `ol.steps` |
| 07 | Keamanan, operasional, data | Temuan lensa panel yang relevan | tabel per lensa |
| 08 | Rencana uji | Bagaimana membuktikan ini benar | tabel: klaim, test |
| 09 | Tahapan | Batch dan gerbangnya | tabel fase |
| 10 | Pertanyaan terbuka | Yang belum terjawab | `.card.decision` |
| 11 | Daftar sumber | | tabel bukti |

Dua bagian yang membedakan RFC dari rencana kerja: **04 pilihan yang ditimbang** dan **05 kekurangan**. Template RFC Rust menuliskannya sebagai "Rationale and alternatives" dan "Drawbacks" ("Why should we *not* do this?"). Template proposal Go menaruhnya di "Rationale" dan menambah "Compatibility".

Ukuran: RFC penuh untuk perubahan lintas modul atau yang sulit dibalik. Untuk perubahan satu modul, RFC mini cukup: bagian 00, 03, 04, 06, 10.

---

## 4. ADR

Menjawab satu hal: keputusan apa yang diambil, dalam konteks apa, dengan akibat apa.

| # | Bagian | Isi |
| :-- | :--- | :--- |
| 00 | Ringkasan | Keputusannya dalam satu kalimat aktif, dan statusnya |
| 01 | Konteks | Kekuatan yang bekerja: teknis, organisasi, tenggat. Fakta, bukan pembelaan |
| 02 | Pilihan yang dipertimbangkan | Daftar opsi, cukup ringkas |
| 03 | Keputusan | "Kami akan ..." dalam kalimat aktif |
| 04 | Akibat | Yang jadi lebih mudah, yang jadi lebih sulit, yang harus dipantau |
| 05 | Daftar sumber | |

- Status ditulis di `eyebrow` dan `meta`: diusulkan, diterima, digantikan.
- **ADR lama tidak disunting dan tidak dihapus.** Keputusan yang dibalik ditulis sebagai ADR baru; yang lama diberi status "digantikan" dengan tautan ke penggantinya.
- Panjangnya satu sampai dua halaman. ADR yang lebih panjang biasanya RFC yang salah nama.
- Nama berkas bernomor urut per proyek: `hris-adr-0007-antrian-di-database.html` (pola lengkap di `SKILL.md` langkah 3).

Susunan Konteks, Keputusan, Status, Akibat berasal dari tulisan Michael Nygard (2011), yang juga menyebut dokumennya sebaiknya satu sampai dua halaman. MADR menambah "Considered Options" dan "Decision Drivers" sebagai bagian tersendiri.

---

## 5. Laporan dan Rencana

**Laporan temuan** (audit, hasil swipe, investigasi):

| # | Bagian | Isi |
| :-- | :--- | :--- |
| 00 | Ringkasan | Berapa temuan per tingkat keparahan, dan apa yang paling mendesak |
| 01 | Cakupan | Apa yang diperiksa, apa yang tidak, dengan alat apa |
| 02 | Temuan | Tabel ber-ID: gejala, lokasi, cara mengulang, keparahan |
| 03 | Yang berjalan baik | Supaya tidak diperiksa ulang tanpa perlu |
| 04 | Rekomendasi | Urutan perbaikan |
| 05 | Daftar sumber | Bukti per temuan |

**Rencana atau peta**: ringkasan, cara membaca, isi utama per kelompok, urutan kerja, yang sengaja ditunda, daftar sumber.

**Handover**: susunannya milik `meta-handover`; skill itu memakai gaya yang sama lewat `doc-tools`.

---

## 6. Sumber Susunan

| Jenis | Sumber | Yang diambil |
| :--- | :--- | :--- |
| PRD | Atlassian, template "Product requirements" (atlassian.com/software/confluence/templates/product-requirements) | Sasaran dan ukuran berhasil; asumsi; pertanyaan terbuka dan hal di luar cakupan |
| RFC | Rust RFC template (github.com/rust-lang/rfcs, `0000-template.md`) | Summary, Motivation, Drawbacks, Rationale and alternatives, Unresolved questions |
| RFC | Go proposal template (github.com/golang/proposal, `design/TEMPLATE.md`) | Background, Rationale, Compatibility, Implementation, Open issues |
| ADR | Michael Nygard, "Documenting Architecture Decisions", 15 November 2011 | Title, Context, Decision, Status, Consequences; satu sampai dua halaman; status "superseded" |
| ADR | MADR 4.0.0 (adr.github.io/madr) | Considered Options, Decision Drivers, Pros and Cons of the Options |

Bagian "Pengguna", "Alur", "Keamanan, operasional, data", dan "Rencana uji" tidak berasal dari template di atas. Itu tambahan dari cara kerja user: panel tujuh lensa dan kewajiban test di `AGENTS.md`.

---

## 7. Anti-Pattern

**Anti-Pattern 1: mengisi semua baris tabel acuan.** Sebelas judul dengan tiga yang berisi adalah dokumen tiga bagian yang menyamar. Buang yang kosong.

**Anti-Pattern 2: PRD yang memilih teknologi.** "Memakai Redis" di PRD mengunci keputusan sebelum pilihannya ditimbang. PRD menyebut kebutuhan ("job tidak boleh hilang"); RFC memilih alatnya.

**Anti-Pattern 3: RFC dengan satu opsi dan dua orang-orangan.** Opsi yang sengaja dibuat buruk supaya rekomendasi terlihat baik. Tiap opsi ditulis dalam versi terkuatnya.

**Anti-Pattern 4: ADR yang disunting setelah diterima.** Riwayat keputusan hilang. Tulis ADR baru.

**Anti-Pattern 5: bagian "Risiko" berisi kalimat umum.** "Ada risiko performa" tidak bisa ditindak. Tulis skenarionya: input apa, komponen mana, apa akibatnya.

---

## 8. Edge Case

**Edge Case 1: user meminta "PRD" untuk perubahan satu layar.** Tulis dokumen pendek: ringkasan, masalah, cakupan, keputusan. Jangan memanjangkan supaya terlihat seperti PRD.

**Edge Case 2: belum ada data masalahnya.** Bagian masalah ditulis sebagai asumsi dengan cara termurah memverifikasinya, dan itu disebut di ringkasan. Jangan mengarang angka.

**Edge Case 3: keputusan sudah diambil sebelum dokumen ditulis.** Itu ADR, bukan RFC. RFC yang ditulis untuk membenarkan keputusan jadi membuang waktu pembaca.

**Edge Case 4: dokumen untuk dua pembaca berbeda.** Pemilik produk dan engineer. Pisahkan lewat `.tabs` hanya bila isinya benar-benar setara; biasanya lebih jelas dua dokumen yang saling menaut.

**Edge Case 5: dokumen lama dengan gaya lain.** Jangan menimpa. Buat berkas baru dengan gaya ini dan tautkan yang lama dari daftar sumber, kecuali user meminta dokumen lamanya diganti.

**Edge Case 6: permintaan Markdown.** Bila user atau pembacanya (agen lain) meminta Markdown, susunan di berkas ini tetap berlaku; yang tidak dipakai hanya template HTML dan `doc-tools`.
