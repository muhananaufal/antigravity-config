# Panduan Master: Security Scanning dalam CI/CD Golang

> **Berlaku:** Go 1.21+ · Trivy / govulncheck / gitleaks · **Lihat juga:** `testing_quality/govulncheck_security_scan.md` · `cybersecurity_zerotrust/binary_signing_verification.md` · `ci_cd_pipeline/github_actions_go.md` · `devops_control_planes/docker_container_go.md`

Dokumen ini merupakan panduan komprehensif tingkat master untuk mengintegrasikan pengujian keamanan (Security Scanning) ke dalam pipeline CI/CD aplikasi Golang. Praktik keamanan modern mewajibkan *Shift-Left Security*, di mana pemindaian kerentanan dilakukan seawal mungkin dalam siklus hidup pengembangan perangkat lunak (SDLC).

## 1. Arsitektur & Analisis Internals

Integrasi CI/CD keamanan untuk Golang bukan sekadar menjalankan perintah, tetapi memahami lapisan di mana kerentanan dapat muncul: pada tingkat *source code* (SAST), tingkat dependensi (SCA/Vuln Check), dan tingkat infrastruktur/container.

### Diagram ASCII: Pipeline Keamanan CI/CD Golang

```text
+-------------------+       +-------------------+       +--------------------+
|   Developer IDE   | ----> |   Git Repository  | ----> |   CI Trigger (PR)  |
| (gosec pre-commit)|       | (GitHub/GitLab)   |       |  (GitHub Actions)  |
+-------------------+       +-------------------+       +--------------------+
                                                              |
                                                              v
+---------------------------------------------------------------------------------+
|                                CI/CD Pipeline                                   |
|                                                                                 |
| 1. Dependency Review: Snyk / GitHub Dependency Review                           |
| 2. SAST Scanning    : gosec (AST Analysis)                                      |
| 3. Vuln Analysis    : govulncheck (Call Graph Analysis)                         |
|                                                                                 |
|  [ MERGE BLOCKER: Gagal jika ditemukan CRITICAL/HIGH vulnerabilities ]          |
|                                                                                 |
| 4. Build Artifact   : go build (dengan CGO_ENABLED=0 untuk isolasi)             |
| 5. SBOM Generation  : syft (Pembuatan Software Bill of Materials)               |
| 6. SLSA Provenance  : slsa-github-generator (Attestation)                       |
| 7. Container Build  : Docker build                                              |
| 8. Image Scanning   : Trivy / Docker Scout (CVE & Misconfig)                    |
+---------------------------------------------------------------------------------+
                                                              |
                                                              v
                                                    +--------------------+
                                                    |  Artifact Registry |
                                                    | (Signed & Scanned) |
                                                    +--------------------+
```

## 2. govulncheck: Analisis Kerentanan Level Code & Binary

`govulncheck` adalah alat resmi dari tim Go yang tidak hanya melihat file `go.mod` (seperti alat SCA tradisional), tetapi juga melakukan analisis *Call Graph* (graf pemanggilan). 

**Internals:**
`govulncheck` menganalisis AST (Abstract Syntax Tree) dan SSA (Static Single Assignment) dari kode Go untuk memastikan apakah fungsi yang rentan dari dependensi *benar-benar dipanggil* dalam aplikasi. Ini secara dramatis mengurangi *false positives*.

### Integrasi CI (Mengeblok Merge jika ada CRITICAL)

```yaml
# .github/workflows/govulncheck.yml
name: Go Vulnerability Check
on:
  pull_request:
    branches: [ "main" ]

jobs:
  vuln-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.22'
          
      - name: Install govulncheck
        run: go install golang.org/x/vuln/cmd/govulncheck@latest
        
      - name: Run govulncheck (Block on CRITICAL)
        # Menjalankan govulncheck dalam mode test, mengekstrak output JSON
        # Jika ditemukan kerentanan, pipeline ini akan gagal dan mengeblok PR merge
        run: |
          govulncheck ./... || (echo "🚨 Vulnerabilities found!" && exit 1)
```

## 3. gosec (Golang Security Checker): SAST Scanning

`gosec` memindai kode sumber Golang untuk menemukan kelemahan keamanan dengan mem-parsing AST Golang tanpa melakukan evaluasi *type checking* penuh (lebih cepat namun bisa memicu false positives). `gosec` sangat krusial untuk menemukan kelemahan spesifik Go seperti penggunaan `unsafe`, SQL injection, hardcoded credentials, dan error unhandled pada operasi I/O.

### Konfigurasi & Suppressions

Untuk menangani *false positives*, `gosec` mendukung penggunaan tag komentar direktif. Namun, penggunaan *suppression* ini harus diaudit ketat agar tidak menyembunyikan kelemahan nyata.

```go
package main

import (
    "crypto/md5"
    "fmt"
)

// Contoh fungsi yang sengaja menggunakan algoritma hashing lemah (MD5) untuk kompatibilitas sistem lama
// Penggunaan tag // #nosec G401 akan menekan peringatan gosec secara lokal tanpa mematikan rule secara global
func generateLegacyHash(data []byte) string {
    /* #nosec G401 -- Alasan: Berinteraksi dengan API legacy pihak ketiga yang mengharuskan penggunaan MD5. Bukan untuk kriptografi keamanan modern. */
    h := md5.New()
    h.Write(data)
    return fmt.Sprintf("%x", h.Sum(nil))
}
```

## 4. Container Image Scanning: Trivy & Docker Scout

Setelah aplikasi di-build ke dalam container, pemindaian tingkat OS dan paket tingkat aplikasi diperlukan.

### Trivy (Standard Industri)
Trivy memindai container images untuk CVE OS (Alpine, Debian, dll.) dan miskonfigurasi (Infrastructure as Code).

```yaml
# .github/workflows/trivy.yml
name: Container Image Scan
on:
  push:
    branches: [ "main" ]

jobs:
  trivy-scan:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        
      - name: Build an image from Dockerfile
        run: docker build -t my-go-app:${{ github.sha }} .
        
      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: 'my-go-app:${{ github.sha }}'
          format: 'table'
          exit-code: '1' # Gagal pipeline jika...
          ignore-unfixed: true
          vuln-type: 'os,library'
          severity: 'CRITICAL,HIGH' # Hanya blok jika severity HIGH/CRITICAL
```

### Docker Scout (Perbandingan)
Docker Scout lebih terintegrasi dengan Docker Desktop dan ekosistem Docker Hub. Ia unggul dalam memberikan rekomendasi *remediation* yang kontekstual (misal: "Update base image ke versi X untuk menambal kerentanan ini"). Trivy lebih fleksibel untuk lingkungan CI/CD agnostic.

## 5. Software Supply Chain: Dependency Review, SBOM & SLSA

Peretasan Supply Chain (*Supply Chain Attacks*) menuntut visibilitas mendalam ke komponen yang kita gunakan.

### Software Bill of Materials (SBOM) dengan `syft`

SBOM adalah daftar lengkap semua komponen pihak ketiga, library, dan dependensi (serta versinya) yang digunakan dalam artefak. `syft` membaca binary Go dan image container untuk mengekstraksinya.

```bash
# Mengekstrak SBOM ke format SPDX JSON
syft packages dir:. -o spdx-json=sbom.spdx.json
```

### SLSA (Supply-chain Levels for Software Artifacts) Provenance

SLSA Provenance adalah bukti kriptografis bahwa sebuah artefak di-build dari *source code* yang benar, di CI/CD yang tepercaya, dan tidak dimodifikasi.

```yaml
# SLSA Provenance Generation Job (GitHub Actions)
  provenance:
    needs: [build]
    permissions:
      actions: read
      id-token: write # Dibutuhkan untuk OIDC token
      contents: write
    uses: slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v1.9.0
    with:
      base64-subjects: "${{ needs.build.outputs.hashes }}"
      upload-assets: true
```

## 6. Anti-Patterns (❌ BAD vs ✅ GOOD)

### Anti-Pattern 1: Pemindaian (Scanning) Setelah Deploy (Terlambat)

❌ **BAD:** Menjalankan pemindaian kerentanan pada container hanya setelah image di-push ke registry produksi atau setelah di-deploy ke Kubernetes cluster.
```yaml
# BAD CI Pipeline
steps:
  - run: docker build -t app:latest .
  - run: docker push registry/app:latest
  - run: kubectl apply -f deployment.yaml
  - run: trivy image registry/app:latest # TERLAMBAT! Malware/CVE sudah di produksi.
```

✅ **GOOD:** *Fail-fast*. Menjalankan SAST, SCA, dan Image Scanning sebelum build dan push. Blokir proses jika ditemukan kerentanan di ambang batas.
```yaml
# GOOD CI Pipeline
steps:
  - run: govulncheck ./... # Blok jika rentan di level source
  - run: docker build -t app:latest .
  - run: trivy image --exit-code 1 --severity CRITICAL app:latest # Blok push jika image rentan
  - run: docker push registry/app:latest
```

### Anti-Pattern 2: Mengabaikan Seluruh Temuan gosec Secara Membuta

❌ **BAD:** Mengabaikan *error return value* secara massal dengan mengecualikan flag tertentu atau memasang `#nosec` tanpa alasan valid pada kode kritis.
```go
// BAD
/* #nosec */ 
db.Exec("UPDATE users SET password_hash = '" + req.Password + "' WHERE id = " + req.ID) // Bahaya SQL Injection tingkat tinggi tetap dieksekusi tanpa teguran CI karena #nosec membabi buta.
```

✅ **GOOD:** Lakukan audit, dan jika memang merupakan false positive, spesifikkan rule yang di-*suppress* lengkap dengan alasannya.
```go
// GOOD
// #nosec G201 -- Alasan: Statement ini dieksekusi terhadap in-memory SQLite untuk unit test internal, tidak ada external user input yang masuk.
db.Exec(fmt.Sprintf("CREATE TABLE %s (id INTEGER)", testTableName))
```

## 7. Edge Cases Implementatif

Berikut adalah skenario lapangan dan *edge cases* yang sering muncul dalam penerapan keamanan pipeline Go:

1. **False Positive Suppression yang Terbengkalai (Drift):** 
   Seiring berjalannya waktu, kode berubah, namun komentar `#nosec` tetap tertinggal, berisiko menyembunyikan kelemahan baru yang disisipkan tanpa sengaja. 
   *Solusi:* Secara periodik jadwalkan *security audit sprint* untuk meninjau ulang semua file yang memiliki direktif *suppression*.
2. **Air-Gapped Environments (Lingkungan Tanpa Internet):** 
   `govulncheck` dan `trivy` membutuhkan koneksi internet untuk mengunduh *vulnerability database* terbaru (seperti OSV). Dalam lingkungan *air-gapped* CI/CD, pipeline akan gagal (*timeout*).
   *Solusi:* Konfigurasikan Trivy Client-Server mode atau *offline database download*, dan gunakan proxy internal seperti Artifactory untuk melakukan sinkronisasi modul Golang secara aman.
3. **Efisiensi Mono-repo Scanning:** 
   Pada Golang mono-repo besar, pemindaian `gosec` dan `govulncheck` pada seluruh proyek di setiap pull request memakan waktu berjam-jam (menghalangi produktivitas developer).
   *Solusi:* Terapkan logika diferensial. Gunakan tool seperti `tj-actions/changed-files` di GitHub Actions untuk mendeteksi *module* mana yang mengalami perubahan, lalu arahkan pemindaian SAST hanya ke direktori yang terdampak (*delta scanning*).
4. **Rate Limiting API GitHub / Docker Hub:** 
   Saat pipeline sering mem-pull *base image* Alpine untuk di-scan dan di-build, batasan *rate limit* sering terjadi dan memecahkan CI/CD.
   *Solusi:* Gunakan *authenticated pulls* untuk memperluas rate limit, dan sediakan Docker registry mirror / pull-through cache (seperti ECR Pull Through Cache atau Harbor) di dalam ekosistem CI.
5. **CGO Vulnerability Scanning:** 
   `govulncheck` sangat piawai memindai dependensi asli Golang. Namun, jika menggunakan `CGO_ENABLED=1` dan mengandalkan *shared libraries* C (seperti librdkafka atau sqlite3), kerentanan di C library tersebut *tidak* akan tertangkap oleh alat SAST Golang.
   *Solusi:* CGO menuntut pemindaian hibrida. Selain `govulncheck`, gunakan Trivy pada container final, dan pastikan memindai *fs* (filesystem) untuk mendeteksi versi paket C yang kadaluarsa.

## 8. Unit Test / Config Test untuk Validasi Keamanan

Sebagai Best Practice DevOps, konfigurasi CI/CD dan fungsi keamanan *harus* dapat dites. Berikut adalah contoh tes unit yang memvalidasi parsing konfigurasi keamanan untuk memastikan flag seperti TLS selalu aktif.

```go
package config_test

import (
	"os"
	"testing"
	"gopkg.in/yaml.v3"
)

// Config merepresentasikan struktur konfigurasi aplikasi
type Config struct {
	Database struct {
		Host     string `yaml:"host"`
		RequireTLS bool `yaml:"require_tls"`
	} `yaml:"database"`
	Security struct {
		DisableSAST bool `yaml:"disable_sast_in_dev"`
	} `yaml:"security"`
}

// TestProductionSecurityConfig memvalidasi bahwa konfigurasi produksi
// tidak pernah mengizinkan koneksi non-TLS atau menonaktifkan fitur keamanan.
func TestProductionSecurityConfig(t *testing.T) {
	// Membaca file konfigurasi (asumsi file disimulasikan sebagai string atau file di fixtures)
	yamlContent := []byte(`
database:
  host: "db.production.internal"
  require_tls: true
security:
  disable_sast_in_dev: false
`)

	var cfg Config
	err := yaml.Unmarshal(yamlContent, &cfg)
	if err != nil {
		t.Fatalf("failed to unmarshal configuration: %v", err)
	}

	// Memastikan koneksi database wajib TLS
	if !cfg.Database.RequireTLS {
		t.Errorf("critical: require_tls in production must be true to prevent MiTM. Current value: %v", cfg.Database.RequireTLS)
	}

	// Memastikan fitur SAST tidak pernah dimatikan secara tidak sengaja di produksi
	if cfg.Security.DisableSAST {
		t.Errorf("Kritis: disable_sast_in_dev tidak boleh aktif di lingkungan manapun selain local dev.")
	}
}

// TestGosecSuppressionValidator mensimulasikan linter internal yang 
// mengecek jangan sampai ada #nosec global yang diizinkan dalam direktori /core.
func TestGosecSuppressionValidator(t *testing.T) {
    // Simulasi path file core (domain bisnis yang paling sensitif)
    fileContent := []byte(`package core
    /* #nosec */
    func DangerousOperation() {}
    `)
    
    // Logika verifikasi sederhana
    importStr := string(fileContent)
    if containsGlobalNosec(importStr) {
        t.Errorf("Kebijakan perusahaan melanggar: Penggunaan /* #nosec */ global tanpa penentuan Rule (misal G404) dilarang pada paket 'core'.")
    }
}

func containsGlobalNosec(code string) bool {
    // Dalam realita, gunakan library regex atau parser AST
    // Ini adalah simulasi logika
    import "strings"
    return strings.Contains(code, "/* #nosec */")
}
```

## Kapan JANGAN Pakai Ini

- **Memindai kode tapi tidak memindai image yang benar-benar dirilis.** Yang berjalan di produksi adalah image, bukan repo. Kerentanan di base image tidak akan pernah muncul pada pemindaian sumber.
- **Gerbang yang memblokir berdasarkan severity, bukan eksploitabilitas.** Banyak CVE "HIGH" tidak berlaku untuk cara Anda memakai paketnya. `govulncheck` yang menganalisis jalur panggilan jauh lebih layak memblokir daripada pemindai berbasis versi.
- **Pengecualian tanpa tanggal kedaluwarsa.** Pengecualian permanen menjadi lubang permanen, dan tidak ada yang akan meninjaunya lagi. Setiap pengecualian WAJIB punya tanggal dan pemilik.
- **Menjalankan seluruh pemindai pada setiap commit.** Waktu CI membengkak dan orang mencari jalan memintas. Pemindaian cepat di setiap PR, pemindaian dalam terjadwal.
- **Hasil pemindaian yang tidak masuk ke tempat yang dilihat orang.** Laporan di artefak CI yang tidak pernah diunduh sama saja dengan tidak ada pemindaian — hanya lebih mahal.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| CVE ditemukan audit eksternal, bukan CI | apa yang dipindai | Image rilis tidak ikut dipindai |
| Daftar pengecualian terus bertambah | tanggal dan pemilik pengecualian | Pengecualian jadi permanen |
| Tim menambahkan pengecualian secara refleks | rasio temuan yang benar-benar relevan | Gerbang memblokir berdasarkan severity saja |
| Rahasia ter-commit dan lolos | apakah ada pemindai rahasia | Tidak ada gerbang untuk kredensial |
| Waktu CI didominasi pemindaian | durasi tiap langkah | Semua pemindai berjalan di setiap commit |

```bash
# Yang berjalan di produksi adalah IMAGE -- pindai itu, bukan hanya repo
trivy image --severity HIGH,CRITICAL --exit-code 1 registri/api:1.4.2
trivy fs --scanners vuln,secret,misconfig .

# Eksploitabilitas, bukan sekadar keberadaan versi rentan
govulncheck ./...
govulncheck -mode=binary ./dist/app

# Rahasia di riwayat, bukan hanya di working tree
gitleaks detect --source . --redact --log-opts='--all'

# Pengecualian tanpa tanggal kedaluwarsa
grep -rn 'ignore\|exception' .trivyignore .golangci.yml 2>/dev/null | grep -v '20[0-9][0-9]-'
```
