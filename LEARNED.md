# Learned

Pelajaran yang sudah dibayar mahal. WAJIB dibaca sebelum task teknis (§3.1 `AGENTS.md`), WAJIB ditambah saat user mengoreksi atau saat mekanisme meleset dari dugaan (§9).

**Aturan menulis:** satu baris per pelajaran — fakta, lalu konsekuensinya. DILARANG naratif. Lewat 80 baris → konsolidasikan yang serupa, jangan biarkan tumbuh liar.

---

## Mekanisme yang TIDAK ADA — jangan dicoba lagi

- Antigravity **tidak mengekspansi `@import`** di `AGENTS.md`; aturan WAJIB ditulis literal. Agent malah `view_file` mengikuti path secara manual, sehingga aturan mati di task yang tidak memicu pembacaan berkas.
- **`~/.gemini/config/rules/` tidak dimuat otomatis.** String `Location: "rules/"` di `language_server.exe` hanya berlaku untuk rule milik plugin.
- `AGENTS.md` literal adalah **satu-satunya** mekanisme rules global Antigravity.
- ❓ Belum terjawab: apakah `hooks.json` global cukup sendiri, atau wajib `.agents/hooks.json` per-proyek. Penanda pasif terpasang di `stop_gate_antigravity.ps1`; cek `%TEMP%\agy_stop_hook_marker.txt`.

## Cara verifikasi yang sahih

- **Transcript Antigravity TIDAK merekam system prompt maupun keluaran hook.** Menghitung kata kunci di sana menyesatkan — 6 kali memberi vonis salah dalam satu sesi.
- Yang sahih hanya tiga: **argumen `tool_calls`**, **teks `PLANNER_RESPONSE`**, dan **perubahan nyata di disk**.
- Transcript memuat hasil `view_file` dari berkas aturan itu sendiri → kata seperti `implementation_plan` dan `php artisan test` terhitung padahal cuma dibaca.
- **Model Antigravity bernalar dalam bahasa Inggris** meski aturannya Bahasa Indonesia. Cari "small project", bukan "kecil".
- Agent sering bertanya lewat **teks biasa**, bukan tool `ask_question`. Jangan pakai keberadaan tool sebagai bukti.
- Ubah `hooks.json` / `settings.json` → **WAJIB restart**. Bandingkan `(Get-Process).StartTime` vs waktu tulis berkas **SEBELUM** menyimpulkan apa pun. Tiga tes gagal karena ini.
- Aturan lapis pertama sering mencegah pelanggaran lahir, sehingga gate tidak punya mangsa. Untuk menguji gate, **tanam pelanggarannya sendiri**, jangan minta agent membuatnya.
- **Layout PDF bisa diukur objektif, jangan dinilai dari tampilan.** Render dengan `output(["compress" => false])` lalu baca content stream-nya sebagai teks: operator `x y Td ... [(teks)] TJ` memberi posisi teks, `w 0 0 h x y cm /Im1 Do` memberi posisi+ukuran gambar. Origin PDF di kiri-BAWAH, jadi `gap_atas = tinggi_halaman - y`. Untuk konfirmasi mata, render PNG lewat `$options->setPdfBackend("GD")`. Tanpa ini, "gap-nya sudah cukup belum" cuma jadi debat rasa.
- **Tooling untuk mengukur PDF cukup yang sudah ada — tidak perlu library parser.** Skrip PHP polos + `preg_match_all` sudah cukup membaca content stream; `pdftoppm`/poppler TIDAK tersedia di Windows dev box ini, jadi jangan mengandalkannya. Untuk render view Blade dengan data produksi tanpa lewat HTTP/login, pakai `php artisan tinker --execute="require '<skrip>';"` lalu `view(...)->render()` + `Auth::loginUsingId()`. Jalankan dari dalam `public/` bila view memakai `file_exists('storage/...')` relatif, kalau tidak aset (cover/watermark/kop) diam-diam tidak ter-render dan hasil ukurannya menyesatkan.
- **Gambar via `data:` URI menghapus seluruh kelas bug path saat menguji renderer.** Isu `setChroot` + path Windows bikin dompdf menaruh ikon "broken image" 9x13pt yang mengacaukan pengukuran layout, dan gejalanya mirip masalah CSS. `base64_encode(file_get_contents(...))` mengisolasi variabelnya.
- **Baca source library SEBELUM coba-coba CSS/konfigurasi.** Membaca `vendor/dompdf/dompdf/src/` (`FrameReflower/Page.php`, `Positioner/Fixed.php`, `Css/Style.php`) yang menemukan akar masalah; trial-and-error hanya akan menghasilkan kesimpulan salah "@page tidak didukung dompdf" lalu buntu. Berlaku umum: untuk library terpasang, source-nya ADA di disk dan lebih sahih daripada dokumentasi maupun hafalan.
- **Ukur metrik PENDAMPING, bukan cuma metrik yang sedang diperbaiki.** Saat membetulkan gap halaman PDF, patch cover saya gagal diam-diam (deklarasi `margin:0px` di dalam blok menimpa sisipan di awal blok). Gap-nya justru terlihat MEMBAIK; yang membongkar kegagalan adalah jumlah halaman berubah 5 -> 6. Kalau saya hanya memantau angka yang sedang saya perbaiki, saya sudah lapor sukses sambil merusak hal lain.

## Desain gate

- Gate yang memblokir **utang lama** di berkas yang tidak disentuh membuat **setiap repo legacy mustahil dikerjakan**, dan bertabrakan dengan §4 yang melarang memperbaiki di luar scope. WAJIB ratchet: blokir hanya pelanggaran di baris baru.
- Detektor secret berbasis **nama variabel** bisa dibutakan cukup dengan mengganti nama. WAJIB juga mencocokkan **bentuk nilai** (`sk_live_`, `AKIA`, `ghp_`, URI berkredensial).
- Mode FAST **DILARANG** memindai direktori non-git — tanpa pagar ini, hook menyisir seluruh home directory tiap akhir giliran.
- Hook WAJIB **fail-open** dan berpagar anti-loop. Exit code bukan nol tapi tanpa rincian pelanggaran = gate-nya yang error, bukan kodenya.

## Jebakan PowerShell 5.1 & Windows

- `-ne` untuk string bersifat **case-insensitive** → `"Wajib" -ne "WAJIB"` bernilai `$false`. Pakai `-cne`.
- `Write-Output` di dalam fungsi **mencemari nilai balik**; string informasinya dikira data. Pakai `Write-Host`.
- Melempar **string kosong** ke parameter membuat PowerShell membuang argumennya → error "Missing an argument".
- Berkas `.ps1` WAJIB **ASCII murni**. PowerShell 5.1 salah membaca UTF-8 tanpa BOM pada skrip.
- Berkas `.md` WAJIB **UTF-8 tanpa BOM**. `Set-Content`/`Out-File` bawaan merusaknya; pakai `[IO.File]::WriteAllText` + `UTF8Encoding($false)`.
- **Kutip ganda di pesan `git commit -m`** dipecah jadi argumen terpisah. Pakai `git commit -F <berkas>`.
- Glob `*_protocol*` ikut mencocoki `networking_protocols_grpc`. Periksa hasil filter path sebelum menulis massal.
- **Operator `&&` tidak valid** di PowerShell 5.1 → error "The token '&&' is not a valid statement separator". Pakai `;` atau jalankan perintah secara terpisah.

## Proses

- Menguji skrip secara terpisah ≠ menguji sambungannya. Bug false-block hanya muncul saat dijalankan dengan **argv persis** dari `settings.json`.
- Dokumentasi resmi bisa menjanjikan mekanisme yang tidak ada di build terpasang. **Uji sebelum mengandalkan.**

## Proses (lanjutan)

- **Metrik hijau bukan berarti benar.** Membaca `AGENTS.md` utuh dari atas ke bawah setelah belasan suntingan parsial membongkar 5 cacat yang lolos SEMUA pengukuran: rujukan basi ke section yang sudah dikosongkan, aturan yang saling meniadakan antar-section, presedensi baris tabel yang ambigu, dan macro yang tidak tahu jalur baru. WAJIB baca utuh sekali setelah rangkaian edit besar.
- Memindahkan isi section jadi skill WAJIB diikuti sapuan rujukan ke section itu — glosarium dan berkas lain bisa masih menunjuk ke tempat yang sudah kosong.
- Menambah baris di daftar bernomor menggeser SEMUA rujukan `§n.m` sesudahnya. Periksa lintas berkas, bukan hanya berkas yang disunting.
- **Rujukan valid ≠ terjangkau.** Semua rujukan di `SKILL.md` bisa resolve 100% sementara 19% direktori referensi tidak pernah disebut sama sekali — jadi tak punya jalan masuk. Audit yang benar: bandingkan direktori yang ADA di disk vs yang DIRUJUK, bukan sebaliknya.
- Struktur antar-skill sejenis bisa diam-diam berbeda. `golang`/`nestjs` punya tabel Core References, `rust`/`laravel` hanya punya tabel Niche — 129 berkas jadi mati. Bandingkan kerangka antar-skill, jangan periksa satu per satu terpisah.
- `nestjs` sempat tidak punya `_protocol/brownfield.md` padahal §2 memerintahkan membacanya. Aturan yang menunjuk berkas WAJIB diverifikasi berkasnya ada di SEMUA skill, bukan cuma di satu contoh.

## Proses (retrofit korpus)

- **Perkiraan cakupan WAJIB diukur, bukan ditaksir.** Saya menyusun "Prioritas 5: retrofit ~30 berkas" tanpa menghitung. Angka nyatanya 198 dari 215. Satu perintah pengukuran di awal akan mengubah seluruh rencana dan ekspektasi user. Ukur dulu, baru janjikan.
- Retrofit format lintas ratusan berkas jauh lebih aman lewat **skrip idempoten + berkas bundle** daripada Edit satu per satu: bisa dry-run, bisa diulang tanpa efek ganda, dan encoding UTF-8-tanpa-BOM ditangani di satu tempat.
- Verifikasi setiap batch WAJIB mencakup tiga hal sekaligus: cross-link resolve, nol BOM, dan nol U+FFFD. Yang ketiga sempat memberi alarm palsu — `security_fuzzing_go.md` memang sengaja mencetak karakter pengganti sebagai contoh. **Periksa riwayat git sebelum menyimpulkan kerusakan.**
- `Get-Content` PS 5.1 menampilkan UTF-8 sebagai mojibake (`Â·`) walau berkasnya benar. Verifikasi encoding WAJIB lewat `[IO.File]::ReadAllBytes` + cek byte, bukan lewat mata di konsol.

## Konvensi Kode & Framework

- Saat mengecek atau membuat direktori upload di CodeIgniter, WAJIB sesuaikan dengan pola model konvensi proyek: gunakan path absolut `FCPATH . 'uploads/...'` dan hak akses `0755`, bukan path relatif (`./`) atau `0777`.
- Pada custom error message `form_validation` di CodeIgniter, placeholder `%s` akan digantikan oleh nama label (bukan nilai input). DILARANG menulis ulang label di depan `%s` karena menghasilkan teks ganda (contoh: `"NIP %s"` menjadi `"NIP NIP"`).
- **Satu sinyal bukan pengukuran.** Saya melaporkan "20 berkas tanpa diagram" berdasarkan pencarian fence ```text saja. Angka sebenarnya 4 — sisanya memakai fence polos atau judul berbeda. Selisihnya 5x, dan saya sudah menyampaikannya ke user sebagai temuan. Sebelum melaporkan angka sebagai defect, uji detektornya pada berkas yang DIKETAHUI punya properti itu.
- Audit cakupan berbeda dari audit struktur. Empat dimensi format bisa 100% sementara core domain kehilangan topik yang pasti kepakai (error handling, OAuth/OIDC, CORS, pagination). Yang menemukannya bukan pengukuran struktur, tapi mendaftar isi tiap domain lalu bertanya "apa yang ditanyakan wawancara senior dan tidak ada di sini".
- Menandai seluruh domain sebagai Core ("semua") tanpa memeriksa isinya membuat agent membaca berkas niche di setiap proyek. `devops_control_planes` punya 5 dari 8 berkas niche. Core WAJIB menyebut berkas, bukan direktori, kecuali seluruh isinya memang selalu relevan.
- **§8 "istilah teknis tetap bahasa aslinya" berlaku untuk IDENTIFIER & STRING LOGGING/ERROR, bukan cuma jargon di prosa.** Saya sempat membiarkan string galat (`fmt.Errorf("gagal...")`) dan log message berbahasa Indonesia di dalam kode. Mesin observabilitas (Datadog/CloudWatch/Grafana) mengandalkan pola regex bahasa Inggris, dan error chain Go tercampur-aduk jika string error lokal. KODE WAJIB 100% BAHASA INGGRIS: identifier (fungsi/tipe/field/variabel/tag JSON/slog keys) DAN seluruh string literal kode (log, error wrapping `fmt.Errorf`, assertion `t.Fatalf`, panic). Bahasa Indonesia HANYA BOLEH berada di komentar (`// ...`) dan teks narasi Markdown di luar blok kode.

- **Berkas tulisan sendiri tetap wajib diaudit dengan standar yang sama.** Audit manual `observability_resilience` menemukan dua kekeliruan faktual di `continuous_profiling.md` yang saya tulis sendiri beberapa sesi sebelumnya: klaim label pprof tidak diwariskan ke goroutine anak (justru diwariskan lewat runtime, dan konsekuensinya terbalik), dan klaim `-ldflags "-s -w"` menghilangkan simbol profil (pclntab tidak dihapus; yang terdampak agen eBPF di luar proses). Mengecualikan berkas sendiri dari audit = mengekalkan kesalahan yang paling sulit ditemukan orang lain.

## Dompdf (PDF rendering)

- **Di dompdf, selector `html` ADALAH page box** (`lib/res/html.css`: `html { display: -dompdf-page !important }`). Akibatnya `html { margin: 0 }` menimpa `@page { margin }` dan membuat margin halaman diabaikan tanpa error. Gejalanya: `@page` terlihat "tidak berfungsi" berapa pun nilainya. Reset CSS untuk dokumen PDF WAJIB menulis `body { margin: 0 }` saja, JANGAN `html, body { margin: 0 }`.
- **Padding pada block tidak bisa memberi jarak per-halaman.** Padding hanya dipakai sekali di awal block; saat block-nya split, halaman lanjutan mentok ke tepi area konten. Jarak yang harus hadir di SETIAP halaman WAJIB lewat `@page { margin }` — itu satu-satunya yang di-apply ulang tiap halaman (`FrameReflower/Page.php`, `apply_page_style` dipanggil di dalam loop halaman).
- **Dompdf 1.2.2 tidak mengenal unit `vw`/`vh`.** Unit tak dikenal di-fallback ke `$ref_size` (= dimensi containing block) di `Style::length_in_pt`, sehingga `width:100vw` kebetulan berperilaku seperti `100%`. Begitu `@page` diberi margin, "100vw" ikut menyusut mengikuti area konten. Untuk elemen full-bleed, tulis ukuran absolut dalam pt.
- **Elemen `position: fixed` diposisikan relatif terhadap area konten** (page box dikurangi margin `@page`), lihat `AbstractFrameReflower::determine_absolute_containing_block` case `"fixed"`. Untuk full-bleed, beri offset negatif sebesar margin `@page`.
- **`@page :first { margin: 0 }` didukung, tapi merusak elemen fixed.** Fixed frame di-deep_copy dari halaman 1 (`FrameReflower/Page.php`), jadi kalau halaman 1 punya margin berbeda, watermark bergeser di halaman 2. Terukur: geser -26.2pt. Pakai margin `@page` seragam + margin negatif pada elemen cover, bukan `:first`.
- **Untuk mengukur layout PDF, parse `/Type /Pages` -> `/Kids` untuk urutan halaman.** Mencocokkan `stream...endstream` secara buta ikut menangkap data gambar biner sebagai "halaman", dan urutan objek `/Type /Page` TIDAK sama dengan urutan halaman. Render dengan `output(['compress' => false])` supaya content stream terbaca.
