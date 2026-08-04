# ADR — Architecture Decision Records

> **Berlaku:** Go 1.21+ · **Lihat juga:** `engineering_practice/technical_design_doc.md` · `engineering_practice/code_review_go.md` · `arch_patterns/clean_hexagonal_architecture.md`

## Konsep Utama

Kode memberi tahu Anda **apa** yang dilakukan sistem. Git blame memberi tahu **siapa** dan **kapan**. Tidak satu pun memberi tahu **mengapa** — dan "mengapa" adalah satu-satunya hal yang tidak bisa direkonstruksi dari artefak yang tersisa.

ADR adalah catatan pendek yang membekukan konteks sebuah keputusan **pada saat keputusan itu diambil**, sebelum konteksnya menguap. Satu berkas, satu keputusan, ditulis sekali dan tidak pernah diedit — hanya digantikan (*superseded*).

Kesalahpahaman paling umum: mengira ADR mendokumentasikan **pilihan**. Yang bernilai justru **penolakannya**.

> Enam bulan kemudian, seorang engineer baru akan melihat kode Anda dan berpikir *"kenapa tidak pakai X saja, kan lebih sederhana?"*. Kalau ADR Anda tidak menjawabnya, dia akan menghabiskan dua minggu membuktikan bahwa X memang tidak bisa — pelajaran yang Anda sudah bayar setahun lalu.

**Inilah pembeda level.** Engineer mid menulis: *"Kami memilih PostgreSQL."* Engineer senior menulis: *"Kami memilih PostgreSQL. DynamoDB ditolak karena pola query kami membutuhkan join lintas empat entitas dan tim belum punya pengalaman operasional NoSQL. Keputusan ini WAJIB ditinjau ulang bila volume tulis melewati 50k/detik atau bila kami merekrut SRE berpengalaman DynamoDB."*

Kalimat terakhir itu — **pemicu peninjauan ulang** — yang paling sering hilang, dan paling berharga. Tanpanya, ADR berubah jadi dogma: tim mewarisi keputusan tanpa tahu kondisi apa yang membuatnya kedaluwarsa.

### Anatomi ADR (format MADR yang dipersempit)

| Bagian | Isi | Wajib |
| :--- | :--- | :---: |
| **Status** | `proposed` · `accepted` · `superseded by ADR-00X` · `deprecated` | ✅ |
| **Konteks** | Kekuatan yang menekan: batasan teknis, waktu, tim, regulasi | ✅ |
| **Keputusan** | Satu kalimat aktif: "Kami akan…" | ✅ |
| **Alternatif Ditolak** | Tiap alternatif + alasan penolakan yang spesifik | ✅ |
| **Konsekuensi** | Yang jadi lebih mudah **dan** yang jadi lebih sulit | ✅ |
| **Pemicu Tinjau Ulang** | Kondisi terukur yang membatalkan keputusan ini | ✅ |

## Diagram ASCII

```text
   SIKLUS HIDUP ADR — berkas TIDAK PERNAH diedit, hanya digantikan

   ADR-004 "Pakai PostgreSQL"          ADR-011 "Pindah ke Citus"
   status: accepted                    status: accepted
   +--------------------+              +--------------------+
   | Konteks            |              | Konteks            |
   | Keputusan          |   supersedes | - volume tulis 70k |
   | Alternatif ditolak |<-------------|   melewati pemicu  |
   |  - DynamoDB (join) |              |   di ADR-004       |
   | Konsekuensi        |              | Keputusan          |
   | Pemicu tinjau:     |              | Alternatif ditolak |
   |  > 50k tulis/detik |              | Konsekuensi        |
   +--------------------+              +--------------------+
   status DIUBAH jadi:                          |
   "superseded by ADR-011"                      v
                                        pemicu baru lagi...

   BENAR : riwayat utuh, alasan lama tetap terbaca
   SALAH : mengedit ADR-004 langsung -> konteks 2024 hilang selamanya
```

## Kode Go Production-Ready

`adrlint` — memvalidasi seluruh direktori ADR, mendeteksi rantai *supersede* yang rusak, dan membangun indeks. Dipasang di CI supaya ADR yang cacat tidak pernah masuk `main`.

```go
package adr

import (
	"bufio"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Status adalah keadaan sebuah ADR dalam siklus hidupnya.
type Status string

const (
	StatusProposed   Status = "proposed"
	StatusAccepted   Status = "accepted"
	StatusSuperseded Status = "superseded"
	StatusDeprecated Status = "deprecated"
)

// Record adalah satu ADR yang sudah diurai.
type Record struct {
	ID           int      // 4 dari "0004-pakai-postgresql.md"
	Path         string
	Title        string
	Status       Status
	SupersededBy int      // 0 bila tidak ada
	Supersedes   []int
	Sections     map[string]bool
}

// wajibSection adalah bagian yang HARUS ada pada setiap ADR.
// Tanpa "Alternatif Ditolak" dan "Pemicu Tinjau Ulang", ADR hanya jadi
// pengumuman, bukan catatan keputusan.
var wajibSection = []string{
	"Konteks", "Keputusan", "Alternatif Ditolak", "Konsekuensi", "Pemicu Tinjau Ulang",
}

var (
	reFilename = regexp.MustCompile(`^(\d{4})-[a-z0-9-]+\.md$`)
	reStatus   = regexp.MustCompile(`(?i)^\s*-?\s*\*{0,2}status\*{0,2}\s*:\s*(.+?)\s*$`)
	reSupBy    = regexp.MustCompile(`(?i)superseded\s+by\s+ADR-(\d{1,4})`)
	reSupersedes = regexp.MustCompile(`(?i)supersedes\s+ADR-(\d{1,4})`)
	reHeading  = regexp.MustCompile(`^##+\s+(.+?)\s*$`)
	reTitle    = regexp.MustCompile(`^#\s+(.+?)\s*$`)
)

// ErrInvalidName ditandai bila nama berkas tidak mengikuti pola NNNN-judul.md.
var ErrInvalidName = errors.New("adr: nama berkas harus NNNN-judul-kebab.md")

// ParseFile mengurai satu berkas ADR menjadi Record.
func ParseFile(fsys fs.FS, path string) (Record, error) {
	base := filepath.Base(path)
	m := reFilename.FindStringSubmatch(base)
	if m == nil {
		return Record{}, fmt.Errorf("%s: %w", base, ErrInvalidName)
	}
	var id int
	if _, err := fmt.Sscanf(m[1], "%d", &id); err != nil {
		return Record{}, fmt.Errorf("%s: id tidak terbaca: %w", base, err)
	}

	f, err := fsys.Open(path)
	if err != nil {
		return Record{}, fmt.Errorf("buka %s: %w", path, err)
	}
	defer f.Close()

	rec := Record{ID: id, Path: path, Sections: map[string]bool{}}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	inFence := false

	for sc.Scan() {
		line := sc.Text()

		// Abaikan isi blok kode: heading di dalamnya bukan section ADR.
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}

		if rec.Title == "" {
			if t := reTitle.FindStringSubmatch(line); t != nil {
				rec.Title = t[1]
				continue
			}
		}
		if h := reHeading.FindStringSubmatch(line); h != nil {
			rec.Sections[normalize(h[1])] = true
			continue
		}
		if s := reStatus.FindStringSubmatch(line); s != nil && rec.Status == "" {
			raw := strings.ToLower(s[1])
			switch {
			case strings.Contains(raw, "superseded"):
				rec.Status = StatusSuperseded
			case strings.Contains(raw, "deprecated"):
				rec.Status = StatusDeprecated
			case strings.Contains(raw, "accepted"):
				rec.Status = StatusAccepted
			case strings.Contains(raw, "proposed"):
				rec.Status = StatusProposed
			}
		}
		if b := reSupBy.FindStringSubmatch(line); b != nil {
			fmt.Sscanf(b[1], "%d", &rec.SupersededBy)
		}
		if s := reSupersedes.FindStringSubmatch(line); s != nil {
			var n int
			fmt.Sscanf(s[1], "%d", &n)
			rec.Supersedes = append(rec.Supersedes, n)
		}
	}
	if err := sc.Err(); err != nil {
		return Record{}, fmt.Errorf("baca %s: %w", path, err)
	}
	return rec, nil
}

func normalize(s string) string {
	return strings.TrimSpace(strings.ToLower(s))
}

// Finding adalah satu pelanggaran yang ditemukan linter.
type Finding struct {
	Path string
	Msg  string
}

func (f Finding) String() string { return f.Path + ": " + f.Msg }

// Lint memuat seluruh ADR lalu memvalidasinya sebagai satu kesatuan graf.
func Lint(fsys fs.FS, dir string) ([]Record, []Finding, error) {
	var recs []Record
	err := fs.WalkDir(fsys, dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(p, ".md") || strings.HasSuffix(p, "README.md") {
			return nil
		}
		r, perr := ParseFile(fsys, p)
		if perr != nil {
			// Nama berkas salah tetap dilaporkan, bukan menghentikan seluruh lint.
			recs = append(recs, Record{Path: p})
			return nil
		}
		recs = append(recs, r)
		return nil
	})
	if err != nil {
		return nil, nil, fmt.Errorf("telusuri %s: %w", dir, err)
	}

	sort.Slice(recs, func(i, j int) bool { return recs[i].ID < recs[j].ID })

	byID := make(map[int]*Record, len(recs))
	for i := range recs {
		if recs[i].ID != 0 {
			byID[recs[i].ID] = &recs[i]
		}
	}

	var out []Finding
	seenID := map[int]string{}

	for i := range recs {
		r := &recs[i]
		if r.ID == 0 {
			out = append(out, Finding{r.Path, "nama berkas tidak mengikuti pola NNNN-judul-kebab.md"})
			continue
		}
		if prev, dup := seenID[r.ID]; dup {
			out = append(out, Finding{r.Path, "ID ganda dengan " + prev})
		}
		seenID[r.ID] = r.Path

		if r.Status == "" {
			out = append(out, Finding{r.Path, "status tidak ditemukan"})
		}
		for _, s := range wajibSection {
			if !r.Sections[normalize(s)] {
				out = append(out, Finding{r.Path, "bagian wajib hilang: " + s})
			}
		}
		// Rantai supersede WAJIB dua arah dan menunjuk berkas yang ada.
		if r.SupersededBy != 0 {
			target, ok := byID[r.SupersededBy]
			switch {
			case !ok:
				out = append(out, Finding{r.Path, fmt.Sprintf("superseded by ADR-%04d yang tidak ada", r.SupersededBy)})
			case !contains(target.Supersedes, r.ID):
				out = append(out, Finding{target.Path, fmt.Sprintf("harus menyatakan supersedes ADR-%04d", r.ID)})
			}
			if r.Status != StatusSuperseded {
				out = append(out, Finding{r.Path, "punya superseded-by tapi status bukan superseded"})
			}
		}
		if r.Status == StatusSuperseded && r.SupersededBy == 0 {
			out = append(out, Finding{r.Path, "status superseded tapi tidak menyebut penggantinya"})
		}
	}
	return recs, out, nil
}

func contains(xs []int, v int) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

// Index membangun daftar ADR aktif untuk README, mengurutkan dari terbaru.
func Index(recs []Record) string {
	var b strings.Builder
	b.WriteString("| ADR | Judul | Status |\n| ---: | :--- | :--- |\n")
	for i := len(recs) - 1; i >= 0; i-- {
		r := recs[i]
		if r.ID == 0 {
			continue
		}
		fmt.Fprintf(&b, "| [%04d](%s) | %s | %s |\n", r.ID, filepath.Base(r.Path), r.Title, r.Status)
	}
	return b.String()
}
```

## Uji

```go
package adr

import (
	"testing"
	"testing/fstest"
)

const adrLengkap = `# Pakai PostgreSQL sebagai penyimpan utama

- Status: accepted

## Konteks
Beban baca dominan, join lintas empat entitas.

## Keputusan
Kami akan memakai PostgreSQL 16.

## Alternatif Ditolak
- DynamoDB: pola query butuh join, tim belum punya pengalaman operasional.

## Konsekuensi
Lebih mudah: query ad-hoc. Lebih sulit: sharding horizontal nanti.

## Pemicu Tinjau Ulang
Volume tulis melewati 50k/detik.
`

func TestLint(t *testing.T) {
	t.Run("adr lengkap tidak menghasilkan temuan", func(t *testing.T) {
		fsys := fstest.MapFS{"adr/0004-pakai-postgresql.md": {Data: []byte(adrLengkap)}}
		_, f, err := Lint(fsys, "adr")
		if err != nil {
			t.Fatalf("tak terduga: %v", err)
		}
		if len(f) != 0 {
			t.Fatalf("mau nol temuan, dapat %v", f)
		}
	})

	t.Run("bagian wajib hilang terdeteksi", func(t *testing.T) {
		tanpaAlternatif := "# X\n\n- Status: accepted\n\n## Konteks\na\n\n## Keputusan\nb\n\n## Konsekuensi\nc\n\n## Pemicu Tinjau Ulang\nd\n"
		fsys := fstest.MapFS{"adr/0001-x.md": {Data: []byte(tanpaAlternatif)}}
		_, f, _ := Lint(fsys, "adr")
		if len(f) != 1 {
			t.Fatalf("mau 1 temuan, dapat %v", f)
		}
	})

	t.Run("rantai supersede satu arah terdeteksi", func(t *testing.T) {
		lama := "# Lama\n\n- Status: superseded by ADR-0002\n\n## Konteks\na\n\n## Keputusan\nb\n\n## Alternatif Ditolak\nc\n\n## Konsekuensi\nd\n\n## Pemicu Tinjau Ulang\ne\n"
		baru := "# Baru\n\n- Status: accepted\n\n## Konteks\na\n\n## Keputusan\nb\n\n## Alternatif Ditolak\nc\n\n## Konsekuensi\nd\n\n## Pemicu Tinjau Ulang\ne\n"
		fsys := fstest.MapFS{
			"adr/0001-lama.md": {Data: []byte(lama)},
			"adr/0002-baru.md": {Data: []byte(baru)},
		}
		_, f, _ := Lint(fsys, "adr")
		if len(f) == 0 {
			t.Fatal("mau temuan karena ADR-0002 tidak menyatakan supersedes")
		}
	})

	t.Run("heading di dalam blok kode tidak dihitung section", func(t *testing.T) {
		palsu := "# X\n\n- Status: accepted\n\n## Konteks\na\n\n" + "```" + "\n## Alternatif Ditolak\n" + "```" + "\n\n## Keputusan\nb\n\n## Konsekuensi\nc\n\n## Pemicu Tinjau Ulang\nd\n"
		fsys := fstest.MapFS{"adr/0001-x.md": {Data: []byte(palsu)}}
		_, f, _ := Lint(fsys, "adr")
		if len(f) != 1 {
			t.Fatalf("heading dalam fence seharusnya diabaikan, dapat %v", f)
		}
	})

	t.Run("nama berkas salah ditolak", func(t *testing.T) {
		fsys := fstest.MapFS{"adr/keputusan-db.md": {Data: []byte(adrLengkap)}}
		_, f, _ := Lint(fsys, "adr")
		if len(f) != 1 {
			t.Fatalf("mau 1 temuan nama berkas, dapat %v", f)
		}
	})
}
```

## Anti-Pattern

**❌ SALAH — ADR ditulis setelah kode selesai, sebagai formalitas**

```markdown
## Keputusan
Kami memakai Kafka.

## Konsekuensi
Sistem jadi event-driven.
```

Ini bukan ADR, ini pengumuman. Tidak ada konteks yang menekan, tidak ada alternatif, tidak ada kondisi kedaluwarsa. Enam bulan lagi tidak ada yang tahu apakah Kafka dipilih karena analisis atau karena satu orang sedang ingin mencobanya. Ditulis belakangan juga berarti keputusannya tidak pernah benar-benar ditantang — yang justru inti dari proses ini.

**✅ BENAR — ditulis SEBELUM implementasi, memuat penolakan dan pemicu**

```markdown
## Konteks
Order service memancarkan 8k event/detik saat puncak. Konsumen: 3 tim, dua di
antaranya butuh replay 7 hari ke belakang untuk rekonsiliasi.

## Keputusan
Kami akan memakai Kafka dengan retensi 7 hari pada topik `orders.v1`.

## Alternatif Ditolak
- **NATS JetStream**: replay tersedia, tapi tim SRE belum punya runbook dan
  kami butuh produksi dalam 6 minggu.
- **Postgres outbox + polling**: cukup untuk 8k/detik, TAPI tiga konsumen
  independen berarti tiga polling loop yang bersaing memperebutkan tabel yang sama.
- **AWS Kinesis**: retensi 7 hari mahal pada volume ini, dan kami on-prem.

## Konsekuensi
Lebih mudah: konsumen baru tinggal subscribe tanpa mengubah producer.
Lebih sulit: kami sekarang mengoperasikan Kafka — butuh 1 SRE terlatih dan
runbook untuk rebalance, ISR shrink, dan disk penuh.

## Pemicu Tinjau Ulang
- Volume turun di bawah 500 event/detik selama 3 bulan (Kafka jadi berlebihan).
- Jumlah konsumen kembali menjadi satu.
- Tim SRE kehilangan satu-satunya orang yang paham Kafka.
```

**❌ SALAH — mengedit ADR lama ketika keputusan berubah**

```bash
# Konteks 2024 hilang selamanya. Riwayat penalaran terhapus.
vim docs/adr/0004-pakai-postgresql.md   # ubah "PostgreSQL" jadi "Citus"
```

**✅ BENAR — ADR baru yang menggantikan, keduanya tetap ada**

```bash
# ADR lama HANYA diubah barisan statusnya.
# docs/adr/0004: "- Status: superseded by ADR-0011"
# docs/adr/0011: "- Status: accepted" + "Supersedes ADR-0004"
# Alasan 2024 tetap terbaca, termasuk pemicu yang ternyata benar-benar tercapai.
```

## Kasus Tepi Produksi

1. **Keputusan yang diwarisi tanpa ADR.** Sistem lama penuh keputusan tak tertulis. Menulis ADR retroaktif untuk semuanya adalah pemborosan. Tulis ADR retroaktif **hanya saat keputusan itu sedang ditantang** — konteksnya jadi hidup, dan hasilnya langsung dipakai. Beri penanda `Status: accepted (direkonstruksi <tanggal>)` supaya pembaca tahu konteksnya hasil ingatan, bukan catatan waktu itu.

2. **Keputusan lintas repo.** ADR di repo mana? Aturan praktis: di repo yang **paling menderita** bila keputusan itu salah. Untuk keputusan lintas tim, buat repo `architecture-decisions` terpisah, dan dari repo pelaksana cukup tautkan. Menyalin ADR ke banyak repo menciptakan versi yang menyimpang diam-diam.

3. **Rantai supersede bercabang.** ADR-004 digantikan ADR-011 untuk service A, tapi service B masih memakai keputusan lama. Jangan paksakan satu rantai linear — pecah lingkupnya sejak awal (`ADR-004: penyimpan untuk order-service`), bukan lingkup global yang kemudian tidak bisa digantikan sebagian.

4. **ADR yang ditolak.** Proposal yang tidak jadi diambil tetap WAJIB disimpan dengan `Status: rejected` dan alasannya. Tanpa itu, ide yang sama akan diusulkan ulang tiap enam bulan oleh orang berbeda, dan tim membayar ongkos diskusinya berulang kali.

5. **Nomor bentrok saat kerja paralel.** Dua PR bersamaan sama-sama membuat `0012-*.md`. Linter di atas mendeteksinya (`ID ganda`), tapi pencegahan lebih baik: ambil nomor saat **membuka PR**, bukan saat mulai menulis, dan jadikan `adrlint` sebagai gate CI yang wajib hijau.

## Kapan JANGAN Pakai Ini

- **Keputusan pintu dua arah.** Kalau membalikkannya butuh kurang dari sehari, ADR-nya lebih mahal daripada keputusannya. Pilih library HTTP router tidak butuh ADR; memilih model konsistensi data butuh.
- **Sebagai gerbang persetujuan.** Begitu ADR jadi syarat formal sebelum boleh ngoding, orang akan menulisnya belakangan agar lolos — dan Anda kehilangan seluruh manfaatnya sambil tetap membayar ongkos birokrasinya.
- **Detail implementasi.** Nama fungsi, struktur folder, gaya kode: itu wilayah code review dan linter, bukan ADR. ADR yang mencatat hal remeh akan membuat ADR penting tenggelam.
- **Ketika tidak ada alternatif nyata.** Kalau hanya satu opsi yang mungkin, tidak ada keputusan yang diambil — cukup komentar di kode.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Debat yang sama berulang tiap kuartal | riwayat diskusi di PR/chat | Keputusan tidak pernah dicatat, atau ADR-nya tidak bisa ditemukan |
| Reviewer bertanya "kenapa begini?" pada pola yang sudah baku | komentar review berulang di area yang sama | ADR ada tapi tidak ditautkan dari kode; sematkan `// lihat ADR-0011` di titik masuk modul |
| ADR terakhir berumur >12 bulan pada sistem yang aktif berubah | `ls -lt docs/adr \| head` | Praktiknya sudah mati; keputusan diambil tapi tidak dicatat |
| Semua ADR berstatus `accepted`, nol `superseded`/`rejected` | keluaran `adrlint` | Dokumentasi teater — ditulis untuk terlihat rapi, bukan untuk dipakai |

```bash
# Berapa keputusan yang ditulis dalam 90 hari terakhir?
git log --since="90 days ago" --diff-filter=A --name-only -- docs/adr | grep -c '\.md$'

# Cari ADR yang pemicu tinjau ulangnya kemungkinan sudah tercapai
grep -l "Pemicu Tinjau Ulang" docs/adr/*.md | xargs grep -A3 "Pemicu Tinjau Ulang"

# Gate CI
go run ./cmd/adrlint -dir docs/adr || exit 1
```
