# Refactoring Legacy Global Helpers ke Arsitektur Modern di Laravel 11/12

Dalam aplikasi Laravel legacy (Laravel 5.x hingga 8.x), sangat umum ditemukan file `app/Helpers/functions.php` yang diload secara otomatis via Composer `autoload.files`. Praktik ini menciptakan "Global Helpers" yang berisikan ratusan fungsi prosedural mulai dari formatting tanggal, kalkulasi pajak, hingga eksekusi query database.

Di era Laravel 11/12 dan PHP 8.3/8.4, arsitektur ini sudah dianggap sebagai **Anti-Pattern**. Penggunaan global helpers membawa dampak buruk pada maintainability, testability, dan performa aplikasi, terutama saat aplikasi dijalankan di atas Laravel Octane (FrankenPHP/Swoole) yang membutuhkan aplikasi berjalan terus menerus (long-running process).

Dokumen ini akan membahas secara mendalam bagaimana merombak (refactor) global helpers menjadi arsitektur OOP modern menggunakan **Clean Architecture** (Action, Service, Repository, Value Object) dengan *strict typing* dan *Pest v3*.

---

## Mengapa Global Helpers Berbahaya?

1. **Hidden Dependencies**: Fungsi global sering kali memanggil facade (`DB::`, `Config::`, `Auth::`) secara tersembunyi, membuat side-effect tidak terlihat oleh pemanggil fungsi.
2. **Testing Nightmare**: Menguji kode yang bergantung pada helper global sangat sulit. Anda tidak bisa dengan mudah melakukan *mocking* pada fungsi prosedural bawaan (kecuali menggunakan ekstensi seperti `uopz` yang tidak direkomendasikan).
3. **Octane Memory Leaks & State Bleed**: Variabel statis atau koneksi yang di-cache di dalam fungsi helper global dapat bocor (bleed) ke request pengguna lain di lingkungan asynchronous/long-running seperti Laravel Octane.
4. **Namespace Pollution**: Fungsi global rentan mengalami tabrakan nama (*name collision*) dengan fungsi bawaan PHP atau package pihak ketiga.
5. **Pelanggaran SRP (Single Responsibility Principle)**: Helper sering kali menjadi "keranjang sampah" (dumping ground) untuk semua logic yang tidak jelas tempatnya.

---

## Strategi Migrasi Global Helpers

Untuk menghapus `functions.php`, kita dapat memetakan jenis-jenis fungsi helper ke dalam struktur modern berikut:

1. **Business Logic & Operasi Spesifik** -> Pindahkan ke **Action Classes** (kelas invokable dengan 1 tanggung jawab tunggal).
2. **Query Database** -> Pindahkan ke **Repository**, **Model Scopes**, atau **Custom Eloquent Builders**.
3. **Formatting & Manipulasi Data Sederhana** -> Pindahkan ke **Value Objects** atau **Blade Components/Macros**.
4. **Logic Kompleks Stateful** -> Pindahkan ke **Services**.

---

## ❌ Anti-Pattern 1: God Helper File dengan Tight Coupling

Dalam legacy code, kalkulasi bisnis sering kali di-hardcode ke dalam satu fungsi global yang mengambil input langsung dari environment atau global state.

### ❌ KODE SALAH (Legacy `app/Helpers/functions.php`)

```php
<?php

// DILARANG: Fungsi global tanpa type-hint, hidden dependency ke Auth dan DB.
function calculate_final_discounted_price($product_id, $base_price) {
    // Hidden dependency 1: Auth facade
    $user = auth()->user();
    
    // Hidden dependency 2: DB query dalam helper
    $discountRate = \DB::table('discounts')
        ->where('user_tier', $user->tier ?? 'regular')
        ->value('rate') ?? 0;
        
    $tax = env('TAX_RATE', 0.11); // Bahaya: env() tidak boleh dipanggil selain di config!
    
    $discounted = $base_price - ($base_price * $discountRate);
    $final = $discounted + ($discounted * $tax);
    
    return $final;
}
```

**Analisis Bahaya (Security & Memory Risk):**
- **Hidden Queries**: Memanggil fungsi ini dalam loop (misal saat mapping koleksi produk) akan menghasilkan **N+1 Query Problem**.
- **Octane Risk**: Pemanggilan `env()` secara langsung di luar file konfigurasi akan mengembalikan `null` jika konfigurasi di-cache (`php artisan config:cache`), menyebabkan kalkulasi pajak menjadi 0%.
- **Testing**: Anda tidak bisa mem-bypass atau mock logika diskon untuk melakukan unit testing sederhana pada kalkulasi harga.

### ✅ KODE BENAR (Action Class + Dependency Injection)

Refactor logic di atas menjadi **Action Class** (Single Responsibility) dengan menggunakan **Repository** untuk data diskon dan mem-passing user secara eksplisit.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Pricing;

use App\Models\User;
use App\Repositories\Contracts\DiscountRepositoryInterface;
use App\ValueObjects\Money;
use Illuminate\Support\Facades\Config;

final readonly class CalculateFinalPriceAction
{
    public function __construct(
        private DiscountRepositoryInterface $discountRepository
    ) {}

    /**
     * Kalkulasi harga dengan diskon user dan pajak sistem.
     */
    public function execute(Money $basePrice, ?User $user): Money
    {
        $tier = $user?->tier ?? 'regular';
        $discountRate = $this->discountRepository->getRateForTier($tier);
        
        // Membaca config, bukan env()
        $taxRate = (float) Config::get('shop.tax_rate', 0.11);
        
        $discountAmount = $basePrice->multiply($discountRate);
        $priceAfterDiscount = $basePrice->subtract($discountAmount);
        
        $taxAmount = $priceAfterDiscount->multiply($taxRate);
        
        return $priceAfterDiscount->add($taxAmount);
    }
}
```

---

## ❌ Anti-Pattern 2: Global Formatting & HTML Munging

Fungsi helper legacy sering kali digunakan untuk membuat output HTML langsung atau memformat nilai (seperti uang) dengan logika yang sangat kotor.

### ❌ KODE SALAH (Legacy UI Helper)

```php
<?php

// DILARANG: Mereturn HTML langsung dari helper dan hardcode format string.
function format_invoice_status($status, $amount) {
    $money = "Rp. " . number_format($amount, 0, ',', '.');
    
    if ($status === 'paid') {
        return '<span class="badge bg-success">Lunas: '.$money.'</span>';
    } elseif ($status === 'unpaid') {
        return '<span class="badge bg-danger">Belum Bayar: '.$money.'</span>';
    }
    
    return '<span class="badge bg-secondary">Unknown</span>';
}
```

**Analisis Bahaya (Security & Architecture Risk):**
- **XSS Vulnerability**: Jika `$money` atau param lain berisi string berbahaya yang terinjeksi (meski number_format cukup aman, kebiasaan ini membuka celah XSS jika data lain tidak di-escape). Blade `{{ }}` secara otomatis melakukan escape, namun memanggil helper ini melalui `{!! format_invoice_status(...) !!}` menggagalkan proteksi tersebut.
- **MVC Violation**: Kode presentasi (HTML/UI) dicampur dengan PHP logic dasar. Susah diganti saat pindah ke Inertia (Vue/React) karena outputnya adalah string HTML.

### ✅ KODE BENAR (Enum + Value Object + Blade Component)

Gunakan **PHP 8.1+ Enums**, **Value Objects**, dan **Blade Components**.

**1. Enum untuk Status:**
```php
<?php

declare(strict_types=1);

namespace App\Enums;

enum InvoiceStatus: string
{
    case PAID = 'paid';
    case UNPAID = 'unpaid';
    case REFUNDED = 'refunded';

    public function label(): string
    {
        return match($this) {
            self::PAID => 'Lunas',
            self::UNPAID => 'Belum Bayar',
            self::REFUNDED => 'Dikembalikan',
        };
    }

    public function colorClass(): string
    {
        return match($this) {
            self::PAID => 'bg-success',
            self::UNPAID => 'bg-danger',
            self::REFUNDED => 'bg-warning',
        };
    }
}
```

**2. Value Object untuk Uang:**
```php
<?php

declare(strict_types=1);

namespace App\ValueObjects;

use InvalidArgumentException;

final readonly class Money
{
    public function __construct(
        private int $amountInCents,
        private string $currency = 'IDR'
    ) {
        if ($this->amountInCents < 0) {
            throw new InvalidArgumentException('Amount cannot be negative.');
        }
    }

    public static function fromIDR(int $amount): self
    {
        return new self($amount * 100, 'IDR'); // Simpan dalam basis terkecil
    }

    public function format(): string
    {
        // Dalam implementasi nyata, gunakan NumberFormatter dari intl extension
        return 'Rp ' . number_format($this->amountInCents / 100, 0, ',', '.');
    }
    
    public function multiply(float $multiplier): self
    {
        return new self((int) round($this->amountInCents * $multiplier), $this->currency);
    }
    
    public function add(self $other): self
    {
        if ($this->currency !== $other->currency) {
            throw new InvalidArgumentException('Currency mismatch');
        }
        return new self($this->amountInCents + $other->amountInCents, $this->currency);
    }
    
    public function subtract(self $other): self
    {
        return new self($this->amountInCents - $other->amountInCents, $this->currency);
    }
}
```

**3. Blade Component (`resources/views/components/invoice-badge.blade.php`):**
```blade
@props(['status', 'amount'])

<span class="badge {{ $status->colorClass() }}">
    {{ $status->label() }}: {{ $amount->format() }}
</span>
```

**Pemanggilan di UI:**
```blade
<!-- Jauh lebih aman, otomatis escaping, logic murni OOP -->
<x-invoice-badge :status="$invoice->status" :amount="$invoice->money" />
```

---

## Clean Architecture: Implementasi Alur E2E Tanpa Helper

Berikut adalah bagaimana Action, Repository, dan Controller dirangkai menggunakan standar Laravel 11 dengan strict types, tanpa ada campur tangan helper eksternal.

### 1. Form Request Validation
```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Orders;

use Illuminate\Foundation\Http\FormRequest;

final class ProcessOrderRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'product_id' => ['required', 'uuid', 'exists:products,id'],
            'qty'        => ['required', 'integer', 'min:1'],
        ];
    }
}
```

### 2. Controller
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Actions\Order\ProcessOrderAction;
use App\Http\Controllers\Controller;
use App\Http\Requests\Orders\ProcessOrderRequest;
use Illuminate\Http\JsonResponse;

final class OrderController extends Controller
{
    public function __construct(
        private readonly ProcessOrderAction $processOrderAction
    ) {}

    public function store(ProcessOrderRequest $request): JsonResponse
    {
        $order = $this->processOrderAction->execute(
            productId: $request->validated('product_id'),
            userId: $request->user()->id,
            qty: (int) $request->validated('qty')
        );

        return response()->json([
            'message' => 'Order processed successfully',
            'data'    => $order->toArray()
        ], 201);
    }
}
```

### 3. Action Class
```php
<?php

declare(strict_types=1);

namespace App\Actions\Order;

use App\Models\Order;
use App\Repositories\Contracts\OrderRepositoryInterface;
use App\Repositories\Contracts\ProductRepositoryInterface;
use App\Actions\Pricing\CalculateFinalPriceAction;
use App\ValueObjects\Money;
use Illuminate\Support\Facades\DB;
use RuntimeException;

final readonly class ProcessOrderAction
{
    public function __construct(
        private OrderRepositoryInterface $orderRepository,
        private ProductRepositoryInterface $productRepository,
        private CalculateFinalPriceAction $calculatePriceAction
    ) {}

    public function execute(string $productId, string $userId, int $qty): Order
    {
        return DB::transaction(function () use ($productId, $userId, $qty) {
            $product = $this->productRepository->findByIdLockedForUpdate($productId);
            
            if (! $product) {
                throw new RuntimeException('Product not found.');
            }

            if ($product->stock < $qty) {
                throw new RuntimeException('Insufficient stock.');
            }

            $basePrice = Money::fromIDR($product->price_rupiah * $qty);
            
            // Re-use Action Pricing yang sudah direfactor sebelumnya
            // (Dalam sistem nyata, kita akan mengambil object User secara utuh dari Repository)
            $finalPrice = $this->calculatePriceAction->execute($basePrice, null);

            $this->productRepository->decrementStock($productId, $qty);

            return $this->orderRepository->create([
                'user_id'    => $userId,
                'product_id' => $productId,
                'qty'        => $qty,
                'total_paid' => $finalPrice->format(), // Simpan format raw/integer di production
            ]);
        });
    }
}
```

### 4. Repository Pattern
```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Models\Order;
use App\Repositories\Contracts\OrderRepositoryInterface;

final readonly class OrderRepository implements OrderRepositoryInterface
{
    public function create(array $data): Order
    {
        return Order::create($data);
    }
}
```

---

## Pengujian Ekstensif dengan Pest v3

Refactoring tidak ada artinya tanpa validasi testing. Pest v3 memberikan fitur Arch Testing yang brilian untuk memastikan budaya global helper tidak kembali masuk ke tim pengembangan.

### 1. Arch Testing: Melarang Global Helpers Custom

File: `tests/Arch/HelpersTest.php`
```php
<?php

declare(strict_types=1);

uses()->group('architecture');

test('aplikasi tidak boleh lagi menggunakan legacy helper functions', function () {
    // Larang memanggil fungsi kustom legacy
    expect(['calculate_final_discounted_price', 'format_invoice_status'])
        ->not->toBeUsed();
});

test('controller hanya boleh memanggil action atau query, bukan facade', function () {
    expect('App\Http\Controllers')
        ->not->toUse('Illuminate\Support\Facades\DB')
        ->not->toUse('Illuminate\Support\Facades\Cache');
});
```

### 2. Unit Testing: CalculateFinalPriceAction

File: `tests/Unit/Actions/CalculateFinalPriceActionTest.php`
```php
<?php

declare(strict_types=1);

use App\Actions\Pricing\CalculateFinalPriceAction;
use App\Models\User;
use App\Repositories\Contracts\DiscountRepositoryInterface;
use App\ValueObjects\Money;
use Illuminate\Support\Facades\Config;

uses()->group('pricing', 'unit');

it('calculates the final price correctly with discount and tax', function () {
    // 1. Setup / Arrange
    $user = User::factory()->make(['tier' => 'gold']);
    $basePrice = Money::fromIDR(100000); // 100,000 IDR
    
    // Mock the repository
    $discountRepoMock = Mockery::mock(DiscountRepositoryInterface::class);
    $discountRepoMock->shouldReceive('getRateForTier')
        ->with('gold')
        ->once()
        ->andReturn(0.20); // 20% discount

    Config::set('shop.tax_rate', 0.10); // 10% tax

    $action = new CalculateFinalPriceAction($discountRepoMock);

    // 2. Act
    $finalPrice = $action->execute($basePrice, $user);

    // 3. Assert
    // Base: 100,000. Discount 20% = 80,000. Tax 10% = 8,000. Final = 88,000.
    $expectedAmountInCents = 88000 * 100;
    
    // Asserting value object logic
    $reflectionAmount = (new ReflectionClass($finalPrice))->getProperty('amountInCents')->getValue($finalPrice);
    
    expect($reflectionAmount)->toBe($expectedAmountInCents)
        ->and($finalPrice->format())->toBe('Rp 88.000');
});

it('calculates correctly without user', function () {
    $basePrice = Money::fromIDR(100000);
    
    $discountRepoMock = Mockery::mock(DiscountRepositoryInterface::class);
    $discountRepoMock->shouldReceive('getRateForTier')
        ->with('regular')
        ->once()
        ->andReturn(0.0); // 0% discount

    Config::set('shop.tax_rate', 0.11); // 11% tax

    $action = new CalculateFinalPriceAction($discountRepoMock);
    $finalPrice = $action->execute($basePrice, null);

    // Base 100,000 + 11% tax = 111,000
    $expectedAmountInCents = 111000 * 100;
    $reflectionAmount = (new ReflectionClass($finalPrice))->getProperty('amountInCents')->getValue($finalPrice);
    
    expect($reflectionAmount)->toBe($expectedAmountInCents);
});
```

---

## Rangkuman Solusi Top 1%

1. **Delete File**: Buang perlahan `app/Helpers/functions.php`. Jangan tambahkan kode baru di sana.
2. **Design Pattern**: Gunakan **Action Class** (invokable) untuk logika yang spesifik dan re-usable, pastikan state-less (sangat aman untuk Octane).
3. **Immutability**: Logic kalkulasi, manipulasi uang, atau formatting kompleks dibungkus ke dalam **Value Objects** (`final readonly class`).
4. **Dependency Injection**: Daripada mengandalkan helper yang memanggil facade `DB::` atau `Auth::`, injeksikan *Repository* ke *Action* melalui constructor. Hal ini membuat aplikasi 100% testable menggunakan PHPUnit/Pest *mocks*.
5. **Strict Types**: Selalu tambahkan `declare(strict_types=1);` pada setiap file baru, dan pastikan setiap parameter serta return type dideklarasikan dengan tipe data (termasuk *custom type* menggunakan object class).
