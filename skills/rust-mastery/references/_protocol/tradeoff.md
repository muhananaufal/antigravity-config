# Trade-Off Rust — Kapan Pakai, Kapan Hindari

> Dipicu dari `SKILL.md` saat keputusan arsitektur atau saat menjalankan Challenger Mode (§4 `AGENTS.md`) terhadap pilihan stack.
> Pemilihan bahasa tetap melewati `skills/master-decision-tree/SKILL.md` BAGIAN 1 lebih dulu — berkas ini melengkapi keputusan itu dengan amunisi tantangan, bukan menggantikannya.

## Keunggulan — dan kapan ia benar-benar menentukan

| Keunggulan | Pemicu (kapan ini jadi alasan memilih Rust) | Konsekuensi praktis |
| :--- | :--- | :--- |
| Memory safety tanpa GC | Domain berregulasi (finansial, medis, aerospace) atau target p99 < 1 ms | Tidak ada jeda GC untuk dijelaskan ke SRE, dan seluruh kelas use-after-free ditolak saat kompilasi |
| Zero-cost abstraction | Hot path yang benar-benar panas: matching engine, parser, encoding, SIMD | Abstraksi tinggi tidak membayar ongkos runtime — trait & iterator hilang saat monomorphization |
| Menjangkau tempat lain tak sampai | Perlu berjalan di kernel (eBPF), browser (WASM), embedded, atau sebagai pustaka FFI | Satu bahasa untuk backend, edge, dan modul native — mis. `napi-rs` mempercepat titik panas Node.js |

## Kelemahan — WAJIB ditantangkan ke user bila pemicunya cocok

| Kelemahan | Pemicu | Tantangan yang WAJIB diajukan |
| :--- | :--- | :--- |
| Kurva belajar borrow checker | Tim kecil (1–3), tenggat < 4 minggu, belum ada yang pernah pakai Rust | **TANTANG paling keras.** Time-to-market adalah constraint dominan, dan Rust memperlambatnya berlipat di bulan pertama. Sarankan Laravel/NestJS; potong satu layanan ke Rust nanti bila terbukti perlu. |
| Waktu kompilasi | CI tanpa layer cache, iterasi cepat harian | Tanpa `cargo-chef`, build ulang 10–15 menit **setiap push** (`LEARNED.md`). **TANTANG**: bila alur kerja menuntut iterasi menit-an, ongkos ini nyata dan berulang. Wajibkan `cargo-chef` + `sccache` sejak Day-0. |
| Ekosistem web lebih muda | Butuh admin panel, CMS, atau ORM dengan scaffolding matang | SQLx/SeaORM kuat, tapi **tidak ada padanan Filament/Nova**. **TANTANG**: kalau deliverable-nya panel admin, Rust membuat Anda menulis dari nol. |
| Container bukan `FROM scratch` | Asumsi "biner statis, jadi Docker-nya sepele" | **Salah, dan tercatat di `LEARNED.md`.** Butuh `ca-certificates` untuk TLS, target musl atau distroless untuk glibc, `tzdata`, dan `cargo-chef` untuk caching. Anggarkan waktu DevOps-nya. |

## Garis Merah — JANGAN pakai Rust bila

1. **Time-to-market < 4 minggu dengan tim yang belum pernah menjalankan Rust di produksi.** Ini pembunuh proyek paling sering, bukan masalah teknis.
2. Deliverable utamanya **admin panel / CMS / CRUD berat scaffolding** → Laravel + Filament.
3. Beban sistem **murni I/O-bound biasa** tanpa target latensi ketat — Go memberi 90% hasilnya dengan sepertiga ongkos onboarding. Lihat `master-decision-tree` NODE 1.1 cabang B.
