# Brownfield Protocol — Legacy / Refactoring / Repo Eksisting

> Dipicu dari `SKILL.md` saat menghadapi repositori yang sudah ada.

Saat menghadapi repositori yang sudah ada (memiliki `go.mod`, `Cargo.toml`, `composer.json`, `package.json`, dll), **DILARANG KERAS memaksakan *Big Bang Rewrite*, menciptakan "Frankenstein Codebase", atau menerapkan daftar subagent statis lawas**. Gunakan protokol **Dynamic Reconnaissance & Partitioning**:

1. **Intai & Pembelahan Subagent secara 100% Dinamis (Dynamic Hybrid Swarm):**
   Agen Utama memindai direktori root dan dependency proyek terlebih dahulu, kemudian membelah tim Subagent ber-model `pro` (dari 3 hingga >10 secara elastis) dengan strategi selaras alam:
   *   **Pembagian Berbasis Modul / Folder:** Jika repo dibangun dengan modul/domain terpisah (misal `/Modules/Order`, `/crates/storage`, `/pkg/auth`), panggil **1 Subagent Auditor terpisah per modul/folder**.
   *   **Pembagian Berbasis Tech Stack di Manifest Dependency:** Jika mendeteksi library tertentu (misal GORM, Tokio, Octane, Kafka, GraphQL), panggil subagent auditor yang bertugas berburu bug khas library tersebut (misal N+1 Hunter, Octane State Leak Auditor, Tokio Cancellation Hazard Hunter). Jika TIDAK ADA fitur uang/fintech atau AI, dilarang memukul rata memangil spesialis kripto/AI!
   *   **Pembagian Berbasis Volume File:** Jika satu folder memuat >30 file, pecah menjadi 2-3 subagent secara paralel berdasar sub-fungsi (misal Handler vs Repository vs Service).
   *   **Mastery Standard Matcher:** 1 Subagent khusus yang merawat temuan bug para auditor lalu membedah HANYA file referensi di `references/` kita yang spesifik bertindak sebagai obat pencerah untuk menyembuhkan temuan cacat tersebut.
2. **Zero-Steering Grilling (Opsi Evolusi Netral):**
   Sajikan ≥3 opsi evolusi arsitektur untuk user pasca audit:
   *   **Opsi 1: Native Consistent Extension (KISS):** Tanam fitur/modul baru mengikuti ekspresi asli codebase setempat (agar konsisten dengan tim developer lama), NAMUN disuntikkan pertolongan Top 1% (wajib parameterized query, timeout, dan zero lint warnings).
   *   **Opsi 2: Strangler Fig Pattern (Modular Isolation):** Bangun fitur/modul baru di lingkungan terisolasi yang murni mematuhi standar modern kita tanpa menyakiti kode kuno, terhubung melalui facade/proxy.
   *   **Opsi 3: Surgical Rewrite & Hardening:** Lakukan bedah operasi bedana apabila modul lama sudah terlalu berlumur cacat fatal (seperti race condition ektrim pada modul pembayaran) sejalan dengan pembangunan fitur barunya.
