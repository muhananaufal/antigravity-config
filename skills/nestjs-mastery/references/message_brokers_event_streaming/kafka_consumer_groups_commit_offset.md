# Arsitektur Apache Kafka Berbeban Berat di NestJS

## Pendahuluan
Apache Kafka adalah platform streaming peristiwa terdistribusi berkinerja tinggi. Dalam ekosistem NestJS, penggunaan `kafkajs` memungkinkan pembangunan sistem dengan skalabilitas ekstrem. Dokumen ini membahas implementasi *Consumer Groups* terisolasi, manual *commit offset* untuk menghindari *data loss*, dan keselamatan saat *partition rebalance*.

## Diagram Arsitektur

```text
+-------------------+       +-------------------+       +-------------------+
|   Producer App    |       |   Kafka Cluster   |       |   Consumer App    |
| (NestJS Microsvc) |       | (Brokers 1, 2, 3) |       | (NestJS Microsvc) |
+--------+----------+       +--------+----------+       +---------+---------+
         |                           |                            |
         |  1. Publish Event         |                            |
         |  (Topic: order.events)    |                            |
         |-------------------------->|                            |
         |                           |  2. Fetch Messages         |
         |                           |<---------------------------|
         |                           |                            |
         |                           |  3. Process Data           |
         |                           |                            |
         |                           |  4. Manual Commit Offset   |
         |                           |<---------------------------|
```

## Implementasi NestJS (TypeScript 5+, NestJS 10+)

```typescript
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Kafka, Consumer, Producer, EachMessagePayload, logLevel } from 'kafkajs';
import { ConfigService } from '@nestjs/config';

export interface OrderEvent {
  orderId: string;
  amount: number;
  status: 'CREATED' | 'PAID' | 'FAILED';
  timestamp: string;
}

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaService.name);
  private kafka: Kafka;
  private producer: Producer;
  private consumer: Consumer;

  constructor(private readonly configService: ConfigService) {
    const brokers = this.configService.getOrThrow<string>('KAFKA_BROKERS').split(',');
    const clientId = this.configService.getOrThrow<string>('KAFKA_CLIENT_ID');

    this.kafka = new Kafka({
      clientId,
      brokers,
      logLevel: logLevel.ERROR,
    });

    this.producer = this.kafka.producer({
      allowAutoTopicCreation: false,
      transactionTimeout: 30000,
    });

    this.consumer = this.kafka.consumer({
      groupId: this.configService.getOrThrow<string>('KAFKA_GROUP_ID'),
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
    await this.consumer.connect();
    
    this.logger.log('Kafka Producer and Consumer connected');
    await this.setupConsumer();
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
    await this.consumer.disconnect();
    this.logger.log('Kafka connections closed gracefully');
  }

  async publishOrderEvent(topic: string, event: OrderEvent): Promise<void> {
    try {
      await this.producer.send({
        topic,
        messages: [
          {
            key: event.orderId,
            value: JSON.stringify(event),
          },
        ],
        acks: -1, // Wait for all in-sync replicas
      });
      this.logger.log(`Event published successfully for order: ${event.orderId}`);
    } catch (error: unknown) {
      this.logger.error(`Failed to publish event for order: ${event.orderId}`, error instanceof Error ? error.stack : 'Unknown error');
      throw error;
    }
  }

  private async setupConsumer(): Promise<void> {
    const topic = this.configService.getOrThrow<string>('KAFKA_ORDER_TOPIC');
    
    await this.consumer.subscribe({ topic, fromBeginning: false });

    await this.consumer.run({
      autoCommit: false, // Wajib manual commit untuk zero data loss
      eachMessage: async (payload: EachMessagePayload): Promise<void> => {
        const { topic, partition, message, heartbeat } = payload;
        
        try {
          if (!message.value) {
            throw new Error('Message value is null');
          }

          const eventPayload = JSON.parse(message.value.toString()) as OrderEvent;
          this.logger.log(`Processing order: ${eventPayload.orderId}`);

          // Simulasi pemrosesan berat
          await this.processOrderBusinessLogic(eventPayload);

          // Wajib panggil heartbeat jika proses lama
          await heartbeat();

          // Manual commit setelah berhasil
          await this.consumer.commitOffsets([
            { topic, partition, offset: (BigInt(message.offset) + BigInt(1)).toString() }
          ]);
          
          this.logger.log(`Successfully processed and committed offset for order: ${eventPayload.orderId}`);
        } catch (error: unknown) {
          this.logger.error(`Error processing message from topic ${topic}, partition ${partition}`, error instanceof Error ? error.stack : 'Unknown error');
          // Jangan commit offset, pesan akan diproses ulang atau masuk DLQ (implementasi kustom)
          throw error; // Memicu retry bawaan kafkajs
        }
      },
    });
  }

  private async processOrderBusinessLogic(event: OrderEvent): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 100)); // Simulasi I/O
  }
}
```

## Pengujian Unit (Test Suite)

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { KafkaService, OrderEvent } from './kafka.service';

describe('KafkaService', () => {
  let service: KafkaService;
  let configService: ConfigService;

  const mockProducer = {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue([{ topicName: 'test-topic', partition: 0, errorCode: 0 }]),
  };

  const mockConsumer = {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
    run: jest.fn().mockResolvedValue(undefined),
    commitOffsets: jest.fn().mockResolvedValue(undefined),
  };

  const mockKafka = {
    producer: jest.fn().mockReturnValue(mockProducer),
    consumer: jest.fn().mockReturnValue(mockConsumer),
  };

  jest.mock('kafkajs', () => ({
    Kafka: jest.fn().mockImplementation(() => mockKafka),
    logLevel: { ERROR: 0 },
  }));

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KafkaService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn((key: string) => {
              const env = {
                KAFKA_BROKERS: 'localhost:9092',
                KAFKA_CLIENT_ID: 'test-client',
                KAFKA_GROUP_ID: 'test-group',
                KAFKA_ORDER_TOPIC: 'order.events',
              };
              return env[key as keyof typeof env];
            }),
          },
        },
      ],
    }).compile();

    service = module.get<KafkaService>(KafkaService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should publish order event successfully', async () => {
    const event: OrderEvent = {
      orderId: 'ORD-123',
      amount: 50000,
      status: 'CREATED',
      timestamp: new Date().toISOString(),
    };

    await service.publishOrderEvent('order.events', event);
    expect(mockProducer.send).toHaveBeenCalledTimes(1);
  });
});
```

## Analisis Trade-Off

### Kelebihan
1. **Throughput Tinggi:** Kafka sanggup memproses jutaan event per detik, sangat cocok untuk arsitektur skala besar (HFT, log streaming).
2. **Durabilitas & Replayability:** Pesan disimpan dalam disk secara persisten sesuai retention policy, memungkinkan sistem memutar ulang event masa lalu.
3. **Partitioning:** Memungkinkan skalabilitas horizontal linear dengan memecah antrean ke dalam banyak partisi yang dapat dibaca oleh banyak instance consumer secara paralel.

### Kekurangan
1. **Kompleksitas Operasional:** Mengelola cluster Kafka (meski tanpa Zookeeper di versi KRaft) sangat kompleks (tuning JVM, page cache Linux).
2. **Rebalance Storm:** Perubahan pada anggota Consumer Group akan memicu rebalance partisi yang menghentikan seluruh pemrosesan sejenak ("Stop The World").
3. **Kurangnya Native DLQ:** Tidak ada fitur Dead Letter Queue bawaan seperti di RabbitMQ, sehingga developer harus mengimplementasikannya secara manual.

## Anti-Patterns Kritis

### 1. Auto-Commit di Lingkungan Penting
❌ **Salah:** Menggunakan `autoCommit: true`. Jika consumer melempar error setelah offset di-commit secara otomatis oleh background thread, pesan hilang selamanya!
```typescript
// ANTI-PATTERN
this.consumer.run({
  autoCommit: true,
  eachMessage: async ({ message }) => {
    await processAndSaveToDb(message); // Jika ini crash, offset sudah naik! Data loss.
  }
});
```
✅ **Benar:** Matikan `autoCommit` dan lakukan `commitOffsets` hanya setelah bisnis logik sukses.
```typescript
// BEST PRACTICE
this.consumer.run({
  autoCommit: false,
  eachMessage: async ({ message, partition, topic }) => {
    await processAndSaveToDb(message);
    await this.consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + BigInt(1)).toString() }]);
  }
});
```

### 2. Memblokir Heartbeat (Poison Pill Blocking)
❌ **Salah:** Membiarkan pemrosesan pesan berjalan sinkron dan lama tanpa memanggil `heartbeat()`, sehingga coordinator menganggap consumer mati dan memicu Rebalance Storm.
```typescript
// ANTI-PATTERN
eachMessage: async ({ message }) => {
  await veryLongRunningTaskSync(); // Consumer terdepak dari group!
}
```
✅ **Benar:** Panggil heartbeat secara manual di tengah iterasi panjang atau proses di worker terpisah.
```typescript
// BEST PRACTICE
eachMessage: async ({ message, heartbeat }) => {
  await doHalfTask();
  await heartbeat();
  await doRemainingTask();
}
```

## Production Edge Cases
1. **Idempotency Kegagalan Commit:** Jika proses sukses namun aplikasi crash sebelum `commitOffsets` terpanggil, pesan akan dikonsumsi ulang. Sistem hilir (Database) wajib bersifat idempotent (misalnya pengecekan `orderId` unik sebelum `INSERT`).
2. **Partition Rebalance Saat Memproses:** Consumer harus menangani sinyal pemutusan dari Kafka dengan menghentikan eksekusi aman (*graceful shutdown*) agar tidak terjadi inkonsistensi.
3. **Kelebihan Kapasitas (Head-of-Line Blocking):** Jika satu pesan bermasalah menyebabkan Exception terus menerus, seluruh partisi macet. Terapkan strategi max-retry lokal, lalu buang ke topik DLQ (Dead Letter Queue) kustom.
