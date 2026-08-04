# stop_gate_claude.ps1 - Stop hook Claude Code.
# Menjalankan quality_gate.ps1 -Fast. Gagal -> {"decision":"block"} sehingga Claude
# DILARANG berhenti sebelum pelanggaran dibereskan.
#
# FAIL-OPEN: error apa pun di skrip ini -> Claude tetap boleh berhenti.
# ANTI-LOOP: maksimal 2 blokir per sesi, dihitung lewat berkas penghitung di TEMP.
# ASCII-only (PowerShell 5.1).

$ErrorActionPreference = 'Continue'

# Setel $false untuk mematikan Gate 4 (blokir saat kode berubah tapi test tak pernah jalan).
# Placeholder & secret tetap ditegakkan apa pun nilainya.
$ENFORCE_TESTS = $true

function Emit-Allow { Write-Output '{}'; exit 0 }

try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { Emit-Allow }
    $inp = $raw | ConvertFrom-Json

    if ($inp.stop_hook_active -eq $true) { Emit-Allow }

    $cwd = $inp.cwd
    if (-not $cwd -or -not (Test-Path -LiteralPath $cwd)) { Emit-Allow }

    # Pagar anti-loop: maksimal 2 blokir per session_id
    $sid = $inp.session_id
    if (-not $sid) { $sid = 'nosession' }
    $safe = ($sid -replace '[^A-Za-z0-9_-]','_')
    $counterDir = Join-Path $env:TEMP 'claude_stop_gate'
    if (-not (Test-Path -LiteralPath $counterDir)) { New-Item -ItemType Directory -Path $counterDir -Force | Out-Null }
    $counterFile = Join-Path $counterDir "$safe.count"
    $count = 0
    if (Test-Path -LiteralPath $counterFile) { $count = [int](Get-Content -LiteralPath $counterFile -Raw).Trim() }
    if ($count -ge 2) { Emit-Allow }

    $gate = Join-Path $PSScriptRoot 'quality_gate.ps1'
    if (-not (Test-Path -LiteralPath $gate)) { Emit-Allow }

    $tp = ''
    if ($ENFORCE_TESTS -and $inp.transcript_path -and (Test-Path -LiteralPath $inp.transcript_path)) { $tp = $inp.transcript_path }

    # -Transcript HANYA disertakan bila ada isinya. Melempar string kosong membuat
    # PowerShell membuang argumennya sehingga quality_gate.ps1 crash "Missing an argument".
    $argv = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$gate,'-Path',$cwd)
    if ($tp) { $argv += @('-Transcript',$tp) }
    $out = & powershell.exe $argv
    if ($LASTEXITCODE -eq 0) {
        if (Test-Path -LiteralPath $counterFile) { Remove-Item -LiteralPath $counterFile -Force -ErrorAction SilentlyContinue }
        Emit-Allow
    }

    $detail = ($out | Where-Object { $_ -match '^\s+(PLACEHOLDER|SECRET|GAGAL|TEST_BELUM_JALAN)' } | Select-Object -First 15) -join "`n"

    # Exit code bukan nol tapi tidak ada rincian pelanggaran = gate-nya yang error,
    # bukan kodenya yang salah. FAIL-OPEN: DILARANG memblokir tanpa alasan konkret.
    if (-not $detail) { Emit-Allow }

    Set-Content -LiteralPath $counterFile -Value ([string]($count + 1)) -Encoding ascii
    @{
        decision = 'block'
        reason   = "QUALITY GATE GAGAL. DILARANG berhenti sebelum ini dibereskan:`n$detail"
        hookSpecificOutput = @{
            hookEventName     = 'Stop'
            additionalContext = 'Perbaiki setiap pelanggaran di atas, lalu jalankan ulang scripts/quality_gate.ps1 untuk membuktikan lulus.'
        }
    } | ConvertTo-Json -Compress -Depth 5
    exit 0
}
catch { Emit-Allow }
