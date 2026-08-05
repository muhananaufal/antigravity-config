# Panduan Definitif: OWASP Input Validation & Sanitization di Go

> **Berlaku:** Go 1.21+ · OWASP Top 10 · **Lihat juga:** `security_owasp/casbin_rbac_abac.md` · `db_sqlc/sqlc_pgx_driver.md` · `testing_quality/fuzz_testing_go.md` · `microservices_grpc/rest_chi_middleware_stack.md`

## 1. Konsep dan Internals (Technical Depth)

Validasi dan sanitasi input adalah lapis pertahanan utama (*first line of defense*) melawan berbagai vektor serangan OWASP Top 10, termasuk Injection (SQLi, Command), Cross-Site Scripting (XSS), Path Traversal, dan Malicious File Execution. Dalam ekosistem Go, kita mengandalkan pendekatan multi-lapis (Defense-in-Depth):

1. **Structural Validation (Type & Boundary)**: Memastikan input sesuai dengan format, tipe data, dan batasan panjang yang diharapkan. Umumnya menggunakan *struct tags* dengan library seperti `go-playground/validator`. Validasi tidak mengubah data, hanya menolak (*reject*) jika salah.
2. **Sanitization (Mutation)**: Proses memodifikasi input untuk menghilangkan atau menetralisir karakter berbahaya sebelum diproses. Misalnya, menghapus tag `<script>` dari input HTML menggunakan library seperti `microcosm-cc/bluemonday`.
3. **Escaping (Contextual Output)**: Mengubah karakter khusus menjadi representasi yang aman pada konteks tertentu (HTML, SQL, URL). Di Go, `html/template` melakukan *context-aware escaping* secara otomatis, sedangkan *parameterized query* (`database/sql`) meng-handle escaping untuk SQL.
4. **Canonicalization (Normalization)**: Proses menormalkan input ke bentuk dasar atau standarnya. Ini sangat kritis untuk mencegah *Path Traversal* (di mana `/a/b/../c` dinormalisasi menjadi `/a/c`) dan kebingungan Unicode (di mana karakter yang terlihat sama memiliki representasi *byte* berbeda).
5. **ReDoS (Regular Expression Denial of Service)**: Go `regexp` secara internal mengkompilasi pola menjadi DFA/NFA tanpa *backtracking*, yang menjamin *linear time complexity* $O(N)$ terhadap panjang input. Go kebal terhadap serangan ReDoS klasik, tetapi aplikasi tetap rentan terhadap keletihan memori (*OOM*) jika membaca *payload* dalam ukuran yang tak dibatasi.

## 2. Diagram ASCII: Arsitektur Validasi Multi-Lapis

```text
[ Attacker / Client ]
         |
         | (HTTP POST /profile) Payload JSON / Form Data
         v
+-------------------------------------------------------------+
| 1. HTTP Middleware (Size Limiter)                           |
|    http.MaxBytesReader(w, r.Body, 1<<20) // Max 1MB         |
|    Mencegah DoS (OOM, Billion Laughs, dll)                  |
+-------------------------------------------------------------+
         |
         v
+-------------------------------------------------------------+
| 2. Canonicalization Layer                                   |
|    - Unicode NFC Normalization (norm.NFC)                   |
|    - Path Normalization (filepath.Clean)                    |
+-------------------------------------------------------------+
         |
         v
+-------------------------------------------------------------+
| 3. Structural Validation (Validator)                        |
|    - Cek tipe data, min/max length, Enum, Regex             |
|    - Cek Null Bytes (\x00) & invalid UTF-8                  |
+-------------------------------------------------------------+
         |
         v
+-------------------------------------------------------------+
| 4. Sanitization & Escaping (Context-Specific)               |
|    - XSS: bluemonday (strip dangerous HTML)                 |
|    - SQL: sql.Stmt / Parameterized Queries ($1)             |
+-------------------------------------------------------------+
         |
         v
[ Safe Business Logic & Persistence Layer ]
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: SQL Injection via String Concatenation

**Mengapa berbahaya (Exploit Vector)**: Memasukkan input mentah pengguna langsung ke dalam query SQL memungkinkan *attacker* untuk mengubah semantik atau struktur query. Serangan ini dapat digunakan untuk membaca seluruh isi database (data exfiltration), mem-bypass login, atau menghapus tabel.

```go
// VULNERABLE: SQL Injection
func getUserVulnerable(ctx context.Context, db *sql.DB, username string) error {
	// ❌ BAD: Menggabungkan string secara manual
	query := "SELECT * FROM users WHERE username = '" + username + "'"
	
	// Attacker mengirim username:  admin' OR '1'='1
	// Query menjadi: SELECT * FROM users WHERE username = 'admin' OR '1'='1'
	_, err := db.ExecContext(ctx, query)
	return err
}
```

```go
// ✅ GOOD: Menggunakan Parameterized Queries (Prepared Statements)
func getUserSafe(ctx context.Context, db *sql.DB, username string) error {
	// Driver DB akan memisahkan antara struktur query dan data input
	query := "SELECT * FROM users WHERE username = $1"
	_, err := db.ExecContext(ctx, query, username)
	return err
}
```

### ❌ Anti-Pattern 2: Path Traversal pada File System

**Mengapa berbahaya (Exploit Vector)**: Mengizinkan klien untuk menentukan nama file yang akan dibaca/ditulis tanpa memvalidasi jalurnya. Attacker dapat mengeksploitasi karakter `../` (*dot-dot-slash*) untuk keluar dari direktori root yang dituju (misal `/var/www/images`) dan mengakses file rahasia sistem seperti `/etc/passwd` atau `.env`.

```go
// VULNERABLE: Path Traversal
func downloadFileVulnerable(w http.ResponseWriter, r *http.Request) {
	// ❌ BAD: Membaca path langsung dari input pengguna
	filename := r.URL.Query().Get("file") 
	
	// Attacker mengirim: ?file=../../../etc/passwd
	// Hasil baca: /var/www/uploads/../../../etc/passwd -> /etc/passwd
	data, _ := os.ReadFile("/var/www/uploads/" + filename)
	w.Write(data)
}
```

```go
// ✅ GOOD: Menggunakan filepath.Clean dan memeriksa Base Path
func downloadFileSafe(w http.ResponseWriter, r *http.Request) {
	filename := r.URL.Query().Get("file")
	
	// 1. Bersihkan path (menghilangkan resolve ../)
	cleanPath := filepath.Clean(filename)
	
	// 2. Pastikan file hanya nama file saja, tidak ada path lain
	if cleanPath != filepath.Base(cleanPath) {
		http.Error(w, "Invalid filename", http.StatusBadRequest)
		return
	}
	
	// 3. Gabungkan dengan root direktori yang pasti aman
	safePath := filepath.Join("/var/www/uploads/", cleanPath)
	data, err := os.ReadFile(safePath)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	w.Write(data)
}
```

### ❌ Anti-Pattern 3: Reflected XSS pada API Response / Template

**Mengapa berbahaya (Exploit Vector)**: Memasukkan input tak tervalidasi langsung ke dalam *response* HTTP sebagai `text/html`. Klien/browser yang menerima respons akan mengeksekusi tag `<script>` yang disisipkan oleh attacker. Ini dapat berujung pada pencurian *Session Cookie* atau tindakan atas nama korban (*Account Takeover*).

```go
// VULNERABLE: Reflected XSS
func searchHandlerVulnerable(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	w.Header().Set("Content-Type", "text/html")
	
	// ❌ BAD: Mencetak payload langsung ke output browser
	// Attacker mengirim: ?q=<script>alert(document.cookie)</script>
	fmt.Fprintf(w, "<h1>Search results for: %s</h1>", query)
}
```

```go
// ✅ GOOD: Menggunakan html/template atau Escaping eksplisit
func searchHandlerSafe(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	w.Header().Set("Content-Type", "text/html")
	
	// html.EscapeString mengubah < menjadi &lt;
	safeQuery := html.EscapeString(query)
	fmt.Fprintf(w, "<h1>Search results for: %s</h1>", safeQuery)
}
```

## 4. Edge Cases & Defensive Programming Khusus Go

1. **Null Byte Injection (`\x00`)**: String di Go (yang merupakan slice of byte) *mengizinkan* kehadiran karakter `null byte`. Akan tetapi, sistem file di level OS atau *C-bindings* (CGO) membaca string sebagai *null-terminated* string. Sebuah attacker dapat mengirim file bernama `malicious.php\x00.jpg`. Validasi Go (berpikir berakhiran `.jpg`) mungkin akan meloloskannya, tetapi OS akan menyimpannya sebagai `malicious.php`. **Selalu periksa dan tolak input yang mengandung `\x00` (`strings.ContainsRune(input, '\x00')`)**.
2. **Unicode Normalization bypass**: Karakter Unicode memiliki beberapa bentuk representasi. Misalnya, karakter huruf vokal dengan aksen bisa direpresentasikan dengan 1 *codepoint* (NFC) atau gabungan huruf + *modifier* (NFD). Attacker bisa menggunakan NFD untuk *bypass* filter atau WAF, sementara di backend lain data itu dinormalisasi kembali dan dieksekusi sebagai bahaya. **Lakukan normalisasi (misal: `golang.org/x/text/unicode/norm.NFC.String()`) sebelum melakukan regex/validasi**.
3. **Mismatched Content-Type Parsing**: Pada eksekusi `r.ParseMultipartForm()`, jika file di-upload tapi ukurannya sangat besar, Go akan menaruh sisanya di *temporary files* (`/tmp`). Attacker bisa melakukan DoS pada disk dengan *upload* berbarengan. Selalu batas total ukuran payload dari request sebelum pemrosesan via `http.MaxBytesReader(w, r.Body, Limit)`.
4. **Time of Check to Time of Use (TOCTOU)**: Terutama di OS file sistem. Anda memvalidasi path, memeriksa eksistensinya `os.Stat(path)`, dan jika aman, membacanya. Namun dalam seperseribu detik antara cek dan baca, attacker mengubah *symlink* file tersebut menuju `/etc/shadow`. Di Go, berhati-hatilah dengan fungsi yang mengandalkan file sistem; buka file *descriptor* (handle) secara langsung secepatnya lalu periksa fstat dari file deskriptor tersebut, bukan path string-nya.

## 5. Production-Ready Go Code

Kode di bawah menunjukkan pipeline yang matang: menerima request HTTP body berformat JSON, membatasi ukuran, mencegah null-byte, melakukan validasi struktural, membersihkan konten HTML (XSS prevention), dan memvalidasi keamanan nama file (Path Traversal prevention).

```go
package security

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/go-playground/validator/v10"
	"github.com/microcosm-cc/bluemonday"
	"golang.org/x/text/unicode/norm"
)

// UserProfile merepresentasikan payload yang harus divalidasi dan disanitasi
type UserProfile struct {
	// Validasi alphanumeric, panjang maksimal 32, diwajibkan
	Username string `json:"username" validate:"required,alphanum,min=3,max=32"`
	// Validasi email
	Email string `json:"email" validate:"required,email"`
	// Bio bisa berisi teks/HTML tapi harus disanitasi.
	Bio string `json:"bio" validate:"max=500"`
	// Avatar filename untuk di-save (contoh skenario path traversal)
	AvatarFile string `json:"avatar_file" validate:"required,max=100"`
}

var (
	validate      *validator.Validate
	htmlSanitizer *bluemonday.Policy
)

// init menginisialisasi validator dan sanitizer di awal proses
func init() {
	validate = validator.New()
	
	// bluemonday.UGCPolicy membolehkan tag formatting aman (<b>, <i>, dsb), 
	// namun menghilangkan tag berbahaya (<script>, <object>, event handlers onclick)
	htmlSanitizer = bluemonday.UGCPolicy()
}

// ParseAndValidateProfile membaca input dari HTTP request, mencegah payload raksasa,
// memeriksa encoding, sanitasi path dan XSS, lalu mengembalikan data bersih.
func ParseAndValidateProfile(ctx context.Context, body io.Reader) (*UserProfile, error) {
	// Defensive: Pastikan context belum dibatalkan (timeout/closed connection)
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("context error before validation: %w", err)
	}

	var req UserProfile
	
	// Dekode JSON dengan ketat
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return nil, fmt.Errorf("invalid json payload: %w", err)
	}

	// 1. Unicode Normalization (Canonicalization)
	// Penting untuk memastikan karakter direpresentasikan dalam bentuk standar.
	req.Username = norm.NFC.String(req.Username)
	req.Email = norm.NFC.String(req.Email)
	req.Bio = norm.NFC.String(req.Bio)
	req.AvatarFile = norm.NFC.String(req.AvatarFile)

	// 2. Fundamental Safety Check: Reject Null Bytes & Non-UTF8
	if !isSafeString(req.Username) || !isSafeString(req.Email) || 
	   !isSafeString(req.Bio) || !isSafeString(req.AvatarFile) {
		return nil, errors.New("malicious payload: contains null bytes or invalid utf-8")
	}

	// 3. Structural Validation (Validator library)
	if err := validate.Struct(req); err != nil {
		return nil, fmt.Errorf("structural validation failed: %w", err)
	}

	// 4. Sanitization (XSS Prevention on Bio)
	req.Bio = htmlSanitizer.Sanitize(req.Bio)

	// 5. Canonicalization (Path Traversal Prevention on AvatarFile)
	// filepath.Clean menormalisasi path (menghapus ../ dan ./)
	cleanPath := filepath.Clean(req.AvatarFile)
	// Jika file asal berbeda dengan base file-nya, berarti ada path structure yang dicoba diinput.
	// misal: "dir/image.png" != "image.png"
	if cleanPath != req.AvatarFile || filepath.Base(cleanPath) != cleanPath {
		return nil, errors.New("malicious payload: path traversal attempt detected in filename")
	}

	// Di sini, req sudah aman dari injeksi dasar, XSS, dan Path traversal
	return &req, nil
}

// isSafeString memeriksa apakah sebuah string adalah UTF-8 valid dan bebas null-byte.
func isSafeString(s string) bool {
	if strings.ContainsRune(s, '\x00') {
		return false
	}
	return utf8.ValidString(s)
}

// ==========================================
// Unit Tests (Testing Security Boundaries)
// ==========================================

func TestParseAndValidateProfile_SecurityBoundaries(t *testing.T) {
	tests := []struct {
		name      string
		payload   string
		expectErr bool
		errString string // Substring expected in error
		check     func(t *testing.T, res *UserProfile)
	}{
		{
			name: "Valid input (Happy Path)",
			payload: `{"username": "johndoe", "email": "john@example.com", "bio": "Hello world", "avatar_file": "profile.png"}`,
			expectErr: false,
			check: func(t *testing.T, res *UserProfile) {
				if res.Username != "johndoe" {
					t.Errorf("expected username johndoe, got %s", res.Username)
				}
			},
		},
		{
			name: "Reflected XSS Sanitization Boundary",
			// Attacker injects malicious JS and an iframe
			payload: `{"username": "attacker", "email": "att@example.com", "bio": "<p>My Bio</p><script>alert(1)</script><iframe src='javascript:alert(1)'></iframe>", "avatar_file": "img.png"}`,
			expectErr: false, // Disanitasi (diubah), bukan ditolak
			check: func(t *testing.T, res *UserProfile) {
				if strings.Contains(res.Bio, "<script>") || strings.Contains(res.Bio, "<iframe>") {
					t.Errorf("XSS sanitization failed, dangerous tags persisted: %s", res.Bio)
				}
				if !strings.Contains(res.Bio, "<p>My Bio</p>") {
					t.Errorf("Sanitizer removed safe tags too aggressively: %s", res.Bio)
				}
			},
		},
		{
			name: "Path Traversal Boundary (Dot-Dot-Slash)",
			payload: `{"username": "attacker", "email": "att@example.com", "bio": "Bio", "avatar_file": "../../../etc/passwd"}`,
			expectErr: true,
			errString: "path traversal attempt",
			check: nil,
		},
		{
			name: "Path Traversal Boundary (Absolute Path)",
			payload: `{"username": "attacker", "email": "att@example.com", "bio": "Bio", "avatar_file": "/var/www/secret.key"}`,
			expectErr: true,
			errString: "path traversal attempt",
			check: nil,
		},
		{
			name: "Null Byte Injection (C-string bypass)",
			payload: `{"username": "admin\u0000", "email": "att@example.com", "bio": "Bio", "avatar_file": "img.png"}`,
			expectErr: true,
			errString: "contains null bytes",
			check: nil,
		},
		{
			name: "Structural Boundary (SQL Injection payload bypassed by length/type)",
			// Username memiliki spasi dan quote (bukan alphanum), harusnya direject struct validation
			payload: `{"username": "admin' OR 1=1--", "email": "att@example.com", "bio": "Bio", "avatar_file": "img.png"}`,
			expectErr: true,
			errString: "structural validation failed",
			check: nil,
		},
		{
			name: "Unknown Fields Injection (Mass Assignment attempt)",
			// Attacker mencoba mengubah is_admin
			payload: `{"username": "johndoe", "email": "j@ex.com", "bio": "Hi", "avatar_file": "f.png", "is_admin": true}`,
			expectErr: true,
			errString: "invalid json payload", // due to DisallowUnknownFields
			check: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			bodyReader := strings.NewReader(tt.payload)
			
			res, err := ParseAndValidateProfile(ctx, bodyReader)
			if tt.expectErr {
				if err == nil {
					t.Errorf("Expected error but got nil")
					return
				}
				if !strings.Contains(err.Error(), tt.errString) {
					t.Errorf("Expected error containing %q, got: %v", tt.errString, err)
				}
			} else {
				if err != nil {
					t.Errorf("Did not expect error but got: %v", err)
					return
				}
				if tt.check != nil {
					tt.check(t, res)
				}
			}
		})
	}
}
```

## Kapan JANGAN Pakai Ini

- **Validasi hanya di sisi klien.** Itu untuk pengalaman pengguna, bukan keamanan. Setiap permintaan bisa dibuat tanpa melewati klien Anda sama sekali.
- **Blacklist karakter.** Selalu ada pengodean yang terlewat — Unicode, URL-encoding ganda, homoglif. Whitelist bentuk yang diizinkan; itu daftar yang bisa Anda buktikan lengkap.
- **Sanitasi sebagai pengganti pengodean kontekstual.** Nilai yang aman di badan HTML belum tentu aman di dalam atribut, URL, atau JavaScript. Yang benar adalah mengodekan **di titik penggunaan**, bukan membersihkan di titik masuk.
- **`fmt.Sprintf` untuk menyusun SQL, perintah shell, atau path berkas.** Jawabannya masing-masing: parameterisasi query, `exec.Command` dengan argumen terpisah, dan `filepath.Clean` diikuti pemeriksaan awalan direktori.
- **Validasi yang menerima lalu "memperbaiki".** Perbaikan otomatis bisa menghasilkan nilai yang lolos pemeriksaan tetapi tidak diinginkan — dan penyerang akan mencari bentuk yang berubah menjadi sesuatu yang berguna baginya. Tolak yang tidak valid.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Query dengan bentuk aneh di `pg_stat_statements` | SQL yang tidak berparameter | Query disusun dengan penggabungan string |
| Berkas terbaca dari luar direktori yang dimaksud | penanganan path dari input | Path traversal |
| Proses anak dijalankan dengan argumen tak terduga | `exec.Command` dengan shell | Command injection |
| Lonjakan `400` dari satu sumber | payload yang ditolak | Ada yang sedang menguji batas validasi |
| Panic pada input tertentu | apakah jalur itu di-fuzz | Ada bentuk input yang belum pernah dicoba |

```bash
# gosec: G201/G202 SQL string, G204 subprocess, G304 path dari variabel
gosec -include=G201,G202,G204,G304 ./...

grep -rn 'fmt.Sprintf' --include='*.go' . | grep -iE 'select |insert |update |delete |where '
grep -rn 'exec.Command' --include='*.go' . | grep -v '_test.go'

# Fuzzing adalah cara paling efektif menemukan input yang belum terpikirkan
go test -fuzz=FuzzHandler -fuzztime=120s ./...

# Siapa yang sedang menguji batas validasi Anda
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.status==400) | "\(.ip) \(.path)"' | sort | uniq -c | sort -rn | head
```
