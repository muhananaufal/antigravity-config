# Arsitektur Pelokalan Multi-Bahasa Skala Global: NestJS I18n Enterprise Setup

Dokumen referensi ini menguraikan arsitektur pelokalan multi-bahasa skala global menggunakan `nestjs-i18n` di NestJS 10+ dan TypeScript 5+. Arsitektur ini dirancang untuk mendeteksi bahasa pengguna secara otomatis melalui berbagai resolver (seperti *Accept-Language HTTP Headers* dan parameter URL kustom), serta mendukung pemantulan kata ganti dinamis dengan resolusi berjenjang.

## 1. Arsitektur Deteksi Bahasa Berjenjang

```ascii
+-----------------------------------------------------------------------------------+
|                            Incoming Client Request                                |
|  Headers: Accept-Language: fr-CH, fr;q=0.9, en;q=0.8                              |
|  Query: ?lang=de                                                                  |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|                          I18n Language Resolvers                                  |
|                                                                                   |
|  1. QueryResolver: Cek query param '?lang=' (Tertinggi)                           |
|  2. HeaderResolver: Cek header 'X-Custom-Language'                                |
|  3. AcceptLanguageResolver: Ekstrak dari 'Accept-Language' (RFC 4647)             |
|  4. CookieResolver: Cek cookie 'lang'                                             |
|                                                                                   |
|  * Resolusi berhenti pada kecocokan valid pertama.                                |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|                        I18n Service (Translation Engine)                          |
|  - Load JSON/YAML files (e.g., /i18n/en/messages.json)                            |
|  - Watch mode untuk hot-reload saat development                                   |
|  - Type-safe translation keys via generated TypeScript interfaces                 |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|                            Response to Client                                     |
|  "Bonjour, Monsieur!" (Translated string)                                         |
+-----------------------------------------------------------------------------------+
```

## 2. Implementasi Enterprise Setup

### 2.1. Konfigurasi Modul I18n Global

Modul ini mengonfigurasi `nestjs-i18n` dengan parser JSON dan resolver berjenjang. Kami mengaktifkan sinkronisasi tipe (type generation) untuk keamanan kompilasi.

```typescript
import { Module } from '@nestjs/common';
import {
  AcceptLanguageResolver,
  CookieResolver,
  HeaderResolver,
  I18nModule,
  QueryResolver,
} from 'nestjs-i18n';
import { join } from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    I18nModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        fallbackLanguage: configService.get<string>('FALLBACK_LANG') ?? 'en',
        loaderOptions: {
          path: join(__dirname, '/i18n/'),
          watch: true, // Enable hot-reload in dev
        },
        typesOutputPath: join(
          __dirname,
          '../../src/generated/i18n.generated.ts',
        ),
      }),
      resolvers: [
        { use: QueryResolver, options: ['lang'] },
        new HeaderResolver(['x-custom-lang']),
        AcceptLanguageResolver,
        new CookieResolver(),
      ],
      inject: [ConfigService],
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

### 2.2. Service dan Controller (Type-Safe Translation)

Kita menggunakan `I18nService` yang diketikkan secara kuat (strongly typed) untuk mencegah kesalahan penulisan kunci terjemahan.

```typescript
import { Controller, Get, Query } from '@nestjs/common';
import { I18nService, I18nContext } from 'nestjs-i18n';
import { I18nTranslations } from '../generated/i18n.generated';

@Controller('greetings')
export class AppController {
  constructor(private readonly i18n: I18nService<I18nTranslations>) {}

  @Get('hello')
  async getHello(@Query('name') name: string): Promise<string> {
    const currentLang = I18nContext.current()?.lang ?? 'en';
    
    // Type-safe translation resolution
    const greeting = await this.i18n.translate('messages.HELLO', {
      lang: currentLang,
      args: { name: name ?? 'Guest' },
    });
    
    return greeting;
  }
  
  @Get('pronoun')
  async getPronounGreeting(
    @Query('name') name: string,
    @Query('gender') gender: 'male' | 'female' | 'neutral',
  ): Promise<string> {
    const currentLang = I18nContext.current()?.lang ?? 'en';
    
    return this.i18n.translate('messages.GREETING_WITH_PRONOUN', {
      lang: currentLang,
      args: { name, gender },
    });
  }
}
```

### 2.3. Struktur File Translasi JSON

Contoh struktur file JSON untuk bahasa Inggris (`/i18n/en/messages.json`):

```json
{
  "HELLO": "Hello, {name}!",
  "GREETING_WITH_PRONOUN": "Hello {name}, {gender, select, male {sir} female {madam} neutral {friend} other {friend}}!"
}
```

## 3. Unit dan Mock Test Suite

Pengujian menggunakan mocking terhadap `I18nService` dan `I18nContext` untuk memverifikasi resolusi resolusi bahasa dan interpolasi.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { I18nService, I18nContext } from 'nestjs-i18n';

describe('AppController I18n Tests', () => {
  let controller: AppController;
  let i18nServiceMock: jest.Mocked<I18nService>;

  beforeEach(async () => {
    i18nServiceMock = {
      translate: jest.fn(),
    } as unknown as jest.Mocked<I18nService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: I18nService,
          useValue: i18nServiceMock,
        },
      ],
    }).compile();

    controller = module.get<AppController>(AppController);
    
    // Mocking I18nContext
    jest.spyOn(I18nContext, 'current').mockReturnValue({ lang: 'fr' } as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('harus menerjemahkan pesan sapaan sesuai bahasa konteks (fr)', async () => {
    i18nServiceMock.translate.mockResolvedValue('Bonjour, John!');

    const result = await controller.getHello('John');

    expect(i18nServiceMock.translate).toHaveBeenCalledWith('messages.HELLO', {
      lang: 'fr',
      args: { name: 'John' },
    });
    expect(result).toBe('Bonjour, John!');
  });

  it('harus menggunakan fallback "en" jika I18nContext bernilai undefined', async () => {
    jest.spyOn(I18nContext, 'current').mockReturnValue(undefined);
    i18nServiceMock.translate.mockResolvedValue('Hello, Guest!');

    const result = await controller.getHello(undefined as unknown as string);

    expect(i18nServiceMock.translate).toHaveBeenCalledWith('messages.HELLO', {
      lang: 'en',
      args: { name: 'Guest' },
    });
    expect(result).toBe('Hello, Guest!');
  });
});
```

## 4. Analisis Trade-Off

**Kelebihan:**
1. **Type Safety Tinggi:** Generasi tipe otomatis mencegah kunci terjemahan yang salah diketik (typo).
2. **Fleksibilitas Deteksi:** Resolusi berjenjang memberikan kontrol presisi terhadap cara mendeteksi bahasa (query, header, cookie).
3. **Kinerja Runtime Baik:** Cache in-memory dari `nestjs-i18n` mengurangi I/O filesystem setelah inisialisasi awal.

**Kekurangan:**
1. **Overhead Memori di Startup:** Memuat banyak file terjemahan dalam berbagai bahasa dapat mengonsumsi RAM pada fase awal.
2. **Ketergantungan Konteks Async:** Menggunakan `I18nContext.current()` bergantung pada ClsHooked atau eksekusi berbasis async local storage yang memiliki overhead minor.
3. **Kompleksitas Manajemen Kunci:** Mengelola sinkronisasi kunci terjemahan antara backend dan frontend (SPA/Mobile) bisa jadi sangat repot di sistem terdistribusi.

## 5. Anti-Patterns Kritis

### Anti-Pattern 1: Menggunakan Tipe `any` atau `string` Mentah untuk Key
**❌ Salah:** Menggunakan literal string tanpa keamanan tipe, sehingga jika key dihapus di JSON, kode tidak akan mengeluh sampai runtime.
```typescript
// Bencana menunggu waktu
const msg = await this.i18n.translate('messges.hello_world' as any); // Typo 'messges' tidak terdeteksi
```
**✅ Benar:** Menggunakan tipe generik yang dihasilkan oleh `I18nModule`.
```typescript
constructor(private readonly i18n: I18nService<I18nTranslations>) {}
// Typo 'messges' akan memicu Error Kompilasi
const msg = await this.i18n.translate('messages.HELLO');
```

### Anti-Pattern 2: Fallback Tersirat pada Tingkat Database
**❌ Salah:** Mencoba menangani bahasa default manual di setiap query jika terjemahan I18n kosong.
```typescript
let title = await this.i18n.translate('items.title');
if (!title || title === 'items.title') {
  title = await db.getDefaultTitle(); // Menimbulkan N+1 bottleneck lambat
}
```
**✅ Benar:** Memastikan fallbacks ditangani oleh `nestjs-i18n` configuration secara otomatis. Menggunakan resolver default dengan konfigurasi `fallbackLanguage`.

## 6. Production Edge Cases

1. **Malicious / Terlalu Panjang Accept-Language Header:** Klien mengirimkan string Accept-Language berukuran 5MB untuk menyebabkan ReDoS (Regular Expression Denial of Service). *Solusi:* Validasi panjang maksimum header `Accept-Language` di layer middleware/WAF (Web Application Firewall) sebelum mencapai NestJS resolver.
2. **Missing Translation Key pada Bahasa Spesifik:** Key tersedia di `en.json` tetapi hilang di `fr.json`. `nestjs-i18n` akan merender key name (seperti `messages.NEW_FEATURE`) yang terlihat buruk di produksi. *Solusi:* Selalu konfigurasikan fallbacks atau jalankan CI/CD linter (seperti `i18n-ally`) untuk memblokir deployment jika terjemahan ada yang bolong.
3. **Concurreny & Hot Reload di Produksi:** Opsi `watch: true` dihidupkan di server produksi yang memicu file-system watcher yang boros CPU dan memory leak karena event listener menumpuk. *Solusi:* Pastikan `watch` dibatasi secara ketat hanya pada mode pengembangan menggunakan conditional environment variable.
