# Prometheus & Grafana Metrics (OpenTelemetry / Octane)

Dokumen ini membedah arsitektur dan implementasi high-performance metrik bisnis dan operasional di Laravel Enterprise menggunakan Prometheus, Grafana, OpenTelemetry, dan Laravel Octane.

## Arsitektur Pemrosesan Metrik

```ascii
[Client Request] ---> [Nginx/ALB] ---> [Laravel Octane (Swoole/FrankenPHP)]
                                               |
                                               v
                                     [Prometheus Middleware]
                                     - Increment HTTP Requests Counter
                                     - Observe Request Duration Histogram
                                               |
                                               v
                                       [Business Logic]
                                       - Checkout Failed Counter
                                       - Active Tenants Gauge
                                               |
                                               v
                             [Swoole/Octane Shared Memory (Table)]
                             (Zero-overhead metric aggregation)
                                               |
                                               v
[Prometheus Scraper] <--- [GET /metrics] <-----/
(Scrapes every 15s)       (Prometheus Exporter Controller)
                                               |
                                               v
                                          [Grafana]
                                          (Dashboards & Alerts)
```

## Spesifikasi Teknis

### 1. Prometheus Registry & Octane Shared Memory

Implementasi ini menggunakan Swoole Table melalui Laravel Octane cache driver atau implementasi khusus untuk menghindari I/O blocking (Redis/DB) saat mencatat metrik per request.

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Metrics;

use Prometheus\CollectorRegistry;
use Prometheus\RenderTextFormat;
use Prometheus\Storage\Adapter;
use Prometheus\Storage\APC;
use Prometheus\Storage\InMemory;
use Illuminate\Support\ServiceProvider;

final class PrometheusServiceProvider extends ServiceProvider
{
    /**
     * Register services.
     */
    public function register(): void
    {
        $this->app->singleton(Adapter::class, function (): Adapter {
            // Menggunakan APCu untuk shared memory performa tinggi di Octane/FPM
            // Alternatif: Redis untuk distributed setup jika tidak menggunakan Octane
            return extension_loaded('apcu') && ini_get('apc.enabled')
                ? new APC()
                : new InMemory();
        });

        $this->app->singleton(CollectorRegistry::class, function ($app): CollectorRegistry {
            return new CollectorRegistry($app->make(Adapter::class));
        });
    }
}
```

### 2. Prometheus Middleware (HTTP Metrics)

Mencatat latensi dan jumlah request tanpa memblokir response, memanfaatkan `terminate` method.

```php
<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Prometheus\CollectorRegistry;
use Symfony\Component\HttpFoundation\Response;

final readonly class PrometheusMetricsMiddleware
{
    public function __construct(
        private CollectorRegistry $registry,
    ) {}

    /**
     * Handle an incoming request.
     *
     * @param  \Closure(\Illuminate\Http\Request): (\Symfony\Component\HttpFoundation\Response)  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        // Define route name safely
        $route = $request->route();
        $routeName = $route !== null ? (is_string($route->getName()) ? $route->getName() : 'unnamed_route') : 'not_found';
        $request->attributes->set('metrics_route_name', $routeName);
        $request->attributes->set('metrics_start_time', microtime(true));

        return $next($request);
    }

    /**
     * Handle tasks after the response has been sent to the browser.
     */
    public function terminate(Request $request, Response $response): void
    {
        $startTime = $request->attributes->get('metrics_start_time');
        if (!is_float($startTime)) {
            return;
        }

        $duration = microtime(true) - $startTime;
        $routeName = (string) $request->attributes->get('metrics_route_name', 'unknown');
        $method = $request->getMethod();
        $statusCode = (string) $response->getStatusCode();

        $counter = $this->registry->getOrRegisterCounter(
            'laravel_app',
            'http_requests_total',
            'Total HTTP requests',
            ['method', 'route', 'status']
        );
        $counter->inc([$method, $routeName, $statusCode]);

        $histogram = $this->registry->getOrRegisterHistogram(
            'laravel_app',
            'http_request_duration_seconds',
            'HTTP request duration in seconds',
            ['method', 'route', 'status'],
            [0.1, 0.2, 0.5, 1.0, 2.0, 5.0]
        );
        $histogram->observe($duration, [$method, $routeName, $statusCode]);
    }
}
```

### 3. Business Metrics Recorder

Pencatatan metrik bisnis (misalnya failed checkout, queue processing).

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Metrics;

use Prometheus\CollectorRegistry;

final readonly class BusinessMetrics
{
    public function __construct(
        private CollectorRegistry $registry,
    ) {}

    public function incrementFailedCheckout(string $reason, string $tenantId): void
    {
        $counter = $this->registry->getOrRegisterCounter(
            'laravel_app',
            'checkout_failures_total',
            'Total number of failed checkouts',
            ['reason', 'tenant_id']
        );
        
        $counter->inc([$reason, $tenantId]);
    }

    public function observeQueueLatency(string $queueName, float $latencySeconds): void
    {
        $histogram = $this->registry->getOrRegisterHistogram(
            'laravel_app',
            'queue_processing_latency_seconds',
            'Latency of queue jobs',
            ['queue'],
            [0.05, 0.1, 0.5, 1.0, 5.0, 10.0, 30.0]
        );
        
        $histogram->observe($latencySeconds, [$queueName]);
    }
}
```

### 4. Controller Exporter (Endpoint `/metrics`)

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use Illuminate\Http\Response;
use Prometheus\CollectorRegistry;
use Prometheus\RenderTextFormat;

final readonly class MetricsController
{
    public function __construct(
        private CollectorRegistry $registry,
    ) {}

    public function __invoke(): Response
    {
        $renderer = new RenderTextFormat();
        $result = $renderer->render($this->registry->getMetricFamilySamples());

        return new Response($result, 200, [
            'Content-Type' => RenderTextFormat::MIME_TYPE,
        ]);
    }
}
```

## Anti-Patterns & Edge Cases

### Anti-Patterns Kritis

#### ❌ 1. High Cardinality Labels
Mencatat ID user atau request ID sebagai label. Ini akan meledakkan memori Prometheus (TSDB) karena setiap ID unik membuat time series baru.

```php
// SALAH: Label 'user_id' akan membuat jutaan time series
$counter->inc([$request->route()->getName(), $request->user()->id]);
```

```php
// BENAR: Gunakan dimensi yang terbatas (low cardinality) seperti role, status, route
$counter->inc([$request->route()->getName(), $request->user()->role->name]);
```

#### ❌ 2. DB/Network Call Synchronous Saat Pencatatan Metrik
Menulis metrik langsung ke database (MySQL) atau memanggil API Datadog secara sinkron pada setiap request.

```php
// SALAH: Membuat query DB tambahan per request
DB::table('metrics')->insert(['name' => 'page_view', 'count' => 1]);
```

```php
// BENAR: Gunakan in-memory storage (APCu/Swoole Table) yang discrape oleh Prometheus
$this->registry->getOrRegisterCounter('app', 'page_view', '')->inc();
```

### Production Edge Cases

1. **Octane Worker Memory Leak / OOM:**
   - *Masalah:* Memory penyimpanan array lokal (`InMemory`) pada setiap worker berbeda-beda dan terisolasi, menyebabkan metrik tereset jika worker direstart atau metrik tidak akurat (hanya mewakili satu worker saat discrape).
   - *Solusi:* Wajib menggunakan APCu, Redis, atau Swoole Table untuk menyimpan state metrik secara atomic yang dapat diakses oleh semua worker dan endpoint `/metrics`.

2. **Scrape Timeout dari Prometheus Server:**
   - *Masalah:* Proses pengumpulan metrik dari APCu memakan waktu terlalu lama (misal karena jutaan metrics dengan cardinality bocor), menyebabkan Prometheus memberikan status `context deadline exceeded`.
   - *Solusi:* Set `max_execution_time` yang wajar di endpoint `/metrics`, monitor ukuran APCu, dan set alert jika time series > 10.000.

3. **Inconsistent Label Cardinality Registration:**
   - *Masalah:* Mendaftarkan counter dengan label `['route']` di awal, namun later on dipanggil dengan increment `['route', 'status']`. Library akan melempar exception fatal yang dapat menjatuhkan aplikasi.
   - *Solusi:* Definisikan dan bungkus semua registrasi metrik dalam kelas infrastruktur (`BusinessMetrics`) dengan type-hinting kuat pada array parameter label.

## Testing Terpadu (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Http\Middleware\PrometheusMetricsMiddleware;
use App\Infrastructure\Metrics\BusinessMetrics;
use Illuminate\Http\Request;
use Prometheus\CollectorRegistry;
use Prometheus\Storage\InMemory;
use Symfony\Component\HttpFoundation\Response;

covers(PrometheusMetricsMiddleware::class);
covers(BusinessMetrics::class);

test('middleware records http metrics correctly', function () {
    $registry = new CollectorRegistry(new InMemory());
    $middleware = new PrometheusMetricsMiddleware($registry);
    
    $request = Request::create('/test-route', 'GET');
    $request->attributes->set('metrics_route_name', 'test.route');
    $request->attributes->set('metrics_start_time', microtime(true) - 0.5); // 500ms delay
    
    $response = new Response('', 200);
    
    $middleware->terminate($request, $response);
    
    $metrics = $registry->getMetricFamilySamples();
    
    $counters = array_filter($metrics, fn ($m) => $m->getName() === 'laravel_app_http_requests_total');
    expect($counters)->toHaveCount(1);
    
    $samples = reset($counters)->getSamples();
    expect($samples[0]->getLabelValues())->toBe(['GET', 'test.route', '200'])
        ->and($samples[0]->getValue())->toBe(1.0);
});

test('business metrics increments checkout failures accurately', function () {
    $registry = new CollectorRegistry(new InMemory());
    $businessMetrics = new BusinessMetrics($registry);
    
    $businessMetrics->incrementFailedCheckout('payment_declined', 'tenant-a');
    $businessMetrics->incrementFailedCheckout('payment_declined', 'tenant-a');
    
    $samples = $registry->getMetricFamilySamples()[0]->getSamples();
    
    expect($samples[0]->getLabelValues())->toBe(['payment_declined', 'tenant-a'])
        ->and($samples[0]->getValue())->toBe(2.0);
});
```
