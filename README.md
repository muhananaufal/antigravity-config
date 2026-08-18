# ⚡ AETHERIS — Lean Constitution v2

> **SSOT (Single Source of Truth) untuk aturan agen AI.**
> Repositori konfigurasi sentral yang mengontrol perilaku agen di Google Antigravity dan Claude Code lewat satu berkas aturan bersama.

**Dua perilaku inti yang dijaga seluruh isi repo ini:**

1. **Tidak pernah langsung meng-acc request** — setiap permintaan fitur/perbaikan disapu **Panel Multi-POV** (7 lensa role) sebelum dieksekusi, lalu berhenti menunggu persetujuan.
2. **Setiap klaim berlabel sumber** — `[fakta:sumber]` · `[inferensi]` · `[spekulasi]` · `[memori-model]`, berlaku di semua mode termasuk saat menulis kode.

---

## 📑 Daftar Isi

1. [Peta Sistem](#-peta-sistem)
2. [Konstitusi (`AGENTS.md`)](#-konstitusi-agentsmd)
3. [Skill Bundles (`skills/`)](#-skill-bundles-skills)
4. [Otomasi & Hooks (`scripts/`)](#-otomasi--hooks-scripts)
5. [Memori Persisten (`shared/`)](#-memori-persisten-shared)
6. [Integrasi Multi-Tool](#-integrasi-multi-tool)
7. [Ekstensi MCP & Plugins](#-ekstensi-mcp--plugins)
8. [Jaminan Integritas Sistem](#-jaminan-integritas-sistem)

---

## 🗺️ Peta Sistem

```
~/.gemini/config/
├── AGENTS.md                   # SSOT Konstitusi (8 seksi: gerbang, routing, label, challenger, eksekusi)
├── README.md                   # Dokumen ini
├── config.json                 # Konfigurasi Global Antigravity
├── hooks.json                  # Lifecycle Hooks (Quality Gate otomatis saat Stop)
├── mcp_config.json             # Integrasi MCP Servers
│
├── drafts/                     # Draf perubahan konstitusi sebelum diaktifkan
├── projects/                   # State per-proyek Antigravity (ter-gitignore)
│
├── scripts/
│   ├── quality_gate.ps1        # Gerbang mutu KODE PROYEK (ratchet, placeholder, secret, linter, test)
│   ├── audit_references.ps1    # Gerbang mutu BERKAS REFERENSI (kepadatan, encoding, rantai kerja)
│   ├── audit_go_snippets.ps1   # Bukti eksekusi blok kode Go di korpus arsip
│   ├── stop_gate_antigravity.ps1
│   └── stop_gate_claude.ps1
│
├── shared/
│   ├── LEARNED.md              # Living Brain — pelajaran yang sudah dibayar mahal
│   └── tool-claude-code.md     # Adaptor Claude Code (terjemahan mekanisme tool)
│
├── skills/
│   ├── meta-panel/             # ★ GERBANG UTAMA — Panel Multi-POV 7 lensa
│   │   └── references/decision-tree.md   # Pohon keputusan stack & arsitektur
│   ├── meta-brainstorm/        # Brainstorming umum & teknikal + Gerbang Bukti
│   ├── meta-git/               # Git Flow, Conventional Commits, atribusi
│   ├── mastery-skills/         # Meta-skill pembuatan & audit skill baru
│   └── mastery-{golang,rust,laravel,nestjs}/   # ARSIP — korpus referensi domain
│
└── plugins/                    # Plugin pihak ketiga (Apache-2.0) — ter-gitignore
```

---

## 📜 Konstitusi (`AGENTS.md`)

SSOT mutlak. Diimpor Claude Code lewat `~/.claude/CLAUDE.md`, dibaca langsung oleh Antigravity.

### §0. Gerbang Mutlak — enam larangan tanpa pengecualian

1. **Anti-halusinasi:** klaim teknis wajib berlabel; kode DILARANG ditulis di atas `[memori-model]` yang belum diverifikasi ke sumber nyata.
2. **Panel:** request DILARANG langsung di-acc — sapu Panel Multi-POV dulu, lalu berhenti menunggu persetujuan.
3. **DILARANG lapor selesai** sebelum test/linter dijalankan dan hasilnya dilaporkan apa adanya.
4. **DILARANG klaim bugfix** tanpa Proof-of-Defect (reproduksi MERAH sebelum HIJAU).
5. **DILARANG meninggalkan** `// TODO`, kode setengah matang, credential hardcode, atau untyped bypass.
6. **Git:** Conventional Commits + trailer `Co-authored-by: aetheris <agents.aetheris@gmail.com>`.

### §2. Routing Task — lima jalur

| Jalur | Aksi |
| :--- | :--- |
| Brainstorming apa pun | Picu `meta-brainstorm` |
| Request fitur/perbaikan/refactor, **berapa pun ukurannya** | Panel → sajikan → BERHENTI → eksekusi §5 |
| Bugfix dengan gejala jelas | Panel ringkas → Proof-of-Defect → eksekusi §5 |
| Investigasi read-only / tanya jawab / obrolan | Jawab langsung, label §3 tetap berlaku |
| Blocker kritis di tengah eksekusi | BERHENTI, jelaskan, minta klarifikasi |

### §3. Label Epistemik — universal

Empat label, berlaku di semua mode termasuk saat coding. Angka spesifik tanpa sumber DILARANG. Frasa peminjam otoritas ("studi menunjukkan", "praktik industri") DILARANG tanpa sumber. Fetch gagal dicatat GAGAL, bukan diganti ingatan.

### §4. Challenger Procedure — anti-yes-man

Request tanpa masalah jelas ditolak. Usulan berisiko ditantang eksplisit. Setiap usulan arsitektur wajib ≥3 kelebihan **dan** ≥3 kekurangan; perubahan besar wajib ≥3 opsi. Flattery dan selebrasi prematur dilarang.

### §5. Disiplin Eksekusi — setelah persetujuan

Baseline regresi → branch kerja → batch maks 3–4 berkas → TDD untuk bugfix → exit gate → Circuit Breaker 5 loop → verifikasi state nyata (bukan klaim teks).

---

## 🛠️ Skill Bundles (`skills/`)

### ★ `meta-panel` — gerbang utama

Leburan lima role v1 (`architect`, `swe`, `devops`, `dba`, `qa`) menjadi **tujuh lensa yang menyala bersamaan** pada setiap request:

| # | Lensa | Menjawab |
| :-: | :--- | :--- |
| 1 | 📋 Manager / Product | Masalah nyatanya apa? Solusi titipan atau bukan? Non-goals? |
| 2 | 💰 Cost / FinOps | Ongkos implementasi + maintenance sepadan? |
| 3 | 🎨 UX / DX | Breaking change? Edge state (kosong/loading/gagal)? |
| 4 | 🛡️ Security | Sapuan STRIDE — permukaan serangan baru? |
| 5 | ⚙️ Ops / SRE | Bagaimana ini mati? Blast radius, observability, rollback |
| 6 | 🗄️ Data | (kondisional) Skema reversibel? Lock, index, pertumbuhan volume? |
| 7 | 🧪 QA / Edge-case | Bagaimana saya merusaknya? Race, double-submit, input aneh |

Output **proporsional**: request kecil dapat panel ringkas beberapa baris; request besar dapat tabel penuh + rekomendasi + alternatif ditolak + **pembatal** + utang bukti. Yang wajib adalah *menyapu* semua lensa — yang dilaporkan hanya lensa yang menemukan sesuatu.

`references/decision-tree.md` — pohon keputusan stack & arsitektur (compute model, persistence, async, API, auth, observability, deployment, scaling, security, testing). Berstatus **rujukan**, bukan gerbang wajib.

### `meta-brainstorm`

Protokol eksplorasi ide untuk ranah **umum** (bisnis, karir, keuangan, hukum, pendidikan) maupun **teknikal**. Mode umum adalah mode utama — di sana tidak ada compiler yang menegur klaim salah.

- **Gerbang Bukti:** 7 hukum anti-fabrikasi. Sumber yang tidak dibuka di sesi ini DILARANG disebut.
- **Fase 0:** ekstrak klaim penentu → sumber terdekat → WebSearch (*menemukan*) → WebFetch (*membaca*) → **pencarian pembantah wajib** → Evidence Ledger — semuanya sebelum opsi pertama disajikan.
- **Hubungan dengan `AGENTS.md` §3:** §3 adalah SSOT definisi label; §0 skill ini menambahkan Evidence Ledger di atasnya. Bila keduanya tampak berbeda, yang lebih ketat menang.

### `meta-git`

Git Flow (`feature/*`, `fix/*`, `chore/*`), Conventional Commits, atomic commit per unit logis, Stacked PRs & micro-branching per batch, dan trailer atribusi:

```text
Co-authored-by: aetheris <agents.aetheris@gmail.com>
```

### `mastery-skills`

Meta-skill untuk merancang dan mengaudit skill bundle baru.

### `mastery-{golang,rust,laravel,nestjs}` — **ARSIP**

Korpus referensi domain (703 berkas referensi total di seluruh bundle, terukur lewat `scripts/audit_references.ps1`). **Statusnya arsip sejak Lean v2:** masih di disk, boleh dikutip sebagai `[fakta:path]`, tetapi **tidak lagi wajib dibaca** sebelum menulis kode.

Alasannya ada di `LEARNED.md`: volume referensi bukan nilai — struktur dan routing yang menentukan. Kewajiban verifikasi kini menunjuk sumber nyata (source library terpasang, dokumentasi resmi, kode proyek itu sendiri), bukan korpus internal yang bisa basi tanpa ada yang tahu.

---

## ⚡ Otomasi & Hooks (`scripts/`)

Stop hook berjalan setiap kali agen menyelesaikan giliran:

```json
{
  "quality-gate": {
    "enabled": true,
    "Stop": [
      {
        "type": "command",
        "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/stop_gate_antigravity.ps1",
        "timeout": 60
      }
    ]
  }
}
```

**`quality_gate.ps1`** — gerbang mutu kode proyek user:

1. **Placeholder Blocker** — `// TODO`, `FIXME`, `implement later`, `your code here`.
2. **Secret Blocker** — private key, API key (`sk_live_`, `AKIA`, `ghp_`), URI berkredensial. Mencocokkan **bentuk nilai**, bukan hanya nama variabel.
3. **Untyped Bypass Blocker** — `any` (TS), raw `unwrap()` (Rust), raw `interface{}` (Go) pada baris baru.
4. **Empty Test Blocker** — fungsi test tanpa asersi.
5. **Phantom Test Prevention** — perubahan berkas sumber wajib diiringi eksekusi test runner riil.
6. **Ratchet** — hanya memblokir baris baru. Utang lama dilaporkan sebagai catatan, tidak memblokir; tanpa ini setiap repo legacy jadi mustahil dikerjakan.

**`audit_references.ps1`** — gerbang mutu berkas referensi + **gate rantai kerja** yang menjaga tabel 6 tahap tetap identik di `meta-git/SKILL.md` dan `meta-panel/references/decision-tree.md`.

---

## 🧠 Memori Persisten (`shared/`)

**`LEARNED.md`** — satu baris per pelajaran: fakta, lalu konsekuensinya. Wajib dibaca setiap sesi baru, wajib ditambah setiap kali user mengoreksi atau mekanisme meleset dari dugaan.

Kategorinya: tooling & hook system · quality gate & audit ratchet · Git flow & PowerShell Windows · proses & retrofit korpus · verifikasi alat CLI · arsitektur & stack decision · domain engine & runtime truths.

> **Cara menulis ke berkas ini:** pakai tool `Edit` atau `[IO.File]::WriteAllText` + `UTF8Encoding($false)`. **JANGAN** pakai redirect `>>` PowerShell — PS 5.1 menulis UTF-16LE, dan NUL byte yang masuk membuat git menganggap berkas ini biner.

---

## 🔄 Integrasi Multi-Tool

Satu SSOT, dua tool:

- **Antigravity** membaca `AGENTS.md` langsung (literal, tanpa ekspansi `@import`).
- **Claude Code** mengimpornya lewat `~/.claude/CLAUDE.md`, ditambah `shared/tool-claude-code.md` yang menerjemahkan nama tool dan membatasi subagent (maksimal 3 paralel, hanya bila user menyebut "swarm").

Satu kali edit di `AGENTS.md` berlaku di keduanya tanpa sinkronisasi manual. **DILARANG menulis aturan di `~/.claude/CLAUDE.md`** — berkas itu hanya penunjuk.

---

## 🔌 Ekstensi MCP & Plugins

| Server / Plugin | Tipe | Peran |
| :--- | :--- | :--- |
| **StitchMCP** | MCP Remote | Design system, wireframe & mockup UI/UX |
| **Chrome DevTools MCP** | MCP Local | Otomasi browser E2E, DOM snapshot, console log, Lighthouse |
| **Google Antigravity SDK** | Plugin | Siklus hidup agen, subagent, sidecar, slash command |
| **Modern Web Guidance** | Plugin | Panduan antarmuka modern, CSS token, responsive layout |

---

## 🛡️ Jaminan Integritas Sistem

Klaim di bawah **terukur, bukan janji** — tiap baris menyebut perintah yang membuktikannya.
Status terakhir diverifikasi **2026-08-18** lewat eksekusi langsung `scripts/audit_references.ps1` (bundle=7, berkas=703).

| Properti | Status | Cara membuktikan |
| :--- | :--- | :--- |
| Rantai kerja 6 tahap identik di kedua dokumen | ✅ utuh | `scripts/audit_references.ps1` |
| Gerbang "Gasskan" hadir di seluruh dokumen rantai | ✅ | `scripts/audit_references.ps1` |
| Rujukan silang antar-dokumen rantai resolve | ✅ | `scripts/audit_references.ps1` |
| Berkas referensi lolos gate FATAL | ⚠️ **92 pelanggaran** — `mastery-rust` 88, `mastery-laravel` 4 | `scripts/audit_references.ps1` |
| Nol kredensial hardcode ter-commit | ✅ | `git log -S` + `scripts/quality_gate.ps1` |
| Conventional Commits + Co-author trailer | ✅ | `git log --format=%s` |

> **92 pelanggaran FATAL itu utang lama di korpus arsip, bukan regresi.** Keduanya ada di bundle yang tidak disentuh migrasi Lean v2 (`git log main..HEAD -- skills/mastery-rust skills/mastery-laravel` mengembalikan kosong). Karena korpus itu kini berstatus arsip dan tidak lagi di jalur wajib, dampaknya turun — tapi angkanya tetap ditulis di sini, bukan disembunyikan.

> **DILARANG menulis klaim "0 Broken Paths" atau sejenisnya tanpa perintah yang membuktikannya.**
> Garansi yang tidak bisa dijalankan hanyalah dekorasi, dan lebih berbahaya daripada tidak ada.

---
*Dikelola dan dirawat oleh AETHERIS Autonomous Engineering Team.*
