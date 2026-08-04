# Pembasmian Serangan DDOS & Brute Force dengan Redis Throttler

Salah satu eksploitasi Zero-Day pada layanan API adalah pemboman permintaan skala besar (Denial of Service/DDOS) maupun upaya *brute-force* pada endpoint kritis (seperti form Login atau OTP). Menerapkan modul `@nestjs/throttler` yang didorong oleh *Cluster* **Redis** (atau **Valkey**) sebagai penyimpan persediaan token (Token Bucket Algorithm) menjamin konsistensi batasan *rate limit* secara global melintasi banyak instance (horizontal scaling).

## Arsitektur Redis Token Bucket Rate Limiting

```ascii
[Penyerang (IP 192.168.1.50)]           [Klien Sah (User ID 502)]
               |                                      |
     (Mengirim 200 req/detik)               (Mengirim 2 req/detik)
               v                                      v
+--------------------------------------------------------------------------+
|                        NestJS API Gateway / Load Balancer                |
|                                                                          |
|       +----------------------------------------------------------+       |
|       |                     Throttler Guard                      |       |
|       | 1. Evaluasi Tipe Throttler (Default / Short / Custom)    |       |
|       | 2. Menghasilkan Tracker Key (berdasarkan IP / User ID)   |       |
|       +----------------------------------------------------------+       |
|                                     |                                    |
+-------------------------------------|------------------------------------+
                                      v
                  +---------------------------------------+
                  |         Redis / Valkey Cluster        |
                  |                                       |
                  | [Tracker: IP_192.168.1.50]            |
                  |  - TTL: 60 Detik                      |
                  |  - Hits: 200 (Melebihi Limit!)  -> 429|
                  |                                       |
                  | [Tracker: User_502]                   |
                  |  - TTL: 60 Detik                      |
                  |  - Hits: 2 (Aman, Lanjutkan)    -> 200|
                  +---------------------------------------+
```

## Implementasi Kode: TypeScript & NestJS 10+

### 1. Modul Throttler Global dan Integrasi Redis Storage

```typescript
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard, seconds } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from 'nestjs-throttler-storage-redis';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';

@Module({
  imports: [
    ConfigModule.forRoot(),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Definisi batasan yang dinamis (buckets)
        throttlers: [
          {
            name: 'short',     // Proteksi lonjakan drastis (Spike)
            ttl: seconds(1),   // 1 Detik
            limit: 3,          // Maks 3 request
          },
          {
            name: 'default',   // Batasan standar pemakaian wajar
            ttl: seconds(60),  // 1 Menit
            limit: 100,        // Maks 100 request
          },
        ],
        // Menautkan state tracker lintas server menggunakan Redis / Valkey
        storage: new ThrottlerStorageRedisService({
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD'),
        }),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    {
      // Mengunci seluruh endpoint secara global di tingkat aplikasi
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
```

### 2. Kustomisasi Guard: Membatasi Berdasarkan *User ID* & Rute Kritis (OTP / Login)

```typescript
import { Injectable, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';
import { Request } from 'express'; // Atau FastifyRequest

@Injectable()
export class WafThrottlerGuard extends ThrottlerGuard {
  
  // Customisasi pesan error HTTP 429
  protected throwThrottlingException(context: ExecutionContext): void {
    throw new HttpException(
      'Terlalu banyak permintaan! Sistem keamanan memblokir aktivitas Anda. Tunggu beberapa saat.', 
      HttpStatus.TOO_MANY_REQUESTS
    );
  }

  // Mengubah mekanisme Tracking Key (Default IP Address, diganti menjadi kombinasi spesifik)
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const request = req as Request;
    
    // Jika User sudah login, tracking berdasarkan User ID, jika belum, tracking IP-nya (X-Forwarded-For)
    // Hal ini mengatasi kelemahan "Satu Kantor (1 IP Publik) diblokir bersamaan" NAT Issue.
    const user = (request as any).user;
    if (user && user.id) {
       return `tracker_user:${user.id}`;
    }
    
    // Menggunakan IP proxy jika berada di belakang Load Balancer
    const ip = request.ips.length ? request.ips[0] : request.ip;
    return `tracker_ip:${ip}`;
  }
}
```

### 3. Override Bucket Limit di Controller

```typescript
import { Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { WafThrottlerGuard } from './waf-throttler.guard';

// Menerapkan Custom Throttler Guard
@UseGuards(WafThrottlerGuard)
@Controller('auth')
export class AuthController {
  
  @Post('login')
  // OVERRIDE: Login sangat rawan brute-force. Set ketat: maksimal 5 percobaan per 1 menit!
  @Throttle({ default: { limit: 5, ttl: 60000 } }) 
  public async login() {
    return { token: 'jwt...' };
  }

  @Post('webhook/internal')
  // PENGECUALIAN: Internal event atau Service-to-Service webhook dibebaskan dari limit.
  @SkipThrottle()
  public async handleWebhook() {
    return { success: true };
  }
}
```

## Analisis Trade-Off

### Kelebihan
1. **Ketahanan Horisontal (Stateless Storage):** Dengan menyimpan token di Redis (bukan di memori RAM instance aplikasi via `memoryStorage`), *rate limiting* akan tetap konsisten meskipun Anda merentangkan NestJS ke 50 *pod* Kubernetes.
2. **Fleksibilitas Granular:** Decorator `@Throttle` memungkinkan insinyur mendesain batas berbeda-beda per endpoint, mengakomodasi sifat resource-heavy (misal eksport PDF, maks 2 req/menit) dan resource-light (Health check ping).
3. **Penyelamat Database (Anti-Crash):** Membatasi akses *brute-force* mencegah badai beban berat (*avalanche effect*) menghempas SQL database pada operasi mahal (seperti hashing bcrypt password saat login).

### Kekurangan
1. **Network Overhead pada Redis:** Setiap *request* yang masuk harus melakukan *round-trip* komunikasi I/O jaringan ke Redis terlebih dahulu sebelum masuk Controller. Redis yang lambat (Network Bottleneck) akan menurunkan TPS (Transactions Per Second) seluruh API.
2. **Risiko Kolisi di NAT (Network Address Translation):** Memblokir semata-mata berdasarkan IP Address Publik bisa merugikan (false positive) satu universitas/kafe yang menggunakan jaringan *Wifi* yang sama ketika satu klien berulah nakal (Noisy Neighbor).
3. **Kompleksitas Failover:** Apabila klaster Redis down atau *unreachable*, aplikasi mungkin macet melempar error (`ECONNREFUSED` saat ThrottlerGuard beraksi), mendadak mengunci seluruh koneksi API jika tidak diatur mode perlakuan *graceful degradation*.

## Anti-Patterns Kritis

### Anti-Pattern 1: Menggunakan Default In-Memory Storage di Produksi Skala Besar
❌ **Salah:** Mengandalkan RAM per-instance NodeJS.
```typescript
ThrottlerModule.forRoot([{
  ttl: 60000,
  limit: 10,
  // Tidak ada konfigurasi storage = default in-memory.
}])
```
Jika Load Balancer menyebar traffic ke 5 server Node.js secara berurutan (Round Robin), penyerang secara aktual memiliki limit `10 x 5 = 50 req` sebelum terblokir semuanya. Ini merusak sistem kalkulasi limit!

✅ **Benar:** Selalu inisiasikan `ThrottlerStorageRedisService` di env Produksi agar perhitungan tersinkronisasi murni.

### Anti-Pattern 2: Lupa Mendekode IP di Balik Cloudflare/Nginx
❌ **Salah:** `req.ip` mengembalikan IP dari *Nginx Reverse Proxy* (contoh: `127.0.0.1` atau `10.x.x.x`). Guard akan memblokir Nginx dan menghentikan seluruh layanan bagi semua pengguna di dunia!
```typescript
// tracker berbasis req.ip default dari express.
```

✅ **Benar:** Aktifkan *trust proxy* di Fastify/Express config, dan manfaatkan header spesifik seperti `X-Forwarded-For` atau implementasikan override algoritma di `getTracker()` milik `ThrottlerGuard` custom.

## Production Edge Cases

1. **Redis OOM (Out Of Memory):** Jika jutaan *distinct IP* membanjiri API dalam beberapa menit (Global Botnet Attack), key tracking di Redis bisa memakan gigabytes memori hingga crash. Solusi: Gunakan Redis eviction policy `volatile-lru` dan batasi `maxmemory`. Atau delegasikan layer pertama DDoS di Web Application Firewall eksternal (Cloudflare WAF / AWS Shield).
2. **Serangan Lambat / L7 Slowloris Attack:** Throttler hanya menghitung permintaan selesai/masuk. Serangan lambat yang secara konstan membiarkan koneksi TCP terbuka belum tuntas (meneteskan header per 5 detik) tidak akan terblokir efisien. Solusi: Settingan Timeout HTTP (seperti Fastify `connectionTimeout`) wajib difungsikan berdampingan.
3. **GraphQL Endpoints:** `@nestjs/throttler` di GraphQL dapat berlaku keliru (terhitung per Query GraphQL di satu rute POST `/graphql`, bukan per operasi resolusi data). Membutuhkan instalasi paket dan guard ekstensi khusus GraphQL yaitu `GqlThrottlerGuard`.

## Unit / Integration Testing Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { Controller, Get, UseGuards, INestApplication } from '@nestjs/common';
import { ThrottlerModule, Throttle } from '@nestjs/throttler';
import * as request from 'supertest';
import { WafThrottlerGuard } from './waf-throttler.guard';

@Controller('test')
@UseGuards(WafThrottlerGuard)
class TestController {
  @Get('normal')
  // Limit super ketat untuk testing: 2 per detik
  @Throttle({ default: { limit: 2, ttl: 1000 } })
  getNormal() {
    return { ok: true };
  }
}

describe('DDOS Throttler Security Suite', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([{
          name: 'default',
          ttl: 1000,
          limit: 2,
        }]),
      ],
      controllers: [TestController],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('harus memblokir permintaan ketiga dalam jeda waktu singkat (HTTP 429)', async () => {
    const server = app.getHttpServer();

    // Req 1 - Sukses
    await request(server).get('/test/normal').expect(200);
    // Req 2 - Sukses (Batas maksimal)
    await request(server).get('/test/normal').expect(200);

    // Req 3 - Melebihi batas (Limit 2)! Harus memicu Exception 429
    const res = await request(server).get('/test/normal').expect(429);
    
    expect(res.body.statusCode).toBe(429);
    expect(res.body.message).toContain('Terlalu banyak permintaan! Sistem keamanan memblokir');
  });

  it('harus mengizinkan kembali permintaan setelah durasi TTL (1 detik) habis', async () => {
    const server = app.getHttpServer();

    // Memblokir kuota 
    await request(server).get('/test/normal');
    await request(server).get('/test/normal');
    await request(server).get('/test/normal').expect(429);

    // Menunggu TTL habis (lebih dari 1 detik)
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Req 4 - Sukses kembali karena state tracker sudah di-flush/expired
    await request(server).get('/test/normal').expect(200);
  });
});
```
