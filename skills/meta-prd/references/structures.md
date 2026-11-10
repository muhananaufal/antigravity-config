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

## 5. Jenis Dokumen Lain

Tiap susunan di bawah menyebut dari mana ia diturunkan. Yang bertanda **(susunan sendiri)** tidak punya sumber yang dibuka; perlakukan sebagai titik berangkat, bukan pegangan.

### 5.1 Laporan temuan (audit, hasil swipe, investigasi)

Diturunkan dari struktur laporan di OWASP Web Security Testing Guide, yang memisahkan pendahuluan (cakupan, batasan, waktu), ringkasan eksekutif, temuan (ringkasan lalu rincian), dan lampiran.

| # | Bagian | Isi |
| :-- | :--- | :--- |
| 00 | Ringkasan | Untuk pembaca yang tidak akan membaca rinciannya: berapa temuan per tingkat keparahan, apa yang paling mendesak, dan apa artinya bagi mereka |
| 01 | Cakupan dan batas | Apa yang diperiksa, apa yang tidak, dengan alat apa, kapan, dan batasan yang memengaruhi hasil |
| 02 | Ringkasan temuan | Satu tabel: ID, judul, keparahan |
| 03 | Rincian temuan | Per temuan: ID, judul, seberapa mungkin terjadi, dampaknya, uraian dan cara mengulang, langkah memperbaiki |
| 04 | Yang berjalan baik | Supaya tidak diperiksa ulang tanpa perlu **(susunan sendiri)** |
| 05 | Rekomendasi | Urutan perbaikan **(susunan sendiri)** |
| 06 | Lampiran | Cara menguji, arti tiap tingkat keparahan, dan daftar semua yang diperiksa, termasuk yang tidak bermasalah |
| 07 | Daftar sumber | Bukti per temuan |

Laporan swipe dibangun `swipe-tools` dengan susunannya sendiri; tabel ini untuk laporan yang ditulis tangan.

### 5.2 Rencana

Diturunkan dari lima unsur "pitch" di *Shape Up* (Ryan Singer, bab 6): masalah, selera waktu, solusi, lubang kelinci, dan yang tidak dikerjakan.

| # | Bagian | Isi |
| :-- | :--- | :--- |
| 00 | Ringkasan | Apa yang akan dikerjakan dan apa yang tidak, dalam beberapa baris |
| 01 | Masalah | Kejadian atau kebutuhan yang mendorong pekerjaan ini |
| 02 | Batas waktu yang mau dihabiskan | Berapa besar pekerjaan ini boleh jadi, dan bagaimana batas itu membentuk solusinya. Dari user, bukan taksiran agen |
| 03 | Solusi | Unsur intinya, dalam bentuk yang langsung terbayang: sketsa, alur, daftar potongan |
| 04 | Jebakan yang sudah terlihat | Rincian yang perlu disebut sekarang supaya tidak jadi masalah di tengah jalan |
| 05 | Yang tidak dikerjakan | Fungsi atau kasus yang sengaja dikeluarkan supaya muat di batas waktunya |
| 06 | Urutan kerja | Potongan dan urutannya, tiap potongan berakhir pada yang bisa dicoba **(susunan sendiri)** |
| 07 | Daftar sumber | |

**Peta** (peta belajar, peta aplikasi): ringkasan, cara membaca, isi utama per kelompok, yang sengaja ditunda, daftar sumber **(susunan sendiri)**.

**Handover**: susunannya milik `meta-handover`; skill itu memakai gaya yang sama lewat `doc-tools`.

### 5.3 Runbook

Diturunkan dari praktik "Use runbooks to perform procedures" (OPS07-BP03) di AWS Well-Architected Framework: runbook adalah langkah demi langkah untuk satu hasil, dengan hasil yang diharapkan, alat dan izin yang diperlukan, penanganan kegagalan, pemilik, dan siapa yang dihubungi; disimpan di version control, diperbarui saat prosesnya berubah, dan **divalidasi dengan dijalankan orang lain**.

AWS memakai "runbook" untuk satu prosedur. Di sini satu dokumen memuat semua prosedur satu sistem, karena pemegangnya satu orang; tiap prosedur di dalamnya mengikuti bentuk di bawah.

| # | Bagian | Isi |
| :-- | :--- | :--- |
| 00 | Ringkasan | Sistem ini apa, jalan di mana, siapa pemiliknya, apa yang belum dicoba, dan tanggal terakhir dicocokkan dengan kenyataan |
| 01 | Peta | Komponen, alamat, dan ketergantungannya; diagram **(susunan sendiri)** |
| 02 | Merilis | Satu prosedur |
| 03 | Mundur | Satu prosedur; apa yang tidak bisa dimundurkan |
| 04 | Cadangan dan pemulihan | Dua prosedur; apa yang dicadangkan, ke mana, seberapa sering |
| 05 | Saat ada masalah | Per gejala: cek apa dulu, perintah apa, siapa yang dikabari |
| 06 | Perawatan berkala | Yang kedaluwarsa atau penuh, dengan tanggal atau batasnya **(susunan sendiri)** |
| 07 | Akses | Di mana kredensial disimpan (bukan isinya) dan siapa yang punya akses |
| 08 | Daftar sumber | Dari mana tiap langkah diambil |

**Tiap prosedur** dibuka dengan `dl.kv` berisi: hasil yang diharapkan, alat yang dipakai, izin khusus, siapa yang dihubungi bila gagal, dan kapan terakhir dicoba. Lalu langkahnya di `ol.steps`, dengan perintah di `pre[data-copy]` dan, untuk langkah yang bisa gagal, apa yang dilakukan bila gagal.

Runbook DILARANG memuat password, token, atau isi `.env`.

- **Tanda per langkah:** `<span class="pill muted">Belum dicoba</span>` untuk langkah yang belum pernah dijalankan, `<span class="pill ok">Dicoba 10 Nov 2026</span>` untuk yang sudah. Perintah yang terbukti ada di kode tetapi belum pernah dijalankan tetap "Belum dicoba".
- **Validasi:** sumbernya meminta runbook dijalankan orang lain. Untuk yang bekerja sendirian, padanannya: jalankan sendiri di lingkungan bukan produksi sambil hanya membaca dokumennya, dan betulkan tiap langkah yang ternyata butuh pengetahuan di kepala.
- **Runbook pertama hampir selalu draf.** Alamat server, cara rilis, cadangan, dan siapa yang dikabari jarang ada di repo. Jangan dikarang: tulis drafnya, beri status "Draf, belum pernah dijalankan" di `eyebrow`, dan jadikan tiap fakta yang hilang satu kartu keputusan. Namanya tetap `<proyek>-runbook.html`; statusnya yang berubah saat langkahnya dicoba.
- **Bagian "Keputusan yang dibutuhkan"** ditambahkan sebelum daftar sumber selama masih ada fakta yang hilang, lalu dibuang.
- **Ringkasan** tetap dua kartu (`SKILL.md` §3): kartu kiri memuat sistem ini apa, jalan di mana, dan siapa pemiliknya; kartu kanan memuat apa yang belum dicoba dan tanggal terakhir dicocokkan.

### 5.4 Panduan pakai

Diturunkan dari bagian "How-to guides" di Diátaxis: panduan menuntun pembaca melewati satu masalah atau menuju satu hasil, disusun dari kebutuhan pengguna (bukan dari daftar fitur alatnya), berupa urutan tindakan yang logis, membuang yang tidak perlu, dan berjudul persis seperti yang ditunjukkannya. Panduan bukan tutorial: ia tidak mengajar dari nol.

| Bagian | Isi |
| :--- | :--- |
| Judul | Tugas pengguna, persis: "Mengajukan klaim transport dari HP", bukan "Modul Reimbursement" |
| Untuk siapa dan kapan dipakai | Satu sampai dua kalimat; apa yang harus sudah ada sebelum mulai |
| Langkah | `ol.steps`, satu tindakan per langkah, dengan kata yang tampil di layar; tangkapan layar di `.screen` hanya di langkah yang membingungkan |
| Cabang | Ditulis sebagai syarat: "Kalau klaimnya dari Field Duty, pilih tanggal dalam rentang dinasnya" |
| Bila tidak berhasil | Pesan yang mungkin muncul, artinya, dan apa yang dilakukan **(susunan sendiri)** |
| Siapa yang dihubungi | **(susunan sendiri)** |

Satu panduan satu tugas. Penjelasan lengkap tiap kolom dan pilihan bukan isi panduan; tautkan ke tempatnya bila ada. Tanpa nama tabel, kelas, atau endpoint.

### 5.5 Catatan rilis

Diturunkan dari Keep a Changelog 1.1.0: catatan perubahan ditulis untuk manusia, ada satu entri tiap versi, perubahan sejenis dikelompokkan, versi terbaru di atas, dan tanggal rilis ditampilkan.

Tiap rilis dikelompokkan menurut enam jenis dari sumber itu, dengan label Indonesia:

| Jenis di sumber | Label di dokumen | Isi |
| :--- | :--- | :--- |
| Added | Baru | Fitur baru |
| Changed | Berubah | Perubahan pada yang sudah ada |
| Deprecated | Akan dihapus | Yang segera dihilangkan |
| Removed | Dihapus | Yang sudah dihilangkan |
| Fixed | Diperbaiki | Perbaikan kesalahan |
| Security | Keamanan | Bila menyangkut kerentanan |

Kelompok yang kosong dibuang. Satu kalimat per butir, dari sudut pengguna: apa yang ia lihat berbeda dan apa yang perlu ia lakukan. Yang tidak terlihat pengguna (refactor, test) tidak masuk. Tanggal ditulis absolut dan `datetime`-nya berformat tahun-bulan-hari, sesuai anjuran sumbernya. Untuk beberapa rilis dalam satu halaman pakai `ul.changelog` atau `ol.timeline`, terbaru di atas.

### 5.6 Laporan kemajuan

Diturunkan dari template laporan status proyek di Confluence (dibuat Arizona State University, diterbitkan Atlassian), yang memuat ringkasan status dan kendala, yang diselesaikan dalam tujuh hari terakhir, langkah berikutnya, dan risiko serta masalah.

| # | Bagian | Isi |
| :-- | :--- | :--- |
| 00 | Ringkasan | Satu kalimat status dan kendala utamanya |
| 01 | Yang selesai sejak laporan terakhir | Yang sudah bisa dicoba orang lain, dengan cara mencobanya |
| 02 | Langkah berikutnya | Yang dikerjakan sampai laporan berikut |
| 03 | Risiko dan masalah | Yang terhalang, butuh apa, dari siapa |
| 04 | Perubahan taksiran | Bila berubah: dari apa ke apa, dan kenapa **(susunan sendiri)** |
| 05 | Keputusan yang ditunggu | **(susunan sendiri)** |

Tanpa persentase: "yang sudah bisa dicoba" lebih berguna daripada "90% selesai" **(susunan sendiri)**.

### 5.7 Penawaran (pekerjaan lepas) **(susunan sendiri)**

Tidak ada sumber yang dibuka untuk jenis ini. Unsur masalah, batas waktu, dan yang tidak dikerjakan meminjam dari 5.2.

Masalah yang dipecahkan; cakupan, yang tidak termasuk, dan yang masih terbuka; tahapan dan apa yang diserahkan tiap tahap; taksiran berentang dengan asumsinya; harga dan jadwal bayar; masa berlaku penawaran. Harga dan tarif hanya dari user. Kalimat kontrak bukan bagian dokumen ini.

Cara memotong pekerjaan, menaksir, dan menyusun penawaran ada di `skills/meta-brainstorm/references/role-planner.md`; isi runbook berangkat dari `skills/meta-panel/references/lens-ops.md` bagian 2.7.

---

## 6. Sumber Susunan

Semua dibuka 10 November 2026. Sumbernya template dan panduan yang dipakai luas, bukan kajian yang membuktikan susunan itu paling efektif.

| Jenis | Sumber | Yang diambil |
| :--- | :--- | :--- |
| PRD | Atlassian, template "Product requirements" (atlassian.com/software/confluence/templates/product-requirements) | Sasaran dan ukuran berhasil; asumsi; pertanyaan terbuka dan hal di luar cakupan |
| RFC | Rust RFC template (github.com/rust-lang/rfcs, `0000-template.md`) | Summary, Motivation, Drawbacks, Rationale and alternatives, Unresolved questions |
| RFC | Go proposal template (github.com/golang/proposal, `design/TEMPLATE.md`) | Background, Rationale, Compatibility, Implementation, Open issues |
| ADR | Michael Nygard, "Documenting Architecture Decisions", 15 November 2011 | Title, Context, Decision, Status, Consequences; satu sampai dua halaman; status "superseded" |
| ADR | MADR 4.0.0 (adr.github.io/madr) | Considered Options, Decision Drivers, Pros and Cons of the Options |
| Laporan temuan | OWASP Web Security Testing Guide, versi "Latest", 5.1 Reporting Structure (wstg.owasp.org/latest/5-Reporting/01-Reporting_Structure) | Introduction dengan Scope, Limitations, Timeline; Executive Summary; Findings Summary dan Findings Details; isi tiap temuan; Appendices |
| Rencana | Ryan Singer, *Shape Up*, bab 6 "Write the Pitch" (basecamp.com/shapeup/1.5-chapter-06) | Problem, Appetite, Solution, Rabbit holes, No-gos |
| Runbook | AWS Well-Architected Framework, Operational Excellence, OPS07-BP03 "Use runbooks to perform procedures" (docs.aws.amazon.com) | Definisi runbook; isi minimum (hasil, alat, izin, penanganan kegagalan, pemilik, eskalasi); disimpan di version control; divalidasi dengan dijalankan orang lain; anti-pattern "relying on memory" |
| Panduan pakai | Diátaxis, "How-to guides" (diataxis.fr/how-to-guides) | Berorientasi tujuan; disusun dari kebutuhan pengguna; urutan logis; membuang yang tidak perlu; penamaan; bukan tutorial |
| Catatan rilis | Olivier Lacan, Keep a Changelog 1.1.0 (keepachangelog.com/en/1.1.0) | Prinsip "for humans, not machines"; enam jenis perubahan; terbaru di atas; tanggal ditampilkan |
| Laporan kemajuan | Atlassian, template "Project status report", dibuat Arizona State University (atlassian.com/software/confluence/templates/project-status) | Ringkasan status dan kendala; Accomplishments; Next Steps; Risks and Issues. Halamannya terpotong saat dibaca, jadi mungkin ada bagian yang terlewat |
| Penawaran | Tidak ada | Pencarian menemukan panduan kontrak agile 18F; halamannya tidak dibuka, jadi tidak dipakai |

Yang gagal: alamat lama bagian Reporting OWASP (`owasp.org/www-project-web-security-testing-guide/latest/5-Reporting/README`) dialihkan; isinya diambil dari alamat `wstg.owasp.org` di atas.

Bagian "Pengguna", "Alur", "Keamanan, operasional, data", dan "Rencana uji" di PRD dan RFC tidak berasal dari template di atas. Itu tambahan dari cara kerja user: lensa panel dan kewajiban test di `AGENTS.md`. Baris yang bertanda **(susunan sendiri)** di bagian 5 juga begitu.

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
