# Resilience & Circuit Breaker in Laravel 11

## 1. Introduction

Dalam sistem terdistribusi dan *microservices mesh*, kegagalan jaringan, timeout, atau layanan pihak ketiga yang lambat adalah hal yang pasti terjadi. Tanpa strategi *resilience* yang tepat, kegagalan kecil pada satu layanan dapat memicu *cascading failures*, merobohkan keseluruhan sistem akibat *resource exhaustion* (misal: habisnya *worker thread* atau *database connections*).

Pola **Circuit Breaker** bertindak sebagai pemutus arus (layaknya sekring listrik). Jika terjadi kegagalan beruntun melebihi ambang batas, *circuit* akan **terbuka** (Open), menghentikan request secara langsung (*fail-fast*) tanpa mencoba mengakses layanan bermasalah, memberi waktu bagi layanan tersebut untuk pulih.

Dokumen ini membedah implementasi Circuit Breaker di Laravel 11 / PHP 8.3 dengan konsep Clean Architecture.

## 2. Core Concepts (State Machine)

Circuit Breaker memiliki 3 state utama:
1.  **Closed:** Request diteruskan ke layanan eksternal secara normal. Mengumpulkan *success* dan *failure metrics*.
2.  **Open:** Request langsung ditolak (melempar Exception khusus atau mengeksekusi Fallback) tanpa memanggil layanan eksternal. Mode ini aktif setelah ambang kegagalan (misal: 5 kegagalan berturut-turut) terlampaui.
3.  **Half-Open:** Setelah periode *cooling/timeout* tertentu berlalu dari state Open, sejumlah kecil request diizinkan mencoba koneksi ulang. Jika berhasil, state kembali ke **Closed**. Jika gagal, kembali ke **Open**.

## 3. Clean Architecture Integration

Circuit Breaker secara eksklusif adalah **Infrastructure Concern**. Domain atau Application Layer hanya perlu berurusan dengan hasil akhir atau me-nangkap `ServiceUnavailableException`.

### 3.1. Implementation via Middleware / Decorator

Kita bisa membuat decorator untuk antarmuka klien API eksternal (Adapter).

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Resilience;

use Illuminate\Support\Facades\Redis;
use Closure;
use Exception;
use Illuminate\Support\Facades\Log;

final class RedisCircuitBreaker
{
    public function __construct(
        private readonly string $serviceName,
        private readonly int $failureThreshold = 5,
        private readonly int $timeoutWindowSeconds = 60
    ) {}

    /**
     * @template T
     * @param Closure(): T $action
     * @return T
     * @throws CircuitOpenException
     * @throws Exception
     */
    public function execute(Closure $action): mixed
    {
        if ($this->isOpen()) {
            throw new CircuitOpenException("Circuit for [{$this->serviceName}] is currently OPEN.");
        }

        try {
            $result = $action();
            $this->recordSuccess();
            
            return $result;
        } catch (Exception $e) {
            $this->recordFailure();
            throw $e;
        }
    }

    private function isOpen(): bool
    {
        $isOpenKey = "circuit_breaker:{$this->serviceName}:is_open";
        if (Redis::exists($isOpenKey)) {
            // Masih dalam masa hukuman (timeoutWindowSeconds)
            return true;
        }

        // Jika tidak open, apakah di half-open / melebihi batas?
        $failures = (int) Redis::get("circuit_breaker:{$this->serviceName}:failures");
        
        if ($failures >= $this->failureThreshold) {
            // Transisi ke OPEN
            Redis::setex($isOpenKey, $this->timeoutWindowSeconds, 1);
            // Reset failure counter agar setelah timeout masuk mode half-open
            Redis::del("circuit_breaker:{$this->serviceName}:failures");
            
            Log::warning("Circuit Breaker OPEN for service: {$this->serviceName}");
            return true;
        }

        return false;
    }

    private function recordFailure(): void
    {
        $key = "circuit_breaker:{$this->serviceName}:failures";
        Redis::incr($key);
        // Expire counter periodically agar kegagalan sementara tidak menumpuk permanen
        Redis::expire($key, $this->timeoutWindowSeconds * 2);
    }

    private function recordSuccess(): void
    {
        // Reset failures if successful (transition from Half-Open to Closed)
        Redis::del("circuit_breaker:{$this->serviceName}:failures");
    }
}
```

### 3.2. Injecting Circuit Breaker to Infrastructure Adapter

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Adapters\Http;

use App\Application\Ports\Outbound\InventoryClientInterface;
use App\Infrastructure\Resilience\RedisCircuitBreaker;
use App\Infrastructure\Resilience\CircuitOpenException;
use App\Domain\Exceptions\InventoryUnavailableException;
use Illuminate\Support\Facades\Http;
use Throwable;

final class HttpInventoryClientAdapter implements InventoryClientInterface
{
    private RedisCircuitBreaker $circuitBreaker;

    public function __construct(string $baseUrl)
    {
        $this->circuitBreaker = new RedisCircuitBreaker('inventory_service', 5, 30);
    }

    public function checkStock(string $productId): int
    {
        try {
            return $this->circuitBreaker->execute(function () use ($productId) {
                $response = Http::timeout(2)
                    ->get("http://inventory-service/api/stock/{$productId}")
                    ->throw();

                return (int) $response->json('data.stock');
            });
        } catch (CircuitOpenException | Throwable $e) {
            // Translate Infrastructure exception to Domain exception
            throw new InventoryUnavailableException(
                "Unable to check stock for product {$productId}: " . $e->getMessage(),
                previous: $e
            );
        }
    }
}
```

## 4. Anti-Patterns & Best Practices

### Anti-Pattern 1: Retries Tanpa Backoff dan Circuit Breaker (Thundering Herd)

❌ **Anti-Pattern:** Menggunakan mekanisme `retry()` terus menerus secara instan ketika dependensi utama *down*.

```php
<?php
// ❌ BAD: Mencoba ulang secepat mungkin tanpa batas waktu / jeda.
// Jika layanan tujuan sedang down/berat, ini akan memperparah DDoS internal.
$response = Http::retry(10, 0)->get('http://overloaded-service/api/data');
```
*Penjelasan:* Jika layanan tujuan lambat, memberondongnya dengan puluhan *retry* seketika (disebut *thundering herd problem*) justru memastikan layanan itu mati selamanya. Server kita juga akan kehabisan *threads* karena tertahan menunggu *timeout*.

✅ **Best Practice:** Gunakan *Exponential Backoff* dengan *Jitter*, digabungkan dengan Circuit Breaker.

```php
<?php
// ✅ GOOD: Exponential backoff, dikendalikan circuit breaker
return $this->circuitBreaker->execute(function () {
    return Http::retry(3, function (int $attempt, Exception $exception) {
        // Backoff: 100ms, 200ms, 400ms ditambah random jitter
        return ($attempt * 100) + rand(10, 50); 
    })
    ->timeout(2)
    ->get('http://service/api/data')
    ->throw();
});
```

### Anti-Pattern 2: Fail Open Tanpa Fallback Strategy

❌ **Anti-Pattern:** Ketika Circuit terbuka, sistem langsung melempar Exception 500 ke User dan merusak *User Experience* sepenuhnya.

```php
<?php
// ❌ BAD: UI akan error fatal karena exception tidak ditangani.
class CheckoutController
{
    public function store(Request $request)
    {
        // Jika inventory circuit open, Exception dilempar dan layar blank 500
        $stock = $this->inventoryClient->checkStock($request->productId);
        // ...
    }
}
```
*Penjelasan:* Untuk fitur yang tidak 100% kritikal, *Graceful Degradation* jauh lebih baik daripada error total.

✅ **Best Practice:** Terapkan strategi *Fallback* di Application atau Presentation layer.

```php
<?php
// ✅ GOOD: Menangkap Exception dan memberikan Fallback logis.
namespace App\Application\UseCases;

use App\Application\Ports\Outbound\RecommendationClientInterface;
use App\Domain\Exceptions\ServiceUnavailableException;
use App\Application\DTOs\ProductDto;

class GetHomeRecommendationsUseCase
{
    public function __construct(
        private readonly RecommendationClientInterface $recommendationClient
    ) {}

    public function execute(): array
    {
        try {
            // Calling service wrapped with Circuit Breaker
            return $this->recommendationClient->getPersonalized();
        } catch (ServiceUnavailableException $e) {
            // FALLBACK STRATEGY: Graceful Degradation
            // Tampilkan fallback produk statis agar halaman tetap bisa dirender
            return ProductDto::getStaticTrendingProducts();
        }
    }
}
```

## 5. Testing with Pest v3

### 5.1. Unit Testing State Machine Circuit Breaker

Kita menguji transisi state menggunakan mocking pada fased `Redis`.

```php
<?php

declare(strict_types=1);

use App\Infrastructure\Resilience\RedisCircuitBreaker;
use App\Infrastructure\Resilience\CircuitOpenException;
use Illuminate\Support\Facades\Redis;

beforeEach(function () {
    // Clear mocks before each test
    Redis::clearResolvedInstance('redis');
});

it('executes action successfully when circuit is closed', function () {
    Redis::shouldReceive('exists')->with('circuit_breaker:test_svc:is_open')->andReturn(false);
    Redis::shouldReceive('get')->with('circuit_breaker:test_svc:failures')->andReturn(0);
    Redis::shouldReceive('del')->with('circuit_breaker:test_svc:failures')->once();

    $cb = new RedisCircuitBreaker('test_svc');
    
    $result = $cb->execute(fn() => 'success');
    
    expect($result)->toBe('success');
});

it('throws CircuitOpenException immediately when state is OPEN', function () {
    Redis::shouldReceive('exists')->with('circuit_breaker:test_svc:is_open')->andReturn(true);

    $cb = new RedisCircuitBreaker('test_svc');

    // Should NOT execute the closure
    expect(fn() => $cb->execute(function () {
        throw new \Exception("Should not be called");
    }))->toThrow(CircuitOpenException::class, 'Circuit for [test_svc] is currently OPEN.');
});

it('transitions to OPEN after threshold reached', function () {
    Redis::shouldReceive('exists')->with('circuit_breaker:test_svc:is_open')->andReturn(false);
    
    // Simulate current failures already at threshold - 1 (4)
    // Then exception is thrown, adding 1 to failures making it 5
    // Wait, the logic in our class increments AFTER exception.
    // The logic in isOpen() checks before execution. 
    Redis::shouldReceive('get')->with('circuit_breaker:test_svc:failures')->andReturn(5);
    
    // It should trip the breaker and set open key
    Redis::shouldReceive('setex')->with('circuit_breaker:test_svc:is_open', 60, 1)->once();
    Redis::shouldReceive('del')->with('circuit_breaker:test_svc:failures')->once();

    $cb = new RedisCircuitBreaker('test_svc', 5, 60);

    // Call execute, it should see failures = 5, transition to OPEN, and throw
    expect(fn() => $cb->execute(fn() => 'wont run'))
        ->toThrow(CircuitOpenException::class);
});
```

### 5.2. Architecture Testing

Pastikan Domain murni dan tidak peduli dengan Resilience.

```php
<?php

declare(strict_types=1);

test('Domain layer does not depend on Infrastructure Resilience', function () {
    expect('App\Domain')
        ->not->toUse('App\Infrastructure\Resilience')
        ->not->toUse('App\Infrastructure\Resilience\CircuitOpenException')
        ->because('Domain entities must not know about network resiliency mechanics.');
});
```
