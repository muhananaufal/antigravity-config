# Dynamic Modules Builder dan Konfigurasi `forRootAsync` di NestJS

Modul Dinamis (Dynamic Modules) di NestJS memungkinkan kustomisasi perilaku modul pada saat runtime sebelum IoC container meresolusi dependency graph. Hal ini absolut diperlukan saat membangun *reusable library* atau saat integrasi sistem bergantung pada *asynchronous configuration* eksternal (seperti menarik secret/password dari AWS Secret Manager atau Hashicorp Vault secara asinkron sebelum DB connect).

## Topologi Alur Resolusi Dynamic Module

```ascii
+-----------------------+
|  AppModule (Imports)  |
+-----------+-----------+
            |
            | Panggilan: DatabaseModule.forRootAsync({ ... })
            v
+-----------------------+     1. Evaluasi useFactory (Asinkron)
| DynamicModule Builder | <-----------------------------------------+
| (DatabaseModule)      |                                           |
+-----------+-----------+                                           |
            |                                                       |
            | 2. Membuat Custom Provider (Token Berbasis Opsi)      |
            v                                                       |
+-----------------------+     3. Resolve Ketergantungan Factory     |
|   Provider Factory    | ------------------------------------------+
| (useFactory injector) |       (Menarik token ConfigService)
+-----------+-----------+
            |
            | 4. Return Object Konfigurasi DB Valid
            v
+-----------------------+
| Inisialisasi Koneksi  |
|  Database Singleton   |
+-----------------------+
```

## Implementasi Dynamic Module Lanjutan (Type-Safe Builder)

Pembuatan Dynamic Module standar rentan terhadap *Typo* atau _Type-Safety bypass_. Implementasi kelas atas mengandalkan antarmuka (interface) ketat untuk pola `register` / `forRoot`.

```typescript
import { DynamicModule, Module, Provider, Global, Injectable, Inject } from '@nestjs/common';

// --- 1. Definisi Tipe dan Token (Strict Typing) ---
export const DATABASE_OPTIONS_TOKEN = Symbol('DATABASE_OPTIONS_TOKEN');
export const DATABASE_CONNECTION_TOKEN = Symbol('DATABASE_CONNECTION_TOKEN');

export interface DatabaseOptions {
  readonly uri: string;
  readonly maxPoolSize: number;
}

export interface DatabaseModuleAsyncOptions {
  imports?: any[];
  inject?: any[];
  useFactory: (...args: any[]) => Promise<DatabaseOptions> | DatabaseOptions;
}

// --- 2. Core Service yang bergantung pada Opsi ---
@Injectable()
export class DatabaseConnectionManager {
  constructor(
    @Inject(DATABASE_OPTIONS_TOKEN) private readonly options: DatabaseOptions
  ) {}

  public connect(): string {
    return `Connected to ${this.options.uri} with pool ${this.options.maxPoolSize}`;
  }
}

// --- 3. Dynamic Module Builder ---
@Global() // Opsional: Jadikan modul ini global di seluruh aplikasi
@Module({})
export class DatabaseModule {
  
  // Metode Asinkron untuk injeksi konfigurasi pada startup
  public static forRootAsync(options: DatabaseModuleAsyncOptions): DynamicModule {
    const asyncOptionsProvider: Provider = {
      provide: DATABASE_OPTIONS_TOKEN,
      useFactory: options.useFactory,
      inject: options.inject || [],
    };

    // Provider untuk instance Database aktual (menunggu opsi selesai)
    const connectionProvider: Provider = {
      provide: DATABASE_CONNECTION_TOKEN,
      useFactory: async (manager: DatabaseConnectionManager) => {
        // Logika asinkron nyata, misal ping DB / create connection
        return manager.connect(); 
      },
      inject: [DatabaseConnectionManager],
    };

    return {
      module: DatabaseModule,
      imports: options.imports || [],
      providers: [
        asyncOptionsProvider,
        DatabaseConnectionManager,
        connectionProvider,
      ],
      exports: [DATABASE_CONNECTION_TOKEN], // Hanya export token connection untuk klien
    };
  }
}

// --- 4. Konsumsi di AppModule ---
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot(), // Built-in Config
    DatabaseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('DB_URI', 'localhost:5432'),
        maxPoolSize: config.get<number>('DB_POOL', 10),
      }),
    }),
  ],
})
export class AppModule {}
```

## Unit Test

```typescript
import { Test, TestingModule } from '@nestjs/testing';

describe('DynamicModule forRootAsync pattern', () => {
  it('should configure module asynchronously via factory', async () => {
    // Mock eksternal provider
    const mockConfigService = {
      get: jest.fn((key: string) => (key === 'DB_URI' ? 'test_db:3306' : 5)),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRootAsync({
          useFactory: () => ({
            uri: mockConfigService.get('DB_URI'),
            maxPoolSize: mockConfigService.get('DB_POOL'),
          }),
        }),
      ],
    }).compile();

    const connectionString = moduleRef.get<string>(DATABASE_CONNECTION_TOKEN);
    expect(connectionString).toBe('Connected to test_db:3306 with pool 5');
  });
});
```

## Analisis Trade-Off

**Kelebihan:**
1. **Fleksibilitas Penuh (Runtime Agility):** Modul dapat beradaptasi berdasarkan *environment variables* tanpa melakukan *hardcoding* konfigurasi pada decorator `@Module()`.
2. **Isolasi Pustaka (Library encapsulation):** Pola ini menjadi standar baku untuk membuat package npm reusable (mirip dengan `@nestjs/typeorm` atau `@nestjs/mongoose`).
3. **Injeksi Asinkron yang Aman (Safe Initialization):** IoC NestJS akan otomatis mem-block eksekusi Bootstrap dan provider lainnya hingga Promise dari `useFactory` diselesaikan (resolved).

**Kekurangan:**
1. **Sintaks Sangat Verbose:** Diperlukan banyak *boilerplate* (Interface Options, Provider custom, Token Symbol) yang mengintimidasi pengembang awam.
2. **Silent Failure Token:** Salah mengetik array _inject_ vs urutan parameter pada argumen *useFactory* dapat menimbulkan runtime-error 'Undefined Provider' yang sangat membingungkan saat debugging.
3. **Risiko Global Leakage:** Jika menggunakan `@Global()` sembarangan pada Dynamic Module, konfigurasi bentrok antar-instansiasi jika dipanggil (di-import) berulang kali di modul lokal berbeda.

## Anti-Patterns

### ❌ Anti-Pattern 1: Async/Await Ilegal pada Root Decorator
Melakukan operasi asinkron secara naif di luar ekosistem DI, misalnya memanggil `await` sebelum mendeklarasikan Module.
```typescript
// Bencana! Menunda bootstrapping Node.js dan merusak tree-shaking Module.
const config = await fetchSecretFromVault(); 

@Module({
  providers: [{ provide: 'CONFIG', useValue: config }] 
})
export class BadModule {}
```

### ✅ Solusi Benar: Gunakan metode `forRootAsync` / `registerAsync` dengan `useFactory` yang me-return `Promise`. IoC NestJS mendesain `useFactory` agar otomatis "menunggu" secara native.

### ❌ Anti-Pattern 2: Ketidakcocokan Urutan `inject` dan Parameter `useFactory`
```typescript
DatabaseModule.forRootAsync({
  inject: [ConfigService, HttpClient], // A (Config), B (Http)
  useFactory: (http: HttpClient, config: ConfigService) => { 
    // FATAL MISMATCH! `http` parameter akan menerima instance dari ConfigService!
    // Ini menghilangkan strict-typing dari Typescript karena any/inferred!
  }
})
```

### ✅ Solusi Benar: Selalu cocokkan indeks array urutan `inject` dengan urutan dan _Tipe_ argument fungsi yang diterima `useFactory`.

## Production Edge Cases

1. **Vault/KMS Timeout Blocking Boot:** Saat _useFactory_ mencoba mengambil konfigurasi token/password dari AWS KMS / Hashicorp Vault dan terjadi Network Timeout tak berujung (Missing timeout config), aplikasi NestJS akan *Hang* secara diam (tanpa crash) saat di-start di Kubernetes.
2. **Kebocoran Koneksi Re-Mount HMR (Hot Module Replacement):** Saat menjalankan dev mode (HMR), dynamic module memicu eksekusi `useFactory` berulang kali, membuka ribuan pool database DB connection jika logika cleanup `OnModuleDestroy` tidak diimplementasikan pada provider hasil render factory tersebut.
3. **Tumbukan Token Multi-Instances (Token Clashing):** Saat menggunakan pustaka Redis secara dinamis dan memanggil `RedisModule.registerAsync()` dua kali di modul berbeda namun nama Token untuk koneksinya di-hardcode ke string yang sama (contoh `'REDIS_CLIENT'`), instance kedua akan secara fatal menimpa (overwrite) instance pertama dalam container DI global. Solusinya, modul dinamis harus mengizinkan parameter `connectionName` dinamis untuk merubah String Token Prefix.
