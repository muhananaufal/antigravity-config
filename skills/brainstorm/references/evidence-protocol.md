# Evidence Protocol — Rincian Gerbang Bukti

Dokumen pendamping `SKILL.md` skill `brainstorm`. Dibaca saat Fase 0 dijalankan pertama kali pada sebuah sesi.

`SKILL.md` menetapkan **hukum**-nya. Berkas ini menetapkan **cara kerjanya**: bagaimana menilai sumber, bagaimana menyusun query, bagaimana mengutip, dan bagaimana menangkap halusinasi diri sendiri sebelum terkirim.

---

## 1. Tangga Tier Sumber

Klaim penentu WAJIB ditopang Tier 0–2. Tier 3 boleh jadi petunjuk arah, DILARANG jadi tumpuan. Tier 4 bukan sumber.

Tangga ini **berlaku di ranah apa pun** — bisnis, hukum, karir, kesehatan, teknis. Yang berubah cuma wujud artefaknya, bukan derajat kepercayaannya.

| Tier | Prinsip | Wujud di ranah umum | Wujud di ranah teknis | Boleh menopang keputusan? |
| :--- | :--- | :--- | :--- | :--- |
| **0 — Primer & bisa diperiksa ulang** | Artefak yang MENENTUKAN kenyataan itu sendiri, bukan yang menceritakannya | Teks peraturan di situs penerbitnya · laporan keuangan/filing · data badan statistik resmi · halaman harga & syarat resmi · kontrak · data milik user sendiri · dataset mentah | Source code terpasang · spesifikasi/RFC · dokumentasi versi terpin · `CHANGELOG.md` · pengukuran yang Anda jalankan sendiri | YA — bukti terkuat |
| **1 — Kajian berdata & bermetodologi** | Menyatakan cara ia sampai ke angkanya | Paper peer-reviewed · survei yang menyebut ukuran sampel, tahun, dan cara pengambilan · laporan riset industri bermetodologi · jurnalisme investigatif berbasis dokumen | Engineering blog dengan setup pengukuran · talk konferensi berdata · laporan insiden resmi | YA |
| **2 — Praktisi/saksi teridentifikasi** | Pengalaman langsung yang bisa ditelusuri siapa pelakunya | Studi kasus bernama · wawancara pelaku · testimoni yang menyebut angka, tahun, dan konteks nyata · forum profesi yang identitasnya jelas | GitHub issue/PR · postmortem publik · thread praktisi yang menyebut versi & skala | YA, dengan syarat konteksnya disebut |
| **3 — Sekunder** | Menjelaskan ulang karya orang lain | Artikel rangkuman · listicle "10 cara…" · konten marketing · thread viral tanpa data · berita yang mengutip berita | Tutorial · Medium tanpa data · konten SEO | TIDAK — hanya petunjuk arah menuju primernya |
| **4 — Ingatan model** | Pola dari data pelatihan | "Setahu saya…", konsensus yang terasa familiar | idem | TIDAK — ini hipotesis, wajib berlabel `[memori-model]` |

### Empat penurun derajat sumber

Sumber Tier tinggi bisa jatuh derajatnya. Periksa keempatnya:

| Penurun | Tanda | Akibat |
| :--- | :--- | :--- |
| **Konflik kepentingan** | Vendor mem-benchmark produknya sendiri melawan pesaing | Tetap boleh dikutip, WAJIB ditandai. Tuntut angka pembanding independen |
| **Basi** | Terbit >3 tahun lalu pada topik cepat berubah, atau membahas versi mayor yang sudah lewat | Tandai `[BASI]`. Konfirmasi ulang ke `CHANGELOG` versi terkini |
| **Yatim primer** | Mengklaim angka tanpa menyebut dari mana | Turun ke Tier 3. Angkanya DILARANG dikutip |
| **Salin-tempel** | Kalimatnya identik dengan sumber lain | Dihitung SATU sumber bersama induknya, bukan konfirmasi independen |

### Uji independensi

Lima artikel yang mengatakan hal sama BUKAN lima bukti kalau semuanya menyalin satu tulisan asli. Sebelum menghitung "banyak sumber sepakat", tanya: **apakah masing-masing melakukan pengukuran atau pengamatan sendiri?** Kalau tidak, jumlahnya satu.

Inilah mekanisme yang membuat "asumsi yang paling sering dibicarakan" terasa seperti fakta mapan. Popularitas sebuah klaim mengukur seberapa mudah ia disalin, bukan seberapa benar ia.

---

## 2. Kerajinan Query

### Menemukan primernya — ranah umum

| Tujuan | Bentuk query |
| :--- | :--- |
| Teks aturan yang mengikat | `site:<domain-resmi-penerbit> <nomor peraturan>` · `<nama aturan> pdf resmi` |
| Angka statistik | `site:<badan-statistik> <indikator> <tahun>` — bukan artikel yang mengutipnya |
| Syarat & tenggat program | `site:<institusi resmi> <nama program> requirements deadline <tahun>` |
| Harga & ketentuan produk | Halaman pricing resmi vendor, dibuka hari ini. Harga di artikel pihak ketiga hampir selalu basi |
| Asal-usul sebuah kutipan | `"<potongan kutipan persis>" origin misattributed` · cek situs pemeriksa kutipan |
| Kinerja nyata sebuah usaha | `<perusahaan> annual report <tahun>` · filing regulator, bukan siaran pers |

### Menemukan primernya — ranah teknis

| Tujuan | Bentuk query |
| :--- | :--- |
| Dokumentasi terpin versi | `site:docs.<vendor>.com <fitur> <versi>` |
| Perilaku sebenarnya | `<library> <fungsi>` lalu baca source di `vendor/` · `node_modules/` · `~/go/pkg/mod` |
| Kapan perilaku berubah | `<produk> changelog <versi>` · `<produk> migration guide v<N>` |
| Batas resmi | `<layanan> quotas limits` · `<layanan> pricing` |

### Pencarian pembantah (WAJIB minimal satu, ranah apa pun)

Query yang dirancang untuk menemukan bukti bahwa arah favorit itu keliru:

```
Umum:
  "<ide/strategi> gagal" · "<ide> tidak berhasil kenapa"
  "why <strategi> doesn't work"
  "<program/produk> keluhan pengguna" · "<perusahaan> gugatan | sanksi"
  "kritik terhadap <klaim populer>" · "<klaim> debunked"
  "<jalur karir> penyesalan" · "regret <keputusan>"

Teknis:
  "<teknologi> postmortem" · "why we moved off <teknologi>"
  "<teknologi> production issues at scale"
  site:github.com <repo> is:issue <fitur> broken
```

Aturan: **arah yang paling Anda sukai WAJIB paling keras dicari cacatnya.** Kalau pencarian pembantah tidak menemukan apa pun, itu sendiri temuan yang layak dilaporkan — tapi hanya sah kalau querynya benar-benar dijalankan.

### Menemukan konteks yang membuat angka bermakna

Hampir semua klaim bergantung konteks yang sering hilang saat dikutip ulang. Kejar kata kunci pembawa konteks: tahun, wilayah/negara, ukuran organisasi, segmen pasar, ukuran sampel — dan di ranah teknis: skala beban (`at 10k rps`, `p99`, `under sustained load`).

Angka yang benar di Amerika Serikat tahun 2021 bisa sepenuhnya menyesatkan untuk Indonesia tahun ini. **Wilayah dan tahun WAJIB ikut dikutip**, bukan dianggap detail.

---

## 3. Aturan Mengutip

1. **Verbatim, ≤25 kata, di dalam tanda kutip.** Parafrase menghilangkan syarat yang justru menentukan.
2. **DILARANG menguatkan hedge.** Sumber menulis "dapat mencapai hingga 50k rps pada beban ideal" → DILARANG jadi "mencapai 50k rps". Kata "dapat", "hingga", "pada beban ideal" adalah isi klaimnya, bukan hiasan.
3. **Bawa serta syaratnya.** Kalau kutipan bergantung pada versi, hardware, atau konfigurasi, syarat itu masuk ke kolom Klaim di Ledger.
4. **Sumber lokal dikutip dengan lokasi persisnya.** Dokumen milik user: `laporan-q2.xlsx, sheet "Penjualan", baris 12`. Berkas kode: `vendor/dompdf/dompdf/src/FrameReflower/Page.php:88`. Lebih kuat daripada URL mana pun karena bisa diperiksa ulang kapan saja.
4b. **Peraturan dikutip dengan pasal & ayat**, bukan ringkasan. "Sekitar begitu bunyinya" DILARANG — di ranah hukum dan pajak, selisih satu kata mengubah kewajiban.
5. **Bantahan dicatat sama rajinnya dengan konfirmasi.** Ledger yang isinya 100% `TERVERIFIKASI` mencurigakan — itu ciri riset yang hanya mencari pembenaran.

---

## 4. Protokol Angka

Sebuah angka baru bermakna kalau membawa lima hal ini. Kurang satu → tulis kualitatif.

| Wajib menyertai | Contoh buruk | Contoh sah (umum) | Contoh sah (teknis) |
| :--- | :--- | :--- | :--- |
| Satuan & metrik yang jelas | "3x lebih baik" | "biaya akuisisi pelanggan Rp180 ribu, dari Rp540 ribu" | "p99 turun dari 180 ms ke 60 ms" |
| Populasi & wilayah | "rata-rata gajinya sekian" | "median gaji, Jakarta, jenjang 3–5 tahun" | "beban baca 80/20 pada 8 vCPU" |
| Tahun / versi | "pajaknya 11%" | "tarif per <tahun>, sebelum perubahan aturan terbaru" | "Postgres 16.2 dibanding MySQL 8.0.36" |
| Siapa yang mengukur & ukuran sampel | "survei menunjukkan" | "survei <lembaga>, n=412 responden, metode daring (bias seleksi)" | "diukur vendor atas produknya sendiri (konflik kepentingan)" |
| Tanggal terbit | — | "data 2022; kondisi pasar sudah berubah sejak itu → `[BASI]`" | "versi mayor sudah berganti sejak terbit → `[BASI]`" |

**Angka yang paling sering difabrikasi (ranah umum):** "90% startup gagal dalam N tahun", ukuran pasar dalam miliar, persentase kenaikan produktivitas, "N% perekrut hanya melihat CV 6 detik", tingkat konversi rata-rata industri, rentang gaji, biaya hidup kota, imbal hasil investasi historis.

**Ranah teknis:** pangsa pasar tool, cold-start milidetik, biaya cloud per bulan, ambang "sampai N pengguna monolit masih cukup".

Semua kelas ini WAJIB ber-Ledger atau dihapus. Kalau arah klaimnya yakin tapi besarannya tidak, tulis arahnya saja: "mayoritas usaha baru tutup dalam beberapa tahun pertama `[memori-model]`, angka pastinya belum saya verifikasi".

---

## 5. Menangani Kegagalan Pengambilan

| Kegagalan | Yang WAJIB ditulis di Ledger | Yang DILARANG |
| :--- | :--- | :--- |
| Paywall / login wall | `GAGAL (paywall)` + apa yang terbaca dari judul & abstrak saja | Merangkum isinya dari ingatan |
| 404 / URL tidak ada | `GAGAL (404)` — dan curigai URL-nya memang halusinasi | Mengganti dengan URL "yang mirip" |
| Halaman JS-only / kosong | `GAGAL (render)` + cari mirror, dokumen PDF, atau repo sumbernya | Mengarang isi dari nama halaman |
| Rate limit / timeout | `GAGAL (timeout)` + tandai sebagai utang bukti | Menganggapnya terverifikasi |
| Hasil pencarian nihil | `TIDAK DITEMUKAN` — ini temuan yang sah dan sering penting | Menyimpulkan klaimnya benar karena "tidak ada yang membantah" |

**URL yang 404 adalah alarm.** Kalau sebuah URL muncul dari ingatan lalu ternyata tidak ada, kemungkinan besar seluruh klaim yang menempel padanya juga hasil rekonstruksi. Turunkan klaim itu ke `[memori-model]` dan cari ulang dari awal.

---

## 6. Contoh Sebelum / Sesudah

### 6A. Ranah umum — user menimbang berhenti kerja untuk buka usaha

#### ❌ Sebelum — terdengar berwibawa, sebenarnya karangan

> Menurut riset, 90% startup gagal dalam 5 tahun pertama, dan penyebab utamanya adalah kehabisan modal. Para ahli menyarankan menyiapkan dana darurat 6 bulan. Seperti kata Peter Drucker, "culture eats strategy for breakfast" — jadi fokuslah membangun tim dulu. Pasar F&B Indonesia tumbuh 12% per tahun, jadi peluangnya besar.

Yang salah: "menurut riset" tanpa riset · "90%" angka yang beredar luas tapi tak pernah ditelusuri primernya · "para ahli menyarankan" otoritas pinjaman · kutipan Drucker yang atribusinya diperdebatkan · "12% per tahun" tanpa sumber, tahun, maupun segmen · seluruhnya nol label, nol ketidakpastian, dan tak satu pun menyentuh angka **milik user sendiri**.

#### ✅ Sesudah — kadar pengetahuannya jujur

> **Sebelum saya cari data pasar, ada tiga angka milik Anda yang lebih menentukan daripada statistik industri mana pun:** pengeluaran rutin bulanan rumah tangga, sisa tabungan likuid, dan berapa bulan Anda sanggup nol pemasukan. Saya belum punya ketiganya — tanpa itu, opsi apa pun yang saya susun berdiri di atas tebakan.
>
> **Evidence Ledger**
>
> | ID | Klaim | Tier | Sumber | Kutipan | Diakses | Status |
> | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
> | E1 | Tingkat kegagalan usaha baru | — | — | — | 2026-08-10 | TIDAK DITEMUKAN dalam bentuk primer untuk Indonesia |
> | E2 | Kutipan "culture eats strategy" ke Drucker | 3 | <sumber pemeriksa kutipan> | "…" | 2026-08-10 | BANTAHAN — atribusi diperdebatkan |
>
> `[E1]` Angka "90% gagal" sering diulang tapi tidak saya temukan sumber primernya untuk konteks Indonesia — jadi DILARANG jadi dasar keputusan Anda; yang bisa saya katakan hanya bahwa risikonya nyata, bukan besarannya. `[E2]` Kutipan Drucker itu atribusinya tidak solid, jadi saya cabut dari argumen. `[inferensi]` Pertanyaan yang benar-benar menentukan bukan "seberapa besar pasarnya", melainkan "berapa bulan Anda bisa bertahan tanpa pemasukan" — itu bisa Anda hitung sendiri malam ini dan hasilnya lebih akurat daripada laporan pasar mana pun.
>
> **Utang bukti:** ukuran pasar segmen spesifik Anda. Cara termurah menutupnya: hitung langsung dari 20 pesaing terdekat di radius Anda, bukan dari angka nasional.

### 6B. Ranah teknis

#### ❌ Sebelum — terdengar seperti riset, sebenarnya bukan

> Untuk beban seperti ini, sebagian besar tim engineering beralih ke event-driven. Studi menunjukkan arsitektur event-driven meningkatkan throughput hingga 300% dan sudah menjadi standar industri sejak 2023. Netflix dan Uber sudah lama membuktikannya.

Yang salah: "studi menunjukkan" tanpa studi · "300%" fabrikasi presisi · "standar industri" meminjam otoritas · nama perusahaan dipakai sebagai bukti tanpa dokumen · nol tanda ketidakpastian · nol versi, nol skala, nol kondisi.

#### ✅ Sesudah — kadar pengetahuannya jujur

> **Evidence Ledger**
>
> | ID | Klaim | Tier | Sumber | Kutipan | Diakses | Status |
> | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
> | E1 | Outbox mencegah kehilangan event saat commit DB sukses tapi publish gagal | 1 | https://microservices.io/patterns/data/transactional-outbox.html | "…" | 2026-08-10 | TERVERIFIKASI |
> | E2 | Migrasi ke event-driven menambah beban operasional nyata | 2 | GitHub issue <repo>#1423 | "…" | 2026-08-10 | TERVERIFIKASI |
> | E3 | Angka peningkatan throughput lintas-industri | — | — | — | — | TIDAK DITEMUKAN |
>
> Event-driven dengan Transactional Outbox menutup kelas kegagalan dual-write `[fakta:E1]`, dengan ongkos satu komponen operasional tambahan yang harus dipantau `[fakta:E2]`. **Angka peningkatan throughput tidak saya temukan dalam bentuk yang bisa dikutip `[E3]`** — besarannya bergantung pola beban Anda, jadi saya tidak bisa menjanjikan angka. `[inferensi]` Pada volume tulis Anda saat ini, hambatannya kemungkinan besar bukan model messaging-nya, melainkan indeks tabel order — ini bisa diuji dalam satu jam dengan `EXPLAIN ANALYZE` sebelum arsitekturnya diubah sama sekali.
>
> **Utang bukti:** batas throughput nyata pada beban Anda — cara termurah menutupnya: satu load test dengan payload produksi.

Perbedaannya bukan panjang, melainkan **kadar pengetahuan yang diakui**. Versi kedua lebih pendek klaimnya tapi jauh lebih berguna untuk mengambil keputusan.

---

## 7. Checklist Deteksi Halusinasi Diri

Jalankan pada teks draf, kalimat per kalimat. Setiap "ya" WAJIB ditindak sebelum kirim.

```
[ ] Ada nama paper, buku, laporan, aturan, atau standar yang tidak saya buka di sesi ini?
[ ] Ada URL yang saya susun dari pola alamat, bukan dari hasil pencarian nyata?
[ ] Ada angka yang tidak bisa saya tunjuk asalnya di Ledger?
[ ] Ada kutipan tokoh yang belum saya telusuri sumber aslinya?
[ ] Ada isi pasal, syarat program, harga, atau tenggat yang saya tulis dari ingatan?
[ ] Ada nama perusahaan/lembaga dipakai sebagai bukti tanpa dokumen yang benar-benar dibaca?
[ ] Ada frasa "studi/riset/data/para ahli/umumnya/standar industri" tanpa nomor Ledger?
[ ] Ada angka yang saya pakai lintas-wilayah atau lintas-tahun tanpa menyebut asal konteksnya?
[ ] Ada nama API, flag CLI, opsi config, atau nama program yang belum saya konfirmasi masih berlaku?
[ ] Ada klaim yang saya percaya semata karena sering saya lihat, bukan karena saya periksa?
[ ] Ada satu kisah sukses yang saya perlakukan sebagai pola umum?
[ ] Ledger saya 100% konfirmasi tanpa satu pun bantahan?
[ ] Ada parafrase yang membuang kata "dapat", "hingga", "dalam kondisi tertentu"?
[ ] Ada data milik user yang seharusnya saya minta, tapi saya lewati dan ganti dengan statistik umum?
[ ] Ada ketidakpastian yang saya haluskan jadi kalimat yakin supaya jawabannya enak dibaca?
```

Butir terakhir adalah yang paling sering terjadi dan paling sulit ditangkap: dorongan menghasilkan jawaban yang terdengar kompeten mengubah "saya tidak yakin" menjadi "umumnya disepakati bahwa…". Kalimat yang enak dibaca DILARANG dibeli dengan kepastian palsu.

---

## 8. Kalimat Baku

Pakai bentuk-bentuk ini alih-alih mengarang otoritas:

| Alih-alih | Tulis |
| :--- | :--- |
| "Studi menunjukkan X" | "Saya tidak menemukan studi yang bisa dikutip untuk X `[E3: TIDAK DITEMUKAN]`" |
| "Umumnya disepakati bahwa X" | "X sering dinyatakan di komunitas, tapi saya belum menemukan sumber primernya `[memori-model]`" |
| "X sekitar 40% lebih cepat" | "X terukur lebih cepat pada kasus <kondisi> `[fakta:E2]`; besarannya di beban Anda belum diketahui" |
| "Dokumentasi resmi menyebut X" | "Dokumentasi <produk> v<N> menulis: '<verbatim>' `[fakta:E1]`" |
| "Netflix melakukan X" | "Tulisan engineering <perusahaan> tanggal <tgl> menjelaskan X pada konteks <skala> `[fakta:E4]`" |
| "Aturannya kurang lebih begini" | "Saya belum membuka teks aturannya. Sebelum Anda pakai ini untuk keputusan, pasal aslinya wajib dicek `[E5: GAGAL]`" |
| "Kata <tokoh>, '…'" | "Kutipan ini beredar luas atas nama <tokoh>, tapi atribusinya tidak saya temukan di sumber asli — saya cabut dari argumen `[E2: BANTAHAN]`" |
| "Harganya sekitar Rp…" | "Harga pada halaman resmi per <tanggal akses>: … `[fakta:E6]`. Kelas data ini cepat basi, cek ulang sebelum memutuskan" |
| "Rata-rata orang di posisi ini dapat X" | "Saya belum menemukan survei gaji yang menyebut sampel & tahun untuk pasar Anda `[E7: TIDAK DITEMUKAN]`" |
| Langsung menyodorkan statistik industri | "Sebelum ke angka industri: berapa angka Anda sendiri untuk ini? Data Anda mengalahkan rata-rata siapa pun" |
| Diam soal yang tidak diketahui | "Ini yang tidak saya ketahui, dan begini cara termurah mengetahuinya: …" |
