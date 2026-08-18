# Orkestrasi Background Daemon Worker dengan NestJS CLI

Menjalankan proses background yang persisten (daemon) dalam ekosistem NestJS tidak selalu harus di dalam server HTTP utama. Praktik arsitektur modern sering memisahkan beban komputasi berat (seperti _scraping_, _message queue consumer_, atau _indexing_) ke dalam _worker process_ tersendiri.

Skrip NestJS CLI dapat diorkestrasi menjadi background worker yang hidup abadi dengan memanfaatkan kontrol loop, integrasi dengan _Process Manager_ (PM2 atau Systemd), serta penegakan pembatasan memori otomatis.

## Arsitektur Daemon Process

```text
+-----------------------------------------------------------+
|                   Systemd / PM2 (Supervisor)              |
|  - Restart on crash      - Memory limit (e.g. 512MB)      |
+-----------------------------+-----------------------------+
                              | SIGTERM / SIGKILL
                              v
+-----------------------------------------------------------+
|                 NestJS CLI Daemon Process                 |
|  +-----------------------------------------------------+  |
|  |                Infinite While Loop                  |  |
|  |  [Fetch Tasks] -> [Process Task] -> [Wait/Sleep]    |  |
|  +-----------------------------------------------------+  |
|  - Graceful Shutdown Trap (Catch SIGTERM)                 |
|  - Memory Health Check                                    |
+-----------------------------------------------------------+
```

## Implementasi Produksi

Berikut adalah contoh skrip daemon untuk mengkonsumsi antrean (queue) yang dirancang untuk berlari abadi 24/7 dan bisa mematikan dirinya sendiri (self-heal) jika memori bocor.

```typescript
import { Command, CommandRunner } from 'nest-commander';
import { Injectable, Logger } from '@nestjs/common';
import { TaskQueueService } from '../queue/task-queue.service';

@Command({
  name: 'daemon:worker',
  description: 'Menjalankan background worker abadi untuk memproses antrean tugas.',
})
@Injectable()
export class DaemonWorkerCommand extends CommandRunner {
  private readonly logger = new Logger(DaemonWorkerCommand.name);
  private isShuttingDown = false;
  private readonly MAX_MEMORY_MB = 400; // Restart process if > 400MB

  constructor(private readonly taskQueue: TaskQueueService) {
    super();
    this.registerGracefulShutdown();
  }

  async run(passedParams: string[], options?: Record<string, unknown>): Promise<void> {
    this.logger.log('Memulai Daemon Worker. Menunggu tugas...');

    while (!this.isShuttingDown) {
      try {
        const task = await this.taskQueue.fetchNextTask();

        if (!task) {
          // Idle sleep untuk mencegah CPU 100% spin
          await this.sleep(3000);
          continue;
        }

        this.logger.log(`Memproses tugas ID: ${task.id}`);
        await this.taskQueue.processTask(task);
        this.logger.log(`Tugas ID: ${task.id} selesai.`);

        // Self-Healing Memory Check
        this.checkMemoryUsage();

      } catch (error: unknown) {
        if (error instanceof Error) {
          this.logger.error(`Error pada siklus daemon: ${error.message}`, error.stack);
        }
        // Tidur sejenak jika terjadi koneksi putus (hindari spam error log)
        await this.sleep(5000); 
      }
    }

    this.logger.log('Daemon Worker berhenti secara aman.');
    process.exit(0);
  }

  private checkMemoryUsage() {
    const memoryUsage = process.memoryUsage();
    const usedMB = Math.round(memoryUsage.rss / 1024 / 1024);

    if (usedMB > this.MAX_MEMORY_MB) {
      this.logger.warn(`Peringatan: Memori mencapai ${usedMB}MB (Batas: ${this.MAX_MEMORY_MB}MB). Memulai bunuh diri (restart by PM2/Systemd)...`);
      process.exit(1); 
    }
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private registerGracefulShutdown() {
    process.on('SIGTERM', () => {
      this.logger.warn('Menerima sinyal SIGTERM. Bersiap menghentikan loop Daemon...');
      this.isShuttingDown = true;
    });

    process.on('SIGINT', () => {
      this.logger.warn('Menerima sinyal SIGINT (Ctrl+C). Bersiap menghentikan loop Daemon...');
      this.isShuttingDown = true;
    });
  }
}
```

## Unit Testing / CLI Mock Test Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { CommandTestFactory } from 'nest-commander-testing';
import { DaemonWorkerCommand } from './daemon-worker.command';
import { TaskQueueService } from '../queue/task-queue.service';

describe('DaemonWorkerCommand', () => {
  let command: DaemonWorkerCommand;
  let queueMock: Record<keyof TaskQueueService, jest.Mock>;

  beforeEach(async () => {
    queueMock = {
      fetchNextTask: jest.fn(),
      processTask: jest.fn(),
    } as unknown as Record<keyof TaskQueueService, jest.Mock>;

    const module: TestingModule = await CommandTestFactory.createTestingCommand({
      imports: [],
      providers: [
        DaemonWorkerCommand,
        { provide: TaskQueueService, useValue: queueMock },
      ],
    }).compile();

    command = module.get<DaemonWorkerCommand>(DaemonWorkerCommand);
  });

  it('should sleep when no task is found', async () => {
    // Simulasi tidak ada task
    queueMock.fetchNextTask.mockResolvedValue(null);
    
    // Gunakan trik untuk keluar dari infinite loop segera setelah 1 iterasi
    const originalSleep = (command as any).sleep;
    jest.spyOn(command as any, 'sleep').mockImplementation(async () => {
      (command as any).isShuttingDown = true; // Hentikan loop
    });

    const runPromise = command.run([]);
    
    await runPromise;
    expect(queueMock.fetchNextTask).toHaveBeenCalledTimes(1);
    expect(queueMock.processTask).not.toHaveBeenCalled();
    
    (command as any).sleep.mockRestore();
  });
});
```

## Analisis Trade-Off

**Kelebihan:**
1. **Skalabilitas Vertikal yang Aman:** Memisahkan worker process dari web server menjamin CPU spike akibat _background job_ tidak membuat server HTTP menjadi latensi tinggi (lag).
2. **Self-Healing dari Memory Leak:** Karena NodeJS bersifat _garbage-collected_, kebocoran referensi kecil bisa menumpuk. Mekanisme mati mandiri (suicide/exit) yang dimonitor PM2 menjamin lingkungan yang bersih terlahir kembali.
3. **Graceful Shutdown:** Memungkinkan pemrosesan antrean terselesaikan dengan tuntas (tidak diputus tiba-tiba) saat rilis aplikasi atau _server rolling restart_.

**Kekurangan:**
1. **Kompleksitas Infrastruktur:** Harus mengkonfigurasi file eksternal seperti `ecosystem.config.js` (PM2) atau `.service` unit (Systemd).
2. **Kehilangan Context Otomatis:** Berbeda dengan BullMQ di dalam web server yang berbagi pool instan, proses terpisah wajib menginisialisasi DB pool-nya sendiri.
3. **Risiko Split-Brain:** Jika orkestrator keliru, bisa muncul dua _Daemon_ berjalan bersamaan (duplikasi) yang memicu _race condition_ pada penarikan data dari database biasa (non-locking).

## Anti-Patterns

❌ **Anti-Pattern 1: Loop Kosong Tanpa Sleep**
```typescript
// SALAH: CPU akan memuncak ke 100% (Busy Waiting) karena Node event loop berputar tanpa delay
while (!this.isShuttingDown) {
  const task = await this.queue.pop();
  if (!task) continue; 
  await this.process(task);
}
```

✅ **Best Practice 1: Memberikan Napas dengan Idle Sleep**
```typescript
// BENAR: Memberi jeda (delay) pada event loop jika sedang kosong
while (!this.isShuttingDown) {
  const task = await this.queue.pop();
  if (!task) { await this.sleep(3000); continue; }
  await this.process(task);
}
```

❌ **Anti-Pattern 2: Membiarkan Proses Mati Mendadak (Dangling State)**
```typescript
// SALAH: Saat menerima SIGTERM (dari Kubernetes / PM2), transaksi di tengah jalan terpotong paksa
process.on('SIGTERM', () => process.exit(0)); 
```

✅ **Best Practice 2: Penanda Bendera (Flag) Shutdown**
```typescript
// BENAR: Menggunakan state isShuttingDown sehingga loop diselesaikan terlebih dahulu dengan tenang
process.on('SIGTERM', () => { this.isShuttingDown = true; }); 
```

## Production Edge Cases

1. **Deadlock Polling di Database Biasa:** Daemon yang mengandalkan polling SQL `SELECT * FROM tasks WHERE status = 'PENDING'` bisa berbenturan jika dijalankan dalam _High Availability_ (Multiple Daemons). Wajib menggunakan mekanisme row-locking (`SELECT ... FOR UPDATE SKIP LOCKED` di Postgres).
2. **Zombie Process pada Docker:** Menjalankan daemon di container tanpa init process manager yang memadai (PID 1 problem) bisa membuat daemon menolak menerima sinyal `SIGTERM`, sehingga Orchestrator (K8s) akhirnya membunuh kasar via `SIGKILL` (transaksi gagal).
3. **Fluktuasi Jaringan / Koneksi Tiba-tiba Putus:** Loop abadi harus sangat kebal (resilient). Jika koneksi database terputus (Prisma melempar error koneksi), jangan biarkan error mematikan aplikasi langsung. Tangkap error, _log_, tunggu 5 detik, dan coba lagi di iterasi berikutnya.
