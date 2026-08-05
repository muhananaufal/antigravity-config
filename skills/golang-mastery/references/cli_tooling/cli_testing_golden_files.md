# Menguji CLI — Golden File, `testscript`, dan Keluaran Deterministik

> **Berlaku:** Go 1.21+ · `rogpeppe/go-internal/testscript` v1.12+ · **Lihat juga:** `cli_tooling/cobra_command_architecture.md` · `testing_quality/e2e_testing_patterns.md` · `testing_quality/unit_testing_testify.md`

## Konsep Utama

Sebagian besar tim menguji CLI dengan satu cara: skrip shell yang menjalankan biner lalu memeriksa keluarannya dengan `grep`. Lambat, rapuh, hanya berjalan di Linux, dan ketika gagal ia cuma bilang "tidak cocok" tanpa menunjukkan apa.

Ada tiga lapis yang masing-masing punya tugas berbeda:

| Lapis | Menguji apa | Kecepatan | Porsi yang wajar |
| :--- | :--- | :--- | :--- |
| **Unit domain** | Logika bisnis, tanpa CLI sama sekali | mikrodetik | ~80% |
| **Perintah in-process** | Parsing flag, jahitan, format keluaran | mikrodetik | ~18% |
| **`testscript` end-to-end** | Biner sungguhan, kode keluar, interaksi berkas | milidetik | ~2% |

Yang paling sering terlewat adalah lapis tengah. Dengan `cmd.SetArgs` + `cmd.SetOut`, seluruh CLI bisa dijalankan **di dalam proses test** tanpa `exec` — secepat unit test biasa.

### Golden file: alat tajam bermata dua

Golden file menyimpan keluaran yang diharapkan sebagai berkas terpisah, lalu test membandingkannya. Nilainya besar untuk keluaran panjang: diff-nya bisa dibaca, dan perubahan format terlihat jelas di review PR.

Tapi ada satu jebakan yang menghancurkan seluruh manfaatnya:

> Flag `-update` membuat "memberkati keluaran baru" jadi satu perintah. Ketika sebuah test gagal, jalan termudah adalah menjalankan `-update` dan melanjutkan hidup — **tanpa membaca apa yang berubah**. Golden file berubah dari alat verifikasi menjadi stempel otomatis.

Pertahanannya bukan teknis melainkan proses: **perubahan golden file WAJIB terlihat di diff PR dan wajib dibaca reviewer.** Karena itu golden file harus kecil dan fokus. Golden 800 baris tidak akan pernah dibaca siapa pun.

### Determinisme adalah syarat, bukan bonus

Keluaran CLI sering memuat hal yang berubah tiap jalan. Semuanya WAJIB dinormalisasi sebelum dibandingkan:

| Sumber ketidakstabilan | Penanganan |
| :--- | :--- |
| Timestamp | Suntikkan jam palsu, atau ganti pola tanggal jadi `<WAKTU>` |
| Path absolut / direktori sementara | Ganti dengan `<TMP>` |
| Durasi (`selesai dalam 1.23s`) | Ganti dengan `<DURASI>` |
| Warna ANSI | Matikan saat bukan TTY, dan lucuti saat membandingkan |
| Urutan iterasi map | Urutkan sebelum mencetak — **bukan** saat membandingkan |
| Akhir baris Windows | Normalkan `\r\n` jadi `\n` |

## Diagram ASCII

```text
   PIRAMIDA UJI CLI — berat di bawah, tipis di atas

           /\
          /  \      testscript (~2%)
         /____\     biner nyata, kode keluar, sistem berkas
        /      \
       /        \   perintah in-process (~18%)
      /__________\  SetArgs + SetOut, tanpa exec, secepat unit
     /            \
    /              \ unit domain (~80%)
   /________________\ tanpa cobra, tanpa I/O

   Terbalik? Suite lambat, rapuh, dan pesan gagalnya tidak menunjuk
   ke penyebab. Kegagalan e2e cuma bilang "keluaran beda".

   ---------------------------------------------------------------

   ALUR GOLDEN FILE

   test jalan ---> keluaran mentah
                        |
                        v
                  NORMALISASI          <-- WAJIB, kalau tidak selalu gagal
                  waktu -> <WAKTU>
                  path  -> <TMP>
                  ANSI  -> dilucuti
                        |
             +----------+----------+
             |                     |
        -update?               bandingkan
             |                     |
             v                     v
      tulis testdata/         cocok? LULUS
      x.golden                beda?  cetak diff
             |
             `-> WAJIB terbaca di diff PR
                 Golden yang tidak pernah dibaca = test yang tidak menguji
```

## Kode Go Production-Ready

```go
package clitest

import (
	"bytes"
	"flag"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// update dikendalikan lewat `go test -update`. Sengaja dibuat eksplisit
// agar pembaruan golden adalah tindakan sadar, bukan kebiasaan.
var update = flag.Bool("update", false, "tulis ulang berkas golden")

// normalisasi mengubah bagian keluaran yang tidak stabil menjadi penanda tetap.
// Tanpa ini, golden file akan gagal di mesin lain atau di menit berikutnya.
var (
	reWaktuRFC3339 = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})`)
	reDurasi       = regexp.MustCompile(`\b\d+(\.\d+)?(ns|µs|ms|s|m|h)\b`)
	reANSI         = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)
	reHexID        = regexp.MustCompile(`\b[0-9a-f]{32}\b`)
)

// Normalizer mengubah keluaran mentah menjadi bentuk yang bisa dibandingkan.
type Normalizer struct {
	// TmpDir diganti dengan <TMP>. Kosongkan bila tidak relevan.
	TmpDir string
	// Ekstra memungkinkan test menambah aturan khusus miliknya.
	Ekstra []func(string) string
}

// Bersihkan menerapkan seluruh normalisasi secara berurutan.
func (n Normalizer) Clean(s string) string {
	// Akhir baris duluan, agar regex di bawah tidak perlu memikirkannya.
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = reANSI.ReplaceAllString(s, "")
	if n.TmpDir != "" {
		s = strings.ReplaceAll(s, n.TmpDir, "<TMP>")
		// Bentuk yang sudah diselesaikan symlink (macOS: /private/var/...)
		if resolved, err := filepath.EvalSymlinks(n.TmpDir); err == nil {
			s = strings.ReplaceAll(s, resolved, "<TMP>")
		}
	}
	s = reWaktuRFC3339.ReplaceAllString(s, "<TIME>")
	s = reDurasi.ReplaceAllString(s, "<DURATION>")
	s = reHexID.ReplaceAllString(s, "<ID>")
	for _, f := range n.Ekstra {
		s = f(s)
	}
	// Spasi di akhir baris tidak terlihat mata tapi merusak perbandingan.
	lines := strings.Split(s, "\n")
	for i := range lines {
		lines[i] = strings.TrimRight(lines[i], " \t")
	}
	return strings.TrimRight(strings.Join(lines, "\n"), "\n") + "\n"
}

// Golden membandingkan hasil dengan berkas testdata/<nama>.golden.
// Nama berkas diturunkan dari nama test agar tidak perlu diketik manual.
func Golden(t *testing.T, n Normalizer, result string) {
	t.Helper()
	name := strings.ReplaceAll(t.Name(), "/", "_") + ".golden"
	path := filepath.Join("testdata", name)
	clean := n.Clean(result)

	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatalf("buat testdata: %v", err)
		}
		if err := os.WriteFile(path, []byte(clean), 0o644); err != nil {
			t.Fatalf("tulis golden: %v", err)
		}
		t.Logf("golden diperbarui: %s — WAJIB dibaca di diff PR", path)
		return
	}

	want, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			t.Fatalf("golden %s belum ada. Run: go test -run %s -update", path, t.Name())
		}
		t.Fatalf("baca golden: %v", err)
	}

	if got := clean; got != string(want) {
		t.Errorf("keluaran tidak cocok dengan %s\n%s", path, diffBaris(string(want), got))
	}
}

// diffBaris menghasilkan diff sederhana per baris. Pesan gagal yang hanya
// mencetak dua blok panjang membuat orang malas membacanya.
func diffBaris(want, got string) string {
	w := strings.Split(want, "\n")
	g := strings.Split(got, "\n")
	var b bytes.Buffer
	max := len(w)
	if len(g) > max {
		max = len(g)
	}
	for i := 0; i < max; i++ {
		var lw, lg string
		if i < len(w) {
			lw = w[i]
		}
		if i < len(g) {
			lg = g[i]
		}
		switch {
		case lw == lg:
			// baris sama, lewati agar diff tetap pendek
		case lw == "":
			b.WriteString("+ " + lg + "\n")
		case lg == "":
			b.WriteString("- " + lw + "\n")
		default:
			b.WriteString("- " + lw + "\n+ " + lg + "\n")
		}
	}
	return b.String()
}
```

Uji end-to-end biner sungguhan dengan `testscript`:

```go
package main

import (
	"os"
	"testing"

	"github.com/rogpeppe/go-internal/testscript"
)

// TestMain mendaftarkan biner CLI agar bisa dipanggil dari skrip
// TANPA proses eksternal — testscript menjalankannya di dalam proses test.
func TestMain(m *testing.M) {
	os.Exit(testscript.RunMain(m, map[string]func() int{
		"katalog": func() int { return runCLI() },
	}))
}

func TestScript(t *testing.T) {
	testscript.Run(t, testscript.Params{
		Dir: "testdata/skrip",
		Setup: func(e *testscript.Env) error {
			e.Setenv("KATALOG_DB_HOST", "memori")
			return nil
		},
	})
}
```

`testdata/skrip/list.txtar`:

```text
# daftar produk mengembalikan JSON valid dan kode keluar 0
exec katalog produk list --format json
stdout '"sku": "A-1"'
! stderr .

# format tak dikenal gagal dengan kode keluar 2
! exec katalog produk list --format xml
stderr 'format "xml" tidak dikenal'

# konfigurasi dari berkas terbaca
exec katalog config debug
stdout 'db.host   = memori-db\s+<- berkas'

-- config.yaml --
db:
  host: memori-db
```

## Uji

```go
package clitest

import (
	"strings"
	"testing"
)

func TestNormalizer_WaktuDanDurasi(t *testing.T) {
	n := Normalizer{}
	in := "selesai pada 2026-08-05T10:04:00Z dalam 1.234s\n"
	got := n.Clean(in)
	want := "selesai pada <TIME> dalam <DURATION>\n"
	if got != want {
		t.Fatalf("mau %q, dapat %q", want, got)
	}
}

func TestNormalizer_ANSIDilucuti(t *testing.T) {
	n := Normalizer{}
	in := "\x1b[31mfailed\x1b[0m\n"
	if got := n.Clean(in); got != "failed\n" {
		t.Fatalf("ANSI must be stripped, got %q", got)
	}
}

func TestNormalizer_PathSementara(t *testing.T) {
	dir := t.TempDir()
	n := Normalizer{TmpDir: dir}
	in := "writing to " + dir + "/output.json\n"
	if got := n.Clean(in); got != "writing to <TMP>/output.json\n" {
		t.Fatalf("path must be normalized, got %q", got)
	}
}

func TestNormalizer_CRLFDanSpasiAkhir(t *testing.T) {
	n := Normalizer{}
	in := "lines satu   \r\nbaris dua\t\r\n"
	want := "lines satu\nbaris dua\n"
	if got := n.Clean(in); got != want {
		t.Fatalf("mau %q, dapat %q", want, got)
	}
}

func TestNormalizer_AturanEkstra(t *testing.T) {
	n := Normalizer{Ekstra: []func(string) string{
		func(s string) string { return strings.ReplaceAll(s, "v1.2.3", "<VERSI>") },
	}}
	if got := n.Clean("katalog v1.2.3\n"); got != "katalog <VERSI>\n" {
		t.Fatalf("aturan ekstra tidak jalan, dapat %q", got)
	}
}

func TestLineDiff_HanyaMenampilkanYangBerbeda(t *testing.T) {
	d := diffBaris("a\nb\nc\n", "a\nX\nc\n")
	if strings.Contains(d, "a") || strings.Contains(d, "c") {
		t.Fatalf("lines identik tidak boleh muncul di diff:\n%s", d)
	}
	if !strings.Contains(d, "- b") || !strings.Contains(d, "+ X") {
		t.Fatalf("diff tidak menunjukkan perubahan:\n%s", d)
	}
}
```

## Anti-Pattern

**❌ SALAH — golden file memuat nilai yang berubah tiap jalan**

```text
testdata/list.golden:
Dijalankan pada 2026-08-05T10:04:00Z
Berkas sementara: /tmp/TestList2847193/output.json
Selesai dalam 1.234s
```

Test ini gagal pada detik berikutnya, di mesin lain, dan di CI. Tim akan menjalankan `-update` berulang kali sampai akhirnya menonaktifkan test-nya.

**✅ BENAR — dinormalisasi sebelum dibandingkan**

```text
testdata/list.golden:
Dijalankan pada <WAKTU>
Berkas sementara: <TMP>/output.json
Selesai dalam <DURASI>
```

**❌ SALAH — `-update` sebagai refleks**

```bash
# Test gagal? Jalankan ini, lanjut hidup.
go test ./... -update && git commit -am "perbaiki test"
```

Golden file berhenti menguji apa pun. Regresi format keluaran akan lolos ke rilis, dan pengguna yang punya skrip parsing akan menemukannya lebih dulu daripada Anda.

**✅ BENAR — perbarui dengan sengaja, baca diff-nya**

```bash
go test ./... -update
git diff testdata/         # WAJIB dibaca, bukan dilewati
# Perubahan tidak disengaja? Batalkan, jangan di-commit.
```

Perkuat dengan gate CI:

```yaml
- name: Golden tidak boleh berubah tanpa sengaja
  run: |
    go test ./... -update
    git diff --exit-code testdata/ || {
      echo "Golden berubah tapi tidak ikut di-commit."; exit 1; }
```

**❌ SALAH — golden file raksasa**

```text
testdata/full_output.golden   — 1.240 baris
```

Diff-nya tidak akan pernah dibaca. Perubahan satu karakter tenggelam di antara ribuan baris identik.

**✅ BENAR — golden kecil dan fokus, satu per perilaku**

```text
testdata/TestProdukList_Table.golden      — 8 baris
testdata/TestProdukList_JSON.golden       — 12 baris
testdata/TestProdukList_Kosong.golden     — 2 baris
```

**❌ SALAH — menguji logika bisnis lewat lapisan CLI**

```go
func TestDiskonBerlaku(t *testing.T) {
	out, _, _ := run(t, app, "produk", "harga", "--sku", "A-1", "--kupon", "HEMAT10")
	if !strings.Contains(out, "10800") { // rapuh, lambat, tidak jelas
		t.Fatal("diskon salah")
	}
}
```

**✅ BENAR — logika diuji di domain, CLI diuji sebagai adaptor**

```go
func TestHitungDiskon(t *testing.T) {
	got := HitungDiskon(12000, Kupon{Persen: 10})
	if got != 10800 {
		t.Fatalf("mau 10800, dapat %d", got)
	}
}
```

## Kasus Tepi Produksi

1. **Warna ANSI muncul di CI tapi tidak di lokal, atau sebaliknya.** Pustaka warna mendeteksi TTY, dan perilakunya berbeda saat keluaran di-pipe. Matikan warna secara eksplisit di test (`NO_COLOR=1` atau flag `--no-color`), **dan** tetap lucuti ANSI saat normalisasi sebagai jaring pengaman.

2. **Urutan iterasi map bocor ke keluaran.** Go mengacak urutan map dengan sengaja. Urutkan **di kode produksi** sebelum mencetak, bukan di normalizer — karena pengguna juga berhak mendapat keluaran yang stabil, bukan hanya test.

3. **Akhir baris di Windows.** `git` dengan `core.autocrlf=true` mengubah berkas golden saat checkout, membuat test gagal di Windows padahal lulus di Linux. Pasang `*.golden -text` di `.gitattributes` **dan** normalkan `\r\n` di kode.

4. **Format bergantung lokal.** Pemisah desimal dan format tanggal bisa berubah mengikuti `LC_ALL`. Setel lokal tetap di test, dan pertimbangkan apakah CLI Anda memang seharusnya peka lokal — untuk keluaran yang dibaca mesin, jawabannya hampir selalu tidak.

5. **`testscript` dan cakupan kode.** Karena `RunMain` menjalankan biner di dalam proses test, cakupannya ikut terhitung — berbeda dari `exec.Command` yang cakupannya hilang. Ini alasan tambahan memilih `testscript` daripada skrip shell.

6. **Golden file yang tidak pernah gagal.** Bila sebuah golden tidak pernah berubah selama setahun sementara kodenya aktif berubah, curigai test-nya tidak benar-benar dijalankan, atau keluarannya sudah dinormalisasi sampai tidak menyisakan informasi apa pun.

## Kapan JANGAN Pakai Ini

- **Untuk logika yang seharusnya unit test.** Golden file menguji **bentuk keluaran**, bukan kebenaran perhitungan. Kalau yang ingin dipastikan adalah nilainya, uji fungsinya langsung.
- **Ketika keluaran memang sengaja tidak stabil.** Progres bar, spinner, dan animasi tidak layak digolden. Uji keberadaannya, bukan isinya.
- **Untuk keluaran yang sangat panjang.** Di atas ~50 baris, diff berhenti bermakna. Pecah jadi beberapa golden fokus, atau bandingkan hanya bagian yang relevan.
- **Sebagai satu-satunya lapis pengujian.** Golden file tidak menangkap kebocoran memori, race condition, atau kegagalan pada masukan yang tidak Anda pikirkan. Tetap perlu unit test dan `-race`.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Golden sering berubah di PR yang tidak menyentuh keluaran | `git log --stat -- testdata/` | Normalisasi kurang; ada nilai tak stabil yang lolos |
| Test lulus lokal, gagal di CI | bandingkan keluaran mentah keduanya | Warna, lokal, akhir baris, atau path yang berbeda |
| PR selalu memuat `-update` di pesan commit | cari kata "update golden" di riwayat | Golden jadi stempel; regresi tidak lagi tertangkap |
| Skrip pengguna rusak setelah rilis | keluhan tentang parsing | Format keluaran berubah tanpa disadari — golden terlalu longgar |
| Suite test CLI berjalan lebih dari satu menit | `go test -v` diurutkan durasi | Terlalu banyak e2e; pindahkan ke lapis in-process |

```bash
# Golden yang tidak pernah berubah padahal kodenya berubah
for f in testdata/*.golden; do
  echo "$(git log -1 --format=%ar -- "$f")  $f"
done | sort -r

# Nilai tak stabil yang lolos ke golden
grep -lE '[0-9]{4}-[0-9]{2}-[0-9]{2}T|/tmp/|[0-9]+\.[0-9]+(ms|s)\b' testdata/*.golden

# Golden yang terlalu besar untuk direview
wc -l testdata/*.golden | sort -rn | head

# Pastikan golden konsisten lintas platform
git check-attr text -- testdata/*.golden | grep -v 'text: unset' && \
  echo "PERINGATAN: pasang '*.golden -text' di .gitattributes"
```
