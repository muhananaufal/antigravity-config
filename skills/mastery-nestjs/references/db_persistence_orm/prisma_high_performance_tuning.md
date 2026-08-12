# Prisma High Performance Tuning di Lingkungan NestJS Tekanan Ekstrem

Prisma ORM v5+ menawarkan kapabilitas luar biasa, namun pada skala enterprise (ribuan RPS), performanya dapat terdegradasi tanpa tuning khusus. Dokumen ini membahas mitigasi masalah kinerja N+1 query, konfigurasi *Connection Pooling* menggunakan PgBouncer, dan pemanfaatan *Prisma Client Extensions* untuk pengawasan query tingkat lanjut.

## 1. Arsitektur Connection Pooling (PgBouncer)

Pada lingkungan microservices, setiap instance aplikasi membuka koneksi ke database. Tanpa pengelola koneksi sentral, database PostgreSQL akan kehabisan *Max Connections*. PgBouncer dalam *Transaction Mode* menjadi krusial di sini, di mana koneksi ke database dikembalikan ke *pool* segera setelah transaksi selesai (alih-alih menunggu sesi klien berakhir). Hal ini memungkinkan ribuan koneksi klien (aplikasi NestJS) di-multiplexing ke dalam puluhan koneksi database fisik secara efisien.

### ❌ Anti-Pattern: Tanpa Eksternal Pooling di Kubernetes
Tanpa PgBouncer, saat HPA (Horizontal Pod Autoscaler) melakukan *scale-out* tiba-tiba (misal 50 pod, masing-masing dengan `connection_limit=10`), PostgreSQL akan langsung menolak koneksi (`too many clients already`), mengakibatkan *cascading failure* di seluruh sistem.

### ✅ Best Practice: Prisma dengan PgBouncer (Transaction Mode)
Pastikan URL koneksi Prisma menambahkan parameter `?pgbouncer=true` dan PgBouncer diatur dengan mode *transaction*.

```ascii
+-------------------+        +--------------------+        +---------------------+
|   NestJS App 1    |        |                    |        |                     |
|  (Prisma Client)  |=======>|                    |        |                     |
+-------------------+        |    PgBouncer       |=======>|   PostgreSQL DB     |
                             |  (Transaction      |        |   (Max Conn: 100)   |
+-------------------+        |     Mode)          |=======>|                     |
|   NestJS App 2    |=======>|                    |        |                     |
|  (Prisma Client)  |        +--------------------+        +---------------------+
+-------------------+
```

## 2. Implementasi Prisma Client Extensions untuk Observabilitas

Kita wajib mengukur waktu eksekusi setiap query untuk mendeteksi *slow queries* di sistem *production*.

```typescript
// prisma.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';

const logger = new Logger('PrismaExtension');

export const extendedPrismaClient = () => {
  const prisma = new PrismaClient({
    log: [{ emit: 'event', level: 'query' }],
  });

  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const start = performance.now();
          const result = await query(args);
          const end = performance.now();
          const duration = end - start;

          if (duration > 50) {
            logger.warn(`[SLOW QUERY] ${model}.${operation} took ${duration.toFixed(2)}ms`);
          }

          return result;
        },
      },
    },
  });
};

export type ExtendedPrismaClient = ReturnType<typeof extendedPrismaClient>;

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  public readonly client: ExtendedPrismaClient;

  constructor() {
    this.client = extendedPrismaClient();
  }

  async onModuleInit(): Promise<void> {
    await (this.client as unknown as PrismaClient).$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await (this.client as unknown as PrismaClient).$disconnect();
  }
}
```

## 3. Mitigasi N+1 Query: `include` vs `select`

### ❌ Anti-Pattern: N+1 Query Manual (Sangat Lambat)
```typescript
// Anti-pattern: Mengambil relasi di dalam loop (N+1 Problem)
async getUsersWithPostsBad(userIds: string[]): Promise<any[]> {
  const users = await this.prisma.client.user.findMany({
    where: { id: { in: userIds } }
  });
  
  const result = [];
  for (const user of users) {
    const posts = await this.prisma.client.post.findMany({
      where: { authorId: user.id }
    });
    result.push({ ...user, posts });
  }
  return result;
}
```

### ✅ Best Practice: Relational `include` dan `select` Murni
```typescript
import { Prisma } from '@prisma/client';

// Menggunakan tipe yang di-*infer* langsung dari query untuk Type-Safety
type UserWithPosts = Prisma.UserGetPayload<{
  select: {
    id: true;
    email: true;
    posts: {
      select: {
        title: true;
        createdAt: true;
      }
    }
  }
}>;

async getUsersWithPostsGood(userIds: string[]): Promise<UserWithPosts[]> {
  // Hanya mengeksekusi 1 query (JOIN) tanpa over-fetching
  return this.prisma.client.user.findMany({
    where: { id: { in: userIds } },
    select: {
      id: true,
      email: true,
      posts: {
        select: {
          title: true,
          createdAt: true,
        },
      },
    },
  });
}
```

## 4. Analisis Trade-Off

### Kelebihan
1. **Type-Safety Maksimal:** Tipe data di-generate berdasarkan skema, mencegah runtime *undefined errors*.
2. **Developer Experience (DX):** Auto-completion yang sangat baik mempercepat waktu pengembangan.
3. **Fleksibilitas Extension:** *Prisma Client Extensions* memudahkan injeksi logika observabilitas, RLS (Row Level Security), dan soft-deletes.

### Kekurangan
1. **Memory Overhead:** Prisma memiliki mesin Rust di baliknya (Query Engine) yang mengonsumsi lebih banyak memori.
2. **Kompleksitas Query Ekstrem:** Sulit mengoptimalkan query yang sangat kompleks (contoh: multiple nested window functions).
3. **Cold Start Time:** Memiliki ukuran bundel yang cukup besar sehingga memperlambat startup time, terutama pada arsitektur Serverless.

## 5. Production Edge Cases

1. **Max Connection Exhaustion:** Ketika pod scale out secara drastis (contoh: Kubernetes HPA dari 2 ke 50 pod), tanpa PgBouncer transaksi akan gagal dengan error `sorry, too many clients already`.
2. **Transaction Deadlocks:** Memulai prisma transaction berskala besar pada baris yang sering diperbarui (contoh: decrement balance) dapat menyebabkan deadlock. Wajib gunakan indeks unik dan mitigasi isolasi tingkat `Serializable`.
3. **Data Over-fetching:** Menggunakan `include: { relation: true }` pada tabel dengan kolom `TEXT` atau `BYTEA` yang besar dapat menyumbat bandwidth network dan CPU serialisasi JSON.

## 6. Unit Testing dengan Mocking Database

```typescript
// prisma.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

describe('PrismaService Data Access', () => {
  let service: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    service = module.get<PrismaService>(PrismaService);

    // Mock implementation untuk test tanpa menembak DB betulan
    jest.spyOn(service.client.user, 'findMany').mockResolvedValue([
      {
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as import('@prisma/client').Prisma.UserGetPayload<{}>
    ]);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should fetch users efficiently', async () => {
    const users = await service.client.user.findMany({
      where: { id: { in: ['user-1'] } },
      select: { id: true, email: true },
    });

    expect(service.client.user.findMany).toHaveBeenCalledTimes(1);
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe('user-1');
  });
});
```

## 7. Prisma Accelerate (Edge Caching)

Untuk API dengan rasio *read/write* yang tinggi (contoh: katalog produk, halaman artikel), latensi database dapat dipangkas signifikan menggunakan **Prisma Accelerate**. Ini menyediakan *Global Edge Cache* dan *Connection Pooling* terkelola.

### ✅ Best Practice: Edge Caching Strategy
Dengan Accelerate, query dapat di-*cache* di tingkat global (Edge) dengan penentuan TTL (Time-To-Live) dan SWR (Stale-While-Revalidate).

```typescript
// prisma.service.ts
// Contoh import dan instalasi @prisma/extension-accelerate diperlukan
import { withAccelerate } from '@prisma/extension-accelerate';
import { PrismaClient } from '@prisma/client';

export const extendedPrismaClientAccelerate = () => {
  const prisma = new PrismaClient().$extends(withAccelerate());
  return prisma;
};

// Penggunaan SWR (Stale-While-Revalidate) Cache di Service
async function getTrendingProducts(prismaClient: ReturnType<typeof extendedPrismaClientAccelerate>): Promise<unknown[]> {
  // Hanya contoh struktur: Cache selama 60 detik, revalidasi background hingga 120 detik
  return prismaClient.user.findMany({
    where: { email: { contains: 'trending' } },
    cacheStrategy: {
      ttl: 60,
      swr: 120,
    },
  });
}
```

### Trade-Off Prisma Accelerate
**Kelebihan**: Latensi turun drastis ke hitungan milidetik; mengurangi beban komputasi PostgreSQL.
**Kekurangan**: Adanya potensi *stale data* karena sifat *eventual consistency*; menambah biaya langganan layanan (jika menggunakan cloud Prisma).

## 8. Query Analyzer (EXPLAIN ANALYZE) di Prisma

Prisma secara *default* menyembunyikan query SQL asli. Namun, untuk *troubleshooting* performa, kita harus menggunakan `EXPLAIN ANALYZE` di PostgreSQL untuk melihat jalur eksekusi query (contoh: *Sequential Scan* vs *Index Scan*).

### ✅ Best Practice: Menangkap Raw SQL untuk EXPLAIN
Kita bisa menggunakan API `$queryRawUnsafe` untuk menjalankan `EXPLAIN ANALYZE` jika diperlukan. Di production, pertimbangkan extension khusus yang mencatat *slow queries* secara otomatis.

```typescript
// Cara mengambil raw query dari Prisma untuk EXPLAIN ANALYZE
async function analyzeSlowQuery(prisma: PrismaClient): Promise<unknown> {
  const result = await prisma.$queryRawUnsafe(`
    EXPLAIN ANALYZE 
    SELECT "id", "email" 
    FROM "User" 
    WHERE "email" = 'user@example.com'
  `);
  return result;
}
```
Dengan melihat metrik `Execution Time` dan `Planning Time` dari *output* di atas, pengembang dapat memastikan apakah indeks digunakan dengan benar.

## 9. Strategi Composite Index (Indeks Komposit)

Kueri yang sering memfilter berdasarkan lebih dari satu kolom secara bersamaan (misal: mencari berdasarkan `tenantId` dan `status`) wajib diberikan *Composite Index*.

### ❌ Anti-Pattern: Missing Composite Index
Jika sering melakukan kueri `WHERE tenantId = ? AND status = ?` tanpa composite index, database akan melakukan filter lambat atau memakan waktu CPU berlebih, meskipun setiap kolom memiliki indeks individu.

### ✅ Best Practice: Deklarasi Composite Index di Prisma Schema
Definisikan indeks gabungan pada blok `@@index`. Pastikan kolom dengan kardinalitas tertinggi atau yang di-query menggunakan kesamaan (`=`) diletakkan paling awal (contoh: *B-Tree index left-prefix rule*).

```prisma
// schema.prisma
model Order {
  id        String   @id @default(uuid())
  tenantId  String
  status    String
  createdAt DateTime @default(now())

  // Indeks Komposit: Sangat cepat untuk kueri WHERE tenantId = X AND status = Y
  @@index([tenantId, status, createdAt(sort: Desc)])
}
```

### Edge Cases pada Composite Index
1. **Urutan Kolom Krusial**: Indeks `(A, B, C)` dapat digunakan untuk query dengan filter `A`, atau `A AND B`, atau `A AND B AND C`. Namun, indeks ini **tidak** akan dipakai optimal untuk query yang hanya memfilter `B` atau `C`.
2. **Write Penalty**: Setiap penambahan indeks memperlambat operasi *INSERT*, *UPDATE*, dan *DELETE*. Jangan asal membuat indeks tanpa melihat metrik penggunaan dari `pg_stat_user_indexes`.

## 10. N+1 Detection Middleware

Meskipun `include` pada Prisma mengurangi risiko, *N+1 problem* bisa terjadi melalui pemanggilan fungsi berulang di layer *Service* atau *Resolver* GraphQL. Kita dapat membangun sistem deteksi N+1 menggunakan ALS (AsyncLocalStorage) di NestJS.

### ✅ Best Practice: ALS-based N+1 Detector
```typescript
import { AsyncLocalStorage } from 'async_hooks';

// Secara arsitektur, ALS menyimpan "jumlah query" per request.
export const queryContextALS = new AsyncLocalStorage<{ queryCount: number; path: string }>();

// Di dalam Prisma Extension (Bisa disuntikkan di AppModule):
/*
prisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const store = queryContextALS.getStore();
        if (store) {
          store.queryCount++;
          if (store.queryCount > 50) { // Ambang batas N+1
            console.error(`[N+1 DETECTED] Path: ${store.path} mengeksekusi > 50 kueri!`);
          }
        }
        return query(args);
      },
    },
  },
})
*/
```
Teknik ini sangat ampuh dalam mencegah kebocoran *N+1 problem* ke *production* dengan menolak atau memberikan *alert* bila jumlah kueri melewati ambang wajar pada satu siklus request.
