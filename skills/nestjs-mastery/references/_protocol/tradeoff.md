# Trade-Off NestJS — Kapan Pakai, Kapan Hindari

> Dipicu dari `SKILL.md` saat keputusan arsitektur atau saat menjalankan Challenger Mode (§4 `AGENTS.md`) terhadap pilihan stack.
> Pemilihan bahasa tetap melewati `skills/master-decision-tree/SKILL.md` BAGIAN 1 lebih dulu — berkas ini melengkapi keputusan itu dengan amunisi tantangan, bukan menggantikannya.

## Keunggulan — dan kapan ia benar-benar menentukan

| Keunggulan | Pemicu (kapan ini jadi alasan memilih NestJS) | Konsekuensi praktis |
| :--- | :--- | :--- |
| Disiplin enterprise di Node.js | Tim besar, standarisasi ketat, banyak modul yang harus tetap terpisah | DI, Interceptors, Guards, dan Decorator modular mematikan spaghetti khas JavaScript tradisional — struktur dipaksakan framework, bukan kesepakatan lisan |
| Throughput I/O tinggi | Beban I/O-bound konkuren dengan banyak koneksi bersamaan | Fastify engine + kompatibilitas Bun; event loop unggul justru pada beban yang menunggu, bukan yang menghitung |
| Isomorfisme fullstack | Frontend dan backend satu tim/satu bahasa, kontrak berubah sering | Satu TypeScript dari React sampai microservice terdalam; DTO Zod/OpenAPI sinkron tanpa lapisan penerjemah |

## Kelemahan — WAJIB ditantangkan ke user bila pemicunya cocok

| Kelemahan | Pemicu | Tantangan yang WAJIB diajukan |
| :--- | :--- | :--- |
| Bottleneck single-thread | ≥80% beban adalah komputasi CPU-bound: matematika berat, encode video, kriptografi jutaan loop | **TANTANG risiko bottleneck.** Event loop terblokir mematikan SEMUA client, bukan hanya request itu. Sarankan pindah ke Rust/Go, atau jembatani lewat `napi-rs` / Piscina Worker Threads. |
| Overhead heap & cold start | Target deploy FaaS / AWS Lambda dengan frekuensi panggil jarang | Cold start ~300–800 ms (`master-decision-tree` BAGIAN 7). Tanpa bundling SWC/esbuild dan provisioned concurrency warm-up, latensinya menyiksa. **TANTANG**: pertimbangkan runtime lain, atau jangan serverless. |
| Type erasure di runtime | Payload eksternal masuk tanpa validasi skema | **Tipe TypeScript MUSNAH saat compile** (`LEARNED.md`). `reflect-metadata` hanya menyimpan metadata terbatas — generic dan union tidak terbaca. Tanpa Zod/TypeBox di pintu masuk, JSON jahat tembus ke database. |

## Garis Merah — JANGAN pakai NestJS bila

1. Beban intinya **CPU-bound berkelanjutan** dan Worker Thread bukan pilihan yang bisa diterima secara arsitektur → Go atau Rust.
2. Target **p99 < 1 ms atau hard real-time deterministik** — event loop + GC V8 tidak memberi jaminan itu.
3. Deliverable-nya **CLI terdistribusi atau tooling infrastruktur** yang harus jalan tanpa runtime Node terpasang → Go (biner statis).
