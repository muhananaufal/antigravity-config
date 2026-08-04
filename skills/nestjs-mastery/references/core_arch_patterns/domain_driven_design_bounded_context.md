# Domain-Driven Design (DDD) dan Bounded Context dalam NestJS

Domain-Driven Design (DDD) adalah pendekatan pengembangan perangkat lunak sentris pada model bisnis kompleks. Dalam NestJS, DDD sangat cocok dikombinasikan dengan arsitektur modular. Konsep utamanya meliputi Bounded Context, Aggregate Root, Entity murni, dan Value Object yang abadi (immutable).

## Topologi Bounded Context & Aggregates

Sebuah aplikasi e-commerce tidak boleh memiliki satu kelas 'User' raksasa. Ia harus dibagi dalam batasan kontekstual (Bounded Context).

```ascii
+--------------------------------------------------------------------------+
|                       E-Commerce Enterprise System                       |
|                                                                          |
|   +--------------------------+          +--------------------------+     |
|   |  Bounded Context: INVENTORY |          |   Bounded Context: SALES |     |
|   |  (NestJS InventoryModule)   |          |    (NestJS SalesModule)  |     |
|   |                             |          |                          |     |
|   |   +-------------------+     |          |   +------------------+   |     |
|   |   | Aggregate Root:   |     |  Events  |   | Aggregate Root:  |   |     |
|   |   | ProductItem       |--------(RabbitMQ)----->| Order            |   |     |
|   |   |                   |     |          |   |                  |   |     |
|   |   | - ProductId (VO)  |     |          |   | - OrderId (VO)   |   |     |
|   |   | - StockQuantity   |     |          |   | - OrderLines     |   |     |
|   |   +-------------------+     |          |   +------------------+   |     |
|   +--------------------------+          +--------------------------+     |
+--------------------------------------------------------------------------+
```

## Implementasi DDD Murni: Value Objects & Aggregates

Pilar utama DDD adalah *Value Object* (VO) yang murni, terikat enkapsulasi, dan abadi (immutable). *Aggregate Root* melindungi integritas aturan bisnis.

```typescript
// --- 1. Value Object (Immutable, Diidentifikasi dari nilainya) ---
export class Money {
  constructor(
    private readonly amount: number,
    private readonly currency: string
  ) {
    if (amount < 0) throw new Error('Amount tidak boleh negatif.');
    if (currency.length !== 3) throw new Error('Currency harus 3 huruf ISO.');
  }

  public getAmount(): number { return this.amount; }
  public getCurrency(): string { return this.currency; }

  public add(other: Money): Money {
    if (this.currency !== other.currency) {
      throw new Error('Tidak bisa menjumlah mata uang berbeda.');
    }
    return new Money(this.amount + other.amount, this.currency);
  }

  public equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency;
  }
}

// --- 2. Aggregate Root (Mengontrol Entitas Internal) ---
export class OrderLine {
  constructor(
    public readonly productId: string,
    public readonly quantity: number,
    public readonly price: Money
  ) {}

  public getSubtotal(): Money {
    return new Money(this.price.getAmount() * this.quantity, this.price.getCurrency());
  }
}

export class OrderAggregateRoot {
  private readonly id: string;
  private lines: OrderLine[] = [];
  private status: 'NEW' | 'CONFIRMED' = 'NEW';

  constructor(id: string) {
    this.id = id;
  }

  public getId(): string {
    return this.id;
  }

  // Melindungi invarian bisnis: Hanya root yang boleh memanipulasi line
  public addLine(productId: string, quantity: number, price: Money): void {
    if (this.status !== 'NEW') {
      throw new Error('Tidak bisa merubah pesanan yang sudah konfirmasi.');
    }
    this.lines.push(new OrderLine(productId, quantity, price));
  }

  public calculateTotal(): Money {
    if (this.lines.length === 0) return new Money(0, 'USD');
    return this.lines.reduce(
      (acc, curr) => acc.add(curr.getSubtotal()),
      new Money(0, 'USD')
    );
  }

  public confirm(): void {
    if (this.lines.length === 0) throw new Error('Pesanan kosong.');
    this.status = 'CONFIRMED';
  }
}
```

## NestJS Modularization (Bounded Context Boundaries)

Dalam NestJS, pastikan Bounded Context tidak saling _import_ repository secara langsung, guna mencegah "Spaghetti Code".

```typescript
import { Module } from '@nestjs/common';
// Modul Inventory (Bounded Context 1)
@Module({})
export class InventoryModule {}

// Modul Sales (Bounded Context 2)
@Module({})
export class SalesModule {}

// Modul Root Aplikasi
@Module({
  imports: [InventoryModule, SalesModule],
  // TIDAK ADA ketergantungan melintang (cross-import) entitas secara ketat
})
export class AppModule {}
```

## Unit Test (Validasi Value Object & Aggregate)

```typescript
describe('DDD Constructs', () => {
  describe('Money Value Object', () => {
    it('should throw error on negative amount', () => {
      expect(() => new Money(-10, 'USD')).toThrow('Amount tidak boleh negatif.');
    });

    it('should add amounts with same currency', () => {
      const m1 = new Money(100, 'IDR');
      const m2 = new Money(200, 'IDR');
      const total = m1.add(m2);
      expect(total.getAmount()).toBe(300);
      expect(total.equals(new Money(300, 'IDR'))).toBe(true);
    });

    it('should throw error when adding different currencies', () => {
      const m1 = new Money(100, 'USD');
      const m2 = new Money(200, 'IDR');
      expect(() => m1.add(m2)).toThrow('Tidak bisa menjumlah mata uang berbeda.');
    });
  });

  describe('Order Aggregate Root', () => {
    it('should calculate total correctly and enforce invariants', () => {
      const order = new OrderAggregateRoot('ord-1');
      order.addLine('prod-1', 2, new Money(50, 'USD')); // 100
      order.addLine('prod-2', 1, new Money(25, 'USD')); // 25
      
      const total = order.calculateTotal();
      expect(total.getAmount()).toBe(125);

      order.confirm();
      expect(() => order.addLine('prod-3', 1, new Money(10, 'USD')))
        .toThrow('Tidak bisa merubah pesanan yang sudah konfirmasi.');
    });
  });
});
```

## Analisis Trade-Off

**Kelebihan:**
1. **Bahasa Ubiquitous:** Penamaan dalam kode sama persis dengan bahasa yang digunakan tim bisnis, menghilangkan gap komunikasi (domain experts vs engineers).
2. **Proteksi Invariant Kuat:** Menghindari status _invalid_ di database. Data dikontrol super ketat di memori oleh Aggregate Root.
3. **Skalabilitas Bisnis:** Mudah dipecah menjadi Microservices mandiri karena _Bounded Context_ sudah mengatur demarkasi secara eksplisit.

**Kekurangan:**
1. **Over-engineering Berbahaya:** Menggunakan DDD untuk sistem CRUD sederhana (seperti CMS dasar) hanya membuang waktu dan biaya eksekusi tim.
2. **Kesulitan Sinkronisasi Eventual:** Karena antar-modul tidak boleh query database silang, penggabungan data (joins) harus diganti menjadi _Eventual Consistency_ / sinkronisasi via Message Broker.
3. **Biaya Transformasi:** Butuh serialisasi/deserialisasi terus-menerus antara ORM (Database Entities) dan Domain Model murni, menuntut boilerplate konverter yang besar.

## Anti-Patterns

### ❌ Anti-Pattern 1: Anemic Domain Model
Entitas hanya berisi getter dan setter (atau DTO telanjang) tanpa logika bisnis internal, sehingga logika berceceran di layer `Service`.
```typescript
class AnemicOrder {
  public id: string;
  public total: number;
  public status: string;
}
// Logika bisnis di luar entitas:
class OrderService {
  public confirmOrder(order: AnemicOrder) {
    order.status = 'CONFIRMED'; // Pelanggaran enkapsulasi fatal.
  }
}
```

### ✅ Solusi Benar: Rich Domain Model (Seperti contoh `OrderAggregateRoot` di atas). Logika, state, dan transisi diatur dari dalam.

### ❌ Anti-Pattern 2: Aggregate Root Berbagi Referensi Objek
Menyimpan Object Aggregate Root lain di dalam sebuah Aggregate, yang memicu deadlocks/kunci baris (row locking) DB ganda.
```typescript
class OrderAggregate {
  // Salah: Memegang instance penuh dari Aggregate User
  constructor(public user: UserAggregate) {} 
}
```

### ✅ Solusi Benar: Merujuk menggunakan Identifier
```typescript
class OrderAggregate {
  constructor(public userId: string) {} 
}
```

## Production Edge Cases

1. **Concurrency Modification:** Dua request secara paralel (HTTP) mengambil Aggregate yang sama, merubahnya, lalu menyimpannya ke DB. Tanpa mekanisme Optimistic Concurrency Control (Optimistic Locking via kolom `@VersionNumber`), transaksi akan menimbulkan lost-update yang fatal.
2. **Kinerja Bulk Insert:** Karena aggregate divalidasi satu persatu oleh objek domain, eksekusi Batch/Bulk import (misal 50,000 baris CSV) menjadi terhambat bottleneck validasi instansiasi. Harus di-bypass menggunakan metode Fast-Track/ETL khusus bila diperlukan.
3. **Agregat Menjadi Raksasa:** Aggregate mendesain batas transaksi yang membesar (God Object) sehingga setiap kali ada satu _line item_ berubah, seluruh agregat beserta ratusan turunannya ditarik dari DB. Hal ini akan mematikan performa I/O memori seketika. Solusi: batas agregat harus didesain sekecil mungkin.
