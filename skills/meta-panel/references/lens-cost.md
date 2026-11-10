# Lensa 2 — Cost / FinOps (setara engineering manager yang memegang anggaran)

Pendamping `SKILL.md` skill `meta-panel`. Dibuka saat request membawa dependency baru, layanan berbayar, job terjadwal, penyimpanan berkas, data yang tumbuh, atau pekerjaan yang lebih dari beberapa hari.

Lensa ini menjawab: **berapa ongkos membangun, menjalankan, dan merawat ini, dan apakah nilainya sepadan.** Ongkos terbesar sebuah fitur hampir tidak pernah ada di minggu ia ditulis; ia ada di tiap bulan sesudahnya, saat seseorang harus memahaminya lagi, memperbaruinya, dan membayar tagihannya.

**Aturan angka:** lensa ini paling mudah tergelincir ke angka karangan. Harga, kuota, dan ukuran DILARANG ditulis dari ingatan (`AGENTS.md` §3). Yang tidak punya sumber terbuka hari ini ditulis kualitatif ("naik seiring jumlah user") dengan cara mendapatkan angkanya.

---

## 1. Cara Berpikirnya

| Pertanyaan pemula | Pertanyaan senior |
| :--- | :--- |
| "Berapa lama membuatnya?" | "Berapa lama orang berikutnya butuh untuk mengubahnya dengan aman?" |
| "Library ini gratis?" | "Siapa yang merawatnya, kapan terakhir dirilis, dan apa yang terjadi saat ia berhenti dirawat?" |
| "Muat di server sekarang?" | "Apa yang tumbuh tiap hari, dan kapan ia menyentuh batas?" |
| "Fiturnya berguna?" | "Berguna bagi berapa orang, seberapa sering, dan apa yang tidak dikerjakan karena ini dikerjakan?" |
| "Bisa pakai layanan X?" | "Tagihannya mengikuti apa: jumlah user, jumlah permintaan, atau ukuran data? Siapa yang melihat tagihan itu?" |

```text
Empat kantong ongkos
  membangun    waktu menulis, menguji, meninjau, merilis
  menjalankan  server, penyimpanan, layanan berbayar, kuota
  merawat      memahami ulang, memperbarui, menjawab keluhan, on-call
  kesempatan   apa yang tertunda karena ini didahulukan
```

Kantong ketiga adalah yang paling sering tidak dihitung, dan yang paling besar untuk tim kecil.

---

## 2. Katalog Kasus Tepi

### 2.1 Ongkos membangun

| Cek | Skenario yang dicari |
| :--- | :--- |
| Ukuran sebenarnya | Diukur, bukan ditaksir. "Sekitar 30 berkas" yang ternyata 198 mengubah seluruh rencana. Satu perintah hitung di awal. |
| Bagian tersembunyi | Migrasi data lama, test, dokumentasi, perubahan di klien lain, langkah deploy manual. |
| Belajar hal baru | Teknologi yang belum pernah dijalankan tim menambah waktu yang tidak terlihat di rencana. |
| Bisa dipotong | Bagian terkecil yang sudah berguna vs versi lengkap. |
| Menunggu orang lain | Akses, keputusan, atau kredensial yang harus diminta. |

### 2.2 Dependency baru

| Cek | Skenario yang dicari |
| :--- | :--- |
| Perlu atau tidak | Yang dibutuhkan satu fungsi; yang dipasang satu kerangka. Stdlib atau yang sudah terpasang cukup? |
| Kesehatan | Rilis terakhir, isu terbuka, jumlah perawat. Diperiksa hari ini di sumbernya, bukan diingat. |
| Syarat ikutan | Butuh ekstensi, cgo, versi bahasa tertentu, atau layanan lain. Pecah di image minimal atau di versi bahasa server? |
| Lisensi | Boleh dipakai untuk produk ini? Baca berkas lisensinya. |
| Jalan keluar | Seberapa sulit melepasnya nanti. Dependency yang menyebar ke seluruh kode mahal dicabut. |
| Bawaan yang mengejutkan | Perilaku bawaan yang longgar atau diam-diam mengabaikan opsi. Baca source yang terpasang untuk perilaku yang diandalkan. |
| Preset alat | Aturan alat yang bentrok dengan konvensi framework. Jangan ditambal dengan pengecualian per berkas. |

### 2.3 Ongkos menjalankan

| Cek | Skenario yang dicari |
| :--- | :--- |
| Yang tumbuh | Baris tabel, berkas upload, log, antrian, cache. Laju per hari dan batasnya. |
| Yang ditagih per pemakaian | Pesan, email, panggilan API, penyimpanan, token. Apa yang membuatnya melonjak (retry, loop, impor massal)? |
| Kuota bersama | Kuota akun atau layanan yang dipakai bersama. Pekerjaan paralel menghabiskannya lebih cepat. |
| Pekerjaan terjadwal | Job tiap menit yang sebenarnya cukup tiap jam; laporan yang dihitung ulang tiap dibuka. |
| Mesin pengembang | Suite atau container berat yang menghabiskan memori mesin user dan mengganggu kerja lain. |
| Ruang disk | Image, cache build, dan berkas sementara yang menumpuk. |

### 2.4 Ongkos merawat

| Cek | Skenario yang dicari |
| :--- | :--- |
| Lapisan baru | Helper, service, atau abstraksi untuk kondisi satu baris yang sudah ditulis langsung di sepuluh tempat lain. Konsistensi dengan repo mengalahkan kerapian di tingkat ini. |
| Dua cara untuk hal yang sama | Modul baru memakai pola berbeda dari modul sejenis. Tiap perbaikan nanti dikerjakan dua kali. |
| Salinan | Logika atau gaya yang disalin ke beberapa tempat dan pelan-pelan berbeda. Satu sumber, sisanya merujuk. |
| Pengetahuan satu orang | Hanya penulisnya yang paham. Cukupkah README dan test-nya untuk orang berikutnya? |
| Volume bukan nilai | Menambah berkas acuan, opsi, atau konfigurasi tanpa cara menemukannya membuat semuanya lebih sulit dipakai. |
| Pemeriksaan otomatis | Gerbang yang memblokir utang lama di berkas yang tidak disentuh membuat repo mustahil dikerjakan. Yang diblokir hanya pelanggaran di baris baru. |
| Test yang rapuh | Test yang gagal acak memakan waktu tiap kali, lebih mahal daripada tidak ada. |

### 2.5 Nilai dan kesempatan

| Cek | Skenario yang dicari |
| :--- | :--- |
| Seberapa sering dipakai | Fitur untuk kejadian setahun sekali vs tiap hari. |
| Berapa orang | Satu admin atau semua karyawan. |
| Alternatif manual | Berapa lama dikerjakan tangan sekarang. Otomasi untuk pekerjaan lima menit sebulan jarang sepadan. |
| Yang tertunda | Apa yang tidak dikerjakan selama ini dikerjakan. |
| Bisa dibatalkan | Kalau ternyata tidak dipakai, seberapa mahal mencabutnya. |

---

## 3. Enam Prinsip FinOps sebagai Periksa Silang

Untuk request yang menyentuh layanan berbayar atau infrastruktur, sisir enam prinsip FinOps Foundation:

1. Teams need to collaborate
2. Business value drives technology decisions
3. Everyone takes ownership for their technology usage
4. FinOps data should be accessible, timely, and accurate
5. FinOps should be enabled centrally
6. Take advantage of the variable cost model of the cloud

Untuk tim kecil, yang paling berguna nomor 2 dan 3: keputusan teknis ditimbang dari nilainya, dan yang membangun ikut bertanggung jawab atas ongkos jalannya. Pertanyaan praktisnya: **siapa yang melihat tagihannya, dan apakah ia tahu fitur ini menambahnya.**

---

## 4. Cara Mengecek

1. **Hitung, jangan taksir.** Jumlah berkas yang kena, jumlah baris tabel, ukuran direktori upload: satu perintah masing-masing.
2. **Buka halaman harga dan batas resminya hari ini** bila ada layanan berbayar. Harga adalah data yang paling cepat basi; catat tanggal aksesnya.
3. **Periksa dependency di sumbernya**: tag rilis terakhir, berkas lisensi, syarat versi.
4. **Cari pola yang sudah ada** sebelum mengusulkan lapisan baru: cari ekspresi atau fungsi serupa di repo dan hitung kemunculannya.
5. **Tanyakan riwayat pemakaian** fitur sejenis bila ada datanya: berapa kali dipakai, oleh berapa orang.

---

## 5. Contoh Temuan

**Ditolak:**
> Cost: perlu dipertimbangkan biaya maintenance dan infrastruktur jangka panjang.

**Layak dikirim:**
> Untuk membatasi edit lead time ke departemen PCH, saya sempat mau membuat helper `can_edit_lead_time()`. Repo ini sudah menulis pengecekan departemen langsung di lebih dari sepuluh tempat (hasil pencarian `department_code`), jadi helper baru justru jadi satu-satunya pengecualian yang harus dipelajari orang berikutnya. Usul: tulis langsung seperti yang lain. Helper baru layak kalau aturannya rumit atau diperkirakan sering berubah.

**Layak dikirim (ongkos jalan):**
> Tiap pengajuan mengirim satu pesan WhatsApp ke atasan lewat gateway berbayar. Saya belum membuka halaman harga gateway itu, jadi tidak menyebut angka; yang pasti tagihannya mengikuti jumlah pengajuan, dan impor massal 500 pengajuan akan mengirim 500 pesan sekaligus. Usul: impor massal tidak memicu notifikasi, atau digabung jadi satu pesan. Cara tahu angkanya: buka halaman harga gateway dan hitung pengajuan bulan lalu dari tabel.

**Ditolak (angka karangan):**
> Ini akan menghemat sekitar 80% waktu server.

Tanpa pengukuran, tulis arahnya saja.

---

## 6. Anti-Pattern

**Anti-Pattern 1: menghitung hanya ongkos menulis.** Rencana yang berhenti di "tiga hari kerja" tanpa menyebut apa yang ditambahkan ke beban rawat.

**Anti-Pattern 2: DRY di tempat yang salah.** Mengekstrak abstraksi untuk ekspresi sepele yang polanya sudah mapan di repo.

**Anti-Pattern 3: menyebut harga dari ingatan.** Lalu menempelkan tautan halaman harga yang tidak dibuka.

**Anti-Pattern 4: "gratis" karena open source.** Ongkosnya pindah ke merawat, memperbarui, dan menambal.

**Anti-Pattern 5: mengoptimalkan yang belum diukur.** Mengusulkan cache atau antrian untuk kelambatan yang belum dicari penyebabnya; sering kali penyebabnya satu index.

---

## 7. Edge Case

**Edge Case 1: tidak ada angka sama sekali.** Proyek tanpa pemantauan biaya atau pemakaian. Panel menyebut arah ongkosnya dan satu cara termurah mendapat angka pertama.

**Edge Case 2: kuota bersama akun.** Pekerjaan yang membakar kuota (riset besar, agen paralel, suite panjang) dilaporkan dulu, tidak dijalankan diam-diam.

**Edge Case 3: lingkungan pengembang yang sempit.** Memori dan disk mesin user terbatas. Pekerjaan berat dijalankan per batch kecil dan berhenti total setelah gangguan pertama.

**Edge Case 4: nilai yang tidak bisa diukur.** Kepatuhan, keamanan, kepercayaan user. Ditulis sebagai alasan kualitatif yang jujur, tidak dipaksa jadi angka.

**Edge Case 5: ongkos mencabut lebih besar dari ongkos menambah.** Skema, format berkas, dan API publik. Sekali dipakai pihak lain, mencabutnya mahal; itu menaikkan kelas panel.

**Edge Case 6: user sudah memutuskan memakai sesuatu.** Lensa ini tidak mengulang perdebatan. Ia hanya menyebut ongkos yang belum terlihat, sekali.

---

## 8. Sumber

- FinOps Foundation, FinOps Principles (finops.org/framework/principles), dibuka 2026-11-10. Nama prinsip dikutip apa adanya.
- Dropbox Engineering Career Framework IC4, dibuka 2026-11-10: "I look for ways to simplify code and infrastructure" dan "I actively seek out and eliminate sources of toil on the team".
- Google SRE Book bab 5, Eliminating Toil, dibuka 2026-11-10: definisi toil.
- Kejadian di proyek user dari `shared/LEARNED.md`: helper yang ditolak (2026-09-10), "retrofit 30 berkas" yang ternyata 198, volume acuan bukan nilai (2026-08-11), gerbang yang memblokir utang lama, `mattn/go-sqlite3` butuh cgo, preset Pest yang bentrok, kuota akun bersama, memori WSL, "angka tanpa sumber = karangan".
