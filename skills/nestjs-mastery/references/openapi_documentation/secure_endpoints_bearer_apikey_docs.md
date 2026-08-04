# Pengamanan Endpoint Swagger UI: Bearer Token, API Key & Proteksi Produksi

## 1. Pendahuluan dan Signifikansi Keamanan

Mengekspos dokumentasi API yang interaktif (Swagger UI) adalah pisau bermata dua. Di satu sisi, ia menyajikan antarmuka *Developer Experience* (DX) yang luar biasa untuk menguji coba API. Namun di sisi lain, jika halaman tersebut terekspos ke publik tanpa lapisan otentikasi di tingkat aplikasi (API endpoint) dan tingkat antarmuka, itu sama halnya dengan membagikan denah rumah beserta kunci master kepada peretas.

Dokumen ini menjelaskan implementasi *zero-trust* dalam konteks spesifikasi OpenAPI 3 di NestJS, meliputi cara mendefinisikan mekanisme otentikasi global/spesifik menggunakan Bearer Token atau API Key, dan juga cara melindungi akses terhadap endpoint `/api/docs` itu sendiri.

## 2. Diagram Alir Keamanan Swagger/OpenAPI

```text
                                +-----------------------------------+
                                |     Pengguna / Klien (Browser)    |
                                +-----------------------------------+
                                                 |
                                     (1) Akses HTTP GET /api/docs
                                                 v
+-----------------------------+ (2) Cek    +--------------------------+
|  Basic Auth Middleware      | <========= | Proteksi Rute Dokumentasi|
+-----------------------------+  (Unauthorized) +--------------------------+
             | (3) Valid (Melihat UI)
             v
+---------------------------------------------------------+
| Swagger UI Interactive Dashboard                        |
|                                                         |
| [ Authorize Button ] -> Meminta JWT atau API Key        |
|                                                         |
| (4) Menjalankan Try It Out via endpoint bisnis API      |
+---------------------------------------------------------+
             | (5) HTTP POST /api/v1/secure-data + Header
             v
+-----------------------------+
| NestJS Auth Guard (Guards)  | ---> Endpoint Eksekusi Bisnis
+-----------------------------+
```

## 3. Implementasi Produksi (NestJS 10+ & TypeScript 5+)

### 3.1. Proteksi Endpoint /api/docs (Middleware Basic Auth)

Sebelum pengguna dapat melihat UI Swagger, kita lindungi rutenya dengan HTTP Basic Authentication menggunakan library `express-basic-auth`. Hal ini krusial di lingkungan staging dan produksi.

```typescript
import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as basicAuth from 'express-basic-auth';
import { ConfigService } from '@nestjs/config';

export function setupSwaggerDocumentation(app: INestApplication, configService: ConfigService): void {
  // 1. Ambil kredensial admin dari environment variables (Zero Hardcoded Secrets)
  const docsUsername = configService.get<string>('SWAGGER_USER', 'admin');
  const docsPassword = configService.get<string>('SWAGGER_PASSWORD', 'super-secret');
  
  // 2. Terapkan Middleware Basic Auth HANYA pada path swagger
  app.use(
    ['/api/docs', '/api/docs-json'],
    basicAuth({
      challenge: true,
      users: {
        [docsUsername]: docsPassword,
      },
      unauthorizedResponse: 'Akses Dokumentasi API Ditolak.',
    }),
  );

  // 3. Konfigurasi Dokumen OpenAPI Utama
  const openApiConfig = new DocumentBuilder()
    .setTitle('Enterprise Secure Core API')
    .setDescription('Spesifikasi teknis layanan mutakhir.')
    .setVersion('2.0')
    // Mendefinisikan mekanisme keamanan Bearer Token (JWT)
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Masukkan Token JWT yang sah.',
        in: 'header',
      },
      'JWT-auth', // Nama referensi internal
    )
    // Mendefinisikan mekanisme keamanan API Key
    .addApiKey(
      {
        type: 'apiKey',
        name: 'x-api-key',
        in: 'header',
        description: 'Kunci Akses API (API Key) untuk layanan sistem ke sistem.',
      },
      'Api-Key-Auth',
    )
    .build();

  const document = SwaggerModule.createDocument(app, openApiConfig);
  SwaggerModule.setup('api/docs', app, document);
}
```

### 3.2. Penandaan Endpoint Spesifik dengan Dekorator

Dalam Controller, kita menerapkan metadata keamanan yang merujuk pada nama referensi yang telah kita deklarasikan.

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags, ApiOperation } from '@nestjs/swagger';
// Asumsikan AuthGuard kustom
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ApiKeyAuthGuard } from './guards/api-key-auth.guard';

@ApiTags('Operasi Finansial Rahasia')
@Controller('finance')
export class ConfidentialFinanceController {

  /**
   * Endpoint berbasis pengguna yang membutuhkan JWT Token.
   */
  @Get('wallet/balance')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth') // Menyambungkan ke referensi 'JWT-auth' dari setupSwaggerDocumentation
  @ApiOperation({ summary: 'Mendapatkan saldo dompet pengguna' })
  public async getWalletBalance(): Promise<{ balance: number }> {
    return { balance: 99999.00 };
  }

  /**
   * Endpoint berbasis server-to-server yang membutuhkan API Key.
   */
  @Get('system/audit-logs')
  @UseGuards(ApiKeyAuthGuard)
  @ApiSecurity('Api-Key-Auth') // Menyambungkan ke referensi 'Api-Key-Auth'
  @ApiOperation({ summary: 'Mendapatkan log audit seluruh sistem' })
  public async getSystemAuditLogs(): Promise<{ logs: string[] }> {
    return { logs: ['Log 1', 'Log 2'] };
  }
}
```

## 4. Analisis Trade-Off

### Kelebihan
1. **Pagar Ganda Ekstra:** Menerapkan Basic Auth pada path UI memastikan publik secara umum dan web-crawler tidak dapat mengindeks denah sistem API internal.
2. **Katalis Interaktivitas Klien:** Dengan definisi `@ApiBearerAuth`, tim Front-End dapat dengan mudah men-copy-paste JWT mereka ke Swagger UI dan langsung mengeksekusi request yang dilindungi tanpa alat eksternal seperti Postman.
3. **Deskripsi Mekanisme yang Jelas:** Spesifikasi OpenAPI mendokumentasikan dengan standar yang diterima industri bagaimana cara berinteraksi dengan API, termasuk format otorisasi yang diharapkan, sehingga mengurangi miskomunikasi antar tim.

### Kekurangan
1. **Ovehead Pemeliharaan Rute UI:** Basic Auth hanyalah middleware statis. Ia menyusahkan automasi pengecekan integrasi karena memerlukan kredensial ekstra hanya untuk merender JSON swagger saat pipeline berjalan (kecuali di-*bypass*).
2. **Kelupaan Sinkronisasi Dekorator:** Sering kali pengembang mengamankan sebuah rute dengan `@UseGuards(JwtAuthGuard)` namun lupa menyertakan `@ApiBearerAuth()`, akibatnya endpoint terkunci, namun di Swagger UI tidak tersedia tombol gembok kunci bagi klien untuk memasukkan token.
3. **Keterbatasan Kustomisasi Autentikasi UI:** OAuth2 flows bawaan Swagger UI (seperti Authorization Code Flow) sangat rumit untuk di-setup dengan baik di backend yang bertindak sebagai resource server semata.

## 5. Anti-Patterns & Best Practices

### ❌ Anti-Pattern 1: Menyimpan Kredensial Swagger Auth di Source Code
Meng-hardcode *username* dan *password* dari Basic Auth ke dalam repositori akan membahayakan sistem secara permanen.

```typescript
// ❌ SALAH: Hardcode kredensial! Dilarang keras!
app.use('/api/docs', basicAuth({
  users: { 'admin': 'SuperSecret123!' }
}));
```

```typescript
// ✅ BENAR: Mengandalkan environment variables.
const user = configService.getOrThrow<string>('SWAGGER_USER');
const pass = configService.getOrThrow<string>('SWAGGER_PASSWORD');
app.use('/api/docs', basicAuth({ users: { [user]: pass } }));
```

### ❌ Anti-Pattern 2: Tidak Mendaftarkan Skema Keamanan di Setup Document
Menggunakan `@ApiBearerAuth()` di controller tanpa terlebih dahulu mendaftarkan `.addBearerAuth()` di konfigurasi `DocumentBuilder`. Hasilnya UI Swagger tidak merender menu input *Authorize*.

```typescript
// ❌ SALAH: DocumentBuilder tidak memuat addBearerAuth()
const config = new DocumentBuilder().build();

// ✅ BENAR: Harus didefinisikan mekanisme sekuritinya terlebih dahulu.
const config = new DocumentBuilder().addBearerAuth(..., 'JWT').build();
```

## 6. Production Edge Cases

1. **Proxy dan Load Balancer Interfensi:**
   Saat menjalankan NestJS di belakang proxy (Nginx/AWS ALB), kadang-kadang middleware `express-basic-auth` tidak mendapatkan request dengan header yang benar akibat SSL Termination. Anda perlu memastikan bahwa aplikasi menerima header X-Forwarded-Proto.
2. **CSRF dan Swagger UI:**
   Jika Anda memberlakukan proteksi CSRF di seluruh environment, fitur "Try it out" pada Swagger UI (terutama metode POST/PUT) dapat diblokir sistem karena UI Swagger tidak mengirimkan CSRF token secara *default*. Pendekatannya adalah mengecualikan rute Swagger dari CSRF check atau menginjeksi token.
3. **Bocornya Endpoint JSON ke Publik:**
   Pastikan middleware basic auth memproteksi TIDAK HANYA `/api/docs` tetapi juga endpoint file mentahnya yaitu `/api/docs-json` dan `/api/docs-yaml`. Banyak pengembang mengunci UI-nya tetapi membiarkan JSON-nya terbuka.

## 7. Unit / Security Endpoints Test Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { ConfidentialFinanceController } from './finance.controller';

// Dummy guards untuk test
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ExecutionContext } from '@nestjs/common';

describe('Swagger Documentation Security Middleware Test Suite', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Mocking AuthGuard agar selalu gagal jika tidak ada token (contoh isolasi)
    const mockJwtGuard = {
      canActivate: (context: ExecutionContext) => {
        const req = context.switchToHttp().getRequest();
        return req.headers.authorization === 'Bearer VALID_TOKEN';
      },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ConfidentialFinanceController],
    })
    .overrideGuard(JwtAuthGuard).useValue(mockJwtGuard)
    .compile();

    app = moduleFixture.createNestApplication();
    
    // Terapkan proteksi tiruan mirip implementasi setup
    app.use('/api/docs', (req: any, res: any, next: any) => {
      const auth = req.headers.authorization;
      if (auth !== 'Basic YWRtaW46c2VjcmV0') { // admin:secret dalam base64
        return res.status(401).send('Unauthorized');
      }
      res.status(200).send('SWAGGER UI RENDERED');
    });
    
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('Harus menolak akses ke halaman Swagger UI jika kredensial Basic Auth salah', async () => {
    const response = await request(app.getHttpServer()).get('/api/docs');
    expect(response.status).toBe(401);
  });

  it('Harus memberikan akses ke halaman Swagger UI jika kredensial Basic Auth benar', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/docs')
      .set('Authorization', 'Basic YWRtaW46c2VjcmV0');
    expect(response.status).toBe(200);
    expect(response.text).toContain('SWAGGER UI RENDERED');
  });

  it('Endpoint bisnis (/finance/wallet/balance) harus menolak akses jika JWT Token tidak disertakan', async () => {
    const response = await request(app.getHttpServer()).get('/finance/wallet/balance');
    expect(response.status).toBe(403); // Tergantung implementasi guard (Bisa 401 atau 403)
  });
});
```
