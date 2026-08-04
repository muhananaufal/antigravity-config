# High-Performance Validation Pipes: Zod & TypeBox di Fastify (Top 1% Engineering)

## Pendahuluan
Skema validasi tradisional di NestJS menggunakan `class-validator` berbasis dekorator dan refleksi TypeScript. Meski ergonomis, pendekatan ini membawa overhead laten yang merugikan pada layanan dengan troughput sangat tinggi (seperti API Gateway, layanan FinTech, atau mesin analitik Real-Time). Setiap _request_ HTTP harus melewati fase ekstraksi metadata kelas, refleksi tipe, rekursi, dan instansiasi objek, yang secara signifikan memperlambat latensi dan membebani Garbage Collector Node.js.

Sebagai Engineer Top 1%, kita beralih ke skema kompilasi _Ahead-of-Time_ (AOT) atau pendekatan evaluasi statis yang menggunakan pustaka kinerja tinggi seperti **Zod** atau **TypeBox (Sinclair)** (yang mengadopsi standar JSON Schema). Dikombinasikan dengan engine `Fastify`, ini mampu mendongkrak performa throughput hingga 10x lipat lebih cepat.

## Arsitektur Validasi AOT (Ahead of Time) & JIT 

```ascii
+-------------------+      +-------------------------------+       +------------------+
|   Incoming HTTP   |      | Fastify Schema / Zod Pipe     |       | Type-Safe Payload|
|   JSON Request    | ---> | (Pre-Compiled / AOT/ JIT)     | ----> | In Controller    |
+-------------------+      +-------------------------------+       +------------------+
                                         |
                                         v
                         +-------------------------------+
                         | - No Reflection Overhead      |
                         | - No Class Instantiation      |
                         | - Direct Schema Validation    |
                         | - Ultra-low CPU Cycle         |
                         +-------------------------------+
```

## Implementasi Zod Validation Pipe Kinerja Tinggi

Kita akan membuat implementasi kustom `ZodValidationPipe` yang sangat optimal untuk NestJS yang langsung mem-parsing payload raw HTTP ke dalam object type-safe tanpa refleksi.

```typescript
import { 
  PipeTransform, 
  Injectable, 
  ArgumentMetadata, 
  BadRequestException 
} from '@nestjs/common';
import { ZodSchema, ZodError } from 'zod';
import { z } from 'zod';

export const CreateTransactionSchema = z.object({
  idempotencyKey: z.string().uuid(),
  amount: z.number().positive().max(1000000000),
  currency: z.enum(['IDR', 'USD', 'EUR']),
  destinationAccount: z.string().min(10).max(20).regex(/^[0-9]+$/),
  metadata: z.record(z.string()).optional(),
}).strict(); 

export type CreateTransactionDto = z.infer<typeof CreateTransactionSchema>;

@Injectable()
export class ZodValidationPipe implements PipeTransform<unknown, unknown> {
  constructor(private readonly schema: ZodSchema<unknown>) {}

  public transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body' && metadata.type !== 'query' && metadata.type !== 'param') {
      return value;
    }

    try {
      const parsedValue = this.schema.parse(value);
      return parsedValue;
    } catch (error) {
      if (error instanceof ZodError) {
        const errorMessages = error.errors.map(err => `${err.path.join('.')}: ${err.message}`);
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validasi Skema Zod Gagal',
          details: errorMessages,
        });
      }
      throw new BadRequestException('Payload Tidak Valid');
    }
  }
}
```

Dalam Controller:
```typescript
import { Controller, Post, Body, UsePipes } from '@nestjs/common';
import { ZodValidationPipe, CreateTransactionSchema, CreateTransactionDto } from './zod.pipe';

@Controller('transactions')
export class TransactionController {
  
  @Post('transfer')
  @UsePipes(new ZodValidationPipe(CreateTransactionSchema))
  public async transferFunds(
    @Body() payload: CreateTransactionDto 
  ): Promise<{ status: string }> {
    return { status: 'SUCCESS' };
  }
}
```

## Anti-Patterns Kritis

### 1. Inisialisasi Skema di Dalam Fungsi atau Controller
❌ **Salah (Memory Leak & CPU Burn):** Membuat Zod schema atau TypeBox schema di dalam logic controller atau pipe, sehingga skema dikompilasi ulang pada setiap request masuk.
```typescript
@Post()
public doSomething(@Body() body: unknown) {
  const schema = z.object({ id: z.string() });
  schema.parse(body);
}
```
✅ **Benar:** Definisikan skema secara global dan statis di luar _lifecycle_ request.
```typescript
const SchemaStatik = z.object({ id: z.string() });
```

### 2. Menggabungkan Class-Validator dan Zod
❌ **Salah (Anti-Pattern):** Membuat Class DTO, memakai dekorator `class-validator`, namun di dalam Pipe memanggil Zod lagi. Ini menimbulkan beban validasi dua kali lipat.
✅ **Benar:** Pilih salah satu skema secara eksklusif per modul atau secara keseluruhan sistem. 

## Production Edge Cases

1. **Payload JSON Ekstrem (Megabytes):** Zod mengeksekusi iterasi pada objek. Jika payload memiliki ratusan ribu *key*, ini akan memblokir *Event Loop* Node.js secara sinkronus. Solusinya adalah membatasi ukuran HTTP body menggunakan middleware Fastify `bodyLimit`.
2. **Error Message Localization:** Implementasi Zod default menghasilkan error dalam bahasa Inggris. Wajib merancang interceptor ZodErrorMap kustom sebelum melempar error ke klien.
3. **Ketidakcocokan Skema dengan OpenAPI (Swagger):** NestJS `@nestjs/swagger` mengandalkan reflection dari kelas. Dengan Zod, metadata Swagger tidak terbentuk otomatis. Wajib menggunakan adapter pihak ketiga.

## Analisis Trade-Off

**Kelebihan (Pros):**
1. **Kecepatan Ekstrem (Ultra-Fast):** Tidak ada reflection dan instansiasi kelas. Eksekusi validasi jauh lebih cepat.
2. **Keamanan (Type-Safety) Sempurna:** Zod memaksa kebenaran struktural dan tipe typescript yang mutlak secara sinkronus.
3. **SSOT (Single Source of Truth):** Inferensi tipe TS langsung dari skema validasi. Tidak ada duplikasi interface.

**Kekurangan (Cons):**
1. **Integrasi Swagger yang Kurang Mulus:** Membutuhkan librari tambahan atau penulisan skema ganda.
2. **Kurva Pembelajaran (Learning Curve):** Tim yang terbiasa dengan kelas dan dekorator butuh waktu penyesuaian.
3. **Memblokir Event Loop:** Zod berjalan sinkronus sehingga payload JSON ekstrem tetap menjadi ancaman lag sementara pada server.

## Unit Test Suite: Memastikan Akurasi ZodValidationPipe

```typescript
import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { ZodValidationPipe, CreateTransactionSchema } from './zod-validation.pipe';

describe('ZodValidationPipe Test Suite', () => {
  let pipe: ZodValidationPipe;

  beforeEach(() => {
    pipe = new ZodValidationPipe(CreateTransactionSchema);
  });

  const metadata: ArgumentMetadata = { type: 'body' };

  it('seharusnya me-return payload saat diberikan data transaksi yang sah', () => {
    const validPayload = {
      idempotencyKey: 'a90f1ee-6c54-4b01-90e6-d701748f0851',
      amount: 500000,
      currency: 'IDR',
      destinationAccount: '123456789012',
    };

    const result = pipe.transform(validPayload, metadata);
    expect(result).toStrictEqual(validPayload);
  });

  it('seharusnya melempar BadRequestException saat data di luar jangkauan (amount negatif)', () => {
    const invalidPayload = {
      idempotencyKey: 'a90f1ee-6c54-4b01-90e6-d701748f0851',
      amount: -100, 
      currency: 'IDR',
      destinationAccount: '123456789012',
    };

    expect(() => {
      pipe.transform(invalidPayload, metadata);
    }).toThrowError(BadRequestException);

    try {
      pipe.transform(invalidPayload, metadata);
    } catch (e: unknown) {
      if (e instanceof BadRequestException) {
        const response: Record<string, unknown> = e.getResponse() as Record<string, unknown>;
        expect(response.details).toBeDefined();
        expect((response.details as string[])[0]).toContain('amount: Number must be greater than 0');
      }
    }
  });

  it('seharusnya membuang atau menolak data tidak dikenal berdasarkan strict mode', () => {
    const payloadWithMaliciousKey = {
      idempotencyKey: 'a90f1ee-6c54-4b01-90e6-d701748f0851',
      amount: 10000,
      currency: 'USD',
      destinationAccount: '1234567890',
      adminOverride: true, 
    };

    expect(() => {
      pipe.transform(payloadWithMaliciousKey, metadata);
    }).toThrowError(BadRequestException);
  });
});
```

## 1. TypeBox AOT Compilation Internals (High Performance)

Sementara Zod sangat baik untuk fungsionalitas dan ekosistem, **TypeBox** memberikan kinerja tertinggi karena desainnya yang sangat minimalis dan kemampuannya untuk melakukan kompilasi *Ahead-of-Time* (AOT). TypeBox merepresentasikan struktur sebagai JSON Schema native di memori.

Dengan modul `@sinclair/typebox/compiler`, kita dapat mengkompilasi skema validasi TypeBox menjadi kode JavaScript mentah yang dieksekusi oleh mesin V8.

```typescript
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { PipeTransform, Injectable, BadRequestException, ArgumentMetadata } from '@nestjs/common';

export const UserRegistrationSchema = Type.Object({
  username: Type.String({ minLength: 3, maxLength: 20 }),
  email: Type.String({ format: 'email' }),
  age: Type.Number({ minimum: 18 }),
}, { additionalProperties: false });

export type UserRegistrationDto = Static<typeof UserRegistrationSchema>;

// AOT COMPILATION: Dilakukan hanya SEKALI saat startup aplikasi
const UserRegistrationCompiler = TypeCompiler.Compile(UserRegistrationSchema);

@Injectable()
export class TypeBoxValidationPipe implements PipeTransform<unknown, unknown> {
  public transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body') return value;

    // Zero-overhead validation, berjalan dalam O(1) atau siklus CPU minimal.
    const isValid = UserRegistrationCompiler.Check(value);
    
    if (!isValid) {
      const errors = [...UserRegistrationCompiler.Errors(value)];
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validasi Skema TypeBox Gagal',
        details: errors,
      });
    }

    return value;
  }
}
```

### Trade-Off TypeBox vs Zod
**TypeBox Pros:**
1. Kecepatan 10x-100x lebih cepat daripada Zod berkat TypeCompiler.
2. 100% kompatibel dengan standar JSON Schema dan OpenAPI.
3. Bundle size sangat ringan.

**TypeBox Cons:**
1. API Builder tidak se-ergonomis Zod.
2. Kurangnya fitur transformasi `.transform()` bawaan yang kaya.
3. Dokumentasi ekosistem pihak ketiga lebih sedikit dibanding Zod.

## 2. Zod's `.transform()` Pipeline (Data Sanitization & Computation)

Salah satu keunggulan Zod dibandingkan TypeBox adalah kemampuannya melakukan pipeline data secara imperatif menggunakan `.transform()`. Fitur ini mengubah nilai input menjadi bentuk yang benar-benar siap dikonsumsi oleh lapisan bisnis, mencegah polusi data.

```typescript
import { z } from 'zod';

export const PasswordUpdateSchema = z.object({
  oldPassword: z.string().min(8),
  newPassword: z.string().min(8),
  confirmPassword: z.string().min(8)
})
.refine(data => data.newPassword === data.confirmPassword, {
  message: 'Konfirmasi sandi tidak cocok',
  path: ['confirmPassword']
})
.transform((data) => ({
  oldPassword: data.oldPassword,
  // Otomatis men-sanitize atau mengubah nilai output 
  // (misal: flag tambahan) 
  newPasswordHashInput: data.newPassword,
  updatedAt: new Date().toISOString()
}));

// Tipe hasil inferensi otomatis menyesuaikan hasil transform!
export type PasswordUpdateDto = z.infer<typeof PasswordUpdateSchema>;
```

### Edge Case: Transformasi Async
Jangan gunakan transformasi `.transform()` yang melakukan operasi _async_ (seperti pemanggilan database) di dalam Validation Pipe HTTP. Hal ini bisa menimbulkan _latency spike_. Jika ada validasi _async_, gunakan NestJS Custom Guard atau Interceptor, biarkan Pipe murni untuk validasi struktural sinkron.

## 3. Coercion vs Parsing (Strict by Default)

Sistem HTTP murni sering mengirimkan data sebagai _String_, contohnya pada _Query Parameters_ atau _Headers_. 

❌ **Anti-Pattern (Kelemahan class-validator biasa):**
Membiarkan tipe data terkonversi secara klandestin atau implisit yang menimbulkan celah _Type Confusion Attack_.

✅ **Best Practice (Zod Coercion):**
Menggunakan `z.coerce` secara eksplisit HANYA pada properti yang diketahui bersumber dari tipe non-serializable (seperti URL query / path).

```typescript
export const PaginationQuerySchema = z.object({
  // Ekstrak dari ?page=1&limit=10 (berupa string murni dari request)
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  sortBy: z.enum(['createdAt', 'updatedAt']).default('createdAt'),
});

export type PaginationQueryDto = z.infer<typeof PaginationQuerySchema>;
```

**Perbandingan:**
*   `z.number()`: Gagal (`throw Error`) jika diberi `"10"`. (Strict Parsing - Direkomendasikan untuk HTTP Body).
*   `z.coerce.number()`: Sukses jika diberi `"10"`, diubah menjadi `10`. (Coercion - Direkomendasikan untuk HTTP Query/Param).

## 4. Discriminated Unions (Polymorphic Validation)

Pada arsitektur Event-Driven atau arsitektur sistem kompleks, tipe _request_ seringkali bervariasi bergantung pada properti "type" atau "action". 

Zod memiliki `z.discriminatedUnion` yang sangat cepat dalam mengevaluasi percabangan tipe dibandingkan `z.union()` biasa karena menggunakan _hash map_ pada _discriminator key_.

```typescript
import { z } from 'zod';

const CreateIndividualUserSchema = z.object({
  accountType: z.literal('INDIVIDUAL'),
  nik: z.string().length(16),
  fullName: z.string().min(3),
});

const CreateCorporateUserSchema = z.object({
  accountType: z.literal('CORPORATE'),
  npwp: z.string().length(15),
  companyName: z.string().min(3),
});

export const UserRegistrationPolymorphicSchema = z.discriminatedUnion('accountType', [
  CreateIndividualUserSchema,
  CreateCorporateUserSchema,
]);

export type UserRegistrationPolymorphicDto = z.infer<typeof UserRegistrationPolymorphicSchema>;
```
Di lapisan _Controller_, kita langsung mendapatkan dukungan tipe persimpangan yang akurat (IntelliSense) tergantung percabangan `accountType`.

## 5. OpenAPI Schema Inference Auto-Generation (NestJS Swagger)

Seperti disebutkan pada analisis _trade-off_, Zod tidak otomatis terbaca oleh ekosistem NestJS Swagger (`@nestjs/swagger`) yang bergantung pada `class-validator` (Reflection).

✅ **Penyelesaian (Zod-to-OpenAPI):**
Kita wajib menggunakan integrasi pihak ketiga, seperti `nestjs-zod` atau `@anatine/zod-nestjs`, untuk secara otomatis menghasilkan kontrak Swagger dari skema Zod tanpa harus menulis antarmuka secara ganda.

```typescript
import { createZodDto } from 'nestjs-zod/dto';
import { z } from 'zod';

const ProductSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(5),
  price: z.number().positive(),
});

// Menjembatani Zod dengan Class-based DTO untuk Swagger NestJS
export class ProductDto extends createZodDto(ProductSchema) {}
```
Dengan strategi di atas, kita mendapatkan:
1. Validasi sangat cepat pada _runtime_ HTTP.
2. Inferensi Tipe TypeScript tanpa redundansi antarmuka.
3. Otomatisasi dokumentasi Swagger yang selaras (Single Source of Truth).
