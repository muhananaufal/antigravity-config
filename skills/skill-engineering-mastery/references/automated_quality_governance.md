# Tata Kelola Kualitas Otomatis (Automated Quality Governance)

Dokumen ini memaparkan protokol suci *Automated Quality Governance* berbasis terminal. Mengandalkan kedisiplinan manusia atau AI semata adalah kesalahan fatal. Untuk mempertahankan predikat *Top 1% Architect*, kita mendelegasikan otoritas penegakan hukum standar kepada skrip PowerShell/Bash yang kejam, dingin, dan tidak mengenal ampun. Skrip ini adalah manifestasi dari protokol pengawasan tanpa cacat.

## 1. Visi Tata Kelola: 0 FLAGGED FILES

Konsep utamanya adalah menciptakan ekosistem *Fail-Fast*. Sebelum *commit* dilepas atau *agent* AI menyelesaikan tugasnya, sistem wajib menjalankan pemindaian menyeluruh. Jika ada 1 berkas yang gagal standar (kurang dari 130 baris, memuat TODO, atau ukuran terlalu kecil), seluruh *build* dinyatakan GAGAL. Selain itu, sistem menjaga pelacakan audit secara sinkron pada berkas `quality_tracker.md`.

---

## 2. Arsitektur Diagram ASCII: CI/CD Governance Pipeline

```text
[ Developer / AI Agent ] ---> Commits Changes
                                  |
                                  v
+-------------------------------------------------------------+
|               PRE-COMMIT / AGENT-EXIT HOOK                  |
|                                                             |
|  1. Find all *.md files in /references/                     |
|  2. Execute audit_final_trinity.ps1 on modified files       |
+-------------------------------------------------------------+
               |                               |
        (Validates 100%)              (Fails >= 1 Rule)
               |                               |
               v                               v
+-----------------------------+ +-----------------------------+
|    QUALITY TRACKER SYNC     | |    GOVERNANCE REJECTION     |
|                             | |                             |
| - Calculate AvgKB per file  | | - Block Commit / Exit       |
| - Append Timestamp & Status | | - Output Red Errors:        |
| - Write to quality_tracker  | |   "Line <90: File Stub"     |
+-----------------------------+ +-----------------------------+
               |
               v
    [ SUCCESS: GASSKAN! ]
```

---

## 3. Skrip Produksi: audit_final_trinity.ps1 (PowerShell)

Ini adalah skrip PowerShell komplit untuk mendeteksi *file* tipis, memindai kata terlarang, menghitung metrik `AvgKB`, dan meng-update *tracker*. Skrip ini dirancang kokoh tanpa menggunakan utilitas Unix (kompatibel penuh untuk ekosistem Windows *Top 1%*).

```powershell
<#
.SYNOPSIS
    Skrip Audit Final Trinity - Zero Tolerance Policy.
.DESCRIPTION
    Mengevaluasi semua file markdown referensi di direktori.
    - Menolak file < 130 baris (dapat dikonfigurasi ke 90 untuk peringatan).
    - Memindai placeholder terlarang.
    - Sinkronisasi statistik ke quality_tracker.md.
#>
Param (
    [string]$TargetFolder = "C:\Users\muhan\.gemini\config\skills\skill-engineering-mastery\references",
    [string]$TrackerFile = ""
)

$ErrorActionPreference = "Stop"

# Konstanta Aturan
$MIN_LINES = 130
$WARNING_LINES = 90
$FORBIDDEN_REGEX = "(?i)//\s*TODO|(?i)//\s*implementation later"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   TRINITY AUDIT: INITIATING SCAN...      " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

$mdFiles = Get-ChildItem -Path $TargetFolder -Filter "*.md" -File
if ($mdFiles.Count -eq 0) {
    Write-Host "Tidak ada file markdown ditemukan." -ForegroundColor Yellow
    exit 0
}

$TotalFiles = 0
$TotalSizeKB = 0
$FlaggedFiles = 0
$PassedFiles = 0

foreach ($file in $mdFiles) {
    # Skip tracking file itself if it's in the same dir
    if ($file.FullName -eq $TrackerFile) { continue }

    $TotalFiles++
    $TotalSizeKB += ($file.Length / 1KB)

    # Baca konten file
    # Gunakan UTF8 dengan deteksi BOM untuk edge-case Windows
    $content = Get-Content -Path $file.FullName -Encoding UTF8
    $lineCount = $content.Count

    # Cek panjang baris
    if ($lineCount -lt $WARNING_LINES) {
        Write-Host "[$($file.Name)] FATAL: File hanya memiliki $lineCount baris (Minimum: $MIN_LINES). TRASH DETECTED!" -ForegroundColor Red
        $FlaggedFiles++
        continue
    } elseif ($lineCount -lt $MIN_LINES) {
        Write-Host "[$($file.Name)] WARNING: File memiliki $lineCount baris. Mendekati batas minimal!" -ForegroundColor Yellow
        $FlaggedFiles++
        continue
    }

    # Cek kata terlarang (Regex Scan)
    $hasForbidden = $false
    for ($i = 0; $i -lt $lineCount; $i++) {
        if ($content[$i] -match $FORBIDDEN_REGEX) {
            $lineNum = $i + 1
            Write-Host "[$($file.Name)] FATAL: Placeholder terlarang ditemukan pada baris $lineNum!" -ForegroundColor Red
            $hasForbidden = $true
            break
        }
    }

    if ($hasForbidden) {
        $FlaggedFiles++
        continue
    }

    Write-Host "[$($file.Name)] LULUS. (Baris: $lineCount)" -ForegroundColor Green
    $PassedFiles++
}

# Perhitungan Metrik Ekosistem
$AvgKB = if ($TotalFiles -gt 0) { [math]::Round($TotalSizeKB / $TotalFiles, 2) } else { 0 }

Write-Host "------------------------------------------"
Write-Host "HASIL AUDIT:" -ForegroundColor Cyan
Write-Host "Total File: $TotalFiles"
Write-Host "Lulus     : $PassedFiles"
Write-Host "Gagal     : $FlaggedFiles"
Write-Host "Rata-rata Ukuran File (AvgKB): $AvgKB KB"
Write-Host "------------------------------------------"

# Logika Zero Tolerance
if ($FlaggedFiles -gt 0) {
    Write-Host "ABORT: Ditemukan $FlaggedFiles berkas bermasalah. STANDAR TOP 1% DILANGGAR." -ForegroundColor Red
    exit 1
}

Write-Host "EKOSISTEM BERSIH. 0 FLAGGED FILES." -ForegroundColor Green

# Sinkronisasi ke quality_tracker.md
$Timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
$TrackerLine = "| $Timestamp | $TotalFiles | $PassedFiles | $FlaggedFiles | ${AvgKB}KB | PASSED |"

# Jika file tracker belum ada, buat header-nya
if (-Not (Test-Path -Path $TrackerFile)) {
    $Header = @"
# Rekam Jejak Tata Kelola Kualitas (Trinity Tracker)

| Timestamp | Total Files | Passed | Flagged | AvgKB | Status |
|---|---|---|---|---|---|
"@
    Set-Content -Path $TrackerFile -Value $Header -Encoding UTF8
}

Add-Content -Path $TrackerFile -Value $TrackerLine -Encoding UTF8
Write-Host "Log tata kelola disimpan ke $TrackerFile" -ForegroundColor Cyan
exit 0
```

---

## 4. Anti-Patterns dalam Tata Kelola

Mengotomatisasi kualitas bukan berarti kebal terhadap kesalahan desain. Hindari pola-pola konyol berikut:

### ❌ Anti-Pattern 1: "Trusting AI / Manual Feeling" Tanpa Skrip
**Skenario:** *Senior Engineer* atau *Agent AI* berjanji bahwa mereka sudah mereview *pull request* dan memastikan file "terlihat cukup panjang" dan "sepertinya tidak ada TODO". Mereka men-*skip* tahap eksekusi `audit_final_trinity.ps1`.
**Mengapa Salah:** Manusia itu malas, dan AI *Language Models* rentan terhadap halusinasi atau merangkum kode. Melewatkan audit otomatis sama dengan meruntuhkan integritas sistem secara perlahan.
**Solusi Benar ✅:** Buat langkah skrip ini sebagai *hard-blocking step* pada *pre-commit hook* Git atau fase final *Subagent Workflow*. Jika skrip tidak mengembalikan *exit code 0*, proses dibunuh.

### ❌ Anti-Pattern 2: Pengecualian Sementara (Whitelisting the Trash)
**Skenario:** Tenggat waktu proyek mendesak. Seorang *developer* menambahkan skrip pengecualian pada berkas tertentu (misal: `if file == 'quick_notes.md' { skip_audit() }`).
**Mengapa Salah:** Satu jendela pecah (Broken Window Theory) akan memicu developer lain untuk ikut memasukkan file sampah mereka ke daftar putih. Dalam seminggu, tata kelola menjadi tidak berguna.
**Solusi Benar ✅:** *Zero Tolerance.* Tidak ada pengecualian. Jika itu hanya sekadar `quick_notes.md`, letakkan di direktori `/scratch/` atau direktori *draft* yang memang di luar jangkauan `/references/`. 

---

## 5. Production Edge Cases dalam Eksekusi Skrip

Skrip PowerShell terminal bisa jadi rewel jika dihadapkan pada kekacauan realita mesin produksi:

### Edge Case 1: Regex Catastrophic Backtracking pada File Minified
**Skenario:** File markdown memuat *embed* kode konfigurasi raksasa dalam satu baris (misal *minified JSON* sepanjang 100.000 karakter). Evaluasi `(?i)//\s*TODO` pada string yang tak terbatas tersebut akan membuat mesin PowerShell diam (*hang*) atau memakan CPU 100%.
**Penanganan:** Skrip PowerShell di atas masih menggunakan pendekatan per baris yang sedikit rentan. Modifikasi perlindungan tambahan: Jika `$content[$i].Length -gt 2000`, maka lompati baris tersebut dengan *log warning*: "Baris terlalu panjang, skip deteksi regex".

### Edge Case 2: False Positives "TODO" pada Komentar Edukasional
**Skenario:** Dokumen ini sendiri menulis kata "TODO" (sebagai bagian dari Anti-Pattern). Skrip `audit_final_trinity.ps1` akan gagal karena mendeteksinya.
**Penanganan:** Regex `$FORBIDDEN_REGEX` dibuat sangat selektif: `(?i)//\s*TODO`. Ini berarti hanya menolak jika TODO tersebut berformat komentar kode Go/JS (`// TODO`). Jika ditulis dalam teks narasi biasa tanpa `//`, maka aman. Untuk pengawasan yang lebih sakti, skrip PowerShell harus disempurnakan (atau diganti dengan *parser* AST khusus) yang mengecualikan pencarian di dalam blok ` ``` ` (*fenced code blocks*).

### Edge Case 3: Race Condition Penulisan pada quality_tracker.md
**Skenario:** Jika ada 5 *Subagents* berjalan paralel, masing-masing menyelesaikan modul berbeda dan secara instan menjalankan skrip *Trinity Audit* pada saat yang persis sama. Hal ini akan menyebabkan bentrok penguncian berkas (*File Lock Contention*) saat lima proses mencoba memanggil `Add-Content -Path $TrackerFile` serentak.
**Penanganan:** Terapkan mekanisme *File Locking* / *Exponential Backoff Retry* di PowerShell sebelum menulis. 
Contoh pseudo-Powershell: 
```powershell
$locked = $true; $retry = 0
while ($locked -and $retry -lt 5) {
   try { 
     # Buka file secara eksklusif
     [io.file]::OpenWrite($TrackerFile).Close()
     $locked = $false 
   } catch { Start-Sleep -Milliseconds 200; $retry++ }
}
```
Ini memastikan sinkronisasi ke berkas tracker aman di ekosistem asinkron.

---

## 6. Trade-offs Ekosistem (Kelebihan & Kekurangan)

**Kelebihan (Automated Governance):**
1. **Objektivitas Mutlak:** Skrip tidak peduli siapa yang menulis. Baik itu Junior Dev, CTO, atau AI tercanggih, semua diadili setara.
2. **Mentalitas Disiplin Tinggi:** Pengembang secara psikologis akan terbiasa menulis panjang lebar dan berkualitas karena "diancam" oleh auditor bot.
3. **Data Terukur (AvgKB):** Metrik harian pada tracker memudahkan *Manager/Architect* melihat pertumbuhan basis pengetahuan.

**Kekurangan (Automated Governance):**
1. **Perawatan Alat (Tooling Maintenance):** Terkadang skrip ini gagal hanya karena masalah format baris baru Windows (CRLF) vs Unix (LF), membutuhkan perbaikan skrip yang membosankan.
2. **Frustrasi Developer:** Dapat menghancurkan moral jika developer lelah dan hanya ingin merekam "catatan pendek sementara" tapi terus-terusan ditolak oleh *pipeline*. (Penyelesaiannya adalah membuat tempat sampah formal seperti direktori `/scratch`).
