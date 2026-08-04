# Propagasi Batas Waktu (Deadlines) & Circuit Breaker di NestJS gRPC

## Pendahuluan

Dalam lanskap komputasi terdistribusi yang sangat saling bergantung (Microservices Mesh), kegagalan tunggal pada sebuah servis hilir (*downstream*) dapat menumpuk dan membakar (*cascade*) servis hulu (*upstream*). Ketika servis lambat tidak dicegat dengan semestinya, seluruh alur koneksi (*thread/socket pools*) akan habis dipakai menunggu proses yang tak akan pernah selesai (Zombie Requests). 

Mitigasi absolut wajib menggunakan dua senjata: **Propagasi Deadline (Timeouts)** yang dikawal oleh gRPC Metadata, serta benteng pemutus arus **Circuit Breaker Pattern** memanfaatkan modul seperti *Opossum* dalam ekosistem NestJS.

## Diagram Arsitektur Isolasi Kegagalan

```ascii
+-------------+      +-------------------------+      +------------------------+
| API Gateway | ---> | Service A (Aggregator)  | ---> | Service B (Data Store) |
|   (Client)  |      |   [Circuit Breaker]     |      |  [Heavy DB Query]      |
+-------------+      +-------------------------+      +------------------------+
                          |      ^                              |
                          |      |                              |
                          v      | Timeout / 503                v
                    +--------------------+             +------------------+
                    | Opossum State:     |             | DB Overload /    |
                    | [CLOSED] -> [OPEN] |             | Deadlock         |
                    +--------------------+             +------------------+
```

## Implementasi Kode Produksi: Timeout & Circuit Breaker Interceptor

Kita mengimplementasikan pola isolasi melalui NestJS *Interceptor* agar logika Breaker dan batas waktu sepenuhnya diabstraksikan jauh dari kompleksitas *Controller*.

### 1. Interceptor Pemutus Arus (`Opossum`) & Timeouts

```typescript
import { 
  Injectable, 
  NestInterceptor, 
  ExecutionContext, 
  CallHandler, 
  RequestTimeoutException,
  ServiceUnavailableException,
  Logger
} from '@nestjs/common';
import { Observable, from, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import * as CircuitBreaker from 'opossum';

@Injectable()
export class GrpcCircuitBreakerInterceptor implements NestInterceptor {
  private readonly logger: Logger = new Logger(GrpcCircuitBreakerInterceptor.name);
  
  // Konfigurasi Breaker per rute/servis akan lebih aman, 
  // di sini kita asumsikan 1 instance untuk kesederhanaan.
  private readonly breaker: CircuitBreaker;

  constructor() {
    const options: CircuitBreaker.Options = {
      timeout: 3000, // Jika fungsi tidak selesai dalam 3 detik, paksa gagal (Timeout/Deadline)
      errorThresholdPercentage: 50, // Jika >= 50% request gagal, putuskan arus (OPEN)
      resetTimeout: 10000, // Tunggu 10 detik setelah OPEN, lalu coba sedikit request (HALF-OPEN)
      capacity: 100, // Lacak 100 panggilan dalam jendela bergulir
    };

    // Fungsi dummy pembungkus. Opossum butuh action fungsi Promise.
    this.breaker = new CircuitBreaker(
      async (action: () => Promise<unknown>) => await action(),
      options
    );

    // Logging transisi State untuk Observability
    this.breaker.on('open', () => this.logger.warn('Circuit Breaker status: TERBUKA (OPEN) - Mencegah Cascading Failure!'));
    this.breaker.on('halfOpen', () => this.logger.log('Circuit Breaker status: SETENGAH TERBUKA (HALF-OPEN) - Mencoba kembali...'));
    this.breaker.on('close', () => this.logger.log('Circuit Breaker status: TERTUTUP (CLOSED) - Sistem pulih normal.'));
  }

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const rpcContext = context.switchToRpc();
    // Jika diperlukan metadata bisa diekstrak di sini:
    // const metadata = rpcContext.getContext();

    // Membungkus eksekusi handler (next.handle()) di dalam Promise Circuit Breaker
    const execPromise = this.breaker.fire(async () => {
      // rxjs toPromise (lastValueFrom) mengeksekusi pipeline stream
      return await next.handle().toPromise();
    });

    return from(execPromise).pipe(
      catchError((error: unknown) => {
        const err = error as Error;
        if (err.message && err.message.includes('Timed out')) {
          this.logger.error('Permintaan melewati batas waktu yang diizinkan (Deadline Exceeded)');
          return throwError(() => new RequestTimeoutException('Tenggat Waktu Permintaan Terlampaui.'));
        }
        if (err.message && err.message.includes('Breaker is open')) {
           this.logger.warn('Menolak eksekusi secara instan (Fail-Fast) akibat Circuit Breaker Terbuka');
           return throwError(() => new ServiceUnavailableException('Servis Sedang Dalam Pemulihan. Silahkan coba lagi nanti.'));
        }
        return throwError(() => err);
      })
    );
  }
}
```

### 2. Menerapkan Interceptor Pada Controller

```typescript
import { Controller, UseInterceptors } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { GrpcCircuitBreakerInterceptor } from './circuit-breaker.interceptor';

export interface DataRequest { id: string; }
export interface DataResponse { value: string; }

@Controller()
// Pasang benteng pertahanan!
@UseInterceptors(GrpcCircuitBreakerInterceptor)
export class ResilientController {
  
  @GrpcMethod('RiskyService', 'FetchData')
  public async fetchData(request: DataRequest): Promise<DataResponse> {
    // Simulasi kegagalan lambat (membakar socket) jika tidak dicegat
    if (request.id === 'SLOW_ID') {
       await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    // Simulasi Error
    if (request.id === 'ERROR_ID') {
       throw new Error('Internal DB Crash');
    }

    return { value: 'Sukses Mengambil Data' };
  }
}
```

## Unit Test Circuit Breaker

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { GrpcCircuitBreakerInterceptor } from './circuit-breaker.interceptor';
import { of, throwError } from 'rxjs';
import { delay } from 'rxjs/operators';
import { lastValueFrom } from 'rxjs';

describe('GrpcCircuitBreakerInterceptor', () => {
  let interceptor: GrpcCircuitBreakerInterceptor;

  beforeEach(() => {
    interceptor = new GrpcCircuitBreakerInterceptor();
  });

  const mockExecutionContext = {
    switchToRpc: () => ({ getContext: () => ({}) }),
  } as ExecutionContext;

  it('harus meneruskan panggilan sukses (State CLOSED)', async () => {
    const mockCallHandler: CallHandler = {
      handle: () => of('SUCCESS_DATA'),
    };

    const resultStream = interceptor.intercept(mockExecutionContext, mockCallHandler);
    const result = await lastValueFrom(resultStream);
    
    expect(result).toEqual('SUCCESS_DATA');
  });

  it('harus memutus panggilan lambat akibat melebihi timeout Opossum', async () => {
    // Simulasi fungsi yang memakan waktu 4 detik (Opossum di-set 3 detik)
    const mockCallHandler: CallHandler = {
      handle: () => of('LATE_DATA').pipe(delay(4000)),
    };

    const resultStream = interceptor.intercept(mockExecutionContext, mockCallHandler);
    
    try {
      await lastValueFrom(resultStream);
      fail('Seharusnya gagal dengan exception Timeout');
    } catch (e: any) {
      expect(e.status).toBe(408); // NestJS RequestTimeoutException status code
    }
  }, 10000); // perpanjang timeout Jest
});
```

## Analisis Trade-Off

### Kelebihan
1. **Pencegahan Kematian Domino (Fail-Fast):** Menyelamatkan *memory pool* mikroservis pemanggil dengan cara gagal secepatnya (*Fail-Fast*) daripada dibiarkan menggantung menanti servis mati.
2. **Auto-Pemulihan Tanpa Intervensi:** Opossum (Circuit Breaker) secara ajaib mendeteksi ketika layanan bermasalah (*OPEN*) dan menguji pemulihan diri secara hati-hati (ping *HALF-OPEN*), menjamin *High Availability* mandiri.
3. **Propagasi Eksplisit SLA:** Memaksakan kontrak waktu respon antara mikroservis (*Service Level Agreement*). Klien tidak akan tersandera kinerja hilir (Downstream Degradation).

### Kekurangan
1. **Kehilangan Transparansi Error Asli:** Ketika state breaker adalah *OPEN*, respon yang diterima klien menjadi generik (Service Unavailable) sehingga menyamarkan masalah sesungguhnya pada basis data hilir.
2. **Kondisi Perlombaan (Race Conditions) di Konfigurasi Global:** Menggunakan satu instance Breaker untuk seluruh metode RPC dalam satu Controller sangatlah berisiko. Kegagalan satu API endpoint akan memutus akses ke seluruh endpoint lain di Controller yang sama jika di-share tanpa segregasi *Instance Key*.
3. **Tantangan State Terdistribusi:** Circuit Breaker yang berjalan di memori pod (*in-memory*) bersifat mandiri per-replica Kubernetes (Stateless Node). Sehingga satu pod Pod-A mungkin berstatus OPEN sedangkan Pod-B masih CLOSED. (Seringkali, diperlukan *Redis-based Breaker* untuk keseragaman global).

## Anti-Patterns

### 1. Menunggu Tanpa Batas Waktu ❌
Tidak menset deadline saat memanggil RPC. Ini memicu *Memory dan Connection exhaustion*.
```typescript
// SALAH ❌ (Pemanggilan tanpa Timeout)
public async getRemoteData() {
   // Jika microservice B mati/terhenti (hang), API ini akan menyandera RAM selamanya
   return await firstValueFrom(this.client.getRemote()); 
}
```

```typescript
// BENAR ✅ (Batasi RxJS Pipeline dengan Timeout)
import { timeout } from 'rxjs/operators';

public async getRemoteData() {
   return await firstValueFrom(
     this.client.getRemote().pipe(timeout(3000))
   ); 
}
```

### 2. Mengabaikan Segregasi Circuit Breaker ❌
Mengelompokkan endpoint lambat dengan endpoint cepat dalam satu Breaker Instance.
```typescript
// SALAH ❌ (Satu Breaker untuk Heavy Query & Ping)
@UseInterceptors(GlobalCircuitBreaker) // Saat fungsi Heavy gagal, fungsi Ping ikut ditolak!
export class Controller {
  // ...
}
```
*Gunakan instance `Opossum` terpisah per rute (URL / Method) via pemetaan Map/Cache!*

## Production Edge Cases

1. **Jitter Timeout Sinkronisasi Kaskade:** Ketika propagasi request melewati 4 servis A->B->C->D. Jika tiap servis menetapkan timeout statis (misal: 3s). Ketika Servis D membutuhkan 2.5s, C berhasil (total sisa 0.5s), namun B dan A menabrak total penundaan komunikasi (*Network Latency*), menyebabkan timeout tidak valid di hulu. Solusi: Kurangi (*decrement*) Deadline absolut dari metadata gRPC dan operkan kalkulasi dinamis waktu tersisa (*Remaining Time Propagation*).
2. **Thundering Herd saat Half-Open:** Ketika Breaker *HALF-OPEN*, sistem akan melewatkan 1 koneksi uji coba. Namun jika lalu lintas sangat tinggi, sinkronisasi *lock* dari State Machine di modul Opossum (versi Node.js) dapat dilewati oleh ratusan *requests* konkruen pada milidetik yang sama, membakar ulang backend. Solusi: Konfigurasi antrean ketat (Semaphore) pada rute uji coba.
3. **Kegagalan Terprediksi yang Dipaksa Breaker:** Klien mengirimkan HTTP 400 Bad Request berkali-kali. Karena terlempar (throw Error), Opossum menyangka servis rusak dan memutus sirkuit (*OPEN*). Padahal ini salah Klien! Solusi: Pastikan properti opsi `errorFilter` dari Opossum mengecualikan kode-kode *User Error* (400, 401, 403, 404), hanya menghitung kegagalan dari kode gRPC *Internal* atau 5xx HTTP.
