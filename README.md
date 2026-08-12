# ⚡ AETHERIS — Autonomous Software Engineering Engine

> **SSOT (Single Source of Truth) Architecture & Knowledge Engine**  
> Repositori konfigurasi sentral untuk mengontrol seluruh kapabilitas, aturan arsitektur, protokol rekayasa perangkat lunak (*Software Engineering*), memori persisten, integrasi multi-tool, dan *domain mastery* standar Principal Engineer (L7/L8).

---

## 📑 Daftar Isi
1. [Arsitektur & Peta Sistem](#-arsitektur--peta-sistem)
2. [Konstitusi & Aturan Inti (`AGENTS.md`)](#-konstitusi--aturan-inti-agentsmd)
   - [0. Gerbang Mutlak](#0-gerbang-mutlak)
   - [1. Glosarium & Terminologi Baku](#1-glosarium--terminologi-baku)
   - [2. Taksonomi 12 Jalur Routing Task](#2-taksonomi-12-jalur-routing-task)
   - [3. Protokol Pra-Koding & Forensic Baseline](#3-protokol-pra-koding--forensic-baseline)
   - [4. Prosedur Challenger (Anti-Yes-Man)](#4-prosedur-challenger-anti-yes-man)
   - [5. Standar Artefak & Dokumentasi Teknis](#5-standar-artefak--dokumentasi-teknis)
   - [6. Quality Gate Ratchet & Patch Receipt](#6-quality-gate-ratchet--patch-receipt)
   - [7. Swarm Subagent & DAG Batch Writing](#7-swarm-subagent--dag-batch-writing)
   - [8. Standar Komunikasi & Bahasa](#8-standar-komunikasi--bahasa)
3. [Skill Bundles & Domain Mastery (`skills/`)](#-skill-bundles--domain-mastery-skills)
   - [`mastery-golang`](#1-mastery-golang)
   - [`mastery-rust`](#2-mastery-rust)
   - [`mastery-laravel`](#3-mastery-laravel)
   - [`mastery-nestjs`](#4-mastery-nestjs)
   - [`meta-decision`](#5-meta-decision)
   - [`meta-templates`](#6-meta-templates)
   - [`meta-git`](#7-meta-git)
   - [`meta-brainstorm`](#8-meta-brainstorm)
   - [`mastery-skills`](#9-mastery-skills)
4. [Infrastruktur Otomasi & Hooks (`scripts/` & `hooks.json`)](#-infrastruktur-otomasi--hooks-scripts--hooksjson)
5. [Memori Persisten & Living Brain (`shared/`)](#-memori-persisten--living-brain-shared)
6. [Integrasi Multi-Tool & Claude Code Parity](#-integrasi-multi-tool--claude-code-parity)
7. [Ekstensi MCP & Plugins (`plugins/` & `mcp_config.json`)](#-ekstensi-mcp--plugins-plugins--mcp_configjson)

---

## 🗺️ Arsitektur & Peta Sistem

```
~/.gemini/config/
├── AGENTS.md                   # SSOT Konstitusi Utama (Aturan, Routing, & Quality Gates)
├── README.md                   # Dokumentasi Master Seluruh Ekosistem
├── config.json                 # Konfigurasi Global Antigravity
├── hooks.json                  # Lifecycle Hooks (Quality Gate Otomatis saat Stop)
├── mcp_config.json             # Integrasi MCP Servers (StitchMCP, Chrome DevTools)
│
├── docs/
│   └── rfc/                    # RFC Architecture Catalog & dokumen perancangan/audit
│
├── projects/                   # State per-proyek Antigravity (ter-gitignore, tidak diversikan)
│
├── scripts/
│   ├── quality_gate.ps1        # Gerbang mutu KODE PROYEK (ratchet, placeholder, secret, linter, test)
│   ├── audit_references.ps1    # Gerbang mutu BERKAS REFERENSI skill bundle (kepadatan, encoding, klaim)
│   ├── stop_gate_antigravity.ps1 # Wrapper Stop hook untuk Antigravity (hooks.json)
│   └── stop_gate_claude.ps1    # Wrapper Stop hook untuk Claude Code (~/.claude/settings.json)
│
├── shared/
│   ├── LEARNED.md              # Living Brain SSOT (Pelajaran, Bug Triggers, Runtime Truths)
│   └── tool-claude-code.md     # Jembatan Protokol Sinkronisasi Claude Code (~/.claude/CLAUDE.md)
│
├── skills/                     # Skill Bundles Berisi SOP & Ratusan Referensi Produksi
│   ├── mastery-golang/         # Go High-Perf, Concurrency, SQLC, gRPC (30 domain, 221 berkas)
│   ├── mastery-laravel/        # Laravel Octane, Reverb, Horizon, Multi-tenant (27 domain, 136 berkas)
│   ├── mastery-nestjs/         # NestJS Hexagonal, Fastify, Microservices (36 domain, 139 berkas)
│   ├── mastery-rust/           # Rust Async Tokio, Axum, Zero-Cost, Lock-free (34 domain, 195 berkas)
│   ├── mastery-skills/         # Meta-Skill Pembuatan & Audit Skill Baru
│   ├── meta-brainstorm/        # Brainstorming Umum & Teknikal + Gerbang Bukti anti-sitasi fiktif
│   ├── meta-decision/          # Matriks Pemilihan Bahasa & Arsitektur Sistem
│   ├── meta-git/               # Git Flow, Conventional Commits, Dual-Avatar Attribution
│   ├── meta-templates/         # Master Template RFC, RCA, System Map, & Patch Receipts
│   ├── role-architect/         # Mode L8 Principal PM/Architect (SOP Pra-Eksekusi / RFC)
│   ├── role-dba/               # Mode L8 Principal DBA (Skema DB, Optimasi, Migrasi)
│   ├── role-devops/            # Mode L8 Principal DevOps (Infrastruktur, Cloud, CI/CD)
│   └── role-swe/               # Mode L8 Principal SWE (SOP Pasca-Eksekusi / Batch Writing)
│
└── plugins/                    # Plugin PIHAK KETIGA (Apache-2.0) - ter-gitignore, tidak ikut ter-clone.
                                # Diaudit 2026-08-07: nol kredensial, bukan tulisan sendiri.
    ├── chrome-devtools-plugin/ # E2E Browser Testing & Lighthouse Audits
    ├── google-antigravity-sdk/ # SDK Internal & Slash Commands (/goal, /schedule, dll)
    └── modern-web-guidance-plugin/ # Standar Modern Web, CSS Vanilla, & Rich Aesthetics
```

---

## 📜 Konstitusi & Aturan Inti (`AGENTS.md`)

`AGENTS.md` adalah **Sumber Tunggal Kebenaran (SSOT)**. Semua aturan di bawah ini mengikat agen secara mutlak tanpa kompromi.

### 0. Gerbang Mutlak
Enam larangan mutlak yang tidak boleh dilanggar dalam situasi apa pun:
1. **DILARANG mengarang dari hafalan LLM:** Wajib membaca referensi lokal domain sebelum membuat keputusan arsitektur.
2. **DILARANG lapor selesai sebelum test/linter dijalankan:** Hasil eksekusi wajib ditampilkan faktual apa adanya.
3. **DILARANG meninggalkan `// TODO`, kode setengah matang, atau credential hardcode.**
4. **DILARANG untyped bypass:** Menolak `any` (TS), unchecked `unwrap()` (Rust), atau raw `interface{}` tanpa assertion (Go).
5. **DILARANG mulai RFC-Path sebelum user mengetik "Gasskan".**
6. **DILARANG klaim bugfix tanpa Proof-of-Defect (TDD Harness):** Wajib membuat test yang membuktikan kegagalan (MERAH) sebelum memperbaiki kode hingga lulus (HIJAU).

### 1. Glosarium & Terminologi Baku
* **Gasskan:** Kata persetujuan eksplisit dari user untuk memulai eksekusi RFC-Path.
* **All-in-One RFC (`docs/rfc/YYYYMMDD-<fitur>.md`):** Dokumen perencanaan terpadu yang menggabungkan PRD, Desain Teknis, STRIDE Threat Model, dan DAG Batch Tasks.
* **RFC Master Catalog (`docs/rfc/README.md`):** Indeks pelacak status seluruh RFC repositori.
* **system_map.md:** Peta topologi arsitektur hidup di root proyek.
* **Forensic Blast Radius Matrix:** Matriks audit dampak risiko downstream sebelum menyentuh kode warisan (*Brownfield*).
* **RCA 5-Whys (`docs/rca/YYYYMMDD-<insiden>.md`):** Dokumen post-mortem tanpa menyalahkan (*Blameless*) saat terjadi insiden kritis.
* **Self-Healing Circuit Breaker:** Sistem eskalasi putus arus berjenjang (Maks 5 ronde). Ronde 1-3 untuk main agent. Ronde 4-5 wajib riset mendalam. Lebih dari 5x gagal memicu STOP mutlak dan mewajibkan penulisan rekam jejak di `docs/rfc/progress.md`.
* **Iron Law of Deletion:** Jika kode produksi ditulis sebelum *test* TDD-nya ada, kode tersebut WAJIB DIHAPUS TOTAL tanpa sisa.
* **Revert-to-Fail Protocol:** Verifikasi TDD 4 langkah untuk mencegah false-positive: Tulis Test $\rightarrow$ Fix (Hijau) $\rightarrow$ Revert Fix (Wajib Merah) $\rightarrow$ Restore Fix (Hijau).
* **Side Note:** Catatan 1–2 baris di akhir respon mengenai bad practice di luar scope yang tidak boleh disentuh sepihak.

### 2. Taksonomi 12 Jalur Routing Task
Setiap perintah user dicocokkan secara deterministik dari atas ke bawah:
1. **Proyek Baru Kecil (<10 files, SQLite/JSON, CLI/Script):** Eksekusi langsung dengan `role-swe` tanpa RFC & Day-0 Quintet.
2. **Proyek Baru Greenfield (Penuh):** Aktifkan `role-architect` $\rightarrow$ Gerbang Klarifikasi $\rightarrow$ Master Decision Tree $\rightarrow$ Day-0 Quintet $\rightarrow$ All-in-One RFC $\rightarrow$ Tunggu "Gasskan".
3. **Edit $\le 3$ Berkas / Bugfix Minor:** Proof-of-Defect TDD $\rightarrow$ Eksekusi bedah presisi (`role-swe`). DILARANG bikin RFC.
4. **Tambah Fitur / Refactor Brownfield / Edit $>3$ Berkas:** Aktifkan `role-architect` $\rightarrow$ Baseline Regresi $\rightarrow$ Forensic Blast Radius Matrix $\rightarrow$ Sajikan $\ge 3$ Opsi Netral $\rightarrow$ All-in-One RFC $\rightarrow$ Tunggu "Gasskan".
5. **Infrastruktur DevOps & Cloud:** Aktifkan `role-devops` $\rightarrow$ Rancang topologi infrastruktur $\rightarrow$ Tulis konfigurasi IaC (Terraform/K8s/CI).
6. **Skema DB Masif & Data Architect:** Aktifkan `role-dba` $\rightarrow$ Optimasi Execution Plan, migrasi besar, sharding $\rightarrow$ Susun skrip migrasi/optimasi.
7. **In-Flight Fix (Bugfix melar):** Perbaikan bug melebihi 3 file pada plan yang disetujui dilanjutkan dengan `role-swe` tanpa RFC baru.
8. **Emergency Pause:** Blocker arsitektural kritis di tengah jalan memicu pause seketika $\rightarrow$ Susun RCA 5-Whys $\rightarrow$ Tunggu arahan user.
9. **Brainstorming Arsitektur / Tech-Stack:** Picu skill `meta-brainstorm` (Mode 2) dengan `role-architect` $\rightarrow$ Gerbang Bukti $\rightarrow$ Catat di `LEARNED.md` $\rightarrow$ DILARANG nulis kode sebelum "Gasskan".
10. **Brainstorming Umum / Non-Teknis:** Picu skill `meta-brainstorm` (Mode 1) $\rightarrow$ Gerbang Bukti $\rightarrow$ Evidence Ledger sebelum opsi disajikan.
11. **Technical Q&A:** Pertanyaan teknis berjawab tunggal dijawab dingin & faktual tanpa mengubah filesystem. Begitu minta ide, naik ke brainstorming.
12. **Obrolan Santai:** Sapaan dijawab langsung tanpa memaksakan gerbang pengujian mutu.

### 3. Protokol Pra-Koding & Forensic Baseline
* Wajib membaca `shared/LEARNED.md` sebelum interaksi koding.
* Menjalankan **Baseline Regresi** pada proyek Brownfield untuk mencatat status test eksisting sebelum mengubah kode.
* **Progressive Disclosure:** Membaca antarmuka simbol dengan range kecil (50–100 baris) sebelum membedah berkas besar (>500 baris) guna menghemat context window.
* **Monorepo Sub-Root Resolution:** Deteksi otomatis lokasi subfolder manifest (`apps/api`, `services/auth`) untuk eksekusi linter & test runner yang presisi.

### 4. Prosedur Challenger (Anti-Yes-Man)
* Menolak bersikap "yes-man" terhadap usulan user yang berisiko (OWASP, security, performance bottleneck).
* Setiap pengusulan arsitektur wajib menyertakan **$\ge 3$ Kelebihan DAN $\ge 3$ Kekurangan**.
* Pada RFC-Path wajib menyajikan **$\ge 3$ Opsi Netral** tanpa memaksakan label `(Recommended)`.
* **Emotional/Tone Gate:** DILARANG keras memuji/berbasa-basi ("You're right!") atau melakukan selebrasi prematur ("Selesai!", "Berhasil!") tanpa bukti eksekusi langsung. Respon harus dingin, faktual, dan murni teknis.

### 5. Standar Artefak & Dokumentasi Teknis
Seluruh dokumen teknis wajib mengikuti standar arsitektur L7/L8 yang didefinisikan di `skills/meta-templates/SKILL.md`.

### 6. Quality Gate Ratchet & Patch Receipt
* **Ratchet Mechanism:** Hanya memblokir baris baru yang diubah agen; baris legacy dilaporkan sebagai `~ PRAADA` (Side Note).
* **Non-Tautological Assertions:** Melarang test kosong (`assert != nil`), wajib memvalidasi mutasi state nyata.
* **Regression Banking:** Setiap bugfix wajib meninggalkan minimal 1 regression test permanen di suite.
* **Patch Receipt:** Laporan akhir wajib memuat Git Commit SHA, Diff Delta (+/-), Exit Code, dan output konsol asli.
* **Self-Review Checklist Obligatory:**
  ```text
  N+1 query: <temuan / nihil>   OWASP/STRIDE: <...>   race condition: <...>
  input validation: <...>       memory leak: <...>    goroutine/promise leak: <...>
  ```

### 7. Swarm Subagent & DAG Batch Writing
* **Zero-Trust Delegation:** Main Agent DILARANG memercayai laporan klaim "sukses" sub-agen begitu saja. Ia WAJIB melakukan audit independen (via `git diff` atau eksekusi test).
* **SDO & File-Path Handoffs:** DILARANG melampirkan teks *diff* panjang atau instruksi utuh langsung di dalam *prompt* sub-agen. Tuliskan konteks pada berkas terisolasi (mis. `task-brief.md`), lalu kirimkan HANYA *path* berkasnya ke sub-agen.
* Subagent berjalan paralel untuk riset $>3$ domain (Tier Model: `pro`).
* **Subagent Read-Only Constraint:** Subagent DILARANG menulis file atau memanipulasi Git history.
* **DAG Task Dependencies:** Batch tugas di RFC diorganisasi dengan dependensi eksplisit (`DependsOn: [Batch 1]`).
* **Contract-First & Schema Locking:** Mengunci DTO, interface, dan migration skema di Batch 1 sebelum menulis business logic.
* **Batch Writing Limit:** Maksimal penulisan 3–4 file per turn diikuti pengujian atomik dan commit sebelum lanjut ke batch berikutnya.

---

## 🛠️ Skill Bundles & Domain Mastery (`skills/`)

Ekosistem *skills* dikategorikan dalam tiga taksonomi prefiks utama untuk mendikte peran dan *mindset* agen:
* **`mastery-*`**: Kumpulan pengetahuan teknis *hard-skills* mendalam spesifik-domain (contoh: Golang, Rust, Laravel). Berisi kumpulan ratusan *best practices* tingkat Principal Engineer L8 untuk arsitektur produksi berskala besar.
* **`meta-*`**: Kemampuan tingkat tinggi yang melampaui *coding* murni. Membimbing AI dalam mengambil keputusan asitektur, *brainstorming* kritis (gerbang bukti), menggunakan protokol Git tingkat lanjut, hingga memformat dokumen (RFC/RCA) dan membuat *skill* baru.
* **`role-*`**: Persona eksekusi berskala (SOP) yang membungkus agen untuk siklus hidup tertentu. `role-architect` membimbing perencanaan prafase. `role-swe` membimbing pascafase (*Batch Writing*). `role-devops` dan `role-dba` untuk operasi infrastruktur dan manajemen *state* khusus.

### 1. `mastery-golang`
Panduan rekayasa backend Golang tingkat tinggi mencakup 30 domain referensi produksi:
* **Concurrency & Runtime:** Goroutine lifecycle, channel multiplexing, lock-free atomics, runtime memory allocator, sync.Pool.
* **Database & Storage:** SQLC type-safe query generation, pgx connection pooling, Transactional Outbox, dynamic sharding.
* **Transport & Microservices:** gRPC streaming, Protobuf v3, Chi routing, HTTP/2 & HTTP/3 tuning, mTLS security.
* **Observability & Resilience:** `slog` structured logging, OpenTelemetry distributed tracing, RED metrics, uber-go/ratelimit.
* **Advanced Systems:** Linux eBPF telemetry, Kubernetes custom controllers/operators, SIMD vectorization, zero-allocation serialization.

### 2. `mastery-rust`
Panduan rekayasa sistem Rust performa tinggi mencakup 34 domain referensi produksi:
* **Memory Safety & Concurrency:** Lifetime annotations, Borrow checker patterns, Tokio multi-threaded async runtime, crossbeam lock-free queues.
* **Microservices & Web:** Axum web framework, Tower middleware stack, SQLx compile-time checked queries, Tonic gRPC.
* **Low-Level & Performance:** Unsafe Rust containment, FFI C-ABI integration, Custom Allocators (jemalloc/mimalloc), SIMD auto-vectorization, Miri undefined behavior validation.
* **Client & Embedded:** Tauri desktop engine, Bevy game ECS, WebAssembly (WASM) host bindings, eBPF Aya framework.

### 3. `mastery-laravel`
Panduan arsitektur modern enterprise Laravel mencakup 27 domain referensi produksi:
* **High-Performance Engines:** Laravel Octane (Swoole/FrankenPHP), Swoole State Resetters, Reverb WebSockets, Horizon queue orchestration.
* **Database & Scale:** Eloquent optimization, N+1 query prevention, Multi-Tenancy Row Level Security (RLS), Read-Replica split, Redis token bucket.
* **Fintech & Security:** Cashier subscription billing, Idempotent webhook handling, Zero-Trust Sanctum/Passport auth, STRIDE input sanitation.
* **Frontend & Reporting:** Livewire v3 / Inertia.js integration, Dompdf precision layout rendering engine truths.

### 4. `mastery-nestjs`
Panduan arsitektur Enterprise TypeScript NestJS mencakup 36 domain referensi produksi:
* **Core Architecture:** Fastify engine adapter, Inversion of Control (IoC) container tuning, Hexagonal Ports & Adapters architecture.
* **Data Layer:** Prisma & Drizzle ORM performance, Connection pool isolation, Distributed 2PC transactions.
* **Distributed Services:** Apollo GraphQL Federation v2, Kafka & NATS message transports, BullMQ distributed background workers.
* **Security & AI:** Multi-Tenancy RLS guards, pgvector LangChain integration, OWASP strict validation pipes.

### 5. `meta-decision`
Pohon keputusan arsitektur sistem mutlak untuk memilih bahasa dan framework berdasarkan profil throughput, latency, konsistensi data, kecepatan rilis, dan kompleksitas domain.

### 6. `meta-templates`
Koleksi template baku L7/L8:
* `docs/rfc/YYYYMMDD-<fitur>.md`: Template All-in-One RFC lengkap dengan STRIDE Threat Model & DAG Batch Tasks.
* `docs/rfc/README.md`: Master Catalog pelacak status seluruh RFC di repositori.
* `docs/rca/YYYYMMDD-<insiden>.md`: Post-Mortem 5-Whys Blameless Root Cause Analysis.
* `system_map.md`: Living Architecture Map & Topologi SSOT.
* `Laporan Hasil Test & Patch Receipt`: Format bukti verifikasi SOTA dengan Proof-of-Defect TDD Harness.
* `tests/regression/`: Spesifikasi format Failure Banking Artifact untuk mengunci kekebalan terhadap bug masa lalu.

### 7. `meta-git`
* Protokol Git Flow (`feature/*`, `fix/*`, `chore/*`).
* Conventional Commits (`feat:`, `fix:`, `refactor:`, `chore:`).
* **Stacked PRs & Micro-Branching (Devin Protocol):** Branching terisolasi per batch RFC untuk integrasi bertahap yang aman.
* **Dual-Avatar Attribution Trailer:**
  ```text
  Co-authored-by: aetheris <agents.aetheris@gmail.com>
  ```

### 8. `meta-brainstorm`
Protokol eksplorasi ide terstruktur untuk ranah **umum** (bisnis, karir, keuangan, hukum, pendidikan, kehidupan) maupun **Teknikal/Arsitektural** (Stack Selection, Distributed Trade-offs), dengan pencatatan otomatis ke `shared/LEARNED.md`.

* **Gerbang Bukti (Evidence Gate):** 7 hukum anti-fabrikasi — DILARANG menyebut sumber yang tidak dibuka di sesi berjalan, angka tanpa sumber WAJIB diturunkan jadi kualitatif, dan atribusi ke tokoh/pasal/harga WAJIB berdokumen.
* **Fase 0 — Riset Dulu, Bicara Kemudian:** ekstrak klaim penentu → sumber terdekat (data milik user / referensi lokal) → WebSearch untuk *menemukan* → WebFetch untuk *membaca* → **pencarian pembantah wajib** → Evidence Ledger, semuanya sebelum opsi pertama disajikan.
* **Evidence Ledger + 4 label epistemik:** `[fakta:E#]` · `[inferensi]` · `[spekulasi]` · `[memori-model]`, lengkap dengan status `TERVERIFIKASI / BANTAHAN / SEBAGIAN / GAGAL / TIDAK DICARI` dan penanda `[BASI]`.
* **`references/evidence-protocol.md`:** tangga 5 tier sumber (umum & teknis), kerajinan query pembantah, protokol angka, penanganan fetch gagal, dan checklist deteksi halusinasi diri.

### 9. `mastery-skills`
Meta-skill untuk merancang, mengaudit struktur, dan memastikan kualitas skill bundles baru di ekosistem Antigravity.

---

## ⚡ Infrastruktur Otomasi & Hooks (`scripts/` & `hooks.json`)

Sistem pengawasan kualitas otomatis dijalankan setiap kali agen menyelesaikan giliran (*Stop Event*):

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

### Mekanisme Pemeriksaan `scripts/quality_gate.ps1`:
1. **Gate 1 (Placeholder Blocker):** Memindai dan memblokir keberadaan `// TODO`, `FIXME`, `implement later`, `your code here`.
2. **Gate 2 (Secret Hardcode Blocker):** Mendeteksi private keys, API keys (`sk_live_...`, tokens), dan DB passwords.
3. **Gate 2b (Untyped Bypass Blocker):** Memblokir `any` (TS), raw `unwrap()` (Rust), dan raw `interface{}` (Go) pada baris baru.
4. **Gate 2c (Empty Test Blocker):** Mendeteksi fungsi test kosong atau closures tanpa asersi (Meta TestGen-LLM standard).
5. **Gate 4 (Phantom Test Prevention):** Memastikan perubahan pada berkas sumber diiringi eksekusi test runner riil.
6. **Monorepo Sub-Root Matcher:** Otomatis mendeteksi keberadaan manifest di subfolder (`apps/`, `services/`) untuk memicu test runner yang tepat.

---

## 🧠 Memori Persisten & Living Brain (`shared/`)

### `shared/LEARNED.md`
Memori jangka panjang yang menyimpan pengetahuan faktual (*ground truths*) yang dipelajari dari insiden dan percobaan sebelumnya:
* **Architecture Governance Truths:** Efektivitas RFC Master Index, STRIDE Threat Modeling, dan Blast Radius Analysis.
* **SOTA Agentic Truths:** Proof-of-Defect TDD Harness, Self-Healing Circuit Breaker, dan Contract-First Locking.
* **Framework & Engine Quirks:** Solusi layout Dompdf (pengukuran content stream, penanganan `@page`), perilaku CodeIgniter form validation, dan aturan 100% Bahasa Inggris untuk identifier kode & log error.

---

## 🔄 Integrasi Multi-Tool & Claude Code Parity

Repositori ini beroperasi sebagai **SSOT Multi-Platform**:
* **Claude Code Integration:** Melalui file `~/.claude/CLAUDE.md`, Claude Code secara langsung mengimpor aturan dari `~/.gemini/config/AGENTS.md`.
* Satu kali pembaruan pada `AGENTS.md` otomatis memberlakukan aturan yang identik pada Google Antigravity dan Claude Code tanpa perlu sinkronisasi manual.

---

## 🔌 Ekstensi MCP & Plugins (`plugins/` & `mcp_config.json`)

| Server / Plugin | Tipe | Peran & Kemampuan |
| :--- | :--- | :--- |
| **StitchMCP** | MCP Remote | Integrasi design systems, sinkronisasi wireframe visual & mockup UI/UX Google Stitch. |
| **Chrome DevTools MCP** | MCP Local | Otomasi browser E2E, snapshot DOM, inspeksi console logs, Lighthouse audit, network tracing. |
| **Google Antigravity SDK** | Plugin | Pengelolaan siklus hidup agen, subagents, sidecars, dan slash commands (`/goal`, `/schedule`, `/grill-me`, `/learn`). |
| **Modern Web Guidance** | Plugin | Panduan implementasi antarmuka modern, CSS tokens, responsive layouts, dan estetika premium kelas dunia. |

---

## 🛡️ Jaminan Integritas Sistem
Seluruh komponen dalam ekosistem ini diaudit secara berkala dengan garansi:
Klaim di bawah **terukur, bukan janji** — tiap baris menyebut perintah yang membuktikannya.
Status terakhir diverifikasi **2026-08-07** (lihat `docs/rfc/20260807-audit-integritas-config.md`).

| Properti | Status | Cara membuktikan |
| :--- | :--- | :--- |
| Nol domain referensi tak terjangkau dari `SKILL.md` | ✅ 4/4 bundle | §5.1 dokumen RFC |
| Angka domain & berkas di `SKILL.md` cocok dengan disk | ✅ 4/4 bundle | `scripts/audit_references.ps1` |
| Nol kredensial hardcode ter-commit | ✅ | `git log -S` + `scripts/quality_gate.ps1` |
| Encoding berkas referensi UTF-8 tanpa BOM | ⚠️ **2 berkas melanggar** | `scripts/audit_references.ps1` (H17) |
| Kepadatan referensi ≥130 baris | ⚠️ **88 berkas di bawah ambang** | `scripts/audit_references.ps1` (H18) |
| Conventional Commits + Co-author trailer | ✅ | `git log --format=%s` |

> **DILARANG menulis klaim "0 Broken Paths" atau sejenisnya tanpa perintah yang membuktikannya.**
> Versi sebelumnya menjanjikan nol broken path sementara terdapat pointer menggantung ke
> `scripts/` per-bundle dan ke berkas `meta-decision.md` yang tidak pernah ada.
> Garansi yang tidak bisa dijalankan hanyalah dekorasi, dan lebih berbahaya daripada tidak ada.

---
*Dikelola dan dirawat oleh AETHERIS Autonomous Engineering Team.*
