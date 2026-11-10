# Lensa 6 — Data (setara senior DBA atau data engineer)

Pendamping `SKILL.md` skill `meta-panel`. Dibuka saat request menyentuh migrasi, query baru atau yang berubah, laporan, impor atau ekspor, perubahan makna kolom, atau penghapusan data.

Lensa ini menjawab: **apakah data tetap benar, tetap bisa dibaca dengan cepat, dan tetap bisa dikembalikan.** Kode yang salah bisa diganti di rilis berikutnya; data yang salah tertulis tinggal di sana sampai ada yang membersihkannya.

---

## 1. Cara Berpikirnya

| Pertanyaan pemula | Pertanyaan senior |
| :--- | :--- |
| "Migrasinya jalan di lokal?" | "Di tabel sebesar production, migrasi ini mengunci apa dan berapa lama?" |
| "Query-nya benar?" | "Hasilnya benar, tapi diambil lewat index atau lewat membaca seluruh tabel?" |
| "Kolomnya sudah ditambah?" | "Baris lama berisi apa di kolom itu, dan kode mana yang membacanya?" |
| "Bisa di-rollback?" | "Setelah `down`, data yang sempat tertulis di bentuk baru ke mana?" |
| "Laporannya cocok?" | "Cocok untuk fixture angka bulat, atau juga untuk data nyata yang ber-noise dan berlubang?" |

```text
Tiga hal yang dijaga
  kebenaran     constraint, transaksi, satu sumber kebenaran, makna kolom
  kecepatan     rencana query, index, jumlah baris yang disentuh
  pemulihan     bisa dibalik, ada cadangan, bisa diulang tanpa efek ganda
```

---

## 2. Katalog Kasus Tepi

### 2.1 Perubahan skema

| Cek | Skenario yang dicari |
| :--- | :--- |
| Kunci | Perubahan tabel yang menahan tulis (atau baca) selama berjalan. Lamanya tergantung mesin database, versinya, dan ukuran tabel: **ukur atau baca dokumentasi versi yang dipakai**, jangan menebak. |
| Bertahap | Perubahan yang tidak kompatibel dipecah: tambah bentuk baru, isi, pindahkan pembaca, baru hapus bentuk lama. Menghapus atau mengganti nama kolom dalam satu langkah memutus kode yang sedang berjalan. |
| Bawaan dan `NOT NULL` | Kolom wajib baru pada tabel berisi data: baris lama diisi apa? Factory dan seeder lama ikut patah bila tidak mengisinya. |
| Backfill | Mengisi data lama dalam satu perintah besar di dalam migrasi vs per batch di luar transaksi migrasi. Baca aturan migrasi proyeknya dulu. |
| Bisa dibalik | `down` benar-benar mengembalikan, atau hanya menghapus kolom dan membuang isinya. |
| Nama kolom yang ditebak | Mutasi atau migrasi yang menyebut kolom dari ingatan. Baca nama aslinya dari skema. |
| Perintah yang menghapus | `migrate:fresh` dan sejenisnya menghapus data. Di proyek user ini dilarang, juga di lokal. |

### 2.2 Query dan performa

| Cek | Skenario yang dicari |
| :--- | :--- |
| Rencana eksekusi | Untuk query di atas tabel puluhan ribu baris, `EXPLAIN` masuk ke pemeriksaan sebelum commit, sejajar dengan test. Test membuktikan hasilnya benar; ia tidak mengatakan apa pun soal cara mengambilnya. |
| Filter yang tidak terdorong | Agregat atau view yang menghitung seluruh tabel sebelum filter tanggal diterapkan dari luar. |
| N+1 | Loop yang menjalankan satu query per baris. Tampak cepat dengan sepuluh baris. |
| Index | Kolom filter, kolom urut, dan kolom join. Index gabungan mengikuti urutan kolom. Index baru menambah biaya tulis. |
| JOIN yang menggandakan | Join ke tabel anak melipatgandakan baris induk sehingga `SUM` di induk ikut berlipat. |
| Mode SQL | Query yang lolos di lokal karena mode ketat dimatikan, lalu gagal di server yang menyalakannya. Uji dengan mode dipaksa menyala. |
| Pagination | `OFFSET` besar makin lambat; urutan tidak stabil tanpa kolom pembeda menghasilkan baris dobel atau hilang antar halaman. |

### 2.3 Kebenaran

| Cek | Skenario yang dicari |
| :--- | :--- |
| Transaksi | Dua atau lebih tulis yang harus sama-sama berhasil. Cek-lalu-tulis tanpa transaksi atau kunci membuka balapan. |
| Constraint | Keunikan dan relasi dijaga database, bukan hanya validasi aplikasi. Validasi aplikasi tidak menahan dua request bersamaan. |
| Uang dan angka | Float untuk uang; hasil kali di SQL yang membawa galat kecil; pembulatan sebelum ditampilkan dan sebelum dibandingkan. |
| Sumber kebenaran ganda | Nilai yang sama disimpan di dua tempat (total di header dan jumlah detail). Mana yang menang saat berbeda? |
| Makna kolom | Kolom `status`, `type`, `date` yang maknanya bergeser setelah perubahan. Laporan lama membaca makna lama. |
| Relasi yang diubah otomatis | Meratakan rantai pengganti atau memindahkan relasi tanpa diminta. User proyek ini memilih peringatan, bukan perubahan otomatis. |
| Soft delete | Baris terhapus yang masih ikut terhitung, ikut unik, atau ikut tampil di laporan. |
| Idempotensi di bawah kebijakan baris | Cara "sisipkan kalau belum ada" bisa berperilaku lain di bawah kebijakan akses baris; uji dengan peran aplikasi yang sebenarnya. |

### 2.4 Laporan, impor, ekspor

| Cek | Skenario yang dicari |
| :--- | :--- |
| Rentang tanggal | Batas inklusif atau eksklusif; zona waktu; transaksi tepat tengah malam; bulan tanpa data. |
| Angka turunan | Diturunkan dari input asli dokumen sumbernya, bukan dari angka turunan dokumen lain. |
| Cocok dengan layar | Total di laporan dibandingkan dengan total di halaman rincian untuk data asli, bukan fixture. |
| Impor ulang | Menjalankan impor yang sama dua kali: jumlah baris tetap atau berlipat? |
| Berkas besar | Dibaca per baris atau dimuat seluruhnya ke memori. |
| Kolom tersembunyi | Ekspor memuat kolom yang tidak tampil di layar dan tidak boleh dilihat peran itu. |
| Encoding dan format | Pemisah desimal, format tanggal, BOM, pemisah baris. Format tanggal cetak mengikuti helper proyek, bukan bawaan bahasa. |

### 2.5 Pertumbuhan dan siklus hidup

| Cek | Skenario yang dicari |
| :--- | :--- |
| Laju tumbuh | Tabel log, riwayat, notifikasi, sesi: berapa baris per hari, dan apa rencananya setelah setahun. |
| Retensi | Kapan data lama diarsipkan atau dihapus, dan siapa yang masih membutuhkannya. |
| Cadangan | Ada cadangan, dan **isinya** pernah diperiksa. Berkas cadangan nol byte bernama benar bukan cadangan. |
| Peran database | Peran yang menjalankan migrasi dipisah dari peran aplikasi, supaya penjaga di tingkat database tidak bisa dimatikan aplikasi. |

---

## 3. Cara Mengecek

1. **Baca skema nyata**, bukan model saja: kolom, tipe, nullable, index, constraint.
2. **Hitung ukuran tabel** yang disentuh di lingkungan yang ada, dan sebut lingkungannya. Angka lokal tidak membantah klaim tentang production.
3. **Jalankan `EXPLAIN`** untuk query baru atau yang berubah, dengan data sebesar yang tersedia.
4. **Cari semua pembaca kolom** yang berubah (peta keterkaitan 2.1): model, query mentah, view, laporan, ekspor.
5. **Cek data yang ada**: adakah baris yang akan melanggar constraint baru, adakah `null` di kolom yang akan diwajibkan.
6. **Baca aturan migrasi proyek** (runbook, konvensi seeder, perintah yang dilarang) sebelum menulis rencananya.

---

## 4. Contoh Temuan

**Ditolak:**
> Data: pastikan migrasi aman dan query sudah dioptimasi. Tambahkan index bila perlu.

**Layak dikirim:**
> Laporan permintaan bulanan versi baru memakai tabel turunan beragregasi. Hasilnya benar (4 test lulus), tapi `EXPLAIN` menunjukkan ia membaca seluruh `received_purchase_detail` (sekitar 30 ribu baris di lokal) tiap kali laporan dibuka, karena filter bulan ada di query luar dan tidak terdorong masuk. View lain di repo ini memakai subquery terkorelasi ke kunci join dan hanya menyentuh satu baris lewat index. Usul: ikuti bentuk itu. Ukurannya dari database lokal; production bisa lebih besar.

**Ditolak (mengukur lokal, membantah production):**
> Di database saya tidak ada data yang tidak cocok, jadi laporan user tidak mungkin salah.

Database lokal bisa basi, sebagian, atau hasil seed.

---

## 5. Anti-Pattern

**Anti-Pattern 1: migrasi diuji hanya di tabel kosong.** Perilaku kunci dan lamanya baru terlihat di tabel berisi.

**Anti-Pattern 2: test hijau dianggap bukti performa.** Rencana eksekusi diperiksa terpisah.

**Anti-Pattern 3: menyimpan nilai turunan tanpa aturan siapa yang menang.** Dua sumber kebenaran akan berbeda suatu hari.

**Anti-Pattern 4: melebarkan hak peran database demi satu fitur.** Mengukur dulu apa yang boleh dilakukan peran runtime, lalu merancang di dalam batas itu.

**Anti-Pattern 5: operasi massal tanpa penjaga jumlah.** `sync`, `update`, atau `delete` dengan input yang ternyata kosong menghapus atau mengubah semuanya. Cek bentuk dan jumlah input sebelum menulis.

---

## 6. Edge Case

**Edge Case 1: tidak ada akses ke data production.** User sering hanya meneruskan keluhan. Kalau cacatnya ada di bentuk query, buktikan dengan fixture sintetis yang dijalankan ke fungsi aslinya; jangan menggantungkan diagnosis pada data yang tidak bisa diambil siapa pun.

**Edge Case 2: view atau prosedur di database.** Logika yang tidak ada di repo aplikasi. Cari definisinya di database sebelum menyimpulkan dari kode.

**Edge Case 3: dua aplikasi berbagi satu database.** Mengubah kolom memutus aplikasi lain yang tidak ada di repo ini. Tanyakan.

**Edge Case 4: skema dikelola di luar migrasi.** Proyek lama mengubah tabel langsung. Skema di repo bisa tidak sama dengan yang berjalan; baca dari database.

**Edge Case 5: perubahan lokal driver.** User bisa punya tambalan lokal pada driver atau config database yang tidak di-commit. Query baru diuji juga dengan perilaku bawaan server.

**Edge Case 6: "hapus" yang diminta user.** Tanyakan apakah maksudnya hilang dari layar atau hilang dari database, dan apa yang terjadi pada baris yang merujuknya.

---

## 7. Sumber

- Dokumentasi PostgreSQL 18, daftar isi dibuka 2026-11-10: bab Indexes, Concurrency Control, Performance Tips. Use The Index, Luke (use-the-index-luke.com), daftar isi dibuka 2026-11-10.
- Dokumentasi `database/sql` Go, dibuka 2026-11-10: pool koneksi, transaksi, parameter query.
- Kejadian di proyek user dari `shared/LEARNED.md`: laporan dengan tabel turunan (manunggal-purchasing 2026-09-01), view bulanan yang lambat dan mode SQL (2026-09-14), galat float di total, DB lokal vs production, larangan `migrate:fresh`, `sync` dengan null yang mengosongkan izin, backfill per batch dan RLS (selaras), cadangan nol byte, factory tanpa kolom wajib.
- Pernyataan soal kunci saat mengubah tabel sengaja ditulis umum: perilakunya berbeda antar mesin dan versi, dan tidak ada dokumen versi tertentu yang dibuka saat berkas ini ditulis.
