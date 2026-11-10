# Lensa 1 — Manager / Product (setara senior PM atau engineering lead)

Pendamping `SKILL.md` skill `meta-panel`. Dibuka saat request berupa fitur baru, perubahan alur, request tanpa masalah yang jelas, atau memuat kata seperti "sekalian", "otomatis", "samakan", "semua".

Lensa ini menjawab: **apakah kita memecahkan masalah yang benar, sekecil mungkin, dan tahu apa yang sengaja tidak dikerjakan.** Kode yang rapi untuk masalah yang salah tetap kerja yang terbuang, dan itu jenis kerugian yang tidak ditangkap test mana pun.

---

## 1. Cara Berpikirnya

| Pertanyaan pemula | Pertanyaan senior |
| :--- | :--- |
| "Fiturnya apa?" | "Apa yang rusak atau lambat hari ini, bagi siapa, dan seberapa sering?" |
| "Bagaimana membuatnya?" | "Apa cara termurah untuk tahu apakah ini memang dibutuhkan?" |
| "Apa saja yang dikerjakan?" | "Apa yang sengaja tidak dikerjakan, dan siapa yang akan kecewa?" |
| "Kapan selesai?" | "Bagian mana yang bisa dirilis sendiri lebih dulu?" |
| "User minta X." | "User minta X untuk mencapai apa? Adakah yang sudah ada dan menjawab itu?" |

```text
Request
   |
   +-- masalah      siapa, kapan, seberapa sering, buktinya apa
   +-- cakupan      yang diminta | yang tersirat | yang TIDAK diminta
   +-- pilihan      sudah ada? | ubah yang ada | bangun baru | tidak dikerjakan
   +-- ukuran       cara tahu ini berhasil
   +-- urutan       bagian terkecil yang sudah berguna
```

---

## 2. Katalog Kasus Tepi

### 2.1 Masalah yang belum jelas

| Tanda | Yang dilakukan |
| :--- | :--- |
| Request berbentuk solusi ("bikin fitur X", "pakai Redis") | Tanya masalahnya. Panel butuh masalah, bukan solusi titipan. |
| Tidak ada contoh kejadian | Minta satu contoh nyata: siapa, melakukan apa, hasilnya apa, harusnya apa. |
| Premis "cuma terjadi di X" | Verifikasi premisnya dulu sebelum menjelaskan kenapa. |
| "Tadi jalan" atau "ada yang rusak" tanpa sebab | Bukan panel. Pindah ke `meta-debug`. |
| User hanya meneruskan keluhan orang lain | Ia mungkin tidak bisa mengambil data tambahan. Cari bukti yang bisa dibuat sendiri. |

### 2.2 Cakupan yang ambigu

Kata yang hampir selalu punya dua tafsir. **Tanya balik dengan dua contoh konkret**, jangan ditafsirkan.

| Kata | Dua tafsir yang sering tertukar |
| :--- | :--- |
| "semua" / "per user" | Global untuk semua orang, atau terpisah tiap user |
| "otomatis terisi" | Prefill di form (hanya tampilan), atau disimpan di server (mengubah data) |
| "samakan dengan Y" | Gaya, perilaku, lebar, urutan, atau aturannya |
| "maksimal vX" | Batas atas, bukan larangan versi di bawahnya |
| "hapus" | Hilang dari layar, atau hilang dari database |
| "buka untuk Z" | Hanya jalur Z, atau semua jalur yang memakai penjaga yang sama |
| "akun lokal urusan lokal" | Berlaku untuk aplikasi mana; sumber akunnya termasuk atau tidak |
| "nanti" / "inginnya" | Arah jangka panjang, bukan syarat langkah sekarang |

Aturan yang sudah dinyatakan user tidak ditimpa rekomendasi sendiri. Sebelum memutuskan, baca ulang pernyataan terakhirnya tentang pilihan itu.

### 2.3 Cakupan yang melebar

| Cek | Skenario yang dicari |
| :--- | :--- |
| "Sekalian" | Perubahan tambahan yang tidak diminta, diselipkan demi konsistensi atau kerapian. Sajikan sebagai opsi terpisah dengan dampaknya. |
| Menyentuh uang, pajak, izin | Perubahan perilaku di area ini selalu jadi butir "perlu keputusanmu", sekecil apa pun. |
| Abstraksi baru | Helper, kelas, atau lapisan baru untuk hal yang di repo ini biasa ditulis langsung. Cek pola yang sudah ada dulu. |
| Utang yang ditemukan di jalan | Bug atau kekacauan di luar cakupan dicatat sebagai catatan samping, tidak diperbaiki diam-diam. |
| Tahap penyangga | Keputusan yang sudah ada di spesifikasi tidak diparkir ke tahap "penyempurnaan". |

### 2.4 Jalan yang lebih murah

Urutan yang ditimbang sebelum membangun:

1. **Sudah ada.** Fitur, laporan, atau pengaturan yang sudah menjawabnya. Modul kembaran sering sudah punya.
2. **Ubah yang ada.** Menambah satu kolom, satu filter, satu izin.
3. **Proses, bukan kode.** Sebagian masalah selesai dengan mengubah cara kerja.
4. **Pakai yang jadi.** Library atau layanan yang sudah matang. Untuk dipakai sendiri, banyaknya pilihan di luar itu kabar baik.
5. **Bangun.** Baru setelah empat di atas ditimbang.
6. **Tidak dikerjakan.** Selalu opsi yang sah bila nilainya tidak sepadan.

Untuk usulan pendekatan atau arsitektur: minimal tiga opsi, tiap opsi tiga kelebihan dan tiga kekurangan, dan apa yang membatalkannya (`AGENTS.md` §4).

### 2.5 Siapa yang terdampak

| Cek | Skenario yang dicari |
| :--- | :--- |
| Tiap peran | Perubahan untuk HRD yang ikut mengubah layar karyawan atau atasan. |
| Pemakai lama | Alur yang sudah dihafal berubah; data lama tampil berbeda. |
| Pihak di luar aplikasi | Bagian keuangan yang membaca laporan, aplikasi HP, sistem lain. |
| Orang berikutnya di repo | Lapisan baru yang harus dipahami sebelum mengubah apa pun. |
| Operasional | Siapa yang menangani bila fitur ini bermasalah di luar jam kerja. |

### 2.6 Ukuran berhasil dan urutan

| Cek | Skenario yang dicari |
| :--- | :--- |
| Cara tahu berhasil | Apa yang bisa dilihat atau dihitung setelah rilis. Tanpa itu, "selesai" hanya berarti kodenya ada. |
| Bagian terkecil | Potongan pertama yang sudah berguna dan bisa dirilis sendiri. |
| Tenggat nyata | Ada acara atau tenggat luar? Itu menentukan apa yang masuk sekarang dan apa yang sesudahnya. |
| Tanda harus berhenti | Kondisi yang membuat arah ini ditinggalkan. |

---

## 3. Pertanyaan ke User

Panel yang baik sedikit bertanya. Sebelum menulis pertanyaan:

1. **Bisakah diputuskan dari request dan kode?** Kalau ya, putuskan, nyatakan, jangan tanya.
2. **Apakah jawabannya mengubah yang dikerjakan?** Kalau tidak, jangan tanya.
3. **Apakah tafsirnya benar-benar bercabang dan salah pilih mahal?** Baru itu pertanyaan.

Bentuknya: pertanyaan satu kalimat, dua contoh konkret, dan bawaan yang akan dipakai bila user tidak menjawab. Untuk pertanyaan ya atau tidak dari user: jawab dulu ya atau tidak, satu kalimat caranya, akibat utamanya, baru satu pertanyaan konfirmasi.

---

## 4. Contoh Temuan

**Ditolak:**
> Manager: perlu dipastikan fitur ini sesuai kebutuhan bisnis dan tidak scope creep.

**Layak dikirim (perlu keputusanmu):**
> "Isi otomatis bank default saat clone" bisa berarti dua hal. (a) Form clone terbuka dengan bank default sudah terpilih, dan baru tersimpan kalau kamu menekan simpan. (b) Server langsung mengisi bank default ke data hasil clone. Yang kedua mengubah alur data: pesanan hasil clone akan lolos pengecekan "bank wajib diisi" tanpa pernah dilihat orang. Bawaan saya (a), karena hanya mengubah tampilan dan mudah dibalik.

**Layak dikirim (catatan cakupan):**
> Saat membaca `ReimburseService`, perhitungan PPN-nya mengambil tarif dari config, bukan dari bank. Itu di luar yang kamu minta dan tidak saya ubah. Kalau mau disamakan dengan modul pesanan, itu perubahan terpisah yang mengubah angka pajak.

**Ditolak (menaikkan arah jangka panjang jadi syarat):**
> Opsi ini kurang cocok karena kamu ingin nantinya pindah ke microservices.

Tujuan akhir user bukan kriteria langkah pertama, kecuali ia sendiri mengatakannya.

---

## 5. Anti-Pattern

**Anti-Pattern 1: langsung menilai solusi.** Menghabiskan panel untuk membandingkan cara membangun sesuatu yang masalahnya belum disepakati.

**Anti-Pattern 2: lima pertanyaan untuk satu request.** Empat di antaranya biasanya sudah terjawab oleh kalimat user atau label di form.

**Anti-Pattern 3: opsi sebagai tabel berkolom banyak.** Di percakapan, dua sampai tiga opsi ditulis sebagai paragraf, masing-masing dengan satu skenario nyata tentang apa yang hilang.

**Anti-Pattern 4: kalimat trade-off yang menggantung.** "Yang hilang A dan B; kalau penting tambah C saja." Tulis satu skenario per hal yang hilang (jam berapa, user melihat apa), baru pilihannya.

**Anti-Pattern 5: memakai satu kriteria untuk dua jenis keputusan.** "Sudah banyak di luar" membunuh ide untuk dijual, bukan ide untuk dipakai sendiri. Tanya dulu: ini untuk dibagikan atau dipakai?

---

## 6. Edge Case

**Edge Case 1: user tampak buru-buru.** Panel tetap jalan, lebih pendek. Yang dipangkas penjelasannya, bukan peta keterkaitannya.

**Edge Case 2: user memberi wewenang penuh.** Wewenang penuh bukan izin melonggarkan pemeriksaan atau memperluas cakupan. Justru di sini kecenderungan mengakali paling perlu dijaga.

**Edge Case 3: request bertentangan dengan keputusan lama.** Sebut keputusan lamanya dan tanyakan apakah memang dibatalkan. Jangan memilih diam-diam.

**Edge Case 4: user bertanya "ada yang aneh?".** Cari cakupan yang tidak masuk akal di rancangan, bukan konsekuensi aturan yang ia buat sendiri. Kalau tidak ada, jawab tidak ada.

**Edge Case 5: request berupa pertanyaan kelayakan.** "Bisa nggak X?" adalah sondir: jawabannya penyelidikan, bukan fitur. Kode sondir dibuang.

**Edge Case 6: keputusan perlu dibaca orang lain.** Panel tetap di percakapan; dokumennya (PRD, RFC, ADR) lewat `meta-prd` setelah user setuju dokumen itu perlu.

---

## 7. Sumber

- `AGENTS.md` §4 Challenger Procedure: tiga opsi, tiga kelebihan dan kekurangan, pembatal.
- Template PRD Atlassian dan template RFC Rust, dibuka 2026-11-10: sasaran dengan ukuran berhasil, hal di luar cakupan, "Why should we not do this?".
- Dropbox Engineering Career Framework IC4, dibuka 2026-11-10: "I get work to a simple place by focusing on the heart of the problem and prioritizing the right things" dan "I avoid re-inventing the wheel".
- Kejadian di proyek user dari `shared/LEARNED.md`: "pakai cache saja nggak per user" (global vs per user), "isi otomatis" dan PPN clone (transaction-record-system), "maksimal v1.0.0" (pentahoot), helper yang ditolak (manunggal-purchasing 2026-09-10), lima pertanyaan klarifikasi (trs-vivace 2026-10-28), tahap penyempurnaan (pentahoot), "tujuan akhir bukan kriteria langkah pertama" (2026-09-11).
