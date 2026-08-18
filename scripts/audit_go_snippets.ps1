<#
.SYNOPSIS
  Bukti eksekusi untuk blok kode Go di korpus referensi mastery.

.DESCRIPTION
  Mengekstrak setiap fence ```go dari berkas referensi, lalu menjalankan toolchain Go
  asli terhadapnya. Tujuannya menghasilkan BUKTI, bukan pendapat.

  Dua tingkat, sengaja dipisah karena kekuatan sinyalnya beda jauh:

    Tingkat 1  PARSE  (gofmt -e)  - sinyal KERAS.
               Cuplikan dokumentasi memang sering sepotong, tapi potongan yang sah
               tetap WAJIB bisa di-parse setelah dibungkus. Gagal parse = cacat sintaks
               nyata, bukan artefak konteks yang hilang.

    Tingkat 2  BUILD  (go build)  - sinyal LUNAK, hanya untuk cuplikan yang MANDIRI
               (punya "package main" + "func main"). Cuplikan sepotong pasti gagal
               build karena identifier di luar cuplikan; itu BUKAN cacat dan DILARANG
               dilaporkan sebagai temuan.

  LEARNED.md: "Aturan audit WAJIB diuji terhadap output alat itu sendiri. Berteriak
  pada kode sendiri di run pertama membuat pengguna mengabaikan seluruh laporan."

.NOTES
  Berkas ini WAJIB ASCII murni (PowerShell 5.1 salah membaca UTF-8 tanpa BOM pada .ps1).

  STATUS (Lean Constitution v2): korpus mastery-* kini berstatus ARSIP - masih ada di
  disk dan boleh dikutip, tapi TIDAK lagi wajib dibaca sebelum menulis kode. Skrip ini
  tetap berfungsi dan tetap berguna saat korpus itu disunting, hanya saja ia bukan lagi
  bagian dari gerbang rutin. Jalankan sesuai kebutuhan, bukan tiap sesi.
#>

[CmdletBinding()]
param(
    [string]   $Skill    = 'mastery-golang',
    [string]   $OutJson  = '',
    [int]      $Limit    = 0,
    [switch]   $Build,
    [string[]] $Domain   = @(),
    [string]   $Root     = '',
    [switch]   $SelfTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ConfigRoot = Split-Path -Parent $PSScriptRoot

# -SelfTest menjalankan harness terhadap korpus kontrol bercacat-tertanam, lalu
# membandingkan hasilnya dengan yang diharapkan. Tanpa ini, satu-satunya bukti
# bahwa pengklasifikasi masih waras adalah ingatan sesi yang mengalibrasinya.
if ($SelfTest) { $Root = Join-Path $PSScriptRoot 'testdata\go_snippets_control' }

# Korpus mastery-* dipindah dari skills\ ke archive\ pada 2026-08-18 (Lean v2).
# skills\ tetap dicoba lebih dulu supaya bundle aktif mana pun yang punya blok Go
# tetap terjangkau tanpa flag; archive\ jadi jatuh-balik untuk korpus pensiunan.
$RefRoot = if ($Root) { $Root } else {
    $candidates = @(
        (Join-Path $ConfigRoot "skills\$Skill\references"),
        (Join-Path $ConfigRoot "archive\$Skill\references")
    )
    $hit = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($hit) { $hit } else { $candidates[0] }
}

if (-not (Test-Path $RefRoot)) { Write-Host "FATAL: tidak ada $RefRoot" -F Red; exit 2 }

$go = Get-Command go -ErrorAction SilentlyContinue
$gofmt = Get-Command gofmt -ErrorAction SilentlyContinue
if (-not $gofmt) { Write-Host "FATAL: gofmt tidak ditemukan di PATH." -F Red; exit 2 }

# ------------------------------------------------------------ eksekusi alat ---

# PowerShell 5.1 merusak stderr executable native dua kali: "2>&1" membungkus tiap baris
# jadi ErrorRecord (terminating saat EAP='Stop'), dan redireksi berkas menuliskan format
# error PowerShell yang sudah dibungkus selebar konsol. Keduanya menghancurkan pesan
# kompiler yang justru jadi bukti kita. Proses .NET langsung memberi stderr apa adanya.
function Invoke-Capture {
    param([string]$Exe, [string[]]$ArgList, [string]$WorkDir = '')

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $Exe
    $psi.Arguments              = (@($ArgList) | ForEach-Object {
                                      if ($_ -match '[\s"]') { '"' + ($_ -replace '"','\"') + '"' } else { $_ }
                                  }) -join ' '
    $psi.RedirectStandardError  = $true
    $psi.RedirectStandardOutput = $true
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    if ($WorkDir) { $psi.WorkingDirectory = $WorkDir }

    $p = [System.Diagnostics.Process]::Start($psi)
    # stdout dibaca async supaya buffer pipe yang penuh tidak mengunci proses (gofmt
    # mencetak seluruh source terformat ke stdout saat parse berhasil).
    $so  = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    $null = $so.Result

    return [pscustomobject]@{ Code = $p.ExitCode; Err = $err }
}

# ---------------------------------------------------------------- ekstraksi ---

function Get-GoSnippet {
    param([string]$Path)

    $lines = [IO.File]::ReadAllLines($Path)
    $out   = New-Object System.Collections.ArrayList
    $inFence = $false; $tag = ''; $buf = $null; $startLine = 0; $fenceChar = ''

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $l = $lines[$i]

        if (-not $inFence) {
            if ($l -match '^\s*(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$') {
                $fenceChar = $Matches[1]
                $tag       = $Matches[2].ToLower()
                $inFence   = $true
                $startLine = $i + 1
                $buf       = New-Object System.Collections.ArrayList
            }
            continue
        }

        # di dalam fence: tutup hanya oleh penanda sejenis dengan panjang >= pembuka
        if ($l -match '^\s*(```+|~~~+)\s*$' -and $Matches[1].Substring(0,1) -eq $fenceChar.Substring(0,1) -and $Matches[1].Length -ge $fenceChar.Length) {
            if ($tag -eq 'go' -or $tag -eq 'golang') {
                [void]$out.Add([pscustomobject]@{
                    File      = $Path
                    StartLine = $startLine
                    EndLine   = $i + 1
                    Code      = ($buf -join "`n")
                })
            }
            $inFence = $false; $buf = $null
            continue
        }
        [void]$buf.Add($l)
    }
    return $out
}

# --------------------------------------------------------------- klasifikasi ---

function Get-SnippetShape {
    param([string]$Code)

    $hasPkg  = $Code -match '(?m)^\s*package\s+[A-Za-z_]\w*'
    $hasMain = $Code -match '(?m)^\s*func\s+main\s*\('

    if ($hasPkg -and $hasMain) { return 'PROGRAM' }   # mandiri, layak di-build
    if ($hasPkg)               { return 'PACKAGE' }   # deklarasi level paket
    # deklarasi level atas tanpa header package?
    if ($Code -match '(?m)^\s*(func|type|var|const|import)\s') { return 'DECL' }
    return 'STMT'                                     # potongan isi fungsi
}

# Bungkus supaya bisa di-parse. Kembalikan daftar kandidat; sah bila SALAH SATU parse.
#
# Kandidat PERTAMA selalu bentuk yang paling mungkin dimaksud penulis, karena error
# yang dilaporkan diambil dari kandidat pertama. Melaporkan error kandidat terakhir
# menghasilkan pesan menyesatkan: potongan deklarasi yang dipaksa masuk ke badan fungsi
# selalu berbunyi "expected '(', found <NamaFungsi>" dan menyembunyikan sebab aslinya.
#
# Cuplikan dokumentasi yang SAH bisa berupa potongan badan switch, cabang select,
# daftar field struct, atau himpunan method interface. Tanpa pembungkus untuk keempatnya,
# tulisan yang benar akan dituduh cacat.
function Get-ParseCandidate {
    param([string]$Code, [string]$Shape)

    $asDecl   = "package snip`n`n" + $Code
    $asFunc   = "package snip`n`nfunc _snip() {`n" + $Code + "`n}"
    $asSwitch = "package snip`n`nfunc _snip() {`nswitch {`n" + $Code + "`n}`n}"
    $asSelect = "package snip`n`nfunc _snip() {`nselect {`n" + $Code + "`n}`n}"
    $asStruct = "package snip`n`ntype _T struct {`n" + $Code + "`n}"
    $asIface  = "package snip`n`ntype _I interface {`n" + $Code + "`n}"
    $asLit    = "package snip`n`nvar _v = map[string]interface{}{`n" + $Code + "`n}"

    switch ($Shape) {
        'PROGRAM' { return ,@($Code) }
        'PACKAGE' { return ,@($Code) }
        'DECL'    { return ,@($asDecl, $asFunc, $asStruct, $asIface) }
        default   { return ,@($asFunc, $asSwitch, $asSelect, $asStruct, $asIface, $asLit, $asDecl) }
    }
}

# Elipsis sebagai penanda singkatan, bukan sintaks Go.
#
# WAJIB dibedakan dari "..." yang sah: parameter variadik ("...string") dan spread
# argumen ("args..."). Yang dimaksud di sini hanya "..." telanjang -- tidak didahului
# identifier/kurung tutup, dan tidak diikuti tipe. Bisa berdiri di baris sendiri
# maupun menyelip di tengah daftar argumen: "GetSecretValue(ctx, ...)".
#
# Ini BUKAN salah ketik penulis, melainkan konvensi dokumentasi. Konsekuensinya tetap
# nyata: kodenya tidak bisa disalin lalu dijalankan. Karena itu ia dapat kelasnya
# sendiri, bukan disamakan dengan cacat sintaks maupun dianggap bersih.
function Test-ElisionMarker {
    param([string]$Code)
    return ($Code -match '(?<![\w\)\]])\.\.\.(?![\w\[\*])')
}

# Satu fence memuat deklarasi level-paket DAN statement level-fungsi sekaligus.
# Lazim pada blok pengajaran yang menyandingkan BAD dan GOOD. Tidak sah di level
# mana pun, jadi tidak ada pembungkus yang bisa menyelamatkannya -- dan itu memang
# bukan kesalahan sintaks, melainkan keputusan tata letak.
#
# WAJIB dinilai dari error kandidat PERTAMA saja. Memakai gabungan error seluruh
# kandidat membuat kelas ini menelan cacat sintaks asli: kurawal menggantung pada
# sebuah "func" menghasilkan "expected declaration, found '}'" di salah satu kandidat,
# dan kodenya memang mengandung "func" -- dua syarat terpenuhi, vonisnya salah.
# Korpus kontrol menangkap ini: 3 cacat tertanam raib jadi MIXED_LEVEL.
function Test-MixedLevel {
    param([string]$Code, [string]$FirstErr)
    return (($FirstErr -match "expected declaration, found [a-z_]") -and
            ($Code     -match '(?m)^\s*(func|type)\s'))
}

# Fence bertag "go" yang isinya bukan Go murni (perintah shell, DDL SQL, YAML).
# Ini kelas cacat yang BERBEDA dari salah sintaks Go, dan penanganannya pun beda:
# yang salah tagnya, bukan kodenya. Menyatukan keduanya mengaburkan dua masalah.
function Test-MixedFence {
    param([string]$Code, [string]$ErrText)

    $illegalChar = ($ErrText -match "illegal character U\+0023|illegal character U\+0024")
    $shellLine   = ($Code -match '(?m)^\s*(#\s|#!/|\$\s+\w)')
    $sqlLine     = ($Code -match '(?m)^\s*(--\s|SELECT\s|INSERT\s+INTO|CREATE\s+(TABLE|INDEX)|ALTER\s+TABLE)')
    $yamlLine    = ($Code -match '(?m)^\s*(apiVersion|kind):\s')

    # Perintah terminal tanpa penanda prompt sama sekali -- "go test -bench=. -count=10"
    # terlihat seperti Go sampai gofmt menuntut '==' di tempat '='. Dikenali dari nama
    # alat DIIKUTI flag bergaris, karena "go func()" dan "go handle(x)" adalah Go yang sah
    # dan DILARANG ikut tertuduh.
    $cliTool     = '(go|gofmt|godoc|docker|docker-compose|kubectl|helm|make|npm|pnpm|yarn|git|curl|protoc|migrate|benchstat|golangci-lint|staticcheck|dlv|psql|redis-cli|air|task|goreleaser|trivy|gosec|syft|cosign)'
    $shellCmd    = ($Code -match ('(?m)^\s*' + $cliTool + '\b[^\r\n]*\s-{1,2}[A-Za-z]'))
    # gofmt sendiri yang memberi tahu: "go" diikuti sesuatu yang bukan pemanggilan fungsi.
    $goStmtAbuse = ($ErrText -match 'expression in go must be function call')
    # pipa shell di awal baris lanjutan
    $pipeLine    = ($Code -match '(?m)^\s*\|\s*\w')

    return ($illegalChar -or $shellLine -or $sqlLine -or $yamlLine -or
            $shellCmd -or $goStmtAbuse -or $pipeLine)
}

# ---------------------------------------------------------------- kumpulkan ---

$mdFiles = @(Get-ChildItem $RefRoot -Recurse -File -Filter *.md |
             Where-Object { $_.FullName -notmatch '\\_protocol\\' })

if (@($Domain).Count -gt 0) {
    $mdFiles = @($mdFiles | Where-Object {
        $d = Split-Path $_.Directory -Leaf
        $Domain -contains $d
    })
}

$snippets = New-Object System.Collections.ArrayList
foreach ($f in $mdFiles) {
    foreach ($s in @(Get-GoSnippet -Path $f.FullName)) { [void]$snippets.Add($s) }
}

if ($Limit -gt 0 -and $snippets.Count -gt $Limit) {
    $snippets = [System.Collections.ArrayList]@($snippets[0..($Limit-1)])
}

Write-Host ("=== {0} : {1} berkas, {2} blok kode Go ===" -f $Skill, @($mdFiles).Count, $snippets.Count) -F Cyan

if ($snippets.Count -eq 0) { exit 0 }

# ------------------------------------------------------------ tingkat 1 parse ---

$work = Join-Path $env:TEMP ("goaudit_" + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $work -Force | Out-Null

$enc      = New-Object System.Text.UTF8Encoding($false)
$results  = New-Object System.Collections.ArrayList
$idx      = 0

foreach ($s in $snippets) {
    $idx++
    $shape = Get-SnippetShape -Code $s.Code
    $cands = Get-ParseCandidate -Code $s.Code -Shape $shape

    $parsed = $false; $firstErr = ''; $rawErr = ''
    $tmp = Join-Path $work 'snip.go'
    $ci  = 0
    foreach ($c in @($cands)) {
        $ci++
        [IO.File]::WriteAllText($tmp, $c, $enc)
        $r = Invoke-Capture -Exe $gofmt.Source -ArgList @('-e', $tmp)
        if ($r.Code -eq 0) { $parsed = $true; break }
        $rawErr += $r.Err
        # Error yang dilaporkan diambil dari kandidat PERTAMA (bentuk yang paling
        # mungkin dimaksud). Kandidat berikutnya hanya penentu lolos/tidak.
        if ($ci -eq 1) {
            $firstErr = (($r.Err -replace [regex]::Escape($tmp), '<snippet>') -split "`r?`n" |
                         Where-Object { $_ -match '\S' } | Select-Object -First 2) -join ' | '
        }
    }

    # Urutan sengaja dari yang paling spesifik. Tiap kelas punya tindak lanjut berbeda:
    # fence campur -> perbaiki tag; elipsis -> lengkapi kode; level campur -> pecah
    # jadi dua fence; parse gagal -> betulkan sintaksnya.
    $status = if ($parsed) { 'PARSE_OK' }
              elseif (Test-MixedFence -Code $s.Code -ErrText $rawErr) { 'MIXED_FENCE' }
              elseif (Test-ElisionMarker -Code $s.Code) { 'ELISION' }
              elseif (Test-MixedLevel -Code $s.Code -FirstErr $firstErr) { 'MIXED_LEVEL' }
              else { 'PARSE_FAIL' }
    $lastErr = $firstErr

    [void]$results.Add([pscustomobject]@{
        File      = $s.File.Replace($RefRoot + '\', '')
        Domain    = (Split-Path (Split-Path $s.File -Parent) -Leaf)
        StartLine = $s.StartLine
        Shape     = $shape
        Status    = $status
        Detail    = $lastErr.Trim()
    })

    if ($idx % 200 -eq 0) { Write-Host ("  ... {0}/{1}" -f $idx, $snippets.Count) -F DarkGray }
}

# ------------------------------------------------------------ tingkat 2 build ---

$buildResults = New-Object System.Collections.ArrayList
if ($Build -and $go) {
    $programs = @($results | Where-Object { $_.Shape -eq 'PROGRAM' -and $_.Status -eq 'PARSE_OK' })
    Write-Host ("--- Tingkat 2 BUILD : {0} cuplikan mandiri ---" -f $programs.Count) -F Cyan

    $bdir = Join-Path $work 'buildmod'
    New-Item -ItemType Directory -Path $bdir -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $bdir 'go.mod'), "module snipaudit`n`ngo 1.24`n", $enc)

    $n = 0
    foreach ($p in $programs) {
        $n++
        $orig = $snippets | Where-Object { $_.File.EndsWith($p.File) -and $_.StartLine -eq $p.StartLine } | Select-Object -First 1
        if (-not $orig) { continue }
        [IO.File]::WriteAllText((Join-Path $bdir 'main.go'), $orig.Code, $enc)

        $r = Invoke-Capture -Exe $go.Source `
                            -ArgList @('build', '-o', (Join-Path $work 'out.exe'), '.') `
                            -WorkDir $bdir
        $out = $r.Err

        # Kegagalan karena dependensi eksternal BUKAN cacat cuplikan.
        $kind = if ($r.Code -eq 0) { 'BUILD_OK' }
                elseif ($out -match 'no required module provides package|missing go\.sum|cannot find module|to add it:') { 'BUILD_EXTDEP' }
                else { 'BUILD_FAIL' }

        [void]$buildResults.Add([pscustomobject]@{
            File = $p.File; StartLine = $p.StartLine; Status = $kind
            Detail = (($out -split "`r?`n" | Where-Object { $_ -match '\S' } | Select-Object -First 3) -join ' | ').Trim()
        })
        if ($n % 25 -eq 0) { Write-Host ("  ... build {0}/{1}" -f $n, $programs.Count) -F DarkGray }
    }
}

Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue

# -------------------------------------------------------------------- laporan ---

$byStatus = $results | Group-Object Status | Sort-Object Count -Descending
Write-Host ""
Write-Host "--- TINGKAT 1: PARSE (sinyal keras) ---" -F Cyan
foreach ($g in $byStatus) { "  {0,-14} {1,5}" -f $g.Name, $g.Count | Write-Host }

$fails = @($results | Where-Object { $_.Status -eq 'PARSE_FAIL' })
if ($fails.Count -gt 0) {
    Write-Host ""
    Write-Host ("  {0} cuplikan GAGAL PARSE (cacat sintaks nyata):" -f $fails.Count) -F Red
    foreach ($f in ($fails | Select-Object -First 40)) {
        "    {0}:{1}  [{2}]  {3}" -f $f.File, $f.StartLine, $f.Shape, $f.Detail | Write-Host -F Red
    }
    if ($fails.Count -gt 40) { Write-Host ("    ... {0} lainnya (pakai -OutJson untuk daftar penuh)" -f ($fails.Count - 40)) -F DarkGray }
}

$mixed = @($results | Where-Object { $_.Status -eq 'MIXED_FENCE' })
if ($mixed.Count -gt 0) {
    Write-Host ""
    Write-Host ("  {0} fence bertag 'go' tapi isinya BUKAN Go murni (salah tag, bukan salah kode):" -f $mixed.Count) -F Yellow
    foreach ($m in ($mixed | Select-Object -First 25)) {
        "    {0}:{1}" -f $m.File, $m.StartLine | Write-Host -F Yellow
    }
    if ($mixed.Count -gt 25) { Write-Host ("    ... {0} lainnya" -f ($mixed.Count - 25)) -F DarkGray }
}

if ($Build -and $buildResults.Count -gt 0) {
    Write-Host ""
    Write-Host "--- TINGKAT 2: BUILD (cuplikan mandiri saja) ---" -F Cyan
    foreach ($g in ($buildResults | Group-Object Status | Sort-Object Count -Descending)) {
        "  {0,-14} {1,5}" -f $g.Name, $g.Count | Write-Host
    }
    $bf = @($buildResults | Where-Object { $_.Status -eq 'BUILD_FAIL' })
    foreach ($f in ($bf | Select-Object -First 30)) {
        "    {0}:{1}  {2}" -f $f.File, $f.StartLine, $f.Detail | Write-Host -F Yellow
    }
}

if ($SelfTest) {
    # Angka harapan berasal dari cacat yang DITANAM, bukan dari hasil run sebelumnya.
    $expect = @{ PARSE_OK = 15; PARSE_FAIL = 4; ELISION = 3; MIXED_FENCE = 3; MIXED_LEVEL = 1 }
    $actual = @{}
    foreach ($g in ($results | Group-Object Status)) { $actual[$g.Name] = $g.Count }

    Write-Host ""
    Write-Host "--- SWA-UJI: harapan vs kenyataan ---" -F Cyan
    $bad = 0
    foreach ($k in ($expect.Keys | Sort-Object)) {
        $got = if ($actual.ContainsKey($k)) { $actual[$k] } else { 0 }
        $ok  = ($got -eq $expect[$k])
        if (-not $ok) { $bad++ }
        "  {0,-12} harap {1,3}  dapat {2,3}   {3}" -f $k, $expect[$k], $got, $(if ($ok) { 'OK' } else { 'MELESET' }) |
            Write-Host -F $(if ($ok) { 'Green' } else { 'Red' })
    }
    foreach ($k in ($actual.Keys | Where-Object { -not $expect.ContainsKey($_) })) {
        $bad++
        "  {0,-12} kelas tak terduga, dapat {1}" -f $k, $actual[$k] | Write-Host -F Red
    }
    Write-Host ""
    if ($bad -eq 0) { Write-Host "SWA-UJI LULUS - 26 kasus, 5 kelas, nol salah vonis." -F Green; exit 0 }
    Write-Host ("SWA-UJI GAGAL - {0} kelas meleset." -f $bad) -F Red
    exit 1
}

if ($OutJson) {
    $payload = [pscustomobject]@{
        Skill = $Skill; Files = $mdFiles.Count; Snippets = $snippets.Count
        Parse = $results; Build = $buildResults
    }
    [IO.File]::WriteAllText($OutJson, ($payload | ConvertTo-Json -Depth 6), $enc)
    Write-Host ""
    Write-Host ("JSON ditulis: {0}" -f $OutJson) -F Green
}

Write-Host ""
Write-Host ("RINGKAS  blok={0}  parse_gagal={1}  fence_campur={2}  elipsis={3}  level_campur={4}" -f `
    $snippets.Count, $fails.Count, $mixed.Count,
    @($results | Where-Object { $_.Status -eq 'ELISION' }).Count,
    @($results | Where-Object { $_.Status -eq 'MIXED_LEVEL' }).Count) -F Cyan

exit 0
