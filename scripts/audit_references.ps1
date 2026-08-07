# audit_references.ps1 - Audit mutu BERKAS REFERENSI skill bundle.
#
# Berbeda tugas dari quality_gate.ps1: yang itu mengadili kode proyek user,
# yang ini mengadili isi references/ milik skill bundle. Standarnya berasal dari
# skill-engineering-mastery/references/reference_file_standards.md.
#
#   -Skill <nama>   audit satu bundle. Kosong = seluruh bundle di bawah -Root.
#   -MinLines <n>   ambang kepadatan (bawaan 130, sesuai reference_file_standards.md)
#   -Strict         jadikan peringatan struktur (diagram/anti-pattern/edge case) sebagai kegagalan
#
# Exit 0 = lulus. Exit 1 = ada berkas bermasalah.
#
# SENGAJA terpusat, bukan disalin ke scripts/ tiap bundle: lima salinan logika yang
# sama adalah utang pemeliharaan, dan bertentangan dengan KISS di AGENTS.md section 6.
#
# ASCII-only: PowerShell 5.1 salah membaca UTF-8 tanpa BOM pada berkas .ps1.

[CmdletBinding()]
param(
    [string]$Skill = '',
    [string]$Root = "$env:USERPROFILE\.gemini\config\skills",
    [int]$MinLines = 130,
    [switch]$Strict
)

$ErrorActionPreference = 'Continue'

# Penanda "contoh salah" di korpus adalah U+274C (tanda silang). Dibangun lewat [char]
# agar berkas ini tetap ASCII murni. JANGAN pakai escape `u{...}` - itu PowerShell 6+,
# dan di 5.1 ia berubah jadi teks literal tanpa menimbulkan galat apa pun.
$MARK_BAD = [string][char]0x274C

$PLACEHOLDER = '(//|#|/\*|<!--)\s*(TODO|TBD|FIXME)\b|implementation (logic )?here|implement (this )?later|omitted for brevity'
# Anti-pattern dan edge case diberi nomor di korpus, tapi penamaannya bervariasi
# ("Anti-Pattern 1", "Kritis 1", "Edge Case 1"). Menghitung judul seksinya saja
# mengembalikan 1 untuk berkas yang sebenarnya patuh - hitung butir bernomornya.
$ANTIPATTERN = '(?i)^#{2,6}.*(anti-?pattern|kritis)\s*\d|(?i)\*\*(anti-?pattern|kritis)\s*\d'
$EDGECASE    = '(?i)^#{2,6}.*edge\s*case\s*\d|(?i)\*\*edge\s*case\s*\d|(?i)^\s*\d+\.\s*\*\*edge\s*case'
$DIAGRAM     = '^\s*```\s*(ascii|text|mermaid)\s*$'
# Fence berlabel bahasa DIAGRAM bukan kode yang harus ditiru - ia gambar. Placeholder
# di dalamnya (mis. "(No // TODO)" pada kotak diagram) bukan pelanggaran.
# `markdown` juga bukan kode-untuk-ditiru: di korpus ini ia selalu berisi TEMPLATE
# dokumen (kerangka RFC, blueprint berkas referensi), dan instruksi di dalamnya
# justru berbunyi "HARAM menyertakan // TODO" - menghukumnya membalik maksud aturan.
$DIAGRAM_LANG = @('ascii','text','mermaid','diagram','markdown','md','')

function Get-BundleList {
    if ($Skill) {
        $p = Join-Path $Root $Skill
        if (-not (Test-Path -LiteralPath $p)) { Write-Output "SKIP  bundle '$Skill' tidak ada di $Root"; return @() }
        return @(Get-Item -LiteralPath $p)
    }
    return @(Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue |
             Where-Object { Test-Path (Join-Path $_.FullName 'references') })
}

# Placeholder HANYA dihukum bila berada di dalam kode yang dimaksudkan untuk ditiru.
# Tiga konteks yang WAJIB dibebaskan, semuanya terbukti dari korpus nyata:
#   1. Prosa ber-backtick inline - dokumen yang mengajarkan "jangan tulis // TODO"
#      harus boleh mengutipnya (10 false positive di skill-engineering-mastery).
#   2. Fence diagram (ascii/text/mermaid) - itu gambar, bukan kode.
#   3. Fence yang didahului penanda "contoh salah" - memang sengaja memamerkan kesalahan.
# Fungsi ini mengembalikan himpunan baris yang MERUPAKAN kode-untuk-ditiru.
function Get-CodeLines([string[]]$lines) {
    $code = @{}
    $inFence = $false; $fenceStart = 0; $fenceIsCode = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*```(.*)$') {
            $lang = $Matches[1].Trim().ToLower()
            if (-not $inFence) {
                $inFence = $true; $fenceStart = $i
                $fenceIsCode = ($DIAGRAM_LANG -notcontains $lang)
                if ($fenceIsCode) {
                    $from = [Math]::Max(0, $i - 6)
                    for ($j = $from; $j -lt $i; $j++) {
                        if ($lines[$j] -match '(?i)salah|anti-?pattern|\bbad\b|jangan|dilarang|contoh buruk' -or $lines[$j].Contains($MARK_BAD)) {
                            $fenceIsCode = $false; break
                        }
                    }
                }
            } else {
                if ($fenceIsCode) { for ($k = $fenceStart + 1; $k -lt $i; $k++) { $code[$k] = $true } }
                $inFence = $false
            }
        }
    }
    return $code
}

# --- Gate rantai kerja: templates / master-decision-tree / git-workflow ---
# Rantai 6 tahap sengaja diduplikasi ke tiga skill agar tiap dokumen tahu posisinya.
# Duplikasi tanpa penjaga adalah drift yang menunggu terjadi - persis mekanisme yang
# melahirkan temuan H7 dan H11. Dicek di sini supaya tidak bisa melenceng diam-diam.
function Test-WorkflowChain([string]$skillsRoot) {
    $chainFiles = @{
        'templates'            = Join-Path $skillsRoot 'templates\SKILL.md'
        'master-decision-tree' = Join-Path $skillsRoot 'master-decision-tree\SKILL.md'
        'git-workflow'         = Join-Path $skillsRoot 'git-workflow\SKILL.md'
    }
    $bad = New-Object System.Collections.Generic.List[string]
    $sig = @{}
    foreach ($k in $chainFiles.Keys) {
        if (-not (Test-Path -LiteralPath $chainFiles[$k])) { $bad.Add("RANTAI       $k/SKILL.md tidak ditemukan"); continue }
        $txt = [IO.File]::ReadAllText($chainFiles[$k])

        # 6 tahap, dinormalkan supaya penanda "Anda di sini" tidak dihitung beda
        $rows = @([regex]::Matches($txt, '(?m)^\|\s*(\d)\s*\|\s*\**([^|*]+)\**\s*\|') |
                  ForEach-Object { "$($_.Groups[1].Value):$(($_.Groups[2].Value -replace '\*','' -replace ' - Anda di sini.*','' -replace ' . Anda di sini.*','').Trim())" })
        $sig[$k] = ($rows -join '|')
        if ($rows.Count -ne 6) { $bad.Add("RANTAI       $k  punya $($rows.Count) tahap, seharusnya 6") }

        # Gerbang persetujuan WAJIB disebut - ini Gerbang Mutlak, bukan hiasan
        if ($txt -notmatch 'GERBANG MUTLAK') { $bad.Add("RANTAI       $k  tidak menyebut GERBANG MUTLAK") }
        if ($txt -notmatch 'Gasskan')        { $bad.Add("RANTAI       $k  tidak menyebut gerbang Gasskan") }

        # Empat rute AGENTS.md section 2 yang MENGGUGURKAN tahap RFC
        foreach ($r in @('Proyek baru \*\*kecil', 'Edit \*\*.3 berkas', 'In-Flight Fix', 'Emergency Pause')) {
            if ($txt -notmatch $r) { $bad.Add("RANTAI       $k  rute pengecualian hilang: $($r -replace '\\','')") }
        }

        # Rujukan silang: tiap dokumen WAJIB menunjuk dua saudaranya
        foreach ($o in $chainFiles.Keys) {
            if ($o -eq $k) { continue }
            if ($txt -notmatch [regex]::Escape("$o/SKILL.md")) { $bad.Add("RANTAI       $k  tidak merujuk $o/SKILL.md") }
        }

        # "SKILL.md section-n" ambigu: di korpus ini section selalu berarti AGENTS.md
        # U+00A7 dibangun lewat [char] agar berkas ini tetap ASCII murni (syarat baris 8).
        $SECT = [string][char]0x00A7
        if ($txt -match ("SKILL\.md``?\s*" + [regex]::Escape($SECT))) { $bad.Add("RANTAI       $k  memakai tanda section untuk seksi skill lain (pakai kata 'bagian')") }
    }
    $uniq = @($sig.Values | Sort-Object -Unique)
    if ($uniq.Count -gt 1) { $bad.Add("RANTAI       tabel 6 tahap TIDAK identik di ketiga skill") }
    return $bad
}

$bundles = @(Get-BundleList)
if ($bundles.Count -eq 0) { Write-Output "Tidak ada bundle untuk diaudit."; exit 0 }

$grandFlagged = 0; $grandFiles = 0; $grandKB = 0.0

foreach ($b in $bundles) {
    $refDir = Join-Path $b.FullName 'references'
    $files = @(Get-ChildItem -LiteralPath $refDir -Recurse -File -Filter '*.md' -ErrorAction SilentlyContinue |
               Where-Object { $_.DirectoryName -notlike '*_protocol*' -or $_.Directory.Name -ne '_protocol' })
    if ($files.Count -eq 0) { continue }

    $flagged = New-Object System.Collections.Generic.List[string]
    $warned  = New-Object System.Collections.Generic.List[string]
    $sizeKB = 0.0

    foreach ($f in $files) {
        $sizeKB += ($f.Length / 1KB)
        $rel = $f.FullName.Substring($refDir.Length).TrimStart('\')

        # Encoding diperiksa lewat byte, BUKAN lewat mata di konsol - Get-Content PS 5.1
        # menampilkan UTF-8 yang benar sebagai mojibake dan menyesatkan pemeriksaan visual.
        $bytes = [IO.File]::ReadAllBytes($f.FullName)
        if ($bytes.Length -ge 2) {
            # UTF-16 WAJIB ikut diperiksa, bukan hanya BOM UTF-8. Out-File / Set-Content
            # bawaan PowerShell menulis UTF-16LE secara diam-diam, dan berkas hasilnya
            # terlihat normal di editor sambil merusak diff, grep, dan pipeline lain.
            $enc = ''
            if     ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) { $enc = 'UTF-16LE' }
            elseif ($bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) { $enc = 'UTF-16BE' }
            elseif ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $enc = 'UTF-8 ber-BOM' }
            if ($enc) { $flagged.Add("ENCODING     $rel  $enc - berkas .md WAJIB UTF-8 tanpa BOM") }
        }

        $lines = @([IO.File]::ReadAllLines($f.FullName))
        if ($lines.Count -lt $MinLines) {
            $flagged.Add("TIPIS        $rel  $($lines.Count) baris (minimum $MinLines)")
        }

        $code = Get-CodeLines $lines
        $anti = 0; $edge = 0; $diag = 0
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $l = $lines[$i]
            # Baris sangat panjang (base64/minified) dilewati: regex di atasnya memicu
            # catastrophic backtracking dan membekukan proses.
            if ($l.Length -gt 2000) { continue }
            if ($code.ContainsKey($i) -and $l -match $PLACEHOLDER) {
                $flagged.Add("PLACEHOLDER  ${rel}:$($i+1)  $($l.Trim())")
            }
            if ($l -match $ANTIPATTERN) { $anti++ }
            if ($l -match $EDGECASE)    { $edge++ }
            if ($l -match $DIAGRAM)     { $diag++ }
        }

        if ($diag -lt 1) { $warned.Add("NO_DIAGRAM   $rel  tidak ada blok ascii/text/mermaid") }
        if ($anti -lt 2) { $warned.Add("ANTI_PATTERN $rel  hanya $anti (minimum 2)") }
        if ($edge -lt 3) { $warned.Add("EDGE_CASE    $rel  hanya $edge (minimum 3)") }
    }

    # REGRESSION BANKING (AGENTS.md section 6): angka "N Domain, M Berkas" di kepala
    # SKILL.md pernah melenceng di 3 dari 4 bundle sekaligus dan hanya ketahuan lewat
    # audit manual. Dicocokkan otomatis sekarang supaya drift yang sama tidak bisa
    # kembali diam-diam. Hanya kemunculan PERTAMA yang diuji - label per-Tier di bawahnya
    # memang menghitung sebagian, bukan keseluruhan.
    $skillMd = Join-Path $b.FullName 'SKILL.md'
    if (Test-Path -LiteralPath $skillMd) {
        $head = [IO.File]::ReadAllText($skillMd)
        $domDirs = @(Get-ChildItem (Join-Path $b.FullName 'references') -Directory -ErrorAction SilentlyContinue |
                     Where-Object { $_.Name -ne '_protocol' })
        $mD = [regex]::Match($head, '(\d+)\s+Domain')
        $mF = [regex]::Match($head, '(\d+)\s+(?:File|Berkas)')
        if ($mD.Success -and [int]$mD.Groups[1].Value -ne $domDirs.Count) {
            $flagged.Add("KLAIM_DOMAIN SKILL.md  mengklaim $($mD.Groups[1].Value) domain, disk punya $($domDirs.Count)")
        }
        if ($mF.Success -and [int]$mF.Groups[1].Value -ne $files.Count) {
            $flagged.Add("KLAIM_BERKAS SKILL.md  mengklaim $($mF.Groups[1].Value) berkas, disk punya $($files.Count)")
        }
    }

    $avg = if ($files.Count -gt 0) { [math]::Round($sizeKB / $files.Count, 2) } else { 0 }
    $grandFiles += $files.Count; $grandKB += $sizeKB

    Write-Output ""
    Write-Output "=== $($b.Name) : $($files.Count) berkas, rata-rata $avg KB ==="
    if ($flagged.Count -eq 0) { Write-Output "  FATAL   : nihil" } else {
        Write-Output "  FATAL   : $($flagged.Count)"
        foreach ($v in $flagged) { Write-Output "    $v" }
    }
    if ($warned.Count -gt 0) {
        Write-Output "  STRUKTUR: $($warned.Count) peringatan$(if (-not $Strict) { ' (tidak memblokir tanpa -Strict)' })"
        foreach ($w in $warned | Select-Object -First 15) { Write-Output "    ~ $w" }
        if ($warned.Count -gt 15) { Write-Output "    ~ ... $($warned.Count - 15) lainnya" }
    }

    $grandFlagged += $flagged.Count
    if ($Strict) { $grandFlagged += $warned.Count }
}

# Gate rantai hanya relevan saat mengaudit SELURUH ekosistem, bukan satu bundle.
if (-not $Skill) {
    $chainBad = @(Test-WorkflowChain $Root)
    Write-Output ""
    Write-Output "=== Rantai kerja (templates / master-decision-tree / git-workflow) ==="
    if ($chainBad.Count -eq 0) { Write-Output "  RANTAI  : utuh - 6 tahap identik, gerbang Gasskan hadir, 4 rute pengecualian lengkap, rujukan silang penuh" }
    else {
        Write-Output "  RANTAI  : $($chainBad.Count) temuan"
        foreach ($v in $chainBad) { Write-Output "    $v" }
        $grandFlagged += $chainBad.Count
    }
}

$grandAvg = if ($grandFiles -gt 0) { [math]::Round($grandKB / $grandFiles, 2) } else { 0 }
Write-Output ""
Write-Output "AUDIT REFERENSI  bundle=$($bundles.Count)  berkas=$grandFiles  rata-rata=$grandAvg KB  mode=$(if ($Strict) {'STRICT'} else {'NORMAL'})"
if ($grandFlagged -eq 0) { Write-Output "LULUS - nol berkas bermasalah."; exit 0 }
Write-Output "GAGAL - $grandFlagged temuan."
exit 1
