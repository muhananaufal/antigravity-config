# Kustomisasi Antarmuka Swagger UI: Tema, Branding & Kontrol Interaktivitas

## 1. Pendahuluan: Membawa Pengalaman Swagger ke Kelas Sultan

Antarmuka Swagger UI standar (putih mencolok dengan hijau/biru neon khas OpenAPI) secara fungsional sangat handal. Namun, di lanskap korporasi berskala enterprise, menampilkan antarmuka bawaan tanpa branding kepada pihak eksternal/mitra (B2B Partner) akan menurunkan wibawa perusahaan.

Melakukan kustomisasi Swagger UI tidak hanya menyoal penggantian warna. Ia juga melibatkan penerapan identitas perusahaan (logo, *favicon*, dark mode), penginjeksian kode CSS/JS khusus, dan menonaktifkan bilah eksekusi "Try it out" pada lingkungan *production* demi mencegah kecelakaan administratif yang dipicu oleh pengujian di luar konteks sistem.

## 2. Arsitektur Asset Injeksi pada Swagger UI

```text
+-----------------------+      +-------------------------+      +-----------------------+
|  NestJS Bootstrapper  |      |   SwaggerModule.setup   |      |  Client Web Browser   |
|-----------------------|      |-------------------------|      |-----------------------|
| - Parse Config        | ===> | - Configure options     | ===> | - Render HTML Index   |
| - Prepare Public Dir  |      | - Attach customCss      |      | - Load Swagger JS     |
|                       |      | - Attach customJs       |      | - Load custom.css     |
|                       |      | - Attach customSiteTitle|      | - Fetch swagger.json  |
+-----------------------+      +-------------------------+      +-----------------------+
```

## 3. Implementasi Produksi (NestJS 10+ & TypeScript 5+)

### 3.1. Pengaturan di Main Bootstrap

Pertama, siapkan konfigurasi Swagger dengan properti yang sangat dalam (deep customization) seperti *customCssUrl* dan pengaturan properti UI (misalnya menghapus topbar yang mengandung logo default Swagger).

```typescript
import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, SwaggerCustomOptions } from '@nestjs/swagger';
import { join } from 'path';
import * as express from 'express';

export function setupBrandedSwagger(app: INestApplication, environment: string): void {
  // Sajikan direktori publik agar CSS dan aset logo korporat dapat dilayani via HTTP
  app.use('/public', express.static(join(__dirname, '..', 'public')));

  const config = new DocumentBuilder()
    .setTitle('Nexus Core API Platform')
    .setDescription('Infrastruktur Mutakhir Nexus Corp.')
    .setVersion('3.1.0')
    .setContact('Developer Support', 'https://nexus.corp', 'support@nexus.corp')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  // Jika lingkungan adalah production, matikan mode "Try it out"
  const isProduction = environment === 'production';

  const customOptions: SwaggerCustomOptions = {
    customSiteTitle: 'Nexus API Documentation',
    customfavIcon: '/public/favicon.ico', // Ikon tab peramban kustom
    // Menyuntikkan CSS kustom eksternal untuk melumpuhkan styling bawaan
    customCssUrl: [
      'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui.min.css',
      '/public/theme-nexus-dark.css' // CSS Khusus dari direktori lokal kita
    ],
    // Menyuntikkan Custom CSS On-The-Fly
    customCss: `
      .topbar { display: none !important; } 
      .swagger-ui .info .title { color: #8F00FF !important; }
    `,
    swaggerOptions: {
      // Hilangkan field pencarian dan fitur lainnya untuk menjaga minimalisme
      filter: true,
      displayRequestDuration: true,
      docExpansion: 'none', // Lipat semua endpoint saat dimuat
      supportedSubmitMethods: isProduction 
        ? [] // Menonaktifkan tombol "Try it out" untuk semua method jika di Production
        : ['get', 'post', 'put', 'delete', 'patch'], 
    },
  };

  SwaggerModule.setup('api/docs', app, document, customOptions);
}
```

### 3.2. Penulisan File `theme-nexus-dark.css` (Contoh Snippet CSS)

Buat file CSS ini pada folder root `/public/theme-nexus-dark.css`.

```css
/* Custom Dark Mode Swagger UI */
body {
  background-color: #121212 !important;
  color: #E0E0E0 !important;
}

.swagger-ui .scheme-container {
  background-color: #1E1E1E !important;
  box-shadow: none !important;
  border-bottom: 1px solid #333;
}

/* Kustomisasi kontainer rute GET */
.swagger-ui .opblock.opblock-get {
  background: rgba(97, 175, 254, 0.1) !important;
  border-color: #61AFFE !important;
}
.swagger-ui .opblock.opblock-get .opblock-summary-method {
  background: #61AFFE !important;
}
```

## 4. Analisis Trade-Off

### Kelebihan
1. **Peningkatan Gengsi (Brand Prestige):** Partner B2B yang melakukan injeksi ke API Anda akan merasakan aura profesional dan kokoh dari kustomisasi tema perusahaan (mis: *Dark Mode* modern vs putih standar yang menyakitkan mata).
2. **Pencegahan Human Error (Keamanan Operasional):** Dengan menyembunyikan "Try it Out" di lingkungan produksi, kita mencegah manajer, auditor, atau developer iseng secara tak sengaja menghapus entitas database nyata ketika sedang membaca-baca dokumentasi.
3. **Pemuatan Modul Minimalis:** Parameter *docExpansion: none* menyusutkan pemuatan DOM, menyebabkan peramban berjalan lebih ringan saat merender API berskala masif (ratusan endpoint) dengan men-collapse semua *accordion*.

### Kekurangan
1. **Rawan Pembaruan UI Swagger (Brittle CSS):** Kustomisasi bergantung pada nama *class* dan struktur HTML CSS yang diterbitkan oleh pustaka Swagger. Jika `@nestjs/swagger` melakukan *bump version* yang memodifikasi struktur DOM Swagger bawaannya, file CSS kustom Anda mungkin runtuh (break layout).
2. **Tidak Support Serverless dengan Mudah:** Melayani aset statis `/public` untuk CSS melalui NestJS saat berjalan di AWS Lambda (Serverless) menambah kerumitan pengelolaan file, berpotensi memicu kegagalan pemuatan jika tidak menggunakan S3 Bucket CDN.
3. **Konflik Caching Klien:** CSS lokal yang sering dimodifikasi kerap tertahan di dalam *cache* peramban. Tanpa teknik cache-busting khusus, partner B2B Anda mungkin masih merender UI lama yang pecah berantakan.

## 5. Anti-Patterns & Best Practices

### ❌ Anti-Pattern 1: Menyembunyikan "Try it Out" hanya dengan CSS (Security through Obscurity)
Sebagian pengembang mencoba menonaktifkan tombol dengan menginjeksikan `.try-out__btn { display: none; }` ke dalam `customCss`.

```typescript
// ❌ SALAH: Menyembunyikan elemen HTML via CSS tidak memberikan keamanan, 
// peretas atau power-user masih bisa menghapus CSS dan memencet tombol eksekusi.
customCss: '.try-out { display: none !important; }'
```

```typescript
// ✅ BENAR: Menggunakan konfigurasi internal SwaggerOptions untuk melumpuhkan operasi HTTP.
swaggerOptions: {
  supportedSubmitMethods: [] // Metode HTTP yang diizinkan untuk dikirim dari UI adalah KOSONG.
}
```

### ❌ Anti-Pattern 2: Menaruh Aset Gambar dalam Base64 yang Sangat Masif
Menggunakan properti CSS *Base64 string* langsung pada konfigurasi `customCss` NestJS.

```typescript
// ❌ SALAH: Menjejali file JS dengan MB-an base64 gambar membuat inisiasi sangat berat dan merusak heap memory JS.
customCss: `body { background-image: url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg...'); }`
```
```typescript
// ✅ BENAR: Gunakan URL referensi yang diarahkan ke file aset statis.
customCssUrl: ['/public/assets/main-background.css']
```

## 6. Production Edge Cases

1. **Content Security Policy (CSP) Terhadap Inline CSS/JS:**
   Injeksi `customCss` dari properti string secara internal merender `<style>` *inline* di dalam indeks HTML. Jika infrastruktur Anda memberlakukan header `Content-Security-Policy` yang ketat (seperti pelarangan `unsafe-inline`), Swagger UI akan memblokir dan menolak me-render modifikasi tersebut. Solusinya, seluruh tema mutlak harus dimuat lewat file eksternal `customCssUrl`.
2. **Reverse Proxy Sub-Path Mismatch:**
   Saat menjalankan NestJS di belakang Traefik/Nginx, misalnya aplikasi berada di dalam `https://domain.com/my-service`, maka referensi file statis `/public/theme.css` akan pecah menjadi status 404 (Not Found). Anda harus selalu menyesuaikan referensi relasional berdasarkan *base path* reverse proxy (atau mengandalkan domain CDN absolut).
3. **Mobile Responsiveness yang Rusak:**
   Mengorbankan style bawaan dan memaksa aturan padding absolut (mis: `width: 1000px !important`) pada desain kustom Anda akan menghancurkan UX bagi pengembang yang mengamati API Anda dari gawai seluler/tablet portabel. Gunakan teknik CSS grid dan media-query.

## 7. Swagger Theme Extraction Test Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Controller, Get } from '@nestjs/common';

@Controller('dummy')
class DummyController {
  @Get()
  getHello(): string { return 'Hello'; }
}

describe('Swagger UI Custom Theme Application Test Suite', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [DummyController],
    }).compile();

    app = moduleFixture.createNestApplication();

    const config = new DocumentBuilder().build();
    const document = SwaggerModule.createDocument(app, config);
    
    // Injeksi kustom
    SwaggerModule.setup('api/docs', app, document, {
      customCss: '.topbar { display: none !important; }',
      customSiteTitle: 'Nexus Custom Title',
      swaggerOptions: {
        supportedSubmitMethods: [], // Prod mode
      }
    });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('Halaman HTML Swagger UI harus merender judul halaman kustom', async () => {
    const response = await request(app.getHttpServer()).get('/api/docs/');
    expect(response.status).toBe(200);
    // Verifikasi suntikan judul
    expect(response.text).toContain('<title>Nexus Custom Title</title>');
  });

  it('Halaman HTML Swagger UI harus menginjeksi customCSS', async () => {
    const response = await request(app.getHttpServer()).get('/api/docs/');
    expect(response.text).toContain('.topbar { display: none !important; }');
  });

  it('Konfigurasi UI harus menonaktifkan metode eksekusi HTTP', async () => {
    const response = await request(app.getHttpServer()).get('/api/docs/swagger-ui-init.js');
    expect(response.status).toBe(200);
    // Skrip inisiasi yang digenerate NestJS harus mencakup opsi mematikan tombol execute
    expect(response.text).toContain('"supportedSubmitMethods":[]');
  });
});
```
