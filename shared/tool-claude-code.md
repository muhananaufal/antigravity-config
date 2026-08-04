# Adaptor Claude Code

<!-- KHUSUS CLAUDE CODE. Di-import dari ~/.claude/CLAUDE.md bersama shared/core-rules.md.
     JANGAN taruh aturan universal di sini — tempatnya di core-rules.md. -->

## 5. Eksekusi Riset & Subagent
- **Default sekuensial:** Pemenuhan *Mandatory Reference Loading* (§0) dijalankan dengan membaca referensi langsung via `Read` / `Grep` / `Glob`. Hemat token dan jejaknya bisa diaudit baris demi baris.
- **Eskalasi paralel:** Naik ke subagent `Explore` paralel (maks 3) HANYA bila user eksplisit meminta — misal menyebut "swarm" atau "gasskan riset". DILARANG spawn subagent tanpa diminta.
- **Alasan:** akun shared, kuota token dijaga ketat.

## 6. Penerjemah Istilah Skill Mastery
Kelima `SKILL.md` mastery ditulis memakai istilah Antigravity. Saat dibaca di Claude Code, terjemahkan:

| Ditulis di `SKILL.md` | Padanan di Claude Code |
| :--- | :--- |
| `invoke_subagent` tier `pro` | `Read` / `Grep` langsung; naik ke subagent `Explore` hanya bila diminta (§5) |
| `invoke_subagent` tier `flash` | `Grep` / `Glob` langsung |
| *Dynamic Swarm Subagent* / *Swarm Research Protocol* | protokol §5 di atas |
| `view_file` | `Read` |
| `replace_file_content` / `multi_replace_file_content` | `Edit` |
| `grep_search` | `Grep` |
| `search_web` | `WebSearch` / `WebFetch` |
| "di ekosistem Antigravity" | berlaku untuk agent coding mana pun |

Isi teknis referensi mastery tetap berlaku 100% — yang diterjemahkan hanya nama tool & mekanisme eksekusinya.

## 7. Tooling & Higiene
- **Context Hygiene:** Gunakan `/compact` atau `/clear` jika sesi sudah panjang (>30 menit) atau berpindah fitur, agar hemat kuota akun shared.
- **Edit Presisi:** Gunakan `Edit` untuk perubahan parsial. `Write` hanya untuk berkas baru atau rewrite total.
- **Command Macro:**
  - `/greenfield` — inisiasi proyek baru dengan 5 Pilar Day-0.
  - `/audit` — audit kualitas forensik & OWASP Top 10.
  - `/test-harness` — pembuatan suite pengujian otomatis & concurrency test.
