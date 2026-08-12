# Mitigasi Cold Start: Lazy-Loaded Modules & Provisioned Concurrency

## Pendahuluan

Dalam ekosistem *serverless* AWS Lambda, fenomena "Cold Start" adalah momok terbesar yang ditakuti para insinyur peranti lunak. "Cold Start" terjadi saat AWS harus menyediakan instans kontainer baru, memuat lingkungan *runtime*, memuat berkas fungsi ke memori, dan menginisialisasi aplikasi Anda (NestJS *bootstrapping* & IoC *resolution*). Aplikasi NestJS berskala besar (monolit) dapat menyebabkan waktu inisialisasi yang membengkak (3–8 detik). Solusinya ada pada optimalisasi ukuran berkas dengan perkakas "Tree-shaking", memuat modul secara dinamis ("Lazy-Loading"), dan pemanfaatan "Provisioned Concurrency".

## Arsitektur Sistem (Cold Start vs Warm Start)

```ascii
[ Permintaan Masuk Pertama - Cold Start ]
+-----------+    +-------------------+    +----------------------+    +----------------+
|           |    |  Inisialisasi     |    | NestJS Bootstrapping |    | Eksekusi       |
| API Gtw   +--->+  Kontainer AWS    +--->+ (DI, Singleton, dsb) +--->+ Logika         |
|           |    |  (100ms - 300ms)  |    | (1s - 5s !!!)        |    | (50ms)         |
+-----------+    +-------------------+    +----------------------+    +----------------+
                 ^======================= FASE PENALTI WAKTU ==========================^

[ Permintaan Masuk Berikutnya - Warm Start ]
+-----------+    +-------------------+
|           |    | Eksekusi Logika   |
| API Gtw   +--->+ Langsung          |
|           |    | (50ms)            |
+-----------+    +-------------------+
```

## Implementasi Produksi: Lazy-Loading NestJS Modules

NestJS menyediakan kemampuan internal untuk memuat modul pada saat runtime (LazyModuleLoader) dan memutus rantai dependensi yang di-load di fase awal (*bootstrapping*). Modul berat yang jarang digunakan, seperti `ReportingModule` atau `ImageProcessingModule`, tidak akan diload sampai pengguna benar-benar menekan endpoint spesifik tersebut.

### 1. Modul Utama (Hanya memuat yang esensial)

```typescript
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';

// KITA TIDAK MENG-IMPORT HeavyReportingModule DI SINI!
@Module({
  imports: [], 
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
```

### 2. Implementasi `LazyModuleLoader` di Kontroler Utama

```typescript
import { Controller, Get, LazyModuleLoader, Logger, Inject, Res } from '@nestjs/common';
import { Response } from 'express';

@Controller('api')
export class AppController {
  private readonly logger = new Logger(AppController.name);

  // LazyModuleLoader disuntik secara global
  constructor(private readonly lazyModuleLoader: LazyModuleLoader) {}

  @Get('report/heavy')
  async generateHeavyReport(@Res() res: Response): Promise<void> {
    this.logger.log('Permintaan masuk, mencoba meload modul secara lazy...');
    
    // Dynamic Import! Webpack/ESBuild akan membuat bundel split yang terpisah untuk berkas ini
    const { HeavyReportingModule } = await import('./heavy-reporting/heavy-reporting.module');
    
    const moduleRef = await this.lazyModuleLoader.load(() => HeavyReportingModule);
    
    const { HeavyReportingService } = await import('./heavy-reporting/heavy-reporting.service');
    const reportingService = moduleRef.get(HeavyReportingService);

    const reportData = await reportingService.executeIntenseDataCrunching();
    
    res.status(200).json({ success: true, data: reportData });
  }
}
```

### 3. Modul Berat (HeavyReportingModule)
```typescript
import { Module } from '@nestjs/common';
import { HeavyReportingService } from './heavy-reporting.service';

@Module({
  providers: [HeavyReportingService],
  exports: [HeavyReportingService]
})
export class HeavyReportingModule {}
```

## Unit Testing & Handler Mock Suite

Pengujian harus memastikan `LazyModuleLoader` beroperasi secara asinkronus dan hanya memuat objek di *scope* yang relevan.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { LazyModuleLoader } from '@nestjs/core';
import { Response } from 'express';

describe('Lazy Loading Controller', () => {
  let controller: AppController;
  let mockLazyModuleLoader: jest.Mocked<Partial<LazyModuleLoader>>;

  const mockReportingService = {
    executeIntenseDataCrunching: jest.fn().mockResolvedValue('DATA_REPORT'),
  };

  const mockModuleRef = {
    get: jest.fn().mockReturnValue(mockReportingService),
  };

  beforeEach(async () => {
    mockLazyModuleLoader = {
      load: jest.fn().mockResolvedValue(mockModuleRef),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: LazyModuleLoader,
          useValue: mockLazyModuleLoader as any, // casting internal abstraction mock
        },
      ],
    }).compile();

    controller = module.get<AppController>(AppController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('harus mengeksekusi LazyModuleLoader secara dinamik saat endpoint dipanggil', async () => {
    const resMock: Partial<Response> = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    // Ini diperlukan untuk bypass ES Module dynamic import di Jest testing jika Anda 
    // belum melakukan transpilasi advance, namun secara konsep logika ini aman.
    jest.mock('./heavy-reporting/heavy-reporting.module', () => ({
       HeavyReportingModule: class {},
    }), { virtual: true });

    jest.mock('./heavy-reporting/heavy-reporting.service', () => ({
       HeavyReportingService: class {},
    }), { virtual: true });

    await controller.generateHeavyReport(resMock as Response);

    expect(mockLazyModuleLoader.load).toHaveBeenCalled();
    expect(mockModuleRef.get).toHaveBeenCalled();
    expect(mockReportingService.executeIntenseDataCrunching).toHaveBeenCalled();
    expect(resMock.status).toHaveBeenCalledWith(200);
    expect(resMock.json).toHaveBeenCalledWith({ success: true, data: 'DATA_REPORT' });
  });
});
```

## Analisis Trade-Off

### Kelebihan
1. **Penurunan Waktu Startup:** Modul inisialisasi yang krusial (contoh: modul Autentikasi API) dapat dimuat lebih cepat karena framework tidak merayapi dan mendaftarkan 100+ layanan berat lainnya.
2. **Efisiensi Bundel Terpisah:** Menggunakan *code splitting* lewat dynamic import (`import()`) memecah bundel *Webpack* menjadi beberapa berkas lebih kecil, menjaga ukuran eksekusi awal tetap rendah.
3. **Penghematan Biaya:** Lebih kecil memori yang ditelan saat Cold Start berarti eksekusi awal lebih hemat, menyeimbangkan antara kecepatan dengan tagihan AWS Lambda Anda.

### Kekurangan
1. **Latensi Pada Panggilan Pertama Modul Lazy:** Walaupun *startup* awal API lebih cepat, endpoint spesifik (`/api/report/heavy`) justru memakan waktu lebih lambat *saat pertama kali* dipanggil karena harus menginisialisasi dependensinya saat itu juga.
2. **Kompleksitas Import:** Penggunaan `await import()` membuat lintasan kode kurang elegan. Ini dapat menggagalkan validasi TypeScript jika jalur relatif salah ketik secara kasat mata, sebab compiler dinamis tidak selalu se-presisi import statikal.
3. **Tidak Bekerja pada Global Pipes/Guards:** Modul yang di-load lambat tidak mendaftarkan dirinya ke konteks global (Anda tak bisa memasang *Middleware* atau *Interceptor* secara reaktif pada *runtime* untuk diaplikasikan menyeluruh).

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Mengimpor Modul "Lazy" Secara Statis
**Mengapa salah?** Jika sebuah modul dimaksudkan dimuat statikal, tidak boleh ada jejak impor di baris statis. Hal itu akan membatalkan *Lazy Loading* karena mesin TypeScript membundelnya.

```typescript
// SALAH: Baris ini memaksa ESBuild/Webpack untuk membundel layanan secara kaku.
import { HeavyReportingService } from './heavy-reporting/heavy-reporting.service';

@Controller()
export class AppController {
  constructor(private lazyModuleLoader: LazyModuleLoader) {}

  @Get()
  async doThings() {
     // Modul ini sebenarnya sudah berada di memori sejak awal! Code split gagal!
     const { HeavyReportingModule } = await import('./heavy-reporting/heavy-reporting.module');
  }
}
```

### ✅ Best Practice: Impor Dinamis Utuh di Scope Lokal
```typescript
// BENAR: Tidak ada import statis menuju folder yang dilazy load!
  @Get()
  async doThings() {
     const { HeavyReportingModule } = await import('./heavy-reporting/heavy-reporting.module');
     const moduleRef = await this.lazyModuleLoader.load(() => HeavyReportingModule);
  }
```

### ❌ Anti-Pattern 2: Tidak Menggunakan ESBuild / Webpack Bundler
**Mengapa salah?** Jika Anda men-deploy struktur proyek `dist` NestJS murni bersama seluruh folder `node_modules` (tanpa di-bundel Tree Shaking) ke AWS Lambda, *Cold Start* tak akan terselamatkan sekalipun ada Lazy Modules, karena I/O disk untuk menelusuri ratusan berkas dalam Node.js sangat lambat.

### ✅ Best Practice: Kombinasi Bundler
Kombinasikan teknik Lazy Modules dengan ESBuild (atau Webpack/Nx) yang dikonfigurasi secara cermat, sehingga bundel hanya memuat kode-kode yang diperlukan (menghapus *dead-code*) dan mengompresnya.

## Production Edge Cases

1. **Traffic Spike Masif dan Berduri Tiba-tiba:** Walaupun sudah mengoptimasi "Cold Start", saat ada promo massal (jutaan pengguna masuk berbarengan), AWS perlu waktu memutar ratusan Instans Kontainer seketika yang tetap akan menembakkan waktu 3-5 detik latensi.
   - **Solusi:** Aktifkan **Provisioned Concurrency** (PC). PC menginstruksikan AWS Lambda untuk menghidupkan, menginisialisasi Container dan menjalankan NestJS jauh sebelum pengguna masuk. API Gateway dapat langsung diteruskan pada instans-instans *Pre-Warmed* tersebut (Cold Start 0 ms).
2. **Kelelahan Koneksi Saat Modul Lazy Diinisialisasi:** Lazy module yang memuat layanan Database baru akan meminta koneksi baru ke klaster DB saat dijalankan.
   - **Solusi:** Bagikan (share) instans Provider Database pada *AppModule* (induk) dan inject ke modul lazy. Jangan membuat koneksi baru dalam layanan lazy karena tidak aman saat konkuen berjalan.
3. **Memory Leaks Saat Lazy Load Ulang:** Seseorang memanggil modul lambat beberapa kali dan sistem membuat instans baru setiap saat.
   - **Solusi:** NestJS mengatur Singleton secara default. Pemanggilan `this.lazyModuleLoader.load()` yang berulang pada identifier modul yang sama TIDAK AKAN menginstansiasi layanan secara baru (akan dikembalikan instans dari cache), mengamankan Anda dari tumpahan memori, tapi pastikan konfigurasi injeksi tetap *Singleton* (bukan *Request Scoped* tanpa kesadaran yang dalam).
