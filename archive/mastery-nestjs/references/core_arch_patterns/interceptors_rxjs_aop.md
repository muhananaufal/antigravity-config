# Interceptors & Aspect-Oriented Programming (Top 1% Architecture)

## 1. Fundamental Law & Mechanical Sympathy

Dalam anatomi siklus hidup (*Request Lifecycle*) NestJS, **Interceptors** menduduki posisi yang sangat unik dan bertenaga. Terinspirasi oleh konsep *Aspect-Oriented Programming* (AOP), *Interceptors* memungkinkan Anda untuk membungkus *(wrap)* titik eksekusi rute dengan logika kustom sebelum **dan** sesudah *Controller* merespons, menggunakan kekuatan **RxJS Observables**.

Secara mekanik (*Mechanical Sympathy*), ketika sebuah rute diintersepsi, NestJS memberikan objek `ExecutionContext` (berisi detail HTTP/gRPC/GraphQL) dan `CallHandler`. Panggilan ke `CallHandler.handle()` akan mengembalikan sebuah *RxJS Stream*. Karena ini adalah *stream* reaktif, operasi yang dilakukan oleh antarmuka tingkat rendah V8 *Event Loop* tidak langsung dieksekusi secara berurutan (*imperative*). Sebaliknya, *stream* tersebut akan ditunda (*deferred execution*) hingga di-*subscribe* oleh NestJS di ujung *pipeline*. Ketidakpahaman mendalam terhadap sifat RxJS—seperti menembakkan efek samping tanpa menggunakan operator `tap()`, atau secara tidak sengaja memanggil metode `subscribe()` manual di dalam *Interceptor*—dapat memicu *memory leak* masif, *race condition* lintas klien, hingga eksekusi kueri *database* ganda.

## 2. Top 1% Production Architecture

Arsitektur produksi tingkat tinggi selalu mendelegasikan tugas-tugas non-bisnis yang repetitif (seperti *Caching*, Penguncian *Distributed Mutex*, Pemetaan *Response*, dan *Timeout*) keluar dari *Controller* menuju *Interceptors*.

### 2.1 Redis Distributed Cache Interceptor
Mengimplementasikan tingkat performa *Tier 1* menuntut pembacaan *cache* sebelum *request* menyentuh lapisan *Controller* atau *Database*. Jika *cache* (misalnya dari Redis) tersedia, *Interceptor* dapat memotong rute (mencegah *Controller* berjalan) dengan mengembalikan *Observable* baru secara instan (melalui `of()`).

```typescript
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Inject,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Redis } from 'ioredis';

@Injectable()
export class HttpCacheInterceptor implements NestInterceptor {
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    
    // Only cache safe GET requests
    if (request.method !== 'GET') {
      return next.handle();
    }

    const cacheKey = `http_cache:${request.originalUrl}`;
    const cachedResponse = await this.redis.get(cacheKey);

    if (cachedResponse) {
      // Short-circuit the request lifecycle, controller is NEVER executed
      return of(JSON.parse(cachedResponse));
    }

    // Controller executes. Then, the response is captured via tap()
    return next.handle().pipe(
      tap((response) => {
        // Asynchronously set cache without blocking the client response
        this.redis.set(cacheKey, JSON.stringify(response), 'EX', 300).catch((err) => {
          console.error('Failed to write to Redis cache', err);
        });
      }),
    );
  }
}
```

### 2.2 Global Timeout & Circuit Breaking
Untuk layanan mikro yang berkomunikasi dengan API luar, *Interceptor* wajib digunakan sebagai *Circuit Breaker* dan pengawal durasi (*Timeout Guard*). Jika eksekusi melewati batas aman (misal 5 detik), putuskan *stream* dan lempar pengecualian `RequestTimeoutException`.

```typescript
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  RequestTimeoutException,
} from '@nestjs/common';
import { Observable, throwError, TimeoutError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';

@Injectable()
export class GlobalTimeoutInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    // Force a strict 5000ms deadline on the execution stream
    return next.handle().pipe(
      timeout(5000),
      catchError((err) => {
        if (err instanceof TimeoutError) {
          return throwError(() => new RequestTimeoutException('Execution deadline exceeded'));
        }
        return throwError(() => err);
      }),
    );
  }
}
```

## 3. Failure & Edge-Case Anomaly Matrix

| Kelas Anomali | Gejala / Dampak Mutlak | Matriks Mitigasi (Top 1% Tactic) |
| :--- | :--- | :--- |
| **The Double Execution Trap** | Memanggil `next.handle()` lebih dari satu kali, atau melakukan `subscribe()` manual secara ilegal di dalam *Interceptor*, menyebabkan *Controller* (dan transaksi DB) dieksekusi 2x untuk satu *request*. | **ATURAN EMAS:** Anda HANYA boleh mereturn *Observable* ke kerangka kerja NestJS. Jangan pernah menggunakan `subscribe()`. Gunakan operator RxJS murni seperti `map()`, `tap()`, atau `switchMap()`. |
| **Context Switching (GraphQL vs HTTP)** | Mencoba mengakses `request.headers` namun *Interceptor* dipanggil oleh *resolver* GraphQL (menghasilkan *Null Reference Error*). | Gunakan pemeriksaan tipe konteks secara ketat: `if (context.getType<GqlContextType>() === 'graphql')` dan panggil utilitas spesifik seperti `GqlExecutionContext.create(context)`. |
| **Missing Exception Propagation** | *Interceptor* menelan pengecualian (menggunakan `catchError` dan me-return nilai *default*) secara tidak sengaja, mengakibatkan *client* mendapat respon sukses 200 OK dengan format *error* di dalamnya. | Jika Anda menangkap pengecualian di dalam `catchError`, pastikan Anda selalu mengakhirinya dengan `throwError(() => err)` jika Anda ingin *Global Exception Filter* milik NestJS bekerja sebagaimana mestinya. |

## 4. High-Assurance Testing

Karena ketergantungan mutlaknya pada RxJS dan `ExecutionContext`, pengujian *Interceptor* memerlukan pemalsuan (*mocking*) pada utilitas injeksi dependensi. Pendekatan TDD (*Test-Driven Development*) terbaik adalah dengan membuat *mock* pada *CallHandler* dan menyimulasikan aliran asinkron dengan fungsi `lastValueFrom()`.

```typescript
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { HttpCacheInterceptor } from './http-cache.interceptor';
import { of, lastValueFrom } from 'rxjs';
import Redis from 'ioredis-mock';

describe('HttpCacheInterceptor', () => {
  let interceptor: HttpCacheInterceptor;
  let redisClient: any;

  beforeEach(() => {
    redisClient = new Redis();
    interceptor = new HttpCacheInterceptor(redisClient);
  });

  it('should return cached data and short-circuit CallHandler if cache exists', async () => {
    // Arrange
    await redisClient.set('http_cache:/api/users', JSON.stringify({ cached: true }));
    
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', originalUrl: '/api/users' }),
      }),
    } as unknown as ExecutionContext;

    const mockCallHandler = {
      handle: jest.fn().mockReturnValue(of({ database: true })),
    } as CallHandler;

    // Act
    const resultObservable = await interceptor.intercept(mockContext, mockCallHandler);
    const result = await lastValueFrom(resultObservable);

    // Assert
    expect(result).toEqual({ cached: true });
    expect(mockCallHandler.handle).not.toHaveBeenCalled(); // Controller was bypassed
  });
});
```

## 5. Anti-Patterns & "When NOT to Use" Matrix

### Anti-Pattern: Transformasi Struktur Respons (Response Mapping) Global yang Serampangan
Banyak *developer* baru tergoda untuk membuat `TransformInterceptor` global yang membungkus semua respons ke dalam pola `{ data: ..., statusCode: 200 }`.

**Mengapa ini fatal?**
- **Pros:** Mencapai keseragaman respons secara cepat (DRY).
- **Cons (1):** Menghancurkan arsitektur *TypeScript/Swagger/OpenAPI*. *Controller* Anda mendeklarasikan mengembalikan `UserDto`, tetapi *client* menerima `{ data: UserDto }`. Ini memutus kontrak tipe karena *Interceptor* mengubah bentuk di detik-detik terakhir di luar jangkauan kompilator.
- **Cons (2):** Jika aplikasi Anda menggunakan modul pihak ketiga (misal: BullMQ Board, Prometheus Metrics `/metrics`, atau Swagger UI), *interceptor* bodoh ini akan membungkus respons mereka menjadi `{ data: "html string" }` yang merusak seluruh tampilan *dashboard* atau format *scraper*.
- **Cons (3):** Tidak kompatibel dengan GraphQL. Modifikasi struktur *body* REST sama sekali tidak relevan di GraphQL dan akan merusak mesin resolusi Apollo.

**Kapan Interceptor TIDAK Boleh Digunakan:**
- **Validasi Data Input (DTO):** Gunakan **Pipes** (ValidationPipe), bukan Interceptors.
- **Autentikasi & Otorisasi:** Gunakan **Guards** (AuthGuard, RolesGuard), karena Guards berjalan *sebelum* Interceptor. Mencegat pengguna tak diundang di tingkat Interceptor berarti membuang siklus komputasi berharga.
- **Logika Bisnis Khusus (Domain Logic):** Jangan pernah memanipulasi perhitungan keranjang belanja (cart) atau *state machine* status pesanan di dalam Interceptor. Itu murni wilayah *Service Layer* (Domain Driven Design).
