# Bentuk Daftar Periksa dan Berkas Hasil Swipe

Pendamping `SKILL.md` skill `meta-swipe`. Dibuka saat pertama menulis `checklist.json` di sebuah proyek, saat `validate` menolak sebuah berkas, atau saat menambah pemeriksaan untuk fitur baru.

Dua jenis berkas, dua umur yang berbeda:

| Berkas | Lokasi | Umur | Diubah kapan |
| :--- | :--- | :--- | :--- |
| Daftar periksa | `<proyek>/.swipe/checklist.json` | Hidup selama proyek | Saat fitur bertambah, langkah berubah, atau peran baru muncul |
| Hasil satu swipe | `<proyek>/.swipe/runs/<YYYY-MM-DD>-<cakupan>.json` | Satu berkas per swipe, tidak diubah lagi | Hanya untuk memperbaiki salah catat di hari yang sama |

Laporan HTML bukan sumber data. Ia dibangun dari dua berkas ini dan boleh dibuat ulang kapan saja.

`.swipe/` ikut di-commit ke repo proyek: daftar periksa hanya berguna bila ikut berpindah bersama kode yang diperiksanya. Bila proyek tidak menginginkannya di git, itu keputusan user; jangan menambah baris `.gitignore` tanpa diminta.

---

## 1. Daftar Periksa

```json
{
  "version": 1,
  "project": "hris",
  "roles": [
    { "id": "hrd", "label": "HRD", "baseUrl": "http://hrd.localhost" },
    { "id": "karyawan", "label": "Karyawan", "baseUrl": "http://karyawan.localhost" }
  ],
  "features": [
    { "id": "reimbursement", "label": "Reimbursement", "related": ["field-duty"], "foundIn": ["routes/web.php", "app/Policies/Operational/ReimbursePolicy.php"] },
    { "id": "field-duty", "label": "Field Duty", "related": [], "foundIn": ["routes/web.php"] }
  ],
  "checks": [
    {
      "id": "reimbursement-karyawan-ajukan",
      "feature": "reimbursement",
      "role": "karyawan",
      "title": "Mengajukan klaim dari Field Duty",
      "steps": ["Buka menu Reimbursement, klik Tambah", "Pilih Field Duty yang sudah divalidasi", "Isi rute dan unggah satu foto struk", "Klik Simpan"],
      "expect": "Kembali ke daftar; klaim baru berstatus Pending dan muncul di baris teratas",
      "kind": "write"
    }
  ]
}
```

### 1.1 Kolom tingkat atas

| Kolom | Aturan |
| :--- | :--- |
| `version` | Selalu `1`. |
| `project` | Nama proyek, huruf kecil dan tanda hubung. Dipakai di nama berkas laporan. |
| `roles` | Minimal satu. |
| `features` | Minimal satu. |
| `checks` | Minimal satu. |

### 1.2 `roles`

| Kolom | Aturan |
| :--- | :--- |
| `id` | Huruf kecil dan tanda hubung, unik. |
| `label` | Nama peran seperti yang dipakai user ("HRD", "Founder"). |
| `baseUrl` | Alamat yang **disebut user** untuk peran ini, `http` atau `https`, tanpa nama pengguna atau password di dalamnya. |
| `nonLocalConfirmed` | Hanya untuk alamat yang bukan lokal. Diisi `true` setelah user menegaskan alamat persis itu di percakapan. |

Yang dianggap lokal: `localhost`, `*.localhost`, `*.test`, `*.local`, `127.x.x.x`, `10.x.x.x`, `192.168.x.x`, `172.16` sampai `172.31`. Selain itu `validate` menolak sampai `nonLocalConfirmed` diisi.

Peran tidak punya kolom akun. Siapa yang login adalah urusan user di browser.

### 1.3 `features`

| Kolom | Aturan |
| :--- | :--- |
| `id` | Huruf kecil dan tanda hubung, unik. |
| `label` | Nama fitur seperti di menu aplikasi. |
| `related` | Daftar `id` fitur lain yang ikut dicoba saat fitur ini diminta. Harus ada di `features`. |
| `foundIn` | Berkas tempat fitur dan keterkaitannya ditemukan (route, policy, view menu). Supaya orang berikutnya bisa memeriksa ulang dari mana daftar ini datang. |

Keterkaitan satu arah. Kalau Reimbursement menyeret Field Duty tetapi tidak sebaliknya, cukup tulis di Reimbursement.

### 1.4 `checks`

| Kolom | Aturan |
| :--- | :--- |
| `id` | Huruf kecil dan tanda hubung, unik. Pola yang disarankan: `<fitur>-<peran>-<apa>`. **Jangan diganti setelah dipakai**: `diff` mencocokkan dua swipe lewat `id` ini. |
| `feature`, `role` | Harus ada di `features` dan `roles`. Satu pemeriksaan, satu peran. |
| `title` | Apa yang dicoba, dari sudut pengguna. |
| `steps` | Minimal satu langkah. Tiap langkah cukup rinci untuk diikuti orang yang belum pernah membuka aplikasinya: sebut menu, tombol, dan isian. |
| `expect` | Satu hal yang bisa diamati di layar. "Berhasil" bukan harapan; "klaim baru berstatus Pending di baris teratas" adalah harapan. |
| `kind` | `read`, `write`, atau `irreversible`. |

Memilih `kind`:

| `kind` | Untuk | Contoh |
| :--- | :--- | :--- |
| `read` | Membuka, mencari, menyaring, mengunduh | Membuka daftar, membuka detail, ekspor ke berkas |
| `write` | Mengubah data dengan cara yang bisa dibalik dari aplikasi | Membuat draf, mengubah isian, mengajukan yang masih bisa dibatalkan |
| `irreversible` | Semua yang tidak bisa dibalik dari aplikasi, atau yang keluar dari aplikasi | Hapus, kirim email atau WhatsApp, setujui yang memicu pembayaran, impor massal, tutup periode |

Ragu antara `write` dan `irreversible`: pilih `irreversible`. Salah ke arah itu hanya menambah satu pertanyaan ke user.

---

## 2. Berkas Hasil

```json
{
  "version": 1,
  "project": "hris",
  "date": "2026-11-10",
  "scope": "reimbursement",
  "basis": "staging 797a07f3, 2 berkas belum di-commit",
  "browser": "Chrome lewat ekstensi Claude in Chrome, jendela 1920x957",
  "results": [
    { "check": "reimbursement-karyawan-ajukan", "status": "pass", "observed": "Kembali ke daftar, klaim #41 berstatus Pending di baris teratas" },
    {
      "check": "reimbursement-karyawan-ajukan-tanpa-rute",
      "status": "fail",
      "observed": "Halaman putih bertuliskan Server Error; isian yang sudah diketik hilang",
      "console": ["Uncaught TypeError: routes is undefined"],
      "network": [{ "method": "POST", "url": "/reimburse/store", "status": 500 }]
    },
    { "check": "reimbursement-hrd-hapus", "status": "skipped", "reason": "Tidak bisa dibalik; user memilih tidak dijalankan" }
  ],
  "created": [
    { "role": "karyawan", "what": "Klaim #41, Field Duty 3 November, 1 foto", "where": "/reimburse/41" }
  ],
  "notes": ["Database lokal sudah berisi 3 klaim dari swipe 1 November."]
}
```

| Kolom | Aturan |
| :--- | :--- |
| `project` | Sama dengan daftar periksa. |
| `date` | `YYYY-MM-DD`, tanggal swipe dijalankan. |
| `scope` | Huruf kecil dan tanda hubung; masuk ke nama berkas laporan. `semua` untuk swipe penuh. |
| `basis` | Apa yang sedang berjalan: branch, commit, dan apakah ada perubahan yang belum di-commit. Tanpa ini perbandingan dua swipe tidak bisa ditafsirkan. |
| `browser` | Browser, alat pengendalinya, dan ukuran jendela. |
| `results` | Satu entri per pemeriksaan yang masuk cakupan swipe ini. Pemeriksaan di luar cakupan tidak ditulis; laporan mendaftarnya sendiri sebagai "di luar cakupan". |
| `created` | Semua data yang dibuat: sebagai siapa, apa, di mana. Kosong berarti tidak ada. |
| `notes` | Keadaan yang memengaruhi cara membaca hasil: data awal, hal yang tidak bisa dicoba. |

### 2.1 Entri `results`

| Kolom | Wajib untuk | Aturan |
| :--- | :--- | :--- |
| `check` | Semua | `id` dari daftar periksa. Satu entri per pemeriksaan. |
| `status` | Semua | `pass`, `fail`, `blocked`, `skipped`. |
| `observed` | `pass`, `fail` | Apa yang tampil di layar, apa adanya. |
| `reason` | `blocked`, `skipped` | Kenapa tidak dijalankan. |
| `confirmed` | `pass` atau `fail` pada pemeriksaan `irreversible` | `true`, hanya setelah user menjawab ya untuk aksi itu. |
| `console` | Opsional | Daftar teks error atau peringatan console selama pemeriksaan. |
| `network` | Opsional | Daftar `{ "method", "url", "status" }` untuk permintaan yang gagal atau relevan. `url` cukup path-nya. |

---

## 3. Yang Ditolak `validate`

| Pesan | Sebab | Perbaikan |
| :--- | :--- | :--- |
| `must not store credentials (key "...")` | Ada kolom bernama password, token, secret, cookie, authorization, api key | Hapus kolomnya. Akun tidak dicatat di berkas swipe. |
| `credentials inside a URL` | `http://user:pass@host` | Tulis alamatnya tanpa akun. |
| `credential in a query string` | URL dengan `?token=...` atau sejenisnya di `network` atau `where` | Tulis path-nya saja, tanpa query. |
| `is not a local address` | `baseUrl` bukan lokal dan belum ditegaskan | Tanya user; bila ia menegaskan, isi `nonLocalConfirmed`. |
| `unknown role` / `unknown feature` / `unknown check` | Rujukan ke `id` yang tidak ada | Tambah dulu di daftar periksa, atau betulkan salah ketik. |
| `duplicate check id` | Dua pemeriksaan ber-`id` sama | Beri `id` yang berbeda. |
| `needs "observed"` / `needs "reason"` | Hasil tanpa keterangan | Tulis apa yang tampil, atau kenapa tidak dijalankan. |
| `the check is irreversible` | Pemeriksaan `irreversible` dicatat dijalankan tanpa `confirmed` | Kalau user memang mengiyakan, isi `confirmed: true`. Kalau tidak, statusnya `skipped`. |
| `no roles` / `no features` / `no checks` | Kerangka hasil `init` belum diisi | Isi dulu. Kerangka kosong sengaja tidak dianggap sah. |

`validate` keluar dengan kode 1 bila ada berkas yang bermasalah dan 2 bila perintahnya salah atau berkasnya tidak terbaca.

---

## 4. Membaca `diff`

`diff` mencocokkan dua berkas hasil lewat `id` pemeriksaan.

| Kelompok | Artinya | Yang dilakukan |
| :--- | :--- | :--- |
| `regressed` | Dulu `pass`, sekarang `fail` atau `blocked` | Laporkan paling atas. Ini jawaban atas "habis ubah fitur A, ada yang berubah". |
| `newErrors` | Masih `pass`, tetapi ada error console atau jaringan yang dulu tidak ada | Laporkan; sering jadi tanda awal kerusakan. |
| `fixed` | Dulu rusak, sekarang `pass` | Laporkan singkat. |
| `stillFailing` | Rusak di kedua swipe | Sebut bahwa belum berubah. |
| `added` | Pemeriksaan baru | Tidak punya pembanding. |
| `notRerun` | Ada di swipe lama, tidak dijalankan sekarang | Sebut, supaya tidak dikira masih baik. |

Dua swipe hanya setara bila langkah pemeriksaannya sama. Bila langkah sebuah pemeriksaan diubah di antara dua swipe, sebut itu di `notes`; perubahan statusnya bisa berasal dari langkah, bukan dari aplikasi.

---

## 5. Anti-Pattern

**Anti-Pattern 1: mengganti `id` pemeriksaan.** Merapikan nama memutus riwayat: `diff` melihatnya sebagai satu pemeriksaan hilang dan satu baru.

**Anti-Pattern 2: satu pemeriksaan untuk dua peran.** "HRD dan karyawan bisa membuka daftar" tidak bisa dicatat rusak untuk satu dan jalan untuk yang lain. Pecah.

**Anti-Pattern 3: harapan yang tidak bisa diamati.** "Data tersimpan dengan benar" butuh membuka database. Tulis apa yang tampil di layar sesudahnya.

**Anti-Pattern 4: `observed` berisi kesimpulan.** "Validasi belum ada" adalah tafsiran. "Halaman putih bertuliskan Server Error" adalah yang terlihat; tafsirannya ditulis di laporan ke user.

**Anti-Pattern 5: mengubah berkas hasil lama.** Berkas hasil adalah catatan hari itu. Swipe baru, berkas baru.

---

## 6. Edge Case

**Edge Case 1: dua swipe di hari yang sama dengan cakupan sama.** Bedakan lewat cakupan (`reimbursement-pagi`, `reimbursement-setelah-fix`), bukan dengan menimpa.

**Edge Case 2: fitur dihapus dari aplikasi.** Pemeriksaannya dihapus dari daftar periksa di commit yang sama dengan penghapusan fiturnya, dan disebut di laporan swipe berikutnya.

**Edge Case 3: peran baru.** Tambah di `roles`, lalu tambah pemeriksaan per fitur untuk peran itu; pemeriksaan peran lain tidak disalin begitu saja, karena izinnya berbeda.

**Edge Case 4: langkah bergantung pada data hasil pemeriksaan lain.** Tulis ketergantungannya di langkah pertama ("Setelah `reimbursement-karyawan-ajukan` jalan, ...") supaya urutannya terbaca.

**Edge Case 5: berkas disunting tangan dan rusak.** `validate` menyebut baris JSON yang salah. Jangan membuat ulang dari ingatan; perbaiki berkasnya.

**Edge Case 6: proyek tanpa pembagian alamat per peran.** Semua peran ber-`baseUrl` sama. Itu sah; urutkan swipe per peran karena sesinya satu.

---

## 7. Sumber

- `scripts/swipe-tools.mjs` dan `scripts/swipe-tools.test.mjs` di skill ini: aturan di atas adalah yang ditegakkan kode itu, diuji dengan 48 kasus pada 10 November 2026.
- Uji coba swipe pada aplikasi contoh lokal, 10 November 2026: contoh `observed`, `console`, dan `network` di berkas ini mengikuti bentuk yang benar-benar terbaca dari alat browser.
- Keputusan user 10 November 2026: daftar periksa disimpan di repo proyek, sebagai berkas data terpisah dari laporan, dan data buatan swipe tidak dibersihkan otomatis.
