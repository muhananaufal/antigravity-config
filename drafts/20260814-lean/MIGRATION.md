# Rencana Migrasi — Lean Constitution v2 (DRAF)

Status per berkas bila draf disetujui. Semua penghapusan reversibel via git history.

## Nasib per komponen

| Komponen | Nasib | Alasan |
| :--- | :--- | :--- |
| `AGENTS.md` | **GANTI** dengan `drafts/20260814-lean/AGENTS.md` | Konstitusi lean: Panel + Label Epistemik universal. |
| `shared/tool-claude-code.md` | **GANTI** dengan versi lean | CC-1b/CC-5 lama merujuk mesin yang dihapus. |
| `shared/LEARNED.md` | **TETAP** | Aset termahal; tidak tersentuh. |
| `skills/meta-brainstorm/` | **TETAP** + edit kecil | §0-nya menjadi rujukan ke `AGENTS.md` §3 (SSOT label), bukan definisi ganda. |
| `skills/meta-git/` | **TETAP** + edit kecil | Bersihkan rujukan ke RFC/role di "Posisi dalam Rantai Kerja". Hook Agent Sync bergantung pada protokol ini. |
| `skills/meta-panel/` (BARU) | **TAMBAH** | Leburan 5 role → 7 lensa. |
| `skills/role-architect/` | **HAPUS** | Gerbang Klarifikasi & Challenger-nya sudah dilebur ke meta-panel §2 dan AGENTS §4. |
| `skills/role-swe/` | **HAPUS** | Disiplin eksekusinya dipadatkan ke AGENTS §5 (baseline, batch, TDD, exit gate, circuit breaker). |
| `skills/role-devops/` | **HAPUS** | Esensinya jadi lensa ⚙️ Ops. |
| `skills/role-dba/` | **HAPUS** | Esensinya jadi lensa 🗄️ Data. |
| `skills/role-qa/` | **HAPUS** | QA Pentagon jadi checklist serangan di lensa 4/5/7 meta-panel. |
| `skills/meta-decision/` | **PINDAH** → `skills/meta-panel/references/decision-tree.md` | Isi pohonnya bagus; yang dihapus hanya statusnya sebagai gerbang wajib. Rujukan `mastery-*` di dalamnya disapu. |
| `skills/meta-templates/` | **HAPUS** | RFC/RCA/system_map mati. Side Note & format Patch Receipt ringkas sudah terserap ke AGENTS §1/§5. |
| `skills/mastery-*/` (5 skill + references) | **ARSIP** — cabut dari jalur wajib, biarkan di disk (atau pindah `archive/`) | Tidak lagi WAJIB dibaca (Hard Stop 1 v2 menunjuk source terpasang + dok resmi). Boleh tetap dikutip sebagai `[fakta:path]`. Keputusan hapus permanen ditunda — reversibel. |
| `scripts/quality_gate.ps1` (Stop hook) | **TETAP** | Hanya menyebut mastery di komentar; gate ratchet tetap bernilai. |
| `scripts/audit_references.ps1` | **SESUAIKAN/PENSIUN** | Gate "rantai kerja templates/meta-decision" menunjuk berkas yang hilang. |
| `scripts/audit_go_snippets.ps1` | **PENSIUN bila mastery diarsip** | Default `-Skill mastery-golang`. |
| `README.md` repo | **TULIS ULANG** | 52 rujukan ke struktur lama. |
| Macro `/audit`, `/test-harness` | **TETAP** | Tidak bergantung mesin role. |
| Macro `/greenfield` | **TINJAU** | Day-0 Quintet mati; tulis ulang lean atau pensiun. |

## Apa yang hilang dan MEMANG sengaja dihilangkan

- Jalur RFC (`docs/rfc/`, katalog, T-Shirt Tiering, RACI) → diganti: panel + (untuk keputusan besar) sesi `meta-brainstorm` Mode 2, yang penutupnya (keputusan + asumsi + trigger pivot + utang bukti) berfungsi sebagai ADR ringan.
- Day-0 Quintet, Blast Radius Matrix formal, `system_map.md` wajib, Kanban `[ ]/[/]/[x]`, buku besar `docs/rfc/progress.md`.
- Mode role eksklusif — digantikan lensa paralel.

## Kata "Gasskan" tetap hidup

Sebagai kata persetujuan eksekusi setelah panel — satu-satunya birokrasi yang dipertahankan, karena itulah gerbang anti-langsung-acc yang diminta user.

## Urutan apply (setelah "Gasskan" untuk migrasi ini)

1. Pindahkan draf ke posisi aktif (`AGENTS.md`, `shared/`, `skills/meta-panel/`).
2. Pindah `meta-decision` → `meta-panel/references/decision-tree.md`; hapus 5 `role-*` + `meta-templates`.
3. Edit kecil `meta-brainstorm` (§0 merujuk AGENTS §3) dan `meta-git` (bersihkan rantai kerja lama).
4. Arsipkan `mastery-*` dari jalur wajib; sesuaikan/pensiunkan 2 skrip audit.
5. Tulis ulang `README.md`; sapuan akhir: grep `role-|meta-templates|meta-decision|RFC` untuk rujukan mati.
6. Baca utuh hasil akhirnya sekali (pelajaran LEARNED: suntingan parsial beruntun menyisakan rujukan basi).
7. Commit atomik per langkah; merge `feature/lean-constitution` → `main`; catat pelajaran ke `LEARNED.md`.
