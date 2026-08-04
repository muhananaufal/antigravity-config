# Drizzle ORM Zero-Overhead SQL di NestJS

Drizzle ORM menawarkan abstraksi SQL yang luar biasa tipis, memberikan eksekusi query "*Zero-Overhead*" (tidak ada latensi lapisan model ekstra) dengan pengetikan TypeScript yang statis dan kuat. Integrasi Drizzle ke dalam arsitektur Dependency Injection (DI) NestJS memberikan keseimbangan sempurna antara kontrol SQL telanjang dan ekosistem NestJS.

## 1. Arsitektur DI & Eksekusi Cepat

Drizzle tidak memaksakan *Data Mapper* atau *Active Record*, melainkan murni query builder yang aman tipe.

```ascii
+-------------------+       +-----------------------+       +-------------------+
|                   |       |                       |       |                   |
|  NestJS Service   | ----> | Drizzle ORM Builder   | ----> | Postgres Driver   |
|  (DI Injected)    |       | (Zero Type Mapping)   |       | (pg / postgres.js)|
|                   |       |                       |       |                   |
+-------------------+       +-----------------------+       +-------------------+
                                       |
                                       v
                             +-------------------+
                             | Pure SQL Query    |
                             | Execution         |
                             +-------------------+
```

## 2. Definisi Skema (Type-Safe Schema Migration)

Skema Drizzle dideklarasikan dalam TypeScript dan menjadi *Single Source of Truth* untuk migrasi dan query.

```typescript
// schema.ts
import { pgTable, uuid, varchar, timestamp, integer, uniqueIndex } from 'drizzle-orm/pg-core';
import { InferSelectModel, InferInsertModel } from 'drizzle-orm';

export const usersTable = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  balance: integer('balance').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => {
  return {
    emailIdx: uniqueIndex('email_idx').on(table.email),
  };
});

export type User = InferSelectModel<typeof usersTable>;
export type NewUser = InferInsertModel<typeof usersTable>;
```

## 3. Integrasi NestJS Provider (Drizzle + Fastify)

Menginjeksi instance Drizzle via koneksi Postgres asli.

```typescript
// drizzle.module.ts
import { Module, Global } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export const DRIZZLE_DB = 'DRIZZLE_DB';
export type DrizzleDB = NodePgDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE_DB,
      useFactory: async () => {
        const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          max: 20, // max connection pool size
          idleTimeoutMillis: 30000,
        });
        
        // Membungkus pool postgres asli dengan drizzle
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DRIZZLE_DB],
})
export class DrizzleModule {}
```

## 4. Query Performansi Tinggi & Anti-Patterns

Drizzle bersinar dalam kueri relasional (Prepared Statements) tanpa *N+1*.

### ❌ Anti-Pattern: N+1 Looping
```typescript
// Sangat dihindari: Eksekusi iteratif menembus pool batas maksimum
async function getInvoicesBad(db: DrizzleDB, userIds: string[]): Promise<any[]> {
  const results = [];
  for (const id of userIds) {
    const user = await db.select().from(schema.usersTable).where(eq(schema.usersTable.id, id));
    // ini memicu roundtrip network berlebihan
    results.push(user[0]); 
  }
  return results;
}
```

### ✅ Best Practice: `inArray` Batch Fetching
```typescript
// repository.service.ts
import { Injectable, Inject } from '@nestjs/common';
import { DRIZZLE_DB, DrizzleDB } from './drizzle.module';
import { usersTable, User } from './schema';
import { inArray } from 'drizzle-orm';

@Injectable()
export class UserRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDB) {}

  async findUsersByIds(ids: string[]): Promise<User[]> {
    // Eksekusi: SELECT * FROM users WHERE id IN ($1, $2, ...)
    return this.db
      .select()
      .from(usersTable)
      .where(inArray(usersTable.id, ids))
      .execute();
  }
  
  async decrementBalance(userId: string, amount: number): Promise<void> {
    // Zero-overhead raw-like SQL update
    await this.db
      .update(usersTable)
      .set({ balance: sql`${usersTable.balance} - ${amount}` })
      .where(eq(usersTable.id, userId))
      .execute();
  }
}
```

## 5. Analisis Trade-Off

### Kelebihan
1. **Zero-Overhead & Performa Ekstrem:** Menghindari proses *mapping* dan *virtual fields* yang mahal. Query dieksekusi dengan kecepatan driver asli.
2. **Kontrol Penuh SQL:** Developer tahu persis SQL apa yang akan dihasilkan dari sintaks TS.
3. **Edge-Ready & Serverless:** Dapat berjalan optimal pada Vercel Edge, Cloudflare Workers, karena bebas ketergantungan native-bindings (berbeda dari Prisma).

### Kekurangan
1. **Sintaks Lebih Verbose:** Relasi tidak diambil semudah `include: true`, sehingga perlu penulisan `leftJoin` secara manual (meski Drizzle v0.30+ memiliki Relational Queries API).
2. **Ekosistem Migrasi Sederhana:** `drizzle-kit` hebat namun fiturnya belum setingkat Prisma Studio atau TypeORM `QueryRunner` dalam kasus skema *legacy*.
3. **Kurangnya Polimorfisme:** Pemodelan tabel yang kompleks seperti STI (Single Table Inheritance) harus dibuat murni dari nol.

## 6. Production Edge Cases

1. **Stale Data on Replicas:** Ketika melakukan read dari read-replica segera sesudah insert ke Primary (replication lag). Penanganan dilakukan dengan injeksi spesifik `db` instance yang koneksinya mengarah ke *Master node*.
2. **Type Inference Limit:** Ketika kueri *join* melibatkan belasan tabel, inferensi TypeScript dapat mengenai batas maksimum tipe *recursive* dan menurunkan performa IDE TS Server.
3. **Transaction Context Loss:** Jika tidak berhati-hati, memanggil `.execute()` di luar lingkup fungsi transaksional `db.transaction()` dapat menyebabkan *partial commits*.

## 7. Unit Testing (Jest)

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { UserRepository } from './user.repository';
import { DRIZZLE_DB } from './drizzle.module';
import { inArray } from 'drizzle-orm';

describe('UserRepository', () => {
  let repository: UserRepository;
  let mockDb: any;

  beforeEach(async () => {
    mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue([{ id: 'test-1', email: 'test@abc.com' }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserRepository,
        {
          provide: DRIZZLE_DB,
          useValue: mockDb,
        },
      ],
    }).compile();

    repository = module.get<UserRepository>(UserRepository);
  });

  it('should find users by ids using inArray', async () => {
    const result = await repository.findUsersByIds(['test-1']);
    
    expect(mockDb.select).toHaveBeenCalled();
    expect(mockDb.from).toHaveBeenCalled();
    expect(mockDb.where).toHaveBeenCalled();
    expect(mockDb.execute).toHaveBeenCalled();
    expect(result[0].id).toEqual('test-1');
  });
});
```

## 8. Drizzle-Kit Migrations Workflow

Drizzle-Kit adalah toolset CLI untuk menghasilkan dan menjalankan migrasi secara otomatis atau manual. Drizzle menghasilkan berkas migrasi `.sql` standar industri, yang memudahkan audit.

### Alur Kerja (Workflow)
1. **Perubahan Skema:** Ubah file `schema.ts`.
2. **Generate Migrasi:** Jalankan `npx drizzle-kit generate:pg` untuk membuat berkas SQL berdasarkan perbedaan (diff).
3. **Migrate/Push:** Eksekusi `npx drizzle-kit push:pg` (untuk tahap iterasi development) atau terapkan via skrip rilis terkendali (untuk production).

```typescript
// drizzle.config.ts
import type { Config } from 'drizzle-kit';
import * as dotenv from 'dotenv';
dotenv.config();

export default {
  schema: './src/db/schema.ts',
  out: './drizzle/migrations',
  driver: 'pg',
  dbCredentials: {
    connectionString: process.env.DATABASE_URL as string,
  },
  verbose: true,
  strict: true,
} satisfies Config;
```

### ✅ Best Practice: Migrasi Terkendali di CI/CD
Daripada memakai perintah `push` yang secara paksa menimpa state ke database production, gunakan skrip migrasi kustom:

```typescript
// scripts/migrate.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

async function runMigrations(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL as string,
    max: 1, // Batasi 1 koneksi khusus untuk migrasi eksklusif
  });
  const db = drizzle(pool);
  
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  console.log('Migrations complete!');
  
  await pool.end();
}

runMigrations().catch((err: unknown) => {
  console.error('Migration failed!', err);
  process.exit(1);
});
```

## 9. Prepared Statements Caching

Drizzle mendukung *Prepared Statements* untuk mencegah overhead kompilasi query oleh database pada query yang dipanggil berulang kali. Ini memaksimalkan performa *zero-overhead*.

### ✅ Best Practice: Prepare Sekali, Eksekusi Berkali-kali
```typescript
import { sql, eq } from 'drizzle-orm';
import { usersTable } from './schema';

// Deklarasikan di level modul/class, BUKAN di dalam blok request handler
const preparedUserById = db.select()
  .from(usersTable)
  .where(eq(usersTable.id, sql.placeholder('userId')))
  .prepare('get_user_by_id');

async function getUser(id: string) {
  // Eksekusi instan: postgres memakai query plan yang sudah dikompilasi & di-cache
  return await preparedUserById.execute({ userId: id });
}
```

**Trade-Off Prepared Statements:**
- **Kelebihan:** Mereduksi latensi query secara signifikan karena engine database melewati fase *parsing* dan *planning*.
- **Kekurangan:** Jika memiliki query dinamis yang jumlah parameternya terus berubah (misal: panjang `IN` array dinamis), jumlah *prepared statements* membengkak drastis dan menghabiskan *memory* internal PostgreSQL.

## 10. Type Inference Magic & Multi-Schema Support

### Multi-Schema (PostgreSQL Schemas)
Drizzle secara mulus memungkinkan pengelolaan beberapa skema PostgreSQL dalam satu aplikasi (seperti "public", "tenant_a", "tenant_b"), hal ini krusial untuk arsitektur *multi-tenancy*.

```typescript
// schemas/tenant.schema.ts
import { pgSchema, uuid, varchar } from 'drizzle-orm/pg-core';
import { InferSelectModel } from 'drizzle-orm';

// Mendefinisikan schema PostgreSQL khusus
export const tenantSchema = pgSchema('tenant_a');

export const tenantUsers = tenantSchema.table('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  department: varchar('department', { length: 100 }).notNull(),
});

export type TenantUser = InferSelectModel<typeof tenantUsers>;
```

### Type Inference Magic
Drizzle secara cerdas menginferensi tipe dari deklarasi skema, membedakan kolom nullable, boolean, union literals secara statis di TS 5+.

```typescript
import { BuildQueryResult, ExtractTablesWithRelations } from 'drizzle-orm';
import * as schema from './schema';

// Ekstraksi tipe hasil kueri relasional (Query Builder V2 API)
type Schema = typeof schema;
type TExtractTables = ExtractTablesWithRelations<Schema>;
type UserWithPostsAndProfile = BuildQueryResult<
  Schema,
  TExtractTables,
  'usersTable',
  {
    with: {
      posts: true;
      profile: true;
    };
  }
>;
```

## 11. JSONB Operations di PostgreSQL

PostgreSQL `JSONB` merupakan first-class citizen di Drizzle. Ini menjembatani utilitas *NoSQL* di atas keamanan data relasional.

### Definisi Skema JSONB
```typescript
import { pgTable, uuid, jsonb } from 'drizzle-orm/pg-core';
import { InferSelectModel } from 'drizzle-orm';

interface MetadataParams {
  lastLoginIp: string;
  preferences: Record<string, string | number | boolean>;
}

export const profilesTable = pgTable('profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  // Type-safety pada JSONB casting 
  metadata: jsonb('metadata').$type<MetadataParams>().notNull(),
});

export type Profile = InferSelectModel<typeof profilesTable>;
```

### ✅ Best Practice: Kueri JSONB Secara Cerdas
Selalu gunakan *raw* `sql` template literal untuk operasi *JSONB* kompleks dan pastikan *index* database dibuat.

```typescript
import { sql, eq } from 'drizzle-orm';

async function findProfilesByPreference(db: DrizzleDB, theme: string): Promise<Profile[]> {
  // Pemanfaatan index JSONB melalui operator Postgres spesifik (->>)
  return db.select()
    .from(profilesTable)
    .where(
      sql`${profilesTable.metadata}->'preferences'->>'theme' = ${theme}`
    )
    .execute();
}
```

### ❌ Anti-Pattern: Fetch Semua, Filter di Memory
```typescript
async function getThemeBad(db: DrizzleDB, theme: string): Promise<Profile[]> {
  // Bencana memori (OOM) pada tabel besar
  const allProfiles = await db.select().from(profilesTable).execute();
  return allProfiles.filter((p) => p.metadata.preferences?.theme === theme);
}
```

## 12. Zero-Trust Security & Row Level Security (RLS)

### Konsep RLS
PostgreSQL Row-Level Security (RLS) menjamin pengguna hanya bisa mengakses baris (row) mereka sendiri pada engine database. Drizzle mendukung konektivitas dengan *RLS Session* tanpa mengorbankan type-safety.

### ✅ Best Practice: Injeksi Sesi RLS per Request
Daripada memakai parameter *where* aplikasi, pada arsitektur isolasi multi-tenant kita bisa mengatur parameter sesi sesaat sebelum kueri dieksekusi.

```typescript
import { Injectable, Scope, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { DRIZZLE_DB, DrizzleDB } from './drizzle.module';
import { sql } from 'drizzle-orm';

interface RequestWithUser extends FastifyRequest {
  user: { tenantId: string };
}

@Injectable({ scope: Scope.REQUEST })
export class TenantService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    @Inject(REQUEST) private readonly request: RequestWithUser,
  ) {}

  async executeWithRls<T>(operation: (tx: DrizzleDB) => Promise<T>): Promise<T> {
    const tenantId = this.request.user.tenantId;

    // Transaction memastikan perintah SET LOCAL tidak tumpah ke koneksi lain di pool
    return this.db.transaction(async (tx) => {
      // Set konfigurasi lokal per-koneksi
      await tx.execute(sql`SET LOCAL "app.current_tenant" = ${tenantId}`);
      
      return operation(tx as unknown as DrizzleDB);
    });
  }
}
```

**Trade-Off RLS di Drizzle:**
- **Kelebihan:** Mengurangi risiko *human error* krusial; bila developer lupa menyertakan filter `WHERE tenant_id = ?`, database akan mencegah akses secara absolut.
- **Kekurangan:** Menurunkan efisiensi pool koneksi (adanya ekstra query `SET LOCAL` transaksional), dan tidak dapat menggunakan *prepared statements* secara global dengan maksimal.

## 13. Tambahan Edge Cases Produksi

4. **Connection Exhaustion di Serverless/Edge:** Karena arsitektur Drizzle bergantung pada *connection pool* asli (`pg`), eksekusi pada Vercel Functions atau AWS Lambda dapat melebihi kapasitas *pool* karena Node.js me-restart env. **Solusi:** Gunakan PgBouncer eksternal, layanan Prisma Accelerate proxy, atau integrasikan *driver* serverless spesifik seperti `@neondatabase/serverless`.
5. **JSONB Partial Updates:** Merubah hanya satu spesifik *key* di dalam obyek JSONB sangat kompleks. Drizzle belum mempunyai fungsi *builder* khusus untuk `jsonb_set`. Developer harus beralih penuh memakai API `sql` literal untuk menyusun kueri Postgres spesifik agar menghindari *race-conditions* pada update obyek secara utuh.
