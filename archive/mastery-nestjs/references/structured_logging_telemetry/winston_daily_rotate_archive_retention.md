# Winston Daily Rotate, Async Transport & Retention Strategy

## 1. Pendahuluan
Pada arsitektur *Enterprise*, layanan NestJS memproduksi log yang sangat masif, membanjiri I/O Disk, serta berisiko menyebabkan *out of storage* apabila log tidak dikelola dengan benar. Praktik pengelolaan log terbaik membutuhkan pemisahan file log berdasarkan siklus hari (*Daily Rotate*), kompresi arsip log lama (*gzip archive retention*), serta penghapusan otomatis arsip kedaluwarsa. 

Namun, menulis log ke disk secara sinkron akan memblokir *Event Loop* Node.js, terutama saat terjadi lonjakan trafik. Oleh karena itu, kita tidak hanya membutuhkan strategi rotasi, tetapi juga pola **Multi-Transport Fan-Out**, **Asynchronous Transport**, dan pola integrasi dengan *Log Aggregator* menggunakan pendekatan **Fluent Bit Sidecar** pada ekosistem microservices.

## 2. Diagram Arsitektur Multi-Transport & Sidecar
Berikut adalah arsitektur yang menjamin reliabilitas tinggi dan non-blocking logging:

```ascii
+--------------------------+          +-----------------------------------+
|      NestJS App Node     |          |       Asynchronous Buffer         |
|                          |          |                                   |
|  +--------------------+  |   Fan    |  +-----------------------------+  |
|  | Winston Core 3.x   |--+-- Out ---+->| Console (Dev)               |  |
|  +--------------------+  |          |  +-----------------------------+  |
|                          |          |  +-----------------------------+  |
|                          |          +->| Async Daily Rotate File     |  |
+--------------------------+          |  | /logs/error-%DATE%.log      |  |
                                      |  | /logs/app-%DATE%.log.gz     |  |
                                      |  +-----------------------------+  |
                                      +-----------------------------------+
                                                      |
+--------------------------+          +---------------v-------------------+
| Log Aggregator Backend   |          |  Fluent Bit Sidecar (Daemon)      |
| (Elasticsearch/Loki/     |<---------+  - Tail /logs/*.log               |
|  Datadog/CloudWatch)     |  HTTP/   |  - Parse JSON                     |
+--------------------------+  gRPC    |  - Buffer & Batch Forward         |
                                      +-----------------------------------+
```

## 3. Implementasi Produksi (TypeScript 5+ & NestJS 10+)

### a. Instalasi Dependencies
Kita memerlukan dependensi Winston, modul NestJS, serta plugin Daily Rotate File. Tidak menggunakan HTTP log shipper bawaan Winston karena berisiko menambah memori/latensi jika tujuan log melambat (kita offload ke Fluent Bit).

```bash
npm install winston nest-winston winston-daily-rotate-file
npm install --save-dev @types/winston @types/node
```

### b. Konfigurasi Winston Logger Service (Non-Blocking)
Pendekatan ini menggunakan environment variables murni tanpa hardcoded credential, dan menerapkan *type-safety* TS ketat, tanpa `any` atau `unknown`.

```typescript
// src/common/logger/winston-config.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WinstonModuleOptions, WinstonModuleOptionsFactory, utilities as nestWinstonModuleUtilities } from 'nest-winston';
import * as winston from 'winston';
import * as DailyRotateFile from 'winston-daily-rotate-file';
import { TransportStreamOptions } from 'winston-transport';

/**
 * Interface untuk mendefinisikan environment variables logging.
 * Memastikan zero 'any' dan type validation.
 */
export interface LoggerEnvConfig {
  NODE_ENV: 'development' | 'production' | 'test';
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  LOG_DIR: string;
  APP_NAME: string;
}

@Injectable()
export class WinstonConfigService implements WinstonModuleOptionsFactory {
  constructor(private readonly configService: ConfigService<LoggerEnvConfig, true>) {}

  public createWinstonModuleOptions(): WinstonModuleOptions {
    const isProduction: boolean = this.configService.get('NODE_ENV', { infer: true }) === 'production';
    const logDir: string = this.configService.get('LOG_DIR', { infer: true });
    const appName: string = this.configService.get('APP_NAME', { infer: true });
    const logLevel: string = this.configService.get('LOG_LEVEL', { infer: true });

    // 1. Console Transport (Berwarna di Dev, JSON murni di Prod)
    const consoleTransport: winston.transport = new winston.transports.Console({
      level: logLevel,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.ms(),
        isProduction
          ? winston.format.json()
          : nestWinstonModuleUtilities.format.nestLike(appName, {
              colors: true,
              prettyPrint: true,
            }),
      ),
    });

    // 2. Application Log Rotate Transport
    // Info ke atas disimpan dengan kompresi gzip
    const appRotateTransport: DailyRotateFile = new DailyRotateFile({
      level: 'info',
      dirname: logDir,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true, // ZLIB Gzip compression di background worker
      maxSize: '50m', // Rotasi jika mencapai 50 MB pada hari yang sama
      maxFiles: '30d', // Retensi selama 30 Hari (dihapus setelah lewat)
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json() // Wajib JSON agar mudah di-parse Fluent Bit
      ),
      options: { flags: 'a' } as TransportStreamOptions, // Mode append
    });

    // 3. Error Log Rotate Transport
    // Hanya menyimpan exception/error (memudahkan debug)
    const errorRotateTransport: DailyRotateFile = new DailyRotateFile({
      level: 'error',
      dirname: logDir,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '90d', // Error diretain lebih lama (90 hari) untuk audit keamanan
      format: winston.format.combine(
        winston.format.errors({ stack: true }), // Extract stack trace Error object
        winston.format.timestamp(),
        winston.format.json()
      ),
    });

    // Handle File Rotation Events secara elegan
    appRotateTransport.on('rotate', (oldFilename: string, newFilename: string) => {
      // Event hook, bisa ditambahkan metric (Prometheus)
      console.log(`[Logger] File rotated from ${oldFilename} to ${newFilename}`);
    });

    return {
      defaultMeta: { service: appName },
      transports: [
        consoleTransport,
        appRotateTransport,
        errorRotateTransport,
      ],
      // Menghindari node process crash jika ada unhandled exception / rejection
      exceptionHandlers: [
        new DailyRotateFile({
          dirname: logDir,
          filename: 'exceptions-%DATE%.log',
          datePattern: 'YYYY-MM-DD',
          maxFiles: '90d',
          zippedArchive: true,
        }),
      ],
      rejectionHandlers: [
        new DailyRotateFile({
          dirname: logDir,
          filename: 'rejections-%DATE%.log',
          datePattern: 'YYYY-MM-DD',
          maxFiles: '90d',
          zippedArchive: true,
        }),
      ]
    };
  }
}
```

### c. Setup Logger pada Bootstrap (`main.ts`)
```typescript
// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { ConfigService } from '@nestjs/config';
import { LoggerEnvConfig } from './common/logger/winston-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true, // Buffer log awal sampai winston siap
  });

  // Gunakan winston sebagai logger native NestJS
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));

  const configService: ConfigService<LoggerEnvConfig, true> = app.get(ConfigService);
  const port: number = configService.get<number>('PORT', 3000) as number;

  await app.listen(port);
  console.log(`Application started on port ${port}`);
}
bootstrap();
```

### d. Modul Core Logger
```typescript
// src/common/logger/logger.module.ts
import { Global, Module } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import { WinstonConfigService } from './winston-config.service';

@Global()
@Module({
  imports: [
    WinstonModule.forRootAsync({
      useClass: WinstonConfigService,
    }),
  ],
  providers: [WinstonConfigService],
  exports: [WinstonConfigService, WinstonModule],
})
export class LoggerModule {}
```

## 4. Pola Fluent Bit Sidecar (Kubernetes / Docker Compose)

Praktik terbaik Enterprise (terutama pada Kubernetes atau Nomad) **TIDAK PERNAH** mengirim log HTTP/gRPC langsung dari dalam runtime Node.js ke Datadog, Elasticsearch, atau Grafana Loki. Hal tersebut menimbulkan:
1. *Memory leak* jika backend log down (buffer queue internal kepenuhan).
2. Lonjakan *Event Loop* delay akibat *networking I/O* pada modul logging.

Solusi: Menggunakan pola *Sidecar*. Node.js cukup memuntahkan file ke folder `/logs`. Kontainer *Fluent Bit* membaca *(tail)* file log JSON tersebut.

### Konfigurasi Fluent Bit Pipeline (`fluent-bit.conf`)
```ini
[SERVICE]
    Flush        1
    Daemon       Off
    Log_Level    info
    Parsers_File parsers.conf

# 1. INPUT: Membaca log file harian yang dihasilkan Winston
[INPUT]
    Name             tail
    Path             /logs/app-*.log
    Exclude_Path     /logs/app-*.log.gz
    Tag              nest_app.*
    Parser           json
    Mem_Buf_Limit    50MB
    Skip_Long_Lines  On

# 2. FILTER: Enrich metadata (contoh K8s labels)
[FILTER]
    Name             kubernetes
    Match            nest_app.*
    Kube_URL         https://kubernetes.default.svc:443
    Kube_CA_File     /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    Kube_Token_File  /var/run/secrets/kubernetes.io/serviceaccount/token

# 3. OUTPUT: Batch kirim ke Elasticsearch secara asynchronous (atau Loki/Datadog)
[OUTPUT]
    Name             es
    Match            *
    Host             elasticsearch-master.logging.svc.cluster.local
    Port             9200
    Logstash_Format  On
    Logstash_Prefix  nest-app-logs
    Retry_Limit      False
```

## 5. Analisis Trade-Off Arsitektur

### Kelebihan ✅:
1. **Zero Node.js Overhead (High Performance):** NestJS hanya melakukan append ke file lokal (dan mendelegasikan rotasi menggunakan thread *worker pool* Node.js dari pustaka). Penanganan *networking backpressure* dilempar keluar aplikasi ke agen log (Fluent Bit).
2. **Infinite Uptime Security:** Konfigurasi retensi `maxFiles: '30d'` dan `maxSize: '50m'` menjamin 100% server Anda **TIDAK AKAN PERNAH** mengalami pemadaman *(downtime)* akibat *disk is full*.
3. **Resilience & Fault Tolerance:** Jika Log Aggregator (Elasticsearch) *down* atau terkena limit *(Rate Limit)*, aplikasi tidak ikut crash atau mengalami *memory bloating*. Log masih aman tertulis di disk hingga agen bisa mengirimkannya lagi.
4. **Rich JSON Context:** Kombinasi transport console yang berwarna (saat development) dan output JSON saat produksi menjaga ergonomi pengembang *(Developer Experience)* serta kemudahan analisis sistem sentral *(Observability)*.

### Kekurangan ❌:
1. **Ketergantungan Kompresi I/O CPU:** Saat `winston-daily-rotate-file` melakukan zipping log (via modul zlib bawaan Node.js), hal tersebut memakan resource komputasi *(CPU intensive)*. Pada server dengan resource CPU sangat minim (misal single core), ini bisa mengakibatkan *spike latency* sesaat pada aplikasi Node.js.
2. **Eventual Consistency Logging:** Terjadi keterlambatan (sekitar 1-2 detik) antara event yang log-nya dicetak oleh aplikasi hingga log tersebut tersedia dan dapat dicari di Dasbor Log Sentral karena buffering oleh agen (Fluent Bit).
3. **Masalah File Lock di Sistem Multi-Proses:** Pola ini bisa bermasalah ketika di-*deploy* menggunakan PM2 *cluster mode* dengan lebih dari 1 instance mencoba merotasi *file log* yang sama pada jam 00:00.

## 6. Anti-Patterns Kritis

### Anti-Pattern 1: Menyisipkan Kredensial Langsung (Hardcode API Keys)
❌ **Salah:** Membuka rahasia logging (Datadog API Key atau Splunk Token) di modul.
```typescript
// SANGAT BURUK! Menulis Log via HTTP winston transport tanpa perantara.
new winston.transports.Http({
  host: 'logs.datadoghq.com',
  path: '/v1/input/HARDCODED_API_KEY_123456789',
  ssl: true
})
```
✅ **Benar:** Jangan pernah menggunakan HTTP transport di winston jika bukan *side project*. Gunakan rotasi log disk `DailyRotateFile` lalu jalankan proses Fluent Bit Sidecar yang membaca token rahasia dari `.env` eksternalnya.

### Anti-Pattern 2: Logging Object Terlalu Besar (Fat Logs)
❌ **Salah:** Menggunakan `console.log(req.body)` pada middleware, yang mengakibatkan objek Base64 (foto) atau data besar masuk ke transport Winston.
✅ **Benar:** Lakukan *sanitization* menggunakan fungsi filter kustom atau JSON *masking* pada Winston Format.

### Anti-Pattern 3: Penggunaan `winston.transports.File` Polos
❌ **Salah:** Menggunakan bawaan file transport standar pada sistem produksi:
```typescript
// BURUK! File akan tumbuh hingga 200 GB.
new winston.transports.File({ filename: 'combined.log' }) 
```
✅ **Benar:** Selalu, selamanya, gunakan transport rotasi seperti `DailyRotateFile` dengan policy ukuran (`maxSize`) dan retensi waktu (`maxFiles`) secara bersamaan.

## 7. Penanganan Edge Cases di Produksi

1. **Permissions Error (EACCES) Saat Deployment:**
   - **Kasus:** Layanan NestJS dijalankan oleh user `app-runner` tanpa privilege *root*, tetapi direktori `/logs` dimiliki oleh `root`. Winston akan memicu exception saat aplikasi baru mulai (bootstrap) karena gagal membuat *(create)* file.
   - **Solusi:** Di Dockerfile atau skrip CI/CD, selalu jalankan `RUN mkdir -p /logs && chown -R node:node /logs`.

2. **Kondisi Race Condition Multi-Cluster Node.js (PM2 / Fork Mode):**
   - **Kasus:** Jika 4 pekerja (worker) PM2 mencoba merotasi nama file `app-2026-10-01.log` secara paralel pada pukul 00:00:00, dapat terjadi korupsi file log atau exception *EBUSY*.
   - **Solusi:** `winston-daily-rotate-file` tidak secara natif menangani cluster PM2 dengan baik. Jika Anda wajib pakai PM2, matikan transport file dan suruh PM2 untuk *pipe* seluruh standard out ke dalam log file dan PM2-Logrotate. File transport HANYA AMAN digunakan dalam arsitektur 1 proses per *container* (seperti Docker / Kubernetes).

3. **Timezone Rotasi vs. Alarm Kritis (UTC vs Local Time):**
   - **Kasus:** Rotasi log bawaan *(default)* terjadi pada jam 00:00 waktu lokal (Timezone Server / Container). Pada sistem cloud, kontainer Docker biasanya berjalan di waktu `UTC`. Artinya, file dirotasi pada jam 07:00 WIB (Waktu Indonesia Barat). Hal ini akan membingungkan *On-Call Engineer* NOC *(Network Operation Center)* saat menginvestigasi log "tanggal kemari".
   - **Solusi:** Pastikan kontainer Anda telah dikonfigurasi dengan variable `TZ=Asia/Jakarta` agar Winston berotasi secara sinkron dengan siklus operasional NOC tim Anda, atau setujui standar *UTC-only* di semua dashboard tanpa terkecuali.
