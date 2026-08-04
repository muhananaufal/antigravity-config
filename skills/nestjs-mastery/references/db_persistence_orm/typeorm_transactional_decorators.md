# TypeORM Transactional Decorators di NestJS

Salah satu kekurangan terbesar arsitektur N-Tier pada Node.js adalah proporsi *Transaction Boundary*. Melewatkan objek *QueryRunner* atau *EntityManager* melintasi semua fungsi service sangat mengotori kode. Dengan bantuan `cls-hooked` (atau `AsyncLocalStorage` dari Node.js core), kita dapat menciptakan dekorator `@Transactional()` transparan.

## 1. Arsitektur AsyncLocalStorage (ALS) Transaction

ALS memungkinkan kita menyimpan state dalam rantai *asynchronous execution* (seperti `ThreadLocal` di Java).

```ascii
+--------------------+        +---------------------+       +-------------------+
|  HTTP Request (A)  |        | AsyncLocalStorage   |       |  Database Pool    |
| -> Controller      | -----> | [Store: TxRunner A] | ----> | -> Connection A   |
|   -> @Transactional|        +---------------------+       +-------------------+
|      -> Service 1  |                  |
|      -> Service 2  | <----------------+ (Get Entity Manager for Tx A)
+--------------------+
```

## 2. Implementasi Kustom `@Transactional()`

Alih-alih menggunakan pustaka eksternal pihak ketiga yang sering kali tidak diurus (*unmaintained*), ini adalah implementasi standar produksi dengan `AsyncLocalStorage`.

```typescript
// transaction.context.ts
import { AsyncLocalStorage } from 'async_hooks';
import { EntityManager } from 'typeorm';

export const transactionContext = new AsyncLocalStorage<EntityManager>();

export function getTransactionalEntityManager(): EntityManager | undefined {
  return transactionContext.getStore();
}
```

Dekorator ini akan menangkap *EntityManager*, memulai transaksi, dan menyimpannya ke dalam *Store* konteks asinkron.

```typescript
// transactional.decorator.ts
import { Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { transactionContext } from './transaction.context';

export function Transactional() {
  const injectDataSource = Inject(DataSource);

  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    
    // Injeksi DataSource ke prototype agar bisa diambil
    injectDataSource(target, 'dataSource');

    descriptor.value = async function (...args: any[]) {
      const dataSource: DataSource = this.dataSource;
      
      if (!dataSource) {
        throw new Error('DataSource not found. Did you forget to import TypeOrmModule?');
      }

      // Jika kita sudah berada di dalam transaksi, gunakan yang ada (Propagation.REQUIRED)
      const existingManager = transactionContext.getStore();
      if (existingManager) {
        return originalMethod.apply(this, args);
      }

      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        const result = await transactionContext.run(queryRunner.manager, async () => {
          return await originalMethod.apply(this, args);
        });

        await queryRunner.commitTransaction();
        return result;
      } catch (err) {
        await queryRunner.rollbackTransaction();
        throw err;
      } finally {
        await queryRunner.release();
      }
    };
    
    return descriptor;
  };
}
```

## 3. Repositori Context-Aware (Custom Base Repository)

Repository wajib menggunakan *transactional manager* yang tersimpan di ALS, atau *fallback* ke koneksi global.

```typescript
// base.repository.ts
import { Repository, ObjectLiteral, EntityManager } from 'typeorm';
import { getTransactionalEntityManager } from './transaction.context';

export class BaseRepository<T extends ObjectLiteral> extends Repository<T> {
  protected get manager(): EntityManager {
    const transactionalEntityManager = getTransactionalEntityManager();
    // Gunakan tx manager jika ada, jika tidak fallback ke manager asli
    return transactionalEntityManager ?? super.manager;
  }

  // Override method dasar untuk memastikan menggunakan manager yang benar
  async saveTx(entity: T): Promise<T> {
    return this.manager.save(this.target, entity);
  }
}
```

## 4. Anti-Patterns & Best Practices

### ❌ Anti-Pattern: Propagasi Explicit QueryRunner
```typescript
// Kode kotor dan sulit dirawat
async processPaymentBad(userId: string, amount: number, queryRunner: QueryRunner): Promise<void> {
  await this.userService.decrementBalance(userId, amount, queryRunner);
  await this.invoiceService.createInvoice(userId, amount, queryRunner); // Repot!
}
```

### ✅ Best Practice: Clean @Transactional Decorator
```typescript
// user.service.ts
import { Injectable } from '@nestjs/common';
import { Transactional } from './transactional.decorator';
import { UserRepository } from './user.repository';
import { InvoiceRepository } from './invoice.repository';

@Injectable()
export class PaymentService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly invoiceRepo: InvoiceRepository,
  ) {}

  @Transactional()
  async processPaymentGood(userId: string, amount: number): Promise<void> {
    // Semua operasi di bawah ini akan berada dalam 1 sesi transaksi DB yang sama
    const user = await this.userRepo.findOneBy({ id: userId });
    user.balance -= amount;
    
    await this.userRepo.saveTx(user);
    await this.invoiceRepo.saveTx(this.invoiceRepo.create({ userId, amount }));
    // Jika saveTx di atas melempar error, seluruh transaksi akan otomatis rollback!
  }
}
```

## 5. Analisis Trade-Off

### Kelebihan
1. **Clean Code & SRP:** Logika bisnis tidak terpolusi oleh orkestrasi teknikal Database.
2. **Reusabilitas:** Fungsi repositori dapat dipakai dalam keadaan transaksional maupun non-transaksional secara aman.
3. **Atomic Operations:** Menghindari risiko parsial state (inkonsistensi data) apabila eksekusi mati di tengah jalan.

### Kekurangan
1. **Magic Behavior:** Eksekusi menjadi sangat tersembunyi. Junior developer mungkin bingung mengapa transaksi di-rollback secara tiba-tiba.
2. **ALS Overhead:** `AsyncLocalStorage` pada lingkungan Node.js dengan konkurensi masif (10K+ req/sec) memiliki overhead performa minor (sekitar 3-5% penurunan throughput).
3. **Event Emitter Pitfall:** Kehilangan konteks `AsyncLocalStorage` jika rantai *Promise* terputus, misalnya melalui *Event Emitter* Node.js atau *callback* lama.

## 6. Production Edge Cases

1. **Deadlock Lock Contention:** `Row Share Lock` yang sering bertabrakan akibat multiple `@Transactional()` bersamaan. Pencegahannya adalah selalu mengurutkan operasi modifikasi (Update/Delete) di seluruh sistem dalam urutan alfabetis nama tabel.
2. **Third-Party API Timeout:** Melakukan HTTP request lambat di *tengah-tengah* blok `@Transactional()` menyebabkan koneksi database *idle* terblokir, menguras pool koneksi secara drastis. Selalu selesaikan HTTP request *sebelum* membuka blok transaksional.
3. **Nested Transactions:** `Transaction Propagation` yang tidak didukung secara native. Jika di dalam `@Transactional()` terdapat pemanggilan fungsi ber-`@Transactional()` lain, implementasi di atas akan mengabaikan dekorator kedua. Butuh fitur Savepoint untuk *nested transactions*.

## 7. Unit Testing (Jest)

```typescript
import { transactionContext } from './transaction.context';
import { BaseRepository } from './base.repository';

describe('BaseRepository Tx Injection', () => {
  it('should use transactional manager if inside ALS store', () => {
    const mockTransactionalManager = { save: jest.fn() } as any;
    const mockGlobalManager = { save: jest.fn() } as any;
    
    // Inisialisasi custom Repo
    const repo = new BaseRepository<any>(null, mockGlobalManager);

    // Jalankan dalam konteks transaksi
    transactionContext.run(mockTransactionalManager, async () => {
      await repo.saveTx({ id: 1 });
      
      expect(mockTransactionalManager.save).toHaveBeenCalled();
      expect(mockGlobalManager.save).not.toHaveBeenCalled();
    });
  });

  it('should use global manager if outside ALS store', async () => {
    const mockGlobalManager = { save: jest.fn() } as any;
    const repo = new BaseRepository<any>(null, mockGlobalManager);

    await repo.saveTx({ id: 2 });
    
    expect(mockGlobalManager.save).toHaveBeenCalled();
  });
});
```
