# Katalog Komponen doc-style v1

Pendamping `SKILL.md` skill `meta-prd`. Dibaca saat menulis isi dokumen (langkah 5 prosedur).

Semua komponen di sini sudah ada CSS dan perilakunya di `assets/component-gallery.html`. Berkas ini menjawab tiga hal per komponen: **kapan dipakai, kapan jangan, dan cuplikannya**. Untuk melihat rupanya, buka galeri di browser.

Aturan umum: pilih komponen dari **fungsi isinya**, bukan supaya halaman terlihat ramai. Halaman yang seluruhnya paragraf dan dua tabel itu sah bila isinya memang begitu.

---

## 1. Anatomi Halaman

```text
.wrap
+-- nav.toc            daftar isi kiri, diisi otomatis dari <section id> + <h2>
+-- main
    +-- header.doc     eyebrow, h1, lede, meta | kolom kanan opsional
    +-- .toolbar       catatan kecil | tombol tema
    +-- .toc-mobile    daftar isi untuk layar sempit, diisi otomatis
    +-- section#id     <h2><span class="num">00</span>Judul</h2> + isi
    +-- section#id     ...
    +-- footer.doc     siapa menyusun, kapan, untuk apa
```

Tiga hal yang diurus skrip, jadi jangan ditulis tangan: isi `ol[data-toc]`, sorotan bagian yang sedang dibaca, dan penyimpanan tema.

---

## 2. Memilih Komponen

| Isi yang mau ditampilkan | Komponen | Jangan dipakai untuk |
| :--- | :--- | :--- |
| Dua sampai empat hal setara | `.grid-2` / `.grid-3` / `.grid-4` berisi `.card` | Daftar panjang; pakai tabel |
| Angka kunci yang bersumber | `.stat` | Angka perkiraan atau tanpa sumber |
| Proporsi satu nilai | `.meter` | Membandingkan banyak nilai; pakai `.bar` di tabel |
| Daftar berkolom | `table` di dalam `.table-scroll` | Dua kolom yang salah satunya paragraf panjang; pakai `.kv` |
| Kunci dan nilai | `dl.kv` | Lebih dari sekitar delapan baris; pakai tabel |
| Prosedur berurutan | `ol.steps` | Butir yang urutannya tidak penting; pakai `ul` |
| Rantai pendek | `.flow` | Alur bercabang; pakai Mermaid |
| Rentang waktu beberapa jalur | `.roadmap` | Tanggal pasti per hari; pakai tabel |
| Pilihan yang ditimbang | `.card.option` dengan `.pros`, `.cons`, `.killer` | Satu pilihan saja; itu rekomendasi, tulis sebagai paragraf |
| Pertanyaan untuk user | `.card.decision` | Catatan biasa; pakai callout |
| Peringatan atau batas | `.callout` (lima warna) | Lebih dari satu per bagian |
| Daftar yang dicentang | `ul.checklist[data-store]` | Daftar yang tidak akan dicentang siapa pun |
| Isi setara per peran atau varian | `.tabs` | Isi yang harus dibandingkan berdampingan |
| Rincian yang tidak semua orang butuh | `details` | Menyembunyikan hal penting |
| Perintah atau kode | `pre[data-copy]` | Satu kata; pakai `code` sebaris |
| Kutipan sumber | `blockquote` + `footer` | Parafrase |
| Alur atau arsitektur | `.diagram` + `pre.mermaid` | Alur dua langkah |
| Status dan prioritas | `.pill` | Kalimat; pill maksimal dua sampai tiga kata |
| Kebutuhan dari sudut pengguna | `.card.story` + `dl.gwt` | Kebutuhan teknis internal; pakai tabel ber-ID |
| Opsi melawan kriteria | `table.matrix` | Menggantikan kartu opsi; matriks tidak memuat alasan |
| Risiko menurut kemungkinan dan dampak | `table.risk` | Daftar risiko itu sendiri; skenarionya tetap di tabel |
| Kejadian atau tenggat bertanggal | `ol.timeline` | Rentang antar-jalur; pakai `.roadmap` |
| Perubahan dokumen | `ul.changelog` | Riwayat keputusan; itu ADR |
| Tangkapan layar atau sketsa layar | `.screen.browser` / `.screen.phone` | Menggambar desain final; sketsa `.wire` hanya menunjukkan susunan |
| Beberapa angka dibandingkan | `.columns` | Lebih dari sekitar delapan kolom, atau angka tanpa sumber |
| Istilah yang dipakai berulang | `dl.glossary` | Istilah yang cukup dijelaskan sekali di kalimatnya |

---

## 3. Cuplikan

### Kepala dokumen

```html
<header class="doc">
  <div>
    <p class="eyebrow">PRD · Reimbursement · Draf</p>
    <h1>Reimbursement tanpa kertas untuk karyawan lapangan</h1>
    <p class="lede">Dua sampai tiga kalimat: apa ini, untuk siapa, disusun dari apa.</p>
    <ul class="meta">
      <li><b>Disusun</b> 10 November 2026</li>
      <li><b>Basis kode</b> <code>develop</code> c07e9dd</li>
      <li><b>Status</b> menunggu persetujuan</li>
    </ul>
  </div>
  <div class="progress">
    <div class="row"><b>Fase 1</b><div class="meter"><i style="width:80%"></i></div><span class="lbl">8 dari 10 selesai</span></div>
  </div>
</header>
```

Kolom kanan opsional. Hapus `div.progress` bila tidak ada angka yang layak ditampilkan.

### Bagian

```html
<section id="masalah">
  <h2><span class="num">01</span>Masalah yang dipecahkan</h2>
  <p class="sub">Satu sampai dua kalimat pembuka.</p>
  <h3>Sub-topik</h3>
  <p>Paragraf dengan sumber <span class="lbl">[fakta:E2]</span>.</p>
  <p class="note">Catatan kecil di bawah tabel atau gambar.</p>
</section>
```

`id` huruf kecil tanpa spasi. Nomor dua digit berurutan dari `00`. Judul `h2` berisi teks polos saja: `<code>` di dalam `h2` menjadi kolom sendiri dan di layar sempit hurufnya tersusun ke bawah satu per satu. `code` di `h3` dan `h4` boleh. Label daftar isi yang lebih pendek dari judul: tambahkan `data-toc-label="Masalah"` pada `section`.

### Kartu, kisi, persona

```html
<div class="grid-2">
  <div class="card"><h4>Judul kartu</h4><ul><li><b>Inti</b> lalu penjelasan.</li></ul></div>
  <div class="card"><h4>Judul kartu</h4><p>Isi singkat.</p></div>
</div>

<div class="card persona">
  <div class="avatar" aria-hidden="true">H</div>
  <div><h4>HRD</h4><p>Apa yang ia kerjakan dan dari perangkat apa.</p></div>
</div>
```

### Callout

```html
<div class="callout"><p><b>Netral.</b> Catatan konteks.</p></div>
<div class="callout info"><p><b>Info.</b> Fakta pendukung.</p></div>
<div class="callout ok"><p><b>Aman.</b> Sudah diverifikasi.</p></div>
<div class="callout warn"><p><b>Peringatan.</b> Risiko atau batas.</p></div>
<div class="callout danger"><p><b>Blocker.</b> Menghentikan rencana.</p></div>
```

### Pill

```html
<span class="pill p0">P0</span> <span class="pill p1">P1</span> <span class="pill p2">P2</span> <span class="pill p3">Jarang</span>
<span class="pill ok">Selesai</span> <span class="pill warn">Tertunda</span> <span class="pill danger">Blocker</span>
<span class="pill info">Info</span> <span class="pill muted">Draf</span> <span class="pill solid">Dipilih</span>
```

`p0`/`danger`, `p1`/`warn`, `p2`/`accent`, `p3`/`muted` adalah pasangan nama untuk warna yang sama. Pakai `p0`-`p3` untuk prioritas, nama maksud untuk status.

### Angka

```html
<div class="grid-4">
  <div class="stat"><span class="value">273</span><span class="label">lowongan Go utama</span><span class="delta">28 Okt 2026</span></div>
  <div class="stat"><span class="value">36</span><span class="label">remote terbuka</span><span class="delta down">dari 187</span></div>
</div>

<div class="meter ok"><i style="width:90%"></i></div>

<div class="bar"><span class="lbl">9 · 82%</span><div class="meter"><i style="width:82%"></i></div></div>
```

`.delta.up` dan `.delta.down` mewarnai keterangan. `.meter` punya varian `ok`, `warn`, `danger`.

### Tabel

```html
<div class="table-scroll"><table>
  <thead><tr><th>ID</th><th>Kebutuhan</th><th>Prioritas</th><th class="n">Estimasi</th></tr></thead>
  <tbody>
    <tr class="group-row"><th colspan="4">Kelompok</th></tr>
    <tr><td class="id">U1</td><td>Isi.</td><td><span class="pill p0">P0</span></td><td class="n">3 hari</td></tr>
  </tbody>
</table></div>
```

`table.compact` untuk tabel rapat. `td.id` untuk kode, `td.n` untuk angka, `td.nowrap` untuk sel yang tidak boleh patah.

Saringan baris:

```html
<div class="chips" data-filter-target="#tugas">
  <button class="chip" type="button" data-filter="" aria-pressed="true">Semua</button>
  <button class="chip" type="button" data-filter="p0" aria-pressed="false">P0 saja</button>
</div>
<div class="table-scroll"><table id="tugas"><tbody>
  <tr data-tags="p0 backend"><td>Endpoint pengajuan</td></tr>
</tbody></table></div>
```

### Urutan dan waktu

```html
<ol class="steps">
  <li class="done"><div><h4>Langkah selesai</h4><p>Keterangan.</p></div></li>
  <li><div><h4>Langkah berikut</h4><p>Keterangan.</p></div></li>
</ol>

<div class="flow"><b>Pengajuan</b><i>→</i><b>Cek atasan</b><i>→</i><b>Dibayar</b></div>

<div class="roadmap" style="--cols: 8">
  <div class="lane"><span></span><div class="scale"><span>M1</span><span>M2</span><span>M3</span><span>M4</span><span>M5</span><span>M6</span><span>M7</span><span>M8</span></div></div>
  <div class="lane"><b>Fondasi</b><div class="track"><span style="--from: 1; --span: 2">Skema</span></div></div>
  <div class="lane"><b>Laporan</b><div class="track"><span class="soft" style="--from: 6; --span: 3">Kalau sempat</span></div></div>
</div>
```

`pre[data-copy]` boleh ditaruh di dalam butir `ol.steps` untuk perintah per langkah.

`--cols` jumlah kolom waktu. `--from` kolom mulai (dari 1), `--span` lebarnya. `span.soft` untuk rencana yang belum pasti.

### Pilihan, keputusan, kunci-nilai

```html
<div class="grid-3">
  <div class="card option chosen">
    <h4>A · Nama opsi <span class="pill solid">Rekomendasi</span></h4>
    <ul class="pros"><li>Kelebihan.</li><li>Kelebihan.</li><li>Kelebihan.</li></ul>
    <ul class="cons"><li>Kekurangan.</li><li>Kekurangan.</li><li>Kekurangan.</li></ul>
    <p class="killer"><b>Batal kalau</b> kondisi yang membatalkan opsi ini.</p>
  </div>
</div>

<div class="stack">
  <div class="card decision">
    <div><h4>K1 · Pertanyaannya?</h4><p>Bawaan yang diusulkan: ..., karena .... Akibatnya: ....</p></div>
    <span class="pill warn">Menunggu jawaban</span>
  </div>
  <div class="card decision">
    <div><h4>K2 · Pertanyaan berikutnya?</h4><p>Bawaan yang diusulkan: ..., karena .... Akibatnya: ....</p></div>
    <span class="pill ok">Dijawab: ...</span>
  </div>
</div>

<dl class="kv">
  <div><dt>Pemilik</dt><dd>Tim HRIS</dd></div>
  <div><dt>Di luar cakupan</dt><dd>Pembayaran otomatis.</dd></div>
</dl>
```

`AGENTS.md` §4 mewajibkan tiga kelebihan dan tiga kekurangan per opsi serta pembatalnya. Komponen `.option` disusun untuk itu. Label `.lbl` dan `code` boleh ditaruh langsung di dalam butir `ul.pros` atau `ul.cons`: `<li>Tanpa komponen baru. <span class="lbl">[fakta:E1]</span></li>`.

Beberapa kartu berurutan di luar kisi dibungkus `div.stack` supaya berjarak. Kartu keputusan yang sudah dijawab tidak dihapus: pill-nya diganti `ok` dengan jawabannya, supaya riwayatnya terbaca.

### Tabel tujuan dan tabel asumsi

```html
<div class="table-scroll"><table>
  <thead><tr><th>ID</th><th>Tujuan</th><th>Ukuran berhasil</th><th>Cara mengukur</th></tr></thead>
  <tbody>
    <tr><td class="id">T1</td><td>Pengajuan tidak perlu kertas.</td><td>Semua pengajuan bulan berjalan masuk lewat aplikasi.</td><td>Hitung baris tabel pengajuan dibanding arsip kertas HRD.</td></tr>
  </tbody>
</table></div>

<div class="table-scroll"><table>
  <thead><tr><th>ID</th><th>Asumsi</th><th>Akibat bila salah</th><th>Cara termurah memverifikasi</th></tr></thead>
  <tbody>
    <tr><td class="id">A1</td><td>Karyawan lapangan punya HP dengan kamera.</td><td>Lampiran foto tidak bisa diwajibkan.</td><td>Tanya lima kepala regu.</td></tr>
  </tbody>
</table></div>
```

Tujuan tanpa cara mengukur bukan tujuan; tulis sebagai harapan di paragraf atau buang.

### Daftar periksa, tab, buka-tutup

```html
<ul class="checklist" data-store="kriteria-u1">
  <li><label><input type="checkbox" data-key="a"><span>Kriteria<small>Keterangan kecil.</small></span></label></li>
</ul>

<div class="tabs">
  <div role="tablist" aria-label="Peran">
    <button class="chip" type="button" role="tab" data-tab="hrd" aria-selected="true">HRD</button>
    <button class="chip" type="button" role="tab" data-tab="karyawan" aria-selected="false">Karyawan</button>
  </div>
  <div class="card" role="tabpanel" data-panel="hrd">Isi HRD.</div>
  <div class="card" role="tabpanel" data-panel="karyawan" hidden>Isi karyawan.</div>
</div>

<details><summary>Judul</summary><p>Rincian.</p></details>
```

`data-store` unik per daftar dalam satu halaman. `data-key` stabil per butir: mengganti kuncinya menghapus centang lama. Saat sebuah centang berubah, daftar mengirim event `doc:checklist` yang bisa didengar skrip halaman.

### Kode, kutipan, gambar, diagram

```html
<pre data-copy><code>node doc-tools.mjs check dokumen.html</code></pre>

<blockquote><p>"Kutipan verbatim."</p><footer>Sumber, tanggal, ID bukti.</footer></blockquote>

<figure><img src="tangkapan.png" alt="Apa yang terlihat di gambar"><figcaption>Keterangan.</figcaption></figure>

<div class="diagram">
  <pre class="mermaid">flowchart LR
  A[Pengajuan] --> B{Di atas batas?}
  B -- Ya --> C[Cek HRD]</pre>
</div>
```

Mermaid dimuat dari CDN hanya bila halaman punya `pre.mermaid`, dan digambar ulang saat tema berganti. Tanpa internet, teks sumbernya tetap tampil.

Ganti baris di dalam label node ditulis `&lt;br/&gt;`, bukan `<br/>`. Di dalam `pre`, `<br/>` mentah dibaca browser sebagai elemen dan hilang dari teks yang diterima Mermaid, sehingga dua baris label menyatu tanpa spasi ("Peta belajar Goselesai"). `check` dan `doc-render` tidak menangkap ini; hanya terlihat di gambarnya.

Diagram dengan lebih dari sekitar delapan node mengecil di layar sempit sampai hurufnya sulit dibaca: pecah jadi dua diagram, atau pindahkan rinciannya ke `ol.steps` di bawahnya. Label garis (`A -- Ya --> B`) memakai warna kartu di kedua tema.

### Cerita pengguna dan kriteria penerimaan

```html
<div class="card story">
  <h4>U1 · Mengajukan dari HP <span class="pill p0">P0</span></h4>
  <p class="as">Sebagai <b>karyawan lapangan</b>, saya ingin <b>mengajukan dari HP</b> supaya <b>tidak perlu ke kantor</b>.</p>
  <dl class="gwt">
    <div><dt>Kalau</dt><dd>keadaan awal.</dd></div>
    <div><dt>Ketika</dt><dd>tindakan pengguna.</dd></div>
    <div><dt>Maka</dt><dd>hasil yang bisa diperiksa.</dd></div>
  </dl>
</div>
```

Satu `dl.gwt` per skenario. Skenario gagal (input salah, tanpa izin) ditulis sebagai `dl.gwt` kedua di kartu yang sama, bukan dilewati.

### Matriks perbandingan dan matriks risiko

```html
<div class="table-scroll"><table class="matrix">
  <thead><tr><th>Kriteria</th><th class="pick">A</th><th>B</th></tr></thead>
  <tbody>
    <tr><td>Job tidak hilang saat restart</td><td class="yes pick"></td><td class="part">dengan persistensi</td></tr>
    <tr><td>Tanpa komponen baru</td><td class="yes pick"></td><td class="no"></td></tr>
  </tbody>
</table></div>

<div class="table-scroll"><table class="risk">
  <thead><tr><th></th><th>Dampak kecil</th><th>Dampak sedang</th><th>Dampak besar</th></tr></thead>
  <tbody>
    <tr><th scope="row">Sering</th><td class="mid"></td><td class="high">R2</td><td class="high"></td></tr>
    <tr><th scope="row">Kadang</th><td class="low"></td><td class="mid">R1</td><td class="high"></td></tr>
    <tr><th scope="row">Jarang</th><td class="low">R3</td><td class="low"></td><td class="mid"></td></tr>
  </tbody>
</table></div>
```

Sel `yes`, `no`, `part` menggambar tandanya sendiri; teks di dalam sel jadi keterangan tambahan. Kolom terpilih (`.pick`) ditaruh tepat setelah kolom kriteria: di layar sempit kolom paling kanan tersembunyi di balik geseran. Warna sel matriks risiko (`low`, `mid`, `high`) ditentukan posisinya, bukan isi selnya.

### Garis waktu dan riwayat dokumen

```html
<ol class="timeline">
  <li class="done"><time datetime="2026-10-28">28 Okt 2026</time><div><h4>Kejadian</h4><p>Keterangan.</p></div></li>
  <li class="now"><time datetime="2026-11-10">10 Nov 2026</time><div><h4>Kejadian <span class="pill solid">Sekarang</span></h4><p>Keterangan.</p></div></li>
  <li><time datetime="2027-01-10">10 Jan 2027</time><div><h4>Tenggat</h4><p>Keterangan.</p></div></li>
</ol>

<ul class="changelog">
  <li><span class="pill accent">v1.1</span><time datetime="2026-11-10">10 Nov 2026</time><span>Apa yang berubah.</span></li>
</ul>
```

Tanggal selalu absolut, dengan atribut `datetime` berformat `YYYY-MM-DD`.

### Bingkai layar, grafik kolom, glosarium

```html
<figure>
  <div class="screen browser">
    <div class="address">hrd.localhost/reimbursements</div>
    <div class="view"><img src="tangkapan.png" alt="Daftar pengajuan dengan tiga baris berstatus Menunggu"></div>
  </div>
  <figcaption>Keterangan.</figcaption>
</figure>

<div class="screen phone wire"><i class="short"></i><i class="block"></i><i></i><i class="mid"></i><i class="button"></i></div>

<div class="columns" role="img" aria-label="Lowongan per syarat tahun: 0-1 tahun 3, 2 tahun 5, 3 tahun 9">
  <div style="--v: 33"><b>3</b></div><div style="--v: 56"><b>5</b></div><div style="--v: 100"><b>9</b></div>
</div>
<div class="columns-labels"><span>0–1 th</span><span>2 th</span><span>3 th</span></div>

<dl class="glossary">
  <div><dt>Idempoten</dt><dd>Operasi yang hasilnya sama walau dipanggil lebih dari sekali.</dd></div>
</dl>
```

`.wire` menggambar sketsa dari balok abu: `i` garis penuh, `i.short` dan `i.mid` garis pendek, `i.block` kotak isi, `i.button` tombol. `--v` pada `.columns` bernilai 0 sampai 100 relatif terhadap nilai terbesar; angka aslinya WAJIB ditulis di `<b>` dan di `aria-label`.

### Daftar sumber

Sumber yang sengaja tidak dibuka (tidak tersedia, atau dilarang di tugas itu) tetap dicatat dengan tier `—` dan `<span class="pill muted">Tidak dibuka</span>`, dengan sebabnya; `pill danger` hanya untuk yang dicoba dan gagal.

```html
<div class="table-scroll"><table>
  <thead><tr><th>ID</th><th>Klaim</th><th>Tier</th><th>Sumber</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td class="id">E1</td><td>Klaim</td><td class="n">0</td><td><code>app/Services/X.php:42</code></td><td><span class="pill ok">Terverifikasi</span></td></tr>
    <tr><td class="id">E2</td><td>Klaim</td><td class="n">—</td><td>halaman vendor</td><td><span class="pill danger">Gagal (403)</span></td></tr>
  </tbody>
</table></div>
```

---

## 4. Anti-Pattern

**Anti-Pattern 1: kartu untuk segalanya.** Sepuluh kartu berisi satu kalimat masing-masing lebih sulit dipindai daripada satu tabel. Kartu untuk dua sampai empat hal setara.

**Anti-Pattern 2: callout bertumpuk.** Tiga callout berurutan membuat tidak ada satu pun yang menonjol. Satu per bagian; sisanya paragraf.

**Anti-Pattern 3: pill sebagai kalimat.** "Menunggu persetujuan dari tim HRD minggu depan" bukan pill. Pill dua sampai tiga kata, sisanya di sel sebelahnya.

**Anti-Pattern 4: tile untuk angka lunak.** Tile membuat angka terlihat pasti. Perkiraan dan angka tanpa sumber ditulis di kalimat dengan kata "sekitar" dan labelnya.

**Anti-Pattern 5: menyunting blok gaya untuk satu kebutuhan.** `check` akan gagal, dan dokumen berikutnya tidak mewarisinya. Tambahkan ke galeri, atau pakai `page-style`.

---

## 5. Edge Case

**Edge Case 1: tabel sangat lebar.** `.table-scroll` memberi geser mendatar, tapi tabel sepuluh kolom tetap tidak terbaca. Pecah jadi dua tabel atau pindahkan kolom jarang ke `details`.

**Edge Case 2: dokumen dibuka tanpa internet.** Font jatuh ke font sistem dan diagram tampil sebagai teks. Isi tetap terbaca; jangan menaruh informasi yang hanya ada di dalam diagram.

**Edge Case 3: dua daftar periksa dengan `data-store` sama.** Keduanya berbagi centang. Beri nama berbeda.

**Edge Case 4: berkas dipindah atau diganti nama.** Centang dan tema disimpan per path berkas, jadi keduanya hilang. Sebutkan ini ke user sebelum memindahkan dokumen yang sedang dipakai untuk pelacakan.

**Edge Case 5: dokumen dicetak.** Daftar isi, toolbar, dan tombol salin disembunyikan. Isi `details` yang tertutup tidak ikut tercetak; buka dulu yang perlu.

**Edge Case 6: gambar di luar berkas.** `img src` relatif putus saat HTML dikirim sendirian. Untuk dokumen yang akan dikirim, sematkan gambar kecil sebagai data URI atau kirim satu folder.
