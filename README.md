# ⚡ AETHERIS — Autonomous Software Engineering Engine

> **SSOT (Single Source of Truth) Architecture & Knowledge Engine**  
> Repositori konfigurasi sentral untuk mengontrol seluruh kapabilitas, aturan arsitektur, protokol rekayasa perangkat lunak (*Software Engineering*), memori persisten, integrasi multi-tool, dan *domain mastery* standar Principal Engineer (L7/L8).

---

## 📑 Daftar Isi
1. [Arsitektur & Peta Sistem](#-arsitektur--peta-sistem)
2. [Konstitusi & Aturan Inti (`AGENTS.md`)](#-konstitusi--aturan-inti-agentsmd)
   - [0. Gerbang Mutlak](#0-gerbang-mutlak)
   - [1. Glosarium & Terminologi Baku](#1-glosarium--terminologi-baku)
   - [2. Taksonomi 10 Jalur Routing Task](#2-taksonomi-10-jalur-routing-task)
   - [3. Protokol Pra-Koding & Forensic Baseline](#3-protokol-pra-koding--forensic-baseline)
   - [4. Prosedur Challenger (Anti-Yes-Man)](#4-prosedur-challenger-anti-yes-man)
   - [5. Standar Artefak & Dokumentasi Teknis](#5-standar-artefak--dokumentasi-teknis)
   - [6. Quality Gate Ratchet & Patch Receipt](#6-quality-gate-ratchet--patch-receipt)
   - [7. Swarm Subagent & DAG Batch Writing](#7-swarm-subagent--dag-batch-writing)
   - [8. Standar Komunikasi & Bahasa](#8-standar-komunikasi--bahasa)
3. [Skill Bundles & Domain Mastery (`skills/`)](#-skill-bundles--domain-mastery-skills)
   - [`golang-mastery`](#1-golang-mastery)
   - [`rust-mastery`](#2-rust-mastery)
   - [`laravel-mastery`](#3-laravel-mastery)
   - [`nestjs-mastery`](#4-nestjs-mastery)
   - [`master-decision-tree`](#5-master-decision-tree)
   - [`templates`](#6-templates)
   - [`git-workflow`](#7-git-workflow)
   - [`brainstorm`](#8-brainstorm)
   - [`skill-engineering-mastery`](#9-skill-engineering-mastery)
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
├── scripts/
│   ├── quality_gate.ps1        # Script Ratchet Quality Gate (Linter, Blocker, Tests)
│   └── stop_gate_antigravity.ps1 # Wrapper Execution Hook untuk Antigravity Engine
│
├── shared/
│   ├── LEARNED.md              # Living Brain SSOT (Pelajaran, Bug Triggers, Runtime Truths)
│   └── tool-claude-code.md     # Jembatan Protokol Sinkronisasi Claude Code (~/.claude/CLAUDE.md)
│
├── skills/                     # 9 Skill Bundles Berisi Ratusan Referensi Produksi
│   ├── brainstorm/             # Protokol Brainstorming Teknikal & Non-Teknikal
│   ├── git-workflow/           # Git Flow, Conventional Commits, Dual-Avatar Attribution
│   ├── golang-mastery/         # Go High-Perf, Concurrency, SQLC, gRPC (31 Domain Refs)
│   ├── laravel-mastery/        # Laravel Octane, Reverb, Horizon, Multi-tenant (31 Refs)
│   ├── master-decision-tree/   # Matriks Pemilihan Bahasa & Arsitektur Sistem
│   ├── nestjs-mastery/         # NestJS Hexagonal, Fastify, Microservices (31 Refs)
│   ├── rust-mastery/           # Rust Async Tokio, Axum, Zero-Cost, Lock-free (31 Refs)
│   ├── skill-engineering-mastery/ # Meta-Skill Pembuatan & Audit Skill Baru
│   └── templates/              # Master Template RFC, RCA, System Map, & Patch Receipts
│
└── plugins/                    # Integrasi Plugin Eksternal
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
* **Self-Healing Circuit Breaker:** Batas maksimal 3 kali percobaan perbaikan otomatis saat compile/test gagal sebelum wajib berhenti dan investigasi fundamental.
* **Side Note:** Catatan 1–2 baris di akhir respon mengenai bad practice di luar scope yang tidak boleh disentuh sepihak.

### 2. Taksonomi 10 Jalur Routing Task
Setiap perintah user dicocokkan secara deterministik dari atas ke bawah:
1. **Proyek Baru Kecil (<10 files, SQLite/JSON, CLI/Script):** Eksekusi langsung tanpa RFC & Day-0 Quintet, namun Quality Gate tetap aktif.
2. **Proyek Baru Greenfield (Penuh):** Gerbang Klarifikasi $\rightarrow$ Master Decision Tree $\rightarrow$ Day-0 Quintet $\rightarrow$ All-in-One RFC $\rightarrow$ Tunggu "Gasskan".
3. **Tambah Fitur / Refactor Brownfield:** Baseline Regresi $\rightarrow$ Forensic Blast Radius Matrix $\rightarrow$ Sajikan $\ge 3$ Opsi Netral $\rightarrow$ Tunggu "Gasskan".
4. **Edit $\le 3$ Berkas / Bugfix Minor:** Proof-of-Defect TDD $\rightarrow$ Eksekusi bedah presisi $\rightarrow$ Laporan faktual.
5. **Edit $>3$ Berkas / DB Migration / Breaking API:** Gerbang Klarifikasi $\rightarrow$ All-in-One RFC $\rightarrow$ Update Master Catalog $\rightarrow$ Tunggu "Gasskan".
6. **In-Flight Fix:** Perbaikan bug pada plan yang sudah disetujui dilanjutkan sebagai bagian batch RFC aktif tanpa membuat RFC baru.
7. **Emergency Pause:** Blocker kritis di tengah jalan memicu pause seketika $\rightarrow$ Susun RCA 5-Whys $\rightarrow$ Sinkronisasi ke `LEARNED.md`.
8. **Technical Q&A:** Diskusi teknis tanpa permintaan kode dijawab dingin & faktual tanpa mengubah filesystem.
9. **Brainstorming Arsitektur / Tech-Stack:** Picu skill `brainstorm` $\rightarrow$ Catat keputusan di `LEARNED.md` $\rightarrow$ Dilarang tulis kode sebelum "Gasskan".
10. **Obrolan Santai / Non-Teknis:** Jawab langsung tanpa memaksakan gerbang pengujian mutu.

### 3. Protokol Pra-Koding & Forensic Baseline
* Wajib membaca `shared/LEARNED.md` sebelum interaksi koding.
* Menjalankan **Baseline Regresi** pada proyek Brownfield untuk mencatat status test eksisting sebelum mengubah kode.
* **Progressive Disclosure:** Membaca antarmuka simbol dengan range kecil (50–100 baris) sebelum membedah berkas besar (>500 baris) guna menghemat context window.
* **Monorepo Sub-Root Resolution:** Deteksi otomatis lokasi subfolder manifest (`apps/api`, `services/auth`) untuk eksekusi linter & test runner yang presisi.

### 4. Prosedur Challenger (Anti-Yes-Man)
* Menolak bersikap "yes-man" terhadap usulan user yang berisiko (OWASP, security, performance bottleneck).
* Setiap pengusulan arsitektur wajib menyertakan **$\ge 3$ Kelebihan DAN $\ge 3$ Kekurangan**.
* Pada RFC-Path wajib menyajikan **$\ge 3$ Opsi Netral** tanpa memaksakan label `(Recommended)`.

### 5. Standar Artefak & Dokumentasi Teknis
Seluruh dokumen teknis wajib mengikuti standar arsitektur L7/L8 yang didefinisikan di `skills/templates/SKILL.md`.

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
* Subagent berjalan paralel untuk riset $>3$ domain (Tier Model: `pro`).
* **Subagent Read-Only Constraint:** Subagent DILARANG menulis file atau memanipulasi Git history.
* **DAG Task Dependencies:** Batch tugas di RFC diorganisasi dengan dependensi eksplisit (`DependsOn: [Batch 1]`).
* **Contract-First & Schema Locking:** Mengunci DTO, interface, dan migration skema di Batch 1 sebelum menulis business logic.
* **Batch Writing Limit:** Maksimal penulisan 3–4 file per turn diikuti pengujian atomik dan commit sebelum lanjut ke batch berikutnya.

---

## 🛠️ Skill Bundles & Domain Mastery (`skills/`)

### 1. `golang-mastery`
Panduan rekayasa backend Golang tingkat tinggi mencakup 31 domain referensi produksi:
* **Concurrency & Runtime:** Goroutine lifecycle, channel multiplexing, lock-free atomics, runtime memory allocator, sync.Pool.
* **Database & Storage:** SQLC type-safe query generation, pgx connection pooling, Transactional Outbox, dynamic sharding.
* **Transport & Microservices:** gRPC streaming, Protobuf v3, Chi routing, HTTP/2 & HTTP/3 tuning, mTLS security.
* **Observability & Resilience:** `slog` structured logging, OpenTelemetry distributed tracing, RED metrics, uber-go/ratelimit.
* **Advanced Systems:** Linux eBPF telemetry, Kubernetes custom controllers/operators, SIMD vectorization, zero-allocation serialization.

### 2. `rust-mastery`
Panduan rekayasa sistem Rust performa tinggi mencakup 31 domain referensi produksi:
* **Memory Safety & Concurrency:** Lifetime annotations, Borrow checker patterns, Tokio multi-threaded async runtime, crossbeam lock-free queues.
* **Microservices & Web:** Axum web framework, Tower middleware stack, SQLx compile-time checked queries, Tonic gRPC.
* **Low-Level & Performance:** Unsafe Rust containment, FFI C-ABI integration, Custom Allocators (jemalloc/mimalloc), SIMD auto-vectorization, Miri undefined behavior validation.
* **Client & Embedded:** Tauri desktop engine, Bevy game ECS, WebAssembly (WASM) host bindings, eBPF Aya framework.

### 3. `laravel-mastery`
Panduan arsitektur modern enterprise Laravel mencakup 31 domain referensi produksi:
* **High-Performance Engines:** Laravel Octane (Swoole/FrankenPHP), Swoole State Resetters, Reverb WebSockets, Horizon queue orchestration.
* **Database & Scale:** Eloquent optimization, N+1 query prevention, Multi-Tenancy Row Level Security (RLS), Read-Replica split, Redis token bucket.
* **Fintech & Security:** Cashier subscription billing, Idempotent webhook handling, Zero-Trust Sanctum/Passport auth, STRIDE input sanitation.
* **Frontend & Reporting:** Livewire v3 / Inertia.js integration, Dompdf precision layout rendering engine truths.

### 4. `nestjs-mastery`
Panduan arsitektur Enterprise TypeScript NestJS mencakup 31 domain referensi produksi:
* **Core Architecture:** Fastify engine adapter, Inversion of Control (IoC) container tuning, Hexagonal Ports & Adapters architecture.
* **Data Layer:** Prisma & Drizzle ORM performance, Connection pool isolation, Distributed 2PC transactions.
* **Distributed Services:** Apollo GraphQL Federation v2, Kafka & NATS message transports, BullMQ distributed background workers.
* **Security & AI:** Multi-Tenancy RLS guards, pgvector LangChain integration, OWASP strict validation pipes.

### 5. `master-decision-tree`
Pohon keputusan arsitektur sistem mutlak untuk memilih bahasa dan framework berdasarkan profil throughput, latency, konsistensi data, kecepatan rilis, dan kompleksitas domain.

### 6. `templates`
Koleksi template baku L7/L8:
* `docs/rfc/YYYYMMDD-<fitur>.md`: Template All-in-One RFC lengkap dengan STRIDE Threat Model & DAG Batch Tasks.
* `docs/rfc/README.md`: Master Catalog pelacak status seluruh RFC di repositori.
* `docs/rca/YYYYMMDD-<insiden>.md`: Post-Mortem 5-Whys Blameless Root Cause Analysis.
* `system_map.md`: Living Architecture Map & Topologi SSOT.
* `Laporan Hasil Test & Patch Receipt`: Format bukti verifikasi SOTA dengan Proof-of-Defect TDD Harness.
* `tests/regression/`: Spesifikasi format Failure Banking Artifact untuk mengunci kekebalan terhadap bug masa lalu.

### 7. `git-workflow`
* Protokol Git Flow (`feature/*`, `fix/*`, `chore/*`).
* Conventional Commits (`feat:`, `fix:`, `refactor:`, `chore:`).
* **Stacked PRs & Micro-Branching (Devin Protocol):** Branching terisolasi per batch RFC untuk integrasi bertahap yang aman.
* **Dual-Avatar Attribution Trailer:**
  ```text
  Co-authored-by: aetheris <agents.aetheris@gmail.com>
  ```

### 8. `brainstorm`
Protokol eksplorasi ide terstruktur memisahkan ranah Non-Teknis (Produk, Bisnis, Strategi) dan Teknikal/Arsitektural (Stack Selection, Distributed Trade-offs) dengan pencatatan otomatis ke `shared/LEARNED.md`.

### 9. `skill-engineering-mastery`
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
* ✅ **0 Broken Paths** pada seluruh referensi markdown dan link lokal.
* ✅ **Zero Untyped Bypasses & Zero Hardcoded Secrets**.
* ✅ **100% Conventional Commits Compliance** dengan Dual-Avatar Attribution.

---
*Dikelola dan dirawat oleh AETHERIS Autonomous Engineering Team.*
