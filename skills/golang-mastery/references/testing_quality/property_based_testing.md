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

## Diagram ASCII

```text
   UJI CONTOH vs UJI PROPERTI -- menjawab pertanyaan berbeda

   UJI CONTOH                        UJI PROPERTI
   Encode("abc") == "YWJj"           untuk SEMUA s:
        |                              Decode(Encode(s)) == s
        `-- mendokumentasikan               |
            perilaku yang dimaksud          `-- memverifikasi INVARIAN
                                                pada input yang tidak
   Anda yang memilih inputnya.               terpikirkan siapa pun.

   Keduanya diperlukan. Properti menemukan yang tidak Anda bayangkan;
   contoh menjelaskan apa yang seharusnya terjadi.

   ---------------------------------------------------------------

   SIKLUS RAPID: hasilkan -> uji -> PERKECIL

   seed --> generator --> input acak --> properti
                              |             |
                              |          GAGAL
                              |             |
                              |             v
                              |        SHRINKING: kecilkan input
                              |        sambil tetap gagal
                              |             |
                              |        "abc\x00\xff!!" (400 byte)
                              |             v  perkecil
                              |        "\x00"          (1 byte)
                              v             v
                        LULUS n kali    laporkan kasus MINIMAL + seed

   Nilai terbesar rapid bukan menemukan kegagalan -- tapi
   memperkecilnya sampai penyebabnya jelas.

   ---------------------------------------------------------------

   GENERATOR SEMPIT = UJI YANG MENIPU DIRI SENDIRI

   rapid.IntRange(0, 10)     -> 11 nilai. Uji TERLIHAT menyeluruh,
                                kenyataannya memeriksa 11 kasus.
   rapid.Int()               -> seluruh rentang, termasuk MinInt/MaxInt
                                tempat overflow benar-benar terjadi.

   Ruang input yang sempit adalah cara paling halus membuat
   laporan "1000 checks passed" yang tidak berarti apa-apa.
```

## 2. Kode Go Production-Ready

```go
package testingquality

import (
	"errors"
	"fmt"
	"slices"
	"testing"

	"pgregory.net/rapid"
)

// --- Domain: Inventory Price Calculator ---

// DiscountTier merepresentasikan tier diskon berdasarkan quantity.
//
// Diskon dinyatakan dalam BASIS POIN (1/100 persen) bertipe int, bukan
// float64. Alasannya bukan kerapian — lihat catatan pada Calculate.
type DiscountTier struct {
	MinQty      int
	DiskonBasis int // 0–10000 basis poin = 0%–100%
}

// PriceCalculator menghitung harga total dengan diskon berbasis tier.
type PriceCalculator struct {
	tiers []DiscountTier // selalu terurut menaik berdasarkan MinQty
}

// NewPriceCalculator membuat kalkulator baru dengan tier yang valid.
func NewPriceCalculator(tiers []DiscountTier) (*PriceCalculator, error) {
	if len(tiers) == 0 {
		return nil, errors.New("minimal satu tier diperlukan")
	}

	// Divalidasi SEBELUM diurutkan, dan atas SALINAN.
	//
	// Versi sebelumnya mengurutkan slice milik PEMANGGIL di tempat, lalu
	// menyimpan slice yang sama itu di dalam struct. Dua akibatnya:
	//   - urutan slice pemanggil berubah sebagai efek samping tersembunyi;
	//   - pemanggil tetap memegang slice yang sama, sehingga ia bisa
	//     mengubahnya kapan saja dan MEMATAHKAN invarian terurut yang
	//     diandalkan Calculate — tanpa memanggil satu pun metode.
	// Kelas cacat seperti inilah yang paling sering ditemukan property test,
	// dan berkas tentang property testing sebaiknya tidak memuatnya.
	for _, t := range tiers {
		if t.DiskonBasis < 0 || t.DiskonBasis > 10_000 {
			return nil, fmt.Errorf("diskon %d di luar rentang basis poin [0, 10000]", t.DiskonBasis)
		}
		if t.MinQty < 0 {
			return nil, fmt.Errorf("minQty %d tidak boleh negatif", t.MinQty)
		}
	}

	salinan := slices.Clone(tiers)
	slices.SortFunc(salinan, func(a, b DiscountTier) int { return a.MinQty - b.MinQty })
	return &PriceCalculator{tiers: salinan}, nil
}

// Calculate menghitung total dalam SATUAN MINOR (sen) dan mengembalikan int64.
//
// Ini bukan sekadar preferensi gaya. Versi sebelumnya bekerja dengan float64
// lalu membulatkan dengan `math.Round(total*100)/100`, dan pembulatan itu
// MEMATAHKAN properti yang diuji berkas ini sendiri:
//
//	unitPrice = 100.004
//	qty 1 -> 100.004 -> dibulatkan 100.00 -> biaya per unit 100.000
//	qty 2 -> 200.008 -> dibulatkan 200.01 -> biaya per unit 100.005
//
// Biaya per unit NAIK meski diskonnya sama. Uji propertinya memakai toleransi
// tetap 0.001 yang lebih kecil dari galat itu, sehingga ia akan gagal begitu
// rapid kebetulan membangkitkan nilai semacam ini — uji yang flaky karena
// propertinya memang tidak benar, bukan karena kodenya salah. Dengan aritmetika
// bilangan bulat, propertinya benar secara eksak dan toleransinya tidak perlu.
func (c *PriceCalculator) Calculate(hargaSatuanSen int64, qty int) (int64, error) {
	if hargaSatuanSen < 0 {
		return 0, fmt.Errorf("harga satuan tidak boleh negatif: %d", hargaSatuanSen)
	}
	if qty <= 0 {
		return 0, fmt.Errorf("qty harus positif: %d", qty)
	}

	diskon := 0
	for _, tier := range c.tiers { // terurut menaik: yang terakhir cocok = tertinggi
		if qty >= tier.MinQty {
			diskon = tier.DiskonBasis
		}
	}

	kotor := hargaSatuanSen * int64(qty)
	return kotor - (kotor*int64(diskon))/10_000, nil
}

// --- Unit Tests (Contoh yang Diketahui) ---

func tierUji() []DiscountTier {
	return []DiscountTier{
		{MinQty: 1, DiskonBasis: 0},     // 0% untuk 1+ unit
		{MinQty: 10, DiskonBasis: 1000}, // 10% untuk 10+ unit
		{MinQty: 50, DiskonBasis: 2000}, // 20% untuk 50+ unit
	}
}

func TestPriceCalculator_KasusDiketahui(t *testing.T) {
	calc, err := NewPriceCalculator(tierUji())
	if err != nil {
		t.Fatalf("NewPriceCalculator: %v", err)
	}

	tests := []struct {
		nama    string
		hargaSen int64
		qty      int
		mau      int64
	}{
		{"1 unit tanpa diskon", 10_000, 1, 10_000},
		{"10 unit diskon 10%", 10_000, 10, 90_000},
		{"50 unit diskon 20%", 10_000, 50, 400_000},
		{"100 unit tetap 20%", 1_000, 100, 80_000},
	}

	for _, tt := range tests {
		t.Run(tt.nama, func(t *testing.T) {
			got, err := calc.Calculate(tt.hargaSen, tt.qty)
			if err != nil {
				t.Fatalf("Calculate: %v", err)
			}
			// Perbandingan EKSAK. Toleransi tidak diperlukan lagi begitu
			// perhitungannya memakai bilangan bulat — dan toleransi yang
			// tidak diperlukan menyembunyikan kesalahan sebesar toleransinya.
			if got != tt.mau {
				t.Errorf("Calculate(%d, %d) = %d, mau %d", tt.hargaSen, tt.qty, got, tt.mau)
			}
		})
	}
}

// Invarian terurut milik kalkulator TIDAK boleh bisa dipatahkan pemanggil.
func TestTierPemanggilTidakMemengaruhiKalkulator(t *testing.T) {
	tiers := tierUji()
	calc, err := NewPriceCalculator(tiers)
	if err != nil {
		t.Fatalf("NewPriceCalculator: %v", err)
	}

	sebelum, err := calc.Calculate(10_000, 50)
	if err != nil {
		t.Fatalf("Calculate: %v", err)
	}

	// Pemanggil merusak slice-nya sendiri sesudah kalkulator dibuat.
	for i := range tiers {
		tiers[i].DiskonBasis = 9_999
	}

	sesudah, err := calc.Calculate(10_000, 50)
	if err != nil {
		t.Fatalf("Calculate: %v", err)
	}
	if sebelum != sesudah {
		t.Fatalf("perubahan slice pemanggil mengubah hasil kalkulator: %d -> %d", sebelum, sesudah)
	}
}

// --- Property-Based Tests ---

// TestProperty_HigherQtyNeverHigherUnitCost memverifikasi bahwa membeli lebih banyak
// tidak pernah menghasilkan harga per unit yang lebih tinggi (monotonic discount).
func TestProperty_HigherQtyNeverHigherUnitCost(t *testing.T) {
	calc, err := NewPriceCalculator(tierUji())
	if err != nil {
		t.Fatalf("NewPriceCalculator: %v", err) // galat konstruktor jangan dibuang
	}

	rapid.Check(t, func(t *rapid.T) {
		qtyA := rapid.IntRange(1, 100).Draw(t, "qtyA")
		qtyB := rapid.IntRange(qtyA, 200).Draw(t, "qtyB") // qtyB >= qtyA
		hargaSen := rapid.Int64Range(1, 100_000).Draw(t, "hargaSen")

		// Generator sudah menjamin masukan valid, jadi galat di sini berarti
		// ada yang salah — bukan alasan untuk t.Skip. Versi sebelumnya
		// memasang cabang Skip yang TIDAK PERNAH terjangkau, yang menyamarkan
		// kegagalan sungguhan sebagai kasus yang dilewati.
		totalA, err := calc.Calculate(hargaSen, qtyA)
		if err != nil {
			t.Fatalf("Calculate(%d, %d): %v", hargaSen, qtyA, err)
		}
		totalB, err := calc.Calculate(hargaSen, qtyB)
		if err != nil {
			t.Fatalf("Calculate(%d, %d): %v", hargaSen, qtyB, err)
		}

		// Properti: biaya per unit tidak pernah naik seiring kuantitas.
		//
		// Dibandingkan dengan perkalian silang, bukan pembagian: totalA/qtyA
		// versus totalB/qtyB sebagai pecahan bilangan bulat, tanpa pembulatan
		// dan tanpa toleransi. Perbandingan pecahan yang diubah menjadi float
		// hanya memindahkan masalah yang baru saja dihilangkan.
		if totalB*int64(qtyA) > totalA*int64(qtyB) {
			t.Fatalf("biaya per unit NAIK: qty=%d total=%d vs qty=%d total=%d",
				qtyA, totalA, qtyB, totalB)
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
				MinQty:      rapid.IntRange(0, 1000).Draw(t, fmt.Sprintf("minQty_%d", i)),
				DiskonBasis: rapid.IntRange(0, 10_000).Draw(t, fmt.Sprintf("diskon_%d", i)),
			}
		}

		// Generator hanya menghasilkan konfigurasi yang sah, jadi galat di
		// sini adalah kegagalan sungguhan.
		calc, err := NewPriceCalculator(tiers)
		if err != nil {
			t.Fatalf("NewPriceCalculator(%v): %v", tiers, err)
		}

		hargaSen := rapid.Int64Range(0, 1_000_000).Draw(t, "hargaSen")
		qty := rapid.IntRange(1, 1000).Draw(t, "qty")

		total, err := calc.Calculate(hargaSen, qty)
		if err != nil {
			t.Fatalf("Calculate(%d, %d): %v", hargaSen, qty, err)
		}

		// Properti: total tidak pernah negatif
		if total < 0 {
			t.Fatalf("total negatif: %d (hargaSen=%d, qty=%d)", total, hargaSen, qty)
		}

		// Properti: total tidak pernah melebihi harga tanpa diskon.
		// Perbandingan eksak, tanpa toleransi +0.01 yang dulu diperlukan
		// hanya untuk menutupi galat pembulatan float64.
		maksimum := hargaSen * int64(qty)
		if total > maksimum {
			t.Fatalf("total %d melebihi harga tanpa diskon %d", total, maksimum)
		}
	})
}

// TestProperty_SortModelBased memakai pendekatan "oracle model": bandingkan
// implementasi sendiri dengan referensi pustaka standar.
//
// Agar pendekatan ini berarti, yang diuji WAJIB implementasi yang berbeda
// dari oracle-nya. Versi sebelumnya menulis `MyCustomSort` yang isinya hanya
// memanggil `sort.Ints`, sementara oracle-nya juga `sort.Ints` — uji itu
// membandingkan pustaka standar dengan dirinya sendiri dan TIDAK MUNGKIN
// gagal, berapa pun kasus yang dibangkitkan rapid. Contoh unggulan
// oracle-model di berkas tentang property testing sebaiknya benar-benar
// menguji sesuatu.
func TestProperty_SortModelBased(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		input := rapid.SliceOf(rapid.IntRange(-1000, 1000)).Draw(t, "input")

		harap := slices.Clone(input)
		slices.Sort(harap) // oracle

		got := slices.Clone(input)
		UrutSisip(got) // implementasi yang diuji, BUKAN pembungkus oracle

		if !slices.Equal(got, harap) {
			t.Fatalf("hasil berbeda dari oracle\n  masukan: %v\n  dapat  : %v\n  mau    : %v",
				input, got, harap)
		}
	})
}

// UrutSisip adalah insertion sort — implementasi nyata, bukan pembungkus.
func UrutSisip(arr []int) {
	for i := 1; i < len(arr); i++ {
		nilai := arr[i]
		j := i - 1
		for j >= 0 && arr[j] > nilai {
			arr[j+1] = arr[j]
			j--
		}
		arr[j+1] = nilai
	}
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
