# stop_gate_antigravity.ps1 - Stop hook Antigravity.
# Menjalankan quality_gate.ps1 -Fast. Gagal -> {"decision":"continue"} sehingga agent
# DILARANG berhenti sebelum pelanggaran dibereskan.
#
# FAIL-OPEN: error apa pun di skrip ini -> agent tetap boleh berhenti.
# ANTI-LOOP: setelah executionNum >= 3, gate melepas agar tidak terkunci selamanya.
# ASCII-only (PowerShell 5.1).

$ErrorActionPreference = 'Continue'

function Emit-Allow { Write-Output '{}'; exit 0 }

try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { Emit-Allow }
    $inp = $raw | ConvertFrom-Json

    # Pagar anti-loop
    $execNum = 1
    if ($null -ne $inp.executionNum) { $execNum = [int]$inp.executionNum }
    if ($execNum -ge 3) { Emit-Allow }

    # Jangan ganggu saat berhenti karena error atau masih ada background task
    if ($inp.terminationReason -and $inp.terminationReason -ne 'model_stop') { Emit-Allow }
    if ($null -ne $inp.fullyIdle -and -not $inp.fullyIdle) { Emit-Allow }

    $ws = $null
    if ($inp.workspacePaths -and $inp.workspacePaths.Count -gt 0) { $ws = $inp.workspacePaths[0] }
    if (-not $ws -or -not (Test-Path -LiteralPath $ws)) { Emit-Allow }

    $gate = Join-Path $PSScriptRoot 'quality_gate.ps1'
    if (-not (Test-Path -LiteralPath $gate)) { Emit-Allow }

    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $gate -Path $ws
    if ($LASTEXITCODE -eq 0) { Emit-Allow }

    $detail = ($out | Where-Object { $_ -match '^\s+(PLACEHOLDER|SECRET|GAGAL)' } | Select-Object -First 15) -join "`n"
    $reason = "QUALITY GATE GAGAL. DILARANG berhenti sebelum ini dibereskan:`n$detail`n`nPerbaiki, lalu jalankan ulang gate untuk membuktikan lulus."

    @{ decision = 'continue'; reason = $reason } | ConvertTo-Json -Compress
    exit 0
}
catch { Emit-Allow }
