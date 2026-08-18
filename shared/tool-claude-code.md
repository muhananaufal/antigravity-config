# Adaptor Claude Code

<!-- KHUSUS CLAUDE CODE. Di-import dari ~/.claude/CLAUDE.md setelah AGENTS.md.
     Aturan universal ada di AGENTS.md — JANGAN disalin ke sini. -->

`AGENTS.md` v2 berlaku **PENUH** di Claude Code. Adaptor ini hanya menerjemahkan mekanisme tool.

## CC-1. Subagent & Riset

| JIKA… | MAKA… |
| :--- | :--- |
| Perlu membaca referensi/kode (berapa pun jumlahnya) | Baca langsung: `Read` / `Grep` / `Glob` |
| User menyebut "swarm" atau "gasskan riset" | BOLEH spawn subagent `Explore` paralel, maksimal 3, READ-ONLY |
| User TIDAK menyebutnya | DILARANG spawn subagent apa pun |

Alasan: akun shared, kuota dijaga; jejak `Read` bisa diaudit baris demi baris, sedangkan ringkasan subagent tidak.

**Batas ini MILIK Claude Code saja.** `AGENTS.md` §6.2 menyatakan Antigravity tidak dibatasi — swarm di sana kapabilitas inti, bukan kemewahan. DILARANG membawa batas maks-3 ini ke sana, dan DILARANG membaca §6.1 seolah ia melarang swarm.

Aturan §6.1 yang tetap berlaku penuh di sini: subagent READ-ONLY, File-Path Handoff, Zero-Trust, dan **diskriminator paralel** (hanya untuk ≥3 kegagalan independen di domain berbeda). Di Claude Code, beberapa panggilan `Agent` dalam SATU respons berjalan paralel; satu per respons berjalan sekuensial.

**Urutan:** Panel Multi-POV (`AGENTS.md` §0.2) berjalan **SEBELUM** riset mendalam. Riset di atas asumsi yang salah tetap sia-sia berapa pun banyaknya.

## CC-2. Penerjemah Istilah

| Istilah generik | Padanan Claude Code |
| :--- | :--- |
| `view_file` | `Read` |
| `replace_file_content` / `multi_replace_file_content` | `Edit` |
| `grep_search` | `Grep` |
| `list_dir` | `Glob` |
| `search_web` | `WebSearch` / `WebFetch` |
| `run_command` | `Bash` / `PowerShell` |
| `invoke_subagent` | `Explore` (hanya sesuai CC-1) |

## CC-3. Higiene

- **Batch menulis** (`AGENTS.md` §5.3): maksimal 3–4 berkas per giliran. Melebihi itu memicu truncation, dan truncation melahirkan `// TODO` siluman — pelanggaran §0.5 yang lahir bukan dari niat, melainkan dari kehabisan ruang keluaran.
- **Edit presisi:** `Edit` untuk perubahan parsial; `Write` HANYA berkas baru atau rewrite total.
- **Context hygiene:** sesi >30 menit atau berpindah fitur → sarankan `/compact` atau `/clear`. Akun shared, kuota dijaga.
- **DILARANG menulis aturan di `~/.claude/CLAUDE.md`.** Berkas itu cuma penunjuk; aturan diedit di `~/.gemini/config/AGENTS.md`, kalau tidak akan jadi drift yang tidak terlihat Antigravity. Yang BOLEH diubah di sana hanya dua: baris `@import` (bila lokasi SSOT pindah) dan komentar penjelas struktur.
- **Trailer commit:** `Co-authored-by: aetheris <agents.aetheris@gmail.com>` (sesuai `meta-git`).

## CC-4. Command Macro

| Macro | Status di v2 |
| :--- | :--- |
| `/audit` | TETAP — audit forensik & OWASP tidak bergantung mesin role. |
| `/test-harness` | TETAP — pembuatan suite pengujian tidak bergantung mesin role. |
| `/greenfield` | DITULIS ULANG LEAN — mesin Day-0 wajib + jalur `implementation_plan.md` dicabut. Proyek baru masuk lewat Panel Multi-POV seperti request lain; macro ini kini hanya checklist fondasi kondisional. |

## CC-5. Git Workflow

| Aturan | Di Claude Code |
| :--- | :--- |
| Baca `skills/meta-git/SKILL.md` sebelum menyentuh repo | `Read` |
| Buat `.gitignore` sebagai langkah pertama repo baru | `Write` |
| Buat branch `feature/*` sebelum menulis kode | `Bash` / `PowerShell` |
| Atomic commit per unit logis | `Bash` / `PowerShell` |
| Subagent DILARANG menulis file atau commit | `Explore` READ-ONLY |

Pohon keputusan pemilihan stack ada di `skills/meta-panel/references/decision-tree.md` — rujukan, bukan gerbang wajib.
