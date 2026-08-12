# Spatie Laravel Settings Mastery: The Enterprise Guide

## 1. Overview & Core Philosophy
`spatie/laravel-settings` provides a robust, strongly-typed, and highly optimized way to manage dynamic application configurations. In legacy Laravel applications, developers typically rely on unstructured array-based configuration (`config('app.name')`) or build a generic `settings` table with loose typing (e.g., `key`, `value` columns). Both approaches introduce significant technical debt, lack type safety, and suffer from performance bottlenecks (e.g., N+1 queries when loading settings).

This package revolutionizes configuration management by leveraging **Data Transfer Objects (DTOs)** representing cohesive settings groups. These classes map directly to database columns or JSON structures, providing built-in caching, type casting, encryption, and IDE autocompletion.

## 2. Architectural Benefits
In high-performance, enterprise-grade Laravel 11/12 applications running on PHP 8.3/8.4, architecture matters. Integrating `spatie/laravel-settings` yields several immediate advantages:
- **Strict Typing:** Enforces types (`bool`, `int`, `Carbon`, `Enums`, custom `DTOs`) preventing silent runtime failures.
- **Extreme Performance:** Eliminates database queries during the HTTP request lifecycle via highly optimized, group-based caching.
- **Static Analysis Compatibility:** Seamless integration with PHPStan, Psalm, and IDEs. No more guessing array keys.
- **Version Control & Migrations:** Supports explicit database migrations for settings, ensuring environments remain synchronized.
- **Security:** Guarantees sensitive data (API keys, secrets) is encrypted at rest automatically.

---

## 3. Clean Architecture & Domain-Driven Design (DDD)

In Clean Architecture, settings should be treated as **Domain Configuration** or **Infrastructure dependencies**. Settings classes act as concrete implementations of domain interfaces (if inversion of control is required) or as strictly-typed value objects.

### Defining Cohesive Domain Settings

```php
<?php

declare(strict_types=1);

namespace App\Domain\Invoicing\Settings;

use App\Domain\Invoicing\Enums\InvoiceFormat;
use Spatie\LaravelSettings\Settings;

final class InvoicingSettings extends Settings
{
    public string $default_currency;
    public float $tax_rate;
    public InvoiceFormat $export_format;
    public bool $auto_send_receipts;
    public ?string $legal_company_name;

    public static function group(): string
    {
        return 'invoicing';
    }
}
```

### Decoupling Settings via Interfaces (Ports and Adapters)
To fully isolate the core Domain from the Infrastructure layer (the Spatie package), define an interface (Port) in the Domain, and implement it using the Settings class (Adapter) in the Infrastructure layer. This prevents your core business logic from coupling to `Spatie\LaravelSettings\Settings`.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Invoicing\Contracts;

/**
 * Domain Port
 */
interface TaxConfigurationInterface
{
    public function getDefaultTaxRate(): float;
    public function isTaxInclusive(): bool;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Settings;

use App\Domain\Invoicing\Contracts\TaxConfigurationInterface;
use Spatie\LaravelSettings\Settings;

/**
 * Infrastructure Adapter
 */
final class TaxSettings extends Settings implements TaxConfigurationInterface
{
    public float $default_rate;
    public bool $is_inclusive;

    public static function group(): string
    {
        return 'tax';
    }

    public function getDefaultTaxRate(): float
    {
        return $this->default_rate;
    }

    public function isTaxInclusive(): bool
    {
        return $this->is_inclusive;
    }
}
```

---

## 4. Anti-Patterns & Best Practices

To maintain Top 1% code quality, you must avoid common pitfalls when implementing dynamic settings.

### ❌ Anti-Pattern 1: The "God" Settings Class (Monolithic Architecture)
**Anti-Pattern:** Dumping all application settings into a single `GeneralSettings` class.
**Risks:**
- **Performance/Memory:** Changing one setting invalidates the cache for the entire monolithic group. You are forced to load a massive payload into memory even if you only need a single boolean flag.
- **Security:** Mixing highly sensitive infrastructure secrets with public UI configurations.
- **Maintainability:** Constant merge conflicts in version control. Violates the Single Responsibility Principle (SRP).

```php
<?php

declare(strict_types=1);

namespace App\Settings;

use Spatie\LaravelSettings\Settings;

// ❌ BAD: Mixing unrelated domains and sensitivity levels
final class GeneralSettings extends Settings
{
    public string $site_name;
    public string $stripe_secret; // Critical Security Risk!
    public int $max_upload_size;
    public bool $enable_registration;
}
```

### ✅ Best Practice 1: Domain-Specific Setting Segregation
Split settings into highly cohesive, domain-specific classes. Separate public configurations from sensitive secrets.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Payment\Settings;

use Spatie\LaravelSettings\Settings;

final class StripeSettings extends Settings
{
    public string $public_key;
    public string $secret_key;

    public static function group(): string
    {
        return 'stripe';
    }

    public static function encrypted(): array
    {
        return [
            'secret_key', // Encrypted at rest
        ];
    }
}
```

---

### ❌ Anti-Pattern 2: Mutating Settings in HTTP Controllers
**Anti-Pattern:** Updating settings directly inside web controllers without validation or auditing.
**Risks:**
- **Architecture:** Controllers become tightly coupled to the settings infrastructure.
- **Auditability:** No trail of configuration changes (who changed what, and when).
- **Concurrency:** High risk of race conditions if two requests update settings concurrently.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Settings\SystemSettings;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

final class SettingsController
{
    // ❌ BAD: Direct mutation without validation or events
    public function update(Request $request, SystemSettings $settings): Response
    {
        $settings->maintenance_mode = $request->boolean('maintenance');
        $settings->save();

        return response()->noContent();
    }
}
```

### ✅ Best Practice 2: Command Pattern & Actions for Setting Mutations
Use Action classes or Commands to encapsulate setting mutations. Dispatch events for audit logs.

```php
<?php

declare(strict_types=1);

namespace App\Domain\System\Actions;

use App\Domain\System\Settings\SystemSettings;
use App\Domain\System\Events\MaintenanceModeToggled;
use Illuminate\Support\Facades\Event;

final readonly class ToggleMaintenanceModeAction
{
    public function __construct(
        private SystemSettings $settings
    ) {}

    public function execute(bool $enable): void
    {
        // Idempotency check: Avoid unnecessary database writes and cache invalidations
        if ($this->settings->maintenance_mode === $enable) {
            return;
        }

        $this->settings->maintenance_mode = $enable;
        $this->settings->save();

        Event::dispatch(new MaintenanceModeToggled($enable));
    }
}
```

---

### ❌ Anti-Pattern 3: Using Settings for Transactional Data
**Anti-Pattern:** Using Settings classes to store user-generated content, large JSON blobs, or frequently changing transactional state (e.g., counters, user preferences).
**Risks:**
- **Cache Thrashing:** Settings are designed for *read-heavy, write-infrequent* workloads. Writing to a setting invalidates the cache for the entire group. If updated on every request (e.g., a visitor counter), it will destroy Redis performance.
- **Scalability:** The `settings` table will become a bottleneck under concurrent writes.

```php
<?php
// ❌ BAD: Storing transactional/frequently changing data in Settings
final class GlobalStatsSettings extends Settings
{
    public int $total_visits_today; // Changes every second!
}
```

### ✅ Best Practice 3: Dedicated Eloquent Models for Transactional State
Settings should only be used for global configuration, feature toggles, and API keys. Use Eloquent models or direct Redis counters for transactional or user-scoped data.

---

## 5. Advanced Implementations

### Complex Casts with Spatie Data Transfer Objects
Settings aren't limited to scalar types. You can store complex arrays of strongly-typed DTOs by leveraging `spatie/laravel-data`. This provides incredible power for complex configurations.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Notification\Settings;

use Spatie\LaravelSettings\Settings;
use Spatie\LaravelSettings\SettingsCasts\DtoCast;
use Spatie\LaravelData\Data;

final class NotificationChannel extends Data
{
    public function __construct(
        public string $channel,
        public bool $enabled,
        public array $recipient_emails,
    ) {}
}

final class AlertSettings extends Settings
{
    /** @var array<int, NotificationChannel> */
    public array $channels;

    public static function group(): string
    {
        return 'alerts';
    }

    public static function casts(): array
    {
        return [
            // Automatically casts JSON from the DB into an array of Data objects
            'channels' => DtoCast::class . ':' . NotificationChannel::class,
        ];
    }
}
```

### Creating Custom Casts
For Value Objects that don't fit perfectly into standard DTOs (e.g., wrapping a native PHP class or a custom `Money` object), you can create a custom Cast.

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Settings\Casts;

use Spatie\LaravelSettings\SettingsCasts\SettingCast;
use Brick\Money\Money;

final class MoneyCast implements SettingCast
{
    public function get($payload): Money
    {
        return Money::of($payload['amount'], $payload['currency']);
    }

    public function set($payload): array
    {
        /** @var Money $payload */
        return [
            'amount' => $payload->getAmount()->__toString(),
            'currency' => $payload->getCurrency()->getCurrencyCode(),
        ];
    }
}
```

### Migrations and Zero-Downtime Deployments
Unlike standard Eloquent tables, `spatie/laravel-settings` uses specific migration classes to define default values. This is critical for zero-downtime deployments.

```php
<?php

declare(strict_types=1);

use Spatie\LaravelSettings\Migrations\SettingsMigration;

final class CreateInvoicingSettings extends SettingsMigration
{
    public function up(): void
    {
        $this->migrator->add('invoicing.default_currency', 'USD');
        $this->migrator->add('invoicing.tax_rate', 10.5);
        $this->migrator->add('invoicing.auto_send_receipts', true);
    }
    
    public function down(): void
    {
        $this->migrator->delete('invoicing.default_currency');
        $this->migrator->delete('invoicing.tax_rate');
        $this->migrator->delete('invoicing.auto_send_receipts');
    }
}
```
**Deployment Tip:** Always provide sensible defaults in migrations. When rolling out a new feature flag via settings, the migration ensures the setting exists in the database immediately, preventing `PropertyNotSetException` during the deployment window.

### Extreme Caching Strategies
Under the hood, `laravel-settings` caches all settings grouped together. This means reading a setting is a rapid memory/Redis lookup, bypassing the database entirely.
Ensure your `config/settings.php` has caching enabled in production:

```php
// config/settings.php
'cache' => [
    'enabled' => env('SETTINGS_CACHE_ENABLED', true),
    'store' => 'redis', // Explicitly use Redis/Memcached for performance
    'prefix' => 'settings_',
    'ttl' => null, // Cache indefinitely until explicitly updated
],
```
When `$settings->save()` is invoked, the package automatically invalidates the cache for that specific group.

---

## 6. Pest v3 Testing (Unit & Architecture)

Testing code that interacts with settings is remarkably straightforward because Settings classes are managed by the Laravel container as singletons, and the package provides a native `fake()` implementation.

### Architecture Tests (Pest Arch)
Enforce architectural boundaries. Ensure that all Settings classes reside in the correct directories, extend the base `Settings` class, and do not leak infrastructure logic (like depending on HTTP Requests).

```php
<?php

declare(strict_types=1);

use Spatie\LaravelSettings\Settings;
use Spatie\LaravelSettings\Migrations\SettingsMigration;

test('settings classes are strictly typed and extend base settings')
    ->expect('App\Domain\*\Settings')
    ->toExtend(Settings::class)
    ->toBeFinal()
    ->toUseStrictTypes();

test('settings classes should not depend on HTTP requests')
    ->expect('App\Domain\*\Settings')
    ->not->toUse('Illuminate\Http\Request');

test('settings migrations must extend SettingsMigration')
    ->expect('Database\Settings')
    ->toExtend(SettingsMigration::class)
    ->toUseStrictTypes();
```

### Unit & Integration Tests
When testing domain services or actions that depend on Settings, utilize the `Settings::fake()` method. This mocks the settings in-memory without hitting the database or Redis cache.

```php
<?php

declare(strict_types=1);

namespace Tests\Unit\Domain\System\Actions;

use App\Domain\System\Actions\ToggleMaintenanceModeAction;
use App\Domain\System\Settings\SystemSettings;
use App\Domain\System\Events\MaintenanceModeToggled;
use Illuminate\Support\Facades\Event;

beforeEach(function () {
    // Fake the settings with initial state before resolving the action
    SystemSettings::fake([
        'maintenance_mode' => false,
    ]);
});

test('it toggles maintenance mode and dispatches event', function () {
    Event::fake();

    $settings = app(SystemSettings::class);
    
    // Initial state assertion
    expect($settings->maintenance_mode)->toBeFalse();

    $action = app(ToggleMaintenanceModeAction::class);
    $action->execute(true);

    // Refresh settings object to reflect in-memory changes
    $settings->refresh();

    // Assert mutated state
    expect($settings->maintenance_mode)->toBeTrue();

    // Assert auditing event dispatched successfully
    Event::assertDispatched(
        MaintenanceModeToggled::class, 
        fn (MaintenanceModeToggled $event) => $event->enabled === true
    );
});

test('it achieves idempotency and skips event dispatch if state is unchanged', function () {
    Event::fake();
    
    // Seed initial state as already true
    SystemSettings::fake([
        'maintenance_mode' => true,
    ]);

    $action = app(ToggleMaintenanceModeAction::class);
    $action->execute(true); // Attempt to toggle true again

    Event::assertNotDispatched(MaintenanceModeToggled::class);
});
```

## 7. Security: Encrypted Properties
Never store API keys, OAuth secrets, or banking credentials in plain text. The `encrypted()` method ensures that specific properties are automatically passed through Laravel's encrypter (`Crypt::encrypt()`) before being stored in the database, and decrypted upon retrieval.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Integrations\Settings;

use Spatie\LaravelSettings\Settings;

final class GitHubIntegrationSettings extends Settings
{
    public string $client_id;
    public string $client_secret;
    public string $webhook_secret;

    public static function group(): string
    {
        return 'github';
    }

    public static function encrypted(): array
    {
        return [
            'client_secret',
            'webhook_secret',
        ];
    }
}
```
**Important Security Note:** If the `APP_KEY` changes, all encrypted settings in the database will be unreadable and will throw a `DecryptException`. Always back up the `APP_KEY`.

---

## Summary & Checklist for Top 1% Implementations
- [x] **Strict Types:** Utilize `declare(strict_types=1);` in all Settings and migration classes.
- [x] **Immutability Protection:** Declare all Settings classes as `final` to prevent unexpected extension.
- [x] **Domain Segmentation:** Group settings logically based on distinct Domain boundaries, keeping classes small and highly cohesive.
- [x] **Explicit Casts:** Leverage Custom Casts and DTO Casts for complex data structures to eliminate array-guessing.
- [x] **Encapsulation:** Mutate settings exclusively through Action classes or Commands to enforce validation, idempotency, and audit logging.
- [x] **Encryption:** Define sensitive infrastructure keys within the `encrypted()` array method.
- [x] **Pest Enforcement:** Utilize Pest Architecture tests to guarantee `extends Settings`, strict types, and dependency rules.
- [x] **Production Caching:** Ensure the production environment is configured to cache settings using an in-memory datastore like Redis.

By treating application configurations as strictly-typed, domain-specific objects, `spatie/laravel-settings` completely eliminates categories of runtime errors related to missing configs, typographical errors, and cache invalidation logic, forming the backbone of a highly resilient, enterprise-grade architecture.
