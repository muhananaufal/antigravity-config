$dirs = @('C:\Users\muhan\.gemini\config\skills\golang-mastery\references\security_owasp', 'C:\Users\muhan\.gemini\config\skills\golang-mastery\references\cybersecurity_zerotrust', 'C:\Users\muhan\.gemini\config\skills\golang-mastery\references\cloud_native_k8s_operators')
foreach ($d in $dirs) {
    if (Test-Path $d) {
        $files = Get-ChildItem -Path $d -Filter *.md
        foreach ($f in $files) {
            $content = Get-Content $f.FullName
            $in_code = $false
            for ($i=0; $i -lt $content.Length; $i++) {
                $line = $content[$i]
                if ($line -match '^`(go|yaml|json)') { $in_code = $true; continue }
                if ($line -match '^`') { $in_code = $false; continue }
                if ($in_code -and ($line -notmatch '^\s*//')) {
                    if ($line -match '(?i)(galat|konteks|pengguna|sandi|buat|ambil|simpan|hapus|ubah|perbarui|cocok|terlalu|kosong|hasil)') {
                        Write-Host "$($f.Name):$($i+1): $line"
                    }
                }
            }
        }
    }
}
