# Laravel Mastery: Atomic Locks (Concurrency)

Atomic Locks di Laravel menyediakan mekanisme handal untuk memastikan bahwa sebuah proses kritis hanya dieksekusi oleh satu *worker* atau *request* pada satu waktu. Terutama ketika menggunakan Redis atau Memcached sebagai *cache driver*, *atomic locks* sangat esensial untuk mencegah *race conditions* pada sistem terdistribusi, seperti pemrosesan pembayaran, sinkronisasi inventaris, atau *cron jobs* yang tidak boleh berjalan ganda.

Dokumen ini adalah panduan *Top 1% Quality* untuk menguasai Atomic Locks di ekosistem Laravel 11/12 dengan PHP 8.3/8.4.

## 1. Arsitektur & Eksekusi Kritis

Dalam *Clean Architecture*, pengaturan *lock* sebaiknya tidak dilakukan di *Controller* atau *Model*, melainkan di *Action* atau *Service layer*. Hal ini memastikan bahwa logika bisnis utama terisolasi dan *controller* hanya menangani HTTP/Transport.

### 1.1 Konfigurasi Redis & Cache

Pastikan Anda menggunakan `redis` atau `memcached` di `config/cache.php` karena *file* atau *database driver* mungkin tidak secepat dan seandal sistem *in-memory* untuk *high concurrency*.

### 1.2 Implementasi Clean Architecture: Sinkronisasi Inventaris

Berikut adalah contoh produksi untuk sinkronisasi inventaris menggunakan *Clean Architecture*.

#### A. Form Request (Validasi)
```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Inventory;

use Illuminate\Foundation\Http\FormRequest;

final class SyncInventoryRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'product_id' => ['required', 'string', 'uuid', 'exists:products,id'],
            'quantity'   => ['required', 'integer', 'min:1'],
        ];
    }
}
```

#### B. DTO (Data Transfer Object)
```php
<?php

declare(strict_types=1);

namespace App\DTOs\Inventory;

final readonly class SyncInventoryDTO
{
    public function __construct(
        public string $productId,
        public int $quantity,
    ) {}
}
```

#### C. Action (Bisnis Logika & Atomic Lock)
```php
<?php

declare(strict_types=1);

namespace App\Actions\Inventory;

use App\DTOs\Inventory\SyncInventoryDTO;
use App\Exceptions\Inventory\SyncInProgressException;
use Illuminate\Contracts\Cache\LockProvider;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

final readonly class SyncInventoryAction
{
    public function __construct(
        private UpdateInventoryRepository $repository
    ) {}

    /**
     * @throws SyncInProgressException
     */
    public function execute(SyncInventoryDTO $dto): bool
    {
        $lockKey = sprintf('sync_inventory:%s', $dto->productId);
        
        // Meminta lock selama 10 detik. Jika gagal mendapatkannya, akan melempar LockTimeoutException
        // Metode block() akan menunggu hingga 5 detik jika lock sedang digunakan
        $lock = Cache::lock($lockKey, 10);

        try {
            // Block selama 5 detik untuk mendapatkan lock
            if (! $lock->block(5)) {
                throw new SyncInProgressException("Product {$dto->productId} is currently being synced.");
            }

            Log::info("Lock acquired for product {$dto->productId}");

            // Eksekusi repository (Database Transaction diurus di repository atau dibungkus di sini)
            $this->repository->update($dto->productId, $dto->quantity);

            return true;
        } catch (\Illuminate\Contracts\Cache\LockTimeoutException $e) {
            Log::warning("Timeout waiting for lock on product {$dto->productId}");
            throw new SyncInProgressException("Timeout. Product {$dto->productId} is currently being synced.", 423, $e);
        } finally {
            // ALWAYS release the lock in a finally block to prevent deadlocks
            // optional() is used in case block() failed and lock wasn't actually acquired,
            // but in modern Laravel, release() is safe to call.
            $lock?->release();
            Log::info("Lock released for product {$dto->productId}");
        }
    }
}
```

#### D. Controller
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Inventory;

use App\Http\Controllers\Controller;
use App\Http\Requests\Inventory\SyncInventoryRequest;
use App\DTOs\Inventory\SyncInventoryDTO;
use App\Actions\Inventory\SyncInventoryAction;
use App\Exceptions\Inventory\SyncInProgressException;
use Illuminate\Http\JsonResponse;

final class SyncInventoryController extends Controller
{
    public function __construct(
        private readonly SyncInventoryAction $action
    ) {}

    public function __invoke(SyncInventoryRequest $request): JsonResponse
    {
        $dto = new SyncInventoryDTO(
            productId: $request->validated('product_id'),
            quantity: (int) $request->validated('quantity'),
        );

        try {
            $this->action->execute($dto);

            return response()->json([
                'status' => 'success',
                'message' => 'Inventory synchronized successfully.',
            ]);
        } catch (SyncInProgressException $e) {
            return response()->json([
                'status' => 'error',
                'message' => $e->getMessage(),
            ], 423); // 423 Locked
        }
    }
}
```

## 2. Anti-Patterns & Best Practices

Atomic Locks sangat rentan terhadap *deadlock* atau *stale locks* jika tidak ditangani dengan benar. Berikut adalah pola yang salah dan solusinya.

### 2.1 Anti-Pattern 1: Tidak Melepas Lock Saat Exception Terjadi

❌ **KODE SALAH (Menyebabkan Deadlock / Stale Lock)**
```php
<?php
// ...
public function processPayment(string $orderId): void
{
    $lock = Cache::lock('payment:'.$orderId, 30);
    
    if ($lock->get()) {
        // Jika chargeGateway melempar exception (misal jaringan down), 
        // lock tidak pernah dilepas dan order akan tersangkut selama 30 detik!
        $this->gateway->charge($orderId);
        
        $lock->release();
    }
}
```
**Mengapa Berbahaya:** Jika operasi di dalam *lock* gagal atau menghasilkan *Exception*, eksekusi akan keluar dari blok tanpa memanggil `$lock->release()`. Akibatnya, *lock* akan tetap aktif (*stale*) hingga kedaluwarsa, mengunci proses lain tanpa alasan yang valid.

✅ **KODE BENAR (Menggunakan `finally` atau blok Closure)**
```php
<?php
// ...
public function processPayment(string $orderId): void
{
    // Cara 1: Menggunakan Closure (Laravel akan otomatis release lock)
    Cache::lock('payment:'.$orderId, 30)->get(function () use ($orderId) {
        $this->gateway->charge($orderId);
    });
    
    // Cara 2: Menggunakan Try-Finally (Lebih fleksibel)
    $lock = Cache::lock('payment:'.$orderId, 30);
    if ($lock->get()) {
        try {
            $this->gateway->charge($orderId);
        } finally {
            $lock->release();
        }
    }
}
```

### 2.2 Anti-Pattern 2: Waktu Lock (TTL) Tidak Rasional

❌ **KODE SALAH (TTL terlalu pendek / terlalu lama)**
```php
<?php
// Mengambil lock untuk report generation yang butuh 5 menit, tapi lock cuma 10 detik
$lock = Cache::lock('generate_report', 10);
if ($lock->get()) {
    try {
        $this->reportService->generateMassiveReport(); // Butuh 300 detik
    } finally {
        $lock->release();
    }
}
```
**Mengapa Berbahaya:** Jika TTL *lock* lebih cepat habis dibandingkan waktu eksekusi skrip, proses lain akan bisa mendapatkan *lock* tersebut padahal *worker* pertama masih bekerja. Ini menyebabkan *race condition*. Sebaliknya, jika TTL sangat panjang (misal 1 jam) dan *worker* crash sebelum `finally` dieksekusi (contoh: *OOM kill*), sistem akan lumpuh selama 1 jam menunggu *lock* kedaluwarsa otomatis.

✅ **KODE BENAR (TTL Rasional + Lock Extension)**
```php
<?php
// ...
public function generateReport(): void
{
    // Beri TTL yang masuk akal, lebih dari rata-rata tapi tidak selamanya
    $lock = Cache::lock('generate_report', 120);

    if ($lock->get()) {
        try {
            // Jika prosesnya butuh looping panjang, kita bisa extend lock
            foreach ($this->getChunks() as $chunk) {
                $this->processChunk($chunk);
                // Menghidupkan kembali lock ke 120 detik lagi dari sekarang
                $lock->betweenSeconds(120); 
            }
        } finally {
            $lock->release();
        }
    }
}
```
*(Catatan: Metode ekstensif mungkin membutuhkan manipulasi cache manual tergantung pada driver, tetapi secara konsep ini mencegah stale/expired lock)*

## 3. Pest v3 Testing (Architecture & Unit)

Kode produksi *Top 1%* wajib dites secara komprehensif. Kita menggunakan *Pest v3* dengan arsitektur tes dan pengujian fitur untuk *mocking cache*.

### 3.1 Architecture Testing (`tests/ArchTest.php`)
```php
<?php

declare(strict_types=1);

arch('actions should not use global request helper')
    ->expect('App\Actions')
    ->not->toUse('request')
    ->not->toUse('session');

arch('actions should be final')
    ->expect('App\Actions')
    ->toBeClasses()
    ->toBeFinal();
```

### 3.2 Unit/Feature Testing (`tests/Feature/Actions/SyncInventoryActionTest.php`)
```php
<?php

declare(strict_types=1);

use App\Actions\Inventory\SyncInventoryAction;
use App\DTOs\Inventory\SyncInventoryDTO;
use App\Exceptions\Inventory\SyncInProgressException;
use App\Actions\Inventory\UpdateInventoryRepository;
use Illuminate\Support\Facades\Cache;
use Illuminate\Contracts\Cache\Lock;
use Illuminate\Contracts\Cache\LockTimeoutException;
use Mockery\MockInterface;

it('successfully acquires lock and syncs inventory', function () {
    // Arrange
    $dto = new SyncInventoryDTO('prod-123', 50);
    
    $repositoryMock = $this->mock(UpdateInventoryRepository::class, function (MockInterface $mock) {
        $mock->shouldReceive('update')
             ->once()
             ->with('prod-123', 50);
    });

    // Mocking the Cache::lock facade behavior
    $lockMock = $this->mock(Lock::class, function (MockInterface $mock) {
        $mock->shouldReceive('block')
             ->with(5)
             ->once()
             ->andReturn(true);
             
        $mock->shouldReceive('release')
             ->once();
    });

    Cache::shouldReceive('lock')
         ->once()
         ->with('sync_inventory:prod-123', 10)
         ->andReturn($lockMock);

    $action = app(SyncInventoryAction::class);

    // Act
    $result = $action->execute($dto);

    // Assert
    expect($result)->toBeTrue();
});

it('throws exception when lock cannot be acquired within timeout', function () {
    // Arrange
    $dto = new SyncInventoryDTO('prod-456', 20);
    
    // Repository should not be called
    $this->mock(UpdateInventoryRepository::class, function (MockInterface $mock) {
        $mock->shouldNotReceive('update');
    });

    $lockMock = $this->mock(Lock::class, function (MockInterface $mock) {
        // Simulasi block timeout
        $mock->shouldReceive('block')
             ->with(5)
             ->once()
             ->andThrow(new LockTimeoutException());
             
        // Release must still be called in finally!
        $mock->shouldReceive('release')
             ->once();
    });

    Cache::shouldReceive('lock')
         ->once()
         ->with('sync_inventory:prod-456', 10)
         ->andReturn($lockMock);

    $action = app(SyncInventoryAction::class);

    // Act & Assert
    expect(fn () => $action->execute($dto))
        ->toThrow(SyncInProgressException::class, 'Timeout. Product prod-456 is currently being synced.');
});
```

## 4. Kesimpulan

- *Atomic Locks* adalah pertahanan terbaik melawan *double execution* di *background worker* atau *concurrent HTTP requests*.
- Gunakan blok `try...finally` atau `get(Closure)` untuk memastikan *lock release*.
- Isolasi logika ke dalam *Action/Service* untuk mempermudah tes *mocking* tanpa menyentuh *controller/routing*.
- Pilih *cache driver* yang didesain untuk *concurrency* (`redis` dengan `predis/phpredis`).
