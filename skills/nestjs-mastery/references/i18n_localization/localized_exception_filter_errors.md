# Localized Exception Filters & Validation Errors

Dokumen referensi mutakhir ini memetakan pola arsitektur untuk melokalisasi pesan kesalahan di NestJS. Fokus utamanya adalah membajak mekanisme *Global Exception Filters* dan *Validation Pipes* (`class-validator` / Zod) sehingga semua balasan kesalahan HTTP dikembalikan menggunakan bahasa natif (ibu) dari klien/pengguna, menaikkan kualitas pengalaman UX API.

## 1. Arsitektur Filter Intersepsi Kesalahan Terjemahan

```ascii
+---------------------------------------------------------------------------------+
|                         Client HTTP Request (lang=es)                           |
+---------------------------------------------------------------------------------+
                                       |
                                       v
+---------------------------------------------------------------------------------+
|                        NestJS ValidationPipe (Global)                           |
|  - DTO class-validator triggers validation error                                |
|  - e.g., 'email must be an email' -> BadRequestException                        |
+---------------------------------------------------------------------------------+
                                       |
                                       v
+---------------------------------------------------------------------------------+
|                        I18nValidationExceptionFilter                            |
|                                                                                 |
|  1. Intersep BadRequestException.                                               |
|  2. Ekstrak pesan validasi mentah (ValidationErrors[]).                         |
|  3. Ambil context bahasa saat ini (via I18nContext: 'es').                      |
|  4. Terjemahkan metadata pesan (mis: validation.IS_EMAIL).                      |
|  5. Format & restrukturisasi response JSON.                                     |
+---------------------------------------------------------------------------------+
                                       |
                                       v
+---------------------------------------------------------------------------------+
|                         Client HTTP Response (400)                              |
|  {                                                                              |
|    "statusCode": 400,                                                           |
|    "message": "El correo electrónico debe ser un correo válido" // Diterjemahkan|
|  }                                                                              |
+---------------------------------------------------------------------------------+
```

## 2. Implementasi Filter & DTO Produksi

### 2.1. DTO (Data Transfer Object)

Kita mendeklarasikan kunci penerjemahan (sebagai ganti teks hardcode) dalam anotator `class-validator`. `nestjs-i18n` menyediakan utilitas bawaan `i18nValidationMessage`.

```typescript
import { IsEmail, IsNotEmpty, MinLength } from 'class-validator';
import { i18nValidationMessage } from 'nestjs-i18n';

export class CreateUserDto {
  @IsNotEmpty({ message: i18nValidationMessage('validation.NOT_EMPTY') })
  @IsEmail({}, { message: i18nValidationMessage('validation.INVALID_EMAIL') })
  email!: string;

  @MinLength(6, { message: i18nValidationMessage('validation.MIN_LENGTH', { min: 6 }) })
  password!: string;
}
```

### 2.2. Filter Kesalahan Kustom & Validation Pipe Global

```typescript
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  ValidationError,
  Logger,
} from '@nestjs/common';
import { I18nService, I18nContext, I18nValidationError } from 'nestjs-i18n';
import { Response } from 'express';

@Catch(HttpException)
export class GlobalI18nExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalI18nExceptionFilter.name);

  constructor(private readonly i18n: I18nService) {}

  async catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse() as any;

    const i18nContext = I18nContext.current();
    const lang = i18nContext?.lang || 'en';

    let formattedErrors: string[] | object = exceptionResponse.message;

    // Deteksi jika ini adalah error validasi array (I18nValidationError)
    if (
      status === HttpStatus.BAD_REQUEST &&
      Array.isArray(exceptionResponse.message)
    ) {
      formattedErrors = await this.translateValidationErrors(
        exceptionResponse.message,
        lang,
      );
    } 
    // Menerjemahkan pesan HTTPException biasa
    else if (typeof exceptionResponse.message === 'string' && exceptionResponse.message.includes('.')) {
      try {
        formattedErrors = await this.i18n.translate(exceptionResponse.message, { lang });
      } catch (err) {
        this.logger.warn(`Translation key not found: ${exceptionResponse.message}`);
      }
    }

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      errors: formattedErrors,
      error: exceptionResponse.error || 'Bad Request',
    });
  }

  /**
   * Rekursif menerjemahkan list kesalahan validasi bertingkat.
   */
  private async translateValidationErrors(
    errors: I18nValidationError[],
    lang: string,
  ): Promise<Record<string, string[]>> {
    const messages: Record<string, string[]> = {};

    for (const error of errors) {
      const propertyKey = error.property;
      messages[propertyKey] = [];

      if (error.constraints) {
        for (const [key, rawMessage] of Object.entries(error.constraints)) {
          // Parsing argumen metadata nestjs-i18n
          const [translationKey, argsString] = rawMessage.split('|');
          const args = argsString ? JSON.parse(argsString) : {};

          const translated = await this.i18n.translate(translationKey, {
            lang,
            args: { property: propertyKey, ...args },
          });

          messages[propertyKey].push(translated as string);
        }
      }

      if (error.children && error.children.length > 0) {
        const nestedMessages = await this.translateValidationErrors(error.children, lang);
        Object.assign(messages, nestedMessages);
      }
    }

    return messages;
  }
}
```

### 2.3. Registrasi di `main.ts`

```typescript
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { i18nValidationErrorFactory } from 'nestjs-i18n';
import { AppModule } from './app.module';
import { GlobalI18nExceptionFilter } from './global-i18n-exception.filter';
import { I18nService } from 'nestjs-i18n';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Wajib untuk memformat ValidationErrors menjadi format I18nValidationError
  app.useGlobalPipes(
    new ValidationPipe({
      exceptionFactory: i18nValidationErrorFactory,
      whitelist: true,
    }),
  );

  // Registrasi filter pengecualian global
  const i18nService = app.get(I18nService);
  app.useGlobalFilters(new GlobalI18nExceptionFilter(i18nService));

  await app.listen(3000);
}
bootstrap();
```

## 3. Unit Test Suite Mock Filter Kesalahan

Pengujian memvalidasi bahwa intersepsi berhasil menerjemahkan string payload.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { GlobalI18nExceptionFilter } from './global-i18n-exception.filter';
import { HttpException, HttpStatus, ArgumentsHost } from '@nestjs/common';
import { I18nService, I18nContext } from 'nestjs-i18n';

describe('GlobalI18nExceptionFilter', () => {
  let filter: GlobalI18nExceptionFilter;
  let i18nServiceMock: jest.Mocked<I18nService>;

  beforeEach(async () => {
    i18nServiceMock = {
      translate: jest.fn(),
    } as unknown as jest.Mocked<I18nService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GlobalI18nExceptionFilter,
        { provide: I18nService, useValue: i18nServiceMock },
      ],
    }).compile();

    filter = module.get<GlobalI18nExceptionFilter>(GlobalI18nExceptionFilter);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('harus merespons dengan JSON terjemahan validasi', async () => {
    jest.spyOn(I18nContext, 'current').mockReturnValue({ lang: 'es' } as any);
    
    // Simulasi Exception Payload dari ValidationPipe
    const exception = new HttpException(
      {
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: [
          { property: 'email', constraints: { isEmail: 'validation.INVALID_EMAIL|{}' } },
        ],
      },
      HttpStatus.BAD_REQUEST,
    );

    // Simulasi respons HTTP
    const responseMock = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as any;
    
    const hostMock = {
      switchToHttp: jest.fn().mockReturnValue({
        getResponse: () => responseMock,
      }),
    } as unknown as ArgumentsHost;

    i18nServiceMock.translate.mockResolvedValue('Correo inválido');

    await filter.catch(exception, hostMock);

    expect(i18nServiceMock.translate).toHaveBeenCalledWith('validation.INVALID_EMAIL', {
      lang: 'es',
      args: { property: 'email' },
    });

    expect(responseMock.status).toHaveBeenCalledWith(400);
    expect(responseMock.json).toHaveBeenCalledWith({
      statusCode: 400,
      timestamp: expect.any(String),
      error: 'Bad Request',
      errors: {
        email: ['Correo inválido'],
      },
    });
  });
});
```

## 4. Analisis Trade-Off

**Kelebihan:**
1. **Pemusatan Logika Kesalahan (DRY):** Semua penterjemahan error dilakukan di dalam satu filter global yang elegan, tidak tercecer di seluruh controller.
2. **Pengalaman Pengguna Sempurna:** Klien mendapatkan error validasi yang bermakna dalam bahasa aslinya, sangat disukai tim mobile app/frontend SPA.
3. **Penyisipan Argumen Dinamis:** Meta atribut DTO (seperti `{ min: 6 }` di `MinLength`) bisa dibagikan langsung ke resolver terjemahan dengan sintaks pipe (`|`).

**Kekurangan:**
1. **Performa Parsing String:** Membelah string dengan `split('|')` pada properti error untuk mengambil meta argument menambah mikrodetik latensi parsing di beban puncak error request.
2. **Isolasi Tipe Error Validation:** Menangkap generic HttpException membatasi kita, sehingga logika spesifik array error format bisa rentan berbenturan dengan exception lain yang memiliki format message array.
3. **Muted Missing Keys:** Apabila I18n tidak menemukan kuncinya, teks akan terekspos ke klien sebagai string teknis (misal `validation.IS_EMAIL`), mengancurkan kualitas visual UI frontend jika tak dijaga.

## 5. Anti-Patterns Kritis

### Anti-Pattern 1: Hardcoding Error Translation di Service/Controller
**❌ Salah:** Mengeksekusi penerjemahan error dan melemparkan string literal yang telah diubah ke Exception. Logika pengontrol/servis tercampur penterjemahan.
```typescript
@Post()
async createUser(@Body() dto: CreateUserDto) {
  if (!isValid(dto)) {
    // Parah: Terjemahan membocorkan logika domain!
    const msg = await this.i18n.translate('errors.user_invalid');
    throw new BadRequestException(msg); 
  }
}
```
**✅ Benar:** Lempar Exception dengan format kunci (key-based), dan biarkan *Global Filter* mengekstraksi dan menerjemahkannya sebelum mencapai lapisan HTTP terakhir.

### Anti-Pattern 2: Mengabaikan Error Hirarki (Nested Errors)
**❌ Salah:** Mengambil array tingkat 1 error saja, sehingga kesalahan DTO bercabang (e.g. `@ValidateNested()`) terkubur tanpa terjemahan.
```typescript
const flattened = exceptionResponse.message.map(err => err.constraints);
// Kesalahan berantai pada nested obyek akan terbuang/hilang.
```
**✅ Benar:** Mengimplementasikan penyelesaian rekursif terhadap `error.children` (seperti `translateValidationErrors` pada blok kode di atas) sehingga sub-DTO turut diterjemahkan akurat.

## 6. Production Edge Cases

1. **Terjemahan Parameter JSON Gagal (Unescaped characters):** Jika meta string argumen pada error (`validation.ERROR|{"key":"val"}`) berisi tanda kutip ganda atau special character tak di-escape yang merusak JSON.parse. *Solusi:* Bungkus pembelahan meta I18n parsing di dalam blok `try/catch` khusus, fallback ke `{}` untuk menghindari filter melemparkan error server 500 baru akibat kegagalan parsing.
2. **Uncaught Error pada Fallback Locale:** Filter gagal me-resolve konteks karena interceptor `I18nContext` rusak di jalur request (misalnya WebSockets/GraphQL over HTTP context yang hancur). *Solusi:* Beri instruksi fallback agresif ke `lang = process.env.FALLBACK_LANG || 'en'` jika `I18nContext.current()` adalah `undefined`.
3. **Denial of Service melalui Array Validation Raksasa:** Penyerang mengirim payload array JSON isi 10,000 item. NestJS Class Validator menghentikan dan meludahkan pesan 10,000 error array ke dalam filter. Filter mencoba mengeksekusi iterasi & translasi async loop 10,000 kali. Node event-loop hang. *Solusi:* Batasi panjang array validasi maksimal (`ArrayMaxSize`) di DTO atau batasi translasi error maksimum ke 50 pertama di ExceptionFilter, lewati sisanya.
