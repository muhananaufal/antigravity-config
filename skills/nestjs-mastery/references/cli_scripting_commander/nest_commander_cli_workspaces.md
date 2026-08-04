# Eksekusi Skrip CLI Canggih dengan Nest-Commander di Lingkungan NestJS

Pengembangan aplikasi berskala enterprise seringkali membutuhkan utilitas CLI (Command Line Interface) yang dapat berjalan pada ruang lingkup (context) aplikasi backend yang sama. `nest-commander` adalah solusi mutakhir yang mengizinkan eksekusi skrip CLI yang memiliki akses penuh terhadap container Dependency Injection (DI) NestJS, termasuk akses ke Services, Repositories, Logger, dan Config tanpa perlu menjalankan server HTTP (tanpa ekspos port).

## Arsitektur Nest-Commander Workspace

```text
+-------------------------------------------------------------+
|                     Terminal / Shell                        |
|   $ node dist/cli.js process-data --batch-size 5000         |
+------------------------------+------------------------------+
                               |
                               v
+------------------------------+------------------------------+
|                   CommandFactory.run()                      |
|  (Inisialisasi NestJS Application Context - Tanpa HTTP)     |
+------------------------------+------------------------------+
                               |
                               v
+------------------------------+------------------------------+
|                  CommandRunner (@Command)                   |
| - Parse Arguments (@Option, @Positional)                    |
| - Injeksi Dependency (DI) otomatis                          |
+-------------------------------------------------------------+
                               |
           +-------------------+-------------------+
           |                   |                   |
           v                   v                   v
  +-----------------+ +-----------------+ +-----------------+
  |  UserService    | |  PrismaService  | |  RedisService   |
  +-----------------+ +-----------------+ +-----------------+
```

## Implementasi Produksi

Berikut adalah contoh implementasi CLI mutakhir menggunakan `nest-commander` dengan penanganan error, validasi opsi, dan dependency injection penuh.

```typescript
import { Command, CommandRunner, Option } from 'nest-commander';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

interface CommandOptions {
  batchSize: number;
  dryRun: boolean;
}

@Command({
  name: 'process-inactive-users',
  description: 'Memproses dan menonaktifkan pengguna yang tidak aktif dalam batch.',
})
@Injectable()
export class ProcessInactiveUsersCommand extends CommandRunner {
  private readonly logger = new Logger(ProcessInactiveUsersCommand.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async run(passedParams: string[], options?: CommandOptions): Promise<void> {
    const batchSize = options?.batchSize ?? 100;
    const isDryRun = options?.dryRun ?? false;

    this.logger.log(`Memulai proses dengan batch size: ${batchSize} | Dry Run: ${isDryRun}`);

    try {
      const thresholdDate = new Date();
      thresholdDate.setMonth(thresholdDate.getMonth() - 6);

      const usersToProcess = await this.prisma.user.findMany({
        where: {
          lastLoginAt: { lt: thresholdDate },
          isActive: true,
        },
        take: batchSize,
        select: { id: true, email: true },
      });

      if (usersToProcess.length === 0) {
        this.logger.log('Tidak ada pengguna yang perlu diproses.');
        return;
      }

      if (isDryRun) {
        this.logger.warn(`DRY RUN: Akan menonaktifkan ${usersToProcess.length} pengguna.`);
        usersToProcess.forEach(u => this.logger.debug(`Target: ${u.email}`));
        return;
      }

      const result = await this.prisma.user.updateMany({
        where: {
          id: { in: usersToProcess.map(u => u.id) },
        },
        data: { isActive: false },
      });

      this.logger.log(`Berhasil menonaktifkan ${result.count} pengguna.`);
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.logger.error(`Kesalahan eksekusi command: ${error.message}`, error.stack);
      }
      process.exit(1);
    }
  }

  @Option({
    flags: '-b, --batch-size [number]',
    description: 'Jumlah pengguna per batch',
  })
  parseBatchSize(val: string): number {
    const parsed = parseInt(val, 10);
    if (isNaN(parsed) || parsed <= 0) {
      throw new Error('Batch size harus berupa angka positif.');
    }
    return parsed;
  }

  @Option({
    flags: '-d, --dry-run',
    description: 'Jalankan tanpa melakukan modifikasi data (simulasi)',
  })
  parseDryRun(): boolean {
    return true;
  }
}
```

File `cli.ts` (Entry Point):
```typescript
import { CommandFactory } from 'nest-commander';
import { AppModule } from './app.module';

async function bootstrap() {
  await CommandFactory.run(AppModule, ['warn', 'error', 'log']);
}

bootstrap().catch((err: unknown) => {
  if (err instanceof Error) {
    console.error('Fatal CLI Error:', err.message);
  }
  process.exit(1);
});
```

## Unit Testing / CLI Mock Test Suite

Menguji `nest-commander` sangat mudah menggunakan `CommandTestFactory`.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { CommandTestFactory } from 'nest-commander-testing';
import { ProcessInactiveUsersCommand } from './process-inactive-users.command';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

describe('ProcessInactiveUsersCommand', () => {
  let command: ProcessInactiveUsersCommand;
  let prismaMock: Record<keyof PrismaService, jest.Mock>;

  beforeEach(async () => {
    prismaMock = {
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      } as unknown,
    } as unknown as Record<keyof PrismaService, jest.Mock>;

    const module: TestingModule = await CommandTestFactory.createTestingCommand({
      imports: [],
      providers: [
        ProcessInactiveUsersCommand,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    command = module.get<ProcessInactiveUsersCommand>(ProcessInactiveUsersCommand);
  });

  it('should run successfully in dry-run mode without updating DB', async () => {
    prismaMock.user.findMany.mockResolvedValue([{ id: '1', email: 'test@test.com' }]);
    
    await CommandTestFactory.run(command, ['-d']);
    
    expect(prismaMock.user.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.user.updateMany).not.toHaveBeenCalled();
  });
});
```

## Analisis Trade-Off

**Kelebihan:**
1. **Reusability Kode:** Memungkinkan skrip CLI menggunakan ulang logic bisnis, services, dan modul yang sudah ada di aplikasi tanpa duplikasi.
2. **Eksekusi Aman:** Berjalan murni di backend (tanpa ekspos port HTTP), tidak bisa dipicu oleh payload jaringan eksternal.
3. **Ekosistem NestJS:** Mendukung penuh lifecycle hooks, modul dinamis, dan sistem logging bawaan NestJS.

**Kekurangan:**
1. **Startup Overhead:** Harus me-load seluruh container dependency injection NestJS, yang bisa memakan waktu hingga hitungan detik hanya untuk tugas CLI sederhana.
2. **Penggunaan Memori:** Sama dengan menjalankan server aplikasi (karena memuat semua modul), tidak cocok untuk lingkungan dengan sumber daya sangat terbatas (misal serverless dingin).
3. **Kompleksitas Packaging:** Membutuhkan entry point tersendiri (`cli.ts`) terpisah dari `main.ts`, membuat build process sedikit lebih kompleks.

## Anti-Patterns

❌ **Anti-Pattern 1: Menyambungkan CLI langsung ke Express/Fastify App**
```typescript
// SALAH: Memuat HTTP server padahal hanya butuh background task
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000); 
  const command = app.get(MyCommand);
  await command.run();
  process.exit(0);
}
```

✅ **Best Practice 1: Menggunakan CommandFactory**
```typescript
// BENAR: Menggunakan nest-commander murni tanpa HTTP
import { CommandFactory } from 'nest-commander';
async function bootstrap() {
  await CommandFactory.run(AppModule, ['warn', 'error']);
}
```

❌ **Anti-Pattern 2: Tidak mematikan proses saat error fatal terjadi**
```typescript
// SALAH: Aplikasi hang atau memory leak akibat event loop tidak tertutup
async run() {
  try { await this.doWork(); } 
  catch (e) { console.error('Gagal'); /* Dibiarkan begitu saja */ }
}
```

✅ **Best Practice 2: Handle error dan exit code**
```typescript
// BENAR: Keluar dengan status fail untuk CI/CD pipeline
async run() {
  try { await this.doWork(); } 
  catch (e) { 
    this.logger.error('Gagal memproses data');
    process.exit(1);
  }
}
```

## Production Edge Cases

1. **Graceful Shutdown saat dihentikan (SIGINT/SIGTERM):** Saat CLI berjalan lama (cron), dan sistem mengirimkan sinyal kill, pastikan ada penanganan event `process.on('SIGINT')` untuk menghentikan transaksi database dengan aman, mencegah state data setengah matang.
2. **Koneksi Database Timeout:** Skrip CLI yang mengambil data puluhan ribu row berisiko terkena _statement timeout_. Pastikan pembagian eksekusi melalui parameter `--batch-size` dan eksekusi repetitif dengan cursor pagination.
3. **Limitasi Koneksi Pool:** Karena skrip CLI memuat `AppModule`, ia akan membuat connection pool penuh. Jika skrip berjalan sangat sering dan singkat, pool yang terus dibuka-tutup bisa menghabiskan socket DB. Gunakan konfigurasi koneksi terpisah (lebih sedikit maks pool) jika dieksekusi via cron secara persisten.
