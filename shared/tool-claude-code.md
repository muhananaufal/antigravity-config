# Adaptor Claude Code

<!-- KHUSUS CLAUDE CODE. Di-import dari ~/.claude/CLAUDE.md setelah AGENTS.md.
     Aturan universal (§0-§4) ada di AGENTS.md — JANGAN disalin ke sini. -->

> **PENTING — pembacaan §5 dan §6 di atas.**
> `AGENTS.md` ditulis untuk Antigravity. Bagian **§0 sampai §4 berlaku penuh** di Claude Code.
> Tapi **§5 (Eksekusi Riset & Subagent) dan §6 (Tooling) ABAIKAN** — keduanya memakai
> tool yang tidak ada di Claude Code. Penggantinya CC-1 dan CC-3 di bawah.

## CC-1. Eksekusi Riset & Subagent — *pengganti §5*
- **Default sekuensial:** Pemenuhan *Mandatory Reference Loading* (§0) dijalankan dengan membaca referensi langsung via `Read` / `Grep` / `Glob`. Hemat token dan jejaknya bisa diaudit baris demi baris.
- **Eskalasi paralel:** Naik ke subagent `Explore` paralel (maks 3) HANYA bila user eksplisit meminta — misal menyebut "swarm" atau "gasskan riset". DILARANG spawn subagent tanpa diminta.
- **Alasan:** akun shared, kuota token dijaga ketat.

## CC-2. Penerjemah Istilah
Berlaku untuk `AGENTS.md` §5-§6 maupun kelima `SKILL.md` mastery:

| Istilah Antigravity | Padanan di Claude Code |
| :--- | :--- |
| `invoke_subagent` tier `pro` | `Read` / `Grep` langsung; naik ke subagent `Explore` hanya bila diminta (CC-1) |
| `invoke_subagent` tier `flash` | `Grep` / `Glob` langsung |
| *Dynamic Swarm Subagent* / *Swarm Research Protocol* | protokol CC-1 |
| `view_file` | `Read` |
| `replace_file_content` / `multi_replace_file_content` | `Edit` |
| `grep_search` | `Grep` |
| `search_web` | `WebSearch` / `WebFetch` |
| "di ekosistem Antigravity" | berlaku untuk agent coding mana pun |

Isi teknis referensi mastery tetap berlaku 100% — yang diterjemahkan hanya nama tool & mekanisme eksekusinya.

## CC-3. Tooling & Higiene — *pengganti §6*
- **Context Hygiene:** Gunakan `/compact` atau `/clear` jika sesi sudah panjang (>30 menit) atau berpindah fitur, agar hemat kuota akun shared.
- **Edit Presisi:** Gunakan `Edit` untuk perubahan parsial. `Write` hanya untuk berkas baru atau rewrite total.
- **Command Macro:**
  - `/greenfield` — inisiasi proyek baru dengan 5 Pilar Day-0.
  - `/audit` — audit kualitas forensik & OWASP Top 10.
  - `/test-harness` — pembuatan suite pengujian otomatis & concurrency test.
