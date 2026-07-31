# 📈 Laravel Pulse: Enterprise Monitoring & Telemetry

**Domain**: Ecosystem Extended
**Status**: Top 1% Mastery Level (PHP 8.3+ / Laravel 11+)

## 1. Architectural Overview & The Role of Pulse

Laravel Pulse is a highly extensible health and performance monitoring dashboard, designed to provide a high-level overview of an application's vital statistics. In a clean architecture, telemetry and monitoring are considered external infrastructure concerns. Your core business logic should not be coupled directly to Pulse; instead, observability should be achieved via events, middleware, and dedicated recorder services.

Pulse operates primarily through:
- **Recorders**: Components that hook into Laravel's event system or execute polling loops to ingest metrics.
- **Storage/Ingest Pipeline**: Where metrics are temporarily buffered (typically Redis) before being aggregated and flushed to a persistent relational database.
- **Dashboard/Cards**: The frontend Livewire components that query aggregated data for presentation.

### Ingestion Strategy for High-Traffic Apps

In a high-traffic environment, synchronous ingestion directly to MySQL/PostgreSQL will cause significant I/O bottlenecks.

**Best Practice**: Use Redis as the ingestion engine.

```php
// config/pulse.php (Snippet)
return [
    // ...
    'ingest' => [
        'driver' => env('PULSE_INGEST_DRIVER', 'redis'), // Use redis for high-traffic
        'buffer' => env('PULSE_INGEST_BUFFER', 5000),    // Buffer size before background sync
        'trim' => [
            'keep' => '7 days', // Aggressive retention for telemetry data
        ],
    ],
];
```

## 2. Advanced Custom Pulse Recorders (Clean Architecture)

Let's build a custom recorder to monitor the usage of specific external API endpoints (e.g., measuring external dependency latency).

### The Recorder Contract and Implementation

```php
<?php

declare(strict_types=1);

namespace Infrastructure\Monitoring\Pulse\Recorders;

use Illuminate\Support\Facades\Event;
use Laravel\Pulse\Pulse;
use Laravel\Pulse\Recorders\Concerns\Ignores;
use Illuminate\Http\Client\Events\ResponseReceived;
use Illuminate\Http\Client\Events\ConnectionFailed;
use Carbon\CarbonImmutable;

final readonly class ExternalApiLatencyRecorder
{
    use Ignores;

    public function __construct(
        private Pulse $pulse,
    ) {}

    /**
     * Register the events to listen to.
     */
    public function register(callable $record, array $config): void
    {
        // Listen to Laravel's native HTTP Client events
        Event::listen([
            ResponseReceived::class,
            ConnectionFailed::class,
        ], function (ResponseReceived|ConnectionFailed $event) use ($record, $config) {
            $record($event);
        });
    }

    /**
     * Record the actual event data.
     */
    public function record(ResponseReceived|ConnectionFailed $event): void
    {
        $request = $event->request;
        $url = $request->url();
        $host = parse_url($url, PHP_URL_HOST) ?? 'unknown-host';

        if ($this->shouldIgnore($host)) {
            return;
        }

        if ($event instanceof ConnectionFailed) {
             $this->pulse->record(
                type: 'api_outage',
                key: $host,
                value: 1, // Count 1 failure
                timestamp: CarbonImmutable::now(),
            )->max()->count();
            return;
        }

        $duration = $event->response->handlerStats()['total_time_us'] ?? 0;
        $durationMs = (int) ($duration / 1000);

        // Record the latency for the host
        $this->pulse->record(
            type: 'api_latency',
            key: $host,
            value: $durationMs,
            timestamp: CarbonImmutable::now(),
        )->average()->max();
    }
}
```

### Registering the Recorder

```php
<?php

declare(strict_types=1);

namespace Infrastructure\Monitoring\Providers;

use Illuminate\Support\ServiceProvider;
use Infrastructure\Monitoring\Pulse\Recorders\ExternalApiLatencyRecorder;
use Illuminate\Contracts\Foundation\Application;

final class MonitoringServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(ExternalApiLatencyRecorder::class, function (Application $app) {
            return new ExternalApiLatencyRecorder(
                $app->make('pulse')
            );
        });
    }
}
```

---

## 3. Anti-Patterns & Best Practices

### ❌ Anti-Pattern 1: Synchronous Ingestion in High-Traffic Scenarios

**The Bad Code:**
```php
<?php

declare(strict_types=1);

namespace Infrastructure\Monitoring;

use Laravel\Pulse\Facades\Pulse;
use Illuminate\Support\Facades\Log;

final class CheckoutMonitor
{
    public function recordCheckoutAttempt(int $userId): void
    {
        // ❌ BAD: By default, if the ingest driver is 'database', this performs
        // a blocking SQL INSERT/UPDATE on every checkout attempt directly in the web request.
        // It increases response time and causes DB lock contention under heavy load.
        Pulse::record('checkout_attempt', (string)$userId, 1)->count();
    }
}
```

**✅ The Good Code (Deferred Ingestion & Redis):**
```php
<?php

declare(strict_types=1);

namespace Infrastructure\Monitoring;

use Laravel\Pulse\Facades\Pulse;

final readonly class CheckoutMonitor
{
    public function recordCheckoutAttempt(int $userId): void
    {
        // ✅ GOOD: Ensure config/pulse.php uses 'redis' as ingest driver.
        // Furthermore, leverage `Pulse::defer()` if you are doing any heavy calculation
        // before recording, ensuring the closure runs AFTER the HTTP response is sent.
        Pulse::defer(static function () use ($userId): void {
            Pulse::record(
                type: 'checkout_attempt',
                key: (string)$userId,
                value: 1,
            )->count();
        });
    }
}
```

**Detailed Explanation (Performance & Infrastructure Risk):**
When Pulse records an entry, it uses the configured `ingest` driver. Using a relational database for high-frequency telemetry data during the request lifecycle introduces massive latency. The `redis` driver buffers these metrics in memory. A background artisan command (`pulse:work`) periodically batches and flushes this buffer to the relational database, vastly reducing write load on the main DB and ensuring zero-impact telemetry on user requests. 

### ❌ Anti-Pattern 2: PII Data Leakage into Pulse Telemetry

**The Bad Code:**
```php
<?php

declare(strict_types=1);

namespace Infrastructure\Monitoring\Pulse\Recorders;

use Illuminate\Database\Events\QueryExecuted;
use Laravel\Pulse\Facades\Pulse;

final class UserSearchRecorder
{
    public function record(QueryExecuted $event): void
    {
        // ❌ BAD: Recording raw SQL bindings or user input strings into Pulse.
        // This stores Personally Identifiable Information (PII) like emails or SSNs
        // in plaintext in the Pulse metric tables, violating GDPR/CCPA.
        if (str_contains($event->sql, 'users')) {
             Pulse::record('user_search', json_encode($event->bindings), 1)->count();
        }
    }
}
```

**✅ The Good Code (Data Sanitization & Aggregation):**
```php
<?php

declare(strict_types=1);

namespace Infrastructure\Monitoring\Pulse\Recorders;

use Illuminate\Database\Events\QueryExecuted;
use Laravel\Pulse\Facades\Pulse;

final readonly class UserSearchRecorder
{
    public function record(QueryExecuted $event): void
    {
        if (str_contains($event->sql, 'users') === false) {
            return;
        }

        // ✅ GOOD: Record the action category or a hashed identifier, NEVER raw PII.
        // We only care about the volume and performance of user searches, not the exact terms.
        Pulse::defer(static function () use ($event): void {
             Pulse::record(
                type: 'database_query_heavy',
                key: 'user_search_operation', // Generic key for grouping
                value: (int)$event->time, // Log query execution time instead of user data
             )->average();
        });
    }
}
```

**Detailed Explanation (Security & Compliance Risk):**
Telemetry systems should only record aggregated, anonymous metrics. Storing `$event->bindings` means user passwords (if not hashed yet in a specific flow), emails, or personal addresses are saved into the `pulse_entries` table. This creates a massive security vulnerability where developers with access to the Pulse dashboard or database can view sensitive data. Always sanitize and aggregate telemetry data at the source.

### ❌ Anti-Pattern 3: State Mutation and Memory Leaks in Recorders (Octane Context)

**The Bad Code:**
```php
<?php

declare(strict_types=1);

namespace Infrastructure\Monitoring\Pulse\Recorders;

use Laravel\Pulse\Pulse;
use Illuminate\Http\Client\Events\ResponseReceived;

final class StatefulApiRecorder
{
    // ❌ BAD: Mutable array accumulating state across requests
    private array $recordedHosts = [];

    public function __construct(private Pulse $pulse) {}

    public function record(ResponseReceived $event): void
    {
        $host = parse_url($event->request->url(), PHP_URL_HOST);
        
        $this->recordedHosts[] = $host; // MEMORY LEAK in Laravel Octane!

        $this->pulse->record('api_latency', $host, 100);
    }
}
```

**✅ The Good Code (Stateless, Read-only Recorders):**
```php
<?php

declare(strict_types=1);

namespace Infrastructure\Monitoring\Pulse\Recorders;

use Laravel\Pulse\Pulse;
use Illuminate\Http\Client\Events\ResponseReceived;

final readonly class StatefulApiRecorder
{
    // ✅ GOOD: Final, readonly class. No mutable state accumulated.
    public function __construct(private Pulse $pulse) {}

    public function record(ResponseReceived $event): void
    {
        $host = parse_url($event->request->url(), PHP_URL_HOST);
        
        if ($host === null) {
            return;
        }

        $this->pulse->record('api_latency', $host, 100);
    }
}
```

**Detailed Explanation (Memory & Octane Risk):**
Laravel Octane keeps the application booted in memory across requests. If a Pulse recorder (registered as a singleton) stores state (like appending to an array), that array will grow indefinitely with every request until the PHP worker runs out of memory and crashes. Pulse recorders MUST be strictly stateless.

---

## 4. Pulse Security & Authorization

By default, Pulse is only available in the `local` environment. To enable it in production, you MUST implement robust authorization via a Gate.

```php
<?php

declare(strict_types=1);

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use Illuminate\Support\Facades\Gate;
use Domain\Users\Models\User;

final class PulseServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        Gate::define('viewPulse', static function (User $user): bool {
            // Strictly limit to specific Admin emails or roles
            return in_array($user->email, [
                'sysadmin@enterprise.com',
                'sre@enterprise.com',
            ], true) && $user->hasRole('SuperAdmin');
        });
    }
}
```

---

## 5. Comprehensive Unit & Architecture Testing (Pest v3)

Testing Pulse recorders involves ensuring that the recorder properly hooks into events and calls the Pulse facade/service correctly.

```php
<?php

declare(strict_types=1);

namespace Tests\Unit\Infrastructure\Monitoring;

use Infrastructure\Monitoring\Pulse\Recorders\ExternalApiLatencyRecorder;
use Illuminate\Http\Client\Events\ResponseReceived;
use Illuminate\Http\Client\Request;
use Illuminate\Http\Client\Response;
use GuzzleHttp\Psr7\Request as PsrRequest;
use GuzzleHttp\Psr7\Response as PsrResponse;
use Laravel\Pulse\Pulse;
use Mockery;
use Laravel\Pulse\Entry;
use Carbon\CarbonImmutable;

uses()->group('monitoring', 'pulse');

it('records api latency correctly when a response is received', function () {
    // 1. Arrange
    $pulseMock = Mockery::mock(Pulse::class);
    
    // The entry mock to handle the chained ->average()->max() calls
    $entryMock = Mockery::mock(Entry::class);
    $entryMock->shouldReceive('average')->once()->andReturnSelf();
    $entryMock->shouldReceive('max')->once()->andReturnSelf();
    
    $pulseMock->shouldReceive('record')
        ->once()
        ->withArgs(function (string $type, string $key, int $value, CarbonImmutable $timestamp) {
            return $type === 'api_latency' 
                && $key === 'api.stripe.com'
                && $value === 150; // 150000 us = 150 ms
        })
        ->andReturn($entryMock);

    $recorder = new ExternalApiLatencyRecorder($pulseMock);
    
    $psrRequest = new PsrRequest('GET', 'https://api.stripe.com/v1/charges');
    $psrResponse = new PsrResponse(200);
    
    $request = new Request($psrRequest);
    $response = new Response($psrResponse);
    // Inject handler stats to simulate Guzzle's transfer stats
    $response->handlerStats = ['total_time_us' => 150000];

    $event = new ResponseReceived($request, $response);

    // 2. Act
    $recorder->record($event);
});

it('ignores specified hosts in the ignore list', function () {
    // 1. Arrange
    $pulseMock = Mockery::mock(Pulse::class);
    $pulseMock->shouldReceive('record')->never(); // Should not be called

    $recorder = new ExternalApiLatencyRecorder($pulseMock);
    
    // Inject the config to ignore 'analytics.local'
    $recorder->setIgnore(['analytics.local']);

    $psrRequest = new PsrRequest('GET', 'https://analytics.local/track');
    $request = new Request($psrRequest);
    $event = new ResponseReceived($request, new Response(new PsrResponse()));

    // 2. Act
    $recorder->record($event);
});
```

### Architectural Tests for Monitoring Infrastructure

Ensure our Monitoring layer adheres to clean architecture principles.

```php
<?php

declare(strict_types=1);

namespace Tests\Architecture;

uses()->group('architecture', 'monitoring');

test('Pulse recorders are final and read-only')
    ->expect('Infrastructure\Monitoring\Pulse\Recorders')
    ->toBeFinal()
    ->toBeReadonly();

test('Monitoring infrastructure does not depend on Domain Logic')
    ->expect('Infrastructure\Monitoring')
    ->toOnlyUse([
        'Illuminate',
        'Laravel\Pulse',
        'Carbon',
        'GuzzleHttp',
        'Infrastructure\Monitoring',
    ])
    ->ignoring('App\Providers'); // Providers setup the IoC, they can reference Domain models like User for auth.

test('Recorders have strong typing in record methods')
    ->expect('Infrastructure\Monitoring\Pulse\Recorders')
    ->toHaveMethod('record')
    ->andMethod('record')->toHaveStrongTypes();
```

## 6. Livewire Card Development for Pulse

To view your custom metrics on the `/pulse` dashboard, you need a custom Livewire card.

```php
<?php

declare(strict_types=1);

namespace Infrastructure\Monitoring\Pulse\Cards;

use Laravel\Pulse\Livewire\Card;
use Laravel\Pulse\Facades\Pulse;
use Illuminate\Contracts\View\View;
use Livewire\Attributes\Lazy;

#[Lazy]
final class ApiLatencyCard extends Card
{
    public function render(): View
    {
        // Retrieve the aggregated data for the card
        $latencies = Pulse::aggregate(
            'api_latency',
            ['average', 'max'],
            $this->periodAsInterval(),
        );

        return view('pulse.api-latency', [
            'latencies' => $latencies,
            'time' => $this->time,
            'runAt' => $this->runAt,
        ]);
    }
}
```

```html
<!-- resources/views/pulse/api-latency.blade.php -->
<x-pulse::card :cols="$cols" :rows="$rows" :class="$class">
    <x-pulse::card-header
        name="External API Latency"
        title="Time: {{ $time }}ms; Run at: {{ $runAt }};"
        details="past {{ $this->periodForHumans() }}"
    >
        <x-slot:icon>
            <x-pulse::icons.globe />
        </x-slot:icon>
    </x-pulse::card-header>

    <x-pulse::scroll :expand="$expand" wire:poll.5s="">
        @if ($latencies->isEmpty())
            <x-pulse::no-results />
        @else
            <x-pulse::table>
                <colgroup>
                    <col width="100%" />
                    <col width="0%" />
                    <col width="0%" />
                </colgroup>
                <x-pulse::thead>
                    <tr>
                        <x-pulse::th>Host</x-pulse::th>
                        <x-pulse::th class="text-right">Average</x-pulse::th>
                        <x-pulse::th class="text-right">Max</x-pulse::th>
                    </tr>
                </x-pulse::thead>
                <tbody>
                    @foreach ($latencies as $latency)
                        <tr class="h-2 first:h-0"></tr>
                        <tr wire:key="{{ $latency->key }}">
                            <x-pulse::td class="max-w-[1px]">
                                <code class="block text-xs truncate text-gray-900 dark:text-gray-100" title="{{ $latency->key }}">
                                    {{ $latency->key }}
                                </code>
                            </x-pulse::td>
                            <x-pulse::td class="text-right text-gray-700 dark:text-gray-300 text-sm tabular-nums">
                                <strong>{{ number_format($latency->average) }}</strong> ms
                            </x-pulse::td>
                            <x-pulse::td class="text-right text-gray-700 dark:text-gray-300 text-sm tabular-nums">
                                <strong>{{ number_format($latency->max) }}</strong> ms
                            </x-pulse::td>
                        </tr>
                    @endforeach
                </tbody>
            </x-pulse::table>
        @endif
    </x-pulse::scroll>
</x-pulse::card>
```

This ensures a robust, visually consistent presentation directly integrated into the Laravel Pulse UI.
