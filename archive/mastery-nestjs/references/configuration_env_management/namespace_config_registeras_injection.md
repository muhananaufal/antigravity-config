# Namespace Config & registerAs Injection di NestJS

## 1. Pendahuluan
Mengakses `process.env.MY_VAR` secara langsung (statis) di dalam Layer Service merupakan kebiasaan buruk (*anti-pattern*) yang menghancurkan prinsip "Dependency Inversion" dan meniadakan testabilitas (sulit melakukan *Testing mock*). Dalam aplikasi monorepo atau arsitektur enterprise skala besar, domain konfigurasi membesar tak terkendali. NestJS menyelesaikan ini dengan fasilitas modularisasi **`registerAs` Namespace**. Sistem ini mengelompokkan konfigurasi terkait secara logis, dan menginjeksikannya langsung layaknya objek terketik kuat (*strongly-typed*). Di sinilah prinsip-prinsip mendalam seperti **Config factory pattern**, **async config loading**, **config invalidation & hot-reload**, serta **circular dependency resolution** dikelola dengan elegan.

## 2. Diagram Arsitektur
```ascii
+-----------------------+        +--------------------------+
|  .env File / K8s CM   |        | registerAs('database')   |
|  DB_HOST=10.0.0.1     +---+--->+ Config Factory           |
|  DB_PORT=5432         |   |    | { host: '10.0.0.1',      |
|                       |   |    |   port: 5432 }           |
+-----------------------+   |    +-----------+--------------+
                            |                | (Injected as Type)
+-----------------------+   |    +-----------v--------------+
| registerAs('aws')     |   |    | @Inject(dbConfig.KEY)    |
| Config Factory        <---+    | DatabaseService          |
| { region: 'us-east' } |        |                          |
+-----------------------+        +--------------------------+
```

## 3. Konsep Lanjutan & Desain Sistem Konfigurasi

### a. Config Factory Pattern
`registerAs` sebetulnya merupakan implementasi spesifik dari pola desain *Factory*. Pabrik konfigurasi tidak sekadar meneruskan `process.env`, tetapi bisa digunakan untuk melakukan manipulasi atau pengkondisian rumit di awal, misalnya mengatur *URL parser*, memecah nilai variabel dari string koma menjadi array, atau mengenkripsi ulang token rahasia sebelum dilemparkan ke memori RAM (*In-memory transform*). 

### b. Async Config Loading
Di skenario di mana konfigurasi lokal di PC dibaca dari `.env`, sementara konfigurasi produksi ditarik asinkron (misalnya dari AWS Parameter Store API), pabrik *namespace* dapat dimodifikasi agar dapat menunggu (`await`) pengambilan nilai dari luar sebelum merakit *Dependency Injection Container* NestJS.

### c. Config Invalidation & Hot-Reload
Secara default, nilai-nilai yang dipabrikasi melalui `registerAs` dikompilasi ke objek *singleton immutable* saat pertama kali aplikasi NestJS me-*mount* modul (`AppModule`). Ini mencegah *config invalidation* atau *hot-reload* jika variabel dasar (`process.env`) di-update secara *runtime* tanpa me-restart proses Node. Aplikasi yang tidak dapat di-*restart* (zero-downtime microservices berat) membutuhkan perancangan custom untuk me-re-run factory injeksi jika terdapat pemicu update konfigurasi eksternal.

### d. Circular Dependency Resolution pada Konfigurasi
Sering kali terjadi masalah di mana `Service A` membutuhkan konfigurasi dari Namespace A, namun Namespace A mencoba menginisialisasi nilainya menggunakan Helper Function yang sayangnya bergantung pada Service B yang meminta Namespace B. Untuk mengatasi konflik ini, konfigurasi namespace harus dijaga sekecil mungkin dan sepenuhnya terisolasi tanpa merangkul domain kode logika *runtime* aplikasi (sepenuhnya independen).

## 4. Implementasi Kode Produksi TypeScript 5+ & NestJS 10+

### a. Membuat Namespace Config & Config Factory
```typescript
// src/config/namespaces/database.config.ts
import { registerAs } from '@nestjs/config';

// Definisikan Interface yang strict dan bebas dari tipe 'any'
export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  isSsl: boolean;
  poolSize: number;
}

// 'database' adalah nama token kuncinya (Namespace).
// Pabrik ini mengonversi, mem-parsing, dan memberi nilai fallback (Config Factory Pattern)
export default registerAs('database', (): DatabaseConfig => {
  const host = process.env.DATABASE_HOST ?? 'localhost';
  const port = parseInt(process.env.DATABASE_PORT ?? '5432', 10);
  const user = process.env.DATABASE_USER ?? 'root';
  const isSsl = process.env.DATABASE_SSL === 'true';
  const poolSize = parseInt(process.env.DATABASE_POOL_SIZE ?? '10', 10);

  return { host, port, user, isSsl, poolSize };
});
```

### b. Memuat Namespace pada Modul Induk (Async Friendly)
```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import databaseConfig from './config/namespaces/database.config';
// import awsConfig from './config/namespaces/aws.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig], // Load semua namespaces (Factories akan dieksekusi di sini)
      cache: true,            // Optimasi performa akses berulang
    }),
  ],
})
export class AppModule {}
```

### c. Menginjeksikan Config ke Dalam Service (Type-Safe!)
```typescript
// src/modules/database/database.service.ts
import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import databaseConfig from '../../config/namespaces/database.config';

@Injectable()
export class DatabaseService {
  private readonly logger = new Logger(DatabaseService.name);

  constructor(
    // Injeksi dengan menggunakan konstanta KEY milik token
    @Inject(databaseConfig.KEY)
    private readonly dbConf: ConfigType<typeof databaseConfig>,
  ) {}

  connect(): void {
    // dbConf sekarang adalah objek JavaScript terstruktur (Fully Typed & Strict)
    // Autocomplete IDE berjalan mulus dan kita tidak menyentuh langsung process.env!
    this.logger.log(`Connecting DB to ${this.dbConf.host}:${this.dbConf.port}`);
    this.logger.log(`SSL Enabled: ${this.dbConf.isSsl}`);
  }
}
```

### d. Unit Testing yang Sangat Mudah & Anti-Flaky
```typescript
// src/modules/database/database.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseService } from './database.service';
import databaseConfig, { DatabaseConfig } from '../../config/namespaces/database.config';
import { Logger } from '@nestjs/common';

describe('DatabaseService', () => {
  let service: DatabaseService;
  let loggerSpy: jest.SpyInstance;

  beforeEach(async () => {
    // Mocking object secara absolut menghindari polusi process.env global
    const mockDbConfig: DatabaseConfig = {
      host: '192.168.1.100',
      port: 3306,
      user: 'test_user',
      isSsl: true,
      poolSize: 5,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseService,
        // Kita cukup me-override Token Provider Config-nya! Pola yang sangat bersih!
        {
          provide: databaseConfig.KEY,
          useValue: mockDbConfig,
        },
      ],
    }).compile();

    service = module.get<DatabaseService>(DatabaseService);
    loggerSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should be created and operate with injected mock config', () => {
    expect(service).toBeDefined();
    
    service.connect();
    expect(loggerSpy).toHaveBeenCalledWith('Connecting DB to 192.168.1.100:3306');
    expect(loggerSpy).toHaveBeenCalledWith('SSL Enabled: true');
  });
});
```

## 5. Analisis Trade-Off
### Kelebihan:
1. **Isolasi Domain & Prinsip Tanggung Jawab Tunggal (Single Responsibility):** Modul AWS S3 hanya mendapatkan interface injeksi dari `awsConfig`, sementara Modul Postgres hanya merengkuh `databaseConfig`. Tidak ada kebocoran atau polusi rahasia di luar domain yang tidak relevan (Prinsip Akses Minimum).
2. **Developer Experience Luar Biasa (IntelliSense):** Interface disajikan secara murni dalam *TypeScript* murni. Pengembang tak perlu lagi menerka tipe data (misal berulang kali memanggil `Number(process.env.PORT)`) karena tipe sudah dipabrikasi di titik masuk (Namespace factory).
3. **Kemudahan Uji (Testability) Tinggi:** Memasok *mock JavaScript object* ke injektor IoC (Inversion of Control) NestJS sangat gampang. Sebaliknya, mengubah `process.env` mutator selama eksekusi Jest akan berisiko menyebabkan *side effects* (efek samping silang) di test case lain (*Flaky Tests*).

### Kekurangan:
1. **Boilerplate Meningkat:** Terdapat gesekan kurva pembelajaran bagi pemula karena pola ini mewajibkan minimum tiga tahap (3 file berbeda): membuat file *namespace Factory*, mendaftarkannya ke muatan dasar `AppModule`, dan meng-*inject* perantara tersebut via dekorator `@Inject(token.KEY)`.
2. **Ketergantungan Ketat pada Ekosistem NestJS:** Konstruksi injeksi token via `@Inject` bersifat sangat berorientasi *framework* NestJS. Konfigurasi tersebut tidak bisa dengan mudah dipanggil oleh modul fungsi Vanilla Node.js independen di luar siklus perutean class provider.
3. **Risiko Modifikasi Referensi Global (Mutable Object):** Secara internal, NestJS mem-*passing* objek konfigurasi berdasarkan referensi (*by reference*). Jika tidak di-*freeze*, developer ceroboh bisa saja mengeksekusi `this.dbConf.host = 'hacked.com'`, yang akan merusak *singleton configuration* ini pada kelas servis lainnya. Pengamanan ekstra mewajibkan membungkus keluaran objek menjadi `Object.freeze({...})`.

## 6. Anti-Patterns Kritis

### Anti-Pattern 1: Mengakses `process.env` di Dalam Business Logic Node.js
❌ **Salah:** Menyisipkan pengambilan konfigurasi statis tepat di ruang lingkup eksekusi fungsi Logika Bisnis (Spaghetti Configuration).
```typescript
@Injectable()
export class StripePaymentService {
  public async chargeCreditCard() {
    // MAGIC STRING & IMPOSSIBLE TO MOCK CLEANLY:
    const stripeApiKey = process.env.STRIPE_API_KEY; 
  }
}
```
✅ **Benar:** Gunakan Namespaced Config Injection yang selalu disediakan melalui rantai pasok konstruktor (`this.paymentConfig.stripeApiKey`).

### Anti-Pattern 2: Me-Load Seluruh ConfigModule via `ConfigService` String Getter
❌ **Salah:** Konfigurasi masih memanggil get() dengan string bebas dan tetap tidak melindungi dari masalah *typo* human-error.
```typescript
// Typo, tapi TypeScript tidak bisa membantu memprotesnya, merusak proses runtime:
const host = this.configService.get('database.hossssst'); 
```
✅ **Benar:** Menggunakan struktur terinkapsulasi penuh `ConfigType` dan `registerAs`, langsung mendapatkan proteksi ketat kompilasi dari tipe data struktural compiler TS.

### Anti-Pattern 3: Circular Dependency melalui Modul Luar (Cross-contamination)
❌ **Salah:** *Namespace factory* mencoba memanggil metode internal dari Service A, padahal Service A dikonstruksi membutuhkan *Namespace factory* tersebut. Ini mengunci proses booting NestJS dalam sebuah putaran tak berujung (*deadlock bootstrap*).
✅ **Benar:** Buat pabrik konfigurasi sebodoh dan seringan mungkin. Biarkan *factory* tersebut menjadi entitas dasar tanpa mengimpor domain logika dari Service internal aplikasi.

## 7. Production Edge Cases
1. **Overriding Config di Runtime E2E Tests Secara Efisien:**
   Dalam pengujian integrasi murni dari hulu-ke-hilir menggunakan Supertest API, jika aplikasi menggunakan hierarki Namespaces yang mendalam, sangat disarankan untuk mengatur nilai mutasi sementara di tingkat framework *testing*: Anda meregistrasikan override menggunakan metode rantai `moduleRef.overrideProvider(databaseConfig.KEY).useValue({...})`. Cara ini memastikan aplikasi tidak melompat keluar dari batasan *.env* terisolasi miliknya di ruang disk lokal test runner.
2. **Kasus Global Config Leak & "Nest can't resolve dependencies":**
   Jika sebuah arsitektur *namespace* didaftarkan namun `ConfigModule.forRoot({ isGlobal: false })` diaplikasikan di modul root, injeksi token pada sub-modul yang lebih dalam di dalam pohon struktur akan selalu gagal. Developer diwajibkan untuk merepresentasikan skema dependensi `isGlobal: true` di root, atau melakukan *import eksplisit* `ConfigModule.forFeature(myConfig)` ke dalam setiap `imports: []` module yang membutuhkannya secara *atomic*.
3. **Integritas Penyelarasan Integrasi Validasi Zod / Joi:**
   `registerAs` menarik raw data `process.env` pasca proses perantara dari tahapan pengait parameter global `validate` Zod (jika menggunakan jembatan validasi paralel). Bila mekanisme skema mengubah/memaksa (`cast`) tipe data string menjadi instansi objek yang kompleks, Factory `registerAs` harus dirancang berkolaborasi dengan output yang telah dilembutkan oleh skema Zod tersebut, memastikannya *DRY* (*Don't Repeat Yourself*) dan tidak menghasilkan validasi rangkap.
4. **Mutabilitas Hot-Reload & Skala Terdistribusi:**
   *Configurational state* yang disandarkan di *memory caching* (karena properti `cache: true`) tidak mampu menoleransi pergeseran mendadak dari lingkungan, seperti mutasi parameter variabel di sistem ConfigMap di tengah lalu lintas jalan (*hot path deployment*). Bila Anda dihadapkan dengan spesifikasi toleransi nol-*downtime*, NestJS ConfigModule mungkin dipandang terlampau stagnan dan Anda dituntut mengintegrasikan agen *watcher* sekunder untuk merangsang pengosongan referensi memori secara dinamik.
undant.
