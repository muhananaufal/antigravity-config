# Circuit Breaker & Graceful Degradation di NestJS

Konsep *Graceful Degradation* merupakan seni memastikan bahwa ketika suatu fitur atau dependensi utama mati, aplikasi Anda tidak serta merta menampilkan layar putih kematian (Crash), melainkan memberikan pengalaman yang dikurangi tapi tetap operasional (seperti rekomendasi default statis). Untuk mencapai hal ini, **Circuit Breaker Pattern** adalah pahlawan tanpa tanda jasa yang memantau tingkat kegagalan dan secara otomatis memutus sirkuit listrik ke layanan yang bermasalah.

Ini mencegah sistem menghabiskan sumber dayanya sendiri karena harus menunggu *timeout* tanpa henti pada layanan yang sudah terkapar, dan segera merutekan ke logika cadangan (*fallback*).

## Arsitektur Circuit Breaker (ASCII Diagram)

```text
State Transitions:
[ CLOSED ] -----(Errors > Threshold)-----> [ OPEN ]
   ^                                         |
   |                                         v
   +-------(Success > Threshold)------ [ HALF-OPEN ] <--(Timeout)

Flow:
          +-------------------+
          | Incoming Request  |
          +-------------------+
                    |
                    v
          +-------------------+
          |  Circuit Breaker  |--> Is OPEN? ---> YES ---> Execute Fallback Logic
          +-------------------+                            (Graceful Degradation)
                    |
                    v NO (CLOSED / HALF-OPEN)
          +-------------------+
          | Target Microservice|
          | /recommendations   |
          +-------------------+
```

## Implementasi Kode Produksi (TypeScript 5+ & NestJS 10+)

Kita akan membungkus pemanggilan eksternal dengan pustaka standar industri, misal `opossum`, di dalam sebuah service pelindung, sambil menjaganya sepenuhnya tipe-aman dan bebas kebocoran `any`.

```typescript
import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import CircuitBreaker from 'opossum';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';

/**
 * Tipe untuk kontrak balasan rekomendasi.
 */
export interface ProductRecommendation {
  id: string;
  name: string;
  confidenceScore: number;
}

@Injectable()
export class RecommendationResilienceService {
  private readonly logger = new Logger(RecommendationResilienceService.name);
  private breaker: CircuitBreaker<[string], ProductRecommendation[]>;

  constructor(private readonly httpService: HttpService) {
    const circuitBreakerOptions: CircuitBreaker.Options = {
      timeout: 3000, // Jika layanan butuh waktu lebih dari 3 detik, picu kegagalan
      errorThresholdPercentage: 50, // Buka sirkuit jika 50% permintaan gagal
      resetTimeout: 10000, // Tunggu 10 detik sebelum mencoba status HALF-OPEN
      capacity: 100, // Jendela bergulir dari 100 permintaan terakhir
    };

    // Inisialisasi breaker membungkus panggilan asli yang berisiko
    this.breaker = new CircuitBreaker<[string], ProductRecommendation[]>(
      (userId: string) => this.fetchRecommendationsUnsafe(userId),
      circuitBreakerOptions,
    );

    // Mendaftarkan fallback (Graceful Degradation) saat Breaker TERBUKA atau ada kegagalan
    this.breaker.fallback((userId: string, err: Error) => this.fallbackRecommendations(userId, err));

    // Pemantauan Transisi Status
    this.breaker.on('open', () => this.logger.warn(`🚨 Sirkuit REKOMENDASI TERBUKA! Mengalihkan ke Fallback.`));
    this.breaker.on('halfOpen', () => this.logger.log(`⚠️ Sirkuit REKOMENDASI SETENGAH TERBUKA. Menguji kesehatan...`));
    this.breaker.on('close', () => this.logger.log(`✅ Sirkuit REKOMENDASI DITUTUP. Layanan telah pulih.`));
  }

  /**
   * Fungsi inti untuk diakses oleh Controllers.
   */
  public async getRecommendations(userId: string): Promise<ProductRecommendation[]> {
    return this.breaker.fire(userId);
  }

  /**
   * Panggilan rentan terhadap layanan mikro eksternal.
   */
  private async fetchRecommendationsUnsafe(userId: string): Promise<ProductRecommendation[]> {
    try {
      const response = await lastValueFrom(
        this.httpService.get<ProductRecommendation[]>(`http://recommendation-engine.internal/api/v1/users/${userId}/recs`),
      );
      return response.data;
    } catch (error: unknown) {
      this.logger.error(`Gagal mengambil dari mesin rekomendasi: ${(error as Error).message}`);
      throw new InternalServerErrorException('Mesin rekomendasi downstream gagal');
    }
  }

  /**
   * Graceful Degradation: Kembalikan setelan generik statis tanpa menghubungi sistem lumpuh.
   */
  private fallbackRecommendations(userId: string, error: Error): ProductRecommendation[] {
    this.logger.debug(`Memicu fallback rekomendasi untuk user ${userId} akibat error: ${error.message}`);
    return [
      { id: 'DEFAULT-1', name: 'Barang Terpopuler: Sabun Mandi', confidenceScore: 0.99 },
      { id: 'DEFAULT-2', name: 'Barang Terpopuler: Pasta Gigi', confidenceScore: 0.95 },
    ];
  }
}
```

## Unit / Chaos Interceptor Mock Test Suite

Menguji bahwa Fallback berhasil terpanggil saat *threshold* dicapai tanpa menghentikan sistem keseluruhan.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { RecommendationResilienceService, ProductRecommendation } from './recommendation-resilience.service';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';

describe('RecommendationResilienceService Suite', () => {
  let service: RecommendationResilienceService;
  let mockHttpService: jest.Mocked<HttpService>;

  beforeEach(async () => {
    mockHttpService = {
      get: jest.fn(),
    } as unknown as jest.Mocked<HttpService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecommendationResilienceService,
        { provide: HttpService, useValue: mockHttpService },
      ],
    }).compile();

    service = module.get<RecommendationResilienceService>(RecommendationResilienceService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('harus mengembalikan data asli ketika layanan normal (CLOSED)', async () => {
    const mockData: ProductRecommendation[] = [{ id: '1', name: 'Test', confidenceScore: 1 }];
    mockHttpService.get.mockReturnValue(of({ data: mockData } as any));

    const result = await service.getRecommendations('user123');
    expect(result).toEqual(mockData);
    expect(mockHttpService.get).toHaveBeenCalledTimes(1);
  });

  it('harus mengembalikan data fallback ketika layanan error secara beruntun (Graceful Degradation)', async () => {
    // Simulasikan kegagalan dari eksternal
    mockHttpService.get.mockReturnValue(throwError(() => new Error('Connection refused')));

    // Fire sekali, circuit mencatat error dan memanggil fallback secara instan
    const result = await service.getRecommendations('user123');
    
    expect(result).toEqual([
      { id: 'DEFAULT-1', name: 'Barang Terpopuler: Sabun Mandi', confidenceScore: 0.99 },
      { id: 'DEFAULT-2', name: 'Barang Terpopuler: Pasta Gigi', confidenceScore: 0.95 },
    ]);
    expect(mockHttpService.get).toHaveBeenCalledTimes(1);
  });
});
```

## Analisis Trade-off

### Kelebihan
1. **Pencegahan Kelelahan Sistem (Preventing Resource Exhaustion):** Daripada thread / port jaringan menumpuk dan mati karena menunggu batas waktu 30 detik untuk 10.000 pengguna, Breaker memutuskan koneksi di lapisan internal dalam 0 milidetik, menyelamatkan sisa sistem Anda.
2. **Pengalaman Pengguna Tanpa Putus:** Melalui *Graceful Degradation*, pelanggan tetap bisa berbelanja barang *default*, yang berarti aliran pendapatan / bisnis tetap berjalan meski engine pintar AI sedang sekarat.
3. **Pemulihan Otomatis (Self-Healing):** Peralihan *Half-Open* memungkinkan pengecekan kesehatan otomatis terhadap sistem *downstream* tanpa perlu pemulihan manusia (*human intervention*) melalui restart pod manual.

### Kekurangan
1. **Konfigurasi Ambang Batas yang Sulit:** Sangat menantang untuk menyetel angka pasti `errorThresholdPercentage` dan `timeout` dengan benar. Jika disetel terlalu sensitif, sistem akan bergoyang-goyang antara Open dan Closed secara acak, yang menyebabkan kelaparan ketersediaan.
2. **Logika Fallback Menjadi Kotor:** Seiring berjalannya waktu, data statis cadangan (*fallback*) dapat menjadi tidak relevan secara bisnis jika tidak dirawat.
3. **Penyembunyian Kesalahan yang Tak Terlihat:** Jika tim pemantau tidak menangkap peristiwa `open` dari *breaker*, sistem seolah berjalan mulus padahal sesungguhnya engine rekomendasi mati selama berminggu-minggu tanpa disadari, karena metrik HTTP level atas selalu membalas 200 OK dengan konten statis.

## Anti-Patterns

### ❌ Anti-Pattern 1: Nesting Try/Catch Polos sebagai Pengganti Circuit Breaker
**Masalah:** Menggunakan penangkapan error `catch` secara polos tanpa jendela hitungan akan tetap mengakibatkan *timeout* yang lambat dan menghancurkan CPU untuk SETIAP permintaan baru.
```typescript
// SALAH: Tidak menghentikan antrian banjir.
async fetch() {
  try {
     return await axios.get('http://api', { timeout: 30000 }); // Tunggu 30 detik pada setiap request!
  } catch (err) {
     return staticData;
  }
}
```
✅ **Solusi Benar:** Gunakan mekanisme *Circuit Breaker* persisten (Opossum/Resilience4j style) dengan transisi State (Closed->Open).

### ❌ Anti-Pattern 2: Fallback yang Sama-sama Rapuh
**Masalah:** Menyediakan logika Fallback yang berpotensi memanggil database sekunder melalui jaringan. Jika jaringan mati sepenuhnya, sistem fallback Anda JUGA akan hancur dan batas eksekusi terbakar ganda.
✅ **Solusi Benar:** Logika fallback harus selalu beroperasi sepenuhnya di memori (in-memory statis cache) atau perhitungan murni tanpa I/O.

## Production Edge Cases

1. **Efek Teromol Badai saat Half-Open (The Half-Open Thunder):** Dalam keadaan setengah terbuka (Half-Open), jika *Breaker* melepaskan 1 permintaan saja tetapi bersamaan ada 100 instance dari layanan NestJS yang juga memasuki mode *Half-Open*, layanan lumpuh *downstream* tiba-tiba dihentak oleh 100 permintaan serentak yang mematikannya lagi seketika. Solusi tingkat lanjut membutuhkan *Distributed Circuit Breaker* menggunakan Redis untuk menyelaraskan State secara klaster.
2. **Keterbatasan Cache Memory di Fallback:** Jika fallback yang digunakan perlu melayani halaman cache statis besar dari RAM kepada seribu pengguna, itu bisa memicu OOM (Out Of Memory) di dalam proses Node.js. Ukuran konten *Graceful Degradation* harus seminimal mungkin.
3. **Pemisahan Kekhawatiran (*Separation of Concerns*):** Panggilan gRPC sering kali tidak berinteraksi baik dengan Circuit Breaker berbasis HTTP murni (axios). Untuk arsitektur NestJS gRPC, *Circuit Breaker* khusus gRPC interceptor (seperti pola Envoy sidecar) diperlukan untuk ketangguhan yang setara.
