# Adaptor Claude Code — Lean v2 (DRAF)

`AGENTS.md` v2 berlaku PENUH di Claude Code. Adaptor ini hanya menerjemahkan mekanisme tool.

## CC-1. Subagent & Riset

| JIKA… | MAKA… |
| :--- | :--- |
| Perlu membaca referensi/kode (berapa pun jumlahnya) | Baca langsung: `Read` / `Grep` / `Glob` |
| User menyebut "swarm" atau "gasskan riset" | BOLEH spawn subagent `Explore` paralel, maksimal 3, READ-ONLY |
| User TIDAK menyebutnya | DILARANG spawn subagent apa pun |

Alasan: akun shared, kuota dijaga; jejak `Read` bisa diaudit baris demi baris.

## CC-2. Penerjemah Istilah

| Istilah generik | Padanan Claude Code |
| :--- | :--- |
| `view_file` | `Read` |
| `replace_file_content` | `Edit` |
| `grep_search` / `list_dir` | `Grep` / `Glob` |
| `search_web` | `WebSearch` / `WebFetch` |
| `run_command` | `Bash` / `PowerShell` |
| `invoke_subagent` | `Explore` (hanya sesuai CC-1) |

## CC-3. Higiene

- **Batch menulis** (`AGENTS.md` §5.3): maksimal 3–4 berkas per giliran — melebihi itu memicu truncation dan `// TODO` siluman.
- **Edit presisi:** `Edit` untuk perubahan parsial; `Write` hanya berkas baru / rewrite total.
- Sesi >30 menit atau pindah fitur → sarankan `/compact` atau `/clear`.
- **DILARANG menulis aturan di `~/.claude/CLAUDE.md`** — berkas itu hanya penunjuk `@import` ke SSOT di `~/.gemini/config/`.
- Trailer commit di Claude Code: `Co-authored-by: aetheris <agents.aetheris@gmail.com>` (baris terakhir, sesuai `meta-git`).

## CC-4. Command Macro

| Macro | Status di v2 |
| :--- | :--- |
| `/audit` | TETAP — audit forensik & OWASP tidak bergantung mesin role. |
| `/test-harness` | TETAP — pembuatan suite pengujian tidak bergantung mesin role. |
| `/greenfield` | DITINJAU ULANG — mesin Day-0 Quintet v1 sudah dihapus; macro ini perlu ditulis ulang lean atau dipensiunkan. |
