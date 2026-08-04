# Arsitektur Cache Lapis Ganda (L1 In-Memory + L2 Redis Valkey Distributed Cache)

Dalam arsitektur berskala Enterprise dengan latensi ultra-rendah dan jutaan *Requests Per Second* (RPS), penggunaan memori terdistribusi seperti Redis (atau Valkey) sering kali tidak cukup cepat untuk hotspot data yang sangat sering diakses, mengingat masih adanya *network round-trip*. Arsitektur **Multi-Tier Cache (L1 + L2)** memecahkan masalah ini dengan menggabungkan cache *in-memory* lokal proses (L1) dan cache *distributed* (L2).

L1 Cache menggunakan strategi LRU (*Least Recently Used*) lokal di dalam Node.js heap untuk respon dalam hitungan mikrodetik, sedangkan L2 Cache menggunakan Valkey/Redis untuk konsistensi data lintas *instance* atau replika server.

## Arsitektur Aliran Cache L1/L2

```ascii
+-----------------------+       Hit       +-----------------------+
|                       |---------------->|                       |
|    Client Request     |                 |   L1 Cache (Memory)   |
|                       |<----------------|   (Microsecond TTL)   |
+-----------+-----------+                 +-----------------------+
            | Miss (L1)                               ^ Hit
            v                                         |
+-----------------------+       Hit       +-----------------------+
|                       |---------------->|                       |
|   NestJS App Server   |                 |   L2 Cache (Valkey)   |
|   Cache Interceptor   |<----------------|   (Network Latency)   |
+-----------+-----------+                 +-----------------------+
            | Miss (L2)                               ^ Hit
            v                                         |
+-----------------------+                             |
|                       |-----------------------------+
|    Primary Database   |  Update L2 Cache -> Return Result
|   (PostgreSQL/NoSQL)  |  (L1 updated on next request or via PubSub)
+-----------------------+
```

## Implementasi Produksi Multi-Tier Cache

Kode di bawah ini menggunakan `@nestjs/cache-manager` yang dipadukan dengan struktur data *Map*/*LRU* internal Node.js untuk L1, dan RedisStore untuk L2.

```typescript
import { Injectable, Inject, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { LRUCache } from 'lru-cache';
import * as crypto from 'crypto';

/**
 * Konfigurasi untuk strategi L1 dan L2 cache
 */
export interface MultiTierCacheOptions {
  l1TtlMs: number;
  l2TtlMs: number;
}

@Injectable()
export class MultiTierCacheService {
  private readonly logger = new Logger(MultiTierCacheService.name);
  
  // L1 Cache: In-Memory LRU Cache untuk mencegah OOM (Out Of Memory)
  private readonly l1Cache: LRUCache<string, string>;

  constructor(@Inject(CACHE_MANAGER) private readonly l2Cache: Cache) {
    this.l1Cache = new LRUCache({
      max: 10000, // Maksimal 10.000 item dalam memori lokal
      ttl: 5000,  // Default TTL L1 5 detik (Stale read toleransi rendah)
    });
  }

  /**
   * Mengambil data dengan strategi Read-Through Multi-Tier.
   * L1 -> L2 -> Fallback Function
   */
  async getOrSet<T>(
    key: string,
    fallback: () => Promise<T>,
    options: MultiTierCacheOptions = { l1TtlMs: 2000, l2TtlMs: 60000 },
  ): Promise<T> {
    // 1. Cek L1 (In-Memory Local)
    const l1Data = this.l1Cache.get(key);
    if (l1Data) {
      this.logger.debug(`[L1 HIT] Key: ${key}`);
      return JSON.parse(l1Data) as T;
    }

    // 2. Cek L2 (Distributed Valkey/Redis)
    try {
      const l2Data = await this.l2Cache.get<string>(key);
      if (l2Data) {
        this.logger.debug(`[L2 HIT] Key: ${key}`);
        // Backfill ke L1 untuk request selanjutnya
        this.l1Cache.set(key, l2Data, { ttl: options.l1TtlMs });
        return JSON.parse(l2Data) as T;
      }
    } catch (error: unknown) {
      this.logger.warn(`[L2 ERROR] Failed to fetch key ${key}. Falling back to DB. Error: ${error instanceof Error ? error.message : String(error)}`);
      // Jika Redis down, kita degradasi gracefully, lanjut ke fallback DB
    }

    // 3. Fallback (Cache Miss) - Ambil dari Sumber Kebenaran (Database)
    this.logger.debug(`[MISS] Key: ${key}. Fetching from fallback...`);
    const freshData = await fallback();
    const serializedData = JSON.stringify(freshData);

    // 4. Update L2 secara asynchronous untuk mengurangi latensi response
    this.updateL2CacheAsync(key, serializedData, options.l2TtlMs);

    // 5. Update L1 secara sinkron untuk hot data
    this.l1Cache.set(key, serializedData, { ttl: options.l1TtlMs });

    return freshData;
  }

  /**
   * Invalidasi data dari L1 dan L2 secara bersamaan
   */
  async invalidate(key: string): Promise<void> {
    this.l1Cache.delete(key);
    try {
      await this.l2Cache.del(key);
      this.logger.log(`[INVALIDATE] Key: ${key} cleared from L1 and L2`);
    } catch (error: unknown) {
      this.logger.error(`[INVALIDATE ERROR] Failed to clear L2 cache for key ${key}`, error instanceof Error ? error.stack : String(error));
    }
  }

  /**
   * Menulis ke L2 tanpa memblokir thread eksekusi utama
   */
  private updateL2CacheAsync(key: string, data: string, ttlMs: number): void {
    Promise.resolve(this.l2Cache.set(key, data, ttlMs)).catch((error: unknown) => {
      this.logger.error(`[L2 SET ERROR] Failed to update key ${key}`, error instanceof Error ? error.stack : String(error));
    });
  }
}
```

## Unit Testing & Cache Mock Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { MultiTierCacheService } from './multi-tier-cache.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';

describe('MultiTierCacheService', () => {
  let service: MultiTierCacheService;
  let mockL2Cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    mockL2Cache = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MultiTierCacheService,
        {
          provide: CACHE_MANAGER,
          useValue: mockL2Cache,
        },
      ],
    }).compile();

    service = module.get<MultiTierCacheService>(MultiTierCacheService);
  });

  it('seharusnya mengembalikan data dari fallback pada saat initial miss', async () => {
    mockL2Cache.get.mockResolvedValue(null);
    const fallbackFn = jest.fn().mockResolvedValue({ id: 1, name: 'Data' });

    const result = await service.getOrSet('test-key', fallbackFn);

    expect(result).toEqual({ id: 1, name: 'Data' });
    expect(fallbackFn).toHaveBeenCalledTimes(1);
    expect(mockL2Cache.set).toHaveBeenCalled();
  });

  it('seharusnya mengembalikan data dari L1 dan tidak memanggil fallback atau L2 pada call kedua', async () => {
    mockL2Cache.get.mockResolvedValue(null);
    const fallbackFn = jest.fn().mockResolvedValue({ id: 1, name: 'Data' });

    // Call 1: Miss L1 & L2 -> Fallback -> Set L1 & L2
    await service.getOrSet('test-key', fallbackFn);
    
    mockL2Cache.get.mockClear();
    fallbackFn.mockClear();

    // Call 2: Hit L1
    const result2 = await service.getOrSet('test-key', fallbackFn);

    expect(result2).toEqual({ id: 1, name: 'Data' });
    expect(mockL2Cache.get).not.toHaveBeenCalled();
    expect(fallbackFn).not.toHaveBeenCalled();
  });
});
```

## Analisis Trade-Off Arsitektur

### Kelebihan
1. **Latensi Nano/Mikro Detik:** L1 in-memory menghilangkan overhead deserialisasi Redis dan latensi jaringan, menangani jutaan RPS per pod Node.js dengan CPU cost sangat rendah.
2. **Resiliensi Tinggi:** Jika jaringan Redis down atau terputus (L2 terganggu), sistem masih dapat bertahan sesaat melayani *hot data* lewat L1 cache, memberikan *graceful degradation*.
3. **Optimisasi Biaya L2:** Trafik pembacaan ke Redis/Valkey dipangkas drastis (hanya ketika L1 miss), mengurangi skala cluster Redis yang diperlukan, menekan biaya infrastruktur *cloud*.

### Kekurangan
1. **Inkonsistensi L1 Cache (Stale Data):** Jika L2 diubah oleh instance A, instance B masih akan melayani data usang (stale) dari L1 lokalnya sampai TTL-nya habis. Dibutuhkan mekanisme Pub/Sub ekstra (seperti Redis Pub/Sub broadcast) jika sinkronisasi seketika sangat mutlak.
2. **Penggunaan Memori Heap Node.js:** L1 memakan heap memori V8. Jika ukuran dan limit L1 (LRU max items) dikonfigurasi terlalu besar, OOM (Out-of-Memory) crash dan *Garbage Collection Pauses* akan terjadi.
3. **Kompleksitas Invalidation:** Menghapus atau meng-update data membutuhkan invalidasi yang terdistribusi lintas node (sulit untuk menjamin L1 cache tiap pod bersih 100% pada saat bersamaan).

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menggunakan L1 Cache tanpa Limit (OOM Risk)
```typescript
// BUKAN PRAKTIK TOP 1%
private readonly l1Cache = new Map<string, any>(); // ❌ Bahaya! Memory Leak!

async get(key: string) {
  // Map akan tumbuh tanpa batas sampai server crash
  if (this.l1Cache.has(key)) return this.l1Cache.get(key);
}
```
**Perbaikan ✅:** Selalu gunakan LRUCache (`lru-cache`) dengan konfigurasi `max` item eksplisit.

### ❌ Anti-Pattern 2: Menunggu Penulisan L2 Secara Sinkron
```typescript
// BUKAN PRAKTIK TOP 1%
const freshData = await fallback();
await this.l2Cache.set(key, JSON.stringify(freshData)); // ❌ Menghambat Response latensi
return freshData;
```
**Perbaikan ✅:** Jadikan proses set L2 bersifat asinkron (Fire and Forget) dan pastikan *unhandled promise rejection* ditangkap.

## Production Edge Cases
1. **L2 Thundering Herd / Dogpile:** Pada saat L2 miss, ribuan *request* secara paralel dapat menembus L1 dan L2 menuju database. Gunakan teknik *Promise Coalescing* atau Redlock untuk mencegah hal ini (dibahas pada materi Dogpile Cache).
2. **Redis Connection Timeout:** Jika Valkey/Redis *hang* atau *latency spike*, operasi `.get()` bisa tersangkut. Wajib membungkus *client* L2 dengan timeout (misalnya `Promise.race()` 50ms) agar segera jatuh (fallback) ke Database jika terlalu lambat.
3. **Serialization Cost:** Menyimpan objek JSON yang berukuran mega-byte ke L1 Cache menghabiskan CPU Node.js untuk `JSON.parse()`. Pertimbangkan kompresi atau menyimpan objek JavaScript langsung di L1, bukan *stringified* JSON (Namun hati-hati referensi objek dapat dimutasi tak sengaja oleh *caller*).
