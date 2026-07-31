# Template SKILL.md: Standar Penulisan File Indeks Master Skill Bundle

Dokumen ini berisi template standar dan panduan penulisan file `SKILL.md` untuk setiap Master Skill Bundle.

---

## 1. Struktur Wajib File SKILL.md

Setiap file `SKILL.md` WAJIB mengandung 2 komponen utama:

### Komponen A: YAML Frontmatter (Metadata Trigger)

```yaml
---
name: {ecosystem}-mastery
description: Gunakan skill ini ketika {daftar kata kunci trigger, mencakup seluruh domain}.
---
```

**Aturan penulisan deskripsi YAML:**
1. Awali dengan `"Gunakan skill ini ketika..."`.
2. Sertakan kata kunci pemicu yang mencakup SEMUA domain di `references/`.
3. Maksimal 60 kata (~80 token) — ini dibaca di SETIAP percakapan baru.

```yaml
# ✅ BAIK — dense, trigger-rich, ≤60 kata
---
name: golang-mastery
description: Gunakan skill ini ketika merancang arsitektur, konkurensi, DB/SQLC, gRPC, HFT, testing, security, distributed systems, K8s Operators, Linux Systems Programming, atau runtime internals di Golang.
---

# ❌ BURUK — terlalu granular (pola Micro-Skill lama)
---
name: golang-concurrency-engineering
description: Skill untuk goroutine dan concurrency di Go.
---

# ❌ BURUK — terlalu panjang, membebani token budget
---
name: golang-mastery
description: Gunakan skill ini secara otomatis ketika user meminta untuk membuat, merancang, membangun, mengimplementasikan goroutine, channel, mutex, rwmutex, waitgroup, atomic... (200 kata lagi)
---
```

---

### Komponen B: Protocol Rules + Routing Table

Setelah YAML frontmatter, WAJIB sertakan:
1. **Core Protocol** — 2 aturan universal (reference loading + no-steering grilling)
2. **Language/Domain-Specific Quality Gate** — aturan spesifik per ekosistem
3. **Routing Table** — mapping topik → domain wildcard

```markdown
## 🔁 Protocol & Routing Table

**Core Protocol:**
1. WAJIB `view_file` SELURUH file referensi di `references/<domain>/` yang relevan — DILARANG mengarang dari hafalan LLM.
2. WAJIB sajikan minimal 2-3 opsi netral + trade-off saat Grilling — DILARANG langsung rekomendasikan 1 opsi.

**{Bahasa}-Specific Quality Gate:**
3. WAJIB `{perintah test}` — zero error sebelum lapor selesai.
4. WAJIB unit test pada modul bisnis utama.
5. ... (aturan spesifik ekosistem, max 12-15 rules)

| Topik Task | Domain Referensi |
| :--- | :--- |
| {kata kunci domain A + sinonim} | `references/{domain_a}/` |
| {kata kunci domain B + sinonim} | `references/{domain_b}/` |
```

**Aturan penulisan routing table:**
- Kolom kiri: kata kunci kaya sinonim yang mungkin digunakan user.
- Kolom kanan: path domain saja — Agent membaca SEMUA file di domain tersebut.
- 1 baris per domain di `references/`.

---

## 2. Panjang SKILL.md

**Tidak ada batas baris maksimum.** SKILL.md yang efektif adalah yang:
- Semua protocol rules spesifik, actionable, dan tidak redundan satu sama lain.
- Routing table mencakup SEMUA domain tanpa ada yang terlewat.
- Tidak ada padding atau rule generik yang sudah ditangani AGENTS.md.

> Contoh: `golang-mastery/SKILL.md` yang optimal adalah ~90-120 baris dengan 27 specific rules + 22 domain routing table — bukan 45 baris dengan hanya 2 generic rules.

---

## 3. Contoh SKILL.md Lengkap (Production-Ready)

```markdown
---
name: golang-mastery
description: Gunakan skill ini ketika merancang arsitektur, konkurensi, DB/SQLC, gRPC, HFT, testing, security, distributed systems, K8s Operators, Linux Systems Programming, atau runtime internals di Golang.
---

# Golang Mastery

SSOT arsitektur & rekayasa sistem Golang enterprise & high-throughput.

## 🔁 Protocol & Routing Table

**Core Protocol:**
1. WAJIB `view_file` SELURUH file referensi di `references/<domain>/` — DILARANG mengarang dari hafalan LLM.
2. WAJIB sajikan minimal 2-3 opsi netral + trade-off saat Grilling — DILARANG label "(Recommended)".

**Go-Specific Quality Gate:**
3. WAJIB `go test -race ./...` — bebas data race sebelum lapor selesai.
4. WAJIB `golangci-lint run` — zero lint error sebelum merge.
5. WAJIB unit test `_test.go` pada modul bisnis utama.
6. WAJIB Clean Architecture: DTO → Handler → Service → Repository.
7. WAJIB `context.WithTimeout` pada SEMUA panggilan DB/Redis/gRPC/HTTP.
8. WAJIB Graceful Shutdown: `os.Signal` + drain DB/Redis sebelum exit.

| Topik Task | Domain Referensi |
| :--- | :--- |
| GMP scheduler, GC, escape analysis, goroutine stack, generics, CGO | `references/runtime_internals/` |
| Goroutine leak, channel fan-out/fan-in, sync primitives, context, atomic | `references/concurrency/` |
| sqlc + pgx, ACID, locking, migration, cache L1/L2/L3, N+1, pool | `references/db_sqlc/` |
```

---

## 4. Anti-Patterns dalam Penulisan SKILL.md

### ❌ Anti-Pattern 1: Protocol Rules yang Overlap dengan AGENTS.md
```markdown
# SALAH — rule ini sudah ada di AGENTS.md global:
3. WAJIB gunakan Bahasa Indonesia dalam respon.
4. WAJIB edit presisi dengan replace_file_content.
5. WAJIB jalankan linter sebelum selesai.
```
**Kenapa berbahaya**: Duplikasi = token waste. Rules di SKILL.md harus EKSKLUSIF — hal-hal yang spesifik untuk ekosistem ini yang tidak ada di AGENTS.md.

### ❌ Anti-Pattern 2: Routing Table dengan Path File Spesifik
```markdown
# SALAH — menunjuk file tertentu, bukan domain wildcard:
| Goroutine | `references/concurrency/goroutine_lifecycle_leaks.md` |

# BENAR — domain wildcard:
| Goroutine leak, channel, sync primitives, context | `references/concurrency/` |
```
**Kenapa berbahaya**: Jika ada file baru di domain tersebut, routing table tidak akan mentrigger pembacaannya. Wildcard domain memastikan SEMUA file terbaca.

---

## 5. Perbedaan SKILL.md vs AGENTS.md

| Aspek | `SKILL.md` | `AGENTS.md` |
|---|---|---|
| **Scope** | Spesifik per ekosistem (Go, Rust, dll) | Global untuk semua task |
| **Trigger** | Hanya saat topik skill relevant | Setiap percakapan |
| **Isi** | Protocol ekosistem + routing table | SWE quality gate, workflow, subagent protocol |
| **Contoh rule** | `WAJIB go test -race ./...` | `WAJIB review mandiri sebelum lapor selesai` |
