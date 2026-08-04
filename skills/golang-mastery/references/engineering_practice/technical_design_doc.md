# Technical Design Doc — Menulis untuk Ditolak

> **Berlaku:** Go 1.21+ · **Lihat juga:** `engineering_practice/adr_decision_records.md` · `engineering_practice/slo_error_budget.md` · `arch_patterns/modular_monolith_go.md`

## Konsep Utama

Design doc bukan dokumentasi. Dokumentasi menjelaskan sistem yang **sudah ada**; design doc adalah alat untuk **mendapatkan penolakan semurah mungkin**, sebelum kode ditulis.

Ini pergeseran cara pandang yang membedakan level. Engineer mid menulis design doc untuk **meyakinkan** — menjual rencananya. Engineer senior menulis untuk **diserang** — mengundang orang menemukan cacatnya selagi ongkos perubahannya masih nol.

> Ongkos mengubah keputusan: di dokumen ≈ 1 jam · di kode ≈ 1 minggu · di produksi ≈ 1 kuartal + insiden.

Konsekuensinya konkret: bagian paling berharga dari design doc Anda adalah **"Yang Bisa Salah"** dan **"Alternatif"**. Kalau kedua bagian itu tipis, dokumennya adalah brosur, bukan desain.

### Design doc vs ADR

Keduanya sering dikira sama. Bedanya jelas dan penting:

| | Design Doc | ADR |
| :--- | :--- | :--- |
| Lingkup | Satu fitur/sistem utuh | Satu keputusan tunggal |
| Umur | Hidup selama perancangan, lalu jadi arsip | Abadi, tidak pernah diedit |
| Isi | Rencana, alternatif, risiko, tahapan | Konteks, keputusan, penolakan, pemicu tinjau |
| Setelah selesai | Keputusan pentingnya **diekstrak jadi ADR** | Berdiri sendiri |

Alur yang benar: design doc → diskusi → beberapa ADR lahir darinya → implementasi. Design doc boleh basi; ADR tidak.

### Kerangka yang berfungsi

| Bagian | Pertanyaan yang dijawab | Sering dilewati? |
| :--- | :--- | :---: |
| **Masalah** | Apa yang rusak sekarang, dan bagaimana kita mengukurnya? | |
| **Bukan Tujuan** | Apa yang sengaja TIDAK dikerjakan? | ✅ sering |
| **Rancangan** | Bagaimana bentuknya — diagram, kontrak, alur data | |
| **Alternatif** | Apa lagi yang dipertimbangkan, kenapa kalah? | ✅ sering |
| **Yang Bisa Salah** | Mode kegagalan, blast radius, mitigasi | ✅ **paling sering** |
| **Tahapan & Rollback** | Bagaimana dirilis bertahap, bagaimana dibatalkan? | ✅ sering |
| **Dampak SLO** | Bagaimana error budget berubah? | ✅ hampir selalu |
| **Ongkos** | Infra, waktu tim, beban operasional baru | |

**Bukan Tujuan** adalah bagian dengan rasio nilai-per-kata tertinggi. Satu kalimat *"Migrasi data historis di luar lingkup — akan ditangani terpisah"* mencegah dua minggu salah paham.

## Diagram ASCII

```text
   ONGKOS PERUBAHAN vs TAHAP  (kenapa dokumen dulu)

   ongkos
     ^
     |                                        ####
     |                                  ####  ####
     |                            ####  ####  ####
     |                #####       ####  ####  ####
     |   #            #####       ####  ####  ####
     +---+------------+-----------+-----+-----+----> tahap
       dokumen      prototipe    kode  rilis produksi
        1 jam        1 hari     1 mgg  1 bln  1 kuartal + insiden

   Design doc bekerja bila orang MENEMUKAN CACAT di kolom pertama.
   Doc yang tidak pernah dikritik = doc yang tidak dibaca.

   ---------------------------------------------------------------

   SIKLUS: DOC -> ADR -> KODE

   +-------------------+
   | Design Doc        |  lingkup luas, umur pendek
   | "Pipeline Order"  |
   +-------------------+
       |        |
       v        v
   +--------+ +--------+
   | ADR-14 | | ADR-15 |   keputusan tunggal, abadi
   | outbox | | Kafka  |
   +--------+ +--------+
       |        |
       +---+----+
           v
     kode + tautan `// lihat ADR-0014`
```

## Kode Go Production-Ready

`designlint` — memvalidasi struktur design doc dan, yang paling penting, **menolak dokumen yang bagian risikonya kosong**. Dipasang di CI agar dokumen tidak lolos hanya karena rapi di permukaan.

```go
package designdoc

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode"
)

// Section adalah satu bagian dokumen beserta isinya.
type Section struct {
	Title string
	Words int
	Items int // jumlah butir daftar
}

// Doc adalah design doc yang sudah diurai.
type Doc struct {
	Title    string
	Sections map[string]*Section
	Order    []string
}

// requirement mendefinisikan bagian wajib beserta ambang kepadatannya.
// Ambang ini bukan birokrasi: bagian risiko yang hanya berisi satu kalimat
// selalu berarti penulisnya belum memikirkan mode kegagalan.
type requirement struct {
	name     string
	minWords int
	minItems int
}

var required = []requirement{
	{"masalah", 40, 0},
	{"bukan tujuan", 10, 1},
	{"rancangan", 80, 0},
	{"alternatif", 60, 2},        // minimal dua alternatif nyata
	{"yang bisa salah", 60, 3},   // minimal tiga mode kegagalan
	{"tahapan & rollback", 30, 1},
	{"dampak slo", 20, 0},
}

// ErrKosong dikembalikan bila masukan tidak memuat heading apa pun.
var ErrKosong = errors.New("designdoc: dokumen tidak memuat heading")

// Parse membaca markdown dan mengelompokkan isi per bagian level dua.
func Parse(r io.Reader) (*Doc, error) {
	d := &Doc{Sections: map[string]*Section{}}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	var cur *Section
	inFence := false

	for sc.Scan() {
		line := sc.Text()
		trimmed := strings.TrimSpace(line)

		if strings.HasPrefix(trimmed, "```") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue // kode tidak dihitung sebagai isi argumentasi
		}

		switch {
		case strings.HasPrefix(line, "# "):
			if d.Title == "" {
				d.Title = strings.TrimSpace(line[2:])
			}
		case strings.HasPrefix(line, "## "):
			name := normalize(line[3:])
			s := &Section{Title: strings.TrimSpace(line[3:])}
			d.Sections[name] = s
			d.Order = append(d.Order, name)
			cur = s
		default:
			if cur == nil {
				continue
			}
			cur.Words += countWords(trimmed)
			if isListItem(trimmed) {
				cur.Items++
			}
		}
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("baca dokumen: %w", err)
	}
	if len(d.Sections) == 0 {
		return nil, ErrKosong
	}
	return d, nil
}

func normalize(s string) string {
	return strings.ToLower(strings.TrimSpace(strings.Trim(s, "#* ")))
}

func countWords(s string) int {
	return len(strings.FieldsFunc(s, func(r rune) bool {
		return unicode.IsSpace(r)
	}))
}

func isListItem(s string) bool {
	return strings.HasPrefix(s, "- ") || strings.HasPrefix(s, "* ") ||
		(len(s) > 2 && unicode.IsDigit(rune(s[0])) && s[1] == '.')
}

// Finding adalah satu pelanggaran struktur.
type Finding struct {
	Section string
	Msg     string
}

func (f Finding) String() string { return f.Section + ": " + f.Msg }

// Lint memeriksa kelengkapan DAN kepadatan bagian wajib.
func (d *Doc) Lint() []Finding {
	var out []Finding
	for _, req := range required {
		s, ok := d.Sections[req.name]
		if !ok {
			out = append(out, Finding{req.name, "bagian wajib tidak ada"})
			continue
		}
		if s.Words < req.minWords {
			out = append(out, Finding{req.name,
				fmt.Sprintf("terlalu tipis: %d kata, minimal %d", s.Words, req.minWords)})
		}
		if req.minItems > 0 && s.Items < req.minItems {
			out = append(out, Finding{req.name,
				fmt.Sprintf("butuh minimal %d butir, ada %d", req.minItems, s.Items)})
		}
	}
	return out
}
```

## Uji

```go
package designdoc

import (
	"strings"
	"testing"
)

func docDenganRisiko(risiko string) string {
	return `# Pipeline Order

## Masalah
` + strings.Repeat("kata ", 45) + `

## Bukan Tujuan
- Migrasi data historis di luar lingkup dan akan ditangani terpisah nanti

## Rancangan
` + strings.Repeat("kata ", 85) + `

## Alternatif
- Opsi A ditolak karena beban operasional terlalu besar untuk tim saat ini
- Opsi B ditolak karena latensi tidak memenuhi target yang sudah disepakati
` + strings.Repeat("kata ", 60) + `

## Yang Bisa Salah
` + risiko + `

## Tahapan & Rollback
- Rilis di balik feature flag lalu dinaikkan bertahap per sepuluh persen
` + strings.Repeat("kata ", 30) + `

## Dampak SLO
` + strings.Repeat("kata ", 25) + `
`
}

func TestLint_DokumenLengkapLolos(t *testing.T) {
	risiko := "- Broker penuh menyebabkan producer memblokir dan request menumpuk\n" +
		"- Konsumen lambat membuat lag tumbuh sampai retensi terlampaui\n" +
		"- Kegagalan parsial meninggalkan order tanpa event pasangannya\n" +
		strings.Repeat("kata ", 60)
	d, err := Parse(strings.NewReader(docDenganRisiko(risiko)))
	if err != nil {
		t.Fatalf("tak terduga: %v", err)
	}
	if f := d.Lint(); len(f) != 0 {
		t.Fatalf("mau nol temuan, dapat %v", f)
	}
}

func TestLint_RisikoTipisDitolak(t *testing.T) {
	// Inilah kegagalan paling umum: bagian risiko diisi seadanya.
	d, err := Parse(strings.NewReader(docDenganRisiko("- Mungkin ada bug")))
	if err != nil {
		t.Fatalf("tak terduga: %v", err)
	}
	f := d.Lint()
	if len(f) == 0 {
		t.Fatal("bagian risiko satu baris seharusnya ditolak")
	}
	var kena bool
	for _, x := range f {
		if x.Section == "yang bisa salah" {
			kena = true
		}
	}
	if !kena {
		t.Fatalf("temuan harus menunjuk bagian risiko, dapat %v", f)
	}
}

func TestParse_BlokKodeTidakDihitung(t *testing.T) {
	in := "# X\n\n## Masalah\n```go\n" + strings.Repeat("fmt.Println(1)\n", 50) + "```\n"
	d, err := Parse(strings.NewReader(in))
	if err != nil {
		t.Fatalf("tak terduga: %v", err)
	}
	if d.Sections["masalah"].Words != 0 {
		t.Fatalf("kode tidak boleh dihitung sebagai argumentasi, dapat %d kata",
			d.Sections["masalah"].Words)
	}
}

func TestParse_DokumenKosong(t *testing.T) {
	if _, err := Parse(strings.NewReader("teks biasa tanpa heading")); err == nil {
		t.Fatal("mau error untuk dokumen tanpa heading")
	}
}
```

## Anti-Pattern

**❌ SALAH — dokumen yang menjual, bukan mengundang serangan**

```markdown
## Rancangan
Kami akan membangun pipeline berbasis Kafka yang scalable, resilient, dan
future-proof. Arsitektur ini mengikuti best practice industri.

## Alternatif
Kami sudah mempertimbangkan beberapa opsi lain dan Kafka adalah yang terbaik.
```

"Scalable, resilient, future-proof" tidak memuat informasi — tidak ada yang bisa disanggah. Bagian alternatif tanpa isi berarti tidak ada perbandingan yang benar-benar dilakukan. Dokumen seperti ini akan disetujui tanpa dibaca, lalu cacatnya muncul di produksi.

**✅ BENAR — angka, batas, dan mode kegagalan yang bisa diserang**

```markdown
## Rancangan
Producer menulis ke Postgres dan tabel outbox dalam satu transaksi. Relay
membaca outbox tiap 200ms dan memublikasikan ke Kafka topik `orders.v1`
(retensi 7 hari, 12 partisi, kunci partisi = customer_id).

Throughput puncak terukur: 8.000 event/detik. Kapasitas satu partisi ~2.000
event/detik pada ukuran pesan kami (rata-rata 1,2 KB), jadi 12 partisi memberi
margin 3x.

## Yang Bisa Salah
- **Relay mati setelah publish tapi sebelum menandai outbox.** Akibat: event
  ganda. Mitigasi: konsumen WAJIB idempoten berdasarkan `event_id`.
- **Kunci partisi condong.** Satu customer besar bisa menjenuhkan satu partisi.
  Blast radius: keterlambatan hanya untuk customer tersebut. Deteksi: alert
  pada lag per partisi, bukan lag total.
- **Konsumen lebih lambat dari retensi 7 hari.** Data hilang permanen.
  Mitigasi: alert saat lag melewati 3 hari, jauh sebelum batas.

## Dampak SLO
Menambah satu dependensi pada jalur kritis checkout. Batas atas ketersediaan
turun dari 99,95% menjadi ~99,90% bila Kafka 99,95%. Error budget bulanan
menyusut dari 21 menit menjadi 43 menit — masih di dalam target 99,9%,
TAPI tanpa margin untuk dependensi baru berikutnya.
```

**❌ SALAH — mengedit design doc setelah keputusan diambil**

Design doc yang terus diedit menjadi dokumentasi yang selalu tertinggal dari kode. Enam bulan kemudian isinya tidak akurat, tapi orang tetap memercayainya.

**✅ BENAR — bekukan doc, ekstrak keputusannya jadi ADR**

```bash
# Setelah disetujui: doc dibekukan, keputusan pentingnya jadi ADR abadi.
git mv docs/design/order-pipeline.md docs/design/archive/2026-08-order-pipeline.md
# lalu lahirkan ADR-0014 (outbox) dan ADR-0015 (Kafka) yang berdiri sendiri
```

## Kasus Tepi Produksi

1. **Dokumen tidak pernah dikomentari.** Nol komentar bukan tanda desain sempurna — hampir selalu tanda tidak ada yang membacanya. Perbaikannya bukan mengirim pengingat, tapi memperpendek dokumen dan menyebut **secara spesifik** siapa diminta menyerang bagian mana: *"@rina tolong serang bagian Yang Bisa Salah, terutama soal partisi condong."*

2. **Desain berubah di tengah implementasi.** Wajar dan sehat. Yang DILARANG adalah membiarkannya tak tercatat. Kalau perubahannya menyentuh keputusan yang sudah jadi ADR, buat ADR baru yang menggantikan. Kalau hanya detail implementasi, cukup catatan di PR.

3. **Dokumen untuk pekerjaan lintas tim.** Bagian **Bukan Tujuan** menjadi paling kritis di sini, karena tiap tim membaca dengan asumsi berbeda tentang siapa mengerjakan apa. Sebutkan pemilik per bagian secara eksplisit, dan minta tiap tim mengonfirmasi bagiannya sebelum implementasi dimulai.

4. **Desain yang mengubah data lama.** Migrasi data hampir selalu berisiko lebih besar daripada kode barunya, tapi paling sering dianggap detail. WAJIB punya bagian tersendiri: berapa baris, berapa lama, apakah bisa dijalankan bertahap, dan **apa rencana bila migrasi gagal di tengah**.

5. **Doc ditulis setelah kode jadi.** Kadang perlu — misal mendokumentasikan sistem warisan sebelum mengubahnya. Beri penanda jelas `Status: deskriptif (bukan proposal)` supaya pembaca tahu ini peta, bukan rencana. Mencampur keduanya membuat orang menyangka keputusannya masih terbuka padahal sudah berjalan setahun.

## Kapan JANGAN Pakai Ini

- **Pekerjaan di bawah dua minggu dengan satu pengerjaan.** Ongkos dokumennya melebihi manfaatnya. Cukup deskripsi PR yang baik.
- **Ketika keputusannya sudah diambil di luar dokumen.** Menulis design doc untuk keputusan yang sudah final adalah teater, dan orang akan menyadarinya — biaya kepercayaannya mahal. Kalau memang sudah diputuskan, katakan begitu dan tulis ADR-nya.
- **Sebagai syarat administratif.** Begitu design doc jadi kotak centang sebelum boleh ngoding, kualitasnya jatuh ke tingkat minimum yang lolos. Ukurannya harus mutu diskusi yang dihasilkan, bukan keberadaan dokumennya.
- **Untuk perubahan yang mudah dibatalkan.** Pintu dua arah tidak butuh desain formal — butuh feature flag.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Design doc disetujui tanpa satu pun komentar | jumlah komentar per dokumen | Tidak dibaca. Persetujuannya tidak bernilai. |
| Bagian "Yang Bisa Salah" selalu terpendek | keluaran `designlint` | Mode kegagalan tidak dipikirkan; insiden pertama akan mengejutkan |
| Insiden pada sistem yang punya design doc lengkap | cocokkan postmortem dengan bagian risiko | Risikonya tidak terpetakan, atau dipetakan tapi mitigasinya tidak dikerjakan |
| Nol ADR lahir dari design doc | hitung tautan doc→ADR | Keputusannya tidak pernah dipadatkan; enam bulan lagi alasannya hilang |
| Dokumen terus diedit setelah implementasi | riwayat git berkas doc | Doc berubah jadi dokumentasi basi; bekukan dan pindah ke ADR |

```bash
# Design doc yang masih diedit setelah kode terkait di-merge
git log --format='%ad %s' --date=short -- docs/design/ | head -20

# Bagian risiko paling tipis di seluruh dokumen
for f in docs/design/*.md; do
  n=$(awk '/^## Yang Bisa Salah/,/^## /' "$f" | wc -w)
  echo "$n $f"
done | sort -n | head

# Gate CI
go run ./cmd/designlint docs/design/*.md || exit 1
```
