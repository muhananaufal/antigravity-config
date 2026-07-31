# Laravel Octane: High-Performance Architecture (FrankenPHP, Swoole & RoadRunner)

Ekosistem Laravel Octane membawa revolusi besar ke dunia PHP dengan mengubah paradigma eksekusi dari *stateless, short-lived processes* (satu proses per request seperti di PHP-FPM) menjadi *persistent, long-running processes*. Octane melakukan bootstrapping framework Laravel hanya satu kali di awal, lalu menjaga memori tetap hidup untuk melayani request-request berikutnya dengan kecepatan tinggi.

Artikel ini akan mengupas tuntas arsitektur Octane, perbedaan *engine* di baliknya (FrankenPHP, Swoole, RoadRunner), manajemen memori tingkat lanjut, *Clean Architecture*, hingga *Anti-Patterns* yang dapat merusak aplikasi Octane Anda, dan diakhiri dengan *Testing* menggunakan Pest v3.

---

## 1. Arsitektur & Pilihan Engine: FrankenPHP vs Swoole vs RoadRunner

Octane tidak bekerja sendiri; ia bergantung pada *Application Server* atau *Engine* yang berjalan secara *persistent*.

### A. FrankenPHP (Recommended / Modern Standard)
FrankenPHP adalah *app server* PHP modern yang ditulis dalam bahasa **Go** dan dibangun di atas web server **Caddy**.
- **Kelebihan Utama**: Terintegrasi langsung dengan modul Caddy, dukungan HTTP/3 otomatis, kompresi otomatis (Brotli/Gzip), Early Hints (103), serta **Worker Mode** yang dapat me-reuse memori PHP.
- **Konkurensi**: Berbasis Go routines yang sangat ringan.
- **Security**: Mendukung otomatisasi Let's Encrypt / TLS dari Caddy.
- **Performance**: Sangat cepat karena PHP dieksekusi menggunakan CGO secara terintegrasi dengan server HTTP Go tanpa perantara seperti FastCGI.

### B. Swoole
Swoole adalah ekstensi PHP (C-based) yang membawa *event-driven, asynchronous, non-blocking I/O*, dan coroutines ke dalam PHP.
- **Kelebihan Utama**: Ekosistem yang sudah sangat matang untuk *high concurrency*, TCP/UDP server, *WebSockets* (tanpa butuh Pusher/Reverb), dan task workers.
- **Fitur Spesifik Octane**: `Octane::concurrently()` berjalan optimal di atas Swoole Task Workers. Octane Table (`Octane::table()`) untuk *shared memory* antar worker dan `Octane::tick()` untuk penjadwalan interval millisecond.
- **Kerumitan**: Memerlukan instalasi ekstensi PECL yang cukup *tricky* di beberapa OS, dan Anda tidak boleh sembarangan memblokir *event loop* jika menggunakan coroutines (meski Octane sendiri secara default belum menggunakan Coroutine secara *full* untuk request handling, melainkan berbasis *Task Worker*).

### C. RoadRunner
Sama seperti FrankenPHP, RoadRunner ditulis menggunakan **Go**, namun bekerja dengan protokol **goridge** (RPC) antara Go server dan PHP workers.
- **Kelebihan Utama**: Sangat stabil, *agnostic* terhadap framework, memori lebih terkontrol jika dibandingkan ekstensi C seperti Swoole, mudah di-deploy di Kubernetes.
- **Kerumitan**: Dibutuhkan proses konversi payload HTTP via RPC, sehingga secara teoritis sedikit *overhead* dibanding FrankenPHP.

---

## 2. Manajemen Memori & State: Paradigma Baru

Hal terpenting dalam Octane adalah memahami bahwa **memori tidak di-flush otomatis di akhir request**.
Objek yang Anda *instantiate* dan daftarkan sebagai Singleton di Laravel Service Container akan **bertahan (persist)** untuk request selanjutnya.
Ini luar biasa untuk performa (koneksi DB, konfigurasi, instance class besar hanya di-load sekali), namun fatal jika salah digunakan (Memory Leaks, State Bleed antar user).

### Octane Lifecycle & Dependency Injection
- **Bootstrapping**: Saat worker menyala, Laravel melakukan *boot* framework, memanggil method `register` dan `boot` pada Service Providers.
- **Request Handling**: Octane meng-clone *sandbox* dari container untuk setiap request. Container utama (application) tetap utuh. Namun, instance yang sudah resolve sebagai singleton di aplikasi utama **tidak** akan di-resolve ulang.

---

## 3. Anti-Patterns & Best Practices pada Octane

Kesalahan paling umum di Octane berkaitan dengan *State Leakage* (data request A bocor ke request B) dan *Memory Leaks* (memori membengkak hingga worker mati).

### ❌ Anti-Pattern 1: Menyimpan Request State di Static Property atau Singleton
Karena proses worker hidup lama, *static property* dan singleton class akan mempertahankan nilainya lintas request. Jika Anda menyimpan ID user yang sedang login di static property, user B bisa saja terotentikasi sebagai user A.

```php
<?php

declare(strict_types=1);

namespace App\Services;

use App\Models\User;

// ❌ KODE SALAH: State Leakage Risk & Memory Risk
class UserContextService
{
    // Static property ini TIDAK di-reset antar request di Octane
    private static ?User $currentUser = null;
    
    // Atau jika service ini di-bind sebagai Singleton di AppServiceProvider:
    private ?User $activeUser = null;

    public function setCurrentUser(User $user): void
    {
        self::$currentUser = $user;
        $this->activeUser = $user;
    }

    public function processTransaction(float $amount): void
    {
        // Bahaya! Jika request selanjutnya tidak memanggil setCurrentUser,
        // transaksi ini akan dieksekusi atas nama user dari request sebelumnya!
        $user = self::$currentUser ?? $this->activeUser;
        $user->balance -= $amount;
        $user->save();
    }
}
```

#### ✅ Solusi 1: Hindari State di Singleton / Static, Gunakan Method Injection atau Context
Di Laravel 11+, manfaatkan `Illuminate\Support\Context` untuk *contextual data* yang aman pada sistem asinkron, atau *pass* state via argument method.

```php
<?php

declare(strict_types=1);

namespace App\Services;

use App\Models\User;
use Illuminate\Support\Context;

// ✅ KODE BENAR: Stateless Service
class UserContextService
{
    /**
     * Stateless method, request state dipassing sebagai argumen.
     */
    public function processTransaction(User $user, float $amount): void
    {
        $user->balance -= $amount;
        $user->save();
    }
    
    /**
     * Atau memanfaatkan Laravel Context (Aman di Octane)
     */
    public function logActivity(string $action): void
    {
        // Context aman digunakan di Octane karena otomatis dikelola per-request
        $userId = Context::get('auth_user_id');
        
        if ($userId) {
            // Proses logging
        }
    }
}
```

### ❌ Anti-Pattern 2: Ketergantungan Langsung (Injection) Objek `Request` pada Singleton
Jika Anda membuat Singleton service dan meng-inject `Illuminate\Http\Request` ke constructor-nya, `Request` yang masuk adalah request *pertama* saat worker di-booting. Request kedua dan seterusnya akan tetap menggunakan payload request pertama.

```php
<?php

declare(strict_types=1);

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use Illuminate\Http\Request;
use App\Services\SearchFilterService;

// ❌ KODE SALAH
class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(SearchFilterService::class, function ($app) {
            // Bahaya! Request object di-cache selamanya di dalam Singleton ini.
            return new SearchFilterService($app->make(Request::class));
        });
    }
}
```

#### ✅ Solusi 2: Gunakan Scoped Bindings, Closure, atau Facade
Jika suatu objek membutuhkan request saat ini, jangan simpan di *constructor singleton*. Gunakan method argument atau *binding scoped*.

```php
<?php

declare(strict_types=1);

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use App\Services\SearchFilterService;
use Illuminate\Contracts\Foundation\Application;

// ✅ KODE BENAR
class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Gunakan `scoped` (di-flush setiap akhir request)
        $this->app->scoped(SearchFilterService::class, function (Application $app) {
            return new SearchFilterService($app->make('request'));
        });
    }
}
```

---

## 4. Implementasi Clean Architecture dengan Octane (Strict Types & High Performance)

Berikut adalah contoh tumpukan arsitektur yang 100% aman di Octane, berkinerja tinggi, dan strongly typed.
Alur: `FormRequest` -> `Controller` -> `Service` (Stateless) -> `Repository` -> `Model`.

### A. Controller (Entry Point)

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\V1\TransferFundRequest;
use App\Services\Banking\TransferService;
use App\Http\Resources\TransactionResource;
use Illuminate\Http\JsonResponse;

final class TransferController extends Controller
{
    // Konstruktor injection aman asalkan TransferService bersifat Stateless
    public function __construct(
        private readonly TransferService $transferService
    ) {}

    public function __invoke(TransferFundRequest $request): JsonResponse
    {
        // Data request divalidasi oleh FormRequest.
        // Semua stateful context dioper sebagai parameter.
        $transaction = $this->transferService->executeTransfer(
            senderId: $request->user()->id,
            receiverId: $request->validated('receiver_id'),
            amount: (float) $request->validated('amount')
        );

        return response()->json([
            'message' => 'Transfer successful',
            'data'    => new TransactionResource($transaction),
        ], 201);
    }
}
```

### B. Service / Action (Business Logic)

Service layer harus benar-benar *stateless* dan tidak menyimpan property instance yang berubah-ubah per-request.

```php
<?php

declare(strict_types=1);

namespace App\Services\Banking;

use App\Repositories\Contracts\TransactionRepositoryInterface;
use App\Repositories\Contracts\UserRepositoryInterface;
use App\Models\Transaction;
use Illuminate\Database\DatabaseManager;
use RuntimeException;
use Throwable;

final readonly class TransferService
{
    public function __construct(
        private UserRepositoryInterface $userRepository,
        private TransactionRepositoryInterface $transactionRepository,
        private DatabaseManager $db
    ) {}

    /**
     * Execute a fund transfer safely inside a transaction.
     *
     * @throws RuntimeException
     */
    public function executeTransfer(int $senderId, int $receiverId, float $amount): Transaction
    {
        if ($amount <= 0) {
            throw new RuntimeException('Amount must be greater than zero.');
        }

        try {
            return $this->db->transaction(function () use ($senderId, $receiverId, $amount): Transaction {
                // Lock row to prevent race conditions (Penting untuk sistem concurrent)
                $sender = $this->userRepository->findByIdForUpdate($senderId);
                
                if (! $sender || $sender->balance < $amount) {
                    throw new RuntimeException('Insufficient balance.');
                }

                $receiver = $this->userRepository->findByIdForUpdate($receiverId);
                if (! $receiver) {
                    throw new RuntimeException('Receiver not found.');
                }

                // Mutasi saldo
                $this->userRepository->decrementBalance($sender, $amount);
                $this->userRepository->incrementBalance($receiver, $amount);

                // Catat transaksi
                return $this->transactionRepository->create([
                    'sender_id'   => $sender->id,
                    'receiver_id' => $receiver->id,
                    'amount'      => $amount,
                    'status'      => 'COMPLETED',
                ]);
            });
        } catch (Throwable $e) {
            throw new RuntimeException('Transfer failed: ' . $e->getMessage(), previous: $e);
        }
    }
}
```

### C. Konkurensi Tingkat Lanjut dengan `Octane::concurrently`

Jika menggunakan Swoole, Anda bisa memproses data IO-bound secara paralel dalam satu request untuk menekan response time.

```php
<?php

declare(strict_types=1);

namespace App\Services\Analytics;

use Laravel\Octane\Facades\Octane;
use App\Services\Api\ExternalStockService;
use App\Services\Api\ExternalWeatherService;

final readonly class DashboardService
{
    public function __construct(
        private ExternalStockService $stockService,
        private ExternalWeatherService $weatherService
    ) {}

    public function getDashboardData(string $city, string $ticker): array
    {
        // 🚀 KODE BENAR: Menjalankan task secara paralel (hanya didukung di Swoole & FrankenPHP tertentu)
        // Mengeksekusi kedua closure bersamaan, mempersingkat waktu respon secara drastis
        [$weather, $stock] = Octane::concurrently([
            fn () => $this->weatherService->fetchCurrentWeather($city),
            fn () => $this->stockService->fetchCurrentPrice($ticker),
        ]);

        return [
            'weather' => $weather,
            'stock'   => $stock,
        ];
    }
}
```

---

## 5. Testing & Verification (Pest v3)

Saat berhadapan dengan *persistent environment*, pengetesan struktural (Architecture Testing) menjadi krusial untuk mencegah kebocoran *state*. Pest v3 sangat powerful untuk ini.

### A. Architecture Testing untuk Mencegah Kebocoran State

File: `tests/Arch/StatelessServicesTest.php`
```php
<?php

declare(strict_types=1);

test('services should not contain mutable properties')
    ->expect('App\Services')
    ->classes()
    ->toBeReadonly()
    ->because('Services in Octane must be readonly to prevent state bleeding between requests.');

test('no static properties allowed in Http layer')
    ->expect('App\Http')
    ->not->toHaveStaticProperties()
    ->because('Static properties persist across requests in Octane, leading to data leaks.');
    
test('controllers should not be singletons')
    ->expect('App\Http\Controllers')
    ->not->toBeInterfaces(); // ensure they remain instantiable normally
```

### B. Unit & Feature Testing (Strict Types)

File: `tests/Feature/TransferControllerTest.php`
```php
<?php

declare(strict_types=1);

use App\Models\User;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Cache;
use App\Services\Banking\TransferService;
use Mockery\MockInterface;
use function Pest\Laravel\actingAs;
use function Pest\Laravel\postJson;

it('successfully transfers funds between two users', function (): void {
    // Arrange
    $sender = User::factory()->create(['balance' => 1000]);
    $receiver = User::factory()->create(['balance' => 0]);

    // Act
    $response = actingAs($sender)
        ->postJson('/api/v1/transfer', [
            'receiver_id' => $receiver->id,
            'amount'      => 500,
        ]);

    // Assert
    $response->assertCreated()
             ->assertJsonPath('data.status', 'COMPLETED')
             ->assertJsonPath('data.amount', 500);

    expect($sender->refresh()->balance)->toBe(500.0)
          ->and($receiver->refresh()->balance)->toBe(500.0);
});

it('fails gracefully when balance is insufficient', function (): void {
    $sender = User::factory()->create(['balance' => 100]);
    $receiver = User::factory()->create(['balance' => 0]);

    $response = actingAs($sender)
        ->postJson('/api/v1/transfer', [
            'receiver_id' => $receiver->id,
            'amount'      => 500, // melebihi saldo
        ]);

    $response->assertStatus(500) // atau 400 tergantung implementasi exception handler
             ->assertJsonPath('message', fn (string $msg) => str_contains($msg, 'Insufficient balance'));

    // Pastikan tidak ada uang terpotong
    expect($sender->refresh()->balance)->toBe(100.0)
          ->and($receiver->refresh()->balance)->toBe(0.0);
});

it('uses fakes to isolate service logic in specific scenarios', function (): void {
    $sender = User::factory()->create();
    
    // Mocking the Service to force a failure scenario
    $this->mock(TransferService::class, function (MockInterface $mock) {
        $mock->shouldReceive('executeTransfer')
             ->once()
             ->andThrow(new RuntimeException('DB Deadlock Detected'));
    });

    $response = actingAs($sender)
        ->postJson('/api/v1/transfer', [
            'receiver_id' => 999,
            'amount'      => 100,
        ]);

    $response->assertStatus(500);
});
```

---

## 6. Tuning & Deployment Tips (FrankenPHP)

Jika Anda mendeploy menggunakan FrankenPHP dan Octane, Anda perlu melakukan *tuning* pada konfigurasi `octane.php`.

```php
// config/octane.php

return [
    'server' => env('OCTANE_SERVER', 'frankenphp'),

    'listeners' => [
        // Sangat penting: Mereset state container/fasad tertentu per-request
        ResetProviders::class,
        FlushLocaleState::class,
        FlushMonologState::class,
    ],

    // FrankenPHP & Swoole Worker configuration
    'frankenphp' => [
        // Berapa jumlah request sebelum worker di-restart (Mencegah PHP memory leaks C-level)
        'max_requests' => 500,
    ],
    
    'garbage_collection' => [
        // Menjalankan gc_collect_cycles() saat worker memakan memory lebih dari batas ini (MB)
        'check_interval' => 50,
        'threshold' => 128,
    ],
];
```

**Kesimpulan:**
Octane membawa kecepatan tak terhingga untuk Laravel, namun menuntut disiplin tingkat tinggi. Dengan menerapkan *Clean Architecture*, *Stateless Services*, dan mengamankan properti via *Readonly Classes*, Anda mendapatkan performa ala Go/Node.js dipadukan dengan keindahan sintaks PHP dan ekosistem Laravel. Pastikan Anda mengawal *codebase* dengan ketat menggunakan *Architecture Testing* via Pest.
