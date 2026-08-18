# Redis Streams sebagai Event Sourcing Terjangkau di NestJS

## Pendahuluan
Redis tidak hanya tentang *caching* (K/V store) dan *Pub/Sub* volatil. Dengan struktur data **Redis Streams**, ia bisa beralih fungsi menjadi Message Broker persisten. Menggunakan pola `XADD`, `XREADGROUP`, dan log event-sourcing, ia menyediakan solusi ringan (hemat resource) untuk layanan mikro yang membutuhkan antrean handal bertipe persisten *Consumer Group Acknowledgment*.

## Diagram Arsitektur

```text
+-------------------+      XADD     +-----------------------------------------+
|   Publisher App   |-------------->|               Redis Server              |
| (NestJS Microsvc) |               |                                         |
+-------------------+               |  +-----------------------------------+  |
                                    |  | Stream: event_log                 |  |
                                    |  | 1623490-0: { id: 1, ev: "ADD" }   |  |
+-------------------+  XREADGROUP   |  | 1623492-0: { id: 2, ev: "PAY" }   |  |
|   Consumer App 1  |<--------------|  +-----------------------------------+  |
|   (Group: cg_A)   |      ACK      |               |     |                   |
+-------------------+---------------+               |     |                   |
                                                    |     |                   |
+-------------------+  XREADGROUP                   |     |                   |
|   Consumer App 2  |<------------------------------+     |                   |
|   (Group: cg_A)   |      ACK                            |                   |
+-------------------+-------------------------------------+
```

## Implementasi NestJS (TypeScript 5+, NestJS 10+)

```typescript
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export interface DomainEvent {
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class RedisStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisStreamService.name);
  private redisClient!: Redis;
  private readonly streamKey = 'system:events:log';
  private readonly groupName = 'nestjs_processor_group';
  private readonly consumerName = `worker-${process.pid}`;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const url = this.configService.getOrThrow<string>('REDIS_URL');
    
    this.redisClient = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });

    this.redisClient.on('error', (err: unknown) => {
      this.logger.error('Redis connection error', err instanceof Error ? err.stack : 'Unknown error');
    });

    await this.initConsumerGroup();
    this.startConsumingLoop(); // Non-blocking
    this.logger.log(`Redis Stream connected. Worker: ${this.consumerName}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.redisClient.quit();
    this.logger.log('Redis connection closed');
  }

  private async initConsumerGroup(): Promise<void> {
    try {
      // Membuat stream jika belum ada, dan membuat Consumer Group (MKSTREAM memastikannya)
      await this.redisClient.xgroup('CREATE', this.streamKey, this.groupName, '0', 'MKSTREAM');
      this.logger.log(`Consumer Group ${this.groupName} ensured on ${this.streamKey}`);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('BUSYGROUP')) {
        this.logger.log('Consumer group already exists, skipping creation.');
      } else {
        throw err;
      }
    }
  }

  async appendEvent(event: DomainEvent): Promise<string> {
    try {
      // XADD ke stream, menggunakan '*', Redis membuatkan ID berbasis Timestamp Otomatis
      // Menyimpan data sebagai key-value (hash)
      const eventId = await this.redisClient.xadd(
        this.streamKey,
        'MAXLEN', '~', 100000, // Capping panjang stream untuk mencegah OOM (Approximate MaxLen)
        '*', 
        'aggregateId', event.aggregateId,
        'eventType', event.eventType,
        'payload', JSON.stringify(event.payload)
      );
      this.logger.log(`Event ${event.eventType} appended. Stream ID: ${eventId}`);
      return eventId;
    } catch (err: unknown) {
      this.logger.error('Failed to append event', err instanceof Error ? err.stack : 'Unknown error');
      throw err;
    }
  }

  private async startConsumingLoop(): Promise<void> {
    while (true) {
      try {
        // XREADGROUP memblokir selama 5000ms jika tidak ada event (Long Polling)
        // '>' artinya ambil pesan yang belum pernah diserahkan ke consumer lain di grup ini
        const streams = await this.redisClient.xreadgroup(
          'GROUP', this.groupName, this.consumerName,
          'BLOCK', 5000,
          'COUNT', 10,
          'STREAMS', this.streamKey, '>'
        );

        if (streams) {
          const stream = streams[0];
          const messages = stream[1];

          for (const msg of messages) {
            const messageId = msg[0];
            const dataFields = msg[1];
            
            // Konversi murni array fields ke Object
            const eventData = this.parseRedisArrayToObject(dataFields);
            this.logger.log(`Processing Msg ${messageId} | Type: ${eventData.eventType}`);

            await this.processEventLogic(eventData);

            // Manual ACK agar tidak muncul di Pending Entries List (PEL) lagi
            await this.redisClient.xack(this.streamKey, this.groupName, messageId);
          }
        }
      } catch (err: unknown) {
        this.logger.error('Error while consuming streams', err instanceof Error ? err.stack : 'Unknown error');
        await new Promise(resolve => setTimeout(resolve, 2000)); // Backoff perlindungan
      }
    }
  }

  private parseRedisArrayToObject(array: string[]): Record<string, string> {
    const obj: Record<string, string> = {};
    for (let i = 0; i < array.length; i += 2) {
      obj[array[i]] = array[i + 1];
    }
    return obj;
  }

  private async processEventLogic(data: Record<string, string>): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 50));
  }
}
```

## Pengujian Unit (Test Suite)

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedisStreamService, DomainEvent } from './redis-stream.service';

describe('RedisStreamService', () => {
  let service: RedisStreamService;

  const mockRedisClient = {
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    xgroup: jest.fn().mockResolvedValue('OK'),
    xadd: jest.fn().mockResolvedValue('123456789-0'),
    xreadgroup: jest.fn().mockResolvedValue([
      [
        'system:events:log',
        [
          ['123456789-0', ['aggregateId', 'A1', 'eventType', 'TEST', 'payload', '{}']]
        ]
      ]
    ]),
    xack: jest.fn().mockResolvedValue(1),
  };

  jest.mock('ioredis', () => {
    return jest.fn().mockImplementation(() => mockRedisClient);
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisStreamService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('redis://localhost:6379'),
          },
        },
      ],
    }).compile();

    service = module.get<RedisStreamService>(RedisStreamService);
    // bypass the inner looping initialization for unit testing
    (service as any).redisClient = mockRedisClient;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should append event correctly to stream using MAXLEN bound', async () => {
    const event: DomainEvent = { aggregateId: 'AG-1', eventType: 'CREATED', payload: { a: 1 } };
    const id = await service.appendEvent(event);
    
    expect(id).toBe('123456789-0');
    expect(mockRedisClient.xadd).toHaveBeenCalledWith(
      'system:events:log',
      'MAXLEN', '~', 100000,
      '*',
      'aggregateId', 'AG-1',
      'eventType', 'CREATED',
      'payload', '{"a":1}'
    );
  });
});
```

## Analisis Trade-Off

### Kelebihan
1. **Low Setup Cost:** Sebagian besar arsitektur sudah memiliki *Redis Server* (untuk caching). Redis Streams tidak butuh penambahan infrastruktur broker baru.
2. **Kinerja Super Cepat:** Operasi memori murni (dengan persistensi AOF disk), membuatnya sangat cepat (Microsecond latencies) dibandingkan broker tradisional.
3. **PEL (Pending Entries List):** Menggunakan pola Consumer Group, Redis melacak pesan apa yang sedang diproses (pending) tanpa menghapusnya, memudahkan *claiming* oleh worker lain jika worker lama mati/crash.

### Kekurangan
1. **Risiko OOM (Out Of Memory):** Seluruh pesan tersimpan di RAM. Jika developer lupa membatasi MAXLEN atau trimming stream secara reguler, Redis Server bisa kolaps kekurangan RAM.
2. **Tidak Seandal Kafka untuk Skala Raksasa:** Cluster sharding/Clustering Redis kurang optimal mendistribusikan Stream Keys ke banyak node dibanding pembagian partisi log Kafka.
3. **Ecosystem & Tooling Kurang:** Tidak memiliki GUI bawaan secanggih RabbitMQ Management UI atau Kafka UI.

## Anti-Patterns Kritis

### 1. Menumpuk Data Stream ke Infinity (No Trimming)
❌ **Salah:** Menggunakan `XADD` polos berulang kali tanpa merencanakan batas ukuran log. RAM server membengkak parah setelah berhari-hari.
```typescript
// ANTI-PATTERN
await this.redisClient.xadd(streamKey, '*', 'field', 'value'); // RAM limit habis. OOM Killer bekerja.
```
✅ **Benar:** Membatasi ukuran stream dengan parameter MAXLEN (pendekatan hampiran `~` lebih performant).
```typescript
// BEST PRACTICE
await this.redisClient.xadd(streamKey, 'MAXLEN', '~', 10000, '*', 'field', 'value');
```

### 2. Mengabaikan PEL (Pending Messages Idle)
❌ **Salah:** Tidak ada worker khusus yang menjalankan `XPENDING` dan `XCLAIM`. Jika worker mati sebelum mengirim ACK, pesannya "terkunci" selamanya di memori Pending List dan tidak diproses pihak lain.
✅ **Benar:** Wajib sediakan CRON/Worker penyapu (*Sweeper/Reaper*) yang secara berkala membaca List Tertunda, memanggil `XCLAIM` pada pesan usang > 10 menit, dan memindahkannya ke worker aktif.

## Production Edge Cases
1. **Long Polling Timeout Limits:** Driver TCP IORedis bisa memutus socket (timeout ping) jika operasi `XREADGROUP BLOCK 0` diatur tak terbatas (infinity). Sebaiknya gunakan BLOCK dengan durasi berhingga (contoh: 5000ms), lalu putar *while loop*.
2. **AOF Rewrite I/O Spikes:** Redis menggunakan Append-Only File (AOF) untuk menulis data stream ke Disk. Pada beban *write-heavy*, *bgrewriteaof* OS bisa membekukan server sesaat, sehingga `XADD` menghasilkan error I/O spike sesaat.
3. **Stale Consumer Registration:** Worker yang mati seringkali nama consumer-nya berbekas di Grup, menyebabkan informasi matrik monitoring tidak relevan. Developer butuh memanggil `XGROUP DELCONSUMER` rutin untuk "membersihkan" status worker usang.
