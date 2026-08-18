---
title: "Advanced API Error Handling in Laravel 11/12"
description: "Panduan definitif (Top 1% Quality) untuk merancang, mengimplementasikan, dan menguji sistem Error Handling terpusat pada API Laravel menggunakan Clean Architecture, PHP 8.3/8.4, dan Pest v3."
tags: [laravel, api, error-handling, exceptions, clean-architecture, pest]
---

# Advanced API Error Handling in Laravel 11/12

Error handling yang tangguh dan terprediksi adalah pembeda utama antara API level amatir dan *enterprise-grade*. Dalam arsitektur modern (terutama pada Laravel 11+ di mana `app/Exceptions/Handler.php` telah dihilangkan dan digantikan konfigurasi fluent di `bootstrap/app.php`), penanganan *exception* harus tersentralisasi, aman (tidak membocorkan rahasia sistem), terstruktur (mengikuti standar seperti RFC 7807), dan selaras dengan prinsip *Clean Architecture*.

Panduan ini membahas filosofi, arsitektur, dan implementasi dari Error Handling kelas dunia di Laravel 11/12 menggunakan **PHP 8.3/8.4**.

---

## 1. Filosofi & Standarisasi (RFC 7807)

Ketika API merespons dengan error, *client* (Mobile App, SPA, B2B partner) membutuhkan payload yang konsisten agar dapat mem-parsing *error* secara seragam tanpa menebak-nebak strukturnya. Standar yang sangat disarankan adalah **RFC 7807 (Problem Details for HTTP APIs)**.

Struktur standar RFC 7807:
```json
{
  "type": "https://api.example.com/errors/insufficient-funds",
  "title": "Insufficient Funds",
  "status": 422,
  "detail": "Your current balance is 10000, but the transaction requires 50000.",
  "instance": "/transactions/trx_123456",
  "extensions": {
    "current_balance": 10000,
    "required_amount": 50000
  }
}
```

---

## 2. Struktur Domain Exceptions (Clean Architecture)

Dalam Clean Architecture, lapisan terdalam (Domain/Action/Service) DILARANG keras mengembalikan respons HTTP. Lapisan ini hanya boleh melemparkan (`throw`) *Domain Exceptions* yang sangat deskriptif.

### Base Application Exception

```php
<?php

declare(strict_types=1);

namespace App\Exceptions;

use Exception;
use Throwable;

abstract class ApplicationException extends Exception
{
    /**
     * @param array<string, mixed> $contextData
     */
    public function __construct(
        string $message,
        protected readonly int $httpStatus = 500,
        protected readonly array $contextData = [],
        string $errorCode = 'APP_ERR',
        ?Throwable $previous = null
    ) {
        $this->code = $errorCode;
        parent::__construct($message, 0, $previous);
    }

    public function getHttpStatus(): int
    {
        return $this->httpStatus;
    }

    /**
     * @return array<string, mixed>
     */
    public function getContextData(): array
    {
        return $this->contextData;
    }
    
    public function getErrorCode(): string
    {
        return (string) $this->code;
    }
}
```

### Spesifik Domain Exception

```php
<?php

declare(strict_types=1);

namespace App\Domain\Transaction\Exceptions;

use App\Exceptions\ApplicationException;

final class InsufficientFundsException extends ApplicationException
{
    public function __construct(
        private readonly int $currentBalance,
        private readonly int $requiredAmount
    ) {
        parent::__construct(
            message: 'Your current balance is insufficient to process this transaction.',
            httpStatus: 422,
            contextData: [
                'current_balance' => $this->currentBalance,
                'required_amount' => $this->requiredAmount,
            ],
            errorCode: 'ERR_INSUFFICIENT_FUNDS'
        );
    }
}
```

---

## 3. Sentralisasi Exception Handling di Laravel 11+

Di Laravel 11/12, kita mengatur Exception Handling di dalam file `bootstrap/app.php`. Daripada memenuhi file ini dengan *closures*, kita akan membuat kelas *invokable* terdedikasi `ApiExceptionHandler`.

### Konfigurasi `bootstrap/app.php`

```php
<?php

declare(strict_types=1);

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use App\Exceptions\Handlers\ApiExceptionHandler;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware) {
        // middleware configs
    })
    ->withExceptions(function (Exceptions $exceptions) {
        // Register API Exception Handler
        $exceptions->render(new ApiExceptionHandler());
        
        // Report exceptions to external tracker (e.g., Sentry)
        $exceptions->reportable(function (Throwable $e) {
            // Sentry\captureException($e);
        })->stop();
    })->create();
```

### Implementasi `ApiExceptionHandler`

Handler ini akan mengevaluasi jenis *exception* (apakah itu domain exception, validation exception, authentication exception, atau fatal error) dan merapikannya ke standar RFC 7807.

```php
<?php

declare(strict_types=1);

namespace App\Exceptions\Handlers;

use App\Exceptions\ApplicationException;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Throwable;

final readonly class ApiExceptionHandler
{
    /**
     * @return JsonResponse|false
     */
    public function __invoke(Throwable $exception, Request $request): JsonResponse|false
    {
        // Hanya proses untuk request API atau meminta JSON
        if (! $request->is('api/*') && ! $request->expectsJson()) {
            return false;
        }

        return match (true) {
            $exception instanceof ApplicationException => $this->handleApplicationException($exception, $request),
            $exception instanceof ValidationException => $this->handleValidationException($exception, $request),
            $exception instanceof ModelNotFoundException => $this->handleModelNotFoundException($exception, $request),
            $exception instanceof AuthenticationException => $this->handleAuthenticationException($exception, $request),
            $exception instanceof HttpExceptionInterface => $this->handleHttpException($exception, $request),
            default => $this->handleSystemException($exception, $request),
        };
    }

    private function handleApplicationException(ApplicationException $e, Request $request): JsonResponse
    {
        return $this->buildResponse(
            status: $e->getHttpStatus(),
            title: 'Domain Logic Error',
            detail: $e->getMessage(),
            instance: $request->fullUrl(),
            type: $e->getErrorCode(),
            extensions: $e->getContextData()
        );
    }

    private function handleValidationException(ValidationException $e, Request $request): JsonResponse
    {
        return $this->buildResponse(
            status: Response::HTTP_UNPROCESSABLE_ENTITY,
            title: 'Unprocessable Entity',
            detail: 'The provided data was invalid.',
            instance: $request->fullUrl(),
            type: 'ERR_VALIDATION',
            extensions: ['errors' => $e->errors()]
        );
    }

    private function handleModelNotFoundException(ModelNotFoundException $e, Request $request): JsonResponse
    {
        return $this->buildResponse(
            status: Response::HTTP_NOT_FOUND,
            title: 'Resource Not Found',
            detail: 'The requested resource could not be found.',
            instance: $request->fullUrl(),
            type: 'ERR_NOT_FOUND'
        );
    }

    private function handleAuthenticationException(AuthenticationException $e, Request $request): JsonResponse
    {
        return $this->buildResponse(
            status: Response::HTTP_UNAUTHORIZED,
            title: 'Unauthorized',
            detail: 'You must be authenticated to access this resource.',
            instance: $request->fullUrl(),
            type: 'ERR_UNAUTHORIZED'
        );
    }

    private function handleHttpException(HttpExceptionInterface $e, Request $request): JsonResponse
    {
        return $this->buildResponse(
            status: $e->getStatusCode(),
            title: 'HTTP Error',
            detail: $e->getMessage() ?: 'An HTTP error occurred.',
            instance: $request->fullUrl(),
            type: 'ERR_HTTP'
        );
    }

    private function handleSystemException(Throwable $e, Request $request): JsonResponse
    {
        $status = Response::HTTP_INTERNAL_SERVER_ERROR;
        $isLocal = app()->environment('local', 'testing');
        
        $detail = $isLocal ? $e->getMessage() : 'An unexpected internal server error occurred.';
        $extensions = $isLocal ? [
            'file' => $e->getFile(),
            'line' => $e->getLine(),
            'trace' => collect($e->getTrace())->take(5)->toArray(),
        ] : [];

        return $this->buildResponse(
            status: $status,
            title: 'Internal Server Error',
            detail: $detail,
            instance: $request->fullUrl(),
            type: 'ERR_INTERNAL',
            extensions: $extensions
        );
    }

    /**
     * @param array<string, mixed> $extensions
     */
    private function buildResponse(
        int $status,
        string $title,
        string $detail,
        string $instance,
        string $type,
        array $extensions = []
    ): JsonResponse {
        $payload = [
            'type' => $type,
            'title' => $title,
            'status' => $status,
            'detail' => $detail,
            'instance' => $instance,
        ];

        if (! empty($extensions)) {
            $payload['extensions'] = $extensions;
        }

        return new JsonResponse($payload, $status);
    }
}
```

---

## 4. Aliran Kode Clean Architecture

Dalam sistem *Clean Architecture*, layer luar (Controller) tidak mengetahui adanya exception khusus dan tidak memiliki blok `try-catch` besar.

### Request Validation (FormRequest)

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Transaction;

use Illuminate\Foundation\Http\FormRequest;

final class ProcessTransactionRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'amount' => ['required', 'integer', 'min:1'],
            'recipient_id' => ['required', 'string', 'uuid', 'exists:users,id'],
        ];
    }
}
```

### Action / Service Layer

Di layer inilah *business logic* dan validasi domain (bukan input) berjalan.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Transaction\Actions;

use App\Domain\Transaction\Exceptions\InsufficientFundsException;
use App\Models\User;
use Illuminate\Support\Facades\DB;

final class ProcessTransactionAction
{
    public function execute(User $sender, string $recipientId, int $amount): void
    {
        DB::transaction(function () use ($sender, $recipientId, $amount) {
            $currentBalance = $sender->balance;

            if ($currentBalance < $amount) {
                throw new InsufficientFundsException(
                    currentBalance: $currentBalance,
                    requiredAmount: $amount
                );
            }

            // Lakukan pemotongan saldo dan pencatatan transaksi...
            $sender->decrement('balance', $amount);
            // ...
        });
    }
}
```

### Controller Layer

*Controller* menjadi sangat tipis. Cukup menerima *request*, memanggil *Action*, dan merespons (jika berhasil). Tidak ada `try-catch` sama sekali.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Transaction;

use App\Domain\Transaction\Actions\ProcessTransactionAction;
use App\Http\Controllers\Controller;
use App\Http\Requests\Transaction\ProcessTransactionRequest;
use Illuminate\Http\JsonResponse;

final class ProcessTransactionController extends Controller
{
    public function __construct(
        private readonly ProcessTransactionAction $processTransactionAction
    ) {}

    public function __invoke(ProcessTransactionRequest $request): JsonResponse
    {
        /** @var \App\Models\User $user */
        $user = $request->user();

        $this->processTransactionAction->execute(
            sender: $user,
            recipientId: $request->validated('recipient_id'),
            amount: (int) $request->validated('amount')
        );

        return response()->json([
            'status' => 'success',
            'message' => 'Transaction processed successfully.',
        ], 200);
    }
}
```

---

## 5. Anti-Patterns & Best Practices

Berikut adalah perbandingan *Anti-Pattern* yang sering ditemui oleh *developer* medioker dan *Best Practice* untuk *engineer* sejati.

### ❌ Anti-Pattern 1: Mengatur Flow Control Menggunakan Exception (dan Try-Catch di Controller)

Kesalahan yang sering dilakukan adalah Controller menangkap generic Exception dan me-return HTTP JSON dari dalam blok catch secara manual.

```php
// ❌ KODE SALAH
final class OrderController extends Controller
{
    public function store(Request $request): JsonResponse
    {
        try {
            // ... logic panjang ...
            if ($stock < 1) {
                return response()->json(['error' => 'Out of stock'], 400); // ❌ Mengatur flow lewat HTTP
            }
            // ...
        } catch (\Exception $e) {
            // ❌ Menangkap generic exception secara membabi buta
            return response()->json(['message' => 'Something went wrong', 'error' => $e->getMessage()], 500);
        }
    }
}
```

**✅ KODE BENAR: Biarkan Action melempar Domain Exception, dan tangkap secara sentral.**

```php
// ✅ KODE BENAR (Action)
if ($stock < 1) {
    throw new OutOfStockException($productId, $stock); // Sangat deskriptif!
}

// ✅ KODE BENAR (Controller)
// Tidak ada try-catch. Jika ada exception, Handler akan otomatis merespons format RFC 7807.
public function store(StoreOrderRequest $request): JsonResponse
{
    $this->createOrderAction->execute($request->toDto());
    return response()->json(['status' => 'success'], 201);
}
```
**Penjelasan:** *Flow* aplikasi tidak boleh dikendalikan oleh HTTP Response interupsi dari dalam logic. Lepaskan *Domain Exceptions* khusus, sehingga kode mudah ditest secara terisolasi tanpa *overhead* HTTP/Routing.

---

### ❌ Anti-Pattern 2: Membocorkan Database & Stack Trace ke End User di Production

Secara tidak sengaja mengembalikan objek `$e->getMessage()` ke *client* saat Production mode. Ini mengekspos SQL Query, struktur tabel, dan variabel rahasia.

```php
// ❌ KODE SALAH (Di Exception Handler atau Controller)
public function render($request, Throwable $e)
{
    return response()->json([
        'status' => false,
        'message' => $e->getMessage(), // ❌ BERBAHAYA di Production! (Bisa berisi SQL Error)
    ], 500);
}
```

**✅ KODE BENAR: Sanitasi Exception berdasarkan *Environment*.**

```php
// ✅ KODE BENAR (Terimplementasi di ApiExceptionHandler kita)
private function handleSystemException(Throwable $e, Request $request): JsonResponse
{
    $isLocal = app()->environment('local', 'testing');
    
    // ✅ Pesan disanitasi jika di production
    $detail = $isLocal ? $e->getMessage() : 'An unexpected internal server error occurred.';
    $extensions = $isLocal ? [
        'file' => $e->getFile(),
        'line' => $e->getLine(),
    ] : [];

    return $this->buildResponse(
        status: 500,
        title: 'Internal Server Error',
        detail: $detail,
        instance: $request->fullUrl(),
        type: 'ERR_INTERNAL',
        extensions: $extensions
    );
}
```
**Penjelasan:** Di sistem berskala besar, memaparkan SQL error `Column 'api_key' not found in field list` bisa digunakan peretas (SQL Injection *reconnaissance*). Pesan untuk HTTP 500 harus selalu *generic* kecuali di env `local/testing`. Gunakan tools seperti Sentry atau Datadog untuk melacak log aslinya.

---

## 6. Testing dengan Pest v3 (Unit & Architecture)

Implementasi Error Handling wajib diverifikasi, baik perilakunya (Unit Test) maupun konsistensinya (Arch Test).

### Architecture Testing

Kita menggunakan arsitektur ini untuk memaksa agar tidak ada *Domain Exception* yang tidak me-extend *ApplicationException*.

```php
<?php

declare(strict_types=1);

// tests/Feature/Architecture/ExceptionArchitectureTest.php

use App\Exceptions\ApplicationException;

test('semua domain exception harus mewarisi ApplicationException base class')
    ->expect('App\Domain')
    ->classes()
    ->matching('*Exception')
    ->toExtend(ApplicationException::class);

test('controller tidak boleh menggunakan try catch secara mandiri (tergantung exception handler)')
    ->expect('App\Http\Controllers')
    ->not->toUse('try'); // Pest Arch tidak secara natif membaca AST untuk `try-catch`, kita bisa membuat custom rules dengan PHPStan jika diperlukan.
```

### Unit / Feature Testing

```php
<?php

declare(strict_types=1);

// tests/Feature/Transaction/ProcessTransactionTest.php

use App\Models\User;
use function Pest\Laravel\actingAs;
use function Pest\Laravel\postJson;

it('mengembalikan standar error RFC 7807 saat saldo tidak mencukupi', function () {
    $sender = User::factory()->create(['balance' => 1000]);
    $recipient = User::factory()->create();

    $response = actingAs($sender)
        ->postJson('/api/transactions', [
            'recipient_id' => $recipient->id,
            'amount' => 5000,
        ]);

    $response->assertStatus(422)
        ->assertJsonStructure([
            'type',
            'title',
            'status',
            'detail',
            'instance',
            'extensions' => [
                'current_balance',
                'required_amount',
            ]
        ])
        ->assertJson([
            'type' => 'ERR_INSUFFICIENT_FUNDS',
            'title' => 'Domain Logic Error',
            'status' => 422,
            'extensions' => [
                'current_balance' => 1000,
                'required_amount' => 5000,
            ]
        ]);
});

it('menyembunyikan stack trace saat internal error di production environment', function () {
    // Simulasikan production env
    app()->detectEnvironment(fn () => 'production');
    
    $sender = User::factory()->create();
    
    // Buat route buatan atau mock db agar melemparkan exception generik
    // ...

    $response = actingAs($sender)->postJson('/api/trigger-fatal-error');

    $response->assertStatus(500)
        ->assertJson([
            'type' => 'ERR_INTERNAL',
            'title' => 'Internal Server Error',
            'detail' => 'An unexpected internal server error occurred.',
        ])
        ->assertJsonMissing([
            'extensions' => ['file', 'line', 'trace'],
        ]);
});
```

---

## 7. Checklist untuk Production 🚀

Sebelum sistem error handling ini di-deploy, pastikan semua poin di bawah telah terpenuhi:

- [ ] **Custom ApiExceptionHandler Aktif**: Terdaftar sempurna di `bootstrap/app.php`.
- [ ] **RFC 7807 Compliance**: Semua response 4xx/5xx memiliki `type`, `title`, `status`, `detail`, dan `instance`.
- [ ] **ZERO try-catch di Controllers**: Controller bersih dan *delegates* exception ke global handler.
- [ ] **Sanitasi Production**: Data kredensial, string database connection, dan API keys MUST NOT LEAK dalam payload `message` HTTP 500.
- [ ] **Sentry/Datadog Integration**: Error tingkat fatal (HTTP 500) sudah di-laporkan (reported) ke alat pemantauan eksternal (di `reportable` closure `app.php`).
- [ ] **Strong Typing & PHP 8.3/8.4**: Menggunakan `readonly` properties, *constructor property promotion*, *match expressions*, dan *strict types* pada setiap file exception.
- [ ] **Architecture Test Passed**: Tidak ada Exception yang melanggar kontrak hirarki (*extends* dari base ApplicationException).

Dengan implementasi ini, API Laravel Anda menjadi sangat prediktif, sangat aman dari *information leakage*, dan sangat ramah untuk diintegrasikan oleh pihak ketiga.
