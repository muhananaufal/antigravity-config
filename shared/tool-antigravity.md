# Adaptor Antigravity

<!-- KHUSUS ANTIGRAVITY. Di-import dari AGENTS.md bersama shared/core-rules.md.
     JANGAN taruh aturan universal di sini — tempatnya di core-rules.md. -->

## 5. Eksekusi Riset & Subagent
> Istilah *Swarm Reference Loading*, *Swarm Research Protocol*, dan *Dynamic Swarm Subagent* yang dipakai di `SKILL.md` mastery merujuk ke protokol di bawah ini.

- **Swarm Research Protocol:** Pemenuhan *Mandatory Reference Loading* (§0) dijalankan lewat `invoke_subagent` paralel — satu subagent per domain referensi, dijalankan bersamaan. DILARANG membaca sekuensial saat domainnya banyak.
- **WAJIB spawn subagent paralel** jika task melibatkan: penulisan/edit >5 berkas, audit/research >3 domain, atau pekerjaan independen yang bisa berjalan bersamaan.
- **Model tier:** Default SEMUA subagent ke `pro`. Gunakan `flash` hanya untuk task trivial (hitung berkas, grep, list direktori).
- **DILARANG spawn subagent** untuk: edit ≤3 berkas, bugfix minor, pertanyaan investigasi, atau task yang membutuhkan context parent secara langsung.
- **Batas sistem:** nesting subagent maksimal 10 level.

## 6. Tooling
- **Edit Presisi:** Gunakan `replace_file_content` / `multi_replace_file_content` + `grep_search`. DILARANG rewrite berkas utuh untuk perubahan kecil.
- **Baca berkas:** `view_file`.
- **Pencarian web:** `search_web` — hanya setelah §3 *Fallback Search* terpenuhi.
