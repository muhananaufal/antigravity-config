# Lensa 7 — QA / Edge-case (setara senior QA atau SDET)

Pendamping `SKILL.md` skill `meta-panel`. Dibuka pada setiap panel kelas Terbatas ke atas.

Lensa ini menjawab: **bagaimana saya merusaknya?** Bukan dengan menebak input aneh secara acak, melainkan dengan menyisir tujuh sumbu tempat perangkat lunak biasanya patah. Tiap sumbu di bawah berisi kasus untuk **dicek terhadap request yang sedang dipanel**; yang masuk ke panel hanya kasus yang benar-benar kena.

---

## 1. Cara Berpikirnya

| Pertanyaan pemula | Pertanyaan senior |
| :--- | :--- |
| "Apakah fiturnya jalan?" | "Dalam keadaan apa fitur ini memberi hasil salah tanpa error?" |
| "Sudah ada test?" | "Test itu pernah merah? Kalau kodenya saya rusak, apakah ia merah?" |
| "Input kosong ditangani?" | "Apa yang terjadi di antara dua langkah, saat langkah pertama sukses dan kedua gagal?" |
| "Sudah dicoba?" | "Dicoba sebagai siapa, dengan data sebanyak apa, dan pada jam berapa?" |

Yang dicari lensa ini paling sering bukan crash, tapi **hasil yang salah dan terlihat benar**: total yang meleset sen, daftar yang diam-diam kosong, test yang hijau karena alasan lain.

```text
Tujuh sumbu
  urutan      apa yang terjadi kalau langkahnya dibalik, diulang, atau dilompati
  bersamaan   dua orang, dua tab, dua request, dua worker
  waktu       tengah malam, akhir bulan, zona waktu, jam yang dibekukan
  jumlah      nol, satu, tepat di batas, ribuan
  bentuk      null, kosong, spasi, unicode, angka sebagai teks, array di tempat string
  peran       tiap role, tanpa role, role sakti, data milik orang lain
  keadaan     setengah jadi, sudah dihapus, sudah disetujui, kedaluwarsa
```

---

## 2. Katalog Kasus Tepi

### 2.1 Urutan

| Cek | Skenario yang dicari |
| :--- | :--- |
| Kirim dua kali | Tombol diklik dua kali cepat, atau request diulang klien setelah timeout. Apakah tercipta dua baris? |
| Langkah dilompati | URL langkah ketiga dibuka langsung tanpa langkah satu dan dua. |
| Tombol kembali | Form dikirim, tekan kembali, kirim lagi dengan data lama. |
| Aksi pada keadaan salah | Menyetujui yang sudah ditolak, mengedit yang sudah dibayar, menghapus yang sedang dipakai. |
| Urutan suntingan | Pada server dev yang dipakai user langsung: view yang membaca variabel baru disunting sebelum controller yang mengirimnya. |
| Urutan rilis | Kode baru jalan sebelum migrasi, atau migrasi jalan sebelum kode lama berhenti. |

### 2.2 Bersamaan

| Cek | Skenario yang dicari |
| :--- | :--- |
| Cek lalu tulis | Dua request sama-sama lolos pengecekan stok, kuota, atau keunikan sebelum salah satunya menulis. |
| Dua tab | User membuka dua tab, mengubah di tab satu, menyimpan data lama dari tab dua. |
| Worker ganda | Job yang sama diambil dua worker, atau dijalankan ulang setelah gagal di tengah. |
| Balapan dengan waktu | Asersi atau logika yang memanggil jam dua kali dan mengharap hasil sama. |
| Proses di belakang | Konsumen antrian atau proyektor yang hidup saat test integrasi menulis ke tabel yang sama. |

### 2.3 Waktu

| Cek | Skenario yang dicari |
| :--- | :--- |
| Batas hari dan bulan | Transaksi pukul 23:59 dan 00:00; laporan bulanan untuk tanggal 31; Februari. |
| Zona waktu | Disimpan UTC, ditampilkan lokal, difilter dengan tanggal lokal. |
| Lintas hari | Booking atau shift yang mulai sebelum tengah malam dan selesai sesudahnya. |
| Waktu dibekukan | Test dengan jam dibekukan tidak pernah melepas throttle, kedaluwarsa, atau TTL. |
| Jendela kosong | Rasio atau rata-rata atas rentang tanpa data: pembagian nol atau nilai bukan-angka yang meracuni agregat. |

### 2.4 Jumlah

| Cek | Skenario yang dicari |
| :--- | :--- |
| Nol | Daftar kosong, laporan tanpa baris, pengguna tanpa riwayat. Apa yang tampil? |
| Satu vs banyak | Kode yang benar untuk satu item tapi salah untuk dua (helper bentrok, daftar yang menyambung ke perintah shell). |
| Tepat di batas | Item ke-N tepat di batas halaman, kuota, atau throttle. Request ke-61 saat batasnya 60. |
| Banyak | Tabel puluhan ribu baris: query tanpa index, export yang kehabisan memori, daftar yang memuat semuanya. |
| Angka uang | Hasil kali float di SQL yang kembali sebagai `6349200.000000001`; uji dengan angka ber-noise, bukan angka bulat. |

### 2.5 Bentuk input

| Cek | Skenario yang dicari |
| :--- | :--- |
| Kosong yang bermacam-macam | `null`, string kosong, spasi saja, `"-"`, `"0"`, array kosong. Tiap satu bisa lolos penjaga yang berbeda. |
| Tipe yang salah | Array di tempat string (`search[value]` dari DataTables), angka sebagai teks, boolean sebagai `"false"`. |
| Teks sulit | Unicode, aksen, emoji, tanda kutip, `<`, `&`, garis miring, baris baru, teks 1.000 karakter tanpa spasi. |
| Enum tak dikenal | Nilai enum salah ketik yang diam-diam jadi nilai nol bila decoder longgar. |
| Berkas | Ukuran nol, sangat besar, ekstensi palsu, nama berkas dengan spasi atau path. |
| Path dan nama khusus | Nama yang berarti lain di sistem operasi; path gaya satu shell dibaca program lain. |

### 2.6 Peran

| Cek | Skenario yang dicari |
| :--- | :--- |
| Tiap role sungguhan | Fitur dicoba sebagai tiap role yang memakainya, bukan hanya admin. |
| Tanpa izin | User tanpa izin membuka URL-nya langsung. Ditolak di endpoint, bukan hanya disembunyikan di menu. |
| Milik orang lain | User A mengganti id di URL atau body menjadi milik user B. |
| Role sakti | Test atau dokumentasi yang dibuat dengan role ber-bypass tidak mewakili siapa pun. |
| Dua aktor dalam satu test | Guard atau menu yang di-cache per instance aplikasi memakai hasil aktor pertama. |
| Izin tanpa fitur, fitur tanpa izin | Permission ada tapi route-nya menunjuk method yang tidak ada, atau sebaliknya. |

### 2.7 Keadaan

| Cek | Skenario yang dicari |
| :--- | :--- |
| Setengah jadi | Langkah pertama tersimpan, langkah kedua gagal. Apa yang tertinggal, dan bisakah diulang? |
| Data lama | Baris yang dibuat sebelum kolom baru ada; nilainya `null` atau bawaan. |
| Sudah dihapus | Soft delete yang masih ikut terhitung, atau induk dihapus sementara anaknya tersisa. |
| Kedaluwarsa | Token, sesi, cache, atau tautan yang dibuka setelah masa berlakunya. |
| Cache basi | Hasil lama tetap tersaji setelah data berubah; "kosong" dari cache yang belum terisi dibaca sebagai jawaban sah. |
| Lingkungan | Jalan di lokal karena `.env`, tabrakan port, atau versi bahasa; merah di CI yang bersih. |

---

## 3. Menilai Test yang Ada dan yang Akan Ditulis

Panel menyebut rencana test bila request mengubah perilaku. Empat hal yang dicek:

1. **Test itu bisa merah.** Test baru disaksikan gagal dulu, dengan alasan yang benar. Merah karena route belum ada tidak sama dengan merah karena aturannya salah.
2. **Asersinya tidak lolos karena kebetulan.** `assertSee('Order Creator')` lolos karena judul kartu memuat teks itu. `assertJsonPath(..., null)` lolos untuk key yang tidak ada. Pakai nilai unik atau potongan markup.
3. **Jalur sukses ditembus.** Minimal satu test per endpoint yang sampai ke controller dan kembali 2xx.
4. **Jumlah test yang jalan dicocokkan.** Perintah test dengan dua path bisa diam-diam menjalankan satu. Bandingkan jumlah yang jalan dengan yang diharapkan.

Uji mutasi adalah cara termurah mengetahui test buta: rusak kodenya dengan sengaja, pastikan berkasnya benar-benar berubah, lalu lihat apakah suite merah.

---

## 4. Contoh Temuan

**Ditolak (bisa ditempel ke request mana pun):**
> QA: perlu dicek edge case dan race condition-nya. Pastikan ada validasi input.

**Layak dikirim:**
> Kalau karyawan menekan "Ajukan" dua kali cepat, dua pengajuan tersimpan: `ReimburseController::store` langsung `create()` tanpa kunci unik dan tombolnya tidak dimatikan setelah klik (sudah saya baca di controller dan view form). Akibatnya HRD melihat dua baris identik dan bisa menyetujui keduanya. Usul: matikan tombol setelah klik dan tambah kunci unik `(user_id, tanggal, nominal, jenis)`; yang pertama cukup untuk sekarang, yang kedua mencegah lewat API.

**Ditolak (konsekuensi aturan yang user sudah tahu):**
> Kalau izin HRD dicabut, HRD tidak bisa menyetujui pengajuan.

**Ditolak (penjaga yang sudah dijawab lapis lain):**
> Perlu gerbang untuk nomor WA kosong di controller.

Sebelum mengusulkan penjaga, cek apakah penyaring di atasnya sudah menanganinya. Cara membuktikannya: cabut penjaganya, jalankan test, lihat warnanya.

---

## 5. Anti-Pattern

**Anti-Pattern 1: daftar kasus tepi yang disalin.** Menempel tujuh sumbu ke panel tanpa mengeceknya. Panel memuat hasil pengecekan, bukan daftar pertanyaan.

**Anti-Pattern 2: "bagaimana kalau X tidak ada" tanpa bukti.** Mengarang skenario dari kemungkinan teoretis. Cek dulu apakah X memang bisa tidak ada: kolomnya nullable atau tidak, datanya di database ada yang kosong atau tidak.

**Anti-Pattern 3: menilai seberapa sering dari struktur kode.** "Jarang terjadi" adalah klaim tentang riwayat; tanyakan ke tabel log dan `failed_jobs`.

**Anti-Pattern 4: fixture angka bulat dan nama pendek.** Data uji yang terlalu rapi tidak memicu galat pembulatan, teks panjang, atau karakter khusus.

**Anti-Pattern 5: percaya suite hijau.** Hijau membuktikan asersi yang ada terpenuhi, bukan bahwa perilakunya benar. Tanyakan: asersi mana yang akan merah bila bug ini ada?

---

## 6. Edge Case Lensa Ini Sendiri

**Edge Case 1: tidak ada test sama sekali di modul itu.** Panel menyebutnya sebagai risiko dan mengusulkan satu test jalur sukses sebagai jaring sebelum mengubah apa pun, bukan menuntut suite penuh.

**Edge Case 2: perilaku hanya terlihat di browser.** Dialog yang tidak menutup, tombol yang mati setelah skrip rusak, tata letak yang meluber. Test server tidak menangkapnya; sebut bahwa itu perlu dilihat di halaman (lihat `meta-swipe`), dan dengan alat apa.

**Edge Case 3: test lambat.** Suite penuh belasan menit. Jalankan test modul yang disentuh, cocokkan jumlahnya, dan katakan suite penuh belum dijalankan.

**Edge Case 4: hasil suite berbeda antar-run.** Dua hasil dari kode yang sama adalah temuan, bukan gangguan. Kejar penyebabnya (jam, urutan, state bersama) sebelum lanjut.

**Edge Case 5: database test menunjuk database kerja user.** Sebelum menjalankan test yang menyegarkan database, baca konfigurasinya. Database lokal user tidak di-`migrate` tanpa izin.

---

## 7. Sumber

Seluruh kasus di katalog berasal dari kejadian yang tercatat di `shared/LEARNED.md` proyek user (altrms, manunggal-purchasing, pentahoot, trs-vivace, mp-so, selaras; Agustus–November 2026) atau dari daftar yang dibuka saat berkas ini ditulis (2026-11-10): 100 Go Mistakes, bagian Testing dan Concurrency (100go.co). Sumbu "urutan, bersamaan, waktu, jumlah, bentuk, peran, keadaan" adalah pengelompokan penyusun, bukan standar dari luar.
