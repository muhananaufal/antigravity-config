# Brownfield Laravel — Protokol Repo Eksisting

> Dipicu dari `SKILL.md` saat tambah fitur / refactor / optimasi / audit pada repo ber-`composer.json`. **Baseline regresi (§3.4 `AGENTS.md`) WAJIB tuntas lebih dulu.**

**DILARANG:** Big Bang Rewrite · "Frankenstein Codebase" · daftar subagent statis yang tidak relevan dengan repo.

## 1. Rekonesans — bentuk tim sesuai kenyataan repo

Lirik struktur direktori + `composer.json` + config framework **dulu**, baru sebar subagent tier `pro` (3–10, elastis):

| Kondisi repo | Bentuk subagent |
| :--- | :--- |
| Struktur modular (`/Modules/Order`, `/Modules/Billing`) atau DDD | 1 auditor per modul/domain |
| `laravel/octane` terdeteksi | **Octane State Leak Auditor** — properti `static`, singleton tanpa pembatalan di `config/octane.php` |
| Eloquent intensif / Queue terdeteksi | **Eloquent Performance & N+1 Hunter** — query tanpa `->with()`, pagination hilang, job tanpa `$afterCommit = true` di dalam `DB::transaction()` |
| Endpoint API/Web terdeteksi | **Security & OWASP Auditor** — IDOR, Mass Assignment `$fillable`, SQL injection pada raw query, rate limiting |
| Satu folder >30 berkas (`/app/Http/Controllers`, `/app/Services`) | Pecah ke 2–3 subagent per grup rute/fungsi |
| **Selalu, tepat 1** | **Mastery Standard Matcher** — konsolidasi seluruh temuan auditor, lalu baca HANYA referensi yang jadi obatnya. WAJIB membedah `legacy_refactoring/` bila menyentuh skema DB lawas. |

DILARANG memanggil spesialis multi-tenancy/AI Scout bila repo tidak punya fiturnya.

## 2. Sajikan ≥3 opsi — Zero-Steering Grilling

| Opsi | Kapan cocok | Konsekuensi |
| :--- | :--- | :--- |
| **Native Consistent Extension** (KISS) | Pola repo masih sehat | Cepat & konsisten. WAJIB tetap suntik `FormRequest` validation, `->paginate()`, eager loading, SLA k6, zero PHPStan level 9 error pada kode baru. |
| **Strangler Fig** | Modul baru bisa berdiri sendiri | Lapisan Clean Architecture: **FormRequest → Controller → Action/Service → Repository → Model**, struktur lawas tidak disentuh. |
| **Surgical Rewrite & Hardening** | Modul lama fatal (pembayaran/inventaris penuh N+1, race condition di Horizon/Queue) | Bedah modul lama sekalian bangun fitur barunya. Paling mahal, paling bersih. |

DILARANG memberi label "(Recommended)" sepihak — lihat §4 `AGENTS.md`.
