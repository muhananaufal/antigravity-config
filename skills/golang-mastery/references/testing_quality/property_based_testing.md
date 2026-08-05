# Property-Based Testing di Go dengan `rapid`

> **Berlaku:** Go 1.21+ · `pgregory.net/rapid` · **Lihat juga:** `testing_quality/fuzz_testing_go.md` · `testing_quality/unit_testing_testify.md` · `testing_quality/synctest_deterministic_concurrency.md` · `runtime_internals/go_generics_type_parameters.md`

Property-Based Testing (PBT) mendefinisikan *invariant* — aturan yang HARUS selalu benar — dan secara otomatis menghasilkan ratusan input untuk mencoba membantah aturan tersebut. Berbeda dari unit test yang memverifikasi output spesifik, PBT memverifikasi *sifat* dari fungsi. `pgregory.net/rapid` adalah library PBT terbaik untuk Go dengan shrinking yang sangat powerful.

---

## 1. Mental Model: Properti vs Contoh

```
Unit Test:                    Property-Based Test:
  input  → output                 ∀ input yang valid:
  "abc" → "cba"  ✓                 invariant_1(f(input)) = true
  "xyz" → "zyx"  ✓                 invariant_2(input, f(input)) = true
  ...                              ...

Contoh invariant yang kuat:
  1. Round-trip:    decode(encode(x)) == x
  2. Idempotency:   sort(sort(x)) == sort(x)
  3. Commutativity: add(a,b) == add(b,a)
  4. Preservation:  len(sort(x)) == len(x) && sum(sort(x)) == sum(x)
  5. Oracle model:  mySort(x) == stdlib.sort(x) [model-based]

Shrinking (fitur kunci rapid):
  Failure input: [99, 17, 42, 3, 88, 55, 23, 71]
  Rapid shrinks: [2, 1] → input minimal yang reproduce bug yang sama
```

---

## 2. Kode Go Production-Ready

```go
package testingquality

import (
	"math"
	"sort"
	"testing"
	"time"

	"pgregory.net/rapid"
)

// --- Domain: Inventory Price Calculator ---

// DiscountTier merepresentasikan tier diskon berdasarkan quantity.
type DiscountTier struct {
	MinQty   int
	Discount float64 // 0.0 – 1.0 (0% – 100%)
}

// PriceCalculator menghitung harga total dengan diskon berbasis tier.
type PriceCalculator struct {
	tiers []DiscountTier // harus diurutkan ascending by MinQty
}

// NewPriceCalculator membuat kalkulator baru dengan tier yang valid.
func NewPriceCalculator(tiers []DiscountTier) (*PriceCalculator, error) {
	if len(tiers) == 0 {
		return nil, errors.New("at least one tier required")
	}
	// Sort by MinQty
	sort.Slice(tiers, func(i, j int) bool {
		return tiers[i].MinQty < tiers[j].MinQty
	})
	for _, t := range tiers {
		if t.Discount < 0 || t.Discount > 1 {
			return nil, fmt.Errorf("invalid discount %v: must be [0, 1]", t.Discount)
		}
		if t.MinQty < 0 {
			return nil, fmt.Errorf("invalid minQty %d: must be >= 0", t.MinQty)
		}
	}
	return &PriceCalculator{tiers: tiers}, nil
}

// Calculate menghitung total harga untuk quantity unit dengan harga per unit.
func (c *PriceCalculator) Calculate(unitPrice float64, qty int) (float64, error) {
	if unitPrice < 0 {
		return 0, fmt.Errorf("unitPrice must be non-negative, got %v", unitPrice)
	}
	if qty <= 0 {
		return 0, fmt.Errorf("qty must be positive, got %d", qty)
	}

	discount := 0.0
	for _, tier := range c.tiers {
		if qty >= tier.MinQty {
			discount = tier.Discount
		}
	}

	total := unitPrice * float64(qty) * (1 - discount)
	// Round ke 2 desimal untuk harga uang
	return math.Round(total*100) / 100, nil
}

// --- Unit Tests (Contoh yang Diketahui) ---

func TestPriceCalculator_KnownCases(t *testing.T) {
	tiers := []DiscountTier{
		{MinQty: 1, Discount: 0.0},   // 0% untuk 1+ unit
		{MinQty: 10, Discount: 0.10}, // 10% untuk 10+ unit
		{MinQty: 50, Discount: 0.20}, // 20% untuk 50+ unit
	}
	calc, err := NewPriceCalculator(tiers)
	if err != nil {
		t.Fatalf("NewPriceCalculator: %v", err)
	}

	tests := []struct {
		name      string
		unitPrice float64
		qty       int
		want      float64
	}{
		{"1 unit no discount", 100.0, 1, 100.00},
		{"10 units 10% off", 100.0, 10, 900.00},
		{"50 units 20% off", 100.0, 50, 4000.00},
		{"100 units still 20% off", 10.0, 100, 800.00},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := calc.Calculate(tt.unitPrice, tt.qty)
			if err != nil {
				t.Fatalf("Calculate: %v", err)
			}
			if math.Abs(got-tt.want) > 0.01 {
				t.Errorf("Calculate(%v, %d) = %v, want %v", tt.unitPrice, tt.qty, got, tt.want)
			}
		})
	}
}

// --- Property-Based Tests ---

// TestProperty_HigherQtyNeverHigherUnitCost memverifikasi bahwa membeli lebih banyak
// tidak pernah menghasilkan harga per unit yang lebih tinggi (monotonic discount).
func TestProperty_HigherQtyNeverHigherUnitCost(t *testing.T) {
	tiers := []DiscountTier{
		{MinQty: 1, Discount: 0.0},
		{MinQty: 10, Discount: 0.10},
		{MinQty: 50, Discount: 0.20},
	}
	calc, _ := NewPriceCalculator(tiers)

	rapid.Check(t, func(t *rapid.T) {
		// Generate dua quantity: qtyA < qtyB
		qtyA := rapid.IntRange(1, 100).Draw(t, "qtyA")
		qtyB := rapid.IntRange(qtyA, 200).Draw(t, "qtyB") // qtyB >= qtyA
		unitPrice := rapid.Float64Range(0.01, 1000.0).Draw(t, "unitPrice")

		totalA, err := calc.Calculate(unitPrice, qtyA)
		if err != nil {
			t.Skip() // skip invalid input
		}
		totalB, err := calc.Calculate(unitPrice, qtyB)
		if err != nil {
			t.Skip()
		}

		// Properti: harga per unit B tidak boleh lebih mahal dari A
		unitCostA := totalA / float64(qtyA)
		unitCostB := totalB / float64(qtyB)

		if unitCostB > unitCostA+0.001 { // tolerance untuk floating point
			t.Fatalf("unit cost increased with higher qty!\n"+
				"  qty=%d unitCost=%.4f vs qty=%d unitCost=%.4f",
				qtyA, unitCostA, qtyB, unitCostB)
		}
	})
}

// TestProperty_TotalAlwaysNonNegative memverifikasi output selalu >= 0.
func TestProperty_TotalAlwaysNonNegative(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		// Generate tier yang valid
		numTiers := rapid.IntRange(1, 5).Draw(t, "numTiers")
		tiers := make([]DiscountTier, numTiers)
		for i := range tiers {
			tiers[i] = DiscountTier{
				MinQty:   rapid.IntRange(0, 1000).Draw(t, fmt.Sprintf("minQty_%d", i)),
				Discount: rapid.Float64Range(0, 1).Draw(t, fmt.Sprintf("discount_%d", i)),
			}
		}

		calc, err := NewPriceCalculator(tiers)
		if err != nil {
			t.Skip() // invalid tier config — skip
		}

		unitPrice := rapid.Float64Range(0, 10000).Draw(t, "unitPrice")
		qty := rapid.IntRange(1, 1000).Draw(t, "qty")

		total, err := calc.Calculate(unitPrice, qty)
		if err != nil {
			t.Skip()
		}

		// Properti: total tidak pernah negatif
		if total < 0 {
			t.Fatalf("total price negative: %.4f (unitPrice=%.2f, qty=%d)", total, unitPrice, qty)
		}

		// Properti: total tidak melebihi tanpa diskon
		maxPossible := unitPrice * float64(qty)
		if total > maxPossible+0.01 {
			t.Fatalf("total %.4f exceeds max possible %.4f", total, maxPossible)
		}
	})
}

// TestProperty_SortStable_ModelBased menggunakan pendekatan "oracle model":
// bandingkan implementasi custom kita dengan referensi stdlib.
func TestProperty_SortStable_ModelBased(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		// Generate slice of int
		input := rapid.SliceOf(rapid.IntRange(-1000, 1000)).Draw(t, "input")

		// Oracle: stdlib sort
		expected := make([]int, len(input))
		copy(expected, input)
		sort.Ints(expected)

		// System under test: custom sort
		actual := make([]int, len(input))
		copy(actual, input)
		MyCustomSort(actual)

		// Properti 1: length preserved
		if len(actual) != len(expected) {
			t.Fatalf("length changed: %d → %d", len(expected), len(actual))
		}

		// Properti 2: semua elemen identik dengan oracle
		for i := range actual {
			if actual[i] != expected[i] {
				t.Fatalf("sort differs at index %d: got %d, want %d\ninput: %v",
					i, actual[i], expected[i], input)
			}
		}
	})
}

// MyCustomSort adalah sort yang akan di-verify dengan PBT (contoh sederhana).
func MyCustomSort(arr []int) {
	sort.Ints(arr) // dalam produksi nyata, ini custom implementation
}
```

---

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Memverifikasi Output Spesifik (Bukan Properti)

```go
// BAD: ini bukan PBT, ini unit test dengan input random yang selalu gagal
rapid.Check(t, func(t *rapid.T) {
    x := rapid.Int().Draw(t, "x")
    result := Double(x)
    if result != 42 { // selalu gagal kecuali x=21
        t.Fatalf("expected 42, got %d", result)
    }
})

// GOOD: verifikasi properti yang selalu benar untuk semua input
rapid.Check(t, func(t *rapid.T) {
    x := rapid.Int().Draw(t, "x")
    result := Double(x)
    // Properti: Double(x) selalu genap
    if result%2 != 0 {
        t.Fatalf("Double(%d) = %d, expected even number", x, result)
    }
    // Properti: Double(x)/2 == x (inverse operation)
    if result/2 != x {
        t.Fatalf("Double(%d)/2 = %d, want %d", x, result/2, x)
    }
})
```

**Kenapa berbahaya:** PBT dengan expected value spesifik hanya verifikasi 1 kasus dan gagal untuk semua input lain. Anda kehilangan seluruh value dari PBT — eksplorasi ratusan input untuk menemukan edge case.

### ❌ Anti-Pattern 2: State Global/Outer yang Di-mutasi dalam Closure

```go
// BAD: closure dijalankan ratusan kali — mutasi outer state = bug tersembunyi
totalRevenue := 0.0
rapid.Check(t, func(t *rapid.T) {
    price := rapid.Float64Range(1, 100).Draw(t, "price")
    qty := rapid.IntRange(1, 10).Draw(t, "qty")
    totalRevenue += price * float64(qty) // salah! closure dipanggil ulang → akumulasi state
})
// totalRevenue tidak berarti — di-reset tiap shrink iteration juga

// GOOD: closure harus idempotent — semua kalkulasi lokal
rapid.Check(t, func(t *rapid.T) {
    price := rapid.Float64Range(1, 100).Draw(t, "price")
    qty := rapid.IntRange(1, 10).Draw(t, "qty")
    total := price * float64(qty) // lokal
    if total < 0 {
        t.Fatalf("total negative: %v", total)
    }
})
```

**Kenapa berbahaya:** `rapid.Check` menjalankan closure ratusan kali. Selama shrinking (mencari minimal failing case), closure dijalankan ulang dengan berbagai variasi. State yang terakumulasi antar run membuat hasil tidak deterministic dan invariant yang dicek tidak valid.

### ❌ Anti-Pattern 3: Generator Terlalu Sempit → Coverage Rendah

```go
// BAD: generator terlalu constrained — melewatkan boundary values penting
rapid.Check(t, func(t *rapid.T) {
    qty := rapid.IntRange(2, 8).Draw(t, "qty") // hanya 2-8, melewatkan 0,1,9,10!
    // Tier boundary di qty=10 tidak pernah dicapai
})

// GOOD: include boundary values dan extend range
rapid.Check(t, func(t *rapid.T) {
    qty := rapid.IntRange(0, 100).Draw(t, "qty") // include boundary values 0, 1, 10, 50
    if qty <= 0 {
        t.Skip() // skip invalid, tapi biarkan generator coba
    }
    // Sekarang tier boundaries (10, 50) akan di-hit
})
```

**Kenapa berbahaya:** PBT yang membatasi range generator terlalu ketat tidak akan menemukan bug di boundary. Tier discount yang salah di qty=10 tidak akan terdeteksi jika generator hanya 2-8.

---

## 4. Edge Cases & Defensive Programming

1. **Floating Point Equality dalam PBT:** Jangan gunakan `==` untuk float di property check — gunakan toleransi: `math.Abs(a-b) < 1e-9`. Operasi floating point tidak associative; `(a+b)+c ≠ a+(b+c)` secara exact.

2. **Shrinking Overhead untuk Struct Kompleks:** Saat rapid menemukan failing input dan mencoba menyusutkannya, generasi struct kompleks (nested, banyak field) bisa memakan waktu lama. Gunakan `rapid.Custom()` untuk mendefinisikan shrinker yang lebih efisien, atau simpan hanya ID/seed yang mereproduksi failure.

3. **Time-Based Non-Determinism:** Fungsi yang bergantung pada `time.Now()` adalah musuh PBT — hasil berbeda tiap run. Inject waktu via interface: `type Clock interface { Now() time.Time }` dan gunakan `rapid.Custom()` untuk generate `time.Time` yang controlled.

4. **Seed untuk Reproducibility:** Secara default, rapid menggunakan seed random. Untuk me-replay run yang spesifik, set `RAPID_SEED=<value>` environment variable. Ini penting saat debugging failure yang hanya terjadi di CI.

5. **`rapid.Check` vs `rapid.MakeCheck`:** Gunakan `rapid.MakeCheck` untuk properti yang perlu dijalankan di luar `testing.T` context (misal: dalam benchmark). `rapid.Check(t, ...)` adalah shorthand untuk test context biasa.

## Kapan JANGAN Pakai Ini

- **Untuk perilaku yang memang berupa daftar kasus.** "Kode negara `ID` menghasilkan `+62`" adalah tabel, bukan properti. Memaksakan generator di situ hanya mengaburkan maksudnya.
- **Ketika propertinya menduplikasi implementasi.** Bila oracle-nya adalah menulis ulang fungsi yang sama dengan cara lain, uji itu hanya membuktikan Anda menulis bug yang sama dua kali.
- **Generator yang terlalu sempit.** `rapid.IntRange(0, 10)` membuat uji **terlihat** menyeluruh padahal hanya memeriksa sebelas nilai. Ruang input yang sempit adalah cara paling halus menipu diri sendiri.
- **Untuk kode dengan efek samping yang tidak bisa diulang.** Properti butuh determinisme. Kode yang menyentuh waktu nyata, jaringan, atau berkas harus di-*inject* dulu agar bisa dikendalikan.
- **Sebagai pengganti uji contoh.** Uji contoh mendokumentasikan perilaku yang dimaksudkan; properti memverifikasi invarian. Keduanya menjawab pertanyaan berbeda dan saling melengkapi.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Properti lulus sejak hari pertama, selamanya | rentang generator | Generator terlalu sempit, atau propertinya trivial |
| Kegagalan tidak bisa direproduksi | apakah seed dicatat | Seed tidak disimpan bersama laporan kegagalan |
| Shrinking berjalan sangat lama | ukuran ruang input | Input terlalu besar; batasi generator atau naikkan `shrinktime` |
| Properti gagal acak di CI saja | efek samping di dalam properti | Ada state global atau waktu nyata yang ikut terlibat |
| Bug produksi yang "seharusnya tertangkap" | invarian mana yang diuji | Properti menguji hal yang tidak berhubungan dengan bug itu |

```bash
# Perbanyak percobaan untuk memperluas ruang yang benar-benar dijelajahi
go test -run=TestProperty -rapid.checks=1000 ./...

# Reproduksi kegagalan dengan seed yang dilaporkan
go test -run=TestProperty -rapid.seed=1717171717 ./...

# Beri waktu lebih untuk memperkecil kasus pemicu
go test -run=TestProperty -rapid.shrinktime=60s ./...

# Melihat nilai yang benar-benar dihasilkan generator
go test -run=TestProperty -rapid.v -rapid.checks=20 ./...
```
