# NestJS CQRS: CommandBus, QueryBus, EventBus, & Saga Handlers Setup

Arsitektur Command Query Responsibility Segregation (CQRS) memisahkan secara tegas antara operasi yang memutasi status (Command) dengan operasi yang membaca status (Query). Pada level aplikasi NestJS, pola ini diimplementasikan menggunakan paket resmi `@nestjs/cqrs`.

## Arsitektur CQRS di NestJS

```ascii
+-------------------+        +----------------+       +-------------------+
|    Controllers    | -----> |   CommandBus   | ----> |  CommandHandlers  | -> Mutate DB
+-------------------+        +----------------+       +-------------------+
        |                                                       |
        |                                                       v
        |                                             +-------------------+
        |                                             |     EventBus      |
        |                                             +-------------------+
        |                                                       |
        |                                                       v
        |                                             +-------------------+
        |                                             |   EventHandlers   | -> Update Read DB / External Systems
        v                                             +-------------------+
+-------------------+        +----------------+       +-------------------+
|    Controllers    | -----> |    QueryBus    | ----> |   QueryHandlers   | -> Read from Read DB
+-------------------+        +----------------+       +-------------------+
```

## Implementasi Produksi

Berikut adalah contoh implementasi modul reservasi hotel (Booking) yang memanfaatkan CQRS secara lengkap, tanpa kompromi pada type-safety.

### 1. Definisi Command, Query, dan Event

```typescript
import { ICommand, IQuery, IEvent } from '@nestjs/cqrs';

// --- Commands ---
export class CreateBookingCommand implements ICommand {
  constructor(
    public readonly bookingId: string,
    public readonly userId: string,
    public readonly roomId: string,
    public readonly checkIn: Date,
    public readonly checkOut: Date,
  ) {}
}

export class ConfirmBookingCommand implements ICommand {
  constructor(public readonly bookingId: string) {}
}

// --- Queries ---
export class GetBookingQuery implements IQuery {
  constructor(public readonly bookingId: string) {}
}

export class GetUserBookingsQuery implements IQuery {
  constructor(public readonly userId: string) {}
}

// --- Events ---
export class BookingCreatedEvent implements IEvent {
  constructor(
    public readonly bookingId: string,
    public readonly userId: string,
    public readonly roomId: string,
  ) {}
}

export class BookingConfirmedEvent implements IEvent {
  constructor(public readonly bookingId: string) {}
}
```

### 2. Command Handlers & Event Publisher

```typescript
import { CommandHandler, EventPublisher, ICommandHandler } from '@nestjs/cqrs';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { CreateBookingCommand } from './commands.cqrs';
import { BookingCreatedEvent } from './events.cqrs';
import { AggregateRoot } from '@nestjs/cqrs';

// Aggregate Root Dummy
export class BookingAggregate extends AggregateRoot {
  constructor(private readonly id: string) {
    super();
  }

  createBooking(userId: string, roomId: string): void {
    // Logika domain di sini
    this.apply(new BookingCreatedEvent(this.id, userId, roomId));
  }
}

@Injectable()
export class BookingRepository {
  async save(aggregate: BookingAggregate): Promise<void> {
    // Simpan status agregat ke database
    return Promise.resolve();
  }
}

@CommandHandler(CreateBookingCommand)
export class CreateBookingHandler implements ICommandHandler<CreateBookingCommand> {
  constructor(
    private readonly repository: BookingRepository,
    private readonly publisher: EventPublisher,
  ) {}

  async execute(command: CreateBookingCommand): Promise<string> {
    const { bookingId, userId, roomId } = command;
    try {
      // 1. Buat instance agregat
      const aggregate = this.publisher.mergeObjectContext(new BookingAggregate(bookingId));
      
      // 2. Eksekusi logika domain yang akan trigger apply() event
      aggregate.createBooking(userId, roomId);
      
      // 3. Simpan state (dalam event sourcing ini simpan event, dalam state-based simpan current state)
      await this.repository.save(aggregate);
      
      // 4. Commit trigger dispatch Events ke EventBus
      aggregate.commit();
      
      return bookingId;
    } catch (error: unknown) {
       if (error instanceof Error) {
           throw new InternalServerErrorException(`Gagal membuat booking: ${error.message}`);
       }
       throw new InternalServerErrorException('Kesalahan tak terduga saat membuat booking');
    }
  }
}
```

### 3. Query Handlers

```typescript
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { GetBookingQuery } from './queries.cqrs';
import { Injectable, NotFoundException } from '@nestjs/common';

export interface BookingReadModel {
  id: string;
  userId: string;
  roomId: string;
  status: string;
}

@Injectable()
export class BookingReadRepository {
  async findById(id: string): Promise<BookingReadModel | null> {
    // Baca dari read-optimized database (misal: MongoDB/Elasticsearch/Redis)
    return Promise.resolve({ id, userId: 'U123', roomId: 'R456', status: 'PENDING' });
  }
}

@QueryHandler(GetBookingQuery)
export class GetBookingHandler implements IQueryHandler<GetBookingQuery, BookingReadModel> {
  constructor(private readonly readRepo: BookingReadRepository) {}

  async execute(query: GetBookingQuery): Promise<BookingReadModel> {
    const booking = await this.readRepo.findById(query.bookingId);
    if (!booking) {
      throw new NotFoundException(`Booking dengan ID ${query.bookingId} tidak ditemukan.`);
    }
    return booking;
  }
}
```

### 4. Sagas untuk Orkestrasi Proses Panjang

```typescript
import { Injectable } from '@nestjs/common';
import { Saga, ICommand, ofType } from '@nestjs/cqrs';
import { Observable } from 'rxjs';
import { map, delay } from 'rxjs/operators';
import { BookingCreatedEvent } from './events.cqrs';
import { ConfirmBookingCommand } from './commands.cqrs';

@Injectable()
export class BookingSagas {
  @Saga()
  bookingCreated = (events$: Observable<unknown>): Observable<ICommand> => {
    return events$.pipe(
      ofType(BookingCreatedEvent),
      // Simulasi proses async pihak ketiga, misalnya validasi fraud
      delay(1000),
      map((event: BookingCreatedEvent) => {
        // Memicu command baru setelah event terjadi
        return new ConfirmBookingCommand(event.bookingId);
      }),
    );
  };
}
```

### 5. Controller (Titik Masuk)

```typescript
import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CreateBookingCommand } from './commands.cqrs';
import { GetBookingQuery } from './queries.cqrs';
import { randomUUID } from 'crypto';

interface CreateBookingDto {
  userId: string;
  roomId: string;
  checkIn: string;
  checkOut: string;
}

@Controller('bookings')
export class BookingController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Post()
  async create(@Body() dto: CreateBookingDto): Promise<{ id: string }> {
    const bookingId = randomUUID();
    const command = new CreateBookingCommand(
      bookingId,
      dto.userId,
      dto.roomId,
      new Date(dto.checkIn),
      new Date(dto.checkOut)
    );
    const id = await this.commandBus.execute<CreateBookingCommand, string>(command);
    return { id };
  }

  @Get(':id')
  async getBooking(@Param('id') id: string): Promise<unknown> {
    const query = new GetBookingQuery(id);
    return this.queryBus.execute(query);
  }
}
```

### 6. Module Setup

```typescript
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { BookingController } from './booking.controller';
import { CreateBookingHandler } from './create-booking.handler';
import { GetBookingHandler } from './get-booking.handler';
import { BookingSagas } from './booking.sagas';
import { BookingRepository } from './booking.repository';
import { BookingReadRepository } from './booking-read.repository';

export const CommandHandlers = [CreateBookingHandler];
export const QueryHandlers = [GetBookingHandler];

@Module({
  imports: [CqrsModule],
  controllers: [BookingController],
  providers: [
    BookingRepository,
    BookingReadRepository,
    ...CommandHandlers,
    ...QueryHandlers,
    BookingSagas,
  ],
})
export class BookingModule {}
```

## Unit Test Suite

Pengujian CQRS melibatkan mocking `CommandBus` atau repositori.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { CreateBookingHandler, BookingRepository } from './create-booking.handler';
import { CreateBookingCommand } from './commands.cqrs';
import { EventPublisher } from '@nestjs/cqrs';

describe('CreateBookingHandler', () => {
  let handler: CreateBookingHandler;
  let repository: BookingRepository;
  let publisher: EventPublisher;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateBookingHandler,
        {
          provide: BookingRepository,
          useValue: { save: jest.fn() },
        },
        {
          provide: EventPublisher,
          useValue: {
            mergeObjectContext: jest.fn().mockImplementation((obj) => {
              obj.commit = jest.fn();
              return obj;
            }),
          },
        },
      ],
    }).compile();

    handler = module.get<CreateBookingHandler>(CreateBookingHandler);
    repository = module.get<BookingRepository>(BookingRepository);
    publisher = module.get<EventPublisher>(EventPublisher);
  });

  it('seharusnya mengeksekusi command dan menyimpan agregat', async () => {
    const command = new CreateBookingCommand('ID1', 'USER1', 'ROOM1', new Date(), new Date());
    jest.spyOn(repository, 'save').mockResolvedValue(undefined);

    const result = await handler.execute(command);

    expect(result).toBe('ID1');
    expect(repository.save).toHaveBeenCalled();
    expect(publisher.mergeObjectContext).toHaveBeenCalled();
  });
});
```

## Analisis Trade-Off

**Kelebihan:**
1. **Skalabilitas Terpisah:** Command (Write) dan Query (Read) bisa di-scale secara independen sesuai beban masing-masing.
2. **Kinerja Baca Optimal:** Query handler tidak terbebani oleh lock database tulis, bisa membaca langsung dari read-model (denormalisasi).
3. **Pemisahan Konteks (Decoupling):** Logika bisnis menjadi sangat tunggal dan kohesif; class handler hanya menangani 1 use-case spesifik.

**Kekurangan:**
1. **Kompleksitas Kode Meningkat:** Membutuhkan lebih banyak boilerplate (Class Command, Handler, Event).
2. **Eventual Consistency:** Aplikasi read-model mungkin sedikit tertinggal (stale) dari write-model, menyebabkan kebingungan UI sesaat.
3. **Tracing Sulit:** Melacak alur eksekusi asinkron dari Command -> Event -> Saga -> Command Lain sangat menantang jika tidak ada korelasi ID.

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengembalikan Data Domain/Entity dari Command Handler
Command seharusnya murni mutasi status (mengembalikan `void` atau hanya identitas entitas baru), jangan mengembalikan state penuh.

```typescript
// ❌ SALAH: Command Handler mengembalikan state entitas (melanggar prinsip CQRS)
@CommandHandler(CreateBookingCommand)
export class WrongCreateBookingHandler {
  async execute(command: CreateBookingCommand): Promise<BookingEntity> {
    const entity = await this.repo.save(command);
    return entity; // DILARANG di CQRS murni!
  }
}
```

```typescript
// ✅ BENAR: Hanya mengembalikan ID agar client melakukan Query terpisah
@CommandHandler(CreateBookingCommand)
export class CorrectCreateBookingHandler {
  async execute(command: CreateBookingCommand): Promise<string> {
    const id = await this.repo.save(command);
    return id; 
  }
}
```

### ❌ Anti-Pattern 2: Memanggil QueryBus di dalam Command Handler
Command Handler yang memanggil Query Handler menciptakan kopling erat dan merusak pemisahan tanggung jawab.

```typescript
// ❌ SALAH: Command Handler mengeksekusi query.
@CommandHandler(UpdateStatusCommand)
export class WrongUpdateHandler {
  constructor(private queryBus: QueryBus) {}
  async execute(command: UpdateStatusCommand) {
    const current = await this.queryBus.execute(new GetBookingQuery(command.id));
    // ... mutasi state ...
  }
}
```

```typescript
// ✅ BENAR: Inject langsung ReadRepository atau Domain Service jika butuh data sebelum mutasi
@CommandHandler(UpdateStatusCommand)
export class CorrectUpdateHandler {
  constructor(private repository: WriteRepository) {}
  async execute(command: UpdateStatusCommand) {
    const current = await this.repository.findById(command.id); // Akses sisi write!
    // ... mutasi state ...
  }
}
```

## Production Edge Cases

1. **Idempotensi Command:** Request retry dari client HTTP (misal: akibat timeout jaringan) akan mengirim Command yang sama 2x. Solusi: Gunakan Redis untuk memeriksa apakah `requestId` unik dari command tersebut sudah diproses dalam waktu tertentu, dan tolak duplikat.
2. **Saga Failures / Compensating Transactions:** Jika saga yang terdiri dari 3 step gagal pada step ke-3, tidak ada transaksi database tunggal untuk me-rollback step 1 dan 2. Solusi: Saga harus men-dispatch `Compensating Command` (misalnya `CancelBookingCommand`) secara eksplisit untuk me-revert state sebelumnya.
3. **Event Loss saat Server Crash:** `aggregate.commit()` men-dispatch event in-memory melalui `@nestjs/cqrs`. Jika server crash tepat setelah record DB tersimpan namun sebelum event terkirim, EventHandlers tidak akan pernah tereksekusi. Solusi: Implementasi **Outbox Pattern**. Simpan payload event dalam tabel database (transaksi yang sama dengan data mutasi), lalu gunakan sistem *polling* atau *CDC (Change Data Capture)* untuk mem-publish-nya ke message broker (Kafka/RabbitMQ).
