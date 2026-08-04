# DTO Security Shield & Payload Stripping di NestJS (Top 1% Engineering)

## Pendahuluan
Ancaman vektor keamanan pada lapisan Application Programming Interface (API) paling sering bermuara dari kelalaian sanitasi *Data Transfer Object* (DTO). *Mass Assignment Vulnerability*, HTTP Parameter Pollution (HPP), dan *Prototype Poisoning* adalah musuh utama sistem yang menerima input terstruktur (JSON). 

Di NestJS, `ValidationPipe` bertindak sebagai dinding pertahanan (Security Shield). Hanya memvalidasi tipe data tidaklah cukup. Sebagai praktisi Top 1%, kita diwajibkan untuk mengonfigurasi Global Validation Pipe dengan *Payload Stripping* yang agresif (menghapus paksa semua properti asing), serta mencegah injeksi secara kaku lewat konfigurasi _whitelist_ dan pencegahan payload *non-whitelisted*.

## Arsitektur Security Gateway (DTO Stripping)

```ascii
+-----------------------+       +---------------------------------------------+       +------------------+
| Hacker Payload (JSON) |       |  NestJS Global ValidationPipe (Security)    |       | Clean Controller |
+-----------------------+       +---------------------------------------------+       +------------------+
| {                     |       | Config:                                     |       | Payload Diterima:|
|  "email":"a@b.com",   | --->  | - whitelist: true (Strip Hacked Props)      | --->  | {                |
|  "isAdmin": true,     |       | - forbidNonWhitelisted: true (Throw 400)    |       | "email":"a@b.com"|
|  "__proto__": {       |       | - transform: true (Cast Tipe Definitif)     |       | }                |
|     "role": "admin"   |       +---------------------------------------------+       +------------------+
|  }                    |
| }                     | 
+-----------------------+
```

## Implementasi Produksi Security ValidationPipe Global

Konfigurasi _bootstrap_ aplikasi harus secara definitif mengunci semua pintu masuk data yang tidak terdaftar di dalam struktur DTO kelas secara statik.

Dalam `main.ts`:
```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, BadRequestException, HttpStatus, ValidationError } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, 
      forbidNonWhitelisted: true, 
      transform: true, 
      forbidUnknownValues: true,
      exceptionFactory: (errors: ValidationError[]) => {
        const formatErrors = errors.map(err => ({
          field: err.property,
          constraints: err.constraints,
        }));
        return new BadRequestException({
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Payload Input Security Validation Failed',
          errors: formatErrors,
        });
      },
    }),
  );

  await app.listen(3000);
}
```

Dalam File DTO (`update-user.dto.ts`):
```typescript
import { IsString, IsOptional, MaxLength } from 'class-validator';

export class UpdateUserDto {
  @IsString()
  @IsOptional()
  @MaxLength(255)
  public readonly bio?: string;
}
```

## Anti-Patterns Kritis

### 1. Mematikan `whitelist: false` pada Operasi PATCH / UPDATE
❌ **Salah (Mass Assignment Vulnerability):** Developer terkadang mematikan fitur whitelist karena ingin membuat Update DTO dinamis. Jika object `req.body` langsung di-pass ke DB, attacker bebas memodifikasi field sensitif seperti `isAdmin`.
✅ **Benar:** Wajib `whitelist: true` secara permanen. Gunakan `PartialType` dari `@nestjs/mapped-types` untuk update operations.

### 2. Membiarkan Properti DTO Kosong Tanpa Dekorator Validasi
❌ **Salah (Bypass Kritis):** Fitur `whitelist` membuang properti tanpa dekorator class-validator. 
```typescript
export class BadDto {
  public name: string; // DIBUANG!
}
```
✅ **Benar:** Tambahkan setidaknya `@Allow()` jika tidak ada batasan khusus.
```typescript
import { Allow } from 'class-validator';
export class GoodDto {
  @Allow()
  public readonly name: string; 
}
```

## Production Edge Cases

1. **Eksploitasi Prototype Poisoning (`__proto__`):** Memastikan proxy API Gateway atau body-parser Express/Fastify menolak kunci-kunci ajaib lapisan proto.
2. **File Uploads Bypassing DTO Validation:** Saat memproses *multipart/form-data*, `req.body` stringified sering kali meloloskan properti dari Pipe. Buat `ParseJsonPipe` kustom untuk intercept stringified data.
3. **Dampak Performa pada Payload Masif:** Konfigurasi `forbidNonWhitelisted: true` sangat mahal di iterasi array besar. Untuk bulk ingestion > 10.000 row, disarankan tidak memakai ValidationPipe global, melainkan Pipe fungsional.

## Analisis Trade-Off

**Kelebihan (Pros):**
1. **Keamanan Definitif (Secure by Default):** Memangkas risiko Mass Assignment Attack 100%.
2. **Standardisasi API:** API hanya menerima yang didefinisikan dalam DTO class.
3. **Isolasi Logika Bersih:** Mencegah polusi objek tak terstruktur.

**Kekurangan (Cons):**
1. **Evolusi API Beresiko Melanggar Klien Lama:** Klien lama yang mengirim field dummy usang akan ditolak 400.
2. **Deklarasi Berlebihan:** Developer harus menuliskan dekorator pada setiap properti tanpa terkecuali.
3. **Miskonsepsi Tipe Transform:** `transform: true` membuat class-transformer memaksakan implicit type casting yang dapat memunculkan side effects.

## Unit Test Suite: Menguji DTO Security Shield & Stripping

```typescript
import { ValidationPipe, ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { Allow } from 'class-validator';

class ProtectedUpdateDto {
  @Allow()
  public readonly username?: string;
}

describe('ValidationPipe Security Shield Test Suite', () => {
  let globalPipe: ValidationPipe;

  beforeEach(() => {
    globalPipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
  });

  const metadata: ArgumentMetadata = {
    type: 'body',
    metatype: ProtectedUpdateDto,
  };

  it('seharusnya membiarkan payload yang sah melewatinya dengan mulus', async () => {
    const validPayload = { username: 'engineer_top1' };
    
    const result = await globalPipe.transform(validPayload, metadata);
    expect(result).toBeInstanceOf(ProtectedUpdateDto);
    expect((result as ProtectedUpdateDto).username).toBe('engineer_top1');
  });

  it('seharusnya melempar BadRequestException saat menerima payload hacker', async () => {
    const hackedPayload = { 
      username: 'normal_user', 
      isAdmin: true,
      hiddenToken: 'xyz123'
    };

    try {
      await globalPipe.transform(hackedPayload, metadata);
      fail('Harusnya melempar BadRequestException');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(BadRequestException);
      if (e instanceof BadRequestException) {
        const response: Record<string, unknown> = e.getResponse() as Record<string, unknown>;
        expect(response.message).toBeDefined();
        const messageString = JSON.stringify(response.message);
        expect(messageString).toContain('isAdmin should not exist');
      }
    }
  });

  it('seharusnya MENGHAPUS (stripping) jika forbidNonWhitelisted false', async () => {
    const softPipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false, 
      transform: true,
    });

    const maliciousPayload = { username: 'test', injectedFlag: 1 };
    const result: unknown = await softPipe.transform(maliciousPayload, metadata);
    
    expect((result as Record<string, unknown>).username).toBe('test');
    expect((result as Record<string, unknown>).injectedFlag).toBeUndefined();
  });
});
```

## Deep Dive: Mass Assignment Vulnerability (Vektor Eksploitasi & Pertahanan)

*Mass Assignment Vulnerability* (sering juga diklasifikasikan sebagai *Auto-binding Vulnerability* atau *Object Injection*) terjadi ketika sebuah aplikasi web secara membabi-buta menerima input tambahan dari *client* dan memetakannya langsung (mengikat) ke dalam model data objek internal atau *database entity*. Celah ini sangat berbahaya karena membiarkan pengguna memodifikasi nilai *field* tingkat sistem atau otorisasi yang seharusnya tidak dapat diubah oleh peran pengguna biasa.

### Mekanisme Eksploitasi Tanpa *Shield*
Anggaplah Anda membangun sebuah *endpoint* untuk profil *user*: HTTP PUT `/api/v1/users/:id`. *Endpoint* ini dirancang hanya untuk memperbarui `username` dan `bio`. Namun, tabel `User` di basis data juga menyimpan kolom `role` (berisi 'USER' atau 'ADMIN') serta kolom `balance` (berisi saldo dompet elektronik).

Seorang peretas (attacker) yang jeli akan mencoba mengonstruksi HTTP PUT *Request* seperti berikut:
```json
{
  "username": "hacker_elite_99",
  "bio": "I hack for fun",
  "role": "ADMIN",
  "balance": 9999999
}
```
Jika layer DTO tidak menerapkan perlindungan *stripping* dengan ketat, NestJS akan meneruskan *payload* utuh tersebut ke *controller*, dan kemudian *controller* akan meneruskannya ke fungsi TypeORM / Prisma:
```typescript
// ANTI-PATTERN: Jangan pernah mem-passing req.body secara langsung ke layer ORM!
await this.userRepository.update(id, req.body);
```
Sintaks ORM tersebut akan membaca keberadaan properti `role` dan `balance`, lalu membuat sintaks SQL `UPDATE users SET role = 'ADMIN', balance = 9999999 WHERE id = ?`. Boom! Akun peretas secara instan dinaikkan otoritasnya menjadi *Admin* penuh dan memiliki uang tak terbatas.

### Solusi Pertahanan Komprehensif (Defense in Depth)
Lapisan mitigasi dari *Mass Assignment* tidak cukup hanya di satu tempat. Pendekatan *Defense-in-Depth* sangat dibutuhkan:
1. **ValidationPipe Global (Layer DTO):** Kombinasi `whitelist: true` dan `forbidNonWhitelisted: true` secara otomatis akan menolak *payload* nakal ini di level awal, bahkan sebelum menyentuh logika *Controller*. Ini adalah perlindungan utama (L1).
2. **Strict Type-Mapping (Layer Service):** DILARANG Keras mengirim *object literal* utuh dari *client* ke fungsi *Repository*. Prosedur aman adalah dengan memetakan secara manual:
   ```typescript
   await this.userRepository.update(id, {
     username: dto.username,
     bio: dto.bio,
   });
   ```
3. **Konfigurasi Database/ORM:** Pastikan *framework* ORM mengunci atribut *fillable* (pada beberapa ORM) atau memiliki mekanisme blokir jika kolom berstatus internal/rahasia diubah tanpa fungsi mutator khusus.

## Konfigurasi Global `ClassSerializerInterceptor` (Standard Produksi)

Untuk membersihkan data sebelum dikembalikan ke *client* (mengamankan data seperti _password hash_, _internal token_, _One-Time Password (OTP)_, atau riwayat audit), NestJS memanfaatkan `ClassSerializerInterceptor`. Interceptor ini mencegat (*intercept*) *object response* dan melakukan pembersihan (stripping) berdasarkan deklarasi dekorator dari paket `class-transformer`.

Praktik Top 1% mewajibkan interceptor ini diregistrasikan secara global di konfigurasi `main.ts` agar developer tidak lupa memasangnya di tiap *controller*, yang dapat memicu *data leak* insidental.

```typescript
import { ClassSerializerInterceptor, ValidationPipe, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app: INestApplication = await NestFactory.create(AppModule);

  // 1. Global Pipeline untuk Sanitasi Input (Proteksi Inbound)
  app.useGlobalPipes(new ValidationPipe({ 
    whitelist: true, 
    forbidNonWhitelisted: true, 
    transform: true 
  }));

  // 2. Global Interceptor untuk Eksklusi Output (Proteksi Outbound - Mencegah Data Leak)
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  // Menghindari hardcoded secrets & ports, memanfaatkan environment variable mutlak
  const port: number = process.env.APP_PORT ? parseInt(process.env.APP_PORT, 10) : 3000;
  
  // Hanya mendengarkan di interface localhost/private jika di belakang reverse proxy
  const host: string = process.env.APP_HOST || '0.0.0.0';
  await app.listen(port, host);
}
```

## Pola Pemisahan DTO: Request DTO vs Response DTO (SSOT Pattern)

Dalam sistem bertingkat tinggi (*Enterprise-Grade*), penggunaan DTO (`UserDto`) yang seragam untuk *Request* (Input, Validasi) dan *Response* (Output, Serialisasi) adalah praktik yang sangat berbahaya dan diklasifikasikan sebagai *Anti-Pattern*. 

❌ **Anti-Pattern:** Satu class `UserDto` dengan campuran `@IsEmail()`, `@Exclude()`, dan `@IsOptional()`. Developer akan pusing membedakan properti mana yang diperuntukkan bagi form pendaftaran, dan properti mana yang dikembalikan setelah sukses mendaftar.

✅ **Benar (SSOT Pattern):** Pisahkan secara definitif antara `CreateUserRequestDto` (fokus penuh pada validasi keamanan input dengan `class-validator`) dan `UserResponseDto` (fokus penuh pada format output yang bersih dengan `class-transformer`). Ini menciptakan *Single Source of Truth* untuk masing-masing fase siklus (masuk dan keluar).

```typescript
import { Exclude, Expose } from 'class-transformer';
import { IsString, IsEmail, MinLength } from 'class-validator';

// 1. Request DTO (Input Validation - Inbound)
export class CreateUserRequestDto {
  @IsEmail()
  public readonly email!: string;

  @IsString()
  @MinLength(8)
  public readonly password!: string;
}

// 2. Response DTO (Output Serialization - Outbound)
@Exclude() // Menolak semua properties kecuali yang di-@Expose() (Secure by Default)
export class UserResponseDto {
  @Expose()
  public readonly id!: string;

  @Expose()
  public readonly email!: string;

  // Properti 'password' dan 'createdAt' TIDAK akan diekspos sama sekali 
  // karena tidak memiliki dekorator @Expose()
}
```
**Trade-Off Pemisahan DTO:**
- **Pros:** Keamanan terjamin (Secure by Default), kode terstruktur, terhindar dari bentrok dekorator.
- **Cons:** *Boilerplate* kode menjadi bertambah dua kali lipat, membutuhkan kedisiplinan pemetaan objek manual.

## Pitfalls (Jebakan) Penggunaan `@Exclude()` pada Inheritance (Pewarisan)

Ketika mengandalkan paket `class-transformer` versi tertentu, penerapan `@Exclude()` dapat menunjukkan tingkah laku tak terduga (*undefined behavior*) saat dikombinasikan dengan pewarisan berbasis *Class Inheritance* (mekanisme `extends`).

❌ **Anti-Pattern (Pitfall Inherent Leak):**
```typescript
import { Exclude, Expose } from 'class-transformer';

class BaseEntityDto {
  @Exclude() // Mencoba menyembunyikan properti internal di level parent
  public internalDatabaseId!: string;
}

// Terkadang dalam versi class-transformer usang, turunan (child class) 
// secara diam-diam membatalkan deklarasi Exclude parent jika tidak dikonfigurasi ketat.
export class PublicUserDto extends BaseEntityDto {
  @Expose()
  public email!: string;
}
```
✅ **Benar (Mitigasi Strict Strategy):**
Mekanisme pertahanan paling aman adalah membatasi tingkat eksposure dengan pola *Strategy Exclude-All* tepat di deklarasi *class* level paling spesifik/turunan. Ini memastikan semua anggota properti disembunyikan sampai secara eksplisit dianotasi satu per satu dengan `@Expose()`.

```typescript
@Exclude() // Proteksi eksklusi penuh di level class turunan (Maksimum sekuriti)
export class SecurePublicUserDto extends BaseEntityDto {
  @Expose()
  public readonly publicId!: string;

  @Expose()
  public readonly email!: string;
}
```

## Pencegahan Kritis: Prototype Pollution (Peracunan Purwarupa)

*Prototype Pollution* (Peracunan Purwarupa) adalah sebuah vektor eksploitasi di dunia JavaScript/Node.js, memungkinkan peretas (*attacker*) secara paksa menyuntikkan properti jahat ke objek purwarupa dasar `Object.prototype`. Hal ini akan berimbas kepada setiap iterasi objek di seluruh *runtime* eksekusi Node.js, berpotensi merusak perilaku logika percabangan aplikasi, bypass sistem otentikasi, hingga memicu *Remote Code Execution* (RCE) jika objek yang dimanipulasi dikonsumsi oleh fungsi tingkat sistem (seperti manipulasi `spawn` pada `child_process`).

Di aplikasi NestJS, *bypass* dapat disusupkan lewat *payload* bersarang (nested JSON) yang secara licik menyisipkan atribut `__proto__` atau struktur rekursif `constructor.prototype`.

**Langkah Mitigasi Level Produksi:**
1. **Gunakan Object.create(null):** Jika dimungkinkan, untuk manipulasi dictionary internal gunakan inisialisasi tanpa purwarupa, sehingga ia kebal terhadap turunan properti dari `Object.prototype`.
2. **Hindari Recursive Merge Sembarangan:** Jangan memanggil mekanisme penggabungan bersarang secara serampangan. Pastikan setiap pustaka pihak ketiga telah memiliki tambalan perbaikan eksploit *Prototype Pollution*.
3. **Middleware Guard Validation:** Tangkal percobaan ini langsung dari *middleware* paling luar yang memonitor arus lalu lintas HTTP yang masuk.

```typescript
import { Injectable, NestMiddleware, BadRequestException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class PrototypePoisoningMiddleware implements NestMiddleware {
  public use(req: Request, res: Response, next: NextFunction): void {
    // Memeriksa body payload untuk mendeteksi injeksi properti prototipe JS
    if (req.body && typeof req.body === 'object') {
      const payloadString: string = JSON.stringify(req.body);
      
      // Deteksi kaku pada penanda bahaya
      if (payloadString.includes('"__proto__"') || payloadString.includes('"constructor"')) {
         throw new BadRequestException('Security System: Potential Prototype Pollution Attempt Blocked');
      }
    }
    next();
  }
}
```
*Catatan Trade-Off Performa:*
Melakukan `JSON.stringify()` berulang kali pada *payload* yang masif berukuran megabyte dapat melahirkan degradasi performa komputasi O(N) dan membebani sinkronisasi CPU *event-loop*. Untuk performa yang jauh lebih optimal, konfigurasi parser JSON pada lapisan terluar (Express `body-parser` atau Fastify parsers) yang secara spesifik dirancang untuk mencegah *proto keys* agar langsung dibuang (*stripped*).

## Kesimpulan Akhir
Performa tangguh dari lapisan keamanan DTO dan Serialization pada *framework* NestJS bukan terletak pada keajaiban *framework* itu sendiri, melainkan pada kejelian konfigurasi sang arsitek *software*. Dengan menegakkan perisai *Payload Stripping* yang tak kenal ampun, membentengi respons data menggunakan intersepsi global, dan melindungi dari *Prototype Pollution* dan Mass Assignment, seorang praktisi NestJS dapat dengan percaya diri meloloskan infrastruktur perusahaannya melewati audit *security penetration testing* paling ketat sekalipun.
```
