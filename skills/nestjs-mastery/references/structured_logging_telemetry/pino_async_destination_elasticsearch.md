# Pino Async Multi-Destination Transport & ECS Compliance (Elasticsearch / OpenSearch)

## 1. Pendahuluan

Dalam ekosistem aplikasi backend berskala enterprise (Tier-1, miliaran request per hari), logging bukanlah operasi trivial. Pencatatan log secara sinkron melalui `console.log` akan memblokir Event Loop Node.js (V8 main thread), menyebabkan *throughput* aplikasi (Transactions Per Second - TPS) menurun secara drastis, meningkatkan latensi, dan berpotensi menyebabkan bottleneck I/O.

Untuk memitigasi isu ini, standar industri mengharuskan penggunaan sistem logging asinkron berkinerja tinggi. **Pino** adalah standar *de facto* di ekosistem Node.js karena pendekatan arsitekturalnya yang memanfaatkan *Worker Threads* untuk melakukan *offloading* proses I/O. 

Dokumen ini menjelaskan arsitektur **Multi-Destination Fanout**, implementasi redaksi PII (Personally Identifiable Information), **Elastic Common Schema (ECS) Compliance**, dan versi skema logging terstruktur untuk Elasticsearch atau OpenSearch, dijamin sepenuhnya type-safe (TypeScript 5+ ready) tanpa celah keamanan hardcoded secrets.

---

## 2. Arsitektur Logging: Multi-Destination Fanout & Worker Threads

Pendekatan *Multi-Destination Fanout* memungkinkan aplikasi mengirimkan satu payload log ke berbagai target sistem (misal: Console, File, Elasticsearch, Datadog) secara asinkron tanpa menambah beban di *main thread*. 

```ascii
+-----------------------------------------------------------------------------------+
|                            Node.js Main Event Loop (V8)                           |
|                                                                                   |
|  [NestJS App] ---> Logger.info({ user: "..." }) ---> (Offloaded via MessagePort)  |
+-------------------------------------------------------|---------------------------+
                                                        |
                                                        v
+-----------------------------------------------------------------------------------+
|                              Pino Worker Thread Pool                              |
|                                                                                   |
|                            [Pino Multi-Transport Fanout]                          |
|                               /             |             \                       |
|                              /              |              \                      |
|                             v               v               v                     |
|                 +---------------+   +----------------+  +-------------------+     |
|                 | stdout (Dev)  |   | File Rolling   |  | Pino Elasticsearch|     |
|                 | pino-pretty   |   | pino-roll      |  | Batch & Flush HTTP|     |
|                 +---------------+   +----------------+  +-------------------+     |
+-------------------------------------------------------------------|---------------+
                                                                    |
                                                                    v
                                                     +------------------------------+
                                                     |  Elasticsearch / OpenSearch  |
                                                     |  Cluster (Log Aggregation)   |
                                                     +------------------------------+
```

Pino menggunakan modul `worker_threads` Node.js untuk mengeksekusi *transport*. Serialization JSON yang berat dan I/O jaringan dipindahkan sepenuhnya ke luar jalur eksekusi bisnis utama.

---

## 3. ECS (Elastic Common Schema) Compliance & Schema Versioning

Kibana dan Elasticsearch berkinerja paling optimal saat format log selaras dengan **Elastic Common Schema (ECS)**. Dengan ECS, metrik, log, dan traces dari berbagai layanan akan terstruktur dengan standar yang seragam (misalnya: `user.id`, `http.request.method`, `trace.id`), memungkinkan korelasi log lintang-mikroservis yang efisien.

Selain itu, menambahkan *schema versioning* menjamin *backward compatibility* pada *data pipelines* ketika format log aplikasi diubah.

---

## 4. Keamanan: Redaksi Data PII

Sangat dilarang keras membocorkan token, *password*, nomor kartu kredit, atau data medis ke sistem log terpusat. Pino menyediakan kapabilitas `redact` bawaan berkinerja tinggi (berbasis *fast-redact*) yang membersihkan payload JSON sebelum dikirim ke *transport*.

---

## 5. Implementasi Kode Produksi TypeScript 5+ & NestJS 10+

Kode di bawah ini sepenuhnya *type-safe*, murni TypeScript (zero `any`), dan mengandalkan `process.env` atau *ConfigService* NestJS.

### a. Instalasi Dependencies

```bash
npm install pino pino-elasticsearch pino-http nestjs-pino @elastic/elasticsearch ecs-pino-format
npm install -D @types/pino @types/pino-http pino-pretty
```

### b. Format Skema & PII Redaction Configuration

Kita pisahkan konfigurasi skema dan redaksi log untuk menjamin tingkat isolasi yang baik.

```typescript
// src/common/logger/logger.config.ts
import { ecsFormat } from '@elastic/ecs-pino-format';
import type { TransportMultiOptions, LoggerOptions } from 'pino';

export interface AppLoggerConfig {
  nodeEnv: string;
  elasticUrl: string;
  elasticIndex: string;
  elasticApiKey: string;
  logLevel: string;
  schemaVersion: string;
}

/**
 * Mendefinisikan rute (path) JSON yang akan disensor sebelum masuk transport.
 */
const piiRedactionPaths: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.creditCard',
  'req.body.socialSecurityNumber',
  'user.email',
  'user.phone',
];

/**
 * Builder untuk menghasilkan konfigurasi Pino Transport dengan kapabilitas Multi-Destination.
 */
export function buildPinoTransport(config: AppLoggerConfig): TransportMultiOptions | undefined {
  if (config.nodeEnv === 'test') {
    return undefined; // Mematikan transport saat testing
  }

  const targets: TransportMultiOptions['targets'] = [];

  // Transport 1: Console prettifier untuk local development
  if (config.nodeEnv === 'development') {
    targets.push({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
      level: config.logLevel,
    });
  }

  // Transport 2: Elasticsearch untuk Production / Staging
  if (config.nodeEnv === 'production' || config.nodeEnv === 'staging') {
    if (!config.elasticUrl || !config.elasticApiKey) {
      throw new Error('Elasticsearch URL & API Key are required in production/staging environments');
    }

    targets.push({
      target: 'pino-elasticsearch',
      options: {
        node: config.elasticUrl,
        auth: {
          apiKey: config.elasticApiKey,
        },
        index: config.elasticIndex,
        opType: 'create', // Immutable logs
        flushBytes: 10000, // Batching 10KB
        flushInterval: 5000, // Flush setiap 5 detik
        rejectUnauthorized: true, // TLS validation
      },
      level: config.logLevel,
    });
  }

  return targets.length > 0 ? { targets } : undefined;
}

/**
 * Menyusun Logger Options dengan integrasi ECS Format.
 */
export function buildPinoOptions(config: AppLoggerConfig): LoggerOptions {
  return {
    level: config.logLevel,
    redact: {
      paths: piiRedactionPaths,
      censor: '[REDACTED]',
    },
    ...ecsFormat(), // Injeksi ECS Common Schema
    base: {
      env: config.nodeEnv,
      schema_version: config.schemaVersion,
      service_name: 'core-backend-api',
    },
  };
}
```

### c. NestJS Logger Module

Menggunakan `nestjs-pino` yang secara otomatis membungkus *request* HTTP dan mengikat konfigurasi Pino secara asinkron dari `ConfigService`.

```typescript
// src/common/logger/logger.module.ts
import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { pino } from 'pino';
import { buildPinoTransport, buildPinoOptions, AppLoggerConfig } from './logger.config';

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const config: AppLoggerConfig = {
          nodeEnv: configService.get<string>('NODE_ENV') ?? 'development',
          elasticUrl: configService.get<string>('ELASTICSEARCH_URL') ?? '',
          elasticIndex: configService.get<string>('ELASTICSEARCH_INDEX') ?? 'app-logs',
          elasticApiKey: configService.get<string>('ELASTICSEARCH_API_KEY') ?? '',
          logLevel: configService.get<string>('LOG_LEVEL') ?? 'info',
          schemaVersion: configService.get<string>('LOG_SCHEMA_VERSION') ?? 'v1.0.0',
        };

        const transportOptions = buildPinoTransport(config);
        const pinoOptions = buildPinoOptions(config);

        // Jika transportOptions ada, kita integrasikan ke pino options
        if (transportOptions) {
          Object.assign(pinoOptions, {
            transport: transportOptions,
          });
        }

        return {
          pinoHttp: {
            ...pinoOptions,
            autoLogging: true,
            // Format log HTTP request untuk ECS compliance
            customProps: (req, res) => {
              return {
                context: 'HTTP',
                http: {
                  request: { method: req.method },
                  response: { status_code: res.statusCode },
                },
              };
            },
          },
        };
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class AppLoggerModule {}
```

### d. Interceptor Trace ID & Correlation ID

Agar log dapat dilacak melintasi berbagai layanan mikro (microservices), kita mewajibkan injeksi `traceId` (atau `correlation-id`) ke setiap request. Di sini kita memanipulasi *header* dan membiarkan `nestjs-pino` mencatat request context.

```typescript
// src/common/logger/trace-id.interceptor.ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';

@Injectable()
export class TraceIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    
    // Mengekstrak trace ID dari header upstream, atau generate baru
    const traceId = request.headers['x-trace-id'] || request.headers['x-correlation-id'] || uuidv4();
    
    // Normalisasi header agar dicatat oleh pino-http
    request.headers['x-trace-id'] = traceId;
    request['traceId'] = traceId; // Custom prop di objek request

    return next.handle();
  }
}
```

### e. Unit Testing dengan Zero 'Any'

Memastikan modul Logger dapat diinisialisasi tanpa memblokir sistem test (sehingga transport akan bernilai *undefined* dan logs masuk memori/dev/null).

```typescript
// src/common/logger/logger.module.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { AppLoggerModule } from './logger.module';
import { ConfigModule } from '@nestjs/config';

describe('AppLoggerModule', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              NODE_ENV: 'test',
              ELASTICSEARCH_URL: 'https://localhost:9200',
              ELASTICSEARCH_INDEX: 'test-logs',
              ELASTICSEARCH_API_KEY: 'test-key',
              LOG_LEVEL: 'silent',
              LOG_SCHEMA_VERSION: 'v1.0.0',
            }),
          ],
        }),
        AppLoggerModule,
      ],
    }).compile();
  });

  it('should successfully compile the module with valid config', () => {
    expect(module).toBeDefined();
  });
});
```

---

## 6. Analisis Trade-Off

Setiap keputusan arsitektur memiliki kelebihan dan konsekuensi. Berikut adalah profil trade-off untuk Pino Async Elasticsearch:

### ✅ Kelebihan (Pros):
1. **Zero Event Loop Blocking:** Proses serialisasi, transformasi JSON, dan I/O jaringan HTTP berjalan murni di `worker_threads`. V8 Main thread bebas melayani *business logic*, menjaga latensi tetap stabil di bawah beban tinggi (HFT/Enterprise tier).
2. **Batching Otomatis & Throttling:** Payload tidak dikirim satu per satu, melainkan di-*batch* secara agregat di memori hingga batas buffer (misal `10000 bytes`) atau durasi (misal `5000 ms`) terpenuhi, menurunkan beban IOPS di sistem cluster Elasticsearch.
3. **ECS Formatter Native:** Otomatis menghasilkan log seragam. Kibana *Dashboarding* akan sangat instan tanpa harus mengkonfigurasi parser log (Logstash filter/Grok rules).
4. **Keamanan Redaksi Nirkontak (Contactless Redaction):** Redaksi PII berlangsung di transport thread; variabel asli di *main thread* (seperti objek domain) tidak dimutasi (zero mutation bug).

### ❌ Kekurangan (Cons):
1. **Volatilitas Data Memory (Data Loss Risk):** Karena log di-*buffer* dalam memori worker, bila pod Kubernetes (atau proses Node.js) dimatikan secara kasar (`SIGKILL`), log yang ada di buffer akan hilang sebelum sempat di-*flush* ke ES.
2. **Beban Overhead Memori (RAM):** Worker threads mengkonsumsi memori V8 terpisah. Pada infrastruktur dengan RAM super ketat (< 128MB per microservice), worker thread dapat memicu OOM (Out Of Memory).
3. **Kompleksitas Infrastruktur Log:** Menjaga API Key Elasticsearch dan *mapping schema* ES menuntut koordinasi ketat dengan tim DevOps.

---

## 7. Anti-Patterns Kritis ❌ vs ✅

### Anti-Pattern 1: Serialisasi Manual Objek Raksasa
Mengkonversi objek besar di jalur request akan merusak latensi keseluruhan API.
❌ **Salah:**
```typescript
// Memblokir V8 Event loop secara masif, menurunkan throughput
const payload = JSON.stringify(giantDomainObject, null, 2);
logger.info(payload);
```
✅ **Benar:** Biarkan Pino dan Worker Thread mengurus konversi JSON.
```typescript
// Cepat dan asynchronous
logger.info({ data: giantDomainObject }, 'Processing domain action');
```

### Anti-Pattern 2: Kebocoran Hardcoded Secrets & Environment Any
❌ **Salah:** Menggunakan type asersi paksa (`any` / `as string`) dan nilai *hardcoded*.
```typescript
// Rentan bocor saat code terkomit ke GitHub (Supply chain attack)
const apiKey: any = 'RWRXWFpU...'; 
```
✅ **Benar:** Ketat dalam Typescript, nilai mutlak dari infrastruktur (process.env)
```typescript
const apiKey: string = configService.getOrThrow<string>('ELASTICSEARCH_API_KEY');
```

### Anti-Pattern 3: Mutasi Object untuk Penyensoran
❌ **Salah:** Mengedit *property* object di main thread untuk membuang PII.
```typescript
const reqBody = { ...req.body };
delete reqBody.password; // Menyebabkan de-optimisasi V8 (Hidden Class invalidation)
logger.info(reqBody);
```
✅ **Benar:** Gunakan konfigurasi `redact` di logger instansiasi.
```typescript
// Otomatis disensor oleh pino fast-redact di balik layar
logger.info({ reqBody: req.body }); 
```

---

## 8. Production Edge Cases & Mitigation Strategi

1. **Mapping Explosion di Elasticsearch (Type Conflict):**
   * **Kasus:** Elasticsearch menolak log karena *field* yang bernama sama (misal `data.user`) di satu log bertipe `string`, tetapi di log lain bertipe `object`. Ini disebut *Mapping Explosion/Conflict*.
   * **Mitigasi:** Standarisasi skema dengan ECS, dan gunakan tipe data primitif secara konsisten. Tambahkan *Index Template* di Elasticsearch dengan konfigurasi `dynamic: false` atau `ignore_malformed: true` pada field *arbitrary*.
   
2. **Buffer Overflow & OOM (Out of Memory):**
   * **Kasus:** Pada saat aplikasi diserang (DDoS) atau *traffic spike* mendadak, jutaan log masuk, buffer `pino-elasticsearch` menggelembung melebih kapasitas RAM.
   * **Mitigasi:** Batasi `flushBytes` maksimal misal `50000` (50KB), atau implementasikan *Circuit Breaker* dan `pino.extreme()` mode untuk langsung drop log jika ES sedang lambat atau mati.
   
3. **Graceful Shutdown (SIGTERM):**
   * **Kasus:** NestJS aplikasi di-*rollout* oleh Kubernetes. Jika proses Node.js langsung putus, log asinkron yang di memori tidak terkirim.
   * **Mitigasi:** Tangkap event `SIGTERM` / `SIGINT` menggunakan NestJS lifecycle hooks `onApplicationShutdown()`, lalu paksa logger untuk melakukan sinkronisasi terakhir:
     ```typescript
     import { pino } from 'pino';
     process.on('SIGTERM', () => {
        pino.final(logger).info('Application is terminating gracefully');
        // Panggil flush manual ke dest jika support
     });
     ```
4. **Jaringan Terputus dari Elasticsearch:**
   * **Kasus:** Elasticsearch *cluster* *timeout* atau mengalami masalah DNS, `pino-elasticsearch` bisa melemparkan unhandled error di worker thread.
   * **Mitigasi:** Pastikan worker thread tidak meng-*crash*-kan main thread (biasanya Pino sudah memisahkan fault domain). Untuk keandalan kelas militer, gunakan log forwarder agen lokal (FluentBit / Vector) yang membaca log dari `stdout` atau UNIX Socket, menggeser beban retry logic keluar dari NodeJS.
