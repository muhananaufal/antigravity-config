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
// ✅ GOOD: Parameterized query — driver memisahkan STRUKTUR query dari DATA
func getUserSafe(ctx context.Context, db *sql.DB, username string) (*User, error) {
	// QueryRowContext, bukan ExecContext: yang ini SELECT dan hasilnya dipakai.
	// (Versi sebelumnya memakai ExecContext lalu membuang barisnya, sehingga
	// fungsi bernama getUser tidak pernah mengembalikan user.)
	var u User
	err := db.QueryRowContext(ctx,
		`SELECT id, username FROM users WHERE username = $1`, username,
	).Scan(&u.ID, &u.Username)
	if err != nil {
		return nil, err
	}
	return &u, nil
}
```

> Parameterisasi melindungi **nilai**, bukan **identifier**. Nama tabel, nama kolom, dan arah `ORDER BY` tidak bisa diparameterkan — untuk itu satu-satunya cara aman adalah memetakan input ke daftar putih nilai yang Anda tulis sendiri. `ORDER BY $1` bukan sekadar tidak aman; ia tidak berfungsi.

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
// ✅ TERBAIK (Go 1.24+): os.Root mengurung SELURUH operasi di dalam satu
// direktori. Ia menolak "..", path absolut, DAN symlink yang menunjuk keluar —
// yang terakhir tidak bisa ditangani pemeriksaan string mana pun.
var akar *os.Root // dibuka sekali saat start: os.OpenRoot("/var/www/uploads")

func downloadFileTerbaik(w http.ResponseWriter, r *http.Request) {
	f, err := akar.Open(r.URL.Query().Get("file"))
	if err != nil {
		http.Error(w, "berkas tidak ditemukan", http.StatusNotFound)
		return
	}
	defer f.Close()
	io.Copy(w, f)
}
```

```go
// ✅ CUKUP untuk Go < 1.24: bersihkan, tolak apa pun yang bukan nama berkas polos
func downloadFileSafe(w http.ResponseWriter, r *http.Request) {
	nama := r.URL.Query().Get("file")

	// `path`, bukan `path/filepath`: masukannya dari HTTP dan selalu memakai
	// garis miring depan. filepath memperlakukan backslash sebagai pemisah di
	// Windows, sehingga hasil pemeriksaan berbeda tergantung OS.
	bersih := path.Clean(nama)
	if bersih != nama || bersih != path.Base(bersih) || strings.HasPrefix(bersih, ".") {
		http.Error(w, "nama berkas tidak valid", http.StatusBadRequest)
		return
	}

	data, err := os.ReadFile(filepath.Join("/var/www/uploads", bersih))
	if err != nil {
		http.Error(w, "berkas tidak ditemukan", http.StatusNotFound)
		return
	}
	w.Write(data)
}
```

Dua lubang pada bentuk yang lebih sering ditulis (`cleanPath != filepath.Base(cleanPath)` saja):

- **`.` dan `..` LOLOS.** `filepath.Base("..")` mengembalikan `".."`, jadi kedua sisi perbandingannya sama dan nilainya diterima. Di sini ia berhenti di `os.ReadFile` karena hasilnya direktori — tetapi pada kode yang menuliskan berkas atau menyusun path lebih lanjut, ia tidak berhenti di mana pun.
- **Symlink tidak tersentuh.** `evil.png` yang merupakan symlink ke `/etc/passwd` lolos setiap pemeriksaan string, dan `os.ReadFile` mengikutinya dengan patuh. Hanya `os.Root` (atau `openat2` dengan `RESOLVE_BENEATH`) yang benar-benar menutup jalur ini. Inilah juga jawaban untuk TOCTOU di Kasus Tepi 4.

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
// ✅ GOOD: html/template melakukan escaping SESUAI KONTEKS secara otomatis
var tplCari = template.Must(template.New("cari").Parse(
	`<h1>Hasil pencarian: {{.}}</h1><a href="/ulang?q={{.}}">ulangi</a>`))

func searchHandlerSafe(w http.ResponseWriter, r *http.Request) {
	// charset WAJIB disebut. Tanpa itu sebagian klien lama menebak encoding,
	// dan penebakan itulah yang dulu membuat serangan XSS berbasis UTF-7 bisa
	// dilakukan pada halaman yang isinya sudah di-escape dengan benar.
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = tplCari.Execute(w, r.URL.Query().Get("q"))
}
```

Perhatikan potongan di atas menaruh nilai yang sama di **dua konteks berbeda** — badan HTML dan nilai atribut `href`. `html/template` mengodekannya dengan aturan yang berbeda untuk masing-masing, dan menolak URL berskema `javascript:`. Itu tepatnya yang tidak bisa dilakukan `html.EscapeString`:

- `html.EscapeString` hanya benar untuk **teks di badan HTML** dan atribut yang **diapit kutip**. Pada atribut tanpa kutip (`<div class={{.}}>`), penyerang cukup menyisipkan spasi lalu `onmouseover=...` — tidak satu pun karakter yang di-escape ikut terlibat.
- Di dalam `<script>`, `<style>`, atau sebuah URL, aturan pengodeannya berbeda sama sekali, dan `html.EscapeString` tidak melindungi apa pun di sana.

Ini juga alasan butir "Sanitasi sebagai pengganti pengodean kontekstual" ada di bagian **Kapan JANGAN Pakai Ini**: yang menentukan bukan seberapa bersih nilainya saat masuk, melainkan konteks tempat ia akhirnya dicetak.

## 4. Edge Cases & Defensive Programming Khusus Go

1. **Null Byte Injection (`\x00`) — nasihatnya benar, tetapi mekanisme yang biasa disebut TIDAK berlaku untuk Go.** String Go boleh memuat `\x00`, dan pada bahasa yang meneruskan string apa adanya ke `open(2)` hal itu memang memotong nama berkas: `malicious.php\x00.jpg` tersimpan sebagai `malicious.php`. **Di Go itu tidak terjadi.** Lapisan syscall menolak path yang memuat NUL — `syscall.BytePtrFromString` mengembalikan `EINVAL` — sehingga `os.ReadFile("x.php\x00.jpg")` gagal dengan galat, bukan membuka berkas yang salah.

   Yang tetap nyata, dan justru sering terlewat karena orang mengira Go sudah aman:
   - **CGO dan proses eksternal.** Begitu string diteruskan ke pustaka C atau argumen `exec.Command`, pemotongan gaya C berlaku lagi sepenuhnya.
   - **Sistem hilir.** Nama yang Anda simpan ke basis data akan dibaca layanan lain — PHP, Python, Java, atau penyimpanan objek — yang belum tentu seketat Go.
   - **Log dan tampilan.** NUL di tengah string memotong tampilan pada banyak alat, sehingga bukti serangan bisa hilang dari layar orang yang sedang menyelidikinya.

   Jadi tolakannya tetap wajib (`strings.ContainsRune(input, '\x00')`), tetapi ketahuilah bahwa yang Anda lindungi adalah **tetangga hilir**, bukan pemanggilan berkas Go Anda sendiri.
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
	"path"
	"strings"
	"unicode/utf8"

	"github.com/go-playground/validator/v10"
	"github.com/microcosm-cc/bluemonday"
	"golang.org/x/text/unicode/norm"
)

// Galat sentinel, supaya pemanggil bisa memetakannya ke kode HTTP dengan
// errors.Is. Pencocokan substring pesan adalah asersi yang diam-diam berhenti
// bekerja begitu kalimatnya diubah sedikit — dan pada jalur keamanan, uji yang
// diam-diam berhenti menguji lebih buruk daripada tidak ada uji.
var (
	ErrPayloadTidakValid = errors.New("payload tidak valid")
	ErrPayloadBerbahaya  = errors.New("payload berbahaya")
	ErrValidasiStruktur  = errors.New("validasi struktur gagal")
	ErrJalurBerbahaya    = errors.New("upaya path traversal pada nama berkas")
)

const (
	batasBodyProfil = 1 << 20 // 1 MiB
	batasBio        = 500
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

// ParseAndValidateProfile membaca, membatasi, menormalkan, memvalidasi, dan
// membersihkan payload profil.
func ParseAndValidateProfile(ctx context.Context, body io.Reader) (*UserProfile, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("context batal sebelum validasi: %w", err)
	}

	var req UserProfile

	// 0. BATAS UKURAN — lapis PERTAMA pada diagram §2, dan justru yang hilang
	// dari versi sebelumnya: fungsi menerima io.Reader telanjang tanpa batas
	// apa pun, sehingga satu body raksasa cukup untuk menghabiskan memori
	// proses. Seluruh lapisan berikutnya baru berjalan setelah body dibaca.
	//
	// Di handler HTTP, http.MaxBytesReader tetap WAJIB dipasang JUGA: ia
	// menghentikan pembacaan di lapisan server dan menutup koneksi dengan
	// galat yang jelas, sedangkan LimitReader di sini memotong diam-diam
	// (yang muncul sebagai galat sintaks JSON) dan hanya melindungi fungsi ini
	// bila dipanggil dari tempat lain.
	dec := json.NewDecoder(io.LimitReader(body, batasBodyProfil))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrPayloadTidakValid, err)
	}
	// Tolak apa pun SESUDAH dokumen JSON pertama. Decode hanya membaca satu
	// nilai dan mengabaikan sisanya tanpa keluhan: `{...}{"is_admin":true}`
	// lolos, dan perantara yang mem-parse dokumen KEDUA melihat isi yang
	// sama sekali berbeda dari yang dilihat aplikasi ini.
	if err := dec.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: ada data setelah objek JSON", ErrPayloadTidakValid)
	}

	// 1. Canonicalization: normalisasi Unicode ke bentuk standar.
	req.Username = norm.NFC.String(req.Username)
	req.Email = norm.NFC.String(req.Email)
	req.Bio = norm.NFC.String(req.Bio)
	req.AvatarFile = norm.NFC.String(req.AvatarFile)

	// 2. Tolak null byte dan UTF-8 tidak valid.
	if !isSafeString(req.Username) || !isSafeString(req.Email) ||
		!isSafeString(req.Bio) || !isSafeString(req.AvatarFile) {
		return nil, fmt.Errorf("%w: null byte atau UTF-8 tidak valid", ErrPayloadBerbahaya)
	}

	// 3. Validasi struktural.
	if err := validate.Struct(req); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrValidasiStruktur, err)
	}

	// 4. Sanitasi XSS.
	//
	// Perhatikan urutan dan akibatnya: sanitizer bisa MEMPERBESAR string —
	// `<` menjadi `&lt;`, satu karakter jadi empat. Panjang yang baru saja
	// lolos `max=500` bisa membengkak sampai empat kali lipat sesudahnya, dan
	// bila kolom basis datanya `varchar(500)`, kegagalannya muncul jauh dari
	// sini sebagai galat penyisipan yang membingungkan.
	req.Bio = htmlSanitizer.Sanitize(req.Bio)
	if utf8.RuneCountInString(req.Bio) > batasBio {
		return nil, fmt.Errorf("%w: bio melebihi batas setelah sanitasi", ErrValidasiStruktur)
	}

	// 5. Nama berkas.
	//
	// Dipakai `path`, BUKAN `path/filepath`: masukannya berasal dari HTTP dan
	// selalu bersemantik garis miring depan, sedangkan filepath berperilaku
	// berbeda di Windows (backslash sebagai pemisah) sehingga hasil
	// pemeriksaan bergantung pada OS tempat kode dijalankan.
	bersih := path.Clean(req.AvatarFile)
	switch {
	case bersih != req.AvatarFile: // ada yang berubah = ada struktur path
		return nil, ErrJalurBerbahaya
	case bersih != path.Base(bersih): // memuat direktori
		return nil, ErrJalurBerbahaya
	case strings.HasPrefix(bersih, "."):
		// Menangkap "." dan ".." — keduanya LOLOS pemeriksaan Base di atas,
		// karena path.Base("..") mengembalikan ".." apa adanya. Sekaligus
		// menolak berkas tersembunyi semacam ".env".
		return nil, ErrJalurBerbahaya
	}

	return &req, nil
}

// isSafeString memeriksa apakah sebuah string adalah UTF-8 valid dan bebas null-byte.
func isSafeString(s string) bool {
	if strings.ContainsRune(s, '\x00') {
		return false
	}
	return utf8.ValidString(s)
}

```

```go
package security

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestParseAndValidateProfile_BatasKeamanan(t *testing.T) {
	tests := []struct {
		name    string
		payload string
		// Sentinel, bukan substring. Uji lama mencocokkan teks pesan — asersi
		// yang berhenti bekerja tanpa suara begitu kalimatnya diubah sedikit,
		// dan pada jalur keamanan itu lebih buruk daripada tidak ada uji.
		mauGalat error
		periksa  func(t *testing.T, res *UserProfile)
	}{
		{
			name:    "jalur normal",
			payload: `{"username": "johndoe", "email": "john@example.com", "bio": "Hello world", "avatar_file": "profile.png"}`,
			periksa: func(t *testing.T, res *UserProfile) {
				if res.Username != "johndoe" {
					t.Errorf("Username = %q, mau johndoe", res.Username)
				}
			},
		},
		{
			name:    "sanitasi XSS",
			payload: `{"username": "attacker", "email": "att@example.com", "bio": "<p>My Bio</p><script>alert(1)</script><iframe src='javascript:alert(1)'></iframe>", "avatar_file": "img.png"}`,
			periksa: func(t *testing.T, res *UserProfile) {
				// Pencocokan TANPA kurung tutup. Uji lama mencari "<iframe>"
				// sementara payload-nya berisi "<iframe src=..." — asersi itu
				// tidak mungkin gagal, bahkan bila sanitizer sama sekali tidak
				// menyentuh tag iframe.
				rendah := strings.ToLower(res.Bio)
				for _, dilarang := range []string{"<script", "<iframe", "javascript:", "onerror", "onclick"} {
					if strings.Contains(rendah, dilarang) {
						t.Errorf("sanitasi gagal, %q masih ada: %s", dilarang, res.Bio)
					}
				}
				if !strings.Contains(res.Bio, "<p>My Bio</p>") {
					t.Errorf("tag aman ikut terhapus: %s", res.Bio)
				}
			},
		},
		{
			name:     "path traversal ../",
			payload:  `{"username": "attacker", "email": "att@example.com", "bio": "Bio", "avatar_file": "../../../etc/passwd"}`,
			mauGalat: ErrJalurBerbahaya,
		},
		{
			name:     "path absolut",
			payload:  `{"username": "attacker", "email": "att@example.com", "bio": "Bio", "avatar_file": "/var/www/secret.key"}`,
			mauGalat: ErrJalurBerbahaya,
		},
		{
			// LOLOS pada versi lama: Clean("..") == ".." dan Base("..") == "..",
			// jadi kedua pemeriksaannya sama-sama terpenuhi dan nilai diterima.
			name:     "titik-titik telanjang",
			payload:  `{"username": "attacker", "email": "att@example.com", "bio": "Bio", "avatar_file": ".."}`,
			mauGalat: ErrJalurBerbahaya,
		},
		{
			name:     "berkas tersembunyi",
			payload:  `{"username": "attacker", "email": "att@example.com", "bio": "Bio", "avatar_file": ".env"}`,
			mauGalat: ErrJalurBerbahaya,
		},
		{
			name: "null byte",
			payload: `{"username": "admin\u0000", "email": "att@example.com", "bio": "Bio", "avatar_file": "img.png"}`,
			mauGalat: ErrPayloadBerbahaya,
		},
		{
			// Username memuat spasi dan kutip, jadi bukan alphanum — ditolak
			// validasi struktur jauh sebelum menyentuh lapisan basis data.
			name:     "muatan SQLi ditolak validasi struktur",
			payload:  `{"username": "admin' OR 1=1--", "email": "att@example.com", "bio": "Bio", "avatar_file": "img.png"}`,
			mauGalat: ErrValidasiStruktur,
		},
		{
			name:     "field tak dikenal (mass assignment)",
			payload:  `{"username": "johndoe", "email": "j@ex.com", "bio": "Hi", "avatar_file": "f.png", "is_admin": true}`,
			mauGalat: ErrPayloadTidakValid,
		},
		{
			// Dokumen KEDUA sesudah yang pertama. Decode hanya membaca satu
			// nilai dan mengabaikan sisanya tanpa keluhan — perantara yang
			// mem-parse dokumen kedua melihat isi yang berbeda dari yang
			// dilihat aplikasi ini.
			name:     "data menyusul setelah objek JSON",
			payload:  `{"username": "johndoe", "email": "j@ex.com", "bio": "Hi", "avatar_file": "f.png"}{"username": "evil"}`,
			mauGalat: ErrPayloadTidakValid,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := ParseAndValidateProfile(context.Background(), strings.NewReader(tt.payload))
			if tt.mauGalat != nil {
				if !errors.Is(err, tt.mauGalat) {
					t.Fatalf("galat = %v, mau %v", err, tt.mauGalat)
				}
				return
			}
			if err != nil {
				t.Fatalf("tidak mengharapkan galat: %v", err)
			}
			if tt.periksa != nil {
				tt.periksa(t, res)
			}
		})
	}
}

// Body raksasa WAJIB ditolak, bukan dibaca sampai habis. Tanpa batas ini,
// lapis PERTAMA pada diagram §2 tidak ada sama sekali.
func TestBodyRaksasaDitolak(t *testing.T) {
	besar := `{"username":"abc","email":"a@b.co","bio":"` +
		strings.Repeat("x", batasBodyProfil+1024) + `","avatar_file":"a.png"}`

	if _, err := ParseAndValidateProfile(context.Background(), strings.NewReader(besar)); err == nil {
		t.Fatal("body melebihi batas diterima; tidak ada pembatas ukuran")
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
| Memori melonjak pada satu endpoint | ada tidaknya `MaxBytesReader` | Body tanpa batas dibaca utuh ke memori |
| Penyisipan DB gagal padahal validasi lolos | panjang SESUDAH sanitasi | Sanitizer memperbesar string setelah `max` diperiksa |
| Berkas terbaca padahal namanya polos | symlink di dalam direktori unggahan | Pemeriksaan string tidak menyentuh symlink |

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
