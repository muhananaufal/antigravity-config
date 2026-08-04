# Arsitektur Multi-Tenancy Berbasis Postgres Row Level Security (RLS) di NestJS

## Pendahuluan

Arsitektur multi-tenancy dengan Row Level Security (RLS) pada PostgreSQL menawarkan tingkat keamanan dan isolasi data tertinggi pada model basis data terbagi (Shared Database, Shared Schema). Dengan RLS, kebijakan akses data ditegakkan langsung oleh mesin basis data (database engine), bukan oleh lapisan aplikasi (ORM/Query Builder). Hal ini secara efektif mencegah kebocoran data antar-tenant (tenant data bleed) yang disebabkan oleh kelalaian pengembang dalam menyertakan klausa `WHERE tenant_id = ?` pada setiap *query*. Dalam ekosistem NestJS, implementasi ini dicapai dengan mencegat alur *request*, mengekstrak identitas tenant, dan menyuntikkannya sebagai variabel sesi tingkat lokal (`SET LOCAL`) sebelum transaksi atau *query* dijalankan.

## Diagram Arsitektur

```text
+---------------------+
|    Klien (Klien)    |
+----------+----------+
           | 1. HTTP Request (X-Tenant-Id)
           v
+----------+----------+
|  NestJS Middleware  |
|  (TenantExtractor)  |
+----------+----------+
           | 2. Set Request Context (ClsService)
           v
+----------+----------+
| NestJS Provider/ORM |
| (Prisma/TypeORM)    |
+----------+----------+
           | 3. BEGIN;
           |    SET LOCAL app.current_tenant_id = 'T1';
           |    SELECT * FROM users;
           |    COMMIT;
           v
+----------+----------+
|   PostgreSQL DB     |
| +-----------------+ |
| | RLS Policies    | | -> Evaluasi app.current_tenant_id == row.tenant_id
| +-----------------+ |
+---------------------+
```

## Kebijakan PostgreSQL (Database Layer)

Sebelum aplikasi NestJS dapat memanfaatkan RLS, struktur basis data harus dikonfigurasi. Berikut adalah contoh migrasi SQL untuk mengaktifkan RLS:

```sql
-- 1. Buat tabel dengan kolom tenant_id
CREATE TABLE "Users" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "email" VARCHAR(255) UNIQUE NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "tenant_id" UUID NOT NULL
);

-- 2. Aktifkan RLS pada tabel
ALTER TABLE "Users" ENABLE ROW LEVEL SECURITY;

-- 3. Buat kebijakan (Policy)
-- Kebijakan ini memaksa setiap baris yang dibaca/ditulis harus memiliki tenant_id
-- yang sama dengan variabel konfigurasi sesi 'app.current_tenant_id'
CREATE POLICY "tenant_isolation_policy" ON "Users"
    AS PERMISSIVE FOR ALL
    TO PUBLIC
    USING ("tenant_id" = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK ("tenant_id" = current_setting('app.current_tenant_id', true)::uuid);
```

## Implementasi Kode Produksi NestJS

Implementasi ini menggunakan pola Unit of Work (atau Middleware/Interceptor) dengan penyedia *Database* kustom yang memastikan `SET LOCAL` selalu dijalankan pada koneksi yang sama dengan *query* yang dieksekusi. 

```typescript
import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
  ExecutionContext,
  CallHandler,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { ClsService } from 'nestjs-cls';
import { DataSource, EntityManager } from 'typeorm';
import { Observable } from 'rxjs';
import { ConfigService } from '@nestjs/config';

// 1. Antarmuka Konteks RLS
export interface TenantContext {
  tenantId: string;
}

// 2. Middleware Pengekstraksi Tenant
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly clsService: ClsService<TenantContext>) {}

  public use(req: Request, res: Response, next: NextFunction): void {
    const tenantId = req.headers['x-tenant-id'];

    if (!tenantId || typeof tenantId !== 'string') {
      throw new UnauthorizedException('X-Tenant-Id header is missing or invalid');
    }

    // UUID Regex Validation
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(tenantId)) {
        throw new UnauthorizedException('Invalid X-Tenant-Id format');
    }

    this.clsService.run(() => {
      this.clsService.set('tenantId', tenantId);
      next();
    });
  }
}

// 3. Layanan Repositori Dasar (Membungkus eksekusi dengan RLS)
@Injectable()
export class RlsRepositoryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly clsService: ClsService<TenantContext>,
  ) {}

  /**
   * Menjalankan callback di dalam transaksi dengan RLS yang diaktifkan.
   */
  public async executeWithRls<T>(
    operation: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const tenantId = this.clsService.get('tenantId');

    if (!tenantId) {
      throw new Error('Tenant Context not found. Execution aborted for security.');
    }

    return this.dataSource.transaction(async (transactionalEntityManager: EntityManager) => {
      // SET LOCAL hanya berlaku untuk transaksi saat ini
      // Hal ini mencegah kebocoran sesi di Connection Pool
      await transactionalEntityManager.query(
        `SET LOCAL app.current_tenant_id = '${tenantId}';`,
      );

      // Eksekusi operasi bisnis
      const result = await operation(transactionalEntityManager);

      // (Opsional) Membersihkan variabel - meskipun SET LOCAL otomatis hilang saat COMMIT
      await transactionalEntityManager.query(`RESET app.current_tenant_id;`);

      return result;
    });
  }
}

// 4. Contoh Penggunaan di Layanan Bisnis
import { Repository } from 'typeorm';
import { UserEntity } from './user.entity';

@Injectable()
export class UserService {
  constructor(private readonly rlsRepository: RlsRepositoryService) {}

  public async findAllUsers(): Promise<UserEntity[]> {
    return this.rlsRepository.executeWithRls(async (manager: EntityManager) => {
      // Query ini akan dicegat oleh PostgreSQL RLS
      // SELECT * FROM "Users" WHERE tenant_id = current_setting('app.current_tenant_id')
      return manager.find(UserEntity);
    });
  }

  public async createUser(email: string, name: string): Promise<UserEntity> {
      return this.rlsRepository.executeWithRls(async (manager: EntityManager) => {
          const user = manager.create(UserEntity, { email, name });
          // Postgres RLS WITH CHECK memastikan user disimpan dengan tenant_id dari app.current_tenant_id
          return manager.save(user);
      });
  }
}
```

## Unit & Tenant Isolator Mock Test Suite

Berikut adalah rangkaian pengujian untuk memvalidasi keamanan isolasi RLS. Pengujian mensimulasikan kegagalan penyuntikan dan memastikan akses ditolak.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { RlsRepositoryService } from './rls-repository.service';
import { ClsService } from 'nestjs-cls';
import { DataSource, EntityManager } from 'typeorm';

describe('RlsRepositoryService', () => {
  let service: RlsRepositoryService;
  let clsServiceMock: jest.Mocked<ClsService>;
  let dataSourceMock: jest.Mocked<DataSource>;
  let entityManagerMock: jest.Mocked<EntityManager>;

  beforeEach(async () => {
    clsServiceMock = {
      get: jest.fn(),
    } as unknown as jest.Mocked<ClsService>;

    entityManagerMock = {
      query: jest.fn(),
    } as unknown as jest.Mocked<EntityManager>;

    dataSourceMock = {
      transaction: jest.fn().mockImplementation((cb) => cb(entityManagerMock)),
    } as unknown as jest.Mocked<DataSource>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RlsRepositoryService,
        { provide: ClsService, useValue: clsServiceMock },
        { provide: DataSource, useValue: dataSourceMock },
      ],
    }).compile();

    service = module.get<RlsRepositoryService>(RlsRepositoryService);
  });

  it('Harus menolak eksekusi jika Konteks Tenant hilang', async () => {
    clsServiceMock.get.mockReturnValue(undefined);

    await expect(
      service.executeWithRls(async (manager) => {
        return true;
      }),
    ).rejects.toThrow('Tenant Context not found. Execution aborted for security.');
    
    expect(dataSourceMock.transaction).not.toHaveBeenCalled();
  });

  it('Harus menyuntikkan app.current_tenant_id dengan benar ke dalam transaksi', async () => {
    const mockTenantId = '123e4567-e89b-12d3-a456-426614174000';
    clsServiceMock.get.mockReturnValue(mockTenantId);

    const result = await service.executeWithRls(async (manager) => {
      return 'berhasil';
    });

    expect(result).toBe('berhasil');
    expect(entityManagerMock.query).toHaveBeenNthCalledWith(
      1,
      `SET LOCAL app.current_tenant_id = '${mockTenantId}';`,
    );
    expect(entityManagerMock.query).toHaveBeenNthCalledWith(
      2,
      `RESET app.current_tenant_id;`,
    );
  });
});
```

## Analisis Trade-off

**Kelebihan (Pros):**
1. **Keamanan Maksimal Mutlak:** Mustahil terjadi kebocoran data akibat *developer error* (lupa `WHERE tenant_id = ?`) karena proteksi di-enforce di tingkat kernel basis data.
2. **Kinerja Skalabilitas yang Kuat:** Memungkinkan penggunaan satu koneksi basis data (Connection Pool yang dibagikan) untuk semua tenant, sehingga konsumsi sumber daya basis data sangat rendah.
3. **Kode Aplikasi Lebih Bersih:** *Query* ORM menjadi lebih sederhana karena pengembang tidak perlu secara manual menyaring berdasarkan `tenant_id` pada setiap permintaan.

**Kekurangan (Cons):**
1. **Penurunan Kinerja Transaksional:** Setiap operasi memerlukan overhead `SET LOCAL` dan bergantung sepenuhnya pada transaksi (begitu ada `BEGIN`, koneksi tidak bisa dilepas ke *pool* hingga selesai).
2. **Kesulitan Migrasi & Superuser:** Tugas administratif (misalnya pelaporan lintas tenant) memerlukan otorisasi peran spesifik (bypass RLS) yang membuat skrip *cron jobs* atau analitik lebih kompleks.
3. **Ketergantungan Kuat Terhadap Ekosistem PostgreSQL:** Mengunci (Vendor Lock-in) aplikasi secara agresif pada PostgreSQL, sehingga arsitektur tidak bisa dipindahkan ke MySQL/MariaDB tanpa merombak ulang kebijakan.

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menggunakan `SET SESSION` alih-alih `SET LOCAL`
**Masalah:** Menggunakan `SET SESSION` (atau `SET`) pada koneksi dari Connection Pool akan meracuni koneksi (connection poisoning). Jika koneksi dikembalikan ke pool dan digunakan kembali oleh tenant lain tanpa disetel ulang, data tenant pertama akan terekspos.
```typescript
// ❌ SALAH: Meracuni koneksi global di connection pool
await manager.query(`SET app.current_tenant_id = '${tenantId}';`); 
```
```typescript
// ✅ BENAR: Menggunakan SET LOCAL di dalam transaksi
await manager.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`); 
```

### ❌ Anti-Pattern 2: Sanitasi ID Tenant yang Buruk (SQL Injection)
**Masalah:** Karena `SET LOCAL` dilakukan menggunakan raw SQL, injeksi SQL menjadi vektor serangan yang sangat fatal jika `tenant_id` tidak divalidasi.
```typescript
// ❌ SALAH: Memungkinkan injeksi SQL melalui header
const tenantId = req.headers['x-tenant-id']; 
await manager.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);
// Jika tenantId = "1'; DROP TABLE Users; --", bencana terjadi.
```
```typescript
// ✅ BENAR: Validasi ketat Regex UUID sebelum penyuntikan
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!uuidRegex.test(tenantId)) throw new Error("Format Invalid");
await manager.query(`SET LOCAL app.current_tenant_id = '${tenantId}';`);
```

## Production Edge Cases

1. **Background Jobs (Bulls/Kue):** Saat antrian pekerjaan latar belakang (Cron/Queue) dijalankan, konteks HTTP Request tidak ada. Anda harus menyuntikkan ID Tenant ke dalam muatan *job* (payload) dan menginisialisasi ClsService/Konteks RLS secara manual dalam *Job Processor* sebelum mengakses *Database*.
2. **Super-Admin Cross-Tenant Queries:** Fitur Dasbor Administrator Global memerlukan data agregasi lintas semua tenant. Anda harus membuat perutean khusus (atau peran basis data kustom) yang *Bypass RLS* atau mengakses data dari replica analitik khusus tanpa RLS aktif.
3. **Koneksi Terputus di Tengah Transaksi:** Jika `SET LOCAL` berhasil dipanggil tetapi Node.js mati secara paksa sebelum *query* selesai, transaksi akan di-*rollback* oleh *pool manager*. Namun, sangat kritis untuk mengonfigurasi `Pool` PostgreSQL agar melakukan *reset* koneksi secara eksplisit saat pengembalian (mis. `DISCARD ALL`) untuk memastikan tidak ada sisa kondisi RLS.
