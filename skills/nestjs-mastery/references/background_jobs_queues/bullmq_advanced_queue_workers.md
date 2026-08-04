# Arsitektur Pemrosesan Antrean Latar Belakang Lanjutan dengan BullMQ di NestJS

## Pendahuluan
Pemrosesan antrean latar belakang (Background Queue Processing) merupakan komponen esensial dalam sistem terdistribusi modern untuk membebaskan *main event loop* dari tugas-tugas berat (I/O intensif, rendering laporan, pengiriman email massal). Menggunakan BullMQ (`@nestjs/bullmq`) yang ditenagai oleh Redis, kita dapat membangun infrastruktur antrean yang tangguh, terukur, dan mendukung fitur lanjutan seperti pengaturan konkurensi dinamis, alur kerja *Parent-Child*, serta mekanisme penghapusan duplikasi (*deduplication*) Job ID untuk menjamin idempotensi operasi kritis.

## Diagram Arsitektur

```text
[ API Gateway / Client ]
          |
    (HTTP POST)
          v
+-----------------------+      (Enqueue)       +-----------------------+
|  NestJS Producer API  | ===================> |    Redis (BullMQ)     |
+-----------------------+                      +-----------------------+
          ^                                           |      |      |
          | (Feedback)                       (Dequeue)|      |      |
          v                                           v      v      v
+-----------------------+                  +-----------------------------------+
|  WebSocket Gateway    |                  |  NestJS Worker Nodes (Scale Out)  |
|  (Realtime Updates)   | <=============== |  - Worker 1 (Concurrency: 5)      |
+-----------------------+   (Job Complete) |  - Worker 2 (Concurrency: 5)      |
                                           |  - Worker 3 (Concurrency: 5)      |
                                           +-----------------------------------+
```

## Implementasi Kode Produksi (TypeScript 5+ & NestJS 10+)

### 1. Konfigurasi Modul & Producer
```typescript
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DocumentQueueService } from './document-queue.service';
import { DocumentProcessorWorker } from './document-processor.worker';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST'),
          port: configService.get<number>('REDIS_PORT'),
          password: configService.get<string>('REDIS_PASSWORD'),
          tls: configService.get<boolean>('REDIS_TLS') ? {} : undefined,
          enableOfflineQueue: false,
        },
        defaultJobOptions: {
          removeOnComplete: 1000,
          removeOnFail: 5000,
          attempts: 3,
        },
      }),
    }),
    BullModule.registerQueue({
      name: 'document-processing',
    }),
  ],
  providers: [DocumentQueueService, DocumentProcessorWorker],
  exports: [DocumentQueueService],
})
export class DocumentQueueModule {}
```

### 2. Producer Service dengan Parent-Child Flow & Deduplication
```typescript
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, FlowProducer } from 'bullmq';
import { DocumentPayload, DocumentBatchResult } from './interfaces/document.interface';
import { randomUUID } from 'crypto';

@Injectable()
export class DocumentQueueService {
  private readonly logger = new Logger(DocumentQueueService.name);
  private readonly flowProducer: FlowProducer;

  constructor(
    @InjectQueue('document-processing') private readonly documentQueue: Queue<DocumentPayload, DocumentBatchResult, string>
  ) {
    this.flowProducer = new FlowProducer({ connection: this.documentQueue.opts.connection });
  }

  async enqueueSingleDocument(payload: DocumentPayload, idempotencyKey: string): Promise<string> {
    this.logger.log(`Enqueueing document processing for tenant ${payload.tenantId}`);
    
    const job = await this.documentQueue.add('process-pdf', payload, {
      jobId: idempotencyKey, // Deduplication by Job ID
      delay: 0,
      priority: 1,
    });
    
    return job.id ?? randomUUID();
  }

  async enqueueDocumentBatchWithParent(batchId: string, payloads: DocumentPayload[]): Promise<string> {
    this.logger.log(`Enqueueing batch flow with ${payloads.length} children for batch ${batchId}`);
    
    const childrenJobs = payloads.map((payload) => ({
      name: 'process-child-pdf',
      data: payload,
      queueName: 'document-processing',
      opts: { attempts: 3, jobId: `child-${batchId}-${payload.documentId}` },
    }));

    const flow = await this.flowProducer.add({
      name: 'finalize-batch',
      queueName: 'document-processing',
      data: { batchId, totalDocuments: payloads.length },
      opts: { jobId: `parent-batch-${batchId}` },
      children: childrenJobs,
    });

    return flow.job.id ?? randomUUID();
  }
}
```

### 3. Worker Lanjutan (Concurrency & Flow Handling)
```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DocumentPayload, DocumentBatchResult, BatchPayload } from './interfaces/document.interface';

@Processor('document-processing', {
  concurrency: 10, // Max 10 concurrent jobs per worker instance
  limiter: { max: 100, duration: 1000 }, // Max 100 jobs per second
  lockDuration: 30000,
})
export class DocumentProcessorWorker extends WorkerHost {
  private readonly logger = new Logger(DocumentProcessorWorker.name);

  async process(job: Job<DocumentPayload | BatchPayload, any, string>): Promise<any> {
    this.logger.log(`Processing job ${job.id} of type ${job.name}`);

    switch (job.name) {
      case 'process-pdf':
      case 'process-child-pdf':
        return this.handleDocumentProcessing(job as Job<DocumentPayload, DocumentBatchResult, string>);
      case 'finalize-batch':
        return this.handleBatchFinalization(job as Job<BatchPayload, { status: string }, string>);
      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
        throw new Error(`Unknown job name: ${job.name}`);
    }
  }

  private async handleDocumentProcessing(job: Job<DocumentPayload, DocumentBatchResult, string>): Promise<DocumentBatchResult> {
    const { documentId, tenantId, fileUrl } = job.data;
    this.logger.debug(`Processing document ${documentId} for tenant ${tenantId} from ${fileUrl}`);
    
    await new Promise((resolve) => setTimeout(resolve, 2000));
    
    if (Math.random() < 0.1) {
      throw new Error('Simulated random processing failure');
    }

    await job.updateProgress(100);
    return { documentId, success: true, processedAt: new Date().toISOString() };
  }

  private async handleBatchFinalization(job: Job<BatchPayload, { status: string }, string>): Promise<{ status: string }> {
    const { batchId } = job.data;
    this.logger.log(`Finalizing batch ${batchId}.`);
    
    const childrenValues = await job.getChildrenValues();
    const results = Object.values(childrenValues);
    
    this.logger.log(`Batch ${batchId} finalized with ${results.length} child results.`);
    return { status: 'COMPLETED_SUCCESSFULLY' };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    this.logger.error(`Job ${job.id} failed: ${error.message}`, error.stack);
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    this.logger.warn(`Job ${jobId} stalled! Check event loop blocks.`);
  }
}
```

## Analisis Trade-Off

### Kelebihan ✅
1. **Ketahanan Tinggi (Resilience):** BullMQ dibangun di atas Redis, memastikan jobs bertahan bahkan saat Node.js API server *crash* atau direstart.
2. **Kinerja & Konkurensi Canggih:** Kontrol granul pada level *worker* (contoh `concurrency: 10`) memungkinkan pemanfaatan multi-core secara maksimal.
3. **Orkestrasi Kompleks:** Fitur *Parent-Child* (Flows) memungkinkan pola Map-Reduce tanpa menulis logika state-machine manual; Parent job tidak akan dijalankan sebelum semua Child selesai.

### Kekurangan ❌
1. **Ketergantungan Infrastruktur Tambahan:** Membutuhkan *cluster* Redis yang dikonfigurasi dengan baik yang menambah kompleksitas *deployment*.
2. **Potensi Memori Redis Penuh (OOM):** Jika laju penambahan antrean lebih cepat dari pengolahan, Redis dapat kehabisan memori. Harus mengatur limit secara ketat.
3. **Masalah Serialisasi:** Semua payload harus bisa diserialisasi ke JSON. Melempar class instance akan merusak payload.

## Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan Blob Besar di Payload Job
Memasukkan string Base64 gambar berukuran besar ke dalam `job.data` yang akan memperlambat I/O Redis.
```typescript
// SALAH: Menyimpan isi file langsung di antrean
await this.queue.add('process-img', { imageBase64: '... 10MB string ...' });
```
✅ **Solusi Benar:** Simpan file di AWS S3, dan masukkan kuncinya ke antrean.
```typescript
await this.queue.add('process-img', { s3Key: 'tenant/123/img.jpg' });
```

### ❌ Anti-Pattern 2: Pemblokiran Event Loop dalam Worker
Melakukan operasi sinkron berat dalam `process()` akan memblokir detak jantung BullMQ, menyebabkan *Stalled Jobs*.
```typescript
// SALAH: CPU intensive task memblokir event loop
const result = crypto.pbkdf2Sync('password', 'salt', 1000000, 64, 'sha512');
```
✅ **Solusi Benar:** Pisahkan tugas CPU-intensif ke `worker_threads` atau service eksternal.

## Production Edge Cases
1. **Stalled Jobs (Zombie Workers):** Jika worker mati tanpa sinyal SIGTERM, job akan terkunci. BullMQ akan merestartnya setelah `lockDuration`.
2. **Race Conditions saat Scale-Out:** Puluhan instance *worker* memproses berisiko menyebabkan *Lost Updates* di DB. Wajib menggunakan *Optimistic Locking*.
3. **Penyusutan Redis Memory (Eviction Policies):** Jangan biarkan kebijakan redis menghapus job aktif BullMQ. Pisahkan *instance* Redis untuk Caching (allkeys-lru) dan antrean (noeviction).

## Unit Test Suite
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { DocumentQueueService } from './document-queue.service';
import { Queue } from 'bullmq';

describe('DocumentQueueService', () => {
  let service: DocumentQueueService;
  let mockQueue: jest.Mocked<Queue>;

  beforeEach(async () => {
    mockQueue = {
      add: jest.fn(),
      opts: { connection: {} },
    } as unknown as jest.Mocked<Queue>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentQueueService,
        { provide: getQueueToken('document-processing'), useValue: mockQueue },
      ],
    }).compile();

    service = module.get<DocumentQueueService>(DocumentQueueService);
    (service as any).flowProducer = { add: jest.fn().mockResolvedValue({ job: { id: 'flow-id' } }) };
  });

  it('should enqueue a single document with idempotency key', async () => {
    mockQueue.add.mockResolvedValue({ id: 'job-123' } as any);
    const payload = { documentId: 'doc-1', tenantId: 't-1', fileUrl: 'http://test' };
    const jobId = await service.enqueueSingleDocument(payload, 'idem-123');
    expect(mockQueue.add).toHaveBeenCalledWith('process-pdf', payload, { jobId: 'idem-123', delay: 0, priority: 1 });
    expect(jobId).toBe('job-123');
  });

  it('should enqueue batch with parent and children', async () => {
    const payloads = [{ documentId: 'doc-1', tenantId: 't-1', fileUrl: 'http://test' }];
    const flowId = await service.enqueueDocumentBatchWithParent('batch-99', payloads);
    expect((service as any).flowProducer.add).toHaveBeenCalled();
    expect(flowId).toBe('flow-id');
  });
});
```
