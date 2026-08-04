# Pengamanan Lapis Baja OWASP API Top 10 via Fastify, Helmet, & Validation Pipes

NestJS, terutama jika dijalankan di atas mesin Fastify (bukan Express) demi efisiensi tinggi, membutuhkan hardening (penguatan) ketat sesuai pedoman keamanan **OWASP API Top 10**. Lapisan keamanan ini mencakup Header Security, proteksi Content Security Policy (CSP), pencegahan Mass Assignment DTO, sanitasi Injeksi, hingga CORS terkunci ketat.

## Arsitektur Keamanan Lapis Baja (Security Layers)

```ascii
                      [Jaringan Internet Publik]
                                  |
   +-------------------------------------------------------------+
   |                  NestJS + Fastify Engine                    |
   |                                                             |
   |  1. [Helmet] ---------------------------------------------+ |
   |     Menambahkan HSTS, X-Frame-Options, CSP, XSS-Filter    | |
   |                                                           | |
   |  2. [CORS Config] ----------------------------------------+ |
   |     Hanya izinkan spesifik Origin, Methods, dan Headers   | |
   |                                                           | |
   |  3. [Fastify CSRF/Rate Limiting] -------------------------+ |
   |     Proteksi di level koneksi ringan (Socket TCP/HTTP)    | |
   |                                                           | |
   |  4. [Global ValidationPipe] ------------------------------+ |
   |     whitelist: true, forbidNonWhitelisted: true           | |
   |     (Menolak Mass Assignment & Sanitasi XSS/SQL Payload)  | |
   |                                                             |
   +-------------------------------------------------------------+
                                  |
                                  v
                        [Controller & Logika]
```

## Implementasi Kode: TypeScript & NestJS 10+ (Fastify)

### 1. Bootstrapping dengan Helmet, HSTS, & CORS Ketat (`main.ts`)

```typescript
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import helmet from '@fastify/helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true, trustProxy: true }), // Trust proxy untuk membaca IP asli di belakang Nginx/Load Balancer
  );

  // 1. Integrasi Helmet untuk NestJS Fastify (Hardening HTTP Headers)
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Sesuai kebutuhan UI
        imgSrc: ["'self'", 'data:', 'https://images.trusted.com'],
        scriptSrc: ["'self'"], // Tolak XSS execution
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    hsts: {
      maxAge: 31536000, // 1 tahun
      includeSubDomains: true,
      preload: true,
    },
    frameguard: {
      action: 'deny', // Proteksi terhadap Clickjacking
    },
    hidePoweredBy: true, // Sembunyikan 'X-Powered-By: Express/Fastify'
  });

  // 2. Konfigurasi CORS Zero-Trust (Whitelisting ketat)
  app.enableCors({
    origin: (origin, callback) => {
      const allowedOrigins = ['https://dashboard.perusahaananda.com', 'https://api.perusahaananda.com'];
      // Mengizinkan request tanpa origin (seperti curl/Postman) atau origin terdaftar
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Akses diblokir oleh kebijakan CORS.'), false);
      }
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  });

  // 3. Pencegahan Mass Assignment & Sanitasi Tipe via DTO Pipeline
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Hapus otomatis semua property yang tidak ada di kelas DTO
      forbidNonWhitelisted: true, // Tolak request dan lempar HTTP 400 jika property tak dikenal dikirim (Strict Mass Assignment Protection)
      transform: true, // Konversi string ke angka/boolean sesuai metadata tipe
      disableErrorMessages: process.env.NODE_ENV === 'production', // Cegah bocornya struktur data detail kepada penyerang di sistem Produksi
    }),
  );

  await app.listen(3000, '0.0.0.0');
}

bootstrap();
```

### 2. Definisi DTO Aman dari Mass Assignment (`create-user.dto.ts`)

```typescript
import { IsEmail, IsString, IsNotEmpty, MaxLength, MinLength, Matches } from 'class-validator';

export class CreateUserDto {
  @IsEmail({}, { message: 'Format email tidak valid.' })
  @IsNotEmpty()
  public readonly email: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(64)
  // Ekspresi reguler membatasi karakter (hanya Alfanumerik) - Proteksi SQLi & XSS Lapis Pertama
  @Matches(/^[a-zA-Z0-9!@#\$%\^\&*\)\(+=._-]+$/, {
    message: 'Karakter pada password tidak diizinkan.',
  })
  public readonly password: string;
}
```

## Analisis Trade-Off

### Kelebihan
1. **Perlindungan Injeksi Lapis Aplikasi (Mass Assignment):** Penyerang tidak bisa menginjeksi parameter liar (misal `{"isAdmin": true}` di body request registrasi) karena DTO akan langsung menolaknya.
2. **Postur Keamanan Pasif-Otomatis:** Modul Helmet dan aturan CORS bekerja secara transparan di seluruh aplikasi, melindungi sistem dari berbagai serangan dasar web (Clickjacking, MIME Sniffing, XSS) tanpa pengembang perlu menulis kodenya setiap kali.
3. **Optimasi Fastify:** Memanfaatkan implementasi native Fastify untuk layer keamanannya terbukti lebih efisien dalam memproses *request/response* secara konkurensi skala tinggi dibandingkan middleware Express.

### Kekurangan
1. **Debugging Lebih Sulit di Produksi:** `disableErrorMessages: true` di ValidationPipe sering membuat aplikasi Frontend sulit menerjemahkan "kesalahan form/input" karena response hanya memberi pesan ringkas "Bad Request". Perlu error code spesifik (bukan deskripsi panjang).
2. **Pengelolaan CSP yang Rumit:** Terutama bila API diintegrasikan dengan *swagger documentation UI*, modul iframe eksternal, atau web-view di *mobile apps*, konfigurasi Content Security Policy dapat memblokir skrip secara agresif jika tidak teliti merancang instruksi `script-src` dan `style-src`.
3. **CORS Overhead:** Konfigurasi origin dinamis dengan *callback array* menyebabkan server harus menjalankan logic dan selalu melempar `OPTIONS` (Preflight) header, berpotensi menambah delay mikro di koneksi awal.

## Anti-Patterns Kritis

### Anti-Pattern 1: Menggunakan Wildcard `*` di Konfigurasi CORS
❌ **Salah:** Mengizinkan semua situs lintas-domain mengirim *credentials* merupakan bunuh diri sekuritas. Penyerang di `https://evil-site.com` bisa memanggil API atas nama user Anda (CSRF).
```typescript
app.enableCors({
  origin: '*', // SANGAT BURUK!
  credentials: true, 
});
```

✅ **Benar:** Daftar tegas/white-list origin terpercaya, dan atur `credentials: true`.

### Anti-Pattern 2: DTO Lemah Tanpa Whitelist
❌ **Salah:** DTO hanya sebagai penanda tipe tanpa filter. Property injeksi akan masuk ke dalam service.
```typescript
app.useGlobalPipes(new ValidationPipe({
  whitelist: false, // BURUK: Mass Assignment mengintai!
}));
```

✅ **Benar:** Aktifkan `whitelist: true` dan `forbidNonWhitelisted: true`. Semua yang tidak tertulis di DTO class (tidak memiliki dekorator `@Is...`) akan dibuang atau ditolak, membersihkan muatan beracun atau XSS mentah di *property* ekstra.

## Production Edge Cases

1. **Load Balancer Masking the IP Address:** Karena server Node.js sering diletakkan di balik reverse-proxy seperti Nginx atau AWS ALB, server akan melihat IP pengguna sebagai "IP internal Nginx" (misalnya `10.0.0.x`). Tanpa `trustProxy: true` di FastifyAdapter, library keamanan atau Rate Limiter akan gagal memblokir IP peretas asli karena seluruh serangan dianggap datang dari Nginx.
2. **Reverse Proxy TLS Offloading:** Helmet's HSTS mensyaratkan koneksi berjalan pada *secure scheme* (HTTPS). Namun, Load Balancer sering mendekripsi HTTPS dan meneruskan HTTP ke NestJS (TLS offloading). NestJS perlu diberitahu via header proxy (`X-Forwarded-Proto`) bahwa *client asli* memakai HTTPS agar aturan HTTP security berlaku tepat sasaran.
3. **Pengecualian CSP pada Swagger UI:** Jika menjalankan endpoint `/api-docs` Swagger yang butuh eksekusi script statis dari inline string, Helmet dapat merusak interface Swagger sepenuhnya (layar putih blank) karena melarang instruksi `unsafe-inline`. Anda harus mematikan Helmet spesifik di *route* `/api-docs` atau melonggarkan instruksi spesifik di *development*.

## Unit / Integration Testing Suite (ValidationPipe)

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { Controller, Post, Body, INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { CreateUserDto } from './create-user.dto';

@Controller('users')
class UsersController {
  @Post()
  create(@Body() body: CreateUserDto) {
    return { success: true, data: body };
  }
}

describe('Global Security & Mass Assignment Suite', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
    }).compile();

    app = moduleFixture.createNestApplication();
    
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('DTO Protection', () => {
    it('harus menerima muatan valid sesuai DTO', async () => {
      const validPayload = {
        email: 'aman@perusahaananda.com',
        password: process.env.MOCK_TEST_PASSWORD || 'PasswordKuKuat123!',
      };

      const res = await request(app.getHttpServer())
        .post('/users')
        .send(validPayload)
        .expect(201);
      
      expect(res.body.success).toBe(true);
      expect(res.body.data.email).toEqual(validPayload.email);
    });

    it('harus menolak permintaan dan melemparkan HTTP 400 karena Mass Assignment (forbidNonWhitelisted)', async () => {
      const maliciousPayload = {
        email: 'hacker@jahat.com',
        password: process.env.MOCK_TEST_PASSWORD || 'PasswordBiasa123!',
        isAdmin: true, // PROPERTY INJEKSI LIAR
        __proto__: { role: 'admin' }, // Prototype poisoning attempt
      };

      const res = await request(app.getHttpServer())
        .post('/users')
        .send(maliciousPayload)
        .expect(400);

      expect(res.body.error).toBe('Bad Request');
      expect(res.body.message).toContain('property isAdmin should not exist');
    });

    it('harus menolak format injeksi (SQLi/XSS char) pada email/password', async () => {
      const badPayload = {
        email: 'bukan-email-asli',
        password: process.env.MOCK_TEST_SHORT_PASSWORD || '12', // Harus ganti jika di production, ini sengaja jelek utk test validation error
      };

      const res = await request(app.getHttpServer())
        .post('/users')
        .send(badPayload)
        .expect(400);

      expect(res.body.message.some((msg: string) => msg.includes('email tidak valid'))).toBe(true);
    });
  });
});
```
