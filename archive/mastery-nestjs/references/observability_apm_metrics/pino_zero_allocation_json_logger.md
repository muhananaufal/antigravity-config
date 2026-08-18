# Pino Zero-Allocation JSON Logger di NestJS

Ekosistem NodeJS terkenal rentan terhadap penyumbatan alur peristiwa (*Event Loop Blocking*) akibat operasi I/O sinkron atau serialisasi *string* berskala besar. Logger standar (`console.log` atau logger bawaan NestJS) tidak dirancang untuk menangani jutaan baris log JSON secara konkuren. **Pino (`nestjs-pino`)** menggunakan format *Zero-Allocation* JSON berbasis arsitektur *SonicBoom* (menulis langsung ke I/O descriptor secara asinkron), menjadikannya pustaka logging tercepat dengan konsumsi RAM yang jauh lebih stabil.

## 1. Arsitektur SonicBoom I/O Asynchronous Stream

Diagram ini mengilustrasikan perbedaan jalur eksekusi Logger tradisional yang tersumbat saat *serialization* vs aliran asinkron dengan SonicBoom.

```ascii
[Tradisional: console.log]
(App) --> JSON.stringify() --> [Main Thread Blocked] --> OS stdout (Sync) --> (Disk/Console)
           ^ High CPU Allocation

[Pino Zero-Allocation]
(App) --> Pino String Builder (No object copy) --> [SonicBoom Stream] (Async I/O)
                                                           | (Background thread)
                                                           V
                                                OS stdout (Async/Batched)
```

## 2. Analisis Trade-Off

### Kelebihan (Pros)
1. **Performa Mentah (Raw Performance):** Diklaim hingga 5x lebih cepat daripada Winston/Morgan berkat minimisasi alokasi *garbage collection*.
2. **Struktur Berbasis JSON Bawaan:** Memaksa standardisasi *Structured Logging*, yang 100% siap ditelan oleh *log aggregator* seperti ELK (Elasticsearch, Logstash, Kibana) atau Datadog/Splunk tanpa filter *regex* tebal.
3. **Injeksi Konteks Otomatis:** Otomatis menambahkan ID Pelacakan HTTP (Request-ID) pada setiap log (Pino HTTP) secara transparan.

### Kekurangan (Cons)
1. **Konsol yang Tidak Ramah Manusia:** Keluaran mentah JSON sulit dibaca di konsol terminal *developer*. Membutuhkan modul `pino-pretty` untuk konversi visual (hanya boleh aktif pada lingkungan lokal/Dev).
2. **Kurva Adopsi Kurang Familier:** Pengembang yang terbiasa dengan metode logging tradisional sering melupakan pentingnya mem-passing objek dibandingkan string (contoh: `logger.info({ user: id }, 'msg')` vs `logger.info('user: ' + id)`).
3. **Redaksi Data (Redaction) Mahal:** Menerapkan fungsi *redact* (menyensor kata sandi/token di log) pada objek bersarang cukup mahal jika dieksekusi terus-menerus.

## 3. Production Edge Cases

1. **Memory Leak oleh Transport Asinkron:** Mengirim log langsung via HTTP (menggunakan transport pino) dari dalam aplikasi Node.js sering memblokir Event Loop pada latensi tinggi jaringan. Solusi: Keluarkan log ke `stdout` (12-factor app) dan gunakan agen eksternal (FluentBit, Vector) untuk *forwarding*.
2. **Circular References Error:** Objek dengan referensi sirkular (misal objek NestJS Request/Response penuh) akan membuat logger *crash* jika diteruskan mentah-mentah. Solusi: Gunakan properti `serializers` khusus pada konfigurasi Pino.
3. **Penyensoran Kredensial PII:** Tanpa disadari, token akses atau password masuk ke JSON log karena `console.log(request)`. Pino memiliki fungsi *redact* yang efisien, tetapi jalur path array harus ditinjau (seperti `['req.headers.authorization', 'user.password']`).

## 4. Anti-Patterns Kritis

### Anti-Pattern 1: Menggabungkan Objek dan String di Pesan Utama (String Concatenation)
**❌ Salah:** Hal ini merusak format JSON dan menambah kerja alokasi memori (string parsing).
```typescript
const user = { id: 1, name: 'Budi' };
// Logger terpaksa melakukan parsing lambat string.
this.logger.log(`Memproses user: ${JSON.stringify(user)}`);
```

**✅ Benar:** Menggunakan argumen pertama sebagai *context object* dan argumen kedua sebagai pesan deskriptif.
```typescript
const user = { id: 1, name: 'Budi' };
// Output JSON murni tanpa interpolasi mahal.
this.logger.info({ user }, 'Memproses user');
```

### Anti-Pattern 2: Menulis Log Transportasi HTTP Langsung dari Aplikasi
**❌ Salah:** Menggunakan *Pino Transport* yang mengirim ke ElasticSearch/Datadog dalam proses utama aplikasi (memblokir I/O jika Elastic down).
```typescript
pino({ transport: { target: 'pino-elasticsearch' } }); // Berbahaya di produksi!
```

**✅ Benar:** Aplikasi hanya menulis ke standard output (`stdout`), agen infrastruktur (seperti Fluentd, Vector, Promtail) yang mengurus pengiriman dan antrean ulang (*retry queues*).

## 5. Implementasi Pino Module & Konfigurasi Serializer

Konfigurasi mutakhir agar *zero-allocation* terjaga, penyensoran (*redact*) aktif, dan kompatibilitas NestJS terpenuhi.

```typescript
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        // Redaksi kredensial
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie', 'body.password'],
          censor: '[REDACTED]',
        },
        // Auto-Generate Request ID jika tidak ada
        genReqId: (req: IncomingMessage) => {
          return req.headers['x-request-id'] || randomUUID();
        },
        // Mencegah parsing obyek tebal, hanya catat yang relevan
        serializers: {
          req: (req: IncomingMessage) => ({
            id: req.id,
            method: req.method,
            url: req.url,
            // Header spesifik saja untuk menghindari log gempal
            userAgent: req.headers['user-agent'], 
            ip: req.socket.remoteAddress,
          }),
          res: (res: ServerResponse) => ({
            statusCode: res.statusCode,
          }),
          err: (err: Error) => ({
            type: err.name,
            message: err.message,
            stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
          }),
        },
        transport: process.env.NODE_ENV !== 'production'
          ? {
              target: 'pino-pretty',
              options: {
                singleLine: true,
                colorize: true,
              },
            }
          : undefined, // Di Produksi: Output Stdout Mentah
      },
    }),
  ],
})
export class AppLoggerModule {}
```

## 6. Unit Testing Suite (Logger Mocking)

Menguji fungsionalitas injeksi `PinoLogger` dalam *Service* secara terisolasi tanpa mencetak log fisik selama unit test (*polluting console*).

```typescript
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Test, TestingModule } from '@nestjs/testing';

@Injectable()
class ExampleService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(ExampleService.name);
  }

  public processTask(taskId: string): boolean {
    this.logger.info({ taskId }, 'Task processing started');
    try {
      if (taskId === 'error') throw new Error('Simulated failure');
      return true;
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error({ err: error, taskId }, 'Task processing failed');
      }
      throw error;
    }
  }
}

describe('PinoLogger Injection & Logic', () => {
  let service: ExampleService;
  let mockLogger: jest.Mocked<Partial<PinoLogger>>;

  beforeEach(async () => {
    mockLogger = {
      setContext: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExampleService,
        { provide: PinoLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<ExampleService>(ExampleService);
  });

  it('Should set context correctly', () => {
    expect(mockLogger.setContext).toHaveBeenCalledWith('ExampleService');
  });

  it('Should log info with object and message on success', () => {
    const result = service.processTask('123');
    expect(result).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith({ taskId: '123' }, 'Task processing started');
  });

  it('Should log error on exception with error object', () => {
    expect(() => service.processTask('error')).toThrow('Simulated failure');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'error', err: expect.any(Error) }),
      'Task processing failed'
    );
  });
});
```
