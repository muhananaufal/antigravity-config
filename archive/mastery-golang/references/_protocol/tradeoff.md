# Trade-Off Go — Kapan Pakai, Kapan Hindari

> Dipicu dari `SKILL.md` saat keputusan arsitektur atau saat menjalankan Challenger Mode (§4 `AGENTS.md`) terhadap pilihan stack.
> Pemilihan bahasa tetap melewati `skills/meta-decision/SKILL.md` BAGIAN 1 lebih dulu — berkas ini melengkapi keputusan itu dengan amunisi tantangan, bukan menggantikannya.

## Keunggulan — dan kapan ia benar-benar menentukan

| Keunggulan | Pemicu (kapan ini jadi alasan memilih Go) | Konsekuensi praktis |
| :--- | :--- | :--- |
| Konkurensi murah | Beban I/O-bound konkuren tinggi: >10k koneksi hidup, fan-out ke banyak service | Goroutine ~4KB dengan penjadwal M:N — `go func()` bukan keputusan berat seperti thread OS |
| Biner statis, deploy sepele | Target `distroless`/`scratch`, CLI terdistribusi, K8s Operator, tooling DevOps | Bahasa ibu Kubernetes/Docker/Terraform: ekosistem control-plane sudah berbicara Go |
| Rasio performa/produktivitas | Butuh >50k req/s **tanpa** jaminan memory-safety tingkat regulasi | Mendekati Rust dalam throughput, jauh lebih cepat ditulis dan di-onboard |

## Kelemahan — WAJIB ditantangkan ke user bila pemicunya cocok

| Kelemahan | Pemicu | Tantangan yang WAJIB diajukan |
| :--- | :--- | :--- |
| Ekspresivitas tipe terbatas | Domain dengan state machine kaya, banyak varian, invariant ketat | Go tidak punya sum type / exhaustive match. **TANTANG**: bila korektnes tipe krusial (ledger, protokol), sarankan Rust. Bila tetap Go, wajibkan sentinel error + linter kustom sebagai ganti. |
| Error handling verbose & mudah ditelan | Tim besar atau banyak anggota junior | `if err != nil` gampang jadi ritual kosong. **TANTANG**: wajibkan `errors.As`/sentinel + `%w` wrapping, dan gate linter. Tanpa itu, kesalahan hilang diam-diam. |
| Ekosistem admin/CMS tipis | Deliverable utamanya admin panel, CRUD internal, atau dashboard operasional | **TANTANG keras**: Go tidak punya padanan Filament/Nova. Membangunnya dari nol membakar berminggu-minggu. Sarankan Laravel + Filament untuk lapisan itu, Go untuk layanan yang benar-benar butuh throughput. |
| GC tetap ada | Target latensi p99 di bawah 1 ms, atau hard real-time deterministik | Go punya GC berjeda rendah, tapi tetap GC. **TANTANG**: untuk deterministik keras, itu wilayah Rust. |

> **Catatan koreksi (`LEARNED.md`):** DILARANG berargumen "Go tidak punya runtime reflection".
> Go **punya** `reflect` di stdlib dan dipakai berat oleh `encoding/json`, GORM, dan validator.
> Yang benar: komunitasnya menghindarinya demi performa.

## Garis Merah — JANGAN pakai Go bila

1. **Hard real-time deterministik dibutuhkan** — jeda GC tidak bisa dinegosiasikan → Rust.
2. **Deliverable utamanya admin panel / CMS / CRUD internal** dengan tenggat pendek → Laravel + Filament.
3. **Tidak ada satu pun anggota tim yang pernah menjalankan Go di produksi** dan tenggat < 4 minggu → time-to-market jadi constraint dominan; lihat `meta-decision` NODE 1.1 cabang A.
