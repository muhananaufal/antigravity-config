# Panduan Enterprise: Strategi API Versioning & Sunset Policy (NestJS)

Manajemen versi API yang solid adalah fondasi dari siklus rilis yang stabil di lingkungan enterprise. Dokumen ini membedah komparasi pendekatan versioning, implementasi kustom di NestJS, dan pengelolaan siklus hidup endpoint melalui standar RFC 8594 (HTTP Sunset) dan header Deprecation.

## 1. Analisis Komparasi Strategi Versioning

Terdapat tiga pendekatan utama dalam API Versioning. Berikut adalah perbandingannya:

1. **URI Versioning** (Contoh: `/v1/orders`)
   - **Kelebihan:** Sangat mudah dipahami, direplikasi, dan dilacak (cacheable) oleh proxy server (Cloudflare, CDN).
   - **Kekurangan:** Mengotori struktur routing, tidak semantik (versi bukanlah resource), rawan *version sprawl* jika ada banyak microservices.
2. **Header Versioning** (Contoh: `X-API-Version: 2.0`)
   - **Kelebihan:** URI tetap bersih dan semantik (`/orders`), menyembunyikan kompleksitas dari URL.
   - **Kekurangan:** Lebih sulit diuji via browser langsung, memerlukan konfigurasi Varnish/CDN khusus untuk caching berdasarkan header.
3. **Media Type (Accept) Versioning** (Contoh: `Accept: application/vnd.myapi.v2+json`)
   - **Kelebihan:** Paling sesuai dengan prinsip REST (HATEOAS), merepresentasikan kontrak struktur data yang diinginkan klien.
   - **Kekurangan:** Cukup kompleks untuk diimplementasi, klien sering lupa mengirim header `Accept` yang benar.

## 2. Arsitektur Sunset Policy (RFC 8594)

Diagram di bawah menggambarkan alur bagaimana API berevolusi dan bagaimana klien menerima sinyal deprecation:

```text
[Client]                      [API Gateway / NestJS]                     [Monitoring System]
   |                                    |                                         |
   |--- 1. GET /api/orders (v1) ------->|                                         |
   |                                    |--- 2. Route Check (v1 Deprecated)       |
   |                                    |                                         |
   |<-- 3. 200 OK (With Sunset Headers) |--- 4. Log "Deprecated API Usage" ------>|
   |    Deprecation: @1640995200        |                                         |
   |    Sunset: Sat, 31 Dec 2022 ...    |                                         |
   |    Link: <.../docs>; rel="sunset"  |                                         |
   |                                    |                                         |
```

## 3. Implementasi Kustom Versioning & Sunset Interceptor (NestJS)

Berikut adalah implementasi `Header Versioning` dipadukan dengan Interceptor NestJS untuk injeksi header Sunset & Deprecation secara otomatis jika rute ditandai usang.

```typescript
import {
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  NestInterceptor,
  SetMetadata,
  UseInterceptors,
  VersioningType,
  INestApplication,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { FastifyReply } from 'fastify';

// 1. Decorator untuk menandai rute yang dideprecate
export const SUNSET_METADATA_KEY = 'api:sunset_metadata';

export interface SunsetOptions {
  deprecationDate: Date; // Kapan API mulai dianggap usang
  sunsetDate: Date; // Kapan API akan dinonaktifkan (Hard Limit)
  docLink: string;
}

export const Sunset = (options: SunsetOptions) => SetMetadata(SUNSET_METADATA_KEY, options);

// 2. Interceptor untuk menginjeksi header RFC 8594
@Injectable()
export class SunsetInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    
    // Ambil metadata dari decorator method
    const metadata = Reflect.getMetadata(
      SUNSET_METADATA_KEY,
      context.getHandler(),
    ) as SunsetOptions | undefined;

    if (metadata) {
      // Set Header Deprecation (RFC 8594 - Draft) berupa timestamp UNIX
      const deprecationUnix = Math.floor(metadata.deprecationDate.getTime() / 1000);
      response.header('Deprecation', deprecationUnix.toString());

      // Set Header Sunset (RFC 8594) format HTTP-date
      const sunsetHttpDate = metadata.sunsetDate.toUTCString();
      response.header('Sunset', sunsetHttpDate);

      // Set Link Rel untuk referensi migrasi
      response.header(
        'Link',
        `<${metadata.docLink}>; rel="sunset"; type="text/html"`,
      );
    }

    return next.handle().pipe(
      tap(() => {
        // Logging internal untuk metrik penggunaan API lama
        if (metadata) {
          console.warn(`[Sunset Policy] Deprecated API accessed: ${context.getHandler().name}`);
        }
      }),
    );
  }
}

// 3. Controller dengan Versioning & Sunset
@Controller({ path: 'orders', version: '1' })
@UseInterceptors(SunsetInterceptor)
export class OrdersV1Controller {
  @Get()
  @Sunset({
    deprecationDate: new Date('2023-01-01T00:00:00Z'),
    sunsetDate: new Date('2024-12-31T23:59:59Z'),
    docLink: 'https://developer.company.com/api/v2-migration',
  })
  getOrders(): Record<string, string> {
    return { data: 'Legacy Orders Data' };
  }
}

@Controller({ path: 'orders', version: '2' })
export class OrdersV2Controller {
  @Get()
  getOrders(): Record<string, string> {
    return { data: 'New V2 Orders Data' };
  }
}

// Bootstrap Configuration Example:
export function configureVersioning(app: INestApplication): void {
  app.enableVersioning({
    type: VersioningType.HEADER,
    header: 'X-API-Version',
    defaultVersion: '2',
  });
}
```

## 4. Test Suite (Jest)

```typescript
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { SunsetInterceptor, SUNSET_METADATA_KEY } from './sunset.interceptor'; // Asumsi path valid
import { of } from 'rxjs';
import { FastifyReply } from 'fastify';

describe('SunsetInterceptor', () => {
  let interceptor: SunsetInterceptor;

  beforeEach(() => {
    interceptor = new SunsetInterceptor();
  });

  it('should inject Sunset, Deprecation, and Link headers when metadata is present', (done) => {
    const mockDate = new Date('2023-01-01T00:00:00Z');
    
    const mockReply = {
      header: jest.fn(),
    } as unknown as FastifyReply;

    const mockExecutionContext = {
      switchToHttp: () => ({ getResponse: () => mockReply }),
      getHandler: () => {
        const handler = () => {};
        Reflect.defineMetadata(SUNSET_METADATA_KEY, {
          deprecationDate: mockDate,
          sunsetDate: mockDate,
          docLink: 'https://docs',
        }, handler);
        return handler;
      },
    } as unknown as ExecutionContext;

    const mockCallHandler: CallHandler = {
      handle: () => of('test-data'),
    };

    interceptor.intercept(mockExecutionContext, mockCallHandler).subscribe((result) => {
      expect(result).toBe('test-data');
      expect(mockReply.header).toHaveBeenCalledWith('Deprecation', '1672531200');
      expect(mockReply.header).toHaveBeenCalledWith('Sunset', mockDate.toUTCString());
      expect(mockReply.header).toHaveBeenCalledWith('Link', '<https://docs>; rel="sunset"; type="text/html"');
      done();
    });
  });
});
```

## 5. Trade-Off Analisis (Header Versioning)

**Kelebihan:**
1. **URI Bersih:** Endpoint tetap mencerminkan resource RESTful tanpa polusi prefix versi (`/orders` bukan `/v1/orders`).
2. **Fleksibilitas Klien:** Memungkinkan klien beralih versi hanya dengan mengubah konfigurasi HTTP client di satu tempat terpusat (Interceptors/Middleware di frontend).
3. **Mendukung Defaulting:** Sangat mudah mengarahkan klien tanpa header ke versi stabil (default version) dari sistem.

**Kekurangan:**
1. **Caching Complexity:** Memerlukan konfigurasi `Vary: X-API-Version` di CDN. Jika CDN salah konfigurasi, response v1 bisa tersaji ke klien v2.
2. **Explorability:** Klien tidak bisa sekadar menyalin paste URL ke browser web untuk menguji GET request tanpa ekstensi tambahan.
3. **Overhead Routing:** NestJS harus membaca header pada setiap request sebelum memutuskan handler mana yang dieksekusi.

## 6. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Percabangan Versi di Dalam Handler (Spaghetti Code)
Mencampur logika rilis v1 dan v2 di dalam satu blok fungsi akan menghancurkan Single Responsibility Principle.

```typescript
// ❌ BURUK: Percabangan if-else berbasis versi yang kotor
@Get('/orders')
getOrders(@Headers('X-API-Version') version: string): Record<string, unknown> {
  if (version === '1') {
    return this.legacyService.getLegacyData();
  } else if (version === '2') {
    return this.newService.getOptimizedData();
  }
  throw new Error('Unsupported version'); // Tidak tertangkap router
}
```

### ✅ Solusi 1: Pemisahan Controller (Clean Architecture)
Gunakan dukungan native NestJS Versioning untuk routing deklaratif terpisah.

```typescript
// ✅ BAIK: Routing versi otomatis di-handle framework
@Controller({ path: 'orders', version: '1' })
export class OrdersV1Controller { /* ... */ }

@Controller({ path: 'orders', version: '2' })
export class OrdersV2Controller { /* ... */ }
```

### ❌ Anti-Pattern 2: Menghapus API Usang Tanpa Pemberitahuan (Silent Kill)
Mematikan layanan versi lama secara mendadak akan menyebabkan outage di sisi consumer.

```typescript
// ❌ BURUK: Menghapus controller v1 begitu v2 rilis
// Developer langsung mendelete OrdersV1Controller.ts, klien lama mendapatkan 404 Not Found.
```

### ✅ Solusi 2: Sunset Policy Grace Period
Terapkan `SunsetInterceptor` dan biarkan berjalan selama min 3-6 bulan untuk mengumpulkan log klien mana saja yang masih memakai API tersebut.

## 7. Production Edge Cases

1. **CDN Caching Collision:** Jika menggunakan header versioning, edge cache seperti Cloudflare berpotensi mencampur cache v1 dan v2 jika Anda lupa mengeset header `Vary: X-API-Version`. Klien v2 bisa menerima struktur data v1 dan memicu runtime error di UI.
2. **Graceful Degradation vs Sunset:** Saat mencapai `sunsetDate`, Anda sebaiknya secara bertahap memasukkan `503 Service Unavailable` atau *Brownout Testing* (mematikan API usang selama 5 menit setiap jam) untuk memaksa pengguna memigrasikan klien mereka sebelum *hard kill*.
3. **Schema Validation Drift:** Saat memakai 2 versi API yang berjalan paralel namun memakai database yang sama (Shared Database), migrasi skema tabel wajib mendukung backward compatibility (contoh: tambah kolom baru `nullable` alih-alih me-rename kolom lama) agar versi 1 tidak mengalami error ORM.
