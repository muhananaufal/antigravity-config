# Template dan Buku Panduan SKILL.md (Mahakarya Abadi)

Dokumen ini adalah template definitif dan panduan penyusunan file `SKILL.md`. File ini adalah jantung dari sebuah *Skill Bundle*. Jika `SKILL.md` ditulis dengan buruk, maka seluruh sistem agen akan gagal beroperasi. Kami menetapkan standar yang sangat ketat, tanpa kompromi.

## 1. Aturan Hukum Verifikasi
Setiap modifikasi, pembacaan, atau implementasi yang dipandu oleh `SKILL.md` WAJIB melalui proses verifikasi. Tidak boleh ada asumsi "kode saya pasti benar tanpa dites". Setiap agen wajib menjalankan *Automated Quality Gates* sebelum melapor selesai.

## 2. Template Frontmatter YAML

Wajib ada di baris pertama `SKILL.md`. Tidak boleh diubah strukturnya, hanya nilainya.

```yaml
---
name: "nama-teknologi-mastery"
description: "Gunakan skill ini ketika merancang arsitektur, optimasi, deployment, atau penyelesaian masalah tingkat lanjut pada [Sebutkan Teknologi]. Mewajibkan standar Top 1%."
version: "2.0.0"
author: "Antigravity Meta-Architecture Team"
---
```

## 3. Pilar Revolusioner: Greenfield Protocol & Brownfield Protocol

Skill Bundle harus cerdas beradaptasi dengan kondisi medan tempur proyek. 

### A. Greenfield Protocol (Dynamic Swarm Scaling)
Digunakan saat proyek dibuat dari nol (0 file, atau sekadar `README.md`).
- **Pendekatan:** Skalakan *Subagent Swarm* secara dinamis untuk membangun fondasi secara paralel.
- **Strategi:**
  1. Subagent 1 (Arsitek): Membuat kerangka folder dan file konfigurasi awal.
  2. Subagent 2 (DevOps): Membuat Dockerfile, CI/CD pipeline, dan skrip Makefile.
  3. Subagent 3 (Security): Mengamankan konfigurasi (misal, helmet, cors, SSL stubs).

### B. Brownfield Protocol (Dynamic Reconnaissance & Partitioning)
Digunakan saat menangani repositori eksisting/legacy.
- **Pendekatan:** DILARANG *Big Bang Rewrite*. Lakukan *Dynamic Reconnaissance* (Pengintaian Dinamis) dan pemisahan area (Partitioning).
- **Strategi:**
  1. Deteksi *tech stack* (misal parsing `go.mod`, `composer.json`, `package.json`).
  2. Gunakan `grep_search` untuk memetakan titik masuk/exit sistem (Routing, Controller, Repositories).
  3. Karantina perubahan baru dengan standar baru tanpa merusak fungsi eksisting.

## 4. Tabel Auto-Detect Niche Domain

Agen wajib melakukan *parsing* manifes proyek untuk menentukan file Niche mana dari direktori `references/` yang harus dimuat oleh Subagent.

| Deteksi (Regex / Dependency Match) | Kondisi Repositori | File Niche yang Dipicu (`references/...`) | Subagent Role |
| :--- | :--- | :--- | :--- |
| `github.com/redis/go-redis` | Proyek Golang menggunakan Redis | `caching_redis_pubsub.md` | Redis Optimization Engineer |
| `"react": "^18.0.0"` | Proyek Node.js dengan React | `react_concurrent_mode.md` | React Architecture Specialist |
| `aws/aws-sdk-php` | Proyek Laravel terhubung ke AWS | `aws_vapor_lambda_native.md` | Cloud Native Integrator |
| `gorm.io/gorm` | Proyek Golang dengan GORM ORM | `database_gorm_patterns.md` | Database Performance DBA |

## 5. Automated Quality Gates (Cross-Platform Terminal Scripts)

Dalam direktori `scripts/`, file otomatisasi penegakan hukum wajib disediakan dalam format cross-platform (`audit_quality_gate.ps1` untuk Windows PowerShell dan `quality_gate.sh` untuk Linux/macOS). Ini adalah contoh skrip mutlak yang harus dipanggil agen setelah setiap fase pengerjaan kritis. DILARANG KERAS menggunakan `grep` UNIX mentah pada skrip PowerShell Windows.

### A. Windows PowerShell Quality Gate (`scripts/audit_quality_gate.ps1`)
```powershell
# scripts/audit_quality_gate.ps1
# DILARANG MENGABAIKAN ERROR DARI SCRIPT INI!
$ErrorActionPreference = "Stop"
Write-Host "🚀 Memulai Antigravity Quality Gate (Strict Mode - PowerShell)..." -ForegroundColor Cyan

# 1. Linting & Formatting Check (Contoh Deteksi Polyglot)
if (Test-Path "go.mod") {
    Write-Host "🔍 Mendeteksi Golang Project. Menjalankan test & lint..." -ForegroundColor Yellow
    go test ./... -timeout=5m -v
} elseif (Test-Path "Cargo.toml") {
    Write-Host "🔍 Mendeteksi Rust Project. Menjalankan clippy..." -ForegroundColor Yellow
    cargo clippy -- -D warnings
} elseif (Test-Path "composer.json") {
    Write-Host "🔍 Mendeteksi PHP/Laravel Project. Menjalankan stan & tests..." -ForegroundColor Yellow
    ./vendor/bin/phpstan analyse --level=9
}

# 2. No-Hardcoded-Secrets Check (Native PowerShell Select-String Tanpa Dependensi Unix Grep!)
Write-Host "🔑 Memeriksa Hardcoded Secrets..." -ForegroundColor Cyan
$secrets = Get-ChildItem -Path "./src", "./internal", "./app" -Recurse -Include *.go,*.rs,*.php,*.js,*.ts -ErrorAction SilentlyContinue | 
           Select-String -Pattern "password\s*[:=]\s*['\""][^'\""]+['\""]", "api_key\s*[:=]\s*['\""][^'\""]+['\""]"

if ($secrets) {
    Write-Host "❌ ERROR FATAL: Ditemukan kemungkinan hardcoded secret pada file berikut. Pindahkan ke .env!" -ForegroundColor Red
    $secrets | ForEach-Object { Write-Host " - $($_.Filename):$($_.LineNumber) -> $($_.Line.Trim())" -ForegroundColor Red }
    exit 1
}

Write-Host "✅ Quality Gate Berhasil Dilewati. Kode Anda aman dan layak di-deploy." -ForegroundColor Green
```

### B. Linux/macOS Bash Quality Gate (`scripts/quality_gate.sh`)
```bash
#!/usr/bin/env bash
# scripts/quality_gate.sh
# DILARANG MENGABAIKAN ERROR DARI SCRIPT INI!
set -euo pipefail

echo "🚀 Memulai Antigravity Quality Gate (Strict Mode - Bash)..."

# 1. Security Audit
if [ -f "package.json" ]; then
    npm audit --audit-level=high
elif [ -f "Cargo.toml" ]; then
    cargo audit
fi

# 2. No-Hardcoded-Secrets Check (Bash Ripgrep / Grep Fallback)
echo "🔑 Memeriksa Hardcoded Secrets..."
if command -v rg &> /dev/null; then
    if rg -i "password\s*[:=]\s*[\"'][^\"']+[\"']" ./src/ 2>/dev/null; then
        echo "❌ ERROR: Ditemukan hardcoded secret! Pindahkan ke .env!"
        exit 1
    fi
elif grep -rEi "password\s*[:=]\s*[\"'][^\"']+[\"']" ./src/ 2>/dev/null; then
    echo "❌ ERROR: Ditemukan hardcoded secret! Pindahkan ke .env!"
    exit 1
fi

echo "✅ Quality Gate Berhasil Dilewati."
```

## 6. Diagram ASCII: Alur Routing Protokol

```ascii
                      [ USER REQUEST ]
                             |
                     (Baca SKILL.md)
                             |
           +-----------------+-----------------+
           |                                   |
    [0 File Ditemukan]                [Proyek Eksisting]
    Greenfield Protocol               Brownfield Protocol
           |                                   |
   Spawn Arsitek Subagent          Deteksi Manifes (go.mod dkk)
   Spawn DevOps Subagent           Grep Routing & Controller
   Spawn Security Subagent         Isolasi Modifikasi (No Big Bang)
           |                                   |
   Parallel Code Gen                 Targeted Code Injection
           |                                   |
           +-----------------+-----------------+
                             |
                   Jalankan quality_gate.sh
                             |
                     Laporan Selesai (SSOT)
```

## 7. Anti-Patterns Kritis (Zero-Tolerance)

❌ **Anti-Pattern 1: Mengabaikan Skrip Verifikasi**
**Salah:** Agen mengubah kode, lalu langsung merespons "Sudah saya perbaiki." tanpa menjalankan *tests* atau linter.
**Benar:** Agen wajib mengeksekusi `./scripts/quality_gate.sh` via tool `run_command` dan hanya berani melapor jika output *exit code* adalah 0.

❌ **Anti-Pattern 2: Merusak Brownfield dengan Gaya Greenfield**
**Salah:** Agen melihat repositori *legacy* yang tidak memakai arsitektur *Clean Code*, lalu memutuskan untuk memindahkan paksa 50 file ke struktur baru dalam satu langkah, merusak seluruh dependency paths.
**Benar:** Terapkan prinsip *Strangler Fig*. Tambahkan fitur baru dengan struktur rapi di folder `v2/`, sambil membiarkan kode lama bekerja. Refaktor kode lama hanya jika diminta secara eksplisit.

## 8. Production Edge Cases

1. **Edge Case 1: Ketiadaan Toolchains di Mesin User**
   - **Kondisi:** Skrip `quality_gate.sh` gagal karena mesin lokal pengguna (Windows) tidak memiliki `golangci-lint` atau `cargo-audit`.
   - **Penanganan:** Agen wajib mampu mendeteksi ketiadaan dependensi dari output error `run_command`. Agen harus mem-fallback ke inspeksi manual terbatas (menggunakan `grep_search` regex pola anti-pattern) ATAU merekomendasikan instalasi *toolchain* via instruksi OS (misal `choco install` atau `go install`).

2. **Edge Case 2: Dependensi Melingkar (Circular Dependencies) saat Auto-Detect**
   - **Kondisi:** Saat agen menjalankan *Brownfield Protocol*, analisis memori mendeteksi siklus dependensi antara modul A dan Modul B yang sangat rumit, menyebabkan Subagent terjebak dalam *infinite loop* perbaikan.
   - **Penanganan:** Agen wajib memiliki ambang batas rekursi. Jika linter gagal di poin yang sama >3 kali, hentikan eksekusi, buat *Artifact* markdown (`circular_dep_report.md`), dan lemparkan status ke User dengan opsi "Zero-Steering Grilling" untuk menyepakati strategi pemutusan dependensi.

3. **Edge Case 3: Mixed Ecosystems File Naming Collision**
   - **Kondisi:** Proyek menggunakan Next.js (TypeScript) di folder `/frontend` dan Laravel (PHP) di `/backend`, menyebabkan alat analisis global tersandung dengan file `.env` yang ganda.
   - **Penanganan:** `SKILL.md` wajib menginstruksikan bahwa setiap eksekusi terminal (*run_command*) wajib diarahkan tepat ke sub-direktori spesifik menggunakan parameter `Cwd`. Agen induk dilarang keras mengeksekusi script analisis dari root directory tanpa *context isolation*.
