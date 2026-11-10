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

`id` huruf kecil tanpa spasi. Nomor dua digit berurutan dari `00`. Label daftar isi yang lebih pendek dari judul: tambahkan `data-toc-label="Masalah"` pada `section`.

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

<div class="card decision">
  <div><h4>K1 · Pertanyaannya?</h4><p>Bawaan yang diusulkan dan dampaknya.</p></div>
  <span class="pill warn">Menunggu jawaban</span>
</div>

<dl class="kv">
  <div><dt>Pemilik</dt><dd>Tim HRIS</dd></div>
  <div><dt>Di luar cakupan</dt><dd>Pembayaran otomatis.</dd></div>
</dl>
```

`AGENTS.md` §4 mewajibkan tiga kelebihan dan tiga kekurangan per opsi serta pembatalnya. Komponen `.option` disusun untuk itu.

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

### Daftar sumber

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
