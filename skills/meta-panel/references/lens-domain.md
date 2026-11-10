# Lensa 10 — Domain / Aturan Bisnis (setara analis bisnis senior yang paham bidangnya)

Pendamping `SKILL.md` skill `meta-panel`. Dibuka saat request menyentuh aturan bidang usahanya: cuti dan absensi, gaji dan potongan, pajak, pembelian dan persetujuan, stok, tarif, jatah, batas, periode, atau status dan alurnya.

Lensa ini menjawab: **aturan bisnis mana yang disentuh, dari mana aturan itu berasal, dan apakah perubahan ini masih sejalan dengan aturan lain yang sudah berjalan.**

**Hukum lensa ini:** agen bukan sumber aturan bisnis. Aturan datang dari user, dari dokumen perusahaan, atau dari kode yang sudah berjalan dan disepakati. Tugas lensa ini memastikan aturan itu **ditanyakan dan dicocokkan**, bukan ditebak. Tebakan yang masuk akal tentang "biasanya HRIS begini" adalah cara tercepat membuat aplikasi yang salah dengan rapi.

---

## 1. Cara Berpikirnya

| Pertanyaan pemula | Pertanyaan senior |
| :--- | :--- |
| "Aturannya apa?" | "Aturannya tertulis di mana, siapa pemiliknya, dan kapan terakhir berubah?" |
| "Maksimal 3, oke." | "Tiga apa, dihitung per apa, dalam periode menurut tanggal apa, dan status mana yang ikut dihitung?" |
| "Tambah aturan baru." | "Aturan mana yang sudah berjalan dan bertabrakan dengannya?" |
| "Berlaku untuk semua." | "Siapa pengecualiannya: peran tertentu, karyawan lama, kasus yang sudah berjalan?" |
| "Ubah rumusnya." | "Angka yang sudah terbit dengan rumus lama dibiarkan atau dihitung ulang, dan siapa yang membaca selisihnya?" |

```text
Satu aturan bisnis punya enam sisi
  satuan        apa yang dihitung (klaim, hari, perjalanan, orang)
  cakupan       untuk siapa (per orang, per divisi, per perusahaan)
  waktu         periode menurut tanggal apa; berlaku mulai kapan
  keadaan       status mana yang dihitung; apa yang terjadi saat berubah
  pengecualian  peran, jenis, atau kasus yang diperlakukan lain
  akibat        ditolak, diperingatkan, ditandai, atau dihitung sebagai lain
```

---

## 2. Katalog Kasus Tepi

### 2.1 Asal aturan

| Cek | Skenario yang dicari |
| :--- | :--- |
| Sumbernya | Ucapan user di percakapan, dokumen kebijakan, tiket bernomor, atau kebiasaan yang tertanam di kode. Sebut yang mana. |
| Aturan yang hanya ada di kode | Komentar, konstanta, atau test yang mengunci sebuah perilaku adalah catatan keputusan. Test yang sengaja menjaga sebuah perilaku berarti itu aturan, bukan kelalaian. |
| Aturan yang hanya ada di kepala | Tidak tertulis di mana pun. Tanyakan, lalu usulkan ditulis (komentar di kode, atau dokumen lewat `meta-prd`). |
| Pemilik aturan | User sendiri, HRD, keuangan, pimpinan. User yang hanya meneruskan permintaan mungkin perlu bertanya balik ke pemiliknya. |
| Tanggal keputusan | Aturan yang baru berubah minggu lalu lebih mungkin masih bergerak. |

### 2.2 Definisi yang tersembunyi di satu kalimat

Permintaan aturan hampir selalu lebih pendek daripada aturannya. Untuk tiap kata, cari tafsir kedua.

| Kata di permintaan | Yang perlu ditegaskan |
| :--- | :--- |
| "per bulan", "per tahun" | Menurut tanggal kejadian atau tanggal pengajuan? Bulan kalender atau periode gaji? Tahun kalender atau tahun kerja? |
| "maksimal N" | N apa (pengajuan, hari, rupiah)? Yang ditolak, dibatalkan, dan dihapus ikut dihitung? |
| "per karyawan" | Pemilik data atau yang mengajukan? Bagaimana bila diajukan atas nama orang lain? |
| "setelah disetujui" | Disetujui siapa, tingkat ke berapa? Bagaimana bila persetujuannya dibatalkan? |
| "hari kerja" | Sabtu, hari libur nasional, cuti bersama, dan jadwal sif ikut bagaimana? |
| "aktif" | Karyawan percobaan, kontrak habis, sedang cuti panjang, sudah mengundurkan diri tetapi masih dalam masa kerja. |
| "otomatis" | Dihitung saat itu juga, saat tutup periode, atau oleh job terjadwal? Bisa dikoreksi tangan? |

Tanya balik dengan **dua contoh konkret** dan bawaan yang akan dipakai, bukan dengan daftar definisi.

### 2.3 Tabrakan dengan aturan yang sudah ada

| Cek | Skenario yang dicari |
| :--- | :--- |
| Aturan sejenis di fitur yang sama | Batas baru bertabrakan dengan aturan yang mengizinkan hal itu berulang (satu klaim per hari perjalanan lawan tiga klaim per bulan). |
| Pola di modul kembaran | Modul sejenis memperlakukan "melewati batas" dengan cara lain: menandai, bukan menolak. Dua perlakuan untuk hal serupa membingungkan pengguna. |
| Laporan yang sudah mendefinisikannya | Laporan menghitung "per bulan" dengan satu definisi; aturan baru memakai definisi lain, sehingga dua angka tidak pernah cocok. |
| Urutan aturan | Aturan mana yang diperiksa dulu, dan pesan mana yang dilihat pengguna bila dua-duanya dilanggar. |
| Aturan turunan | Jatah, saldo, atau angka lain yang dihitung dari data yang aturannya berubah. |

### 2.4 Waktu berlakunya

| Cek | Skenario yang dicari |
| :--- | :--- |
| Data yang sudah ada | Orang yang hari ini sudah melewati batas baru: ditolak ke depan saja, atau data lamanya ikut ditindak? |
| Kasus yang sedang berjalan | Pengajuan yang masuk sebelum aturan berubah dan diputuskan sesudahnya. |
| Berlaku mundur | Tanggal mundur memungkinkan data baru masuk ke periode lama. Aturan baru berlaku untuk tanggal kejadiannya atau tanggal masuknya? |
| Periode yang sudah ditutup | Laporan atau gaji yang sudah terbit; perubahan sesudahnya mengubah angka yang sudah dipegang orang. |
| Aturan yang berubah lagi | Tarif atau batas yang berganti per tahun: disimpan dengan masa berlakunya, atau satu angka yang ditimpa? |

### 2.5 Pengecualian dan wewenang

| Cek | Skenario yang dicari |
| :--- | :--- |
| Peran yang boleh melewati | HRD, pimpinan, atau admin. Pengecualian lewat satu peran berarti aturan itu bisa dilewati; itu keputusan user. |
| Atas nama orang lain | Batas dihitung ke pemilik data, bukan ke yang mengetik. |
| Jenis yang dikecualikan | Satu jenis pengajuan tidak ikut dihitung (dinas lapangan lawan dinas biasa). |
| Kasus khusus yang sah | Kejadian yang jarang tetapi resmi: perjalanan panjang, cuti melahirkan, karyawan pindah divisi di tengah periode. |
| Koreksi | Cara membetulkan data yang salah tanpa melanggar aturan, dan siapa yang berwenang. |

### 2.6 Akibat saat aturan dilanggar

| Pilihan | Kapan cocok | Yang dikorbankan |
| :--- | :--- | :--- |
| Ditandai, diputuskan manusia | Kasus sah bisa melewati batas; keputusannya milik atasan | Beban pemutus bertambah |
| Diperingatkan, boleh lanjut | Pengguna perlu tahu, tetapi tidak dilarang | Bisa diabaikan |
| Ditolak | Aturan keras, atau akibatnya tidak bisa dibalik | Kasus sah yang tidak terpikirkan ikut tertolak |
| Dihitung sebagai jenis lain | Kelebihan tetap diterima dengan konsekuensi (tidak dibayar, memotong jatah lain) | Rumus dan laporan ikut berubah |

User proyek ini berkali-kali memilih yang paling mudah dibalik: peringatan dan konfirmasi sebelum blokir. Usulkan mulai dari sana, kecuali aturannya memang keras.

---

## 3. Cara Mengecek

1. **Cari aturan yang sudah ada di kode**: konstanta, komentar bertanda tiket atau tanggal, pesan penolakan, dan test yang namanya menyebut aturan.
2. **Baca modul kembaran** untuk melihat bagaimana hal serupa diperlakukan.
3. **Baca laporan dan rekap** yang menghitung hal yang sama; definisinya di sana adalah definisi yang sudah dilihat pengguna.
4. **Tanyakan riwayatnya**: berapa orang yang hari ini sudah melewati batas baru. Satu hitungan dari data lebih berharga daripada dugaan.
5. **Tulis aturannya kembali dalam satu kalimat lengkap** dengan enam sisinya, dan minta user membetulkan.

---

## 4. Contoh Temuan

**Ditolak:**
> Domain: pastikan aturan bisnis sudah sesuai kebijakan perusahaan.

**Ditolak (menebak aturan):**
> Sebaiknya klaim yang ditolak tidak dihitung, karena umumnya begitu di aplikasi HRIS.

"Umumnya" bukan sumber. Sajikan dua pilihannya dan tanyakan.

**Layak dikirim (menghalangi):**
> Batas tiga klaim per bulan bertabrakan dengan aturan klaim per hari Field Duty. Karyawan dengan Field Duty lima hari mengajukan hari pertama sampai ketiga, lalu ditolak di hari keempat dan kelima, padahal `ReimburseService::assertClaimableDuty` menulis "satu klaim per hari perjalanan boleh berkali-kali" dan `ReimburseDutyLinkTest` menguncinya. Sudah saya baca di dua berkas itu. Jalan lain, dari yang paling mudah dibalik: klaim keempat tetap masuk tetapi ditandai untuk pemutus (sama dengan cara jatah cuti diperlakukan sejak Oktober); atau batasnya dihitung per duty, bukan per klaim.

**Layak dikirim (perlu keputusanmu):**
> "Per bulan" itu bulan perjalanan atau bulan pengajuan? Contoh: perjalanan 30 November diajukan 2 Desember. Bawaan saya bulan perjalanan, karena laporan Reimbursement sudah menghitung per tanggal perjalanan dan form mengizinkan tanggal mundur.

---

## 5. Anti-Pattern

**Anti-Pattern 1: mengisi kekosongan dengan "biasanya".** Aturan bidang usaha berbeda per perusahaan. Yang tidak disebut user ditanyakan.

**Anti-Pattern 2: menerima kalimat pendek sebagai aturan lengkap.** "Maksimal tiga per bulan" punya minimal empat definisi yang belum disebut.

**Anti-Pattern 3: menimpa aturan lama tanpa menyebutnya.** Aturan baru yang membatalkan aturan lama disajikan sebagai pilihan: mana yang menang.

**Anti-Pattern 4: lima pertanyaan definisi sekaligus.** Putuskan bawaan dari kode dan laporan yang ada, nyatakan, dan tanyakan hanya yang salah pilihnya mahal.

**Anti-Pattern 5: menulis angka aturan dari ingatan.** Tarif pajak, upah minimum, dan batas resmi lain datang dari user atau dokumen yang dibuka, bukan dari agen.

---

## 6. Edge Case

**Edge Case 1: user tidak tahu aturannya.** Ia meneruskan permintaan orang lain. Susun pertanyaan yang bisa ia teruskan, dengan contoh konkret, dan jangan mulai sebelum terjawab untuk hal yang menghalangi.

**Edge Case 2: kode dan ucapan user bertentangan.** Kode menegakkan A, user bilang aturannya B. Tunjukkan berkasnya dan tanyakan mana yang benar; bisa jadi kodenya yang salah, bisa jadi aturannya sudah berubah.

**Edge Case 3: dua bagian perusahaan punya aturan berbeda.** Divisi atau cabang memperlakukan hal yang sama secara lain. Itu kebutuhan konfigurasi, dan menaikkan ukuran perubahan.

**Edge Case 4: aturan menyentuh kewajiban resmi.** Pajak, upah, jam kerja. Lensa legal ikut menyala; angkanya dari dokumen resmi atau dari user.

**Edge Case 5: proyek baru tanpa aturan tertulis.** Kumpulkan aturannya lebih dulu sebagai daftar bernomor di PRD; fitur pertama ditulis setelah daftar itu dibaca user.

**Edge Case 6: aturan "sementara".** Pengecualian yang dijanjikan hanya untuk bulan ini. Catat kapan dan bagaimana ia dicabut; pengecualian tanpa tanggal akhir menjadi aturan tetap.

---

## 7. Sumber

- Uji panel 10 November 2026 pada repo `altrms`: contoh temuan di bagian 4, sudah dicek ke kode (`ReimburseService::assertClaimableDuty`, `ReimburseDutyLinkTest`, `UnpaidLeaveService` yang sejak 5 Oktober 2026 mencatat kelebihan jatah sebagai unpaid, dan kueri laporan yang menghitung per tanggal perjalanan).
- Kejadian dari `shared/LEARNED.md`: "pakai cache saja nggak per user" (global lawan per user), "isi otomatis" dan PPN saat clone, cuti bersama, "maksimal v1.0.0", lima pertanyaan klarifikasi, konfirmasi sebelum blokir.
- `AGENTS.md` §4: request tanpa kejelasan masalah digali dulu.
- Katalog bagian 2 disusun sendiri dari kejadian di atas; tidak ada sumber luar yang dibuka untuk berkas ini.
