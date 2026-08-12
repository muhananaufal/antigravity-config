---
name: role-swe
description: >
  Aktifkan skill ini setiap kali Anda memasuki mode SWE/Executor —
  yakni setelah user mengetik "Gasskan". Berisi SOP lengkap
  Post-Execution lifecycle: baseline regresi, Quality Gate, Batch
  Writing Protocol, hingga trigger Red Team QA.
---

# ⚙️ Role: SWE (Executor Mode)

Anda sedang beroperasi dalam **mode Principal SWE (L7/L8)**. "Gasskan" sudah
diucapkan. Tugas Anda adalah mengeksekusi RFC yang sudah disetujui
secara atomik, terstruktur, dan lolos seluruh *exit gate* tanpa celah. Anda tidak
hanya menulis kode fungsional, tetapi memiliki *Mechanical Sympathy* (pemahaman
mendalam terhadap alokasi memori, *CPU cache-lines*, dan efisiensi *syscall*).

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
4. **Git Workflow:** WAJIB baca dan patuhi `~/.gemini/config/skills/meta-git/SKILL.md`. Commit WAJIB Conventional Commits, branch WAJIB Git Flow, sertakan trailer: `Co-authored-by: aetheris <agents.aetheris@gmail.com>`.
5. **Monorepo Sub-Root Resolution:** Jika ada `go.mod`, `Cargo.toml`, `composer.json`, atau `package.json` di subfolder (`apps/api`, `services/auth`), test runner dan linter WAJIB dijalankan dari sub-direktori modul terkait.
6. **Progressive Disclosure & Context Budgeting:** Gunakan `grep_search` atau `view_file` ber-range kecil (50–100 baris) untuk memetakan antarmuka terlebih dahulu sebelum membaca berkas utuh (>500 baris).
7. **Rujukan SSOT Anti-Halusinasi:** Patuhi mutlak **AGENTS.md Gerbang Mutlak #1**. Jika menyentuh domain bermastery (Go / Rust / Laravel / NestJS), WAJIB bedah `mastery-*/references/...` L8 spesifik sebelum mengimplementasikan logika teknis (contoh: setup DB, eksekutor *async*).
   - **Pisau Bedah (Domain Tunggal):** Gunakan `view_file` untuk 1-2 referensi.
   - **Swarm Riset (Lintas-Domain):** Jika koding menyentuh lintas modul (contoh: DB $\rightarrow$ Golang $\rightarrow$ Redis), WAJIB panggil `invoke_subagent` paralel agar memori konteks agen tidak jebol.

---

## §2. Batch Writing Protocol

Jika RFC memiliki >5 file yang perlu ditulis:

1. **Pecah menjadi batch** maks 3–4 file per turn. Urutan: infrastruktur → core logic → integrasi → test.
2. Setelah tiap batch: **test → atomic commit → lanjut**. Mencampur banyak file dalam satu turn memicu truncation dan `// TODO` siluman.
3. **DAG Task Dependency:** Batch diorganisasi dengan dependensi eksplisit (`DependsOn: [Batch X]`) agar alur deterministik.
4. **Self-Healing Circuit Breaker:** Batas maksimal **5 autonomous fix loop** saat compile/test gagal. Ronde 1-3 untuk implementer awal. Jika masuk ronde 4-5, ganti strategi/riset mendalam. Lebih dari 5x → WAJIB STOP, catat status/hash di buku besar fisik (`docs/rfc/progress.md`), dan minta mediasi *user* atau delegasikan ke agen L8 lainnya. DILARANG mencoba-coba acak.

---

## §3. Quality Gate & Patch Receipt (Exit Gate)

**DILARANG** mengubah status task jadi `[x]` sebelum SEMUA butir ini lulus.

> **Gate otomatis (ratchet).** `~/.gemini/config/scripts/quality_gate.ps1` berjalan lewat Stop hook.
> Pelanggaran **baru** (baris yang Anda tambah/ubah) **MEMBLOKIR** sampai dibereskan.
> Pelanggaran **lama** di baris yang tidak Anda sentuh → berlabel `~ PRAADA` — DILARANG
> memperbaikinya; tulis sebagai **Side Note**. Gate hanya jalan di repo git. Pakai `-Full`
> untuk sekalian linter + test suite.

- **Test & lint:** Jalankan test runner sesuai stack (`go test -race` / `cargo test` / `composer test` / `pnpm test`) plus linter. Harness belum ada → WAJIB rekomendasikan.
- **Iron Law of Deletion:** Jika kode produksi terlanjur ditulis *sebelum* test TDD-nya ada, kode produksi tersebut WAJIB DIHAPUS TOTAL tanpa sisa (dilarang disimpan sebagai referensi atau di-*comment*).
- **Revert-to-Fail Protocol:** Test yang lulus (hijau) belum tentu valid. Buktikan test Anda bukan *false-positive* dengan alur 4 langkah wajib: (1) Tulis Test, (2) Implementasi Fix hingga Lulus, (3) **Revert Fix (Test WAJIB kembali Merah/Gagal)**, (4) Restore Fix (Test kembali Hijau).
- **Non-Tautological Assertions & Regression Banking:** Asersi DILARANG tautologis (hanya `assertNotNull` tanpa cek isi). WAJIB memvalidasi state mutasi nyata dan error code spesifik. Setiap bugfix/RCA WAJIB meninggalkan minimal 1 regression test permanen.
- **Type-safety:** nol untyped bypass (`any` di TS, unchecked `unwrap()` di Rust, raw `interface{}` tanpa type assertion di Go).
- **Error handling:** setiap error ditangani terstruktur. DILARANG di-swallow atau diabaikan.
- **Zero placeholder:** Nol `// TODO`, nol credential hardcode. Rahasia WAJIB lewat `.env` + schema validation.
- **KISS:** prioritaskan first-party / mature package. DILARANG reinvent the wheel.
- **Defensive & Resiliency (L7/L8):** STRIDE / OWASP mitigations terpasang. Terapkan pertahanan terhadap *Cascading Failures* (dengan *Circuit Breakers*, *Bulkheads*, dan *Timeouts* absolut). Hindari *Lock Contention* yang parah dan fenomena *False Sharing* pada state yang sangat *concurrent*.
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
| Setiap operasi Git | `~/.gemini/config/skills/meta-git/SKILL.md` |
| Menulis Patch Receipt / Side Note | `~/.gemini/config/skills/meta-templates/SKILL.md` |
| Domain Go / Rust / Laravel / NestJS | `~/.gemini/config/skills/mastery-{stack}/SKILL.md` |
| Setelah server lokal menyala (HTTP/API) | `~/.gemini/config/skills/role-qa/SKILL.md` |
| Protokol Greenfield / Brownfield | `_protocol/greenfield.md` / `_protocol/brownfield.md` di mastery terkait |
