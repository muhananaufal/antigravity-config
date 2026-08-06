# quality_gate.ps1 - Gerbang mutu kode proyek (bukan audit berkas mastery).
# Dipakai bersama Antigravity & Claude Code lewat Stop hook, dan oleh macro /audit.
#
#   -Fast (default) : pindai placeholder + hardcoded secret pada berkas yang berubah. Milidetik.
#   -Full           : tambah deteksi stack lalu jalankan linter + test suite.
#
# Exit 0 = lulus. Exit 1 = ada pelanggaran (detail dicetak ke stdout).
# ASCII-only: PowerShell 5.1 salah membaca UTF-8 tanpa BOM pada berkas .ps1.

[CmdletBinding()]
param(
    [string]$Path = (Get-Location).Path,
    [switch]$Full,
    # Path transcript sesi. Diisi HANYA oleh Stop hook. Kalau diisi, Gate 4 aktif:
    # berkas sumber berubah tapi tidak ada perintah test terpanggil = pelanggaran.
    [string]$Transcript = ''
)

$ErrorActionPreference = 'Continue'
$violations = New-Object System.Collections.Generic.List[string]

$CODE_EXT = @('.go','.rs','.php','.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.java','.cs','.rb','.sql','.sh','.ps1','.yaml','.yml')
$SKIP_DIR = @('node_modules','vendor','target','dist','build','.git','.next','coverage','__pycache__','bin','obj')

function Test-Skipped([string]$full) {
    foreach ($d in $SKIP_DIR) { if ($full -like "*\$d\*") { return $true } }
    if ($full -like '*.min.js') { return $true }
    return $false
}

# --- Kumpulkan berkas ---
# Mode FAST (dipakai Stop hook): HANYA berkas yang berubah menurut git.
#   Bukan repo git -> tidak memindai apa pun. Ini disengaja: di luar git kita tidak tahu
#   apa yang baru ditulis agent, dan memindai seluruh pohon direktori bisa berarti
#   menyisir seluruh home directory di setiap akhir giliran.
# Mode FULL (dipakai /audit): boleh memindai pohon, tapi dibatasi kedalaman & jumlah.
$MAX_FILES = 2000

function Get-TargetFiles([string]$root, [bool]$deep) {
    $files = @()
    $isGit = $false
    Push-Location $root
    try {
        $null = git rev-parse --is-inside-work-tree 2>$null
        if ($LASTEXITCODE -eq 0) {
            $isGit = $true
            $rel = @()
            $rel += (git diff --name-only 2>$null)
            $rel += (git diff --name-only --cached 2>$null)
            $rel += (git ls-files --others --exclude-standard 2>$null)
            foreach ($r in ($rel | Where-Object { $_ })) {
                $p = Join-Path $root ($r -replace '/','\')
                if (Test-Path -LiteralPath $p -PathType Leaf) { $files += (Get-Item -LiteralPath $p) }
            }
        }
    } catch { }
    finally { Pop-Location }

    if (-not $isGit) {
        if (-not $deep) {
            # Write-Host, BUKAN Write-Output: apa pun yang di-Write-Output di dalam
            # fungsi ikut jadi nilai balik dan akan disangka daftar berkas.
            Write-Host "SKIP  bukan repo git - mode FAST tidak memindai apa pun (pakai -Full untuk memaksa)"
            return @()
        }
        $files = Get-ChildItem -LiteralPath $root -Recurse -Depth 6 -File -ErrorAction SilentlyContinue
    }

    $res = @($files | Where-Object { $CODE_EXT -contains $_.Extension -and -not (Test-Skipped $_.FullName) } | Sort-Object FullName -Unique)
    if ($res.Count -gt $MAX_FILES) {
        Write-Host "BATAS berkas dipotong dari $($res.Count) ke $MAX_FILES"
        $res = $res[0..($MAX_FILES-1)]
    }
    return $res
}

$targets = @(Get-TargetFiles $Path ([bool]$Full))

# --- RATCHET: baris mana yang BARU di sesi ini? ---
# Gate yang memblokir utang lama di berkas yang tidak disentuh membuat setiap repo
# legacy mustahil dikerjakan, DAN bertabrakan dengan AGENTS.md section 4 yang
# melarang memperbaiki temuan di luar scope. Jadi:
#   pelanggaran di baris BARU  -> BLOKIR
#   pelanggaran yang sudah ada -> laporkan sebagai Side Note, jangan blokir
$addedLines = @{}   # path -> hashtable nomor baris yang ditambahkan
$isRatchet = $false
Push-Location $Path
try {
    $null = git rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -eq 0) {
        $isRatchet = $true
        $diff = git diff --unified=0 HEAD 2>$null
        $cur = $null; $ln = 0
        foreach ($line in $diff) {
            if ($line -match '^\+\+\+ b/(.+)$') { $cur = (Join-Path $Path ($Matches[1] -replace '/','\')); $addedLines[$cur] = @{} }
            elseif ($line -match '^@@ -\d+(?:,\d+)? \+(\d+)') { $ln = [int]$Matches[1] }
            elseif ($line -match '^\+' -and $line -notmatch '^\+\+\+') { if ($cur) { $addedLines[$cur][$ln] = $true }; $ln++ }
        }
        # Berkas untracked seluruhnya baru
        foreach ($u in (git ls-files --others --exclude-standard 2>$null)) {
            if ($u) { $addedLines[(Join-Path $Path ($u -replace '/','\'))] = 'ALL' }
        }
    }
} catch { } finally { Pop-Location }

function Test-IsNew([string]$file, [int]$lineNo) {
    if (-not $isRatchet) { return $true }
    if (-not $addedLines.ContainsKey($file)) { return $false }
    if ($addedLines[$file] -eq 'ALL') { return $true }
    return $addedLines[$file].ContainsKey($lineNo)
}
$preexisting = New-Object System.Collections.Generic.List[string]

# --- Gate 1: placeholder / kode setengah matang ---
$PLACEHOLDER = '(//|#|/\*|<!--)\s*(TODO|FIXME|XXX|TBD|HACK)\b|omitted for brevity|implement (this )?later|your code here'
foreach ($f in $targets) {
    $hits = Select-String -LiteralPath $f.FullName -Pattern $PLACEHOLDER -AllMatches -ErrorAction SilentlyContinue
    foreach ($h in $hits) {
        $msg = "PLACEHOLDER  $($f.FullName):$($h.LineNumber)  $($h.Line.Trim())"
        if (Test-IsNew $f.FullName $h.LineNumber) { $violations.Add($msg) } else { $preexisting.Add($msg) }
    }
}

# --- Gate 2: credential hardcode ---
# Dua jalur deteksi. Jalur NAMA saja tidak cukup: mengganti nama variabel dari
# apiKey jadi legacyKey langsung membutakannya. Jalur BENTUK NILAI menangkap
# kredensial sungguhan tanpa peduli nama variabelnya.
$SECRET_NAME  = '(password|passwd|api[_-]?key|secret|token|access[_-]?key|private[_-]?key|auth|credential|conn(ection)?[_-]?str)\s*[:=]\s*["''][^"'']{8,}["'']'
$SECRET_VALUE = 'sk_(live|test)_[A-Za-z0-9]{10,}|pk_live_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{15,}|AIza[0-9A-Za-z_-]{30,}|SG\.[A-Za-z0-9_-]{15,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.|mongodb(\+srv)?://[^:\s]+:[^@\s]+@|postgres(ql)?://[^:\s]+:[^@\s]+@|mysql://[^:\s]+:[^@\s]+@'
foreach ($f in $targets) {
    $hits = Select-String -LiteralPath $f.FullName -Pattern "$SECRET_NAME|$SECRET_VALUE" -AllMatches -ErrorAction SilentlyContinue
    foreach ($h in $hits) {
        $line = $h.Line
        $isValueHit = $line -match $SECRET_VALUE
        # Abaikan yang jelas-jelas ambil dari env. Berlaku untuk KEDUA jalur.
        if ($line -match 'process\.env|os\.Getenv|env\(|getenv|ENV\[|\$_ENV|std::env|Deno\.env') { continue }
        # Penyaring contoh/anti-pattern HANYA untuk jalur nama. Nilai berbentuk
        # kredensial asli tetap dilaporkan walau ditulis di baris berlabel contoh,
        # karena kunci sungguhan yang bocor tidak jadi aman karena diberi komentar.
        if (-not $isValueHit -and $line -match '(?i)example|contoh|anti-?pattern|salah|placeholder|xxxx|your[_-]?|<[a-z_]+>|\.\.\.') { continue }
        $msg = "SECRET       $($f.FullName):$($h.LineNumber)  $($line.Trim())"
        if (Test-IsNew $f.FullName $h.LineNumber) { $violations.Add($msg) } else { $preexisting.Add($msg) }
    }
}
# --- Gate 2b: untyped bypasses (any in TS, raw unwrap in Rust, raw interface{} in Go) ---
$UNTYPED_TS = ':\s*any\b|<any>|\bas\s+any\b'
$UNTYPED_RS = '\.unwrap\(\)'
$UNTYPED_GO = 'interface\{\}'

foreach ($f in $targets) {
    $pattern = $null
    if ($f.Extension -in @('.ts','.tsx')) { $pattern = $UNTYPED_TS }
    elseif ($f.Extension -eq '.rs')      { $pattern = $UNTYPED_RS }
    elseif ($f.Extension -eq '.go')      { $pattern = $UNTYPED_GO }

    if ($pattern) {
        $hits = Select-String -LiteralPath $f.FullName -Pattern $pattern -AllMatches -ErrorAction SilentlyContinue
        foreach ($h in $hits) {
            $line = $h.Line
            # Lewati komentar
            if ($line -match '^\s*(//|/\*|\*)') { continue }
            $msg = "UNTYPED_BYPASS $($f.FullName):$($h.LineNumber)  $($line.Trim())"
            if (Test-IsNew $f.FullName $h.LineNumber) { $violations.Add($msg) } else { $preexisting.Add($msg) }
        }
    }
}

# --- Gate 2c: empty / tautological test detection ---
foreach ($f in $targets) {
    if ($f.Name -match '(_test\.go|\.test\.(ts|js|tsx|jsx)|Test\.php|tests/.*\.rs|test_.*\.py)$') {
        $lines = Get-Content -LiteralPath $f.FullName -ErrorAction SilentlyContinue
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $l = $lines[$i]
            # Deteksi Go empty test: func TestXxx(t *testing.T) {}
            if ($l -match 'func\s+Test\w+\([^)]*\)\s*\{\s*\}') {
                $msg = "EMPTY_TEST   $($f.FullName):$($i+1)  Empty test function detected"
                if (Test-IsNew $f.FullName ($i+1)) { $violations.Add($msg) } else { $preexisting.Add($msg) }
            }
            # Deteksi TS/JS empty test: it('...', () => {})
            if ($l -match '(it|test)\s*\([^,]+,\s*(async\s*)?\(\s*\)\s*=>\s*\{\s*\}\)') {
                $msg = "EMPTY_TEST   $($f.FullName):$($i+1)  Empty test closure detected"
                if (Test-IsNew $f.FullName ($i+1)) { $violations.Add($msg) } else { $preexisting.Add($msg) }
            }
            # Deteksi Python pass test: def test_xxx(): pass
            if ($l -match 'def\s+test_\w+\([^)]*\):\s*pass') {
                $msg = "EMPTY_TEST   $($f.FullName):$($i+1)  Empty python test pass detected"
                if (Test-IsNew $f.FullName ($i+1)) { $violations.Add($msg) } else { $preexisting.Add($msg) }
            }
        }
    }
}

# --- Gate 4: berkas sumber berubah tapi test tidak pernah dijalankan ---
# Sengaja sempit. Hanya menyala bila SEMUA syarat terpenuhi:
#   (a) transcript diberikan (artinya dipanggil dari Stop hook)
#   (b) ada berkas SUMBER yang berubah - .md/.yaml/.json/.sql/.sh tidak dihitung
#   (c) tidak ada satu pun perintah test terpanggil sepanjang sesi
# Fail-open: transcript tidak terbaca -> lewat.
$SRC_EXT = @('.go','.rs','.php','.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.java','.cs','.rb')
if ($Transcript -and (Test-Path -LiteralPath $Transcript)) {
    $srcChanged = @($targets | Where-Object { $SRC_EXT -contains $_.Extension })
    if ($srcChanged.Count -gt 0) {
        $TESTCMD = 'go test|cargo test|npm (run )?test|pnpm (run )?test|yarn test|php artisan test|phpunit|bin.pest|pytest|jest|vitest|mvn [^|]*test|gradle [^|]*test|dotnet test'
        $found = Select-String -LiteralPath $Transcript -Pattern $TESTCMD -List -ErrorAction SilentlyContinue
        if (-not $found) {
            $names = ($srcChanged | Select-Object -First 5 | ForEach-Object { $_.Name }) -join ', '
            $violations.Add("TEST_BELUM_JALAN  $($srcChanged.Count) berkas sumber berubah ($names) tapi tidak ada perintah test terpanggil di sesi ini")
        }
    }
}

# --- Gate 3 (hanya -Full): linter + test sesuai stack (Monorepo & Sub-Root Aware) ---
$ranCommands = @()
if ($Full) {
    $projectUnits = @() # array of PSCustomObject @{ Dir = ...; Rel = ...; Stack = ... }

    function Find-Manifests([string]$baseDir) {
        $units = @()
        # 1. Cek root direktori
        if (Test-Path (Join-Path $baseDir 'go.mod'))        { $units += [PSCustomObject]@{ Dir = $baseDir; Rel = '.'; Stack = 'go' } }
        if (Test-Path (Join-Path $baseDir 'Cargo.toml'))    { $units += [PSCustomObject]@{ Dir = $baseDir; Rel = '.'; Stack = 'rust' } }
        if (Test-Path (Join-Path $baseDir 'composer.json')) { $units += [PSCustomObject]@{ Dir = $baseDir; Rel = '.'; Stack = 'php' } }
        if (Test-Path (Join-Path $baseDir 'package.json'))  { $units += [PSCustomObject]@{ Dir = $baseDir; Rel = '.'; Stack = 'node' } }

        # 2. Jika di root kosong atau struktur monorepo, telusuri subfolder (depth 1..2)
        $subDirs = Get-ChildItem -LiteralPath $baseDir -Directory -Depth 2 -ErrorAction SilentlyContinue | Where-Object { -not (Test-Skipped $_.FullName) }
        foreach ($sd in $subDirs) {
            $relPath = $sd.FullName.Substring($baseDir.Length).TrimStart('\','/')
            if (Test-Path (Join-Path $sd.FullName 'go.mod'))        { $units += [PSCustomObject]@{ Dir = $sd.FullName; Rel = $relPath; Stack = 'go' } }
            if (Test-Path (Join-Path $sd.FullName 'Cargo.toml'))    { $units += [PSCustomObject]@{ Dir = $sd.FullName; Rel = $relPath; Stack = 'rust' } }
            if (Test-Path (Join-Path $sd.FullName 'composer.json')) { $units += [PSCustomObject]@{ Dir = $sd.FullName; Rel = $relPath; Stack = 'php' } }
            if (Test-Path (Join-Path $sd.FullName 'package.json'))  { $units += [PSCustomObject]@{ Dir = $sd.FullName; Rel = $relPath; Stack = 'node' } }
        }
        return $units
    }

    $projectUnits = @(Find-Manifests $Path)

    $cmds = @{
        go   = @('go vet ./...','go test -race ./...')
        rust = @('cargo clippy --all-targets -- -D warnings','cargo test')
        php  = @('vendor\bin\pint --test','php artisan test')
        node = @('npm test --silent')
    }

    if ($projectUnits.Count -eq 0) {
        Write-Output "SKIP  deteksi stack gagal - tidak ada go.mod/Cargo.toml/composer.json/package.json di root maupun subfolder (depth 2)"
    } else {
        foreach ($unit in $projectUnits) {
            Push-Location $unit.Dir
            try {
                foreach ($c in $cmds[$unit.Stack]) {
                    $exe = ($c -split ' ')[0]
                    if (-not (Get-Command $exe -ErrorAction SilentlyContinue) -and -not (Test-Path $exe)) {
                        Write-Output "SKIP  [$($unit.Rel)] $c  (perkakas tidak terpasang)"
                        continue
                    }
                    Write-Output "RUN   [$($unit.Rel)] $c"
                    $out = & cmd /c "$c 2>&1"
                    $ranCommands += "[$($unit.Rel)] $c"
                    if ($LASTEXITCODE -ne 0) {
                        $violations.Add("GAGAL        [$($unit.Rel)] $c (exit $LASTEXITCODE)")
                        ($out | Select-Object -Last 25) | ForEach-Object { Write-Output "      $_" }
                    }
                }
            } finally { Pop-Location }
        }
    }
}

# --- Laporan ---
Write-Output ""
Write-Output "QUALITY GATE  mode=$(if($Full){'FULL'}else{'FAST'})  ratchet=$(if($isRatchet){'ON'}else{'OFF'})  berkas_dipindai=$($targets.Count)  perintah_dijalankan=$($ranCommands.Count)"

# Utang lama: dilaporkan supaya bisa jadi Side Note, TAPI tidak memblokir.
# Memaksa agent membereskannya justru melanggar section 4 AGENTS.md.
if ($preexisting.Count -gt 0) {
    Write-Output "PRAADA - $($preexisting.Count) pelanggaran lama di baris yang TIDAK diubah sesi ini (tidak memblokir, tulis sebagai Side Note):"
    foreach ($v in $preexisting) { Write-Output "  ~ $v" }
}

if ($violations.Count -eq 0) {
    Write-Output "LULUS - nol pelanggaran baru."
    exit 0
}
Write-Output "GAGAL - $($violations.Count) pelanggaran BARU:"
foreach ($v in $violations) { Write-Output "  $v" }
exit 1
