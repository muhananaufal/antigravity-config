# 🚀 Laravel Mastery: Enterprise-Grade Webhooks (Top 1% Quality)

Webhooks adalah mekanisme komunikasi antar sistem berbasis HTTP. Di tingkat *Enterprise*, menerima webhook bukan sekadar mem-parsing JSON, melainkan tentang **Security, Idempotency, Asynchrony, dan Resilience**.

Dokumen ini adalah panduan komprehensif mengelola Webhook di Laravel 11/12 + PHP 8.3/8.4 menggunakan prinsip *Clean Architecture* dan *Domain-Driven Design* (DDD) ringan.

---

## 🏗️ 1. Pilar Utama Webhook Enterprise

1.  **Verifikasi Tanda Tangan (Signature Validation)**: Jangan percaya muatan apa pun tanpa memvalidasi kriptografi HMAC.
2.  **Idempotency (Anti-Duplikasi)**: Webhook sering mengalami *retry* dari *provider* (misal: Stripe). Sistem harus kebal terhadap duplikasi pemrosesan.
3.  **Proses Asinkron (Queue-First)**: Respons `200 OK` atau `202 Accepted` ke *provider* secepat mungkin (idealnya < 300ms). Pindahkan logika beban berat ke *Background Job*.
4.  **Logging & Audit Trail**: Simpan *raw payload* untuk keperluan *debugging* atau *replay* masa depan.
5.  **Graceful Error Handling & Dead Letter Queues**: Jangan membiarkan *job* gagal tanpa peringatan dan strategi pemulihan.

---

## ❌ vs ✅ 2. Anti-Patterns & Solusi Best Practice

### Anti-Pattern #1: Memproses Webhook Secara Sinkron & Mengabaikan Signature

❌ **KODE SALAH (Memicu Timeout & Vulnerability)**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use App\Models\Order;
use App\Services\PaymentService;

class StripeWebhookController extends Controller
{
    // BAHAYA: Tanpa middleware validasi signature!
    public function handle(Request $request, PaymentService $paymentService)
    {
        $payload = $request->all();

        // BAHAYA: Memproses logika lambat secara langsung (sinkron)
        if ($payload['type'] === 'payment_intent.succeeded') {
            $order = Order::find($payload['data']['object']['metadata']['order_id']);
            $paymentService->processFulfillment($order); // Proses 5 detik!
            $paymentService->sendInvoiceEmail($order); // Proses 3 detik!
        }

        // Stripe mungkin sudah timeout karena durasi total 8 detik
        return response()->json(['status' => 'success']);
    }
}
```
**Penjelasan:** *Provider* (seperti Stripe) memiliki batas *timeout* (biasanya 5 detik). Pemrosesan sinkron menyebabkan *provider* mengira pengiriman gagal, sehingga mereka akan melakukan *retry* (mengirim webhook ulang), menyebabkan duplikasi tagihan/email. Ketiadaan verifikasi *signature* memungkinkan *attacker* memalsukan *payment success*.

✅ **KODE BENAR (Asynchronous & Middleware Secured)**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Requests\StripeWebhookRequest;
use App\Actions\Webhooks\DispatchStripeEventAction;
use Illuminate\Http\JsonResponse;

class StripeWebhookController extends Controller
{
    // Endpoint ini HANYA memvalidasi signature (via Middleware) dan payload,
    // lalu melempar (dispatch) Job ke dalam Queue.
    public function handle(
        StripeWebhookRequest $request,
        DispatchStripeEventAction $action
    ): JsonResponse {
        // Logika asinkron: Action hanya memparsing dan mendispatch ke Queue
        $action->execute($request->validated());

        // Kembalikan 202 Accepted secepat kilat (< 50ms)
        return response()->json(['status' => 'accepted'], 202);
    }
}
```

### Anti-Pattern #2: Mengabaikan Idempotency (Duplicate Processing)

❌ **KODE SALAH (Double Charging/Emailing Risiko Tinggi)**
```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Models\Order;
use Illuminate\Support\Facades\Mail;

class ProcessPaymentJob
{
    public function handle(array $payload): void
    {
        $order = Order::find($payload['order_id']);

        // BAHAYA: Jika Stripe mengirim payload ini 2 kali karena network glitch,
        // status akan diupdate 2 kali, dan email dikirim 2 kali!
        $order->update(['status' => 'paid']);
        Mail::to($order->user)->send(new OrderPaid($order));
    }
}
```
**Penjelasan:** *Provider* sering menjanjikan *"At-least-once delivery"*. Artinya, jika ada gangguan jaringan, *payload* yang sama (dengan ID *event* yang sama) mungkin dikirim berulang. Jika kode tidak *idempotent*, Anda akan merugikan *user* dengan tagihan ganda atau email spam.

✅ **KODE BENAR (Idempotency Key & Status Check via Pessimistic Locking)**
```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Models\Order;
use App\Models\WebhookLog;
use Illuminate\Support\Facades\DB;
use Illuminate\Contracts\Queue\ShouldQueue;

class ProcessStripePaymentJob implements ShouldQueue
{
    public function __construct(
        public readonly string $eventId,
        public readonly array $payload
    ) {}

    public function handle(): void
    {
        DB::transaction(function () {
            // 1. Cek apakah Event ID sudah pernah diproses (Idempotency via table log)
            $log = WebhookLog::firstOrCreate(
                ['provider_event_id' => $this->eventId],
                ['provider' => 'stripe', 'status' => 'processing', 'payload' => $this->payload]
            );

            // Jika statusnya bukan baru saja dibuat, berarti ini request duplikat!
            if (!$log->wasRecentlyCreated && in_array($log->status, ['processed', 'processing'])) {
                return; // Abaikan secara halus
            }

            // 2. State Machine Check: Pastikan order masih dalam state 'pending'
            $order = Order::where('id', $this->payload['metadata']['order_id'])
                          ->lockForUpdate() // Pessimistic locking mencegah race condition
                          ->firstOrFail();

            if ($order->status !== 'pending') {
                $log->update(['status' => 'skipped_invalid_state']);
                return;
            }

            // 3. Proses aman
            $order->update(['status' => 'paid']);
            // Dispatch Queue email...

            // 4. Tandai log selesai
            $log->update(['status' => 'processed']);
        });
    }
}
```

---

## 🏛️ 3. Clean Architecture: Implementasi Top 1% Webhook

Dalam *Clean Architecture*, alur masuk webhook dibagi menjadi tanggung jawab spesifik: Middleware (Verifikasi), Request (Validasi Bentuk), Controller (Titik Masuk), Action (Pemilah), Repository (Data), dan Job (Pemroses Latar Belakang).

### A. Middleware (Validasi Signature)

*Lokasi: `app/Http/Middleware/VerifyStripeSignature.php`*

```php
<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use Stripe\WebhookSignature;
use Stripe\Exception\SignatureVerificationException;

final class VerifyStripeSignature
{
    public function handle(Request $request, Closure $next): Response
    {
        $signature = $request->header('Stripe-Signature');
        $secret = config('services.stripe.webhook_secret');

        if (! $signature || ! $secret) {
            abort(403, 'Missing signature or webhook secret.');
        }

        try {
            // Validasi native via library (Mencegah timing attacks & kadaluwarsa)
            WebhookSignature::verifyHeader(
                $request->getContent(),
                $signature,
                $secret,
                config('services.stripe.webhook_tolerance', 300)
            );
        } catch (SignatureVerificationException $e) {
            abort(403, 'Invalid Stripe signature.');
        }

        return $next($request);
    }
}
```

### B. FormRequest (DTO / Input Validation)

*Lokasi: `app/Http/Requests/StripeWebhookRequest.php`*

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class StripeWebhookRequest extends FormRequest
{
    public function authorize(): bool
    {
        // Otentikasi sudah ditangani sepenuhnya oleh Middleware VerifyStripeSignature
        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'id' => ['required', 'string'],
            'type' => ['required', 'string'],
            'data' => ['required', 'array'],
            'data.object' => ['required', 'array'],
        ];
    }
}
```

### C. Controller (Entrypoint)

*Lokasi: `app/Http/Controllers/Webhooks/StripeWebhookController.php`*

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Webhooks;

use App\Http\Controllers\Controller;
use App\Http\Requests\StripeWebhookRequest;
use App\Actions\Webhooks\DispatchStripeEventAction;
use Illuminate\Http\JsonResponse;

final class StripeWebhookController extends Controller
{
    public function __invoke(
        StripeWebhookRequest $request,
        DispatchStripeEventAction $action
    ): JsonResponse {
        $action->execute(
            eventId: $request->validated('id'),
            eventType: $request->validated('type'),
            payload: $request->validated()
        );

        return response()->json(['status' => 'accepted'], 202);
    }
}
```

### D. Action/Service (Business Logic Dispatcher)

*Lokasi: `app/Actions/Webhooks/DispatchStripeEventAction.php`*

```php
<?php

declare(strict_types=1);

namespace App\Actions\Webhooks;

use App\Jobs\Webhooks\ProcessStripePaymentSuccessJob;
use App\Jobs\Webhooks\ProcessStripePaymentFailedJob;
use Illuminate\Support\Facades\Log;

final class DispatchStripeEventAction
{
    /**
     * @param array<string, mixed> $payload
     */
    public function execute(string $eventId, string $eventType, array $payload): void
    {
        Log::info("Received Stripe Webhook", ['event_id' => $eventId, 'type' => $eventType]);

        // Pola "Registry" / Switch untuk Dispatching berdasarkan tipe event secara Background
        match ($eventType) {
            'payment_intent.succeeded' => ProcessStripePaymentSuccessJob::dispatch($eventId, $payload),
            'payment_intent.payment_failed' => ProcessStripePaymentFailedJob::dispatch($eventId, $payload),
            default => Log::debug("Unhandled Stripe event type: {$eventType}"),
        };
    }
}
```

### E. Model & Repository (Data Access)

*Gunakan tabel log khusus untuk merekam raw data dan melacak idempotency.*

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

final class WebhookLog extends Model
{
    protected $fillable = [
        'provider',
        'provider_event_id',
        'type',
        'status', // pending, processing, processed, failed, skipped
        'payload',
        'exception_trace',
    ];

    protected function casts(): array
    {
        return [
            'payload' => 'array', // Otomatis cast/serialize array ke JSON
        ];
    }
}
```

*Lokasi: `app/Repositories/Contracts/OrderRepositoryInterface.php` & `app/Repositories/OrderRepository.php`*

```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Models\Order;
use App\Repositories\Contracts\OrderRepositoryInterface;
use Illuminate\Database\Eloquent\ModelNotFoundException;

final class OrderRepository implements OrderRepositoryInterface
{
    /**
     * @throws ModelNotFoundException
     */
    public function lockAndFindForUpdate(string $orderId): Order
    {
        return Order::where('id', $orderId)->lockForUpdate()->firstOrFail();
    }

    public function markAsPaid(Order $order): bool
    {
        return $order->update(['status' => 'paid', 'paid_at' => now()]);
    }
}
```

### F. Job (Background Processor Utama)

*Lokasi: `app/Jobs/Webhooks/ProcessStripePaymentSuccessJob.php`*

```php
<?php

declare(strict_types=1);

namespace App\Jobs\Webhooks;

use App\Models\WebhookLog;
use App\Repositories\Contracts\OrderRepositoryInterface;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Throwable;

final class ProcessStripePaymentSuccessJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 3;
    public int $backoff = 60; // Retry otomatis via queue worker setiap 1 menit jika Exception

    /**
     * @param array<string, mixed> $payload
     */
    public function __construct(
        public readonly string $eventId,
        public readonly array $payload
    ) {}

    public function handle(OrderRepositoryInterface $orderRepository): void
    {
        DB::transaction(function () use ($orderRepository) {
            $log = WebhookLog::firstOrCreate(
                ['provider_event_id' => $this->eventId, 'provider' => 'stripe'],
                ['type' => $this->payload['type'], 'status' => 'processing', 'payload' => $this->payload]
            );

            if (! $log->wasRecentlyCreated && $log->status === 'processed') {
                return; // Idempotent: Abaikan pemrosesan duplikat
            }

            $orderId = $this->payload['data']['object']['metadata']['order_id'] ?? null;
            if (! $orderId) {
                $log->update(['status' => 'failed', 'exception_trace' => 'Missing order_id in metadata']);
                return;
            }

            // Pessimistic Locking untuk mencegah Race Conditions saat multiple workers
            $order = $orderRepository->lockAndFindForUpdate((string) $orderId);

            if ($order->status !== 'pending') {
                $log->update(['status' => 'skipped', 'exception_trace' => 'Order state is not pending']);
                return;
            }

            $orderRepository->markAsPaid($order);

            $log->update(['status' => 'processed']);
        });
    }

    public function failed(Throwable $exception): void
    {
        WebhookLog::where('provider_event_id', $this->eventId)
            ->update([
                'status' => 'failed',
                'exception_trace' => $exception->getMessage(),
            ]);
    }
}
```

---

## 🧪 4. Testing Webhooks (Pest v3)

Jangan menguji sistem webhook secara manual berulang-ulang menggunakan Postman. Automasi 100% menggunakan Pest PHP untuk memvalidasi arsitektur dan kapabilitas *idempotency*.

### A. Architecture Testing

Pastikan semua Job webhook mengimplementasi antarmuka antrean (queue), dan tidak ada yang beroperasi secara *synchronous*.

*Lokasi: `tests/Architecture/WebhookTest.php`*

```php
<?php

declare(strict_types=1);

use Illuminate\Contracts\Queue\ShouldQueue;

arch('semua webhook job harus dimasukkan ke dalam antrean (asynchronous)')
    ->expect('App\Jobs\Webhooks')
    ->toImplement(ShouldQueue::class);

arch('semua controller webhook harus return strictly')
    ->expect('App\Http\Controllers\Webhooks')
    ->toHaveMethod('__invoke');
```

### B. Unit & Feature Testing

Uji titik integrasi Webhook secara terisolasi. Kita membuat *dummy signature* menggunakan `WebhookSignature::generateHeader` Stripe untuk simulasi penerimaan HTTP valid.

*Lokasi: `tests/Feature/Webhooks/StripeWebhookTest.php`*

```php
<?php

declare(strict_types=1);

use App\Jobs\Webhooks\ProcessStripePaymentSuccessJob;
use Illuminate\Support\Facades\Bus;
use Stripe\WebhookSignature;

use function Pest\Laravel\postJson;

beforeEach(function () {
    $this->secret = config('services.stripe.webhook_secret');
    $this->payload = [
        'id' => 'evt_test_123',
        'type' => 'payment_intent.succeeded',
        'data' => [
            'object' => [
                'metadata' => ['order_id' => 'ord_456'],
            ],
        ],
    ];
    $this->timestamp = time();
});

it('menolak webhook tanpa signature yang valid dari header Stripe', function () {
    postJson('/api/webhooks/stripe', $this->payload)
        ->assertStatus(403);
});

it('menerima webhook valid dan mendispatch Job ke queue asinkron', function () {
    Bus::fake(); // Mencegah Job dieksekusi secara nyata

    $signedPayload = json_encode($this->payload);
    $signature = WebhookSignature::generateHeader($this->timestamp, $this->secret, $signedPayload);

    postJson('/api/webhooks/stripe', $this->payload, [
        'Stripe-Signature' => $signature,
    ])->assertStatus(202)
      ->assertJson(['status' => 'accepted']);

    Bus::assertDispatched(ProcessStripePaymentSuccessJob::class, function ($job) {
        return $job->eventId === 'evt_test_123';
    });
});
```

*Lokasi: `tests/Unit/Jobs/ProcessStripePaymentSuccessJobTest.php`*

```php
<?php

declare(strict_types=1);

use App\Jobs\Webhooks\ProcessStripePaymentSuccessJob;
use App\Models\Order;
use App\Models\WebhookLog;
use App\Repositories\OrderRepository;

it('memproses pembayaran secara penuh dan mencatat idempotency webhook log', function () {
    $order = Order::factory()->create(['status' => 'pending']);
    
    $payload = [
        'type' => 'payment_intent.succeeded',
        'data' => ['object' => ['metadata' => ['order_id' => $order->id]]]
    ];

    $job = new ProcessStripePaymentSuccessJob('evt_789', $payload);
    $job->handle(new OrderRepository());

    // Verifikasi Transaksi Database (Pessimistic Locking bekerja)
    expect($order->fresh()->status)->toBe('paid');
    
    $log = WebhookLog::where('provider_event_id', 'evt_789')->first();
    expect($log->status)->toBe('processed');
});

it('mengabaikan secara elegan panggilan webhook duplikat (Idempotency Check Test)', function () {
    $order = Order::factory()->create(['status' => 'pending']);
    $payload = [
        'type' => 'payment_intent.succeeded',
        'data' => ['object' => ['metadata' => ['order_id' => $order->id]]]
    ];

    // Simulasikan job dipanggil 2 kali (Contoh: Retry Stripe karena delay jaringan)
    $job1 = new ProcessStripePaymentSuccessJob('evt_duplicate_000', $payload);
    $job2 = new ProcessStripePaymentSuccessJob('evt_duplicate_000', $payload);

    $repo = new OrderRepository();
    
    // Panggilan pertama sukses
    $job1->handle($repo);
    
    // Modifikasi manual (Simulasi proses refund / admin cancel di tengah jalan)
    $order->update(['status' => 'refunded']);
    
    // Panggil ulang payload yg sama!
    $job2->handle($repo);

    // Order tidak boleh ditimpa menjadi `paid` ulang, karena id event sudah tercatat (Idempotency)
    expect($order->fresh()->status)->toBe('refunded');
});
```

---

## 📋 5. Checklist Deployment Produksi 🚀

Saat melempar fitur Webhook ke *Staging* atau *Production*, pastikan elemen infrastruktur berikut memadai:

1. [ ] **Rate Limiting**: Lindungi *route* webhook dengan `ThrottleRequests` Laravel (Contoh: `throttle:100,1`).
2. [ ] **IP Whitelisting**: Izinkan webhook hanya dari *IP Range* resmi milik provider API terkait (misal CIDR dari Stripe/Github).
3. [ ] **Timeouts Worker**: Atur nilai `timeout` di *worker horizon/supervisor* (contoh `timeout=300`) agar Job yang mandek diakhiri tanpa bocor RAM.
4. [ ] **Queue Optimization**: Dedikasikan koneksi atau antrean terpisah (seperti `queue=webhooks`) di *Horizon* agar transaksi Webhook tidak bercampur dengan pengiriman Email Marketing massal.
5. [ ] **Dead Letter Queue (DLQ)**: Jika Job webhook gagal setelah batas maksimal (parameter `tries = 3`), ia akan jatuh ke dalam database tabel `failed_jobs`. Pastikan sistem *monitoring* (Misal Sentry, Bugsnag, atau Log Slack) disiapkan untuk bereaksi otomatis saat entri muncul di DLQ.
