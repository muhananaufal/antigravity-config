# Strategi Tagged Cache & Invalidasi Multi-Tenant

Dokumen ini mendeskripsikan strategi penggunaan `Cache::tags()` pada arsitektur multi-tenant berbeban tinggi (B2B SaaS). Tantangan utama dalam caching multi-tenant adalah bagaimana membersihkan (purge) seluruh cache milik satu tenant secara sekejap tanpa mengganggu cache tenant lain, serta mencegah *tombstone memory leak* di dalam cluster Redis.

## Diagram ASCII: Aliran Tagged Cache Invalidation

```ascii
[ Database / Model Updates ]
            |
(Tenant 104 Updates Catalog)
            |
            v
[ Model Observer Trigger ]
            |
            v
 Cache::tags(['tenant:104', 'catalog:active'])->flush()
            |
            v
 [ REDIS TAG SETS (SADD) ] --(Menandai referensi cache usang)
            |
            v
[ Redis Menghapus Data O(N) Berdasarkan Tag Reference ]
```

## Mekanika Internal Redis Tagging di Laravel

Berbeda dengan cache key biasa yang disimpan sebagai string *key-value*, Cache Tags pada driver Redis Laravel bekerja dengan menyimpan Set (Himpunan) referensi:
1. `tag:tenant:104:key` (berisi ID referensi random)
2. Value asli disimpan di key tersendiri yang di-hash dengan referensi tag tersebut.
Saat `flush()` dipanggil, Laravel menghapus referensi tag, secara logis menginvalidasi seluruh entri yang bergantung pada referensi tersebut tanpa harus melakukan SCAN yang memblokir I/O Redis.

## Implementasi Kode Produksi (PHP 8.3 / Laravel 11)

### 1. Abstract Multi-Tenant Repository

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Repositories;

use Illuminate\Support\Facades\Cache;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Collection;

/**
 * Base repository enforcing tenant-scoped cache tagging.
 * Strict typing for PHPStan Level 9.
 *
 * @template TModel of Model
 */
abstract class TenantScopedRepository
{
    /**
     * @param int $tenantId
     * @param class-string<TModel> $modelClass
     */
    public function __construct(
        protected readonly int $tenantId,
        protected readonly string $modelClass
    ) {}

    /**
     * Get base tenant tag name.
     */
    protected function getTenantTag(): string
    {
        return "tenant:{$this->tenantId}";
    }

    /**
     * Get entity specific tag.
     */
    protected function getEntityTag(): string
    {
        // e.g. "tenant:104:catalog"
        $entityName = strtolower(class_basename($this->modelClass));
        return "{$this->getTenantTag()}:{$entityName}";
    }

    /**
     * Fetch active records safely with tenant tags.
     *
     * @return Collection<int, TModel>
     */
    public function getActiveRecords(): Collection
    {
        $cacheKey = "{$this->getEntityTag()}:active_records";

        /** @var Collection<int, TModel> */
        return Cache::tags([$this->getTenantTag(), $this->getEntityTag()])
            ->remember($cacheKey, 3600, function () {
                return $this->modelClass::query()
                    ->where('tenant_id', $this->tenantId)
                    ->where('is_active', true)
                    ->get();
            });
    }

    /**
     * Invalidate entire tenant cache or specific entity.
     */
    public function invalidateCache(bool $entireTenant = false): void
    {
        $tag = $entireTenant ? $this->getTenantTag() : $this->getEntityTag();
        
        // This instantly invalidates all keys associated with this tag
        Cache::tags([$tag])->flush();
    }
}
```

### 2. Observer untuk Invalidasi Otomatis (Event-Driven Purging)

```php
<?php

declare(strict_types=1);

namespace App\Observers;

use App\Models\Catalog;
use Illuminate\Support\Facades\Cache;
use Illuminate\Contracts\Queue\ShouldQueue;

/**
 * Asynchronously clears cache tags upon Catalog mutation.
 * Implements ShouldQueue to not block the DB transaction.
 */
final class CatalogObserver implements ShouldQueue
{
    /**
     * Handle the Catalog "saved" event.
     */
    public function saved(Catalog $catalog): void
    {
        $this->purgeCache($catalog->tenant_id);
    }

    /**
     * Handle the Catalog "deleted" event.
     */
    public function deleted(Catalog $catalog): void
    {
        $this->purgeCache($catalog->tenant_id);
    }

    private function purgeCache(int $tenantId): void
    {
        // Flush specific entity tag to prevent collateral damage to other modules
        Cache::tags(["tenant:{$tenantId}:catalog"])->flush();
    }
}
```

## Anti-Patterns & Best Practices

❌ **Anti-Pattern 1: Terlalu Banyak Tag per Entri (Tag Explosion)**
**Salah:** `Cache::tags(['tenant:104', 'product:1', 'category:2', 'promo:3', 'global'])->put(...)`
**Bahaya:** Karena setiap tag membuat set referensi di Redis, menyimpan dengan 5 tag akan melakukan 5x `SADD` ke Redis. Saat membaca, ia mengecek 5 tag. Performa Redis akan terdegradasi.
✅ **Benar:** Batasi maksimal 2-3 hierarki tag (misal: Tag Induk `tenant:104`, Tag Anak `tenant:104:catalog`).

❌ **Anti-Pattern 2: Memory Leak dari Tag Tombstones di Redis Lama**
**Salah:** Menggunakan Redis versi < 6.0 untuk implementasi Cache Tags Laravel skala besar.
**Bahaya:** Di versi Laravel terdahulu/Redis lawas, file cache lama *orphaned* (menggantung) saat tag dihapus (flush hanya menghapus referensi, bukan menghapus fisik value-nya), memenuhi RAM Redis hingga limit OOM.
✅ **Benar:** Pastikan Redis memiliki kebijakan `maxmemory-policy allkeys-lru` atau `volatile-lru`. Di Laravel 11 dengan Predis/PhpRedis terbaru, driver telah dioptimalkan via *garbage collection* prunable.

## Production Edge Cases

1. **Tag Flush Collision (Race Condition di Mutasi Masal):**
   *Skenario:* Fitur *Bulk Import* mengupdate 1000 produk dari 1 tenant secara bersamaan. Observer menembakkan 1000 kali `flush()` pada tag yang sama ke Redis dalam waktu 1 detik. CPU Redis melonjak (Spike).
   *Mitigasi:* Tambahkan *Debouncing* pada level queue atau ubah arsitektur Bulk Import agar melakukan single *manual flush* di akhir transaksi, menonaktifkan observer *per-row*.

2. **Downtime Redis & Degradasi Node:**
   *Skenario:* Cache node Redis (cluster) gagal. `Cache::tags()` akan melempar exception karena fallback driver seperti `file` atau `database` **TIDAK MENDUKUNG** tag (exception `BadMethodCallException`).
   *Mitigasi:* Tangkap exception pada layer Abstraksi dan kembalikan ke *direct query* database dengan *circuit breaker pattern*, JANGAN biarkan exception tag cache merusak runtime.

3. **Inkonsistensi L1/L2 karena Tag Flush:**
   *Skenario:* Menggabungkan Cache Tags Redis (L2) dengan Octane RAM (L1). Saat tag di-flush di Redis, memori Octane di *worker pod* tidak tahu menahu soal itu.
   *Mitigasi:* Hindari penggunaan Cache Tags pada layer L1 yang state-nya di-manage sendiri. Gunakan Pub/Sub Redis untuk memancarkan sinyal "Tag X Invalid" agar semua Octane worker menghapus memori lokalnya.

## Unit / Arch Testing (Pest v3)

```php
<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Cache;

it('flushes only specific tenant entity cache while preserving others', function () {
    // Arrange: Populate cache for Tenant 1 and Tenant 2
    Cache::tags(['tenant:1', 'tenant:1:catalog'])->put('catalog_data_1', 't1_data', 3600);
    Cache::tags(['tenant:2', 'tenant:2:catalog'])->put('catalog_data_2', 't2_data', 3600);
    
    // Ensure both exist
    expect(Cache::tags(['tenant:1:catalog'])->get('catalog_data_1'))->toBe('t1_data')
      ->and(Cache::tags(['tenant:2:catalog'])->get('catalog_data_2'))->toBe('t2_data');
      
    // Act: Purge Tenant 1 Catalog Only
    Cache::tags(['tenant:1:catalog'])->flush();
    
    // Assert: T1 is gone, T2 remains intact
    expect(Cache::tags(['tenant:1:catalog'])->get('catalog_data_1'))->toBeNull()
      ->and(Cache::tags(['tenant:2:catalog'])->get('catalog_data_2'))->toBe('t2_data');
});
```
