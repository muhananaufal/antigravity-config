# Real-Time Read Model Projections & Denormalization (Eventual Consistency)

Konsep CQRS menyatakan bahwa arsitektur yang kuat akan memiliki model data baca yang sangat dioptimalkan, sering kali denormalisasi secara penuh, tanpa relasi asing (`JOIN`). Dalam Event Sourcing, Model Baca ini dibangun dan dipertahankan secara "Real-Time Asynchronous" dengan merefleksikan event stream menggunakan *Projections*.

## Arsitektur Proyeksi (Projection)

```ascii
[ EventStoreDB / Message Broker ]
         |
         | (Persistent Subscription / Change Data Capture)
         v
+-------------------+
| Projector Service | --- (Event: BookingCreated)
+-------------------+
         |
         v (Menerjemahkan event murni menjadi Dokumen NoSQL siap baca)
[ MongoDB (Read DB) ] 
{ _id: 'B123', userId: 'U1', room: 'R-Suite', status: 'Pending', search_index: 'U1 Suite' }
         |
         v
[ Client Query (GET /bookings/B123) -> Sangat cepat, O(1), No JOINs ]
```

## Implementasi Produksi

Contoh kita akan mendemonstrasikan bagaimana aplikasi NestJS berlangganan (*subscribe*) dari stream EventStoreDB menggunakan `subscribeToAll` dan secara asinkron memperbarui ElasticSearch atau MongoDB Read-Models (dalam contoh ini kita menggunakan repository memory array sebagai representasi DB Dokumen Mongoose/ElasticSearch).

### 1. Definisi Read Model dan Repository Sisi Baca (Mongo/Elastic)

```typescript
import { Injectable, Logger } from '@nestjs/common';

export interface BookingReadDocument {
  id: string;
  customerName: string; // Hasil denormalisasi dari UserService
  roomType: string;     // Hasil denormalisasi dari RoomService
  status: string;
  createdAt: string;
}

@Injectable()
export class DenormalizedReadRepository {
  // Simulasi MongoDB Collection/Elasticsearch Index
  private readonly collection = new Map<string, BookingReadDocument>();
  private readonly logger = new Logger(DenormalizedReadRepository.name);

  async upsert(id: string, partialDoc: Partial<BookingReadDocument>): Promise<void> {
    const existing = this.collection.get(id) || ({} as BookingReadDocument);
    const updated = { ...existing, ...partialDoc };
    this.collection.set(id, updated);
    this.logger.debug(`[ReadModel] Upsert ${id} -> ${JSON.stringify(updated)}`);
  }

  async findById(id: string): Promise<BookingReadDocument | null> {
    return this.collection.get(id) || null;
  }
}
```

### 2. Dependency Eksternal Resolvers (Untuk Denormalisasi)

Dalam sistem mikro, data *Customer Name* atau *Room Type* mungkin tidak tersedia pada Event payload `BookingCreated` (karena payload event hanya menyimpan ID referensi). Projector perlu men-denormalisasi dengan men-*fetch* (atau mem-cache) referensi tersebut saat event datang.

```typescript
import { Injectable } from '@nestjs/common';

@Injectable()
export class ExternalDataFetcher {
  async getCustomerName(userId: string): Promise<string> {
    // Simulasi memanggil API gRPC atau Redis Cache Service user
    return `User-${userId}`;
  }

  async getRoomType(roomId: string): Promise<string> {
    // Simulasi referensi room
    return roomId.startsWith('PREM') ? 'Premium' : 'Standard';
  }
}
```

### 3. Subscription & Projections Engine

Implementasikan sebuah daemon background (biasanya *Persistent Subscription* atau *Catch-Up Subscription*) yang selalu menyala mendengarkan dari akhir event log.

```typescript
import { Injectable, OnModuleInit, Logger, InternalServerErrorException } from '@nestjs/common';
import { EventStoreService } from './event-store.service';
import { DenormalizedReadRepository } from './read-repository';
import { ExternalDataFetcher } from './external-fetcher';
import { START } from '@eventstore/db-client';

@Injectable()
export class ProjectionService implements OnModuleInit {
  private readonly logger = new Logger(ProjectionService.name);

  constructor(
    private readonly esdb: EventStoreService,
    private readonly readRepo: DenormalizedReadRepository,
    private readonly fetcher: ExternalDataFetcher,
  ) {}

  async onModuleInit(): Promise<void> {
    this.startSubscription().catch((err: unknown) => {
      this.logger.error('Subscription loop terhenti kritis', err);
    });
  }

  private async startSubscription(): Promise<void> {
    // Dalam produksi, simpan Checkpoint (posisi stream yang terakhir diproses) ke DB.
    // Misal: const lastCheckpoint = await this.readRepo.getLastCheckpoint();
    // Di sini kita catch-up dari awal (START) setiap kali restart (hanya untuk demonstrasi).
    
    try {
        const subscription = this.esdb.client.subscribeToAll({
          fromPosition: START, // atau lastCheckpoint
        });

        for await (const resolvedEvent of subscription) {
          if (!resolvedEvent.event) continue;
          
          const type = resolvedEvent.event.type;
          const data = resolvedEvent.event.data as Record<string, unknown>;

          // Jangan memblokir event stream karena 1 event error. Terapkan Dead Letter Queue.
          try {
             await this.routeEvent(type, data);
             // await this.readRepo.saveCheckpoint(resolvedEvent.event.position);
          } catch (e: unknown) {
             this.logger.error(`Gagal memproyeksikan event ${type} ID: ${resolvedEvent.event.id}. Mengirim ke DLQ.`, e);
          }
        }
    } catch (err: unknown) {
        throw new InternalServerErrorException('Gagal subscribe ke event stream untuk proyeksi.', { cause: err });
    }
  }

  private async routeEvent(type: string, data: Record<string, unknown>): Promise<void> {
    switch (type) {
      case 'BookingCreated':
        await this.handleBookingCreated(data as { bookingId: string; userId: string; roomId: string; createdAt: string });
        break;
      case 'PaymentAccepted':
        await this.handlePaymentAccepted(data as { bookingId: string });
        break;
      default:
        // Hiraukan event sistem atau domain lain
        break;
    }
  }

  private async handleBookingCreated(data: { bookingId: string; userId: string; roomId: string; createdAt: string }): Promise<void> {
    // DENORMALISASI: Mengambil deskripsi lengkap saat build time read model
    const [customerName, roomType] = await Promise.all([
      this.fetcher.getCustomerName(data.userId),
      this.fetcher.getRoomType(data.roomId),
    ]);

    await this.readRepo.upsert(data.bookingId, {
      id: data.bookingId,
      customerName,
      roomType,
      status: 'PENDING',
      createdAt: data.createdAt,
    });
  }

  private async handlePaymentAccepted(data: { bookingId: string }): Promise<void> {
    await this.readRepo.upsert(data.bookingId, {
      status: 'PAID',
    });
  }
}
```

## Unit Test Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ProjectionService } from './projection.service';
import { DenormalizedReadRepository } from './read-repository';
import { ExternalDataFetcher } from './external-fetcher';
import { EventStoreService } from './event-store.service';

describe('ProjectionService', () => {
  let projectionService: ProjectionService;
  let readRepo: DenormalizedReadRepository;
  let fetcher: ExternalDataFetcher;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectionService,
        {
          provide: EventStoreService,
          useValue: { client: { subscribeToAll: jest.fn() } }, // Mocked
        },
        {
          provide: DenormalizedReadRepository,
          useValue: { upsert: jest.fn() },
        },
        {
          provide: ExternalDataFetcher,
          useValue: {
            getCustomerName: jest.fn().mockResolvedValue('Budi'),
            getRoomType: jest.fn().mockResolvedValue('VIP'),
          },
        },
      ],
    }).compile();

    projectionService = module.get<ProjectionService>(ProjectionService);
    readRepo = module.get<DenormalizedReadRepository>(DenormalizedReadRepository);
    fetcher = module.get<ExternalDataFetcher>(ExternalDataFetcher);
  });

  it('seharusnya mendenormalisasi data saat BookingCreated terjadi', async () => {
    // Akses metode private untuk testing behavior routing
    await (projectionService as any).routeEvent('BookingCreated', {
      bookingId: '123',
      userId: 'U1',
      roomId: 'R1',
      createdAt: '2023-01-01T00:00:00Z',
    });

    expect(fetcher.getCustomerName).toHaveBeenCalledWith('U1');
    expect(readRepo.upsert).toHaveBeenCalledWith('123', {
      id: '123',
      customerName: 'Budi',
      roomType: 'VIP',
      status: 'PENDING',
      createdAt: '2023-01-01T00:00:00Z',
    });
  });
});
```

## Analisis Trade-Off

**Kelebihan:**
1. **Query Ultra Cepat:** Klien tidak menggunakan `JOIN`. Semua informasi (User Info, Room Info, Status) telah dipanggang (pre-calculated) dalam bentuk JSON tunggal pada Read DB, siap di-serve dalam hitungan milidetik.
2. **Kemandirian Baca Tulis (High Availability):** Jika service Write atau EventStore (Tulis) down, Read-Model DB (misal MongoDB) tetap beroperasi dan aplikasi terus merespons query client secara stabil.
3. **Fleksibilitas Pencarian Kompleks:** Sangat mudah memproyeksikan stream yang sama ke mesin Search Engine murni seperti Elasticsearch untuk *Fuzzy Full-Text Search*, tanpa membebani Primary Database.

**Kekurangan:**
1. **Eventual Consistency:** Ada jendela waktu/delay asinkron (dalam satuan milidetik, hingga jam saat lag parah) dari penulisan (`AppendToStream`) hingga read-model selesai diperbarui (`Upsert Mongo`). Klien yang melakukan POST mungkin mendapat data lama (stale) setelah redirect GET.
2. **Duplikasi Data / Storage Membengkak:** Data seperti *Nama Customer* diduplikasi pada banyak tabel di Read-Model, memakan porsi besar RAM/Disk penyimpanan.
3. **Kompleksitas Checkpointing & Replay:** Kita harus secara teliti menyimpan state log *Position (Checkpoint)*, jika proyektor mati dan menyala kembali agar ia melanjutkan memproses dari checkpoint dan tidak mengulang dari 0 atau melewatkan data.

## Anti-Patterns

### ❌ Anti-Pattern 1: Query Sinkron melalui Projector
Mencoba mem-bypass Eventual Consistency dengan melakukan *Read-Your-Writes* blocking.

```typescript
// ❌ SALAH: Command Handler mem-polling Read Model secara sinkron sebelum return
await eventStore.appendToStream(...);
while(await readRepo.findById(id) === null) {
   await sleep(100); // Bad architecture, memblokir thread, beresiko timeout cascade
}
return "Sukses";
```
✅ BENAR: Biarkan Client HTTP/Frontend men-handle polling via WebSocket (Long Polling/Server Sent Events) jika membutuhkan feedback nyata ke pengguna. Klien bertanggung jawab membaca Eventual State.

### ❌ Anti-Pattern 2: Projector Tidak Idempoten
Pesan stream broker bisa terkirim minimal dua kali (*At-Least-Once Delivery*), maka proyektor harus tahan terhadap replay duplikat.

```typescript
// ❌ SALAH: Non-idempotent operation (nambah terus jumlahnya jika replay terjadi)
async handlePayment(data) {
   // UPDATE booking SET total_paid = total_paid + data.amount
}
```
✅ BENAR: Gunakan identitas absolut (`idempotency_key` pada query) atau overwrite penuh (Upsert `version` document > version yang lama).

## Production Edge Cases

1. **Massive Replay (Re-Projection) tanpa Zero-Downtime:** Saat struktur Read-Model perlu dirombak ulang, kita harus mendelete tabel MongoDB dan memulai proses `subscribeToAll` dari awal stream (Replay Jutaan Data). Ini bisa membuat aplikasi backend mati. Solusi: Lakukan pendekatan Blue/Green Projection Index. Bangun Read-Model baru di index berbeda (misal `v2_bookings_read`), lalu ketika replay selesai sinkron dengan real-time, ubah pointer Alias Router di aplikasi baca untuk menggunakan V2, lalu delete V1 di balik layar.
2. **Proyektor Crash karena Skema Berubah / Poison Event:** Jika satu event formatnya rusak, logika proyektor akan melempar exception `undefined is not a function`, dan akan di-retry loop selamanya oleh ESDB subscription (Poison Message / Head of line blocking). Solusi: Try-Catch ketat pada event parser dan selalu pindahkan event gagal ke log terpisah (DLQ/Dead Letter Queue), lalu commit ack stream untuk melanjutkan ke event berikutnya.
3. **Stale References pada Denormalisasi (Race Condition):** Event `CustomerNameUpdated` masuk sebelum event `BookingCreated`, sehingga waktu memproyeksikan booking, nama customer belum berubah. Solusi: Gunakan dependensi topologi Event ordering yang benar dari sumber hulu, atau buat "Join Projections" di EventStoreDb (melalui fitur server-side Projections Javascript engine eventstoredb).
