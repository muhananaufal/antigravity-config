# Horizontal Pod Autoscaling (HPA) Berbasis Kustom Metrik Prometheus

## 1. Visi Arsitektur Skala Elastis (Top 1% Engineering)

Skalabilitas horizontal tradisional yang hanya mengandalkan utilisasi CPU/Memory (`resource.cpu`) merupakan metode primitif yang lambat dan reaktif. Dalam arsitektur microservices kasta tinggi (NestJS), autoscaling idealnya dilakukan secara **proaktif** bersumber pada metrik bisnis murni. Contoh: Panjang antrean pesan tertunda di BullMQ/Redis, atau lonjakan p99 Latency / Requests Per Second (RPS) sebelum CPU sempat terkuras. 

Sistem ini dicapai dengan mengekspos metrik dari NestJS menggunakan `@willsoto/nestjs-prometheus`, menscrape metrik tersebut melalui Prometheus, lalu menggunakan Prometheus Adapter (KEDA atau K8s Custom Metrics API) untuk memberikan sinyal skala yang ganas ke HPA Controller K8s.

## 2. Topologi Autoscaling Metrik Kustom

```text
+-------------------------------------------------------------------------+
| KUBERNETES CLUSTER                                                      |
|                                                                         |
|   +-------------------+         [Trigger Scale-Up]                      |
|   | K8s HPA Controller| <------------------------------------------+    |
|   +---------+---------+                                            |    |
|             |                                                      |    |
|             | (Adjusts Replicas: 2 -> 10)                          |    |
|             v                                                      |    |
|   +-------------------+         +-------------------------------+  |    |
|   | NestJS Deployment |         | Prometheus Adapter / KEDA     |--+    |
|   | [Pod] [Pod] [Pod] |         | (Translates PromQL to K8s)    |       |
|   +---------+---------+         +---------------+---------------+       |
|             |                                   ^                       |
|             | (Exposes /metrics endpoint)       | (Scrapes PromQL)      |
|             v                                   |                       |
|   +-------------------+         +---------------+---------------+       |
|   | BullMQ / HTTP API | ------> | Prometheus Server             |       |
|   | (Queue / Latency) |         | (Time-Series Metrics DB)      |       |
|   +-------------------+         +-------------------------------+       |
+-------------------------------------------------------------------------+
```

## 3. Implementasi Metrik NestJS TypeScript 5+

```typescript
// src/metrics/queue-metrics.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Gauge, Registry } from 'prom-client';
import { InjectMetric } from '@willsoto/nestjs-prometheus';

@Injectable()
export class QueueMetricsService implements OnModuleInit {
  private queueLengthGauge: Gauge<string>;

  constructor(
    @InjectQueue('video-transcoding') private readonly transcodeQueue: Queue,
    private readonly registry: Registry,
  ) {
    this.queueLengthGauge = new Gauge({
      name: 'nestjs_bullmq_queue_waiting_jobs',
      help: 'Jumlah antrean pekerjaan yang belum diproses dalam BullMQ',
      labelNames: ['queue_name'],
      registers: [this.registry],
    });
  }

  public onModuleInit(): void {
    // Memantau secara berkala. Pada level produksi yang ganas,
    // kita meminimalisir impact loop ini via setInterval.
    setInterval(async () => {
      try {
        const waitingCount = await this.transcodeQueue.getWaitingCount();
        this.queueLengthGauge.labels('video-transcoding').set(waitingCount);
      } catch (error) {
        // Silenced failure untuk mencegah crash daemon pengukur
      }
    }, 5000);
  }
}
```

Manifest K8s HPA untuk mengekstrak metrik:

```yaml
# hpa-prometheus.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: nestjs-video-worker-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: nestjs-video-worker
  minReplicas: 2
  maxReplicas: 20
  metrics:
  - type: Object
    object:
      metric:
        name: nestjs_bullmq_queue_waiting_jobs
      describedObject:
        apiVersion: v1
        kind: Service
        name: prometheus-adapter
      target:
        type: Value
        # Skalakan 1 Pod tambahan setiap penumpukan 50 job antrean
        value: 50
```

## 4. Unit / K8s Watcher Mock Test Suite

```typescript
// src/metrics/queue-metrics.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { QueueMetricsService } from './queue-metrics.service';
import { getQueueToken } from '@nestjs/bullmq';
import { Registry, Gauge } from 'prom-client';

describe('QueueMetricsService (HPA PromQL Emitter)', () => {
  let service: QueueMetricsService;
  let mockQueue: { getWaitingCount: jest.Mock };
  let mockRegistry: { registerMetric: jest.Mock };

  beforeEach(async () => {
    mockQueue = {
      getWaitingCount: jest.fn().mockResolvedValue(150),
    };
    mockRegistry = {
      registerMetric: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueueMetricsService,
        { provide: getQueueToken('video-transcoding'), useValue: mockQueue },
        { provide: Registry, useValue: mockRegistry },
      ],
    }).compile();

    service = module.get<QueueMetricsService>(QueueMetricsService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('seharusnya mendaftarkan Gauge untuk metrics K8s HPA secara benar', () => {
    // Menggunakan trik reflection via private accessor test
    const gauge = (service as any).queueLengthGauge as Gauge<string>;
    expect(gauge).toBeDefined();
    expect(gauge.name).toEqual('nestjs_bullmq_queue_waiting_jobs');
  });

  it('seharusnya secara periodik memperbarui jumlah antrean', async () => {
    jest.useFakeTimers();
    const gauge = (service as any).queueLengthGauge as Gauge<string>;
    const setSpy = jest.spyOn(gauge, 'set');
    const labelSpy = jest.spyOn(gauge, 'labels').mockReturnValue({ set: setSpy } as any);

    service.onModuleInit();
    
    // Majukan timer 5000ms untuk trigger interval
    jest.advanceTimersByTime(5000);
    
    // Tuntaskan promise getWaitingCount
    await Promise.resolve();

    expect(mockQueue.getWaitingCount).toHaveBeenCalled();
    expect(labelSpy).toHaveBeenCalledWith('video-transcoding');
    expect(setSpy).toHaveBeenCalledWith(150);
  });
});
```

## 5. Analisis Trade-Off

### Kelebihan
1. **Skalabilitas Preventif & Akurat**: Skalabilitas berdasarkan Queue Length (BullMQ) akan memicu Pod untuk naik mendahului spike CPU yang lambat, menumbangkan antrean sebelum sistem macet.
2. **Kustomisasi Tak Terbatas**: Mampu menyesuaikan skala (autoscaling) berdasarkan parameter per-tier user (contoh: utamakan melompatkan Pod untuk pengguna VIP daripada pengguna gratis).
3. **Efisiensi FinOps (Cost-Savings)**: Dapat turun skala (scale down) ke replika 0 atau 1 dengan presisi tinggi saat antrean sudah kosong sempurna.

### Kekurangan
1. **Titik Kegagalan Eksternal (SPOF)**: Jika Prometheus atau Prometheus Adapter tumbang, HPA menjadi buta (metrics terhenti) dan Pod gagal merespons badai traffic.
2. **Kompleksitas Infrastruktur Keras**: Membutuhkan ekosistem PromQL, Service Monitors, KEDA, dan manajemen sertifikat yang rumit untuk mem-bypass agregasi aman K8s API.
3. **Lag Prometheus Scrape**: Prometheus scraping secara standar berjalan pada interval 15-30 detik. Ada waktu tempuh tunda antara metrik lonjakan terjadi, diserap Prometheus, dicerna Adapter, dan dieksekusi K8s HPA.

## 6. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Terlalu Agresif Memicu Scaledown Window
Membuat jendela penurunan skala (scale-down window) HPA terlalu cepat akan memicu fenomena fluktuasi liar (Thrashing/Flapping) di mana K8s membunuh dan melahirkan pod terus-menerus.

**Salah:**
```yaml
behavior:
  scaleDown:
    stabilizationWindowSeconds: 10 # Terlalu agresif, Pod akan hancur dan lahir beruntun
```

**Benar:**
```yaml
behavior:
  scaleDown:
    stabilizationWindowSeconds: 300 # Pod ditahan selama 5 menit sebelum dieksekusi untuk memastikan tren reda
```

### ❌ Anti-Pattern 2: Melacak Jumlah Total Request Alih-Alih Rate/RPS
Memerintahkan HPA untuk menskalakan Pod dari Total Hit (Counter) yang terus bertambah akan mengakibatkan pod diskalakan hingga ke angka maksimal selamanya.

**Salah (Prometheus Query di Adapter):**
`sum(nestjs_http_requests_total)`

**Benar (Prometheus Query di Adapter):**
`sum(rate(nestjs_http_requests_total[2m]))` # Evaluasi RPS/lonjakan trafik yang dinamis.

## 7. Production Edge Cases

1. **Deadlock Redis / BullMQ Connection**: Jika Redis tempat BullMQ bersemayam mencapai batas memori atau koneksi terkunci, `getWaitingCount()` akan throw Error. Desain metrik gagal yang tidak henti (uncaught exception) pada interval pengukur dapat membunuh worker. Penempatan blok `try...catch` mutlak diperlukan.
2. **Cardinality Bomb Explosion**: Memasukkan `userId` atau parameter yang sangat dinamis sebagai Label ke Prometheus `Gauge` di NestJS akan meledakkan memori Time Series DB (Cardinality Bomb), menjatuhkan Prometheus server Anda sepenuhnya.
3. **Cold Start Penalty Node.js**: HPA yang melahirkan Pod (Scale Up) memakan waktu 15-40 detik agar V8 Engine Bootstrap & NestJS IOC menyelesaikan fase warm-up. Jika Spike Traffic naik tajam seketika (100x lipat), HPA berbasis metrik kustom tetap tertinggal jika tidak didesain dengan pre-warming/over-provisioning statis minimal 20% head-room cadangan.
