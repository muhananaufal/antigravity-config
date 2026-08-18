# NATS JetStream: Distributed Event Streaming di NestJS

## Pendahuluan
NATS JetStream (generasi modern dari NATS) merupakan sistem perpesanan cloud-native ringan dengan kapabilitas streaming dan persistensi pesan. Dalam NestJS, NATS JetStream menawarkan model *Push vs Pull Consumers*, serta mekanisme pencegahan duplikasi (Deduplication Window) yang sangat andal untuk arsitektur terdistribusi atomis.

## Diagram Arsitektur

```text
+-------------------+           +---------------------------------+
|   Producer App    |           |    NATS JetStream Cluster       |
| (NestJS Microsvc) |           |                                 |
+--------+----------+           |   +-------------------------+   |
         |                      |   | Stream: EVENTS_STREAM   |   |
         |  Publish w/ MsgID    |   | Subjects: events.*      |   |
         +---------------------->   | Deduplication Window 2m |   |
                                |   +-----------+-------------+   |
                                |               |                 |
                                |               v                 |
                                |       +---------------+         |
                                |       | Pull Consumer |         |
                                |       | (Durable: P1) |         |
                                |       +---------------+         |
                                +---------------|-----------------+
                                                |
                                                | Pull Request (Batch)
+-------------------+                           |
|   Consumer App    |<--------------------------+
| (NestJS Microsvc) |     (Ack / Nak / Term)
+-------------------+
```

## Implementasi NestJS (TypeScript 5+, NestJS 10+)

```typescript
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, NatsConnection, JetStreamClient, StringCodec, consumerOpts } from 'nats';

export interface BaseEvent {
  eventId: string;
  type: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class NatsJetStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NatsJetStreamService.name);
  private nc!: NatsConnection;
  private js!: JetStreamClient;
  private sc = StringCodec();

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const servers = this.configService.getOrThrow<string>('NATS_SERVERS');
    try {
      this.nc = await connect({
        servers: servers.split(','),
        maxReconnectAttempts: -1,
      });
      this.js = this.nc.jetstream();
      
      await this.setupStream();
      this.startPullConsumer().catch(err => {
        this.logger.error('Failed to start consumer', err instanceof Error ? err.stack : err);
      });
      
      this.logger.log('Connected to NATS JetStream');
    } catch (error: unknown) {
      this.logger.error('Failed to connect to NATS', error instanceof Error ? error.stack : 'Unknown error');
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.nc?.drain();
    await this.nc?.close();
    this.logger.log('NATS connection closed gracefully');
  }

  private async setupStream(): Promise<void> {
    const jsm = await this.nc.jetstreamManager();
    const streamName = 'EVENTS_STREAM';
    
    try {
      await jsm.streams.info(streamName);
      this.logger.log(`Stream ${streamName} already exists`);
    } catch (e: unknown) {
      // Jika stream belum ada, buat baru
      await jsm.streams.add({
        name: streamName,
        subjects: ['events.>'], // Wildcard matching
        retention: 'limits',
        max_age: 7 * 24 * 60 * 60 * 1000 * 1000000, // 7 days in nanoseconds
        duplicate_window: 2 * 60 * 1000 * 1000000, // 2 minutes dedup window
        storage: 'file', // File-backed persistence
      });
      this.logger.log(`Stream ${streamName} created with dedup window`);
    }
  }

  async publishEvent(subject: string, event: BaseEvent): Promise<void> {
    const data = this.sc.encode(JSON.stringify(event));
    try {
      const pubAck = await this.js.publish(subject, data, {
        msgId: event.eventId, // Penting untuk deduplication JetStream
      });
      this.logger.log(`Published ${subject} to stream ${pubAck.stream} seq ${pubAck.seq}`);
    } catch (error: unknown) {
      this.logger.error(`Publish failed for ${event.eventId}`, error instanceof Error ? error.stack : 'Unknown error');
      throw error;
    }
  }

  private async startPullConsumer(): Promise<void> {
    const stream = 'EVENTS_STREAM';
    const durableName = 'events-processor-durable';

    // Konfigurasi Durable Pull Consumer
    const opts = consumerOpts();
    opts.durable(durableName);
    opts.manualAck();
    opts.ackExplicit();
    opts.deliverTo(durableName); // Pull consumer

    const sub = await this.js.pullSubscribe('events.>', opts);
    this.logger.log(`Started Pull Consumer ${durableName}`);

    // Loop penarik pesan berkelanjutan
    while (true) {
      try {
        // Ambil max 10 pesan dengan batas waktu 5 detik
        const messages = await sub.fetch({ batch: 10, expires: 5000 });
        for await (const msg of messages) {
          try {
            const content = JSON.parse(this.sc.decode(msg.data)) as BaseEvent;
            this.logger.log(`Processing event: ${content.eventId}`);
            
            await this.processBusinessLogic(content);
            
            // Konfirmasi kesuksesan proses ke server NATS
            msg.ack();
          } catch (err: unknown) {
            this.logger.error('Failed to process message', err instanceof Error ? err.stack : 'Unknown');
            // Menolak pesan, minta broker kirim ulang berdasarkan konfigurasi backoff
            msg.nak(); 
          }
        }
      } catch (err: unknown) {
        // Abaikan error timeout (normal jika antrean kosong)
        if (err instanceof Error && err.message.includes('TIMEOUT')) {
          continue;
        }
        this.logger.error('Error fetching messages', err instanceof Error ? err.stack : 'Unknown');
        await new Promise(resolve => setTimeout(resolve, 1000)); // Backoff manual
      }
    }
  }

  private async processBusinessLogic(event: BaseEvent): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 50));
  }
}
```

## Pengujian Unit (Test Suite)

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NatsJetStreamService, BaseEvent } from './nats.service';

describe('NatsJetStreamService', () => {
  let service: NatsJetStreamService;

  const mockPubAck = { stream: 'EVENTS_STREAM', seq: 123 };
  const mockJetStreamClient = {
    publish: jest.fn().mockResolvedValue(mockPubAck),
    pullSubscribe: jest.fn().mockResolvedValue({
      fetch: jest.fn().mockResolvedValue([]),
    }),
  };

  const mockJetStreamManager = {
    streams: {
      info: jest.fn().mockResolvedValue({}),
      add: jest.fn().mockResolvedValue({}),
    },
  };

  const mockNatsConnection = {
    jetstream: jest.fn().mockReturnValue(mockJetStreamClient),
    jetstreamManager: jest.fn().mockResolvedValue(mockJetStreamManager),
    drain: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };

  jest.mock('nats', () => ({
    connect: jest.fn().mockResolvedValue(mockNatsConnection),
    StringCodec: jest.fn().mockReturnValue({
      encode: jest.fn((str) => Buffer.from(str)),
      decode: jest.fn((buf) => buf.toString()),
    }),
    consumerOpts: jest.fn().mockReturnValue({
      durable: jest.fn(),
      manualAck: jest.fn(),
      ackExplicit: jest.fn(),
      deliverTo: jest.fn(),
    }),
  }));

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NatsJetStreamService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('nats://localhost:4222'),
          },
        },
      ],
    }).compile();

    service = module.get<NatsJetStreamService>(NatsJetStreamService);
    (service as any).js = mockJetStreamClient;
    (service as any).sc = require('nats').StringCodec();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should publish event with duplicate window msgId', async () => {
    const event: BaseEvent = { eventId: 'evt-111', type: 'USER_SIGNED_UP', payload: {} };
    await service.publishEvent('events.user.signup', event);
    
    expect(mockJetStreamClient.publish).toHaveBeenCalledWith(
      'events.user.signup',
      expect.any(Buffer),
      { msgId: 'evt-111' }
    );
  });
});
```

## Analisis Trade-Off

### Kelebihan
1. **Deduplikasi Bawaan:** JetStream melacak ID pesan unik (`msgId`) pada jendela waktu (`duplicate_window`), mencegah penulisan data dobel ke log jika publisher mengirim pesan ulang akibat jeda jaringan.
2. **Fleksibilitas Konsumen:** Dukungan murni terhadap "Push Consumers" (latensi super rendah) dan "Pull Consumers" (kontrol flow tinggi & pemrosesan berkelompok).
3. **Single Binary:** Sangat ringan dan mudah di-deploy di cloud/Kubernetes, ukurannya hanya hitungan belasan MB tanpa ketergantungan JVM.

### Kekurangan
1. **Ekosistem Belum Sedewasa Kafka:** Jumlah resource ekosistem (connectors ke Hadoop/Data Warehouse) tidak sebanding dengan Kafka Connect.
2. **Keterbatasan Ukuran Pesan (Max Payload):** Secara default 1MB. Jika dipaksakan pesan raksasa, akan menyebabkan degradasi I/O performa secara signifikan.
3. **Konfigurasi Streaming Kompleks:** Konfigurasi Retention (Limits vs WorkQueue vs Interest) dapat membingungkan dan merusak arsitektur apabila developer awam salah pilih pola.

## Anti-Patterns Kritis

### 1. Lupa Menggunakan ID Dedup (msgId)
❌ **Salah:** Memanggil publish tanpa *Message ID*. NATS tidak dapat melakukan deteksi duplikat sehingga ketika timeout terjadi dan request diulangi (retry), akan terjadi duplikasi data (Double Charge)!
```typescript
// ANTI-PATTERN
await this.js.publish(subject, data); // Jika retry internal nyala, bisa double events.
```
✅ **Benar:** Kirim *ID Event unik* (UUID/ULID) sebagai `msgId`.
```typescript
// BEST PRACTICE
await this.js.publish(subject, data, { msgId: event.uniqueId });
```

### 2. Menggunakan Push Consumer untuk Proses Berat
❌ **Salah:** Memanfaatkan Push Consumer tanpa kendali saat memproses integrasi pihak ketiga lambat (mis. kirim Email). Node NATS akan memaksa pesan tumpah dan menjebol RAM worker.
```typescript
// ANTI-PATTERN
// Push subscribe tanpa batas antrean
const sub = await this.js.subscribe('events.>');
for await (const msg of sub) {
  await slowDbInsert(msg); // Backpressure meledak!
}
```
✅ **Benar:** Gunakan mekanisme "Pull" (`pullSubscribe`) untuk mengatur flow rate sesuai kekuatan worker (Batch Fetching).

## Production Edge Cases
1. **At-Most-Once vs At-Least-Once Delivery:** Jika ACK terlambat dari worker karena GC Pause di Node.js, broker NATS mungkin me-requeue pesan. Pastikan logika di consumer tahan banting (Idempotent DB Transactions).
2. **Stream Limits Exceeded (Storage Full):** Apabila `retention: 'limits'` dan storage max disk terlewati, NATS secara otomatis menghapus pesan paling usang tanpa ampun. Penting mengatur alerting ke metrik disk space OS.
3. **Terminating Poison Messages:** Beberapa event mungkin salah struktur (parsing error selamanya). Worker harus diatur melempar instruksi khusus `msg.term()` alih-alih `msg.nak()` agar NATS berhenti me-requeue event beracun tersebut selamanya.
