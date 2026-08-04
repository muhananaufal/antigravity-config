# Event-Driven Microservices: SQS & SNS Worker via AWS Lambda

## Pendahuluan

Dalam arsitektur terdistribusi yang sangat diskalabel, Amazon SQS (Simple Queue Service) dan Amazon SNS (Simple Notification Service) bertindak sebagai urat nadi komunikasi asynchronous. NestJS secara alami mendukung pemrosesan event ini di dalam konteks AWS Lambda. Dengan mendelegasikan event dari Lambda Trigger secara langsung ke NestJS Application Context (secara Standalone), kita dapat menikmati *Dependency Injection* tanpa overhead pemrosesan antarmuka HTTP.

## Arsitektur Sistem (Event-Driven Worker)

```ascii
+-------------+       +--------------+        +---------------------------+
|             |       |              |        |                           |
|  Amazon     +------>+  AWS Lambda  +------->+   NestJS Standalone       |
|  SQS / SNS  |       |  (Poller)    |        |   Application Context     |
|             |       |              |        |                           |
+-------------+       +--------------+        +-------------+-------------+
       ^                                                    |
       |  (Batch Item Failures)                             |
       +----------------------------------------------------+
```

## Implementasi Produksi (SQS Batch Processing & Partial Failures)

Dalam AWS SQS, kita bisa menerima pesan dalam bentuk "Batch" (hingga 10 pesan sekaligus). Jika satu pesan gagal, sangat berbahaya untuk menggagalkan *seluruh* batch (karena pesan yang sukses akan diproses ulang / duplicate processing). Kita harus mengembalikan objek `SQSBatchResponse` yang mengandung `itemIdentifier` dari pesan yang gagal saja.

### 1. Definisi Layanan Pekerja SQS (SQS Worker Service)

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { SQSRecord } from 'aws-lambda';

export interface ProsesPesanResult {
  sukses: boolean;
  messageId: string;
  error?: string;
}

@Injectable()
export class OrderWorkerService {
  private readonly logger = new Logger(OrderWorkerService.name);

  // Simulasi dependensi lain, misalnya Database Service
  // constructor(private readonly dbService: DatabaseService) {}

  public async processBatch(records: SQSRecord[]): Promise<string[]> {
    const failedMessageIds: string[] = [];

    // Proses secara paralel untuk efisiensi, atau berurutan jika ada constraint
    const prosesPromises = records.map(async (record: SQSRecord) => {
      const hasil = await this.prosesSatuPesan(record);
      if (!hasil.sukses) {
        failedMessageIds.push(hasil.messageId);
      }
    });

    await Promise.allSettled(prosesPromises);

    return failedMessageIds;
  }

  private async prosesSatuPesan(record: SQSRecord): Promise<ProsesPesanResult> {
    try {
      this.logger.log(`Memulai pemrosesan pesan: ${record.messageId}`);
      
      const payload = JSON.parse(record.body);
      
      // Validasi ketat terhadap payload
      if (!payload.orderId || !payload.amount) {
         throw new Error('Payload pesan tidak valid: orderId atau amount hilang');
      }

      // Simulasi logika bisnis kompleks (misal: simpan ke database, potong saldo)
      this.logger.log(`Memproses order ID: ${payload.orderId} senilai ${payload.amount}`);
      
      // await this.dbService.processOrder(payload.orderId);

      this.logger.log(`Pesan ${record.messageId} sukses diproses.`);
      return { sukses: true, messageId: record.messageId };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Gagal memproses pesan ${record.messageId}: ${errorMsg}`);
      return { sukses: false, messageId: record.messageId, error: errorMsg };
    }
  }
}
```

### 2. Lambda Handler Entrypoint (`sqs-handler.ts`)

Kita menginisialisasi NestJS menggunakan `NestFactory.createApplicationContext` (Standalone App) alih-alih `NestFactory.create` (HTTP Server), sehingga bootstrap sangat ringan.

```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { OrderWorkerService } from './order-worker.service';
import { SQSEvent, SQSBatchResponse, Context } from 'aws-lambda';
import { INestApplicationContext } from '@nestjs/common';

let cachedAppContext: INestApplicationContext | undefined = undefined;

async function getApplicationContext(): Promise<INestApplicationContext> {
  if (!cachedAppContext) {
    cachedAppContext = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn', 'log'],
    });
  }
  return cachedAppContext;
}

export const handler = async (
  event: SQSEvent,
  context: Context,
): Promise<SQSBatchResponse> => {
  context.callbackWaitsForEmptyEventLoop = false;
  
  const appCtx: INestApplicationContext = await getApplicationContext();
  const workerService: OrderWorkerService = appCtx.get(OrderWorkerService);

  const failedMessageIds: string[] = await workerService.processBatch(event.Records);

  // Mengembalikan ReportBatchItemFailures untuk partial success
  const batchItemFailures = failedMessageIds.map((id: string) => ({
    itemIdentifier: id,
  }));

  return { batchItemFailures };
};
```

## Unit Testing & Handler Mock Suite

Pengujian memastikan bahwa kegagalan parsial di-handle dan dicatat tanpa menggagalkan seluruh respon Lambda.

```typescript
import { handler } from './sqs-handler';
import { SQSEvent, Context, SQSRecord } from 'aws-lambda';
import { NestFactory } from '@nestjs/core';
import { OrderWorkerService } from './order-worker.service';

jest.mock('@nestjs/core', () => ({
  NestFactory: {
    createApplicationContext: jest.fn(),
  },
}));

describe('SQS Lambda Worker', () => {
  let mockEvent: SQSEvent;
  let mockContext: Context;
  let mockWorkerService: Partial<OrderWorkerService>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockWorkerService = {
      processBatch: jest.fn(),
    };

    (NestFactory.createApplicationContext as jest.Mock).mockResolvedValue({
      get: jest.fn().mockReturnValue(mockWorkerService),
    });

    mockEvent = {
      Records: [
        { messageId: 'msg-1', body: '{"orderId":"1", "amount": 100}' } as SQSRecord,
        { messageId: 'msg-2', body: '{"orderId":"2", "amount": 200}' } as SQSRecord,
      ],
    } as SQSEvent;

    mockContext = {
      callbackWaitsForEmptyEventLoop: true,
      functionName: 'sqs-worker-lambda',
    } as unknown as Context;
  });

  afterEach(() => {
    jest.resetModules();
  });

  it('harus memproses semua pesan sukses dan mengembalikan batch kosong', async () => {
    (mockWorkerService.processBatch as jest.Mock).mockResolvedValue([]);

    const result = await handler(mockEvent, mockContext);

    expect(mockWorkerService.processBatch).toHaveBeenCalledWith(mockEvent.Records);
    expect(result.batchItemFailures).toEqual([]);
    expect(mockContext.callbackWaitsForEmptyEventLoop).toBe(false);
  });

  it('harus mengembalikan ID pesan yang gagal dalam batchItemFailures', async () => {
    // Simulasi msg-2 gagal
    (mockWorkerService.processBatch as jest.Mock).mockResolvedValue(['msg-2']);

    const result = await handler(mockEvent, mockContext);

    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: 'msg-2' },
    ]);
  });
});
```

## Analisis Trade-Off

### Kelebihan
1. **Ketahanan Tinggi (High Resiliency):** Antrean SQS menyimpan pesan jika database sedang down. Pesan tidak hilang; Lambda dapat melakukan proses ulang dengan strategi Dead Letter Queue (DLQ).
2. **Skalabilitas Ekstrem:** Lambda memproses polling ke SQS secara masif. Kita dapat membatasi tingkat konkuren (Concurrency Limit) untuk melindungi *downstream service* yang lebih rapuh.
3. **Efisiensi Kode (Standalone App):** NestJS hanya mem-bootstrap komponen Service (tanpa layer Express/Fastify HTTP), menjadikannya lebih cepat diinisialisasi untuk event workers murni.

### Kekurangan
1. **Kompleksitas Tracing:** Melacak satu transaksi alur pengguna melintasi beberapa Microservices via SQS/SNS membutuhkan sistem observability khusus seperti AWS X-Ray atau Datadog.
2. **Idempotency Constraint:** AWS SQS menjamin *At-Least-Once Delivery* (terutama antrean Standar). Aplikasi HARUS dirancang invulnerabel terhadap pemrosesan duplikat (Idempotent).
3. **Delay Waktu Nyata:** SQS menambah latensi (overhead asynchronous), tidak cocok untuk logika balasan HTTP yang menuntut waktu respon sinkron yang ketat dari antarmuka pengguna.

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Mengabaikan Partial Batch Failures
**Mengapa salah?** Jika satu pesan gagal dalam sebuah batch dan Anda melemparkan (throw) error secara global, semua pesan lainnya yang berhasil di batch itu akan dikembalikan ke SQS, memicu duplikasi pemrosesan ketika batch tersebut dicoba ulang.

```typescript
// SALAH: Jangan melempar error langsung dalam iterasi batch
export const handler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    const payload = JSON.parse(record.body);
    // Jika simpanDB gagal, error dilempar dan fungsi berhenti!
    // SQS menganggap SELURUH batch gagal dan mencoba ulang semua!
    await simpanDB(payload);
  }
};
```

### ✅ Best Practice: Return ReportBatchItemFailures
```typescript
// BENAR: Mengembalikan list id pesan yang spesifik gagal. AWS hanya akan retry pesan itu.
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const failedIds: string[] = [];
  for (const record of event.Records) {
     try {
       await simpanDB(JSON.parse(record.body));
     } catch(err) {
       failedIds.push(record.messageId);
     }
  }
  return { batchItemFailures: failedIds.map(id => ({ itemIdentifier: id })) };
};
```

### ❌ Anti-Pattern 2: Asumsi Exactly-Once Processing
**Mengapa salah?** Menganggap bahwa Lambda hanya dipicu tepat satu kali per pesan. SQS standard dapat mengirim pesan yang sama dua kali pada jaringan yang bergejolak.

```typescript
// SALAH: Update saldo secara membabi buta tanpa mengecek status
await db.execute('UPDATE dompet SET saldo = saldo + ?', [amount]);
```

### ✅ Best Practice: Terapkan Kunci Idempotency
```typescript
// BENAR: Pastikan pesan dengan ID yang sama hanya diproses sekali.
const transaksi = await db.cariTransaksi(record.messageId);
if (transaksi) {
  return { sukses: true }; // Sudah diproses sebelumnya.
}
// Buat transaksi baru dengan ID pesan sebagai primary key / idempotency key
```

## Production Edge Cases

1. **Poison Pill Messages:** Pesan cacat yang selalu menyebabkan parse JSON gagal atau null pointer. Hal ini akan selamanya terjebak dalam loop (Retry Storm).
   - **Solusi:** Selalu bungkus eksekusi worker dalam `try/catch` per-pesan. Konfigurasikan Dead Letter Queue (DLQ) pada AWS SQS di angka *maxReceiveCount = 3*.
2. **Batas Ukuran Payload SQS:** SQS hanya mengizinkan pesan hingga 256KB. Bagaimana jika payload event berukuran 5MB?
   - **Solusi:** Gunakan pola "Claim Check". Simpan payload 5MB di Amazon S3, dan kirimkan `s3://bucket/key` di dalam SQS. NestJS Lambda mengambil datanya dari S3 saat memproses pesan.
3. **Keterbatasan Koneksi Downstream (DB Thrashing):** Lambda Worker bisa saja meluncur dalam 1000 instance secara bersamaan jika SQS dipenuhi oleh jutaan pesan, yang berujung pada kelumpuhan sistem Database relasional secara langsung.
   - **Solusi:** Gunakan parameter *Reserved Concurrency* pada AWS Lambda untuk Worker tersebut, membatasinya secara keras ke maksimal 50 konkuren, bertindak sebagai katup pelepas tekanan (Throttling) yang anggun.
