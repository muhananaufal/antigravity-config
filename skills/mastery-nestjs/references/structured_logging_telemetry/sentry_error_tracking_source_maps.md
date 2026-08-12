# Sentry Error Tracking, Performance Monitoring & Source Maps pada NestJS Global Interceptor

## 1. Pendahuluan (Enterprise Scale Context)

Error di lingkungan *production* sangat krusial namun seringkali sulit dilacak dengan presisi karena kode TypeScript telah melewati fase kompilasi, *minification*, dan *uglification* menjadi JavaScript (CommonJS atau ESM). Tanpa mekanisme yang memadai, tumpukan *stack trace* hanya akan menunjuk pada file `.js` terkompilasi yang sangat sulit dipahami oleh tim *engineering*. 

Dengan memanfaatkan ekosistem **Sentry** (termasuk *Error Tracking*, *Performance Monitoring*, *Profiling*, dan *Session Replay Sampling*) dikombinasikan dengan *Source Maps*, kita dapat melacak titik pasti dari sebuah insiden (nama file asli TypeScript dan baris kode spesifik) yang memicu *bug*. Selain itu, di tingkat arsitektur *enterprise*, penyensoran data sensitif atau *Personally Identifiable Information* (PII) wajib dilakukan (GDPR Compliance) secara otomatis sebelum *payload* insiden dikirimkan meninggalkan infrastruktur *server* kita menuju infrastruktur *cloud* Sentry.

Dokumen ini merincikan spesifikasi teknis dan standar industri (Standard Operating Procedure) tentang implementasi `Global Interceptor`, `Exception Filter`, dan `Sentry Initialization` khusus untuk arsitektur terdistribusi berbasis **NestJS 10+** dan **TypeScript 5+**, menjamin kualitas kode tanpa *type `any`*, tanpa *hardcoded secrets*, dan tahan terhadap kondisi asinkron yang tidak wajar.

## 2. Diagram Arsitektur Telemetri

Arsitektur telemetri memisahkan antara eksekusi logika bisnis dan pengumpulan observabilitas secara *non-blocking*.

```ascii
+-----------------------------------------------------------------------------------------+
|                                    Infrastruktur Backend                                |
|                                                                                         |
|  +-----------------------+       +------------------------------------------------+     |
|  |  NestJS Lifecycle     |       | Sentry SDK Node (Telemetry Engine)             |     |
|  |                       |       |                                                |     |
|  | 1. HTTP Request Masuk +---A---+-> Mulai Sentry Transaction & Span (Performance)|     |
|  | 2. Business Logic     |       |                                                |     |
|  | 3. throw new Error()  +---B---+-> Global Exception Filter Menangkap Error      |     |
|  | 4. HTTP Response Out  +---C---+-> Akhiri Transaction Span & Hitung Durasi      |     |
|  +-----------------------+       |                                                |     |
|                                  |   +----------------------------------------+   |     |
|                                  |   | Sentry Hook (Sebelum Payload Dikirim)  |   |     |
|                                  |   | - beforeSend(): PII & GDPR Scrubbing   |   |     |
|                                  |   | - Custom Fingerprinting Grouping       |   |     |
|                                  |   | - Traces Sampler & Replay Sampler      |   |     |
|                                  |   +-------------------+--------------------+   |     |
+----------------------------------------------------------|------------------------------+
                                                           | (Asynchronous HTTP/gRPC UDP)
                                                           v
+-----------------------------------------------------------------------------------------+
|                                  Sentry Cloud / Self-Hosted                             |
|                                                                                         |
|  +-----------------------+       +-------------------+       +-----------------------+  |
|  | 1. Ingest Data        | ----> | 2. De-obfuscate   | ----> | 3. Index & Alerting   |  |
|  |    (Event / Trace)    |       |    via Source Map |       |    (Slack / PagerDuty)|  |
|  +-----------------------+       +-------------------+       +-----------------------+  |
+-----------------------------------------------------------------------------------------+
```

## 3. Instalasi Dependencies

Instalasi *library* resmi Sentry. Di lingkungan NestJS, kita menggunakan integrasi *Node* serta modul *Profiling* untuk *Performance Monitoring* yang komprehensif.

```bash
npm install @sentry/node @sentry/profiling-node
```

## 4. Implementasi Inisialisasi Sentry (Instrumentasi)

Praktik terbaik pada *Node.js* dan Sentry adalah melakukan inisialisasi di awal siklus hidup aplikasi, bahkan sebelum *framework* (seperti NestJS) di-`bootstrap`. Kode di bawah menerapkan aturan ketat *GDPR Scrubbing* dan *Session/Performance Sampling*. Semua kredensial dimuat melalui *Environment Variables*.

### `instrument.ts`

```typescript
// src/instrument.ts
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

/**
 * Menjamin lingkungan aman, memastikan tidak ada eksekusi tanpa DSN pada production.
 */
const SENTRY_DSN: string | undefined = process.env.SENTRY_DSN;
const NODE_ENV: string = process.env.NODE_ENV ?? 'development';
const SENTRY_TRACES_SAMPLE_RATE: number = parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1');
const SENTRY_PROFILES_SAMPLE_RATE: number = parseFloat(process.env.SENTRY_PROFILES_SAMPLE_RATE ?? '0.1');
const LOG_FILTER_MASK: string = process.env.LOG_FILTER_MASK ?? '[SCRUBBED_BY_SECURITY_POLICY]';

// Kata kunci PII (Personally Identifiable Information) yang wajib dienkripsi/disensor
const SENSITIVE_KEYS: ReadonlyArray<string> = ['password', 'creditCard', 'ssn', 'token', 'authorization', 'cookie', 'secret', 'phone', 'email'];

/**
 * Fungsi utilitas rekursif untuk menyensor objek bertingkat tanpa menggunakan `any`.
 */
function sanitizePiiData(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(item => sanitizePiiData(item));
  }

  const sanitizedObject: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const isSensitive = SENSITIVE_KEYS.some((sensitiveKey) => key.toLowerCase().includes(sensitiveKey.toLowerCase()));
    
    if (isSensitive) {
      sanitizedObject[key] = LOG_FILTER_MASK;
    } else {
      sanitizedObject[key] = typeof value === 'object' ? sanitizePiiData(value) : value;
    }
  }

  return sanitizedObject;
}

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: NODE_ENV,
    integrations: [
      nodeProfilingIntegration(),
    ],
    // Tracing Performance Monitoring
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    profilesSampleRate: SENTRY_PROFILES_SAMPLE_RATE,
    
    // Custom logic to dynamically determine sample rate based on transaction context
    tracesSampler: (samplingContext: Sentry.SamplingContext): number => {
      // Selalu sampel 100% untuk endpoint health check (atau jatuhkan menjadi 0% agar hemat kuota)
      const transactionName = samplingContext.transactionContext.name ?? '';
      if (transactionName.includes('health') || transactionName.includes('metrics')) {
        return 0.0; // Hemat kuota, tidak perlu trace health check
      }
      return SENTRY_TRACES_SAMPLE_RATE;
    },

    // Hook GDPR Scrubbing: Dijalankan persis sebelum payload terkirim via jaringan
    beforeSend(event: Sentry.Event, hint: Sentry.EventHint): Sentry.Event | null {
      // 1. Scrubbing Request Data
      if (event.request) {
        if (event.request.headers) {
          event.request.headers = sanitizePiiData(event.request.headers) as Record<string, string>;
        }
        if (event.request.data) {
          event.request.data = sanitizePiiData(event.request.data);
        }
        if (event.request.cookies) {
          event.request.cookies = sanitizePiiData(event.request.cookies) as Record<string, string>;
        }
      }

      // 2. Custom Fingerprinting
      // Secara pintar mengelompokkan (grouping) error yang serupa, menghindari duplikasi spam alert.
      const exception = hint.originalException;
      if (exception instanceof Error) {
        if (exception.message.includes('Database connection timeout')) {
          event.fingerprint = ['database', 'connection-timeout'];
        } else if (exception.message.includes('Rate limit exceeded')) {
          event.fingerprint = ['api', 'rate-limit'];
        }
      }

      return event;
    },
  });
}
```

Pastikan melakukan *import* file instruksi Sentry pada baris teratas titik mula eksekusi aplikasi (*entrypoint*).

### `main.ts`

```typescript
// src/main.ts
import './instrument'; // HARUS di baris paling pertama!
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SentryGlobalFilter } from './common/filters/sentry.filter';
import { SentryInterceptor } from './common/interceptors/sentry.interceptor';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  
  // Mengaplikasikan Sentry Error Tracking dan Performance Monitoring secara global
  app.useGlobalFilters(new SentryGlobalFilter());
  app.useGlobalInterceptors(new SentryInterceptor());

  const PORT: number = parseInt(process.env.PORT ?? '3000', 10);
  await app.listen(PORT);
}

void bootstrap();
```

## 5. Global Exception Filter (Error Tracking)

Filter ini diaktifkan di seluruh lapisan siklus NestJS untuk menjaring error yang terlepas (ter-*throw*) dari blok `try-catch` di tingkat rute, layanan, atau *controller*.

### `sentry.filter.ts`

```typescript
// src/common/filters/sentry.filter.ts
import { 
  ArgumentsHost, 
  Catch, 
  ExceptionFilter, 
  HttpException, 
  HttpStatus, 
  Logger 
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { Request, Response } from 'express';

@Catch()
export class SentryGlobalFilter implements ExceptionFilter {
  private readonly logger = new Logger(SentryGlobalFilter.name);

  public catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    
    // Tentukan Status Code HTTP
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | Record<string, unknown> = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      message = typeof exceptionResponse === 'string' 
        ? exceptionResponse 
        : (exceptionResponse as Record<string, unknown>);
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    // Hanya laporkan ke Sentry Cloud jika error bernuansa kegagalan server (5xx)
    // Hindari mengirim 400 (Bad Request), 401 (Unauthorized), dsb agar kuota Sentry tidak cepat habis.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      Sentry.withScope((scope: Sentry.Scope) => {
        // Context Enrichment
        scope.setTag('path', request.url);
        scope.setTag('method', request.method);
        scope.setTag('status_code', status.toString());
        
        // Identifikasi Pengguna secara Anonim
        scope.setUser({ ip_address: request.ip });
        
        // Tambahkan Extra Context
        scope.setExtra('body', request.body);
        scope.setExtra('query', request.query);
        scope.setExtra('params', request.params);

        // Jika error bukan instansiasi objek `Error`, bungkus menjadi `Error` yang valid agar stack trace terselamatkan
        const capturedException = exception instanceof Error 
            ? exception 
            : new Error(`Non-Error object thrown: ${JSON.stringify(exception)}`);

        Sentry.captureException(capturedException);
        this.logger.error(`[Sentry Captured] ${request.method} ${request.url}`, capturedException.stack);
      });
    }

    // Standarisasi Balasan ke Klien
    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message,
    });
  }
}
```

## 6. Sentry Performance Interceptor

Untuk melacak *Performance Monitoring* (berapa lama setiap API beroperasi, *bottleneck* pada kueri basis data, *tracing latency*), kita membutuhkan `NestInterceptor`. 

### `sentry.interceptor.ts`

```typescript
// src/common/interceptors/sentry.interceptor.ts
import { 
  CallHandler, 
  ExecutionContext, 
  Injectable, 
  NestInterceptor 
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { Request } from 'express';

@Injectable()
export class SentryInterceptor implements NestInterceptor {
  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    
    // Penamaan Transaksi Sentry yang Jelas
    const transactionName = `${request.method} ${request.route?.path ?? request.url}`;
    
    return Sentry.startSpan(
      {
        op: 'http.server',
        name: transactionName,
      },
      (span) => {
        return next.handle().pipe(
          finalize(() => {
            // Selesaikan transaksi setelah respons HTTP dikirim atau terinterupsi error
            if (span) {
              span.end();
            }
          })
        );
      }
    );
  }
}
```

## 7. Analisis Trade-Off

### ✅ Kelebihan (Pros):
1. **Source Maps De-obfuscation Presisi Tinggi:** Berkat injeksi *Source Maps* via *CI/CD Pipeline* menggunakan Sentry CLI, pelacakan *bug* menjadi selevel IDE (melihat baris `controller.ts:45`) di dalam antarmuka UI web Sentry. Sangat menekan angka `Mean Time to Resolution (MTTR)`.
2. **Context Enrichment & Tracing:** Melampirkan *HTTP request payload*, *user agent*, *headers*, parameter kueri secara otomatis (namun termitigasi sensor). Fitur *Distributed Tracing* dapat dihubungkan ke *microservices* (via *header* `sentry-trace`).
3. **GDPR Zero-Trust Compliance:** Penerapan fungsi penyensor *PII* kustom menjamin tidak ada token, kata sandi, atau *credit card* *leak* tanpa sengaja yang meracuni *cloud*.
4. **Performance & Profiling Monitoring:** Melacak secara konstan *latency HTTP* untuk identifikasi masalah N+1 atau *deadlock* lambatnya koneksi DB.

### ❌ Kekurangan (Cons):
1. **Risiko Pemeliharaan Filter PII:** Fungsi `sanitizePiiData` bersifat rekursif. Apabila tingkat kueri (kedalaman struktur JSON) mencapai ribuan cabang (*deep nested objects*), akan mengakibatkan pemblokiran sinkron pada siklus *Node.js Event Loop* dan meningkatkan *CPU Usage*.
2. **Overhead Jaringan Tinggi & Kuota Finansial:** Tiap error *stack trace* tebal (biasanya 50-200 baris) beserta *source maps parsing* mengirim paket data besar ke *cloud*. Rate batas (*quota usage limits*) pada langganan berbayar berisiko *depleted* lebih awal jika aplikasi *spamming exception* tiada henti.
3. **Ketergantungan Eksternal:** Menyisipkan dan menginisialisasi pustaka observabilitas monolitik di akar proyek menyebabkan dependensi arsitektur yang menahan kelenturan saat bermigrasi ke solusi lain (misal DataDog atau OpenTelemetry lokal).

## 8. Anti-Patterns Kritis & Best Practices

### Anti-Pattern 1: Mengunggah Source Maps (.map) secara Publik ❌
❌ **Salah:** Membiarkan konfigurasi `tsconfig.json` melakukan kompilasi `sourceMap: true` dan menerbitkan direktori *build* `.js` berserta `.js.map` ke CDN atau direktori statis web *server* NGINX / Cloudflare. Akibatnya peretas *black-hat* sanggup membaca arsitektur asli, kunci rahasia statik, dan *internal logic*.
✅ **Benar:** Aktifkan injeksi otomatis `.map` lewat `sentry-cli` via CI/CD *runner* saat fase prapeluncuran (sebelum repositori *docker image* dipublikasikan), kemudian operasikan *perintah shell* khusus seperti `find dist/ -name "*.map" -type f -delete` setelah rilis ke Sentry sukses, menyensor total isi repositori *node_modules* yang rawan.

### Anti-Pattern 2: Swallowing (Menelan) dan Meredam Error Secara Pasif ❌
❌ **Salah:** Penangkapan *Error* dalam blok eksekusi `try-catch` tetapi hanya diredam tanpa dilempar kembali atau tak diserahterimakan pada *Global Exception Filter*.
```typescript
try {
  await this.paymentService.processHighRiskTransaction();
} catch (error) {
  // Silent fail: Error hilang tak terlacak. Sentry tidak akan merespon!
  this.logger.error("Terjadi kegagalan misterius.");
}
```
✅ **Benar:** Lakukan pengambilan log proaktif serta pemanggilan eksplisit `Sentry.captureException()`.
```typescript
try {
  await this.paymentService.processHighRiskTransaction();
} catch (error) {
  // Opsional tangkap segera dan lampirkan ke konteks jika krusial
  Sentry.captureException(error);
  // ATAU lempar ke atas agar Sentry Global Filter yang bekerja otomatis
  throw new InternalServerErrorException('Payment processing failed critically');
}
```

### Anti-Pattern 3: Penggunaan Tipe Data *Untyped* (`any`) untuk Data Sensor ❌
❌ **Salah:** Mengeksekusi penelusuran sensor data (PII) menggunakan `any`, membunuh kapabilitas keamanan TS.
✅ **Benar:** Memanfaatkan tipe `unknown`, struktur *Record<string, unknown>*, *type narrowing* yang ketat (seperti dipraktikkan pada langkah fungsi `sanitizePiiData` di atas) sesuai dengan standar *TypeScript 5 Strict Mode*.

## 9. Penanganan Kasus Ekstrem (Production Edge Cases)

1. **Jaringan Sentry Cloud Terputus / Unreachable / Blackhole:**
   - Karena Sentry pada lapisan bawah menggunakan protokol UDP asinkron di *Node.js*, ketika layanan Sentry tumbang, itu tak berujung meruntuhkan *main event-loop* server, karena semua kesalahan `socket` akan ditelan (`swallowed internally`) oleh Sentry SDK. Namun, hal ini membuat pemantauan aplikasi "buta". **Solusi:** Miliki cadangan (seperti AWS CloudWatch, Datadog *agent logger*, atau standar `pino` *stdout log metrics* teragregasi *fluentbit*).

2. **DDoS Attack yang Menyebabkan *Exception Splurging* & Rate Limiting (Pencekikan)**
   - Peretas meretas *endpoint* hingga gagal dengan jutaan permintaan palsu. Tiap *error* 500 mencoba melapor ke Sentry. Ini bisa membuat kuota bulanan tersedot hanya dalam hitungan detik. **Solusi:** Manfaatkan strategi *Rate Limiting Sentry*, terapkan blok IP agresif di WAF (Web Application Firewall), serta sesuaikan nilai algoritma sampel `tracesSampler` secara situasional jika tingkat lalu lintas masuk kategori tak wajar (anomaly).

3. **Source Map / Hash Release Version Mismatch:**
   - Sentry membutuhkan *hash* rilis aplikasi untuk menjodohkan kode `.js` yang error dengan `.map` yang spesifik di-unggah. Terkadang implementasi di CI/CD tertinggal (Sentry merilis versi 1.0.4 namun pod di Kubernetes masih 1.0.3). Saat hal ini terjadi, laporan *error* tidak akan berhasil di- *deobfuscate*. **Solusi:** Ikat selalu konfigurasi variabel global *Release Tag* pada setiap paket yang dilepaskan, semisal: `SENTRY_RELEASE: ${COMMIT_SHA}` dan injeksikan dalam berkas *Env*.
