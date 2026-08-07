# Adaptor Claude Code

<!-- KHUSUS CLAUDE CODE. Di-import dari ~/.claude/CLAUDE.md setelah AGENTS.md.
     Aturan universal ada di AGENTS.md — JANGAN disalin ke sini. -->

**Cara membaca `AGENTS.md` di atas:** §0–§6 dan §9 berlaku PENUH. **§7 dan §8 DIABAIKAN** — keduanya memakai tool Antigravity yang tidak ada di sini. Penggantinya CC-1 dan CC-3 di bawah.

## CC-1. Eksekusi Riset & Subagent — *mengganti §7*

| JIKA… | MAKA… |
| :--- | :--- |
| Perlu membaca referensi domain (berapa pun jumlahnya) | Baca langsung: `Read` / `Grep` / `Glob` |
| User menyebut "swarm" atau "gasskan riset" | BOLEH spawn subagent `Explore` paralel, maksimal 3 |
| User TIDAK menyebutnya | DILARANG spawn subagent apa pun |

Alasan: akun shared, kuota token dijaga ketat. Jejak `Read` juga bisa Anda audit baris demi baris, sedangkan ringkasan subagent tidak.

**Urutan sama persis dengan Antigravity:** Gerbang Klarifikasi (§2 `AGENTS.md`) berjalan **SEBELUM** riset. DILARANG membaca referensi atau spawn subagent sebelum pertanyaan arsitektural terjawab — riset di atas asumsi yang salah tetap sia-sia berapa pun banyaknya.

Beda kemampuan dari Antigravity: maksimal **3** subagent paralel (batas harness), tipe `Explore` / `general-purpose` / `Plan`, dan **tidak ada** tier model `pro`/`flash`.

### CC-1b. Bagian §7 yang TETAP BERLAKU PENUH

"§7 DIABAIKAN" hanya mencabut **mekanisme subagent**-nya. Sisa §7 adalah metodologi rekayasa yang tidak bergantung tool apa pun, dan WAJIB tetap dipatuhi:

| Aturan §7 | Status di Claude Code |
| :--- | :--- |
| **DAG Task Dependency** (`DependsOn: [Batch X]`) | BERLAKU. Batch di dokumen RFC wajib menyatakan dependensinya. |
| **Contract-First & Schema Locking** | BERLAKU. Interface / DTO / struct / migration dikunci di Batch 1 sebelum business logic. |
| **Batch Writing Protocol** | BERLAKU. Maksimal **3–4 berkas per giliran**; setiap batch: jalankan test terkait → atomic commit → baru lanjut. |
| **Kanban maks 2 WIP** (dari §8) | BERLAKU. CC-3 mengganti §8 hanya pada bagian tooling, bukan aturan alur kerjanya. |

Alasan Batch Writing paling sering dilanggar dan paling mahal: menulis >4 berkas dalam satu giliran memicu truncation, dan truncation melahirkan `// TODO` siluman — pelanggaran §0.3 yang lahir bukan dari niat, melainkan dari kehabisan ruang keluaran.

## CC-2. Penerjemah Istilah

Berlaku untuk `AGENTS.md` §7–§8 maupun kelima `SKILL.md` mastery beserta `_protocol/`-nya.

| Istilah Antigravity | Padanan Claude Code |
| :--- | :--- |
| `invoke_subagent` tier `pro` | `Read` / `Grep` langsung; subagent `Explore` HANYA bila diminta (CC-1) |
| `invoke_subagent` tier `flash` | `Grep` / `Glob` langsung |
| *Dynamic Swarm Subagent* / *Swarm Research Protocol* | prosedur CC-1 |
| `view_file` | `Read` |
| `replace_file_content` / `multi_replace_file_content` | `Edit` |
| `grep_search` | `Grep` |
| `list_dir` | `Glob` |
| `search_web` | `WebSearch` / `WebFetch` |
| `run_command` | `Bash` atau `PowerShell` |
| "di ekosistem Antigravity" | berlaku untuk agent coding mana pun |

Isi teknis referensi mastery tetap berlaku 100%. Yang diterjemahkan HANYA nama tool dan mekanisme eksekusinya.

## CC-3. Tooling & Higiene — *mengganti §8*

- **Bahasa & panjang jawaban:** ikut §8 `AGENTS.md` tanpa perubahan.
- **Edit presisi:** `Edit` untuk perubahan parsial. `Write` HANYA untuk berkas baru atau rewrite total.
- **Context hygiene:** sesi >30 menit atau berpindah fitur → sarankan `/compact` atau `/clear`. Akun shared, kuota dijaga.
- **DILARANG menulis aturan di `~/.claude/CLAUDE.md`.** Berkas itu cuma penunjuk; aturan diedit di `~/.gemini/config/AGENTS.md`, kalau tidak akan jadi drift yang tidak terlihat Antigravity. Yang BOLEH diubah di sana hanya dua: baris `@import` (bila lokasi SSOT pindah) dan komentar penjelas struktur.

## CC-4. Command Macro

| Macro | Fungsi |
| :--- | :--- |
| `/greenfield` | Inisiasi proyek baru dengan 5 Pilar Day-0. **Gugur bila proyeknya kecil (§2)** |
| `/audit` | Audit kualitas forensik & OWASP Top 10 |
| `/test-harness` | Pembuatan suite pengujian otomatis & concurrency test |

## CC-5. Git Workflow & Decision Tree — *tambahan khusus Claude Code*

Berlaku sama dengan `AGENTS.md §3.6` dan `§3.9`, dengan terjemahan tool:

| Aturan | Di Antigravity | Di Claude Code |
| :--- | :--- | :--- |
| Baca `master-decision-tree/SKILL.md` sebelum pilih stack | `view_file` | `Read` |
| Baca `git-workflow/SKILL.md` sebelum menyentuh repo | `view_file` | `Read` |
| Buat `.gitignore` sebagai Langkah 0 Greenfield | `write_to_file` | `Write` |
| Buat branch `feature/*` sebelum menulis kode | `run_command git checkout -b` | `Bash` |
| Atomic commit per unit logis | `run_command git commit` | `Bash` |
| Subagent DILARANG menulis file atau commit | `invoke_subagent` READ-ONLY | `Explore` READ-ONLY |

**WAJIB dibaca sebelum proyek baru:**
- `~/.gemini/config/skills/master-decision-tree/SKILL.md`
- `~/.gemini/config/skills/git-workflow/SKILL.md`

**DILARANG** membuat branch atau commit tanpa lebih dulu membaca kedua dokumen di atas.
