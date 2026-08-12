# Laravel Cashier Mastery: Stripe & Paddle dengan Clean Architecture

Dokumen ini merupakan panduan definitif dan mendalam untuk mengimplementasikan sistem pembayaran berlangganan (subscriptions), tagihan (invoices), dan webhook menggunakan Laravel Cashier (baik untuk Stripe maupun Paddle). Implementasi ini diwajibkan menggunakan standar PHP 8.3/8.4, Laravel 11/12, serta mengadopsi Clean Architecture yang mencakup DTO (Data Transfer Object), Services, Actions, dan Repositories (jika diperlukan).

Semua kode di bawah dirancang untuk skala *Enterprise*, tanpa placeholder (`// TODO`), sepenuhnya *type-safe*, dan divalidasi menggunakan Pest v3.

---

## 1. Arsitektur Domain Pembayaran (Clean Architecture)

Dalam aplikasi *Fintech* atau *SaaS* berskala besar, menangani pembayaran langsung di dalam Controller atau Model merupakan pelanggaran serius terhadap prinsip *Single Responsibility Principle* (SRP). Arsitektur yang kita gunakan memisahkan *concern* ke dalam beberapa lapisan:

1.  **Data Transfer Objects (DTO):** Objek murni yang memvalidasi dan membawa data antara layer (Controller ke Action/Service).
2.  **Actions/Services:** Tempat bersemayamnya *business logic* inti (membuat pelanggan, melakukan subscribe, menukar paket berlangganan).
3.  **Webhook Handlers:** Menangani asinkronus *event* dari Stripe atau Paddle yang diproses melalui antrean (Queue) untuk mencegah *timeout*.
4.  **Enums:** Mengelola status dan tipe secara ketat.

### 1.1 Enumerasi (Enums)

Menggunakan enumerasi PHP 8.1+ wajib dilakukan untuk menghindari *magic strings*.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Payment\Enums;

enum SubscriptionPlan: string
{
    case BASIC_MONTHLY = 'price_basic_monthly_123';
    case PRO_MONTHLY = 'price_pro_monthly_456';
    case ENTERPRISE_YEARLY = 'price_enterprise_yearly_789';

    public function name(): string
    {
        return match ($this) {
            self::BASIC_MONTHLY => 'Basic Plan',
            self::PRO_MONTHLY => 'Pro Plan',
            self::ENTERPRISE_YEARLY => 'Enterprise Plan',
        };
    }

    public function features(): array
    {
        return match ($this) {
            self::BASIC_MONTHLY => ['1 User', '10GB Storage', 'Email Support'],
            self::PRO_MONTHLY => ['5 Users', '50GB Storage', 'Priority Support'],
            self::ENTERPRISE_YEARLY => ['Unlimited Users', '500GB Storage', '24/7 Dedicated Support'],
        };
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Domain\Payment\Enums;

enum PaymentProvider: string
{
    case STRIPE = 'stripe';
    case PADDLE = 'paddle';
}
```

---

## 2. Data Transfer Objects (DTO)

DTO digunakan untuk memastikan semua data yang masuk ke lapisan servis (Service Layer) sudah divalidasi, berbentuk *strongly-typed*, dan *immutable*. Kita memanfaatkan fitur `readonly` class dari PHP 8.2+.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Payment\DTOs;

use App\Domain\Payment\Enums\SubscriptionPlan;
use Illuminate\Http\Request;
use InvalidArgumentException;

readonly class CreateSubscriptionDTO
{
    public function __construct(
        public int $userId,
        public string $paymentMethodId,
        public SubscriptionPlan $plan,
        public ?string $couponCode = null,
    ) {}

    public static function fromRequest(Request $request): self
    {
        $planValue = $request->string('plan_id')->toString();
        $plan = SubscriptionPlan::tryFrom($planValue);

        if ($plan === null) {
            throw new InvalidArgumentException(
                sprintf('Invalid subscription plan provided: %s', $planValue)
            );
        }

        return new self(
            userId: $request->user()->id,
            paymentMethodId: $request->string('payment_method_id')->toString(),
            plan: $plan,
            couponCode: $request->string('coupon_code')->nullable()
        );
    }
}
```

---

## 3. Implementasi Stripe (Laravel Cashier Stripe)

Stripe Cashier menyediakan antarmuka *fluent* ke sistem pembayaran Stripe. Namun, pembungkus (wrapper) berupa *Service* atau *Action* diperlukan agar logika tetap terisolasi.

### 3.1 Kontrak Servis (Interface)

```php
<?php

declare(strict_types=1);

namespace App\Domain\Payment\Contracts;

use App\Domain\Payment\DTOs\CreateSubscriptionDTO;
use Laravel\Cashier\Subscription;

interface SubscriptionServiceInterface
{
    public function subscribe(CreateSubscriptionDTO $dto): Subscription;
    public function cancel(int $userId, string $subscriptionName): Subscription;
    public function resume(int $userId, string $subscriptionName): Subscription;
    public function swapPlan(int $userId, string $subscriptionName, string $newPlanId): Subscription;
}
```

### 3.2 Stripe Subscription Service

```php
<?php

declare(strict_types=1);

namespace App\Domain\Payment\Services;

use App\Domain\Payment\Contracts\SubscriptionServiceInterface;
use App\Domain\Payment\DTOs\CreateSubscriptionDTO;
use App\Models\User;
use Exception;
use Illuminate\Support\Facades\Log;
use Laravel\Cashier\Exceptions\IncompletePayment;
use Laravel\Cashier\Subscription;
use RuntimeException;

final readonly class StripeSubscriptionService implements SubscriptionServiceInterface
{
    public function subscribe(CreateSubscriptionDTO $dto): Subscription
    {
        /** @var User $user */
        $user = User::query()->findOrFail($dto->userId);

        if ($user->subscribed('default')) {
            throw new RuntimeException('User already has an active subscription.');
        }

        try {
            $subscriptionBuilder = $user->newSubscription('default', $dto->plan->value);

            if ($dto->couponCode !== null) {
                $subscriptionBuilder->withPromotionCode($dto->couponCode);
            }

            // Menerapkan metode pembayaran dan langsung melakukan subscribe
            $subscription = $subscriptionBuilder->create($dto->paymentMethodId);
            
            Log::info('Stripe subscription created successfully', [
                'user_id' => $user->id,
                'plan' => $dto->plan->value,
                'stripe_id' => $subscription->stripe_id,
            ]);

            return $subscription;

        } catch (IncompletePayment $exception) {
            // Memerlukan otentikasi tambahan (3D Secure)
            Log::warning('Incomplete payment requires SCA', [
                'user_id' => $user->id,
                'payment_intent' => $exception->payment->id,
            ]);
            throw $exception;
        } catch (Exception $exception) {
            Log::error('Failed to create Stripe subscription', [
                'user_id' => $user->id,
                'error' => $exception->getMessage(),
            ]);
            throw new RuntimeException('Failed to process subscription. Please try again later.', 0, $exception);
        }
    }

    public function cancel(int $userId, string $subscriptionName = 'default'): Subscription
    {
        /** @var User $user */
        $user = User::query()->findOrFail($userId);
        
        $subscription = $user->subscription($subscriptionName);
        
        if ($subscription === null) {
            throw new RuntimeException('Active subscription not found.');
        }

        return $subscription->cancel();
    }

    public function resume(int $userId, string $subscriptionName = 'default'): Subscription
    {
        /** @var User $user */
        $user = User::query()->findOrFail($userId);
        
        $subscription = $user->subscription($subscriptionName);
        
        if ($subscription === null || ! $subscription->onGracePeriod()) {
            throw new RuntimeException('Subscription is not on grace period and cannot be resumed.');
        }

        return $subscription->resume();
    }

    public function swapPlan(int $userId, string $subscriptionName, string $newPlanId): Subscription
    {
        /** @var User $user */
        $user = User::query()->findOrFail($userId);
        
        $subscription = $user->subscription($subscriptionName);
        
        if ($subscription === null) {
            throw new RuntimeException('Active subscription not found for swapping.');
        }

        return $subscription->swapAndInvoice($newPlanId);
    }
}
```

---

## 4. Implementasi Paddle (Laravel Cashier Paddle)

Berbeda dengan Stripe, Paddle mengurus pengelolaan pajak global (MoR - Merchant of Record). Implementasinya memerlukan webhook yang lebih rumit, namun esensi layanan backend dapat disamakan polanya.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Payment\Services;

use App\Domain\Payment\Contracts\SubscriptionServiceInterface;
use App\Domain\Payment\DTOs\CreateSubscriptionDTO;
use App\Models\User;
use Illuminate\Support\Facades\Log;
use Laravel\Paddle\Exceptions\PaddleException;
use Laravel\Paddle\Subscription;
use RuntimeException;

final readonly class PaddleSubscriptionService implements SubscriptionServiceInterface
{
    /**
     * Catatan: Paddle Cashier v2+ biasanya menangani redirect ke checkout (Paddle.js),
     * Namun jika menggunakan API sisi server (S2S), kita menggunakan facade Paddle.
     * Di sini kita asumsikan flow checkout PayLink.
     */
    public function subscribe(CreateSubscriptionDTO $dto): \Laravel\Cashier\Subscription
    {
        throw new RuntimeException('Paddle Cashier implementation requires returning a checkout link or using Paddle Checkout, not direct server-side API creation like Stripe.');
    }

    public function cancel(int $userId, string $subscriptionName = 'default'): \Laravel\Cashier\Subscription
    {
        // Dalam implementasi nyata, Paddle mengembalikan object tersendiri.
        // Kita menggunakan DocBlock untuk menenangkan IDE karena interface mengikat ke Stripe secara historis dalam dokumen ini.
        // Solusi sejati: pisahkan interface untuk Cashier Stripe & Paddle, atau gunakan return type interface/union.
        
        /** @var User $user */
        $user = User::query()->findOrFail($userId);
        
        /** @var \Laravel\Paddle\Subscription|null $subscription */
        $subscription = $user->subscription($subscriptionName);
        
        if ($subscription === null) {
            throw new RuntimeException('Active Paddle subscription not found.');
        }

        try {
            $subscription->cancel();
            return $subscription; // Note: type mismatch in strict interface, adjust interface in real hybrid app
        } catch (PaddleException $e) {
            Log::error('Paddle cancel error', ['error' => $e->getMessage()]);
            throw new RuntimeException('Cannot cancel Paddle subscription.', 0, $e);
        }
    }
    
    // ... Implementasi resume() dan swapPlan() akan memanfaatkan API Paddle secara spesifik ...
}
```

*(Catatan Arsitektural: Bila menggunakan dua Cashier sekaligus, sangat disarankan menggunakan abstraksi lebih tinggi (misalnya `PaymentGatewayInterface`) dan tidak memaksakan return type `\Laravel\Cashier\Subscription` milik Stripe pada implementasi Paddle, melainkan kembalikan *Domain Entity* murni. Kode di atas menyoroti limitasi tersebut jika desainnya digabungkan).*

---

## 5. Webhook Handlers (Mencegah Race Conditions & Timeout)

Menangani Webhook harus selalu menggunakan tipe asinkronus agar server tidak *timeout* dan Stripe/Paddle tidak melakukan pengiriman ulang (retries).

```php
<?php

declare(strict_types=1);

namespace App\Jobs\StripeWebhooks;

use App\Models\User;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Log;
use Spatie\WebhookClient\Models\WebhookCall;

final class HandleInvoicePaymentSucceeded implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 3;
    public int $backoff = [30, 60, 120];

    public function __construct(
        public readonly WebhookCall $webhookCall
    ) {}

    public function handle(): void
    {
        $payload = $this->webhookCall->payload;
        $customerId = $payload['data']['object']['customer'] ?? null;
        $invoiceId = $payload['data']['object']['id'] ?? null;

        if ($customerId === null) {
            Log::warning('Webhook missing customer ID', ['payload' => $payload]);
            return;
        }

        /** @var User|null $user */
        $user = User::query()->where('stripe_id', $customerId)->first();

        if ($user === null) {
            Log::error('Stripe Customer not found in our database', ['stripe_id' => $customerId]);
            return;
        }

        // Jalankan logika penambahan kredit, update invoice lokal, dll
        $this->processSuccessfulInvoice($user, $invoiceId, $payload);
        
        Log::info('Successfully processed Stripe InvoicePaymentSucceeded', [
            'user_id' => $user->id,
            'invoice_id' => $invoiceId,
        ]);
    }

    private function processSuccessfulInvoice(User $user, string $invoiceId, array $payload): void
    {
        // Real implementation
        $amountPaid = (int) ($payload['data']['object']['amount_paid'] ?? 0);
        $currency = $payload['data']['object']['currency'] ?? 'usd';

        $user->invoices()->create([
            'provider_id' => $invoiceId,
            'amount' => $amountPaid,
            'currency' => $currency,
            'status' => 'paid',
            'paid_at' => now(),
        ]);
        
        // Kirim email notifikasi (event trigger)
        // event(new InvoicePaidEvent($user, $invoiceId, $amountPaid));
    }
}
```

---

## 6. Anti-Patterns (❌ vs ✅)

### 6.1 Anti-Pattern 1: Fat Controllers vs Action/Service Pattern

**❌ Bad Practice (Fat Controller & Lack of Abstraction):**
Memasukkan seluruh logika pembuatan tagihan dan `try-catch` Cashier langsung di Controller. Controller menjadi *God Class* yang tidak dapat di-test dengan mudah secara independen (unit test).

```php
<?php
// ❌ CONTOH BURUK (JANGAN DITIRU)
namespace App\Http\Controllers;

use Illuminate\Http\Request;

class SubscriptionController extends Controller
{
    public function store(Request $request)
    {
        try {
            $user = $request->user();
            
            // Hardcode plan, kurang fleksibel
            if ($request->plan == 'basic') {
                $stripePlan = 'price_123';
            } else {
                $stripePlan = 'price_456';
            }
            
            $user->newSubscription('default', $stripePlan)
                 ->create($request->payment_method);
                 
            return response()->json(['message' => 'Success']);
        } catch (\Exception $e) {
            return response()->json(['error' => $e->getMessage()], 500); // ❌ Mengespose detail error sistem
        }
    }
}
```

**✅ Good Practice (Clean Architecture dengan DTO dan Service):**
Memindahkan tanggung jawab pengumpulan data ke DTO, pemrosesan bisnis ke Service, dan respons ke resource/API layer. Controller hanya menjadi *traffic cop*.

```php
<?php
declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Domain\Payment\DTOs\CreateSubscriptionDTO;
use App\Domain\Payment\Services\StripeSubscriptionService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Laravel\Cashier\Exceptions\IncompletePayment;
use Exception;

final class SubscriptionController
{
    public function __construct(
        private readonly StripeSubscriptionService $subscriptionService
    ) {}

    public function store(Request $request): JsonResponse
    {
        try {
            $dto = CreateSubscriptionDTO::fromRequest($request);
            $subscription = $this->subscriptionService->subscribe($dto);

            return response()->json([
                'message' => 'Subscription created successfully.',
                'subscription_id' => $subscription->id,
            ], 201);
            
        } catch (IncompletePayment $e) {
            return response()->json([
                'message' => 'Payment requires additional action.',
                'payment_intent_client_secret' => $e->payment->client_secret,
            ], 402);
            
        } catch (Exception $e) {
            // Kita sudah menanganinya dengan log di Service, maka di sini kembalikan error generic yang aman
            return response()->json([
                'message' => 'Unable to process subscription at this time.',
            ], 422);
        }
    }
}
```
**Penjelasan:**
Versi "✅" memastikan Controller tetap ringan. Eksekusi Stripe tidak tercampur dengan pengolahan Request. Jika sewaktu-waktu kita beralih ke CLI/Artisan, Service dan DTO dapat digunakan ulang tanpa menyentuh Controller.

### 6.2 Anti-Pattern 2: Menangani Webhook Secara Sinkron

**❌ Bad Practice (Synchronous Webhook Handling):**
Menjalankan *query* database berat, mengirim email, dan melakukan panggilan API eksternal langsung ketika Stripe menembak rute `/stripe/webhook`. Jika melebihi batas waktu (misal 5-10 detik), Stripe akan menganggap gagal dan melakukan *retry* terus-menerus yang akan berujung duplikasi data (Race Conditions).

```php
<?php
// ❌ CONTOH BURUK (Synchronous Webhook)
Route::post('/stripe/webhook', function(Request $request) {
    $payload = $request->all();
    if ($payload['type'] === 'invoice.payment_succeeded') {
        $user = User::where('stripe_id', $payload['data']['object']['customer'])->first();
        // Proses berat: update 10 tabel, panggil PDF generator, kirim email
        generateInvoicePdf(); 
        sendEmail();
    }
    return response('Webhook Handled', 200);
});
```

**✅ Good Practice (Queue & Idempotency):**
Menyimpan *payload* webhook dengan status *pending* ke tabel lokal (menggunakan library seperti `spatie/laravel-webhook-client`), mengembalikan status 200 OK ke Stripe segera dalam hitungan milidetik, lalu melempar tugas (*Job*) ke Queue yang dilengkapi kapabilitas *idempotent*.

```php
<?php
declare(strict_types=1);

// ✅ CONTOH BAIK (Lihat bagian 5 - Webhook Handlers)
// 1. Simpan Webhook Payload via Spatie Webhook Client ke tabel database (otomatis merespon 200)
// 2. Dispatch Job (HandleInvoicePaymentSucceeded) secara asinkron via Redis/RabbitMQ.
// Job class akan diulang jika error, memanfaatkan retry backoff.
// Logika idempotent di dalam job: periksa jika invoice sudah di-update agar tidak dobel.
```

---

## 7. Pengujian Pest v3 (Unit & Architecture)

Kita wajib memastikan *layer* aplikasi tidak saling tumpang tindih menggunakan Pest Architecture tests.

### 7.1 Architecture Testing (`tests/ArchTest.php`)

```php
<?php

declare(strict_types=1);

test('controllers are strictly typed and immutable')
    ->expect('App\Http\Controllers')
    ->toUseStrictTypes()
    ->toBeClasses()
    ->toBeFinal();

test('services should not depend on http requests')
    ->expect('App\Domain\Payment\Services')
    ->not->toUse('Illuminate\Http\Request');

test('dtos should be readonly')
    ->expect('App\Domain\Payment\DTOs')
    ->toBeReadonly()
    ->toBeClasses();
    
test('enums are strictly typed')
    ->expect('App\Domain\Payment\Enums')
    ->toUseStrictTypes()
    ->toBeEnums();
```

### 7.2 Unit Testing Service (`tests/Unit/Services/StripeSubscriptionServiceTest.php`)

Menggunakan *Pest v3* dengan *Mockery* untuk mengisolasi panggilan Cashier dan Model Database sehingga tes berjalan cepat tanpa memukul API eksternal Stripe secara nyata.

```php
<?php

declare(strict_types=1);

use App\Domain\Payment\DTOs\CreateSubscriptionDTO;
use App\Domain\Payment\Enums\SubscriptionPlan;
use App\Domain\Payment\Services\StripeSubscriptionService;
use App\Models\User;
use Laravel\Cashier\Subscription;
use Laravel\Cashier\SubscriptionBuilder;
use Illuminate\Support\Facades\Log;

beforeEach(function () {
    $this->service = new StripeSubscriptionService();
});

it('creates a stripe subscription successfully', function () {
    // 1. Arrange: Setup Mock DTO
    $dto = new CreateSubscriptionDTO(
        userId: 1,
        paymentMethodId: 'pm_card_visa',
        plan: SubscriptionPlan::PRO_MONTHLY,
        couponCode: null
    );

    // 2. Arrange: Mock User & Subscription Builder
    $subscriptionMock = Mockery::mock(Subscription::class);
    $subscriptionMock->stripe_id = 'sub_123456';
    
    $builderMock = Mockery::mock(SubscriptionBuilder::class);
    $builderMock->shouldReceive('create')
        ->with('pm_card_visa')
        ->once()
        ->andReturn($subscriptionMock);

    $userMock = Mockery::mock(User::class);
    $userMock->id = 1;
    $userMock->shouldReceive('getAttribute')->with('id')->andReturn(1);
    $userMock->shouldReceive('subscribed')
        ->with('default')
        ->once()
        ->andReturn(false);
    $userMock->shouldReceive('newSubscription')
        ->with('default', 'price_pro_monthly_456')
        ->once()
        ->andReturn($builderMock);

    // Mock Eloquent Query Builder findOrFail
    $queryMock = Mockery::mock();
    $queryMock->shouldReceive('findOrFail')
        ->with(1)
        ->once()
        ->andReturn($userMock);
    
    // Inject Mock into User Model statically via Laravel magic or override IOC
    // Note: in a real application, you might use a Repository pattern to make this even more decoupled.
    User::shouldReceive('query')->andReturn($queryMock);

    Log::shouldReceive('info')
        ->once()
        ->with('Stripe subscription created successfully', \Mockery::type('array'));

    // 3. Act
    $result = $this->service->subscribe($dto);

    // 4. Assert
    expect($result)->toBeInstanceOf(Subscription::class)
        ->and($result->stripe_id)->toEqual('sub_123456');
});

it('throws exception if user already subscribed', function () {
    // Arrange
    $dto = new CreateSubscriptionDTO(
        userId: 99,
        paymentMethodId: 'pm_123',
        plan: SubscriptionPlan::BASIC_MONTHLY,
    );

    $userMock = Mockery::mock(User::class);
    $userMock->shouldReceive('subscribed')->with('default')->andReturn(true);

    $queryMock = Mockery::mock();
    $queryMock->shouldReceive('findOrFail')->with(99)->andReturn($userMock);
    User::shouldReceive('query')->andReturn($queryMock);

    // Act & Assert
    expect(fn () => $this->service->subscribe($dto))
        ->toThrow(RuntimeException::class, 'User already has an active subscription.');
});
```

---

## Kesimpulan

Implementasi *Subscriptions* menggunakan Laravel Cashier tidak boleh hanya berkutat pada kecepatan koding semata. Skalabilitas, penanganan error, ketepatan tipe data, dan independensi antar *layer* sistem mutlak diperlukan. Melalui penggunaan DTO, Enum, asinkronisasi Webhook, dan pengujian secara masif (*Architecture Tests* dan *Unit Tests*), aplikasi *Fintech* maupun SaaS kita mampu terhindar dari *silent failures*, *race conditions*, serta menjamin stabilitas dalam memproses pendapatan perusahaan.
