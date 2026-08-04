# Learned

Pelajaran yang sudah dibayar mahal. WAJIB dibaca sebelum task teknis (§3.1 `AGENTS.md`), WAJIB ditambah saat user mengoreksi atau saat mekanisme meleset dari dugaan (§9).

**Aturan menulis:** satu baris per pelajaran — fakta, lalu konsekuensinya. DILARANG naratif. Lewat 80 baris → konsolidasikan yang serupa, jangan biarkan tumbuh liar.

---

## Mekanisme yang TIDAK ADA — jangan dicoba lagi

- Antigravity **tidak mengekspansi `@import`** di `AGENTS.md`; aturan WAJIB ditulis literal. Agent malah `view_file` mengikuti path secara manual, sehingga aturan mati di task yang tidak memicu pembacaan berkas.
- **`~/.gemini/config/rules/` tidak dimuat otomatis.** String `Location: "rules/"` di `language_server.exe` hanya berlaku untuk rule milik plugin.
- `AGENTS.md` literal adalah **satu-satunya** mekanisme rules global Antigravity.
- ❓ Belum terjawab: apakah `hooks.json` global cukup sendiri, atau wajib `.agents/hooks.json` per-proyek. Penanda pasif terpasang di `stop_gate_antigravity.ps1`; cek `%TEMP%\agy_stop_hook_marker.txt`.

## Cara verifikasi yang sahih

- **Transcript Antigravity TIDAK merekam system prompt maupun keluaran hook.** Menghitung kata kunci di sana menyesatkan — 6 kali memberi vonis salah dalam satu sesi.
- Yang sahih hanya tiga: **argumen `tool_calls`**, **teks `PLANNER_RESPONSE`**, dan **perubahan nyata di disk**.
- Transcript memuat hasil `view_file` dari berkas aturan itu sendiri → kata seperti `implementation_plan` dan `php artisan test` terhitung padahal cuma dibaca.
- **Model Antigravity bernalar dalam bahasa Inggris** meski aturannya Bahasa Indonesia. Cari "small project", bukan "kecil".
- Agent sering bertanya lewat **teks biasa**, bukan tool `ask_question`. Jangan pakai keberadaan tool sebagai bukti.
- Ubah `hooks.json` / `settings.json` → **WAJIB restart**. Bandingkan `(Get-Process).StartTime` vs waktu tulis berkas **SEBELUM** menyimpulkan apa pun. Tiga tes gagal karena ini.
- Aturan lapis pertama sering mencegah pelanggaran lahir, sehingga gate tidak punya mangsa. Untuk menguji gate, **tanam pelanggarannya sendiri**, jangan minta agent membuatnya.

## Desain gate

- Gate yang memblokir **utang lama** di berkas yang tidak disentuh membuat **setiap repo legacy mustahil dikerjakan**, dan bertabrakan dengan §4 yang melarang memperbaiki di luar scope. WAJIB ratchet: blokir hanya pelanggaran di baris baru.
- Detektor secret berbasis **nama variabel** bisa dibutakan cukup dengan mengganti nama. WAJIB juga mencocokkan **bentuk nilai** (`sk_live_`, `AKIA`, `ghp_`, URI berkredensial).
- Mode FAST **DILARANG** memindai direktori non-git — tanpa pagar ini, hook menyisir seluruh home directory tiap akhir giliran.
- Hook WAJIB **fail-open** dan berpagar anti-loop. Exit code bukan nol tapi tanpa rincian pelanggaran = gate-nya yang error, bukan kodenya.

## Jebakan PowerShell 5.1 & Windows

- `-ne` untuk string bersifat **case-insensitive** → `"Wajib" -ne "WAJIB"` bernilai `$false`. Pakai `-cne`.
- `Write-Output` di dalam fungsi **mencemari nilai balik**; string informasinya dikira data. Pakai `Write-Host`.
- Melempar **string kosong** ke parameter membuat PowerShell membuang argumennya → error "Missing an argument".
- Berkas `.ps1` WAJIB **ASCII murni**. PowerShell 5.1 salah membaca UTF-8 tanpa BOM pada skrip.
- Berkas `.md` WAJIB **UTF-8 tanpa BOM**. `Set-Content`/`Out-File` bawaan merusaknya; pakai `[IO.File]::WriteAllText` + `UTF8Encoding($false)`.
- **Kutip ganda di pesan `git commit -m`** dipecah jadi argumen terpisah. Pakai `git commit -F <berkas>`.
- Glob `*_protocol*` ikut mencocoki `networking_protocols_grpc`. Periksa hasil filter path sebelum menulis massal.

## Proses

- Menguji skrip secara terpisah ≠ menguji sambungannya. Bug false-block hanya muncul saat dijalankan dengan **argv persis** dari `settings.json`.
- Dokumentasi resmi bisa menjanjikan mekanisme yang tidak ada di build terpasang. **Uji sebelum mengandalkan.**
