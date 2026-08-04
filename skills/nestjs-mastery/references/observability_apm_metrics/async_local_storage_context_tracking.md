# AsyncLocalStorage (ALS) Request Context Tracking di NestJS

Menjalankan ribuan permintaan konkuren (Concurrent Requests) di dalam paradigma *Single-Threaded Event Loop* NodeJS membawa tantangan serius: Bagaimana melacak variabel spesifik satu permintaan (seperti `Trace-ID`, `User-ID`, `Tenant-ID`) melalui puluhan lapis abstraksi (*Controller -> Service -> Repository -> External API*) tanpa menulis boilerplate `context` berulang-ulang di argumen setiap fungsi? Modul bawaan NodeJS `AsyncLocalStorage` (ALS) menyelesaikan ini secara elegan melalui transmisi status secara pasif.

## 1. Arsitektur Isolasi Konteks ALS (Propagasi Pasif)

Diagram ini mengilustrasikan bagaimana ALS memungkinkan sub-rantai asinkron (*Promises*) untuk membaca "Ruang Memori Global Semu" (Pseudo-Global) yang benar-benar terisolasi dari *request* klien lain secara konkuren.

```ascii
      Request A (Trace ID: 111)           Request B (Trace ID: 222)
                 |                                   |
                 V                                   V
+-----------------------------------+-----------------------------------+
|  ALS Middleware (Store Init: 111) | ALS Middleware (Store Init: 222)  |
+-----------------------------------+-----------------------------------+
                 |                                   |
                 | (Event Loop Switching, Concurrent)|
                 V                                   V
        +------------------+                +------------------+
        | Service A Task 1 |                | Service B Task 1 |
        +------------------+                +------------------+
                 | (No args passed down!)            |
                 V                                   V
        +------------------+                +------------------+
        | Repository Save  |                | Cache Redis Get  |
        +------------------+                +------------------+
                 |                                   |
[ALS.getStore()  |                  [ALS.getStore()  |
 returns 111]    |                   returns 222]    |
                 V                                   V
```

## 2. Analisis Trade-Off

### Kelebihan (Pros)
1. **Pembersihan Kode Bersih (Clean Code):** Menghilangkan *Prop Drilling*! Anda tidak perlu lagi melewatkan parameter `(..., userToken, traceId, tenantId)` ke setiap tanda tangan fungsi internal bisnis.
2. **Audit Logging Sepenuhnya Transparan:** Modul ORM (seperti Prisma/TypeORM) atau Winston/Pino logger internal dapat mencabut `Trace ID` secara mandiri dari Store tanpa modifikasi lapisan perantara.
3. **Pemisahan Multi-Tenant Lanjutan (RLS):** Untuk aplikasi berbasis SaaS, dapat otomatis menyuntikkan ID Penyewa (Tenant ID) ke kueri Row-Level Security (RLS) PostgreSQL tanpa campur tangan eksplisit *Developer*.

### Kekurangan (Cons)
1. **Penalti Kinerja Minor:** `AsyncLocalStorage` sedikit lebih berat dibanding fungsi NodeJS standar (berkisar < 5% overhead I/O) karena melacak rantai eksekusi *Promise Hooks* di V8.
2. **Ancaman Kehilangan Konteks (Context Loss):** Menggunakan utilitas asinkron warisan (`EventEmitter`, modifikasi antrean global seperti `setTimeout`, sambungan paket lama) sering kali mematahkan untaian janji, yang berarti konteks di-reset jadi `undefined`.
3. **Kesulitan Debugging:** Jika `undefined` muncul tiba-tiba di lapisan basis data, melacak fungsi persis mana yang merusak konteks (Context Dropping) ibarat mencari jarum di tumpukan jerami.

## 3. Production Edge Cases

1. **EventEmitter / RxJS Context Loss:** Observables (`rxjs`) RxJS kustom atau modifikasi aliran sering secara tak terduga lolos dari konteks pelacakan `async_hooks`. Solusi: Menggunakan pustaka pihak ketiga pelengkap seperti `@nestjs/cls` yang memiliki *patching* tambahan atau membungkus emit dengan `als.run()`.
2. **Batched Operations (Cron / Queues):** Latar belakang *Cron Jobs* atau operasi *BullMQ* tidak memicu aliran `HTTP Middleware`, maka ALS *Store* secara otomatis kosong. Solusi: Menerapkan *Interceptor* atau *Decorator* khusus pada pekerja *Cron/Queue* untuk meniru inisialisasi awal `ALS.run(...)`.
3. **Kebocoran Memori Objek Konteks (Memory Leaks):** Memasukkan objek masif (seperti seluruh instance Request `express`) ke dalam ALS membuang jejak referensi *Garbage Collector*. Solusi: Simpan hanya string primadona berbobot ringan (TraceID, UserID, TenantID).

## 4. Anti-Patterns Kritis

### Anti-Pattern 1: Menyimpan Objek Penuh (*Heavy Objects*) di Store
**❌ Salah:** Menyimpan ribuan kilobita memori ke konteks yang tertunda selama siklus RPC.
```typescript
const store = new AsyncLocalStorage<Request>(); 
// Seluruh referensi socket dan headers tertahan!
store.run(expressRequest, () => { next(); });
```

**✅ Benar:** Membentuk struktur ringan khusus.
```typescript
interface RequestContext { traceId: string; userId?: string; }
const store = new AsyncLocalStorage<RequestContext>();
```

### Anti-Pattern 2: Asumsi Kehadiran Konteks secara Absolut
**❌ Salah:** Jika dijalankan via Cron, kode ini meledak tanpa peringatan karena `.getStore()` bisa menghasilkan undefined.
```typescript
const trace = als.getStore().traceId; // Error Cannot read properties of undefined!
```

**✅ Benar:** Selalu tambahkan perlindungan pengecekan (Fallback Default).
```typescript
const trace = als.getStore()?.traceId ?? 'cron-system-trace';
```

## 5. Implementasi ALS (Module, Store, Middleware, Service)

Implementasi berorientasi Type-Safe murni menggunakan modul bawaan *Node.js AsyncLocalStorage*.

```typescript
import { AsyncLocalStorage } from 'async_hooks';
import { Injectable, NestMiddleware, Module, Scope, Global } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

// 1. Tentukan Bentuk Kontrak Data (Type Safe)
export interface RequestContext {
  traceId: string;
  tenantId?: string;
  userId?: string;
}

// 2. Singleton Ekspor ALS Store
export const RequestContextStore = new AsyncLocalStorage<RequestContext>();

// 3. Service Injeksi (Aman diakses tanpa merusak arsitektur modul)
@Injectable()
export class ContextService {
  public getContext(): RequestContext | undefined {
    return RequestContextStore.getStore();
  }

  public getTraceId(): string {
    return this.getContext()?.traceId ?? 'system-unknown-trace';
  }
}

// 4. Middleware: Gerbang Utama Pembentukan Ruang Waktu Konteks
@Injectable()
export class ContextMiddleware implements NestMiddleware {
  public use(req: Request, res: Response, next: NextFunction): void {
    const traceId = (req.headers['x-trace-id'] as string) || randomUUID();
    const tenantId = req.headers['x-tenant-id'] as string | undefined;

    const context: RequestContext = { traceId, tenantId };

    // Mengeksekusi 'next()' di DALAM lingkup ALS memori isolasi!
    RequestContextStore.run(context, () => {
      // Menyuntikkan kembali Trace ID ke respon, untuk debugging klien
      res.setHeader('x-trace-id', traceId);
      next();
    });
  }
}

// 5. App Module
@Global()
@Module({
  providers: [ContextService],
  exports: [ContextService],
})
export class ContextModule {}
```

## 6. Unit Testing Suite (ALS Context Isolation & Retention)

Kita wajib mengonfirmasi bahwa fungsi `.run()` benar-benar tidak bertabrakan jika dipanggil dua kali secara paralel (simulasi permintaan simultan).

```typescript
import { RequestContextStore, ContextService } from './context.module';

describe('AsyncLocalStorage (ALS) Request Context', () => {
  let contextService: ContextService;

  beforeEach(() => {
    contextService = new ContextService();
  });

  it('Should return default value when accessed OUTSIDE context', () => {
    // Di luar middleware `run()`, nilai harus hilang.
    const store = RequestContextStore.getStore();
    expect(store).toBeUndefined();
    expect(contextService.getTraceId()).toBe('system-unknown-trace');
  });

  it('Should isolate context strictly among concurrent executions', async () => {
    const runConcurrently = async (traceId: string) => {
      return new Promise<string>((resolve) => {
        // Lingkup eksekusi asinkron A/B
        RequestContextStore.run({ traceId }, async () => {
          // Menunggu acak, simulasi Query DB
          await new Promise((r) => setTimeout(r, Math.random() * 50));
          
          // Membaca Context via service
          resolve(contextService.getTraceId());
        });
      });
    };

    // Meluncurkan 3 permintaan paralel bersamaan (Race Conditions)
    const [resultA, resultB, resultC] = await Promise.all([
      runConcurrently('TRACE-AAA'),
      runConcurrently('TRACE-BBB'),
      runConcurrently('TRACE-CCC'),
    ]);

    // Setiap konteks asinkron dipertahankan & tidak tumpang tindih
    expect(resultA).toBe('TRACE-AAA');
    expect(resultB).toBe('TRACE-BBB');
    expect(resultC).toBe('TRACE-CCC');
  });
});
```
