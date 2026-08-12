# Brownfield Laravel — Protokol Forensik & Blast Radius Repo Eksisting

> [!WARNING]
> **SSOT Override:** Segala instruksi di file ini (termasuk pembentukan Swarm subagent, Day-0 Quintet, RFC, dan Matriks) **TUNDUK** pada pengecualian di AGENTS.md §2 dan §7. Jika proyek berukuran kecil atau sekadar edit minor, **ABAIKAN** instruksi berat di file ini dan langsung tulis kode. DILARANG spawn subagent untuk tugas yang tidak memenuhi syarat di §7.

> Dipicu dari `SKILL.md` saat tambah fitur / refactor / optimasi / audit pada repo ber-`composer.json`. **Baseline regresi (§3.4 `AGENTS.md`) WAJIB tuntas lebih dulu.**

**DILARANG:** Big Bang Rewrite · "Frankenstein Codebase" · Mengubah kode tanpa memetakan Blast Radius.

---

## 1. Rekonesans Forensik — Bentuk Tim Sesuai Kenyataan Repo

Pindai struktur direktori + `composer.json` + config framework **dulu**, baru sebar subagent paralel (1 per domain, sesuai `AGENTS.md` §7):

| Kondisi Repo | Fokus Audit Subagent | Target Berkas & Concern |
| :--- | :--- | :--- |
| Modular / DDD (`Modules/Order`) | **Domain Boundary Auditor** | Cross-domain Eloquent query, direct model binding lintas modul |
| `laravel/octane` terdeteksi | **Octane State Leak Auditor** | Properti `static`, stateful singleton di Service Provider |
| Eloquent intensif / Queue | **Eloquent N+1 & Queue Hunter** | Query tanpa `->with()`, pagination hilang, job tanpa `$afterCommit` |
| Endpoint API/Web | **Security & OWASP Auditor** | IDOR, Mass Assignment `$fillable`, raw query SQLi, missing rate-limiting |
| Multi-tenant / routing subdomain terdeteksi | **Tenant Isolation Auditor** | Global scope tenant bocor, query lintas-tenant tanpa `tenant_id`, cache key tanpa prefiks tenant |

---

## 2. Matriks Blast Radius & Forensic Audit (Wajib Sebelum RFC)

Subagent auditor wajib menyusun tabel forensik ini sebelum opsi arsitektur diajukan:

```markdown
### 🔍 Forensic Blast Radius Matrix
| Komponen yang Disentuh | Modul / Job Queue Downstream Terdampak | Potensi Risiko / Failure Mode | Mitigasi Defensif (Guardrail) |
| :--- | :--- | :--- | :--- |
| Model `User` / `Order` | Background Horizon Queue workers | Serialization payload pecah saat worker menjalankan job lama | Model $afterCommit & DTO primitives |
| Skema database Eloquent | Public REST API resources & Web views | Response API berubah tanpa sadar (regression) | API Resource wrapping + Feature test |
```

---

## 3. Bahaya Khas Laravel yang WAJIB Diperiksa

1. **Octane state leak:** properti `static` dan singleton stateful di Service Provider bertahan **antar-request** — kelas bug yang tidak pernah ada di php-fpm. Data satu pengguna bocor ke pengguna berikutnya.
2. **N+1 query:** relasi Eloquent diakses di dalam loop tanpa `->with()`. Satu halaman daftar berubah jadi ratusan query, dan baru terasa setelah data produksi tumbuh.
3. **Job tanpa `$afterCommit`:** worker mengambil job sebelum transaksi pemanggilnya commit, lalu gagal mencari baris yang belum ada. Race yang lolos di lokal dan menyala di produksi.
4. **Mass assignment & IDOR:** `$fillable`/`$guarded` longgar, atau route model binding tanpa policy — pengguna mengubah kolom atau membaca sumber daya milik orang lain.
5. **Pagination hilang:** `->all()` atau `->get()` pada tabel yang tumbuh. Berfungsi mulus sampai baris ke sejuta, lalu menghabiskan memori proses PHP sekaligus.

---

