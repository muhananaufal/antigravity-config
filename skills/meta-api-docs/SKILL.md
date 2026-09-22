---
name: meta-api-docs
description: >-
  Dokumentasi API (Postman) yang tidak bisa basi: saved response dari eksekusi
  nyata lewat generator berbasis test, dan deskripsi per endpoint yang
  diverifikasi ke kode. Dipicu saat user meminta dokumentasi / collection
  Postman, "saved response", "example response", "docs endpoint", atau saat
  endpoint API berubah di proyek yang sudah memakai pola ini.
---

# meta-api-docs — Dokumentasi API dari Eksekusi Nyata

> **Prinsip inti:** example dan deskripsi API adalah **klaim tentang perilaku kode**. Klaim ditulis tangan cepat basi dan sering salah sejak awal. Example dihasilkan dengan **menjalankan request sungguhan**; deskripsi ditulis setelah **membaca kode** yang menegakkan aturannya. Keduanya dibuat ulang oleh satu perintah dan gagal keras bila meleset.

Pola ini lahir di proyek altrms (Laravel 9, 64 endpoint, 160 example). Referensi implementasi lengkap: `tests/Postman/PostmanExamplesTest.php` dan `docs/postman/descriptions/` di repo itu. Template umum ada di `references/`.

---

## §0. HUKUM BESI

1. **Tidak ada example yang ditulis tangan.** Setiap example = respons asli dari request yang dijalankan generator. Menyunting body example di JSON collection dilarang.
2. **Status yang meleset menggagalkan generator.** Setiap example mencatat status yang *diharapkan*; bila API menjawab lain, generator berhenti dan mencetak body-nya. Example yang salah lebih buruk daripada tidak ada. Selisih ini sering membongkar dokumentasi lama yang keliru (altrms: README menulis 422 untuk bentrok booking, API menjawab 409).
3. **Deskripsi hanya dari kode yang dibuka sesi ini** (`AGENTS.md` §3). Setiap klaim akses, parameter, aturan, dan status code ditelusuri ke route → controller → FormRequest (`rules()` DAN `withValidator`/`prepareForValidation`) → policy → service → resource. Sebelum menyatakan "web dan API berbeda", telusuri kedua jalur sampai kelas bersamanya.
4. **Aktor = role nyata.** Dilarang memakai akun yang melewati semua policy (mis. `Gate::before` untuk role developer/superuser) sebagai aktor example: hasilnya tidak mewakili role mana pun. Bila aturan berbeda per role, buat **pasangan** example sukses per role.
5. **Periksa isi body, bukan hanya status code.** Setelah generator lulus pertama kali, buka beberapa body dan pastikan isinya membuktikan aturan yang diklaim label example-nya (altrms: dua bug generator lolos status code, baru ketahuan dari body).
6. **Generator tidak boleh bisa menyentuh database nyata.** Ia menolak jalan kecuali koneksinya database test yang terisolasi (mis. SQLite `:memory:`), karena seeder + `RefreshDatabase` mengosongkan database apa pun yang dikonfigurasi.

---

## §1. Kapan dipakai

| Situasi | Tindakan |
| :--- | :--- |
| User minta collection / saved response / dokumentasi endpoint | Bangun generator (§2), deskripsi (§3), gerbang proyek (§5) |
| Proyek sudah punya generator ini dan endpoint berubah | Ubah skenario + deskripsi yang terdampak, jalankan generator, commit collection (§4) |
| User bertanya perilaku API | Jawab dari kode (§0.3); bila dokumentasinya ternyata keliru, perbaiki berkas deskripsinya |

Skill ini dokumentasi, bukan perubahan perilaku. Temuan perilaku yang janggal (aturan yang bolong, beda web/API) **dilaporkan**, tidak diperbaiki diam-diam; perbaikannya butuh persetujuan (`AGENTS.md` §0.2).

---

## §2. Generator saved response

Satu kelas test **di luar testsuite biasa** (mis. `tests/Postman/`), dijalankan manual. Template: `references/generator-template.php`.

**Kerangka wajib:**

1. **Penjaga database** di `setUp()`: skip bila koneksi bukan database test terisolasi.
2. **Waktu dibekukan** (`Carbon::setTestNow`) pada hari kerja, jam sebelum aturan jam mana pun berlaku; majukan waktu secara eksplisit bila skenario butuh (mis. check-out).
3. **Fake semua jalan keluar**: `Http::fake()` (API eksternal: routing jarak, push), `Mail::fake()`, `Storage::fake()`, queue bila ada.
4. **Seeder bawaan proyek** untuk data yang kaya; pastikan datanya fiktif. Data yang tidak disediakan seeder dibuat di generator (mis. notifikasi, booking confirmed milik orang lain agar penyamaran terlihat).
5. **Aktor**: karyawan = role bawaan seeder; admin = role nyata (HRD/super admin) dengan izin yang diperlukan (`syncPermissions(Permission::all())` bila role itu memang memegang semua izin).
6. **Skenario berurutan per grup**, id hasil request disimpan (`$this->ids[...]`) untuk request berikutnya. Susun supaya status data mendukung example: buat → baca → ubah → putuskan → coba ubah lagi (422) → batal/hapus.
7. **`record(nama, label, statusDiharapkan, respons, bodyDikirim?, uri?)`**: cocokkan status, simpan body (JSON dirapikan) + header penting. `bodyDikirim` dan `uri` diisi bila berbeda dari request di collection, supaya *original request* example cocok dengan yang benar-benar dikirim (query string, body error).
8. **Sanitasi**: token, secret, token perangkat → placeholder. Jangan pernah ada hash password.
9. **Tulis ke collection**: untuk setiap request (dicocokkan lewat **nama**), ganti `response` dengan example terekam dan `description` dengan isi berkas deskripsi (§3). Bagian lain collection tidak disentuh. Gagal bila ada request tanpa example atau tanpa deskripsi.

**Jebakan yang sudah memakan korban:**

| Jebakan | Gejala | Penangkal |
| :--- | :--- | :--- |
| Login (`Auth::attempt`) mengisi session guard web, terbawa ke request berikut dalam satu proses test | Logout / request "tanpa token" berperilaku seperti login lewat session (`TransientToken::delete()`) | Kosongkan session store + `forgetGuards()` setiap ganti aktor |
| Singleton yang menyimpan request (mis. yajra `datatables.request`) | Request kedua dalam satu test membaca parameter request pertama | `forgetInstance()` sebelum tiap request |
| `$a + $b` pada array PHP tidak menimpa kunci yang sudah ada | Field override (mis. `user_pemakai_id`) diam-diam tetap `null` | `array_merge` |
| Multipart dengan `PUT` | File/field tidak terbaca | Kirim `POST` + `_method=PUT`, sama seperti klien sungguhan |
| Endpoint unduhan (XLSX/PDF) | Body biner merusak collection | Simpan status + `Content-Type` + `Content-Disposition`, body kosong |
| Skrip suntingan dengan regex | `preg_replace` gagal → `null` → berkas tertulis kosong, lint/test "lulus" karena tak ada isinya | Suntingan lewat `str_replace` dengan jumlah kemunculan dicek; `php -l`/`wc -l` setelah menulis |
| Throttle rute (`throttle:api`) dengan waktu dibekukan | Makin banyak example, request ke-N dijawab 429 "Too Many Attempts" dan status meleset | Kosongkan penghitungnya saat ganti aktor (store cache `array` milik test), jangan menaikkan limit produksi |
| Endpoint daftar dengan filter | Example hanya "200 OK" polos, filter tidak terdokumentasi dan tak pernah dibuktikan | Minimal satu example 200 dengan filter gabungan + satu 422 nilai tidak dikenal; buka body-nya (§0.5) |

---

## §3. Deskripsi per endpoint

Satu berkas markdown per request: `docs/postman/descriptions/{nn-grup}/{slug nama request}.md` (slug = huruf kecil, selain huruf/angka jadi `-`). Template: `references/description-template.md`.

**Isi wajib, urutan tetap:**

1. Satu kalimat: apa yang dilakukan endpoint, untuk siapa.
2. **Tabel akses**: autentikasi, izin, kepemilikan / cakupan (siapa melihat apa), throttle, content-type.
3. **Tabel parameter**: path/query/body, tipe, wajib, aturan (dari FormRequest, termasuk validasi kustom).
4. **Aturan bisnis bernomor**: setiap cabang di service dan policy yang mengubah hasil - status yang boleh, kuota, bentrok, kunci konkurensi (429), 409 untuk keputusan yang bertabrakan, efek samping (notifikasi, saldo, file dihapus), dan field yang **diabaikan** (mis. `user_id` yang hanya dihormati di web).
5. **Tabel respons**: setiap status code yang mungkin dan kapan terjadi, termasuk 401 untuk token/akun nonaktif.

**Cara menulisnya:** baca kode per modul (controller + request + policy + service + repository + resource), tulis semua berkas modul itu, lalu verifikasi ulang klaim yang meragukan dengan `grep` sebelum lanjut modul berikutnya. Klaim yang tidak bisa diverifikasi dihapus, bukan diperhalus.

---

## §4. Memperbarui saat endpoint berubah

1. Ubah kode + test perilakunya seperti biasa.
2. Tambah/ubah skenario generator: sukses, error utama, pasangan per role bila relevan.
3. Perbarui berkas deskripsi yang terdampak (dan README peta endpoint / aturan bisnis bila ada).
4. Jalankan generator; baca body example baru (§0.5).
5. Commit kode, generator, deskripsi, dan collection dalam batch yang sama.

---

## §5. Gerbang di proyek

Tambahkan ke `AGENTS.md` / `CLAUDE.md` proyek supaya agent berikutnya ikut menjaga sinkronnya (contoh nyata: altrms `AGENTS.md` gerbang 3 "API Contract Sync Gate"):

- Pemicunya: perubahan route API, controller API, FormRequest yang dipakai API (termasuk yang dipakai bersama web), resource, policy, atau aturan service yang mengubah respons / status code.
- Kewajibannya: deskripsi diverifikasi ke kode, skenario generator diperbarui, generator dijalankan, collection di-commit; dilarang menyunting example/deskripsi langsung di JSON.
- Catat perintah generator dan penjaga database-nya di README dokumentasi API.

---

## §6. Checklist selesai

- [ ] Generator lulus; setiap request punya ≥1 example dan satu berkas deskripsi.
- [ ] Tidak ada token/secret/hash di collection (`grep`).
- [ ] Beberapa body example dibuka dan isinya cocok dengan labelnya (termasuk pasangan per role).
- [ ] Bagian collection selain `response`/`description` tidak berubah (bandingkan JSON sebelum-sesudah).
- [ ] Test suite + linter proyek dijalankan dan dilaporkan apa adanya (`AGENTS.md` §5.7).
- [ ] Temuan perilaku janggal dilaporkan ke user sebagai daftar terpisah, tidak diperbaiki diam-diam.
