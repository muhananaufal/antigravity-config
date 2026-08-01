# Sentry Error Diagnostics Vault & Hardening

Dokumen ini menjelaskan strategi tingkat lanjut untuk implementasi pemantauan kegagalan (Error Monitoring) dengan Sentry. Fitur utama mencakup pembersihan otomatis data sensitif (PII/CC) sebelum terkirim, integrasi pelacakan Release Git SHA, dan rekam jejak (*Breadcrumbs*) pada sistem antrian asinkron seperti Laravel Horizon.

## Arsitektur Data Scrubbing & Breadcrumbs

```ascii
[Exception Thrown (App/Horizon)] 
             |
             v
 [Laravel Exception Handler] 
             |
             v
[Sentry Laravel Integration]
             |
             +-- [BeforeSend Hook] --> (Scrub PII: passwords, CC, SSN)
             |
             +-- [Event Hint Hook] --> (Inject Queue Payload, Headers)
             |
             +-- [Breadcrumbs] ------> (Logs DB Queries, HTTP Client, Redis calls leading up to exception)
             |
             v
   [Sentry Cloud / On-Premise]
   (Grouped by Exception Class & Git SHA)
```

## Spesifikasi Teknis

### 1. Hardening & Data Scrubbing (PII/CC)

Sentry menangkap variabel lingkungan dan payload request. Di level enterprise, ini berisiko mengirim data sensitif. Kita menggunakan callback `before_send` dalam konfigurasi.

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Exceptions;

use Sentry\Event;
use Sentry\EventHint;

final class SentryScrubber
{
    private const SENSITIVE_KEYS = [
        'password',
        'password_confirmation',
        'credit_card',
        'cc_number',
        'cvv',
        'authorization',
        'api_key',
        'token',
        'ssn',
    ];

    /**
     * Memfilter payload sebelum event dikirim ke Sentry.
     */
    public static function scrub(Event $event, ?EventHint $hint): ?Event
    {
        $request = $event->getRequest();

        if (is_array($request) && isset($request['data'])) {
            $request['data'] = self::recursiveScrub($request['data']);
            $event->setRequest($request);
        }

        // Contoh: Drop event sepenuhnya jika error spesifik yang tidak butuh dilacak
        if ($hint !== null && $hint->exception !== null) {
            if ($hint->exception instanceof \Illuminate\Session\TokenMismatchException) {
                return null; // Abaikan CSRF Token Mismatch
            }
        }

        return $event;
    }

    /**
     * @param array<string, mixed> $data
     * @return array<string, mixed>
     */
    private static function recursiveScrub(array $data): array
    {
        foreach ($data as $key => $value) {
            if (is_string($key) && in_array(strtolower($key), self::SENSITIVE_KEYS, true)) {
                $data[$key] = '[FILTERED]';
            } elseif (is_array($value)) {
                $data[$key] = self::recursiveScrub($value);
            }
        }
        return $data;
    }
}
```

### 2. Integrasi ke `config/sentry.php` (Pelabelan & Scrubbing)

Menghubungkan Scrubber dan Git SHA (untuk pelacakan rilis otomatis).

```php
<?php

return [
    'dsn' => env('SENTRY_LARAVEL_DSN', env('SENTRY_DSN')),
    
    // Release dinamis dari CI/CD Git SHA
    'release' => env('SENTRY_RELEASE', trim(exec('git log --pretty="%h" -n1 HEAD'))),
    
    'environment' => env('APP_ENV', 'production'),

    'traces_sample_rate' => (float) env('SENTRY_TRACES_SAMPLE_RATE', 0.1),

    'send_default_pii' => false,

    'before_send' => [\App\Infrastructure\Exceptions\SentryScrubber::class, 'scrub'],
    
    // Merekam Breadcrumbs otomatis (Query DB lambat, error HTTP eksternal)
    'breadcrumbs' => [
        'logs' => true,
        'sql_queries' => true,
        'sql_bindings' => false, // Set false to avoid PII in DB queries
        'queue_info' => true,
        'command_info' => true,
        'http_client_requests' => true,
    ],
];
```

### 3. Horizon Multi-Step Breadcrumbs

Ketika job gagal, sering kali kita tidak tahu state apa yang dieksekusi sebelum error. Menambahkan manual breadcrumbs sangat krusial.

```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Sentry\Laravel\Integration;
use Sentry\Breadcrumb;

final class ProcessComplexCheckout implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct(
        public readonly string $orderId,
        public readonly string $userId
    ) {}

    public function handle(): void
    {
        // Breadcrumb: Merekam awal pemrosesan job
        Integration::addBreadcrumb(new Breadcrumb(
            Breadcrumb::LEVEL_INFO,
            Breadcrumb::TYPE_DEFAULT,
            'job.checkout',
            'Memulai validasi inventaris',
            ['order_id' => $this->orderId]
        ));

        // ... proses validasi yang bisa gagal ...

        Integration::addBreadcrumb(new Breadcrumb(
            Breadcrumb::LEVEL_INFO,
            Breadcrumb::TYPE_HTTP,
            'job.checkout.payment',
            'Memanggil API Payment Gateway X',
            ['gateway' => 'Stripe']
        ));

        // Jika gateway melempar exception di sini, breadcrumbs di atas 
        // akan dilampirkan dalam laporan error Sentry.
    }
}
```

## Anti-Patterns Kritis

#### ❌ 1. Mengaktifkan `sql_bindings` di Production
Secara default, Laravel Sentry menangkap kueri SQL. Mengaktifkan binding akan mengekspos semua parameter string kueri DB (seperti password hash, email, token) langsung ke dashboard Sentry.

```php
// SALAH: Mengekspos PII ke vendor eksternal
'breadcrumbs' => [
    'sql_queries' => true,
    'sql_bindings' => true, // BAHAYA!
],
```
```php
// BENAR: Matikan bindings, hanya query bentuk statis yang terlihat
'breadcrumbs' => [
    'sql_queries' => true,
    'sql_bindings' => false,
],
```

#### ❌ 2. Over-Sampling Traces
Menset `traces_sample_rate = 1.0` pada aplikasi ber-traffic tinggi akan menghabiskan kuota event Sentry/APM dalam hitungan menit dan memberatkan CPU/RAM (Performance overhead).

```php
// BENAR: Sampling parsial untuk performa (10% dari total trafik)
'traces_sample_rate' => 0.1, 
```

## Production Edge Cases

1. **Massive Exception Floods pada Queue Restart:**
   - *Masalah:* Jika database (Redis/MySQL) down, Horizon akan mencoba ratusan job yang gagal per detik, membanjiri Sentry dengan error yang sama (Quota Exhaustion & Rate Limiting).
   - *Solusi:* Implementasikan algoritma *Circuit Breaker* atau batasi retries pada job. Sentry tidak akan menghentikan exception flood dengan sendirinya, jadi konfigurasi `ignore_exceptions` atau throttle exception di level Handler.

2. **Scrubbing Leak pada File Upload (Multipart Form):**
   - *Masalah:* PII (seperti foto KTP) di-upload dan path sementaranya terekam oleh exception handler atau di-serialize.
   - *Solusi:* Callback `before_send` harus secara tegas menghilangkan konten binary (atau base64) besar dan properti file bawaan Laravel (`Illuminate\Http\UploadedFile`) dari request payload sebelum payload dikonversi menjadi JSON.

3. **Asynchronous/Octane Sentry Context Bleed:**
   - *Masalah:* Di Laravel Octane, data user dari request sebelumnya (`Auth::user()`) bisa bocor ke error pada request selanjutnya karena Sentry singleton tidak dibersihkan antar-request.
   - *Solusi:* Pastikan menggunakan integrasi spesifik Octane (`sentry:octane:setup`), dan jalankan `\Sentry\State\Hub::getCurrent()->pushScope()` dan `popScope()` jika melakukan task threading asinkron (misal `Octane::concurrently`).

## Testing Terpadu (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Infrastructure\Exceptions\SentryScrubber;
use Sentry\Event;
use Sentry\EventHint;

covers(SentryScrubber::class);

test('sentry scrubber recursively removes sensitive PII data', function () {
    $event = Event::createEvent();
    
    // Simulasi data HTTP request yang terperangkap Sentry
    $payload = [
        'method' => 'POST',
        'url' => 'https://api.example.com/checkout',
        'data' => [
            'user_name' => 'John Doe',
            'credit_card' => '4111-1111-1111-1111', // Should be scrubbed
            'cvv' => '123', // Should be scrubbed
            'nested' => [
                'token' => 'super-secret-token', // Should be scrubbed
                'status' => 'active',
            ]
        ]
    ];
    
    $event->setRequest($payload);
    
    $scrubbedEvent = SentryScrubber::scrub($event, new EventHint());
    
    expect($scrubbedEvent)->not->toBeNull();
    
    $requestData = $scrubbedEvent->getRequest();
    
    expect($requestData['data']['user_name'])->toBe('John Doe')
        ->and($requestData['data']['credit_card'])->toBe('[FILTERED]')
        ->and($requestData['data']['cvv'])->toBe('[FILTERED]')
        ->and($requestData['data']['nested']['token'])->toBe('[FILTERED]')
        ->and($requestData['data']['nested']['status'])->toBe('active');
});

test('sentry scrubber drops specific ignored exceptions entirely', function () {
    $event = Event::createEvent();
    $hint = new EventHint();
    
    // Simulate CSRF exception
    $hint->exception = new \Illuminate\Session\TokenMismatchException();
    
    $scrubbedEvent = SentryScrubber::scrub($event, $hint);
    
    expect($scrubbedEvent)->toBeNull(); // Event dropped
});
```
