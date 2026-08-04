# Trade-Off NestJS — Kapan Pakai, Kapan Hindari

> Dipicu dari `SKILL.md` saat keputusan arsitektur atau saat menjalankan Challenger Mode (§4 `AGENTS.md`) terhadap pilihan stack.

## Keunggulan

| Keunggulan | Isinya |
| :--- | :--- |
| Disiplin enterprise di Node.js | DI, Interceptors, Guards, Decorator modular — mematikan spaghetti code khas JavaScript tradisional |
| Throughput I/O tinggi | Fastify engine + kompatibilitas Bun runtime, skalabilitas koneksi bersamaan ekstrem |
| Isomorfisme fullstack | Satu bahasa (TypeScript), kontrak DTO Zod/OpenAPI sinkron dari frontend sampai microservice terdalam |

## Kelemahan — WAJIB ditantangkan ke user bila kondisinya cocok

| Kelemahan | Pemicu | Tantangan yang WAJIB diajukan |
| :--- | :--- | :--- |
| Bottleneck single-thread | ≥80% beban adalah komputasi CPU-bound (matematika berat, encode video, kriptografi jutaan loop) | **TANTANG risiko bottleneck.** Sarankan pindahkan ke Rust/Go, atau jembatani lewat `napi-rs` / Piscina Worker Threads. |
| Overhead heap & cold start | Target deploy FaaS / AWS Lambda berfrekuensi panggil jarang | Tanpa bundling SWC/esbuild dan provisioned concurrency warm-up, latensi cold start menyiksa. Pertimbangkan runtime lain. |
| Type erasure di runtime | Payload eksternal masuk tanpa validasi skema | Tipe TypeScript MUSNAH saat compile. Tanpa Zod/TypeBox di pintu masuk, JSON jahat tembus ke database. |
