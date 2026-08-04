# Prometheus & Grafana RED Metrics di NestJS

Pada era *cloud-native*, memantau kesehatan operasional mikroservis mutlak membutuhkan pemahaman mendalam tentang RED Metrics (Rate, Errors, Duration) dan USE Metrics (Utilization, Saturation, Errors). Integrasi `Prometheus` dengan Node.js melalui *library* seperti `@willsoto/nestjs-prometheus` memberikan wawasan presisi mikrosekon yang penting untuk mengelola *Service Level Objectives* (SLO).

## 1. Arsitektur RED Metrics Histogram Pipeline

Diagram berikut memvisualisasikan bagaimana sebuah HTTP *Request* disadap oleh *Interceptor* global, diukur menggunakan *Histogram* Prometheus (untuk latensi/Duration), serta diakumulasikan ke dalam *Counters* (untuk jumlah Rate & Errors), lalu diekspos melalui *endpoint* `/metrics` ke *Prometheus Scraper*.

```ascii
[Client Request] --> | NestJS HTTP Pipeline |
                           |
                     +----------------------+
                     | Global RED Interceptor|
                     +----------------------+
                       |       |       |
                 (Start Timer) |       |
                       |       |       |
                +-----------------------------+
                |     Controller & Service    |  <-- Business Logic
                +-----------------------------+
                       |       |       |
                  (End Timer)  |    (Check Error)
                       |       |       |
                +-------------------------------+
                |   Prometheus Registry / SDK   |
                +-------------------------------+
                 /            |             \
       [Counter: Rate] [Counter: Errors] [Histogram: Duration]
                 \            |             /
                  \           |            /
                +-------------------------------+
                |   Endpoint: GET /metrics      |
                +-------------------------------+
                           ^
                           | (Pull every 15s)
                    [Prometheus Server]
                           |
                   [Grafana Dashboards]
```

## 2. Analisis Trade-Off

### Kelebihan (Pros)
1. **Pull-based Architecture:** Prometheus bertindak secara aktif menarik (pull) metrik. Aplikasi Node.js tidak dibebani oleh tugas mendorong *payload* ke jaringan, mencegah *bottleneck* I/O akibat pengiriman metrik.
2. **Kueri Agregasi Superior:** Dukungan PromQL (Prometheus Query Language) memungkinkan pembuatan peringatan dinamis (misalnya persentil latensi P99 melampaui 500ms dalam rentang 5 menit).
3. **Standar Industri Kuat:** Ekosistem ini merupakan *default standard* untuk klaster Kubernetes dengan integrasi siap pakai *Prometheus Operator*.

### Kekurangan (Cons)
1. **Kehilangan Data Sementara:** Jika pod Kubernetes mengalami eksit mendadak (*OOM Kill*) sesaat sebelum periode *scrape*, metrik yang berada dalam RAM Node.js akan raib.
2. **Kardinalitas Meledak (High Cardinality):** Menggunakan variabel tak terbatas seperti UUID atau email sebagai *label* metrik akan menghabiskan memori RAM aplikasi dengan cepat.
3. **Keamanan Endpoint Terbuka:** Rute `/metrics` sering kali terekspos ke publik jika tidak dilindungi dengan benar, sehingga dapat dimanfaatkan peretas untuk serangan pengintaian arsitektur (*reconnaissance*).

## 3. Production Edge Cases

1. **Slow DB Queries:** Aplikasi cepat merespons, tetapi ORM tercekik (*bottleneck*). Solusi: Mengekspos histogram khusus yang melacak durasi `pg` (PostgreSQL) execution plan.
2. **Kubernetes Autoscaling (HPA):** Pod *scraped* yang dinamis sering kali menghasilkan metrik terputus-putus. Solusi: Gunakan *Thanos* atau *Cortex* bersama Prometheus untuk *long-term storage* dan deduplikasi pod.
3. **Gagalnya Label Matching:** Kesalahan kecil dalam *typo* routing Express bisa menyebabkan rute dinamis (seperti `/users/1` dan `/users/2`) diproses sebagai rute unik. Metrik harus mengelompokkannya sebagai `/users/:id` agar kardinalitas memori terjaga.

## 4. Anti-Patterns Kritis

### Anti-Pattern 1: Menggunakan Parameter Dinamis sebagai Label Metrik
**❌ Salah:** Kardinalitas tak terhingga yang menyebabkan *memory leak* di Node.js dan *out-of-memory* di Prometheus server.
```typescript
metric.labels({ path: request.url }); // BAHAYA: request.url bisa /users/123456789
```

**✅ Benar:** Memetakan ke pola *route handler* yang terdefinisi (statikal).
```typescript
const routePath = request.route?.path ?? 'unknown_route'; // MENGHASILKAN: /users/:id
metric.labels({ path: routePath });
```

### Anti-Pattern 2: Histogram Buckets yang Tidak Realistis
**❌ Salah:** Membiarkan konfigurasi *bucket* latensi *default* Prom-client (sangat tidak sesuai dengan aplikasi *low-latency*).
```typescript
new Histogram({ name: 'http_latency', help: 'Latensi' }); // Buckets default: 0.005 hingga 10 detik.
```

**✅ Benar:** Menyesuaikan *bucket* (dalam detik) berdasarkan ekspektasi SLO.
```typescript
new Histogram({ 
  name: 'http_request_duration_seconds', 
  help: 'HTTP latency in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] // Cocok untuk API Cepat (10ms - 5s)
});
```

## 5. Implementasi RED Metrics (Interceptor)

Kita menggunakan interceptor untuk menghitung durasi, memilah rute, dan menghitung total *request* / error.

```typescript
import { CallHandler, ExecutionContext, Injectable, NestInterceptor, HttpException, HttpStatus } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Histogram, Counter } from 'prom-client';
import { Request, Response } from 'express';

@Injectable()
export class PromRedMetricsInterceptor implements NestInterceptor {
  constructor(
    @InjectMetric('http_request_duration_seconds')
    private readonly histogram: Histogram<string>,
    @InjectMetric('http_requests_total')
    private readonly counter: Counter<string>,
  ) {}

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const req = ctx.getRequest<Request>();
    
    // Menghindari kardinalitas liar: Ambil route path atau fallback
    const route = req.route ? req.route.path : req.path;
    const method = req.method;

    // Abaikan rute metrik dan health
    if (route === '/metrics' || route === '/health') {
      return next.handle();
    }

    const endTimer = this.histogram.startTimer();

    return next.handle().pipe(
      tap(() => {
        const res = ctx.getResponse<Response>();
        const status = res.statusCode.toString();

        this.counter.inc({ method, route, status });
        endTimer({ method, route, status });
      }),
      catchError((err: Error) => {
        const status = err instanceof HttpException 
          ? err.getStatus().toString() 
          : HttpStatus.INTERNAL_SERVER_ERROR.toString();

        this.counter.inc({ method, route, status });
        endTimer({ method, route, status });

        return throwError(() => err);
      }),
    );
  }
}
```

## 6. Unit Testing Suite (Metrics Tracking)

Kita menguji fungsi *interceptor* RED tanpa mengandalkan server HTTP nyata menggunakan objek *Mock* Express/NestJS.

```typescript
import { PromRedMetricsInterceptor } from './prom-red-metrics.interceptor';
import { ExecutionContext, CallHandler, HttpException, HttpStatus } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { Histogram, Counter } from 'prom-client';

describe('PromRedMetricsInterceptor', () => {
  let interceptor: PromRedMetricsInterceptor;
  let mockHistogram: Histogram<string>;
  let mockCounter: Counter<string>;
  let endTimerFn: jest.Mock;

  beforeEach(() => {
    endTimerFn = jest.fn();
    mockHistogram = {
      startTimer: jest.fn().mockReturnValue(endTimerFn),
    } as unknown as Histogram<string>;

    mockCounter = {
      inc: jest.fn(),
    } as unknown as Counter<string>;

    interceptor = new PromRedMetricsInterceptor(mockHistogram, mockCounter);
  });

  const createMockContext = (method: string, routePath: string, statusCode: number): ExecutionContext => ({
    switchToHttp: () => ({
      getRequest: () => ({
        method,
        route: { path: routePath },
        path: routePath,
      }),
      getResponse: () => ({
        statusCode,
      }),
    }),
  } as unknown as ExecutionContext);

  it('Should correctly track successful HTTP requests', (done) => {
    const context = createMockContext('GET', '/api/users/:id', 200);
    const next: CallHandler = {
      handle: () => of('Success Payload'),
    };

    interceptor.intercept(context, next).subscribe({
      next: () => {
        expect(mockHistogram.startTimer).toHaveBeenCalled();
        expect(mockCounter.inc).toHaveBeenCalledWith({ method: 'GET', route: '/api/users/:id', status: '200' });
        expect(endTimerFn).toHaveBeenCalledWith({ method: 'GET', route: '/api/users/:id', status: '200' });
        done();
      },
    });
  });

  it('Should correctly track failed HTTP requests (Exceptions)', (done) => {
    const context = createMockContext('POST', '/api/orders', 500);
    const error = new HttpException('Bad Request', HttpStatus.BAD_REQUEST);
    const next: CallHandler = {
      handle: () => throwError(() => error),
    };

    interceptor.intercept(context, next).subscribe({
      error: () => {
        expect(mockHistogram.startTimer).toHaveBeenCalled();
        expect(mockCounter.inc).toHaveBeenCalledWith({ method: 'POST', route: '/api/orders', status: '400' });
        expect(endTimerFn).toHaveBeenCalledWith({ method: 'POST', route: '/api/orders', status: '400' });
        done();
      },
    });
  });
});
```
