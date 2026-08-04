# Strategi Pemulihan Kegagalan: Exponential Backoff Retry & DLQ

## Pendahuluan
Dalam pemrosesan asinkron (seperti integrasi API eksternal), kegagalan sementara (*transient failures*) adalah hal biasa. Untuk menghindari "banjir kegagalan" yang dapat merobohkan sistem eksternal, kita wajib mengimplementasikan **Exponential Backoff dengan Jitter**. Ketika batas *retry* telah terlampaui, alih-alih menghapus tugas tersebut, kita mengevakuasinya ke **Dead Letter Queue (DLQ)** untuk pemutaran ulang di kemudian hari.

## Diagram Arsitektur

```text
       [ TUGAS BARU ] -> (BullMQ Main Queue)
                              |
                     +--------+--------+
                     |                 |
                   (Sukses)         (Gagal)
                     |                 |
                [ SELESAI ]            v
                            (Cek Retry Attempts < Max)
                               /              \
                             (Ya)            (Tidak)
                             /                  \
                [ Exponential Backoff ]     [ Evakuasi (Move) ]
                [ Delay: 2^n + Jitter ]              \
                             \                        v
                         (Re-Queue)          ( DEAD LETTER QUEUE / DLQ )
                                                 (Redis Set / DB)
```

## Implementasi Kode Produksi (TypeScript 5+ & NestJS 10+)

### 1. Konfigurasi Retry dan Exponential Backoff di Queue
```typescript
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhookService } from './webhook.service';
import { WebhookProcessor } from './webhook.processor';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'webhook-delivery',
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 2000, // Mulai dari 2 detik
        },
        removeOnComplete: 100,
        removeOnFail: false, // JANGAN dihapus saat gagal
      },
    }),
  ],
  providers: [WebhookService, WebhookProcessor],
  exports: [WebhookService],
})
export class WebhookModule {}
```

### 2. Implementasi Processor dengan Evakuasi DLQ Kustom
```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebhookPayload } from './interfaces/webhook.interface';
import { DeadLetterJobEntity } from './entities/dlq.entity';
import axios from 'axios';

export class PermanentFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentFailureError';
  }
}

@Processor('webhook-delivery', { concurrency: 20 })
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(
    @InjectRepository(DeadLetterJobEntity)
    private readonly dlqRepository: Repository<DeadLetterJobEntity>,
  ) {
    super();
  }

  async process(job: Job<WebhookPayload, any, string>): Promise<any> {
    this.logger.log(`Attempt ${job.attemptsMade + 1} for Job ${job.id}`);

    try {
      const response = await axios.post(job.data.targetUrl, job.data.payload, { timeout: 5000 });
      return { status: response.status, data: response.data };
    } catch (error: any) {
      this.logger.warn(`Webhook failed to ${job.data.targetUrl}: ${error.message}`);
      
      if (error.response && error.response.status >= 400 && error.response.status < 500 && error.response.status !== 429) {
        throw new PermanentFailureError(`Client Error ${error.response.status}. Do not retry.`);
      }
      throw error;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<WebhookPayload>, error: Error): Promise<void> {
    const isPermanent = error instanceof PermanentFailureError;
    const isExhausted = job.attemptsMade >= (job.opts.attempts || 1);

    if (isPermanent || isExhausted) {
      this.logger.error(`Job ${job.id} exhausted retries. Evacuating to DLQ...`);
      
      try {
        await this.dlqRepository.save({
          queueName: job.queueName,
          originalJobId: job.id,
          payload: job.data,
          failedReason: error.message,
          attemptsMade: job.attemptsMade,
          evacuatedAt: new Date(),
        });
        
        await job.remove(); // Hapus dari Redis untuk hemat RAM
        this.logger.log(`Job ${job.id} saved to DLQ Db and cleared from Redis.`);
      } catch (dlqError: any) {
        this.logger.fatal(`CRITICAL: DLQ Save Failed. ${dlqError.message}`);
      }
    }
  }
}
```

## Analisis Trade-Off

### Kelebihan ✅
1. **Self-Healing & Resiliency:** Sistem pulih secara otomatis tanpa intervensi manusia.
2. **Pencegahan Beban Berlebih:** Penundaan eksponensial memberikan ruang nafas (*cooling period*) pada sistem tujuan.
3. **Data Loss Prevention:** DLQ persisten di *Relational DB* menjamin tidak ada tugas (notifikasi kritis) yang lenyap begitu saja.

### Kekurangan ❌
1. **Peningkatan Latensi Pemrosesan:** Kegagalan berturut-turut pada ujung antrean menyebabkan penundaan tidak cocok untuk respons real-time.
2. **Kompleksitas Penyimpanan DLQ:** Menyimpan payload utuh DLQ ke dalam Database dapat menyebabkan ukuran tabel membengkak drastis.
3. **Risiko Re-Execution Ganda:** Jika batas waktu HTTP dipotong (Timeout di NestJS), namun server tujuan perlahan menyelesaikan tugas, *retry* berikutnya dapat menjadi eksekusi ganda.

## Anti-Patterns

### ❌ Anti-Pattern 1: Linear Retry atau Fixed Delay
Melakukan percobaan ulang konstan setiap 1 detik.
```typescript
// SALAH: Membombardir server yang down
backoff: { type: 'fixed', delay: 1000 }, attempts: 10
```
✅ **Solusi Benar:** Gunakan `type: 'exponential'` untuk backoff.

### ❌ Anti-Pattern 2: Mere-try Error Logis Klien (400 Bad Request)
Jika Payload API tidak valid, dire-try pun akan tetap gagal (Deterministic Error).
```typescript
// SALAH: Menangkap semua error dan dibiarkan dire-try oleh BullMQ
catch (e) { throw e; }
```
✅ **Solusi Benar:** Deteksi *Permanent Errors* dan lempar error unik yang memicu pembuangan ke DLQ langsung.

## Production Edge Cases
1. **Poison Pills:** Job dengan payload tidak terduga yang merusak Worker setiap di-parse. Perlu validasi tipe statis sejak awal.
2. **Redis Memory Exhaustion:** Antrean *Delayed/Waiting* memakan memori. Ribuan job yang gagal dan menanti retry eksponensial dalam durasi lama akan menguras RAM.
3. **Urutan Pemrosesan Berantakan:** Pekerjaan dengan *retry* tertinggal dari antrean baru. Hindari pola ini jika Anda mewajibkan antrean *Strict FIFO*.

## Unit Test Suite
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { WebhookProcessor, PermanentFailureError } from './webhook.processor';
import { DeadLetterJobEntity } from './entities/dlq.entity';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('WebhookProcessor', () => {
  let processor: WebhookProcessor;
  let dlqRepo: any;

  beforeEach(async () => {
    dlqRepo = { save: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookProcessor,
        { provide: getRepositoryToken(DeadLetterJobEntity), useValue: dlqRepo },
      ],
    }).compile();
    processor = module.get<WebhookProcessor>(WebhookProcessor);
  });

  afterEach(() => { jest.clearAllMocks(); });

  it('should process job successfully', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200, data: 'OK' });
    const job = { data: { targetUrl: 'http://a.com' } } as Job;
    const result = await processor.process(job as any);
    expect(result.status).toBe(200);
  });

  it('should throw PermanentFailureError on 400', async () => {
    mockedAxios.post.mockRejectedValue({ response: { status: 400 } });
    const job = { data: { targetUrl: 'http://a.com' } } as Job;
    await expect(processor.process(job as any)).rejects.toThrow(PermanentFailureError);
  });

  it('should evacuate job to DLQ on PermanentFailureError', async () => {
    const jobMock = {
      id: 'job-1', queueName: 'q', opts: { attempts: 5 }, attemptsMade: 1, remove: jest.fn()
    } as unknown as Job;
    
    await processor.onFailed(jobMock, new PermanentFailureError('Bad Request'));
    expect(dlqRepo.save).toHaveBeenCalled();
    expect(jobMock.remove).toHaveBeenCalled();
  });
});
```
