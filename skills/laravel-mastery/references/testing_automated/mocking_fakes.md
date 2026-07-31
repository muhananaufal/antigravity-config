---
description: "Top 1% Guide to Advanced Mocking, Fakes, and Test Doubles in Laravel 11/12 using Pest v3 and Mockery. Focus on Clean Architecture and PHP 8.3+."
---

# 🏆 Advanced Mocking, Fakes, and Test Doubles in Laravel & Pest v3

## 1. Paradigma Pengujian Modern (The Modern Testing Paradigm)

Dalam pengembangan aplikasi berskala enterprise menggunakan Laravel 11/12 dan PHP 8.3/8.4, pengujian otomatis bukan sekadar alat pelaporan coverage, melainkan jaring pengaman (safety net) untuk arsitektur. Salah satu tantangan terbesar dalam *Unit Testing* maupun *Feature Testing* adalah bagaimana mengisolasi *System Under Test* (SUT) dari dependensi eksternal seperti database, API pihak ketiga, antrian (queue), dan sistem file.

Di sinilah **Test Doubles** berperan. Istilah "Test Double" mencakup beberapa konsep spesifik:
- **Dummy**: Objek yang diteruskan tetapi tidak pernah digunakan secara nyata (hanya untuk memenuhi parameter).
- **Fake**: Objek yang memiliki implementasi bekerja tetapi mengambil jalan pintas (misalnya, `Http::fake()` atau in-memory database).
- **Stub**: Objek yang memberikan jawaban statis/kaleng (canned answers) terhadap pemanggilan tertentu.
- **Mock**: Objek yang dikonfigurasi dengan ekspektasi perilaku (misalnya, mengharapkan metode X dipanggil 1 kali dengan parameter Y).
- **Spy**: Mirip dengan Mock, tetapi kita memverifikasi interaksinya *setelah* SUT dieksekusi, bukan melakukan konfigurasi ekspektasi di awal.

Dalam ekosistem Laravel, kita menggunakan **Mockery** untuk Mocks/Stubs/Spies tingkat objek, dan **Laravel Built-in Fakes** (seperti `Mail::fake()`, `Event::fake()`, `Queue::fake()`) untuk layanan infrastruktur. Kombinasi ini dengan **Pest v3** menghasilkan test suite yang ekspresif, cepat, dan sangat mudah dirawat.

---

## 2. Clean Architecture di Laravel (The Groundwork)

Sebelum kita menguji, kita harus mendesain arsitektur yang *testable*. Kode yang tightly-coupled (sangat terikat) tidak mungkin di-mock dengan baik. Kita akan mengadopsi struktur Clean Architecture dengan alur eksekusi:

`FormRequest` (Validasi) ➡️ `Controller` (Routing & HTTP Response) ➡️ `Action/Service` (Business Logic) ➡️ `Repository` (Data Access) & `External Services` (Interfaces).

Dengan pemisahan ini:
- **Controller** diuji menggunakan *Feature Test* (menggunakan Laravel Fakes).
- **Action/Service** diuji menggunakan *Unit Test* (menggunakan Mockery untuk mem-mock Repository dan External Services).
- **Repository** diuji menggunakan *Integration Test* (menghantam database nyata, seringkali in-memory SQLite atau transaksi yang di-rollback).

---

## 3. 🚨 Anti-Patterns & Security/Memory Risks

Sebelum masuk ke implementasi yang benar, penting untuk memahami bahaya dari praktik pengujian yang buruk. Berikut adalah beberapa Anti-Pattern yang sering terjadi, dampaknya terhadap keamanan/memori, dan solusinya.

### Anti-Pattern 1: Leaking External API Calls (Network/Timeout Risk)

Melakukan pemanggilan HTTP nyata ke API eksternal selama pengujian adalah bencana untuk keandalan CI/CD.

❌ **KODE SALAH (Berbahaya):**
```php
declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Exception;

final class PaymentService
{
    public function charge(string $token, int $amount): bool
    {
        // ❌ BAHAYA: Menghantam API Stripe nyata saat test berjalan!
        $response = Http::withToken('sk_test_123')
            ->post('https://api.stripe.com/v1/charges', [
                'amount' => $amount,
                'source' => $token,
            ]);

        if ($response->failed()) {
            throw new Exception('Payment failed');
        }

        return true;
    }
}
```
**Mengapa Berbahaya?**
- **Security Risk:** Kredensial production atau staging bisa bocor atau terpakai untuk membuat tagihan nyata secara tidak sengaja.
- **Flaky Tests & Timeouts:** Jika API eksternal down atau lambat, test Anda gagal (False Negative). Pipeline CI/CD bisa timeout, menghabiskan alokasi menit runner yang mahal.
- **Rate Limiting:** IP runner CI Anda bisa di-blacklist oleh provider pihak ketiga karena DDoSing API mereka.

✅ **KODE BENAR:**
Selalu gunakan `Http::fake()` atau injeksi Interface `PaymentGatewayInterface` yang kemudian di-mock.

```php
declare(strict_types=1);

// Di dalam file test (Pest)
use Illuminate\Support\Facades\Http;

it('charges payment successfully using Http fake', function () {
    // ✅ BENAR: Menggunakan Fake untuk mencegat (intercept) request nyata.
    Http::fake([
        'api.stripe.com/v1/charges' => Http::response(['id' => 'ch_123', 'status' => 'succeeded'], 200),
    ]);

    $service = new \App\Services\PaymentService();
    $result = $service->charge('tok_visa', 5000);

    expect($result)->toBeTrue();
    
    // ✅ Verifikasi request yang dikirim
    Http::assertSent(function (\Illuminate\Http\Client\Request $request) {
        return $request->url() === 'https://api.stripe.com/v1/charges' &&
               $request['amount'] === 5000;
    });
});
```

### Anti-Pattern 2: Mocking Eloquent Models Secara Langsung (Memory Leak / Fragility)

Mencoba mem-mock instance dari `Illuminate\Database\Eloquent\Model` menggunakan Mockery.

❌ **KODE SALAH (Berbahaya):**
```php
declare(strict_types=1);

use App\Models\User;
use Mockery\MockInterface;

it('calculates user total points', function () {
    // ❌ BAHAYA: Eloquent Model menggunakan banyak magic methods (__get, __set, __call).
    // Mem-mock model secara langsung menyebabkan perilaku yang tidak dapat diprediksi,
    // memory leaks parah pada test runner yang panjang, dan tightly-coupled tests.
    $mockUser = Mockery::mock(User::class, function (MockInterface $mock) {
        $mock->shouldReceive('getAttribute')->with('points')->andReturn(100);
        $mock->shouldReceive('save')->andReturn(true);
    });

    $service = new \App\Services\PointService();
    $service->addPoints($mockUser, 50);
});
```
**Mengapa Berbahaya?**
- **Memory Risk:** Eloquent menyimpan status global dan koneksi secara internal. Mem-mock mereka meninggalkan referensi menggantung (dangling references) di memory Mockery container, membengkakkan konsumsi RAM PHP saat menjalankan ratusan test.
- **Fragility:** Karena magic methods (`__get`), Mockery sering gagal mencegat akses properti. Test Anda menjadi sangat rapuh terhadap perubahan internal Laravel.

✅ **KODE BENAR:**
Gunakan **Repository Pattern** untuk memisahkan logika database, lalu *mock* Repository tersebut. Jika harus berinteraksi dengan Model dalam test, gunakan **Factories** dengan In-Memory SQLite atau `RefreshDatabase` trait.

```php
declare(strict_types=1);

use App\Repositories\UserRepositoryInterface;
use App\Models\User;
use App\Services\PointService;

it('calculates user total points securely', function () {
    // ✅ BENAR: Mocking Repository Interface, bukan Eloquent Model.
    $mockRepository = Mockery::mock(UserRepositoryInterface::class);
    
    // Kita bisa membuat model asli di memory tanpa menyimpannya ke DB.
    $user = new User(['id' => 1, 'points' => 100]);
    
    $mockRepository->shouldReceive('updatePoints')
        ->once()
        ->with(1, 150) // user_id, new_points
        ->andReturn(true);

    $service = new PointService($mockRepository);
    
    // Test action logic
    $service->addPoints($user, 50);
});
```

### Anti-Pattern 3: Partial Mocking of the Subject Under Test (SUT)

Mem-mock sebagian metode dari class yang sama dengan yang sedang Anda uji (Subject Under Test).

❌ **KODE SALAH (Berbahaya):**
```php
declare(strict_types=1);

namespace App\Services;

final class InvoiceService
{
    public function generateAndSend(): bool
    {
        $invoice = $this->generatePdf(); // ❌ Memanggil metode internal
        return $this->sendEmail($invoice);
    }

    public function generatePdf(): string
    {
        return 'pdf_binary_content';
    }

    public function sendEmail(string $pdf): bool
    {
        return true;
    }
}

// Di dalam test:
it('generates and sends invoice (Partial Mock)', function () {
    // ❌ BAHAYA: Mem-mock SUT (InvoiceService) itu sendiri.
    $mockService = Mockery::mock(InvoiceService::class)->makePartial();
    $mockService->shouldReceive('generatePdf')->once()->andReturn('mocked_pdf');
    $mockService->shouldReceive('sendEmail')->once()->andReturn(true);

    $result = $mockService->generateAndSend();
});
```
**Mengapa Berbahaya?**
- **Logika Buta:** Anda tidak lagi menguji `InvoiceService`; Anda menguji konfigurasi Mockery Anda sendiri. Ini memberikan jaminan palsu (false sense of security). Jika implementasi internal `generatePdf` rusak, test ini akan tetap hijau!

✅ **KODE BENAR:**
Ekstrak tanggung jawab ke class terpisah (Single Responsibility Principle) dan mock dependensi eksternal tersebut.

```php
declare(strict_types=1);

// Pisahkan PDF Generation dan Email Sending ke Service terpisah.
use App\Services\PdfGeneratorInterface;
use App\Services\EmailSenderInterface;

final class InvoiceAction
{
    public function __construct(
        private readonly PdfGeneratorInterface $pdfGenerator,
        private readonly EmailSenderInterface $emailSender,
    ) {}

    public function execute(): bool
    {
        $pdf = $this->pdfGenerator->generate('invoice_data');
        return $this->emailSender->send($pdf);
    }
}

// Di dalam test:
it('generates and sends invoice properly', function () {
    // ✅ BENAR: Menguji SUT murni (InvoiceAction) dengan mem-mock dependensinya.
    $mockPdf = Mockery::mock(PdfGeneratorInterface::class);
    $mockPdf->shouldReceive('generate')->once()->andReturn('mock_pdf_binary');

    $mockEmail = Mockery::mock(EmailSenderInterface::class);
    $mockEmail->shouldReceive('send')->with('mock_pdf_binary')->once()->andReturn(true);

    $action = new \App\Services\InvoiceAction($mockPdf, $mockEmail);
    $result = $action->execute();

    expect($result)->toBeTrue();
});
```

---

## 4. Implementasi Penuh: E-Commerce Checkout

Mari kita lihat contoh arsitektur nyata dengan implementasi kelas tingkat tinggi dan pengujiannya.

### 4.1. Domain & Interfaces (Clean Architecture)

```php
// app/Contracts/PaymentGatewayInterface.php
declare(strict_types=1);

namespace App\Contracts;

interface PaymentGatewayInterface
{
    public function charge(float $amount, string $token): string; // Mengembalikan transaction ID
}
```

```php
// app/Repositories/OrderRepositoryInterface.php
declare(strict_types=1);

namespace App\Repositories;

use App\Models\Order;

interface OrderRepositoryInterface
{
    public function create(array $data): Order;
    public function markAsPaid(int $orderId, string $transactionId): void;
}
```

```php
// app/Events/OrderPlaced.php
declare(strict_types=1);

namespace App\Events;

use App\Models\Order;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

final class OrderPlaced
{
    use Dispatchable, SerializesModels;

    public function __construct(public readonly Order $order) {}
}
```

### 4.2. Action/Service Layer (Business Logic)

Action ini bertanggung jawab untuk memproses checkout. Ia menerima dependensi via Constructor Injection.

```php
// app/Actions/ProcessCheckoutAction.php
declare(strict_types=1);

namespace App\Actions;

use App\Contracts\PaymentGatewayInterface;
use App\Repositories\OrderRepositoryInterface;
use App\Events\OrderPlaced;
use Illuminate\Support\Facades\Log;
use Throwable;

final readonly class ProcessCheckoutAction
{
    public function __construct(
        private OrderRepositoryInterface $orderRepository,
        private PaymentGatewayInterface $paymentGateway,
    ) {}

    /**
     * @param array<string, mixed> $orderData
     */
    public function execute(array $orderData, string $paymentToken): bool
    {
        try {
            $order = $this->orderRepository->create($orderData);
            
            $transactionId = $this->paymentGateway->charge($orderData['total_amount'], $paymentToken);
            
            $this->orderRepository->markAsPaid($order->id, $transactionId);
            
            OrderPlaced::dispatch($order);
            
            return true;
        } catch (Throwable $e) {
            Log::error('Checkout failed: ' . $e->getMessage());
            return false;
        }
    }
}
```

### 4.3. HTTP Layer (Controller & Request)

```php
// app/Http/Requests/StoreCheckoutRequest.php
declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class StoreCheckoutRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, \Illuminate\Contracts\Validation\ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'total_amount' => ['required', 'numeric', 'min:1'],
            'payment_token' => ['required', 'string'],
            'items' => ['required', 'array'],
        ];
    }
}
```

```php
// app/Http/Controllers/CheckoutController.php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Actions\ProcessCheckoutAction;
use App\Http\Requests\StoreCheckoutRequest;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final class CheckoutController extends Controller
{
    public function __construct(
        private readonly ProcessCheckoutAction $processCheckoutAction
    ) {}

    public function __invoke(StoreCheckoutRequest $request): JsonResponse
    {
        $success = $this->processCheckoutAction->execute(
            $request->validated(),
            $request->validated('payment_token')
        );

        if (!$success) {
            return response()->json([
                'message' => 'Payment processing failed.'
            ], Response::HTTP_UNPROCESSABLE_ENTITY);
        }

        return response()->json([
            'message' => 'Order processed successfully.'
        ], Response::HTTP_CREATED);
    }
}
```

---

## 5. Pengujian dengan Pest v3 & Mockery

### 5.1. Pest v3 Architecture Testing (arch.php)

Pest menyediakan plugin arsitektur bawaan untuk memastikan kita mematuhi aturan Clean Architecture. Ini akan dijalankan terlebih dahulu dan menggagalkan build jika ada pelanggaran.

```php
// tests/Feature/ArchitectureTest.php
declare(strict_types=1);

// Menggunakan Arch Testing untuk menegakkan Clean Architecture
arch('strict types are enforced everywhere')
    ->expect('App')
    ->toUseStrictTypes();

arch('controllers should not interact with models directly')
    ->expect('App\Http\Controllers')
    ->toNotUse('App\Models')
    ->ignoring('App\Models\User'); // (Opsional: Kecuali auth user)

arch('controllers should only use actions and requests')
    ->expect('App\Http\Controllers')
    ->toOnlyUse([
        'App\Actions',
        'App\Http\Requests',
        'App\Http\Controllers',
        'Illuminate\Http',
        'Symfony\Component\HttpFoundation',
        'function response',
    ]);

arch('actions should be final and readonly classes')
    ->expect('App\Actions')
    ->toBeFinal()
    ->toBeReadonly();
```

### 5.2. Pest v3 Unit Test: Action & Mockery

Kita akan menggunakan Mockery untuk menguji `ProcessCheckoutAction` secara mutlak terisolasi dari database.

```php
// tests/Unit/Actions/ProcessCheckoutActionTest.php
declare(strict_types=1);

use App\Actions\ProcessCheckoutAction;
use App\Contracts\PaymentGatewayInterface;
use App\Repositories\OrderRepositoryInterface;
use App\Models\Order;
use App\Events\OrderPlaced;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Log;

// 1. Setup global untuk setiap test di file ini
beforeEach(function () {
    Event::fake(); // Fake event dispatcher Laravel
    Log::spy();    // Spy logger Laravel
    
    // Inisialisasi Mock Objects
    $this->orderRepositoryMock = Mockery::mock(OrderRepositoryInterface::class);
    $this->paymentGatewayMock = Mockery::mock(PaymentGatewayInterface::class);
    
    // Inisialisasi Action SUT (Subject Under Test)
    $this->action = new ProcessCheckoutAction(
        $this->orderRepositoryMock,
        $this->paymentGatewayMock
    );
});

// 2. Test Success Path
it('processes checkout successfully and dispatches event', function () {
    $orderData = ['total_amount' => 1500.0, 'items' => []];
    $token = 'valid_token_123';
    $transactionId = 'txn_999888';
    
    // Dummy Order Model (di-memori)
    $order = new Order();
    $order->id = 55;
    
    // Konfigurasi ekspektasi pada mock
    $this->orderRepositoryMock
        ->shouldReceive('create')
        ->once()
        ->with($orderData)
        ->andReturn($order);
        
    $this->paymentGatewayMock
        ->shouldReceive('charge')
        ->once()
        ->with(1500.0, $token)
        ->andReturn($transactionId);
        
    $this->orderRepositoryMock
        ->shouldReceive('markAsPaid')
        ->once()
        ->with(55, $transactionId)
        ->andReturnNull();
        
    // Eksekusi SUT
    $result = $this->action->execute($orderData, $token);
    
    // Verifikasi output
    expect($result)->toBeTrue();
    
    // Verifikasi efek samping (Event)
    Event::assertDispatched(OrderPlaced::class, function (OrderPlaced $event) use ($order) {
        return $event->order->id === $order->id;
    });
});

// 3. Test Failure Path (Exception dari Gateway)
it('logs error and returns false when payment fails', function () {
    $orderData = ['total_amount' => 1500.0, 'items' => []];
    $token = 'invalid_token';
    
    $order = new Order();
    $order->id = 56;
    
    $this->orderRepositoryMock
        ->shouldReceive('create')
        ->once()
        ->with($orderData)
        ->andReturn($order);
        
    // Simulasikan kegagalan payment (Throw Exception)
    $this->paymentGatewayMock
        ->shouldReceive('charge')
        ->once()
        ->andThrow(new \Exception('Insufficient funds'));
        
    // Verifikasi bahwa markAsPaid tidak akan pernah dipanggil
    $this->orderRepositoryMock
        ->shouldNotReceive('markAsPaid');
        
    // Eksekusi SUT
    $result = $this->action->execute($orderData, $token);
    
    // Verifikasi output (Graceful Failure)
    expect($result)->toBeFalse();
    
    // Verifikasi Event tidak di-dispatch
    Event::assertNotDispatched(OrderPlaced::class);
    
    // Verifikasi Log Spy (menggunakan Mockery Spy API yang telah dikonfigurasi Log::spy)
    Log::shouldHaveReceived('error')
        ->once()
        ->with('Checkout failed: Insufficient funds');
});
```

### 5.3. Pest v3 Feature Test: Controller & Laravel Fakes

Pada lapisan Controller, kita tidak mem-mock Service/Action secara manual. Kita akan membiarkan Laravel Container (IoC) meresolve instance nyata, namun kita melakukan faking pada binding infrastruktur seperti Event, HTTP, atau injeksi interface eksternal.

```php
// tests/Feature/CheckoutControllerTest.php
declare(strict_types=1);

use App\Models\Order;
use App\Contracts\PaymentGatewayInterface;
use App\Events\OrderPlaced;
use Illuminate\Support\Facades\Event;
use Mockery\MockInterface;
use function Pest\Laravel\postJson;

it('accepts valid payload and returns 201 response', function () {
    Event::fake();
    
    // Karena PaymentGateway adalah eksternal, kita *harus* mem-mock binding-nya
    // pada Service Container Laravel agar Controller (dan Action di baliknya) 
    // menerima versi mock.
    $this->mock(PaymentGatewayInterface::class, function (MockInterface $mock) {
        $mock->shouldReceive('charge')
             ->once()
             ->with(2000.50, 'tok_123')
             ->andReturn('txn_success_xyz');
    });

    // Dummy repository data will be saved to DB in Feature tests. 
    // Pastikan Anda menggunakan RefreshDatabase trait di TestCase utama Anda.
    
    $payload = [
        'total_amount' => 2000.50,
        'payment_token' => 'tok_123',
        'items' => [
            ['id' => 1, 'qty' => 2]
        ]
    ];

    // Eksekusi HTTP Request
    $response = postJson('/api/checkout', $payload);

    // Verifikasi HTTP Response
    $response->assertCreated()
             ->assertJson(['message' => 'Order processed successfully.']);

    // Verifikasi Event dan Database (Integration)
    Event::assertDispatched(OrderPlaced::class);
    
    $this->assertDatabaseHas('orders', [
        'total_amount' => 2000.50,
    ]);
});

it('validates request payload strictly', function () {
    $payload = [
        // Hilang total_amount dan payment_token
        'items' => []
    ];

    $response = postJson('/api/checkout', $payload);

    $response->assertUnprocessable()
             ->assertJsonValidationErrors(['total_amount', 'payment_token']);
});
```

---

## 6. Fitur Mockery Lanjutan (Spies vs Mocks)

### Menggunakan Spies

Mock digunakan ketika Anda ingin mendefinisikan ekspektasi (apa yang *harus* terjadi) **sebelum** Anda mengeksekusi aksi.
Spy digunakan ketika Anda ingin mencatat interaksi dan memverifikasinya **setelah** aksi selesai.

```php
declare(strict_types=1);

use App\Services\NotificationService;
use App\Contracts\SmsClientInterface;

it('sends sms notification using spy', function () {
    // Membuat spy
    $smsClientSpy = Mockery::spy(SmsClientInterface::class);
    
    $service = new NotificationService($smsClientSpy);
    
    // Eksekusi langsung SUT (tanpa shouldReceive di awal)
    $service->alertUser('08123456', 'System Down');
    
    // Verifikasi SETELAH eksekusi
    $smsClientSpy->shouldHaveReceived('send')
        ->once()
        ->with('08123456', 'System Down');
});
```
*Kapan Menggunakan Spies?* Spies sangat berguna jika objek yang di-mock memiliki banyak metode yang dipanggil (seperti Logger), dan Anda hanya peduli dengan satu panggilan spesifik di akhir eksekusi tanpa ingin menetapkan ekspektasi di awal.

---

## 7. Penutup (Best Practices Checklist)

Untuk mencapai arsitektur Top 1% dalam pengujian aplikasi Laravel Anda:
1. **Pemisahan:** Gunakan Dependency Injection dan Interfaces. Jangan pernah melakukan instansiasi objek rumit (menggunakan `new`) di dalam kelas SUT.
2. **Kekuatan Interface:** Mock *Interface*, bukan konkret Class. Ini membuat kode terhindar dari *mocking* internal private logic yang rapuh.
3. **Strict Types:** Selalu gunakan `declare(strict_types=1);` dan Type Hinting (PHP 8.3+) agar Mockery dapat secara otomatis mendeteksi tanda tangan metode (Method Signatures) dan menolak parameter yang salah tipe selama pengujian.
4. **Isolasi Database:** Gunakan Repository Pattern jika logika query sangat kompleks, lalu mock repository-nya di unit test. Untuk feature test, hit test-database menggunakan in-memory SQLite (tercepat).
5. **ZERO Hardcoding Credentials:** Jangan pernah membiarkan test environment terhubung ke gateway eksternal produksi. Selalu gunakan *Laravel Fakes* atau *Mockery*.
6. **Bersihkan Container:** Pest v3 dan struktur internal Laravel sudah otomatis memanggil `Mockery::close()` saat tear-down. Jangan panggil secara manual kecuali Anda memiliki setup environment kustom.
