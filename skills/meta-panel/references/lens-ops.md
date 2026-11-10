# Lensa 5 — Ops / SRE (setara senior SRE yang memegang on-call)

Pendamping `SKILL.md` skill `meta-panel`. Dibuka saat request menyentuh deploy, migrasi, job, antrian, integrasi pihak ketiga, cron, config, cache, atau apa pun yang berjalan tanpa ditonton orang.

Lensa ini menjawab tiga pertanyaan: **bagaimana ini mati, siapa yang tahu duluan, dan bagaimana mundurnya.** Orang yang memegang on-call tidak bertanya apakah fiturnya bekerja; ia bertanya apa yang membangunkannya jam tiga pagi dan apa yang bisa ia lakukan saat itu.

---

## 1. Cara Berpikirnya

| Pertanyaan pemula | Pertanyaan senior |
| :--- | :--- |
| "Sudah di-deploy?" | "Kalau rilis ini buruk, berapa menit sampai kita tahu, dan dari sinyal apa?" |
| "Ada error handling?" | "Saat layanan pihak ketiga lambat (bukan mati), berapa request yang ikut menggantung?" |
| "Job-nya jalan?" | "Kalau proses mati di tengah job, job itu hilang, terulang, atau setengah jadi?" |
| "Bisa di-rollback?" | "Setelah migrasi ini jalan, kode lama masih bisa hidup atau tidak?" |
| "Sudah dites?" | "Dites lewat jalur yang sama dengan production, atau lewat jalan pintas?" |

```text
Perubahan
   |
   +-- cara mati        lambat, penuh, putus, setengah jadi, terulang
   +-- cara ketahuan    log, metrik, alert, keluhan user (yang terakhir = terlambat)
   +-- cara mundur      matikan fitur, kembali ke versi lama, pulihkan data
   +-- cara menyebar    siapa di hulu dan hilir yang ikut kena
```

---

## 2. Katalog Kasus Tepi

### 2.1 Ketergantungan keluar (database, cache, API pihak ketiga, layanan lain)

| Cek | Skenario yang dicari |
| :--- | :--- |
| Timeout | Tiap panggilan keluar punya batas waktu. Yang dicari bukan "mati" tapi **lambat**: tanpa timeout, satu layanan lambat menahan semua worker. |
| Timeout yang ternyata tidak berlaku | Deadline lewat context atau opsi yang diam-diam diabaikan klien kecuali sebuah saklar dinyalakan. Baca source klien sebelum mengandalkannya. |
| Retry | Hanya untuk operasi yang aman diulang, dengan jeda yang membesar dan acak, dan dibatasi. Retry di setiap lapis mengalikan beban. |
| Efek samping di jalur utama | Kirim notifikasi atau publish event secara sinkron di tengah request; saat tujuannya menolak koneksi, request utama ikut tertahan. |
| Jawaban kosong yang tampak sah | Cache yang belum terisi atau lookup turunan yang tertinggal memberi "tidak ada" yang dibaca sebagai jawaban benar. |
| Endpoint pihak ketiga yang belum pernah dipanggil | Path atau nilai yang salah sejak ditulis, aman hanya karena belum ada pemanggil. Satu panggilan ke sandbox membedakannya. |
| Batas pihak ketiga | Kuota, rate limit, dan cara kita menghindari membanjiri mereka saat retry. |

### 2.2 Job, antrian, cron

| Cek | Skenario yang dicari |
| :--- | :--- |
| Ketahanan | Pekerjaan yang tidak boleh hilang dijalankan lewat antrian yang tersimpan, bukan goroutine atau proses lepas. |
| Terulang | Job dijalankan dua kali (retry, dua worker, deploy di tengah). Hasilnya dobel atau aman? |
| Setengah jadi | Job mati setelah langkah kedua dari lima. Bisa dilanjutkan, diulang dari awal, atau meninggalkan data rusak? |
| Menumpuk | Job masuk lebih cepat dari yang diproses. Ada batas antrian dan siapa yang tahu saat menumpuk? |
| Gagal diam-diam | Job gagal masuk tabel kegagalan dan tidak ada yang melihatnya. Cek isi tabel itu sekarang. |
| Jadwal | Cron tumpang-tindih dengan run sebelumnya; jadwal di zona waktu server; dua server menjalankan cron yang sama. |
| Hook dan proses anak | Hook yang memanggil proses lain bisa menggantung menunggu prompt; proses anak tetap hidup setelah induknya dihentikan. |

### 2.3 Deploy dan mundur

| Cek | Skenario yang dicari |
| :--- | :--- |
| Urutan | Kode baru dan skema baru tidak selalu aktif bersamaan. Kode lama harus hidup dengan skema baru selama pergantian, atau sebaliknya. |
| Mundur | Setelah migrasi, apakah versi lama masih bisa jalan? Migrasi yang menghapus kolom tidak bisa dibalik tanpa backup. |
| Rollback sementara vs perbaikan permanen | Dua-duanya dalam satu commit berarti membatalkan yang satu ikut mencabut yang lain. |
| Config dan env | Variabel baru yang belum ada di server; nilai bawaan yang tertutup `.env` lokal; cache config yang perlu dibuang. |
| Restart | Perubahan config, hook, atau daemon yang baru berlaku setelah proses di-restart. Bandingkan waktu mulai proses dengan waktu ubah berkas. |
| Pemeriksaan kesehatan | Probe yang lolos karena kebetulan waktu (server sementara di socket) lalu merah di lingkungan lain. |
| Cabang dan merge | Bekerja di cabang yang salah karena user pindah checkout; berkas hasil merge otomatis berisi dua implementasi. |

### 2.4 Pengamatan

| Cek | Skenario yang dicari |
| :--- | :--- |
| Sinyal pertama | Dari mana kita tahu ini rusak sebelum user mengeluh: log, metrik, atau tabel kegagalan? |
| Log yang berguna | Tiap baris punya id request atau id job; pesan error menyebut apa yang dicoba dan dengan data apa. |
| Format log yang dibaca pihak lain | Mengubah nama field log membutakan dashboard atau skrip yang membacanya. |
| Alert yang bisa ditindak | Alert tanpa langkah berikutnya hanya kebisingan. Rasio yang dihitung dari jendela kosong bisa meracuni alert. |
| Output yang hilang | Perintah di lingkungan tertentu mengembalikan exit 0 dengan output kosong. Jangan menyimpulkan "tidak ada apa-apa" dari kosong. |

### 2.5 Beban dan batas

| Cek | Skenario yang dicari |
| :--- | :--- |
| Yang tumbuh tanpa batas | Tabel log, berkas upload, antrian, cache tanpa TTL, direktori sementara. |
| Pekerjaan berat di request | Export, PDF, impor besar dikerjakan saat user menunggu; timeout web server memutusnya. |
| Lonjakan | Semua user membuka laporan di awal bulan; semua job terjadwal di menit yang sama. |
| Sumber daya bersama | Suite test atau proses berat yang menghabiskan memori mesin dan me-restart layanan user. |
| Memperlambat dengan rapi | Saat kelebihan beban, menolak sebagian permintaan dengan jelas lebih baik daripada melambat untuk semua. |

### 2.6 Lingkungan

| Cek | Skenario yang dicari |
| :--- | :--- |
| Port dan server | Port yang sudah dipakai proses lain; request dijawab server yang salah. Verifikasi identitas server sebelum menyimpulkan. |
| Versi | Bahasa atau alat di PATH berbeda dari yang dipakai server atau CI. |
| Database | Database lokal bukan production; database test bukan database kerja. Sebut lingkungannya di tiap pengukuran. |
| Penyimpanan bersama | Probe ke database lain masih memakai cache berkas yang sama dan mengotori aplikasi yang hidup. |
| Operasi yang merusak | Reset, sync dengan input kosong, atau restore tanpa penjaga jumlah menghapus semuanya tanpa error. |

---

## 3. Daftar Peluncuran Ringkas

Untuk fitur baru atau perubahan besar, sisir sepuluh kelompok daftar peluncuran Google SRE dan jawab yang relevan dengan satu kalimat masing-masing:

1. Arsitektur: sketsa komponen dan jenis permintaan.
2. Mesin dan pusat data: di mana ini berjalan, cadangannya apa.
3. Volume, kapasitas, performa: perkiraan lalu lintas, lonjakan saat rilis, uji beban.
4. Keandalan dan failover: apa yang terjadi saat satu komponen mati; cara mendeteksi dan menangani backend yang mati; timeout, retry, dan batas laju.
5. Pemantauan: keadaan dalam, perilaku ujung ke ujung, alert.
6. Keamanan: tinjauan desain, autentikasi.
7. Otomasi dan tugas manual: cara memperbarui server, data, dan config; proses rilis, canary, rilis bertahap.
8. Pertumbuhan: kapasitas cadangan, titik sempit.
9. Ketergantungan luar: sistem pihak ketiga, degradasi yang rapi, cara tidak membanjiri mereka.
10. Jadwal dan rilis: tenggat keras, hari yang dihindari.

Untuk aplikasi satu server, sebagian besar kelompok ini dijawab "tidak relevan karena ...". Menuliskan alasannya tetap berguna: itulah yang berubah saat aplikasinya tumbuh.

---

## 4. Contoh Temuan

**Ditolak:**
> Ops: perhatikan monitoring dan rollback. Pastikan ada error handling.

**Layak dikirim:**
> Kirim WhatsApp ke atasan dipanggil langsung di `ReimburseService::submit`, di dalam request simpan. Kalau gateway WA lambat, karyawan menunggu sampai timeout dan mengira pengajuannya gagal, padahal sudah tersimpan, lalu mengirim ulang (pemanggilannya sudah saya baca; klien HTTP-nya tidak diberi timeout). Usul: simpan dulu, kirim notifikasi lewat antrian yang sudah ada di proyek ini. Mundurnya mudah: job-nya dimatikan, pengajuan tetap jalan.

**Ditolak (menilai frekuensi dari kode):**
> Job ini berisiko gagal suatu saat.

Tanyakan dulu ke tabel kegagalan: berapa baris, sejak kapan, job apa.

---

## 5. Anti-Pattern

**Anti-Pattern 1: "kalau gagal tinggal coba lagi".** Tanpa memeriksa apakah operasinya aman diulang dan apakah retry-nya dibatasi.

**Anti-Pattern 2: menginvestigasi infrastruktur user.** Gangguan lingkungan di tengah task (database lokal putus, container restart) dilaporkan satu kalimat lalu ditunggu atau ditanyakan sekali. Infra user bukan cakupan task.

**Anti-Pattern 3: melonggarkan pemeriksaan supaya hijau.** Menghapus atau melemahkan check sebelum membuktikan gagalnya. Buktikan dulu, perbaiki penyebabnya.

**Anti-Pattern 4: menilai lewat pipa.** `perintah | tail` menelan exit code perintah kirinya. Gerbang dijalankan tanpa pipa, atau exit code-nya ditangkap dulu.

**Anti-Pattern 5: merangkai langkah berbahaya dengan `;`.** Commit atau push tetap jalan walau test sebelumnya gagal. Baca hasilnya dulu, baru langkah berikut.

---

## 6. Edge Case

**Edge Case 1: tidak ada pemantauan sama sekali.** Banyak proyek kecil hanya punya log berkas. Panel menyebut sinyal paling murah yang bisa ditambah (satu baris log terstruktur, satu hitungan di tabel), bukan menuntut tumpukan observability.

**Edge Case 2: deploy manual.** Tanpa CI/CD, urutan langkah deploy adalah bagian dari perubahan. Tulis urutannya dan langkah mundurnya.

**Edge Case 3: jalur production berbeda dari jalur test.** Koneksi lewat pooler, proxy, atau antrian yang tidak ada di test. Uji lewat jalur yang sama, atau sebut bahwa belum.

**Edge Case 4: skrip yang sedang berjalan.** Menyunting skrip shell yang sedang dieksekusi membuatnya menjalankan baris yang bergeser. Hentikan dulu atau sunting salinannya.

**Edge Case 5: menghentikan proses.** Hentikan hanya proses yang PID-nya Anda catat sendiri. Filter lewat nama bisa ikut membunuh proses user.

**Edge Case 6: operasi yang tidak bisa dibalik.** Hapus data, kirim keluar, migrasi yang membuang kolom. Panel menandainya menghalangi sampai ada cadangan atau persetujuan eksplisit.

---

## 7. Sumber

- Google SRE Book, dibuka 2026-11-10: bab 21 Handling Overload, bab 22 Addressing Cascading Failures, bab 12 Effective Troubleshooting, bab 15 Postmortem Culture, lampiran Launch Coordination Checklist.
- SRE Workbook bab 16 Canarying Releases dan bab 5 Alerting on SLOs, dibuka 2026-11-10.
- AWS Builders' Library, "Timeouts, retries, and backoff with jitter" (2019), dibuka 2026-11-10.
- Kejadian di proyek user dari `shared/LEARNED.md`: deadline go-redis yang diabaikan, PUBLISH sinkron yang menahan pemanggil, `failed_jobs` 2887 baris, endpoint refund yang tidak pernah dipanggil, hook commit yang menggantung, pipa yang menelan exit code, restart WSL saat race test, port ganda di Windows.
