# Code Review Go — Taksonomi, Umpan Balik, dan Penegakan Otomatis

> **Berlaku:** Go 1.21+ · `golang.org/x/tools` untuk `go/analysis` · **Lihat juga:** `engineering_practice/adr_decision_records.md` · `testing_quality/unit_testing_testify.md` · `concurrency/goroutine_leak_detection.md`

## Konsep Utama

Code review yang buruk memakan waktu tanpa menaikkan mutu. Dua penyebabnya hampir selalu sama: **reviewer mendebatkan hal yang seharusnya dikerjakan mesin**, dan **komentar tidak menyatakan bobotnya**, sehingga penulis tidak tahu mana yang wajib dan mana yang selera.

Aturan pemisahan yang WAJIB dipegang:

> Kalau sebuah aturan bisa ditulis sebagai linter, **DILARANG** dibahas di review. Manusia mahal; pakai mereka untuk hal yang tidak bisa diotomatiskan.

| Lapis | Ditegakkan oleh | Contoh |
| :--- | :--- | :--- |
| Format | `gofmt`, `gofumpt` | spasi, urutan import |
| Aturan mekanis | `golangci-lint`, linter kustom | error tidak dicek, `context` bukan argumen pertama |
| **Desain** | **manusia** | batas modul salah, abstraksi prematur, kontrak bocor |
| **Risiko** | **manusia** | jalur ini bisa kehilangan data saat proses mati di tengah |

Lapis 3 dan 4 inilah nilai sesungguhnya dari reviewer senior. Sisanya adalah pekerjaan mesin yang menyamar sebagai kolaborasi.

### Bobot komentar — hilangkan tebak-tebakan

Setiap komentar WAJIB diawali penanda bobot. Ini sepele tapi mengubah dinamika review secara drastis:

| Penanda | Arti | Boleh di-merge tanpa dituruti? |
| :--- | :--- | :---: |
| **`blocking:`** | Harus diperbaiki. Ada risiko nyata. | ❌ |
| **`consider:`** | Saran kuat, penulis boleh menolak dengan alasan. | ✅ |
| **`nit:`** | Selera. Abaikan tanpa perlu membalas. | ✅ |
| **`question:`** | Saya belum paham, bukan menuduh. | ✅ |
| **`praise:`** | Sengaja disebut. Review yang hanya berisi kritik melelahkan. | — |

Tanpa penanda, penulis memperlakukan semua komentar sebagai wajib, atau reviewer merasa diabaikan. Keduanya merusak.

### Yang WAJIB dicari reviewer Go — berurut dari yang paling sering fatal

1. **Kebocoran goroutine & context** — goroutine tanpa jalan keluar, `context` tidak diteruskan, `defer cancel()` hilang.
2. **Error yang ditelan atau kehilangan konteks** — `_ = err`, atau `fmt.Errorf` tanpa `%w` sehingga `errors.Is/As` di atasnya rusak.
3. **Kontrak yang bocor lewat tipe** — mengembalikan `*sql.Rows` dari lapisan repository berarti pemanggil sekarang wajib tahu soal SQL.
4. **Interface didefinisikan di sisi produsen** — di Go, interface milik **konsumen**. Interface besar di package produsen adalah tanda arah dependensi terbalik.
5. **Mutasi map/slice bersama tanpa penjagaan** — race yang tidak terdeteksi karena test tidak pernah dijalankan dengan `-race`.
6. **Kepemilikan sumber daya kabur** — siapa yang menutup? Kalau tidak terlihat dari tanda tangan fungsi, itu bug menunggu waktu.

## Diagram ASCII

```text
   ALUR REVIEW — manusia hanya masuk setelah mesin selesai

   PR dibuka
      |
      v
   +---------------------------+   gagal
   | gofmt + golangci-lint     |--------> penulis perbaiki, TANPA review manusia
   | + go test -race           |          (jangan buang waktu reviewer)
   | + linter kustom tim       |
   +---------------------------+
      | lulus
      v
   +---------------------------+
   | REVIEW MANUSIA            |
   |                           |
   |  1. Apa yang berubah?     |  <- baca deskripsi PR & ADR terkait
   |  2. Batas modul benar?    |  <- desain
   |  3. Apa yang bisa hilang? |  <- risiko: data, uang, keamanan
   |  4. Test membuktikan apa? |  <- test yang selalu hijau tidak bernilai
   |                           |
   +---------------------------+
      |
      v
   blocking: 0  -> approve
   blocking: >0 -> request changes, SEBUTKAN mana yang blocking

   ---------------------------------------------------------------

   UKURAN PR vs MUTU TEMUAN  (pola yang konsisten di banyak tim)

   temuan/
   100 baris
     ^
   8 |  ##
   6 |  ####
   4 |  ######
   2 |  ##########
   0 +--+----+----+----+---> ukuran PR (baris)
      50  200  500  1000+
                     ^
                     `- di sini reviewer menulis "LGTM" tanpa membaca
```

## Kode Go Production-Ready

Linter kustom yang mengkodekan aturan review tim, sehingga tidak perlu diulang manusia. Contoh ini menegakkan dua aturan yang paling sering jadi bug produksi: **`context.Context` wajib argumen pertama**, dan **error hasil bungkus wajib memakai `%w`**.

```go
package reviewlint

import (
	"go/ast"
	"go/types"
	"strings"

	"golang.org/x/tools/go/analysis"
	"golang.org/x/tools/go/analysis/passes/inspect"
	"golang.org/x/tools/go/ast/inspector"
)

// AnalyzerCtxFirst menolak fungsi yang menerima context.Context bukan sebagai
// parameter pertama. Aturan ini ada di Effective Go, tapi tidak ditegakkan
// kompilator — dan pelanggarannya membuat context sering lupa diteruskan.
var AnalyzerCtxFirst = &analysis.Analyzer{
	Name:     "ctxfirst",
	Doc:      "context.Context MUST be the first parameter",
	Requires: []*analysis.Analyzer{inspect.Analyzer},
	Run:      runCtxFirst,
}

func runCtxFirst(pass *analysis.Pass) (any, error) {
	insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)
	filter := []ast.Node{(*ast.FuncDecl)(nil)}

	insp.Preorder(filter, func(n ast.Node) {
		fn := n.(*ast.FuncDecl)
		if fn.Type.Params == nil {
			return
		}
		var idx, pos int
		found := false
		for _, field := range fn.Type.Params.List {
			names := len(field.Names)
			if names == 0 {
				names = 1 // parameter tanpa nama tetap menempati satu posisi
			}
			if isContextType(pass.TypesInfo.TypeOf(field.Type)) {
				found = true
				idx = pos
				break
			}
			pos += names
		}
		if found && idx != 0 {
			pass.Reportf(fn.Pos(),
				"blocking: context.Context is at position %d in %s, MUST be at position 0", idx, fn.Name.Name)
		}
	})
	return nil, nil
}

func isContextType(t types.Type) bool {
	named, ok := t.(*types.Named)
	if !ok {
		return false
	}
	obj := named.Obj()
	return obj != nil && obj.Name() == "Context" &&
		obj.Pkg() != nil && obj.Pkg().Path() == "context"
}

// AnalyzerErrWrap menolak fmt.Errorf yang memuat variabel error tapi memakai
// %v alih-alih %w. Akibatnya errors.Is/As di lapisan atas berhenti bekerja,
// dan penanganan error berbasis tipe diam-diam rusak.
var AnalyzerErrWrap = &analysis.Analyzer{
	Name:     "errwrap",
	Doc:      "fmt.Errorf wrapping an error MUST use %w",
	Requires: []*analysis.Analyzer{inspect.Analyzer},
	Run:      runErrWrap,
}

func runErrWrap(pass *analysis.Pass) (any, error) {
	insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)
	filter := []ast.Node{(*ast.CallExpr)(nil)}

	insp.Preorder(filter, func(n ast.Node) {
		call := n.(*ast.CallExpr)
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "Errorf" {
			return
		}
		pkg, ok := sel.X.(*ast.Ident)
		if !ok || pkg.Name != "fmt" || len(call.Args) < 2 {
			return
		}
		lit, ok := call.Args[0].(*ast.BasicLit)
		if !ok {
			return
		}
		format := lit.Value
		if strings.Contains(format, "%w") {
			return // sudah benar
		}
		// Ada argumen bertipe error tapi format tidak memakai %w.
		for _, arg := range call.Args[1:] {
			if isErrorType(pass.TypesInfo.TypeOf(arg)) {
				pass.Reportf(call.Pos(),
					"blocking: fmt.Errorf wraps error without %%w — errors.Is/As will fail")
				return
			}
		}
	})
	return nil, nil
}

func isErrorType(t types.Type) bool {
	if t == nil {
		return false
	}
	return types.Implements(t, errorInterface) ||
		types.Implements(types.NewPointer(t), errorInterface)
}

var errorInterface = types.Universe.Lookup("error").Type().Underlying().(*types.Interface)
```

Dipasang sebagai binary `go vet`-compatible:

```go
package main

import (
	"golang.org/x/tools/go/analysis/multichecker"

	"example.com/tools/reviewlint"
)

func main() {
	multichecker.Main(
		reviewlint.AnalyzerCtxFirst,
		reviewlint.AnalyzerErrWrap,
	)
}
```

## Uji

```go
package reviewlint_test

import (
	"testing"

	"golang.org/x/tools/go/analysis/analysistest"

	"example.com/tools/reviewlint"
)

// analysistest membaca testdata/src/<pkg> dan mencocokkan komentar
// "// want ..." dengan diagnostik yang dihasilkan analyzer.
func TestCtxFirst(t *testing.T) {
	analysistest.Run(t, analysistest.TestData(), reviewlint.AnalyzerCtxFirst, "ctxfirst")
}

func TestErrWrap(t *testing.T) {
	analysistest.Run(t, analysistest.TestData(), reviewlint.AnalyzerErrWrap, "errwrap")
}
```

`testdata/src/ctxfirst/a.go`:

```go
package ctxfirst

import "context"

// Benar: context di posisi pertama.
func Fetch(ctx context.Context, id string) error { return nil }

// Salah: context di posisi kedua.
func Simpan(id string, ctx context.Context) error { return nil } // want `context.Context ada di posisi 1`

// Tanpa context sama sekali: tidak dilaporkan.
func Hitung(a, b int) int { return a + b }
```

`testdata/src/errwrap/a.go`:

```go
package errwrap

import (
	"errors"
	"fmt"
)

var ErrNotFound = errors.New("not found")

func Correct() error { return fmt.Errorf("fetch user: %w", ErrNotFound) }

func Incorrect() error { return fmt.Errorf("fetch user: %v", ErrNotFound) } // want `without %w`

// Tanpa error di argumen: bukan pembungkusan, tidak dilaporkan.
func BukanBungkus(n int) error { return fmt.Errorf("value %d out of bounds", n) }
```

## Anti-Pattern

**❌ SALAH — reviewer memperdebatkan hal yang bisa dimesinkan**

```text
reviewer: sebaiknya variabel ini namanya `userID` bukan `uid`
reviewer: import-nya belum dikelompokkan
reviewer: baris ini kepanjangan
reviewer: pakai `errors.New` saja, bukan `fmt.Errorf` tanpa format
```

Empat komentar, nol risiko produksi berkurang. Penulis kehilangan sehari untuk perubahan kosmetik, dan bug sesungguhnya — goroutine yang tidak pernah keluar — lolos karena reviewer sudah kehabisan tenaga.

**✅ BENAR — mesin urus kosmetik, manusia urus risiko**

```yaml
# .golangci.yml — semua di atas ditegakkan otomatis, tidak pernah masuk review
linters:
  enable: [errcheck, govet, staticcheck, revive, bodyclose, contextcheck, errorlint, nilerr]
```

```text
reviewer: blocking: goroutine di baris 84 dibuat tanpa jalan keluar. Kalau
          ctx dibatalkan saat menunggu `resultCh`, goroutine ini bocor
          permanen. Lihat concurrency/goroutine_leak_detection.md.
reviewer: question: kalau proses mati antara INSERT dan publish event di
          baris 120, apakah event-nya hilang? Kalau iya, ini butuh outbox.
reviewer: praise: pemisahan repository dari handler di sini rapi.
```

**❌ SALAH — PR besar tanpa pemandu**

```text
"feat: implementasi modul pembayaran" — 47 berkas, 3.400 baris
```

Tidak ada manusia yang mereview 3.400 baris dengan sungguh-sungguh. Yang terjadi: reviewer membaca 200 baris pertama, menulis dua nit, lalu approve. Review menjadi upacara.

**✅ BENAR — dipecah dengan urutan yang bisa diikuti**

```text
PR 1: tipe domain + test  (180 baris)
PR 2: repository + integrasi test (240 baris)
PR 3: handler + e2e (200 baris)
PR 4: aktifkan lewat feature flag (30 baris)

Deskripsi PR 2:
  Konteks: ADR-0014 (kenapa outbox, bukan 2PC)
  Fokus review: kebenaran transaksi di internal/payment/repo.go:88-140
  Bukan fokus: penamaan (sudah mengikuti PR 1)
```

## Kasus Tepi Produksi

1. **Reviewer tunggal jadi penyumbat.** Bila hanya satu orang paham suatu modul, dia menjadi antrean sekaligus risiko bus factor. Ini bukan masalah proses review — ini gejala kepemilikan pengetahuan yang timpang. Perbaiki dengan pair review terjadwal, bukan dengan mempercepat approval.

2. **PR mendesak saat insiden.** Perbaikan produksi tidak boleh menunggu review normal, tapi juga tidak boleh tanpa mata kedua. Aturan yang berfungsi: satu approval boleh dari siapa pun yang sedang online, dan PR itu WAJIB direview ulang secara penuh dalam 24 jam berikutnya sebagai PR terpisah.

3. **Perubahan besar yang murni mekanis.** Rename lintas 200 berkas hasil refactor otomatis tidak butuh review baris-per-baris. WAJIB dipisah dari perubahan bermakna, dan deskripsinya menyebut perintah yang dipakai supaya reviewer bisa memverifikasi ulang alih-alih membaca.

4. **Perbedaan pendapat yang buntu.** Dua senior tidak sepakat soal desain dan PR mandek berhari-hari. Aturan eskalasi WAJIB ada sebelum dibutuhkan: setelah dua putaran tanpa titik temu, keputusan naik ke pemilik area, hasilnya dicatat sebagai ADR. Buntu tanpa jalan keluar merusak lebih banyak daripada keputusan yang kurang optimal.

5. **Kode yang dihasilkan generator.** `sqlc`, `mockgen`, `protoc` menghasilkan ribuan baris yang tidak layak direview. Tandai lewat `//go:generate` dan kecualikan dari diff review, TAPI **review perubahan pada sumber generatornya** — di situlah keputusan sebenarnya diambil.

## Kapan JANGAN Pakai Ini

- **Prototipe yang akan dibuang.** Review ketat pada kode eksperimen yang umurnya seminggu adalah pemborosan. Beri penanda jelas di repo/branch bahwa area ini tidak tunduk pada standar produksi, dan pastikan tidak ada jalan agar ia diam-diam masuk produksi.
- **Sebagai satu-satunya gerbang mutu.** Review manusia tidak menangkap race condition, kebocoran memori, atau regresi performa. Itu tugas `-race`, profiling, dan benchmark di CI. Tim yang hanya mengandalkan review akan kaget di produksi.
- **Untuk mengajari dasar-dasar.** Kalau seorang engineer butuh 20 komentar per PR tentang hal mendasar, review bukan alatnya — pairing dan mentoring yang tepat. Review yang berubah jadi kelas membuat kedua pihak lelah.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Waktu approval cepat pada PR besar | korelasi ukuran PR vs waktu-ke-approve | PR terlalu besar untuk direview sungguhan; "LGTM" bukan review |
| Bug produksi di area yang baru direview | telusuri insiden ke PR-nya | Review menyasar kosmetik, bukan risiko |
| Komentar didominasi penamaan & format | ambil sampel 20 PR terakhir | Linter kurang ketat; pindahkan aturannya ke mesin |
| PR menunggu >3 hari | umur PR terbuka | Reviewer jadi penyumbat, atau tidak ada pemilik area yang jelas |
| Rasio komentar `blocking:` mendekati nol | hitung penanda bobot | Review jadi upacara, atau reviewer takut menolak |

```bash
# Ukuran PR vs waktu approve — cari pola "besar tapi cepat"
gh pr list --state merged --limit 50 \
  --json number,additions,deletions,createdAt,mergedAt \
  | jq -r '.[] | [.number, (.additions+.deletions),
      ((.mergedAt|fromdate)-(.createdAt|fromdate))/3600] | @tsv' \
  | sort -k2 -rn | head -20

# Sebaran bobot komentar
gh pr list --state merged --limit 30 --json number \
  | jq -r '.[].number' \
  | xargs -I{} gh pr view {} --json comments \
  | grep -oE '\b(blocking|consider|nit|question|praise):' | sort | uniq -c
```
