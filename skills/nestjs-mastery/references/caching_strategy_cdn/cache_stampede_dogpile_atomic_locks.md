# Mitigasi Cache Stampede (Dogpile Effect) dengan Penguncian Atomik dan Probabilistic Early Expiration

**Cache Stampede** (atau Dogpile Effect) adalah bencana infrastruktur mematikan. Hal ini terjadi saat *hot cache* (data yang diakses ribuan kali per detik) kedaluwarsa secara mendadak (TTL expired). Akibatnya, ribuan *concurrent request* tidak menemukan data di cache (Cache Miss), lalu ribuan *request* tersebut bersamaan membombardir *Database* untuk melakukan rekalkulasi data. Hasilnya: koneksi DB habis, latensi meroket, dan berujung *Downtime* / *Outage* total.

Untuk mitigasi skala Enterprise, digunakan **Atomic Mutex Locking (Redlock)** di Redis untuk menjamin hanya **SATU request** yang menembus DB. Solusi lebih agresif adalah **Probabilistic Early Expiration (PER)**, di mana cache diperbarui asinkron *sebelum* TTL aslinya benar-benar habis, sehingga tidak pernah terjadi Cache Miss secara massal.

## Arsitektur Cache Stampede Mutex (Redlock)

```ascii
      Request A       Request B       Request C       Request D
          |               |               |               |
          |               |               |               |
       (Miss)          (Miss)          (Miss)          (Miss)
          |               |               |               |
  +-------v-------+-------v-------+-------v-------+-------v-------+
  |                   Redis / Valkey Distributed Cache            |
  +---------------+---------------+---------------+---------------+
          |               |               |               |
  (Try Lock: OK)   (Try Lock: NO)  (Try Lock: NO)  (Try Lock: NO)
          |               |               |               |
          |          (Wait/Poll)     (Wait/Poll)     (Wait/Poll)
          |               |               |               |
  +-------v-------+       |               |               |
  |               |       |               |               |
  | Primary DB /  |       |               |               |
  | Heavy Service |       |               |               |
  |               |       |               |               |
  +-------+-------+       |               |               |
          |               |               |               |
     (Result &            |               |               |
   Cache Updated)         |               |               |
          |               |               |               |
          +----(Lock Released)------------+---------------+
                          |
                    (Cache Hit pada poll selanjutnya, kembali cepat)
```

## Implementasi Produksi NestJS & TypeScript

Implementasi di bawah ini menggunakan integrasi *Redis* murni (`ioredis`) untuk melakukan `SET NX` (Set if Not eXists) sebagai *Distributed Mutex*.

```typescript
import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Nilai beta untuk algoritma Probabilistic Early Expiration (PER)
 * Biasanya berkisar antara 0.1 (sedikit overlap) hingga 1.0 (sangat agresif).
 */
const PER_BETA = 1.0;

export interface CacheEntry<T> {
  data: T;
  delta: number; // Durasi (ms) waktu yang dibutuhkan untuk membangun cache ini
  expiryTime: number; // Timestamp (ms) absolut kedaluwarsa
}

@Injectable()
export class StampedeProtectedCacheService {
  private readonly logger = new Logger(StampedeProtectedCacheService.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  /**
   * Strategi 1: Probabilistic Early Expiration (PER)
   * Formula XFetch algoritma: currentTime - (-delta * beta * log(rand())) >= expiryTime
   */
  async getWithPER<T>(
    key: string,
    ttlMs: number,
    factory: () => Promise<T>,
  ): Promise<T> {
    const rawCache = await this.redis.get(key);
    const now = Date.now();

    if (rawCache) {
      const entry = JSON.parse(rawCache) as CacheEntry<T>;
      
      // Hitung probabilitas rekalkulasi lebih awal (XFetch algorithm)
      const randomFactor = Math.log(Math.random());
      const probabilisticExpiry = entry.expiryTime - (entry.delta * PER_BETA * randomFactor);

      if (now >= probabilisticExpiry) {
        this.logger.debug(`[PER RECOMPUTE] Key: ${key}. Refreshing early in background.`);
        // Eksekusi background, jangan block request utama
        this.refreshCache(key, ttlMs, factory).catch((err: unknown) => {
          this.logger.error(`[PER ERROR] Background refresh failed for ${key}`, err);
        });
      }
      return entry.data; // Segera return data stale/hit
    }

    // Kasus Cold Cache (benar-benar tidak ada data). Harus block & compute.
    return this.fetchAndLock(key, ttlMs, factory);
  }

  /**
   * Strategi 2: Mutex Lock (Redlock pattern simplified)
   * Hanya 1 worker yang berhak memanggil factory().
   */
  private async fetchAndLock<T>(
    key: string,
    ttlMs: number,
    factory: () => Promise<T>,
  ): Promise<T> {
    const lockKey = `lock:${key}`;
    const lockVal = Math.random().toString(36).substring(7); // Token uniks untuk lock
    
    // Retry polling setup
    const maxRetries = 10;
    const retryDelayMs = 200;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // 1. Coba dapatkan kunci eksklusif, lock expired dalam 5 detik
      const acquired = await this.redis.set(lockKey, lockVal, 'PX', 5000, 'NX');

      if (acquired) {
        try {
          this.logger.debug(`[MUTEX ACQUIRED] Key: ${key} on attempt ${attempt}`);
          const start = Date.now();
          const data = await factory();
          const delta = Date.now() - start;

          const entry: CacheEntry<T> = {
            data,
            delta,
            expiryTime: Date.now() + ttlMs,
          };

          await this.redis.set(key, JSON.stringify(entry), 'PX', ttlMs);
          return data;
        } finally {
          // Hanya lepaskan lock jika kita yang punya. Gunakan Lua script agar atomik.
          const releaseLua = `
            if redis.call("get",KEYS[1]) == ARGV[1] then
                return redis.call("del",KEYS[1])
            else
                return 0
            end
          `;
          await this.redis.eval(releaseLua, 1, lockKey, lockVal);
        }
      }

      // 2. Jika gagal mendapat lock, tunggu dan coba ambil dari cache (mungkin worker lain selesai)
      this.logger.debug(`[MUTEX WAITING] Key: ${key} is locked by another process. Sleeping ${retryDelayMs}ms...`);
      await new Promise((res) => setTimeout(res, retryDelayMs));
      
      const checkCache = await this.redis.get(key);
      if (checkCache) {
        const entry = JSON.parse(checkCache) as CacheEntry<T>;
        return entry.data;
      }
    }

    throw new Error(`[CACHE STAMPEDE TIMEOUT] Failed to acquire lock or read cache for key: ${key}`);
  }

  private async refreshCache<T>(key: string, ttlMs: number, factory: () => Promise<T>): Promise<void> {
    // Redlock simplified di background agar tidak dogpile dari background worker
    const lockKey = `lock_bg:${key}`;
    const acquired = await this.redis.set(lockKey, '1', 'PX', 10000, 'NX');
    
    if (acquired) {
      try {
        const start = Date.now();
        const data = await factory();
        const delta = Date.now() - start;
        const entry: CacheEntry<T> = { data, delta, expiryTime: Date.now() + ttlMs };
        await this.redis.set(key, JSON.stringify(entry), 'PX', ttlMs);
      } finally {
        await this.redis.del(lockKey);
      }
    }
  }
}
```

## Unit Testing & Cache Mock Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { StampedeProtectedCacheService } from './stampede-protected.service';

describe('StampedeProtectedCacheService', () => {
  let service: StampedeProtectedCacheService;
  let mockRedis: any;

  beforeEach(async () => {
    mockRedis = {
      get: jest.fn(),
      set: jest.fn(),
      eval: jest.fn(),
      del: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StampedeProtectedCacheService,
        { provide: 'REDIS_CLIENT', useValue: mockRedis },
      ],
    }).compile();

    service = module.get<StampedeProtectedCacheService>(StampedeProtectedCacheService);
  });

  it('seharusnya mengeksekusi factory hanya SEKALI dalam situasi Cold Cache', async () => {
    // Simulasi Cache Miss selalu
    mockRedis.get.mockResolvedValue(null);
    
    // Pekerja pertama sukses mengambil lock
    mockRedis.set.mockResolvedValueOnce('OK'); // Lock success
    mockRedis.set.mockResolvedValueOnce('OK'); // Set Cache success
    mockRedis.eval.mockResolvedValueOnce(1); // Release lock success

    const factorySpy = jest.fn().mockResolvedValue('DB_DATA');

    const result = await service['fetchAndLock']('key_1', 10000, factorySpy);

    expect(result).toBe('DB_DATA');
    expect(factorySpy).toHaveBeenCalledTimes(1);
    expect(mockRedis.set).toHaveBeenCalledWith('lock:key_1', expect.any(String), 'PX', 5000, 'NX');
  });

  it('seharusnya melakukan polling jika tidak mendapat lock', async () => {
    mockRedis.get
      .mockResolvedValueOnce(null) // Cek cache sebelum loop: miss
      .mockResolvedValueOnce(JSON.stringify({ data: 'CACHED_DATA', delta: 10, expiryTime: 999 })); // Loop cek cache: hit!
    
    // Gagal dapat lock (nil)
    mockRedis.set.mockResolvedValue(null);

    const factorySpy = jest.fn().mockResolvedValue('DB_DATA');

    const result = await service['fetchAndLock']('key_1', 10000, factorySpy);

    expect(result).toBe('CACHED_DATA');
    // Factory tidak boleh dipanggil karena menunggu hasil worker lain!
    expect(factorySpy).not.toHaveBeenCalled(); 
  });
});
```

## Analisis Trade-Off Arsitektur

### Kelebihan
1. **Perlindungan DB Absolut:** Menjamin *database* hanya menerima 1 kueri kalkulasi berat meskipun diserang jutaan request simultan (Cache Stampede). Mencegah *Spike CPU* database.
2. **Latensi Halus (Smooth Latency):** Dengan *Probabilistic Early Expiration*, *client* nyaris tidak akan pernah merasakan jeda kalkulasi DB. Background worker memperbarui *cache* sebelum TTL utama habis, menjamin latensi konstan ultra rendah.
3. **Mencegah Memory Leak Koneksi:** Daripada merusak pool koneksi DB dengan ribuan kueri gagal, Mutex memastikan request lain diam (`sleep`) atau langsung mengonsumsi hasil akhir dari Redis.

### Kekurangan
1. **Kompleksitas Kode & Redlock Overhead:** Penambahan *locking*, *unlocking* dengan Lua Script, dan siklus tunggu (polling loop) menambah kerumitan alur kode dan sulit untuk di-debug jika terjadi *Deadlock*.
2. **Stale Data dalam Jendela Polling:** Worker yang *menunggu/poll* mungkin harus rela menerima penundaan (*delay*) ratusan milidetik sebelum worker utama merilis hasilnya ke Redis.
3. **Throttling Thread Event-Loop:** Menggunakan `setTimeout` dalam loop polling secara agresif pada request konkurensi masif dapat meningkatkan tekanan pada *event-loop* Node.js, mempengaruhi performa endpoint asinkron lain.

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menggunakan Non-Atomic Delete untuk melepas Lock
```typescript
// BUKAN PRAKTIK TOP 1%
// Worker A memperoleh Lock. Selesai memproses terlalu lama (Lock terlanjur expired).
// Worker B mengambil Lock.
// Worker A akhirnya selesai dan menghapus key.
await this.redis.del('lock:key'); // ❌ BAHAYA: Worker A menghapus Lock milik Worker B!
```
**Perbaikan ✅:** Wajib mencocokkan Lock Value (token unik random) menggunakan Lua script secara atomik. Jika Token beda, Lock tersebut bukan miliknya.

### ❌ Anti-Pattern 2: Pemanggilan Fallback Tanpa Jeda/Mutex
```typescript
// BUKAN PRAKTIK TOP 1%
let data = await redis.get(key);
if (!data) {
  // ❌ 10,000 request bersamaan masuk ke baris ini menembak DB
  data = await runHeavyDBSQL(); 
  await redis.set(key, data);
}
```
**Perbaikan ✅:** Implementasikan pattern Redlock NX atau antrean antrean lokalisir (Promise-Coalescing Map lokal sebelum Redis Mutex).

## Production Edge Cases
1. **Worker Meninggal saat Memegang Lock:** Jika worker A memegang lock dan server crash (OOM, restart), lock akan tersangkut. Oleh karena itu, kita selalu memberikan TTL (PX) pendek pada *Lock* (misalnya 5 detik), agar lock kedaluwarsa secara mandiri (Deadlock terhindarkan).
2. **Clock Drift antar Node:** Waktu server Redis dan pod Node.js mungkin bergeser mili-detik. Konsep *expiryTime* absolut dalam *Probabilistic Early Expiration* bisa diandalkan hanya jika NTP terkalibrasi baik. Penggunaan parameter *delta latency* meminimalisir deviasi ini.
3. **Re-entrant Lock Need:** Terkadang satu *request context* butuh memanggil cache terproteksi yang sama lebih dari sekali. Redlock sederhana tidak bersifat *re-entrant*, yang dapat memblokir dirinya sendiri (deadlock mandiri). Pastikan level granulasi key unik berdasar *method parameter*.
