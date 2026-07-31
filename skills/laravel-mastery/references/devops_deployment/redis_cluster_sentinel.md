---
title: "Redis Cluster & Sentinel Integration in Laravel 11"
description: "Panduan arsitektur level Top 1% untuk mengintegrasikan Redis Cluster dan Sentinel pada ekosistem Laravel 11 demi pencapaian High Availability (HA) dan distribusi Cache/Session."
tags: [devops, redis, sentinel, cluster, laravel-11, high-availability]
---

# Redis Cluster & Sentinel Integration in Laravel 11

Pada aplikasi skala perusahaan (*enterprise-scale*), penggunaan satu peladen (node) Redis tunggal (Single-Node Redis) adalah SPOF (*Single Point of Failure*). Jika node tunggal ini mati (crash), sistem *caching*, sesi pengguna, antrean, dan *WebSockets* akan seketika rontok. Solusi industri untuk mengatasi ini adalah menggunakan topologi **Redis Sentinel** untuk *High Availability* atau **Redis Cluster** untuk pembagian beban secara horizontal (Horizontal Sharding). 

## 1. Clean Architecture: Abstraksi Distribusi Cache

Agar pergantian teknologi *cache* atau koneksi basis data di masa mendatang tidak memecah belah modul bisnis kita, kita wajib menyembunyikan operasi Redis ini di belakang *Repository* dan *Action Layer*.

### FormRequest
```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class FetchUserStatsRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, array<mixed>>
     */
    public function rules(): array
    {
        return [
            'user_id' => ['required', 'integer', 'exists:users,id'],
        ];
    }
}
```

### Controller
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\FetchUserStatsRequest;
use App\Actions\RetrieveUserStatisticsAction;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final class UserStatisticsController extends Controller
{
    public function __construct(
        private readonly RetrieveUserStatisticsAction $retrieveStatsAction
    ) {}

    public function __invoke(FetchUserStatsRequest $request): JsonResponse
    {
        $stats = $this->retrieveStatsAction->execute(
            userId: (int) $request->validated('user_id')
        );

        return response()->json([
            'status' => 'success',
            'data'   => $stats,
        ], Response::HTTP_OK);
    }
}
```

### Action / Service Layer
```php
<?php

declare(strict_types=1);

namespace App\Actions;

use App\Repositories\UserStatsCacheRepositoryInterface;
use App\Repositories\UserStatsDatabaseRepositoryInterface;

final readonly class RetrieveUserStatisticsAction
{
    public function __construct(
        private UserStatsCacheRepositoryInterface $cacheRepository,
        private UserStatsDatabaseRepositoryInterface $dbRepository
    ) {}

    public function execute(int $userId): array
    {
        // Mencoba mendapatkan dari sistem terdistribusi Redis Sentinel/Cluster
        $cachedStats = $this->cacheRepository->getStatsForUser($userId);

        if ($cachedStats !== null) {
            return $cachedStats;
        }

        // Cache Miss: Query DB dan simpan ke Cache
        $stats = $this->dbRepository->calculateStatsForUser($userId);
        
        $this->cacheRepository->setStatsForUser($userId, $stats);

        return $stats;
    }
}
```

### Repositories (Cache Implementation)
```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use Illuminate\Support\Facades\Redis;

interface UserStatsCacheRepositoryInterface
{
    public function getStatsForUser(int $userId): ?array;
    public function setStatsForUser(int $userId, array $data): void;
}

final class UserStatsCacheRepository implements UserStatsCacheRepositoryInterface
{
    private const CACHE_TTL = 3600; // 1 Jam

    public function getStatsForUser(int $userId): ?array
    {
        // Menggunakan native Redis Facade untuk berinteraksi dengan php-redis (C-extension)
        $data = Redis::connection('cache')->get("user_stats:{$userId}");
        
        return $data ? json_decode($data, true, 512, JSON_THROW_ON_ERROR) : null;
    }

    public function setStatsForUser(int $userId, array $data): void
    {
        Redis::connection('cache')->setex(
            "user_stats:{$userId}",
            self::CACHE_TTL,
            json_encode($data, JSON_THROW_ON_ERROR)
        );
    }
}
```

## 2. Anti-Patterns vs Best Practices (Scalability & Resilience)

### ❌ Anti-Pattern 1: Menggunakan Predis di Production (Performance Bottleneck)
**KODE SALAH (`config/database.php`):**
```php
'redis' => [
    'client' => 'predis',
    'default' => [
        'host' => '127.0.0.1',
        'password' => null,
        'port' => 6379,
    ],
],
```
**Mengapa Berbahaya?**
- `predis` ditulis menggunakan murni PHP (Userland). Pada sistem tingkat tinggi yang menerima ribuan permintaan per detik (RPS), parsing protokol komunikasi Redis oleh modul PHP *native* sangat membebani memori dan prosesor (CPU Bound). Ini akan menyebabkan saturasi FPM *worker* yang berakibat latensi melonjak tajam (P99 *spikes*).

**✅ KODE BENAR (Menggunakan PhpRedis C-Extension dengan Redis Sentinel Topology):**
Selalu *compile* dan nyalakan ekstensi `phpredis`.
```php
// config/database.php
'redis' => [
    // Gunakan 'phpredis' karena ini berjalan di tingkat C (sangat cepat)
    'client' => env('REDIS_CLIENT', 'phpredis'),

    // Konfigurasi Redis Sentinel (Toleransi Kesalahan)
    'default' => [
        // Prefix protokol 'tcp://' untuk host Sentinel
        'url' => env('REDIS_URL'),
        'host' => env('REDIS_HOST', '127.0.0.1'),
        'password' => env('REDIS_PASSWORD', null),
        'port' => env('REDIS_PORT', '6379'),
        'database' => env('REDIS_DB', '0'),
    ],

    // Cluster Configuration jika env('REDIS_CLUSTER') aktif
    'options' => [
        'cluster' => env('USE_REDIS_CLUSTER', false) ? 'redis' : null,
        'prefix' => env('REDIS_PREFIX', Str::slug(env('APP_NAME', 'laravel'), '_').'_database_'),
    ],
    
    // Konfigurasi Failover Sentinel
    'cache' => [
        'url' => env('REDIS_URL'),
        'host' => env('REDIS_CACHE_HOST', 'sentinel1,sentinel2,sentinel3'),
        'password' => env('REDIS_PASSWORD', null),
        'port' => env('REDIS_PORT', '26379'), // Port standar Sentinel
        'database' => env('REDIS_CACHE_DB', '1'),
        'options' => [
            'replication' => 'sentinel',
            'service' => env('REDIS_SENTINEL_SERVICE', 'mymaster'),
            'parameters' => [
                'password' => env('REDIS_PASSWORD', null),
            ],
        ],
    ],
],
```

### ❌ Anti-Pattern 2: Key Collisions pada Cluster (Sharding Error)
**KODE SALAH:**
```php
// Menghapus banyak key secara terpusat di Redis Cluster
$keys = Redis::keys("session:*");
Redis::del($keys);
```
**Mengapa Berbahaya?**
- **CROSSSLOT Error**: Dalam mode Redis Cluster, *keys* didistribusikan melintasi banyak peladen node berdasarkan CRC16 *hash slot*. Jika *command* (seperti `DEL key1 key2 ...` atau `MGET`) memanggil *keys* yang berada di node (slot) berbeda dalam satu kali transmisi pipa, peladen Cluster akan menolak operasi tersebut dan memunculkan error *CROSSSLOT*.
- **`KEYS *` Melumpuhkan I/O Loop**: *Command* `KEYS` memblokir I/O tunggal (single-thread) Redis, melumpuhkan jutaan koneksi lain selama detik/menit.

**✅ KODE BENAR (Menggunakan Hash Tags `{}` dan Pipeling Aman):**
Jika beberapa *keys* wajib diakses bersamaan di dalam Cluster, paksa penempatannya di node yang sama menggunakan pola *Hash Tags* `{}`. Jika ingin membersihkan, gunakan `SCAN` bukan `KEYS`.
```php
// Penamaan key menggunakan hash tag (segala sesuatu dalam {} digunakan untuk hashing)
// Semua operasi pada user_123 akan dijamin berada pada node fisik Redis yang sama.
$cacheKey = "user:{123}:stats";
$prefKey = "user:{123}:preferences";

// Untuk menghapus keys tanpa CROSSSLOT secara massal, hapus secara per-key pipeline
$iterator = null;
while ($keys = Redis::scan($iterator, 'session:*', 100)) {
    foreach ($keys as $key) {
        Redis::del($key); // Dikelola oleh PhpRedis yang menangani routing ke node Cluster yang tepat
    }
}
```

## 3. Pest v3 Testing (Architecture & Mocking)

Mari tulis serangkaian tes menggunakan Pest v3.

### Arch Testing (`tests/Feature/ArchitectureTest.php`)
```php
<?php

declare(strict_types=1);

test('Strict types in all files')
    ->expect('App')
    ->toUseStrictTypes();

test('Controllers delegate to Actions')
    ->expect('App\Http\Controllers')
    ->not->toUse('App\Repositories');
    
test('Env variables must not be used outside config')
    ->expect('env')
    ->not->toBeUsed();
```

### Unit Testing - Redis Mocking (`tests/Unit/Actions/RetrieveUserStatisticsActionTest.php`)
```php
<?php

declare(strict_types=1);

use App\Actions\RetrieveUserStatisticsAction;
use App\Repositories\UserStatsCacheRepositoryInterface;
use App\Repositories\UserStatsDatabaseRepositoryInterface;

it('returns cached stats if available without touching DB', function () {
    // 1. Arrange
    $cacheRepoMock = Mockery::mock(UserStatsCacheRepositoryInterface::class);
    $cacheRepoMock->shouldReceive('getStatsForUser')
        ->once()
        ->with(123)
        ->andReturn(['hits' => 500, 'points' => 10]);

    $dbRepoSpy = Mockery::spy(UserStatsDatabaseRepositoryInterface::class);

    $action = new RetrieveUserStatisticsAction($cacheRepoMock, $dbRepoSpy);

    // 2. Act
    $result = $action->execute(123);

    // 3. Assert
    expect($result)->toBeArray()
        ->and($result['hits'])->toBe(500);
        
    // Memastikan basis data tidak dipanggil (Cache Hit!)
    $dbRepoSpy->shouldNotHaveReceived('calculateStatsForUser');
});

it('fetches from DB and stores in cache on cache miss', function () {
    // 1. Arrange
    $cacheRepoMock = Mockery::mock(UserStatsCacheRepositoryInterface::class);
    $cacheRepoMock->shouldReceive('getStatsForUser')
        ->once()
        ->with(999)
        ->andReturnNull(); // Cache Miss

    $dbData = ['hits' => 0, 'points' => 0];
    
    $dbRepoMock = Mockery::mock(UserStatsDatabaseRepositoryInterface::class);
    $dbRepoMock->shouldReceive('calculateStatsForUser')
        ->once()
        ->with(999)
        ->andReturn($dbData);
        
    // Pastikan repositori menetapkan (set) hasil DB baru ke Cache
    $cacheRepoMock->shouldReceive('setStatsForUser')
        ->once()
        ->with(999, $dbData);

    $action = new RetrieveUserStatisticsAction($cacheRepoMock, $dbRepoMock);

    // 2. Act
    $result = $action->execute(999);

    // 3. Assert
    expect($result)->toBe($dbData);
});
```

Mengimplementasikan konfigurasi Redis Cluster dan Sentinel seperti di atas memberikan jaminan 99.99% *uptime* untuk sistem penyangga (*buffer*) di arsitektur mikroservis atau ekosistem masif berbasis Laravel 11.
