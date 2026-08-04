# Fault Injection dengan Kustom NestJS Interceptors

Dalam lanskap *Chaos Engineering* tingkat produksi, keandalan bukan sekadar tujuan, melainkan hasil dari pengujian yang terus-menerus dan disengaja. Di NestJS, kita dapat memanfaatkan kekuatan **Interceptors** untuk secara dinamis menyuntikkan kegagalan, latensi, dan kelainan langsung ke dalam *pipeline* permintaan di lingkungan pementasan (Staging) atau Canary. Teknik ini secara langsung memvalidasi bagaimana sistem kita berperilaku di bawah tekanan jaringan yang tidak menentu atau kegagalan *downstream*.

Tujuan utama dari `ChaosInterceptor` adalah untuk secara proaktif "menghancurkan" sistem dalam kondisi yang terkontrol. Hal ini mengungkap kelemahan yang tersembunyi, kebocoran memori, kesalahan pengaturan batas waktu (*timeout*), dan memvalidasi mekanisme pemulihan seperti *Circuit Breakers* atau percobaan ulang otomatis (*Automatic Retries*).

## Arsitektur Chaos Interceptor (ASCII Diagram)

```text
       +-------------------+       +-----------------------+       +-------------------+
       |                   |       | Chaos Interceptor     |       |                   |
User ->|  NestJS Gateway   |------>| [x] 10% Packet Drop   |------>| Target Controller |
       |                   |       | [~] 5s Latency Spike  |       |                   |
       +-------------------+       | [!] 500 DB Error Inj  |       +-------------------+
                                   +-----------------------+                |
                                               ^                            | (Success or Injected Error)
                                               |                            v
                                    +----------------------+        +-------------------+
                                    | ConfigService (.env) |        | HTTP Response     |
                                    | CHAOS_ENABLED=true   |        | 200 OK / 500 Err  |
                                    +----------------------+        +-------------------+
```

## Implementasi Kode Produksi (TypeScript 5+ & NestJS 10+)

Berikut adalah implementasi `ChaosInterceptor` yang komprehensif, tipe-aman, dan dapat diandalkan yang disuntikkan secara dinamis berdasarkan konfigurasi.

```typescript
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, throwError, timer } from 'rxjs';
import { delay, switchMap, tap } from 'rxjs/operators';
import { randomInt } from 'crypto';

/**
 * Konfigurasi untuk Chaos Engineering yang didefinisikan ketat.
 */
interface ChaosConfiguration {
  enabled: boolean;
  dropRate: number; // Persentase kemungkinan memutus koneksi (0-100)
  latencySpikeRate: number; // Persentase kemungkinan menambah latensi
  latencySpikeMs: number; // Durasi latensi tambahan dalam milidetik
  error500Rate: number; // Persentase kemungkinan menyuntikkan HTTP 500
}

@Injectable()
export class ChaosInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ChaosInterceptor.name);
  private readonly config: ChaosConfiguration;

  constructor(private readonly configService: ConfigService) {
    // Pengambilan konfigurasi yang ketat dan fallback yang aman (defaults to 0 for safety)
    this.config = {
      enabled: this.configService.get<string>('CHAOS_ENABLED') === 'true',
      dropRate: parseInt(this.configService.get<string>('CHAOS_DROP_RATE') ?? '0', 10),
      latencySpikeRate: parseInt(this.configService.get<string>('CHAOS_LATENCY_RATE') ?? '0', 10),
      latencySpikeMs: parseInt(this.configService.get<string>('CHAOS_LATENCY_MS') ?? '5000', 10),
      error500Rate: parseInt(this.configService.get<string>('CHAOS_ERROR_RATE') ?? '0', 10),
    };
  }

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.config.enabled) {
      return next.handle();
    }

    const rollDrop = this.rollDice();
    if (rollDrop < this.config.dropRate) {
      this.logger.warn(`[CHAOS] Menyuntikkan pemutusan jaringan paksa (Packet Drop).`);
      return throwError(() => new HttpException('Service Unavailable (Chaos Injection)', HttpStatus.SERVICE_UNAVAILABLE));
    }

    const rollError = this.rollDice();
    if (rollError < this.config.error500Rate) {
      this.logger.error(`[CHAOS] Menyuntikkan kesalahan internal server (HTTP 500).`);
      return throwError(() => new HttpException('Internal Server Error (Chaos Injection)', HttpStatus.INTERNAL_SERVER_ERROR));
    }

    const rollLatency = this.rollDice();
    if (rollLatency < this.config.latencySpikeRate) {
      this.logger.debug(`[CHAOS] Menyuntikkan lonjakan latensi sebesar ${this.config.latencySpikeMs}ms.`);
      return timer(this.config.latencySpikeMs).pipe(
        switchMap(() => next.handle()),
        tap(() => this.logger.debug(`[CHAOS] Latensi selesai dieksekusi.`))
      );
    }

    return next.handle();
  }

  /**
   * Menghasilkan angka acak antara 0 hingga 99 untuk probabilitas.
   */
  private rollDice(): number {
    return randomInt(0, 100);
  }
}
```

### Module Setup

```typescript
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ChaosInterceptor } from './chaos.interceptor';
import { AppController } from './app.controller';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [AppController],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: ChaosInterceptor,
    },
  ],
})
export class AppModule {}
```

## Unit / Chaos Interceptor Mock Test Suite

Pengujian ini menggunakan pemalsuan fungsi `randomInt` untuk menguji secara deterministik skenario kegagalan.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, CallHandler, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChaosInterceptor } from './chaos.interceptor';
import { of, lastValueFrom } from 'rxjs';
import * as crypto from 'crypto';

describe('ChaosInterceptor Suite', () => {
  let interceptor: ChaosInterceptor;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockCallHandler: jest.Mocked<CallHandler>;

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn(),
    } as unknown as jest.Mocked<ConfigService>;

    mockCallHandler = {
      handle: jest.fn().mockReturnValue(of('success')),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChaosInterceptor,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    interceptor = module.get<ChaosInterceptor>(ChaosInterceptor);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('harus meloloskan permintaan jika chaos dinonaktifkan', async () => {
    mockConfigService.get.mockImplementation((key: string) => {
      if (key === 'CHAOS_ENABLED') return 'false';
      return null;
    });

    const context = {} as ExecutionContext;
    const result = await lastValueFrom(interceptor.intercept(context, mockCallHandler));

    expect(result).toBe('success');
    expect(mockCallHandler.handle).toHaveBeenCalled();
  });

  it('harus melempar HttpException 503 jika packet drop memicu', async () => {
    mockConfigService.get.mockImplementation((key: string) => {
      if (key === 'CHAOS_ENABLED') return 'true';
      if (key === 'CHAOS_DROP_RATE') return '100'; // 100% chance
      return '0';
    });

    // Remount interceptor to read new config
    const customInterceptor = new ChaosInterceptor(mockConfigService);
    jest.spyOn(crypto, 'randomInt').mockReturnValue(50); // Roll 50 < 100

    const context = {} as ExecutionContext;
    await expect(lastValueFrom(customInterceptor.intercept(context, mockCallHandler))).rejects.toThrow(
      new HttpException('Service Unavailable (Chaos Injection)', HttpStatus.SERVICE_UNAVAILABLE),
    );
  });

  it('harus menunda permintaan jika latency spike memicu', async () => {
     mockConfigService.get.mockImplementation((key: string) => {
      if (key === 'CHAOS_ENABLED') return 'true';
      if (key === 'CHAOS_LATENCY_RATE') return '100'; // 100% chance
      if (key === 'CHAOS_LATENCY_MS') return '50'; // 50ms for test speed
      return '0';
    });

    const customInterceptor = new ChaosInterceptor(mockConfigService);
    jest.spyOn(crypto, 'randomInt').mockReturnValue(50); // Roll 50 < 100

    const context = {} as ExecutionContext;
    const start = Date.now();
    const result = await lastValueFrom(customInterceptor.intercept(context, mockCallHandler));
    const duration = Date.now() - start;

    expect(result).toBe('success');
    expect(duration).toBeGreaterThanOrEqual(50);
  });
});
```

## Analisis Trade-off

### Kelebihan
1. **Validasi Pemulihan Bencana Proaktif:** Memungkinkan pengembang menemukan titik kegagalan di mana batas waktu terlalu lama atau retries mengakibatkan *Thundering Herd*.
2. **Keyakinan Skala Besar:** Memastikan bahwa infrastruktur otomatis penskalaan dan peringatan (*alerting*) benar-benar bekerja ketika layanan mikro terdegradasi.
3. **Meningkatkan Kesadaran Pengembang:** Mengubah pola pikir tim pengembangan dari "asumsi bahagia" menjadi rancangan defensif sejak awal.

### Kekurangan
1. **Bahaya Konfigurasi Tak Sengaja:** Jika variabel `CHAOS_ENABLED` bocor atau secara keliru diatur ke `true` di lingkungan Produksi, hal itu akan menyebabkan bencana buatan yang merugikan pelanggan.
2. **Kebisingan Pemantauan:** Injeksi kesalahan akan membakar metrik tingkat kesalahan (Error Budgets) dan dapat memicu *PagerDuty alerts* yang tidak perlu jika tim SRE tidak diinformasikan tentang pengujian *Chaos*.
3. **Peningkatan Latensi Dasar:** Evaluasi logika `Math.random` atau `crypto.randomInt` dan evaluasi cabang if/else pada setiap rute akan menambahkan overhead eksekusi mikrosekon meskipun fitur tersebut dimatikan (jika diikat sebagai *global interceptor*).

## Anti-Patterns

### ❌ Anti-Pattern 1: Hardcoding Prosentase Kegagalan
**Masalah:** Menggunakan angka ajaib langsung dalam kode dan mengikat *chaos logic* dengan argumen `NODE_ENV`. Hal ini menyulitkan eksperimen karena butuh *redeploy* untuk mengubah *rate* injeksi.
```typescript
// SALAH
if (process.env.NODE_ENV === 'staging') {
  if (Math.random() < 0.1) {
    throw new Error('Random Chaos');
  }
}
```
✅ **Solusi Benar:** Gunakan `ConfigService` dengan tipe-aman dan validasi yang ketat di saat inisiasi kelas. Ambil prosentase dari *Environment Variables* seperti yang dicontohkan dalam kode implementasi produksi di atas.

### ❌ Anti-Pattern 2: Menggunakan `Math.random()` untuk Probabilitas Tinggi
**Masalah:** `Math.random()` tidak memiliki keamanan kriptografi dan distribusinya dapat bias, sehingga tidak mensimulasikan distribusi kesalahan acak secara akurat di bawah beban tinggi (jutaan operasi).
✅ **Solusi Benar:** Gunakan modul bawaan Node.js `crypto.randomInt()` untuk *pseudo-randomness* yang lebih merata dan dapat diprediksi secara statistik.

## Production Edge Cases

1. **Efek Domino Kaskade (Cascading Domino Effect):** Ketika menyuntikkan latensi 5 detik, hal ini tidak hanya mempengaruhi layanan yang mencegat permintaan tersebut, tetapi akan menguras *connection pool* (kolam koneksi) server *upstream* yang memanggil layanan ini. Jika sistem *upstream* tidak memiliki *circuit breaker* atau *bulkhead*, seluruh jaring laba-laba layanan akan runtuh berantai.
2. **Konflik dengan Global Exception Filters:** Kesalahan HTTP 500 dan 503 yang disuntikkan secara buatan akan ditangkap oleh *Global Exception Filters*. Jika filter tersebut diatur untuk selalu mencetak log sebagai keparahan FATAL ke Datadog/Sentry, injeksi kekacauan akan mencemari log keamanan dan peringatan produksi secara besar-besaran. Filter harus sadar dan menyaring `Chaos Injection` untuk diabaikan dari *error reporting pipeline*.
3. **Penyumbatan Jalur Sehat (Health Check Choking):** Interceptor ini secara default akan mencegat `/health` atau prober dari Kubernetes. Jika latensi/penjatuhan paket mengenai titik akhir `/health`, Kubernetes akan salah mengira bahwa Pod sudah mati lalu merestart Pod secara prematur. **Mitigasi:** Tambahkan daftar putih (*whitelist*) rute untuk mengecualikan prober (mis. `/metrics`, `/health`, `/readiness`).
