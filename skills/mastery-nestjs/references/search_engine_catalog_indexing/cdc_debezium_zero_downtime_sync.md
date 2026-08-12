---
title: "CDC Debezium Zero-Downtime Sync"
description: "Sinkronisasi database Postgres ke mesin pencarian (Meilisearch/Elastic) secara real-time dan bebas latensi CPU menggunakan arsitektur Change Data Capture (CDC) dengan Debezium, Apache Kafka, dan NestJS."
tags: [nestjs, cdc, debezium, kafka, postgresql, system-architecture]
---

# CDC Debezium Zero-Downtime Sync: Sinkronisasi Data Real-Time (Postgres to Search Engine)

Metode tradisional sinkronisasi database ke Search Engine menggunakan pola "Dual Write" di level aplikasi (simpan ke DB, lalu API call ke Elastic) sangat rentan terhadap *partial failures* (transaksi DB berhasil tapi koneksi ke Elastic gagal), dan polling periodik (cron job SELECT WHERE updated_at > ?) membebani CPU database secara eksponensial seiring besarnya tabel (N+1 query impact). 

Arsitektur **Change Data Capture (CDC)** memecahkan masalah ini dengan membaca *Transaction Log (WAL - Write Ahead Log)* langsung dari database menggunakan Debezium, dan mendorong event perubahan tersebut ke Kafka.

## 1. Arsitektur CDC Debezium & Kafka

```ascii
+--------------------+        +---------------------+       +-----------------------+
| PostgreSQL DB      |        | Debezium Connector  |       | Apache Kafka          |
|--------------------|        |---------------------|       |-----------------------|
| - Write Ahead Log  | -----> | - Reads WAL Streams | ----> | Topic: `db.products`  |
|   (Logical Rep)    | (Push) | - Format to JSON    | (Pub) | (Partitioned by PK)   |
+--------------------+        +---------------------+       +-----------------------+
                                                                     |
                                                                     | (Subscribes)
                                                                     v
                                                          +-----------------------+
                                                          | NestJS Kafka Consumer |
                                                          |-----------------------|
                                                          | - Read Event (C/U/D)  |
                                                          | - Transform Schema    |
                                                          | - Batch Sync to ES    |
                                                          +-----------------------+
```

## 2. Implementasi NestJS Consumer (TypeScript 5+ & NestJS 10+)

### Setup Kafka Microservice Consumer

```typescript
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload, Ctx, KafkaContext } from '@nestjs/microservices';
import { ElasticSearchService } from './elastic-search.service';

// Format Payload Standard dari Debezium
export interface DebeziumEvent<T> {
  op: 'c' | 'u' | 'd' | 'r'; // create, update, delete, read (snapshot)
  before: T | null;
  after: T | null;
  source: {
    ts_ms: number;
    db: string;
    schema: string;
    table: string;
  };
  ts_ms: number;
}

export interface ProductDBSchema {
  id: string;
  name: string;
  price: number;
  is_active: boolean;
  category_id: string;
}

@Controller()
export class CdcSyncController {
  private readonly logger = new Logger(CdcSyncController.name);

  constructor(private readonly elasticSearchService: ElasticSearchService) {}

  @MessagePattern('postgres.public.products') // Format topic default Debezium
  async handleProductChange(
    @Payload() message: DebeziumEvent<ProductDBSchema>,
    @Ctx() context: KafkaContext,
  ) {
    const topic = context.getTopic();
    const partition = context.getPartition();
    
    // Debezium mengirim payload null/empty untuk tombstone record (Penghapusan fisik)
    if (!message || !message.op) {
       this.logger.debug('Received tombstone message, ignoring.');
       return;
    }

    try {
      this.logger.log(`Processing CDC Event [${message.op}] on Partition: ${partition}`);

      switch (message.op) {
        case 'c': // Create
        case 'r': // Read (Initial Snapshot)
          if (message.after && message.after.is_active) {
             await this.elasticSearchService.upsertDocument(this.transform(message.after));
          }
          break;
        case 'u': // Update
          if (message.after) {
             if (message.after.is_active) {
                await this.elasticSearchService.upsertDocument(this.transform(message.after));
             } else {
                // Soft delete scenario (is_active = false)
                await this.elasticSearchService.deleteDocument(message.after.id);
             }
          }
          break;
        case 'd': // Hard Delete
          if (message.before) {
             await this.elasticSearchService.deleteDocument(message.before.id);
          }
          break;
        default:
          this.logger.warn(`Unknown operation type: ${message.op}`);
      }
    } catch (error: unknown) {
      this.logger.error(`Failed to process CDC event from topic ${topic}`, error);
      // Di produksi, jangan telan error; gunakan Dead Letter Queue (DLQ)
      throw error; 
    }
  }

  private transform(dbRecord: ProductDBSchema) {
    // Transformasi skema database ke skema denormalized untuk Search Engine
    return {
      id: dbRecord.id,
      name: dbRecord.name,
      price: dbRecord.price,
      categoryId: dbRecord.category_id,
      // Field gabungan lainnya bisa dipanggil via gRPC ke service lain jika butuh enrichment
    };
  }
}
```

*Catatan: Konfigurasi module Kafka Client NestJS (dengan `Transport.KAFKA`) di-bootstrap di `main.ts` sebagai microservice.*

## 3. Unit / Mock Test Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { CdcSyncController, DebeziumEvent, ProductDBSchema } from './cdc-sync.controller';
import { ElasticSearchService } from './elastic-search.service';
import { KafkaContext } from '@nestjs/microservices';

describe('CdcSyncController', () => {
  let controller: CdcSyncController;
  let elasticSearchService: jest.Mocked<ElasticSearchService>;

  beforeEach(async () => {
    const mockEsService = {
      upsertDocument: jest.fn(),
      deleteDocument: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CdcSyncController],
      providers: [
        {
          provide: ElasticSearchService,
          useValue: mockEsService,
        },
      ],
    }).compile();

    controller = module.get<CdcSyncController>(CdcSyncController);
    elasticSearchService = module.get(ElasticSearchService);
  });

  it('should upsert document on Create (op: c)', async () => {
    const payload: DebeziumEvent<ProductDBSchema> = {
      op: 'c',
      before: null,
      after: { id: 'p1', name: 'Keyboard', price: 100, is_active: true, category_id: 'c1' },
      source: { ts_ms: 100, db: 'db', schema: 'public', table: 'products' },
      ts_ms: 101,
    };
    
    const mockCtx = { getTopic: jest.fn(), getPartition: jest.fn() } as unknown as KafkaContext;

    await controller.handleProductChange(payload, mockCtx);

    expect(elasticSearchService.upsertDocument).toHaveBeenCalledWith({
      id: 'p1', name: 'Keyboard', price: 100, categoryId: 'c1'
    });
  });

  it('should delete document on Delete (op: d)', async () => {
    const payload: DebeziumEvent<ProductDBSchema> = {
      op: 'd',
      before: { id: 'p2', name: 'Mouse', price: 50, is_active: true, category_id: 'c2' },
      after: null,
      source: { ts_ms: 100, db: 'db', schema: 'public', table: 'products' },
      ts_ms: 101,
    };
    
    const mockCtx = { getTopic: jest.fn(), getPartition: jest.fn() } as unknown as KafkaContext;

    await controller.handleProductChange(payload, mockCtx);

    expect(elasticSearchService.deleteDocument).toHaveBeenCalledWith('p2');
  });
});
```

## 4. Analisis Trade-Off

### Kelebihan
1. **Guaranteed Delivery (Zero Data Loss):** Kafka menyimpan log secara persisten. Jika NestJS worker mati, ia dapat melanjutkan (*resume*) pemrosesan dari *offset* terakhir tanpa kehilangan satu event pun.
2. **Tidak Membebani Database Induk (Zero DB Polling):** CDC membaca log biner (WAL), bukan mengeksekusi kueri `SELECT`, sehingga latensi CPU di Postgres mendekati 0.
3. **Decoupling Sejati:** Layanan API Backend (BFF) sama sekali tidak menyadari keberadaan mesin pencari. Proses tulis (Write) menjadi sangat cepat.

### Kekurangan
1. **Kompleksitas Infrastruktur:** Membutuhkan deployment Zookeeper, Kafka broker, Kafka Connect, Debezium Connector plugin, dan setelan logical replication di Postgres. (Bukan untuk project berskala kecil).
2. **Data Denormalisasi (Enrichment) Rumit:** Debezium menghasilkan event per tabel (misal tabel `products`). Jika Elasticsearch membutuhkan field dari tabel `categories` (misal nama kategori), worker NestJS harus melakukan kueri lookup ekstra (*Stream Enrichment*) atau men-join aliran (Kafka Streams) yang sulit.
3. **Eventual Consistency:** Data di aplikasi frontend dan mesin pencari mungkin memiliki jeda waktu milidetik hingga detik. (Tidak cocok jika UI mengharapkan data instan "read-after-write" secara blocking).

## 5. Anti-Patterns Kritis

### Anti-Pattern 1: Sinkronisasi Single Item di NestJS Kafka Worker ❌
Melakukan eksekusi API insert ke Elasticsearch satu per satu setiap menerima 1 event dari Kafka, menyebabkan bottleneck latensi jaringan pada throughput tinggi (misal saat batch DB update ribuan baris).
```typescript
// ❌ SALAH: Insert 1 by 1
await this.elasticClient.index({ index: 'products', document: transformed });
```
**✅ Solusi Benar:** Gunakan Kafka Batching (konfigurasi `@MessagePattern` `batch: true` atau RxJS `bufferTime()`) lalu panggil `client.bulk()` ElasticSearch untuk menekan overhead I/O.

### Anti-Pattern 2: Tidak Menangani Dead Letter Queue (DLQ) ❌
Membiarkan error terjadi tanpa *acknowledgement* (ACK) yang benar di NestJS, membuat Kafka lag partition membengkak atau menyebabkan *poison pill message* yang membuat loop error selamanya.
**✅ Solusi Benar:** CATCH error pada record spesifik, log ke DLQ (table DB khusus atau Kafka Topic error), dan kembalikan sukses/ack ke broker utama agar offset maju terus.

## 6. Production Edge Cases

1. **Snapshotting Besar (Initial Load):** Saat Debezium baru disambungkan ke database yang memiliki 10 Juta row, ia akan melakukan fasa "Initial Snapshot", mengirim 10 juta event beruntun (Read Event `op: 'r'`). NestJS Consumer bisa kehabisan memori atau ElasticSearch bisa terbakar CPU-nya. Batasi `max.poll.records` di NestJS Kafka client.
2. **Postgres Replication Slot Bloat:** Jika Kafka/Debezium mati lama, WAL (Write-Ahead-Logs) tertahan di Postgres karena Replication Slot masih menahan offset lama. Ini bisa memakan space disk Postges sampai 100% dan membuat DB mati total. Wajib monitor metrik disk usage & replication slot lag!
3. **Event Out of Order:** Jika terjadi update bersamaan pada baris sama dan ada lebih dari 1 instance NestJS, ada risiko update masuk tidak berurutan karena partisi yang salah. Pastikan message Kafka di-partition berdasarkan Primary Key (Produk ID) agar perubahan di ID yang sama diproses oleh worker yang sama berurutan!
