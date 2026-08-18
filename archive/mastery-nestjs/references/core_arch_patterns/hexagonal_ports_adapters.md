# Hexagonal Architecture (Ports & Adapters) murni di TypeScript dan NestJS

Arsitektur Hexagonal (atau Ports & Adapters) yang dicetuskan oleh Alistair Cockburn memisahkan inti logika bisnis (Domain) dari detail teknis (Database, HTTP/API, antarmuka pengguna). Dalam NestJS, ini krusial untuk mencegah kebocoran framework ke dalam Domain (misal, entitas domain tidak boleh memiliki decorator `@Entity` TypeORM atau decorator `@ApiProperty` Swagger).

## Topologi Arsitektur (Ports & Adapters)

```ascii
                      +-----------------------------------------+
                      |               Application               |
+----------------+    |   +---------------------------------+   |    +-----------------+
| Primary Adapters    |   |           Domain Core           |   |    | Secondary       |
| (Driving)      |    |   |                                 |   |    | Adapters        |
|                |    |   |                                 |   |    | (Driven)        |
| +------------+ |    |   |  +---------------------------+  |   |    | +-------------+ |
| | Controller |======|===|=>|     Primary Ports         |  |   |    | | Repository  | |
| | (HTTP)     | | In |   |  |     (Use Cases / APIs)    |  |   |    | | (Postgres)  | |
| +------------+ |    |   |  +---------------------------+  |   |    | +-------------+ |
|                |    |   |               |                 |   |    |       ^         |
| +------------+ |    |   |  +---------------------------+  |   |    |       |         |
| |  CLI/Cron  |======|===|=>|     Domain Entities &     |  |   |    |       |         |
| |  Adapter   | |    |   |  |     Business Rules        |  |   |    |       |         |
| +------------+ |    |   |  +---------------------------+  |   |    |       |         |
|                |    |   |               |                 |   |    |       |         |
|                |    |   |  +---------------------------+  |   |    | +-------------+ |
|                |    |   |  |     Secondary Ports       |  |   |    | | HTTP Client | |
|                |    |   |  |     (SPI / Interfaces)    |==|===|====> | (3rd Party) | |
+----------------+    |   |  +---------------------------+  |Out|    | +-------------+ |
                      |   +---------------------------------+   |    +-----------------+
                      +-----------------------------------------+
```

## Implementasi Murni TypeScript & NestJS 10+

Inti (Core) tidak boleh mengandung import dari `@nestjs/common` atau ORM apapun. Ia hanyalah kelas TypeScript murni.

### 1. Domain Layer (Pure TS)
```typescript
// src/domain/entities/order.entity.ts
export class Order {
  constructor(
    private readonly id: string,
    private readonly totalAmount: number,
    private status: 'PENDING' | 'PAID' | 'SHIPPED'
  ) {}

  public getId(): string {
    return this.id;
  }

  public getTotalAmount(): number {
    return this.totalAmount;
  }

  public getStatus(): string {
    return this.status;
  }

  public markAsPaid(): void {
    if (this.status !== 'PENDING') {
      throw new Error('Hanya pesanan PENDING yang bisa dibayar.');
    }
    this.status = 'PAID';
  }
}

// src/domain/ports/secondary/order.repository.interface.ts
// Port Sekunder: Didefinisikan di Domain, Diimplementasikan di Adapters
export interface OrderRepositoryPort {
  findById(id: string): Promise<Order | null>;
  save(order: Order): Promise<void>;
}

// src/domain/ports/primary/pay-order.usecase.ts
export interface PayOrderUseCase {
  execute(orderId: string): Promise<void>;
}

// src/domain/services/order.service.ts
// Tidak ada dekorator @Injectable() dari NestJS!
export class OrderService implements PayOrderUseCase {
  constructor(
    private readonly orderRepository: OrderRepositoryPort
  ) {}

  public async execute(orderId: string): Promise<void> {
    const order = await this.orderRepository.findById(orderId);
    if (!order) {
      throw new Error('Pesanan tidak ditemukan.');
    }
    order.markAsPaid();
    await this.orderRepository.save(order);
  }
}
```

### 2. Infrastructure/Framework Layer (NestJS)

```typescript
// src/infrastructure/adapters/secondary/postgres-order.repository.ts
import { Injectable } from '@nestjs/common';
import { OrderRepositoryPort } from '../../../domain/ports/secondary/order.repository.interface';
import { Order } from '../../../domain/entities/order.entity';

// Detail TypeORM diisolasi di sini
@Injectable()
export class PostgresOrderRepository implements OrderRepositoryPort {
  public async findById(id: string): Promise<Order | null> {
    // Simulasi Query Database
    if (id === '123') return new Order('123', 500, 'PENDING');
    return null;
  }

  public async save(order: Order): Promise<void> {
    // Simulasi Save ke Database
    console.log(`Menyimpan order ${order.getId()} dengan status ${order.getStatus()}`);
  }
}

// src/infrastructure/adapters/primary/order.controller.ts
import { Controller, Post, Param, Inject } from '@nestjs/common';
import { PayOrderUseCase } from '../../../domain/ports/primary/pay-order.usecase';

@Controller('orders')
export class OrderController {
  constructor(
    @Inject('PAY_ORDER_USE_CASE') 
    private readonly payOrderUseCase: PayOrderUseCase
  ) {}

  @Post(':id/pay')
  public async payOrder(@Param('id') id: string): Promise<{ message: string }> {
    try {
      await this.payOrderUseCase.execute(id);
      return { message: 'Pembayaran sukses.' };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown Error';
      return { message: errorMsg };
    }
  }
}

// src/infrastructure/modules/order.module.ts
import { Module } from '@nestjs/common';
import { OrderController } from '../adapters/primary/order.controller';
import { PostgresOrderRepository } from '../adapters/secondary/postgres-order.repository';
import { OrderService } from '../../../domain/services/order.service';

@Module({
  controllers: [OrderController],
  providers: [
    PostgresOrderRepository, // Sebagai detail
    {
      provide: 'ORDER_REPOSITORY_PORT',
      useExisting: PostgresOrderRepository
    },
    {
      provide: 'PAY_ORDER_USE_CASE',
      // Manual wiring agar Core tetap agnostik terhadap DI framework
      useFactory: (orderRepo: PostgresOrderRepository) => {
        return new OrderService(orderRepo);
      },
      inject: [PostgresOrderRepository]
    }
  ]
})
export class OrderModule {}
```

## Unit Test

```typescript
import { OrderService } from './order.service'; // src/domain/services/order.service.ts
import { Order } from '../entities/order.entity';
import { OrderRepositoryPort } from '../ports/secondary/order.repository.interface';

describe('OrderService (Domain Logic)', () => {
  let mockRepository: jest.Mocked<OrderRepositoryPort>;
  let orderService: OrderService;

  beforeEach(() => {
    mockRepository = {
      findById: jest.fn(),
      save: jest.fn(),
    };
    orderService = new OrderService(mockRepository);
  });

  it('should process payment and save order successfully', async () => {
    const order = new Order('123', 100, 'PENDING');
    mockRepository.findById.mockResolvedValue(order);

    await orderService.execute('123');

    expect(mockRepository.findById).toHaveBeenCalledWith('123');
    expect(order.getStatus()).toBe('PAID');
    expect(mockRepository.save).toHaveBeenCalledWith(order);
  });

  it('should throw error if order not found', async () => {
    mockRepository.findById.mockResolvedValue(null);
    await expect(orderService.execute('999')).rejects.toThrow('Pesanan tidak ditemukan.');
  });
});
```

## Analisis Trade-Off

**Kelebihan:**
1. **Agnostik Framework:** Domain tidak terkunci (vendor lock-in) pada NestJS, TypeORM, atau Prisma. Migrasi ke Fastify atau Express murni jadi lebih mudah.
2. **Testabilitas Superior:** Logika bisnis 100% bisa dites (unit test) secepat kilat tanpa booting IoC NestJS.
3. **Pemisahan Perhatian (Separation of Concerns) Mutlak:** Bug di layer database (SQL error) tidak akan merembes mengubah aturan bisnis.

**Kekurangan:**
1. **Boilerplate Tinggi:** Memerlukan antarmuka (ports), implementasi (adapters), dan mapper untuk mengonversi Entity ORM ke Entity Domain.
2. **Overhead Mapper:** Mengonversi data dari format DB (ActiveRecord/Data Mapper) ke Domain murni setiap query berimbas pada performa dan CPU memori di HFT (High-Frequency Trading).
3. **Kurva Pembelajaran:** Developer pemula kesulitan memahami mengapa mereka tidak boleh menyuntikkan (inject) repository langsung ke controller.

## Anti-Patterns

### ❌ Anti-Pattern 1: Bocornya TypeORM Decorators ke Domain Entity
```typescript
// src/domain/entities/user.ts
import { Entity, PrimaryGeneratedColumn } from 'typeorm'; // Bencana!

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  public id: string;
}
```

### ✅ Solusi Benar: Pisahkan ORM Entity dan Domain Entity
```typescript
// src/infrastructure/db/typeorm-user.entity.ts (Hanya untuk TypeORM)
// src/domain/entities/user.ts (Pure TypeScript kelas biasa)
```

### ❌ Anti-Pattern 2: Domain Layer mengembalikan HTTP Status Codes
```typescript
export class UserService {
  public getUser() {
     // Domain tidak boleh tahu soal HTTP (404, 200).
     throw new HttpException('User not found', 404);
  }
}
```

### ✅ Solusi Benar: Domain melempar DomainError (Business Exception), lalu Primary Adapter (Filter di NestJS) memetakannya ke HTTP Status.

## Production Edge Cases

1. **Transaction Management Lintas Adapter:** Karena Domain Service tidak tahu apa itu `QueryRunner` atau transaksi database, mengorkestrasi transaksi ACID 2-fase menjadi sangat rumit. Solusinya membutuhkan pola Unit of Work di dalam layer Adapter.
2. **Kinerja Mapping Skala Besar:** Mengubah array berisi 10,000 ORM entities menjadi Domain objects di memori menyebabkan _Garbage Collection pauses_ dan Out-Of-Memory (OOM) fatal. Solusi: Gunakan CQRS (lewat Bypass Read/Projection Model) khusus untuk pengambilan data besar.
3. **Validasi Data vs Business Rules:** Bentrok antara validasi DTO HTTP (menggunakan `class-validator`) dan invariant entitas Domain. Pastikan validasi format (contoh: regex email) ada di DTO, sedangkan validasi bisnis (contoh: stok cukup) ada di Domain.
