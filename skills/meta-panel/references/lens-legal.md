# Lensa 9 — Legal dan Kepatuhan (bersyarat)

Pendamping `SKILL.md` skill `meta-panel`. Lensa ini **hanya menyala bila pemicunya ada**: data pribadi, uang atau pajak, konten dan kode milik pihak lain, peluncuran ke pengguna di luar organisasi, atau kontrak dengan klien. Untuk permintaan lain, satu baris "tidak ada pemicunya" sudah cukup.

Lensa ini menjawab: **adakah kewajiban di luar kode yang ikut tersentuh, dan siapa yang harus ditanya.**

**Batas lensa ini, dibaca dulu:**

1. **Agen bukan penasihat hukum.** Lensa ini menemukan pertanyaan yang perlu dijawab orang yang berwenang; ia tidak memutuskan apa yang sah.
2. **Isi pasal, tarif, dan tenggat DILARANG ditulis dari ingatan** (`AGENTS.md` §3, `meta-brainstorm` §0 hukum 5). Yang boleh ditulis hanya yang dokumen resminya dibuka di sesi itu, dengan alamat dan tanggal aksesnya.
3. **Temuan lensa ini hampir selalu berbentuk "perlu keputusanmu" atau "tanyakan ke X"**, bukan "ini melanggar".

---

## 1. Cara Berpikirnya

| Pertanyaan pemula | Pertanyaan senior |
| :--- | :--- |
| "Boleh nggak secara hukum?" | "Kewajiban apa yang mungkin tersentuh, dokumen resminya yang mana, dan siapa di organisasi ini yang memutuskan?" |
| "Datanya kan cuma di server kita." | "Data siapa ini, untuk apa dikumpulkan, siapa yang bisa melihatnya, dan sampai kapan disimpan?" |
| "Library-nya gratis." | "Lisensinya apa, dan apa syaratnya untuk produk yang dijual atau dibagikan?" |
| "Gambarnya dari internet." | "Siapa pemiliknya, dan ada izin tertulisnya?" |
| "Klien minta begini." | "Di kontrak, siapa yang memiliki kodenya dan siapa yang menanggung kalau datanya bocor?" |

```text
Lima pemicu
  data pribadi     identitas, kontak, kesehatan, keuangan, lokasi, biometrik
  uang             pembayaran, pajak, gaji, potongan, faktur
  milik orang      library, font, gambar, ikon, teks, data pihak ketiga
  publik           pengguna di luar organisasi, pendaftaran terbuka, anak-anak
  kontrak          kepemilikan kode, kerahasiaan, tingkat layanan
```

---

## 2. Katalog Kasus Tepi

### 2.1 Data pribadi

Indonesia punya Undang-undang Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi. Menurut abstrak resminya, undang-undang itu mengatur jenis data pribadi, hak subjek data, pemrosesan, kewajiban pengendali dan prosesor, transfer data, sanksi administratif, dan ketentuan pidana. **Isi pasalnya tidak dikutip di sini**; buka teksnya sebelum menyebut kewajiban tertentu.

| Cek | Skenario yang dicari |
| :--- | :--- |
| Data baru yang dikumpulkan | Kolom baru berisi data orang (nomor identitas, alamat, kontak darurat). Untuk apa, dan apakah pemiliknya tahu? |
| Data yang lebih peka | Kesehatan (surat dokter, alasan sakit), keuangan (gaji, rekening), lokasi (absensi GPS), wajah (foto absensi). Lensa keamanan menjaga aksesnya; lensa ini bertanya apakah pengumpulannya sendiri sudah punya dasar. |
| Akses yang melebar | Perubahan yang membuat rekan kerja, atasan, atau pihak luar bisa melihat data yang sebelumnya tertutup. |
| Dipakai untuk tujuan lain | Data yang dikumpulkan untuk absensi dipakai untuk penilaian kinerja atau dibagikan ke pihak ketiga. |
| Keluar dari sistem | Ekspor, kirim ke layanan luar (pesan, email, analitik, penyimpanan awan), terutama ke luar negeri. |
| Disimpan selamanya | Tidak ada aturan kapan data orang yang sudah keluar dihapus atau disamarkan. |
| Permintaan pemilik data | Ada cara untuk melihat, membetulkan, atau menghapus data seseorang bila ia meminta? |
| Data di log dan cadangan | Data pribadi tercetak di log, pesan error, atau berkas cadangan yang aksesnya lebih longgar. |
| Data sungguhan di lingkungan uji | Salinan produksi dipakai di lokal atau staging tanpa disamarkan. |

### 2.2 Uang dan pajak

| Cek | Skenario yang dicari |
| :--- | :--- |
| Tarif dan rumus | Angka pajak, potongan, atau pembulatan ditulis di kode. Dari dokumen mana angkanya, dan siapa yang mengesahkan? |
| Perubahan perhitungan | Mengubah cara hitung mengubah angka di dokumen yang sudah terbit. Data lama dihitung ulang atau dibiarkan? |
| Dokumen bernomor | Faktur, kuitansi, atau bukti potong yang nomornya tidak boleh lompat atau berulang. |
| Jejak perubahan | Siapa mengubah angka apa, kapan. Tanpa itu, pemeriksaan keuangan tidak bisa dijawab. |
| Pembayaran | Menyimpan atau meneruskan data kartu atau rekening. Hampir selalu lebih aman diserahkan ke penyedia pembayaran. |

Tarif dan aturan pajak adalah wilayah lensa domain juga: sumbernya user atau bagian keuangan, bukan agen.

### 2.3 Milik pihak lain

| Cek | Skenario yang dicari |
| :--- | :--- |
| Lisensi library | Baca berkas lisensi di paket yang terpasang. Lisensi yang mewajibkan membuka kode turunan perlu keputusan user sebelum dipakai di produk tertutup. |
| Font | Lisensi font untuk web, aplikasi, dan dokumen cetak bisa berbeda. |
| Gambar, ikon, ilustrasi | Sumber dan izinnya dicatat. "Dari hasil pencarian gambar" bukan izin. |
| Teks dan data pihak ketiga | Menyalin isi situs lain, atau mengambil datanya otomatis: periksa `robots.txt` dan syarat pakainya sebelum permintaan pertama. |
| Kode dari jawaban forum atau AI | Potongan panjang yang disalin apa adanya dari sumber berlisensi. |
| Merek | Nama dan logo pihak lain di tampilan atau dokumen. |

**Ringkasan syarat tujuh lisensi yang sering ditemui** (choosealicense.com, dikurasi GitHub dan kontributornya). Ini untuk tahu **apa yang perlu ditanyakan**, bukan kesimpulan tentang kewajiban user. Ringkasan bukan teks lisensinya; lisensi yang berlaku adalah berkas `LICENSE` di paket versi yang terpasang.

| Lisensi | Syarat menurut ringkasan sumber | Pertanyaan yang muncul |
| :--- | :--- | :--- |
| MIT, BSD-3-Clause | License and copyright notice | Di mana pemberitahuan lisensi disertakan saat produknya dibagikan? |
| Apache-2.0 | License and copyright notice; State changes | Sama, ditambah: apakah paketnya diubah, dan perubahan itu dicatat? |
| MPL-2.0 | Disclose source; License and copyright notice; Same license (file) | Berkas paket mana yang diubah? (Baris ini kurang pasti: tabel sumbernya terbaca rata.) |
| LGPL-3.0 | Disclose source; License and copyright notice; Same license (library); State changes | Dipakai sebagai library atau diubah isinya? (Baris ini juga kurang pasti.) |
| GPL-3.0 | Disclose source; License and copyright notice; Same license; State changes | Apakah produknya **didistribusikan** ke pihak lain? Bila ya, user perlu memutuskan sebelum memasang. |
| AGPL-3.0 | Semua syarat GPL-3.0, ditambah Network use is distribution | Apakah produknya dipakai orang lain lewat jaringan (aplikasi web)? Bila ya, user perlu memutuskan sebelum memasang. |

Arti syarat menurut sumbernya, dikutip apa adanya: Disclose source, "Source code must be made available when the licensed material is distributed." Same license, "Modifications must be released under the same license when distributing the licensed material." Network use is distribution, "Users who interact with the licensed material via network are given the right to receive a copy of the source code." State changes, "Changes made to the licensed material must be documented."

Sumber itu menyebut GPL-3.0 "strong copyleft", AGPL-3.0 "strongest copyleft", dan MPL-2.0 "weak copyleft". Apa artinya untuk satu produk tertentu tetap bukan wewenang agen.
### 2.4 Peluncuran ke publik

| Cek | Skenario yang dicari |
| :--- | :--- |
| Halaman kebijakan | Aplikasi yang dibuka untuk umum biasanya butuh kebijakan privasi dan syarat pakai. Isinya bukan tulisan agen; siapkan tempatnya dan tanyakan sumbernya. |
| Persetujuan | Pendaftaran yang mengumpulkan data: ada pemberitahuan dan pilihan yang jelas? |
| Pesan keluar | Email atau pesan massal ke orang yang tidak meminta. |
| Pengguna di bawah umur | Aplikasi yang bisa dipakai anak. |
| Toko aplikasi | Aplikasi HP punya aturan toko soal data dan pembayaran; buka halaman aturannya saat itu relevan. |

### 2.5 Kontrak dan klien

| Cek | Skenario yang dicari |
| :--- | :--- |
| Kepemilikan kode | Kode pesanan klien, komponen milik sendiri yang dipakai ulang, dan library pihak ketiga: mana milik siapa. |
| Kerahasiaan | Data atau kode klien dipakai sebagai contoh, dimasukkan ke layanan luar, atau ditempel ke alat AI. |
| Akses setelah selesai | Akun, kunci, dan akses server yang masih dipegang setelah proyek diserahkan. |
| Janji layanan | Waktu tanggap dan ketersediaan yang dijanjikan, dibanding yang sanggup dijaga seorang diri. |

---

## 3. Cara Mengecek

1. **Kenali pemicunya dari perubahan itu sendiri**: kolom baru apa, siapa yang jadi bisa melihat apa, data keluar ke mana, paket baru apa.
2. **Untuk paket baru, baca berkas lisensinya** di folder paket yang terpasang. Nama lisensi dicatat apa adanya.
3. **Untuk kewajiban hukum, buka dokumen resminya** dari situs penerbitnya (untuk peraturan Indonesia: `peraturan.bpk.go.id` atau `peraturan.go.id`), bukan artikel rangkuman. Catat alamat dan tanggal akses. Tidak sempat membuka: tulis "belum saya periksa" dan cara memeriksanya.
4. **Tanyakan siapa yang berwenang.** Di proyek klien: pemilik produk atau bagian hukum dan keuangannya. Di proyek sendiri: user, dan untuk hal yang berat, penasihat hukum.
5. **Usulkan yang paling hemat data**: tidak mengumpulkan lebih murah daripada mengamankan.

---

## 4. Contoh Temuan

**Ditolak:**
> Legal: pastikan fitur ini patuh UU PDP dan regulasi yang berlaku.

**Ditolak (mengarang isi aturan):**
> Menurut pasal sekian UU PDP, data ini wajib dihapus dalam 30 hari.

Tanpa teks pasal yang dibuka di sesi itu, kalimat ini karangan yang terdengar resmi.

**Layak dikirim (perlu keputusanmu):**
> Layar baru "rekan satu divisi yang cuti" akan menampilkan `reason`, `attachment`, dan `foto_url` cuti yang disetujui: `OffResource` mengirim ketiganya untuk milik orang lain juga, sudah saya baca di berkas itu. Untuk cuti sakit, itu alasan sakit dan surat dokter yang terbaca rekan kerja. Itu data kesehatan; apakah boleh dilihat rekan satu divisi bukan keputusan saya. Bawaan saya: layar itu hanya menampilkan nama, jenis, dan tanggal. Yang perlu kamu tanyakan ke HRD atau pemilik kebijakannya: bolehkah alasan dan lampiran dilihat selain oleh atasan dan HRD.

**Layak dikirim (lisensi):**
> Paket yang mau dipasang berlisensi AGPL-3.0 menurut berkas `LICENSE` di paketnya (sudah saya buka). Saya belum membuka teks lisensinya, jadi tidak menyimpulkan kewajibannya; yang perlu kamu putuskan sebelum memasang: apakah aplikasi klien ini boleh memakai paket berlisensi itu. Jalan lain: paket sejenis berlisensi MIT yang sudah terpasang di proyek.

---

## 5. Anti-Pattern

**Anti-Pattern 1: menulis isi aturan dari ingatan.** Pasal, tarif, tenggat, dan denda adalah kelas yang paling sering direkonstruksi keliru.

**Anti-Pattern 2: memvonis.** "Ini melanggar" bukan wewenang agen. Bentuknya: apa yang tersentuh, apa yang belum diperiksa, siapa yang ditanya.

**Anti-Pattern 3: lensa ini menyala di tiap permintaan.** Mengganti label tombol tidak punya sisi hukum. Tanpa pemicu, satu baris.

**Anti-Pattern 4: menulis kebijakan privasi atau syarat pakai sendiri.** Agen boleh menyiapkan halamannya dan daftar hal yang perlu dijawab; isinya dari pihak yang berwenang.

**Anti-Pattern 5: mengumpulkan "siapa tahu perlu".** Kolom data pribadi yang tidak dipakai fitur mana pun adalah beban tanpa manfaat.

---

## 6. Edge Case

**Edge Case 1: user bertanya "ini legal nggak?".** Jawab apa yang diketahui dari dokumen yang dibuka, apa yang tidak diketahui, dan siapa yang bisa memutuskan. "Saya tidak tahu, dan begini cara mengetahuinya" adalah jawaban sah.

**Edge Case 2: dokumen resminya gagal dibuka.** Catat gagal dengan sebabnya. Jangan mengganti isinya dengan ingatan.

**Edge Case 3: aturan di negara lain.** Pengguna atau klien di luar Indonesia membawa aturan lain. Sebut bahwa itu di luar yang diperiksa.

**Edge Case 4: proyek internal kecil.** Aplikasi untuk lima orang di satu kantor tetap menyimpan data orang. Pemicunya tetap berlaku; kedalamannya yang menyesuaikan.

**Edge Case 5: klien sudah memutuskan.** Lensa ini menyebut sekali apa yang belum terlihat, lalu mengikuti. Keputusan dan risikonya milik klien; catat bahwa sudah disampaikan.

**Edge Case 6: data sudah telanjur terkumpul.** Temuan tentang data lama disajikan sebagai catatan terpisah dengan pilihan penanganannya, bukan diperbaiki diam-diam.

---

## 7. Sumber

- Undang-undang Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi, halaman JDIH BPK (`peraturan.bpk.go.id/Details/229798/uu-no-27-tahun-2022`), dibuka 10 November 2026. Yang dipakai hanya judul, tanggal (ditetapkan dan diundangkan 17 Oktober 2022), dan abstrak materi pokoknya. Teks pasal tidak dibuka.
- Temuan panel uji 10 November 2026 pada repo `altrms`: `OffResource` mengirim `reason`, `attachment`, dan `foto_url` untuk cuti milik orang lain.
- Kejadian dari `shared/LEARNED.md`: periksa `robots.txt` sebelum permintaan pertama; angka tanpa sumber adalah karangan.
- `meta-brainstorm` §0 hukum 5: atribusi ke aturan wajib berbukti.
- choosealicense.com (dikurasi GitHub, Inc. dan kontributornya), halaman "Appendix" dan "Licenses", dibuka 10 November 2026: tabel ringkasan syarat di bagian 2.3. Itu ringkasan pihak ketiga; teks lisensi masing-masing tidak dibuka. Baris MPL-2.0 dan LGPL-3.0 kurang pasti karena tabel sumbernya terbaca tanpa kolom.
- Bagian kontrak dan peluncuran publik disusun sendiri sebagai daftar pertanyaan; tidak ada aturan toko aplikasi yang dibuka untuk berkas ini.
