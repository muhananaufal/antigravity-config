# Penjadwalan Cron Berbasis Kunci Terdistribusi dengan Redlock di NestJS

## Pendahuluan
Penjadwalan tugas latar belakang (Cron Jobs) menggunakan decorator `@Cron()` bawaan NestJS (`@nestjs/schedule`) sangat mudah diimplementasikan, tetapi memunculkan masalah kritis dalam lingkungan produksi *multi-node*. Jika Anda menjalankan 5 replika pod Kubernetes, jadwal Cron akan terpicu 5 kali bersamaan. Untuk mencegah eksekusi duplikat yang dapat merusak integritas data, kita harus menerapkan mekanisme *Distributed Atomic Lock* menggunakan Redlock.

## Diagram Arsitektur

```text
       Cron Trigger (0 0 * * *)
              |
+-------------+-------------+-------------+
|             |             |             |
v             v             v             v
Pod 1         Pod 2         Pod 3         Pod 4
(NestJS)      (NestJS)      (NestJS)      (NestJS)
  |             |             |             |
  +----+        +------+      +--------+    +-------+
       |               |               |            |
       v               v               v            v
  [ SET NX "report_lock" EX 60000 ] (Redis Cluster)
       |               |               |            |
  (Sukses)         (Gagal)         (Gagal)      (Gagal)
       |               |               |            |
       v               v               v            v
[ Eksekusi Job ]  [ Bypass/Skip ] [ Bypass/Skip ] [ Bypass ]
```

## Implementasi Kode Produksi (TypeScript 5+ & NestJS 10+)

### 1. Integrasi Redlock Service
```typescript
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import Redlock, { Lock } from 'redlock';

@Injectable()
export class DistributedLockService implements OnApplicationShutdown {
  private readonly logger = new Logger(DistributedLockService.name);
  private readonly redisClient: Redis;
  private readonly redlock: Redlock;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('REDIS_HOST', 'localhost');
    const port = this.configService.get<number>('REDIS_PORT', 6379);
    
    this.redisClient = new Redis({ host, port });
    
    this.redlock = new Redlock([this.redisClient], {
      driftFactor: 0.01,
      retryCount: 0, // Gagal -> berarti node lain yang eksekusi
      retryDelay: 200,
      retryJitter: 200,
      automaticExtensionThreshold: 500,
    });

    this.redlock.on('error', (error) => {
      this.logger.error(`Redlock Error: ${error.message}`, error.stack);
    });
  }

  async acquireLock(resource: string, ttlMs: number): Promise<Lock | null> {
    try {
      this.logger.debug(`Attempting to acquire lock on: ${resource}`);
      return await this.redlock.acquire([`lock:${resource}`], ttlMs);
    } catch (error: unknown) {
      this.logger.debug(`Lock ${resource} already acquired by another node.`);
      return null;
    }
  }

  async releaseLock(lock: Lock): Promise<void> {
    try {
      await lock.release();
    } catch (error: unknown) {
      this.logger.warn(`Failed to release lock: ${String(error)}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.redlock.quit();
    await this.redisClient.quit();
  }
}
```

### 2. Implementasi Cron Job
```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DistributedLockService } from './distributed-lock.service';
import { ReportGeneratorService } from './report-generator.service';

@Injectable()
export class DailyReportCronService {
  private readonly logger = new Logger(DailyReportCronService.name);

  constructor(
    private readonly lockService: DistributedLockService,
    private readonly reportService: ReportGeneratorService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { name: 'generate_daily_billing' })
  async handleDailyBillingReport(): Promise<void> {
    const lockKey = 'cron:daily_billing_report';
    const lockTtl = 300000; // 5 menit

    const lock = await this.lockService.acquireLock(lockKey, lockTtl);

    if (!lock) {
      this.logger.log(`Another instance is processing. Skipping.`);
      return;
    }

    try {
      this.logger.log('Lock acquired. Starting daily billing...');
      await this.reportService.generateAndDistributeReports();
      this.logger.log('Daily billing generation completed.');
    } catch (error: unknown) {
      this.logger.error(`Error during generation`, (error as Error).stack);
      throw error;
    } finally {
      this.logger.log(`Keeping lock until TTL expires to prevent drift double execution.`);
    }
  }
}
```

## Analisis Trade-Off

### Kelebihan ✅
1. **Keamanan Data Mutlak:** Menghilangkan eksekusi duplikat saat menggunakan arsitektur *microservices* terdistribusi atau *autoscaling*.
2. **Tanpa Leader Election Kompleks:** Tidak memerlukan setup ZooKeeper. Memanfaatkan kluster Redis yang sudah ada.
3. **Efisiensi Sumber Daya:** Node yang gagal mengambil *lock* segera mundur dan melanjutkan *idle*.

### Kekurangan ❌
1. **Single Point of Failure (SPOF):** Jika Redis mati, penjadwalan gagal total. (Solusi: gunakan Redis Cluster/Sentinel).
2. **Clock Drift Issues:** Redlock sangat sensitif terhadap perbedaan waktu sistem (NTP drift) antar server.
3. **Ghost Locks:** Jika Node 1 terhenti (*GC Pause* panjang) dan TTL habis, Node 2 mengambil lock, memicu double execution.

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengatur Lock TTL Terlalu Singkat
Mengatur TTL kunci 1 detik untuk tugas yang makan waktu 10 detik.
```typescript
// SALAH: TTL terlalu pendek
const lock = await this.lockService.acquireLock('export_csv', 1000); 
await longRunningExportCsv(); // 10 detik
```
✅ **Solusi Benar:** Lock TTL harus `MAX_EXPECTED_DURATION + 10%`.

### ❌ Anti-Pattern 2: Merilis Lock Secara Agresif Pada Cron
Melepaskan lock segera di blok `finally` saat interval cron sangat pendek antar server yang memiliki *clock skew*.
```typescript
// SALAH: Merilis lock terlalu cepat saat cron trigger masih berlangsung di node lain
finally { await this.lockService.releaseLock(lock); }
```
✅ **Solusi Benar:** Biarkan kunci membusuk (expire by TTL) untuk perlindungan aman.

## Production Edge Cases
1. **Database Idempotency:** Bahkan dengan lock, sistem DB harus tetap didesain *idempotent* (menggunakan *upsert*, UUID unik).
2. **Redis Failover Delay:** Saat failover di Redis Sentinel, koneksi terputus. Pastikan *retryCount: 0* untuk membatalkan cron.
3. **Automatic Lock Extension Failure:** Jika Event Loop Node.js sangat tersumbat, script perpanjangan TTL otomatis tidak akan berjalan, sehingga Lock bocor.

## Unit Test Suite
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { DailyReportCronService } from './daily-report-cron.service';
import { DistributedLockService } from './distributed-lock.service';
import { ReportGeneratorService } from './report-generator.service';

describe('DailyReportCronService', () => {
  let cronService: DailyReportCronService;
  let lockService: jest.Mocked<DistributedLockService>;
  let reportService: jest.Mocked<ReportGeneratorService>;

  beforeEach(async () => {
    lockService = {
      acquireLock: jest.fn(),
      releaseLock: jest.fn(),
    } as unknown as jest.Mocked<DistributedLockService>;

    reportService = {
      generateAndDistributeReports: jest.fn(),
    } as unknown as jest.Mocked<ReportGeneratorService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DailyReportCronService,
        { provide: DistributedLockService, useValue: lockService },
        { provide: ReportGeneratorService, useValue: reportService },
      ],
    }).compile();

    cronService = module.get<DailyReportCronService>(DailyReportCronService);
  });

  it('should execute if lock is acquired', async () => {
    lockService.acquireLock.mockResolvedValue({ resource: 'lock', release: jest.fn() } as any);
    await cronService.handleDailyBillingReport();
    expect(lockService.acquireLock).toHaveBeenCalled();
    expect(reportService.generateAndDistributeReports).toHaveBeenCalledTimes(1);
  });

  it('should skip if lock is denied', async () => {
    lockService.acquireLock.mockResolvedValue(null);
    await cronService.handleDailyBillingReport();
    expect(reportService.generateAndDistributeReports).not.toHaveBeenCalled();
  });
});
```
