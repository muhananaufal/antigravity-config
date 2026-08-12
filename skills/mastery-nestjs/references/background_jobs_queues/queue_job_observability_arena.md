# Observabilitas Sistem Antrean: Real-Time Monitoring & Tracing

## Pendahuluan
Bekerja dengan arsitektur latar belakang asinkron seperti BullMQ sering diumpamakan sebagai kotak hitam. Tanpa observabilitas mumpuni, tim buta terhadap *stalled jobs* atau *memory leaks*. Kombinasi visualisasi metrik **Bull-Board** dan injeksi **OpenTelemetry (OTel)** di level antrean memungkinkan inspeksi real-time dan pembedahan alur (*distributed trace*) lintas-*microservices*.

## Diagram Arsitektur Observabilitas

```text
                                [ Grafana / Jaeger UI ]
                                          ^
                                          | (Trace Span Exporter)
+-----------------------+      +---------------------------+       +-------------------+
|  NestJS Producer API  | --+  |       OTel Collector      |       |  DevOps Admin     |
+-----------------------+   |  +---------------------------+       +-------------------+
  (Inject Trace Context)    |                ^                               |
          v                 |                | (Trace Span Export)           v (Browser)
+-----------------------+   |  +---------------------------+       +-------------------+
|    Redis (BullMQ)     |   |  |   NestJS Worker Nodes     |       | Express UI Server |
+-----------------------+   +->|   (Extract Trace Context) |       |  (Bull-Board)     |
          ^                    +---------------------------+       +-------------------+
          |                                                                  |
          +--------------------( Baca Metrik Redis Lengkap )-----------------+
```

## Implementasi Kode Produksi (TypeScript 5+ & NestJS 10+)

### 1. Memasang Dashboard Bull-Board
```typescript
import { Controller, Get, Next, Req, Res, UseGuards } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Request, Response, NextFunction } from 'express';
import { AdminAuthGuard } from '../auth/admin-auth.guard'; // Proteksi wajib

@Controller('/admin/queues')
@UseGuards(AdminAuthGuard)
export class QueueDashboardController {
  private serverAdapter: ExpressAdapter;

  constructor(
    @InjectQueue('document-processing') private readonly docQueue: Queue,
    @InjectQueue('webhook-delivery') private readonly webhookQueue: Queue,
  ) {
    this.serverAdapter = new ExpressAdapter();
    this.serverAdapter.setBasePath('/admin/queues');

    createBullBoard({
      queues: [
        new BullMQAdapter(this.docQueue),
        new BullMQAdapter(this.webhookQueue),
      ],
      serverAdapter: this.serverAdapter,
      options: {
        uiConfig: {
          boardTitle: 'Queue Dashboard',
        },
      },
    });
  }

  @Get('*')
  getDashboard(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction) {
    const router = this.serverAdapter.getRouter();
    router(req, res, next);
  }
}
```

### 2. Injeksi OpenTelemetry (OTel)
```typescript
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { trace, context, propagation } from '@opentelemetry/api';

@Injectable()
export class OTelQueueProducerService {
  constructor(@InjectQueue('webhook-delivery') private readonly queue: Queue) {}

  async enqueueWithTrace(payload: any): Promise<string> {
    const tracer = trace.getTracer('bullmq-producer');
    
    return tracer.startActiveSpan('enqueue-webhook-job', async (span) => {
      try {
        const traceCarrier = {};
        propagation.inject(context.active(), traceCarrier);

        const job = await this.queue.add('send-hook', {
          ...payload,
          _otelContext: traceCarrier,
        });
        
        span.setAttribute('messaging.system', 'bullmq');
        span.setAttribute('job.id', job.id || 'unknown');
        
        return job.id as string;
      } finally {
        span.end();
      }
    });
  }
}
```

### 3. Ekstraksi OTel di sisi Worker
```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { trace, context, propagation } from '@opentelemetry/api';

@Processor('webhook-delivery')
export class OTelWebhookWorker extends WorkerHost {
  
  async process(job: Job<any, any, string>): Promise<any> {
    const tracer = trace.getTracer('bullmq-worker');
    
    const traceCarrier = job.data._otelContext || {};
    const parentContext = propagation.extract(context.active(), traceCarrier);
    
    return context.with(parentContext, async () => {
      return tracer.startActiveSpan(`process-job:${job.name}`, async (span) => {
        span.setAttribute('messaging.system', 'bullmq');
        span.setAttribute('job.id', job.id || '');

        try {
          // PROSES BISNIS
          const result = await this.executeLogic(job.data);
          span.setStatus({ code: 1 }); // OK
          return result;
        } catch (error: any) {
          span.setStatus({ code: 2, message: error.message }); // ERROR
          span.recordException(error);
          throw error;
        } finally {
          span.end();
        }
      });
    });
  }

  private async executeLogic(data: any): Promise<string> { return 'Done'; }
}
```

## Analisis Trade-Off

### Kelebihan ✅
1. **Penyelesaian Masalah Holistik:** Jika lambat, Traces OTel akan menampilkan garis waktu mulai dari awal mula API.
2. **Kemudahan Administratif:** Bull-Board ramah pengguna untuk menghapus/me-*retry* jobs massal.
3. **Visibilitas Proaktif:** Engineer dapat mengatur Alerts dari Traces yang dikumpulkan.

### Kekurangan ❌
1. **Beban Kinerja OTel (Overhead):** Memakan sedikit CPU dan bandwidth jaringan. Tidak dianjurkan untuk tugas < 1 milidetik.
2. **Isolasi Keamanan (Security Risk):** Bull-Board dapat menjadi celah keamanan serius bila tak diproteksi ketat.
3. **Penyimpanan Metrik:** Menyimpan Traces dari sistem sibuk menghabiskan disk server Jaeger.

## Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan PII Secara Hardcoded di Log/Traces
```typescript
// SALAH: Mengekspos kredensial pelanggan ke trace
span.setAttribute('payload', JSON.stringify(job.data));
```
✅ **Solusi Benar:** Masking data sensitif.

### ❌ Anti-Pattern 2: Membuka Rute Bull-Board Tanpa Filter Auth
```typescript
// SALAH: Ekspos Publik
@Controller('queues')
export class Dashboard {} 
```
✅ **Solusi Benar:** Wajib terapkan `@UseGuards(AdminAuthGuard)`.

## Production Edge Cases
1. **Dashboard OOM:** Memuat ratusan ribu *completed jobs* dari Redis bisa menyebabkan UI Server crash. Limit penyimpanan wajib ada.
2. **Broken Trace Lineage:** Jika pekerjaan dipicu cron internal tanpa konteks trace induk, akan ada orphan traces.
3. **Metadata Polusi:** `_otelContext` terus disisipkan dalam alur Parent-Child dapat menyebabkan ukuran data payload bengkak di Redis.

## Unit Test Suite
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { QueueDashboardController } from './queue-dashboard.controller';
import { OTelQueueProducerService } from './otel-queue-producer.service';
import { getQueueToken } from '@nestjs/bullmq';

describe('Queue Observability Specs', () => {
  describe('OTelQueueProducerService', () => {
    let service: OTelQueueProducerService;
    let mockQueue: any;

    beforeEach(async () => {
      mockQueue = { add: jest.fn().mockResolvedValue({ id: 'otel-1' }) };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          OTelQueueProducerService,
          { provide: getQueueToken('webhook-delivery'), useValue: mockQueue },
        ],
      }).compile();
      service = module.get<OTelQueueProducerService>(OTelQueueProducerService);
    });

    it('should inject otel context into payload', async () => {
      const jobId = await service.enqueueWithTrace({ key: 'val' });
      expect(jobId).toBe('otel-1');
      expect(mockQueue.add).toHaveBeenCalledWith(
        'send-hook', 
        expect.objectContaining({ key: 'val', _otelContext: expect.any(Object) })
      );
    });
  });

  describe('QueueDashboardController', () => {
    it('should be defined with guards', () => {
      const guards = Reflect.getMetadata('__guards__', QueueDashboardController);
      expect(guards).toBeDefined();
    });
  });
});
```
