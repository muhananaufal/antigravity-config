# Arsitektur Multi-Level Caching: L1 Octane (Swoole) + L2 Redis

Dokumen ini membedah implementasi caching berlapis (Multi-Level Cache) menggunakan Laravel Octane (Swoole/FrankenPHP RAM Table) sebagai L1 Cache dan Redis Cluster sebagai L2 Cache. Tujuannya: mencapai latency membaca (read latency) *zero network trip* di rentang microsecond (µs) sambil mempertahankan state terdistribusi yang tersinkronisasi di Redis untuk klaster multi-node.

## Diagram ASCII: Aliran Data L1-L2 Cache

```ascii
[ HTTP Request Masuk ] --> (Laravel Octane Worker Process)
                                |
                                v
                      [ Cek L1: Octane Table ] --(Hit)--> [ RESPONSE SEKEITKA: 0ms ]
                                |
                             (Miss)
                                |
                                v
                      [ Cek L2: Redis Cluster ] --(Hit)--> [ Populate L1 ] --> [ RESPONSE: ~1-3ms ]
                                |
                             (Miss)
                                |
                                v
                    [ Mutex Lock (Cache::lock) ]
                                |
                                v
                      [ Query DB / Heavy Task ]
                                |
                                v
                [ Simpan L2 Redis & Simpan L1 Octane ]
                                |
                                v
                        [ HTTP Response ]
```

## Spesifikasi Teknis & Persiapan

Implementasi ini memanfaatkan `Octane::cache()` (Swoole Table atau FrankenPHP shared memory) untuk kecepatan ekstrem, dikombinasikan dengan Redis (Predis/PhpRedis) untuk persistensi lintas kontainer pod Kubernetes.

## Implementasi Kode Produksi (PHP 8.3 / Laravel 11)

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Cache;

use Closure;
use Illuminate\Support\Facades\Cache;
use Laravel\Octane\Facades\Octane;
use Illuminate\Contracts\Cache\LockTimeoutException;

/**
 * MultiLevelCache orchestrator L1 (Octane RAM) and L2 (Redis).
 * Strict types enforced for PHPStan Level 9 compatibility.
 */
final class MultiLevelCacheManager
{
    private const int L1_TTL_SECONDS = 30; // Short-lived in RAM
    private const int LOCK_TIMEOUT_SECONDS = 5;
    
    /**
     * Resolves value from L1 -> L2 -> Fallback logic with atomic lock.
     *
     * @template T
     * @param string $key Cache key identifier
     * @param int $ttlSeconds L2 Redis TTL in seconds
     * @param Closure(): T $resolver Fallback computation closure
     * @return T
     * @throws \RuntimeException
     */
    public function remember(string $key, int $ttlSeconds, Closure $resolver): mixed
    {
        // Step 1: Cek L1 Cache (Swoole RAM Table) - Microsecond Latency
        $l1Result = Octane::cache()->get($key);
        if ($l1Result !== null) {
            return $l1Result;
        }

        // Step 2: Cek L2 Cache (Redis) - Millisecond Latency
        /** @var mixed $l2Result */
        $l2Result = Cache::store('redis')->get($key);
        if ($l2Result !== null) {
            // Populate L1 cache to speed up subsequent requests on this specific worker pod
            Octane::cache()->put($key, $l2Result, self::L1_TTL_SECONDS);
            return $l2Result;
        }

        // Step 3: Cache Miss, implement atomic lock to prevent dogpile effect
        $lockKey = "lock:{$key}";
        $lock = Cache::store('redis')->lock($lockKey, self::LOCK_TIMEOUT_SECONDS);

        try {
            // Block other requests until this one finishes resolving
            if (! $lock->block(self::LOCK_TIMEOUT_SECONDS)) {
                throw new \RuntimeException("Timeout waiting for lock on {$key}");
            }
            
            // Double check lock L2 cache after acquiring lock (another process might have filled it)
            /** @var mixed $doubleCheck */
            $doubleCheck = Cache::store('redis')->get($key);
            if ($doubleCheck !== null) {
                Octane::cache()->put($key, $doubleCheck, self::L1_TTL_SECONDS);
                return $doubleCheck;
            }

            // Execute heavy computation
            /** @var T $resolvedData */
            $resolvedData = $resolver();

            // Populate both L2 and L1
            Cache::store('redis')->put($key, $resolvedData, $ttlSeconds);
            Octane::cache()->put($key, $resolvedData, self::L1_TTL_SECONDS);

            return $resolvedData;

        } catch (LockTimeoutException $e) {
            throw new \RuntimeException("Critical cache stampede averted by timeout on {$key}", 0, $e);
        } finally {
            $lock?->release();
        }
    }
    
    /**
     * Invalidate both L1 and L2 caches.
     */
    public function forget(string $key): void
    {
        Octane::cache()->forget($key);
        Cache::store('redis')->forget($key);
    }
}
```

## Anti-Patterns & Best Practices

❌ **Anti-Pattern 1: Mengabaikan Atomic Lock saat Rebuild Cache**
**Salah:** Langsung query DB jika `$l2Result === null`.
**Bahaya:** Cache stampede! Jika cache global kedaluwarsa dan trafik 10.000 RPS masuk, 10.000 koneksi DB akan terbentuk, membunuh server MySQL dalam hitungan detik.
✅ **Benar:** Gunakan `Cache::lock()->block()` untuk memastikan hanya 1 worker per klaster yang mengeksekusi `$resolver()`.

❌ **Anti-Pattern 2: TTL L1 Terlalu Lama (L1 Stale Data)**
**Salah:** Mengatur TTL Octane (L1) sama dengan Redis (L2), misal 24 jam.
**Bahaya:** Data L1 bersifat lokal per-pod (atau per worker process). Jika data di Redis diperbarui oleh pod A, pod B akan tetap melayani data basi (stale) dari RAM selama 24 jam.
✅ **Benar:** L1 TTL HARUS pendek (misal 5-30 detik) hanya untuk meredam lonjakan request mendadak per detik.

## Production Edge Cases (Kasus Ekstrem Produksi)

1. **Redis Timeout / Network Partition (Split Brain):**
   *Skenario:* Koneksi ke Redis putus sesaat.
   *Mitigasi:* Tangani `RedisException` dan *fallback* ke pemrosesan `$resolver()` langsung secara degradasi anggun (graceful degradation), dengan memberikan peringatan (alert) log kritis alih-alih melempar HTTP 500 terus-menerus.

2. **Memory Lock Contention (Deadlock pada `$lock->block()`):**
   *Skenario:* Task `$resolver()` butuh waktu 10 detik, tetapi timeout lock diatur 5 detik. Proses kedua mendapatkan lock baru sementara proses pertama masih berjalan, menyebabkan dua proses membunuh performa DB.
   *Mitigasi:* Durasi lock *harus* lebih lama dari waktu terburuk komputasi (worst-case execution time).

3. **Data Serialization Mismatch di Octane Table:**
   *Skenario:* Menyimpan objek PHP kompleks atau koneksi database di `Octane::cache()`.
   *Mitigasi:* Swoole table membutuhkan serialisasi string/array murni. Pastikan `$resolvedData` yang masuk selalu berbentuk DTO serializable atau array murni.

## Unit / Arch Testing (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Infrastructure\Cache\MultiLevelCacheManager;
use Illuminate\Support\Facades\Cache;
use Laravel\Octane\Facades\Octane;

it('fetches from L1 cache bypassing L2 entirely', function () {
    // Arrange
    $manager = new MultiLevelCacheManager();
    $key = 'tenant:1:settings';
    
    // L1 contains data
    Octane::shouldReceive('cache->get')
        ->once()
        ->with($key)
        ->andReturn(['theme' => 'dark']);
        
    // L2 should NEVER be called
    Cache::shouldReceive('store')->never();
    
    // Act
    $result = $manager->remember($key, 3600, fn() => ['theme' => 'light']);
    
    // Assert
    expect($result)->toBe(['theme' => 'dark']);
});

it('resolves fallback and writes to both L1 and L2 when both miss', function () {
    $manager = new MultiLevelCacheManager();
    $key = 'heavy_report_data';
    $resolvedData = ['sales' => 50000];
    
    // L1 Miss
    Octane::shouldReceive('cache->get')->with($key)->andReturn(null);
    Octane::shouldReceive('cache->put')->once()->with($key, $resolvedData, 30);
    
    // L2 Miss & Lock mocking
    $mockStore = Mockery::mock();
    $mockLock = Mockery::mock();
    
    $mockStore->shouldReceive('get')->with($key)->andReturn(null); // initial
    $mockStore->shouldReceive('get')->with($key)->andReturn(null); // double check
    $mockStore->shouldReceive('put')->once()->with($key, $resolvedData, 3600);
    
    $mockLock->shouldReceive('block')->once()->andReturn(true);
    $mockLock->shouldReceive('release')->once();
    
    $mockStore->shouldReceive('lock')->andReturn($mockLock);
    
    Cache::shouldReceive('store')->with('redis')->andReturn($mockStore);
    
    // Act
    $result = $manager->remember($key, 3600, fn() => $resolvedData);
    
    // Assert
    expect($result)->toBe($resolvedData);
});
```
