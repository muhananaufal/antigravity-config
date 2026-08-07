---
name: git-workflow
description: Protokol Git untuk AI agent — branching (Git Flow), Conventional Commits, atomic commit, subagent constraints, dan setup commitlint/semantic-release. Dipicu saat proyek baru (Greenfield), fitur besar (Brownfield), atau operasi Git apa pun.
---

# Git Workflow — Top 1% Backend Engineering Protocol

Dokumen ini adalah SSOT perilaku AI agent terhadap Git. Setiap operasi yang menyentuh repositori Git — dari `git init` hingga `git push` — WAJIB mengikuti protokol ini tanpa pengecualian.

## 🔗 Posisi dalam Rantai Kerja

Skill ini adalah **tahap 5** — dan ia berada **SETELAH** gerbang persetujuan, bukan sebelumnya.

| # | Tahap | Dokumen |
| :-: | :--- | :--- |
| 1 | Routing task | `AGENTS.md` §2 |
| 2 | Pilih stack & arsitektur | `master-decision-tree/SKILL.md` |
| 3 | Tulis `docs/rfc/YYYYMMDD-<fitur>.md` + katalog | `templates/SKILL.md` bagian 1–2 |
| 4 | **BERHENTI — tunggu user mengetik "Gasskan"** | `AGENTS.md` §0.5 · **GERBANG MUTLAK** |
| 5 | **Branch, atomic commit, merge** | **`git-workflow/SKILL.md` — Anda di sini** |
| 6 | Patch Receipt + centang Kanban di RFC | `templates/SKILL.md` bagian 6 |

> Nomor **§** selalu merujuk `AGENTS.md`. Untuk seksi milik skill lain dipakai kata "bagian"; seksi dokumen ini sendiri ditulis §1–§10 tanpa nama berkas.

**DILARANG membuat branch untuk pekerjaan berjalur RFC sebelum tahap 4 terlewati.**

**Empat rute §2 `AGENTS.md` MENGGUGURKAN tahap 3–4 — di sana branch boleh langsung dibuat:**

| Rute §2 | Yang berlaku |
| :--- | :--- |
| Proyek baru **kecil** (4 syarat §2) | RFC & Day-0 Quintet DILARANG dipaksakan → langsung ke §3 dokumen ini |
| Edit **≤3 berkas**, bugfix, refactor minor, investigasi | DILARANG bikin RFC → langsung ke §4 dokumen ini. Bugfix tetap WAJIB Proof-of-Defect (§0.6) |
| **In-Flight Fix** — >3 berkas tapi berasal dari RFC yang SUDAH disetujui | **DILARANG buat RFC kedua, dan DILARANG buat branch kedua.** Lanjutkan di branch RFC yang aktif |
| **Emergency Pause** — blocker arsitektural kritis di tengah eksekusi | BERHENTI. Jangan commit setengah jadi; susun `docs/rca/YYYYMMDD-<insiden>.md` (`templates/SKILL.md` bagian 3) lebih dulu |

**Tiga sambungan yang WAJIB dijaga konsisten:**
- Nama branch WAJIB sama persis dengan field **Target Branch** di dokumen RFC (`templates` §1) dan di katalog `docs/rfc/README.md`.
- Satu **Batch** RFC memetakan ke satu atau lebih commit atomik (§5 di bawah); setelah batch lolos Quality Gate dan ter-commit, centang `[x]`-nya di RFC.
- Kerangka RFC, RCA, `system_map.md`, dan Patch Receipt seluruhnya didefinisikan di `templates/SKILL.md` — DILARANG mengarang formatnya sendiri.

---

## §0. HUKUM BESI

Tiga hukum yang DILARANG dilanggar dalam kondisi apa pun.

1. **SUBAGENT DILARANG MENULIS.** Subagent hanya boleh: membaca file (`view_file`, `grep_search`), menjalankan perintah read-only (`git status`, `git log`, `git diff`, test runner, linter), dan melaporkan temuan. Subagent DILARANG: `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `git commit`, `git checkout -b`, `git push`, `git merge`, atau perintah apa pun yang mengubah filesystem atau Git history. **Hanya Main Agent yang menyentuh filesystem dan Git.**
2. **SATU COMMIT = SATU UNIT LOGIS.** Commit yang mencampur fitur baru + refactor + config update dalam satu snapshot adalah pelanggaran. Pecah menjadi commit atomik berdasarkan *alasan perubahan*, bukan jumlah file.
3. **JANGAN COMMIT KE `main` ATAU `develop` SECARA LANGSUNG.** Semua pekerjaan WAJIB dilakukan di branch `feature/*`, `fix/*`, `hotfix/*`, atau `refactor/*`. Merge ke `develop` atau `main` hanya melalui mekanisme yang terkontrol (merge/PR).

---

## §1. BRANCHING MODEL — GIT FLOW

```
feature/*  ──┐
fix/*      ──┤
refactor/* ──┼──► develop ──► release/* ──► staging (opsional) ──► main
              │       ▲                                              │
              │       └──────────────── hotfix/* ◄───────────────────┘
              │                            │
              │                            └──► develop (cherry-pick / merge back)
```

### Branch Utama (Permanen)

| Branch | Fungsi | Siapa yang merge ke sini |
| :--- | :--- | :--- |
| `main` | Kode yang sedang live di production. Setiap commit di sini HARUS bisa di-deploy. | Hanya dari `release/*` atau `hotfix/*` |
| `develop` | Integrasi development. Merepresentasikan "next release". | Dari `feature/*`, `fix/*`, `refactor/*` |

### Branch Sementara (Dibuat dan Dihapus Sesuai Kebutuhan)

| Branch | Dibuat dari | Merge kembali ke | Naming Convention |
| :--- | :--- | :--- | :--- |
| `feature/*` | `develop` | `develop` | `feature/add-checkout-api` |
| `fix/*` | `develop` | `develop` | `fix/cart-race-condition` |
| `refactor/*` | `develop` | `develop` | `refactor/extract-payment-service` |
| `release/*` | `develop` | `main` + `develop` | `release/1.2.0` |
| `hotfix/*` | `main` | `main` + `develop` | `hotfix/fix-crash-checkout` |
| `staging` | `release/*` | (environment branch, bukan merge target) | `staging` |

### Aturan Penamaan Branch

```
<type>/<deskripsi-singkat-kebab-case>

Contoh:
  feature/user-email-verification
  fix/duplicate-order-on-double-click
  hotfix/payment-timeout-500
  refactor/simplify-auth-middleware
  release/2.1.0
```

---

## §2. CONVENTIONAL COMMITS

Setiap commit message WAJIB mengikuti format ini. Tidak ada pengecualian.

### Format

```
<type>(<scope>): <deskripsi imperatif, ≤50 karakter>

<body opsional — jelaskan "apa" dan "mengapa", bukan "bagaimana">

<footer opsional — referensi issue, breaking changes>
```

### Tipe Commit

| Type | Kapan Digunakan | Contoh |
| :--- | :--- | :--- |
| `feat` | Fitur baru yang menambah kapabilitas | `feat(auth): add OAuth2 Google login` |
| `fix` | Perbaikan bug | `fix(cart): prevent negative quantity` |
| `docs` | Perubahan dokumentasi saja | `docs(readme): update API setup guide` |
| `style` | Formatting, whitespace, titik koma — TANPA perubahan logika | `style(api): fix indentation in routes` |
| `refactor` | Perubahan kode yang bukan fix dan bukan fitur baru | `refactor(order): extract tax calculator` |
| `perf` | Peningkatan performa | `perf(query): add composite index on orders` |
| `test` | Menambah atau memperbaiki test | `test(payment): add integration test for refund` |
| `build` | Perubahan build system atau dependensi | `build(deps): upgrade sqlx to 0.8` |
| `ci` | Perubahan konfigurasi CI/CD | `ci(github): add staging deploy workflow` |
| `chore` | Perubahan lain yang tidak menyentuh src atau test | `chore: update .gitignore` |
| `revert` | Membatalkan commit sebelumnya | `revert: revert "feat(auth): add OAuth2"` |

### Breaking Changes

Tambahkan `!` setelah type/scope, DAN jelaskan di footer:

```
feat(api)!: change paginated response format

BREAKING CHANGE: GET /users now returns { data: [], meta: { page, total } }
instead of a flat array. All clients must update their parsers.

Refs #234
```

### Aturan Penulisan

1. **Subject line:** imperatif ("add", bukan "added" atau "adds"), ≤50 karakter, tanpa titik di akhir
2. **Body:** pisahkan dari subject dengan baris kosong. Jelaskan konteks dan alasan.
3. **Footer:** referensi issue (`Closes #123`, `Fixes #456`, `Refs #789`)
4. **Bahasa:** commit message WAJIB Bahasa Inggris (standar industri global)

### Semantic Versioning (Otomatis jika `semantic-release` dipasang)

```
fix:  → patch bump  (1.0.0 → 1.0.1)
feat: → minor bump  (1.0.0 → 1.1.0)
!:    → major bump  (1.0.0 → 2.0.0)
```

---

## §2b. STACKED PRs & MICRO-BRANCHING (SOTA Devin Protocol)

Untuk fitur besar berbasis All-in-One RFC yang mencakup banyak batch tugas:

```
develop
  ├── feature/rfc-20260806-core-schema (Batch 1: Contract Locking & Migrations)
  │     └── feature/rfc-20260806-domain-logic (Batch 2: Services & Repositories)
  │           └── feature/rfc-20260806-http-transport (Batch 3: Controllers & E2E)
```

1. **Micro-Branching per Batch:** Setiap batch RFC yang bersifat independen dikerjakan dalam branch terisolasi yang di-stack di atas batch sebelumnya.
2. **Atomic Verification Gate:** Setiap micro-branch wajib melewati seluruh test unit/integrasi dan quality gate sebelum di-merge ke branch fitur utama (`feature/rfc-*`).
3. **Clean Squash/Rebase:** Saat seluruh batch selesai, branch di-squash/rebase secara bersih ke `develop` dengan melampirkan Patch Receipt lengkap.

---

## §3. PROTOKOL GREENFIELD (Proyek Baru)

Urutan langkah yang WAJIB diikuti saat membuat proyek dari nol:

```
[Langkah 0: WAJIB SEBELUM APA PUN — Buat .gitignore]
  DILARANG membuat file kode, .env, config, dependensi, atau artefak
  build sebelum .gitignore ada dan ter-commit. Secret yang ter-stage
  sekali pun sulit dihapus permanen dari Git History.

  DIKECUALIKAN: dokumen perencanaan (docs/rfc/, docs/rca/, system_map.md).
  Rantai kerja menempatkannya di tahap 3, yaitu SEBELUM "Gasskan" dan
  karenanya sebelum git init di tahap 5 - jadi urutannya memang wajib
  mendahului .gitignore. Larangan di atas melindungi dari kebocoran
  kredensial dan artefak biner; berkas Markdown perencanaan tidak
  memuat keduanya.

  Salin baseline .gitignore dari §8 dokumen ini ke root project:
  $ git init
  $ git checkout -b main
  
  Buat .gitignore terlebih dahulu (lihat §8 untuk baseline content).
  Pastikan sekurang-kurangnya mencakup: .env, .env.*, node_modules/,
  vendor/, target/, dist/, build/, .idea/, .vscode/
  
  Baru kemudian:
  $ git add .gitignore
  $ git commit -m "chore: add .gitignore before any other file"

[Langkah 1: Inisialisasi Repositori]
  $ git checkout -b main          # Branch utama (sudah ada dari Langkah 0)
  
  Buat initial commit dengan struktur dasar:
  $ git add .
  $ git commit -m "chore: initialize project structure"
  
  Buat branch develop:
  $ git checkout -b develop

[Langkah 2: Setup Git Tooling]
  Salin file dari resources/ skill ini ke root project:
  - .commitlintrc.json           (Conventional Commits enforcement)
  - .gitmessage                  (Template commit message)
  - .releaserc.json              (HANYA jika project butuh auto-versioning)
  
  Pasang hooks (jika project Node.js/TypeScript):
  $ npm install -D @commitlint/cli @commitlint/config-conventional husky
  $ npx husky init
  $ echo "npx --no -- commitlint --edit \$1" > .husky/commit-msg
  
  Untuk Go/Rust/PHP: commitlint tetap bisa digunakan via npx global,
  atau validasi format commit lewat CI pipeline (GitHub Actions).
  
  Commit setup:
  $ git add .
  $ git commit -m "build: add commitlint and git hooks"

[Langkah 3: Mulai Development]
  $ git checkout -b feature/<nama-fitur-pertama>
  
  ... kerjakan fitur ...
  
  Commit secara atomik (lihat §5).
  
  Setelah selesai:
  $ git checkout develop
  $ git merge feature/<nama-fitur-pertama>
  $ git branch -d feature/<nama-fitur-pertama>

[Langkah 4: Release Pertama]
  $ git checkout -b release/0.1.0
  
  - Update versi di package.json / Cargo.toml / composer.json
  - Update CHANGELOG.md
  - Test suite final
  
  $ git commit -m "chore(release): prepare v0.1.0"
  $ git checkout main
  $ git merge release/0.1.0
  $ git tag -a v0.1.0 -m "release: v0.1.0"
  $ git checkout develop
  $ git merge release/0.1.0
  $ git branch -d release/0.1.0
```

---

## §4. PROTOKOL BROWNFIELD (Repo Eksisting)

Urutan langkah WAJIB sebelum menyentuh kode di repo yang sudah ada:

```
[Langkah 1: Sinkronisasi]
  $ git fetch origin                    # Ambil perubahan terbaru
  $ git status                          # Cek apakah ada uncommitted changes
  
  Jika ada uncommitted changes:
    → BERHENTI. Tanya user apakah ingin stash atau commit dulu.
  
  $ git checkout develop                # Pastikan di branch develop
  $ git pull --rebase origin develop    # Rebase, BUKAN merge (history bersih)

[Langkah 2: Buat Branch Kerja]
  $ git checkout -b feature/<nama-fitur>    # atau fix/, refactor/, dll
  
  DILARANG langsung bekerja di develop atau main.

[Langkah 3: Kerjakan Fitur]
  ... eksekusi batch checklist di docs/rfc/ ...
  
  Commit secara atomik (lihat §5).

[Langkah 4: Integrasi]
  Sebelum merge ke develop, pastikan branch up-to-date:
  $ git fetch origin
  $ git rebase origin/develop          # Rebase di atas develop terbaru
  
  Jika ada conflict:
    → BERHENTI. Laporkan conflict ke user. DILARANG force resolve.
  
  $ git checkout develop
  $ git merge feature/<nama-fitur>     # Fast-forward jika memungkinkan
  $ git branch -d feature/<nama-fitur>

[Langkah 5: Hotfix (Bug Kritis di Production)]
  $ git checkout main
  $ git pull --rebase origin main
  $ git checkout -b hotfix/<deskripsi>
  
  ... perbaiki bug ...
  
  $ git commit -m "fix(<scope>): <deskripsi>"
  $ git checkout main
  $ git merge hotfix/<deskripsi>
  $ git tag -a v1.2.1 -m "hotfix: <deskripsi>"
  $ git checkout develop
  $ git merge hotfix/<deskripsi>       # Propagasi fix ke develop
  $ git branch -d hotfix/<deskripsi>
```

---

## §5. ATOMIC COMMIT — CARA MENGELOMPOKKAN PERUBAHAN

Ini adalah seni yang membedakan junior dan senior engineer. Satu task bisa menghasilkan banyak commit.

### Contoh: Task "Tambah Fitur Checkout"

```
SALAH (1 commit raksasa):
  "feat: add checkout feature with payment, email, and DB migration"

BENAR (4 commit atomik):
  1. "feat(db): add orders and order_items migration"
  2. "feat(order): implement order creation service"  
  3. "feat(payment): integrate Stripe checkout session"
  4. "feat(email): send order confirmation after payment"
```

### Decision Tree untuk Atomisitas

```
Apakah perubahan ini bisa di-revert secara independen
tanpa merusak perubahan lain?
├── YA → Ini HARUS jadi commit terpisah
└── TIDAK → Gabungkan dengan commit yang bergantung padanya
```

### Urutan Commit yang Benar

```
1. Infrastruktur dulu (migration, config, dependency)
2. Core logic (service, repository, domain model)
3. Integrasi (controller/handler, route, middleware)
4. Pelengkap (test, dokumentasi)
```

### Teknis: Cara Staging Parsial

Jika AI sudah mengubah banyak file sekaligus untuk satu task, gunakan `git add` per kelompok:

```bash
# Commit 1: Database migration
git add database/migrations/
git commit -m "feat(db): add orders table migration"

# Commit 2: Service layer
git add src/services/order_service.go src/repositories/order_repo.go
git commit -m "feat(order): implement order creation service"

# Commit 3: HTTP handler
git add src/handlers/order_handler.go src/routes/api.go
git commit -m "feat(api): add POST /orders endpoint"

# Commit 4: Tests
git add tests/
git commit -m "test(order): add integration tests for order creation"
```

### Co-Author Attribution Protocol (Pair Programming Trailer)

Untuk memunculkan atribusi kolaborasi ganda (*dual avatar*) di GitHub / GitLab, pesan commit yang dibuat oleh AI Agent dapat menyertakan Git trailer `Co-authored-by:` di bagian footer:

```text
feat(auth): implement jwt rs256 verification and test suite

Implement RS256 token validation with fail-fast env checks and unit tests.

Co-authored-by: aetheris <agents.aetheris@gmail.com>
```

> **Catatan Platform:**
> - Saat berjalan di **Google Antigravity (AETHERIS):** gunakan `Co-authored-by: aetheris <agents.aetheris@gmail.com>`
> - Saat berjalan di **Claude Code:** gunakan `Co-authored-by: Claude <noreply@anthropic.com>`
> - Trailer diletakkan di **baris paling akhir** setelah 1 baris kosong (*blank line*) pemisah.

### Rollback Protocol — Jika Quality Gate Gagal Mid-Atomic

Skenario: Commit 1 & 2 sudah dilakukan, Commit 3 gagal Quality Gate.

```bash
# JANGAN buat commit "fix" baru yang mengotori history.
# Lakukan rollback ke titik sebelum task dimulai:

# Cek berapa commit yang perlu di-undo
git log --oneline -5

# Undo N commit terakhir, tapi PERTAHANKAN perubahan di working tree
git reset --soft HEAD~N   # N = jumlah commit yang ingin di-undo

# Sekarang semua perubahan kembali ke staged state.
# Perbaiki masalah yang ditemukan Quality Gate.
# Kemudian re-commit secara bersih dari awal:
git add <file-group-1>
git commit -m "feat(scope): deskripsi unit logis 1"

git add <file-group-2>
git commit -m "feat(scope): deskripsi unit logis 2"
# ... dst
```

> **Aturan:** DILARANG membuat commit dengan pesan `"fix: try again"`,
> `"wip"`, `"temp"`, atau sejenisnya. Git history adalah dokumentasi
> permanent. Rollback + re-commit bersih adalah satu-satunya jalan.

---

## §6. SUBAGENT CONSTRAINTS

### Yang BOLEH Dilakukan Subagent

| Aksi | Contoh | Alasan |
| :--- | :--- | :--- |
| Membaca file | `view_file`, `grep_search`, `list_dir` | Riset codebase |
| Search web | `search_web`, `read_url_content` | Riset dokumentasi |
| Git read-only | `git status`, `git log`, `git diff`, `git branch -a` | Audit repository |
| Jalankan test/linter | `go test`, `cargo test`, `npm test`, `phpstan` | Cek baseline |
| Kalkulasi / analisis | Hitung file, bandingkan output, parse log | Analisis temuan |

### Yang DILARANG Dilakukan Subagent

| Aksi | Alasan |
| :--- | :--- |
| `write_to_file` / `replace_file_content` / `multi_replace_file_content` | Hanya Main Agent yang menulis |
| `git add` / `git commit` / `git push` | Hanya Main Agent yang mengubah Git history |
| `git checkout -b` / `git merge` / `git rebase` | Hanya Main Agent yang mengelola branch |
| `rm`, `mv`, `mkdir` (yang mengubah structure) | Hanya Main Agent yang mengubah filesystem |
| Install dependency (`npm install`, `go get`, `cargo add`) | Mengubah lockfile = mengubah filesystem |

### Alur Kerja dengan Subagent

```
Main Agent menerima task dari user
│
├── Apakah task butuh riset paralel (>3 domain, audit besar)?
│   ├── YA → Spawn subagents (READ-ONLY) untuk:
│   │         - Membaca referensi dari skills/
│   │         - Audit file dan direktori codebase
│   │         - Menjalankan test suite untuk baseline
│   │         - Search web untuk dokumentasi
│   │         └── Subagents melaporkan temuan ke Main Agent
│   │
│   └── TIDAK → Main Agent riset sendiri
│
├── Main Agent menyusun dokumen RFC di docs/rfc/
├── User approve ("Gasskan")
│
├── Main Agent:
│   ├── git checkout -b feature/...
│   ├── Menulis SEMUA file sendiri (berdasarkan temuan subagent)
│   ├── git add + commit per unit logis (§5)
│   └── Lapor ke user: "Siap di-review/push"
│
└── User review → push / merge
```

---

## §7. PRE-COMMIT CHECKLIST

Sebelum SETIAP `git commit`, Main Agent WAJIB memverifikasi:

```
[ ] Commit message mengikuti Conventional Commits format (§2)
[ ] Perubahan dalam commit ini adalah SATU unit logis (§5)
[ ] Tidak ada file yang seharusnya masuk commit lain (staging parsial)
[ ] Tidak ada `// TODO`, credential hardcode, atau placeholder
[ ] Tidak ada file temporary / debug yang ikut ter-stage
[ ] .gitignore sudah mencakup build artifacts, .env, node_modules, target/
```

---

## §8. GITIGNORE BASELINE

Setiap project WAJIB memiliki `.gitignore` yang minimal mencakup:

```gitignore
# Environment & Secrets
.env
.env.*
!.env.example

# Dependencies
node_modules/
vendor/
target/

# Build artifacts
dist/
build/
*.exe
*.dll
*.so
*.dylib

# IDE
.idea/
.vscode/
*.swp
*.swo
*~

# OS
.DS_Store
Thumbs.db

# Logs
*.log
logs/

# Coverage & Testing
coverage/
.nyc_output/
htmlcov/
```

---

## §9. COMMIT MESSAGE TEMPLATE

File `.gitmessage` yang disalin ke project dapat di-set sebagai template default:

```bash
git config commit.template .gitmessage
```

Ini akan muncul di editor setiap kali developer mengetik `git commit` tanpa `-m`, memandu format yang benar.

---

## §10. KAPAN PUSH KE REMOTE

```
Apakah branch ini sudah memiliki ≥1 commit yang lengkap dan teruji?
├── YA
│   ├── Apakah user sudah approve perubahan?
│   │   ├── YA → git push origin <branch-name>
│   │   └── TIDAK → BERHENTI. Tunggu approval.
│   │
└── TIDAK → Jangan push. Commit WIP ke lokal saja.
```

### Force Push Policy

- `git push --force` **DILARANG** di `main`, `develop`, `staging`, dan `release/*`
- `git push --force-with-lease` **BOLEH** hanya di branch `feature/*` milik sendiri setelah rebase
