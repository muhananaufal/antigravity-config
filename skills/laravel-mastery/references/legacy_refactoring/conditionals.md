# Menguasai Refactoring Conditional Statement di Laravel 11 (PHP 8.3/8.4)

## Pengantar
Conditional statement (if-else, switch) adalah sumber utama kompleksitas cyclomatic dalam aplikasi PHP. Dalam aplikasi Laravel berskala besar, conditional yang menumpuk (nested conditionals) tidak hanya membuat kode sulit dibaca (Spaghetti Code) tetapi juga meningkatkan risiko bug, mempersulit pengujian (Unit Testing), dan melanggar prinsip Open-Closed dari SOLID. Dokumen ini membahas strategi tingkat lanjut untuk melakukan refactoring conditional statement menggunakan fitur PHP 8.3/8.4 terbaru dan ekosistem Laravel 11/12.

## 1. Strategy Pattern dan Polymorphism vs Switch/Match

Pendekatan paling umum untuk mengganti conditional kompleks adalah menggunakan Strategy Pattern. PHP 8 telah memperkenalkan `match` expression yang jauh lebih baik dari `switch`, namun untuk logika bisnis yang kompleks (seperti kalkulasi harga dengan berbagai aturan), Strategy Pattern tetap menjadi pilihan terbaik dalam Clean Architecture.

### ❌ Anti-Pattern 1: God Class dengan Nested Conditionals dan Switch/Match

**Mengapa Berbahaya:**
- **Open-Closed Principle Violation:** Setiap kali ada metode pembayaran baru, Anda harus memodifikasi kelas ini (risiko regression bug tinggi).
- **Cognitive Complexity:** Sulit bagi developer untuk membedakan logika tiap metode pembayaran dalam satu file besar.
- **Testing Difficulty:** Unit test harus mem-mock banyak dependensi yang tidak relevan untuk metode pembayaran tertentu.
- **Memory Risk:** Kelas ini berpotensi memuat banyak Service yang sebenarnya hanya dipakai salah satu kondisional.

```php
<?php

declare(strict_types=1);

namespace App\Services;

use App\Models\Order;
use Exception;

final class PaymentProcessor
{
    public function process(Order $order, string $method): bool
    {
        if ($order->amount <= 0) {
            throw new Exception('Invalid order amount');
        }

        if ($method === 'credit_card') {
            // Logika kompleks untuk kartu kredit
            // Verifikasi 3D secure, hubungi gateway eksternal
            if ($order->currency !== 'USD' && $order->currency !== 'IDR') {
                throw new Exception('Currency not supported for credit card');
            }
            // ... 50 baris kode integrasi Stripe/Midtrans ...
            return true;
        } elseif ($method === 'bank_transfer') {
            // Logika verifikasi mutasi bank
            // ... 40 baris kode cek mutasi API BCA/Mandiri ...
            return true;
        } elseif ($method === 'ewallet') {
             // Logika OVO/GoPay/Dana
             if (!$order->customer->phone_number) {
                 throw new Exception('Phone number required for ewallet');
             }
             // ... 30 baris kode request payment link ...
             return true;
        }

        throw new Exception('Unsupported payment method');
    }
}
```

### ✅ Kode Benar: Refactoring dengan Strategy Pattern dan Laravel Service Container

Dalam Clean Architecture, Controller/Action tidak perlu tahu detail implementasi metode pembayaran. Kita mendefinisikan *interface* (Contract) dan membiarkan Laravel Container yang me-resolve *concrete class* berdasarkan input.

```php
<?php

declare(strict_types=1);

namespace App\Contracts;

use App\Models\Order;

interface PaymentStrategy
{
    public function process(Order $order): bool;
    
    public function isSupported(string $currency): bool;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Strategies\Payment;

use App\Contracts\PaymentStrategy;
use App\Models\Order;
use App\Exceptions\PaymentException;
use Illuminate\Support\Facades\Http;

final readonly class CreditCardPayment implements PaymentStrategy
{
    public function __construct(private string $gatewaySecret) {}

    public function process(Order $order): bool
    {
        if (!$this->isSupported($order->currency)) {
            throw PaymentException::unsupportedCurrency($order->currency, 'Credit Card');
        }

        $response = Http::withToken($this->gatewaySecret)
            ->post('https://api.gateway.test/charge', [
                'amount' => $order->amount,
                'currency' => $order->currency,
                'reference' => $order->reference_id,
            ]);

        if ($response->failed()) {
            throw PaymentException::gatewayError($response->body());
        }

        return true;
    }

    public function isSupported(string $currency): bool
    {
        return in_array($currency, ['USD', 'IDR'], true);
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Strategies\Payment;

use App\Contracts\PaymentStrategy;
use App\Models\Order;
use App\Exceptions\PaymentException;

final readonly class EWalletPayment implements PaymentStrategy
{
    public function process(Order $order): bool
    {
        if (empty($order->customer->phone_number)) {
             throw PaymentException::missingCustomerInfo('phone_number', 'E-Wallet');
        }
        
        // Logika spesifik E-Wallet di sini
        return true;
    }

    public function isSupported(string $currency): bool
    {
        return $currency === 'IDR';
    }
}
```

**Manager Class (Factory pattern via Laravel Manager):**

```php
<?php

declare(strict_types=1);

namespace App\Managers;

use App\Contracts\PaymentStrategy;
use Illuminate\Support\Manager;
use App\Strategies\Payment\CreditCardPayment;
use App\Strategies\Payment\EWalletPayment;
use App\Exceptions\PaymentException;

final class PaymentManager extends Manager
{
    public function getDefaultDriver(): string
    {
        throw PaymentException::driverNotSpecified();
    }

    protected function createCreditCardDriver(): PaymentStrategy
    {
        return new CreditCardPayment(config('services.payment.credit_card_secret'));
    }

    protected function createEwalletDriver(): PaymentStrategy
    {
        return new EWalletPayment();
    }
    
    public function process(Order $order, string $driver): bool
    {
        if ($order->amount <= 0) {
            throw PaymentException::invalidAmount($order->amount);
        }
        
        /** @var PaymentStrategy $strategy */
        $strategy = $this->driver($driver);
        
        return $strategy->process($order);
    }
}
```

Sekarang Controller sangat tipis dan strongly typed:

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Requests\ProcessPaymentRequest;
use App\Managers\PaymentManager;
use App\Models\Order;
use Illuminate\Http\JsonResponse;

final class PaymentController
{
    public function __construct(private readonly PaymentManager $paymentManager) {}

    public function __invoke(ProcessPaymentRequest $request, Order $order): JsonResponse
    {
        $this->paymentManager->process($order, $request->validated('method'));

        return response()->json(['message' => 'Payment processed successfully']);
    }
}
```

---

## 2. Null Object Pattern vs Pemeriksaan Null Berulang

Pemeriksaan `if ($object !== null)` atau operator null-safe `?->` sangat sering digunakan di PHP. Namun jika diulang di banyak tempat, ini adalah indikator perlunya *Null Object Pattern*.

### ❌ Anti-Pattern 2: Berulang Kali Mengecek Relasi Null

**Mengapa Berbahaya:**
- **Null Reference Exception (NPE):** Jika programmer lupa memeriksa null, aplikasi akan crash. NullPointerException (atau Call to a member function on null) adalah salah satu error paling sering terjadi.
- **Logika Tersebar:** Penanganan default (misal diskon 0 jika tidak ada promo aktif) tersebar di seluruh basis kode. Jika aturan bisnis berubah (misal diskon default menjadi 5%), Anda harus memburu semua if-null.
- **Security Risk:** Kegagalan menangani status null pada *Role* atau *Permission* dapat mengekspos fitur admin ke pengguna reguler jika default fallback-nya salah.

```php
<?php

declare(strict_types=1);

namespace App\Services;

use App\Models\User;
use App\Models\Subscription;

final class PricingService
{
    public function calculateFinalPrice(User $user, float $basePrice): float
    {
        $subscription = $user->activeSubscription;

        // Null check 1
        if ($subscription !== null && $subscription->isActive()) {
            $discount = $subscription->getDiscountRate();
        } else {
            $discount = 0.0;
        }

        $priceAfterDiscount = $basePrice - ($basePrice * $discount);
        
        // Null check 2
        if ($subscription !== null && $subscription->hasFreeShipping()) {
             $shippingFee = 0.0;
        } else {
             $shippingFee = 15.0;
        }

        return $priceAfterDiscount + $shippingFee;
    }
}
```

### ✅ Kode Benar: Menerapkan Null Object Pattern pada Layer Model/Domain

Dengan mendefinisikan "Null Subscription", kita menjamin objek kembalian selalu bertipe sama (Polymorphism) dan kita dapat menghapus logika if-null dari service layer.

```php
<?php

declare(strict_types=1);

namespace App\Contracts;

interface SubscriptionInterface
{
    public function isActive(): bool;
    public function getDiscountRate(): float;
    public function hasFreeShipping(): bool;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Models\NullObjects;

use App\Contracts\SubscriptionInterface;

final readonly class NullSubscription implements SubscriptionInterface
{
    public function isActive(): bool
    {
        return false;
    }

    public function getDiscountRate(): float
    {
        return 0.0;
    }

    public function hasFreeShipping(): bool
    {
        return false;
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasOne;
use App\Contracts\SubscriptionInterface;
use App\Models\NullObjects\NullSubscription;

final class User extends Model
{
    public function activeSubscription(): HasOne
    {
        return $this->hasOne(Subscription::class)->where('status', 'active');
    }
    
    // Aksesor (Getter) untuk selalu mengembalikan objek valid
    public function getSubscription(): SubscriptionInterface
    {
        return $this->activeSubscription ?? new NullSubscription();
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use App\Contracts\SubscriptionInterface;

final class Subscription extends Model implements SubscriptionInterface
{
    public function isActive(): bool
    {
        return $this->status === 'active' && $this->expires_at->isFuture();
    }

    public function getDiscountRate(): float
    {
        return (float) $this->discount_rate; // misal 0.10
    }

    public function hasFreeShipping(): bool
    {
        return (bool) $this->free_shipping;
    }
}
```

Service kini terbebas dari conditional (Sangat Bersih):

```php
<?php

declare(strict_types=1);

namespace App\Services;

use App\Models\User;

final class PricingService
{
    public function calculateFinalPrice(User $user, float $basePrice): float
    {
        // Polimorfisme mengambil alih
        $subscription = $user->getSubscription();

        $discount = $subscription->getDiscountRate();
        $priceAfterDiscount = $basePrice - ($basePrice * $discount);
        
        $shippingFee = $subscription->hasFreeShipping() ? 0.0 : 15.0;

        return $priceAfterDiscount + $shippingFee;
    }
}
```

---

## 3. Early Return (Guard Clauses) vs Nested If (Arrow Anti-Pattern)

Daripada membungkus logika utama ke dalam struktur kontrol yang dalam (identasi yang membentuk tanda panah `>`), gunakan Guard Clauses untuk gagal secepat mungkin (Fail Fast).

### ❌ Anti-Pattern: Deep Nesting

```php
<?php

declare(strict_types=1);

namespace App\Actions;

use App\Models\User;

final class PublishPostAction
{
    public function execute(User $user, array $data): bool
    {
        if ($user->isActive()) {
            if ($user->hasPermission('publish_posts')) {
                if (!empty($data['title']) && !empty($data['content'])) {
                    if (strlen($data['content']) >= 100) {
                        // ... Logika Utama ...
                        return true;
                    } else {
                        throw new \Exception("Content too short");
                    }
                } else {
                     throw new \Exception("Invalid data");
                }
            } else {
                 throw new \Exception("Unauthorized");
            }
        } else {
            throw new \Exception("Inactive user");
        }
    }
}
```

### ✅ Kode Benar: Guard Clauses

Balik kondisi (invert conditionals) dan tangani error/edge cases di atas. Logika utama ("The Happy Path") tidak teridentasi dan diletakkan paling bawah.

```php
<?php

declare(strict_types=1);

namespace App\Actions;

use App\Models\User;
use App\Exceptions\PostValidationException;
use App\Exceptions\AuthorizationException;
use App\Models\Post;

final class PublishPostAction
{
    public function execute(User $user, array $data): bool
    {
        // Guard 1
        if (!$user->isActive()) {
            throw AuthorizationException::userInactive($user->id);
        }

        // Guard 2
        if (!$user->hasPermission('publish_posts')) {
            throw AuthorizationException::unauthorized('publish_posts');
        }

        // Guard 3 (Walaupun idealnya ada FormRequest, action tetap butuh validasi jika dipanggil via CLI/Job)
        if (empty($data['title']) || empty($data['content'])) {
            throw PostValidationException::missingRequiredFields();
        }

        // Guard 4
        if (strlen($data['content']) < 100) {
            throw PostValidationException::contentTooShort(strlen($data['content']));
        }

        // --- THE HAPPY PATH ---
        // Logika utama di sini, tanpa blok if.
        $post = Post::create([
             'title' => $data['title'],
             'content' => $data['content'],
             'author_id' => $user->id,
        ]);
        
        $post->publish();
        
        return true;
    }
}
```

---

## 4. State Pattern untuk Transisi Status

Sistem yang mengatur Status (seperti Order status: Pending -> Processing -> Shipped -> Delivered -> Cancelled) seringkali penuh dengan kondisi rumit `if ($order->status === 'pending')`.
Alih-alih `if/else`, gunakan Laravel State Machines (bisa menggunakan package spathie/laravel-model-states atau implementasi mandiri State Pattern). Pendekatan mandiri membungkus setiap state menjadi kelas terpisah.

---

## 5. Pengujian dengan Pest v3

Dalam Arsitektur modern, kita harus menguji baik Architecture (via Pest Arch) maupun Unit Behavior secara ekstensif.

### Architecture Testing

```php
<?php

declare(strict_types=1);

// tests/ArchTest.php

use App\Contracts\PaymentStrategy;
use App\Strategies\Payment;

test('globals')
    ->expect(['dd', 'dump', 'ray'])
    ->not->toBeUsed();

test('payment strategies implement interface')
    ->expect('App\Strategies\Payment')
    ->toImplement(PaymentStrategy::class)
    ->toHaveMethod('process')
    ->toHaveMethod('isSupported');

test('payment strategies are final')
    ->expect('App\Strategies\Payment')
    ->toBeClasses()
    ->toBeFinal()
    ->toBeReadonly();

test('controllers depend on contracts or managers, not concrete strategies')
    ->expect('App\Http\Controllers')
    ->toUse('App\Managers\PaymentManager')
    ->not->toUse('App\Strategies\Payment\CreditCardPayment');
```

### Unit Testing Strategy Pattern & Null Object

```php
<?php

declare(strict_types=1);

// tests/Unit/PricingServiceTest.php

use App\Services\PricingService;
use App\Models\User;
use App\Models\NullObjects\NullSubscription;
use App\Contracts\SubscriptionInterface;
use Mockery\MockInterface;

it('calculates price for user with active subscription (polymorphism)', function () {
    /** @var User|MockInterface $userMock */
    $userMock = Mockery::mock(User::class);
    
    $subscriptionMock = Mockery::mock(SubscriptionInterface::class);
    $subscriptionMock->shouldReceive('getDiscountRate')->andReturn(0.10); // 10%
    $subscriptionMock->shouldReceive('hasFreeShipping')->andReturn(true);
    
    $userMock->shouldReceive('getSubscription')->andReturn($subscriptionMock);

    $service = new PricingService();
    $finalPrice = $service->calculateFinalPrice($userMock, 100.0);

    // (100 - (100 * 0.10)) + 0 = 90
    expect($finalPrice)->toBe(90.0);
});

it('calculates price for user without subscription (Null Object pattern)', function () {
    /** @var User|MockInterface $userMock */
    $userMock = Mockery::mock(User::class);
    
    // Test that the Null Object handles everything gracefully
    $userMock->shouldReceive('getSubscription')->andReturn(new NullSubscription());

    $service = new PricingService();
    $finalPrice = $service->calculateFinalPrice($userMock, 100.0);

    // (100 - (100 * 0.0)) + 15 (shipping default) = 115
    expect($finalPrice)->toBe(115.0);
});
```

### Unit Testing Factory / Manager

```php
<?php

declare(strict_types=1);

// tests/Unit/PaymentManagerTest.php

use App\Managers\PaymentManager;
use App\Strategies\Payment\CreditCardPayment;
use App\Strategies\Payment\EWalletPayment;
use App\Exceptions\PaymentException;
use App\Models\Order;

it('resolves credit card driver correctly', function () {
    $app = app();
    config(['services.payment.credit_card_secret' => 'test-secret']);
    
    $manager = new PaymentManager($app);
    $driver = $manager->driver('credit_card');
    
    expect($driver)->toBeInstanceOf(CreditCardPayment::class);
});

it('throws exception if driver is not supported', function () {
    $app = app();
    $manager = new PaymentManager($app);
    
    $manager->driver('crypto'); // not defined
})->throws(\InvalidArgumentException::class, 'Driver [crypto] not supported.');

it('throws exception on invalid order amount before processing', function () {
    $app = app();
    $manager = new PaymentManager($app);
    
    $order = new Order(['amount' => 0]);
    
    $manager->process($order, 'credit_card');
})->throws(PaymentException::class, 'Invalid payment amount: 0');
```

## Kesimpulan
Refactoring _conditional statements_ yang kompleks di Laravel bukan sekadar merapikan sintaks menjadi `match` expression, melainkan memindahkan domain logic tersebut ke lapisan objek yang sesuai (Strategy Pattern, Null Object Pattern, State Pattern). 
Menerapkan **Guard Clauses** untuk validasi input dan _Object-Oriented Design_ sejati (menyembunyikan *state* dan *behavior* polimorfik) akan menghasilkan basis kode PHP 8.4 yang sangat skalabel, minim *regression bugs*, memori yang efisien (hanya me-load *driver* yang dibutuhkan), dan dengan _Cyclomatic Complexity_ yang mendekati 1.
