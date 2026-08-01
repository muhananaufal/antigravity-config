# Master-Level GitLab CI/CD untuk Golang (Internals & Best Practices)

Dokumen ini adalah referensi definitif untuk merancang, mengoptimalkan, dan mengamankan pipeline GitLab CI/CD untuk aplikasi Golang skala enterprise. Referensi ini menggali *internals* dari eksekusi runner, strategi caching tingkat lanjut, dan migrasi menuju sistem build tanpa *privileged mode*.

## 1. Arsitektur Pipeline CI/CD

Pipeline GitLab CI untuk Golang idealnya berjalan dalam tahapan linier dan paralel.

```ascii
+-----------------------------------------------------------------------------------+
|                                GitLab CI/CD Pipeline                              |
+-------+       +-------+       +-------+       +-------+       +-------+           |
| test  | ----> | lint  | ----> | build | ----> | scan  | ----> | deploy|           |
+-------+       +-------+       +-------+       +-------+       +-------+           |
| unit  |       | fmt   |       | amd64 |       | SAST  |       | dev   |           |
| race  |       | vet   |       | arm64 |       | trivy |       | prod  |           |
| cover |       | static|       | docker|       | vuln  |       |       |           |
+-------+       +-------+       +-------+       +-------+       +-------+           |
+-----------------------------------------------------------------------------------+
```

## 2. Struktur Dasar `.gitlab-ci.yml`

Berikut adalah representasi ideal sebuah pipeline modern yang modular dengan `include` templates, membedakan antara *Merge Request pipelines* dan *branch pipelines*.

```yaml
# .gitlab-ci.yml
image: golang:1.21-alpine

variables:
  CGO_ENABLED: 0
  GOOS: linux
  GOARCH: amd64
  # Menonaktifkan proxy untuk private module jika ada, fallback ke proxy publik
  GOPROXY: "https://proxy.golang.org,direct"

stages:
  - test
  - lint
  - build
  - scan
  - deploy

include:
  - project: 'ci-cd-templates/golang'
    file: '/templates/go-tests.yml'
    ref: v1.0.0

workflow:
  rules:
    # Memastikan pipeline berjalan pada Merge Request ATAU pada branch default (main), menghindari duplikasi
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH

default:
  cache:
    # Caching strategi per-branch dengan fallback ke branch utama
    key:
      files:
        - go.mod
        - go.sum
      prefix: $CI_COMMIT_REF_SLUG
    fallback_keys:
      - default-main-cache
    paths:
      - .go/pkg/mod/
      - .go/build-cache/
  before_script:
    - mkdir -p .go
    - export GOPATH="$CI_PROJECT_DIR/.go"
    - export GOCACHE="$CI_PROJECT_DIR/.go/build-cache"

# Contoh definisi stage manual dalam file utama (selain include)
go-build:
  stage: build
  script:
    - go build -ldflags="-w -s" -o bin/app ./cmd/server
  artifacts:
    paths:
      - bin/app
    expire_in: 1 week
```

### Internals: GitLab Cache vs Artifacts
- **Cache**: Digunakan untuk state yang bisa dihasilkan ulang (seperti dependensi `.go/pkg/mod`). GitLab Runner membungkus folder ini menjadi arsip ZIP dan mengunggahnya ke objek storage *sebelum* pod/container runner dihancurkan, lalu mengunduhnya lagi di *job* berikutnya.
- **Artifacts**: Digunakan untuk hasil build akhir (binary). Artifact wajib memiliki batasan *expiry* (`expire_in`) agar storage GitLab tidak membengkak tanpa kendali, yang bisa menyebabkan *out-of-disk space* (OOM/Disk full) di infrastruktur CI.

---

## 3. DinD (Docker-in-Docker) vs Kaniko: Menuju Build Tanpa Privileged

Secara tradisional, mem-build image Docker di dalam runner GitLab membutuhkan Docker-in-Docker (`docker:dind`). Pendekatan ini membutuhkan eksekusi container dengan flag `--privileged`, yang memberikan akses penuh pada host *node* Kubernetes atau Docker, membuka celah untuk *container escape attack*.

Alternatif modern adalah **Kaniko** dari Google, yang mampu membangun image container dari `Dockerfile` sepenuhnya di *userspace*, tanpa perlu akses *root* ke daemon Docker.

### Kaniko Implementation

```yaml
build-docker:
  stage: build
  image:
    name: gcr.io/kaniko-project/executor:debug
    entrypoint: [""]
  script:
    - mkdir -p /kaniko/.docker
    # Memasukkan registry credentials. CI_REGISTRY_USER dan CI_REGISTRY_PASSWORD di-inject otomatis oleh GitLab.
    - echo "{\"auths\":{\"$CI_REGISTRY\":{\"username\":\"$CI_REGISTRY_USER\",\"password\":\"$CI_REGISTRY_PASSWORD\"}}}" > /kaniko/.docker/config.json
    - /kaniko/executor
      --context "${CI_PROJECT_DIR}"
      --dockerfile "${CI_PROJECT_DIR}/Dockerfile"
      --destination "${CI_REGISTRY_IMAGE}:${CI_COMMIT_SHA}"
      --destination "${CI_REGISTRY_IMAGE}:latest"
      --cache=true
      --cache-ttl=168h
```

### Internals Kaniko
Kaniko mengekstrak sistem berkas dari `base image`, lalu mengeksekusi perintah di `Dockerfile` lapis demi lapis dengan cara `chroot` dan mencatat selisih (*diff*) file system. Hasil akhirnya disatukan ke dalam *tarball* manifest image OCI dan dipush ke registry tanpa *daemon* eksternal.

---

## 4. GitLab Environments & Deployment Tracking

Mendaftarkan deployment ke *GitLab Environments* memungkinkan pelacakan historis, tombol *rollback* instan, dan melihat status *uptime* dari metrik Prometheus secara langsung di GitLab UI.

```yaml
deploy-production:
  stage: deploy
  image: bitnami/kubectl:latest
  script:
    - kubectl set image deployment/api-server app=${CI_REGISTRY_IMAGE}:${CI_COMMIT_SHA} -n production
    - kubectl rollout status deployment/api-server -n production
  environment:
    name: production
    url: https://api.production.example.com
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
      when: manual # Mewajibkan approval manusia sebelum deploy
```

---

## 5. Anti-Patterns (BAD vs GOOD)

### Anti-Pattern 1: Docker-in-Docker Privileged Mode pada Shared Runner
Mengekspos *socket* Docker ke dalam runner dengan hak akses privileged adalah resep bencana untuk keamanan multi-tenant.

❌ **BAD (DinD Privileged):**
```yaml
build:
  image: docker:19.03.12
  services:
    - name: docker:19.03.12-dind
      # Berbahaya karena runner harus dikonfigurasi dengan privileged=true
  script:
    - docker build -t my-app .
    - docker push my-app
```
**Mengapa berbahaya?** Jika runner di-share antar *repository*, kode berbahaya di repositori A dapat me-mount sistem berkas host runner, mencuri token CI/CD repositori B, atau melakukan instalasi *rootkit* pada node.

✅ **GOOD (Kaniko / Unprivileged Builder):**
```yaml
build:
  image:
    name: gcr.io/kaniko-project/executor:debug
    entrypoint: [""]
  script:
    - /kaniko/executor --context . --destination my-registry/my-app:latest
```

### Anti-Pattern 2: Mengakumulasi Artifact Tanpa Expiry
Meninggalkan binary yang dibuild di setiap pipeline tanpa masa berlaku (expiry).

❌ **BAD (Artifact Menumpuk):**
```yaml
build-binary:
  script: go build -o main .
  artifacts:
    paths:
      - main
```
**Mengapa berbahaya?** Pipeline yang berjalan 50 kali sehari dengan artifact sebesar 50MB akan mengonsumsi 2.5GB/hari, 75GB/bulan. GitLab instance bisa kehabisan kapasitas disk, mematikan seluruh sistem CI perusahaan.

✅ **GOOD (Artifact Lifecycle):**
```yaml
build-binary:
  script: go build -o main .
  artifacts:
    paths:
      - main
    expire_in: 2 days # Dihapus setelah 2 hari
```

---

## 6. Testing Konfigurasi & Unit Test CI

Menguji konfigurasi GitLab CI tidak harus melalui *commit-and-push*. Anda bisa menggunakan utilitas validasi atau mock eksekusi secara lokal.

### Test 1: Linting `gitlab-ci.yml` menggunakan API GitLab
Pastikan file syntax valid sebelum di-push.
```bash
# Validasi sintaks lokal
curl --header "Content-Type: application/json" \
  https://gitlab.example.com/api/v4/ci/lint \
  --data "{\"content\": \"$(cat .gitlab-ci.yml | sed -e 's/\"/\\\"/g' -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g')\"}"
```

### Test 2: Local Pipeline Execution dengan `gitlab-ci-local`
Menjalankan job spesifik secara lokal untuk iterasi cepat.
```bash
# Menggunakan https://github.com/firecow/gitlab-ci-local
gitlab-ci-local go-build
# Output: [INFO] Starting job: go-build
# Output: [INFO] go build -ldflags="-w -s" -o bin/app ./cmd/server
# Output: [INFO] Job completed successfully.
```

### Test 3: Unit Test CI-CD Script (Bash)
Untuk custom *deployment script*, selalu buat unit test Bash dengan framework seperti BATS (Bash Automated Testing System).
```bash
# test_deploy.bats
#!/usr/bin/env bats

@test "Deploy script fails when kubectl is not installed" {
  run bash ./scripts/deploy.sh
  [ "$status" -eq 1 ]
  [ "${lines[0]}" = "ERROR: kubectl command not found" ]
}
```

---

## 7. Edge Cases & Penanganan Praktis

### Edge Case 1: Pipeline Eksekusi pada Fork Repositori (Secret Exposure)
**Skenario**: Pengguna melakukan *fork* repositori utama. Jika *Merge Request pipeline* terkonfigurasi salah, branch *fork* bisa mengeksekusi pipeline di *context* repositori utama dan membocorkan CI/CD variables (seperti AWS Keys) melalui `echo` atau akses *shell* dari *job*.
**Solusi**: Gunakan rule keamanan GitLab untuk MR dari fork project, atau aktifkan *protected variables* yang hanya diakses di *protected branches* (seperti `main`).
```yaml
rules:
  # Tolak pipeline jika MR datang dari fork repository
  - if: $CI_MERGE_REQUEST_SOURCE_PROJECT_PATH != $CI_PROJECT_PATH
    when: never
```

### Edge Case 2: Monorepo Skala Besar (Pipeline Triggering)
**Skenario**: Dalam *monorepo* (misal, 20 microservices), mengubah 1 file di microservice A memicu build dan deploy pada ke-20 microservice, membuang *compute resources*.
**Solusi**: Gunakan keyword `rules: changes:` untuk melacak perubahan jalur spesifik.
```yaml
build-service-a:
  script: go build ./services/service-a
  rules:
    - changes:
        - services/service-a/**/*
        - libs/common/**/* # Build jika common library berubah
```

### Edge Case 3: Race Condition Pada Cache
**Skenario**: Dua *job* (misal: Unit Test dan Linter) berjalan secara paralel di awal pipeline. Keduanya mengunduh cache dependensi, melakukan resolusi `go mod download`, dan mencoba mengunggah kembali state `.go/pkg/mod/` secara bersamaan, merusak arsip zip di objek storage.
**Solusi**: Pisahkan *job* yang memanipulasi dependensi, atau jadikan hanya satu *job* yang bertindak sebagai *cache pusher* (menggunakan policy: push), sedangkan job lain hanya read-only (policy: pull).
```yaml
download-deps:
  stage: .pre
  script: go mod download
  cache:
    key: $CI_COMMIT_REF_SLUG
    paths:
      - .go/pkg/mod/
    policy: pull-push

test:
  stage: test
  script: go test ./...
  cache:
    key: $CI_COMMIT_REF_SLUG
    paths:
      - .go/pkg/mod/
    policy: pull # Mencegah race condition upload cache
```

### Edge Case 4: OOMKilled Saat Menjalankan `go test` Pada Runner Kecil
**Skenario**: Runner dengan memori 1GB menjalankan `go test -race ./...` di aplikasi besar, menyebabkan kernel Linux menembakkan signal OOMKilled karena konsumsi memori *race detector* sangat tinggi.
**Solusi**: Batasi konkurensi build dan *test* via flag `-p` dan kelola GOGC.
```yaml
test-race:
  script:
    - export GOGC=50 # Garbage collection lebih agresif
    # Batasi konkurensi menjadi 2 goroutines saat build/test
    - go test -p 2 -race -v ./...
```

### Edge Case 5: Kredensial GitLab Registry Berakhir Kadaluarsa (Expired Token) Saat Long Build
**Skenario**: CI *Job* Token (CI_JOB_TOKEN) memiliki umur hidup yang bergantung pada eksekusi *job*. Jika proses build memakan waktu sangat lama (misal 2 jam), token tersebut bisa kadaluarsa ketika mencoba `docker push`, mengakibatkan "Unauthorized".
**Solusi**: Untuk image build yang panjang, sediakan *Project Access Token* dengan peran *Registry Write* di *CI/CD Variables* khusus alih-alih menggunakan `$CI_JOB_TOKEN` bawaan yang *ephemeral*.
```yaml
# Penggantian dari auth bawaan:
before_script:
  # Menggunakan custom token (LONG_LIVED_REGISTRY_TOKEN)
  - echo "$LONG_LIVED_REGISTRY_TOKEN" | docker login $CI_REGISTRY -u $CUSTOM_REGISTRY_USER --password-stdin
```

## 6. Advanced: GitLab CI Security & Compliance

GitLab menyediakan fitur bawaan yang *powerful* untuk *security scanning* dan pengaturan kepatuhan, sangat penting untuk aplikasi Golang berskala *enterprise* dan perbankan (Fintech).

### Protected Branches & Required Approvals
Konfigurasi *branch* (seperti `main` atau `production`) agar bersifat **protected**. Ini memastikan *pipeline* deployment hanya dapat dijalankan di *branch* tersebut (karena *protected variables* hanya terpapar ke *protected branches*), dan dengan fitur *approval rules*, Anda mewajibkan sejumlah peninjauan kode (*Merge Request approvals*) sebelum kode dapat digabungkan dan memicu rilis ke tingkat produksi.

### Built-in DAST & Compliance Pipelines
- **DAST (Dynamic Application Security Testing):** GitLab menyediakan template `DAST.gitlab-ci.yml`. DAST akan menguji aplikasi yang sedang berjalan (biasanya pada *review app* atau *staging environment*) secara aktif untuk mencari celah penetrasi seperti injeksi SQL, *Cross-Site Scripting* (XSS), dan kerentanan antarmuka web.
- **Compliance Frameworks:** Pada GitLab versi Premium/Ultimate, administrator dapat mengikat *compliance pipeline* (skrip CI terpusat milik organisasi) secara paksa ke seluruh grup *project*. Ini menjamin bahwa tidak ada satu pun pengembang yang dapat menghapus perlindungan *security scan* dari `.gitlab-ci.yml` mereka sendiri, sehingga *compliance* (kepatuhan) SOC2 atau ISO-27001 tetap terjaga.

### Secret Detection & Dependency Scanning
Gunakan template bawaan GitLab untuk menjaga kebersihan repositori. Template `Secret-Detection` menggunakan engine seperti Gitleaks untuk memastikan tidak ada *token* AWS atau kredensial basis data yang masuk secara sengaja ke dalam *commit*. Di sisi lain, `Dependency-Scanning` meneliti `go.mod` dan `go.sum` untuk mencocokkannya dengan *database CVE (Common Vulnerabilities and Exposures)* dan mengunci instalasi *packages* berbahaya.

### Container Scanning: GitLab Built-in vs Trivy
*GitLab Container Scanning* dapat disertakan (`Container-Scanning.gitlab-ci.yml`) dan akan secara mulus menampilkan hasilnya pada dasbor *Security Merge Request*. Namun, di komunitas infrastruktur, sangat lazim untuk lebih memilih **Trivy** (*open source* Aqua Security scanner). Trivy sering diandalkan karena lebih cepat dalam memindai arsitektur OS dasar (seperti Alpine/Distroless image), memiliki kemampuan memindai file konfigurasi IaC (*Infrastructure as Code*) Terraform/Kubernetes, serta menghasilkan laporan yang fleksibel tanpa batasan tipe lisensi GitLab.

**Contoh Snippet Template Security Bawaan GitLab:**

```yaml
# Implementasi cepat DevSecOps via Include Templates
include:
  # Memindai kebocoran Hardcoded Secrets (AWS, SSH keys, dll)
  - template: Security/Secret-Detection.gitlab-ci.yml
  # Dependency Scanning (Memindai package pada go.mod)
  - template: Security/Dependency-Scanning.gitlab-ci.yml
  # Memindai Image Docker OCI untuk CVE pada base OS layer
  - template: Security/Container-Scanning.gitlab-ci.yml
  # SAST bawaan (Gosec di bawah kap untuk Golang)
  - template: Security/SAST.gitlab-ci.yml

variables:
  # Konfigurasi custom untuk behavior Analyzer
  DS_EXCLUDED_PATHS: "test/, vendor/, mock/"
  SAST_EXCLUDED_PATHS: "spec, test, tests, tmp"
  SECURE_LOG_LEVEL: "info"
```

Dengan mengimplementasikan `include` pada *snippet* di atas, pipeline Anda akan secara otomatis terpadu dengan standar pertahanan keamanan siber kelas dunia, menganalisis statis, dinamis, hingga *supply chain* tanpa membutuhkan instalasi alat sekuritas yang rumit dari awal.
