# Brownfield Protocol — Legacy / Refactoring / Tambah Fitur di Repo Go Eksisting

> Dipicu dari `SKILL.md` saat user meminta penambahan fitur baru, modifikasi, optimasi, atau audit pada codebase yang sudah ada.

Saat user meminta **penambahan fitur baru, modifikasi, optimasi, atau audit** pada **codebase yang sudah ada (Legacy/Existing Project)**, DILARANG memaksakan *Big Bang Rewrite*, penciptaan "Frankenstein Codebase", atau pemakaian daftar subagent statis yang tidak relevan. Gunakan protokol **Dynamic Reconnaissance & Partitioning**:

1. **Intai & Pembelahan Subagent secara 100% Dinamis (Dynamic Hybrid Swarm):**
   Agen Utama DILARANG mematok nama atau jumlah peran subagent secara kaku. Pertama, lirik struktur direktori root dan dependency (`go.mod`/config) dari repository user. Setelah itu, spawn tim Subagent ber-model `pro` (dari 3 hingga >10 secara elastis) dengan strategi pembagian yang benar-benar selaras dengan kenyataan repo asli:
   - **Pembagian Berbasis Modul / Folder:** Jika project user dibagi menjadi beberapa modul/domain (misal: `/order`, `/user`, `/catalog`, `/payment`), spawn **1 Subagent Auditor terpisah untuk membedah masing-masing folder/modul**.
   - **Pembagian Berbasis Tech Stack di `go.mod`:** Jika mendeteksi library tertentu di `go.mod` (misal `gorm.io/gorm`, `kafka-go`, atau `graphql`), spawn subagent auditor dengan misi spesifik memburu kerentanan library tersebut (misal N+1 GORM Hunter, atau Kafka DLQ Auditor). Jika TIDAK ADA fitur finansial/uang, DILARANG memanggil spesialis fintech/moneter!
   - **Pembagian Berbasis Volume File:** Jika satu folder/package sangat padat (>30 file), pecah audit atas folder tersebut ke beberapa subagent berdasarkan sub-package atau fungsi eksekusi (misal: Subagent A fokus layer Handler/API, Subagent B fokus layer Query/Repository).
   - **Mastery Standard Matcher (Subagent Dedikatif):** Tugas subagent ini murni mengkonsolidasi seluruh laporan kecacatan dari para auditor di atas, lalu menarik dan membaca HANYA file di direktori `references/` kita yang **spesifik bisa menjadi obat pencerah untuk menyembuhkan temuan tersebut** (WAJIB membedah `zero_downtime_migrations.md` jika audit menemukan skema DB lama yang harus diubah).
2. **Zero-Steering Grilling (Opsi Evolusi / Penambahan Fitur):**
   Agen Utama merangkum laporan dari seluruh tim spesialis dan menyajikan ≥3 opsi netral beserta trade-off untuk user (Gasskan):
   - **Opsi 1: Native Consistent Extension (KISS):** Tanam fitur baru dengan mematuhi pola asli/ekspresi arsitektur repo tersebut (agar tim developer lama tidak bingung), NAMUN disuntikkan perlindungan standar Top 1% (WAJIB timeout, parameterized queries, RED metrics, dan index DB). Cepat dan konsisten.
   - **Opsi 2: Strangler Fig Pattern (Modular Isolation):** Fitur/modul baru didirikan secara independen menggunakan arsitektur modern kita (`internal/` Modular Monolith/Clean/SQLC) tanpa merusak kode lama. Terhubung ke legacy hanya melalui interface facade/proxy.
   - **Opsi 3: Surgical Rewrite & Expansion:** Jika modul lama terkait sudah terlalu cacat (misal fitur baru bergantung pada modul pembayaran jadul yang fatal/rentan race condition), ajukan operasi bedah modul lama sekaligus merancang fitur barunya berpadu berstandar Top 1%.
