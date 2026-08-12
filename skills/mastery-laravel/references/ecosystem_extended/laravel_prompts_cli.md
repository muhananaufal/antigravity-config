---
description: "Advanced guide to building modern, interactive CLI applications using Laravel Prompts, applying Clean Architecture to Console Commands, mitigating memory/security risks, and testing with Pest v3."
tags: ["laravel", "cli", "prompts", "artisan", "clean-architecture", "php8.4", "pest", "testing", "security"]
---

# 🚀 Laravel Prompts & Advanced CLI Mastery (PHP 8.4 / Laravel 11+)

Laravel Prompts revolutionizes command-line interface (CLI) applications in PHP by providing beautiful, interactive, and user-friendly forms. It replaces the older Symfony Console question helpers with a modern, aesthetically pleasing, and highly functional API.

However, with great power comes the responsibility to maintain clean architecture, handle memory efficiently, and ensure non-interactive environment compatibility (e.g., CI/CD pipelines, cron jobs, automated deployments). 

This comprehensive guide covers everything from basic usage to enterprise-grade CLI architecture, strictly typed for PHP 8.3/8.4 and tested with Pest v3.

---

## 🏗️ 1. Core Principles of CLI Clean Architecture

A prevalent mistake in Laravel applications is placing heavy business logic directly inside Artisan commands. In Clean Architecture, Console Commands should be treated purely as **Delivery Mechanisms** (exactly like HTTP Controllers or Job handlers).

### Rules for Enterprise CLI:
1. **Zero Business Logic in Commands**: Commands must only gather input (via Prompts, arguments, or options) and format/display output.
2. **Delegation to Actions/Use Cases**: Pass strictly typed DTOs (Data Transfer Objects) or primitives to Action classes or Domain Services.
3. **CI/CD Readiness**: Always support non-interactive modes (`--no-interaction` or explicit flags like `--force`) by defining arguments/options as fallbacks for visual prompts.
4. **Strict Typing**: Leverage PHP 8.4 strict types. Commands should return integer exit codes (`self::SUCCESS`, `self::FAILURE`).

---

## ⛔ 2. Anti-Patterns & Best Practices

### 💥 Anti-Pattern 1: Fat Commands, Memory Exhaustion & Mixed I/O
**Risk:** **Memory & Performance.** Loading massive datasets directly in a command and performing I/O sequentially causes memory leaks and high execution times. Furthermore, mixing prompt logic with DB operations makes the command impossible to test in isolation without full integration tests.

#### ❌ BAD CODE: The "Fat & Leaky" Command
```php
<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\User;
use Illuminate\Console\Command;
use function Laravel\Prompts\confirm;
use function Laravel\Prompts\info;

final class ProcessUsersCommand extends Command
{
    protected $signature = 'users:process';
    protected $description = 'Process all users (BAD EXAMPLE)';

    public function handle(): int
    {
        // ❌ BAD: Asking for input without any non-interactive fallback flag.
        // In a CI/CD pipeline, this will hang infinitely waiting for user input!
        $shouldProcess = confirm('Do you want to process all users?');

        if (!$shouldProcess) {
            return self::SUCCESS;
        }

        // ❌ BAD: Memory leak! Loads ALL users into RAM at once.
        // If there are 1,000,000 users, PHP will exceed memory limits and crash.
        $users = User::where('active', true)->get();

        foreach ($users as $user) {
            // ❌ BAD: Business logic is tightly coupled with CLI output.
            $user->update(['last_processed_at' => now()]);
            info("Processed user: {$user->email}"); // I/O bottleneck
        }

        return self::SUCCESS;
    }
}
```

#### ✅ GOOD CODE: Action Delegation & Memory Optimization
```php
<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Actions\Users\ProcessActiveUsersAction;
use Illuminate\Console\Command;
use function Laravel\Prompts\confirm;
use function Laravel\Prompts\info;
use function Laravel\Prompts\progress;

final class ProcessUsersCommand extends Command
{
    // ✅ GOOD: Allow non-interactive flags for CI/CD environments.
    protected $signature = 'users:process {--force : Force processing without interactive prompts}';
    protected $description = 'Process all active users safely via Action';

    public function __construct(
        private readonly ProcessActiveUsersAction $processUsersAction
    ) {
        parent::__construct();
    }

    public function handle(): int
    {
        $force = (bool) $this->option('force');

        // ✅ GOOD: Handle non-interactive mode gracefully if --force is missing
        if (!$force && !$this->components->getOutput()->isInteractive()) {
            $this->error('Interactive prompts disabled in this environment. Use --force to run.');
            return self::FAILURE;
        }

        $shouldProcess = $force || confirm(
            label: 'Do you want to process all active users?',
            default: false
        );

        if (!$shouldProcess) {
            info('Operation aborted by user.');
            return self::SUCCESS;
        }

        $totalUsers = $this->processUsersAction->countActive();

        if ($totalUsers === 0) {
            info('No active users found to process.');
            return self::SUCCESS;
        }

        // ✅ GOOD: Using a progress bar. The Action handles the chunking.
        progress(
            label: 'Processing active users...',
            steps: $totalUsers,
            callback: fn (\Laravel\Prompts\Progress $progress) => clone $this->processUsersAction->execute($progress)
        );

        info("Successfully processed {$totalUsers} users.");

        return self::SUCCESS;
    }
}
```

**Detailed Explanation:**
- **Memory/Performance:** The `ProcessActiveUsersAction` should implement `User::query()->lazy()` or `User::query()->chunkById()` to process records in batches, keeping memory usage flat (O(1) relative to dataset size).
- **Testing:** The Action can now be unit-tested purely as domain logic, mocking out the DB, without any need to simulate Console I/O.
- **CI/CD Resiliency:** The `--force` flag allows automation scripts (e.g., GitHub Actions, cron jobs) to bypass the interactive `confirm()` prompt entirely, preventing infinitely hanging processes.

---

### 💥 Anti-Pattern 2: Unsanitized Dynamic Searches & Security Risks
**Risk:** **Security (Injection/Data Leakage) & Performance.** Using `search()` prompts to dynamically query the database without strict validation can expose sensitive data to unauthorized admins/developers running the CLI, or lead to DoS (Denial of Service) via unoptimized wildcard `LIKE` searches on massive tables.

#### ❌ BAD CODE: Unsafe Search Prompt
```php
<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\User;
use Illuminate\Console\Command;
use function Laravel\Prompts\search;

final class FindUserCommand extends Command
{
    protected $signature = 'user:find';
    protected $description = 'Find user (BAD EXAMPLE)';

    public function handle(): int
    {
        // ❌ BAD: No input sanitization, searching across unindexed columns, exposing all data.
        $selectedUserId = search(
            label: 'Search for a user',
            options: fn (string $value) => strlen($value) > 0
                ? User::query()
                    ->where('name', 'like', "%{$value}%")
                    ->orWhere('email', 'like', "%{$value}%") // Slow, unindexed full-table scan!
                    ->orWhere('ssn', 'like', "%{$value}%")   // SECURITY RISK: Searching by PII!
                    ->pluck('name', 'id')
                    ->all()
                : []
        );

        $this->info("Selected ID: {$selectedUserId}");
        return self::SUCCESS;
    }
}
```

#### ✅ GOOD CODE: Sanitized, Scoped, and Performant Search
```php
<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Repositories\Contracts\UserRepositoryInterface;
use Illuminate\Console\Command;
use function Laravel\Prompts\search;
use function Laravel\Prompts\info;

final class FindUserCommand extends Command
{
    // ✅ GOOD: Allow direct argument bypassing for automation.
    protected $signature = 'user:find {--email= : Provide email directly for CI/automation}';
    protected $description = 'Safely search and find a user';

    public function __construct(
        private readonly UserRepositoryInterface $userRepository
    ) {
        parent::__construct();
    }

    public function handle(): int
    {
        $emailOption = $this->option('email');

        // ✅ GOOD: Fast-path for automated environments.
        if (is_string($emailOption) && trim($emailOption) !== '') {
            $user = $this->userRepository->findByEmail($emailOption);
            if ($user !== null) {
                info("Found user: {$user->name} ({$user->email})");
                return self::SUCCESS;
            }
            $this->error('User not found.');
            return self::FAILURE;
        }

        // ✅ GOOD: Use Repository for querying. Strict length limits enforced.
        $selectedUserId = search(
            label: 'Search for a user by name or email',
            placeholder: 'e.g. John Doe',
            options: function (string $value): array {
                $term = trim($value);
                
                // ✅ GOOD: Prevent massive full-table scan queries on extremely short inputs.
                if (strlen($term) < 3) {
                    return [];
                }

                // Repository handles optimized queries (e.g., using Laravel Scout, ElasticSearch, or exact prefix matches).
                return $this->userRepository->searchPublicProfilesForDropdown($term);
            }
        );

        if ($selectedUserId) {
            info("Successfully selected User ID: {$selectedUserId}");
        }

        return self::SUCCESS;
    }
}
```

**Detailed Explanation:**
- **Security:** We explicitly removed the ability to search by highly sensitive fields (like SSN or internal API tokens). The query is abstracted into a Repository that guarantees only safe, public-facing data is returned to the CLI output.
- **Performance:** We enforced a minimum search length (`strlen($term) < 3`). Without this, typing "a" would trigger a `LIKE '%a%'` query against millions of rows, locking the database and degrading application performance for real users.
- **CI/CD Resiliency:** We provided a `--email=` option. If an external script needs to find a user, it passes the exact email, skipping the interactive prompt and avoiding search overhead altogether.

---

## 🛠️ 3. Advanced Prompts API & Types

Laravel Prompts provides a rich set of statically typed functions. Always ensure your closures and return types are strictly typed according to PHP 8.4 standards.

### Multi-Select with Validation
```php
<?php

declare(strict_types=1);

use function Laravel\Prompts\multiselect;

/** @var array<int, string> $roles */
$roles = multiselect(
    label: 'Assign roles to the new user',
    options: [
        'admin' => 'Administrator',
        'editor' => 'Content Editor',
        'viewer' => 'Read-only Viewer',
    ],
    default: ['viewer'],
    validate: fn (array $values): ?string => match (true) {
        count($values) === 0 => 'You must select at least one role.',
        in_array('admin', $values, true) && count($values) > 1 => 'Admin role cannot be combined with other restrictive roles.',
        default => null
    }
);
```

### Spinning (Long-Running Tasks)
When dispatching jobs, calling external APIs, or processing files, keep the user informed without cluttering the screen with hundreds of log lines.

```php
<?php

declare(strict_types=1);

use function Laravel\Prompts\spin;
use Illuminate\Support\Facades\Http;

// The UI will show a clean spinner until the closure completes.
$response = spin(
    message: 'Provisioning server via Forge API...',
    callback: fn () => Http::timeout(30)->post('https://forge.laravel.com/api/v1/servers', [
        'type' => 'app',
        'provider' => 'ocean2',
    ])
);
```

### Forms (Introduced in Laravel 11.x)
Laravel Prompts `form()` builder allows you to compose multiple questions into a single cohesive UI flow, returning an associative array of all answers.

```php
<?php

declare(strict_types=1);

use function Laravel\Prompts\form;

$responses = form()
    ->text('What is your name?', required: true, name: 'name')
    ->password(
        label: 'Provide a secure password', 
        validate: fn(string $p) => strlen($p) < 8 ? 'Minimum 8 characters required' : null, 
        name: 'password'
    )
    ->confirm('Accept terms and conditions?', name: 'terms')
    ->submit();

// $responses is strictly an array: 
// ['name' => 'John', 'password' => 'secret123', 'terms' => true]
```

---

## 🧪 4. Testing CLI Prompts with Pest v3

Testing interactive commands used to be notoriously difficult, but Laravel provides powerful assertions out of the box. Combined with Pest v3, we can achieve 100% coverage on CLI interfaces.

### Unit / Feature Testing Commands

```php
<?php

declare(strict_types=1);

// tests/Feature/Console/ProcessUsersCommandTest.php

use App\Models\User;
use function Pest\Laravel\artisan;
use function Pest\Laravel\assertDatabaseHas;

it('aborts user processing when confirmation is negative', function (): void {
    artisan('users:process')
        ->expectsConfirmation('Do you want to process all active users?', 'no')
        ->expectsOutputToContain('Operation aborted by user.')
        ->assertSuccessful(); // Expects exit code 0
});

it('processes users when confirmed via interactive prompt', function (): void {
    // Arrange
    $user = User::factory()->create(['active' => true, 'last_processed_at' => null]);

    // Act & Assert I/O
    artisan('users:process')
        ->expectsConfirmation('Do you want to process all active users?', 'yes')
        ->expectsOutputToContain('Successfully processed 1 users.')
        ->assertSuccessful();

    // Assert Domain State
    assertDatabaseHas('users', [
        'id' => $user->id,
        'active' => true,
    ]);
    
    // Using Pest expectations for deep validation
    expect($user->fresh()->last_processed_at)->not->toBeNull();
});

it('can run non-interactively using the force flag', function (): void {
    // Arrange
    User::factory()->count(3)->create(['active' => true]);

    // Act
    artisan('users:process', ['--force' => true])
        ->doesntExpectOutput('Do you want to process all active users?')
        ->expectsOutputToContain('Successfully processed 3 users.')
        ->assertSuccessful();
});
```

### Architecture Testing Commands (Pest v3)
To enforce the Clean Architecture rules discussed in Section 1, we must utilize Pest's architecture testing to ensure Commands do not bypass Action classes and hit Eloquent Models directly.

```php
<?php

declare(strict_types=1);

// tests/ArchTest.php

arch('console commands are strictly delivery mechanisms and must not use Models directly')
    ->expect('App\Console\Commands')
    ->toOnlyUse([
        'Illuminate\Console\Command',
        'Laravel\Prompts',
        'App\Actions',
        'App\Repositories\Contracts',
        'App\DataTransferObjects',
        'Illuminate\Support\Collection',
        'Illuminate\Support\Facades\Log',
        // Whitelist other allowed infrastructure components
    ])
    ->not->toUse('App\Models') // ❌ Commands must NEVER use Eloquent Models directly!
    ->not->toUse('Illuminate\Support\Facades\DB'); // ❌ No raw DB queries in commands!

arch('console commands must extend base command class and implement handle')
    ->expect('App\Console\Commands')
    ->toExtend('Illuminate\Console\Command')
    ->toHaveMethod('handle');

arch('console commands should be final')
    ->expect('App\Console\Commands')
    ->toBeFinal();
```

---

## 🎯 5. Summary Checklist for CLI Mastery

1. **Never mix Domain Logic and I/O:** Commands are entry points, nothing more. Delegate heavy lifting to Actions.
2. **Respect CI/CD Pipelines:** Always provide fallback flags (`--force`, `--no-interaction`) to prevent stalled pipelines.
3. **Secure Inputs:** Even in a trusted CLI environment, never trust dynamic inputs in `search()`. Protect against excessive DB load and PII leakage.
4. **Memory Management:** For large datasets, always use chunking (`lazy()`, `chunkById()`) combined with Prompts `progress()` bars.
5. **Test Relentlessly:** Use Pest's `expectsConfirmation`, `expectsQuestion`, and Arch tests to programmatically enforce architecture boundaries.
