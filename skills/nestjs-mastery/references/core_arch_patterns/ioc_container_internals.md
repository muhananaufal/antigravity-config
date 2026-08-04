# Internal Mesin Dependency Injection (DI) NestJS dan Inversion of Control (IoC)

Dependency Injection (DI) pada NestJS bukan sekadar syntactic sugar; ia merupakan implementasi Inversion of Control (IoC) container berbasis metadata (menggunakan `reflect-metadata`) yang sangat kuat dan kompleks. Memahami mesin internal DI sangat penting untuk membangun aplikasi enterprise yang efisien.

## Arsitektur Internal IoC Container

Dalam NestJS, setiap module memiliki instance IoC containernya sendiri (meskipun ada hierarki global dan pewarisan). Ketika aplikasi di-bootstrap, NestJS memindai metadata (dekorator `@Injectable()`, `@Module()`, dll), membuat graf dependensi (dependency graph), dan melakukan resolusi topologi untuk menginisialisasi provider sesuai urutan yang tepat.

```ascii
+-------------------------------------------------------------+
|                     NestFactory.create()                    |
|                              |                              |
|   +--------------------------v--------------------------+   |
|   |                  Metadata Scanner                   |   |
|   |  (Membaca @Module, @Injectable, @Controller)        |   |
|   +--------------------------+--------------------------+   |
|                              |                              |
|   +--------------------------v--------------------------+   |
|   |               Dependency Graph Builder              |   |
|   |  (Menganalisis ketergantungan constructor/property) |   |
|   +--------------------------+--------------------------+   |
|                              |                              |
|   +--------------------------v--------------------------+   |
|   |                 Instance Loader & DI                |   |
|   |  (Menyuntikkan token dari Module/Global Container)  |   |
|   |                                                     |   |
|   |  +-----------------+  +-----------------+           |   |
|   |  | Singleton Cache |  |  Request Scope  |           |   |
|   |  | (Default)       |  |  Tree Builder   |           |   |
|   |  +-----------------+  +-----------------+           |   |
|   +-----------------------------------------------------+   |
+-------------------------------------------------------------+
```

## Token Mapping dan Provider Registration

NestJS memetakan provider berdasarkan Token (bisa berupa kelas, string, atau simbol).

```typescript
import { Injectable, Inject, Module, Scope } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

// 1. Class-based Token (Singleton by default)
@Injectable()
export class DatabaseConnectionPool {
  private readonly connectionId: string;
  constructor() {
    this.connectionId = `db_conn_${Math.random().toString(36).substring(7)}`;
  }
  public query(sql: string): ReadonlyArray<Record<string, string>> {
    return [{ id: '1', name: 'John Doe', connectionId: this.connectionId }];
  }
}

// 2. String Token untuk Value/Factory
export const CONFIG_TOKEN = 'APP_CONFIG';
export interface AppConfig {
  readonly maxConnections: number;
  readonly timeoutMs: number;
}

// 3. Request-Scoped Provider (Ekstrem cost performance)
@Injectable({ scope: Scope.REQUEST })
export class RequestContextTracker {
  public traceId: string;
  constructor() {
    this.traceId = `req_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }
  public getTraceId(): string {
    return this.traceId;
  }
}

@Injectable()
export class UserService {
  constructor(
    private readonly dbPool: DatabaseConnectionPool,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
    private readonly requestContext: RequestContextTracker // Bahaya: UserService akan dipaksa menjadi Request-Scoped!
  ) {}

  public async getUser(id: string): Promise<Record<string, string> | null> {
    const result = this.dbPool.query(`SELECT * FROM users WHERE id = ${id}`);
    if (result.length === 0) {
      return null;
    }
    return {
      ...result[0],
      configMaxConn: String(this.config.maxConnections),
      traceId: this.requestContext.getTraceId()
    };
  }
}

@Module({
  providers: [
    DatabaseConnectionPool,
    {
      provide: CONFIG_TOKEN,
      useValue: { maxConnections: 100, timeoutMs: 5000 }
    },
    RequestContextTracker,
    UserService
  ],
  exports: [UserService]
})
export class UserModule {}
```

## Unit Test & Integritas IoC

```typescript
describe('UserModule DI & Scope Integrity', () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [UserModule],
    }).compile();
  });

  it('should inject correct config value', async () => {
    const config = moduleRef.get<AppConfig>(CONFIG_TOKEN);
    expect(config.maxConnections).toBe(100);
    expect(config.timeoutMs).toBe(5000);
  });

  it('should resolve UserService as scoped provider due to RequestContextTracker dependency', async () => {
    // Karena RequestContextTracker adalah Scope.REQUEST, UserService akan ikut menjadi Scope.REQUEST
    const ctxId1 = { id: 1 };
    const ctxId2 = { id: 2 };
    
    // ResolveInstanceCache
    const userService1 = await moduleRef.resolve<UserService>(UserService, ctxId1);
    const userService2 = await moduleRef.resolve<UserService>(UserService, ctxId2);
    
    const dbPool1 = await moduleRef.resolve<DatabaseConnectionPool>(DatabaseConnectionPool, ctxId1);
    
    expect(userService1).not.toBe(userService2); // Harus instance yang berbeda karena scope request yang berbeda
    expect(userService1['requestContext'].getTraceId()).not.toBe(userService2['requestContext'].getTraceId());
  });
});
```

## Analisis Trade-Off: Singleton vs Request Scope

**Kelebihan Singleton Scope:**
1. **Performa Memori Optimal:** Hanya dialokasikan sekali saat aplikasi bootstrap.
2. **Kecepatan Inisialisasi:** Tidak ada overhead saat request HTTP masuk (semua class sudah siap di RAM).
3. **Koneksi Stabil:** Sangat cocok untuk resource berat seperti Connection Pool atau gRPC client.

**Kekurangan Singleton Scope:**
1. **Kekurangan Konteks Request:** Tidak bisa secara native menyimpan state yang spesifik untuk request tertentu (seperti `req.user` atau `traceId`) tanpa bantuan AsyncLocalStorage.
2. **Risiko Kebocoran State:** Jika developer menyimpan mutasi di property class, data tersebut akan bocor ke request pengguna lain.
3. **Sulit Isolasi Tenancy:** Untuk multi-tenancy dinamis (tenant per request), Singleton tidak dapat berganti konfigurasi tanpa modifikasi.

**Kelebihan Request Scope:**
1. **Isolasi Penuh:** Setiap request mendapatkan instance tree yang baru (aman dari state leakage).
2. **Konteks Spesifik:** Sangat mudah mengakses request/response headers dan session langsung via constructor.
3. **Multi-Tenancy:** Memudahkan injeksi koneksi database yang dinamis per ID Tenant.

**Kekurangan Request Scope (Ekstrem Cost):**
1. **Garbage Collection (GC) Hell:** Ratusan objek dibuat per HTTP request dan segera dihancurkan. Ini menyebabkan tekanan besar pada GC Node.js.
2. **Penurunan TPS Drastis:** Performa Throughput Per Second (TPS) dapat turun 20-50% dibanding Singleton karena overhead IoC per request.
3. **Scope Bubbling:** Satu service Request-Scoped yang disuntikkan ke service Singleton akan memaksa service Singleton tersebut menjadi Request-Scoped, merusak struktur performa aplikasi.

## Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan State Mutabel di Singleton
```typescript
@Injectable() // Default: Singleton
export class BadAuthService {
  private currentUser: Record<string, string>; // Bencana State Leakage!

  public setUser(user: Record<string, string>): void {
    this.currentUser = user; 
  }
  public getUser(): Record<string, string> {
    return this.currentUser;
  }
}
```

### ✅ Solusi Benar: Pass state di method argument (Stateless Service) atau gunakan `AsyncLocalStorage`
```typescript
@Injectable()
export class GoodAuthService {
  // Pure function, tidak menyimpan state
  public extractUser(token: string, secret: string): Record<string, string> {
    return { token, decoded: 'true' };
  }
}
```

### ❌ Anti-Pattern 2: Dependency Bubbling Tanpa Sadar
Memasukkan Request-Scoped provider ke dalam Global Singleton provider yang besar tanpa disadari.
```typescript
@Injectable({ scope: Scope.REQUEST })
export class ReqLogger {}

@Injectable() // Menjadi Request-Scoped karena ReqLogger!
export class GiantEnterpriseService {
  // Ini butuh waktu lama untuk inisialisasi, dan sekarang dilakukan setiap request.
  constructor(private reqLog: ReqLogger) {} 
}
```

### ✅ Solusi Benar: Gunakan AsyncLocalStorage untuk konteks log, hindari `Scope.REQUEST` sebisa mungkin.

## Production Edge Cases

1. **Circular Dependency Crash:** A bergantung ke B, B bergantung ke A. NestJS akan gagal boot (Undefined injection). Solusi: gunakan `@Inject(forwardRef(() => A))` namun arsitektur sebaiknya direfaktor untuk menggunakan abstraksi ketiga atau Events/PubSub.
2. **Memory Leak pada Custom Providers Factory:** `useFactory` yang menciptakan instance baru dengan event listener eksternal tanpa menangani `OnModuleDestroy` akan menimbulkan kebocoran memori (listener menumpuk).
3. **Lazy Module Loading Deadlocks:** Saat menggunakan `LazyModuleLoader` secara dinamis dari dalam sebuah route, jika terjadi lonjakan trafik konkuren (Thundering Herd) sebelum modul selesai diloading, aplikasi dapat menahan koneksi dan menyebabkan event loop starvation.
