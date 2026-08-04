# scripts/audit_quality_gate.ps1
# DILARANG MENGABAIKAN ERROR DARI SCRIPT INI!
$ErrorActionPreference = "Stop"
Write-Host "================= NESTJS-MASTERY QUALITY GATE (ENTERPRISE ZERO-TOLERANCE) =================" -ForegroundColor Cyan

$targetRoot = "C:\Users\muhan\.gemini\config\skills\nestjs-mastery"

# 1. Validasi Keberadaan Folder Rujukan
Write-Host "[Gate 1] Memeriksa struktur direktori dan file referensi..." -ForegroundColor Cyan
if (!(Test-Path "$targetRoot\SKILL.md")) {
    Write-Host "❌ ERROR FATAL: SKILL.md tidak ditemukan di root nestjs-mastery!" -ForegroundColor Red
    exit 1
}

# 2. Audit Kepadatan Berkas dan Placeholder Malas (Zero TODO & Lazy Stubs)
Write-Host "[Gate 2] Meluncurkan pemindaian Zero-Tolerance untuk // TODO dan Batas Minimal Baris..." -ForegroundColor Cyan
$mdFiles = Get-ChildItem -Path "$targetRoot\references" -Filter '*.md' -Recurse -ErrorAction SilentlyContinue

$flagged = @()
$totalSizeKB = 0
$totalFiles = 0

if ($mdFiles) {
    foreach ($f in $mdFiles) {
        $sizeKB = [math]::Round($f.Length / 1KB, 2)
        $totalSizeKB += $sizeKB
        $totalFiles++
        $lines = @(Get-Content -Path $f.FullName).Count
        
        # Pengecekan placeholder malas yang dilarang keras
        $content = @(Get-Content -Path $f.FullName) -join "`n"
        $lazyStub = ($content -match "//\s*TODO:\s*implement later" -or $content -match "insert code here later" -or $content -match "/* omitted for brevity */")
        
        # Pengecekan ada tidaknya diagram ASCII di referensi
        $hasAscii = ($content -match "```(ascii|text)")

        Write-Host "   -> $($f.Name) ($($f.Directory.Name)) | Size: $sizeKB KB | Lines: $lines | ASCII: $hasAscii | Lazy Stub: $lazyStub" -ForegroundColor DarkGray

        if ($lines -lt 130 -or $lazyStub -or ($hasAscii -eq $false)) {
            $flagged += "$($f.Directory.Name)/$($f.Name) (Lines: $lines, ASCII: $hasAscii, Lazy Stub: $lazyStub)"
        }
    }
} else {
    Write-Host "⚠️ PERINGATAN: Direktori references/ belum terisi file berkesimpulan!" -ForegroundColor Yellow
}

# 3. No-Hardcoded-Secrets Check pada Kode Proyek / Referensi
Write-Host "[Gate 3] Memeriksa kebocoran Hardcoded Secrets (API Keys, Token, Password statis)..." -ForegroundColor Cyan
$secrets = Get-ChildItem -Path $targetRoot -Recurse -Include *.ts,*.js,*.json,*.md -ErrorAction SilentlyContinue | 
           Select-String -Pattern "password\s*[:=]\s*['\""][^'\""]{8,}['\""]", "api_key\s*[:=]\s*['\""][^'\""]{12,}['\""]", "secret\s*[:=]\s*['\""][^'\""]{12,}['\""]" -ErrorAction SilentlyContinue |
           Where-Object { $_.Line -notmatch "process\.env" -and $_.Line -notmatch "Contoh Salah" -and $_.Line -notmatch "Anti-Pattern" -and $_.Line -notmatch "\.env" }

if ($secrets) {
    Write-Host "❌ ERROR FATAL: Ditemukan kebocoran hardcoded secret! Pindahkan ke variabel .env murni!" -ForegroundColor Red
    $secrets | ForEach-Object { Write-Host "  -> $($_.Filename):$($_.LineNumber) => $($_.Line.Trim())" -ForegroundColor Red }
    exit 1
}

Write-Host "-------------------------------------------------------------------------------------------"
Write-Host "Total Berkas Rujukan Terdaftar : $totalFiles Berkas"
if ($totalFiles -gt 0) {
    Write-Host "Total Bobot Ilmu Tersedia      : $([math]::Round($totalSizeKB, 2)) KB"
    Write-Host "Rata-rata Bobot Per Berkas     : $([math]::Round($totalSizeKB / $totalFiles, 2)) KB"
}

if ($flagged.Count -gt 0) {
    Write-Host "❌ FATAL QUALITY GATE REJECTED! Terdapat $($flagged.Count) berkas yang melanggar standar Top 1%:" -ForegroundColor Red
    $flagged | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
    Write-Host "Harap perbaiki, genjot hingga >= 130 baris murni, lengkapi Diagram ASCII, dan hapus placeholder!" -ForegroundColor Yellow
    exit 1
} else {
    Write-Host "✅ QUALITY GATE BERHASIL DILEWATI! ZERO FLAGGED FILES! 100% NESTJS-MASTERY TOP 1% VERIFIED!" -ForegroundColor Green
}
Write-Host "===========================================================================================`n"
