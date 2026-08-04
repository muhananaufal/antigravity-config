# Custom Decorators & Async Validators: Injeksi Dependensi di DTO NestJS (Top 1% Engineering)

## Pendahuluan
Seringkali validasi DTO tidak hanya terbatas pada bentuk statis struktur JSON, namun menuntut aturan domain bisnis yang harus diverifikasi terhadap *state* aplikasi. Misalnya, pendaftaran pengguna mensyaratkan verifikasi ketersediaan email langsung ke dalam *Database*. Menyisipkan injeksi dependensi (Dependency Injection / DI) secara asinkronus ke dalam decorator class-validator (`@IsUniqueEmail()`) adalah praktik canggih yang mempertahankan lapisan kontroler tetap bersih (clean controller) sambil memberlakukan aturan *business constraint* langsung di gerbang masuk.

Namun, validasi asinkronus di level DTO memiliki jebakan performa yang kritikal. Latensi koneksi DB dan potensi N+1 query (misalnya ketika validasi berjalan dalam *Array of Objects*) harus dihindari dengan merancang logika *Constraint* kelas berat dengan sangat hati-hati.

## Arsitektur DI pada Custom Async Validator

```ascii
+--------------------+        +-------------------------+        +--------------------------+
|  Controller (API)  |        |  ValidationPipe (Nest)  |        |  class-validator engine  |
+--------------------+        +-------------------------+        +--------------------------+
         ^                                |                                |
         |                                v                                v
+--------------------+        +-------------------------+        +--------------------------+
| UsersService.create| <----- |  CreateUserDto          | <----- | @IsUniqueUser() Decorator|
+--------------------+        +-------------------------+        +--------------------------+
                                                                           |
                                                                           v
                                                                 +--------------------------+
                                                                 | IsUniqueUserConstraint   |
                                                                 | (Injects PrismaService)  |
                                                                 | Query -> SELECT * FROM ..|
                                                                 +--------------------------+
```

## Implementasi Produksi Decorator Asinkronus

Kita akan merancang dekorator `@IsUniqueEmail()` menggunakan `ValidatorConstraintInterface` dengan dependensi DB, memastikan resolusi Nest DI Container berfungsi dalam instance `class-validator`.

```typescript
import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@ValidatorConstraint({ name: 'isUniqueEmail', async: true })
@Injectable()
export class IsUniqueEmailConstraint implements ValidatorConstraintInterface {
  constructor(private readonly prisma: PrismaService) {}

  public async validate(email: unknown, args: ValidationArguments): Promise<boolean> {
    if (typeof email !== 'string') return false;

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true }, 
    });

    return user === null;
  }

  public defaultMessage(args: ValidationArguments): string {
    return `Alamat email '${args.value}' sudah terdaftar dalam sistem kami.`;
  }
}

export function IsUniqueEmail(validationOptions?: ValidationOptions) {
  return function (object: Record<string, unknown>, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsUniqueEmailConstraint,
    });
  };
}
```

Dalam main.ts (Konfigurasi Wajib untuk DI Class-Validator):
```typescript
import { NestFactory } from '@nestjs/core';
import { useContainer } from 'class-validator';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  useContainer(app.select(AppModule), { fallbackOnErrors: true });
  await app.listen(3000);
}
```

## Anti-Patterns Kritis

### 1. N+1 Query pada Validasi Array (Batch Validation)
❌ **Salah (N+1 Bomb):** Saat klien mengirim payload massal, validasi unik pada properti dalam array akan menembakkan kueri tunggal untuk setiap item (N+1 query problem). Ini bisa melumpuhkan Database.
✅ **Benar:** Geser logika validasi massal (Bulk Validation) ke Service Layer atau gunakan batch validator.

### 2. Lupa Inisialisasi `useContainer`
❌ **Salah (Silent Crash):** Menggunakan `@Injectable()` pada Constraint tanpa mendeklarasikan `useContainer(app.select(...))` akan me-return error karena `class-validator` gagal melakukan resolve untuk objek DB (menjadi undefined).
✅ **Benar:** Setup secara eksplisit `useContainer` selama bootstrap aplikasi.

## Production Edge Cases

1. **Race Conditions saat Eksekusi Konkuren:** Validator DTO asinkron mengecek nilai, jika lolos akan di-insert. Tetapi jika ada dua proses berjalan bersamaan, maka tetap dapat terjadi data duplikat di DB. *Database unique index* tetap mutlak diwajibkan!
2. **Latensi / Timeout Eksternal:** Validasi DTO yang memanggil layanan pihak ketiga bisa memperburuk latensi. Wajib melengkapi operasi async dalam `Constraint` dengan proteksi timeout ketat.
3. **Keterbatasan Konteks Transaksional:** Logika constraint berjalan di luar cakupan transaksi bisnis database. Jangan memvalidasi state yang kompleks di DTO.

## Analisis Trade-Off

**Kelebihan (Pros):**
1. **Clean Architecture:** Mengeluarkan logika validasi if/else dari controller.
2. **Reusabilitas:** Dekorator `@IsUniqueEmail()` dapat digunakan di seluruh DTO sistem.
3. **Pesan Kesalahan Terstandarisasi:** Pemetaan otomatis ke dalam output HTTP 400 Bad Request.

**Kekurangan (Cons):**
1. **Hidden I/O Costs:** Dekorator yang tampak sederhana menyembunyikan operasi I/O asinkron yang lambat.
2. **Sulit di-Test Secara Isolasi:** Memerlukan mocking NestJS DI container secara penuh dalam environment testing.
3. **Risiko Konkurensi:** Tidak menjamin ACID sepenuhnya.

## Unit Test Suite: Menguji Validation Constraint Secara Terisolasi

```typescript
import { ValidationArguments } from 'class-validator';
import { IsUniqueEmailConstraint } from './is-unique-email.constraint';
import { PrismaService } from '../database/prisma.service';

describe('IsUniqueEmailConstraint Test Suite', () => {
  let constraint: IsUniqueEmailConstraint;
  let mockPrismaService: Record<string, unknown>;

  beforeEach(() => {
    mockPrismaService = {
      user: {
        findUnique: jest.fn(),
      },
    };
    constraint = new IsUniqueEmailConstraint(mockPrismaService as unknown as PrismaService);
  });

  const mockArgs: ValidationArguments = {
    targetName: 'UserDto',
    property: 'email',
    object: {},
    value: 'test@example.com',
    constraints: [],
  };

  it('seharusnya mengembalikan true (valid) jika email belum ada di database', async () => {
    (mockPrismaService.user as { findUnique: jest.Mock }).findUnique.mockResolvedValue(null);

    const result = await constraint.validate('new_user@example.com', mockArgs);
    
    expect(result).toBe(true); 
    expect((mockPrismaService.user as { findUnique: jest.Mock }).findUnique).toHaveBeenCalledWith({
      where: { email: 'new_user@example.com' },
      select: { id: true },
    });
  });

  it('seharusnya mengembalikan false (invalid) jika email sudah digunakan', async () => {
    (mockPrismaService.user as { findUnique: jest.Mock }).findUnique.mockResolvedValue({ id: 99 });

    const result = await constraint.validate('exist@example.com', mockArgs);
    
    expect(result).toBe(false); 
  });
  
  it('seharusnya mengembalikan pesan error default yang diformat dengan benar', () => {
    const message = constraint.defaultMessage(mockArgs);
    expect(message).toContain(`Alamat email 'test@example.com' sudah terdaftar`);
  });
});
```

## Cross-Field Validation & Conditional Validation Chains

Validasi lintas bidang (cross-field validation) memungkinkan validasi sebuah properti bergantung pada nilai properti lain dalam DTO yang sama. Hal ini berguna untuk relasi logis kompleks tanpa perlu memindahkannya ke service layer.

### Implementasi Conditional Validations dengan `@ValidateIf`

`@ValidateIf` dari `class-validator` mengevaluasi objek secara runtime, hanya menjalankan rantai validasi di bawahnya jika kondisi boolean terpenuhi.

```typescript
import { IsString, IsNotEmpty, ValidateIf, IsOptional, MinLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  public role?: string;

  // Hanya mewajibkan 'companyName' jika role adalah 'enterprise'
  @ValidateIf((object: UpdateProfileDto) => object.role === 'enterprise')
  @IsNotEmpty({ message: 'Nama perusahaan wajib diisi untuk pengguna enterprise' })
  @IsString()
  @MinLength(3)
  public companyName?: string;
}
```

### Kustomisasi Decorator Lintas Field Lanjutan (Match Fields)

Ketika `@ValidateIf` kurang ekspresif (misalnya memeriksa kecocokan `password` dan `passwordConfirm`), kita bisa menggunakan `ValidatorConstraint` yang mengakses argumen.

```typescript
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'matchProperty', async: false })
export class MatchPropertyConstraint implements ValidatorConstraintInterface {
  public validate(value: unknown, args: ValidationArguments): boolean {
    const [relatedPropertyName] = args.constraints as [string];
    const relatedValue = (args.object as Record<string, unknown>)[relatedPropertyName];
    return value === relatedValue;
  }

  public defaultMessage(args: ValidationArguments): string {
    const [relatedPropertyName] = args.constraints as [string];
    return `${args.property} harus sama persis dengan ${relatedPropertyName}`;
  }
}

export function MatchProperty(property: string, validationOptions?: ValidationOptions) {
  return function (object: Record<string, unknown>, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [property],
      validator: MatchPropertyConstraint,
    });
  };
}
```

## Optimasi Performa: Validator Caching

Menjalankan lookup DB asinkron berulang kali untuk nilai yang sama pada request batch bisa mencekik database. Teknik caching in-memory level request (seperti `Map` atau CacheManager dari NestJS) bisa sangat mengurangi beban I/O. 

```typescript
import { Injectable, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { PrismaService } from '../database/prisma.service';

@ValidatorConstraint({ name: 'isUniqueEmailCached', async: true })
@Injectable()
export class IsUniqueEmailCachedConstraint implements ValidatorConstraintInterface {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  public async validate(email: unknown, args: ValidationArguments): Promise<boolean> {
    if (typeof email !== 'string') return false;

    const cacheKey = `validation:email_unique:${email}`;
    const cachedResult = await this.cacheManager.get<boolean>(cacheKey);

    if (cachedResult !== undefined) {
      return cachedResult;
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    const isUnique = user === null;
    
    // Cache hasil selama 5 detik (mengurangi query ganda di batch upload)
    await this.cacheManager.set(cacheKey, isUnique, 5000);

    return isUnique;
  }
}
```

## Composable Validator Factories

Mendeklarasikan kelas *Constraint* dan fungsi dekorator secara terpisah dapat menyita waktu. Menggunakan konsep *Factory*, kita dapat menyusun mekanisme generator dinamis untuk validator umum (misal mengecek eksistensi ID di tabel apa saja).

```typescript
import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { PrismaService } from '../database/prisma.service';

// Factory Parameter Interface (Menghindari "any" & magic strings)
export interface ExistsInDatabaseOptions {
  tableName: keyof PrismaService;
  columnName: string;
}

export function ExistsInDatabase(
  options: ExistsInDatabaseOptions,
  validationOptions?: ValidationOptions,
) {
  @ValidatorConstraint({ name: `existsInDatabase_${String(options.tableName)}`, async: true })
  class ExistsConstraint implements ValidatorConstraintInterface {
    constructor(private readonly prisma: PrismaService) {}

    public async validate(value: unknown, args: ValidationArguments): Promise<boolean> {
      if (!value) return false;

      // Type-safe approach to dynamically query Prisma models
      const model = this.prisma[options.tableName] as {
        findFirst: (args: { where: Record<string, unknown>; select: Record<string, boolean> }) => Promise<unknown | null>;
      };

      if (!model || typeof model.findFirst !== 'function') {
        throw new Error(`Model ${String(options.tableName)} tidak valid.`);
      }

      const record = await model.findFirst({
        where: { [options.columnName]: value },
        select: { id: true },
      });

      return record !== null;
    }

    public defaultMessage(args: ValidationArguments): string {
      return `${args.property} dengan nilai '${args.value}' tidak ditemukan di tabel ${String(options.tableName)}.`;
    }
  }

  return function (object: Record<string, unknown>, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [],
      validator: ExistsConstraint,
    });
  };
}
```
### Penggunaan:
```typescript
export class CreatePostDto {
  @IsString()
  @ExistsInDatabase({ tableName: 'user', columnName: 'id' })
  public authorId!: string;
}
```

## Edge Cases Lanjutan & Anti-Patterns

### 3. Mutasi State saat Validasi
❌ **Salah:** Mengubah (mutasi) atau menyanitasi objek dalam fungsi `validate`. `class-validator` ditujukan murni untuk validasi (boolean test), bukan transformasi data.
✅ **Benar:** Gunakan mekanisme `@Transform()` dari `class-transformer` yang berjalan *sebelum* `class-validator` untuk memanipulasi string (trim, lowercasing) sebelum diverifikasi.

### 4. Over-Fetching di Async Constraint
❌ **Salah:** Melakukan `await this.prisma.user.findUnique({ where: { email } })` dan mengambil semua kolom (SELECT *).
✅ **Benar:** Wajib gunakan proyeksi seleksi minimal, misal `select: { id: true }` untuk meminimalkan beban memori, serialization load I/O, dan bandwidth dari database ke backend.

### 5. Memory Leak pada Cache Manager
❌ **Salah:** Menggunakan `cacheManager.set()` tanpa mendefinisikan *TTL (Time to Live)* pada runtime produksi bisa membuat memory heap meluap jika server dibombardir oleh pendaftaran spam (bot).
✅ **Benar:** Pastikan ada TTL pendek (misalnya `5000` atau maksimal `10000` ms) pada caching level DTO.

## Analisis Trade-Off Tambahan

**Kelebihan Factory & Caching:**
1. **Modularitas (DRY):** Menggunakan factory mencegah deklarasi puluhan decorator boilerplate untuk tabel yang berbeda-beda.
2. **Kinerja Ekstrim (Caching):** Mencekik *Duplicate Queries* di *Bulk Endpoint*, sangat penting untuk impor massal.

**Kekurangan Factory & Caching:**
1. **Kerumitan Injeksi Tipe:** Factory dynamic proxy bisa membuat referensi Typescript menjadi sangat rumit secara internal (membutuhkan type assertion ketat).
2. **Cache Invalidation Delay:** Adanya resiko *false-positive* (cache stale) dalam durasi jendela TTL. Jika data dihapus sepersekian detik sebelum cache habis, validator mungkin mengizinkan ID basi.
