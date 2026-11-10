# Alur Proyek Baru — Mendefinisikan dari Nol, Seorang Diri

Pendamping `SKILL.md` skill `meta-panel`. Dibuka saat user memulai proyek dari nol, atau modul besar di proyek lama yang belum punya pola untuk ditiru.

Di proyek lama, panel membaca kode yang ada dan mencari apa yang ikut tersentuh. Di proyek baru tidak ada yang bisa dibaca: semua yang biasanya dipegang satu tim harus diputuskan satu orang. Berkas ini mengurutkan keputusan itu supaya **tiap peran mendapat gilirannya bertanya**, dan supaya keputusan yang mahal dibalik diambil lebih dulu dan tertulis.

Yang tidak diulang di sini: pemilihan stack ada di `decision-tree.md`; daftar fondasi teknis (konfigurasi, migrasi, task runner) ada di macro `/greenfield`; cara menulis dokumennya ada di `skills/meta-prd/SKILL.md`.

---

## 1. Tiga Aturan

1. **Satu putaran, satu peran, lalu berhenti.** Delapan putaran sekaligus menghasilkan tembok teks yang tidak dibaca. Tiap putaran: paling banyak tiga pertanyaan, masing-masing dengan bawaan yang dipakai bila tidak dijawab.
2. **Yang mahal dibalik diputuskan dulu dan ditulis.** Masalah, aturan bisnis, bentuk data, dan stack lebih mahal diubah daripada warna tombol. Urutan di bawah mengikuti itu.
3. **Tidak ada kode sebelum fondasinya disetujui.** Proyek baru masuk lewat gerbang yang sama dengan permintaan lain (`AGENTS.md` §0.2). Kode percobaan untuk menjawab "bisa nggak" boleh, dan dibuang sesudahnya.

---

## 2. Delapan Putaran

| # | Peran yang bertanya | Yang diputuskan | Berkas lensa | Keluaran |
| :-- | :--- | :--- | :--- | :--- |
| 1 | Product | Masalah, pengguna dan perannya, yang dianggap berhasil, yang sengaja tidak dikerjakan, potongan pertama yang sudah berguna | `lens-product.md` | PRD bagian masalah, pengguna, cakupan |
| 2 | Domain | Aturan bisnis bernomor: satuan, cakupan, waktu, keadaan, pengecualian, akibat | `lens-domain.md` | PRD bagian aturan; daftar yang belum terjawab |
| 3 | Cost dan Legal | Anggaran waktu dan uang, siapa yang merawat, data pribadi apa yang dikumpulkan, lisensi, kontrak | `lens-cost.md`, `lens-legal.md` | PRD bagian batas; pertanyaan untuk pihak berwenang |
| 4 | Data | Entitas utama dan hubungannya, yang tidak boleh hilang, yang tumbuh, yang perlu jejak perubahan | `lens-data.md` | Diagram entitas; RFC bagian data |
| 5 | Backend | Stack, susunan lapisan, pola yang akan ditiru semua modul berikutnya, integrasi luar | `lens-backend.md`, `decision-tree.md` | ADR per keputusan besar; RFC bagian arsitektur |
| 6 | UX | Arah desain (bagian 4), alur layar utama per peran, lima keadaan tiap layar | `lens-ux.md`, dan `role-designer.md` di `meta-brainstorm` | Tiga contoh arah desain; pilihan user |
| 7 | Security dan Ops | Cara masuk dan pembagian izin, tempat rahasia disimpan, tempat jalan, cara rilis dan mundur, cadangan | `lens-security.md`, `lens-ops.md` | RFC bagian keamanan dan operasional |
| 8 | QA | Kriteria selesai untuk potongan pertama, apa yang diuji otomatis, apa yang dicoba di browser | `lens-qa.md`, dan `role-planner.md` di `meta-brainstorm` | Kriteria selesai; rencana kerja berpotongan; daftar periksa awal `meta-swipe` |

Putaran boleh dilewati bila jawabannya sudah ada di permintaan user; sebutkan bahwa dilewati dan dari kalimat mana jawabannya diambil. Putaran tidak boleh dilewati hanya karena terasa membosankan.

Putaran 1 dan 2 menentukan semua yang sesudahnya. Bila user belum bisa menjawabnya, berhenti di sana: proyek tanpa masalah dan aturan yang jelas tidak diselamatkan oleh stack yang bagus.

### Periksa silang dengan tahap discovery dan alpha

Urutan di atas dicocokkan dengan dua halaman GOV.UK Service Manual. Sumber itu ditulis untuk tim layanan pemerintah, jadi yang diambil prinsipnya, bukan lamanya (ia menyebut discovery "around 4 to 8 weeks is typical"; itu bukan target di sini).

| Dari sumber | Padanannya di alur ini |
| :--- | :--- |
| "Before you commit to building a service, you need to understand the problem that needs to be solved." | Putaran 1 sampai 3 mendahului semua keputusan teknis. |
| "You should not start building your service in discovery." | Tidak ada kode sebelum fondasi disetujui (aturan 3). |
| Yang dicari saat discovery: pengguna dan apa yang ingin mereka capai, batasan (teknologi, peraturan), dan peluang memperbaiki | Putaran 1 (pengguna), putaran 3 (batasan, termasuk hukum), putaran 2 (aturan). |
| "It's not a failure to stop at the end of the discovery phase if your research shows that's the best thing to do." | "Tidak dikerjakan" tetap pilihan yang sah setelah putaran 3. Sebutkan itu ke user. |
| "Alpha is where you try out different solutions to the problems you learnt about during discovery." | Putaran 5 dan 6: beberapa opsi arsitektur, tiga arah desain. |
| "A crucial part of alpha is identifying your riskiest assumptions and testing them." | Asumsi paling berisiko dari putaran 1 sampai 4 diuji dengan kode percobaan sebelum fondasi ditulis. |
| "Expect to throw away any code - and lots of the ideas you test - at the end of alpha." | Halaman contoh arah desain dan kode percobaan dibuang; yang dibawa hanya keputusan dan tokennya. |

Satu hal yang sumbernya tekankan dan alur ini lemah: discovery bertumpu pada **riset ke pengguna sungguhan**, sedangkan putaran di sini bertanya ke user (pemilik proyek). Di putaran 1, tanyakan apakah ada satu calon pengguna yang bisa diajak bicara sebelum putaran 3; jawaban dari satu pengguna nyata mengalahkan dugaan pemilik dan agen.

---

## 3. Cara Bertanya di Tiap Putaran

```text
Putaran N — <peran>
  Yang sudah saya tangkap dari permintaanmu: <satu sampai tiga baris>
  Yang saya putuskan sendiri, bantah kalau salah: <bawaan dan alasannya>
  Yang perlu kamu jawab (maksimal tiga):
    1. <pertanyaan dengan dua contoh konkret>. Bawaan saya: <...>.
  Yang ditunda ke putaran lain: <...>
```

- **Bawaan dulu, pertanyaan kemudian.** Orang yang bekerja sendirian butuh teman yang berani mengusulkan, bukan formulir. Yang ditanyakan hanya yang salah pilihnya mahal.
- **Tiap usulan pendekatan membawa tiga kelebihan, tiga kekurangan, dan pembatalnya** (`AGENTS.md` §4). Untuk keputusan besar, minimal tiga opsi.
- **Yang tidak diketahui ditulis tidak diketahui.** Angka biaya, isi aturan, dan perilaku library tidak diisi dari ingatan.
- **Hasil putaran dicatat sebelum lanjut**, di dokumen atau di berkas catatan proyek, supaya putaran berikutnya dan sesi berikutnya tidak mengulang.

---

## 4. Arah Desain

Untuk proyek baru yang punya tampilan. Tujuannya user **memilih dari yang bisa dilihat**, bukan menyetujui deskripsi.

### 4.1 Urutannya

1. **Tangkap temanya dalam tiga kata sifat dan satu kalimat** dari jawaban putaran 1: untuk siapa, dipakai kapan, di perangkat apa. "Aplikasi kuis kelas, ceria, dipakai di proyektor dan HP" menghasilkan arah yang berbeda dari "panel pembelian, padat, dipakai seharian di laptop".
2. **Cari acuan nyata.** Tiga sampai lima produk atau situs sebidang yang benar-benar dibuka di sesi itu. Dari tiap acuan dicatat yang terlihat: susunan halaman, kepadatan, jenis huruf, cara memakai warna, gerak. Yang dicatat adalah pengamatan, bukan salinan aset.
3. **Susun tiga arah yang sungguh berbeda**, bukan tiga variasi warna dari satu tata letak. Bedakan di minimal dua sumbu: kepadatan (lapang atau padat), watak (tenang atau ekspresif), navigasi (samping, atas, atau bawah), bentuk (bersudut atau membulat).
4. **Buat tiap arah sebagai satu halaman HTML** yang bisa dibuka langsung, memuat layar terpenting aplikasinya dengan isi yang realistis, dalam tema terang dan gelap bila aplikasinya akan punya keduanya.
5. **Sajikan ketiganya** dengan satu paragraf per arah: untuk siapa ia paling cocok, apa yang dikorbankannya, dan apa yang membuatnya salah pilih. Lalu berhenti dan tunggu pilihan user.
6. **Arah terpilih diturunkan jadi token** (warna, huruf, jarak, radius, bayangan, durasi gerak) di satu berkas, dan dicatat sebagai ADR. Layar berikutnya memakai token itu; nilai lepas di luar token tidak ditambah.

### 4.2 Yang ditentukan tiap arah

| Hal | Yang diputuskan | Catatan |
| :--- | :--- | :--- |
| Tipografi | Huruf judul, huruf isi, huruf angka atau kode; skala ukuran | Lisensi font untuk pemakaian itu diperiksa di halaman penerbitnya (lensa legal) |
| Warna | Latar, permukaan, teks, satu aksen, warna status | Kontras teks diukur, bukan dinilai dari mata |
| Tata letak | Kisi, lebar isi, kepadatan baris tabel dan form, titik patah layar sempit | Dicoba di lebar HP dan laptop |
| Komponen dasar | Tombol, isian, tabel, kartu, dialog, notifikasi | Lima keadaan: kosong, memuat, berisi, sebagian, gagal |
| Gerak | Apa yang bergerak, berapa lama, dan untuk apa | Gerak yang berjalan terus punya cara dihentikan; hormati pengaturan kurangi-gerak |
| Ikon dan gambar | Satu keluarga ikon; sumber ilustrasi | Sumber dan izinnya dicatat |

### 4.3 Yang sudah ditolak user

Dari catatan proyek-proyek sebelumnya, ini tidak dipakai kecuali user memintanya: garis atau latar gradien hiasan, garis aksen tebal di sisi kartu, maskot melayang, titik tiga ala jendela macOS, sapaan promosi di kepala halaman, dan emoji sebagai hiasan judul. Tiga arah yang disajikan tidak boleh berbagi salah satu dari itu.

### 4.4 Yang bukan bagian langkah ini

- Halaman contoh arah desain **bukan dokumen**: ia tidak memakai gaya `meta-prd`, dan gaya `meta-prd` bukan gaya aplikasinya.
- Alat desain (Figma) hanya dipakai bila hasilnya akan diserahkan ke orang lain yang bekerja di sana. Untuk orang yang menulis kodenya sendiri, HTML lebih dekat ke hasil akhir.
- Halaman contoh adalah bahan pilihan, bukan fondasi kode. Setelah arah dipilih, yang dibawa ke proyek adalah tokennya.

### 4.5 Memeriksanya

Tiap halaman contoh dirender di browser dalam lebar laptop dan HP, tema terang dan gelap, dan gambarnya dibaca sebelum disajikan. Perender di `skills/meta-prd/scripts/lib/browser.mjs` bisa dipakai untuk mengambil gambarnya. Test server tidak membuktikan tampilan.

---

## 5. Dokumen yang Dihasilkan

| Dokumen | Dari putaran | Kapan ditulis |
| :--- | :--- | :--- |
| PRD | 1, 2, 3 | Setelah putaran 3; inilah yang pertama disetujui user |
| ADR, satu per keputusan | 5 (stack, basis data, cara masuk), 6 (arah desain) | Begitu keputusannya diambil |
| RFC | 4, 5, 7 | Bila arsitekturnya punya pilihan yang ditimbang; proyek kecil cukup ADR |
| Rencana kerja | 8 | Potongan pertama dan kriteria selesainya |

Semuanya lewat `meta-prd`, di folder dokumen proyek. Proyek sangat kecil boleh berhenti di satu PRD pendek dan dua ADR; yang tidak boleh adalah nol dokumen, karena sesi berikutnya tidak akan ingat alasannya.

Tiga titik berhenti yang menunggu persetujuan user: setelah PRD, setelah arah desain dipilih, dan setelah fondasi (kerangka proyek, skema pertama, satu alur dari ujung ke ujung) berdiri dan test-nya lulus.

---

## 6. Anti-Pattern

**Anti-Pattern 1: mulai dari stack.** Memilih framework sebelum tahu masalah dan aturannya.

**Anti-Pattern 2: delapan putaran dalam satu pesan.** User tidak membacanya, lalu semua bawaan lolos tanpa ditinjau.

**Anti-Pattern 3: tiga arah desain yang sama.** Satu tata letak dengan tiga warna bukan pilihan.

**Anti-Pattern 4: arah desain dari ingatan.** Menyusun "gaya modern" tanpa membuka satu acuan pun menghasilkan tampilan generik yang sudah ditolak user.

**Anti-Pattern 5: fondasi berlebihan.** Antrian, cache, dan container untuk aplikasi yang belum punya pengguna. Pasang yang dibutuhkan potongan pertama.

**Anti-Pattern 6: keputusan tanpa catatan.** Enam bulan lagi tidak ada yang ingat kenapa basis datanya itu.

---

## 7. Edge Case

**Edge Case 1: user sudah membawa stack dan desain.** Putaran 5 dan 6 menjadi pemeriksaan singkat atas pilihannya, bukan penawaran ulang.

**Edge Case 2: proyek percobaan satu akhir pekan.** Putaran 1, 4, dan 5 saja, masing-masing beberapa baris. Sebut bahwa sisanya dilewati dengan sengaja.

**Edge Case 3: proyek untuk klien.** Putaran 3 naik bobotnya: kepemilikan kode, kerahasiaan, dan siapa yang merawat setelah diserahkan.

**Edge Case 4: modul baru di proyek lama.** Putaran 5 dan 6 mengikuti pola dan tampilan yang sudah ada; arah desain tidak ditawarkan ulang.

**Edge Case 5: user tidak bisa memilih arah desain.** Tanyakan mana yang paling tidak disukai dan kenapa; jawaban itu biasanya cukup untuk menyusun satu arah gabungan.

**Edge Case 6: acuan gagal dibuka.** Catat gagal. Arah desain yang disusun tanpa acuan diberi tahu begitu ke user.

---

## 8. Sumber

- Permintaan user 10 November 2026: bekerja sendirian sebagai fullstack, butuh teman berpikir per peran, dan untuk proyek baru butuh banyak pilihan tampilan yang diriset sesuai tema aplikasinya.
- `AGENTS.md` §0.2, §4, §5.3; macro `/greenfield` (daftar fondasi); `references/decision-tree.md` (pemilihan stack).
- Kejadian dari `shared/LEARNED.md`: pola tampilan yang ditolak user (bagian 4.3), "tujuan akhir bukan kriteria langkah pertama", lima pertanyaan klarifikasi sekaligus, tampilan tidak bisa diverifikasi dari test server.
- GOV.UK Service Manual, "How the discovery phase works" (diperbarui 21 Juni 2021) dan "How the alpha phase works" (diperbarui 8 Mei 2019), dibuka 10 November 2026: tabel periksa silang di bagian 2. Kutipan di sana verbatim.
- Urutan delapan putaran dan langkah arah desain adalah susunan sendiri yang diperiksa silang dengan sumber di atas. Uji 10 November 2026 hanya menjalankan putaran 1 (satu agen baru, satu giliran); putaran 2 sampai 8 dan arah desain **belum pernah dijalankan**. Perbaiki dari pemakaian pertama.
