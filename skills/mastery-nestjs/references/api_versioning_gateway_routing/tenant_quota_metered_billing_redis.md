# Panduan Enterprise: Pengukuran Kuota Dinamis & Metered Billing (Redis Valkey)

Model bisnis SaaS modern (seperti Stripe atau OpenAI) mengandalkan arsitektur *Metered Billing* (bayar sesuai pemakaian) dan batas kuota ketat (Rate Limiting) per tenant/akun. Dokumen ini membahas implementasi API Quota Metering skala besar di NestJS dengan algoritma *Fixed Window Counter* berbasis Redis.

## 1. Arsitektur Sinkronisasi Quota & Webhook Billing

Metering harus dieksekusi secara instan in-memory, sementara data penagihan direkonsiliasi asinkron (misal: Stripe Webhooks).

```text
[Klien API / Tenant]
       | (Request dengan API Key: sk_live_xyz)
       v
+------------------------------------+       +----------------------------+
|        NESTJS METERING GUARD       | ----> | REDIS / VALKEY (In-Memory) |
| 1. Evaluasi Quota Berdasarkan Paket|       | Kunci: quota:tenant_id:MM  |
| 2. Increment Penggunaan (INCR)     | <---- | Nilai: Current Usage       |
+------------------------------------+       +----------------------------+
       | Lolos Limit
       v
[Controller / Microservice Internal]
       |
       +---> (Event Bus / Kafka) ---> [Billing Microservice (Sync to Stripe)]
```

## 2. Implementasi Metering Guard Berbasis Redis

Kita akan mengimplementasikan Guard NestJS yang melakukan kalkulasi kuota bulanan berjalan. Redis dipilih karena menjamin atomicity (`INCR` command).

```typescript
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import Redis from 'ioredis';

// Konfigurasi Paket Kuota (Biasanya diambil dari DB/Cache)
export const TIER_LIMITS: Record<string, number> = {
  FREE: 1000,       // 1.000 req / bulan
  PRO: 100000,      // 100.000 req / bulan
  ENTERPRISE: -1,   // -1 berarti tak terbatas
};

// Interface yang mengasumsikan tipe Klien/Tenant telah disiapkan oleh Middleware Auth
export interface TenantInfo {
  id: string;
  tier: 'FREE' | 'PRO' | 'ENTERPRISE';
}

@Injectable()
export class QuotaMeteringGuard implements CanActivate {
  private readonly redisClient: Redis;

  constructor(private readonly reflector: Reflector) {
    // Inisialisasi koneksi Redis (Gunakan proses.env di produksi)
    this.redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const tenant: TenantInfo | undefined = request.user; // Di-populate oleh AuthGuard

    if (!tenant) {
      throw new HttpException('Tenant Identification Required', HttpStatus.UNAUTHORIZED);
    }

    const limit = TIER_LIMITS[tenant.tier];

    // Jika unlimited, lewati pengecekan Redis
    if (limit === -1) {
      return true;
    }

    // Pembuatan kunci Redis unik per bulan. Contoh: quota:tenant_123:2024-10
    const currentMonth = new Date().toISOString().slice(0, 7);
    const quotaKey = `quota:${tenant.id}:${currentMonth}`;

    try {
      // Operasi Atomik Increment di Redis
      const currentUsage = await this.redisClient.incr(quotaKey);

      // Set expiration untuk kunci (bersihkan RAM setelah bulan berganti + margin 2 hari)
      if (currentUsage === 1) {
        await this.redisClient.expire(quotaKey, 60 * 60 * 24 * 33); 
      }

      const response = context.switchToHttp().getResponse();
      
      // Injeksi header rate-limit standar untuk transparansi klien
      response.header('X-RateLimit-Limit', limit.toString());
      response.header('X-RateLimit-Remaining', Math.max(0, limit - currentUsage).toString());

      if (currentUsage > limit) {
        throw new HttpException({
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Quota Exceeded',
          message: `Your ${tenant.tier} tier limit of ${limit} requests/month has been reached. Please upgrade your plan.`,
        }, HttpStatus.TOO_MANY_REQUESTS);
      }

      return true;
    } catch (err) {
      // Failsafe: Jika redis mati, jangan blokir request (Degraded Mode), log error
      if (err instanceof HttpException) {
        throw err; // Lempar ulang jika memang karena kuota habis
      }
      console.error('[Quota Guard] Redis Error:', err);
      return true; // Allow gracefully
    }
  }
}
```

## 3. Test Suite (Jest) Metering Logic

```typescript
import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { QuotaMeteringGuard } from './quota-metering.guard';

// Mock Redis global
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => {
    return {
      incr: jest.fn(),
      expire: jest.fn(),
    };
  });
});

describe('QuotaMeteringGuard', () => {
  let guard: QuotaMeteringGuard;
  let redisIncrMock: jest.Mock;

  beforeEach(() => {
    guard = new QuotaMeteringGuard(new Reflector());
    // Akses mock redis client internal
    redisIncrMock = (guard as any).redisClient.incr as jest.Mock;
  });

  it('should allow request and set headers when quota is below limit', async () => {
    redisIncrMock.mockResolvedValue(500); // Klien sudah pakai 500

    const mockReply = {
      header: jest.fn(),
    };

    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { id: 'tnt_1', tier: 'FREE' } }),
        getResponse: () => mockReply,
      }),
    } as unknown as ExecutionContext;

    const result = await guard.canActivate(mockContext);
    
    expect(result).toBe(true);
    expect(mockReply.header).toHaveBeenCalledWith('X-RateLimit-Limit', '1000');
    expect(mockReply.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '500');
  });

  it('should throw 429 HttpException when limit is exceeded', async () => {
    redisIncrMock.mockResolvedValue(1001); // Pemakaian melewati batas

    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { id: 'tnt_2', tier: 'FREE' } }),
        getResponse: () => ({ header: jest.fn() }),
      }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(mockContext)).rejects.toThrow(HttpException);
    await expect(guard.canActivate(mockContext)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });
});
```

## 4. Trade-Off Analisis (Redis Fixed Window Metering)

**Kelebihan:**
1. **Performa Instan:** Evaluasi latensi sub-milidetik (0.1ms - 0.5ms), krusial untuk API Gateway dengan traffic sangat tinggi.
2. **Atomicity Pasti:** Menggunakan command `INCR` Redis menjamin tidak ada race condition mesikpun ada ratusan server gateway bersamaan mengkalkulasi kuota pengguna yang sama.
3. **Memory O(1):** Konsumsi memori sangat konstan, satu pengguna cukup 1 key string per bulan.

**Kekurangan:**
1. **Toleransi Spiky Traffic:** Karena Fixed Window, tidak menghalangi burst attack tiba-tiba di dalam kuota (misal: menghabiskan kuota 100k req dalam 1 detik yang bikin backend DB jebol). Butuh layer Token Bucket tambahan per-detik.
2. **Dependency Silo:** Arsitektur menjadi sangat bergantung pada konektivitas Redis. Kegagalan node Redis akan membutuhkan mitigasi bypass kuota sementara.
3. **Tingkat Akurasi Billing Finansial:** Jika aplikasi mati di tengah memproses bisnis *setelah* melewati Guard (kuota sudah kepotong), maka kuota hilang tetapi *value* tidak diterima user (False Positive metering).

## 5. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Metering Kuota Memakai SQL Database Read-Write
Membaca kolom `usage_count` di Postgres, lalu menambahkannya di memory, lalu menyimpan kembali (Read-Modify-Write) tanpa explicit locking berisiko overwriting dan latensi fatal.

```typescript
// ❌ BURUK: Race condition & sangat lambat
const tenant = await repo.findOne({ id });
if (tenant.usage > limit) throw Error();
tenant.usage++; 
await repo.save(tenant); 
```

### ✅ Solusi 1: Memory-First Atomic Operation
Serahkan tugas perhitungan increment presisi ke struktur data memori (Redis INCR / Memcached).

### ❌ Anti-Pattern 2: Hard Block Tanpa Degradation
Jika Redis Cloud sedang RTO (Request Timeout), guard membanting 500 error ke semua pelanggan aktif yang sedang bertransaksi.

```typescript
// ❌ BURUK: Single point of failure menghentikan bisnis utama
const current = await this.redis.incr(key); // Kalau fail, melempar Exception tak ter-handle
```

### ✅ Solusi 2: Graceful Degradation / Fail-Open Pattern
Bungkus try-catch, dan biarkan transaksi berlanjut jika redis gagal (`return true` pada catch block), mengutamakan *revenue continuity* dibanding *strict limits* parsial.

## 6. Production Edge Cases

1. **Reconciliation Webhook Lags:** Ketika pelanggan meng-upgrade plan dari `FREE` ke `PRO` via Stripe Checkout, webhook mungkin telat 5-10 detik tiba di server. Klien berpotensi masih kena 429 Limit sementara waktu. Perlu mitigasi sinkronisasi token atau *optimistic quota bumps* pada UI.
2. **Idempotency Deduction:** Client terputus koneksinya (TCP Drop) sebelum menerima JSON response dari server, lalu dia melakukan *Retry*. Metering Guard akan memotong saldo kuota *dua kali* untuk transaksi yang sama. Anda butuh mekanisme *Idempotency-Key* khusus pemotongan biaya.
3. **Cross-Region Redis Latency:** Untuk API Multi-Region (Global Edge Network), Redis master node di satu benua bisa menyebabkan ping bottleneck saat increment kuota. Strateginya menggunakan arsitektur *Local-Counter Batching* (buffer in-memory lokal diakumulasi lalu dibilas ke Redis pusat tiap 1 detik), pengorbanannya sedikit *over-quota allowance*.
