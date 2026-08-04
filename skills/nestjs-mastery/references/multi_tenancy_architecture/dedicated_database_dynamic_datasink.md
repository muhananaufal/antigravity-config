# Arsitektur Multi-Tenancy Ekstrem: Basis Data Terdedikasi Dinamis (Dedicated DB Dynamic Datasink)

## Pendahuluan

Tingkatan paling superior dari arsitektur *Multi-Tenancy*—yang sering digunakan oleh penyedia perangkat lunak kesehatan (HIPAA), perbankan (Fintech), atau entitas dengan kebutuhan kedaulatan data tinggi (Data Sovereignty)—adalah menggunakan "Satu Basis Data (Fisik atau Logis) Per Tenant". Arsitektur basis data terdedikasi ini memastikan tidak ada data yang tercampur sama sekali. Namun, menampung ribuan server atau kredensial basis data menimbulkan kompleksitas routing saat *runtime* (dynamic datasink). Di NestJS, koneksi basis data ORM tidak bisa di-hardcode di dalam modul (*Module Import*); melainkan harus dialokasikan ulang (provisioned) secara dinamis ketika permintaan *HTTP request* masuk, dikelola menggunakan *Pool* Least Recently Used (LRU) guna menangani stabilitas memori.

## Diagram Arsitektur

```text
+-----------------------+
|  Klien (Aplikasi Web) |
+-----------+-----------+
            | 1. Request X-Tenant: T_ABC
            v
+-----------+-----------+
| NestJS Application    |
| (Tenant Resolver)     |
+-----------+-----------+
            | 2. Cek Master DB untuk Kredensial DB Tenant
            v
+-----------+-----------+
|   Master Database     | -> Tabel: TenantConfig (DB_URL, Region, Status)
+-----------+-----------+
            | 3. Kembalikan postgres://db_t_abc.cluster.com
            v
+-----------+-----------+
| LRU Connection Pool   | -> Cek Memori: Apakah koneksi T_ABC aktif?
+-----------+-----------+
            | 4. Koneksi Baru atau Cache Terpakai
            v
+-----------+-----------+      +-------------------+      +-------------------+
| Tenant A Database     |      | Tenant B Database |      | Tenant C Database |
| (AWS RDS / Fisik 1)   |      | (GCP SQL / Fisik 2|      | (Server Fisik 3)  |
+-----------+-----------+      +-------------------+      +-------------------+
            ^ (5. Eksekusi Query TypeORM/Prisma)
```

## Implementasi Kode Produksi NestJS

Solusi ini bergantung pada dua sumber basis data: *Master Connection* (untuk data konfigurasi *tenant* global) dan *Tenant Connection* (koneksi ORM target yang bersifat fana/efemeral). Contoh di bawah memanfaatkan TypeORM dengan manajemen cache koneksi (LRU).

```typescript
import {
  Injectable,
  OnApplicationShutdown,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { DataSource, DataSourceOptions } from 'typeorm';
import { LRUCache } from 'lru-cache';
import { ClsService } from 'nestjs-cls';

// 1. Antarmuka Konteks
interface TenantContext {
  tenantId: string;
}

// 2. Layanan Master (Repositori Global)
@Injectable()
export class MasterTenantConfigService {
  constructor(private readonly masterDataSource: DataSource) {}

  /**
   * Mengambil URL Koneksi fisik (Connection String) dari tabel Master berdasarkan ID Tenant.
   */
  public async getDatabaseUrlForTenant(tenantId: string): Promise<string> {
    const queryRunner = this.masterDataSource.createQueryRunner();
    try {
      // Mengambil dari tabel master "tenant_configurations"
      const result = await queryRunner.query(
        `SELECT database_url FROM tenant_configurations WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
        [tenantId],
      );

      if (!result || result.length === 0) {
        throw new NotFoundException(`Tenant configuration for ${tenantId} not found`);
      }

      return result[0].database_url;
    } finally {
      await queryRunner.release();
    }
  }
}

// 3. Layanan Sinkronisasi Datasink Dinamis (Tenant Connection Manager)
@Injectable()
export class DynamicDatasinkService implements OnApplicationShutdown {
  // LRU Cache: Melindungi Node.js dari Out-of-Memory (OOM) dan Postgres dari kehabisan limit pool.
  private readonly connectionPool = new LRUCache<string, DataSource>({
    max: 50, // Maksimal 50 tenant yang berjalan bersamaan di memori instance ini
    ttl: 1000 * 60 * 30, // Hancurkan jika 30 menit tidak diakses (Zombies)
    dispose: (value: DataSource, key: string) => {
      // Hook kritis saat koneksi digusur dari memori
      value.destroy().catch((err) => {
        console.error(`Failed to close connection for tenant ${key} upon LRU eviction`, err);
      });
    },
  });

  constructor(
    private readonly configService: MasterTenantConfigService,
    private readonly clsService: ClsService<TenantContext>,
  ) {}

  /**
   * Mengambil atau membuat koneksi DataSource dinamis.
   */
  public async getTenantDataSource(): Promise<DataSource> {
    const tenantId = this.clsService.get('tenantId');
    if (!tenantId) {
      throw new InternalServerErrorException('Tenant ID missing in Execution Context');
    }

    // 1. Cache Hit (Sangat Cepat)
    const existingConnection = this.connectionPool.get(tenantId);
    if (existingConnection && existingConnection.isInitialized) {
      return existingConnection;
    }

    // 2. Ambil URL Fisik
    const databaseUrl = await this.configService.getDatabaseUrlForTenant(tenantId);

    // 3. Bangun DataSource Baru (Dynamic Provisioning)
    const newDataSource = new DataSource({
      type: 'postgres',
      url: databaseUrl,
      // Penting: Batasi max pool dinamis per tenant karena jumlah tenant tidak terbatas
      extra: { max: 10, connectionTimeoutMillis: 5000 }, 
      entities: [__dirname + '/../**/*.tenant.entity{.ts,.js}'],
      synchronize: false, // JANGAN PERNAH gunakan di produksi
    });

    await newDataSource.initialize();
    
    // Simpan di LRU Cache (yang secara otomatis akan menggusur tenant tertua jika melebihi kuota 50)
    this.connectionPool.set(tenantId, newDataSource);

    return newDataSource;
  }

  /**
   * Graceful Shutdown
   */
  async onApplicationShutdown(): Promise<void> {
    const connections = Array.from(this.connectionPool.values());
    for (const connection of connections) {
      if (connection.isInitialized) {
        await connection.destroy();
      }
    }
    this.connectionPool.clear();
  }
}
```

## Unit & Tenant Isolator Mock Test Suite

Menguji bahwa sistem LRU Cache secara otomatis membersihkan koneksi basis data ketika memori Node.js mencapai batas yang ditentukan.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { DynamicDatasinkService } from './dynamic-datasink.service';
import { MasterTenantConfigService } from './master-tenant-config.service';
import { ClsService } from 'nestjs-cls';
import { DataSource } from 'typeorm';

// Mock DataSource TypeORM
jest.mock('typeorm', () => {
  return {
    DataSource: jest.fn().mockImplementation(() => {
      return {
        isInitialized: true,
        initialize: jest.fn().mockResolvedValue(true),
        destroy: jest.fn().mockResolvedValue(true),
      };
    }),
  };
});

describe('DynamicDatasinkService (Dedicated Database Strategy)', () => {
  let service: DynamicDatasinkService;
  let configServiceMock: jest.Mocked<MasterTenantConfigService>;
  let clsServiceMock: jest.Mocked<ClsService>;

  beforeEach(async () => {
    configServiceMock = {
      getDatabaseUrlForTenant: jest.fn().mockResolvedValue('postgres://mock:5432/db'),
    } as unknown as jest.Mocked<MasterTenantConfigService>;

    clsServiceMock = {
      get: jest.fn(),
    } as unknown as jest.Mocked<ClsService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DynamicDatasinkService,
        { provide: MasterTenantConfigService, useValue: configServiceMock },
        { provide: ClsService, useValue: clsServiceMock },
      ],
    }).compile();

    service = module.get<DynamicDatasinkService>(DynamicDatasinkService);
  });

  it('Harus melakukan inisialisasi koneksi DB baru pada permintaan pertama', async () => {
    clsServiceMock.get.mockReturnValue('t_alfa');
    
    const dataSource = await service.getTenantDataSource();
    expect(configServiceMock.getDatabaseUrlForTenant).toHaveBeenCalledWith('t_alfa');
    expect(dataSource.initialize).toHaveBeenCalled();
  });

  it('Harus mengembalikan cache DataSource yang sama pada panggilan kedua tanpa kueri master', async () => {
    clsServiceMock.get.mockReturnValue('t_beta');
    
    const dataSource1 = await service.getTenantDataSource();
    const dataSource2 = await service.getTenantDataSource();
    
    expect(dataSource1).toBe(dataSource2);
    // getDatabaseUrlForTenant hanya dipanggil SATU kali
    expect(configServiceMock.getDatabaseUrlForTenant).toHaveBeenCalledTimes(1);
  });

  it('Harus menggusur dan menghancurkan (destroy) koneksi DB ketika limit LRU terlampaui', async () => {
      // Simulasi mengganti limit Max di service secara internal (hack untuk testing logic)
      (service as any).connectionPool.max = 2; // Hanya toleransi 2 Tenant

      // Masuk Tenant 1
      clsServiceMock.get.mockReturnValue('T_1');
      const ds1 = await service.getTenantDataSource();
      
      // Masuk Tenant 2
      clsServiceMock.get.mockReturnValue('T_2');
      const ds2 = await service.getTenantDataSource();

      // Masuk Tenant 3 (Ini harus menendang T_1 keluar dari memori LRU)
      clsServiceMock.get.mockReturnValue('T_3');
      const ds3 = await service.getTenantDataSource();

      expect(ds1.destroy).toHaveBeenCalledTimes(1); // Tenant 1 telah digusur
      expect(ds2.destroy).not.toHaveBeenCalled(); // Tenant 2 masih aman
      expect(ds3.destroy).not.toHaveBeenCalled(); // Tenant 3 aman (baru)
  });
});
```

## Analisis Trade-off

**Kelebihan (Pros):**
1. **Kedaulatan & Isolasi Maksimal (Ultimate Compliance):** Cocok untuk sertifikasi SOC2, HIPAA, atau GDPR ketat di mana *tenant* klien korporat mengharuskan basis data mereka berada di *region* spesifik (misalnya basis data klien Jerman wajib berada di Frankfurt).
2. **Skalabilitas Performa Tersendiri (Noisy Neighbor Immunity):** Jika Tenant A melakukan *query* analitik ekstensif selama 24 jam berturut-turut, itu akan menguras batas CPU RDS Tenant A saja, tanpa menyentuh kinerja aplikasi Tenant B.
3. **Kustomisasi Versi Tanpa Batas:** Memungkinkan arsitektur di mana Tenant VIP diberikan server (hardware) basis data khusus dengan spesifikasi gahar dan tabel *Custom Fields*, sedangkan tenant gratis (freemium) menempati klaster RDS bersama dengan batas ukuran.

**Kekurangan (Cons):**
1. **Kompleksitas Infrastruktur (Operational Hell):** Memutakhirkan atau migrasi skema tabel menjadi bencana murni operasional karena infrastruktur DevOps (*Terraform*, CI/CD) harus melakukan migrasi ke ribuan instansi DB fisik (RDS Instances).
2. **Konsumsi Memori Node.js Tinggi:** Sangat rakus memori di *Application Server*. Satu `DataSource` TypeORM bisa memakan memori RAM hingga 25MB-50MB. Jika server menjalankan ratusan tenant aktif secara acak, memori RAM NestJS (V8 Engine) akan dengan cepat membengkak menembus gigabyte.
3. **Keterlambatan (Latency) Basis Data Master & Cold Boot:** Kueri HTTP pertama yang masuk harus menunggu kueri asinkron membaca Kredensial *Master Database* ke jaringan terlebih dahulu, sebelum bisa menyusun inisialisasi jaringan ke *Database* Fisik Tenant.

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Mengabaikan Pengelolaan "Idle Connections"
**Masalah:** Mengalokasikan instansi koneksi tanpa pembatasan masa hidup maksimal (Time To Live/TTL). Dalam Node.js yang berjalan berminggu-minggu, Anda akan mengakumulasikan ratusan koneksi yang dibiarkan menggantung ke basis data fisik meskipun *tenant* tersebut sudah tidak login berhari-hari.
```typescript
// ❌ SALAH: Menyimpan DataSource selamanya di objek statis (Memory Leak)
const dbConnections = {};
dbConnections[tenantId] = new DataSource(...); 
```
```typescript
// ✅ BENAR: Menggunakan pustaka lru-cache dengan kait (hook) `dispose`
const connectionPool = new LRUCache({ max: 50, dispose: (ds) => ds.destroy() });
```

### ❌ Anti-Pattern 2: Beban Terpusat pada Master Database (Single Point of Failure)
**Masalah:** Meminta Data Master setiap kali cache *Tenant DB* kadaluarsa dapat menenggelamkan server Master (DDoS oleh sistem sendiri).
```typescript
// ❌ SALAH: Tidak mengimplementasikan cache untuk konfigurasi URL fisik.
const url = await masterDb.query(`SELECT url FROM tenants WHERE id = $1`, [id]);
```
```typescript
// ✅ BENAR: Mengimplementasikan REDIS di antara lapisan NestJS dan Master Database 
// sehingga resolusi letak server DB tenant tidak selalu menyentuh Master Postgres.
const url = await redisCache.get(`tenant_routing_url:${id}`);
if (!url) { /* Fallback Master DB */ }
```

## Production Edge Cases

1. **Sinkronisasi Skema Rentan Kesalahan (Schema Drift):** Ketika terjadi pembaruan rilis sistem, ada kemungkinan skrip migrasi gagal di basis data Tenant ke-599. Hal ini menciptakan fenomena "Schema Drift" (Sebagian aplikasi menjalankan versi tabel V2, sebagian V1). Sistem Master DB wajib di-desain untuk menyimpan Kolom Status Migrasi (Version State) per *tenant*, dan NestJS harus menolak koneksi (Downtime/Maintenance Mode Page) ke Tenant yang migrasi strukturalnya masih tertunda/gagal.
2. **Serangan Hit-and-Run Acak (Cache Thrashing):** Jika pihak penyerang mencoba mengakses (Hit) ribuan rute ID *tenant* yang berbeda secara acak dalam satu detik, batas LRU Cache (misal 50) akan tergusur bertubi-tubi. Proses pembongkaran `.destroy()` dan instansiasi ulang TypeORM yang intensif CPU akan mencekik Event Loop Node.js. Diperlukan penangkal kecepatan dinamis (*Dynamic Rate Limiting*) berbasis sidik jari HTTP sebelum mencapai logika pemicuan resolusi Multi-Tenancy.
3. **Rolling Updates (Zero Downtime K8s):** Pada sistem Kubernetes *rolling deployment*, puluhan *Pod* NestJS baru yang terbangun (Start Up) akan memicu 'Thundering Herd' (Serbuan tiba-tiba). Semua Pod baru tersebut akan bersamaan meminta resolusi Master DB dan koneksi inisial yang dapat menghancurkan server PostgreSQL. Mekanisme `Pool max` pada setiap NestJS Container harus dihitung sedemikian rupa sehingga: `(Kapasitas Max Postgres / Replikasi Pod) - 2` agar koneksi tidak pernah meledak.
