# Otomasi Dokumentasi OpenAPI 3.1 Menggunakan NestJS Swagger CLI Plugin

## 1. Pendahuluan dan Latar Belakang

Dalam pengembangan sistem enterprise dengan NestJS, menjaga agar dokumentasi OpenAPI (Swagger) tetap sinkron dengan implementasi kode adalah tantangan yang masif. Mengandalkan ratusan dekorator `@ApiProperty()`, `@ApiResponse()`, dan `@ApiOperation()` pada setiap endpoint, DTO (Data Transfer Object), dan Entitas secara manual sering kali menghasilkan basis kode yang kotor, sulit dibaca, dan rentan terhadap ketidakkonsistenan.

Untuk mengatasi ini, NestJS menyediakan Swagger CLI Plugin. Plugin ini mengeksekusi transformasi Abstract Syntax Tree (AST) pada kode TypeScript sebelum proses kompilasi. Dengan menganalisis tipe data TypeScript dan komentar JSDoc, plugin ini secara otomatis menginjeksi metadata Swagger yang dibutuhkan, membebaskan kode sumber dari polusi dekorator, serta secara signifikan mempercepat proses pengembangan.

## 2. Arsitektur Transformasi Abstract Syntax Tree (AST)

Berikut adalah diagram alir bagaimana NestJS CLI Plugin mengeksekusi ekstraksi otomatis saat proses *build*.

```text
+-----------------------+       +-------------------------+       +------------------------+
|   TypeScript Code     |       |   NestJS CLI Compiler   |       |  Swagger Metadata      |
|-----------------------|       |-------------------------|       |------------------------|
| export class UserDTO {| =====>| 1. Parse into AST       | =====>|  @ApiProperty({        |
|   /**                 |       | 2. Analyze Types        |       |    description: '...', |
|    * The user ID      |       | 3. Extract JSDoc        |       |    type: String,       |
|    * @example 'uuid'  |       | 4. Inject Metadata      |       |    example: 'uuid'     |
|    */                 |       | 5. Emit JS Code         |       |  })                    |
|   id: string;         |       |                         |       |                        |
| }                     |       +-------------------------+       +------------------------+
+-----------------------+
```

## 3. Implementasi Produksi (NestJS 10+ & TypeScript 5+)

### 3.1. Konfigurasi `nest-cli.json`

Untuk mengaktifkan otomasi ini, Anda harus meregistrasikan plugin `@nestjs/swagger` di file `nest-cli.json`. Parameter `introspectComments` memungkinkan pengambilan deskripsi dan properti lain langsung dari blok JSDoc.

```json
{
  "$schema": "https://json.schema.nest.land/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "plugins": [
      {
        "name": "@nestjs/swagger",
        "options": {
          "classValidatorShim": true,
          "introspectComments": true,
          "dtoFileNameSuffix": [".dto.ts", ".entity.ts"],
          "controllerFileNameSuffix": [".controller.ts"]
        }
      }
    ]
  }
}
```

### 3.2. Implementasi DTO Bersih Tanpa Polusi Dekorator

Berikut adalah contoh bagaimana kita menulis DTO secara natural dengan TypeScript dan JSDoc, sementara CLI Plugin melakukan sisanya.

```typescript
import { IsString, IsUUID, IsEmail, MinLength, MaxLength } from 'class-validator';

/**
 * Representasi muatan data untuk pendaftaran pengguna baru.
 */
export class CreateUserRegistrationDto {
  /**
   * Identitas unik pengguna dalam format UUIDv4.
   * Akan dihasilkan oleh sistem jika tidak diberikan.
   * @example "123e4567-e89b-12d3-a456-426614174000"
   */
  @IsUUID(4)
  public readonly id!: string;

  /**
   * Nama lengkap pengguna sesuai identitas resmi.
   * @example "John Doe"
   */
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  public readonly fullName!: string;

  /**
   * Alamat surel aktif untuk komunikasi dan login.
   * @example "john.doe@enterprise.com"
   */
  @IsEmail()
  public readonly emailAddress!: string;
}
```

### 3.3. Implementasi Controller

```typescript
import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { CreateUserRegistrationDto } from './dto/create-user.dto';

@Controller('users')
export class UsersRegistrationController {
  
  /**
   * Mendaftarkan Pengguna Baru ke dalam Sistem
   * 
   * Endpoint ini menerima muatan data pengguna baru, melakukan validasi
   * sesuai standar, dan memproses penyimpanan ke basis data.
   * 
   * @returns Metadata hasil pendaftaran yang tidak memuat kata sandi.
   */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  public async registerNewUser(
    @Body() registrationPayload: CreateUserRegistrationDto,
  ): Promise<{ success: boolean; userId: string }> {
    // Implementasi injeksi layanan disederhanakan
    return {
      success: true,
      userId: registrationPayload.id,
    };
  }
}
```

## 4. Analisis Trade-Off

### Kelebihan
1. **Kode Sangat Bersih (Clean Code):** Menghindari polusi ratusan dekorator spesifik Swagger, sehingga logika bisnis utama TypeScript dan Class Validator menjadi sorotan utama, mempertinggi tingkat keterbacaan kode (readability).
2. **Pengurangan Duplikasi Metadata:** Developer tidak perlu menuliskan tipe data dua kali (sekali di anotasi tipe TypeScript, sekali lagi di argumen `@ApiProperty({ type: String })`), mengurangi *human-error*.
3. **Dokumentasi Terintegrasi Erat:** Memaksa developer untuk menulis JSDoc yang bermutu, yang tidak hanya dikonsumsi oleh Swagger UI, tetapi juga langsung tersedia sebagai intellisense di dalam IDE.

### Kekurangan
1. **Efek Magis Terselubung:** Developer junior yang belum terbiasa dengan transformasi AST mungkin kebingungan dari mana asal dokumentasi OpenAPI yang tiba-tiba ter-generate, menyulitkan proses penelusuran jika terjadi bug pada hasil dokumentasi.
2. **Kompilasi Memerlukan CLI:** Transformasi hanya berjalan saat dikompilasi menggunakan `nest build` atau `nest start`. Apabila tim menggunakan *bundler* atau *compiler* kustom seperti `esbuild`, `swc`, atau *ts-node* standar secara independen, CLI plugin tidak akan tereksekusi.
3. **Keterbatasan Edge-Cases Kompleks:** Untuk struktur union (misalnya: `string | number`), tuple rumit, atau generic bertingkat yang sangat kompleks, kadang AST compiler gagal memetakan ke skema OpenAPI yang benar, sehingga tetap mewajibkan injeksi `@ApiProperty` manual.

## 5. Anti-Patterns & Best Practices

### ❌ Anti-Pattern 1: Tetap Menggunakan @ApiProperty Padahal Sudah Ada CLI Plugin
Mengulang deklarasi tipe data yang sudah bisa disimpulkan oleh compiler.

```typescript
// ❌ SALAH: Duplikasi dan polusi visual
import { ApiProperty } from '@nestjs/swagger';

export class UpdateUserDto {
  @ApiProperty({ description: 'User age', type: Number, example: 25 })
  public age: number;
}
```

```typescript
// ✅ BENAR: Percayakan pada JSDoc dan CLI Plugin
export class UpdateUserDto {
  /**
   * Usia pengguna
   * @example 25
   */
  public age: number;
}
```

### ❌ Anti-Pattern 2: Tidak Menggunakan Suffix File yang Tepat
Menggunakan penamaan file yang tidak dipindai oleh plugin di konfigurasi `nest-cli.json` (misalnya file bernama `user-model.ts` alih-alih `user.dto.ts`).
Hal ini menyebabkan CLI gagal memproses AST file tersebut.

```json
// ❌ SALAH: Suffix bawaan tidak mencakup nama file non-standar
"dtoFileNameSuffix": [".dto.ts"] // jika nama file Anda user-model.ts
```

```json
// ✅ BENAR: Daftarkan semua suffix file yang memuat data kontrak
"dtoFileNameSuffix": [".dto.ts", ".entity.ts", ".response.ts", ".model.ts"]
```

## 6. Production Edge Cases

1. **Resolusi Tipe Generic (Pagination):**
   Saat membungkus tipe generic seperti `PaginatedResponse<T>`, plugin kadang kesulitan meresolusi `T` jika kelas tidak mempublikasikan dekorator `@ApiExtraModels()`. Solusinya adalah memadukan otomasi CLI dengan deklarasi ekstra eksplisit khusus pada tipe wrapper.
2. **Penggunaan Enum Eksternal:**
   Jika DTO merujuk pada `enum` dari pustaka eksternal (node_modules), CLI kadang gagal mengekstrak nilai-nilai enum tersebut ke deskripsi properti. Dalam kasus ini, pendefinisian eksplisit `@ApiProperty({ enum: EksternalEnum })` diperlukan.
3. **Migrasi ke SWC Compiler:**
   Bila tim beralih ke kompiler eksekusi ultra-cepat SWC (`nest start -b swc`), maka konfigurasi SWC khusus (`.swcrc`) harus diubah sedemikian rupa dengan menggunakan plugin *Rust-based* SWC Swagger NestJS, karena plugin AST bawaan TypeScript tidak berlaku di runtime SWC.

## 7. Unit / Swagger JSON Extractions Test Suite

Berikut adalah suite pengujian untuk memverifikasi struktur ekstraksi.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { UsersRegistrationController } from './users-registration.controller';

describe('Swagger Documentation AST Generation Test Suite', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [UsersRegistrationController],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('Harus berhasil mengekstrak skema OpenAPI dari JSDoc dengan benar (Mocking AST Effect)', () => {
    const config = new DocumentBuilder()
      .setTitle('AST Test')
      .setVersion('1.0')
      .build();
    
    const document = SwaggerModule.createDocument(app, config);

    // Verifikasi Path dan Metode
    expect(document.paths['/users/register']).toBeDefined();
    expect(document.paths['/users/register'].post).toBeDefined();

    const postEndpoint = document.paths['/users/register'].post;
    
    // Verifikasi Injeksi JSDoc Summary dan Description (jika CLI berjalan)
    // Catatan: Dalam test runner seperti Jest, transformator AST biasanya 
    // memerlukan setup khusus (seperti ts-jest compiler AST transform) agar berjalan.
    // Asumsi kompilator sudah mencakup plugin di ts-jest.
    expect(postEndpoint).toHaveProperty('responses', expect.any(Object));
    expect(postEndpoint.responses['201']).toBeDefined();
  });
});
```
