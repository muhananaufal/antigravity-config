# Trade-Off Laravel — Kapan Pakai, Kapan Hindari

> Dipicu dari `SKILL.md` saat keputusan arsitektur atau saat menjalankan Challenger Mode (§4 `AGENTS.md`) terhadap pilihan stack.
> Pemilihan bahasa tetap melewati `skills/master-decision-tree/SKILL.md` BAGIAN 1 lebih dulu — berkas ini melengkapi keputusan itu dengan amunisi tantangan, bukan menggantikannya.

## Keunggulan — dan kapan ia benar-benar menentukan

| Keunggulan | Pemicu (kapan ini jadi alasan memilih Laravel) | Konsekuensi praktis |
| :--- | :--- | :--- |
| Time-to-market tercepat | Rilis < 4 minggu, tim 1–3 orang | Constraint dominan di mayoritas proyek nyata, dan satu-satunya keunggulan yang sering mengalahkan semua argumen performa |
| Ekosistem first-party terlengkap | Butuh admin panel, billing berlangganan, queue, atau WebSocket **cepat** | Filament/Nova, Cashier, Horizon, Reverb — semuanya first-party dan saling terpasang, bukan rakitan pihak ketiga |
| Monolit full-stack satu deploy | Backend + frontend satu repo, satu pipeline, tim tanpa DevOps khusus | Inertia/Livewire menghapus seluruh lapisan kontrak API internal beserta biaya sinkronisasinya |

## Kelemahan — WAJIB ditantangkan ke user bila pemicunya cocok

| Kelemahan | Pemicu | Tantangan yang WAJIB diajukan |
| :--- | :--- | :--- |
| Tidak ada fire-and-forget native | Ada tugas asinkron **apa pun**, sekecil apa pun | **Proses PHP mati setelah response** (`LEARNED.md`). Tidak ada padanan `go func()`. **TANTANG** setiap asumsi "ini ringan, jalankan saja di belakang": di Laravel itu mustahil. WAJIB masuk Queue + Horizon walau tugasnya sepele. |
| Nol paralelisme dalam proses | CPU-bound: enkode video, olah gambar massal, kriptografi berulang | **TANTANG**: satu request = satu proses, tanpa thread. Delegasikan ke queue worker, atau potong modul itu ke Go/Rust dan panggil lewat antrean. Menaikkan spesifikasi server tidak menyelesaikannya. |
| Throughput per-instance terbatas | Target > 50k req/s atau p99 < 10 ms | **TANTANG pilihan stack.** Octane/FrankenPHP menaikkan langit-langitnya secara berarti, tapi tidak mengubah kelasnya. Bila angka itu keras, ini keputusan bahasa, bukan tuning. |
| Octane melahirkan kelas bug baru | Memakai Octane/Swoole | Properti `static` dan singleton stateful bocor **antar-request** — bug yang tidak pernah ada di php-fpm. **TANTANG**: audit state leak wajib masuk rencana, bukan opsional. |

## Garis Merah — JANGAN pakai Laravel bila

1. **p99 < 10 ms atau > 50k req/s adalah kebutuhan keras**, bukan aspirasi → Go atau Rust (`master-decision-tree` NODE 1.1 cabang B).
2. Beban intinya **CPU-bound berkelanjutan**, bukan I/O-bound — tidak ada jumlah worker yang memperbaiki ketiadaan paralelisme dalam proses.
3. Deliverable-nya **CLI terdistribusi atau tooling infrastruktur** — distribusi biner PHP adalah kerugian permanen di sini → Go.
