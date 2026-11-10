# Peta Keterkaitan — Menelusuri Apa yang Ikut Tersentuh

Pendamping `SKILL.md` skill `meta-panel`, bagian 0c. Dibuka pada setiap panel kelas Terbatas ke atas, **sebelum** lensa mana pun.

Berkas ini menjawab satu hal: sebelum menilai sebuah perubahan, bagaimana cara tahu apa saja yang ikut tersentuh. Enam pertanyaan, masing-masing dengan cara mengeceknya dan kejadian nyata di proyek user yang melahirkannya. Kejadian itu tercatat di `shared/LEARNED.md`; tanggalnya disebut supaya bisa ditelusuri.

Aturan dasarnya: **peta dibuat dari hasil pencarian, bukan dari pemahaman**. "Setahu saya ini cuma dipakai di sini" adalah dugaan sampai ada hasil pencarian yang jumlahnya bisa disebut.

---

## 1. Alurnya

```text
Yang akan diubah (fungsi, kelas, route, view, kolom, key)
        |
        +--> 1. Siapa lagi memakainya?          cari semua pemanggil, sebut jumlahnya
        +--> 2. Ada modul kembaran?             cari modul sejenis, baca caranya
        +--> 3. Komponen bersama mana?          policy, request, middleware, helper, partial
        +--> 4. Kontrak apa yang berubah?       bentuk DAN makna request/response/skema
        +--> 5. Apa kata riwayat?               failed_jobs, log, git log, isu lama
        +--> 6. Test apa yang menjaga?          ada tidaknya, jalur sukses, aktornya
        |
        v
"Yang ikut tersentuh" di panel: 2-6 baris, tiap baris menyebut nama dan jumlah
```

Bila salah satu jawaban membesarkan cakupan (mis. "ternyata dipakai tiga modul"), kembali ke klasifikasi dan naikkan kelasnya.

---

## 2. Enam Pertanyaan

### 2.1 Siapa lagi yang memakai yang akan saya ubah?

**Yang dicari:** semua pemanggil dan pembaca dari hal yang berubah. Bukan hanya pemanggil fungsi, tapi juga pembaca kolom, pemakai nama route, pemakai key response, dan pemakai nama permission.

**Cara mengecek:**

| Yang berubah | Cari |
| :--- | :--- |
| Fungsi atau method | Namanya di seluruh repo, termasuk pemanggilan lewat string (`[Kelas::class, 'method']`, nama route, `call_user_func`) |
| Kelas (Policy, FormRequest, Service, Model) | Nama kelasnya dan `use`-nya; untuk Policy juga `authorize(`, `can(`, `@can` dengan nama ability yang sama |
| Route atau URL | Nama route, path-nya di view dan di JavaScript, dan klien luar (aplikasi HP, sistem lain) |
| View atau partial | Semua `include`/`load->view`/komponen yang memuatnya |
| Kolom tabel | Nama kolom di model, query mentah, view, export, laporan, dan test |
| Key response API | Nama key di klien: frontend, aplikasi HP, dokumentasi Postman |
| Nama permission atau role | Seeder, kamus permission, middleware, policy, view (`@can`), test |

**Sebut jumlahnya.** "Dipakai di 3 controller: A, B, C" bisa dibantah user; "dipakai di beberapa tempat" tidak.

**Kejadian nyata:**
- `OffPolicy::viewAny` dilonggarkan untuk API cuti; portal web memakai policy yang sama dengan query yang tidak dibatasi, sehingga pengajuan se-perusahaan terbuka (altrms, 2026-08).
- Aturan baru di `PresenceReportRequest` membuat 27 test tabel web gagal, karena request yang sama dipakai DataTables yang mengirim `search` dan `order` sebagai array (altrms, 2026-09-22).
- `StoreBookingRequest` dipakai web store, API store, dan API update; klaim "API boleh lintas hari" salah karena aturannya ada di request bersama itu (altrms, 2026-09-22).

### 2.2 Apakah ada modul kembaran?

**Yang dicari:** modul yang bentuknya sama dan sudah memecahkan masalah serupa. Di aplikasi bisnis hampir selalu ada: cuti dan izin, booking dan off, PO detail dan PO online, pengajuan dan persetujuan untuk jenis dokumen lain.

**Cara mengecek:**
- Lihat folder controller, model, dan view yang sejajar dengan modul yang diubah.
- Cari nama method yang sama di controller lain (`approve`, `cancel`, `export`).
- Tanyakan langsung ke kodenya: bagaimana modul itu menangani hal yang sedang diminta?

**Yang dilakukan dengan temuannya:**
- Modul kembaran sudah berperilaku seperti yang diminta → itu opsi utama dan bukti bahwa perilakunya aman di sistem ini.
- Modul kembaran berperilaku lain → tanya user apakah perbedaannya disengaja sebelum menyamakan.
- Dua modul berbeda di satu aspek → pastikan dulu **aspek mana** yang user maksud "samakan".

**Kejadian nyata:**
- Panel tiga opsi untuk tombol aksi booking disusun tanpa melihat modul `off` yang sudah memakai salah satu opsi itu; vonis risikonya salah dan user yang harus bertanya "kalau di fitur off gimana?" (altrms, 2026-09-17).
- "Tabel A beda dengan tabel B, samakan" dikira soal warna dan font, padahal yang dimaksud tabel yang bisa digeser mendatar (manunggal-purchasing, 2026-09-09).

### 2.3 Komponen bersama apa yang tersentuh?

**Yang dicari:** apa pun yang dipakai lebih dari satu jalur, sehingga satu suntingan mengubah banyak perilaku sekaligus.

| Komponen | Kenapa berbahaya | Yang dicek |
| :--- | :--- | :--- |
| Policy, Gate, middleware izin | Melonggarkan satu ability melonggarkan semua pemakainya | Tiap pemakai punya pembatas query sendiri atau tidak |
| FormRequest atau validator bersama | Aturan baru menolak input sah dari jalur lain | Bentuk input tiap jalur (web form, DataTables, API) |
| Helper global | Dipanggil dari tempat yang tidak terduga | Pencarian nama fungsi di seluruh repo |
| Partial view, layout, komponen | Variabel dan skrip bocor antar-halaman | Nama variabel loop vs kunci data controller; tag yang terpotong |
| Config, kamus permission, tabel lookup | Dibaca saat boot atau divalidasi linter | Gerbang yang memvalidasi nama sebelum menyusun urutan kerja |
| Cache dan sesi | Menyimpan hasil lama lintas request atau lintas test | Kunci cache dan kapan dibuang |

**Aturan:** kalau yang diminta bisa dicapai dengan mengubah **titik pemanggilan**, jangan mengubah komponen bersamanya.

**Kejadian nyata:**
- `foreach (... as $unit)` di view menimpa `$unit` milik controller untuk semua baris di bawahnya; dropdown satuan jadi kosong tanpa satu error pun (manunggal-purchasing, 2026-09-04).
- Mencabut nama permission dari kamus sebelum semua pemanggilnya bersih membuat linter merah di commit pertama (altrms, 2026-09-16).
- Atribut `enctype` dipasang di form untuk semua jenis game demi satu jenis; test jenis lain merah (pentahoot, 2026-10-01).

### 2.4 Kontrak apa yang berubah?

**Yang dicari:** janji yang dipegang pihak lain. Bentuk request dan response, nama key **dan maknanya**, status code, skema tabel, format berkas ekspor, nama event, URL.

**Cara mengecek:**
- Bandingkan bentuk sebelum dan sesudah untuk tiap endpoint yang tersentuh, per peran.
- Untuk tiap key yang diganti nama atau digabung: tulis isi dan tujuannya di kontrak lama. Nama sama belum tentu peran sama.
- Cari konsumernya: frontend, aplikasi HP, integrasi pihak ketiga, laporan, dokumentasi API.
- Untuk status code: apakah dua keadaan berbeda sekarang menghasilkan kode yang sama (404 "route belum ada" vs 404 "data tidak ada")?

**Kejadian nyata:**
- Membalik rename key response meleburkan dua key berbeda makna (`meta` berisi token login, `pagination` berisi info halaman) jadi satu; token mendarat di key bernama "pagination" dan test ikut mengunci kekeliruan itu (altrms, 2026-08).
- "Isi otomatis X" diimplementasikan dengan menyimpan data di server saat clone, padahal maksudnya prefill di form; alur data berubah dan gerbang lain ikut lolos (transaction-record-system, 2026-10-01).
- "Clone isi bank default" diperluas diam-diam jadi "PPN dihitung dari bank"; PPN pesanan berubah dari 11% ke 0% (transaction-record-system, 2026-09-30).

### 2.5 Apa kata riwayat nyata?

**Yang dicari:** bukti dari sistem yang berjalan, sebelum menilai kemungkinan dari struktur kode.

| Sumber | Menjawab |
| :--- | :--- |
| Tabel `failed_jobs`, tabel antrian, tabel log | Seberapa sering ini sudah gagal |
| `git log` dan `git blame` berkasnya | Kenapa kodenya begini; perbaikan yang pernah dibalik |
| `LEARNED.md` | Kekeliruan yang sudah pernah terjadi di proyek ini |
| Isu, catatan user, pesan error yang ditempel user | Gejala yang dilihat user akhir |
| `EXPLAIN` atas query yang ada | Apakah query yang disentuh sudah lambat sebelum diubah |

**Batasnya:** database lokal bukan sumber tentang production. Ukuran yang diambil dari lingkungan non-production disebut lingkungannya dan DILARANG dipakai membantah klaim user tentang production.

**Kejadian nyata:**
- Kegagalan `CheckoutJob` disebut "bahaya laten yang belum kejadian"; `SELECT count(*) FROM failed_jobs` menunjukkan 2887 baris sejak 2023, 1876 di antaranya job itu (2026-08-21).
- Premis "cuma terjadi di production" dijelaskan dua giliran sebelum diverifikasi; ternyata staging error yang sama (2026-08-28).

### 2.6 Test apa yang sudah menjaga ini, dan dengan aktor apa?

**Yang dicari:** apakah perilaku yang akan diubah punya test, dan apakah test itu benar-benar membuktikan sesuatu.

| Cek | Kenapa |
| :--- | :--- |
| Ada test yang menembus **jalur sukses**? | Test yang hanya menyentuh penolakan validasi tidak membuktikan endpoint hidup |
| Aktornya role sungguhan? | Test yang login sebagai role ber-bypass tidak membuktikan apa pun soal izin |
| Asersinya mengecek isi, bukan hanya status? | Dua bug generator dokumentasi baru ketahuan dari isi body |
| Test baru nanti bisa merah? | Test yang tidak pernah disaksikan gagal tidak membuktikan apa pun |
| Database test terpisah dari database kerja user? | `RefreshDatabase` ke DB yang salah menghapus data |

**Kejadian nyata:**
- `POST /api/forgotpassword` menjawab 500 untuk semua request sah selama berbulan-bulan; satu-satunya test-nya hijau karena hanya mengirim email salah format (altrms, 2026-08).
- Tiga suite hijau di atas aktor `developer` sementara halaman presensi membocorkan data seluruh karyawan (altrms, 2026-09-16).

---

## 3. Menuliskannya di Panel

```markdown
**Yang ikut tersentuh**
- `OffPolicy::viewAny` dipakai 2 jalur: API cuti dan portal web (tabel daftar cuti).
- Modul `booking` punya aturan serupa dan membatasi di controller, bukan di policy.
- Response `GET /api/offs` dibaca aplikasi HP; key `data` dan `meta` tidak berubah.
- Test yang ada: 4 untuk API (aktor karyawan), 2 untuk web (aktor HRD). Belum ada test "karyawan biasa membuka tabel web".
```

Tiap baris menyebut nama dan jumlah. Yang tidak bisa dicek ditulis apa adanya: "Klien aplikasi HP tidak ada di repo ini; saya belum bisa memastikan key mana yang ia baca."

---

## 4. Anti-Pattern

**Anti-Pattern 1: peta dari ingatan.** "Policy ini cuma dipakai API" tanpa pencarian. Hampir semua kejadian di atas berawal dari kalimat seperti itu.

**Anti-Pattern 2: berhenti di pemanggil langsung.** Fungsi dipanggil service, service dipanggil tiga controller. Telusuri sampai ke titik masuk (route, job, command).

**Anti-Pattern 3: menganggap nama yang sama berarti hal yang sama.** Dua key `meta`, dua method `destroy`, dua kolom `status` di tabel berbeda.

**Anti-Pattern 4: pencarian dengan alat yang buta.** Mencari `as $x` lalu membuang hasilnya sebagai "variabel lokal" justru membuang penyebabnya. Sebelum mempercayai hasil pencarian, uji pencariannya pada kasus yang diketahui ada.

**Anti-Pattern 5: mencocokkan substring.** `db` cocok dengan "TimescaleDB". Pakai pencocokan kata utuh atau path eksak.

---

## 5. Edge Case

**Edge Case 1: pemanggilan lewat string atau konvensi.** Route yang menunjuk method lewat nama, event listener yang didaftarkan di provider, job yang dijadwalkan di kernel, view yang dimuat lewat nama variabel. Pencarian nama fungsi biasa tidak menemukannya; cari juga nama kelas dan nama method sebagai string.

**Edge Case 2: pemakai di luar repo.** Aplikasi HP, sistem lain yang memanggil API, cron di server, skrip user. Tidak terlihat dari repo; tulis sebagai utang bukti dan tanyakan.

**Edge Case 3: berkas hasil merge yang berisi dua implementasi.** Git bisa menggabungkan dua method bernama sama tanpa konflik. Setelah merge, cek method dan route dobel di berkas yang disentuh kedua sisi.

**Edge Case 4: route terdaftar ke method yang tidak ada.** Framework tidak selalu memvalidasinya saat registrasi. Bandingkan daftar route dengan daftar method publik controller-nya.

**Edge Case 5: perubahan lokal user yang belum di-commit.** Berkas yang berbeda dari HEAD belum tentu baru diubah dan belum tentu milik Anda. Cek waktu ubahnya sebelum menyimpulkan apa pun, dan jangan menimpa.

**Edge Case 6: lingkungan berbeda versi.** Server dev berjalan di versi bahasa lain dari yang ada di PATH. Hasil cek di satu versi tidak berlaku untuk yang lain.
