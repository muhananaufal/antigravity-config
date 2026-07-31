# Custom Linter Framework dengan analysis.Analyzer

## Konsep Utama dan Internal

Tim engineer yang besar tidak bisa hanya bergantung pada Code Review (PR) manual untuk menegakkan aturan khusus/arsitektur tim—mereka mengotomatisasinya melalui *Linter kustom*. Dahulu linter ditulis secara serampangan menggunakan *script AST raw*. Saat ini, Go menyediakan API de facto standar: `golang.org/x/tools/go/analysis`.

Keuntungan mutlak framework `analysis` adalah pemisahan fasa *Parsing* dan fasa *Linting*. Package `analysis` memungkinkan sekumpulan Analyzer untuk saling melempar *fakta/hasil temuan* melintasi dependensi (*Requires* dan *Fact*) menggunakan mekanisme DAG (Directed Acyclic Graph) yang diorkestrasi secara transparan. Analyzer ini nantinya tak perlu berjalan di script mandiri terpisah, tapi dapat dikemas (embedded) ke dalam `golangci-lint` (sebagai go plugin) atau melalui program CLI `multichecker` murni bawaan x/tools.

## Diagram Arsitektur Analisis (ASCII)

```text
 +---------------------+
 | File Sumber (*.go)  |
 +---------------------+
           |
   [ Engine AST & Types / Packages Load ]
           |
           v
 +---------------------------------------------------------------+
 |                        analysis.Pass                          |
 | (Memegang referensi utuh ke Fset, TypesInfo, Syntax Nodes)    |
 +---------------------------------------------------------------+
           |                                     |
    <Dependency Graph>                     <Run Function>
           |                                     |
 [ analysis/passes/inspect ] (1st pass)          |
           |                                     |
           | (Export Inspect Result)             |
           v                                     v
 +---------------------------------------------------------------+
 |                      Custom Analyzer (Linter)                 |
 | 1. Import inspector hasil node mapping dari Linter Inspect    |
 | 2. Filter Node Type via AST (CallExpr, FuncDecl)              |
 | 3. Evaluasi TypeInfo Resolve                                  |
 | 4. pass.Reportf(pos, "Error Peringatan Kustom")               |
 +---------------------------------------------------------------+
```

## Kode Go Production-Ready

Contoh solid linter khusus: Melarang pemanggilan panic bawaan (built-in). Linter mem-bypass fungsi shadow (`func panic(){}`) dan hanya mengunci fungsi kernel murni.

```go
package customlinter

import (
	"go/ast"
	"golang.org/x/tools/go/analysis"
	"golang.org/x/tools/go/analysis/passes/inspect"
	"golang.org/x/tools/go/ast/inspector"
)

// ==========================================
// 1. ANALYZER DEFINITION
// ==========================================

// NoPanicAnalyzer adalah definisi resmi yang didaftarkan ke framework linter.
var NoPanicAnalyzer = &analysis.Analyzer{
	Name: "nopanic",
	Doc:  "reports direct calls to the built-in panic() function to encourage robust error returning",
	// KRUSIAL: Meminta framework menjalankan "inspect" analyzer lebih dulu
	// dan mem-passing output cache-nya ke linter ini untuk traversal yang optimal.
	Requires: []*analysis.Analyzer{inspect.Analyzer},
	Run:      runNoPanic,
}

// ==========================================
// 2. ANALYZER LOGIC EXECUTOR
// ==========================================

func runNoPanic(pass *analysis.Pass) (interface{}, error) {
	// 1. Ekstrak object Inspector tersimpan dari phase sebelumnya (Requires)
	inspectResult := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)
	
	// 2. Traversal AST yang terfokus: Hanya periksa pemanggilan fungsi (CallExpr)
	nodeFilter := []ast.Node{
		(*ast.CallExpr)(nil),
	}

	// 3. Traversal Preorder memindai tiap node yang difilter
	inspectResult.Preorder(nodeFilter, func(n ast.Node) {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return
		}

		// Periksa apakah fungsi tersebut merupakan Identifier langsung.
		// (e.g. `panic("x")` adalah Ident, sedangkan `fmt.Panic()` adalah SelectorExpr)
		ident, ok := call.Fun.(*ast.Ident)
		if !ok {
			return
		}

		// Jika kebetulan nama ident adalah "panic"
		if ident.Name == "panic" {
			// VALIDASI TINGKAT LANJUT (SEMANTIK, BUKAN CUMA NAMA STRING TEXT)
			// Ambil Objek Semantik hasil type-checker untuk resolusi mutlak:
			obj := pass.TypesInfo.Uses[ident]
			if obj != nil {
				// Pastikan fungsi ini benar-benar `panic` bawaan Go dari scope Universe.
				// Hal ini menghindarkan peringatan palsu apabila developer iseng membuat 
				// local function `func panic() {}` sendiri.
				if obj.Parent() == pass.Pkg.Scope().Universe() {
					// Peringatkan! Keluarkan Report Output ke Linter stdout
					pass.Reportf(ident.Pos(), "codebase forbids direct calls to built-in panic(); refactor to return an error")
				}
			}
		}
	})

	return nil, nil // Return interface{} value untuk dilempar ke linter turunannya (jika ada)
}
```

### Unit Test (Production Standard dengan analysistest)

```go
package customlinter_test

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/tools/go/analysis/analysistest"

	"mycustom/pkg/customlinter"
)

func TestNoPanicAnalyzer(t *testing.T) {
	// analysistest mensimulasikan lingkungan linter utuh.
	testdata := analysistest.TestData()

	// 1. Setup direktori test dummy 
	pkgDir := filepath.Join(testdata, "src", "baddomain")
	if err := os.MkdirAll(pkgDir, 0755); err != nil {
		t.Fatalf("Failed to create test directory: %v", err)
	}
	
	// 2. Kode Sumber Injeksi (Mengandung magic comment "// want")
	// Framework analysistest akan mengecek apakah Linter memancarkan error string 
	// yang cocok (Regex match) dengan yang diminta "// want ...".
	src := `package baddomain
	
	func Process() {
		// INI HARUS TERDETEKSI:
		panic("boom") // want "codebase forbids direct calls to built-in panic.*"
	}

	func customPanic() {} 
	
	func ValidLogic() {
		// INI TIDAK BOLEH TERDETEKSI KARENA BUKAN PANIC BAWAAN:
		customPanic()
		
		var panic = func() {} // Shadowing fungsi panic
		panic() // Tidak boleh terdeteksi (scope lokal)
	}
	`
	
	if err := os.WriteFile(filepath.Join(pkgDir, "sample.go"), []byte(src), 0644); err != nil {
		t.Fatalf("Failed to write test file: %v", err)
	}

	// 3. Eksekusi Simulasi
	analysistest.Run(t, testdata, customlinter.NoPanicAnalyzer, "baddomain")
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Traversal AST Serampangan tanpa Dependency Cache (Tanpa Requires `inspect`)
Pembuat linter pemula biasanya mem-bypass framework inspector milik *analysis/passes* dan langsung memanggil `ast.Inspect()` mentah atau `ast.Walk()` di atas `pass.Files`.

```go
// ❌ BAD: Memanggil ast.Inspect() di setiap Custom Analyzer
func run(pass *analysis.Pass) (interface{}, error) {
    for _, file := range pass.Files {
        ast.Inspect(file, func(n ast.Node) bool {
             // Operasi berat...
             return true
        })
    }
}
```
**Why dangerous:** Jika perusahaan Anda memiliki 20 modul linter custom dan setiap linter melakukan iterasi AST manual pada kode biner berukuran ratusan Megabyte, komputasi CPU dan alokasi Memory membludak (*Out of Memory* atau proses *linting* butuh 10 menit lambatnya).
**Solusi (Benar):** Linter Inspector standar (`inspect.Analyzer`) yang ada di ekosistem Go dirancang khusus untuk mem-parsing AST **hanya satu kali**. Ia men-cache keseluruhan simpul node (nodes/type-mappings) pada sesi pertama (*Pass 1*). Semua Analyzer kustom sesudahnya (*Pass 2-N*) hanya perlu me-declare `Requires: []*analysis.Analyzer{inspect.Analyzer}` dan mengekstrak array indeks cache hasil tersebut (pengambilan O(1)), memangkas latensi hingga >90%.

### ❌ Anti-Pattern 2: String Text Matching untuk Mengecek Package Method (Tanpa go/types)
Mengecek nama fungsi secara naif (via `ident.Name`) seringkali mengeksploitasi cacat akurasi yang menghasilkan ratusan *False Positive*.

```go
// ❌ BAD: Linter melarang penggunaan database log.Fatal
// Jika kode bertemu `log.Fatal()`, maka lapor.
if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
    if ident, ok := sel.X.(*ast.Ident); ok && ident.Name == "log" && sel.Sel.Name == "Fatal" {
        pass.Reportf(ident.Pos(), "Don't use Fatal")
    }
}
```
**Why dangerous:** Pendekatan dangkal ini salah dan memblokir validitas di situasi di mana:
1. `import log "mycompany/custom/auditlog"` (Keduanya kebetulan bernama `log`, padahal bukan dari package stdlib `log` yang ingin dilarang).
2. Terdapat struct (bukan package) dengan nama yang berawalan log (Shadow variable), contoh: `var log = MyStruct{}; log.Fatal()`. 
**Solusi (Benar):** Lakukan *Semantic Resolution* (Type Checking) penuh melalui memori `pass.TypesInfo.Uses[sel.Sel]`. Lalu panggil `obj.Pkg().Path()` untuk mencocokkan namespace/package aslinya (misalnya mengecek path import = `"log"` mutlak) terbebas dari jebakan shadow variable.

## Edge Cases & Defensive Programming Konkrit

1. **Kode Invalid dan Kompilasi Terputus (Nil Pointers):**
   *Custom Linter* harus bisa dieksekusi secara asinkron di dalam editor (seperti VSCode/GoLand) meski pengembang sedang mengetik alias terjadi *Syntax Error / Incomplete Types*. Jika linter memaksa membaca tree di kode *broken*, `pass.TypesInfo` atau `call.Fun` akan menyimpan penunjuk memori kosong (*nil*). 
   *Defensive:* Terapkan *safety checks* ekstensif. Gunakan *comma-ok type assertions* (bukan hard typecasting `call.Fun.(*ast.Ident)` yang memicu kernel Panic OS). Apabila nilai dari dictionary `pass.TypesInfo.Uses[ident]` mereturn nol (`nil`), hentikan inspeksi sesegera mungkin di node itu dengan `return`. Linter yang sering `panic()` akan di-*blacklist* oleh IDE (extension akan mati total).

2. **CGO dan Generics AST Nodes:**
   Implementasi generic Go (Go 1.18+) menyematkan node AST berjenis `*ast.IndexExpr` (untuk pemanggilan 1 parameter instansiasi: `MyFunc[int]()`) dan `*ast.IndexListExpr` (untuk pemanggilan multi param: `MyMap[string, int]()`) ke dalam cabang AST *sebelum* `CallExpr` dibungkus.
   *Defensive:* Jika linter melacak argumen pada *CallExpr* atau nama Identifier, harus dipersiapkan ekstensi type-switch evaluasi untuk `ast.IndexExpr` dan `ast.IndexListExpr` untuk menelusuri dasar fungsi aslinya (`Base Identifier`), kalau tidak linter tak mendeteksi pemanggilan fungsi tersebut karena tersamar instansiasi generics.

3. **Mengacuhkan Directive '//nolint':**
   Framework core `analysis.Pass` tidak dilengkapi logika *out-of-the-box* untuk men-skip *reporting* apabila pengguna telah menyematkan komen `//nolint:nopanic`.
   *Defensive:* Jika Anda membungkus linter ini langsung ke file CLI Go mandiri (`singlechecker.Main`), linter akan melaporkan baris tersebut terus menerus walau dikomen. Solusinya, pertimbangkan memasukkannya ke konfigurasi runtime `golangci-lint` yang memiliki supervisor middleware untuk memberangus output laporan (*suppression*) jika file memiliki regex nolint, alih-alih me-re-implement logic parsig comment secara mubazir di script Anda sendiri.
