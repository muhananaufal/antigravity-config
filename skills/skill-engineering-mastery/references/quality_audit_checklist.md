# Quality Audit Checklist: Verifikasi Sebelum Skill Bundle Dinyatakan Selesai

Dokumen ini berisi checklist verifikasi wajib sebelum mendeklarasikan sebuah Skill Bundle sebagai "selesai dan siap digunakan". Gunakan juga sebagai panduan audit berkala untuk meningkatkan kualitas file referensi yang sudah ada.

---

## 1. Scorecard Kualitas Per File (15 Poin)

Setiap file referensi WAJIB di-audit menggunakan scorecard berikut sebelum dinyatakan selesai:

| Kriteria | 1 — Lemah | 2 — Cukup | 3 — Top 1% |
|---|---|---|---|
| **Technical Depth** | Surface/tutorial level | Intermediate, ada nuance | Principal-level: covers internals, gotchas, & trade-off nyata |
| **Code Quality** | Tidak kompilasi / ada placeholder | Kompilasi tapi simplified | Production-ready: error handling, ctx propagation, imports lengkap |
| **Specificity** | Generic boilerplate | Agak spesifik tapi masih umum | Hyper-specific: detail implementasi & edge case yang relevan per topik |
| **Anti-Pattern** | Tidak ada | 1 anti-pattern konkret | ≥2 spesifik: kode ❌ salah + kode ✅ benar + penjelasan MENGAPA berbahaya |
| **Unit Test** | Tidak ada | Trivial / smoke test | Meaningful: cover behavior penting & edge case (`func Test...` / `#[cfg(test)]`) |

**Verdict:**
- **13–15 poin** → ⭐ Excellent (Top 1%) — PASS
- **9–12 poin** → 🟡 Enrich — tambah konten yang kurang
- **≤8 poin** → ❌ Rewrite — tulis ulang penuh

### Contoh Grading: Passing vs Failing

**❌ File yang Akan Gagal (Score ~5/15):**
```markdown
# Go Channels

Channel digunakan untuk komunikasi antar goroutine.

## Contoh:
ch := make(chan int)
ch <- 42
val := <-ch
```
→ Depth=1 (hanya sintaks dasar), Code=1 (tidak ada error handling/context), 
  Specificity=1 (generic), Anti-Pattern=1 (tidak ada), Unit Test=1 (tidak ada)

**⭐ File yang Akan Lulus (Score ~14/15):**
```markdown
# Channel Patterns & Backpressure

[Penjelasan buffered vs unbuffered trade-off, deadlock prevention mechanism,
backpressure signals, contoh production dengan goroutine leak prevention,
anti-pattern select tanpa default, edge case nil channel blocking forever,
func TestChannelPipeline dengan goleak.VerifyNone(t)]
```
→ Depth=3, Code=3, Specificity=3, Anti-Pattern=2, Unit Test=3

---

## 2. Checklist Struktur & Arsitektur Bundle

- [ ] **Folder Master Bundle** mengikuti naming convention `{ecosystem}-mastery` (lowercase, hyphen separator).
- [ ] **`SKILL.md`** mengandung: YAML Frontmatter + Protocol Rules (dikelompokkan per blok tematik) + Routing Table wildcard.
- [ ] **`SKILL.md`** tetap scannable — tidak ada duplikasi antar rule, setiap rule actionable.
- [ ] **Sub-folder domain** di `references/<domain>/` mengikuti naming convention lowercase, underscore separator.
- [ ] **Setiap sub-folder domain** berisi 5–10 file referensi (minimum 2, maksimum 10).
- [ ] **File referensi** mengikuti naming convention `{nama_deskriptif}.md` (lowercase, underscore, tanpa prefix angka).

---

## 3. Checklist YAML Frontmatter

- [ ] Field `name` cocok dengan nama folder skill.
- [ ] Field `description` dimulai dengan `"Gunakan skill ini ketika..."`.
- [ ] Field `description` mencakup kata kunci pemicu untuk SEMUA domain di `references/`.
- [ ] Field `description` tidak melebihi 60 kata (~80 token).
- [ ] Field `description` mengandung sinonim/istilah alternatif untuk trigger accuracy.

---

## 4. Checklist Routing Table

- [ ] Tabel memiliki 1 baris per sub-folder domain di `references/<domain>/`.
- [ ] Kolom kiri berisi kata kunci kaya sinonim untuk seluruh topik di domain tersebut.
- [ ] Kolom kanan menggunakan wildcard: `references/{domain}/*.md` — BUKAN path file spesifik.
- [ ] Protocol mencantumkan: WAJIB baca SELURUH file, DILARANG mengarang dari hafalan LLM.
- [ ] Protocol mencantumkan: DILARANG label `(Recommended)`, WAJIB sajikan 2-3 opsi netral.

---

## 5. Checklist Kualitas Konten (Per File Referensi)

- [ ] Setiap file referensi berukuran **8–15 KB** (minimum 5 KB). File <5KB hampir pasti terlalu dangkal.
- [ ] **ASCII Diagram** — minimal 1 diagram arsitektur/flow yang informatif per file.
- [ ] **Kode production-ready** — minimal 1 contoh yang bisa dikompilasi, import lengkap, error handling ada.
- [ ] **Unit Test** — `func Test...` (Go) / `#[cfg(test)]` (Rust) yang meaningful per file.
- [ ] **Zero-Placeholder** — tidak ada `// TODO`, `panic()`, variabel `dummy`, `println("debug")`.
- [ ] **Zero-Hardcoding** — tidak ada API key, token, password, atau URL hardcoded.
- [ ] **Anti-Pattern** — minimal **2 anti-pattern SPESIFIK** dengan kode ❌ salah + kode ✅ benar + penjelasan MENGAPA.
- [ ] **Edge Cases** — minimal **3 skenario tepi konkrit** yang relevan per topik (bukan generic).

### ❌ Anti-Pattern yang Sering Lolos: Generic Edge Cases

```markdown
# SALAH — terlalu generic, bisa ditempel ke topik apapun:
## Edge Cases
1. Null input harus ditangani
2. Timeout harus diset
3. Error harus di-log

# BENAR — spesifik per topik (contoh: untuk Goroutine Leak):
## Edge Cases
1. Nil channel blocks forever — gunakan select dengan ctx.Done() sebagai escape hatch
2. Goroutine launched in for-loop tanpa closure variable capture fix → semua goroutine baca nilai final
3. WaitGroup counter race jika Add() dipanggil setelah goroutine launch
```

---

## 6. Checklist Token Budget

- [ ] Total skill bundles terdaftar ≤6 Master Bundles (target: 3–4).
- [ ] Estimasi token semua skill bundle tidak melebihi **3% total budget** (~225 token untuk 3 bundle).
- [ ] Jika mendekati batas, lakukan kompresi deskripsi YAML sesuai panduan `token_budget_optimization.md`.

---

## 7. Checklist Verifikasi Fungsional

- [ ] **Trigger Test** — simulasikan 3 prompt berbeda yang seharusnya memicu skill ini. Verifikasi trigger accuracy.
- [ ] **Cross-Reference Test** — tidak ada overlap/duplikasi konten signifikan dengan skill bundle lain.
- [ ] **File Path Test** — semua path di routing table benar dan file benar-benar ada.
- [ ] **Broken File Check** — tidak ada file berukuran <1KB (kemungkinan file rusak/kosong).

---

## 8. Audit Workflow untuk File yang Sudah Ada

Gunakan workflow ini untuk audit dan peningkatan kualitas file referensi existing:

```
Per Domain:
1. LIST — list semua file di domain + ukuran KB
2. GRADE — per file: READ → scorecard 5 kriteria → verdict
3. EXECUTE — berdasarkan verdict:
   - Score 13+  → PASS, skip atau minor fix
   - Score 9-12 → ENRICH: tambah section/konten yang lemah
   - Score ≤8   → REWRITE: tulis ulang penuh sampai score 13+
4. UPDATE — catat hasil di quality_tracker.md setelah domain selesai
5. NEXT — lanjut domain berikutnya
```

**Aturan DILARANG selama audit:**
- DILARANG lanjut ke domain berikutnya sebelum semua file di domain saat ini lulus score 13+.
- DILARANG anggap "acceptable" file yang hanya score 9–12 — enrich sampai 13+.
- DILARANG skip file karena "tampak cukup dari judulnya" tanpa benar-benar membacanya.

---

## 9. Per-Domain Checkpoint Gate (Wajib untuk Multi-Domain Task)

Setelah setiap domain selesai, WAJIB centang semua item ini sebelum lanjut:

```
Domain yang baru selesai: [nama_domain]

□ SCORECARD DONE: Setiap file sudah di-grade dengan scorecard 5-kriteria.
□ SCORE 13+: Semua file mencapai score minimal 13/15.
□ UNIT TEST: Setiap file memiliki minimal 1 unit test yang meaningful.
□ ANTI-PATTERN ≥2: Setiap file memiliki minimal 2 anti-pattern spesifik.
□ EDGE CASE ≥3: Setiap file memiliki minimal 3 edge case konkrit.
□ NO BROKEN FILES: Tidak ada file <1KB atau <5KB tanpa alasan valid.
□ DEPTH CONSISTENT: Kualitas file terakhir setara dengan file pertama di domain ini.
```

Hanya boleh lanjut ke domain berikutnya setelah semua checkbox dicentang penuh.
Kualitas adalah satu-satunya metric — waktu tidak relevan.
