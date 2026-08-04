# Invalidasi Cache Berbasis Tag (Cache Tagging) untuk Arsitektur Multi-Tenant

Dalam sistem berskala Enterprise yang memiliki sifat *Multi-Tenant* (seperti SaaS B2B) atau relasi data yang kompleks, melakukan invalidasi cache berbasis key satu per satu (`DEL user_123`) merupakan mimpi buruk operasional. Bagaimana cara Anda menghapus **seluruh** *cache entry* (artikel, komentar, statistik profil) yang berkaitan dengan *Tenant A* saat akunnya diperbarui, tanpa membilas (*flushall*) data milik *Tenant B*?

**Cache Tagging** adalah seni menyematkan satu atau lebih "Tag" meta-data pada suatu *cache key*. Saat invalidasi terjadi, kita menyapu (menghapus) semua kunci yang berhubungan dengan Tag spesifik tersebut dalam hitungan *O(1)* atau *O(N)* efisien tanpa mengganggu kunci lainnya.

## Arsitektur Alur Invalidasi Cache Berbasis Tag

```ascii
+----------------+      [1] Write Data + Tag     +-------------------------+
|                |------------------------------>| REDIS CACHE STORAGE     |
|   App Server   |                               |                         |
|    (NestJS)    |      [2] Set "tags:tenantA" = | keys: [ "stats_tA",     |
|                |          { stats_tA, usr_tA } |         "usr_tA" ]      |
+----------------+                               +-------------------------+
       |
       | [3] Invalidate Tag "tenantA"
       v
+----------------+      [4] Fetch Keys in Set    +-------------------------+
| Redis Pipeline |------------------------------>| GET SMEMBERS tags:tenant|
| / Lua Script   |<------------------------------| (returns 2 keys)        |
+----------------+                               |                         |
       |                [5] Delete Keys + Set    | DEL "stats_tA" "usr_tA" |
       +---------------------------------------->| DEL "tags:tenantA"      |
                                                 +-------------------------+
```

## Implementasi Produksi NestJS & TypeScript

Sistem Cache standar Redis tidak memiliki dukungan *Tagging* bawaan secara native (berbeda dengan Memcached). Kita merekayasanya menggunakan tipe struktur data Redis `SET` untuk melacak daftar kunci per Tag.

```typescript
import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';

export interface TaggedCacheOptions {
  ttlMs?: number;
  tags?: string[];
}

@Injectable()
export class TenantTaggedCacheService {
  private readonly logger = new Logger(TenantTaggedCacheService.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  /**
   * Menyimpan data beserta Tag(s) relasionalnya
   */
  async setWithTags(
    key: string,
    value: unknown,
    options: TaggedCacheOptions = {},
  ): Promise<void> {
    const { ttlMs, tags = [] } = options;
    const serializedData = JSON.stringify(value);

    // Gunakan Redis Pipeline untuk atomisitas dan memangkas network RTT
    const pipeline = this.redis.pipeline();

    // 1. Set key utama
    if (ttlMs) {
      pipeline.set(key, serializedData, 'PX', ttlMs);
    } else {
      pipeline.set(key, serializedData);
    }

    // 2. Tambahkan kunci ini ke dalam setiap set Tag
    for (const tag of tags) {
      const tagSetKey = this.getTagKey(tag);
      pipeline.sadd(tagSetKey, key);
      
      // Jika key utama punya TTL, set tag-nya juga dengan TTL agar Set tidak bocor (Memory Leak)
      if (ttlMs) {
        // Beri kelonggaran waktu sedikit untuk TTL tag (buffer 1 jam)
        pipeline.pexpire(tagSetKey, ttlMs + 3600000); 
      }
    }

    await pipeline.exec();
    this.logger.debug(`[CACHE SET] Key: ${key} tagged with [${tags.join(', ')}]`);
  }

  /**
   * Mengambil data Cache
   */
  async get<T>(key: string): Promise<T | null> {
    const data = await this.redis.get(key);
    return data ? (JSON.parse(data) as T) : null;
  }

  /**
   * Invalidasi MASSAL secara cerdas berdasarkan TAG.
   * Sangat efisien, tidak membilas data tenant lain.
   */
  async invalidateByTag(tag: string): Promise<void> {
    const tagSetKey = this.getTagKey(tag);
    
    // 1. Dapatkan seluruh kunci yang terafiliasi dengan Tag ini
    const keysToDelete = await this.redis.smembers(tagSetKey);

    if (keysToDelete.length === 0) {
      this.logger.debug(`[INVALIDATE] No keys found for tag: ${tag}`);
      return;
    }

    // 2. Hapus key data utama DAN key Set Tag itu sendiri menggunakan Pipeline
    const pipeline = this.redis.pipeline();
    pipeline.del(...keysToDelete);
    pipeline.del(tagSetKey);

    await pipeline.exec();
    this.logger.log(`[INVALIDATED] Tag: ${tag}. Cleared ${keysToDelete.length} keys.`);
  }

  private getTagKey(tag: string): string {
    return `cache_tag:${tag}`;
  }
}
```

## Unit Testing & Cache Mock Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { TenantTaggedCacheService } from './tenant-tagged-cache.service';

describe('TenantTaggedCacheService', () => {
  let service: TenantTaggedCacheService;
  let mockPipeline: any;
  let mockRedis: any;

  beforeEach(async () => {
    mockPipeline = {
      set: jest.fn().mockReturnThis(),
      sadd: jest.fn().mockReturnThis(),
      pexpire: jest.fn().mockReturnThis(),
      del: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };

    mockRedis = {
      pipeline: jest.fn(() => mockPipeline),
      get: jest.fn(),
      smembers: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantTaggedCacheService,
        { provide: 'REDIS_CLIENT', useValue: mockRedis },
      ],
    }).compile();

    service = module.get<TenantTaggedCacheService>(TenantTaggedCacheService);
  });

  it('seharusnya menyimpan data dan mendaftarkan key ke dalam Redis Set', async () => {
    await service.setWithTags('user:1', { name: 'A' }, { tags: ['tenant_A', 'group_1'], ttlMs: 5000 });

    expect(mockRedis.pipeline).toHaveBeenCalled();
    expect(mockPipeline.set).toHaveBeenCalledWith('user:1', '{"name":"A"}', 'PX', 5000);
    expect(mockPipeline.sadd).toHaveBeenCalledWith('cache_tag:tenant_A', 'user:1');
    expect(mockPipeline.sadd).toHaveBeenCalledWith('cache_tag:group_1', 'user:1');
    expect(mockPipeline.pexpire).toHaveBeenCalledTimes(2);
    expect(mockPipeline.exec).toHaveBeenCalled();
  });

  it('seharusnya melakukan invalidasi seluruh key dalam sebuah tag', async () => {
    mockRedis.smembers.mockResolvedValue(['user:1', 'stats:1']);

    await service.invalidateByTag('tenant_A');

    expect(mockRedis.smembers).toHaveBeenCalledWith('cache_tag:tenant_A');
    expect(mockPipeline.del).toHaveBeenCalledWith('user:1', 'stats:1');
    expect(mockPipeline.del).toHaveBeenCalledWith('cache_tag:tenant_A');
    expect(mockPipeline.exec).toHaveBeenCalled();
  });
});
```

## Analisis Trade-Off Arsitektur

### Kelebihan
1. **Invalidasi Operasional Tepat Sasaran:** Anda dapat menyapu bersih seluruh data Cache e-commerce saat "Kategori Baju" di-update tanpa mengganggu "Kategori Sepatu", menjaga efisiensi global.
2. **Kesesuaian Multi-Tenant:** Mutlak diperlukan dalam arsitektur B2B (SaaS). Pemisahan data per tenant pada level aplikasi lebih mudah di-wipe (misal saat tenant melakukan downgrade langganan).
3. **Efisiensi Jaringan (Pipeline):** Penggunaan `pipeline()` / mget / mset dari Redis menjamin I/O jaringan diringkas dalam satu balasan (batching round-trip), sangat krusial pada operasi volume tinggi.

### Kekurangan
1. **Denda Penulisan Ganda (Write Penalty):** Menyimpan cache kini membutuhkan *multiple command* (SET key, SADD tag, EXPIRE tag). Meskipun di-pipeline, secara komputasi Redis ini lebih berat dibandingkan SET standar tunggal.
2. **Potensi Orphan Keys di Tag Set (Memory Leak):** Jika kunci utama kedaluwarsa oleh Redis TTL, namanya masih "nyangkut" di dalam *Set Tag*. Saat Tag di-invalidate, Redis akan mencoba men-DEL kunci yang sudah tak ada, membuang *cycle* CPU Redis.
3. **Big Key Issue (Redis Antipattern):** Jika satu Tag ('global_config') terikat pada 1 Juta *keys*, operasi `smembers` akan memblokir *single-threaded* event loop Redis seketika, menyebabkan *freeze* sistemik!

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menggunakan `KEYS tag:*` untuk Invalidasi
```typescript
// BUKAN PRAKTIK TOP 1%
// ❌ KIAMAT PERFORMA REDIS! Command 'KEYS' bersifat memblokir O(N).
// Pada DB dengan 50 juta keys, ini membuat server Redis terhenti detik-an.
const keys = await this.redis.keys(`tenant:${tenantId}:*`); 
await this.redis.del(...keys);
```
**Perbaikan ✅:** JANGAN PERNAH gunakan `KEYS` di Produksi. Gunakan `SCAN` jika terpaksa, atau arsitektur *Set Tagging* `smembers` (jika ukuran set masuk akal/terukur).

### ❌ Anti-Pattern 2: Melupakan Sinkronisasi TTL pada Tag Set
```typescript
// BUKAN PRAKTIK TOP 1%
pipeline.set(key, val, 'PX', 5000); // Key mati 5 detik
pipeline.sadd(tagKey, key); // ❌ Tag Set Hdup abadi! Memory Leak masif!
```
**Perbaikan ✅:** Selalu sinkronisasikan `pexpire` pada Set Key sejalan dengan TTL kunci utama, sebaiknya ditambahkan ekstra toleransi waktu.

## Production Edge Cases
1. **Tag Set Meledak (>100k member):** Jika sebuah Tag memuat terlalu banyak key, `smembers` akan menghentikan Node dan Redis. Solusinya, gunakan iterasi `SSCAN` untuk menyedot key secara bertahap dalam *chunks* (misal per 1000 items) kemudian di-`DEL`.
2. **Race Condition antara Tagging dan Delete:** Worker A menyuntik `sadd` kunci X ke Tag T, detik yang sama Worker B memanggil invalidasi `del` Tag T. Kunci X mungkin tertinggal abadi dan menjadi *Orphan*. Tangani dengan Lua script terpadu jika konsistensi harus 100%.
3. **Tag Name Collision:** Penggunaan tag sembarangan seperti "admin" atau "123" bisa bentrok antar modul (Tenant ID vs User ID). Wajib memiliki hierarki *namespace* untuk tag (contoh: `tenant:123`, `module:billing`).
