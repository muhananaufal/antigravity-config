---
name: meta-board
description: Gunakan saat user menyetujui sebuah panel ("gass", "setuju", "kerjakan"), menjawab pertanyaan keputusan, melempar ide untuk nanti, menerima atau mengembalikan hasil kerja, atau bertanya "dulu kita memutuskan apa soal X", "tiket apa yang masih terbuka", "sampai mana pekerjaan Y". Gunakan juga di awal sesi pada sebuah proyek, sebelum menyajikan panel baru, sebelum commit pertama sebuah pekerjaan, dan saat Anda tergoda menulis kode tanpa tiket, menandai pekerjaan selesai dari ucapan yang bukan penerimaan, atau meringkas kalimat user dengan kata-kata sendiri.
---

> **Baca berkas ini utuh sebelum memanggil `board-tools`.** Aturan yang bisa diperiksa mesin sudah dipaksa alatnya dan tidak diulang di sini; pesan penolakannya menyebut apa yang kurang. Yang tertulis di sini adalah hal yang alat tidak bisa tahu.

# meta-board — Papan Tiket dan Catatan Keputusan Lintas Proyek

Satu papan untuk semua proyek. Gunanya satu: keputusan yang sudah diambil dan pekerjaan yang sudah disetujui tidak hilang saat percakapannya selesai.

| Berkas | Isi | Dibuka saat |
| :--- | :--- | :--- |
| `scripts/board-tools.mjs` | Alatnya. Daftar perintah ada di kepala berkas. | Tidak perlu dibaca; panggil saja |
| `assets/ticket.example.json` | Tiket lengkap: keputusan user, keputusan agen, pertanyaan terbuka, semua bagian opsional | Menulis tiket pertama di sebuah sesi |
| `assets/idea.example.json`, `approval.example.json`, `decision.example.json` | Ide, persetujuan ide, jawaban atas pertanyaan terbuka | Kejadian itu muncul |

Alat dipanggil dengan `node ~/.gemini/config/skills/meta-board/scripts/board-tools.mjs <perintah>`, disingkat `board` di bawah. Data ada di `~/.aetheris/board/board.db`; halaman untuk dibaca user ada di `~/.aetheris/board/site/`.

---

## §0. Hukum

1. **Tiket satu-satunya wadah.** Keputusan, sumber, dan riwayat tinggal di dalam tiket. Tidak ada catatan keputusan di luar tiket.
2. **Kalimat user disalin apa adanya** ke `user_words` atau `--words`, termasuk singkatan dan salah ketiknya. DILARANG merapikan, menerjemahkan, atau merangkumnya. Bila satu pesan user memuat beberapa hal (persetujuan sekaligus jawaban), persetujuan tiket memakai pesan utuhnya dan tiap keputusan memakai **potongan utuh** yang menyangkut keputusan itu, tanpa mengubah satu huruf pun. Kalimat untuk hal lain BUKAN persetujuan tiket ini.
3. **Agen DILARANG menandai `done`.** Agen berhenti di `review`. `done`, pengembalian, dan `cancelled` hanya dengan kalimat user tentang tiket itu.
4. **Isi ditulis untuk dibaca manusia berbulan-bulan lagi:** kalimat lengkap dalam bahasa percakapan dengan user, tanpa singkatan internal, tanpa nama lensa atau istilah skill.
5. **Papan DILARANG disunting di luar alat**, dan halaman HTML-nya DILARANG disunting tangan.
6. **DILARANG memakai `BOARD_SKIP` atau `--no-verify`** untuk melewati penjaga commit. Itu jalan keluar user saat bekerja sendiri.
7. **DILARANG membaca seluruh papan.** `list` dan `search` dulu, `show` hanya untuk tiket yang memang dibutuhkan.

---

## §1. Kapan, dan Perintahnya

| Kejadian | Yang dilakukan |
| :--- | :--- |
| Awal sesi di sebuah proyek | `board list --project <nama-folder> --waiting`, lalu `board list --project <nama-folder> --status doing`. Sebut hasilnya ke user dalam satu atau dua baris. Kosong → tidak perlu disebut. |
| Sebelum menyajikan panel | `board search "<kata kunci>" --project <nama-folder>`. Keputusan lama yang menyangkut hal yang sama dibuka (`show`) dan disebut di panel; memutuskan ulang hal yang sudah diputuskan tanpa menyebutnya adalah cacat panel. |
| User menyetujui panel (perubahan kecil ke atas) | Tulis berkas tiket, `board add --file <berkas> --dir <root proyek>`. **Sebelum** membuat branch dan menulis kode. |
| User melempar ide yang belum mau dikerjakan | `board add` dengan `"status": "idea"`. Cukup judul dan ringkasan. |
| Ide disetujui setelah panelnya | `board approve <id> --file <berkas>` |
| Mulai mengerjakan | Pindah ke branch tiket, lalu `board set <id> --status doing` |
| User menjawab butir "perlu keputusanmu" | `board decide <id> --file <berkas>`; bila menjawab pertanyaan yang sudah tercatat, tambah `--answers K<n>` |
| Agen memutuskan sendiri karena user menyerahkan | `board decide` dengan `"decided_by": "agent"` dan `authority` berisi kalimat user yang menyerahkannya |
| Agen harus memilih sesuatu yang TIDAK pernah diserahkan user (tidak ada di panel, tidak tercakup kalimat mana pun) | Pilih yang paling mudah dibalik dan catat tetap sebagai keputusan agen, dengan `authority` berisi kalimat terdekat **dan `reason` yang terang menyebut bahwa hal ini tidak ditanyakan ke user**. Sebut ke user saat melapor. Bila pilihannya sulit dibalik: jangan memilih; catat sebagai pertanyaan terbuka dan berhenti. |
| Ada pertanyaan yang belum bisa dijawab user | `board decide` dengan `question` saja |
| Ketahuan sebuah klaim ternyata dugaan | `board unverified <id> --file <berkas>` |
| Dugaan sudah dicek | `board verify <id> U<n> --result "<apa yang ditemukan>"` |
| Dokumen dibuat untuk pekerjaan ini (PRD, handover, laporan swipe) | `board link <id> --label "<apa>" --target "<path atau URL>"` |
| Akhir sesi, pekerjaan belum selesai | `board note <id> --text "<sampai mana, apa berikutnya>"` |
| Pekerjaan selesai menurut agen | `board set <id> --status review --evidence "<perintah dan hasilnya>" --commit <hash>` |
| User menerima hasilnya | `board set <id> --status done --words "<kalimat user>"` |
| User bilang belum sesuai | Lihat §3 |
| Setiap kali ada yang berubah | `board report --out ~/.aetheris/board/site` (hanya halaman yang berubah yang ditulis ulang) |

**Yang TIDAK jadi tiket:** typo, perbaikan satu baris yang panelnya nihil, dan pertanyaan yang hanya dijawab tanpa mengubah apa pun. Bugfix menjadi tiket setelah akar masalahnya ketemu, bukan saat masih diselidiki.

**Proyek tidak didaftarkan.** Ia muncul di papan saat tiket pertamanya dicatat, dinamai menurut folder `--dir`. Berikan root repo, bukan subfolder; kalau tidak, satu proyek terpecah jadi dua. Alat menampilkannya sebagai `<folder induk>/<nama folder>` (mis. `devivace/altrms`), tetapi `--project` hanya memakai nama foldernya (`altrms`).

**Berkas tiket sementara** (`--file`) ditulis ke folder sementara atau scratch, BUKAN ke dalam repo proyek; berkas itu tidak boleh ikut ter-commit.

---

## §2. Mengisi Tiket

Contoh lengkap: `assets/ticket.example.json`. Salin bentuknya, ganti isinya.

| Kolom | Diambil dari | Yang sering salah |
| :--- | :--- | :--- |
| `title` | Permintaan user | Nama fungsi atau nama berkas sebagai judul |
| `summary` | "Yang kamu minta" di panel, 2–3 kalimat | Menulis rencana kerja, bukan apa hasilnya bagi pengguna |
| `branch` | Nama branch yang akan dibuat (`meta-git`); jenis tiket diturunkan dari awalannya | Mengisi `type` sendiri di repo git |
| `type` | HANYA untuk folder tanpa git | — |
| `done_when` | "Selesai kalau" di panel, **disalin apa adanya** | Menggantinya dengan daftar pekerjaan |
| `decisions` | Tiap butir "perlu keputusanmu" yang dijawab, dan tiap bawaan yang agen putuskan sendiri | Melewatkan keputusan agen karena "kecil"; menulis `rejected` asal ada |
| `out_of_scope` | "Yang sengaja tidak dikerjakan" di panel | Kosong padahal panel menolak sebuah perluasan |
| `unverified` | "Belum saya verifikasi" di panel, dengan cara mengeceknya | Menaruh dugaan di `sources` |
| `sources` | Klaim yang jadi dasar keputusan, dengan berkas dan baris, URL, atau perintah dan hasilnya | Sumber yang tidak dibuka sesi ini |
| `user_words` | Pesan persetujuan user | Menyalin "gass" dari persetujuan tiket lain |

**Tiga keputusan agen yang wajib dicatat**, sekecil apa pun: yang mengubah perilaku yang terlihat user, yang memilih satu dari dua cara yang sama-sama masuk akal, dan yang menyimpang dari pola repo. Pilihan nama variabel atau urutan baris tidak dicatat.

**Satu tiket = satu pekerjaan yang disetujui = satu branch.** Bukan satu sesi. Tiket yang keputusannya terus bertambah melewati belasan adalah tanda pekerjaannya terlalu besar: usulkan memecahnya dengan tiket lanjutan (`"follows": <id>`).

**Daftar permintaan berisi banyak poin.** Tiket adalah satuan yang user periksa dan terima, jadi user yang menentukan besarnya:

| User menyebut | Yang dibuat |
| :--- | :--- |
| "jadikan satu branch" / "satu saja" | Satu tiket. Tiap poin menjadi satu baris `done_when`, dikelompokkan per fitur; commit per kelompok; `note` per kelompok yang selesai. Kalimat user soal branch dicatat sebagai keputusannya. |
| "pisah per domain" / "per fitur" | Satu tiket dan satu branch per kelompok. Pembagiannya (tiket mana memuat poin mana) ditampilkan di panel sebelum disetujui. |
| Tidak menyebut apa-apa | Usulkan pembagiannya di panel dan tunggu. DILARANG memilih diam-diam. Patokan usulnya: poin yang bisa diterima atau dikembalikan sendiri-sendiri dipisah; poin yang baru berarti bila semuanya jadi digabung. |

Satu tiket per poin hampir tidak pernah tepat: tiap tiket terbuka butuh branch sendiri. Poin yang sepele (ganti label, perbaiki typo) ikut ke tiket kelompoknya, bukan berdiri sendiri.

---

## §3. Perpindahan Status

| Dari → ke | Siapa | Syarat (yang tidak diperiksa alat dicetak tebal) |
| :--- | :--- | :--- |
| `idea` → `ready` | User, lewat `approve` | Panel sudah disajikan; **kalimatnya memang menyetujui ide ini** |
| `ready` → `doing` | Agen | Repo sedang di branch tiket |
| `doing` → `review` | Agen | Bukti dan commit; tidak ada dugaan terbuka; **test dan linter sudah dijalankan segar** (`AGENTS.md` §5.7) |
| `review` → `done` | User | **Kalimat user menerima tiket ini**, bukan "oke lanjut" untuk hal lain |
| `review` / `done` → `doing` | User | Alasan dan kalimat user. Lihat aturan di bawah |
| apa pun → `cancelled` | User | Alasan |

**Dikembalikan atau tiket baru?** Satu pertanyaan: apakah `done_when`-nya berubah?

- **Tidak berubah** (hasilnya belum memenuhi yang disepakati) → tiket yang sama dikembalikan: `board set <id> --status doing --reason "<apa yang kurang>" --words "<kalimat user>"`.
- **Berubah atau bertambah** (user ingin hal yang berbeda) → tiket baru dengan `"follows": <id>`, lewat panel seperti biasa. Tiket lama tetap `done`.

Ragu → tanyakan ke user, dengan menyebut butir `done_when` yang dimaksud.

---

## §4. Penjaga Commit

Di proyek yang dipasangi, commit di branch kerja tanpa tiket `doing` atau `review` ditolak git.

- **Menawarkan pemasangan:** sekali, saat proyek pertama kali masuk papan dan foldernya repo git. Setelah user setuju: `board hook install --dir <root proyek>`.
- **Sudah ada hook lain:** alat berhenti dan menyebut tiga pilihan (`chain`, `replace`, `skip`). **User yang memilih**; sampaikan pilihannya, jangan memutuskan sendiri.
- **Commit ditolak penjaga:** itu tanda tiketnya belum dicatat atau belum dimulai. Catat atau mulai tiketnya. DILARANG melewati (§0 butir 6).

---

## §5. Kasus Tepi

| Situasi | Yang dilakukan |
| :--- | :--- |
| Sesi terputus sebelum tiket dicatat | Sesi berikutnya mencatatnya dari transcript, dengan kalimat user yang asli. Tidak ada transcript → tanya user, jangan mengarang `user_words`. |
| Pekerjaan ternyata lebih besar dari tiketnya | Berhenti, kembali ke panel (`AGENTS.md` §5.6). Cakupan tambahan = tiket lanjutan, bukan `done_when` yang ditambah diam-diam. |
| Keputusan lama ternyata salah | Keputusan lama TIDAK diubah. Catat keputusan baru yang menyebut nomor keputusan yang digantikannya dan alasannya. |
| Dua sesi menyentuh tiket yang sama | Baca `show` sebelum menulis; catatan sesi lain ada di riwayat. |
| User memutuskan sesuatu tanpa ada tiketnya | Keputusan butuh tiket. Bila pekerjaannya belum disetujui, catat sebagai ide dengan keputusannya di dalam. |
| Folder tanpa git | Tanpa `branch`; isi `type`. Bukti `review` berupa kalimat, tanpa `--commit`. |
| Alat menolak dan pesannya tidak jelas | Jangan mencoba variasi sampai lolos. Baca kepala `board-tools.mjs`; masih buntu → lapor ke user. |
| Papan tidak bisa dibuka | Lapor ke user. DILARANG melanjutkan dengan mencatat "nanti saja". |

---

## §6. Sebelum Melapor ke User

```
[ ] Tiket dicatat SEBELUM kode ditulis
[ ] user_words dan --words adalah salinan huruf demi huruf, dari pesan tentang tiket ini
[ ] Tiap "perlu keputusanmu" yang dijawab ada di decisions; tiap bawaan saya ada sebagai keputusan agen
[ ] rejected berisi pilihan yang benar-benar dipertimbangkan
[ ] Dugaan ada di unverified, bukan di sources
[ ] Status tiket sesuai keadaan sebenarnya; saya tidak menandai done
[ ] Sesi berakhir di tengah pekerjaan → ada note
[ ] Halaman dibuat ulang (report)
[ ] Nomor tiket disebut ke user
```
