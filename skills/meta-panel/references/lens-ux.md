# Lensa 3 — UX / DX (setara senior product designer dan API lead)

Pendamping `SKILL.md` skill `meta-panel`. Dibuka saat request menyentuh apa pun yang terlihat user (layar, form, tabel, pesan), atau apa pun yang dipakai developer lain (response API, kontrak, pesan error, perintah).

Lensa ini menjawab: **bagaimana rasanya dipakai, oleh tiap peran, di tiap keadaan.** Bukan soal indah. Soal apakah orang tahu apa yang terjadi, apa yang harus dilakukan, dan apa yang berubah dari kemarin.

Dua pemakai dilihat sekaligus: **user akhir** (UX) dan **developer yang memakai API atau kode ini** (DX). Perubahan response API adalah perubahan antarmuka juga.

---

## 1. Cara Berpikirnya

| Pertanyaan pemula | Pertanyaan senior |
| :--- | :--- |
| "Tampilannya sudah sesuai?" | "Apa yang dilihat user saat datanya kosong, sedang dimuat, gagal, atau baru sebagian?" |
| "Tombolnya ada?" | "Setelah menekannya, dari mana user tahu berhasil, dan bisakah ia membatalkan?" |
| "Pesan error-nya ada?" | "Pesan itu menyebut apa yang salah dan apa yang harus dilakukan, dengan kata yang dipakai user?" |
| "Response-nya sudah ditambah field?" | "Klien lama yang tidak tahu field ini tetap jalan? Yang membaca field lama masih mendapat makna yang sama?" |
| "Sudah sama dengan desain?" | "Sudah sama dengan halaman sejenis di aplikasi ini, yang sudah dibiasakan user?" |

```text
Tiap layar punya lima keadaan, bukan satu
  kosong      belum ada data            -> apa yang tampil, apa ajakannya
  memuat      sedang mengambil          -> ada tanda, tombol tidak bisa ditekan dua kali
  berisi      keadaan normal            -> yang biasanya dirancang
  sebagian    banyak, panjang, terpotong -> 1 baris, 1.000 baris, teks 300 karakter
  gagal       error, tanpa izin, putus   -> pesan, jalan keluar, data yang sudah diketik
```

---

## 2. Katalog Kasus Tepi

### 2.1 Keadaan layar

| Cek | Skenario yang dicari |
| :--- | :--- |
| Kosong | Tabel tanpa baris, pencarian tanpa hasil, dropdown tanpa pilihan. Dropdown yang diam-diam kosong adalah gejala bug, bukan keadaan kosong. |
| Memuat | Tombol kirim bisa ditekan dua kali; daftar berkedip; tidak ada tanda sedang bekerja untuk aksi lebih dari sekitar satu detik. |
| Panjang | Nama 80 karakter, teks tanpa spasi, angka 12 digit, 30 baris di daftar yang dirancang untuk 5. |
| Gagal | Validasi gagal: isian yang sudah diketik tetap ada atau hilang? Gagal server: pesannya apa? |
| Tanpa izin | Disembunyikan, dimatikan dengan keterangan, atau ditolak setelah diklik. Konsisten dengan halaman lain. |
| Setelah aksi | Ada konfirmasi yang terlihat; daftar ikut diperbarui; fokus dan posisi gulir masuk akal. |

### 2.2 Konsistensi dengan aplikasi yang ada

| Cek | Skenario yang dicari |
| :--- | :--- |
| Halaman kembaran | Tabel, form, atau tombol aksi di modul sejenis sudah punya pola. Ikuti, atau tanya bila mau berbeda. |
| Kata-kata | Label dan deskripsi yang tampil adalah keputusan produk. Pakai kata yang disepakati user atau salin dari halaman sejenis; jangan merumuskan sendiri. |
| Komponen | Dialog, notifikasi, pemilih tanggal memakai library yang sudah dipakai proyek, dengan versinya. Dialog bawaan browser tidak dipakai. |
| Format | Tanggal, uang, dan angka mengikuti helper proyek dan bahasa tampilannya. |
| Kelas gaya | Kelas utilitas yang tidak ada di CSS hasil build tidak berefek dan tidak menimbulkan error. Cek keberadaannya di semua stylesheet yang dimuat. |
| Perilaku bawaan | User proyek ini memilih: peringatan lewat konfirmasi, bukan blokir; relasi tidak diubah otomatis; pemilih pencarian kosong sampai user mengetik. Blokir hanya untuk aksi yang merusak. |

### 2.3 Form dan input

| Cek | Skenario yang dicari |
| :--- | :--- |
| Bawaan | "Terisi otomatis" berarti prefill di form, bukan menyimpan di server. Menyimpan mengubah alur data. |
| Validasi | Muncul di field-nya, menyebut syaratnya, dan semua kesalahan tampil sekaligus. |
| Label di pesan | Placeholder pesan validasi yang diisi nama label; menulis label lagi di depannya menghasilkan teks ganda. |
| Field bersyarat | Field yang hanya relevan untuk satu varian dipasang bersyarat dari varian itu, bukan global. |
| Kehilangan isian | Sesi habis atau error di tengah form panjang. |
| Papan ketik dan HP | Jenis input yang tepat; tombol cukup besar; tabel lebar bisa digeser atau dilipat. |

### 2.4 Tabel, daftar, dan laporan

| Cek | Skenario yang dicari |
| :--- | :--- |
| Lebar | Tabel melebihi layar: bergeser mendatar atau teksnya dilipat. Pastikan aspek mana yang user maksud saat bilang "samakan". |
| Urut, cari, halaman | Bawaan urutan; pencarian atas kolom mana; posisi halaman setelah aksi. |
| Aksi per baris | Tombol aksi membungkus ke baris baru atau memaksa tabel melebar. |
| Cetak dan PDF | Halaman lanjutan, margin, kepala tabel berulang. Layout PDF diukur, bukan dinilai dari mata. |
| Angka | Rata kanan, pemisah ribuan, jumlah desimal konsisten antara rincian dan total. |

### 2.5 Perubahan bagi pemakai lama

| Cek | Skenario yang dicari |
| :--- | :--- |
| Yang pindah | Menu, tombol, atau langkah yang berpindah tempat. Siapa yang akan mencarinya di tempat lama? |
| Yang hilang | Fitur atau kolom yang dihapus masih dipakai seseorang? |
| Bawaan yang berubah | Urutan, filter, atau nilai awal yang berubah mengubah hasil tanpa user melakukan apa-apa. |
| Halaman yang sedang terbuka | User yang sedang membuka halaman saat rilis: form lama dikirim ke kode baru. |
| Pemberitahuan | Perubahan perilaku yang terlihat user disebut di catatan rilis atau diberi tahu. |

### 2.6 DX: API, kontrak, dan pesan untuk developer

| Cek | Skenario yang dicari |
| :--- | :--- |
| Kompatibilitas | Menambah field biasanya aman; mengganti nama, tipe, atau makna tidak. Klien lama (aplikasi HP yang belum diperbarui) masih jalan? |
| Makna key | Dua key bernama sama dengan isi berbeda; satu key melayani dua makna. |
| Bentuk error | Semua error satu bentuk; status code membedakan keadaan (belum login, tanpa izin, tidak ditemukan, tidak valid, bentrok). |
| Jalur penolakan baru | Penolakan baru dari service sampai ke klien sebagai apa? Baca blok `catch` di tiap controller pemanggilnya: jenis exception yang tidak ditangkap di sana jatuh ke handler umum dan dijawab 500, bukan 4xx dengan pesannya. Sebut jenis exception yang harus dipakai. |
| Dokumentasi | Contoh response dibuat dari eksekusi nyata dengan role sungguhan, dan isi body-nya diperiksa, bukan hanya status code. |
| Nilai tak dikenal | Enum atau field yang salah ketik: ditolak dengan pesan, atau diam-diam diabaikan. |
| Nama | Nama field, endpoint, dan pesan mengikuti yang sudah ada di API ini. |

### 2.7 Aksesibilitas dasar

Disusun dari tiga halaman W3C WAI. Daftar ini pemeriksaan awal: sumbernya sendiri menyebut "Easy Checks" itu "designed to be quick and easy, rather than definitive". Lulus daftar ini bukan berarti memenuhi WCAG.

**Sepuluh pemeriksaan cepat** (W3C, "Easy Checks"), dengan yang dicari di aplikasi bisnis:

| Pemeriksaan di sumber | Skenario yang dicari |
| :--- | :--- |
| Page title | Tiap halaman punya judul tab yang menyebut isinya, bukan nama aplikasi saja. |
| Image text alternatives | Gambar yang membawa arti punya teks pengganti; ikon tanpa teks punya nama. |
| Headings | Judul bertingkat sungguhan, bukan teks tebal. |
| Contrast ratio | Teks minimal 4.5:1 terhadap latarnya, 3:1 untuk teks besar (WCAG 1.4.3, AA). Diukur, bukan dinilai mata. Lencana berwarna dengan teks putih paling sering gagal. |
| Resize Text | Teks diperbesar tanpa ada yang terpotong atau bertumpuk. |
| Keyboard access and visual focus | Semua aksi bisa dijangkau tanpa mouse, urutannya masuk akal, dan fokusnya terlihat. Menu aksi dan dialog paling sering gagal. |
| Forms, labels, and errors | Tiap isian punya label yang terhubung; pesan gagal menyebut isiannya dan cara membetulkannya. |
| Moving, Flashing, or Blinking Content | Yang bergerak sendiri bisa dihentikan. |
| Multimedia alternatives | Video atau audio punya teks, bila ada. |
| Basic Structure Check | Halaman tetap terbaca urut tanpa gaya. |

**Yang baru di WCAG 2.2** dan sering kena di aplikasi web (tingkat A dan AA saja):

| Kriteria | Yang dicari |
| :--- | :--- |
| 2.5.8 Target Size (Minimum), AA | Sasaran sentuh "at least 24 by 24 CSS pixels", dengan pengecualian yang tertulis di kriterianya. Ikon aksi di baris tabel paling sering terlalu kecil. |
| 2.4.11 Focus Not Obscured (Minimum), AA | Elemen yang sedang difokus tidak tertutup kepala halaman atau bilah yang menempel. |
| 2.5.7 Dragging Movements, AA | Yang bisa diseret punya cara lain tanpa menyeret. |
| 3.3.7 Redundant Entry, A | Data yang sudah diisi di proses yang sama tidak diminta diketik ulang. |
| 3.3.8 Accessible Authentication (Minimum), AA | Login tidak mewajibkan uji ingatan atau teka-teki tanpa jalan lain; jangan menghalangi tempel password dan pengelola password. |
| 3.2.6 Consistent Help, A | Tautan bantuan berada di tempat yang sama di tiap halaman. |

Empat prinsip WCAG sebagai periksa silang terakhir: bisa ditangkap indra (perceivable), bisa dioperasikan (operable), bisa dipahami (understandable), dan tahan terhadap alat yang berbeda (robust).

Satu hal dari proyek user yang tidak ada di sumber: dialog harus benar-benar menutup, dan halaman di belakangnya tidak tertinggal dalam keadaan mati.
---

## 3. Sepuluh Heuristik sebagai Periksa Silang

Setelah katalog, sisir sepuluh heuristik kegunaan Jakob Nielsen dan tandai yang dilanggar perubahan ini:

1. Visibility of System Status
2. Match Between the System and the Real World
3. User Control and Freedom
4. Consistency and Standards
5. Error Prevention
6. Recognition Rather than Recall
7. Flexibility and Efficiency of Use
8. Aesthetic and Minimalist Design
9. Help Users Recognize, Diagnose, and Recover from Errors
10. Help and Documentation

Yang paling sering kena di aplikasi bisnis: nomor 1 (tidak ada tanda setelah aksi), 4 (berbeda dari halaman sejenis), 5 (aksi merusak tanpa konfirmasi), dan 9 (pesan error yang tidak menyebut jalan keluar).

---

## 4. Contoh Temuan

**Ditolak:**
> UX: perhatikan empty state dan loading state. Pastikan pesan error user-friendly.

**Layak dikirim:**
> Daftar item pengganti dimuat 30 baris begitu modal dibuka. Di modul lain proyek ini pemilih pencarian kosong sampai user mengetik, dan kamu sudah memilih pola itu sebelumnya (catatan 2026-09-10). Dengan 12 ribu item, 30 baris pertama juga hampir tidak pernah berisi yang dicari. Usul: kosong sampai diketik, seperti pemilih yang lain.

**Layak dikirim (DX):**
> Mengganti key `meta` jadi `pagination` di response daftar memutus aplikasi HP: `meta` di endpoint login berisi token, bukan info halaman, dan dua-duanya dihasilkan fungsi yang sama (sudah saya baca di helper response). Usul: tambah key baru tanpa menghapus yang lama, dan pisahkan dua makna itu di helper.

**Ditolak (selera, bukan temuan):**
> Sebaiknya tombolnya biru supaya lebih modern.

Tanpa pola yang sudah ada di aplikasi atau keluhan user, warna dan gaya bukan urusan panel.

---

## 5. Anti-Pattern

**Anti-Pattern 1: merumuskan teks antarmuka sendiri.** Deskripsi izin, label tombol, dan pesan yang tampil ke admin atau user ditanyakan atau disalin persis.

**Anti-Pattern 2: menafsirkan "samakan" sebagai gaya.** Tanya aspek mana: lebar, perilaku geser, warna, urutan kolom.

**Anti-Pattern 3: menambah ornamen.** Garis gradien, maskot, badge di judul, garis aksen tebal di sisi kartu, sapaan promosi. User menolak ini; tampilan mengikuti yang sudah ada.

**Anti-Pattern 4: memverifikasi tampilan dari test server.** Test membuktikan HTML-nya ada, bukan bahwa ia terlihat benar. Sebut bahwa perlu dilihat di halaman, dan dengan alat apa.

**Anti-Pattern 5: memblokir yang cukup diperingatkan.** Mulai dari yang paling mudah dibalik.

---

## 6. Edge Case

**Edge Case 1: tampilan HP tidak bisa direproduksi.** Jendela browser yang dikendalikan tidak selalu bisa mengecil. Minta tangkapan layar ke user daripada menghabiskan giliran.

**Edge Case 2: acuan visual user sendiri rusak.** Render lokal yang CSS atau gambarnya gagal dimuat dijadikan patokan. Render acuannya dulu dengan aset termuat sebelum menyamakan.

**Edge Case 3: CSS belum termuat saat diukur.** Ukuran huruf atau tata letak yang diukur sebelum stylesheet selesai memberi angka bawaan browser.

**Edge Case 4: beberapa komponen interaktif dalam satu halaman.** Inisialisasi komponen pertama berjalan sebelum yang berikutnya ada; error di sana menghentikan sisanya tanpa pesan. Cek halaman buat dan halaman ubah, dan baca console.

**Edge Case 5: konsumer API tidak ada di repo.** Aplikasi HP atau sistem lain. Tanyakan field mana yang dibaca sebelum mengubah bentuk response.

**Edge Case 6: user menolak verifikasi lewat browser.** Di beberapa proyek, cek visual diserahkan ke user. Tanyakan alatnya sebelum menjadikannya langkah rencana, dan laporkan terbuka apa yang tidak dilihat.

---

## 7. Sumber

- Jakob Nielsen, "10 Usability Heuristics for User Interface Design", Nielsen Norman Group, 1994, ditinjau ulang 30 Januari 2024 (dibuka 2026-11-10). Nama heuristik dikutip; penjelasannya tidak.
- Google AIP (google.aip.dev), daftar dibuka 2026-11-10: AIP-180 Backwards compatibility, AIP-193 Errors, AIP-158 Pagination. RFC 9457, Problem Details for HTTP APIs.
- Kejadian di proyek user dari `shared/LEARNED.md`: tabel PO yang "disamakan", pemilih 30 baris, dialog bawaan browser, deskripsi izin yang dirumuskan sendiri, `enctype` global, rename key response, contoh dokumentasi dengan role ber-bypass, dialog Alpine yang tidak menutup, kelas Tailwind yang tidak ada, pola "AI slop" yang ditolak.
- W3C WAI, dibuka 10 November 2026: "Easy Checks - A First Review of Web Accessibility" (diperbarui 9 Agustus 2023), "What's New in WCAG 2.2" (diperbarui 5 Oktober 2023), "WCAG 2 at a Glance" (diperbarui 29 November 2023), dan Understanding SC 1.4.3 Contrast (Minimum). Bagian 2.7 disusun dari empat halaman itu; nama pemeriksaan dan kriteria dikutip apa adanya, kolom "yang dicari" adalah terjemahan ke aplikasi bisnis oleh penyusun.
