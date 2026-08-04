# Redis Valkey: In-Memory Persistence & Distributed Locking di NestJS

Redis (dan *fork* performa tinggi seperti Valkey) bukan sekadar layer Cache L1, melainkan tulang punggung utama dalam arsitektur mikro untuk *Distributed Locks*, *Rate Limiting*, dan *Real-time Ring Buffers*. Pada sistem terdistribusi NestJS, Redis memecahkan masalah *Race Conditions* ganda secara elegan.

## 1. Arsitektur Redis Redlock

Ketika dua buah instance (Pod A & Pod B) mencoba mengeksekusi *cron job* atau menyedot saldo pengguna di waktu yang persis sama, perlindungan kunci di memori sangat dibutuhkan.

```ascii
+----------------+        (1) SET resource_id NX PX 30000    +----------------+
|  NestJS Pod A  | ----------------------------------------> | Redis (Valkey) |
| (Acquires Lock)| <---------------------------------------- |   [Node 1]     |
+----------------+        (2) OK (Lock Granted)              +----------------+
        |
        v
+----------------+        (1) SET resource_id NX PX 30000    +----------------+
|  NestJS Pod B  | ----------------------------------------> | Redis (Valkey) |
| (Fails to Lock)| <---------------------------------------- |   [Node 1]     |
+----------------+        (2) NIL (Resource Blocked)         +----------------+
```

## 2. Inisialisasi Klien Redis IO-Redis

Kita menggunakan library `ioredis` alih-alih `redis` standar karena dukungan cluster dan *pipelining* yang superior.

```typescript
// redis.module.ts
import { Module, Global } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () => {
        const client = new Redis(process.env.REDIS_URL, {
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          // Reconnect logic
          retryStrategy: (times: number) => {
            return Math.min(times * 50, 2000);
          },
        });
        
        client.on('error', (err) => console.error('Redis Client Error', err));
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
```

## 3. Implementasi Redlock (Distributed Locking)

Penguncian untuk menembus persaingan antrean microservices. Mutex ini digunakan demi mencegah *Double Spending* atau eksekusi duplikat.

```typescript
// distributed-lock.service.ts
import { Injectable, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { REDIS_CLIENT } from './redis.module';

@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Mengeksekusi blok kode secara aman dari concurrent execution
   */
  async executeWithLock<T>(
    resource: string,
    ttlMs: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lockKey = `lock:${resource}`;
    const lockValue = uuidv4(); // Nilai acak unik (mencegah Pod lain melepas lock ini)
    
    // NX: Set If Not Exists | PX: Expiration in ms
    const acquired = await this.redis.set(lockKey, lockValue, 'PX', ttlMs, 'NX');

    if (!acquired) {
      throw new Error(`Resource ${resource} is currently locked by another process`);
    }

    try {
      this.logger.log(`Lock acquired on ${resource}`);
      return await operation();
    } finally {
      // Skrip LUA atomik: Hanya hapus kunci JIKA value (uuid) masih cocok
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        else
            return 0
        end
      `;
      await this.redis.eval(luaScript, 1, lockKey, lockValue);
      this.logger.log(`Lock released on ${resource}`);
    }
  }
}
```

## 4. Anti-Patterns & Best Practices

### ❌ Anti-Pattern: Mengunci dengan Mutasi Non-Atomik
```typescript
// SANGAT BURUK: Ada jeda di mana dua pod bisa membaca nilai yang sama secara simultan
async lockBad(key: string): Promise<boolean> {
  const isLocked = await this.redis.get(key);
  if (!isLocked) {
    await this.redis.set(key, 'locked'); // RACE CONDITION TERJADI DI SINI!
    return true;
  }
  return false;
}
```

### ✅ Best Practice: Ring Buffer untuk Polling Data (O(1))
Jika kita butuh menyimpan *Event Logging* atau stream singkat tanpa membebani SQL.
```typescript
// Menyimpan jejak API terbaru, menghapus data lama otomatis via LTRIM (O(N) operation -> O(1) in small sets)
async addTraceToBuffer(userId: string, event: object): Promise<void> {
  const key = `trace:${userId}`;
  const pipeline = this.redis.pipeline();
  pipeline.lpush(key, JSON.stringify(event));
  pipeline.ltrim(key, 0, 99); // Hanya simpan 100 entri terbaru
  pipeline.expire(key, 3600); // Kadaluarsa total buffer dalam 1 jam
  await pipeline.exec();
}
```

## 5. Analisis Trade-Off

### Kelebihan
1. **Kecepatan Ekstrem (Microsecond):** Sangat ideal untuk penghitungan beban *rate limiting* tinggi (100k+ TPS).
2. **Operasi Atomik (Lua Scripting):** Mencegah korupsi data tanpa konfigurasi tabel transaksional yang kompleks.
3. **Data Structures:** Struktur khusus seperti HyperLogLog, Sorted Sets untuk *Leaderboards*, dan Geospatial mumpuni.

### Kekurangan
1. **Volatile by Default:** Tanpa konfigurasi AOF/RDB yang tepat, data akan musnah jika node *reboot*.
2. **OOM Crashing:** Jika kunci tidak diberi batas kedaluwarsa (TTL), RAM akan penuh dan *Redis server* akan crash/menolak tulis.
3. **Network Bound:** Walau eksekusi memori cepat, tetap ada limitasi *latency I/O network* dibanding *In-App LRU Cache*.

## 6. Production Edge Cases

1. **Thundering Herd Problem:** Saat sebuah kunci sentral *cache* yang sangat sering dibaca hilang/kedaluwarsa, 10,000 requests dalam detik itu menembus ke DB asli. Gunakan mitigasi cache-warming awal atau probabilistic early expiration.
2. **Zombie Locks:** Jika *Node* mendapatkan kunci Redis tetapi *Node CPU* *stuck* karena garbage collection yang lama, *Lock* kadaluwarsa sendiri dan pod lain masuk. Ketika Node pertama bangun kembali, terjadi kebingungan eksekusi ganda. Penawar: *Fencing Tokens*.
3. **Cluster Key Hashing:** Di *Redis Cluster Mode*, operasi Multi-Key (seperti pipelining atau MGET) akan gagal *CROSSSLOT error* jika kunci-kuncinya jatuh ke _hash slot_ yang berbeda. Harus diselesaikan menggunakan kurung kurawal `{userId}:data`, `{userId}:meta` agar di-*hash* ke mesin yang sama.

## 7. Unit Testing (Jest)

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { DistributedLockService } from './distributed-lock.service';
import { REDIS_CLIENT } from './redis.module';

describe('DistributedLockService', () => {
  let service: DistributedLockService;
  let mockRedis: any;

  beforeEach(async () => {
    mockRedis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DistributedLockService,
        {
          provide: REDIS_CLIENT,
          useValue: mockRedis,
        },
      ],
    }).compile();

    service = module.get<DistributedLockService>(DistributedLockService);
  });

  it('should acquire lock and execute operation', async () => {
    const mockOperation = jest.fn().mockResolvedValue('success');
    
    const result = await service.executeWithLock('my-resource', 5000, mockOperation);
    
    expect(mockRedis.set).toHaveBeenCalledWith(
      'lock:my-resource',
      expect.any(String),
      'PX',
      5000,
      'NX'
    );
    expect(mockOperation).toHaveBeenCalled();
    expect(mockRedis.eval).toHaveBeenCalled();
    expect(result).toBe('success');
  });

  it('should throw error if lock is not acquired', async () => {
    // Redis mengembalikan null saat NX gagal
    mockRedis.set.mockResolvedValueOnce(null);
    const mockOperation = jest.fn();

    await expect(
      service.executeWithLock('my-resource', 5000, mockOperation)
    ).rejects.toThrow('currently locked');
    
    expect(mockOperation).not.toHaveBeenCalled();
  });
});
```
