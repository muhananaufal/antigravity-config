# EventStoreDB: Append-Only Event Stream & Aggregate Rehydration

Dalam arsitektur Event Sourcing murni, state sistem tidak disimpan sebagai representasi entitas (CRUD database biasa), melainkan diturunkan (*derived*) dari sejarah seluruh mutasi (peristiwa/event) yang pernah terjadi pada entitas tersebut (Append-Only). Kita akan menggunakan `@eventstore/db-client` dengan NestJS.

## Konsep Event Sourcing

```ascii
[ Waktu ] -------------------------------------------------------->
[ Event Stream: "Booking-ID123" ]

[1] BookingCreated(UserID, RoomID) 
       |
       v (Rehydration) => State: { status: 'PENDING' }
       |
[2] PaymentAccepted(Amount)
       |
       v (Rehydration) => State: { status: 'PAID' }
       |
[3] BookingConfirmed()
       |
       v (Rehydration) => State: { status: 'CONFIRMED' }
```

## Implementasi Produksi di NestJS

### 1. Definisi Tipe dan Interface Event

```typescript
import { JSONEventType } from '@eventstore/db-client';

export type BookingCreatedEvent = JSONEventType<
  'BookingCreated',
  { bookingId: string; userId: string; roomId: string; createdAt: string }
>;

export type PaymentAcceptedEvent = JSONEventType<
  'PaymentAccepted',
  { bookingId: string; amount: number; paymentDate: string }
>;

export type BookingEvent = BookingCreatedEvent | PaymentAcceptedEvent;
```

### 2. Koneksi EventStoreDB

Buat provider untuk menginisialisasi client gRPC dari EventStoreDB.

```typescript
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { EventStoreDBClient } from '@eventstore/db-client';

@Injectable()
export class EventStoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventStoreService.name);
  public client!: EventStoreDBClient;

  // Harusnya dari ConfigService (Environment Variable)
  private readonly connectionString = 'esdb://admin:changeit@localhost:2113?tls=false';

  async onModuleInit(): Promise<void> {
    try {
      this.client = EventStoreDBClient.connectionString(this.connectionString);
      this.logger.log('Berhasil terhubung ke EventStoreDB');
    } catch (error: unknown) {
      this.logger.error('Gagal terhubung ke EventStoreDB', error);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.dispose();
      this.logger.log('Koneksi EventStoreDB ditutup');
    }
  }
}
```

### 3. Aggregate Root Rehydration

Aggregate ini akan memproses state berdasarkan rentetan event yang diberikan.

```typescript
export class BookingAggregate {
  public id: string;
  public status: 'INITIAL' | 'PENDING' | 'PAID' = 'INITIAL';
  public version: number = -1; // -1 untuk stream baru

  constructor(id: string) {
    this.id = id;
  }

  // Melakukan kalkulasi ulang state dari awal (Rehydration)
  public loadFromHistory(events: Array<{ type: string; data: unknown }>, expectedVersion: number): void {
    for (const event of events) {
      this.apply(event);
    }
    this.version = expectedVersion;
  }

  // Mutasi lokal berdasarkan event (tanpa menghasilkan event baru)
  private apply(event: { type: string; data: unknown }): void {
    switch (event.type) {
      case 'BookingCreated':
        this.status = 'PENDING';
        break;
      case 'PaymentAccepted':
        this.status = 'PAID';
        break;
      default:
        break;
    }
  }

  // Aksi domain yang menghasilkan list event yang baru untuk di-append
  public create(userId: string, roomId: string): BookingCreatedEvent[] {
    if (this.status !== 'INITIAL') {
      throw new Error('Booking sudah dibuat.');
    }
    const event: BookingCreatedEvent = {
      type: 'BookingCreated',
      data: { bookingId: this.id, userId, roomId, createdAt: new Date().toISOString() },
    };
    return [event];
  }

  public pay(amount: number): PaymentAcceptedEvent[] {
    if (this.status !== 'PENDING') {
      throw new Error('Booking tidak dalam status pending pembayaran.');
    }
    const event: PaymentAcceptedEvent = {
      type: 'PaymentAccepted',
      data: { bookingId: this.id, amount, paymentDate: new Date().toISOString() },
    };
    return [event];
  }
}
```

### 4. Repository (Event Sourcing Storage)

Repository hanya membaca stream dan menulis stream. Tidak ada operasi `UPDATE`.

```typescript
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { EventStoreService } from './event-store.service';
import { jsonEvent, FORWARDS, START, AppendExpectedRevision } from '@eventstore/db-client';
import { BookingAggregate } from './booking.aggregate';
import { BookingEvent } from './events.type';

@Injectable()
export class EventSourcingRepository {
  constructor(private readonly esdb: EventStoreService) {}

  private getStreamName(id: string): string {
    return `booking-${id}`;
  }

  async load(aggregateId: string): Promise<BookingAggregate> {
    const aggregate = new BookingAggregate(aggregateId);
    const streamName = this.getStreamName(aggregateId);
    const events: Array<{ type: string; data: unknown }> = [];
    let currentRevision = -1;

    try {
      const readResult = this.esdb.client.readStream(streamName, {
        direction: FORWARDS,
        fromRevision: START,
        maxCount: 1000,
      });

      for await (const resolvedEvent of readResult) {
        if (resolvedEvent.event) {
          events.push({
             type: resolvedEvent.event.type,
             data: resolvedEvent.event.data,
          });
          currentRevision = Number(resolvedEvent.event.revision);
        }
      }
      
      aggregate.loadFromHistory(events, currentRevision);
      return aggregate;
    } catch (error: unknown) {
       // Tangani error StreamNotFound jika itu stream baru
       const err = error as { type?: string };
       if (err.type === 'stream-not-found') {
          return aggregate; // Kembali dalam status 'INITIAL' dengan version -1
       }
       throw new InternalServerErrorException('Gagal membaca event stream');
    }
  }

  async save(
    aggregate: BookingAggregate,
    newEvents: BookingEvent[],
    expectedRevision: AppendExpectedRevision | bigint,
  ): Promise<void> {
    if (newEvents.length === 0) return;

    const streamName = this.getStreamName(aggregate.id);
    const eventData = newEvents.map((ev) => jsonEvent(ev));

    try {
      await this.esdb.client.appendToStream(streamName, eventData, {
        expectedRevision, // Optimistic Concurrency Control
      });
    } catch (error: unknown) {
      throw new InternalServerErrorException('Gagal menulis ke event stream. Kemungkinan ada konflik konkurensi (WrongExpectedVersionError).');
    }
  }
}
```

## Unit Test Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { BookingAggregate } from './booking.aggregate';
import { EventSourcingRepository } from './event-sourcing.repository';
import { EventStoreService } from './event-store.service';
import { NO_STREAM } from '@eventstore/db-client';

describe('EventSourcingRepository', () => {
  let repository: EventSourcingRepository;
  let esdbService: EventStoreService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventSourcingRepository,
        {
          provide: EventStoreService,
          useValue: {
            client: {
              readStream: jest.fn(),
              appendToStream: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    repository = module.get<EventSourcingRepository>(EventSourcingRepository);
    esdbService = module.get<EventStoreService>(EventStoreService);
  });

  it('seharusnya melakukan optimistic locking (expected revision)', async () => {
    const aggregate = new BookingAggregate('123');
    const events = aggregate.create('U1', 'R1');
    jest.spyOn(esdbService.client, 'appendToStream').mockResolvedValue({ success: true, position: { commit: 1n, prepare: 1n }, nextExpectedRevision: 0n });

    await repository.save(aggregate, events, NO_STREAM);

    expect(esdbService.client.appendToStream).toHaveBeenCalledWith(
      'booking-123',
      expect.any(Array),
      { expectedRevision: NO_STREAM }
    );
  });
  
  it('seharusnya menolak mutasi state yang tidak valid (Domain Logic)', () => {
    const aggregate = new BookingAggregate('123');
    // Memanggil pay() pada state 'INITIAL' harus gagal (butuh 'PENDING')
    expect(() => aggregate.pay(100)).toThrow('Booking tidak dalam status pending pembayaran.');
  });
});
```

## Analisis Trade-Off

**Kelebihan:**
1. **Audit Trail Mutlak (SSOT):** Event store tidak pernah menimpa data, sehingga kita bisa mengaudit sejarah penuh dari sistem secara absolut, atau melakukan *time-travel debugging*.
2. **Fleksibilitas Proyeksi:** Event dapat di-*replay* untuk membangun read model baru (misal proyeksi data analytics) tanpa mempengaruhi aplikasi yang sedang berjalan.
3. **Locking Bebas Konflik (Optimistic Concurrency Control):** Menggunakan `expectedRevision`, event tidak ditimpa; jika 2 transaksi mencoba merubah sistem secara paralel di atas versi data lampau, salah satu akan ditolak (WrongExpectedVersion).

**Kekurangan:**
1. **Kurva Pembelajaran Sangat Curam:** Pemikiran Developer harus diubah dari menyimpan 'current state' menjadi menyimpan 'fakta-fakta'.
2. **Kinerja Rehydration Menurun seiring Waktu:** Jika stream memiliki jutaan event (misal IoT telemetry), aggregate initialization akan sangat lambat kecuali diakali dengan pola "Snapshots".
3. **Kesulitan Refactoring Schema:** Mengubah payload event lama (schema evolution/versioning) sangat menyakitkan karena event masa lalu sifatnya mutlak dan tidak bisa di-update/delete.

## Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan "State Penuh" (Property Dumps) ke dalam Event
Event bukanlah DTO yang menahan state utuh, event adalah rekaman kejadian masa lalu.

```typescript
// ❌ SALAH: Menyimpan keseluruhan entitas dalam satu properti
export type BadEvent = JSONEventType<'BookingUpdated', { currentState: any }>; 
```

```typescript
// ✅ BENAR: Mendeskripsikan *APA* yang berubah
export type GoodEvent = JSONEventType<'BookingContactEmailChanged', { oldEmail: string, newEmail: string }>;
```

### ❌ Anti-Pattern 2: Tidak Menggunakan Snapshot pada Long-Living Streams
Membiarkan stream sebuah aggregate yang panjang umurnya tumbuh hingga ribuan event tanpa pernah melakukan snapshot state.

```typescript
// ❌ SALAH: Selalu me-load dari revision START
this.client.readStream('bank_account-A', { fromRevision: START }); // Menarik 50.000 events
```

```typescript
// ✅ BENAR: Mengambil Snapshot terakhir, lalu melanjutkan readStream dari (SnapshotRevision + 1)
const snapshot = await this.snapshotStore.get('bank_account-A');
this.client.readStream('bank_account-A', { fromRevision: snapshot.revision + 1n });
```

## Production Edge Cases

1. **GDPR / Right to be Forgotten:** Karena EventSourcing murni adalah sistem append-only dan immutable, menghapus data pribadi pelanggan dilarang. Solusi: Gunakan pola *Crypto-Shredding*. Enkripsi PII payload pada event menggunakan per-user encryption key yang disimpan pada database konvensional. Saat ada request GDPR penghapusan, hapus kunci dekripsinya.
2. **Event Schema Versioning (Upcasting):** Terjadi ketika aplikasi butuh bidang tambahan pada payload event lama. Solusi: Gunakan pola *Upcaster* untuk me-mapping struktur event lama (V1) ke struktur baru (V2) saat runtime saat dilakukan operasi `readStream()`.
3. **Optimistic Concurrency Exceptions:** Ketika konkurensi tabrakan (`WrongExpectedVersionError`), UI pengguna akan menerima error. Solusi: Kita dapat mempraktekkan *Automatic Retry with Re-Rehydration* di lapisan command handler sebelum menggagalkan proses ke pengguna.
