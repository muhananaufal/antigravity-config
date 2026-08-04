# CQRS dan Event Sourcing dengan `@nestjs/cqrs`

Command Query Responsibility Segregation (CQRS) adalah pola ekstrem yang memisahkan operasi mutasi data (Commands) dari operasi pengambilan data (Queries). Saat dipadukan dengan Event Sourcing, state aplikasi bukanlah "baris dalam tabel saat ini", melainkan kalkulasi/rekonstruksi dari seluruh Event (sejarah perubahan) yang pernah terjadi sejak sistem dimulai.

## Topologi Command, Event, dan Projection Query

```ascii
+----------------+      [ Command Bus ] ------> [ Command Handler ]
|                |             |                       |
|                |             |                       v
|  HTTP Request  |             |              (Validasi & Eksekusi di Aggregate)
| (Controller)   |             |                       |
|                |             |                       v
|                |             |              [ Event Store (Write DB) ]
+----------------+             |                       |  (Menyimpan Event, misal 'OrderCreated')
       ^                       |                       v
       |                       |                (Event Bus)
       |                       |                       |
       |                       v                       v
       +---------------- [ Query Bus ]        [ Event Handlers ] 
                               |                       |
                               |                       v
                        [ Query Handler ] <--- [ Read Model DB / Elastic / Redis ]
                                                    (Proyeksi Materialized View)
```

## Implementasi Inti (NestJS + TypeScript)

Menggunakan modul bawaan NestJS `@nestjs/cqrs` untuk orkestrasi message-bus lokal.

```typescript
import { AggregateRoot, CommandHandler, ICommandHandler, EventPublisher, EventsHandler, IEventHandler, QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { Injectable } from '@nestjs/common';

// --- 1. Definisi Events & Commands ---
export class MoneyDepositedEvent {
  constructor(public readonly accountId: string, public readonly amount: number) {}
}

export class DepositMoneyCommand {
  constructor(public readonly accountId: string, public readonly amount: number) {}
}

export class GetAccountBalanceQuery {
  constructor(public readonly accountId: string) {}
}

// --- 2. Aggregate Root (Event Sourcing Style) ---
export class AccountAggregate extends AggregateRoot {
  private id: string;
  private balance: number = 0;

  constructor(id: string) {
    super();
    this.id = id;
  }

  // Mutasi logika bisnis, menghasilkan event baru (belum di-commit ke DB)
  public deposit(amount: number): void {
    if (amount <= 0) throw new Error('Deposit harus lebih dari 0.');
    // Menerbitkan uncommitted event internal
    this.apply(new MoneyDepositedEvent(this.id, amount));
  }

  // EVENT HANDLER (Internal Aggregate untuk merekonstruksi state masa lalu)
  public onMoneyDepositedEvent(event: MoneyDepositedEvent): void {
    this.balance += event.amount;
  }

  public getBalance(): number {
    return this.balance;
  }
}

// --- 3. Command Handler (Write Model) ---
@CommandHandler(DepositMoneyCommand)
export class DepositMoneyHandler implements ICommandHandler<DepositMoneyCommand> {
  constructor(private readonly publisher: EventPublisher) {}

  public async execute(command: DepositMoneyCommand): Promise<void> {
    // Pada skenario nyata: Load aggregate history dari Event Store Database, 
    // namun di sini kita inisiasi sederhana.
    const account = this.publisher.mergeObjectContext(new AccountAggregate(command.accountId));
    
    account.deposit(command.amount);
    
    // Commit men-dispatch events ke EventBus lokal NestJS & (idealnya) ke DB Store
    account.commit(); 
  }
}

// --- 4. Event Handler (Membangun Read Model Projection) ---
@EventsHandler(MoneyDepositedEvent)
export class MoneyDepositedProjectionHandler implements IEventHandler<MoneyDepositedEvent> {
  public async handle(event: MoneyDepositedEvent): Promise<void> {
    // Memperbarui database Read-Only (MongoDB, Redis, Elasticsearch, dll)
    console.log(`[PROJECTION UPDATE] Akun ${event.accountId} menambah Rp${event.amount}`);
  }
}

// --- 5. Query Handler (Read Model) ---
@QueryHandler(GetAccountBalanceQuery)
export class GetAccountBalanceHandler implements IQueryHandler<GetAccountBalanceQuery> {
  public async execute(query: GetAccountBalanceQuery): Promise<{ balance: number }> {
    // Hanya membaca proyeksi yang sudah pre-calculated dari Read DB (Super cepat)
    return { balance: 1000 }; // Simulasi membaca Redis
  }
}
```

## Unit Test

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { CommandBus, CqrsModule, EventBus } from '@nestjs/cqrs';

describe('CQRS Bank Account flow', () => {
  let commandBus: CommandBus;
  let eventBus: EventBus;
  let eventHandlerMock: jest.Mock;

  beforeEach(async () => {
    eventHandlerMock = jest.fn();

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [CqrsModule],
      providers: [
        DepositMoneyHandler,
        {
          provide: MoneyDepositedProjectionHandler,
          useValue: { handle: eventHandlerMock }
        }
      ],
    }).compile();

    commandBus = moduleRef.get(CommandBus);
    eventBus = moduleRef.get(EventBus);
    
    // Registrasi handler ke bus
    commandBus.register([DepositMoneyHandler]);
    eventBus.register([moduleRef.get(MoneyDepositedProjectionHandler) as any]);
  });

  it('should process command and dispatch event for projection', async () => {
    const cmd = new DepositMoneyCommand('acc-1', 500);
    await commandBus.execute(cmd);

    expect(eventHandlerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc-1',
        amount: 500
      })
    );
  });

  it('should fail on negative deposit', async () => {
    const cmd = new DepositMoneyCommand('acc-1', -100);
    await expect(commandBus.execute(cmd)).rejects.toThrow('Deposit harus lebih dari 0.');
  });
});
```

## Analisis Trade-Off

**Kelebihan:**
1. **Audit Trail Sempurna:** Event Sourcing tidak pernah menghapus / update data. Semua riwayat adalah "Append-Only Immutable Event", fitur wajib untuk Fintech, Ledger Keuangan, dan perbankan.
2. **Kinerja Baca Ekstrem:** Read Models dapat dibentuk secara khusus (misal: JSON datar ke Redis atau Elastic) menghindari operasi SQL Join yang mahal.
3. **Time-Traveling Debugging:** State sistem dapat dimundurkan atau direkonstruksi ulang (Replay Events) untuk mencari kapan tepatnya bug terjadi di masa lalu.

**Kekurangan:**
1. **Kompleksitas Asinkronisasi:** Konsistensi eventual membuat pembacaan pasca-mutasi kadang tidak seketika (Stale Reads). UI butuh polling atau WebSocket.
2. **Evolusi Schema Event:** Merubah struktur Event di masa depan sangat sulit. Event versi lama di database tetap bertahan dan menuntut _Upcaster_ kompleks.
3. **Kurva Pembelajaran Tajam:** Penggabungan Command Bus, Event Bus, Aggregate, Saga, dan Store DB membengkakkan basecode ratusan persen dibandingkan arsitektur Monolitik biasa.

## Anti-Patterns

### ❌ Anti-Pattern 1: Query/Read Model langsung mengakses Event Store Table
Melakukan agregasi `SELECT SUM(amount) FROM events` per request di database Event Store (karena malas bikin Proyeksi) membunuh performa dan mengalahkan seluruh esensi CQRS.
```typescript
@QueryHandler(GetBalanceQuery)
export class BadQueryHandler {
  async execute() {
    // Fatal: Melakukan kalkulasi berat on-the-fly dari raw events!
    return await this.db.query("SUM(amount) from event_store where agg_id='...'"); 
  }
}
```

### ✅ Solusi Benar: Baca dari Tabel/Proyeksi terpisah (Read Model) yang diperbarui oleh EventHandler secara asinkron di latar belakang.

### ❌ Anti-Pattern 2: Command Handler memanggil Command Handler lain secara langsung
Menimbulkan _Deadlock_ tersembunyi pada bus dan _spaghetti commands_.
```typescript
class DepositHandler {
  async execute() {
    // SANGAT BURUK! Command merantai Command!
    await this.commandBus.execute(new AnotherCommand());
  }
}
```

### ✅ Solusi Benar: Command Handler -> Emit Events. Jika butuh koreografi multy-step, gunakan Pola SAGA (@Saga() decorator di NestJS) untuk mengkoordinasikan reaksi terhadap Event.

## Production Edge Cases

1. **Optimistic Concurrency (Event Versioning):** Jika dua request menembak Aggregate sama di saat sama, mereka akan membangkitkan `Event Version 2` yang sama di Event Store (Duplicate Key Version Exception). Solusi: Implementasi retry logic mekanikal yang menarik ulang Aggregate terkini.
2. **Event Broker Outage:** Jika PostgreSQL Event Store sukses namun RabbitMQ/Kafka gagal ter-publish, Sinkronisasi Projection DB akan selamanya tertinggal (_Ghost Update_). Solusi: Pola Transactional Outbox.
3. **Ukuran Aggregate Sourcing Meledak:** Menarik data aggregate yang memiliki >10,000 riwayat event memakan RAM mematikan dan latensi parah. Solusi: Menerapkan _Snapshotting_ (menyimpan state utuh setiap 100 event).
