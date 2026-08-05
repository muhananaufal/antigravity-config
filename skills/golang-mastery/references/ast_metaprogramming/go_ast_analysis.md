# Go AST & Static Analysis

> **Berlaku:** Go 1.21+ · `go/ast`, `golang.org/x/tools/go/packages` · **Lihat juga:** `ast_metaprogramming/custom_linter_analysisgo.md` · `ast_metaprogramming/code_generation_template.md` · `engineering_practice/code_review_go.md` · `runtime_internals/build_system_linker.md`

## Konsep Utama dan Internal

Abstract Syntax Tree (AST) di Go memungkinkan kita membedah kode sumber menjadi representasi hierarkis dari *token* dan *node* (deklarasi, ekspresi, tipe). Ekosistem Go sangat kaya akan *tooling* karena *compiler frontend*-nya terekspos sebagai *standard library* dan modul `x/tools`.

Komponen-komponen krusial dalam metaprogramming Go:
1. `go/token`: Melacak posisi spesifik di file (baris, kolom) menggunakan `token.FileSet`.
2. `go/parser`: Mengubah source code mentah menjadi struktur AST (`*ast.File`).
3. `go/ast`: Mendefinisikan struktur *node* seperti `ast.CallExpr`, `ast.FuncDecl`, `ast.Ident`. Memberikan fungsi *traversal* seperti `ast.Inspect` dan `ast.Walk`.
4. `go/types`: Melakukan resolusi semantik (*type-checking*). Di sinilah "magic" terjadi, membedakan variabel lokal `foo` dari variabel global bernama sama, serta meresolve *method call*.
5. `golang.org/x/tools/go/packages`: *Entrypoint* standar industri saat ini untuk me-load package Go, menangani `go.mod`, CGO, dan modul eksternal secara mulus alih-alih mem-parsing file secara manual.
6. `golang.org/x/tools/go/ssa`: Mengubah typed-AST menjadi bentuk *Static Single Assignment* (SSA), sangat krusial untuk analisis graf panggilan (*Call Graph*) atau *Data-Flow Analysis*.

Kapan ini digunakan? Linter kustom (misal menggunakan `golang.org/x/tools/go/analysis`), generator kode (*code generation* seperti `mockgen`), refactoring tools otomatis, hingga analisis keamanan SAST (Static Application Security Testing).

## Diagram Pipeline Analisis Go (ASCII)

Diagram berikut menunjukkan bagaimana *source code* berubah dari teks mentah, lalu diparsing menjadi AST murni, kemudian di-type-check, lalu siap dianalisis mendalam.

```text
+---------------------+        [go/parser]          +----------------------+
|  Source Code (.go)  | --------------------------> |    Untyped AST       |
|  (File Teks Biasa)  |      + [go/token]           |   (Struktur Sintaks) |
+---------------------+                             +----------------------+
                                                               |
                                                          [go/types]
                                                               |
                                                               v
+---------------------+       [go/ssa/ssautil]      +----------------------+
|      SSA Form       | <-------------------------- | Typed AST & TypeInfo |
| (Data Flow & Graph) |                             | (Resolusi Semantik)  |
+---------------------+                             +----------------------+
          |
          v
+-----------------------+
| Vulnerability Scanner /|
| Custom Linters / Tools |
+-----------------------+
```

## Kode Go Production-Ready

Kode di bawah ini mendemonstrasikan pencarian pemanggilan fungsi secara spesifik (contoh: pemanggilan `fmt.Println`) di seluruh direktori target menggunakan `go/packages` dan resolusi tipe `go/types` yang aman. Kita menggunakan `ast.Inspect` karena lebih efisien dan ringkas dibandingkan mengimplementasikan interface `ast.Visitor` pada `ast.Walk`.

```go
package astanalyzer

import (
	"fmt"
	"go/ast"
	"go/token"

	"golang.org/x/tools/go/ast/inspector"
	"golang.org/x/tools/go/packages"
)

// FuncCallReport menyimpan informasi pemanggilan fungsi spesifik.
type FuncCallReport struct {
	Position string
	FuncName string
}

// AnalyzeFuncCalls menganalisis sebuah direktori paket untuk mencari pemanggilan
// ke fungsi target secara semantik, BUKAN berdasarkan teks semata.
// Contoh penggunaan: AnalyzeFuncCalls("./...", "fmt.Println")
func AnalyzeFuncCalls(dir string, targetFuncFullName string) ([]FuncCallReport, error) {
	// 1. Konfigurasi go/packages untuk memuat semua informasi yang dibutuhkan
	cfg := &packages.Config{
		Mode: packages.NeedName | 
			packages.NeedFiles | 
			packages.NeedCompiledGoFiles |
			packages.NeedImports | 
			packages.NeedTypes | 
			packages.NeedTypesInfo |
			packages.NeedSyntax | 
			packages.NeedModule,
		Dir: dir,
	}

	// 2. Load paket Go
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		return nil, fmt.Errorf("gagal me-load packages pada direktori %s: %w", dir, err)
	}

	// 3. Validasi Error dari Loading
	if packages.PrintErrors(pkgs) > 0 {
		return nil, fmt.Errorf("ditemukan error saat me-load paket, pastikan kode bisa dikompilasi")
	}

	var reports []FuncCallReport

	// 4. Proses setiap paket
	for _, pkg := range pkgs {
		if pkg.TypesInfo == nil || pkg.Syntax == nil {
			continue // Skip jika paket kosong atau tidak ter-load
		}

		// Menggunakan AST Inspector untuk traversal pre-order yang efisien
		inspect := inspector.New(pkg.Syntax)
		
		// Filter node HANYA untuk CallExpr, menghindari traversal pada node lain
		nodeFilter := []ast.Node{
			(*ast.CallExpr)(nil),
		}

		inspect.Preorder(nodeFilter, func(n ast.Node) {
			callExpr := n.(*ast.CallExpr)
			
			// Ambil identifier fungsi yang dipanggil
			var ident *ast.Ident
			
			// Fungsi bisa dipanggil langsung (foo()) atau via selector (pkg.foo())
			switch fun := callExpr.Fun.(type) {
			case *ast.Ident:
				ident = fun
			case *ast.SelectorExpr:
				ident = fun.Sel
			default:
				// Closure call func()() atau hal lain yang tidak kita lacak
				return
			}

			// Menggunakan TypeInfo.Uses untuk meresolve objek semantik secara akurat
			// tanpa peduli apakah package-nya di-alias atau di-shadow.
			obj := pkg.TypesInfo.Uses[ident]
			if obj != nil {
				// Membandingkan dengan nama penuh fungsi, misal: "fmt.Println"
				if obj.FullName() == targetFuncFullName {
					// Dapatkan posisi presisi
					pos := pkg.Fset.Position(n.Pos())
					reports = append(reports, FuncCallReport{
						Position: pos.String(),
						FuncName: obj.FullName(),
					})
				}
			}
		})
	}
	return reports, nil
}
```

### Unit Test (Production Standard)
```go
package astanalyzer

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAnalyzeFuncCalls(t *testing.T) {
	// Setup direktori workspace sementara yang terisolasi
	dir, err := os.MkdirTemp("", "asttest-*")
	if err != nil {
		t.Fatalf("gagal membuat direktori temp: %v", err)
	}
	defer os.RemoveAll(dir)

	// Buat file Go dengan pemanggilan fmt.Println yang valid, 
	// serta shadowed custom fungsi "Println" untuk menguji resolusi semantik.
	src := `package main
import (
	"fmt"
	aliasedFmt "fmt"
)

func Println(s string) {} // Fungsi custom dengan nama Println

func main() {
	fmt.Println("Halo Dunia")           // Target: Baris 10
	aliasedFmt.Println("Alias import")  // Target: Baris 11
	Println("Custom func call")         // BUKAN Target
}
`
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte(src), 0644); err != nil {
		t.Fatalf("gagal menulis source file: %v", err)
	}

	// Go module mutlak diperlukan untuk x/tools/go/packages beroperasi normal 
	mod := `module testanalyzer
go 1.21
`
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte(mod), 0644); err != nil {
		t.Fatalf("gagal menulis go.mod: %v", err)
	}

	// Eksekusi fungsi utama
	reports, err := AnalyzeFuncCalls(dir, "fmt.Println")
	if err != nil {
		t.Fatalf("AnalyzeFuncCalls gagal tak terduga: %v", err)
	}

	// Validasi Output
	if len(reports) != 2 {
		t.Errorf("diharapkan menemukan 2 call (fmt.Println dan aliasedFmt.Println), mendapat %d", len(reports))
	}

	// Memastikan custom Println tidak ter-detect
	for _, r := range reports {
		if r.FuncName != "fmt.Println" {
			t.Errorf("mendapatkan target yang salah direvolve: %s", r.FuncName)
		}
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan String Matching mentah pada AST Identifier
Salah satu kesalahan paling pemula saat membuat linter adalah menebak-nebak tipe data atau pemanggilan fungsi hanya dari string variabel di `ast.Ident.Name`.

```go
// ❌ BAD: Mencari pemanggilan Println hanya dengan cek string nama
inspect.Preorder([]ast.Node{(*ast.CallExpr)(nil)}, func(n ast.Node) {
    call := n.(*ast.CallExpr)
    if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
        // Bahaya! Jika user melakukan: `import myfmt "fmt"` -> x.Name = "myfmt"
        // Bahaya! Jika user memanggil "log.Println" tapi kita hanya cek "Println" 
        if ident, ok := sel.X.(*ast.Ident); ok && ident.Name == "fmt" && sel.Sel.Name == "Println" {
            fmt.Println("Found fmt.Println!")
        }
    }
})
```
**Why dangerous:** Pendekatan mentah ini sangat rentan patah dan memberikan banyak False Positives / False Negatives. Di Go, package name bisa di-*alias* pada saat diimpor, dan sebuah struct bisa memiliki *method* bernama `Println`. Logika di atas tidak bisa membedakan *method call* dengan fungsi package, apalagi alias import.

```go
// ✅ GOOD: Menggunakan go/types untuk resolusi mutlak
obj := pkg.TypesInfo.Uses[sel.Sel]
if obj != nil && obj.FullName() == "fmt.Println" { ... }
```

### ❌ Anti-Pattern 2: Mem-parsing single file dengan `parser.ParseFile`
Seringkali orang mencoba membuat static analyzer dengan langsung mem-parsing file .go secara naif tanpa memuat dependency `packages`.

```go
// ❌ BAD: Hanya parse satu file, tipe data struct di file lain tidak diketahui
fset := token.NewFileSet()
f, _ := parser.ParseFile(fset, "main.go", nil, 0)

conf := types.Config{}
info := &types.Info{Uses: make(map[*ast.Ident]types.Object)}
// Akan GAGAL resolusi jika `main.go` memanggil fungsi di `utils.go` 
// yang berada pada package yang sama, karena fset hanya diisi main.go.
_, err := conf.Check("mypkg", fset, []*ast.File{f}, info)
```
**Why dangerous:** Jika paket memiliki banyak file, file `main.go` mungkin merujuk pada `var Config` yang dideklarasikan di `config.go`. Jika Anda hanya me-load dan type-check `main.go`, `go/types` akan melemparkan *undefined identifier error*. Anda tidak dapat melakukan static analysis kredibel tanpa me-load satu *Package* utuh secara semantik. Gunakan `golang.org/x/tools/go/packages`.

## Edge Cases & Defensive Programming Konkrit

1. **Uncompilable Code dan Incomplete Syntax Trees:**
   Jika kode sumber pengguna sedang diketik atau memiliki *syntax error* saat linter kita berjalan (umum terjadi di ekstensi IDE), `packages.Load` mungkin berhasil mengembalikan `*packages.Package`, tetapi field `pkg.Syntax` bisa kosong, tipe tidak terselesaikan, atau sebagian node memicu *panic* bila tidak dicek. 
   *Defensive:* Sebelum mengekstrak `pkg.TypesInfo`, **selalu evaluasi `len(pkg.Errors)`** atau panggil `packages.PrintErrors(pkgs)`. Jangan pernah berasumsi `*ast.File` terbentuk dengan utuh. Tambahkan validasi `if pkg.Syntax == nil { continue }` atau batasi linter berjalan hanya bila error paket = 0.

2. **File Kode Hasil Generated (misal mockgen, protoc, wire):**
   *Code Generator* sering menghasilkan kode besar yang kompleks dan redundan. Menjalankan traversal AST pada jutaan baris kode *generated* akan menghabiskan CPU dan RAM (*Out of Memory*), dan seringkali tidak relevan untuk linter manual.
   *Defensive:* Tambahkan filter untuk memeriksa *header file*. Sesuai standar Go, file yang memiliki komentar berawalan `// Code generated by ... DO NOT EDIT.` sebaiknya dilewati. Pada saat traversal (`ast.Inspect`), baca `ast.File.Comments` dan periksa keberadaan *prefix* tersebut sebelum memproses blok fungsinya.

3. **Kompleksitas Generic Types (Instantiated Signatures):**
   Pada Go 1.18+, AST dan Type-Info menjadi jauh lebih kompleks akibat Generics. Jika Anda melacak sebuah fungsi `func Target[T any](val T)`, pemanggilan `Target[int](10)` di AST direpresentasikan sebagai node `*ast.IndexExpr` atau `*ast.IndexListExpr` sebelum masuk ke `*ast.CallExpr`.
   *Defensive:* Jangan melakukan *type-assertion* keras secara dangkal. Jika `callExpr.Fun` bukan `*ast.Ident` dan bukan `*ast.SelectorExpr`, periksa apakah ia adalah tipe instansiasi. Gunakan API baru seperti `go/types.InstantiatedSignature` (atau `types.Info.Instances`) alih-alih `types.Info.Uses` biasa jika Anda juga perlu mengetahui ke argumen T mana fungsi tersebut sedang dilebur. Jika *tools* tidak diupdate untuk mengenali generic node, traversal AST Anda akan tersandung (*silent fail/return*).

## Kapan JANGAN Pakai Ini

- **Mengurai kode Go dengan regex.** Komentar, string literal, dan generik membuat pendekatan berbasis teks salah pada kasus yang tidak Anda bayangkan — dan salahnya senyap. `go/parser` ada persis untuk ini.
- **AST saja ketika yang dibutuhkan informasi tipe.** AST tahu bentuk sintaksis, bukan tipe. Pertanyaan seperti "apakah ini `error`" membutuhkan `go/types` melalui `packages.Load`, dan memuat tipe jauh lebih mahal daripada memuat sintaks.
- **Menulis ulang berkas dari AST tanpa memperhatikan format dan komentar.** Komentar tidak melekat pada node seperti yang diharapkan; menulis ulang naif akan memindahkan atau menghilangkannya, dan diff-nya menjadi tidak bisa di-review.
- **Menganalisis kode yang tidak bisa dikompilasi tanpa menangani galat.** `packages.Load` mengembalikan paket dengan galat; analisis yang mengabaikannya akan memberi hasil yang salah dengan percaya diri.
- **Alat AST yang berjalan di setiap penyimpanan berkas.** Memuat paket dengan informasi tipe untuk repo besar memakan detik dan memori besar; itu bukan operasi interaktif.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Alat memberi hasil salah pada kode tertentu | apakah pakai regex atau parser | Analisis berbasis teks |
| Komentar hilang setelah transformasi | penanganan `CommentMap` | Penulisan ulang naif |
| Hasil analisis salah pada paket yang gagal build | penanganan `pkg.Errors` | Galat kompilasi diabaikan |
| Alat sangat lambat di repo besar | mode `packages.Load` | Memuat tipe padahal hanya butuh sintaks |
| Hasil berbeda antar mesin | versi Go dan build tag | Analisis bergantung lingkungan |

```bash
# Bandingkan biaya: sintaks saja jauh lebih murah daripada dengan tipe
time go run ./cmd/analisis -mode=syntax ./...
time go run ./cmd/analisis -mode=types  ./...

# Paket yang gagal dimuat WAJIB ditangani, bukan diabaikan
go build ./... 2>&1 | head
go vet ./... 2>&1 | head
```
