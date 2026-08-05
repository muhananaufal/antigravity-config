# Perhitungan Moneter dengan Decimal Arithmetic di Go

> **Berlaku:** Go 1.21+ · `shopspring/decimal` · PostgreSQL `numeric` · **Lihat juga:** `fintech_reliability/double_entry_ledger.md` · `fintech_reliability/rate_card_pricing_engine.md` · `fintech_reliability/reconciliation_engine.md` · `db_sqlc/sqlc_pgx_driver.md`

## Concept/Internals
Dalam domain teknologi finansial (fintech), akurasi perhitungan adalah hal mutlak. Penggunaan tipe data `float32` atau `float64` (yang berbasis IEEE 754 *floating-point arithmetic*) untuk merepresentasikan nilai uang adalah tabu besar. Floating point menggunakan basis-2 untuk merepresentasikan pecahan, yang berarti angka desimal basis-10 sederhana seperti `0.1` tidak dapat direpresentasikan secara eksak. Akibatnya, operasi sederhana seperti `0.1 + 0.2` akan menghasilkan `0.30000000000000004`. Akumulasi kesalahan ini akan berujung pada selisih akuntansi (penny shaving) yang masif dalam skala jutaan transaksi.

Go tidak memiliki tipe desimal *built-in* dalam standar library-nya. Standar industri untuk aplikasi Go di ranah finansial adalah pustaka `github.com/shopspring/decimal`. Di bawah kap, pustaka ini merepresentasikan angka desimal menggunakan *arbitrary-precision integer* (dari `math/big.Int`) beserta komponen *exponent* basis-10. Hal ini menjamin bahwa representasi memori benar-benar identik dengan nilai desimal dunia nyata, dan operasi aritmetika bebas dari distorsi *floating point*.

Aspek kritikal lainnya dalam pengolahan uang adalah **Rounding Modes** (Mode Pembulatan). Ketika melakukan konversi kurs (FX) atau perhitungan pajak, hasil seringkali berupa pecahan sen yang tidak dapat diselesaikan secara fisik (contoh: $0.125). 
- `RoundHalfUp`: Membulatkan `0.5` ke atas (umum digunakan untuk perhitungan pajak di beberapa yurisdiksi).
- `RoundBank` (atau `RoundHalfEven`): Membulatkan `0.5` ke angka genap terdekat (mengurangi bias kumulatif dalam jumlah besar, menjadikannya standar akuntansi global).

### Diagram ASCII: Aliran Data Moneter

```ascii
      [ Client Payload (JSON) ] 
      {"amount": "100.55"}     <-- Harus selalu dikirim/diterima sebagai String!
                |
                v
      [ JSON Unmarshal ]
                |
                v
  +---------------------------+
  |  decimal.NewFromString()  |
  +-------------+-------------+
                |
    [ In-Memory Go Struct ]
    ( value: 10055, exp: -2 )
                |
                | <--- Operasi Aritmetika (.Add, .Mul, .Div)
                | <--- Pembulatan Final (RoundBank)
                |
  +-------------v-------------+
  |  database/sql Driver      |
  +-------------+-------------+
                |
                v
      [ PostgreSQL DB ]
      Kolom: NUMERIC(19, 4)    <-- Presisi tepat di tingkat DB
```

## Production Code

Berikut adalah implementasi `Monetary` di Go yang mengkapsulasi tipe uang, kurs, proteksi pembulatan, dan interface yang diperlukan untuk berinteraksi dengan database (mengimplementasikan `sql.Scanner` dan `driver.Valuer`) dan API (JSON).

```go
package money

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/shopspring/decimal"
	"golang.org/x/text/currency"
)

var (
	ErrDivisionByZero      = errors.New("cannot divide by zero")
	ErrAmountTooLarge      = errors.New("amount exceeds maximum allowed value")
	ErrCurrencyMismatch    = errors.New("currency mismatch between operands")
	ErrInvalidDBType       = errors.New("invalid type received from database")
)

// MaxMonetaryValue mendefinisikan batas maksimum untuk mencegah overflow database NUMERIC(19,4)
var MaxMonetaryValue = decimal.RequireFromString("999999999999999.9999")

// Monetary membungkus amount (decimal) dan mata uang (currency) dengan ketat.
type Monetary struct {
	Amount   decimal.Decimal `json:"amount"`
	Currency currency.Unit   `json:"currency"`
}

// NewMonetary adalah constructor standar yang aman
func NewMonetary(amount decimal.Decimal, curr currency.Unit) Monetary {
	return Monetary{Amount: amount, Currency: curr}
}

// Add menjumlahkan dua objek Monetary, melakukan validasi currency dan batas.
func (m Monetary) Add(ctx context.Context, other Monetary) (Monetary, error) {
	if m.Currency != other.Currency {
		return Monetary{}, fmt.Errorf("%w: %s != %s", ErrCurrencyMismatch, m.Currency, other.Currency)
	}
	
	result := m.Amount.Add(other.Amount)
	
	if result.GreaterThan(MaxMonetaryValue) || result.LessThan(MaxMonetaryValue.Neg()) {
		return Monetary{}, ErrAmountTooLarge
	}
	
	return Monetary{Amount: result, Currency: m.Currency}, nil
}

// Allocate mendistribusikan amount secara merata ke `n` bagian, 
// memastikan bahwa sisa (remainder) dibagikan ke bagian pertama untuk mencegah uang hilang.
func (m Monetary) Allocate(ctx context.Context, n int) ([]Monetary, error) {
	if n <= 0 {
		return nil, ErrDivisionByZero
	}

	scale := getCurrencyScale(m.Currency)
	divisor := decimal.NewFromInt(int64(n))

	// Bagi dan bulatkan ke bawah untuk mengetahui base per bagian
	baseAmount := m.Amount.Div(divisor).Truncate(int32(scale))
	
	results := make([]Monetary, n)
	for i := 0; i < n; i++ {
		results[i] = Monetary{Amount: baseAmount, Currency: m.Currency}
	}

	// Hitung remainder (sisa dari pembagian presisi absolut)
	allocatedTotal := baseAmount.Mul(divisor)
	remainder := m.Amount.Sub(allocatedTotal)
	
	// Jika ada sisa, tambahkan unit terkecil (1 cent/1 minor unit) ke hasil bagian awal
	// hingga remainder habis.
	smallestUnit := decimal.New(1, int32(-scale))
	for i := 0; remainder.GreaterThan(decimal.Zero); i++ {
		results[i].Amount = results[i].Amount.Add(smallestUnit)
		remainder = remainder.Sub(smallestUnit)
	}

	return results, nil
}

// getCurrencyScale mengembalikan jumlah digit desimal standar untuk suatu mata uang.
func getCurrencyScale(curr currency.Unit) int {
	switch curr.String() {
	case "JPY", "KRW", "IDR":
		return 0 // Representasi umum IDR biasanya tanpa desimal sen
	case "BHD", "KWD":
		return 3
	default:
		return 2 // Mayoritas mata uang (USD, EUR, SGD)
	}
}

// Implementasi driver.Valuer (Untuk Insert/Update ke DB)
func (m Monetary) Value() (driver.Value, error) {
	// Untuk kemudahan, ini hanya mengembalikan string desimal, 
	// namun praktiknya Anda harus menyimpan Currency di kolom terpisah atau sebagai komposit tipe.
	return m.Amount.String(), nil
}

// Implementasi sql.Scanner (Untuk Select dari DB)
func (m *Monetary) Scan(value interface{}) error {
	if value == nil {
		m.Amount = decimal.Zero
		return nil
	}

	switch v := value.(type) {
	case []byte:
		d, err := decimal.NewFromString(string(v))
		if err != nil {
			return err
		}
		m.Amount = d
	case string:
		d, err := decimal.NewFromString(v)
		if err != nil {
			return err
		}
		m.Amount = d
	default:
		return fmt.Errorf("%w: %T", ErrInvalidDBType, value)
	}
	return nil
}

// Implementasi JSON Marshal/Unmarshal kustom untuk proteksi String
func (m *Monetary) UnmarshalJSON(data []byte) error {
	type Alias Monetary
	aux := &struct {
		Amount json.Number `json:"amount"`
		*Alias
	}{
		Alias: (*Alias)(m),
	}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	
	parsed, err := decimal.NewFromString(string(aux.Amount))
	if err != nil {
		return fmt.Errorf("invalid decimal amount: %w", err)
	}
	m.Amount = parsed
	return nil
}

func (m Monetary) MarshalJSON() ([]byte, error) {
	type Alias Monetary
	return json.Marshal(&struct {
		Amount string `json:"amount"` // Paksa string!
		*Alias
	}{
		Amount: m.Amount.String(),
		Alias:  (*Alias)(&m),
	})
}

// --- Unit Tests ---

func TestMonetary_Allocate(t *testing.T) {
	ctx := context.Background()
	usd := currency.MustParseISO("USD")
	m := NewMonetary(decimal.RequireFromString("100.00"), usd)
	
	// Bagi 100 USD ke 3 orang
	allocations, err := m.Allocate(ctx, 3)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	
	// Ekspektasi: 33.34, 33.33, 33.33 (Jumlah pas 100.00 tanpa sen hilang)
	if !allocations[0].Amount.Equal(decimal.RequireFromString("33.34")) {
		t.Errorf("expected 33.34, got %v", allocations[0].Amount)
	}
	if !allocations[1].Amount.Equal(decimal.RequireFromString("33.33")) {
		t.Errorf("expected 33.33, got %v", allocations[1].Amount)
	}
}

func TestMonetary_Add_CurrencyMismatch(t *testing.T) {
	ctx := context.Background()
	usd := currency.MustParseISO("USD")
	jpy := currency.MustParseISO("JPY")
	
	m1 := NewMonetary(decimal.RequireFromString("10.00"), usd)
	m2 := NewMonetary(decimal.RequireFromString("500"), jpy)
	
	_, err := m1.Add(ctx, m2)
	if !errors.Is(err, ErrCurrencyMismatch) {
		t.Errorf("expected ErrCurrencyMismatch, got %v", err)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan `float64` untuk Kalkulasi Uang
**Mengapa berbahaya:** Angka float64 berpotensi menghasilkan ketidakakuratan karena basis representasi biner. Dalam skala jutaan transaksi, pemotongan presisi (*truncation*) yang tidak terlihat akan menyebabkan kebocoran dana dan kegagalan audit akuntansi (*trial balance* tidak seimbang).

```go
// BAD: Menggunakan float64 untuk uang
type Account struct {
    Balance float64
}
func (a *Account) ApplyTax() {
    tax := a.Balance * 0.05  // Hasilnya bisa 0.5000000000001
    a.Balance += tax
}
```

```go
// GOOD: Menggunakan shopspring/decimal
type Account struct {
    Balance decimal.Decimal
}
func (a *Account) ApplyTax() {
    taxRate := decimal.NewFromFloat(0.05)
    tax := a.Balance.Mul(taxRate)
    a.Balance = a.Balance.Add(tax)
}
```

### ❌ Anti-Pattern 2: Premature Rounding (Pembulatan Dini)
**Mengapa berbahaya:** Melakukan pembulatan di setiap tahapan intermedier kalkulasi (misal: membulatkan harga item A, item B, lalu menjumlahkan dan membulatkan pajaknya lagi) akan menyebabkan *Accumulated Rounding Error*. Perhitungan akhir akan menyimpang dari formula matematika ideal.

```go
// BAD: Pembulatan terjadi di tengah operasi berantai
subtotal := price.Mul(qty).Round(2)
tax := subtotal.Mul(taxRate).Round(2) 
total := subtotal.Add(tax).Round(2) // Error margin meningkat!
```

```go
// GOOD: Simpan presisi setinggi mungkin hingga akhir
subtotal := price.Mul(qty)
tax := subtotal.Mul(taxRate)
// Pembulatan HANYA dilakukan tepat sebelum disimpan ke database / dikirim ke user
total := subtotal.Add(tax).RoundBank(2) 
```

### ❌ Anti-Pattern 3: Mengirim Decimal JSON sebagai Number
**Mengapa berbahaya:** Jika JSON dikonstruksi dengan nilai uang tanpa tanda kutip ganda (contoh: `{"amount": 100.55}`), JavaScript client (termasuk Node.js dan browser) yang membaca JSON tersebut akan menggunakan IEEE 754 double-precision float untuk mem-parsing angka tersebut secara diam-diam. Data rusak bahkan sebelum masuk ke UI.

```go
// BAD: JSON Number
type Payload struct {
    Amount decimal.Decimal `json:"amount"` 
    // Menghasilkan {"amount": 100.55}, berbahaya di JS client
}
```

```go
// GOOD: Paksa tipe desimal menjadi string di JSON
type Payload struct {
    Amount decimal.Decimal `json:"amount,string"` // Opsi 1: gunakan tag string
    // Menghasilkan {"amount": "100.55"}
}
```

## Edge Cases & Defensive Programming

1. **Zero-Decimal Currencies**: Mata uang seperti Yen Jepang (JPY) atau Rupiah Indonesia (IDR - secara praktikal tunai) tidak menggunakan desimal sen. Jika sistem Anda secara membabi buta menggunakan `.RoundBank(2)`, sistem akan menyimpan Yen dalam pecahan sen yang tidak valid, yang akan menyebabkan penolakan dari *payment gateway* / bank switch downstream. Gunakan kamus dinamis untuk skala mata uang.
2. **Penny Shaving dalam Pembagian Murni**: Jika 3 orang membagi bill senilai $10.00 secara adil, pembagian statis `.Div()` akan menghasilkan `3.333333...`. Jika Anda membulatkannya ke 2 desimal (`3.33`), totalnya menjadi `9.99`. Anda kehilangan `$0.01`. Selalu gunakan algoritma `Allocation` yang menyerap *remainder* (sisa pembagian) dan mendistribusikannya sebagai unit terkecil ke sekumpulan partisipan.
3. **Database Precision Mismatch**: Mengirim `decimal.Decimal` dengan presisi tak hingga ke PostgreSQL kolom `NUMERIC(10,2)` dapat menyebabkan database secara diam-diam membulatkan angka tersebut jika Anda tidak berhati-hati, atau sebaliknya melempar error `numeric field overflow`. Validasi atau truncasi *scale* di sisi backend Go sebelum pemanggilan query `INSERT/UPDATE`.
4. **Division by Zero**: Berbeda dengan float di mana `/ 0.0` mengembalikan `+Inf` (infinity), di `shopspring/decimal`, memanggil `decimal.Div(decimal.Zero)` akan memicu **`panic`**. Selalu cek nilai divisor jika divisor bukan konstan, menggunakan `.IsZero()`.

## Kapan JANGAN Pakai Ini

- **`float64` untuk uang, dalam bentuk apa pun.** `0.1 + 0.2 != 0.3` dalam biner, dan selisih itu menumpuk lintas jutaan transaksi menjadi angka yang harus dijelaskan kepada auditor. Tidak ada jumlah pembulatan yang memperbaikinya.
- **Membulatkan di setiap langkah perhitungan.** Pembulatan berulang menghasilkan penyimpangan yang searah. Bulatkan **sekali**, di titik yang ditentukan aturan bisnis, dan dokumentasikan di mana titik itu.
- **Menyimpan `numeric` di database lalu memuatnya ke `float64` di Go.** Presisi hilang tepat di batas itu, dan tidak ada satu pun galat yang muncul. Ini kebocoran presisi paling umum dan paling sulit dilihat di code review.
- **Satu tipe uang tanpa mata uang.** Menjumlahkan IDR dan USD seharusnya **tidak bisa dikompilasi**, bukan menghasilkan angka yang tampak masuk akal.
- **Mengasumsikan skala dua desimal.** IDR umumnya nol desimal, JPY nol, BHD tiga. Asumsi ini akan salah pada mata uang pertama yang keluar dari kebiasaan Anda — dan biasanya di produksi.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Selisih kecil yang konsisten di rekonsiliasi | tipe data di jalur perhitungan | `float64` menyelinap di suatu tempat |
| Total tidak sama dengan jumlah bagian | titik pembulatan | Pembulatan dilakukan berulang |
| Nilai berubah setelah bolak-balik ke database | tipe scan di Go | `numeric` dimuat ke `float64` |
| Angka salah untuk mata uang tertentu | skala per mata uang | Skala diasumsikan seragam |
| Penjumlahan lintas mata uang lolos | tipe yang membawa mata uang | Mata uang tidak ada di tipe |

```bash
# Setiap kemunculan float pada jalur uang adalah temuan
grep -rnE 'float(32|64)' --include='*.go' . \
  | grep -iE 'harga|jumlah|saldo|amount|price|balance|total'

# Kolom uang yang bertipe floating point di database
```

```sql
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE data_type IN ('double precision','real')
  AND column_name ~ '(harga|jumlah|saldo|amount|price|balance|total)';

-- Jumlah bagian harus persis sama dengan total yang tersimpan
SELECT p.id, p.total, sum(i.subtotal) AS item_count, p.total - sum(i.subtotal) AS diff
FROM orders p JOIN order_items i ON i.order_id = p.id
GROUP BY p.id, p.total HAVING p.total <> sum(i.subtotal) LIMIT 20;
```
