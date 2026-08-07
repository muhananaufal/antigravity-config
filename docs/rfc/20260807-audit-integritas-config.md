# RFC: Remediasi Integritas SSOT `~/.gemini/config`

- **Status:** `PROPOSED`
- **RFC Tier (T-Shirt Size):** `Tier 1 (Full RFC)`
- **Tanggal:** 2026-08-07
- **Target Branch:** `fix/audit-integritas-config`
- **RACI Governance Matrix:**
  - **Responsible (Author):** AI Main Agent (Claude Code, Opus 5)
  - **Accountable (Approver):** User — menunggu kata "Gasskan"
  - **Consulted:** `shared/LEARNED.md`, `skill-engineering-mastery/references/quality_audit_checklist.md`
  - **Informed:** Sesi Antigravity & Claude Code berikutnya

> **Kenapa dokumen ini ada:** hasil audit disimpan agar bertahan melewati batas context window.
> Sesi berikutnya WAJIB membaca berkas ini lebih dulu, jalankan perintah verifikasi di §5,
> lalu lanjutkan dari batch yang statusnya masih `[ ]`. DILARANG mengulang audit dari nol.

---

## 1. Konteks & Metodologi

Audit forensik penuh atas repositori SSOT konfigurasi agent. Dipicu permintaan user
("cari lagi apakah ada hole? deep dive"). Bukan insiden produksi — ini audit preventif.

**Cakupan yang benar-benar dibaca (41 berkas, ~350 KB):**
`scripts/` (3) · `shared/` (2) · `AGENTS.md` · `README.md` · `hooks.json` ·
`skills/{brainstorm,templates,git-workflow,master-decision-tree}` (7) ·
`skills/skill-engineering-mastery/` (13) · 4× `<stack>-mastery/SKILL.md` ·
9 berkas `_protocol/` dari keempat bundle mastery.

**BELUM dibaca:** 691 berkas referensi domain (~8.837 KB ≈ 2,3 juta token).
Melebihi context window 1 juta token. Konsekuensinya tercatat di §6 (Batasan).

**Enam dimensi audit:**

| # | Dimensi | Metode |
| :-- | :--- | :--- |
| 1 | Reachability direktori (2 arah) | diff `references/X/` di SKILL.md ↔ direktori di disk |
| 2 | Reachability berkas | ekstrak `*.md` yang disebut spesifik di SKILL.md, cek eksistensi |
| 3 | Integritas rujukan `§` | ~35 rujukan lintas-dokumen dicocokkan ke penomoran asli `AGENTS.md` |
| 4 | Gate vs mandat | `quality_gate.ps1` dibandingkan dengan Quality Gate tiap `SKILL.md` |
| 5 | Klaim vs disk | angka domain/berkas di README & SKILL.md dihitung ulang |
| 6 | Higiene kredensial | pindai config + `git ls-files` + `git log -S` |

**⚠️ Jebakan metodologi yang sudah memakan korban (JANGAN diulang):**
Uji reachability berbasis "nama muncul di teks" memberi **false negative** karena substring —
`db` cocok dengan "Timescale**DB**", `arch` dengan "ai_se**arch**_infra", `security` dengan
"zero_trust_enterprise_**security**". H1 nyaris lolos. WAJIB pakai pencocokan path eksak
(`references/X/`). Selaras `LEARNED.md` butir Glob `*_protocol*` dan butir "Satu sinyal bukan pengukuran".

---

## 2. Inventori Temuan (15 lubang — H15 ditemukan saat verifikasi Batch 1)

Kolom **Status** adalah tracker Kanban: `[ ]` belum · `[/]` dikerjakan · `[x]` tertambal & terverifikasi.
Maksimal 2 item `[/]` bersamaan.

### 🔴 KRITIS

#### H1 — Laravel: 30% ilmu mati di jalur Brownfield · Status: `[x]` TERTAMBAL 2026-08-07
Empat domain fundamental tidak pernah dirujuk dari `laravel-mastery/SKILL.md`:

| Domain | Berkas | KB | Isi kunci |
| :--- | ---: | ---: | :--- |
| `api/` | 12 | 168,7 | routing_versioning, resources_formatting, error_handling, webhooks |
| `arch/` | 8 | 148,9 | hexagonal, cqrs, event_sourcing_aggregate_roots, modular_monolith |
| `db/` | 6 | 108,4 | eloquent_relationships, query_optimization, migrations |
| `security/` | 9 | 185,5 | authentication, authorization_blueprint, input_validation, acl |
| **Total** | **35** | **611,5** | **30% dari bundle (2.068 KB)** |

Satu-satunya rujukan: `laravel-mastery/references/_protocol/greenfield.md:9-11`.
Tabel Core/Context/Auto-Detect di `SKILL.md` nol menyebutnya, dan `_protocol/brownfield.md`
hanya menulis "baca `references/` yang relevan" tanpa daftar domain.

**Akibat:** tugas Laravel brownfield tidak pernah diarahkan ke Eloquent relationships,
query optimization, hexagonal, authentication, authorization, input validation.
Agent mengarang dari hafalan (langgar §0.1) sambil merasa patuh.
**Kambuhan** dari `LEARNED.md` butir "rust/laravel hanya punya tabel Niche — 129 berkas jadi mati".

### 🟠 TINGGI

#### H2 — Gate `-Full` lebih lemah dari mandat tiap SKILL.md · Status: `[ ]`

| Stack | `quality_gate.ps1:239-244` menjalankan | `SKILL.md` mewajibkan | Hilang |
| :--- | :--- | :--- | :--- |
| Go | `go vet`, `go test -race` | + `golangci-lint run` | golangci-lint |
| Rust | `cargo clippy --all-targets -D warnings`, `cargo test` | + `cargo fmt --check`, `--all-features`, `cargo miri test`, `cargo audit` | fmt, miri, audit |
| PHP | `pint --test`, `php artisan test` | + `phpstan --level=9`, `test --arch`, `composer audit` | PHPStan L9, audit |
| Node | `npm test --silent` | `tsc --noEmit`, `eslint .`, jest | tsc, eslint; hardcode `npm` padahal bundle mewajibkan pnpm/corepack |

Diperparah `nestjs-mastery/SKILL.md:103` yang menyebut `quality_gate.ps1` sebagai
"gerbang **primer**" dan tabel bahasa sebagai "**pelengkap**" — terbalik dari kenyataan.

#### H3 — Gate tidak pernah memindai `.json` · Status: `[ ]`
`quality_gate.ps1:22` `$CODE_EXT` memuat 17 ekstensi, **`.json` tidak termasuk**.
Terbukti: API key Google di `mcp_config.json:9` (`X-Goog-Api-Key: AQ.Ab8RN6...`) tak terdeteksi
karena dua sebab — ekstensi tak dipindai **dan** bentuk `AQ.Ab8...` absen dari `$SECRET_VALUE`
(yang hanya kenal `AIza...`).
**Kunci itu AMAN** — ter-`.gitignore`, tidak tracked, `git log -S` kosong, tidak pernah ter-commit.
Yang cacat detektornya, bukan higiene-nya.

### 🟡 SEDANG

#### H4 — Deteksi empty-test Rust adalah dead code · Status: `[ ]`
`quality_gate.ps1:170` mencocokkan `$f.Name` (nama berkas saja) dengan pola `tests/.*\.rs$`.
Nama berkas tidak pernah memuat `/` di OS mana pun → cabang Rust tak pernah menyala.

#### H5 — Gate 4 false-block: `composer test` absen · Status: `[ ]`
`quality_gate.ps1:203` `$TESTCMD` tidak memuat `composer test`, padahal `AGENTS.md §6`
menyebutnya perintah sah. `cargo nextest` juga absen (dipakai `rust-mastery/ci_cd_pipeline_cargo/`).
Agent patuh yang menjalankan `composer test` **diblokir** dengan tuduhan "test tidak pernah dijalankan".

#### H6 — Gate 2b: false-block Rust + celah Go · Status: `[ ]`
`quality_gate.ps1:147-148`. `UNTYPED_RS='\.unwrap\(\)'` tanpa pengecualian berkas test →
menulis test Rust idiomatis memicu blokir. `UNTYPED_GO='interface\{\}'` memblokir bentuk lama
tapi **membiarkan `any`** — alias identik dan idiom Go 1.18+. Bentuk lama diblokir, bentuk baru lolos.

#### H7 — Dua rujukan `§` rusak · Status: `[ ]`
- `skills/brainstorm/SKILL.md:14` — menulis "§2 (bahasa & kepadatan)". §2 = ROUTING TASK. Seharusnya **§8**.
- `AGENTS.md:178` — menulis "hanya setelah §3.7". §3.7 = lokasi referensi mastery.
  Prasyarat web search ada di **§3.8**. Off-by-one.

#### H8 — `scripts/` wajib per bundle, nol dari 5 punya · Status: `[ ]`
`skill-engineering-mastery/references/architecture_pattern.md:23` menandai `scripts/` **[WAJIB]**;
`skill_md_template.md:54` mewajibkan `audit_quality_gate.ps1` + `quality_gate.sh`.
Nol bundle memilikinya. Lebih parah: `nestjs-mastery/SKILL.md:107` merujuk
"Skrip di `scripts/` bundle ini" — pointer ke direktori yang tidak eksis.

#### H9 — Batch Writing Protocol hilang di Claude Code · Status: `[ ]`
`shared/tool-claude-code.md:6` menyatakan §7 DIABAIKAN, tapi CC-1 hanya menggantikan
tabel routing subagent. DAG Task Dependency & Contract-First **selamat** lewat template RFC.
Yang benar-benar jatuh: **"maks 3-4 file per turn + test + atomic commit tiap batch"** —
tidak direstate di mana pun. `templates/SKILL.md:134` masih menunjuk "§7".
Ironi: itu justru penyebab truncation & `// TODO` siluman yang §7 sendiri peringatkan.

### 🟢 RENDAH

#### H10 — `master_decision_tree.md` menggantung di 4 lokasi · Status: `[ ]`
Nama berkas ini **tidak eksis** (aslinya `master-decision-tree/SKILL.md`). Muncul 9×;
5 menyertakan path benar dalam kurung. Empat yang menggantung tanpa path:
`shared/tool-claude-code.md:62` · `skill-engineering-mastery/SKILL.md:17`, `:18`, `:127`.

#### H11 — Drift angka domain/berkas · Status: `[ ]`

| Lokasi | Klaim | Kenyataan |
| :--- | :--- | :--- |
| `README.md:58-62` | "31 Domain" untuk **keempat** bundle | 30 / 27 / 36 / 34 |
| `laravel-mastery/SKILL.md:8` | 26 Domain, 131 File | 27 domain, 136 berkas |
| `rust-mastery/SKILL.md:8` | 31 Domain, 191 File | 34 domain, 195 berkas |
| `nestjs-mastery/SKILL.md` | label Tier I=15, Tier II=13 | baris nyata 16 dan 12 (total 36 ✅) |
| `architecture_pattern.md:8-10` | Go 28/197 · Rust 31/190 · Laravel 26/130 | 30/221 · 34/195 · 27/136 |
| `golang-mastery/SKILL.md:8` | 30 Domain, 221 File | **AKURAT ✅** |

#### H12 — Klaim "0 Broken Paths" di README batal · Status: `[ ]`
`README.md` §Jaminan Integritas mengklaim "✅ 0 Broken Paths pada seluruh referensi markdown
dan link lokal". H8 dan H10 membatalkannya.

#### H13 — Kanban maks 2 WIP jatuh di Claude Code · Status: `[ ]`
Aturan itu hidup **hanya** di `AGENTS.md §8`; CC-3 menggantikan §8 tapi tidak merestatenya.
(Aturan web-search selamat lewat §3.8 — jangan ikut "diperbaiki".)

#### H15 — `cli_tooling` golang tanpa rujukan path · Status: `[ ]`
Ditemukan saat verifikasi ulang Batch 1 (bukan bagian audit awal — 14 temuan pertama melewatkannya).
`golang-mastery/SKILL.md` menyebut `cli_tooling/` **hanya** di tabel Auto-Detect dengan nama telanjang,
tanpa bentuk `references/cli_tooling/`. Domain lain di tabel yang sama selamat karena juga muncul
di Context References dengan path lengkap; `cli_tooling` tidak.
Masih terjangkau (agent bisa menyimpulkan path-nya), jadi severity rendah — tapi inkonsisten
dengan 29 domain golang lainnya. **Sengaja TIDAK ditambal** bersama H1: di luar scope task "kritis",
sesuai §4 Anti-Yes-Man & prinsip ratchet.

#### H14 — Higiene dokumentasi & gitignore · Status: `[ ]`
`projects/` (22 JSON) tidak ada di tree `README.md`. `.gitignore` repo ini tidak memenuhi
baseline `git-workflow/SKILL.md §8` sendiri (tanpa `.env`, `node_modules/`, `dist/`, IDE, OS).
Bisa dibenarkan untuk repo config, tapi standarnya berbunyi "Setiap project WAJIB".

---

## 3. Yang SUDAH diverifikasi BERSIH — DILARANG diaudit ulang

| Aspek | Hasil |
| :--- | :--- |
| Reachability direktori keempat bundle | Nol orphan, nol broken pointer (uji path eksak 2 arah) |
| Reachability berkas | 40 berkas `.md` yang disebut spesifik di SKILL.md, semuanya ada |
| Stop hook Claude Code | Aktif — `stop_gate_claude.ps1` terdaftar di `~/.claude/settings.json:61` |
| Kebocoran kredensial di Git | Nihil — tidak tracked, tidak pernah ter-commit |
| Rujukan `§` selain H7 | `§0.3` `§0.4` `§3.1` `§3.4` `§3.5` `§3.6` `§3.9` `§4` `§5` `§6` semua akurat |
| Integrasi NestJS ke ekosistem | Lengkap — `master-decision-tree` NODE 1.1, `AGENTS.md §3.5`, `tool-claude-code.md` |
| `_protocol/brownfield.md` di 4 bundle | Ada semua — regresi lama tidak terulang |
| Kerangka `brownfield.md` antar-bundle | Identik 100% (Rekonesans → Blast Radius → ≥3 opsi) |

---

## 4. Rencana Eksekusi (DAG Batch — tunggu "Gasskan")

### Batch 1: Pemulihan Jangkauan Ilmu — ✅ SELESAI 2026-08-07
* **DependsOn:** `[]`
* **Goal:** kembalikan 611,5 KB ilmu Laravel ke jalur eksekusi.
* **Rute:** dieksekusi lewat jalur `AGENTS.md §2` "Edit ≤3 berkas → langsung eksekusi",
  **bukan** lewat gerbang "Gasskan". Batch 2-5 tetap menunggu persetujuan.
- [x] `[MODIFY]` `skills/laravel-mastery/SKILL.md` — tambah `arch/` `db/` `api/` `security/` ke tabel **Core References**
- [x] Verifikasi H1 dengan perintah §5.1 → hasil: `laravel-mastery WEAK REF = nihil` ✅

### Batch 2: Perbaikan Cacat Gate (perilaku tidak berubah, hanya bug)
* **DependsOn:** `[Batch 1]`
* **Goal:** hentikan false-block dan hidupkan cabang mati.
- [ ] `[MODIFY]` `scripts/quality_gate.ps1` — H4 (pola `tests/.*\.rs` → cocokkan `FullName`, bukan `Name`)
- [ ] `[MODIFY]` `scripts/quality_gate.ps1` — H5 (tambah `composer test`, `cargo nextest` ke `$TESTCMD`)
- [ ] `[MODIFY]` `scripts/quality_gate.ps1` — H6 (kecualikan berkas test dari `UNTYPED_RS`; tambah `\bany\b` ke `UNTYPED_GO`)
- [ ] Tanam pelanggaran uji lalu jalankan gate — buktikan menyala/padam sesuai harapan
      (`LEARNED.md`: "Untuk menguji gate, tanam pelanggarannya sendiri")

### Batch 3: Perbaikan Rujukan Silang
* **DependsOn:** `[Batch 1]`
* **Goal:** nol rujukan menggantung.
- [ ] `[MODIFY]` `skills/brainstorm/SKILL.md:14` — §2 → §8 (H7)
- [ ] `[MODIFY]` `AGENTS.md:178` — §3.7 → §3.8 (H7)
- [ ] `[MODIFY]` 4 lokasi `master_decision_tree.md` menggantung → path lengkap (H10)
- [ ] Verifikasi dengan perintah §5.3

### Batch 4: Penguatan Gate (MENGUBAH PERILAKU — butuh persetujuan terpisah)
* **DependsOn:** `[Batch 2]`
* **Goal:** selaraskan gate dengan mandat SKILL.md.
- [ ] `[MODIFY]` `scripts/quality_gate.ps1` — H2 (selaraskan `$cmds` dengan tiap SKILL.md)
- [ ] `[MODIFY]` `scripts/quality_gate.ps1` — H3 (tambah `.json` ke `$CODE_EXT` + pola `AQ\.[A-Za-z0-9_-]{20,}`)
- [ ] Uji regresi: jalankan `-Full` pada repo contoh tiap stack, pastikan tidak meledak false-positive

### Batch 5: Dokumentasi & Konsistensi Standar
* **DependsOn:** `[Batch 3]`
- [ ] `[MODIFY]` `README.md` — angka domain keempat bundle (H11), tambah `projects/` ke tree (H14), turunkan klaim "0 Broken Paths" (H12)
- [ ] `[MODIFY]` `laravel-mastery/SKILL.md:8`, `rust-mastery/SKILL.md:8`, label tier `nestjs-mastery/SKILL.md` (H11)
- [ ] `[MODIFY]` `architecture_pattern.md:8-10` — statistik + masukkan NestJS sebagai anggota keempat (H11 + Side Note)
- [ ] Putuskan H8: buat `scripts/` di 5 bundle **atau** cabut mandatnya dari standar
- [ ] Putuskan H9 & H13: restate "maks 3-4 file/turn" dan "maks 2 WIP" di `tool-claude-code.md` CC-3

---

## 5. Perintah Verifikasi Ulang (jalankan untuk cek status tanpa audit ulang)

### 5.1 — H1: domain tanpa rujukan path di SKILL.md
```powershell
$root = "C:\Users\muhan\.gemini\config\skills"
foreach ($b in @("golang-mastery","laravel-mastery","nestjs-mastery","rust-mastery")) {
  $skill = Get-Content "$root\$b\SKILL.md" -Raw -Encoding UTF8
  $dirs  = @(Get-ChildItem "$root\$b\references" -Directory | Select-Object -ExpandProperty Name)
  $cited = @([regex]::Matches($skill,'references/([a-z0-9_]+)/') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
  $weak  = @($dirs | Where-Object { $cited -notcontains $_ })
  Write-Host "$b : WEAK REF = $($weak -join ', ')"
}
```
**LULUS bila:** laravel tidak lagi memuat `api`, `arch`, `db`, `security`.

### 5.2 — H4/H5/H6: cacat gate
```powershell
$g = Get-Content "C:\Users\muhan\.gemini\config\scripts\quality_gate.ps1" -Raw
"H4 dead-code   : " + $(if ($g -match '\$f\.Name -match .*tests/') { 'MASIH ADA' } else { 'TERTAMBAL' })
"H5 composer    : " + $(if ($g -match 'composer test')            { 'TERTAMBAL' } else { 'MASIH ADA' })
"H6 go any      : " + $(if ($g -match 'UNTYPED_GO.*any')          { 'TERTAMBAL' } else { 'MASIH ADA' })
"H3 json scan   : " + $(if ($g -match "CODE_EXT.*\.json")         { 'TERTAMBAL' } else { 'MASIH ADA' })
```

### 5.3 — H7/H10: rujukan menggantung
```powershell
$c = "C:\Users\muhan\.gemini\config"
Select-String -Path "$c\skills\brainstorm\SKILL.md" -Pattern '§2 \(bahasa'
Select-String -Path "$c\AGENTS.md"                  -Pattern 'setelah §3\.7'
Select-String -Path "$c\shared\tool-claude-code.md","$c\skills\skill-engineering-mastery\SKILL.md" -Pattern 'master_decision_tree\.md'
```
**LULUS bila:** dua yang pertama nihil; yang ketiga hanya muncul berpasangan dengan path lengkap.

### 5.4 — H8: direktori scripts per bundle
```powershell
foreach ($b in @("golang-mastery","laravel-mastery","nestjs-mastery","rust-mastery","skill-engineering-mastery")) {
  "$b scripts/ = " + (Test-Path "C:\Users\muhan\.gemini\config\skills\$b\scripts")
}
```

### 5.5 — H11: hitung ulang angka domain & berkas
```powershell
$root = "C:\Users\muhan\.gemini\config\skills"
foreach ($b in @("golang-mastery","laravel-mastery","nestjs-mastery","rust-mastery")) {
  $ref  = "$root\$b\references"
  $dom  = @(Get-ChildItem $ref -Directory | Where-Object { $_.Name -ne '_protocol' })
  $md   = @(Get-ChildItem $ref -Recurse -File -Filter *.md)
  $prot = @(Get-ChildItem "$ref\_protocol" -File -Filter *.md -ErrorAction SilentlyContinue)
  "{0,-16} {1} domain, {2} berkas domain" -f $b, $dom.Count, ($md.Count - $prot.Count)
}
```
**Angka acuan per 2026-08-07:** golang 30/221 · laravel 27/136 · nestjs 36/139 · rust 34/195

---

## 6. Batasan Audit Ini (WAJIB dibaca sebelum mengklaim tuntas)

1. **691 berkas referensi domain (~8.837 KB) belum pernah dibaca.** Audit ini menguji
   *struktur, routing, dan rujukan* — **bukan** kebenaran teknis isi referensinya.
   Cacat faktual seperti yang pernah ditemukan di `continuous_profiling.md`
   (lihat `LEARNED.md`) TIDAK akan tertangkap audit ini.
2. **Dimensi yang belum disentuh:** kualitas isi per berkas (≥130 baris, ≥2 anti-pattern,
   ≥3 edge case, ≥1 diagram) sesuai `reference_file_standards.md`; encoding BOM/U+FFFD;
   duplikasi materi antar-domain; akurasi klaim teknis.
3. **Nol subagent dipakai** (CC-1 — user tidak menyebut "swarm"). Seluruh temuan berasal
   dari pembacaan langsung + skrip verifikasi, jadi setiap klaim bisa ditelusuri baris demi baris.

---

## 7. Rollback

Seluruh perubahan adalah suntingan berkas teks di repo Git. Rollback = `git revert <sha>`
per batch. Batch 4 satu-satunya yang mengubah perilaku runtime (gate jadi lebih ketat);
bila memicu false-positive massal, revert Batch 4 saja — Batch 1-3 dan 5 tidak bergantung padanya.
