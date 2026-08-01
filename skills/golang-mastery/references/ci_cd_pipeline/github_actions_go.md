# Panduan Master-Level: CI/CD Pipeline Golang menggunakan GitHub Actions

Dokumen ini adalah referensi mendalam (master-level) untuk merancang, mengimplementasikan, dan mengelola Continuous Integration dan Continuous Deployment (CI/CD) pipeline untuk proyek Golang menggunakan GitHub Actions. Pipeline yang dibangun akan scalable, aman, efisien secara performa, dan mencakup praktik terbaik dari industri.

---

## 1. Arsitektur CI/CD Pipeline (ASCII Diagram)

Berikut adalah topologi lengkap dari pipeline CI/CD standard industri untuk aplikasi Golang. Alur ini memastikan bahwa setiap Pull Request (PR) diverifikasi dengan ketat dan setiap merge ke `main` menghasilkan artefak yang siap di-deploy secara deterministik.

```text
                  [PULL REQUEST]                             [MERGE TO MAIN / TAG]
                        │                                             │
                        ▼                                             ▼
        ┌───────────────────────────────┐             ┌───────────────────────────────┐
        │       1. Linter & Static      │             │        1. Pre-release         │
        │       Analysis (golangci)     │             │        Checks (Lint, Test)    │
        └───────────────┬───────────────┘             └───────────────┬───────────────┘
                        │                                             │
                        ▼                                             ▼
        ┌───────────────────────────────┐             ┌───────────────────────────────┐
        │       2. Unit Test &          │             │        2. Build Go Binary     │
        │       Coverage Check          │             │        (CGO_ENABLED=0)        │
        └───────────────┬───────────────┘             └───────────────┬───────────────┘
                        │                                             │
                        ▼                                             ▼
        ┌───────────────────────────────┐             ┌───────────────────────────────┐
        │       3. Benchmark            │             │        3. Docker Build &      │
        │       Regression Detect       │             │        Push (GHCR/ECR)        │
        └───────────────┬───────────────┘             └───────────────┬───────────────┘
                        │                                             │
                        ▼                                             ▼
        ┌───────────────────────────────┐             ┌───────────────────────────────┐
        │       4. Dependency Review    │             │        4. Deploy to Staging/  │
        │       (Dependabot/GH Action)  │             │        Production (K8s/Helm)  │
        └───────────────┬───────────────┘             └───────────────────────────────┘
                        │
                        ▼
                  [PR APPROVED]
```

---

## 2. Reusable Workflows (workflow_call)

Praktik terbaik di tingkat enterprise adalah memisahkan definisi pipeline menjadi _reusable workflows_. Hal ini menghilangkan duplikasi konfigurasi antara pipeline PR dan pipeline Deployment.

### 2.1. File: `.github/workflows/go-test-lint.yml` (Reusable)
Workflow ini fokus murni pada statik analisis dan test matrix.

```yaml
name: Go CI Checks (Reusable)

on:
  workflow_call:
    inputs:
      go-version:
        required: true
        type: string
        description: "Versi Go yang digunakan"
    secrets:
      PRIVATE_GOPROXY_TOKEN:
        required: false

jobs:
  lint:
    name: Lint Codebase
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: ${{ inputs.go-version }}
          cache: true # Built-in caching setup-go v4+

      - name: Run golangci-lint
        uses: golangci/golangci-lint-action@v3
        with:
          version: latest
          args: --timeout=5m
          skip-cache: false # Gunakan cache bawaan action

  test-matrix:
    name: Run Tests
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        go: ["1.21.x", "1.22.x", "1.23.x"]
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: ${{ matrix.go }}
          cache: true

      - name: Cache Go modules and Build Cache
        uses: actions/cache@v4
        with:
          path: |
            ~/.cache/go-build
            ~/go/pkg/mod
          key: ${{ runner.os }}-go-${{ matrix.go }}-${{ hashFiles('**/go.sum') }}
          restore-keys: |
            ${{ runner.os }}-go-${{ matrix.go }}-

      - name: Run Tests with Coverage
        env:
          GOPROXY: "https://proxy.golang.org,direct"
        run: |
          go test -v -race -coverprofile=coverage.out -covermode=atomic ./...

      - name: Enforce Coverage Threshold (80%)
        run: |
          COVERAGE=$(go tool cover -func=coverage.out | grep total: | grep -Eo '[0-9]+\.[0-9]+')
          echo "Current Coverage: $COVERAGE%"
          if (( $(echo "$COVERAGE < 80.0" | bc -l) )); then
            echo "Coverage is below threshold of 80%."
            exit 1
          fi
```

### 2.2. Implementasi PR Pipeline
Menggunakan file _reusable_ di atas untuk setiap pull request.

```yaml
name: Pull Request Verification

on:
  pull_request:
    branches: [ "main" ]

permissions:
  contents: read
  pull-requests: write

jobs:
  validate:
    uses: ./.github/workflows/go-test-lint.yml
    with:
      go-version: '1.23.x'

  dependency-review:
    name: Review Dependencies
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4
      - name: Dependency Review
        uses: actions/dependency-review-action@v4
        with:
          fail-on-severity: high

  benchmark-regression:
    name: Benchmark Checks
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Base Branch
        uses: actions/checkout@v4
        with:
          ref: ${{ github.base_ref }}
      - name: Run Base Benchmarks
        run: go test -run=^$ -bench=. ./... > base_bench.txt

      - name: Checkout PR Branch
        uses: actions/checkout@v4
        with:
          clean: false
      - name: Run PR Benchmarks
        run: go test -run=^$ -bench=. ./... > pr_bench.txt

      - name: Compare Benchmarks (benchstat)
        run: |
          go install golang.org/x/perf/cmd/benchstat@latest
          ~/go/bin/benchstat base_bench.txt pr_bench.txt > bench_results.txt
          cat bench_results.txt
          # Implement custom logic here to fail if regression is > 10%
```

---

## 3. Deployment Workflow (Build, Docker, Deploy)

Workflow ini dipicu ketika PR dimerge ke `main`. Melibatkan pembuatan Docker image yang secure (distroless) dan deployment.

```yaml
name: Build and Deploy

on:
  push:
    branches: [ "main" ]
    tags: [ 'v*.*.*' ]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.23.x'
          cache: true

      - name: Compile Go Binary (CGO Disabled for Scratch/Distroless)
        env:
          CGO_ENABLED: 0
          GOOS: linux
          GOARCH: amd64
        run: go build -ldflags="-w -s -X main.Version=${{ github.ref_name }}" -a -installsuffix cgo -o app-binary ./cmd/server

      - name: Log in to the Container registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata (tags, labels) for Docker
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=semver,pattern={{version}}
            type=sha,format=short

      - name: Build and push Docker image
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          # Optimization: Build cache via Buildx
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: build-and-push
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Trigger Deployment Webhook / SSH / Helm
        env:
          DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
        run: |
          echo "Deploying newly pushed image to cluster..."
          # Contoh mock call: curl -X POST https://api.k8s.local/deploy -H "Authorization: Bearer $DEPLOY_TOKEN" -d '{"image": "ghcr.io/repo/app:sha"}'
```

---

## 4. Anti-Patterns & Best Practices

### ❌ Anti-Pattern 1: Hardcoding Secrets dan Credentials di File YAML
Mencantumkan API key atau kredensial database langsung di pipeline YAML atau test files adalah resiko keamanan fatal (OWASP Top 10). Jika repositori bersifat publik, kredensial tersebut akan di-scraping oleh bot dalam hitungan detik.

```yaml
# ❌ BAD: Secret terpampang nyata
steps:
  - name: Run Integration Tests
    run: go test -v ./...
    env:
      DB_PASSWORD: "super_secret_password_123!"
      AWS_ACCESS_KEY: "AKIAIOSFODNN7EXAMPLE"
```
**Penjelasan:**
File YAML masuk ke sistem Version Control (Git). Siapa pun yang memiliki riwayat pull akan memiliki token ini selamanya, meskipun file diubah di commit berikutnya.

```yaml
# ✅ GOOD: Menggunakan GitHub Secrets dan Environment
steps:
  - name: Run Integration Tests
    run: go test -v ./...
    env:
      DB_PASSWORD: ${{ secrets.DB_PASSWORD }}
      AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
      AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```
**Penjelasan:**
Rahasia dikelola secara aman oleh Secrets Manager GitHub. Nilainya diinjeksi hanya saat *runtime* dan secara otomatis disensor (di-mask) dalam log output jika tidak sengaja di-*print*.

### ❌ Anti-Pattern 2: Tidak Menggunakan Cache untuk Build dan Modul
Go akan mengunduh semua modul dari internet dan mengkompilasi ulang seluruh standard library dan third-party library pada setiap *runner* jika cache tidak diatur.

```yaml
# ❌ BAD: Setiap run membuang waktu 2-3 menit hanya untuk download
steps:
  - name: Setup Go
    uses: actions/setup-go@v4
    with:
      go-version: '1.23'
      # Lupa mengaktifkan cache!
  - name: Build
    run: go build -o app ./...
```
**Penjelasan:**
Waktu CI sangat mahal dan memblokir kecepatan *feedback loop* developer. Menjalankan dependensi instalasi dari nol setiap saat akan menguras limit kuota GitHub Actions dan memperlambat tim.

```yaml
# ✅ GOOD: Setup-Go v4+ sudah support implicit cache, ATAU konfigurasi manual cache secara spesifik.
steps:
  - name: Setup Go
    uses: actions/setup-go@v5
    with:
      go-version: '1.23.x'
      cache: true
      cache-dependency-path: go.sum
```
**Penjelasan:**
Dengan me-*restore* GOCACHE (`~/.cache/go-build`) dan GOMODCACHE (`~/go/pkg/mod`), waktu kompilasi berikutnya bisa berkurang hingga 80-90% untuk file yang tidak berubah.

---

## 5. Testing Pipeline Configurations (Act & Go Tests)

Memvalidasi bahwa skrip yang dijalankan CI berjalan benar bisa dilakukan secara lokal atau dalam unit tests Go untuk parser konfigurasinya.

### Test 1: Testing Coverage Threshold Parsing (Go Unit Test)
Ini memastikan bahwa skrip shell yang kita gunakan di CI tidak gagal akibat *floating point parsing*.

```go
package ci_test

import (
	"bytes"
	"os/exec"
	"testing"
)

func TestCoverageThresholdEnforcement(t *testing.T) {
	// Mensimulasikan output 'go tool cover'
	mockOutput := []byte("total:      (statements)    82.5%")
	
	cmd := exec.Command("grep", "-Eo", "[0-9]+\\.[0-9]+")
	cmd.Stdin = bytes.NewReader(mockOutput)
	
	var out bytes.Buffer
	cmd.Stdout = &out
	
	err := cmd.Run()
	if err != nil {
		t.Fatalf("Failed to grep mock coverage: %v", err)
	}
	
	coverageStr := out.String()
	// Di skrip bash: bc -l <<< "$COVERAGE < 80.0"
	if coverageStr != "82.5\n" {
		t.Errorf("Expected extracted coverage to be 82.5, got: %s", coverageStr)
	}
}
```

### Test 2: Konfigurasi Mock Test Environment File
Menguji apakah aplikasi dapat mendeteksi saat dijalankan di dalam lingkungan CI.

```go
package config_test

import (
	"os"
	"testing"
)

func TestIsCIEnvironment(t *testing.T) {
	// GitHub Actions set variable "GITHUB_ACTIONS" to "true"
	os.Setenv("GITHUB_ACTIONS", "true")
	defer os.Unsetenv("GITHUB_ACTIONS")

	isCI := os.Getenv("GITHUB_ACTIONS") == "true"
	
	if !isCI {
		t.Error("Application failed to recognize it is running inside a CI pipeline")
	}
	
	// Biasanya di CI kita matikan color output
	os.Setenv("NO_COLOR", "1")
	if os.Getenv("NO_COLOR") != "1" {
		t.Error("NO_COLOR flag not correctly processed")
	}
}
```

### Test 3: Local CI Testing dengan `act` (NECTAS)
Gunakan tool CLI [`act`](https://github.com/nektos/act) untuk menjalankan GitHub actions lokal sebelum di-push.

```bash
# Contoh command lokal untuk menjalankan job "lint" tanpa push
act -j lint

# Menjalankan spesifik test-matrix untuk arsitektur linux ubuntu-latest (Go 1.23)
act pull_request -j test-matrix --matrix os:ubuntu-latest --matrix go:1.23.x
```
Ini sangat krusial untuk mencegah commit beruntun dengan pesan "fix ci yaml typo".

---

## 6. Edge Cases Implementatif di Dunia Nyata

### Edge Case 1: Flaky Tests / Isolasi State (Race Condition in CI)
Di lokal, test mungkin berjalan *sequential*. Di CI, parameter `-race` mengaktifkan race detector yang memperlambat eksekusi dan bisa memicu timeout atau mengekspos *goroutine leak*.
**Solusi:**
Gunakan `t.Cleanup` untuk mereset *global state*, atau hindari *global variables*. Pada CI, perpanjang *timeout* test khusus untuk race condition `go test -race -timeout=10m ./...` karena detektor instruksi overhead-nya besar.

### Edge Case 2: CGO Dependency (C++ Libraries, SQLite)
Jika Go app menggunakan `sqlite3` atau library CGO lainnya, environment *Ubuntu latest* di GitHub Actions mungkin tidak memiliki compiler `gcc` untuk platform *cross-compilation* (misal build macOS dari Linux).
**Solusi:**
Pastikan setup dependencies OS (apt-get) dan jangan disable CGO.
```yaml
      - name: Install C Compiler
        run: sudo apt-get update && sudo apt-get install -y build-essential gcc-aarch64-linux-gnu
      - name: Build with CGO
        env:
          CGO_ENABLED: 1
          GOOS: linux
          GOARCH: arm64
          CC: aarch64-linux-gnu-gcc
        run: go build -o app ./...
```

### Edge Case 3: Private Go Modules (Private Repositories)
Bila proyek bergantung pada *private repository* lain di organisasimu, perintah `go mod download` akan gagal karena autentikasi HTTP ke GitHub.
**Solusi:**
Setel `GOPRIVATE` dan gunakan `GITHUB_TOKEN` dalam Git config URL.
```yaml
      - name: Configure Git for Private Modules
        run: git config --global url."https://${{ secrets.PAT_TOKEN }}@github.com".insteadOf "https://github.com"
      - name: Download Modules
        env:
          GOPRIVATE: github.com/my-org/*
        run: go mod download
```
*(Catatan: Jangan gunakan token default, gunakan Personal Access Token yang memiliki *read access* ke repo terkait).*

### Edge Case 4: Self-Hosted Runner vs GitHub-Hosted
GitHub-hosted runner menyediakan lingkungan *clean/ephemeral* pada tiap eksekusinya. Sebaliknya, *Self-hosted runner* (misal VM EC2 Anda sendiri) menjaga persistensi sistem file, yang mana sisa-sisa build sebelumnya bisa membuat *false-positives* atau menghabiskan kapasitas disk over time (GOCACHE membengkak).
**Solusi:**
Di pipeline untuk self-hosted runner, pastikan *cleanup step* selalu dieksekusi terlepas status job:
```yaml
      - name: Cleanup Workdir (Self-Hosted)
        if: always()
        run: |
          go clean -modcache -cache
          rm -rf ${{ github.workspace }}/*
```

### Edge Case 5: Rate Limiting dari Go Proxy atau Docker Hub
Penarikan image *base* secara masif tiap PR bisa menyebabkan _Too Many Requests_ (429 HTTP) dari DockerHub jika IP public GitHub diblok.
**Solusi:**
Otentikasi selalu ke registry, atau gunakan *GitHub Container Registry (GHCR)* atau layanan proxy *mirrors* perusahaan. Untuk library Go, secara default telah melewati *proxy.golang.org* yang *rate limit*-nya sangat longgar, namun ini bisa jadi masalah jika internal VPN memblokirnya, sehingga perlu men-setup *Go Proxy / Athens* internal di jaringan CI.

---
*End of Document. Referensi ini diformat agar aplikatif langsung dalam skala production level system.*
