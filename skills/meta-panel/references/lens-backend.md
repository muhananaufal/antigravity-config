# Lensa 8 — Backend / Arsitektur (setara senior backend engineer atau tech lead)

Pendamping `SKILL.md` skill `meta-panel`. Dibuka saat request menyentuh logika bisnis di server, lapisan baru (service, helper, job, event), batas modul, integrasi antarbagian, transaksi, atau pekerjaan di proyek lama yang polanya belum dikenali.

Lensa ini menjawab: **di mana kode ini seharusnya tinggal, bagaimana ia menyatu dengan yang sudah ada, dan apa yang terjadi saat separuh pekerjaannya gagal.** Lensa data melihat tabel dan kueri; lensa ops melihat cara jalannya di server; lensa ini melihat susunan kodenya sendiri.

Sebagian besar pekerjaan user ada di proyek lama. Di sana pertanyaan pertama bukan "pola apa yang terbaik", melainkan **"pola apa yang sudah dipakai repo ini"**.

---

## 1. Cara Berpikirnya

| Pertanyaan pemula | Pertanyaan senior |
| :--- | :--- |
| "Logikanya ditulis di mana?" | "Di repo ini logika sejenis ditulis di mana, dan kenapa?" |
| "Sudah jalan untuk kasus ini?" | "Jalur lain yang berujung di fungsi yang sama ikut berubah?" |
| "Perlu service baru?" | "Berapa tempat yang akan memanggilnya, dan apakah aturan ini memang satu aturan?" |
| "Kalau error, lempar exception." | "Siapa yang menangkapnya, dan apa yang sudah telanjur tersimpan saat itu?" |
| "Panggil API pihak ketiga di sini." | "Kalau ia lambat, mati, atau menjawab dua kali, keadaan kita jadi apa?" |

```text
Satu perubahan di server dilihat dari lima sisi
  tempat        lapisan mana, mengikuti pola repo atau menyimpang
  pintu masuk   web, API, job, command, impor: semua yang berujung di kode ini
  batas         transaksi, kunci, urutan: apa yang harus jadi satu kesatuan
  kegagalan     separuh jalan, dipanggil dua kali, pihak luar tidak menjawab
  kontrak       apa yang dijanjikan fungsi ini ke pemanggilnya
```

---

## 2. Katalog Kasus Tepi

### 2.1 Tempat dan pola repo

| Cek | Skenario yang dicari |
| :--- | :--- |
| Pola yang sudah ada | Aturan sejenis ditulis langsung di controller di sepuluh tempat; versi baru memakai service. Atau sebaliknya. Ikuti repo, atau sajikan penyimpangannya sebagai keputusan user. |
| Satu aturan, banyak salinan | Aturan yang sama ditegakkan di controller web, controller API, dan tampilan. Mengubah satu meninggalkan dua lainnya. |
| Aturan di tampilan | Tombol disembunyikan, tetapi alamatnya tidak dijaga. Aturan harus hidup di server; tampilan hanya mengikutinya. |
| Lapisan yang menjawab hal berbeda | Policy menjawab "siapa", service menjawab "kapan" (status, tanggal). Mencampurnya membuat satu sisi menawarkan aksi yang ditolak sisi lain. |
| Kode proyek lama | Framework versi lama, tanpa DI, helper global. Pola modern yang dipaksakan jadi pulau yang tidak dipahami orang berikutnya. |
| Nama | Fungsi, kelas, dan berkas mengikuti penamaan modul sejenis. |

### 2.2 Semua pintu masuk

| Cek | Skenario yang dicari |
| :--- | :--- |
| Web dan API | Dua controller berujung di service yang sama, atau justru masing-masing punya logikanya sendiri. Perubahan harus sampai ke keduanya. |
| Jalur ubah | Aturan dipasang di pembuatan; jalur ubah bisa memindahkan data ke keadaan yang dilarang (ganti tanggal, ganti pemilik). |
| Job, command, impor | Jalur yang tidak lewat controller sering melewati validasi dan penjaga yang sama. |
| Atas nama orang lain | Admin membuat atau mengubah untuk pengguna lain: aturan dihitung ke pelaku atau ke pemilik data? |
| Hook dan event | Observer, listener, atau trigger yang berjalan diam-diam saat model disimpan. |

### 2.3 Transaksi dan keadaan setengah jadi

| Cek | Skenario yang dicari |
| :--- | :--- |
| Beberapa tulisan yang harus satu | Menyimpan induk lalu rincian; gagal di rincian meninggalkan induk tanpa isi. |
| Tulis ke database dan ke luar | Data tersimpan, lalu kirim notifikasi atau unggah berkas gagal; atau sebaliknya, pesan terkirim lalu transaksi dibatalkan. |
| Berkas dan database | Berkas terunggah, baris gagal tersimpan: berkas yatim. Baris terhapus, berkas tertinggal. |
| Hitung lalu simpan | Membaca jumlah atau saldo, memutuskan, lalu menulis. Dua permintaan serentak sama-sama lolos. Perlu kunci atau batasan di database. |
| Kunci yang tidak dipakai semua jalur | Pembuatan memegang kunci; jalur ubah tidak. |
| Transaksi panjang | Panggilan ke pihak luar di dalam transaksi menahan kunci selama pihak luar lambat. |

### 2.4 Dipanggil dua kali

| Cek | Skenario yang dicari |
| :--- | :--- |
| Klik ganda dan kirim ulang | Dua data kembar; dua notifikasi. |
| Percobaan ulang job | Job yang gagal di tengah diulang dari awal dan mengulang efek sampingnya. |
| Callback pihak luar | Webhook yang sama datang dua kali atau tidak berurutan. |
| Tombol kembali browser | Form lama dikirim ulang setelah berhasil. |

### 2.5 Pihak luar dan batas modul

| Cek | Skenario yang dicari |
| :--- | :--- |
| Lambat atau mati | Ada batas waktu? Apa yang dilihat pengguna, dan apa yang tersimpan? |
| Jawaban tak terduga | Bentuk jawaban berubah, kosong, atau berisi error berstatus 200. |
| Rahasia dan alamat | Dibaca dari konfigurasi, bukan ditulis di kode; berbeda per lingkungan. |
| Modul memanggil isi modul lain | Mengambil tabel atau fungsi internal modul lain alih-alih pintu resminya. Perubahan di sana memutus di sini. |
| Ketergantungan melingkar | A memanggil B yang memanggil A; sering muncul saat menambah "sekalian". |

### 2.6 Kontrak fungsi dan penanganan error

| Cek | Skenario yang dicari |
| :--- | :--- |
| Jenis error yang dilempar | Controller pemanggil hanya menangkap jenis tertentu; jenis lain jatuh jadi 500 dan tercatat sebagai error di log. |
| Nilai kosong | `null`, koleksi kosong, atau string kosong dari fungsi yang pemanggilnya menganggap selalu ada. |
| Parameter opsional | Parameter baru dengan bawaan yang mengubah perilaku pemanggil lama. |
| Nilai balik berubah makna | Dulu mengembalikan model, sekarang mengembalikan array; pemanggil lain masih memperlakukannya sebagai model. |
| Error yang ditelan | `catch` kosong atau yang hanya mencatat lalu lanjut, sehingga kegagalan terlihat seperti berhasil. |
| Waktu dan zona | "Hari ini", awal bulan, dan batas tengah malam dihitung di zona mana. |

---

## 3. Cara Mengecek

1. **Cari pola sejenis dulu.** Cari ekspresi, nama fungsi, atau aturan serupa di repo dan hitung kemunculannya. Itu yang menentukan "cara repo ini".
2. **Telusuri dari pintu masuk.** Dari route ke controller ke fungsi yang diubah, untuk tiap pintu: web, API, job, command.
3. **Baca blok `catch` pemanggil.** Jenis error apa yang ditangkap, dan apa jawabannya ke pengguna.
4. **Cari batas transaksi dan kunci.** Apakah perubahan berada di dalam atau di luar, dan apakah jalur lain memakai kunci yang sama.
5. **Baca hook.** Observer, listener, event model, dan trigger database untuk model yang disentuh.
6. **Baca source library yang diandalkan** untuk perilaku yang menentukan (bawaan, urutan, penanganan error). Ingatan tentang library bukan bukti (`AGENTS.md` §3.4).

---

## 4. Contoh Temuan

**Ditolak:**
> Backend: pastikan logika bisnis ada di service layer dan gunakan transaksi.

**Layak dikirim:**
> Batas tiga klaim per bulan kalau dipasang di `ReimburseService::create` saja masih bisa dilewati lewat edit: `update` menerima tanggal baru, dan di web HRD bisa mengganti pemiliknya. Klaim keempat diajukan bertanggal bulan lain lalu digeser masuk. Sudah saya baca di dua method itu. Usul: pengecekan yang sama di `update` saat tanggal pindah bulan atau pemilik berganti, dengan klaim yang sedang diedit tidak dihitung dua kali.

**Layak dikirim (jenis error):**
> Penolakan baru harus dilempar sebagai `ClaimNotEditableException`. `ReimburseController::store` hanya menangkap jenis itu dan menjawab 422 dengan pesannya; jenis lain jatuh ke handler dan dijawab 500. Sudah saya baca di controller API.

**Ditolak (selera arsitektur):**
> Sebaiknya modul ini dipecah jadi repository pattern supaya lebih bersih.

Tanpa masalah nyata yang dipecahkannya di repo ini, itu preferensi, bukan temuan.

---

## 5. Anti-Pattern

**Anti-Pattern 1: membawa pola dari luar.** Menambah lapisan yang tidak dipakai repo ini karena "praktik yang baik". Di proyek lama, konsistensi lebih murah daripada kerapian.

**Anti-Pattern 2: hanya menelusuri satu pintu.** Membaca controller web, lupa API, job, dan impor.

**Anti-Pattern 3: menganggap `try/catch` sebagai penanganan.** Menangkap error tanpa memutuskan apa yang terjadi pada data yang sudah tersimpan.

**Anti-Pattern 4: menebak perilaku library.** Menulis di atas dugaan tentang bawaan atau urutan eksekusi, tanpa membuka source yang terpasang.

**Anti-Pattern 5: memperbaiki arsitektur sambil lewat.** Refactor yang tidak diminta diselipkan ke dalam perbaikan kecil.

---

## 6. Edge Case

**Edge Case 1: repo punya dua pola untuk hal yang sama.** Modul lama dan modul baru berbeda. Ikuti pola modul yang sedang disentuh, dan sebut bahwa ada dua.

**Edge Case 2: kode yang tidak punya test.** Proyek lama sering begitu. Petakan pemanggilnya lebih teliti, dan usulkan test karakterisasi kecil sebelum mengubah.

**Edge Case 3: logika di database.** Trigger, view, atau prosedur tersimpan yang tidak terlihat dari kode aplikasi. Cari di migrasi dan dump skema.

**Edge Case 4: versi framework lama.** Fitur yang diingat mungkin belum ada di versi itu. Cek versi di berkas kunci dependency sebelum mengusulkan.

**Edge Case 5: kode mati yang mirip kode hidup.** Fungsi yang tampak dipakai ternyata tidak punya pemanggil. Cari pemanggilnya sebelum mengubah atau menirunya.

**Edge Case 6: proyek baru tanpa pola sama sekali.** Di sini pola memang harus dipilih. Itu keputusan arsitektur: lewat alur proyek baru (`references/proyek-baru.md`), bukan diputuskan sambil menulis fitur pertama.

---

## 7. Sumber

- Uji panel 10 November 2026 pada repo `altrms`: dua contoh temuan di bagian 4 berasal dari sana dan sudah dicek ke kode (`ReimburseService::create` dan `update`, `ReimburseController::store`).
- Kejadian dari `shared/LEARNED.md`: helper yang ditolak karena repo menulis pengecekan langsung, FormRequest bersama yang dilonggarkan, modul kembaran `off` dan `booking`, key response yang punya dua makna, bawaan library yang ditebak.
- Komentar di `altrms`: "Policy menjawab SIAPA; status pending menjawab KAPAN" (`OffTable.php`), dibaca 10 November 2026.
- Katalog bagian 2 disusun sendiri dari kejadian di atas; tidak ada sumber luar yang dibuka untuk berkas ini.
