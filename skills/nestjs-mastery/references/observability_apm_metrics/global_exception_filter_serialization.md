# Global Exception Filter & RFC 7807 Serialization di NestJS

Menghadapi sistem produksi level tinggi (API publik, Bank, Fintech), menangani *error* tidak boleh sekadar melempar HTTP 500 mentah atau format JSON tak standar. Praktik industri terbaik menggunakan skema standar *Problem Details for HTTP APIs* (**RFC 7807**) untuk struktur respon galat global. NestJS memanfaatkan fitur *Global Exception Filter* untuk menangkap setiap eksepsi tak terduga (*Unhandled Rejections*), menyensor bocoran *Stack Trace* di produksi, lalu membubuhkan *Trace ID* agar insiden dapat segera dikorelasikan pada *log aggregator*.

## 1. Arsitektur Propagasi Eksepsi dan Serialisasi

Diagram berikut menjelaskan siklus penangkapan *Exception*, pengayaan UUID, serta resolusi log vs respon jaringan.

```ascii
[Controller/Service] --- (Throw Exception / Crash)
          |
          V
+------------------------------------+
|     Global Exception Filter        |
+------------------------------------+
          |
    +----(Check Node Env)----+
    |                        |
[Production]           [Development]
    |                        |
(Hide StackTrace,      (Show StackTrace,
 sanitize sensitive)    verbose messages)
    |                        |
    +----(Format RFC 7807)---+
          |
          |  1. type: "https://api.docs/errors/xyz"
          |  2. title: "Internal Server Error"
          |  3. status: 500
          |  4. detail: "A brief sanitized message"
          |  5. traceId: "uuid-v4-..." 
          |
          V
+-------------------+      +-----------------+
|  HTTP Response    |      |  Server Logger  |
+-------------------+      +-----------------+
```

## 2. Analisis Trade-Off

### Kelebihan (Pros)
1. **Standar Global Klien (RFC 7807):** Membantu klien (Mobile, SPA, B2B Partner) secara deterministik dalam menangani error menggunakan struktur objek JSON seragam (*type, title, status, detail, instance*).
2. **Keamanan Ekstrim (Zero Data Leaks):** Mencegah bocornya versi database, informasi baris kode, atau stack path aplikasi internal kepada pemindai kerentanan (vulnerability scanner/hacker).
3. **Kemudahan Troubleshooting:** Perekatan `TraceId` UUID memfasilitasi tim SRE/Ops mencari insiden presisi 1:1 di dalam ribuan antrean log Datadog/ElasticSearch.

### Kekurangan (Cons)
1. **Peredaman Error Laten (Silenced Error):** Terlalu agresif meredam galat tanpa mekanisme *Alerting* (seperti Sentry) membuat *engineer* buta terhadap insiden *silent failure*.
2. **Kekakuan Mapping Tipe Kesalahan:** Menerjemahkan setiap galat spesifik aplikasi ke dalam URL tipe kesalahan (RFC) menambah beban tata kelola dokumentasi developer.
3. **Kinerja Exception Handling Tinggi:** Di V8 Engine, melempar objek `Error` berbiaya tinggi karena alokasi `stack-trace`. Logika Filter global yang rumit (termasuk UUID generation per error) dapat sedikit menahan *throughput* pada gelombang DDoS.

## 3. Production Edge Cases

1. **Payload Too Large (413):** Kegagalan yang terjadi di level *middleware* Express (misal *BodyParser*) sering mem-*bypass* Filter NestJS jika tidak terikat di `App Level`. Solusi: Pastikan Filter diaplikasikan menggunakan `app.useGlobalFilters()` daripada `APP_FILTER` *provider* di beberapa setup.
2. **Database Connection Lost:** Terputusnya koneksi DB akan melempar ribuan galat per detik yang identik. Solusi: Gunakan filter untuk mengekstrak kode galat DB, lalu agregasikan atau batasi laju (*rate limit*) peringatan error tersebut di logger, bukan langsung mencetak setiap baris koneksi galat.
3. **Eksepsi Asinkron yang Terlepas (Unhandled Promise Rejection):** Eksepsi yang tidak di-*await* dalam *callback* tidak akan sampai ke Exception Filter, malah memicu Node.js *process crash*. Solusi: Selalu lindungi seluruh logika dengan *Try-Catch* asinkron dan tangkap *process level events* (`process.on('unhandledRejection')`).

## 4. Anti-Patterns Kritis

### Anti-Pattern 1: Menyembunyikan Detail Kesalahan Validasi Bisnis (HTTP 400)
**❌ Salah:** Menggunakan RFC 7807 secara membabi buta tanpa melampirkan array kesalahan detail yang diminta Klien.
```json
{
  "status": 400,
  "title": "Bad Request"
  // Klien tidak tahu field mana yang salah!
}
```

**✅ Benar:** Menambahkan ekstensi RFC `errors` kustom untuk pesan validasi granular (contoh: *class-validator*).
```json
{
  "status": 400,
  "title": "Validation Failed",
  "detail": "Data masukan tidak sesuai kriteria.",
  "errors": [{ "field": "email", "reason": "Bukan format email valid" }]
}
```

### Anti-Pattern 2: Mencetak Stack-Trace secara Publik di Produksi
**❌ Salah:** Melempar detail murni `err.stack` ke jaringan.
```typescript
res.status(500).json({ error: err.stack }); // MALAPETAKA SECURITY!
```

**✅ Benar:** Memblokir `stack` dalam mode produksi sepenuhnya di lapisan HTTP, hanya mencetaknya dalam log *server*.

## 5. Implementasi Global Exception Filter RFC7807

```typescript
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';

// Format standar RFC 7807 Problem Details
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  traceId: string;
  errors?: unknown[]; // Untuk Validasi Field Spesifik
  stack?: string; // Hanya Dev
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  public catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    
    // Tarik Trace ID yang ada (dari header/ALS), atau generate baru
    const traceId = (request.headers['x-trace-id'] as string) || randomUUID();
    const isProd = process.env.NODE_ENV === 'production';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let detail = 'An unexpected error occurred.';
    let validationErrors: unknown[] | undefined;

    // Handle Standard NestJS HttpExceptions (4xx)
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse() as Record<string, unknown>;
      
      title = (exceptionResponse['error'] as string) || 'Client Error';
      detail = Array.isArray(exceptionResponse['message']) 
        ? 'Validation Failed' 
        : (exceptionResponse['message'] as string) || detail;
      
      if (Array.isArray(exceptionResponse['message'])) {
        validationErrors = exceptionResponse['message'];
      }
    } 
    // Handle Custom / Fatal Errors (5xx)
    else if (exception instanceof Error) {
      this.logger.error(`[${traceId}] Fatal Error: ${exception.message}`, exception.stack);
      detail = isProd ? 'A critical system error occurred.' : exception.message;
    }

    const problem: ProblemDetails = {
      type: `https://api.yourdomain.com/errors/${status}`,
      title,
      status,
      detail,
      instance: request.url,
      traceId,
      ...(validationErrors && { errors: validationErrors }),
      ...(!isProd && exception instanceof Error && { stack: exception.stack }),
    };

    response
      .status(status)
      .header('Content-Type', 'application/problem+json')
      .json(problem);
  }
}
```

## 6. Unit Testing Suite (Error Serialization Mocking)

Memastikan respon di mode produksi aman, dan validasi *Problem Details* terformat sempurna.

```typescript
import { GlobalExceptionFilter } from './global-exception.filter';
import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';

describe('GlobalExceptionFilter (RFC 7807)', () => {
  let filter: GlobalExceptionFilter;
  let mockResponse: Partial<Response>;
  let mockRequest: Partial<Request>;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      header: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    mockRequest = {
      url: '/api/v1/resource',
      headers: { 'x-trace-id': 'test-uuid-1234' },
    };

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;
    
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = 'test'; // Restore env
  });

  it('Should handle HTTP 400 Bad Request and serialize as Problem Details', () => {
    const errorResponse = { message: ['email must be valid'], error: 'Bad Request' };
    const exception = new HttpException(errorResponse, HttpStatus.BAD_REQUEST);

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(mockResponse.header).toHaveBeenCalledWith('Content-Type', 'application/problem+json');
    expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'https://api.yourdomain.com/errors/400',
      title: 'Bad Request',
      status: 400,
      detail: 'Validation Failed',
      instance: '/api/v1/resource',
      traceId: 'test-uuid-1234',
      errors: ['email must be valid'],
    }));
  });

  it('Should handle unknown Error (500) and HIDE stack trace in Production', () => {
    const exception = new Error('Database Password Exposed');

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(500);
    expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'https://api.yourdomain.com/errors/500',
      title: 'Internal Server Error',
      status: 500,
      detail: 'A critical system error occurred.', // Pesan asli 'Password Exposed' diredam!
      instance: '/api/v1/resource',
      traceId: 'test-uuid-1234',
    }));
    
    // Verifikasi tiada stack property!
    const jsonCallArgs = (mockResponse.json as jest.Mock).mock.calls[0][0];
    expect(jsonCallArgs.stack).toBeUndefined();
  });
});
```
