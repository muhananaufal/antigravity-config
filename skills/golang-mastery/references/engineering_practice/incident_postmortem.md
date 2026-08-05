# Incident Response & Postmortem Tanpa Menyalahkan

> **Berlaku:** Go 1.21+ · **Lihat juga:** `engineering_practice/slo_error_budget.md` · `observability_resilience/structured_logging_zerolog.md` · `observability_resilience/graceful_shutdown_drain.md`

## Konsep Utama

Insiden bukan kegagalan tim — insiden adalah **momen paling padat informasi** yang akan Anda dapatkan tentang sistem Anda. Sistem yang tidak pernah mengalami insiden bukan sistem yang andal; itu sistem yang tidak dipakai.

Dua hal yang membedakan tim dewasa dari tim yang panik:

1. **Respons adalah sistem peran, bukan kepahlawanan.** Saat produksi terbakar, satu orang paling paham teknis akan sekaligus mendiagnosis, memperbaiki, membalas Slack CEO, dan mencoba mengingat apa yang sudah dicoba. Semuanya dikerjakan buruk. Pemisahan peran menyelesaikan ini.
2. **Postmortem dinilai dari action item yang benar-benar selesai**, bukan dari kelengkapan dokumennya. Postmortem 12 halaman dengan nol perbaikan terlaksana lebih buruk daripada satu paragraf dengan satu perbaikan yang sudah di-merge — karena yang pertama menciptakan ilusi bahwa masalahnya sudah ditangani.

### Salah paham tentang "blameless"

*Blameless* **bukan** berarti tidak ada yang bertanggung jawab. Artinya: pertanggungjawaban diarahkan ke **sistem**, bukan ke orang.

| Menyalahkan orang | Menyalahkan sistem |
| :--- | :--- |
| "Budi menjalankan migrasi tanpa review." | "Migrasi produksi bisa dijalankan tanpa approval kedua." |
| "Tim tidak memantau dashboard." | "Kegagalan ini tidak memicu alert apa pun selama 40 menit." |
| "Seharusnya dia lebih hati-hati." | "Perintah destruktif dan perintah aman terlihat identik di CLI." |

Kolom kanan menghasilkan perbaikan yang bisa dikerjakan. Kolom kiri menghasilkan orang yang berhenti melaporkan insiden — dan Anda kehilangan sumber data terbaik yang Anda punya.

**Inilah yang dinilai komite promosi.** Bukan "pernah menangani insiden", tapi: bisakah Anda memimpin insiden tanpa membuat orang defensif, dan mengubah kekacauan jadi perubahan sistem yang permanen.

### Metrik yang dipakai

| Metrik | Arti | Yang diperbaiki bila buruk |
| :--- | :--- | :--- |
| **MTTD** *(detect)* | insiden mulai → terdeteksi | Alert & SLI. Ini paling sering jadi biang keladi. |
| **MTTA** *(acknowledge)* | terdeteksi → ada yang merespons | Rotasi on-call, eskalasi, kelelahan alert |
| **MTTM** *(mitigate)* | direspons → dampak berhenti | Runbook, feature flag, kemampuan rollback |
| **MTTR** *(resolve)* | direspons → akar masalah beres | Boleh lama. Mitigasi dulu, perbaikan menyusul. |

Kesalahan umum: mengejar MTTR kecil. Yang benar adalah **MTTM kecil** — hentikan pendarahan lebih dulu, perbaikan akar masalah boleh besok dengan kepala dingin.

## Diagram ASCII

```text
   PERAN SAAT INSIDEN — pemisahan yang mencegah satu orang kewalahan

   [ Alert menyala ]
          |
          v
   +----------------------+
   | Incident Commander   |  TIDAK menyentuh keyboard produksi.
   | (IC)                 |  Memutuskan, mendelegasikan, menjaga linimasa.
   +----------------------+
      |         |        |
      v         v        v
   +--------+ +--------+ +------------------+
   | Ops    | | Comms  | | Scribe           |
   | Lead   | | Lead   | | (linimasa)       |
   +--------+ +--------+ +------------------+
   diagnosis  update ke   catat SEMUA aksi
   & mitigasi stakeholder beserta jamnya
              tiap 30m

   Tim kecil? IC boleh merangkap Scribe. Yang DILARANG dirangkap:
   IC + Ops Lead — orang yang sedang menatap stack trace tidak bisa
   sekaligus menilai apakah sudah waktunya rollback.

   ---------------------------------------------------------------

   LINIMASA & METRIK

   t0 ---- t1 -------- t2 --------- t3 ------------- t4
   mulai  terdeteksi  direspons   dampak berhenti  akar beres
     |<-MTTD->|<-MTTA->|<--MTTM-->|
     |<---------------- MTTR ----------------------->|

   MTTD besar = masalah OBSERVABILITAS, bukan masalah engineering.
   Perbaiki alert dulu sebelum menambah redundansi apa pun.
```

## Kode Go Production-Ready

Membangun linimasa insiden otomatis dari log terstruktur `log/slog` dan event deploy, lalu menghitung metrik respons. Linimasa yang direkonstruksi mesin mengalahkan ingatan manusia yang sedang stres.

```go
package incident

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
)

// Severity mengikuti tangga keparahan yang WAJIB disepakati sebelum insiden,
// bukan diperdebatkan saat insiden sedang berlangsung.
type Severity int

const (
	SevNone Severity = iota
	Sev3             // degradasi sebagian, ada workaround
	Sev2             // fitur inti terganggu, tanpa workaround
	Sev1             // kehilangan data atau layanan mati total
)

func (s Severity) String() string {
	switch s {
	case Sev1:
		return "SEV1"
	case Sev2:
		return "SEV2"
	case Sev3:
		return "SEV3"
	}
	return "NONE"
}

// EventKind membedakan asal sebuah entri linimasa.
type EventKind string

const (
	KindDetect   EventKind = "detect"   // alert menyala
	KindAck      EventKind = "ack"      // manusia merespons
	KindAction   EventKind = "action"   // aksi mitigasi dilakukan
	KindMitigate EventKind = "mitigate" // dampak ke pengguna berhenti
	KindResolve  EventKind = "resolve"  // akar masalah selesai
	KindDeploy   EventKind = "deploy"   // rilis, sering jadi pemicu
)

// Event adalah satu titik pada linimasa insiden.
type Event struct {
	At    time.Time
	Kind  EventKind
	Actor string
	Msg   string
}

// Timeline mengumpulkan seluruh event satu insiden.
type Timeline struct {
	IncidentID string
	Severity   Severity
	StartedAt  time.Time // t0, biasanya diisi manual saat postmortem
	Events     []Event
}

// ErrNoEvents dikembalikan bila linimasa kosong.
var ErrNoEvents = errors.New("incident: timeline contains no events")

// logLine adalah bentuk JSON keluaran log/slog yang kita pedulikan.
type logLine struct {
	Time  time.Time `json:"time"`
	Level string    `json:"level"`
	Msg   string    `json:"msg"`
	Actor string    `json:"actor"`
	Kind  string    `json:"incident_kind"`
	ID    string    `json:"incident_id"`
}

// ParseSlogStream membaca aliran JSON dari log/slog dan menyaring event yang
// bertanda incident_id tertentu. Baris rusak DILEWATI, bukan menggagalkan
// seluruh rekonstruksi — saat postmortem, data separuh jauh lebih baik
// daripada tidak ada data.
func ParseSlogStream(r io.Reader, incidentID string) (Timeline, error) {
	tl := Timeline{IncidentID: incidentID}
	dec := json.NewDecoder(r)
	for {
		var l logLine
		if err := dec.Decode(&l); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			// Baris tidak valid: lewati satu token lalu lanjut.
			if _, terr := dec.Token(); terr != nil {
				break
			}
			continue
		}
		if l.ID != incidentID || l.Kind == "" {
			continue
		}
		tl.Events = append(tl.Events, Event{
			At: l.Time, Kind: EventKind(l.Kind), Actor: l.Actor, Msg: l.Msg,
		})
	}
	sort.Slice(tl.Events, func(i, j int) bool { return tl.Events[i].At.Before(tl.Events[j].At) })
	return tl, nil
}

// Metrics adalah hasil hitung durasi respons.
type Metrics struct {
	MTTD, MTTA, MTTM, MTTR time.Duration
	Complete               bool // false bila ada fase yang tidak tercatat
}

// first mengembalikan waktu event pertama berjenis k.
func (t Timeline) first(k EventKind) (time.Time, bool) {
	for _, e := range t.Events {
		if e.Kind == k {
			return e.At, true
		}
	}
	return time.Time{}, false
}

// Metrics menghitung MTTD/MTTA/MTTM/MTTR dari linimasa.
// Fase yang tidak tercatat menghasilkan durasi nol dan Complete=false —
// DILARANG melaporkan angka seolah lengkap padahal datanya bolong.
func (t Timeline) Metrics() (Metrics, error) {
	if len(t.Events) == 0 {
		return Metrics{}, ErrNoEvents
	}
	if t.StartedAt.IsZero() {
		return Metrics{}, errors.New("incident: StartedAt is required to compute MTTD")
	}

	var m Metrics
	m.Complete = true

	det, okDet := t.first(KindDetect)
	ack, okAck := t.first(KindAck)
	mit, okMit := t.first(KindMitigate)
	res, okRes := t.first(KindResolve)

	if okDet {
		m.MTTD = det.Sub(t.StartedAt)
	} else {
		m.Complete = false
	}
	if okDet && okAck {
		m.MTTA = ack.Sub(det)
	} else {
		m.Complete = false
	}
	if okAck && okMit {
		m.MTTM = mit.Sub(ack)
	} else {
		m.Complete = false
	}
	if okAck && okRes {
		m.MTTR = res.Sub(ack)
	} else {
		m.Complete = false
	}

	// Urutan terbalik menandakan linimasa yang salah catat, bukan sistem cepat.
	if m.MTTD < 0 || m.MTTA < 0 || m.MTTM < 0 || m.MTTR < 0 {
		return m, fmt.Errorf("incident %s: timeline order is nonsensical", t.IncidentID)
	}
	return m, nil
}

// ActionItem adalah perbaikan yang lahir dari postmortem.
// Tanpa Owner dan Due, ini hanya harapan.
type ActionItem struct {
	Title string
	Owner string
	Due   time.Time
	Done  bool
}

// ValidateActions menolak action item yang tidak bisa ditagih.
func ValidateActions(items []ActionItem) []string {
	var problems []string
	for i, it := range items {
		switch {
		case strings.TrimSpace(it.Owner) == "":
			problems = append(problems, fmt.Sprintf("action[%d] %q: without owner", i, it.Title))
		case it.Due.IsZero():
			problems = append(problems, fmt.Sprintf("action[%d] %q: without due date", i, it.Title))
		case strings.Contains(strings.ToLower(it.Owner), "tim "):
			// "Tim Backend" bukan pemilik. Tugas milik semua orang tidak dikerjakan siapa pun.
			problems = append(problems, fmt.Sprintf("action[%d] %q: owner must be an individual, not a team", i, it.Title))
		}
	}
	return problems
}
```

## Uji

```go
package incident

import (
	"strings"
	"testing"
	"time"
)

func mustTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestMetrics(t *testing.T) {
	base := mustTime("2026-08-05T10:00:00Z")
	tl := Timeline{
		IncidentID: "INC-1", StartedAt: base,
		Events: []Event{
			{At: base.Add(4 * time.Minute), Kind: KindDetect},
			{At: base.Add(6 * time.Minute), Kind: KindAck},
			{At: base.Add(20 * time.Minute), Kind: KindMitigate},
			{At: base.Add(3 * time.Hour), Kind: KindResolve},
		},
	}
	m, err := tl.Metrics()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if m.MTTD != 4*time.Minute {
		t.Errorf("MTTD want 4m, got %v", m.MTTD)
	}
	if m.MTTM != 14*time.Minute {
		t.Errorf("MTTM want 14m, got %v", m.MTTM)
	}
	if !m.Complete {
		t.Error("want Complete=true")
	}
}

func TestMetrics_FaseBolongDitandai(t *testing.T) {
	base := mustTime("2026-08-05T10:00:00Z")
	tl := Timeline{
		IncidentID: "INC-2", StartedAt: base,
		Events: []Event{{At: base.Add(time.Minute), Kind: KindDetect}},
	}
	m, err := tl.Metrics()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if m.Complete {
		t.Fatal("incomplete timeline should have Complete=false")
	}
}

func TestParseSlogStream_BarisRusakDilewati(t *testing.T) {
	in := `{"time":"2026-08-05T10:04:00Z","msg":"alert","incident_kind":"detect","incident_id":"INC-1"}
{ini bukan json}
{"time":"2026-08-05T10:06:00Z","msg":"ack","incident_kind":"ack","incident_id":"INC-1","actor":"rina"}
{"time":"2026-08-05T10:07:00Z","msg":"lain","incident_kind":"ack","incident_id":"INC-9"}`
	tl, err := ParseSlogStream(strings.NewReader(in), "INC-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(tl.Events) != 2 {
		t.Fatalf("want 2 events for INC-1, got %d", len(tl.Events))
	}
	if tl.Events[1].Actor != "rina" {
		t.Errorf("actor want rina, got %q", tl.Events[1].Actor)
	}
}

func TestValidateActions(t *testing.T) {
	items := []ActionItem{
		{Title: "tambah alert", Owner: "rina", Due: time.Now().Add(72 * time.Hour)},
		{Title: "perbaiki runbook", Owner: "", Due: time.Now()},
		{Title: "audit migrasi", Owner: "Tim Backend", Due: time.Now()},
		{Title: "pasang flag", Owner: "budi"},
	}
	p := ValidateActions(items)
	if len(p) != 3 {
		t.Fatalf("want 3 problems, got %d: %v", len(p), p)
	}
}
```

## Anti-Pattern

**❌ SALAH — postmortem yang menamai orang**

```markdown
## Akar Masalah
Budi menjalankan `migrate up` di produksi tanpa meminta review, sehingga
tabel terkunci selama 12 menit.

## Action Item
- Budi akan lebih berhati-hati saat menjalankan migrasi.
```

Dua kerusakan sekaligus. Pertama, action item-nya tidak bisa diverifikasi — "lebih berhati-hati" bukan perubahan sistem, dan orang berikutnya akan mengulanginya. Kedua, semua yang membaca ini belajar bahwa melaporkan insiden itu berisiko secara personal. Insiden berikutnya akan disembunyikan.

**✅ BENAR — akar masalah diarahkan ke sistem, action item bisa ditagih**

```markdown
## Akar Masalah
Perintah migrasi produksi dapat dijalankan oleh siapa pun yang punya kredensial
DB, tanpa approval kedua dan tanpa dry-run. Migrasi tersebut mengambil
ACCESS EXCLUSIVE lock pada tabel 40 juta baris; tidak ada mekanisme yang
menghentikannya setelah dimulai.

## Faktor Penyumbang
- Tidak ada alert pada durasi lock > 30 detik (MTTD 11 menit, seluruhnya dari laporan pengguna).
- Runbook rollback migrasi ada, tapi tidak pernah diuji dan ternyata salah.

## Action Item
- [ ] Migrasi produksi WAJIB lewat pipeline dengan approval kedua — @rina, 2026-08-19
- [ ] Alert `pg_locks` durasi > 30 detik — @budi, 2026-08-12
- [ ] Uji runbook rollback di staging tiap kuartal — @sari, 2026-09-01
```

**❌ SALAH — satu orang merangkap IC dan Ops Lead**

```text
10:06  rina: saya ambil alih, sedang lihat stack trace
10:24  (CEO japri: "ini kenapa?")
10:31  rina: masih cek...
10:52  rina: eh, harusnya kita rollback dari 20 menit lalu ya?
```

Orang yang sedang menatap stack trace kehilangan pandangan menyeluruh. Keputusan rollback selalu terlambat karena yang mendiagnosis selalu merasa "sedikit lagi ketemu".

**✅ BENAR — IC memutuskan, Ops mengerjakan**

```text
10:06  rina (IC): saya IC. @budi ops lead, @sari comms.
10:07  rina (IC): batas waktu diagnosis 10 menit. Lewat itu kita rollback dulu.
10:17  rina (IC): waktu habis. @budi rollback sekarang, diagnosis lanjut sesudahnya.
10:21  budi (ops): rollback selesai, error rate turun.
10:22  sari (comms): update ke stakeholder terkirim.
```

## Kasus Tepi Produksi

1. **Near-miss tanpa dampak pengguna.** Disk penuh 98% lalu ada yang membersihkannya manual — tidak ada pengguna terdampak, jadi tidak ada yang menulis postmortem. Padahal ini insiden termurah yang pernah Anda dapat: seluruh pelajaran, nol kerugian. WAJIB tetap ditulis, cukup versi pendek. Tim yang hanya belajar dari kerusakan nyata membayar terlalu mahal untuk tiap pelajaran.

2. **Insiden berulang dengan akar yang sama.** Kalau postmortem kedua untuk gejala yang sama, akar masalah yang ditulis di postmortem pertama **pasti salah** — atau action item-nya tidak pernah dikerjakan. Jangan tulis postmortem baru dari nol; buka yang lama dan cari mengapa perbaikannya tidak menutup masalah.

3. **Insiden lintas zona waktu.** Handoff antar-region adalah titik paling rawan kehilangan konteks. WAJIB ada handoff eksplisit: IC keluar menyerahkan linimasa tertulis, IC masuk mengonfirmasi telah membacanya. Tanpa itu, tim kedua mengulangi diagnosis yang sudah dicoba tim pertama.

4. **Insiden saat pembekuan rilis.** Perbaikan mendesak bertabrakan dengan pembekuan karena anggaran error budget habis. Aturan WAJIB ditulis sebelumnya: perbaikan yang mengurangi dampak selalu diizinkan, penambahan fitur tidak. Menegosiasikan ini di tengah insiden selalu berakhir buruk.

5. **Action item yang tidak pernah ditutup.** Ini kegagalan paling umum dan paling merusak. Postmortem tanpa penutupan action item hanya menghasilkan arsip. Sambungkan action item ke tracker yang sama dengan pekerjaan biasa, beri tenggat, dan tinjau tiap bulan — bukan disimpan di dokumen terpisah yang tidak pernah dibuka lagi.

## Kapan JANGAN Pakai Ini

- **Untuk tiap gangguan kecil.** Blip 30 detik yang pulih sendiri tidak butuh postmortem penuh. Tetapkan ambang: SEV1/SEV2 wajib, SEV3 opsional, di bawah itu cukup catatan. Postmortem untuk segalanya membuat postmortem penting kehilangan pembaca.
- **Ketika tujuannya mencari siapa yang salah.** Kalau manajemen sudah memutuskan seseorang harus disalahkan, jangan sebut prosesnya "blameless postmortem". Menyebutnya begitu sambil melakukan sebaliknya merusak kepercayaan lebih parah daripada terus terang sejak awal.
- **Sebagai pengganti alert yang benar.** Tim yang postmortem-nya rapi tapi MTTD-nya 40 menit sedang memoles proses hilir sambil membiarkan masalah hulu. Perbaiki deteksinya dulu.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| MTTD jauh lebih besar dari MTTM | tabel metrik per insiden | Sistem Anda sudah bisa diperbaiki cepat, tapi Anda tahu terlambat. Perbaiki alert, bukan arsitektur. |
| Insiden selalu dilaporkan pengguna, bukan alert | sumber event `detect` | Observabilitas tidak menutup jalur kritis. Turunkan dari SLO, bukan dari tebakan. |
| Action item terbuka menumpuk lintas kuartal | umur action item di tracker | Postmortem jadi ritual. Hentikan menulis postmortem baru sampai yang lama ditutup. |
| Insiden yang sama berulang >2 kali | kelompokkan postmortem per komponen | Akar masalah salah didiagnosis. Bukan butuh postmortem lagi — butuh analisis yang lebih dalam. |
| Postmortem selalu ditulis orang yang sama | penulis per dokumen | Pengetahuan insiden terpusat di satu orang; itu risiko bus factor. |

```bash
# Insiden per komponen dalam 90 hari — cari yang berulang
grep -h "^component:" postmortems/*.md | sort | uniq -c | sort -rn

# Action item yang lewat tenggat
grep -hn "\- \[ \]" postmortems/*.md | grep -oP '\d{4}-\d{2}-\d{2}' | sort | head

# Rekonstruksi linimasa dari log produksi
kubectl logs -l app=order --since=6h --all-containers \
  | go run ./cmd/incident-timeline -id INC-2026-0805
```
