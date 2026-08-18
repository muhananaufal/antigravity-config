# Skrip Seeding Database Massal, Interaktif & Tahan Uji Memori

Operasional enterprise seringkali menuntut pembuatan skrip inisialisasi data (seeding) yang tidak sekadar menjalankan satu file SQL, melainkan membutuhkan keputusan dinamis, interaktif, dan mampu menginjeksi ratusan ribu data buatan secara transaksional (batching) tanpa kebocoran memori (memory leak). 

Kombinasi `nest-commander` dan modul prompt (seperti Inquirer.js) dalam ekosistem NestJS memungkinkan terciptanya skrip terminal yang sangat kuat, type-safe, dan hemat RAM.

## Diagram Interaksi Prompt & Batch Seeding

```text
+-------------------+      +-------------------+      +-------------------------+
| Terminal Operator |      | CLI Prompt Engine |      | Transactional Seed Node |
|  $ seed-database  | ---> |  (Inquirer.js)    | ---> | - 100k Records          |
+-------------------+      +-------------------+      | - Batch Insert (1000/q) |
                               |   ^                  | - GC & Memory Sweep     |
       [User Input: Y/N] <-----+   |                  +-------------------------+
       [Select Entity  ] ----------+                               |
                                                                   v
                                                      +-------------------------+
                                                      |   PostgreSQL / Prisma   |
                                                      +-------------------------+
```

## Implementasi Produksi

Berikut adalah contoh skrip seeding interaktif menggunakan `@InquirerService` untuk konfirmasi, dan pengelolaan data batching mutakhir yang melindungi Node.js dari _Out of Memory_ (OOM).

```typescript
import { Command, CommandRunner, InquirerService } from 'nest-commander';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface SeedingOptions {
  entity: string;
  count: number;
}

@Command({
  name: 'seed-mass',
  description: 'Skrip seeding massal yang interaktif dengan transaksi batching.',
})
@Injectable()
export class MassSeedingCommand extends CommandRunner {
  private readonly logger = new Logger(MassSeedingCommand.name);
  private readonly BATCH_SIZE = 5000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly inquirer: InquirerService,
  ) {
    super();
  }

  async run(passedParams: string[], options?: Record<string, unknown>): Promise<void> {
    this.logger.log('Memulai inisialisasi modul Seeding...');

    // 1. Interactive Prompts
    const answers = await this.inquirer.ask<{
      confirmTarget: boolean;
      totalRecords: number;
    }>('seeding-questions', undefined);

    if (!answers.confirmTarget) {
      this.logger.warn('Seeding dibatalkan oleh operator.');
      return;
    }

    const totalRecords = answers.totalRecords;
    this.logger.log(`Memulai injeksi transaksional ${totalRecords} baris data...`);

    // 2. Batch Execution with Memory Safety
    const startTime = performance.now();
    let processed = 0;

    try {
      while (processed < totalRecords) {
        const currentBatchSize = Math.min(this.BATCH_SIZE, totalRecords - processed);
        const dataBatch = this.generateFakeDataBatch(currentBatchSize, processed);

        // Transaksional Insert Massal
        await this.prisma.$transaction(async (tx) => {
          await tx.user.createMany({
            data: dataBatch,
            skipDuplicates: true,
          });
        });

        processed += currentBatchSize;
        this.logger.log(`Progress: ${processed} / ${totalRecords} records.`);

        // Pembersihan referensi manual agar Garbage Collector bisa bekerja optimal
        dataBatch.length = 0; 
      }

      const endTime = performance.now();
      this.logger.log(`Seeding Selesai! Waktu eksekusi: ${((endTime - startTime) / 1000).toFixed(2)} detik`);
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.logger.error(`Kesalahan Kritis saat Seeding: ${error.message}`, error.stack);
      }
      process.exit(1);
    }
  }

  private generateFakeDataBatch(batchSize: number, offset: number) {
    const batch: Array<{ email: string; name: string; isActive: boolean }> = [];
    for (let i = 0; i < batchSize; i++) {
      const currentIndex = offset + i;
      batch.push({
        email: `generated_user_${currentIndex}@corp.local`,
        name: `Automated User ${currentIndex}`,
        isActive: true,
      });
    }
    return batch;
  }
}
```

**Pertanyaan Prompt Interaktif:**
```typescript
import { QuestionSet, Question } from 'nest-commander';

@QuestionSet({ name: 'seeding-questions' })
export class SeedingQuestions {
  @Question({
    type: 'confirm',
    name: 'confirmTarget',
    message: 'Apakah Anda YAKIN ingin menimpa/menambah data ke database produksi?',
    default: false,
  })
  parseConfirm(val: boolean): boolean {
    return val;
  }

  @Question({
    type: 'number',
    name: 'totalRecords',
    message: 'Berapa jumlah baris (records) yang ingin disuntikkan?',
    default: 10000,
  })
  parseTotal(val: number): number {
    return val;
  }
}
```

## Unit Testing / CLI Mock Test Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { CommandTestFactory } from 'nest-commander-testing';
import { MassSeedingCommand } from './mass-seeding.command';
import { SeedingQuestions } from './seeding-questions';
import { PrismaService } from '../prisma/prisma.service';
import { InquirerService } from 'nest-commander';

describe('MassSeedingCommand', () => {
  let command: MassSeedingCommand;
  let inquirerMock: Record<keyof InquirerService, jest.Mock>;
  let prismaMock: Record<keyof PrismaService, jest.Mock>;

  beforeEach(async () => {
    inquirerMock = {
      ask: jest.fn(),
    } as unknown as Record<keyof InquirerService, jest.Mock>;

    prismaMock = {
      $transaction: jest.fn().mockImplementation(async (cb) => {
        return cb({ user: { createMany: jest.fn().mockResolvedValue({ count: 100 }) } });
      }),
    } as unknown as Record<keyof PrismaService, jest.Mock>;

    const module: TestingModule = await CommandTestFactory.createTestingCommand({
      imports: [],
      providers: [
        MassSeedingCommand,
        SeedingQuestions,
        { provide: InquirerService, useValue: inquirerMock },
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    command = module.get<MassSeedingCommand>(MassSeedingCommand);
  });

  it('should abort if operator selects NO', async () => {
    inquirerMock.ask.mockResolvedValue({ confirmTarget: false });
    
    await CommandTestFactory.run(command, []);
    
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('should process batches if operator selects YES', async () => {
    inquirerMock.ask.mockResolvedValue({ confirmTarget: true, totalRecords: 6000 });
    
    await CommandTestFactory.run(command, []);
    
    // Total 6000, Batch Size 5000 -> Harus dipanggil 2 kali
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
  });
});
```

## Analisis Trade-Off

**Kelebihan:**
1. **Keamanan Konfirmasi:** Prompt interaktif memaksa developer untuk sadar akan target database, mencegah ketidaksengajaan _wiping_ database produksi.
2. **Efisiensi Memori (Batching):** Eksekusi batch memastikan V8 JavaScript Engine Node.js tidak menelan ribuan megabyte RAM, menjaga heap usage stabil meskipun data mencapai puluhan juta.
3. **Integritas Transaksional:** Menggunakan `$transaction`, kegagalan pada baris ke-9000 tidak akan menyebabkan _partially seeded data_, seluruh batch akan digulung balik (rollback).

**Kekurangan:**
1. **Tidak Sepenuhnya Otomatis di CI/CD:** Prompt interaktif menyulitkan otomasi murni (harus menggunakan parameter bypass prompt `--yes` jika dieksekusi oleh pipeline).
2. **Lambat dibanding Raw SQL Dump:** Melakukan seeding dari Node.js melalui ORM jauh lebih lambat daripada melakukan `psql -f seed.sql`.
3. **Kompleksitas Kode:** Harus mengelola _state_ iterasi dan _garbage collection_ secara manual di aplikasi.

## Anti-Patterns

❌ **Anti-Pattern 1: Mengambil/Menyimpan Semua Data Dalam Satu Array Besar (OOM Error)**
```typescript
// SALAH: Menciptakan 1.000.000 objek di RAM secara bersamaan
const allData = [];
for (let i=0; i<1000000; i++) { allData.push({ ... }); }
await this.prisma.user.createMany({ data: allData }); 
// Node.js FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory
```

✅ **Best Practice 1: Memori Reusable dengan Chunking / Batching**
```typescript
// BENAR: Menggunakan chunking kecil per 5000 records
for (let i=0; i<1000000; i+=5000) {
   const chunk = generate(5000);
   await this.prisma.user.createMany({ data: chunk });
   chunk.length = 0; // Beri sinyal ke GC
}
```

❌ **Anti-Pattern 2: Promise.all untuk 10.000 koneksi serentak**
```typescript
// SALAH: Membanjiri koneksi database yang berujung Connection Timeout
const promises = items.map(item => this.prisma.user.create({ data: item }));
await Promise.all(promises); 
```

✅ **Best Practice 2: Eksekusi berurutan (Sequential Batching) atau Batch Create**
```typescript
// BENAR: Insert multi-row dalam satu koneksi query
await this.prisma.user.createMany({ data: items });
```

## Production Edge Cases

1. **Non-Interactive CI/CD Pipelines:** Skrip interaktif akan hang/stuck selamanya di CI/CD karena menunggu input TTY. Skrip wajib mendukung argumen bypass (contoh `--force` atau mendeteksi `process.env.CI`) untuk menonaktifkan prompt.
2. **Deadlock Database selama Transaksi Panjang:** Menulis (Write/Lock) puluhan ribu baris data pada tabel yang aktif diakses publik dapat menyebabkan table-locking, memblokir API operasional. Seeding massal wajib dilakukan pada tabel _offline_ atau dengan batch sangat kecil diselingi delay (`setTimeout`).
3. **Auto-Increment Primary Key Tearing:** Jika seeding gagal di tengah jalan (bukan rollback), _sequence_ ID di database PostgreSQL bisa melompat (gaps), mengakibatkan pembengkakan urutan indeks yang membingungkan.
