# Implementasi Pola Transactional Outbox pada gRPC & Postgres

## Pendahuluan

Dalam perancangan sistem terdistribusi berbasis *Microservices*, menjaga konsistensi ganda (*Dual-Write Problem*) adalah permasalahan purba yang brutal. Menulis data ke sebuah basis data relasional (misal Postgres) lalu seketika mempublikasikan pesan (ke Kafka/RabbitMQ) atau memanggil RPC layanan lain (gRPC) merupakan petaka — bagaimana jika RPC/Koneksi gagal setelah basis data berhasil di-*commit*? Data tersebut menjadi tidak sinkron (*inconsistent*).

Pola **Transactional Outbox** mengeleminasi risiko ini dengan menyandera pesan (payload RPC) ke dalam tabel `outbox` lokal menggunakan satu transaksi atomik relasional (ACID). Sebuah proses mandiri di latar belakang (*Worker/Relay*) akan memanen pesan-pesan tertunda ini secara terus menerus, melemparnya melewati gRPC menuju layanan sasaran, memastikan jaminan *Exactly-Once* (atau *At-Least-Once*) Delivery.

## Diagram Arsitektur Transactional Outbox

```ascii
+-----------------------+                    +------------------------------------+
|  NestJS Core Service  |                    |      PostgreSQL Database           |
|                       |  (1) Begin Tx      |                                    |
| [ Order Controller ]  | -----------------> | +------------------+               |
|                       |                    | |   ORDERS Table   | (2) Insert    |
|   Insert Order &      |                    | +------------------+               |
|   Insert Outbox in    |                    |                                    |
|   Same Transaction    |                    | +------------------+               |
|                       |  (4) Commit Tx     | |   OUTBOX Table   | (3) Insert    |
+-----------------------+ -----------------> | +------------------+               |
           ^                                 +------------------------------------+
           |                                                 |
           |                                                 | (5) Polling by Cron / Worker
           |                                                 v
+-----------------------+   (6) Send via gRPC  +------------------------------------+
|  NestJS Outbox Relay  | -------------------> | Target Service (Billing / Loyalty) |
|  [ Cron Scheduler ]   |   (7) Mark Done      |                                    |
+-----------------------+ <------------------- +------------------------------------+
```

## Implementasi Kode Produksi: Outbox dengan Prisma, Postgres & NestJS

Dalam simulasi ini kita menggunakan `Prisma Client` (sebagai ORM standar modern TypeScript) dan gRPC Client terintegrasi di NestJS.

### 1. Definisi Skema Prisma (`schema.prisma`)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Order {
  id        String   @id @default(uuid())
  amount    Int
  status    String
  createdAt DateTime @default(now())
}

model Outbox {
  id           String   @id @default(uuid())
  aggregateType String  // Contoh: "Order"
  aggregateId  String
  eventType    String   // Contoh: "OrderCreated"
  payload      Json     // Data JSON payload Protobuf
  isProcessed  Boolean  @default(false)
  createdAt    DateTime @default(now())
}
```

### 2. Implementasi Service Pemicu (Dual-Write Atomic)

```typescript
import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

export interface CreateOrderDto {
  amount: number;
}

@Injectable()
export class OrderService {
  private readonly prisma = new PrismaClient();
  private readonly logger = new Logger(OrderService.name);

  public async createOrder(dto: CreateOrderDto): Promise<string> {
    try {
      // 1. Eksekusi dalam Transaksi Atomik
      const result = await this.prisma.$transaction(async (tx) => {
        // 2. Simpan Data Bisnis Utama
        const order = await tx.order.create({
          data: {
            amount: dto.amount,
            status: 'PENDING',
          },
        });

        // 3. Tulis Payload Notifikasi/gRPC ke dalam Outbox di Transaksi yg sama!
        const outbox = await tx.outbox.create({
          data: {
            aggregateType: 'Order',
            aggregateId: order.id,
            eventType: 'OrderCreated',
            payload: { orderId: order.id, amount: order.amount },
            isProcessed: false,
          },
        });

        return order.id;
      });

      this.logger.log(`Pesanan ${result} dan Outbox Event berhasil dibuat atomik.`);
      return result;
    } catch (error: unknown) {
      this.logger.error('Gagal memproses pembuatan pesanan', error);
      throw new InternalServerErrorException('Gagal membuat pesanan transaksi.');
    }
  }
}
```

### 3. Relay Worker Polling (Memanen dan Mengirim gRPC)

```typescript
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';
import { ClientGrpc, Client } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { transportOptions } from './grpc.config'; // Asumsi config gRPC statis 

interface BillingServiceClient {
  processBillingEvent(data: { orderId: string; amount: number }): import('rxjs').Observable<any>;
}

@Injectable()
export class OutboxRelayWorker implements OnModuleInit {
  private readonly prisma = new PrismaClient();
  private readonly logger = new Logger(OutboxRelayWorker.name);
  
  @Client(transportOptions)
  private readonly client: ClientGrpc;
  private billingService: BillingServiceClient;

  onModuleInit() {
    // Memuat Service Protobuf klien
    this.billingService = this.client.getService<BillingServiceClient>('BillingService');
  }

  // Polling setiap 5 detik. Untuk skala produksi besar pertimbangkan alat seperti Debezium.
  @Cron(CronExpression.EVERY_5_SECONDS)
  public async processPendingOutboxEvents() {
    this.logger.debug('Memindai Outbox Events yang tertunda...');

    const pendingEvents = await this.prisma.outbox.findMany({
      where: { isProcessed: false },
      orderBy: { createdAt: 'asc' },
      take: 50, // Batch limit
    });

    if (pendingEvents.length === 0) return;

    for (const event of pendingEvents) {
      try {
        if (event.eventType === 'OrderCreated') {
          // Ekstrak Payload Json ke Tipe Klien gRPC
          const payload = event.payload as { orderId: string; amount: number };
          
          // Kirim pesan melewati RPC
          await firstValueFrom(this.billingService.processBillingEvent(payload));
          
          // Tandai Sukses Processed dalam DB
          await this.prisma.outbox.update({
            where: { id: event.id },
            data: { isProcessed: true },
          });

          this.logger.log(`Outbox ID ${event.id} berhasil diproses.`);
        }
      } catch (error: unknown) {
        // Pada kegagalan RPC, kita tidak meng-update isProcessed=true.
        // Relay ini akan diulangi lagi (Retry) pada siklus Cron berikutnya.
        this.logger.error(`Gagal mengirim gRPC untuk Outbox ID ${event.id}. Menunggu Retry...`, error);
      }
    }
  }
}
```

## Unit Test Transaksi Mock

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { OrderService, CreateOrderDto } from './order.service';

// Mock Prisma Client
jest.mock('@prisma/client', () => {
  const mPrismaClient = {
    $transaction: jest.fn(),
  };
  return { PrismaClient: jest.fn(() => mPrismaClient) };
});

describe('OrderService Transactional Outbox', () => {
  let service: OrderService;
  let prismaMock: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OrderService],
    }).compile();

    service = module.get<OrderService>(OrderService);
    // Cast ulang hack untuk mock verification
    prismaMock = (service as any).prisma;
  });

  it('harus membuat Pesanan dan Rekaman Outbox secara atomik (Sukses)', async () => {
    // Setup Mock
    const dto: CreateOrderDto = { amount: 50000 };
    prismaMock.$transaction.mockImplementation(async (callback: any) => {
      // Pass a dummy transaction object 'tx' mock
      const txMock = {
        order: { create: jest.fn().mockResolvedValue({ id: 'ORDER-123', amount: 50000 }) },
        outbox: { create: jest.fn().mockResolvedValue({ id: 'OUTBOX-999' }) },
      };
      return await callback(txMock);
    });

    const result = await service.createOrder(dto);
    
    expect(result).toEqual('ORDER-123');
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it('harus menggagalkan pembuatan pesanan bila transaksi rollback (InternalServerError)', async () => {
    const dto: CreateOrderDto = { amount: 50000 };
    prismaMock.$transaction.mockRejectedValue(new Error('Simulasi DB Crash'));

    await expect(service.createOrder(dto)).rejects.toThrow('Gagal membuat pesanan transaksi');
  });
});
```

## Analisis Trade-Off

### Kelebihan
1. **Jaminan Anti-Hilang 100% (Eventual Consistency):** Memisahkan logika tulis database dengan operasi jala (network) yang riskan. Server gRPC tujuan bisa terputus/padam total selama 3 jam, pesan tidak akan hilang dan akan di-*retried* terus-menerus.
2. **Penyeimbangan Beban Asinkron (Decoupled Performance):** Klien frontend mendapatkan respon instan setelah komit DB tanpa perlu menunggu gRPC latensi (yang bisa saja memakan ratusan milidetik antar wilayah aws).
3. **Audit Trail Mutlak:** Tabel `outbox` itu sendiri secara alamiah menjadi Log Peristiwa (Event Sourcing lite) yang sangat berguna untuk forensik / debugging jejak interaksi mikroservis.

### Kekurangan
1. **At-Least-Once Delivery & Idempotensi (Bahaya Kritis):** Pola Relay Poller dapat menyebabkan pesan gRPC terkirim dua kali (*Duplicate Send*) jika RPC sukses, tetapi koneksi ke basis data terputus tepat saat proses "update isProcessed = true". **Servis target WAJIB mengimplementasikan Idempotensi**.
2. **Latensi Penundaan (*Delay*):** Jika menggunakan Cron Job (misal: tiap 5 detik), waktu pengiriman pesan paling minimal tertunda sebesar latensi polling tersebut. Data tidak *Real-Time*.
3. **Penyusutan Kinerja Basis Data (DB Polling Overhead):** Mengeksekusi Query `SELECT ... WHERE isProcessed = false` setiap beberapa detik membebani kinerja DB. Tabel outbox akan meledak ukurannya dan butuh mekanisme partisi atau *Purging Archival*.

## Anti-Patterns

### 1. Dual-Write Palsu Tanpa Transaksi ❌
Memanggil operasi penyimpanan dan RPC/Publisher ke MQ tanpa ikatan transaksi *Database*.
```typescript
// SALAH ❌ (Berisiko Dual-Write Partial Failure)
public async createOrder() {
  await this.orderRepo.save(orderData); // Berhasil
  // BAGAIMANA JIKA LISTRIK MATI DISINI?
  await this.grpcClient.send(eventData); // Gagal / Tak Terkirim! State tidak sinkron.
}
```

```typescript
// BENAR ✅ (Gunakan Outbox dengan $transaction)
public async createOrder() {
  await this.prisma.$transaction([ ... ]); // Keduanya masuk atau keduanya dibatalkan.
}
```

### 2. Memutarbalikkan Order Transaksi Outbox dengan RPC ❌
Mencoba memanggil gRPC/Network Call **DI DALAM** blok Transaksi Database! Ini akan mengunci baris row (Lock) terlalu lama menunggu latensi network.
```typescript
// SALAH ❌ (Database Connection Lock Exhaustion)
await db.transaction(async (tx) => {
   await tx.save(data);
   // MENUNGGU JARINGAN SELAMA 2 DETIK MENGUNCI TRANSACTION POOL DB!
   await grpc.call(); 
});
```

## Production Edge Cases

1. **Efek Thundering Herd pada Polling Berskala Penuh:** Ketika Anda mendeploy 10 Pod K8s Relay Worker, ke-10 Pod ini akan mengeksekusi Cron secara paralel membaca row (baris) Outbox yang sama dan mengirim gRPC duplikat kejut. Solusi: Gunakan kunci (lock) berbasis baris di Postgres `SELECT ... FOR UPDATE SKIP LOCKED` sehingga setiap worker hanya mencaplok (*grab*) event eksklusif tanpa tumpang tindih.
2. **Tabel Outbox Membesar Eksponensial:** Tabel `Outbox` dengan status `isProcessed = true` menumpuk bermiliar-miliar baris dan mengotori indeks B-Tree. Solusi: Implementasikan Job sapu-bersih mingguan, pindahkan data usang ke *Cold Storage/S3*, dan vakum tabel (PG VACUUM).
3. **Peningkatan Menuju Change Data Capture (CDC):** Cron job untuk polling terbatas pada toleransi CPU. Bila pesan mencapai +5000 QPS, metode polling mati. Solusi: Gantikan Cron Worker NestJS dengan alat *Change Data Capture* tingkat rendah seperti Debezium dan Kafka Connect yang menyadap langsung WAL (Write-Ahead Log) dari level Binari Postgres (Replication Slots).
