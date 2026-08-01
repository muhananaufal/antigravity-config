# Master-Level CI/CD Pipeline untuk Golang Monorepo

Ekosistem Golang modern secara progresif bergerak menuju arsitektur monorepo berkat fitur **Go Workspaces (`go.work`)** yang diperkenalkan pada Go 1.18. Monorepo menyelesaikan masalah manajemen dependensi `replace` yang sangat rumit ketika banyak modul saling bergantungan, namun memperkenalkan tantangan CI/CD baru: **Pipeline Bloat**. Tanpa desain pipeline yang presisi, perubahan sekecil apa pun dapat memicu siklus *build* dan *test* pada seluruh servis, menghabiskan resource komputasi dan memblokir kecepatan *deployment*.

Dokumen referensi ini menguraikan arsitektur CI/CD tingkat mahir untuk Golang monorepo, mencakup deteksi servis yang terdampak, optimisasi *build cache*, paralelisasi tingkat lanjut, serta penanganan *edge cases* kritis.

---

## 1. Arsitektur Monorepo & Diagram Alur CI/CD

Dalam arsitektur monorepo Go, kita memiliki banyak direktori modul yang berjalan secara independen namun berada di dalam satu repositori git.

### Diagram Alur Pipeline (ASCII)

```text
[Developer Push]
       |
       v
+---------------------------------------------------+
| 1. Deteksi Perubahan (Git Diff & Path Filtering)  |
|    - Cek file yang berubah vs base branch         |
|    - Tentukan servis/modul yang terdampak         |
+---------------------------------------------------+
       | (Hasil: ["service-auth", "pkg-logger"])
       v
+---------------------------------------------------+
| 2. Resolusi Dependensi & Build Graph              |
|    - Jika `pkg-logger` berubah, maka              |
|      `service-auth` & `service-user` juga ikut    |
|      dijadwalkan ulang untuk test.                |
+---------------------------------------------------+
       |
       +-------------------------+-------------------------+
       |                         |                         |
       v                         v                         v
+--------------+          +--------------+          +--------------+
| Job: Lint    |          | Job: Test    |          | Job: Build   |
| (GolangCI)   |          | (Parallel)   |          | (Cache Gen)  |
+--------------+          +--------------+          +--------------+
       |                         |                         |
       +-------------------------+-------------------------+
       |
       v
+---------------------------------------------------+
| 3. Security Scan (Trivy / Govulncheck)            |
+---------------------------------------------------+
       |
       v
+---------------------------------------------------+
| 4. Push Container Image & GitOps Update           |
+---------------------------------------------------+
```

---

## 2. Go Workspace (`go.work`) Multi-Module Setup

Go Workspaces meniadakan keharusan menulis direktif `replace` di setiap `go.mod` untuk dependensi lokal. Hal ini mengizinkan IDE dan Go compiler memetakan modul secara lokal.

### Setup Direktori Production-Ready

```text
/monorepo
├── go.work                  # Root workspace
├── libs/
│   ├── logger/
│   │   ├── go.mod
│   │   └── logger.go
│   └── database/
│       ├── go.mod
│       └── postgres.go
├── services/
│   ├── auth-service/
│   │   ├── go.mod
│   │   ├── main.go
│   │   └── Dockerfile
│   └── payment-service/
│       ├── go.mod
│       ├── main.go
│       └── Dockerfile
└── .github/
    └── workflows/
        └── ci.yml
```

### Konfigurasi `go.work`

```go
go 1.22

use (
	./libs/database
	./libs/logger
	./services/auth-service
	./services/payment-service
)
```

**Internal Concepts:** 
Saat CI berjalan di root direktori, perintah `go build` atau `go test` akan mencari `go.work`. Resolusi dependensi akan menggabungkan semua `go.mod` dari direktori yang didaftarkan. Jika Anda menjalankan `go build ./services/auth-service/...`, Go akan membangunnya dengan versi kode lokal dari `./libs/logger` tanpa harus mengambilnya dari registry proxy eksternal.

---

## 3. Affected Service Detection (Deteksi Servis Terdampak)

Pada GitHub Actions, kita tidak boleh menjalankan build untuk `payment-service` jika yang berubah hanya `auth-service/main.go`. Teknik ini memanfaatkan library pihak ketiga seperti `dorny/paths-filter` atau script kustom berbasis `git diff`.

### GitHub Actions YAML: Dynamic Matrix Setup

Berikut adalah konfigurasi production-ready untuk mendeteksi *affected services* dan membangun *dynamic matrix* untuk *job* berikutnya.

```yaml
name: Monorepo CI

on:
  pull_request:
    branches: [ "main" ]

jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      services: ${{ steps.filter.outputs.changes }}
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Wajib 0 untuk deteksi diff yang akurat

      - name: Detect Changed Paths
        uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            auth-service:
              - 'services/auth-service/**'
              - 'libs/logger/**'     # Dependensi tersirat
              - 'libs/database/**'
            payment-service:
              - 'services/payment-service/**'
              - 'libs/logger/**'
              - 'libs/database/**'

  build-and-test:
    needs: detect-changes
    if: ${{ needs.detect-changes.outputs.services != '[]' && needs.detect-changes.outputs.services != '' }}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        service: ${{ fromJSON(needs.detect-changes.outputs.services) }}
      fail-fast: false # Jangan hentikan payment jika auth gagal
    
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.22.x'
          cache: true

      - name: Go Test
        run: |
          # Berpindah ke konteks root karena go.work ada di root
          go test -v -race -cover ./services/${{ matrix.service }}/...
```

---

## 4. Build Cache Optimization & Parallelism

Meskipun Go memiliki caching bawaan (`GOCACHE` dan `GOMODCACHE`), di CI/CD monorepo berskala besar (ratusan modul), mengelola graph dependensi membutuhkan eksekusi terdistribusi. Konsep ala **Turborepo** atau **Bazel** (dan **Earthly**) sangat krusial.

### Earthly Basics untuk Go Monorepo

`Earthfile` (menggabungkan Dockerfile & Makefile) memungkinkan eksekusi berlapis dan terenkapsulasi secara paralel.

```earthly
VERSION 0.8

# Base image dengan caching go modules
base:
    FROM golang:1.22-alpine
    WORKDIR /monorepo
    COPY go.work .
    COPY libs/ libs/
    COPY services/ services/
    # Cache layer untuk go modules
    CACHE /go/pkg/mod
    RUN go mod download

# Reusable test target
test:
    FROM +base
    ARG SERVICE_NAME
    # GOCACHE layer untuk kompilasi lebih cepat
    CACHE /root/.cache/go-build
    RUN go test -v -race ./services/$SERVICE_NAME/...

build-auth:
    BUILD +test --SERVICE_NAME=auth-service
    FROM +base
    CACHE /root/.cache/go-build
    RUN go build -o /out/auth-service ./services/auth-service
    SAVE ARTIFACT /out/auth-service AS LOCAL build/auth-service
```

Dengan `Earthly`, saat mengeksekusi `earthly +build-auth`, layer `go mod download` dan hasil test akan tersimpan dalam *layer cache*. Paralelisasi ditangani langsung secara transparan karena dependensi direpresentasikan dalam *Directed Acyclic Graph* (DAG).

---

## 5. Anti-Patterns dalam CI/CD Monorepo

Pemahaman yang dangkal tentang CI monorepo akan memicu kesalahan fatal dalam arsitektur dan resource management.

### Anti-Pattern 1: Eksekusi Test Global Tanpa Konteks
**Kondisi:** Setiap *Pull Request* memicu `go test ./...` di root workspace, menghabiskan waktu 45 menit padahal hanya 1 file Markdown yang berubah.

❌ **BAD: Global Test Trigger**
```yaml
# ci.yml yang sangat naif
steps:
  - run: go test -v -cover ./...
```

✅ **GOOD: Differential Testing dengan DAG atau Path Filtering**
```yaml
# Hanya test direktori yang termutasi berdasarkan git diff (seperti dicontohkan di bagian 3)
# atau menggunakan Bazel/Earthly:
steps:
  - run: earthly +test-affected
```

### Anti-Pattern 2: Merusak Isolasi Modul (Shared State)
**Kondisi:** Modul-modul di dalam direktori `libs/` berbagi *state* global atau mem-bypass interface, menyebabkan *Test Flakiness* (kadang pass, kadang fail) saat dijalankan berbarengan oleh CI secara paralel (`t.Parallel()`).

❌ **BAD: Global Variable di Shared Library**
```go
// libs/database/postgres.go
package database

import "database/sql"

// DILARANG di monorepo CI paralel karena config antar service bisa bocor
var GlobalDB *sql.DB 

func Connect(dsn string) {
    GlobalDB, _ = sql.Open("postgres", dsn)
}
```

✅ **GOOD: Dependency Injection dan Encapsulation**
```go
// libs/database/postgres.go
package database

import "database/sql"

type Repository struct {
    db *sql.DB
}

func NewRepository(dsn string) (*Repository, error) {
    db, err := sql.Open("postgres", dsn)
    if err != nil {
        return nil, err
    }
    return &Repository{db: db}, nil
}
```

---

## 6. Shared Library Versioning di Monorepo

Di dalam monorepo, *library* (*packages* di dalam `/libs`) umumnya tidak di-tag versinya secara independen (seperti `v1.2.3`), melainkan mengikuti prinsip **Single Source of Truth (SSOT)**. Semua servis mem-build menggunakan commit git yang sama untuk menjamin kompatibilitas ABI (Application Binary Interface).

Namun, ada kalanya *library* di dalam monorepo perlu dipublikasikan ke eksternal (di-import dari luar monorepo). Jika demikian:
1. Pisahkan *go.mod* ke root direktori *library* tersebut.
2. Gunakan Go Git Tagging: `git tag libs/logger/v1.0.0`
3. CI/CD harus mendeteksi tag prefix dan melakukan rilis khusus.

---

## 7. Edge Cases Implementatif & Troubleshooting

Implementasi *real-world* sering kali membentur *edge cases* rumit yang tidak terdokumentasi di tutorial pemula. Berikut penanganannya:

### Edge Case 1: Circular Dependencies Antar Modul
**Gejala:** Servis A mengimpor Servis B untuk DTO (Data Transfer Object), sementara Servis B memanggil fungsi utilitas di Servis A. Compiler akan mengeluarkan error `import cycle not allowed`.
**Solusi:**
- Pisahkan struktur *interface* dan entitas bisnis ke modul ketiga (contoh: `/libs/domain`).
- Praktikkan *Clean Architecture* di mana dependensi selalu menunjuk ke dalam (ke lapisan domain), bukan melingkar.

### Edge Case 2: Shared gRPC/Protobuf Generation
**Gejala:** Update file `user.proto` gagal di-build di service lain karena CI/CD melakukan parallel build yang saling mendahului generasi file `.pb.go`. Akibatnya, `auth-service` melakukan kompilasi duluan sebelum kode Go hasil *generate* tersedia.
**Solusi:**
Jadikan *Protobuf generation* sebagai **pre-build step wajib** yang sinkron, atau masukkan hasil generasinya ke *git repository* secara paksa (commit generated files) untuk menjamin CI selalu menggunakan definisi proto yang *immutable*.

### Edge Case 3: Race Condition Saat Database E2E Testing Paralel
**Gejala:** CI matrix menjalankan testing `auth-service` dan `payment-service` secara paralel. Keduanya membuat tabel `users` pada sebuah instance PostgreSQL Docker sementara yang *shared* di CI. Tabel akan bertabrakan.
**Solusi:**
Setiap test paralel harus melempar ke schema yang di-random, atau instance Testcontainers unik per test suite:
```go
// Menggunakan Testcontainers untuk isolasi unik
ctx := context.Background()
req := testcontainers.ContainerRequest{
    Image:        "postgres:15-alpine",
    ExposedPorts: []string{"5432/tcp"},
    Env:          map[string]string{"POSTGRES_PASSWORD": "pass"},
    WaitingFor:   wait.ForLog("database system is ready to accept connections"),
}
postgres, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
    ContainerRequest: req,
    Started:          true,
})
// Lanjutkan testing...
```

### Edge Case 4: Caching Invalidation Saat go.work Berubah
**Gejala:** Menambahkan servis baru ke `go.work` merusak hash cache pada CI/CD, memaksa download ulang ribuan *packages*.
**Solusi:**
Lakukan pemisahan layer instalasi dependensi per direktori modul di Dockerfile, alih-alih melakukan `go mod download` tunggal untuk seluruh workspace di awal, kecuali jika menggunakan *build orchestrator* sekelas Bazel.

### Edge Case 5: Variabel Lingkungan dan CGO
**Gejala:** Modul yang menggunakan `CGO_ENABLED=1` (misal untuk Kafka *confluent-kafka-go* atau SQLite) akan ter-cache salah jika cross-compilation target (misal `linux/arm64`) dilakukan bersamaan di satu *runner*.
**Solusi:**
Sertakan `GOOS`, `GOARCH`, dan status `CGO_ENABLED` secara eksplisit sebagai bagian dari *cache key* di GitHub Actions:
```yaml
- uses: actions/cache@v4
  with:
    path: ~/.cache/go-build
    key: ${{ runner.os }}-go-cache-${{ hashFiles('**/go.sum') }}-${{ matrix.arch }}-cgo1
```

---

## 8. Validasi Test dan Config (Unit Testing CI Logic)

Penting bagi DevOps untuk memastikan logika path filtering dan build matrix di Actions dapat diandalkan. Ini adalah contoh *unit testing* logic menggunakan Go untuk memastikan struktur dependency tidak bocor (bisa disisipkan di pre-commit hook atau CI root step):

### Tes 1: Validasi `go.work` Modul Tersedia
Memastikan semua path yang dideklarasikan di `go.work` benar-benar ada secara fisik.

```go
package buildtest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGoWorkPathsExist(t *testing.T) {
	content, err := os.ReadFile("../../go.work")
	if err != nil {
		t.Fatalf("Gagal membaca go.work: %v", err)
	}

	lines := strings.Split(string(content), "\n")
	inUseBlock := false

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "use (") {
			inUseBlock = true
			continue
		}
		if inUseBlock && line == ")" {
			break
		}
		if inUseBlock && line != "" {
			path := strings.Trim(line, "\t ")
			if _, err := os.Stat(filepath.Join("../..", path)); os.IsNotExist(err) {
				t.Errorf("Path modul terdeklarasi di go.work namun tidak ada: %s", path)
			}
		}
	}
}
```

### Tes 2: Memastikan Tidak Ada Circular Dependency Antar Servis
Servis A tidak boleh melakukan impor ke paket internal milik Servis B.

```go
package buildtest

import (
	"golang.org/x/tools/go/packages"
	"testing"
)

func TestNoCrossServiceImport(t *testing.T) {
	cfg := &packages.Config{Mode: packages.NeedImports | packages.NeedName | packages.NeedFiles}
	pkgs, err := packages.Load(cfg, "../../services/...")
	if err != nil {
		t.Fatalf("Gagal load packages: %v", err)
	}

	for _, pkg := range pkgs {
		for impPath := range pkg.Imports {
			// Cegah auth-service mengimpor payment-service
			if strings.Contains(pkg.PkgPath, "services/auth-service") && strings.Contains(impPath, "services/payment-service") {
				t.Errorf("Pelanggaran Arsitektur: auth-service tidak boleh impor payment-service")
			}
		}
	}
}
```

### Tes 3: Linter Version Enforcement
Memastikan file `golangci-lint` tidak dimodifikasi serampangan untuk melemahkan tingkat deteksi CI.

```go
package buildtest

import (
	"os"
	"strings"
	"testing"
)

func TestGolangCILintConfig(t *testing.T) {
	content, err := os.ReadFile("../../.golangci.yml")
	if err != nil {
		t.Fatalf("Missing linter config: %v", err)
	}
	cfgStr := string(content)
	
	requiredLinters := []string{"errcheck", "gosec", "gocyclo", "staticcheck"}
	for _, l := range requiredLinters {
		if !strings.Contains(cfgStr, l) {
			t.Errorf("Linter krusial dinonaktifkan: %s. Harap pulihkan konfigurasi .golangci.yml", l)
		}
	}
}
```

---

## 9. Kesimpulan

Membangun infrastruktur CI/CD untuk Golang monorepo menuntut kedisiplinan tingkat dewa. Kombinasi yang benar antara **Go Workspaces (`go.work`)**, **Path Filtering**, **Isolation melalui DI**, dan **Build Cache** dapat memangkas waktu *feedback loop* dari puluhan menit menjadi detik. Pengalaman membuktikan bahwa investasi pada *build tooling* dan *dynamic pipeline matrix* selalu sepadan dengan pengurangan *developer frustration* seiring dengan berkembangnya tim dan basis kode.
