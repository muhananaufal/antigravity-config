# stop_gate_antigravity.ps1 - Stop hook Antigravity.
# Menjalankan quality_gate.ps1 -Fast. Gagal -> {"decision":"continue"} sehingga agent
# DILARANG berhenti sebelum pelanggaran dibereskan.
#
# FAIL-OPEN: error apa pun di skrip ini -> agent tetap boleh berhenti.
# ANTI-LOOP: setelah executionNum >= 3, gate melepas agar tidak terkunci selamanya.
# ASCII-only (PowerShell 5.1).

$ErrorActionPreference = 'Continue'

# --- PENANDA PASIF (SEMENTARA) ---
# Sisa satu pertanyaan: apakah ~/.gemini/config/hooks.json GLOBAL cukup sendiri?
# Saat hook terbukti memblokir, ada dua salinan terpasang (global + .agents/ workspace).
# Yang workspace sudah dihapus. Kalau penanda ini muncul lagi di pemakaian Antigravity
# berikutnya, berarti global cukup dan baris ini boleh dicabut. Kalau tidak pernah
# muncul, hooks.json wajib per-proyek di .agents/.
try { "$(Get-Date -Format o)" | Out-File -FilePath "$env:TEMP\agy_stop_hook_marker.txt" -Append -Encoding ascii } catch { }

# Setel $false untuk mematikan Gate 4 (blokir saat kode berubah tapi test tak pernah jalan).
# Placeholder & secret tetap ditegakkan apa pun nilainya.
$ENFORCE_TESTS = $true

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

    $tp = ''
    if ($ENFORCE_TESTS -and $inp.transcriptPath -and (Test-Path -LiteralPath $inp.transcriptPath)) { $tp = $inp.transcriptPath }

    # -Transcript HANYA disertakan bila ada isinya. Melempar string kosong membuat
    # PowerShell membuang argumennya sehingga quality_gate.ps1 crash "Missing an argument".
    $argv = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$gate,'-Path',$ws)
    if ($tp) { $argv += @('-Transcript',$tp) }
    $out = & powershell.exe $argv
    if ($LASTEXITCODE -eq 0) { Emit-Allow }

    $detail = ($out | Where-Object { $_ -match '^\s+(PLACEHOLDER|SECRET|GAGAL|TEST_BELUM_JALAN)' } | Select-Object -First 15) -join "`n"

    # Exit code bukan nol tapi tidak ada rincian pelanggaran = gate-nya yang error,
    # bukan kodenya yang salah. FAIL-OPEN: DILARANG memblokir tanpa alasan konkret.
    if (-not $detail) { Emit-Allow }
    $reason = "QUALITY GATE GAGAL. DILARANG berhenti sebelum ini dibereskan:`n$detail`n`nPerbaiki, lalu jalankan ulang gate untuk membuktikan lulus."

    @{ decision = 'continue'; reason = $reason } | ConvertTo-Json -Compress
    exit 0
}
catch { Emit-Allow }
