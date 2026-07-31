# Distributed Tracing with OpenTelemetry in Laravel 11

## 1. Introduction

Dalam arsitektur microservices, melacak request yang mengalir melalui berbagai layanan (HTTP, gRPC, Queue, Database) adalah hal yang krusial untuk observabilitas dan debugging. OpenTelemetry (OTel) menyediakan standar industri untuk mengumpulkan traces, metrics, dan logs.

Dokumen ini menjelaskan implementasi OpenTelemetry yang *production-ready* pada Laravel 11 dengan PHP 8.3/8.4, mematuhi prinsip Clean Architecture, dan berfokus pada Distributed Tracing.

## 2. Core Concepts

*   **Trace:** Representasi dari sebuah request utuh dari awal hingga akhir, melintasi berbagai layanan.
*   **Span:** Unit kerja individual di dalam sebuah Trace (misalnya: query database tunggal, request HTTP ke layanan eksternal).
*   **Context Propagation:** Mekanisme untuk meneruskan Trace ID dan Span ID melintasi batas layanan (contoh: via HTTP headers `traceparent`).
*   **Exporter:** Komponen yang mengirimkan data trace ke backend (Jaeger, Zipkin, Datadog, Prometheus).

## 3. Clean Architecture Integration

Dalam Clean Architecture, tracing adalah *Cross-Cutting Concern* atau infrastruktur. Domain layer **tidak boleh** tahu tentang OpenTelemetry. Application layer mendefinisikan *interface* (port) untuk observabilitas jika diperlukan secara eksplisit, tetapi seringkali tracing diimplementasikan via middleware, interceptors, atau event listeners di Infrastructure/Presentation layer.

### 3.1. Application Layer (Port)

Kita mendefinisikan interface yang agnostik terhadap OTel agar Application/Domain layer bisa membuat kustom span jika dibutuhkan.

```php
<?php

declare(strict_types=1);

namespace App\Application\Ports\Observability;

use Closure;

interface TracerInterface
{
    /**
     * Executes the given closure within a new traced span.
     *
     * @template T
     * @param string $name
     * @param array<string, string|int|float|bool> $attributes
     * @param Closure(): T $action
     * @return T
     */
    public function trace(string $name, array $attributes, Closure $action): mixed;
    
    /**
     * Adds an event to the current active span.
     *
     * @param string $name
     * @param array<string, string|int|float|bool> $attributes
     * @return void
     */
    public function recordEvent(string $name, array $attributes = []): void;
    
    /**
     * Records an exception to the current active span.
     *
     * @param \Throwable $exception
     * @return void
     */
    public function recordException(\Throwable $exception): void;
}
```

### 3.2. Infrastructure Layer (Adapter)

Implementasi menggunakan OpenTelemetry PHP SDK.

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Observability;

use App\Application\Ports\Observability\TracerInterface;
use Closure;
use OpenTelemetry\API\Trace\TracerInterface as OTelTracerInterface;
use OpenTelemetry\API\Trace\Span;
use OpenTelemetry\API\Trace\StatusCode;
use OpenTelemetry\Context\Context;

final readonly class OpenTelemetryTracerAdapter implements TracerInterface
{
    public function __construct(
        private OTelTracerInterface $otelTracer
    ) {}

    /**
     * @template T
     * @param string $name
     * @param array<string, string|int|float|bool> $attributes
     * @param Closure(): T $action
     * @return T
     * @throws \Throwable
     */
    public function trace(string $name, array $attributes, Closure $action): mixed
    {
        $span = $this->otelTracer->spanBuilder($name)->startSpan();
        
        foreach ($attributes as $key => $value) {
            $span->setAttribute($key, $value);
        }

        $scope = $span->activate();

        try {
            $result = $action();
            $span->setStatus(StatusCode::STATUS_OK);
            return $result;
        } catch (\Throwable $exception) {
            $span->recordException($exception);
            $span->setStatus(StatusCode::STATUS_ERROR, $exception->getMessage());
            throw $exception;
        } finally {
            $span->end();
            $scope->detach();
        }
    }

    public function recordEvent(string $name, array $attributes = []): void
    {
        $span = Span::getCurrent();
        $span->addEvent($name, $attributes);
    }

    public function recordException(\Throwable $exception): void
    {
        $span = Span::getCurrent();
        $span->recordException($exception);
        $span->setStatus(StatusCode::STATUS_ERROR, $exception->getMessage());
    }
}
```

### 3.3. Presentation Layer (Middleware)

Untuk HTTP masuk, kita mencegat request dan mengekstrak context (Trace Context Propagation).

```php
<?php

declare(strict_types=1);

namespace App\Presentation\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use OpenTelemetry\API\Trace\TracerInterface;
use OpenTelemetry\Context\Context;
use OpenTelemetry\API\Trace\Propagation\TraceContextPropagator;

final class OpenTelemetryMiddleware
{
    public function __construct(
        private readonly TracerInterface $tracer
    ) {}

    /**
     * Handle an incoming request.
     *
     * @param  \Closure(\Illuminate\Http\Request): (\Symfony\Component\HttpFoundation\Response)  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        // Extract trace context from HTTP headers
        $parentContext = TraceContextPropagator::getInstance()->extract($request->headers->all());
        
        $span = $this->tracer
            ->spanBuilder(sprintf('%s %s', $request->method(), $request->path()))
            ->setParent($parentContext)
            ->setAttribute('http.method', $request->method())
            ->setAttribute('http.url', $request->fullUrl())
            ->startSpan();

        $scope = $span->activate();

        try {
            /** @var Response $response */
            $response = $next($request);
            
            $span->setAttribute('http.status_code', $response->getStatusCode());
            if ($response->getStatusCode() >= 500) {
                $span->setStatus(\OpenTelemetry\API\Trace\StatusCode::STATUS_ERROR);
            }
            
            return $response;
        } catch (\Throwable $e) {
            $span->recordException($e);
            $span->setStatus(\OpenTelemetry\API\Trace\StatusCode::STATUS_ERROR);
            throw $e;
        } finally {
            $span->end();
            $scope->detach();
        }
    }
}
```

## 4. Anti-Patterns & Best Practices

### Anti-Pattern 1: Menyebarkan OpenTelemetry API ke Seluruh Domain

❌ **Anti-Pattern:** Menggunakan fungsi global atau SDK spesifik di dalam Service atau Entity Domain.

```php
<?php
// ❌ BAD: Domain Service terikat kuat dengan OpenTelemetry SDK
namespace App\Domain\Services;

use OpenTelemetry\API\Trace\Span; // LEAK!

class ProcessOrderService
{
    public function execute(Order $order): void
    {
        $span = \OpenTelemetry\API\Globals::tracerProvider()
            ->getTracer('domain')
            ->spanBuilder('ProcessOrder')
            ->startSpan();
        
        try {
            // business logic
        } finally {
            $span->end();
        }
    }
}
```
*Penjelasan:* Ini melanggar Dependency Inversion Principle. Domain layer tidak boleh mengetahui detail infrastruktur seperti OpenTelemetry. Jika kita beralih ke library lain atau menonaktifkan tracing, kita harus mengubah domain.

✅ **Best Practice:** Menggunakan port/interface dari Application Layer atau menggunakan pendekatan Aspect-Oriented/Decorator.

```php
<?php
// ✅ GOOD: Menggunakan interface TracerInterface yang agnostik
namespace App\Application\UseCases;

use App\Application\Ports\Observability\TracerInterface;

class ProcessOrderUseCase
{
    public function __construct(
        private readonly OrderRepositoryInterface $repository,
        private readonly TracerInterface $tracer
    ) {}

    public function execute(OrderDto $dto): void
    {
        $this->tracer->trace('ProcessOrder', ['order.id' => $dto->id], function() use ($dto) {
            // pure business logic here, decoupled from OTel SDK
            $order = Order::create($dto);
            $this->repository->save($order);
        });
    }
}
```

### Anti-Pattern 2: Hardcoding Custom Headers untuk Context Propagation

❌ **Anti-Pattern:** Membuat nama header sendiri untuk melacak ID melintasi service (misal: `X-My-Correlation-Id`).

```php
<?php
// ❌ BAD: Custom header tidak standar
$response = Http::withHeaders([
    'X-My-Correlation-Id' => $currentTraceId
])->post('http://microservice-b/api/data');
```
*Penjelasan:* Ini tidak interoperable dengan sistem monitoring standar (seperti Datadog, Jaeger, AWS X-Ray) dan akan memutus distributed trace jika melewati service pihak ketiga (seperti API Gateway, Service Mesh) yang hanya mengenali standar W3C.

✅ **Best Practice:** Menggunakan `TraceContextPropagator` dari OpenTelemetry yang mengikuti standar W3C Trace Context (`traceparent` header).

```php
<?php
// ✅ GOOD: Menginjeksi context W3C Trace Context secara standar
namespace App\Infrastructure\Http;

use Illuminate\Support\Facades\Http;
use OpenTelemetry\API\Trace\Propagation\TraceContextPropagator;

class ExternalServiceClient
{
    public function sendData(array $payload): void
    {
        $headers = [];
        TraceContextPropagator::getInstance()->inject($headers);
        
        // $headers sekarang berisi ['traceparent' => '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01']
        Http::withHeaders($headers)->post('http://microservice-b/api/data', $payload);
    }
}
```

## 5. Testing with Pest v3

Dalam arsitektur bersih, kita perlu menguji adapter infrastruktur dan memastikan domain kita tetap independen (Architecture Testing).

### 5.1. Unit Testing Tracer Adapter

Kita menggunakan Mockery untuk memastikan SDK OpenTelemetry dipanggil dengan benar.

```php
<?php

declare(strict_types=1);

use App\Infrastructure\Observability\OpenTelemetryTracerAdapter;
use OpenTelemetry\API\Trace\TracerInterface as OTelTracer;
use OpenTelemetry\API\Trace\SpanBuilderInterface;
use OpenTelemetry\API\Trace\SpanInterface;
use OpenTelemetry\Context\ScopeInterface;

it('traces execution and records successful span', function () {
    // Arrange
    $otelTracerMock = Mockery::mock(OTelTracer::class);
    $spanBuilderMock = Mockery::mock(SpanBuilderInterface::class);
    $spanMock = Mockery::mock(SpanInterface::class);
    $scopeMock = Mockery::mock(ScopeInterface::class);

    $otelTracerMock->shouldReceive('spanBuilder')
        ->with('test_span')
        ->once()
        ->andReturn($spanBuilderMock);

    $spanBuilderMock->shouldReceive('startSpan')
        ->once()
        ->andReturn($spanMock);

    $spanMock->shouldReceive('setAttribute')
        ->with('key', 'value')
        ->once();

    $spanMock->shouldReceive('activate')
        ->once()
        ->andReturn($scopeMock);

    $spanMock->shouldReceive('setStatus')
        ->with(\OpenTelemetry\API\Trace\StatusCode::STATUS_OK)
        ->once();

    $spanMock->shouldReceive('end')->once();
    $scopeMock->shouldReceive('detach')->once();

    $adapter = new OpenTelemetryTracerAdapter($otelTracerMock);

    // Act
    $result = $adapter->trace('test_span', ['key' => 'value'], function () {
        return 'success';
    });

    // Assert
    expect($result)->toBe('success');
});

it('records exception and sets error status on failure', function () {
    // Setup mocks similarly...
    $otelTracerMock = Mockery::mock(OTelTracer::class);
    $spanBuilderMock = Mockery::mock(SpanBuilderInterface::class);
    $spanMock = Mockery::mock(SpanInterface::class);
    $scopeMock = Mockery::mock(ScopeInterface::class);
    
    $otelTracerMock->shouldReceive('spanBuilder')->andReturn($spanBuilderMock);
    $spanBuilderMock->shouldReceive('startSpan')->andReturn($spanMock);
    $spanMock->shouldReceive('setAttribute')->byDefault();
    $spanMock->shouldReceive('activate')->andReturn($scopeMock);
    
    $exception = new \RuntimeException('Test error');
    
    $spanMock->shouldReceive('recordException')->with($exception)->once();
    $spanMock->shouldReceive('setStatus')
        ->with(\OpenTelemetry\API\Trace\StatusCode::STATUS_ERROR, 'Test error')
        ->once();
        
    $spanMock->shouldReceive('end')->once();
    $scopeMock->shouldReceive('detach')->once();

    $adapter = new OpenTelemetryTracerAdapter($otelTracerMock);

    // Act & Assert
    expect(fn() => $adapter->trace('failing_span', [], function () use ($exception) {
        throw $exception;
    }))->toThrow(\RuntimeException::class, 'Test error');
});
```

### 5.2. Architecture Testing

Memastikan Domain Layer tidak memiliki dependency ke OpenTelemetry atau Infrastructure namespace.

```php
<?php

declare(strict_types=1);

use PHPUnit\Architecture\ArchitectureAsserts;

test('Domain layer does not depend on OpenTelemetry SDK', function () {
    expect('App\Domain')
        ->not->toUse('OpenTelemetry')
        ->because('Domain layer must remain agnostic of observability implementations.');
});

test('Domain layer does not depend on Infrastructure layer', function () {
    expect('App\Domain')
        ->not->toUse('App\Infrastructure')
        ->because('Clean Architecture rule: Dependencies must point inwards.');
});

test('Application ports are independent of implementations', function () {
    expect('App\Application\Ports')
        ->not->toUse('OpenTelemetry')
        ->not->toUse('Illuminate')
        ->because('Ports must not leak infrastructure details.');
});
```
