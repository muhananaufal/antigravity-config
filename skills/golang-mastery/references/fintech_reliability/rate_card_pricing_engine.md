# Rate Card & Pricing Engine di Sistem Keuangan

> **Berlaku:** Go 1.21+ · **Lihat juga:** `fintech_reliability/decimal_arithmetic_money.md` · `fintech_reliability/financial_reporting_olap.md` · `distributed_patterns_resilience/feature_flags_launchdarkly.md` · `engineering_practice/adr_decision_records.md`

Billing Engine fintech harus menghitung fee untuk jutaan transaksi secara deterministik, akurat, dan tanpa float rounding error. Setiap merchant punya Rate Card yang dinegosiasikan khusus — hardcoding logika per-merchant adalah anti-scalable.

---

## 1. Konsep & Internals

Skema harga yang umum:
- **Flat Fee**: Rp 4.000 per transaksi (berapapun nilai transaksinya)
- **Percentage Fee**: 1.5% dari gross amount
- **Tiered Volume Pricing**: Volume 0-10jt = 1.5%, 10jt-50jt = 1.2%, >50jt = 0.8%
- **Capped Percentage**: 1.5%, maksimum Rp 10.000

## 2. Diagram ASCII: Alur Pricing Engine

```ascii
[ TX: Rp 50.000 ] -- Merchant_ID: "M-A1" -- Produk: "QRIS"
        |
        v
+-----------------------------------------------+
|  1. Fetch Rate Card dari DB (by MerchantID)   |
|     Cache per-merchant di Redis (TTL: 1h)     |
+----------------------+------------------------+
                       |
                       v
+-----------------------------------------------+
|  2. Evaluasi Skema Pricing                    |
|     FLAT      → BaseValue                     |
|     PERCENT   → Amount × (BaseValue/100)      |
|     TIERED    → Cari bracket yang cocok       |
+----------------------+------------------------+
                       |
                       v
+-----------------------------------------------+
|  3. Terapkan Floor/Cap                        |
|     if fee < MinFee → fee = MinFee            |
|     if fee > MaxFee → fee = MaxFee            |
|     RoundBank(2)  ← banker's rounding         |
+-----------------------------------------------+
        |
        +---→ [ Audit Log: gross=50000, fee=750, rule=PERCENT-1.5% ]
```

## 3. Production Code

Skema Kalkulator Dinamis yang anti-*Float* dan aman untuk Tiering. 

```go
package pricing

import (
	"errors"
	"fmt"
	"testing"

	"github.com/shopspring/decimal"
)

type FeeType string

const (
	FeeTypeFlat       FeeType = "FLAT"
	FeeTypePercentage FeeType = "PERCENTAGE"
	FeeTypeTiered     FeeType = "TIERED" // volume-based brackets
)

// Tier merepresentasikan satu bracket dalam tiered pricing.
type Tier struct {
	MinVolume decimal.Decimal // inklusif (>= MinVolume)
	MaxVolume decimal.Decimal // eksklusif (< MaxVolume), Zero = tidak ada batas atas
	Rate      decimal.Decimal // persentase dalam angka (misal 1.5 untuk 1.5%)
}

// RateCard merepresentasikan kontrak merchant
type RateCard struct {
	Type      FeeType
	BaseValue decimal.Decimal // Flat: nominal; Percent: persen (1.5 = 1.5%)
	MinFee    decimal.Decimal // Floor — 0 jika tidak ada
	MaxFee    decimal.Decimal // Ceiling — 0 jika tidak ada
	Tiers     []Tier          // hanya digunakan saat Type == TIERED
}

// PricingEngine menampung kumpulan rule logic.
type PricingEngine struct{}

func NewPricingEngine() *PricingEngine {
	return &PricingEngine{}
}

// CalculateFee mengevaluasi fee berdasar Rate Card dan Gross Amount
func (e *PricingEngine) CalculateFee(grossAmount decimal.Decimal, card RateCard) (decimal.Decimal, error) {
	if grossAmount.LessThanOrEqual(decimal.Zero) {
		return decimal.Zero, errors.New("gross amount must be greater than zero")
	}

	var calculatedFee decimal.Decimal

	switch card.Type {
	case FeeTypeFlat:
		calculatedFee = card.BaseValue

	case FeeTypePercentage:
		pct := card.BaseValue.Div(decimal.NewFromInt(100))
		calculatedFee = grossAmount.Mul(pct)

	case FeeTypeTiered:
		rate, err := findTieredRate(grossAmount, card.Tiers)
		if err != nil {
			return decimal.Zero, err
		}
		pct := rate.Div(decimal.NewFromInt(100))
		calculatedFee = grossAmount.Mul(pct)

	default:
		return decimal.Zero, fmt.Errorf("unknown fee type: %s", card.Type)
	}

	return applyCaps(calculatedFee, card.MinFee, card.MaxFee), nil
}

// findTieredRate mencari rate yang cocok berdasarkan gross amount dan brackets.
func findTieredRate(amount decimal.Decimal, tiers []Tier) (decimal.Decimal, error) {
	for _, tier := range tiers {
		// MinVolume <= amount < MaxVolume (MaxVolume == 0 berarti tidak ada batas atas)
		if amount.GreaterThanOrEqual(tier.MinVolume) {
			if tier.MaxVolume.IsZero() || amount.LessThan(tier.MaxVolume) {
				return tier.Rate, nil
			}
		}
	}
	return decimal.Zero, errors.New("no matching tier found for amount (gap in tier definition)")
}

// applyCaps memotong hasil jika melampaui rentang minimum atau maksimum
func applyCaps(fee, min, max decimal.Decimal) decimal.Decimal {
	result := fee
	
	// Jika MaxFee terdefinisi (> 0) dan hasil lebih besar, tekan ke max
	if max.GreaterThan(decimal.Zero) && result.GreaterThan(max) {
		result = max
	}
	
	// Jika MinFee terdefinisi (> 0) dan hasil lebih kecil, angkat ke min
	if min.GreaterThan(decimal.Zero) && result.LessThan(min) {
		result = min
	}

	// Lakukan Bank Rounding terakhir untuk mata uang presisi 2 (Contoh: IDR/USD standar)
	return result.RoundBank(2)
}

// --- Unit Tests ---

func TestPricingEngine_PercentageWithCap(t *testing.T) {
	engine := NewPricingEngine()
	amount := decimal.RequireFromString("150000")

	// 1.5% dari 150.000 = 2.250, tapi capped di 2.000
	card := RateCard{
		Type:      FeeTypePercentage,
		BaseValue: decimal.RequireFromString("1.5"),
		MaxFee:    decimal.RequireFromString("2000"),
	}
	fee, err := engine.CalculateFee(amount, card)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !fee.Equal(decimal.RequireFromString("2000")) {
		t.Errorf("expected cap 2000, got %s", fee)
	}
}

func TestPricingEngine_FlatFee(t *testing.T) {
	engine := NewPricingEngine()
	card := RateCard{
		Type:      FeeTypeFlat,
		BaseValue: decimal.RequireFromString("4000"),
	}
	fee, _ := engine.CalculateFee(decimal.RequireFromString("150000"), card)
	if !fee.Equal(decimal.RequireFromString("4000")) {
		t.Errorf("expected flat 4000, got %s", fee)
	}
}

func TestPricingEngine_TieredPricing(t *testing.T) {
	engine := NewPricingEngine()

	// Tier A: 0 - 10jt = 1.5%
	// Tier B: 10jt - 50jt = 1.2%
	// Tier C: >50jt = 0.8%
	card := RateCard{
		Type: FeeTypeTiered,
		Tiers: []Tier{
			{MinVolume: decimal.Zero, MaxVolume: decimal.RequireFromString("10000000"), Rate: decimal.RequireFromString("1.5")},
			{MinVolume: decimal.RequireFromString("10000000"), MaxVolume: decimal.RequireFromString("50000000"), Rate: decimal.RequireFromString("1.2")},
			{MinVolume: decimal.RequireFromString("50000000"), MaxVolume: decimal.Zero, Rate: decimal.RequireFromString("0.8")},
		},
	}

	tests := []struct {
		amount string
		wantFee string
	}{
		{"5000000", "75000"},    // tier A: 5jt × 1.5% = 75.000
		{"20000000", "240000"},  // tier B: 20jt × 1.2% = 240.000
		{"100000000", "800000"}, // tier C: 100jt × 0.8% = 800.000
	}

	for _, tt := range tests {
		amount := decimal.RequireFromString(tt.amount)
		fee, err := engine.CalculateFee(amount, card)
		if err != nil {
			t.Errorf("CalculateFee(%s): %v", tt.amount, err)
			continue
		}
		if !fee.Equal(decimal.RequireFromString(tt.wantFee)) {
			t.Errorf("amount=%s: got fee %s, want %s", tt.amount, fee, tt.wantFee)
		}
	}
}

func TestPricingEngine_ZeroAmount(t *testing.T) {
	engine := NewPricingEngine()
	card := RateCard{Type: FeeTypeFlat, BaseValue: decimal.RequireFromString("1000")}
	_, err := engine.CalculateFee(decimal.Zero, card)
	if err == nil {
		t.Error("expected error for zero amount")
	}
}

func TestPricingEngine_UnknownFeeType(t *testing.T) {
	engine := NewPricingEngine()
	card := RateCard{Type: "BONUS"}
	_, err := engine.CalculateFee(decimal.RequireFromString("10000"), card)
	if err == nil {
		t.Error("expected error for unknown fee type")
	}
}

func TestPricingEngine_FloorCap(t *testing.T) {
	engine := NewPricingEngine()
	// 1% dari 100 = 1, tapi MinFee = 500
	card := RateCard{
		Type:      FeeTypePercentage,
		BaseValue: decimal.RequireFromString("1"),
		MinFee:    decimal.RequireFromString("500"),
	}
	fee, _ := engine.CalculateFee(decimal.RequireFromString("100"), card)
	if !fee.Equal(decimal.RequireFromString("500")) {
		t.Errorf("expected floor 500, got %s", fee)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Hardcoding Logika Kontrak di Source Code
**Mengapa berbahaya:** "Untuk Merchant Gojek potong 10%, sisanya 15%". Jika Anda mengkodifikasi *business rules* menggunakan parameter IF dan *strings* nama merchant di dalam bahasa Go, setiap kali tim sales mendapatkan deal baru, Anda butuh *Pull Request*, QA testing, dan Kubernetes Deployment ulang. 

```go
// BAD: Logic IF bercabang (Spaghetti Billing)
if merchant == "Grab" {
    fee = amt * 0.10
} else {
    fee = amt * 0.15
}
```
```go
// GOOD: Logika Agnostik (Engine Pattern), data diambil konstan dari DB per transaksi.
```

### ❌ Anti-Pattern 2: Tipe Variabel `Float64` untuk Rate Multiplier
**Mengapa berbahaya:** Jika Rate Card Anda adalah `0.3%` dan Anda menyimpannya sebagai float Go `0.003`. Perhitungan `$100.00 * 0.003` via floating point mungkin terpotong presisinya secara biner. Ini mengakibatkan fraksi penny/sen memotong total tagihan (penny shaving) miliaran perak selama kuartal tersebut. Selalu operasikan persentase murni via `shopspring/decimal`.

### ❌ Anti-Pattern 3: Pembulatan ke Bawah (Truncate) secara Agresif di Persentase
**Mengapa berbahaya:** Banyak developer membuang sisa desimal setelah mengalikan persentase `math.Floor(fee)` agar nilai selalu "aman bulat". Di industri finansial, membulatkan tagihan ke bawah terus menerus (khususnya untuk *micro-transactions* < Rp 1.000) adalah kerugian absolut bandar. Selalu gunakan `RoundBank/RoundHalfEven` di level presisi koin fisik terkecil dari mata uang agar statistik tagihan berimbang (*zero sum bias*).

## Edge Cases & Defensive Programming

1. **Overlapping Tier Treshold (Missing Logic)**: Saat mendefinisikan *Tiered Pricing* bulanan, ada batas *volume*. (Tier A: $0 - $1000). (Tier B: $1001 - $5000). Ada rentang tak bertuan di sini! Jika transaksi senilai persis `$1000.50`, aturan mana yang berlaku? Evaluasi batas *greater-than* (>) vs *greater-than-or-equal* (>=) harus kedap celah, dan mesin penilai *Rule Engine* harus melontarkan panik `ErrNoRuleFound` jika data jatuh di zona bolong ini alih-alih me-return `0 fee`.
2. **Dynamic Tax (PPN) Override**: *Pricing Engine* tidak hidup sendirian. Pajak Nilai Tambah (PPN/VAT) berubah per kebijakan pemerintah negara (contoh dari 10% menjadi 11%). Jangan pernah menyatukan "Margin Profit" dengan "Pajak" ke dalam 1 tarif persentase gabungan, karena saat Anda melapor PPN ke kantor pajak, Anda tidak bisa memisahkannya dengan bersih. Kalkulasikan Margin dulu, baru tindihkan *(stack)* hitungan Pajak di atas Margin tersebut sebagai *Layer* tambahan di Engine.
3. **Refund Reconciliation Trap**: Saat merchant melakukan operasi `Refund / Batal Belanja` kepada pembeli senilai Rp 50.000, mesin tidak boleh memotong *fee* baru. Sebaliknya, mesin harus mampu mengambil *Rate Card* bersejarah (pada tanggal ketika transaksi awal itu diketuk, **BUKAN** Rate Card merchant hari ini) untuk mengkalkulasi pengembalian uang komisi *(Clawback/Refund Fee)*. Jangan menggunakan `JOIN` ke tabel Rate-Merchant aktif terkini, gunakan relasi *Snapshot* pada transaksi asli.

## Kapan JANGAN Pakai Ini

- **Aturan harga di kode tanpa versi.** Harga yang berlaku pada saat transaksi WAJIB bisa direkonstruksi berbulan-bulan kemudian, saat pelanggan atau auditor bertanya. Deploy bukan mekanisme pencatatan.
- **Menghitung ulang harga historis dengan aturan yang berlaku sekarang.** Itu mengubah masa lalu. Transaksi menyimpan harga yang **disepakati saat itu**, bukan referensi ke aturan yang bisa berubah.
- **Pembulatan yang berbeda antara estimasi dan tagihan.** Selisih kecil yang konsisten berubah menjadi keluhan pelanggan dan kehilangan kepercayaan yang jauh lebih mahal daripada selisihnya.
- **Aturan yang saling tumpang tindih tanpa urutan yang ditetapkan.** Hasilnya jadi bergantung pada urutan evaluasi yang tidak pernah diputuskan siapa pun — dan berubah saat aturan ditambah.
- **Mesin harga tanpa uji regresi terhadap kasus nyata yang tercatat.** Regresi harga adalah kerugian langsung, dan biasanya baru ketahuan dari sisi pelanggan.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Harga historis tidak bisa dijelaskan | versi aturan pada transaksi | Aturan tidak diversi atau tidak dicatat |
| Estimasi berbeda dari tagihan | titik dan aturan pembulatan | Dua jalur perhitungan berbeda |
| Hasil berubah saat aturan ditambah | urutan evaluasi aturan | Tumpang tindih tanpa prioritas |
| Pelanggan melaporkan tagihan salah | uji regresi harga | Perubahan lolos tanpa terdeteksi |
| Harga berbeda antar kanal | sumber aturan per kanal | Aturan diduplikasi di beberapa tempat |

```sql
-- Transaksi WAJIB menyimpan versi aturan yang dipakai
SELECT versi_aturan, count(*), min(dibuat_pada), max(dibuat_pada)
FROM transaksi GROUP BY 1 ORDER BY 2 DESC;

-- Estimasi vs tagihan: selisih yang konsisten searah adalah masalah pembulatan
SELECT count(*) FILTER (WHERE estimasi <> final)          AS berbeda,
       avg(final - estimasi)                              AS rata_selisih,
       max(abs(final - estimasi))                         AS selisih_terbesar
FROM transaksi WHERE dibuat_pada > now() - interval '7 days';
```

```bash
# Uji regresi harga terhadap kasus nyata yang tercatat
go test -run=TestHargaRegresi -v ./pricing/...
```
