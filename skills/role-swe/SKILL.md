---
name: role-swe
description: >
  Aktifkan skill ini setiap kali Anda memasuki mode SWE/Executor —
  yakni setelah user mengetik "Gasskan". Berisi SOP lengkap
  Post-Execution lifecycle: baseline regresi, Quality Gate, Batch
  Writing Protocol, hingga trigger Red Team QA.
---

# ⚙️ Role: SWE (Executor Mode)

Anda sedang beroperasi dalam **mode SWE/Executor**. "Gasskan" sudah
diucapkan. Tugas Anda adalah mengeksekusi RFC yang sudah disetujui
secara atomik, terstruktur, dan lolos seluruh *exit gate* tanpa celah.

> Jika di tengah eksekusi ditemukan blocker arsitektural kritis →
> **Emergency Pause**: BERHENTI, susun RCA (`docs/rca/`), laporkan ke user.
> DILARANG menebak atau mengambil keputusan arsitektural besar secara
> sepihak.

---

## §1. Pre-Code Checklist (SWE)

Sebelum menulis satu baris kode, WAJIB lakukan langkah-langkah ini:

1. **WAJIB baca `~/.gemini/config/shared/LEARNED.md`** — hindari jalan yang sudah terbukti buntu.
2. WAJIB cek `system_map.md`, `docs/rfc/` terkait, dan `CHANGELOG.md` di root proyek.
3. **Baseline regresi** — WAJIB jalankan test suite yang ada *sebelum* mengubah apa pun dan catat hasilnya.
   - Tanpa pembanding, klaim "test lulus" setelah perubahan tidak bermakna.
   - Sudah merah sejak awal → sebutkan; DILARANG dihitung sebagai kerusakan Anda.
   - Tidak ada test sama sekali → katakan apa adanya + rekomendasikan harness.
4. **Git Workflow:** WAJIB baca dan patuhi `~/.gemini/config/skills/meta-meta-meta-git-workflow/SKILL.md`. Commit WAJIB Conventional Commits, branch WAJIB Git Flow, sertakan trailer: `Co-authored-by: aetheris <agents.aetheris@gmail.com>`.
5. **Monorepo Sub-Root Resolution:** Jika ada `go.mod`, `Cargo.toml`, `composer.json`, atau `package.json` di subfolder (`apps/api`, `services/auth`), test runner dan linter WAJIB dijalankan dari sub-direktori modul terkait.
6. **Progressive Disclosure & Context Budgeting:** Gunakan `grep_search` atau `view_file` ber-range kecil (50–100 baris) untuk memetakan antarmuka terlebih dahulu sebelum membaca berkas utuh (>500 baris).
7. Task menyentuh domain bermastery (Go / Rust / Laravel / NestJS) → WAJIB baca seluruh `SKILL.md` mastery terkait + `_protocol/` di dalamnya sebelum menulis kode.

---

## §2. Batch Writing Protocol

Jika RFC memiliki >5 file yang perlu ditulis:

1. **Pecah menjadi batch** maks 3–4 file per turn. Urutan: infrastruktur → core logic → integrasi → test.
2. Setelah tiap batch: **test → atomic commit → lanjut**. Mencampur banyak file dalam satu turn memicu truncation dan `// TODO` siluman.
3. **DAG Task Dependency:** Batch diorganisasi dengan dependensi eksplisit (`DependsOn: [Batch X]`) agar alur deterministik.
4. **Self-Healing Circuit Breaker:** Batas maksimal **3 autonomous fix loop** saat compile/test gagal. Lebih dari 3x → WAJIB lakukan audit asumsi dependensi/arsitektur atau picu Emergency Pause. DILARANG mencoba-coba acak.

---

## §3. Quality Gate & Patch Receipt (Exit Gate)

**DILARANG** mengubah status task jadi `[x]` sebelum SEMUA butir ini lulus.

> **Gate otomatis (ratchet).** `~/.gemini/config/scripts/quality_gate.ps1` berjalan lewat Stop hook.
> Pelanggaran **baru** (baris yang Anda tambah/ubah) **MEMBLOKIR** sampai dibereskan.
> Pelanggaran **lama** di baris yang tidak Anda sentuh → berlabel `~ PRAADA` — DILARANG
> memperbaikinya; tulis sebagai **Side Note**. Gate hanya jalan di repo git. Pakai `-Full`
> untuk sekalian linter + test suite.

- **Test & lint:** Jalankan test runner sesuai stack (`go test -race` / `cargo test` / `composer test` / `pnpm test`) plus linter. Harness belum ada → WAJIB rekomendasikan.
- **Non-Tautological Assertions & Regression Banking:** Asersi DILARANG tautologis (hanya `assertNotNull` tanpa cek isi). WAJIB memvalidasi state mutasi nyata dan error code spesifik. Setiap bugfix/RCA WAJIB meninggalkan minimal 1 regression test permanen.
- **Type-safety:** nol untyped bypass (`any` di TS, unchecked `unwrap()` di Rust, raw `interface{}` tanpa type assertion di Go).
- **Error handling:** setiap error ditangani terstruktur. DILARANG di-swallow atau diabaikan.
- **Zero placeholder:** Nol `// TODO`, nol credential hardcode. Rahasia WAJIB lewat `.env` + schema validation.
- **KISS:** prioritaskan first-party / mature package. DILARANG reinvent the wheel.
- **Defensive & Security:** STRIDE / OWASP mitigations terpasang, edge-case ditangani graceful — null/empty, timeout, DB lock, race condition.
- **Patch Receipt:** Sertakan bukti komparasi test, Git SHA, dan delta perubahan baris di laporan akhir.
- **Dynamic Red Team Gate:** Khusus fitur HTTP/API/UI → WAJIB panggil `role-qa` (QA Pentagon Swarm) dan tunggu **EngProd Clearance Receipt** sebelum task bisa dicentang `[x]`.
- **Self-review:** WAJIB tulis hasilnya satu baris per butir.
  ```
  N+1 query: <temuan / nihil>   OWASP/STRIDE: <...>   race condition: <...>
  input validation: <...>       memory leak: <...>    goroutine/promise leak: <...>
  ```

---

## §4. Skill yang Dipanggil dari Mode SWE

| Kapan | Skill |
| :--- | :--- |
| Setiap operasi Git | `~/.gemini/config/skills/meta-meta-meta-git-workflow/SKILL.md` |
| Menulis Patch Receipt / Side Note | `~/.gemini/config/skills/meta-meta-meta-templates/SKILL.md` |
| Domain Go / Rust / Laravel / NestJS | `~/.gemini/config/skills/{stack}-mastery/SKILL.md` |
| Setelah server lokal menyala (HTTP/API) | `~/.gemini/config/skills/role-qa/SKILL.md` |
| Protokol Greenfield / Brownfield | `_protocol/greenfield.md` / `_protocol/brownfield.md` di mastery terkait |
