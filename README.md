# ⚡ AETHERIS — Lean Constitution v2

> **SSOT (Single Source of Truth) untuk aturan agen AI.**
> Repositori konfigurasi sentral yang mengontrol perilaku agen di Google Antigravity dan Claude Code lewat satu berkas aturan bersama.

**Dua perilaku inti yang dijaga seluruh isi repo ini:**

1. **Tidak pernah langsung meng-acc request** — setiap permintaan fitur/perbaikan disapu **Panel Multi-POV** (10 lensa role) sebelum dieksekusi, lalu berhenti menunggu persetujuan.
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
├── archive/                    # Korpus PENSIUNAN — di luar jalur aktif, frontmatter skill dicabut
│   └── mastery-{golang,rust,laravel,nestjs,skills}/
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
├── skills/                     # Sembilan skill aktif.
│   ├── meta-panel/             # ★ GERBANG UTAMA — klasifikasi + Panel 10 lensa
│   │   └── references/         # Peta keterkaitan, satu berkas per lensa, pohon keputusan stack
│   ├── meta-debug/             # Debugging sistematis — akar masalah sebelum perbaikan
│   ├── meta-brainstorm/        # Brainstorming umum & teknikal + Gerbang Bukti
│   ├── meta-git/               # Git Flow, Conventional Commits, atribusi
│   ├── meta-api-docs/          # Dokumentasi API dari eksekusi nyata
│   ├── meta-prd/               # Dokumen HTML (PRD, RFC, ADR, laporan) dengan satu gaya
│   ├── meta-handover/          # Serah terima sesi — bawaan HTML lewat meta-prd
│   ├── meta-swipe/             # Mencoba aplikasi di browser per peran, dengan daftar periksa
│   └── meta-board/             # Papan tiket dan catatan keputusan lintas proyek
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

Leburan lima role v1 (`architect`, `swe`, `devops`, `dba`, `qa`) menjadi **sepuluh lensa yang menyala bersamaan** pada setiap request, masing-masing dengan berkas acuan setara orang senior di peran itu:

| # | Lensa | Menjawab |
| :-: | :--- | :--- |
| 1 | 📋 Manager / Product | Masalah nyatanya apa? Solusi titipan atau bukan? Non-goals? |
| 2 | 💰 Cost / FinOps | Ongkos implementasi + maintenance sepadan? |
| 3 | 🎨 UX / DX | Breaking change? Edge state (kosong/loading/gagal)? |
| 4 | 🛡️ Security | Sapuan STRIDE — permukaan serangan baru? |
| 5 | ⚙️ Ops / SRE | Bagaimana ini mati? Blast radius, observability, rollback |
| 6 | 🗄️ Data | (kondisional) Skema reversibel? Lock, index, pertumbuhan volume? |
| 7 | 🧪 QA / Edge-case | Bagaimana saya merusaknya? Race, double-submit, input aneh |
| 8 | 🧱 Backend / Arsitektur | Di mana kode ini tinggal menurut pola repo? Pintu masuk lain? Keadaan setengah jadi? |
| 9 | ⚖️ Legal & kepatuhan | (bersyarat) Data pribadi, lisensi, kontrak — bertanya, tidak memutuskan |
| 10 | 📐 Domain / aturan bisnis | Aturan mana yang disentuh, dari mana asalnya, bertabrakan dengan yang mana? |

Tambahan di luar gerbang: tiap panel menutup dengan **kriteria selesai** yang bisa diperiksa tanpa membaca kode; proyek baru punya alurnya sendiri (`references/proyek-baru.md`, termasuk tiga arah desain yang bisa dibuka); dan swarm tiga agen hanya jalan bila user memintanya.

Output **proporsional**: request kecil dapat panel ringkas beberapa baris; request besar dapat tabel penuh + rekomendasi + alternatif ditolak + **pembatal** + utang bukti. Yang wajib adalah *menyapu* semua lensa — yang dilaporkan hanya lensa yang menemukan sesuatu.

`references/decision-tree.md` — pohon keputusan stack & arsitektur (compute model, persistence, async, API, auth, observability, deployment, scaling, security, testing). Berstatus **rujukan**, bukan gerbang wajib.

Kedalamannya ditentukan **gerbang klasifikasi** (§0b), bukan perasaan: **Sondir** (kelayakan, keluarannya jawaban bukan kode) · **Terbatas** (panel ringkas) · **Arsitektural** (tabel penuh + alternatif + pembatal) · **Trivial** (sapu kilat). Kelas tidak boleh diturunkan di tengah jalan — kompleksitas tersembunyi hanya boleh menaikkannya.

### `meta-debug`

Debugging sistematis. Hukum tunggal: **DILARANG MEMPERBAIKI SEBELUM AKAR MASALAH DITEMUKAN.**

Empat fase — Investigasi Akar → **Analisis Pola** (cari kode serupa yang jalan, bandingkan tuntas, catat setiap beda) → Hipotesis tertulis → Implementasi. Gagal 3× bukan tanda kurang teliti melainkan tanda asumsi arsitekturalnya keliru: pertanyaannya berganti jenis, bukan diulang lebih keras.

### `meta-brainstorm`

Protokol eksplorasi ide untuk ranah **umum** (bisnis, karir, keuangan, hukum, pendidikan) maupun **teknikal**. Mode umum adalah mode utama — di sana tidak ada compiler yang menegur klaim salah.

- **Gerbang Bukti:** 7 hukum anti-fabrikasi. Sumber yang tidak dibuka di sesi ini DILARANG disebut.
- **Fase 0:** ekstrak klaim penentu → sumber terdekat → WebSearch (*menemukan*) → WebFetch (*membaca*) → **pencarian pembantah wajib** → Evidence Ledger — semuanya sebelum opsi pertama disajikan.
- **Hubungan dengan `AGENTS.md` §3:** §3 adalah SSOT definisi label; §0 skill ini menambahkan Evidence Ledger di atasnya. Bila keduanya tampak berbeda, yang lebih ketat menang.

- **Mode 3, ngobrol per peran:** satu peran tim pada satu waktu sebagai teman berpikir. Sepuluh peran memakai berkas lensa panel; dua peran pembuat punya berkasnya sendiri di `references/`: **desainer** (arah tampilan, susunan halaman, teks antarmuka) dan **perencana** (memotong pekerjaan, menaksir, mengurutkan, penawaran, laporan kemajuan).

### `meta-git`

Git Flow (`feature/*`, `fix/*`, `chore/*`), Conventional Commits, atomic commit per unit logis, Stacked PRs & micro-branching per batch, dan trailer atribusi:

```text
Co-authored-by: aetheris <agents.aetheris@gmail.com>
```

### `meta-api-docs`

Dokumentasi API (collection Postman, saved response, deskripsi endpoint). Contoh response dibuat dari eksekusi nyata, dan deskripsi diverifikasi ke kode.

### `meta-prd`

Satu skill untuk semua dokumen yang dibaca orang: PRD, RFC, ADR, rencana, laporan, runbook, panduan pakai, catatan rilis, penawaran, dan laporan kemajuan. Yang diikat **gayanya**, bukan susunannya.

- **Galeri sebagai sumber tunggal:** `assets/component-gallery.html` memuat seluruh gaya dan skrip; kerangka dan semua dokumen menyalin darinya.
- **`scripts/doc-tools.mjs`:** `new` membuat kerangka, `check` menolak dokumen yang gayanya berubah atau masih ber-placeholder, `sync` memperbarui dokumen lama.
- **`scripts/doc-render.mjs`:** merender terang dan gelap di dua lebar layar. Selesai berarti `check` lulus **dan** gambarnya dibaca.
- **Hubungan dengan panel:** dokumen tidak menggantikan panel. Panel menyarankan jenis dokumen bila request-nya besar.

### `meta-handover`

Dokumen serah terima di akhir sesi panjang. Bawaan HTML lewat `doc-tools` milik `meta-prd`; Markdown hanya bila diminta atau pembacanya agen lain. Langkah 0 mewajibkan membuka transcript sesi dan mencocokkannya dengan keadaan repo.

### `meta-swipe`

Mencoba aplikasi web lewat browser sebagai tiap peran, **hanya bila diminta**.

- **Daftar periksa di repo proyek** (`.swipe/checklist.json`) dan satu berkas hasil per swipe, supaya swipe berikutnya mengulang langkah yang sama dan menunjukkan apa yang berubah.
- **`scripts/swipe-tools.mjs`:** `init`, `validate`, `plan`, `diff`, `report`. Laporan HTML dibangun dari data, bukan ditulis tangan.
- **Pagar:** hanya alamat lokal atau dev yang disebut user, password tidak diketik maupun ditulis, aksi yang tidak bisa dibalik ditanyakan dulu, data buatan swipe tidak dibersihkan otomatis.

### `meta-board`

Satu papan tiket untuk semua proyek, supaya pekerjaan yang disetujui dan keputusan yang diambil tidak hilang bersama percakapannya.

- **Tiket satu-satunya wadah:** ringkasan, keputusan (dengan kalimat user apa adanya dan tanda siapa yang memutuskan), kriteria selesai, yang sengaja tidak dikerjakan, dugaan yang belum dicek, sumber, tautan, dan riwayat.
- **Data di luar semua repo** (`~/.aetheris/board/board.db`, SQLite bawaan Node); halaman papan dan halaman per tiket dibangun dari data itu dengan gaya `meta-prd`.
- **`scripts/board-tools.mjs`** memaksa aturannya: tiket terikat ke branch-nya, mulai kerja ditolak di branch lain, `review` butuh commit yang benar-benar ada di branch itu, `done` butuh kalimat penerimaan user. Agen hanya membaca lewat `list`, `search`, dan `show`, jadi ongkos bacanya tidak naik dengan jumlah tiket.
- **Penjaga commit (opsional per proyek):** hook lokal yang menolak commit di branch kerja tanpa tiket yang sedang dikerjakan.
- **Uji:** `board-tools.test.mjs`, `board-tools.git.test.mjs`, dan `board-tools.browser-test.mjs` (butuh Edge atau Chrome).

---

## 📦 `archive/` — korpus pensiunan

`mastery-{golang,rust,laravel,nestjs,skills}` — **720 berkas, 8.83 MB** (terukur `Get-ChildItem`). Dipensiunkan **2026-08-18**.

**Apa artinya pensiun di sini:**

- Dipindah keluar dari `skills/`, dan **frontmatter `name:`/`description:`-nya dicabut** — jadi tidak lagi ditawarkan sebagai skill oleh mesin discovery mana pun. Ini alasan utama pemindahannya.
- Isinya **tetap utuh** dan boleh dikutip sebagai `[fakta:path]`. Header tiap `SKILL.md` menyimpan cakupan aslinya.
- **Tidak wajib dibaca** sebelum menulis kode. Kewajiban verifikasi menunjuk sumber nyata — source library terpasang, dokumentasi resmi, kode proyek itu sendiri (`AGENTS.md` §0.1).

**Kenapa dipensiunkan, bukan dihapus:** `LEARNED.md` mencatat bahwa volume referensi bukan nilai — struktur dan routing yang menentukan; korpus internal juga bisa basi tanpa ada yang tahu, dan audit pernah menemukan kekeliruan faktual di dalamnya. Tapi isinya mahal dan masih benar sebagian besar, jadi ia dicabut dari jalur wajib, bukan dibuang.

**Kalau suatu saat mau diaktifkan lagi:** kembalikan frontmatter di `SKILL.md`-nya dan pindahkan foldernya ke `skills/`. Riwayat lengkapnya ada di git.

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
Status terakhir diverifikasi **2026-08-18** lewat eksekusi langsung `scripts/audit_references.ps1` (bundle=2, berkas=2, exit 0).

| Properti | Status | Cara membuktikan |
| :--- | :--- | :--- |
| Rantai kerja 6 tahap identik di kedua dokumen | ✅ utuh | `scripts/audit_references.ps1` |
| Gerbang "Gasskan" hadir di seluruh dokumen rantai | ✅ | `scripts/audit_references.ps1` |
| Rujukan silang antar-dokumen rantai resolve | ✅ | `scripts/audit_references.ps1` |
| Berkas referensi **jalur aktif** lolos gate FATAL | ✅ 2/2 bundle | `scripts/audit_references.ps1` |
| Berkas referensi **arsip** lolos gate FATAL | ⚠️ **92 pelanggaran belum diperbaiki** | `scripts/audit_references.ps1 -Root archive` |
| Nol kredensial hardcode ter-commit | ✅ | `git log -S` + `scripts/quality_gate.ps1` |
| Conventional Commits + Co-author trailer | ✅ | `git log --format=%s` |

> **Baca dua baris FATAL itu bersamaan.** Audit rutin kini exit 0 — tapi **bukan karena 92 pelanggarannya diperbaiki**, melainkan karena korpusnya pindah ke `archive/` dan keluar dari cakupan default `-Root skills`. Utangnya masih ada persis seperti sebelumnya (`mastery-rust` 88, `mastery-laravel` 4: berkas di bawah 130 baris + satu berkas UTF-16LE), dan bisa dilihat kapan saja lewat `-Root archive`.
>
> Angka hijau yang lahir dari mempersempit cakupan adalah jenis kebohongan yang paling mudah dipercaya. Karena itu barisnya dipisah, bukan dihapus.

> **DILARANG menulis klaim "0 Broken Paths" atau sejenisnya tanpa perintah yang membuktikannya.**
> Garansi yang tidak bisa dijalankan hanyalah dekorasi, dan lebih berbahaya daripada tidak ada.

---
*Dikelola dan dirawat oleh AETHERIS Autonomous Engineering Team.*
