# Isolasi Tenant Berbasis Skema (Schema-Based Isolation) dengan Prisma di NestJS

## Pendahuluan

Isolasi berbasis Skema (Schema-based isolation) adalah arsitektur *multi-tenancy* tingkat menengah di mana setiap *tenant* memiliki skema basis datanya sendiri (misalnya, `tenant_a`, `tenant_b`) namun semuanya bermukim di dalam satu instansi (server) basis data fisik yang sama. Model ini memberikan keseimbangan antara isolasi data struktural—yang lebih aman daripada model berbagi baris (Row-Level Security/Shared Schema)—dan efisiensi biaya—lebih murah dibandingkan dengan membuat basis data fisik terpisah (Dedicated Database). Dengan menggunakan PostgreSQL dan Prisma ORM di dalam ekosistem NestJS, kita dapat secara dinamis mengarahkan *query* ke skema yang tepat berdasarkan konteks *tenant*.

## Diagram Arsitektur

```text
+-----------------------+
|  Klien (Aplikasi Web) |
+-----------+-----------+
            | 1. HTTP Request (X-Tenant-Id: tenant_b)
            v
+-----------+-----------+
| NestJS Middleware     | -> Ekstrak & Validasi Tenant ID
+-----------+-----------+
            | 2. Simpan di ClsService Context
            v
+-----------+-----------+
| Prisma Tenant Service | -> Dapatkan 'tenant_b' dari ClsService
+-----------+-----------+
            | 3. Set Schema (Search Path) 
            v
+-----------+-----------+
|     PostgreSQL DB     |
| +-------------------+ |
| | Schema: public    | | (Tabel Master/Global)
| +-------------------+ |
| +-------------------+ |
| | Schema: tenant_a  | | -> (Tabel Users, Posts)
| +-------------------+ |
| +-------------------+ |
| | Schema: tenant_b  | | -> (Tabel Users, Posts) [TERPILIH]
| +-------------------+ |
+-----------------------+
```

## Implementasi Kode Produksi NestJS & Prisma

Implementasi modern menggunakan pemisahan *Client* Prisma (Prisma Client). Mengingat Prisma tidak memiliki dukungan *dynamic schema switching* bawaan (native support) untuk setiap *query*, kita menggunakan pendekatan manipulasi URL koneksi yang efisien atau *middleware* kustom untuk mengubah `search_path` (di PostgreSQL).

Berikut adalah strategi efisien menggunakan Prisma `$extends` dan konfigurasi koneksi yang di-cache di tingkat memori aplikasi.

```typescript
import {
  Injectable,
  OnModuleDestroy,
  UnauthorizedException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';

interface TenantContext {
  tenantId: string;
}

@Injectable()
export class PrismaTenantService implements OnModuleDestroy {
  // Penyimpanan Memori Caching Prisma Client Per-Tenant
  private readonly clients = new Map<string, PrismaClient>();
  // Master URL dari Environment
  private readonly baseDbUrl = process.env.DATABASE_URL;

  constructor(private readonly clsService: ClsService<TenantContext>) {
    if (!this.baseDbUrl) {
      throw new InternalServerErrorException('DATABASE_URL is not configured');
    }
  }

  /**
   * Mengambil Prisma Client yang telah disetel khusus untuk Skema Tenant saat ini.
   * Membuat instansi baru jika belum ada dalam cache.
   */
  public async getClient(): Promise<PrismaClient> {
    const tenantId = this.clsService.get('tenantId');

    if (!tenantId) {
      throw new UnauthorizedException('Konteks Tenant tidak tersedia.');
    }

    // Validasi Tenant ID agar aman dari injeksi ke URL Parameter
    const alphanumericRegex = /^[a-z0-9_]+$/i;
    if (!alphanumericRegex.test(tenantId)) {
        throw new UnauthorizedException('Format Tenant ID tidak valid.');
    }

    if (this.clients.has(tenantId)) {
      return this.clients.get(tenantId)!;
    }

    // URL dinamis: Menambahkan param schema
    // Contoh: postgres://user:pass@host:5432/db?schema=tenant_id
    const url = new URL(this.baseDbUrl);
    url.searchParams.set('schema', tenantId);

    const client = new PrismaClient({
      datasources: {
        db: {
          url: url.toString(),
        },
      },
      log: ['error', 'warn'],
    });

    await client.$connect();
    
    // Menyimpan klien ke dalam cache memori
    this.clients.set(tenantId, client);
    return client;
  }

  /**
   * Pembersihan Memori Graceful Shutdown
   */
  async onModuleDestroy(): Promise<void> {
    for (const [tenantId, client] of this.clients.entries()) {
      try {
        await client.$disconnect();
      } catch (error) {
        console.error(`Gagal memutuskan koneksi untuk tenant ${tenantId}`, error);
      }
    }
    this.clients.clear();
  }
}
```

```typescript
// Contoh Penggunaan pada Bisnis Logika
import { Injectable } from '@nestjs/common';
import { PrismaTenantService } from './prisma-tenant.service';
import { User } from '@prisma/client';

@Injectable()
export class UserService {
  constructor(private readonly prismaTenant: PrismaTenantService) {}

  public async findAllUsers(): Promise<User[]> {
    // getClient() otomatis mendeteksi tenantId dari eksekusi HTTP saat ini
    const prisma = await this.prismaTenant.getClient();
    
    // Ini akan menjalankan query SELECT * FROM "tenant_x"."User"
    return prisma.user.findMany();
  }
}
```

## Unit & Tenant Isolator Mock Test Suite

Pengujian berikut memvalidasi logika isolasi bahwa instansi Prisma klien yang berbeda diciptakan (atau digunakan ulang dari *cache*) untuk tenant yang berbeda, mencegah bercampurnya konfigurasi.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaTenantService } from './prisma-tenant.service';
import { ClsService } from 'nestjs-cls';

// Menghindari koneksi DB asli
jest.mock('@prisma/client', () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => {
      return {
        $connect: jest.fn().mockResolvedValue(true),
        $disconnect: jest.fn().mockResolvedValue(true),
      };
    }),
  };
});

describe('PrismaTenantService Isolator', () => {
  let service: PrismaTenantService;
  let clsServiceMock: jest.Mocked<ClsService>;

  beforeEach(async () => {
    // Memaksa Environment Variables untuk uji
    process.env.DATABASE_URL = 'postgresql://usr:pass@localhost:5432/mydb';

    clsServiceMock = {
      get: jest.fn(),
    } as unknown as jest.Mocked<ClsService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrismaTenantService,
        { provide: ClsService, useValue: clsServiceMock },
      ],
    }).compile();

    service = module.get<PrismaTenantService>(PrismaTenantService);
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('Harus menolak akses jika ID Tenant tidak ada', async () => {
    clsServiceMock.get.mockReturnValue(undefined);
    await expect(service.getClient()).rejects.toThrow('Konteks Tenant tidak tersedia.');
  });

  it('Harus menolak ID Tenant dengan karakter berbahaya (SQL/URL Injeksi)', async () => {
    clsServiceMock.get.mockReturnValue('tenant; DROP TABLE users;');
    await expect(service.getClient()).rejects.toThrow('Format Tenant ID tidak valid.');
  });

  it('Harus me-reuse instance PrismaClient (Caching) untuk tenant yang sama', async () => {
    clsServiceMock.get.mockReturnValue('tenant_a');
    
    const client1 = await service.getClient();
    const client2 = await service.getClient();
    
    expect(client1).toBe(client2); // Identitas referensi objek harus sama
  });

  it('Harus memisahkan instance PrismaClient untuk tenant yang berbeda', async () => {
    clsServiceMock.get.mockReturnValueOnce('tenant_a');
    const clientA = await service.getClient();

    clsServiceMock.get.mockReturnValueOnce('tenant_b');
    const clientB = await service.getClient();
    
    expect(clientA).not.toBe(clientB); // Klien harus instansi yang berbeda
  });
});
```

## Analisis Trade-off

**Kelebihan (Pros):**
1. **Pencadangan & Pemulihan (Backup/Restore) Parsial:** Setiap *tenant* memiliki skema tersendiri yang memudahkan proses ekspor (pg_dump pada level skema) atau pemulihan (restore) per-*tenant* tanpa mempengaruhi data *tenant* lain.
2. **Kemandirian Migrasi Basis Data:** Memungkinkan peluncuran fitur berjenjang (Canary deployment) di mana satu skema *tenant* dapat di-migrasi ke versi terbaru (v2) sementara *tenant* lain tetap di versi lama (v1).
3. **Isolasi Bebas Kesalahan Logika (Foolproof):** Sama seperti RLS, pengembang tidak dapat tanpa sengaja mengambil data pengguna dari perusahaan (tenant) yang salah karena koneksi `search_path` membatasi visibilitas secara fisik.

**Kekurangan (Cons):**
1. **Ledakan Koneksi (Connection Exhaustion):** Karena setiap skema menciptakan instansi `PrismaClient` tersendiri, setiap klien membuka *connection pool* miliknya masing-masing. Jika terdapat 1.000 *tenant*, maka koneksi ke *database* akan meledak melebihi kapasitas PostgreSQL (`max_connections`).
2. **Lambat Saat Proses *Cold Start*:** Permintaan (request) pertama ke skema *tenant* yang jarang diakses akan lambat karena `PrismaClient` harus diinstansiasi ulang dan membangun koneksi awal (`$connect`).
3. **Migrasi Massal Menjadi Lambat:** Ketika versi aplikasi diperbarui, proses migrasi struktur tabel (DDL) harus diulang dan dieksekusi secara berurutan ke ratusan/ribuan skema, meningkatkan *downtime* operasional.

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Mengabaikan Batas Memori Aplikasi (OOM)
**Masalah:** Membangun instansi `PrismaClient` ke dalam Map tanpa adanya mekanisme penggusuran (Eviction/LRU Cache). Jika sistem memiliki 10.000 *tenant*, Node.js akan mengalami kehabisan memori (*Out Of Memory* / OOM).
```typescript
// ❌ SALAH: Menyimpan Prisma Client di Array/Map yang terus tumbuh secara permanen
const clients = new Map<string, PrismaClient>();
clients.set(tenantId, new PrismaClient(...));
```
```typescript
// ✅ BENAR: Menggunakan pustaka lru-cache untuk menggusur klien yang tidak aktif (Idle)
import { LRUCache } from 'lru-cache';
const clients = new LRUCache<string, PrismaClient>({
    max: 100, // Maksimal 100 tenant aktif di memori
    dispose: (client) => { client.$disconnect(); }
});
```

### ❌ Anti-Pattern 2: Dynamic Table Naming (Model Berubah-ubah)
**Masalah:** Mencoba memalsukan skema multi-tenant dengan menggunakan nama tabel secara dinamis dalam SQL Mentah (Raw SQL) `SELECT * FROM ${tenant}_users`.
```typescript
// ❌ SALAH: Injeksi SQL dan kehilangan dukungan pemeriksaan tipe statis Prisma
await prisma.$queryRawUnsafe(`SELECT * FROM ${tenantId}_users`);
```
```typescript
// ✅ BENAR: Tetap menggunakan tipe statis ORM dengan search_path/Schema isolasi di URL Koneksi.
const tenantPrisma = await getClientFor(tenantId);
await tenantPrisma.user.findMany(); // Type-safe dan terisolasi!
```

## Production Edge Cases

1. **Pemutusan Koneksi Pasif Lintas Tenant (Zombie Connections):** Prisma tidak tahu kapan *tenant* sedang tidak digunakan. Anda wajib menggunakan arsitektur pembersihan rutin (misalnya `setTimeout` untuk menutup koneksi jika tidak diakses dalam 15 menit) atau menggunakan koneksi proksi (*PgBouncer* di layer infrastruktur).
2. **Migrasi Prisma Bertabrakan:** Menjalankan `prisma migrate deploy` secara standar hanya akan memperbarui skema `public`. Administrator harus merancang *Script Bash* khusus yang melakukan pengulangan iterasi ke setiap skema untuk menjalankan migrasi DDL pada setiap rilis.
3. **Database URL Limits pada Platform Serverless:** Pada sistem seperti Vercel atau AWS Lambda, menyimpan cache instansi basis data akan gagal dan menciptakan ratusan koneksi mati. Jika berbasis Serverless, penggunaan `Prisma Accelerate` atau Data Proxy HTTP (*PostgREST*) mutlak diperlukan agar Serverless *cold-start* tidak melumpuhkan koneksi PostgeSQL.
