# Pipeline Log Monolog (ELK / Datadog / CloudWatch)

Dokumen ini menjelaskan arsitektur *Structured JSON Logging* performa tinggi yang menginjeksi W3C Trace Context / `X-Request-ID` secara otomatis ke seluruh baris log. Logging dikirim tanpa memblokir request pengguna (menggunakan stream, non-blocking UDP, atau HTTP asinkron) ke centralized logging systems seperti Datadog, CloudWatch, atau Elasticsearch.

## Arsitektur Alur Log JSON

```ascii
[Client] -> [Middleware (Set X-Request-ID / TraceParent)] -> [Application Logic (Log::info)]
                                                                       |
                                                                       v
                                                           [Monolog Request Processor]
                                                (Injects Request ID, User ID, Tenant ID, Memory)
                                                                       |
                                                                       v
                                                           [Monolog JSON Formatter]
                                                 (Serializes log record to strict JSON format)
                                                                       |
                                                                       v
                                    +----------------------------------+----------------------------------+
                                    |                                  |                                  |
                                    v                                  v                                  v
                        [Syslog UDP Handler]                  [Datadog API Handler]              [Stream Handler]
                     (Local Vector/FluentBit)              (Async via Octane/Guzzle)           (php://stdout for K8s)
                                    |                                  |                                  |
                                    +----------------------------------+----------------------------------+
                                                                       v
                                                           [ELK / Datadog / CloudWatch]
```

## Spesifikasi Teknis

### 1. Injeksi Trace ID & Processor Kustom

Mencegat seluruh log untuk memasukkan konteks request (W3C Trace Context) sehingga log dari berbagai layanan/mikroservis dapat dikorelasikan (*Distributed Tracing*).

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Logging\Processors;

use Illuminate\Http\Request;
use Monolog\LogRecord;
use Monolog\Processor\ProcessorInterface;

final readonly class TraceContextProcessor implements ProcessorInterface
{
    public function __construct(
        private ?Request $request = null
    ) {}

    public function __invoke(LogRecord $record): LogRecord
    {
        $extra = $record->extra;

        if ($this->request !== null) {
            $extra['request_id'] = $this->request->header('X-Request-ID') ?? $this->request->attributes->get('request_id', 'unknown');
            
            // W3C Trace Context (traceparent)
            $extra['trace_id'] = $this->request->header('traceparent');
            
            $extra['ip'] = $this->request->ip();
            $extra['user_agent'] = $this->request->userAgent();
            
            if ($this->request->user() !== null) {
                $extra['user_id'] = $this->request->user()->getAuthIdentifier();
            }
        }

        $extra['memory_usage_mb'] = round(memory_get_usage(true) / 1024 / 1024, 2);
        
        return $record->with(extra: $extra);
    }
}
```

### 2. Konfigurasi `logging.php` Kustom

Menggunakan JSON formatter dan mendaftarkan kustom prosesor di atas. Ini ditujukan agar mesin log (Logstash/Datadog agent) dapat mengurai log tanpa RegEx.

```php
<?php

use App\Infrastructure\Logging\Processors\TraceContextProcessor;
use Monolog\Formatter\JsonFormatter;
use Monolog\Handler\StreamHandler;

return [
    'default' => env('LOG_CHANNEL', 'stack'),
    
    'channels' => [
        'stack' => [
            'driver' => 'stack',
            'channels' => ['json_stdout'],
            'ignore_exceptions' => false,
        ],

        'json_stdout' => [
            'driver' => 'monolog',
            'handler' => StreamHandler::class,
            'with' => [
                'stream' => 'php://stdout',
            ],
            'formatter' => JsonFormatter::class,
            'formatter_with' => [
                'appendNewline' => true,
                'ignoreEmptyContextAndExtra' => true,
            ],
            'processors' => [
                TraceContextProcessor::class,
            ],
        ],
        
        // Contoh Pengiriman Datadog (Gunakan librari datadog atau syslog UDP)
        'datadog_udp' => [
            'driver' => 'monolog',
            'handler' => \Monolog\Handler\SyslogUdpHandler::class,
            'with' => [
                'host' => env('DATADOG_AGENT_HOST', '127.0.0.1'),
                'port' => env('DATADOG_AGENT_PORT', 10518),
            ],
            'formatter' => JsonFormatter::class,
            'processors' => [
                TraceContextProcessor::class,
            ],
        ],
    ],
];
```

### 3. Middleware Context Bootstrapping

Meng-generate `X-Request-ID` jika belum ada, lalu meletakkannya di Request object.

```php
<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

final class RequestIdMiddleware
{
    public function handle(Request $request, Closure $next): Response
    {
        $requestId = $request->header('X-Request-ID');
        if (empty($requestId)) {
            $requestId = Str::uuid()->toString();
        }

        $request->attributes->set('request_id', $requestId);

        $response = $next($request);
        
        $response->headers->set('X-Request-ID', (string) $requestId);
        
        return $response;
    }
}
```

## Anti-Patterns Kritis

#### ❌ 1. String Concatenation & Serialisasi Manual dalam Log
Menggabungkan data variabel ke dalam pesan string log menyulitkan sistem analitik untuk melakukan query (memerlukan grok/regex parsing lambat).

```php
// SALAH: Sistem terpusat (Datadog) hanya melihat teks "User 15 paid $500 for order 992". Sulit dicari.
Log::info("User {$user->id} paid \${$amount} for order {$order->id}");
```

```php
// BENAR: Structured Logging. Pesan statis, data dinamis ada di array context.
Log::info('Payment processed successfully', [
    'user_id' => $user->id,
    'amount' => $amount,
    'order_id' => $order->id,
]);
```

#### ❌ 2. Blocking HTTP API Calls untuk Logging
Menulis custom log handler yang melakukan POST via Guzzle langsung ke endpoint ElasticSearch atau CloudWatch pada thread/proses request aktif.

```php
// SALAH: Jika ElasticSearch down atau lambat, request user akan nge-hang!
$client->post('https://es.internal/logs', ['json' => $record]); 
```

```php
// BENAR: Tulis ke K8s stdout (stream) atau UDP syslog. Biarkan agen eksternal (FluentBit, Vector, Datadog Agent) yang melakukan forward HTTP secara asinkron.
```

## Production Edge Cases

1. **Context Data Serialization Failure:**
   - *Masalah:* Melemparkan model Eloquent atau objek kompleks (Closure) ke dalam context log array (`Log::info('msg', ['user' => $userModel])`). `JsonFormatter` dapat gagal atau menyebabkan recursion/memory limit exhaust jika objek bersiklus.
   - *Solusi:* Hanya kirim array asosiatif primitif atau ID. Implementasi `toArray()` yang aman jika terpaksa. Strict rules dalam CI agar tidak log objek kompleks.

2. **Disk I/O Bottleneck / Log Rotation:**
   - *Masalah:* File log membengkak cepat (`laravel.log` berukuran 50GB), menghabiskan disk inode, dan memperlambat write sistem I/O.
   - *Solusi:* Selalu log ke `stdout` di containerized environments (K8s/Docker) dan delegasikan rotasi/pengiriman log ke system driver (Docker json-file dengan max-size, FluentBit). Hindari handler `single` atau `daily` bawaan Laravel pada skala Enterprise.

3. **Exception Truncation di JSON:**
   - *Masalah:* Stack trace exception sangat panjang. Datadog atau ELK memotong payload jika melebihi UDP limit (~65KB) atau gRPC limit.
   - *Solusi:* Kustomisasi `JsonFormatter` untuk membatasi panjang stack trace atau men-drop argumen stack trace dari output log, sambil tetap mengirim message dan class exception.

## Testing Terpadu (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Infrastructure\Logging\Processors\TraceContextProcessor;
use Illuminate\Http\Request;
use Monolog\LogRecord;
use Monolog\Level;

covers(TraceContextProcessor::class);

test('trace context processor injects request headers and memory usage', function () {
    $request = Request::create('/api/checkout', 'POST');
    $request->headers->set('X-Request-ID', 'req-12345');
    $request->headers->set('traceparent', '00-abcd-efgh-01');
    $request->server->set('REMOTE_ADDR', '192.168.1.100');
    
    $processor = new TraceContextProcessor($request);
    
    // Fake Log Record for Monolog v3
    $record = new LogRecord(
        new \DateTimeImmutable(),
        'stack',
        Level::Info,
        'Test log message',
        ['event' => 'test'],
        []
    );
    
    $processedRecord = $processor($record);
    $extra = $processedRecord->extra;
    
    expect($extra)->toHaveKey('request_id', 'req-12345')
        ->and($extra)->toHaveKey('trace_id', '00-abcd-efgh-01')
        ->and($extra)->toHaveKey('ip', '192.168.1.100')
        ->and($extra)->toHaveKey('memory_usage_mb')
        ->and($extra['memory_usage_mb'])->toBeFloat();
});

test('processor handles empty request gracefully for background jobs', function () {
    $processor = new TraceContextProcessor(null);
    
    $record = new LogRecord(
        new \DateTimeImmutable(),
        'stack',
        Level::Warning,
        'Job failed',
        [],
        []
    );
    
    $processedRecord = $processor($record);
    
    expect($processedRecord->extra)->not->toHaveKey('request_id')
        ->and($processedRecord->extra)->toHaveKey('memory_usage_mb');
});
```
