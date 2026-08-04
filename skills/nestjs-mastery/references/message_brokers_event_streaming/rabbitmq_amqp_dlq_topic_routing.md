# Penguasaan RabbitMQ / AMQP di NestJS

## Pendahuluan
RabbitMQ adalah message broker tradisional yang kokoh dengan paradigma pertukaran dan rute (Exchanges & Routing). Menggunakan NestJS, RabbitMQ dapat diandalkan untuk pola RPC asinkron, *Fanout* penyiaran (broadcasting), serta pengaturan kegagalan yang aman menggunakan Dead Letter Queue (DLQ).

## Diagram Arsitektur

```text
+-------------------+        +-----------------------------------------------+
|   Publisher App   |        |                 RabbitMQ Node                 |
| (NestJS Microsvc) |        |                                               |
+--------+----------+        |  +---------------+       +-----------------+  |
         |                   |  |               |       | Main Queue      |  |
         |  Publish          |  | Topic Exchange| ----> | (queue.orders)  |  |
         +------------------ >  | (order.exch)  |       +-----------------+  |
                             |  |               |              |             |
                             |  +---------------+       (NACK / Reject)      |
                             |                                 |             |
                             |                                 V             |
                             |                          +-----------------+  |
                             |                          | DLQ Exchange    |  |
                             |                          +-----------------+  |
                             |                                 |             |
                             |                                 V             |
                             |                          +-----------------+  |
                             |                          | DLQ Queue       |  |
                             |                          | (dlq.orders)    |  |
                             |                          +-----------------+  |
                             +-----------------------------------------------+
```

## Implementasi NestJS (TypeScript 5+, NestJS 10+)

```typescript
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqplib from 'amqplib';

export interface PaymentMessage {
  transactionId: string;
  amount: number;
  userId: string;
}

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);
  private connection!: amqplib.Connection;
  private channel!: amqplib.Channel;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const url = this.configService.getOrThrow<string>('RABBITMQ_URL');
    try {
      this.connection = await amqplib.connect(url);
      this.channel = await this.connection.createChannel();
      
      this.connection.on('error', (err: unknown) => {
        this.logger.error('RabbitMQ Connection Error', err instanceof Error ? err.stack : 'Unknown error');
      });

      await this.assertTopology();
      await this.startConsumer();
      this.logger.log('RabbitMQ connected and topology asserted');
    } catch (error: unknown) {
      this.logger.error('Failed to initialize RabbitMQ', error instanceof Error ? error.stack : 'Unknown error');
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
    this.logger.log('RabbitMQ connection closed');
  }

  private async assertTopology(): Promise<void> {
    const mainExchange = 'payment.topic';
    const mainQueue = 'payment.processing';
    const dlxExchange = 'payment.dlx';
    const dlqQueue = 'payment.dlq';

    // 1. Setup Dead Letter Exchange & Queue
    await this.channel.assertExchange(dlxExchange, 'direct', { durable: true });
    await this.channel.assertQueue(dlqQueue, { durable: true });
    await this.channel.bindQueue(dlqQueue, dlxExchange, 'payment.failed');

    // 2. Setup Main Exchange & Queue with DLX configuration
    await this.channel.assertExchange(mainExchange, 'topic', { durable: true });
    await this.channel.assertQueue(mainQueue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': dlxExchange,
        'x-dead-letter-routing-key': 'payment.failed', // Override routing key
      },
    });
    await this.channel.bindQueue(mainQueue, mainExchange, 'payment.*');
  }

  async publishPayment(routingKey: string, message: PaymentMessage): Promise<void> {
    const buffer = Buffer.from(JSON.stringify(message));
    const isSent = this.channel.publish('payment.topic', routingKey, buffer, {
      persistent: true, // Survive broker restarts
      messageId: message.transactionId,
    });
    
    if (!isSent) {
      this.logger.warn(`Channel buffer full, failed to publish instantly for tx: ${message.transactionId}`);
    }
  }

  private async startConsumer(): Promise<void> {
    const mainQueue = 'payment.processing';
    
    await this.channel.prefetch(10); // Batasi proses simultan per worker

    await this.channel.consume(mainQueue, async (msg: amqplib.ConsumeMessage | null) => {
      if (!msg) return;

      const txId = msg.properties.messageId;
      try {
        const content = JSON.parse(msg.content.toString()) as PaymentMessage;
        this.logger.log(`Processing payment: ${content.transactionId}`);

        // Simulasi error acak
        if (content.amount < 0) {
          throw new Error('Invalid negative amount');
        }

        await this.processPayment(content);

        // ACK manual: sukses!
        this.channel.ack(msg);
      } catch (error: unknown) {
        this.logger.error(`Error processing payment ${txId}. Rejecting to DLQ.`, error instanceof Error ? error.message : 'Unknown');
        // NACK eksplisit (requeue = false -> kirim ke DLQ)
        this.channel.nack(msg, false, false);
      }
    }, { noAck: false }); // Wajib manual ACK
  }

  private async processPayment(msg: PaymentMessage): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 50));
  }
}
```

## Pengujian Unit (Test Suite)

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RabbitMQService, PaymentMessage } from './rabbitmq.service';

describe('RabbitMQService', () => {
  let service: RabbitMQService;
  
  const mockChannel = {
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue({ queue: 'test-queue' }),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    prefetch: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockReturnValue(true),
    ack: jest.fn(),
    nack: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };

  const mockConnection = {
    createChannel: jest.fn().mockResolvedValue(mockChannel),
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };

  jest.mock('amqplib', () => ({
    connect: jest.fn().mockResolvedValue(mockConnection),
  }));

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RabbitMQService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('amqp://localhost'),
          },
        },
      ],
    }).compile();

    service = module.get<RabbitMQService>(RabbitMQService);
    // Kita lewati onModuleInit di tes sederhana agar tak memanggil library asli
    (service as any).channel = mockChannel;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should publish payment message correctly', async () => {
    const msg: PaymentMessage = { transactionId: 'TX123', amount: 100, userId: 'U1' };
    await service.publishPayment('payment.success', msg);
    
    expect(mockChannel.publish).toHaveBeenCalledWith(
      'payment.topic',
      'payment.success',
      expect.any(Buffer),
      { persistent: true, messageId: 'TX123' }
    );
  });
});
```

## Analisis Trade-Off

### Kelebihan
1. **Fleksibilitas Routing:** Dukungan Topic, Direct, dan Fanout exchange memungkinkan penentuan rute logika pengiriman pesan yang sangat rumit tanpa harus dikode keras (hardcoded).
2. **Native Dead Lettering:** Memiliki ekosistem DLQ (Dead Letter Queue) bawaan; mempermudah pengalihan pesan gagal tanpa kode aplikasi yang kotor.
3. **Low Latency & Push Model:** Node RabbitMQ langsung menekan (push) pesan ke consumer aktif, menghasilkan latensi di bawah 10ms (sangat cepat).

### Kekurangan
1. **Performa Keseluruhan Terbatas:** Tidak setinggi throughput Apache Kafka. Kinerja menurun dramatis apabila pesan dibiarkan terlalu lama menumpuk (tidak di-consume).
2. **Replay Sulit:** RabbitMQ adalah antrean hapus-dan-lupa. Jika pesan sudah di-ACK, pesan akan dihapus selamanya. Tidak ada *message replay*.
3. **Brain Split / Network Partition:** Saat dijalankan dalam konfigurasi cluster, RabbitMQ sangat sensitif terhadap *network partition*, berisiko merusak antrean *mirrored*.

## Anti-Patterns Kritis

### 1. Fire and Forget dengan noAck
❌ **Salah:** Mengaktifkan mode otomatis `noAck: true`. RabbitMQ membuang pesan dari RAM seketika saat dikirim ke socket worker. Jika aplikasi mati saat memproses, pesan lenyap!
```typescript
// ANTI-PATTERN
this.channel.consume(queue, (msg) => {
  processHeavyTask(msg); // Jika server restart di sini, pesan raib selamanya.
}, { noAck: true }); 
```
✅ **Benar:** Manual Acknowledgment.
```typescript
// BEST PRACTICE
this.channel.consume(queue, async (msg) => {
  await processHeavyTask(msg);
  this.channel.ack(msg);
}, { noAck: false }); 
```

### 2. Prefetch Terlalu Besar (atau Tidak Diatur)
❌ **Salah:** Tidak menetapkan batas *prefetch* (`channel.prefetch(count)`). Jika ada 100.000 pesan, RabbitMQ akan menekan semuanya ke RAM aplikasi Node.js, memicu *Out Of Memory* (OOM)!
```typescript
// ANTI-PATTERN
// tanpa this.channel.prefetch()
this.channel.consume(queue, callback); // Menelan semua pesan sekaligus
```
✅ **Benar:** Atur jumlah prefetch sesuai kemampuan konkurensi database atau I/O API external.
```typescript
// BEST PRACTICE
await this.channel.prefetch(50); // Maksimal proses 50 bersamaan per worker
```

## Production Edge Cases
1. **Infinite Requeue Loop:** Jika `channel.nack(msg, false, true)` terus dipanggil pada pesan yang bermasalah (poison pill), pesan akan berputar balik tiada henti memakan CPU 100%. Atasi dengan maksimal retry logic (menggunakan x-death header) atau ubah param `requeue` menjadi `false` untuk mengirim ke DLX.
2. **Connection Drop Recovery:** AMQP protocol dapat mengalami pemutusan dari sisi server (Heartbeat timeout). Wajib menangkap *event* `close` dan merekatkan sistem re-koneksi dengan backoff eksponensial.
3. **Message Size Limit:** RabbitMQ kesulitan memproses pesan besar (> 1MB). JSON bengkak akan menaikkan I/O disk dan RAM drastis. Simpan biner/teks panjang di S3, kirimkan URL-nya via MQ.
