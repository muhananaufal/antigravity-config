# SLO, Error Budget & Burn-Rate Alerting

> **Berlaku:** Go 1.21+ · Prometheus 2.40+ · **Lihat juga:** `observability_resilience/prometheus_metrics_red.md` · `observability_resilience/health_check_readiness.md` · `distributed_patterns_resilience/circuit_breaker_gobreaker.md`

## Konsep Utama

Uptime 100% adalah target yang salah. Setiap sembilan tambahan melipatgandakan ongkos rekayasa, dan pengguna Anda tidak bisa membedakan 99,99% dengan 99,999% karena jaringan mereka sendiri lebih sering putus daripada itu. **SLO (Service Level Objective) adalah keputusan bisnis yang diterjemahkan jadi angka**, dan *error budget* adalah sisa kegagalan yang boleh Anda belanjakan.

Tiga lapis yang WAJIB dibedakan:

| Lapis | Arti | Contoh |
| :--- | :--- | :--- |
| **SLI** | Sinyal terukur dari sudut pandang pengguna | proporsi request HTTP dengan status <500 dan latensi <300ms |
| **SLO** | Target atas SLI dalam jendela waktu | 99,9% selama 28 hari bergulir |
| **Error Budget** | `1 − SLO`, dinyatakan sebagai anggaran | 0,1% × 28 hari = **40 menit 19 detik** boleh gagal |

Nilai politisnya jauh lebih besar daripada nilai teknisnya. Error budget adalah **satu-satunya alat yang memberi Anda hak menolak** secara objektif: ketika anggaran habis, rilis fitur berhenti dan tim beralih ke reliabilitas — bukan karena Anda merasa sistemnya rapuh, tapi karena angkanya berkata begitu. Inilah yang membedakan engineer senior dari yang mahir teknis tapi selalu kalah dalam rapat prioritas.

**Burn rate** adalah kecepatan konsumsi anggaran relatif terhadap laju yang wajar. Burn rate 1 berarti anggaran habis persis di akhir jendela. Burn rate 14,4 berarti anggaran 30 hari ludes dalam ~2 hari.

Alert WAJIB dipasang pada burn rate, **bukan** pada jumlah error mentah. Alert berbasis ambang error mentah menghasilkan dua kegagalan sekaligus: berisik saat trafik tinggi (banyak error tapi rasio sehat) dan buta saat trafik rendah (sedikit error tapi rasio hancur).

## Diagram ASCII

```text
   MULTI-WINDOW MULTI-BURN-RATE  (Google SRE Workbook)

   Anggaran 30 hari, SLO 99,9%  ->  budget = 43m 12s
   
   Burn  Jendela      Anggaran   Aksi        Alasan
   rate  panjang/pendek habis dlm
   ----  ------------ ---------  ----------  --------------------------------
   14.4   1j /  5m      2 hari    PAGE       insiden akut, bangunkan orang
    6.0   6j / 30m      5 hari    PAGE       degradasi cepat
    3.0   1h /  2j     10 hari    TICKET     tren buruk, tangani jam kerja
    1.0   3h /  6j     30 hari    TICKET     tepat sesuai anggaran, awasi

   Kenapa DUA jendela?
   
   jendela panjang saja  ->  lambat menyala, insiden sudah 1 jam berjalan
   jendela pendek saja   ->  menyala karena satu spike 30 detik lalu pulih
   keduanya (AND)        ->  cepat DAN tidak berisik
   
        error rate
            |
       14.4 |    ####            <- pendek(5m) menyala
            |    ####  ####
        1.0 |----####--####------ <- SLO line
            |    ####  ####
          0 +----+----+----+----> waktu
                 ^         ^
                 |         `- panjang(1j) masih tinggi -> PAGE bertahan
                 `- keduanya tinggi -> PAGE menyala
```

## Kode Go Production-Ready

```go
package slo

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// Severity menentukan bagaimana alert diperlakukan oleh pipeline notifikasi.
type Severity int

const (
	SeverityNone Severity = iota
	SeverityTicket
	SeveritySeverityPage
)

func (s Severity) String() string {
	switch s {
	case SeverityTicket:
		return "TICKET"
	case SeveritySeverityPage:
		return "PAGE"
	default:
		return "NONE"
	}
}

// Objective mendefinisikan satu SLO beserta jendela anggarannya.
type Objective struct {
	Name        string        // "checkout-availability"
	Target      float64       // 0.999 untuk 99,9%
	BudgetWindow time.Duration // biasanya 28 atau 30 hari
}

// ErrorBudget mengembalikan total durasi kegagalan yang boleh terjadi.
func (o Objective) ErrorBudget() time.Duration {
	if o.Target <= 0 || o.Target >= 1 {
		return 0
	}
	return time.Duration(float64(o.BudgetWindow) * (1 - o.Target))
}

// BurnRateRule adalah satu baris dari tabel multi-window multi-burn-rate.
type BurnRateRule struct {
	Factor     float64       // 14.4, 6, 3, 1
	LongWindow time.Duration // 1h, 6h, 1d, 3d
	ShortWindow time.Duration // 5m, 30m, 2h, 6h
	Severity   Severity
}

// DefaultRules mengikuti tabel SRE Workbook untuk jendela anggaran 30 hari.
// Faktor diturunkan dari: factor = (budgetWindow / alertWindow) * fractionOfBudget.
func DefaultRules() []BurnRateRule {
	return []BurnRateRule{
		{Factor: 14.4, LongWindow: time.Hour, ShortWindow: 5 * time.Minute, Severity: SeveritySeverityPage},
		{Factor: 6, LongWindow: 6 * time.Hour, ShortWindow: 30 * time.Minute, Severity: SeveritySeverityPage},
		{Factor: 3, LongWindow: 24 * time.Hour, ShortWindow: 2 * time.Hour, Severity: SeverityTicket},
		{Factor: 1, LongWindow: 72 * time.Hour, ShortWindow: 6 * time.Hour, Severity: SeverityTicket},
	}
}

// RatioQuerier mengambil rasio request GAGAL terhadap total pada rentang waktu.
// Implementasi nyata memanggil Prometheus; antarmuka ini membuatnya bisa diuji.
type RatioQuerier interface {
	FailureRatio(ctx context.Context, sloName string, window time.Duration) (float64, error)
}

// ErrInsufficientTraffic dikembalikan bila sampel terlalu sedikit untuk dipercaya.
var ErrInsufficientTraffic = errors.New("slo: trafik tidak cukup untuk menghitung rasio")

// Evaluator memutuskan severity berdasarkan burn rate dua jendela.
type Evaluator struct {
	Obj    Objective
	Rules  []BurnRateRule
	Query  RatioQuerier
	Logger *slog.Logger
}

// Decision adalah hasil evaluasi satu siklus.
type Decision struct {
	Severity      Severity
	TriggeredRule *BurnRateRule
	LongBurn      float64
	ShortBurn     float64
	BudgetLeft    time.Duration
}

// Evaluate menjalankan seluruh aturan dari yang paling parah ke paling ringan.
// Aturan pertama yang MEMENUHI KEDUA jendela yang menang — inilah inti
// multi-window: jendela pendek memastikan masalahnya MASIH berlangsung.
func (e *Evaluator) Evaluate(ctx context.Context) (Decision, error) {
	budget := e.Obj.ErrorBudget()
	if budget == 0 {
		return Decision{}, fmt.Errorf("slo %q: target %.4f tidak valid", e.Obj.Name, e.Obj.Target)
	}
	allowedRatio := 1 - e.Obj.Target

	for i := range e.Rules {
		r := e.Rules[i]

		longRatio, err := e.Query.FailureRatio(ctx, e.Obj.Name, r.LongWindow)
		if err != nil {
			if errors.Is(err, ErrInsufficientTraffic) {
				// Trafik rendah: JANGAN menyalakan alert dari rasio yang bising.
				e.Logger.Debug("lewati aturan, trafik tidak cukup",
					"slo", e.Obj.Name, "window", r.LongWindow)
				continue
			}
			return Decision{}, fmt.Errorf("query jendela panjang %v: %w", r.LongWindow, err)
		}

		longBurn := longRatio / allowedRatio
		if longBurn < r.Factor {
			continue
		}

		shortRatio, err := e.Query.FailureRatio(ctx, e.Obj.Name, r.ShortWindow)
		if err != nil {
			if errors.Is(err, ErrInsufficientTraffic) {
				continue
			}
			return Decision{}, fmt.Errorf("query jendela pendek %v: %w", r.ShortWindow, err)
		}
		shortBurn := shortRatio / allowedRatio

		// KEDUA jendela WAJIB melewati ambang. Tanpa syarat ini, alert akan
		// bertahan menyala berjam-jam setelah insidennya sendiri sudah pulih.
		if shortBurn < r.Factor {
			continue
		}

		consumed := time.Duration(longRatio * float64(e.Obj.BudgetWindow))
		left := budget - consumed
		if left < 0 {
			left = 0
		}

		return Decision{
			Severity:      r.Severity,
			TriggeredRule: &r,
			LongBurn:      longBurn,
			ShortBurn:     shortBurn,
			BudgetLeft:    left,
		}, nil
	}

	return Decision{Severity: SeverityNone, BudgetLeft: budget}, nil
}
```

Kueri Prometheus yang memasok `FailureRatio` — perhatikan bahwa pembaginya adalah **total request**, bukan konstanta:

```promql
# SLI ketersediaan: proporsi request yang GAGAL dalam 1 jam
sum(rate(http_requests_total{job="checkout",code=~"5.."}[1h]))
  /
sum(rate(http_requests_total{job="checkout"}[1h]))
```

## Uji

```go
package slo

import (
	"context"
	"log/slog"
	"io"
	"testing"
	"time"
)

type stubQuerier struct{ ratios map[time.Duration]float64 }

func (s stubQuerier) FailureRatio(_ context.Context, _ string, w time.Duration) (float64, error) {
	r, ok := s.ratios[w]
	if !ok {
		return 0, ErrInsufficientTraffic
	}
	return r, nil
}

func newEvaluator(ratios map[time.Duration]float64) *Evaluator {
	return &Evaluator{
		Obj:    Objective{Name: "t", Target: 0.999, BudgetWindow: 30 * 24 * time.Hour},
		Rules:  DefaultRules(),
		Query:  stubQuerier{ratios: ratios},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func TestEvaluate(t *testing.T) {
	t.Run("kedua jendela tinggi memicu PAGE", func(t *testing.T) {
		// allowedRatio = 0.001; rasio 0.02 -> burn 20 (> 14.4)
		e := newEvaluator(map[time.Duration]float64{
			time.Hour: 0.02, 5 * time.Minute: 0.02,
		})
		d, err := e.Evaluate(context.Background())
		if err != nil {
			t.Fatalf("tak terduga: %v", err)
		}
		if d.Severity != SeveritySeverityPage {
			t.Fatalf("mau PAGE, dapat %v", d.Severity)
		}
	})

	t.Run("jendela pendek sudah pulih TIDAK memicu", func(t *testing.T) {
		// Inilah nilai multi-window: insiden sudah selesai, alert diam.
		e := newEvaluator(map[time.Duration]float64{
			time.Hour: 0.02, 5 * time.Minute: 0.0,
			6 * time.Hour: 0.0, 30 * time.Minute: 0.0,
			24 * time.Hour: 0.0, 2 * time.Hour: 0.0,
			72 * time.Hour: 0.0, 6 * time.Hour * 1: 0.0,
		})
		d, err := e.Evaluate(context.Background())
		if err != nil {
			t.Fatalf("tak terduga: %v", err)
		}
		if d.Severity != SeverityNone {
			t.Fatalf("mau NONE, dapat %v", d.Severity)
		}
	})

	t.Run("trafik tidak cukup tidak menyalakan alarm palsu", func(t *testing.T) {
		e := newEvaluator(map[time.Duration]float64{}) // semua window -> ErrInsufficientTraffic
		d, err := e.Evaluate(context.Background())
		if err != nil {
			t.Fatalf("tak terduga: %v", err)
		}
		if d.Severity != SeverityNone {
			t.Fatalf("mau NONE saat trafik sepi, dapat %v", d.Severity)
		}
	})

	t.Run("target tidak valid ditolak", func(t *testing.T) {
		e := newEvaluator(map[time.Duration]float64{})
		e.Obj.Target = 1.0
		if _, err := e.Evaluate(context.Background()); err == nil {
			t.Fatal("mau error untuk target 1.0")
		}
	})
}
```

## Anti-Pattern

**❌ SALAH — SLO seragam untuk semua endpoint**

```go
// Semua service dipatok 99,99% "biar aman".
var globalSLO = Objective{Target: 0.9999, BudgetWindow: 30 * 24 * time.Hour}
```

99,99% berarti anggaran hanya **4 menit 19 detik per bulan**. Satu deploy yang meleset saja menghabiskannya. Akibatnya tim belajar mengabaikan alert, dan SLO kehilangan seluruh daya politiknya — persis kebalikan dari tujuannya.

**✅ BENAR — SLO diturunkan dari dampak bisnis per journey**

```go
var objectives = map[string]Objective{
	// Checkout: kegagalan = kehilangan uang langsung.
	"checkout":  {Name: "checkout", Target: 0.999, BudgetWindow: 30 * 24 * time.Hour},
	// Pencarian: degradasi terasa, tapi tidak fatal.
	"search":    {Name: "search", Target: 0.99, BudgetWindow: 30 * 24 * time.Hour},
	// Laporan batch internal: boleh gagal, ada retry harian.
	"reporting": {Name: "reporting", Target: 0.95, BudgetWindow: 30 * 24 * time.Hour},
}
```

**❌ SALAH — alert pada jumlah error absolut**

```promql
# Menyala saat trafik ramai walau rasio sehat; diam saat trafik sepi walau rasio hancur.
sum(rate(http_requests_total{code=~"5.."}[5m])) > 10
```

**✅ BENAR — alert pada burn rate, dua jendela**

```promql
(
  sum(rate(http_requests_total{code=~"5.."}[1h])) / sum(rate(http_requests_total[1h])) > 14.4 * 0.001
)
and
(
  sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 14.4 * 0.001
)
```

## Kasus Tepi Produksi

1. **Service bertrafik rendah.** Pada 10 request/menit, satu kegagalan tunggal = rasio 10% dan burn rate 100. Alert akan menyala tiap hari tanpa makna. WAJIB pasang ambang minimum sampel (`ErrInsufficientTraffic` di kode atas), atau ganti SLI berbasis rasio dengan SLI berbasis *probe* sintetis berjadwal tetap.

2. **Anggaran habis di tengah insiden panjang.** Setelah `BudgetLeft` mencapai nol, burn rate kehilangan makna — semua sudah merah. Kebijakan WAJIB ditulis sebelum insiden terjadi: pembekuan rilis, siapa yang berwenang mencairkannya, dan berapa lama pembekuan berlaku. Menegosiasikan aturan saat sedang panik selalu kalah.

3. **Jendela bergulir vs kalender.** Jendela bergulir 30 hari membuat insiden besar "menghantui" selama 30 hari penuh lalu hilang mendadak. Jendela kalender mereset tiap tanggal 1 dan mengundang perilaku buruk di akhir bulan. Pilih bergulir untuk keputusan operasional, kalender untuk pelaporan ke manajemen — dan jangan campur keduanya dalam satu grafik.

4. **SLO bertingkat pada dependensi.** Service Anda 99,9% tapi bergantung pada tiga dependensi masing-masing 99,9%. Batas atas teoretis Anda menjadi `0.999³ ≈ 99,7%` — **lebih rendah dari target Anda sendiri**. WAJIB hitung ini sebelum menjanjikan angka, atau tambahkan fallback/cache yang memutus ketergantungan.

5. **Deploy dan maintenance terencana.** Tanpa pengecualian, tiap rilis membakar anggaran. Putuskan secara eksplisit: apakah jendela deploy dikecualikan dari SLI, atau justru sengaja dihitung supaya tim terdorong membuat deploy tanpa downtime. Keduanya sah — yang salah adalah tidak memutuskan.

## Kapan JANGAN Pakai Ini

- **Sistem tanpa pengguna nyata** — proyek internal berpengguna lima orang tidak butuh error budget; butuh test yang jalan.
- **Sebelum punya metrik RED yang dipercaya.** SLO di atas instrumentasi yang bocor menghasilkan angka yang meyakinkan dan salah. Selesaikan `prometheus_metrics_red.md` lebih dulu.
- **Sebagai alat menilai kinerja individu.** Begitu error budget dipakai untuk KPI orang, tim akan berhenti melaporkan insiden. Anda kehilangan data, bukan mendapat reliabilitas.
- **Batch job tanpa SLA waktu.** Untuk pipeline harian, ukuran yang benar adalah *freshness* dan *completeness*, bukan rasio ketersediaan per request.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Alert menyala tapi tak ada yang bertindak | rasio alert→tiket ditutup tanpa aksi | ambang terlalu ketat, atau alert bukan pada burn rate |
| Anggaran ludes di minggu pertama tiap bulan | grafik `BudgetLeft` per hari | SLO tidak realistis, atau ada kegagalan sistemik yang dinormalisasi |
| Burn rate tinggi tanpa keluhan pengguna | bandingkan SLI dengan tiket support | SLI mengukur hal yang salah — kemungkinan menghitung health-check atau trafik bot |
| Grafik SLI mulus 100% terus | cek apakah metrik benar-benar ter-scrape | instrumentasi mati; nol error karena nol data, bukan karena sehat |

Perintah cepat saat curiga instrumentasinya yang bohong:

```bash
# Pastikan target benar-benar ter-scrape dan tidak stale
curl -s localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job:.labels.job, health, lastError}'

# Bandingkan total request menurut metrik vs menurut access log
sum(increase(http_requests_total[1h]))
```
