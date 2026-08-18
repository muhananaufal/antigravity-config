# Mocking DI Container Overrides: Manipulasi Penyedia NestJS Lanjutan

## Pengantar
Sistem Injeksi Ketergantungan (*Dependency Injection* / DI) adalah jantung dari ekosistem NestJS. Dalam skenario pengujian, baik unit mapun integrasi, seringkali kita dihadapkan pada situasi di mana *provider* (seperti layanan akses basis data eksternal, validasi keamanan, atau layanan penyedia pihak ketiga) tak boleh tereksekusi sebagaimana aslinya. 

Sebagai *QA Engineer* tingkat tertinggi, Anda wajib memahami seni perombakan memori statis dari kerangka kerja *Test Bed* `Test.createTestingModule` dengan memanfaatkan antarmuka `overrideProvider`, `overrideGuard`, `overrideInterceptor`, dan `overrideFilter`. Teknik sakti ini memungkinkan simulasi dan pemalsuan interaksi tanpa merusak stabilitas dan integritas sistem produksi.

---

## Arsitektur DI Overriding 

```text
+-------------------------------------------------------------+
|              NESTJS TEST MODULE OVERRIDE CYCLE              |
+-------------------------------------------------------------+
| [Module A] -> imports [Module B] -> provides [Service X]    |
|                                                             |
| TEST BED OVERRIDE:                                          |
| Test.createTestingModule({ imports: [Module A] })           |
|     .overrideProvider(Service X) <--- INJECTION TAKEOVER    |
|     .useValue({ mockMethod() })  <--- MOCK INJECTED         |
|     .compile();                                             |
+-------------------------------------------------------------+
```

## Implementasi Kode Type-Safe & Test Suite

Contoh komprehensif mengendalikan sebuah layanan pengiriman pesan jarak jauh dan *Guard* validasi sesi keamanan.

### `sms.service.ts`

```typescript
import { Injectable, Logger } from '@nestjs/common';

export interface SmsResponse {
  readonly messageId: string;
  readonly delivered: boolean;
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  public async sendNotification(phone: string, text: string): Promise<SmsResponse> {
    this.logger.log(`Sending real SMS to ${phone} with cost...`);
    // Simulasi panggilan ke vendor SMS luar negeri
    return new Promise((resolve) => setTimeout(() => {
        resolve({ messageId: `MSG-${Date.now()}`, delivered: true });
    }, 500));
  }
}
```

### `auth.guard.ts`

```typescript
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  public canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
    const token = request.headers['authorization'];

    if (!token || token !== `Bearer ${process.env.TEST_DB_PASSWORD || "Test1234!"}`) {
      throw new UnauthorizedException('Invalid API Token');
    }

    return true;
  }
}
```

### `notification.controller.spec.ts`

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { SmsService, SmsResponse } from './sms.service';
import { SessionAuthGuard } from './auth.guard';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest'; // Untuk contoh ini kita gunakan supertest umum

// --- Simulasi Controller (Biasanya terpisah di file .ts) ---
@Controller('notifications')
class NotificationController {
  constructor(private readonly smsService: SmsService) {}

  @Post('alert')
  @UseGuards(SessionAuthGuard)
  public async triggerAlert(@Body() payload: { phone: string }): Promise<SmsResponse> {
    return this.smsService.sendNotification(payload.phone, 'Critical Alert!');
  }
}
// ------------------------------------------------------------

describe('NotificationController (DI Container Overrides)', () => {
  let app: INestApplication;
  
  // Definisikan mock object dengan strict type (Tanpa any)
  const mockSmsService: Pick<SmsService, 'sendNotification'> = {
    sendNotification: jest.fn().mockResolvedValue({
      messageId: 'MOCK-MSG-001',
      delivered: true,
    }),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [NotificationController],
      providers: [SmsService],
    })
      // Ambil alih instance Service
      .overrideProvider(SmsService)
      .useValue(mockSmsService)
      
      // Ambil alih instance Guard
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true }) // Bypass total sistem Guard!
      
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should successfully bypass guard and mock SMS vendor', async () => {
    const response = await request(app.getHttpServer())
      .post('/notifications/alert')
      .send({ phone: '+628111222333' })
      .expect(201); // Created

    expect(response.body).toStrictEqual({
      messageId: 'MOCK-MSG-001',
      delivered: true,
    });
    
    // Validasi spy mock provider
    expect(mockSmsService.sendNotification).toHaveBeenCalledTimes(1);
    expect(mockSmsService.sendNotification).toHaveBeenCalledWith('+628111222333', 'Critical Alert!');
  });
});
```

---

## Analisis Trade-Off

### Kelebihan
1. **Isolasi Penuh Domain Pengujian**: Kita tidak akan secara tidak sengaja memicu layanan berbayar pihak ketiga seperti pengiriman tagihan SMS, email, atau transaksi mutasi saldo riil saat E2E.
2. **Kekuatan Testing Kasus Negatif (Negative Cases)**: Menggantikan fungsi DI memungkinkan kita memaksa sistem melemparkan *Exceptions* (*mockRejectedValue*) untuk menguji ketangguhan tangkapan *error* filter secara paksa tanpa memodifikasi logikal asli.
3. **Kemudahan Bypass Autentikasi Global**: Modifikasi menggunakan `.overrideGuard()` menyelamatkan kita dari kepelikan memalsukan tanda tangan token JWT atau sesi OAuth2 yang sangat rumit hanya untuk menguji satu rute spesifik.

### Kekurangan
1. **Risiko Pemalsuan Berlebihan (Over-mocking)**: Terlalu banyak memalsukan objek di tingkat wadah DI menyebabkan tes ini menjadi bias. Apabila struktur antarmuka (interface) di kelas aslinya berubah, test bisa saja tetap berlabel "Lulus" meskipun logika produksi hancur total jika tipe-tipe mock tidak selaras.
2. **Kompleksitas Injeksi Khusus**: Overriding provider berbasis nama string kustom atau injeksi dinamis (misalnya `@Inject('REDIS_CLIENT')`) jauh lebih sulit dikelola dan kerap menyebakan kesalahan "Provider Not Found" jika ejaan penimpaan salah.
3. **Rantai Ketergantungan Hierarkis**: Modul yang memiliki arsitektur penyedia multi-lapis (Service A -> Service B -> Service C) bisa menyulitkan proses override jika modul test-bed merakit impor eksternal utuh (deep imports).

---

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Bypass Tipe Data ke `any`
Sangat dilarang keras melonggarkan tipe data saat mendefinisikan *mock value*.

```typescript
// ❌ CONTOH SALAH - Menyelundupkan unknown/any ke mock provider
const badMockProvider: any = {
  callDatabase: () => "OK",
};
moduleFixture.overrideProvider(DatabaseService).useValue(badMockProvider);
```

```typescript
// ✅ CONTOH BENAR - Gunakan utilitas bawaan Typescript (Pick/Omit/Partial) atau antarmuka eksplisit
const strictMockProvider: Pick<DatabaseService, 'callDatabase'> = {
  callDatabase: jest.fn().mockResolvedValue("OK"),
};
moduleFixture.overrideProvider(DatabaseService).useValue(strictMockProvider);
```

### ❌ Anti-Pattern 2: Penimpaan Guard Yang Berbeda Instansi
Mengabaikan tipe Guard atau salah merujuk objek *instance* Class pada saat merombak.

```typescript
// ❌ CONTOH SALAH - Mencoba override kelas dengan instansi class lain tanpa `.useClass`
.overrideGuard(JwtAuthGuard).useValue(new LocalAuthGuard()) 
```

```typescript
// ✅ CONTOH BENAR - Gunakan `useClass` untuk Class Type overriding atau `useValue` untuk Object Override
.overrideGuard(JwtAuthGuard).useClass(MockPermissiveGuard) 
// ATAU
.overrideGuard(JwtAuthGuard).useValue({ canActivate: () => true })
```

---

## Production Edge Cases

1. **Overriding Filter Eksepsi Global**: Secara tak terduga, melakukan penimpaan `.overrideFilter(AllExceptionsFilter)` dalam modul tes seringkali gagal jika *Filter* tersebut diikat (bind) secara mutlak pada kelas Bootstrap utama (`app.useGlobalFilters(...)`) alih-alih diikat melalui registrasi Provider Modul NestJS. Penimpaan DI hanya berdampak jika Filter di-inject lewat penyedia `APP_FILTER`.
2. **Kecacatan Token Provider Dinamis**: Seringkali pustaka pihak ketiga membungkus nama kelas dalam injektor dinamis, misalnya `@InjectRepository(User)`. Cara paling aman untuk menimpanya di DI Test Bed bukanlah menimpa kelas *User*, melainkan memanggil `.overrideProvider(getRepositoryToken(User))`.
3. **Kebocoran Memori Antar Tes**: Ketika menggunakan `.useValue()` yang menyimpan data internal berbasis properti statis (*closure* global referensi mock dari `jest.fn()`), data panggilan rekaman `toHaveBeenCalledWith` dapat bocor (leak) ke blok `it` selanjutnya. Pastikan Anda selalu me-reset injeksi statis Anda di blok `beforeEach` (contoh: `jest.clearAllMocks()`) jika instance mock dideklarasikan di level ruang kelas tertinggi.
