# Laravel Telescope: Debugging & Profiling Masterclass (Top 1% Engineering)

Telescope adalah companion debugging tool kelas satu (first-party) untuk aplikasi Laravel. Dirancang oleh tim Laravel, Telescope memberikan insight mendalam mengenai state aplikasi: request masuk, exceptions, log entries, database queries, queued jobs, mail, notifications, cache operations, scheduled tasks, variable dumps, dan banyak lagi.

Dokumen ini adalah panduan komprehensif, arsitektural, dan *production-ready* untuk menguasai Telescope, debugging, dan profiling di ekosistem Laravel 11/12 dengan PHP 8.3+.

---

## 1. Arsitektur & Filosofi Telescope

Secara arsitektur, Telescope menggunakan pola **Observer / Watcher**. Saat aplikasi boot, Telescope mendaftarkan serangkaian *event listeners* terhadap core components Laravel (seperti `Illuminate\Database\Events\QueryExecuted`, `Illuminate\Log\Events\MessageLogged`, dll). Setiap event yang tertangkap akan di-*record* ke dalam tabel `telescope_entries`.

Namun, mencatat *setiap* interaksi I/O memiliki konsekuensi performa. Oleh karena itu, arsitek Top 1% harus memahami kapan, bagaimana, dan di mana Telescope diizinkan berjalan.

### 1.1 Watcher Overhead
Telescope memiliki lebih dari 20 Watcher bawaan:
- `QueryWatcher`: Merekam semua query. Memiliki fitur pendeteksi query lambat (slow queries).
- `LogWatcher`: Mengarahkan semua output `Log::` ke Telescope.
- `EventWatcher`: Memantau setiap event yang di-*dispatch*.
- `DumpWatcher`: Menangkap output dari fungsi `dump()` sehingga tidak mengganggu flow HTTP response.

---

## 2. Instalasi & Konfigurasi *Production-Ready*

Meskipun Telescope umumnya hanya digunakan di environment `local`, beberapa tim (dengan alasan valid) mengaktifkannya di `production` secara spesifik dengan filtering ketat.

### 2.1 Konfigurasi Dasar (`telescope.php`)

```php
<?php

declare(strict_types=1);

// config/telescope.php

use Laravel\Telescope\Watchers;
use Laravel\Telescope\Http\Middleware\Authorize;

return [
    'domain' => env('TELESCOPE_DOMAIN'),
    'path' => env('TELESCOPE_PATH', 'telescope'),
    'driver' => env('TELESCOPE_DRIVER', 'database'),
    'storage' => [
        'database' => [
            'connection' => env('DB_CONNECTION', 'mysql'),
            'chunk' => 1000,
        ],
    ],
    // Hanya enable watcher krusial jika berjalan di production
    'watchers' => [
        Watchers\CacheWatcher::class => env('TELESCOPE_CACHE_WATCHER', true),
        Watchers\CommandWatcher::class => [
            'enabled' => env('TELESCOPE_COMMAND_WATCHER', true),
            'ignore' => ['schedule:run', 'queue:work'], // Jangan record command infinite/rutin
        ],
        Watchers\DumpWatcher::class => env('TELESCOPE_DUMP_WATCHER', true),
        Watchers\EventWatcher::class => [
            'enabled' => env('TELESCOPE_EVENT_WATCHER', true),
            'ignore' => [
                'Laravel\Octane\Events\RequestReceived', // Abaikan event high-throughput
            ],
        ],
        Watchers\ExceptionWatcher::class => env('TELESCOPE_EXCEPTION_WATCHER', true),
        Watchers\JobWatcher::class => env('TELESCOPE_JOB_WATCHER', true),
        Watchers\LogWatcher::class => env('TELESCOPE_LOG_WATCHER', true),
        Watchers\QueryWatcher::class => [
            'enabled' => env('TELESCOPE_QUERY_WATCHER', true),
            'ignore_packages' => true,
            'ignore_paths' => [],
            'slow' => 100, // MS: Tandai query lambat jika > 100ms
        ],
        Watchers\RequestWatcher::class => [
            'enabled' => env('TELESCOPE_REQUEST_WATCHER', true),
            'size_limit' => env('TELESCOPE_RESPONSE_SIZE_LIMIT', 64),
            'ignore_status_codes' => [200, 201, 204, 302], // Di production, mungkin hanya catat 4xx dan 5xx
            'ignore_http_methods' => ['OPTIONS'],
        ],
    ],
];
```

### 2.2 Otorisasi Telescope (Gate)
Anda harus mengatur siapa yang bisa mengakses dashboard Telescope di non-local environment.

```php
<?php

declare(strict_types=1);

namespace App\Providers;

use Illuminate\Support\Facades\Gate;
use Laravel\Telescope\Telescope;
use Laravel\Telescope\TelescopeApplicationServiceProvider;
use App\Models\User;

final class TelescopeServiceProvider extends TelescopeApplicationServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        // Telescope::night(); // Opsional: Dark mode
        
        $this->hideSensitiveRequestDetails();

        // Rekam data HANYA jika kriteria tertentu terpenuhi (Filter)
        Telescope::filter(function ($entry) {
            if ($this->app->environment('local')) {
                return true;
            }

            return $entry->isReportableException() ||
                   $entry->isFailedRequest() ||
                   $entry->isFailedJob() ||
                   $entry->isScheduledTask() ||
                   $entry->hasMonitoredTag();
        });
    }

    /**
     * Prevent sensitive data from being logged by Telescope.
     */
    protected function hideSensitiveRequestDetails(): void
    {
        if ($this->app->environment('local')) {
            return;
        }

        Telescope::hideRequestParameters(['_token', 'password', 'password_confirmation', 'api_key', 'cc_number']);
        Telescope::hideRequestHeaders(['cookie', 'x-csrf-token', 'x-xsrf-token', 'authorization']);
    }

    /**
     * Register the Telescope gate.
     */
    protected function gate(): void
    {
        Gate::define('viewTelescope', function (User $user) {
            return in_array($user->email, [
                'architect@company.com',
                'cto@company.com',
            ], true);
        });
    }
}
```

---

## 3. Profiling Clean Architecture dengan Telescope

Untuk melihat nilai sebenarnya dari Telescope, kita harus menerapkannya dalam flow Clean Architecture. Telescope Tags sangat berguna untuk menyatukan flow log dari Request -> Controller -> Action -> Repository.

### 3.1 Domain Model

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

final class Account extends Model
{
    protected $fillable = ['uuid', 'name', 'status', 'balance'];

    public function transactions(): HasMany
    {
        return $this->hasMany(Transaction::class);
    }
}
```

### 3.2 Form Request Validation

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class TransferFundRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'from_account_uuid' => ['required', 'uuid', 'exists:accounts,uuid'],
            'to_account_uuid' => ['required', 'uuid', 'exists:accounts,uuid', 'different:from_account_uuid'],
            'amount' => ['required', 'numeric', 'min:1'],
        ];
    }
}
```

### 3.3 Data Transfer Object (DTO)

```php
<?php

declare(strict_types=1);

namespace App\DTOs;

final readonly class TransferFundDTO
{
    public function __construct(
        public string $fromAccountUuid,
        public string $toAccountUuid,
        public float $amount,
    ) {}
}
```

### 3.4 Repository Layer

```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Models\Account;
use RuntimeException;

final class AccountRepository
{
    public function findByUuidLockForUpdate(string $uuid): Account
    {
        $account = Account::where('uuid', $uuid)->lockForUpdate()->first();
        
        if (! $account) {
            throw new RuntimeException("Account {$uuid} not found.");
        }

        return $account;
    }

    public function debit(Account $account, float $amount): void
    {
        $account->balance -= $amount;
        $account->save();
    }

    public function credit(Account $account, float $amount): void
    {
        $account->balance += $amount;
        $account->save();
    }
}
```

### 3.5 Action / Service Layer (The Core Logic)

```php
<?php

declare(strict_types=1);

namespace App\Actions;

use App\DTOs\TransferFundDTO;
use App\Repositories\AccountRepository;
use Illuminate\Support\Facades\DB;
use Laravel\Telescope\Telescope;
use Exception;
use Illuminate\Support\Facades\Log;

final readonly class TransferFundAction
{
    public function __construct(
        private AccountRepository $accountRepository
    ) {}

    public function execute(TransferFundDTO $dto): bool
    {
        // Custom Telescope Tagging untuk tracing mudah di dashboard
        Telescope::tag(function () use ($dto) {
            return ["transfer-flow:{$dto->fromAccountUuid}->{$dto->toAccountUuid}"];
        });

        Telescope::recordLog(
            name: 'info',
            message: 'Starting fund transfer process',
            context: ['amount' => $dto->amount]
        );

        try {
            DB::beginTransaction();

            $fromAccount = $this->accountRepository->findByUuidLockForUpdate($dto->fromAccountUuid);
            $toAccount = $this->accountRepository->findByUuidLockForUpdate($dto->toAccountUuid);

            if ($fromAccount->balance < $dto->amount) {
                Telescope::recordLog('warning', 'Insufficient funds', ['uuid' => $fromAccount->uuid]);
                throw new Exception('Insufficient funds.');
            }

            $this->accountRepository->debit($fromAccount, $dto->amount);
            $this->accountRepository->credit($toAccount, $dto->amount);

            DB::commit();
            
            Log::info("Transfer successful.");
            
            return true;
        } catch (Exception $e) {
            DB::rollBack();
            Log::error("Transfer failed: " . $e->getMessage());
            throw $e;
        }
    }
}
```

### 3.6 Controller

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Requests\TransferFundRequest;
use App\DTOs\TransferFundDTO;
use App\Actions\TransferFundAction;
use Illuminate\Http\JsonResponse;
use Exception;

final class TransferFundController extends Controller
{
    public function __invoke(TransferFundRequest $request, TransferFundAction $action): JsonResponse
    {
        $dto = new TransferFundDTO(
            fromAccountUuid: (string) $request->validated('from_account_uuid'),
            toAccountUuid: (string) $request->validated('to_account_uuid'),
            amount: (float) $request->validated('amount'),
        );

        try {
            $action->execute($dto);
            
            return response()->json([
                'message' => 'Transfer completed successfully.'
            ], 200);
        } catch (Exception $e) {
            return response()->json([
                'error' => $e->getMessage()
            ], 400);
        }
    }
}
```

**Bagaimana Profiling Bekerja di Sini?**
Ketika `TransferFundController` dieksekusi, Telescope secara otomatis merekam:
1. **HTTP RequestWatcher**: Method POST, Payload JSON, Headers, Status 200/400.
2. **QueryWatcher**: Menangkap `SELECT ... FOR UPDATE` dan `UPDATE` lengkap dengan transaction time (membantu profiling deadlock/slow query).
3. **LogWatcher**: Menangkap `Log::info` dan `Telescope::recordLog`.

---

## 4. Advanced Debugging & Telescope Features

### 4.1 Telescope Pruning (Mencegah Database Meledak)
Telescope merekam BANYAK data. Jika dibiarkan, tabel `telescope_entries` akan membengkak hingga jutaan baris dalam hitungan hari, memperlambat aplikasi.
Tambahkan command prune di `Console/Kernel.php` atau `routes/console.php` (Laravel 11+).

```php
<?php

declare(strict_types=1);

// routes/console.php

use Illuminate\Support\Facades\Schedule;

// Hapus data Telescope yang lebih tua dari 48 jam secara otomatis setiap hari
Schedule::command('telescope:prune --hours=48')->daily();
```

### 4.2 Mendeteksi N+1 Queries (N+1 Profiling)
Telescope adalah musuh terbesar N+1 queries. Anda bisa melihat di dashboard Telescope tab "Queries". Jika Anda melihat pola `SELECT * FROM transactions WHERE account_id = ?` diulang 50 kali dalam satu request, itu adalah N+1.
Selain Telescope, di Laravel 11 Anda bisa mengunci aplikasi secara strict:

```php
<?php
// AppServiceProvider.php
use Illuminate\Database\Eloquent\Model;

public function boot(): void
{
    // Mematikan lazy loading secara global (akan throw Exception jika N+1 terjadi)
    Model::preventLazyLoading(! $this->app->isProduction());
}
```

---

## 5. Anti-Patterns (❌ vs ✅)

### Anti-Pattern 1: Telescope Tidak Memiliki Filter Data Sensitif di Production (Security Breach)
Ketika Telescope dipaksa nyala di Production tanpa filtering, password user dan kredensial API akan terekam plain-text di database Telescope.

* ❌ **KODE SALAH (Tidak Mem-filter Request Params):**
```php
public function register(): void
{
    // Merekam SEMUANYA tanpa sensor
    Telescope::filter(function ($entry) {
        return true; 
    });
}
```

* ✅ **KODE BENAR (Masking PII & Sensitive Info):**
```php
public function register(): void
{
    Telescope::hideRequestParameters(['password', 'api_key', 'ccv', 'auth_token']);
    Telescope::hideRequestHeaders(['Authorization', 'Cookie']);

    Telescope::filter(function ($entry) {
        // Hanya record error 500 dan slow queries di production
        if ($this->app->environment('production')) {
             return $entry->isReportableException() || 
                    $entry->isFailedJob() || 
                    ($entry->type === 'query' && $entry->content['time'] > 200); // query > 200ms
        }
        return true;
    });
}
```
* **Mengapa Berbahaya:** Logging password atau PII melanggar GDPR/PCI-DSS. Jika DB Telescope bobol, attacker mendapatkan semua kredensial dalam bentuk plain-text.

### Anti-Pattern 2: Logging Object Penuh di Log/Telescope (Memory Leak Risk)
Terkadang developer mem-*passing* sebuah Eloquent Model yang sangat besar (dengan relationships) ke dalam Log atau event yang dilacak Telescope.

* ❌ **KODE SALAH (Passing Heavy Object ke Logger):**
```php
$user = User::with('posts.comments', 'orders')->find(1);
// Ini akan menserialisasi SELURUH object beserta relasinya, memakan MBs memory.
Log::info('User login detected', ['user' => $user]); 
```

* ✅ **KODE BENAR (Hanya Passing Identifier / Scalar Types):**
```php
$user = User::with('posts.comments', 'orders')->find(1);
// Hanya log ID dan atribut esensial yang diperlukan untuk investigasi.
Log::info('User login detected', [
    'user_id' => $user->id, 
    'email' => $user->email
]); 
```
* **Mengapa Berbahaya:** Menserialisasi Eloquent Model dengan relasi `toArray()` dalam skala besar akan menyebabkan *Memory Limit Exceeded* di PHP, dan memberatkan I/O penulisan JSON ke database Telescope (`content` column) yang mengakibatkan query log memakan waktu lebih lama dari request aslinya.

### Anti-Pattern 3: Meninggalkan `dump()` atau `dd()` di Production Code
Telescope memiliki `DumpWatcher`, tetapi jika method `dump()` terpanggil dalam loop atau flow utama, ini tetap membebani eksekusi PHP (meski ditangkap Telescope dan HTTP tidak terhenti, memory tetap dikonsumsi untuk refleksi dump). `dd()` lebih parah karena akan mematikan proses (*Die*).

* ❌ **KODE SALAH (Debugging Code Bocor):**
```php
public function calculateTotal(array $items): float
{
    $total = 0;
    foreach ($items as $item) {
        dump($item); // TERTINGGAL DI PRODUCTION
        $total += $item['price'];
    }
    return $total;
}
```

* ✅ **KODE BENAR (Menggunakan Pest Arch Testing Untuk Mencegah):**
Developer humanis sering lupa. Cegah dengan Architecture Testing. (Lihat bagian testing di bawah).

---

## 6. Pest v3: Unit & Architecture Testing

Dalam konteks debugging & profiling, test arsitektur sangat krusial untuk memastikan kode-kode kotor (seperti `dd`, `dump`, `ray`, `env()`) tidak bocor ke master branch / production. 

### 6.1 Architecture Testing (Pencegahan Debugging di Production)

```php
<?php

declare(strict_types=1);

// tests/ArchTest.php

uses()->group('architecture');

it('does not contain debugging functions')
    ->expect(['dd', 'dump', 'var_dump', 'print_r', 'ray', 'die'])
    ->not->toBeUsed();

it('does not use env helper outside of config files')
    ->expect('env')
    ->not->toBeUsed()
    ->ignoring('config'); // env() HANYA boleh dipanggil di direktori config/

it('ensures controllers only depend on actions or form requests')
    ->expect('App\Http\Controllers')
    ->toOnlyUse([
        'App\Http\Requests',
        'App\DTOs',
        'App\Actions',
        'Illuminate\Http\JsonResponse',
        'Illuminate\Http\Request',
        'Illuminate\Routing\Controller',
        'Exception',
    ]);
```

### 6.2 Unit/Feature Testing (Testing Action Layer dengan Fakes)

Kita akan men-test `TransferFundAction` dan memastikan repository dipanggil dengan benar.

```php
<?php

declare(strict_types=1);

// tests/Feature/TransferFundActionTest.php

use App\Actions\TransferFundAction;
use App\DTOs\TransferFundDTO;
use App\Models\Account;
use App\Repositories\AccountRepository;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Laravel\Telescope\Telescope;
use Mockery\MockInterface;

uses()->group('feature', 'banking');

beforeEach(function () {
    // Fake Log untuk memastikan kita tidak benar-benar menulis ke file log saat testing
    Log::spy();
});

it('transfers funds successfully between two accounts', function () {
    // Arrange: Create fake accounts (Mocking Repository)
    $fromAccount = new Account(['uuid' => 'acc-1', 'balance' => 1000.0]);
    $toAccount = new Account(['uuid' => 'acc-2', 'balance' => 500.0]);
    
    $dto = new TransferFundDTO('acc-1', 'acc-2', 300.0);

    $this->mock(AccountRepository::class, function (MockInterface $mock) use ($fromAccount, $toAccount) {
        $mock->shouldReceive('findByUuidLockForUpdate')->with('acc-1')->once()->andReturn($fromAccount);
        $mock->shouldReceive('findByUuidLockForUpdate')->with('acc-2')->once()->andReturn($toAccount);
        
        $mock->shouldReceive('debit')->with($fromAccount, 300.0)->once();
        $mock->shouldReceive('credit')->with($toAccount, 300.0)->once();
    });

    DB::shouldReceive('beginTransaction')->once();
    DB::shouldReceive('commit')->once();
    DB::shouldReceive('rollBack')->never();

    $action = app(TransferFundAction::class);

    // Act
    $result = $action->execute($dto);

    // Assert
    expect($result)->toBeTrue();
    Log::shouldHaveReceived('info')->with('Transfer successful.');
});

it('throws exception and rolls back transaction on insufficient funds', function () {
    // Arrange
    $fromAccount = new Account(['uuid' => 'acc-1', 'balance' => 100.0]); // Cuma 100
    $toAccount = new Account(['uuid' => 'acc-2', 'balance' => 500.0]);
    
    $dto = new TransferFundDTO('acc-1', 'acc-2', 300.0); // Mau transfer 300

    $this->mock(AccountRepository::class, function (MockInterface $mock) use ($fromAccount, $toAccount) {
        $mock->shouldReceive('findByUuidLockForUpdate')->with('acc-1')->once()->andReturn($fromAccount);
        $mock->shouldReceive('findByUuidLockForUpdate')->with('acc-2')->once()->andReturn($toAccount);
        
        $mock->shouldReceive('debit')->never();
        $mock->shouldReceive('credit')->never();
    });

    DB::shouldReceive('beginTransaction')->once();
    DB::shouldReceive('commit')->never();
    DB::shouldReceive('rollBack')->once(); // Pastikan Rollback Terjadi

    $action = app(TransferFundAction::class);

    // Act & Assert
    expect(fn() => $action->execute($dto))
        ->toThrow(Exception::class, 'Insufficient funds.');
        
    Log::shouldHaveReceived('error')->withArgs(function ($message) {
        return str_contains($message, 'Transfer failed');
    });
});
```

## 7. Kesimpulan Profiling Pro
- **Jangan matikan buta-buta**. Telescope di production berguna JIKA di-filter hanya merekam exception dan slow query.
- **Telescope Tagging** (`Telescope::tag()`) adalah senjata rahasia untuk micro-tracing flow di Laravel Monolith tanpa perlu APM eksternal mahal seperti Datadog.
- Selalu sandingkan arsitektur kode dengan **Architecture Test (Pest)** agar tidak ada syntax debugging trivial yang bocor dan merusak *memory footprint* di production.
