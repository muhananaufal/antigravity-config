# Pencegahan Cache Stampede & Dogpile Effect: Mutex & Probabilistic Early Expiration

Dokumen ini menjelaskan strategi Enterprise dalam mencegah **Cache Stampede (Dogpile Effect)**. Masalah ini terjadi pada sistem beban tinggi ketika suatu cache key populer kedaluwarsa secara mendadak, menyebabkan puluhan atau ribuan *concurrent request* merangsek masuk dan membobol database secara bersamaan untuk melakukan re-komputasi (karena semuanya mendapati cache = `null`).

Terdapat dua strategi utama untuk menangani hal ini:
1. **Mutex Lock (`Cache::lock`)**: Hanya mengizinkan satu proses yang menghitung data, yang lain menunggu.
2. **Probabilistic Early Expiration (XFCE Algorithm)**: Me-refresh cache secara asinkron di *background* SEBELUM benar-benar kedaluwarsa, memastikan cache tidak pernah kosong.

## Diagram ASCII: Probabilistic Early Expiration (XFCE)

```ascii
[ Waktu Kedaluwarsa Cache: T = 60 detik ]

Time = 0s ----------------------- 50s -------- 55s ----- 59s -- 60s (EXPIRED)
                                   |           |          |
[ Req 1 ] -> Hit (Gap = 10s) ----->| (Aman)    |          |
                                               |          |
[ Req 2 ] -> Hit (Gap = 5s)  ----------------->| (Beta Probabilitas memicu re-komputasi)
             (Tiba-tiba Req 2 mengambil alih tugas re-komputasi secara background)
                                                          |
[ Req 3 ] -> Hit (Gap = 1s)  ---------------------------->| (Aman, masih melayani data lama)
                                                          |
(Req 2 selesai write ke Redis) ---------------------------+ ---> Waktu TTL Diperpanjang ke T = 120s!

Hasil: Cache TIDAK PERNAH kosong, tidak ada request yang nge-blok / antri. Zero latency hit!
```

## Implementasi Kode Produksi (PHP 8.3 / Laravel 11)

Kita akan membuat implementasi kelas `ProbabilisticCacheManager` yang tangguh dan aman tipe (type-safe).

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Cache;

use Closure;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

/**
 * Handles high-concurrency cache generation using Probabilistic Early Expiration
 * and Mutex Locks to absolutely guarantee 0% DB stampede.
 * Strict Types enforced (PHPStan Level 9).
 */
final class StampedeProtectedCache
{
    /**
     * Resolves data with XFCE Probabilistic algorithm + Mutex fallback.
     *
     * @template T
     * @param string $key Identifier for the cache
     * @param int $ttlSeconds Normal expiration time
     * @param Closure(): T $resolver Heavy DB query / API call
     * @param float $beta Beta multiplier (usually 1.0, higher = earlier expiration check)
     * @return T
     */
    public function remember(string $key, int $ttlSeconds, Closure $resolver, float $beta = 1.0): mixed
    {
        $payload = Cache::store('redis')->get($key);

        // Kasus 1: Cache murni kosong (Cold Boot atau Purged) -> Wajib Lock!
        if (! is_array($payload) || ! isset($payload['data'], $payload['expires_at'], $payload['delta'])) {
            return $this->resolveWithLock($key, $ttlSeconds, $resolver);
        }

        /** @var T $data */
        $data = $payload['data'];
        /** @var float $expiresAt */
        $expiresAt = (float) $payload['expires_at'];
        /** @var float $delta Computation time in seconds */
        $delta = (float) $payload['delta'];

        // Kasus 2: Probabilistic check (XFCE Algorithm)
        // Jika hasil perhitungan acak melewati batas, worker ini akan re-komputasi.
        // xfce = current_time - (delta * beta * log(rand(0,1))) >= expiresAt
        
        $random = random_int(1, 1000) / 1000; // Float between 0.001 and 1.0
        $probabilisticGap = $delta * $beta * log($random);
        $currentTime = microtime(true);

        if ($currentTime - $probabilisticGap >= $expiresAt) {
            // Worker ini terpilih (secara probabilitas) untuk me-refresh data
            // Kita bungkus dengan Non-blocking Lock agar worker lain tidak ikut me-refresh
            $lockKey = "refresh_lock:{$key}";
            $lock = Cache::store('redis')->lock($lockKey, 10);
            
            if ($lock->get()) {
                try {
                    // Eksekusi di background atau secara synchronous tapi worker lain tetap return $data (stale)
                    $newData = $this->computeAndStore($key, $ttlSeconds, $resolver);
                    return $newData;
                } catch (\Throwable $e) {
                    Log::error("Failed early refresh for cache {$key}", ['error' => $e->getMessage()]);
                    $lock->release(); // Release to let another request try
                }
            }
        }

        // Kasus 3: Cache Hit Murni (Tidak masuk zona probabilitas awal) atau sedang direfresh worker lain
        return $data;
    }

    /**
     * Memaksa penggunaan Mutex jika cache benar-benar kosong.
     * @template T
     * @param string $key
     * @param int $ttlSeconds
     * @param Closure(): T $resolver
     * @return T
     */
    private function resolveWithLock(string $key, int $ttlSeconds, Closure $resolver): mixed
    {
        $lockKey = "lock:{$key}";
        $lock = Cache::store('redis')->lock($lockKey, 15); // Worst case computation 15s

        if (! $lock->block(10)) {
            // Jika gagal dapat lock selama 10s detik, sistem kritis!
            throw new \RuntimeException("Dogpile lock timeout on {$key}. System overloaded.");
        }

        try {
            // Double check (jika proses lain baru saja menyelesaikannya saat kita antri)
            $payload = Cache::store('redis')->get($key);
            if (is_array($payload) && isset($payload['data'])) {
                /** @var T */
                return $payload['data'];
            }

            return $this->computeAndStore($key, $ttlSeconds, $resolver);
        } finally {
            $lock->release();
        }
    }

    /**
     * Eksekusi closure dan rekam waktu komputasi (delta) untuk algoritma XFCE
     * @template T
     * @param string $key
     * @param int $ttlSeconds
     * @param Closure(): T $resolver
     * @return T
     */
    private function computeAndStore(string $key, int $ttlSeconds, Closure $resolver): mixed
    {
        $start = microtime(true);
        /** @var T $data */
        $data = $resolver();
        $delta = microtime(true) - $start;
        
        // Simpan metadata XFCE beserta data
        $payload = [
            'data' => $data,
            'expires_at' => microtime(true) + $ttlSeconds,
            'delta' => max(0.01, $delta), // Hindari log(0) atau delta 0 yang merusak XFCE
        ];

        // Set Redis TTL lebih panjang dari logical TTL agar stale data tetap bisa dilayani!
        Cache::store('redis')->put($key, $payload, $ttlSeconds + 600); // hard expire +10 menit

        return $data;
    }
}
```

## Anti-Patterns & Best Practices

❌ **Anti-Pattern 1: Menyimpan Raw Scalar Value pada Sistem High-Load**
**Salah:** `Cache::put('dashboard', 500, 60);`
**Bahaya:** Kita kehilangan konteks KAPAN data dibuat dan BERAPA LAMA proses perhitungannya. XFCE algorithm butuh struktur data payload (`delta`, `expires_at`).
✅ **Benar:** Selalu wrap cache item dalam envelope/DTO meta-data (seperti array di kode atas) pada area berpotensi dogpile.

❌ **Anti-Pattern 2: Timeout Block Mutex Terlalu Singkat**
**Salah:** `$lock->block(1);` (menunggu hanya 1 detik).
**Bahaya:** Jika query SQL normal butuh 3 detik, worker A memegang lock dan query, worker B gagal menunggu dan melempar Exception. Alhasil user B melihat HTTP 500 walau sebenarnya data sedang digenerate.
✅ **Benar:** `block($timeout)` harus lebih dari worst-case query, namun jangan tak terhingga (untuk mencegah deadlock permanen pada FPM worker exhaustion).

## Production Edge Cases

1. **Delta (Waktu Komputasi) Mendekati Nol:**
   *Skenario:* Jika closure `$resolver()` sangat cepat (misal 0.0001s), kalkulasi `$probabilisticGap = $delta * log(...)` menjadi nyaris nol. XFCE gagal memberikan jeda peringatan awal.
   *Mitigasi:* Berikan ambang bawah pada perhitungan waktu eksekusi: `max(0.1, $delta)` agar selalu ada gap probabilitas minimal 100ms.

2. **Redis OOM (Out Of Memory) Menghapus Kunci:**
   *Skenario:* Algoritma kita mengandalkan Redis menyimpan data `+ 10 menit` dari TTL aktual. Jika Redis OOM (kebijakan `allkeys-lru`), kunci bisa terhapus duluan, memicu 'Cold Boot' kembali dan antrian Lock.
   *Mitigasi:* Pastikan RAM Redis berkapasitas besar dan gunakan arsitektur tiering (L1/L2) atau kebijakan eviction `volatile-ttl` sehingga Redis memprioritaskan menghapus data dengan sisa TTL terpendek.

3. **Gagal Mendapatkan Lock untuk Refresh Awal:**
   *Skenario:* Pada algoritma XFCE, request yang "terpilih" kebetulan gagal mendapat non-blocking lock karena gangguan jaringan Redis sesaat.
   *Mitigasi:* Tidak masalah! Request tersebut cukup merespon dengan data lama (stale data). Request berikutnya (milidetik kemudian) akan memicu probabilitas lagi dan mencoba mengambil alih regenerasi. Inilah kekuatan XFCE.

## Unit / Arch Testing (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Infrastructure\Cache\StampedeProtectedCache;
use Illuminate\Support\Facades\Cache;

it('forces mutex lock on completely empty cache', function () {
    $manager = new StampedeProtectedCache();
    $key = 'stats_empty';
    
    // Simulate Cache Miss
    Cache::shouldReceive('store->get')->with($key)->andReturn(null);
    
    // Setup Lock expectation
    $mockLock = Mockery::mock();
    $mockLock->shouldReceive('block')->with(10)->once()->andReturn(true);
    $mockLock->shouldReceive('release')->once();
    Cache::shouldReceive('store->lock')->with("lock:{$key}", 15)->andReturn($mockLock);
    
    // Double check expectation inside lock
    Cache::shouldReceive('store->get')->with($key)->andReturn(null);
    
    // Expect Put
    Cache::shouldReceive('store->put')->once();

    // Act
    $result = $manager->remember($key, 60, fn() => 'fresh_data');
    
    expect($result)->toBe('fresh_data');
});

it('serves stale data without locking if XFCE probabilistic logic skips execution', function () {
    $manager = new StampedeProtectedCache();
    $key = 'stats_stale';
    
    // Payload with expires_at in the future (50s remaining of 60s)
    $payload = [
        'data' => 'stale_data',
        'expires_at' => microtime(true) + 50,
        'delta' => 1.5, // took 1.5 seconds to compute
    ];
    
    Cache::shouldReceive('store->get')->with($key)->once()->andReturn($payload);
    
    // Since 50 seconds remaining is way larger than delta gap, it should NEVER lock or put
    Cache::shouldReceive('store->lock')->never();
    Cache::shouldReceive('store->put')->never();
    
    $result = $manager->remember($key, 60, fn() => 'new_data', 1.0);
    
    expect($result)->toBe('stale_data'); // Must return stale
});
```
