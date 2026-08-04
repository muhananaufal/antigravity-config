# Panduan Enterprise: Membangun API Gateway Agregator (BFF) & Reverse Proxy (NestJS Fastify)

Pola Backend for Frontend (BFF) via API Gateway merupakan tulang punggung arsitektur microservices. Dokumen ini mendemonstrasikan implementasi Reverse Proxy berkecepatan tinggi menggunakan NestJS dan engine Fastify (via `@fastify/http-proxy`) lengkap dengan propagasi auth, penanganan timeout, dan retry policies.

## 1. Arsitektur API Gateway

API Gateway berdiri di garda terdepan untuk memotong request eksternal, memvalidasi otorisasi, dan mem-proxy beban ke layanan backend secara stream tanpa buffer memori penuh (High-Performance Stream Forwarding).

```text
[Web Client / Mobile App]
          | (HTTPS / REST)
          v
+-------------------------------------------------------+
|                 NESTJS API GATEWAY                    |
| 1. Authentication Check (JWT)                         |
| 2. Rate Limiting / Security Headers                   |
| 3. Fastify HTTP Proxy (Streaming)                     |
+-------------------------------------------------------+
          |                       |
(Proxy to /users)          (Proxy to /payments)
          |                       |
          v                       v
[Microservice A (Users)]   [Microservice B (Payments)]
```

## 2. Implementasi Reverse Proxy NestJS Fastify

Kita akan memanfaatkan modul proxy native Fastify yang sangat cepat dibandingkan middleware Express-based.

```typescript
import { 
  Controller, 
  All, 
  Req, 
  Res, 
  Injectable, 
  NestMiddleware,
  HttpException,
  HttpStatus
} from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import proxy from '@fastify/http-proxy';
import { HttpAdapterHost } from '@nestjs/core';

@Injectable()
export class GatewayProxyService {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  public registerProxyRoutes(): void {
    const fastifyInstance = this.adapterHost.httpAdapter.getInstance();

    // Proxy Service 1: Users (Upstream: HTTP)
    fastifyInstance.register(proxy, {
      upstream: process.env.UPSTREAM_USER_SERVICE_URL || 'http://localhost:4001',
      prefix: '/api/v1/users',
      rewritePrefix: '/v1/users',
      http2: false,
      replyOptions: {
        // Retry policy & timeout handling bawaan proxy
        rewriteRequestHeaders: (request: FastifyRequest, headers: Record<string, string>) => {
          return {
            ...headers,
            'x-gateway-timestamp': Date.now().toString(),
            // Propagasi auth header yang lolos dari middleware otentikasi
            'x-user-id': (request as any).user?.id || 'anonymous',
          };
        },
        onError: (reply: FastifyReply, error: Record<string, unknown>) => {
          reply.status(502).send({
            statusCode: 502,
            error: 'Bad Gateway',
            message: 'Upstream user service is unreachable or timed out.',
            details: error.message || 'Unknown upstream error'
          });
        }
      }
    });

    // Proxy Service 2: Payments
    fastifyInstance.register(proxy, {
      upstream: process.env.UPSTREAM_PAYMENT_SERVICE_URL || 'http://localhost:4002',
      prefix: '/api/v1/payments',
      rewritePrefix: '/payments',
    });
  }
}

// Global Auth Middleware yang dijalankan sebelum Proxy
@Injectable()
export class GatewayAuthMiddleware implements NestMiddleware {
  use(req: FastifyRequest, res: FastifyReply, next: () => void): void {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new HttpException('Unauthorized Access', HttpStatus.UNAUTHORIZED);
    }
    
    // Validasi token (simulasi)
    const token = authHeader.split(' ')[1];
    if (token === 'invalid') {
      throw new HttpException('Invalid Token', HttpStatus.UNAUTHORIZED);
    }

    // Injeksi hasil auth ke objek request untuk dikonsumsi rewriteRequestHeaders
    (req as any).user = { id: 'usr_123456', role: 'tenant_admin' };
    next();
  }
}
```

## 3. Aggregation Controller (BFF Pattern)

Gateway juga bisa menyatukan (aggregate) beberapa respons upstream dalam satu panggilan klien.

```typescript
import { Controller, Get, Param, Injectable } from '@nestjs/common';

interface AggregatedDashboard {
  user: Record<string, unknown>;
  billing: Record<string, unknown>;
}

@Injectable()
export class DashboardAggregatorService {
  // Simulasi fetch internal HTTP client
  async fetchUser(id: string): Promise<Record<string, unknown>> {
    return { id, name: 'John Doe', status: 'active' };
  }
  async fetchBilling(id: string): Promise<Record<string, unknown>> {
    return { userId: id, balance: 1500, currency: 'USD' };
  }
}

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly aggregator: DashboardAggregatorService) {}

  @Get(':userId')
  async getDashboard(@Param('userId') userId: string): Promise<AggregatedDashboard> {
    // Paralelisasi fetch ke upstream untuk latency minimum
    const [user, billing] = await Promise.all([
      this.aggregator.fetchUser(userId),
      this.aggregator.fetchBilling(userId),
    ]);

    return { user, billing };
  }
}
```

## 4. Test Suite (Jest)

```typescript
import { DashboardController, DashboardAggregatorService } from './dashboard.controller';

describe('DashboardController Aggregation', () => {
  let controller: DashboardController;
  let aggregator: DashboardAggregatorService;

  beforeEach(() => {
    aggregator = new DashboardAggregatorService();
    controller = new DashboardController(aggregator);
  });

  it('should aggregate data from multiple upstream services concurrently', async () => {
    jest.spyOn(aggregator, 'fetchUser').mockResolvedValue({ id: '99', name: 'Test' });
    jest.spyOn(aggregator, 'fetchBilling').mockResolvedValue({ userId: '99', balance: 50 });

    const result = await controller.getDashboard('99');
    
    expect(aggregator.fetchUser).toHaveBeenCalledWith('99');
    expect(aggregator.fetchBilling).toHaveBeenCalledWith('99');
    expect(result).toStrictEqual({
      user: { id: '99', name: 'Test' },
      billing: { userId: '99', balance: 50 },
    });
  });
});
```

## 5. Trade-Off Analisis (Fastify Proxy vs HTTP Client Axios)

**Kelebihan Fastify Proxy:**
1. **Memory Efficiency (Streaming):** Request berukuran besar (seperti upload file 500MB) langsung dialirkan via OS Pipe ke upstream tanpa buffer RAM.
2. **High Throughput:** Minimalkan overhead event-loop Node.js, memungkinkan puluhan ribu RPS per core CPU.
3. **Transparent Headers:** Otomatis menangani header seperti `x-forwarded-for` dan `transfer-encoding`.

**Kekurangan Fastify Proxy:**
1. **Kesulitan Transformasi Data:** Karena berbasis streaming pipelined, sangat sulit jika Anda butuh memodifikasi *body payload* respons upstream di tengah jalan.
2. **Coupling Terhadap Engine:** Sangat terikat pada Fastify; Anda tidak bisa bermigrasi kembali ke Express dengan mudah.
3. **Tracing Complexity:** Jejak logging menjadi bias. Klien 500 Error di Gateway, padahal asalnya dari timeout upstream, membutuhkan Distributed Tracing (OpenTelemetry) ekstra.

## 6. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Buffering Seluruh Body untuk Proxy Custom
Menangkap body lengkap menggunakan axios hanya untuk dilempar ulang ke microservice akan menyebabkan Out of Memory (OOM).

```typescript
// ❌ BURUK: Menguras memori gateway (OOM risk)
@Post('/proxy/upload')
async uploadProxy(@Body() data: Record<string, unknown>) {
  // data masuk ke RAM Gateway, baru di POST
  return axios.post('http://upstream/upload', data);
}
```

### ✅ Solusi 1: Stream Pipe Langsung
Gunakan modul proxy native atau node stream API.

```typescript
// ✅ BAIK: Delegasikan pada @fastify/http-proxy yang berbasis streaming stream.pipe()
```

### ❌ Anti-Pattern 2: Missing Circuit Breaker di Aggregator
Memanggil 5 service secara Promise.all tanpa proteksi timeout. Jika satu mati, Gateway menggantung.

```typescript
// ❌ BURUK: Tidak ada batas waktu, Gateway Thread Pool akan kehabisan slot
await Promise.all([ fetchA(), fetchB() ]); 
```

### ✅ Solusi 2: Timeout Interceptors
Wajib bungkus pemanggilan upstream internal dengan Timeout/CircuitBreaker pattern (contoh: `rxjs/operators/timeout`).

## 7. Production Edge Cases

1. **Keep-Alive Exhaustion:** Upstream proxy bisa kehabisan ephemeral ports (TIME_WAIT socket) jika koneksi TCP sering buka-tutup ke microservice. Pastikan opsi `keepAlive: true` dan agen HTTP connection pool diaktifkan pada layer proksi Anda.
2. **Upstream Timeout cascading:** Ketika service `Payments` mengalami degradasi latensi tinggi (misal 30 detik), Gateway akan menahan koneksi klien web. Batasi proxy timeout (misal Max 5 detik), lalu throw 504 Gateway Timeout agar tidak menghancurkan ketersediaan Gateway.
3. **Double JWT Verification:** Terkadang Gateway memverifikasi JWT dan microservice juga memverifikasinya ulang secara asinkron ke DB. Ini menaikkan latency. Pendekatan tepat (Trust Boundary): Gateway verifikasi JWT via asimetris public key, lalu injeksi header `x-authenticated-user-id`, microservice mematikan auth eksternal dan murni mempercayai injeksi header dari Gateway internal (Private Network).
