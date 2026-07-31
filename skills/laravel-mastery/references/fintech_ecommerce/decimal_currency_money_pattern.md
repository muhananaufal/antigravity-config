# Decimal, Currency & Money Pattern di Laravel 11/12 (PHP 8.3/8.4)

Dalam aplikasi *Fintech*, *E-Commerce*, atau sistem apa pun yang berurusan dengan uang, merepresentasikan nilai moneter secara akurat adalah hal yang sangat krusial. Menggunakan tipe data primitif seperti `float` atau `double` untuk uang adalah sebuah kesalahan fatal yang dapat menyebabkan kerugian finansial yang signifikan karena ketidaktepatan presisi (*floating-point math precision loss*).

Artikel ini membahas penerapan **Money Pattern** secara menyeluruh dan komprehensif menggunakan PHP 8.3/8.4 dan Laravel 11/12, lengkap dengan Clean Architecture, Domain-Driven Design (DDD) principles (seperti Value Objects dan DTOs), serta pengujian menggunakan Pest v3.

Semua kode diwajibkan menggunakan `declare(strict_types=1);` dan *strongly typed* di semua level.

---

## 1. Anatomi Kesalahan Floating-Point

Mengapa kita tidak boleh menggunakan tipe primitif seperti `float`?

Dalam komputasi, bilangan pecahan disimpan menggunakan representasi biner berstandar IEEE 754. Beberapa bilangan desimal (seperti `0.1` atau `0.2`) tidak dapat direpresentasikan secara presisi dalam biner, yang mengakibatkan presisi yang hilang (contoh: `0.1 + 0.2` menghasilkan `0.30000000000000004` alih-alih `0.3`).

Jika diakumulasi pada jutaan transaksi, selisih kecil ini akan merusak neraca keseimbangan dan audit sistem finansial Anda.

---

## 2. Anti-Patterns: Praktik Buruk vs Praktik Terbaik

### Anti-Pattern 1: Menyimpan dan Menghitung Uang dengan `Float`

❌ **Praktik Buruk (Anti-Pattern)**
Penggunaan float atau double di database dan manipulasi matematis PHP biasa.

```php
<?php

declare(strict_types=1);

namespace App\Services;

class CheckoutService
{
    public function calculateTotal(float $price, float $taxRate, float $discount): float
    {
        // Presisi akan hilang di sini!
        $tax = $price * $taxRate;
        $totalBeforeDiscount = $price + $tax;
        
        return $totalBeforeDiscount - $discount;
    }
}
```

**Penjelasan Mendalam:** 
Pendekatan di atas tidak memiliki informasi mengenai *mata uang* (Currency). Anda bisa saja secara tidak sengaja menjumlahkan `100 USD` dan `50 EUR` karena keduanya diperlakukan sekadar sebagai angka `float`. Ditambah lagi, masalah presisi akan muncul ketika `taxRate` adalah `0.07` (7%).

✅ **Praktik Terbaik (Money Pattern & Value Object)**
Gunakan `Value Object` untuk enkapsulasi besaran uang dan mata uangnya. Gunakan integer (*minor units/cents*) atau ekstensi `bcmath`/`gmp` jika sistem Anda sangat butuh presisi skala tinggi (seperti kripto). Dalam contoh kita, kita menyimpan sebagai *minor units* (integer).

```php
<?php

declare(strict_types=1);

namespace App\Domain\Money\ValueObjects;

use App\Domain\Money\Enums\Currency;
use InvalidArgumentException;

readonly class Money
{
    public function __construct(
        public int $amount, // Disimpan dalam minor units (contoh: sen)
        public Currency $currency
    ) {
    }

    public static function of(int $amount, Currency $currency = Currency::IDR): self
    {
        return new self($amount, $currency);
    }

    public function add(Money $other): self
    {
        if ($this->currency !== $other->currency) {
            throw new InvalidArgumentException('Cannot add money of different currencies.');
        }

        return new self($this->amount + $other->amount, $this->currency);
    }
    
    public function subtract(Money $other): self
    {
        if ($this->currency !== $other->currency) {
            throw new InvalidArgumentException('Cannot subtract money of different currencies.');
        }

        return new self($this->amount - $other->amount, $this->currency);
    }
}
```

### Anti-Pattern 2: Menangani Formatting dan Konversi Mata Uang di Layer View/Blade

❌ **Praktik Buruk (Anti-Pattern)**
Mengalikan/membagi angka atau melakukan konversi secara sewenang-wenang langsung pada lapisan View.

```blade
<!-- resources/views/cart.blade.php -->
<div>
    Total: IDR {{ number_format($order->total_amount / 100, 2, ',', '.') }}
</div>
```

**Penjelasan Mendalam:** 
Domain logic (seperti pembagian `/ 100` untuk konversi dari cents) bocor ke View. Jika besok Anda menambahkan mata uang JPY (yang tidak memiliki minor units), format ini akan rusak. Logika konversi dan format harus ada dalam *Value Object* atau presenter/resource.

✅ **Praktik Terbaik (Encapsulated Formatting)**
Value Object `Money` bertanggung jawab atas formatting.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Money\ValueObjects;

use NumberFormatter;
// ... (class definition continued from above)

    public function format(string $locale = 'id_ID'): string
    {
        $formatter = new NumberFormatter($locale, NumberFormatter::CURRENCY);
        
        // Membagi dengan 10 pangkat dari eksponen/skala mata uang
        $decimalAmount = $this->amount / (10 ** $this->currency->minorUnit());
        
        return $formatter->formatCurrency($decimalAmount, $this->currency->value);
    }
```
Lalu di view/resource: `{{ $order->total_price->format() }}`.

---

## 3. Implementasi Clean Architecture

### A. Enums: Currency
Gunakan PHP 8.1+ Enums untuk mata uang.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Money\Enums;

enum Currency: string
{
    case IDR = 'IDR';
    case USD = 'USD';
    case EUR = 'EUR';
    case JPY = 'JPY'; // Tidak memiliki sen

    public function minorUnit(): int
    {
        return match ($this) {
            self::IDR, self::USD, self::EUR => 2,
            self::JPY => 0,
        };
    }
}
```

### B. Value Object: Lengkap (Money)

```php
<?php

declare(strict_types=1);

namespace App\Domain\Money\ValueObjects;

use App\Domain\Money\Enums\Currency;
use InvalidArgumentException;
use NumberFormatter;

final readonly class Money
{
    public function __construct(
        public int $amount,
        public Currency $currency
    ) {
    }

    public static function of(int $amount, Currency $currency): self
    {
        return new self($amount, $currency);
    }
    
    public static function zero(Currency $currency): self
    {
        return new self(0, $currency);
    }

    public function add(Money $other): self
    {
        $this->assertSameCurrency($other);
        return new self($this->amount + $other->amount, $this->currency);
    }

    public function subtract(Money $other): self
    {
        $this->assertSameCurrency($other);
        return new self($this->amount - $other->amount, $this->currency);
    }
    
    public function multiply(int|float $multiplier): self
    {
        // Gunakan fungsi pembulatan yang aman atau ext-bcmath jika float digunakan
        $newAmount = (int) round($this->amount * $multiplier);
        return new self($newAmount, $this->currency);
    }
    
    public function isGreaterThan(Money $other): bool
    {
        $this->assertSameCurrency($other);
        return $this->amount > $other->amount;
    }
    
    public function isLessThan(Money $other): bool
    {
        $this->assertSameCurrency($other);
        return $this->amount < $other->amount;
    }
    
    public function isEqualTo(Money $other): bool
    {
        $this->assertSameCurrency($other);
        return $this->amount === $other->amount;
    }

    public function format(string $locale = 'id_ID'): string
    {
        $formatter = new NumberFormatter($locale, NumberFormatter::CURRENCY);
        $decimalAmount = $this->amount / (10 ** $this->currency->minorUnit());
        return $formatter->formatCurrency($decimalAmount, $this->currency->value) ?: '';
    }

    private function assertSameCurrency(Money $other): void
    {
        if ($this->currency !== $other->currency) {
            throw new InvalidArgumentException(sprintf(
                'Currency mismatch: %s and %s', 
                $this->currency->value, 
                $other->currency->value
            ));
        }
    }
}
```

### C. Laravel Model Casts

Agar database menyimpan dalam format yang benar tetapi ditarik sebagai objek `Money`. Di dalam database MySQL/PostgreSQL, kita menyimpannya sebagai `BIGINT` untuk amannya. 

Skema Migration:
```php
<?php
// ... dalam migration file
$table->bigInteger('price_amount');
$table->string('price_currency', 3)->default('IDR');
```

Laravel 11 Custom Cast:
```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Casts;

use App\Domain\Money\Enums\Currency;
use App\Domain\Money\ValueObjects\Money;
use Illuminate\Contracts\Database\Eloquent\CastsAttributes;
use Illuminate\Database\Eloquent\Model;
use InvalidArgumentException;

final class MoneyCast implements CastsAttributes
{
    public function __construct(
        private readonly string $amountField,
        private readonly string $currencyField
    ) {
    }

    /**
     * @param array<string, mixed> $attributes
     */
    public function get(Model $model, string $key, mixed $value, array $attributes): ?Money
    {
        if (!isset($attributes[$this->amountField]) || !isset($attributes[$this->currencyField])) {
            return null;
        }

        return Money::of(
            (int) $attributes[$this->amountField],
            Currency::from($attributes[$this->currencyField])
        );
    }

    /**
     * @param array<string, mixed> $attributes
     * @return array<string, mixed>
     */
    public function set(Model $model, string $key, mixed $value, array $attributes): array
    {
        if (!$value instanceof Money) {
            throw new InvalidArgumentException('The given value is not a Money instance.');
        }

        return [
            $this->amountField => $value->amount,
            $this->currencyField => $value->currency->value,
        ];
    }
}
```

Penerapan pada Model Eloquent:
```php
<?php

declare(strict_types=1);

namespace App\Models;

use App\Infrastructure\Casts\MoneyCast;
use Illuminate\Database\Eloquent\Model;

class Transaction extends Model
{
    protected $fillable = ['price_amount', 'price_currency'];

    protected function casts(): array
    {
        return [
            'price' => MoneyCast::class.':price_amount,price_currency',
        ];
    }
}
```

### D. Data Transfer Objects (DTO)

Gunakan DTO yang strongly typed untuk menampung input payload transaksi, mencegah injeksi array kotor.

```php
<?php

declare(strict_types=1);

namespace App\Application\DTOs;

use App\Domain\Money\ValueObjects\Money;

final readonly class ProcessPaymentDTO
{
    public function __construct(
        public string $transactionId,
        public string $userId,
        public Money $amountPaid
    ) {
    }
}
```

### E. Actions / Services (Transaction Logic)

Pisahkan logika ke sebuah Action Class yang berdiri sendiri, mudah dites, dan dapat digunakan ulang.

```php
<?php

declare(strict_types=1);

namespace App\Application\Actions;

use App\Application\DTOs\ProcessPaymentDTO;
use App\Models\Transaction;
use Illuminate\Support\Facades\DB;
use DomainException;

final class ProcessPaymentAction
{
    public function execute(ProcessPaymentDTO $dto): Transaction
    {
        return DB::transaction(function () use ($dto) {
            $transaction = Transaction::where('transaction_id', $dto->transactionId)
                ->where('user_id', $dto->userId)
                ->lockForUpdate() // Mencegah race condition/double spending
                ->firstOrFail();

            // Asumsikan ada field 'expected_amount' dan 'expected_currency'
            $expectedMoney = $transaction->expected_money; // Di cast oleh MoneyCast

            if (!$dto->amountPaid->isEqualTo($expectedMoney)) {
                throw new DomainException(sprintf(
                    'Amount mismatch. Expected: %s, Paid: %s',
                    $expectedMoney->format(),
                    $dto->amountPaid->format()
                ));
            }
            
            $transaction->status = 'PAID';
            $transaction->save();
            
            return $transaction;
        });
    }
}
```

---

## 4. Pengujian dengan Pest v3

Unit Testing dan Architecture Testing merupakan standar mutlak. Pest v3 memberikan sintaks yang ekspresif.

### Unit Tests: Money Value Object
```php
<?php

declare(strict_types=1);

use App\Domain\Money\Enums\Currency;
use App\Domain\Money\ValueObjects\Money;

test('it can add two money objects with the same currency', function () {
    $moneyA = Money::of(1000, Currency::IDR); // Rp 10.00
    $moneyB = Money::of(500, Currency::IDR);  // Rp 5.00
    
    $result = $moneyA->add($moneyB);
    
    expect($result->amount)->toBe(1500)
        ->and($result->currency)->toBe(Currency::IDR);
});

test('it throws exception when adding different currencies', function () {
    $moneyA = Money::of(100, Currency::USD);
    $moneyB = Money::of(100, Currency::EUR);
    
    expect(fn () => $moneyA->add($moneyB))->toThrow(
        InvalidArgumentException::class, 
        'Currency mismatch: USD and EUR'
    );
});

test('it correctly formats money according to locale', function () {
    $money = Money::of(150000, Currency::IDR); // Rp 1.500,00
    
    // Setting locale untuk memaksakan ekspektasi
    $formatted = $money->format('id_ID');
    
    expect($formatted)->toContain('Rp')
        ->and($formatted)->toContain('1.500');
});

test('it correctly multiplies money amounts and rounds properly', function () {
    $money = Money::of(100, Currency::USD); // $1.00
    
    // Pajak 7.5% -> multiplier 1.075
    $result = $money->multiply(1.075);
    
    expect($result->amount)->toBe(108); // $1.08 setelah pembulatan terdekat
});
```

### Architecture Tests (Arch)
Kita wajib memastikan aturan arsitektur dipatuhi melalui CI/CD.

```php
<?php

declare(strict_types=1);

arch('Value objects must be final and readonly')
    ->expect('App\Domain\Money\ValueObjects')
    ->toBeFinal()
    ->toBeReadonly();

arch('DTOs must be final and readonly')
    ->expect('App\Application\DTOs')
    ->toBeFinal()
    ->toBeReadonly();

arch('Models must not handle complex domain logic directly')
    ->expect('App\Models')
    ->not->toUse('Illuminate\Support\Facades\DB'); // DB facade harus di Actions/Repositories

arch('Domain layer must be strictly typed and decoupled from Laravel HTTP')
    ->expect('App\Domain')
    ->toUseStrictTypes()
    ->not->toUse('Illuminate\Http\Request'); 
```

---

## 5. Kesimpulan

Menerapkan *Money Pattern* secara konsisten di ekosistem Laravel 11 dengan PHP 8.3/8.4 memastikan aplikasi sistem finansial Anda menjadi kebal terhadap isu *floating-point error*, mudah diaudit, dan secara arsitektur patuh pada desain *strongly typed*. Pendekatan berlapis mulai dari DTO untuk validasi, Value Object untuk enkapsulasi domain, hingga Custom Casts untuk presisi Database, menciptakan jaminan perangkat lunak skala enterprise (Top 1%).
