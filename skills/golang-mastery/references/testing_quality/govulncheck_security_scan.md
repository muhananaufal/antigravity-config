# Security Scanning di Go: govulncheck, gosec & golangci-lint

> **Berlaku:** Go 1.21+ · `govulncheck` v1+ · `gosec` · `golangci-lint` · **Lihat juga:** `testing_quality/fuzz_testing_go.md` · `cybersecurity_zerotrust/security_fuzzing_go.md` · `cli_tooling/binary_distribution_release.md` · `runtime_internals/build_system_linker.md`

Keamanan supply chain dan static analysis adalah bagian tak terpisahkan dari pipeline CI Go modern. `govulncheck` melakukan analisis vulnerability level call-graph, bukan sekadar version matching. `gosec` mendeteksi pola kode berbahaya. `golangci-lint` mengintegrasikan keduanya dalam satu pipeline yang efisien.

---

## 1. Arsitektur Scanning Pipeline

```
Source Code + go.sum
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│               Security Scanning Pipeline                       │
│                                                               │
│  ┌─────────────────┐    ┌─────────────────┐                 │
│  │   govulncheck   │    │     gosec        │                 │
│  │                 │    │                  │                 │
│  │  1. Build call  │    │  AST traversal   │                 │
│  │     graph       │    │  → pattern match │                 │
│  │  2. Match vulns │    │  G101: hardcode  │                 │
│  │     ke fungsi   │    │  G204: cmd inject│                 │
│  │     yang        │    │  G401: weak crypto│                │
│  │     DIPANGGIL   │    │  G501: md5/sha1  │                 │
│  └────────┬────────┘    └────────┬─────────┘                 │
│           │                      │                            │
│           └──────────┬───────────┘                            │
│                      ▼                                        │
│              golangci-lint (meta-runner)                      │
│              ├── govulncheck linter                           │
│              ├── gosec linter                                 │
│              ├── errcheck linter                              │
│              └── staticcheck linter                           │
└───────────────────────────────────────────────────────────────┘
        │
        ▼
   CI Gate: exit code 1 → block merge
```

**Keunggulan `govulncheck` vs dependency scanner tradisional:**

| Aspek | Dependabot / nancy | govulncheck |
|---|---|---|
| Level analisis | `go.mod` version | Call graph (fungsi yg dipanggil) |
| False positive | Tinggi (vuln di-import tapi tidak dipanggil) | Sangat rendah |
| Speed | Cepat | Agak lebih lambat (perlu build) |
| Akurasi | Medium | Tinggi |

---

## 2. Kode Go Production-Ready

```go
package testingquality

import (
	"crypto/md5" // #nosec G501 — HANYA untuk demonstrasi, JANGAN di production
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// SecurityFlaws mendemonstrasi kode yang akan di-flag oleh gosec.
// PERINGATAN: Ini adalah contoh kode BERBAHAYA — JANGAN gunakan pattern ini di production.
func SecurityFlaws(userInput string) string {
	// G101: Hardcoded credentials (password, API key, token)
	apiKey := "sk-live-hardcoded-secret-abc123" //nolint:gosec // demo only
	fmt.Printf("key: %s\n", apiKey)

	// G204: Subprocess launched with variable → Command Injection
	// userInput bisa bernilai: "ls; rm -rf /"
	cmd := exec.Command("sh", "-c", userInput) //nolint:gosec // demo only
	out, _ := cmd.Output()

	// G401: Weak cryptographic primitive (MD5)
	h := md5.New() //nolint:gosec // demo only
	h.Write([]byte("data"))

	return string(out)
}

// perintahDiizinkan memetakan nama ke JALUR ABSOLUT.
//
// Nama telanjang seperti "ls" diselesaikan exec.Command lewat $PATH, dan
// penyerang yang bisa memengaruhi PATH proses — variabel lingkungan yang
// diwarisi, unit systemd yang salah tulis, entrypoint kontainer — mendapat
// eksekusi arbitrer meski daftar putihnya sempurna. Jalur absolut menutup itu.
var perintahDiizinkan = map[string]string{
	"ls":  "/bin/ls",
	"pwd": "/bin/pwd",
}

// SafeAlternatives mendemonstrasikan pola aman sebagai pengganti SecurityFlaws.
func SafeAlternatives(userInput string) (string, error) {
	parts := strings.Fields(userInput)
	if len(parts) == 0 {
		return "", fmt.Errorf("empty command")
	}

	jalur, ok := perintahDiizinkan[parts[0]]
	if !ok {
		return "", fmt.Errorf("command %q not allowed", parts[0])
	}

	// ARGUMEN juga divalidasi, bukan hanya nama perintahnya.
	//
	// Inilah setengah yang biasanya hilang: mendaftarputihkan BINER tidak
	// sama dengan mendaftarputihkan OPERASI. `ls` yang diizinkan tetap
	// menerima `ls -la /etc` atau `ls /home/korban` — perintahnya sah,
	// pembacaannya tidak. Untuk contoh ini hanya nama berkas relatif tanpa
	// komponen path yang diterima.
	for _, a := range parts[1:] {
		if strings.HasPrefix(a, "-") {
			return "", fmt.Errorf("option %q not allowed", a)
		}
		if a != filepath.Base(a) || strings.Contains(a, "..") {
			return "", fmt.Errorf("argument %q contains path components", a)
		}
	}

	// exec.Command dengan args TERPISAH, bukan `sh -c`.
	cmd := exec.Command(jalur, parts[1:]...) // #nosec G204 — jalur & argumen sudah divalidasi
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("execute %q: %w", parts[0], err)
	}
	return string(out), nil
}

// SecureHTTPHeaders contoh middleware untuk security header.
func SecureHTTPHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		// frame-ancestors menggantikan X-Frame-Options di browser modern dan
		// lebih ekspresif; keduanya dipasang demi klien lama.
		w.Header().Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'")

		// HSTS HANYA di HTTPS — dan sebelumnya komentarnya menyatakan itu
		// sementara kodenya memasangnya tanpa syarat apa pun. Komentar yang
		// menjanjikan kondisi yang tidak ada di kode adalah bentuk kesalahan
		// paling mudah lolos review.
		if lewatHTTPS(r) {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

// lewatHTTPS memperhitungkan terminator TLS di depan aplikasi.
//
// Pada topologi ingress/ALB yang menghentikan TLS, r.TLS bernilai nil di
// dalam pod dan pemeriksaan `r.TLS != nil` saja membuat HSTS tidak pernah
// terkirim — senyap. X-Forwarded-Proto hanya boleh dipercaya bila memang ada
// proxy tepercaya di depan; tanpa itu, klien bisa menuliskannya sendiri.
func lewatHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return diBalikProksiTepercaya && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// diBalikProksiTepercaya disetel dari konfigurasi deployment, bukan ditebak.
const diBalikProksiTepercaya = true

// TestSafeAlternatives memverifikasi bahwa fungsi aman bekerja dengan benar
// dan menolak command yang tidak diizinkan.
func TestSafeAlternatives(t *testing.T) {
	t.Run("allowed command pwd", func(t *testing.T) {
		out, err := SafeAlternatives("pwd")
		if err != nil {
			t.Fatalf("SafeAlternatives(pwd) unexpected error: %v", err)
		}
		if len(out) == 0 {
			t.Error("expected non-empty output from pwd")
		}
	})

	t.Run("disallowed command rm rejected", func(t *testing.T) {
		_, err := SafeAlternatives("rm -rf /tmp/test")
		if err == nil {
			t.Error("expected error for disallowed command, got nil")
		}
		if !strings.Contains(err.Error(), "not allowed") {
			t.Errorf("expected 'not allowed' in error, got: %v", err)
		}
	})

	t.Run("shell injection attempt rejected", func(t *testing.T) {
		_, err := SafeAlternatives("ls; rm -rf /")
		if err == nil {
			t.Error("expected error for injection attempt, got nil")
		}
	})

	t.Run("empty input rejected", func(t *testing.T) {
		_, err := SafeAlternatives("")
		if err == nil {
			t.Error("expected error for empty input")
		}
	})
}

// TestSecureHTTPHeaders memverifikasi seluruh security header.
func TestSecureHTTPHeaders(t *testing.T) {
	handler := SecureHTTPHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// httptest.NewRequest, bukan http.NewRequest dengan galat dibuang `_`.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	mau := map[string]string{
		"X-Content-Type-Options":  "nosniff",
		"X-Frame-Options":         "DENY",
		"Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
	}
	for h, v := range mau {
		if got := rec.Header().Get(h); got != v {
			t.Errorf("header %q = %q, mau %q", h, got, v)
		}
	}

	// HSTS adalah satu-satunya header yang komentarnya keliru pada versi
	// sebelumnya — dan satu-satunya yang tidak diperiksa uji ini.
	if !strings.Contains(rec.Header().Get("Strict-Transport-Security"), "max-age=") {
		t.Error("HSTS missing behind TLS terminator")
	}
}

func TestSecureHTTPHeaders_TanpaHTTPSTidakAdaHSTS(t *testing.T) {
	handler := SecureHTTPHeaders(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	req := httptest.NewRequest(http.MethodGet, "/", nil) // tanpa TLS, tanpa X-Forwarded-Proto
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Header().Get("Strict-Transport-Security") != "" {
		t.Error("HSTS set on non-TLS connection")
	}
}
```

### 2.1. Konfigurasi `.golangci.yml` Production-Ready

```yaml
# .golangci.yml
run:
  timeout: 5m
  go: "1.23"

linters-settings:
  gosec:
    severity: medium
    confidence: medium
    includes:
      - G101 # Hardcoded credentials
      - G102 # Bind to all interfaces
      - G201 # SQL query construction via format string
      - G204 # Subprocess launched with variable
      - G304 # File path injection
      - G401 # Use of weak cryptographic primitive
      - G501 # Import of crypto/md5
      # G601 (implicit memory aliasing) SENGAJA tidak disertakan: masalah
      # yang dideteksinya tidak ada lagi sejak semantik variabel loop
      # berubah di Go 1.22, dan `run.go` di atas menyatakan 1.23.
      # Mengaktifkannya hanya menghasilkan derau di basis kode modern.

# CATATAN PENTING: govulncheck BUKAN linter golangci-lint.
#
# Versi sebelumnya menaruh blok `govulncheck:` di bawah `linters-settings`.
# Blok itu sepenuhnya INERT — golangci-lint tidak mengenal nama itu, tidak
# ada linter maupun setelan bernama demikian, sehingga tidak satu pun
# pemindaian kerentanan benar-benar berjalan. Yang lebih buruk dari tidak
# memasangnya adalah memasang sesuatu yang terlihat seperti sudah terpasang.
#
# govulncheck adalah alat TERPISAH dan dijalankan sebagai langkah CI sendiri:
#   go install golang.org/x/vuln/cmd/govulncheck@latest
#   govulncheck ./...

linters:
  disable-all: true
  enable:
    - govet         # vet checks
    - errcheck      # unhandled errors
    - staticcheck   # comprehensive static analysis
    - gosec         # security
    - nilerr        # return nil error with non-nil value
    - godot         # comment formatting
    - revive        # fast linter (replacement for golint)

issues:
  exclude-rules:
    # Izinkan nolint yang spesifik (bukan massal)
    - linters: [gosec]
      text: "G104"  # Unhandled errors dalam defer
```

### 2.2. Integrasi CI (GitHub Actions)

```yaml
# .github/workflows/security.yml
name: Security Scan
on: [push, pull_request]

jobs:
  govulncheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
      - name: Install govulncheck
        run: go install golang.org/x/vuln/cmd/govulncheck@latest
      - name: Run govulncheck
        run: govulncheck ./...
        # Exit code 1 jika ada vuln yang benar-benar dipanggil → block merge

  golangci-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: golangci/golangci-lint-action@v6
        with:
          version: latest
          args: --timeout=5m
```

---

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Mematikan Linter dengan `//nolint` Massal Tanpa Alasan

```go
// BAD: mematikan semua linter di seluruh fungsi — menyembunyikan injeksi nyata
//nolint
func ProcessUserInput(input string) {
    cmd := exec.Command("sh", "-c", input) // command injection tersembunyi!
    cmd.Run()
}

// GOOD: nolint spesifik per-linter + komentar penjelasan MENGAPA aman
//nolint:gosec // G204: input sudah divalidasi oleh whitelist di validateCommand()
func ProcessUserInput(input string) {
    cmd := exec.Command("sh", "-c", input)
    cmd.Run()
}
```

**Kenapa berbahaya:** `//nolint` massal adalah "bungkam semua alarm kebakaran" di rumah Anda. Ketika vulnerability nyata ditambahkan belakangan, linter tidak akan melaporkannya. Selalu scope `//nolint` ke linter spesifik dan tambahkan alasan.

### ❌ Anti-Pattern 2: Menggunakan Dependabot/nancy Saja (Tanpa govulncheck)

```yaml
# BAD: hanya cek versi di go.mod — banyak false positive
# Dependabot melaporkan: "package X menggunakan fungsi Y yang vulnerable"
# Padahal kode kita tidak pernah memanggil fungsi Y tersebut
# Hasilnya: ratusan false positive yang melelahkan tim

# GOOD: tambahkan govulncheck sebagai gate utama
# govulncheck hanya melaporkan jika fungsi vulnerable benar-benar dipanggil
# dari kode kita → hampir zero false positive
```

**Kenapa berbahaya:** False positive yang tinggi menyebabkan "alert fatigue" — tim mulai mengabaikan semua vulnerability report termasuk yang nyata. govulncheck eliminates false positives via call graph analysis.

### ❌ Anti-Pattern 3: SQL Query via `fmt.Sprintf` (SQL Injection)

```go
// BAD: G201 — SQL injection via format string
func GetUser(db *sql.DB, username string) (*User, error) {
    query := fmt.Sprintf("SELECT * FROM users WHERE username = '%s'", username)
    // username = "'; DROP TABLE users; --" → SQL injection!
    return db.QueryRow(query).Scan(...)
}

// GOOD: parameterized query — database driver handles escaping
func GetUser(db *sql.DB, username string) (*User, error) {
    return db.QueryRow(
        "SELECT id, username FROM users WHERE username = $1",
        username, // parameterized — aman dari injection
    ).Scan(...)
}
```

**Kenapa berbahaya:** SQL injection adalah OWASP Top 10 #1. Parameterized query adalah satu-satunya cara yang benar-benar aman — string escaping manual selalu bisa di-bypass oleh encoding tricks.

---

## 4. Edge Cases & Defensive Programming

1. **CGO Vulnerabilities Tidak Ter-scan:** `govulncheck` dan `gosec` tidak bisa menganalisis kode C yang dipanggil via CGO. Jika paket Anda menggunakan `cgo`, integrasikan tool binary-level seperti Snyk atau Grype yang menganalisis ELF/PE binary, bukan source code.

2. **Private Module Authentication:** Saat menjalankan `govulncheck` di CI dengan private Go modules, pastikan `GOPRIVATE` dan `GONOSUMCHECK` dikonfigurasi dengan benar. Tanpa ini, govulncheck gagal fetch module graph untuk private repos.

3. **govulncheck Exit Codes:** `govulncheck` menggunakan exit code `3` untuk "vulnerability ditemukan tapi tidak ada yang benar-benar dipanggil" dan exit code `1` untuk "vulnerability yang dipanggil ditemukan". Pastikan CI hanya block di exit code `1`, bukan `3`.

4. **Vendor Directory:** Jika menggunakan `go mod vendor`, jalankan `govulncheck -C ./vendor ./...` atau pastikan vendor tidak di-exclude dari scan. Beberapa CI setup salah mengkonfigurasi ini dan tidak men-scan vendor directory.

5. **gosec dan Generated Code:** Generated code (dari protobuf, sqlc, mockgen) sering memicu false positive gosec. Gunakan `exclude-dirs` di `.golangci.yml` untuk exclude folder generated: `exclude-dirs: ["mocks", "generated", "pb"]`.

## Kapan JANGAN Pakai Ini

- **Memperlakukan setiap temuan pemindai sebagai kerentanan.** `gosec` menandai **pola**, bukan bukti bahwa sesuatu bisa dieksploitasi. `govulncheck` yang menganalisis jalur panggilan jauh lebih layak dijadikan gerbang yang memblokir.
- **Memblokir CI pada seluruh temuan `gosec` tanpa triase.** Tim akan belajar menambahkan `//nolint` secara refleks dalam dua sprint, dan sejak saat itu pemindainya berhenti bermakna. Gerbang yang terlalu ketat menghasilkan kepatuhan palsu.
- **Pemindaian berbasis versi (Dependabot, nancy) sebagai gerbang tunggal.** Ia melaporkan paket rentan meski fungsi yang rentan tidak pernah dipanggil dari kode Anda — ratusan temuan yang melelahkan dan melatih tim mengabaikan peringatan.
- **Menunda pemindaian sampai menjelang rilis.** Kerentanan yang ditemukan sehari sebelum rilis berubah menjadi keputusan bisnis di bawah tekanan, bukan keputusan teknis yang tenang.
- **Menganggap nol temuan berarti aman.** Pemindai tidak melihat otorisasi yang salah, IDOR, atau alur bisnis yang bisa disalahgunakan — justru kelas kerentanan yang paling sering benar-benar dieksploitasi.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Temuan menumpuk tanpa pernah ditutup | siapa pemiliknya | Tidak ada proses triase; laporan jadi latar belakang |
| `//nolint` bertebaran di seluruh repo | alasan yang tertulis | Gerbangnya terlalu ketat sejak awal |
| Kerentanan lolos ke produksi | apa yang dipindai | Yang dipindai kode, bukan biner yang benar-benar dirilis |
| Versi dependensi di produksi berbeda dari dugaan | `go version -m` pada biner | Yang tertaut tidak sama dengan yang tertulis di `go.mod` |
| Pemindaian selalu hijau, audit eksternal menemukan banyak | kelas kerentanan yang dicakup | Pemindai statis buta terhadap logika otorisasi |

```bash
# Hanya melaporkan yang fungsinya BENAR-BENAR terpanggil dari kode Anda
govulncheck ./...
govulncheck -format=json ./... | jq -r '.. | .osv? // empty' | sort -u

# Memindai biner yang sudah terbangun -- ini yang benar-benar dirilis
govulncheck -mode=binary ./app

gosec -fmt=json -out=gosec.json ./...
golangci-lint run --timeout=5m

# Modul yang benar-benar tertaut ke biner produksi
go version -m ./app | grep -E '^\s+(dep|=>)'

# Dependensi yang sudah punya versi lebih baru
go list -m -u all | grep '\['
```
