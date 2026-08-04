# Automasi Client SDK TypeScript dari OpenAPI Specification

## 1. Pendahuluan

Kolaborasi antara tim Backend dan Frontend acap kali membuahkan gesekan (friction) karena ketidakcocokan kontrak payload API. Tim Backend mengubah tipe data, namun Frontend baru menyadarinya di lingkungan *production*. 

Solusi mutlak (Top 1%) untuk hal ini adalah memanfaatkan *OpenAPI Specification* (Swagger JSON) sebagai *Single Source of Truth* (SSOT). Dari abstraksi tersebut, pipeline CI/CD mengeksekusi generasi *Client SDK* secara otomatis menggunakan generator industri seperti `openapi-typescript` atau `@openapitools/openapi-generator-cli`. Praktik ini mewujudkan sinkronisasi 100%, type-safety ujung-ke-ujung (end-to-end), dan menolak secara frontal semua pembaruan manual yang tidak standar.

## 2. Arsitektur CI/CD SDK Generation

```text
+-------------------+      +-------------------+      +-------------------+
|  Backend NestJS   |      | CI/CD Pipeline    |      | Frontend (React)  |
|                   |      |                   |      |                   |
| 1. Code Changes   | ===> | 3. Build Code     | ===> | 6. Import SDK     |
| 2. Push to Git    |      | 4. Extract Swagger|      | 7. TS Type Check  |
+-------------------+      | 5. Run Generator  |      | 8. Build Web      |
                           +-------------------+      +-------------------+
                                    |
                                    v
                           +-------------------+
                           |  Publish NPM Pkg  | (Opsional: Private Registry)
                           |  @org/api-sdk     |
                           +-------------------+
```

## 3. Implementasi Produksi (NestJS 10+ & TypeScript 5+)

### 3.1. Skrip Ekstraksi File JSON Swagger

Kita harus menulis skrip Node.js (misalnya `scripts/generate-openapi.ts`) yang membangkitkan instance aplikasi NestJS murni tanpa listener HTTP, menciptakan dokumen Swagger, dan menuliskannya ke format `swagger.json`.

```typescript
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { AppModule } from '../src/app.module';

/**
 * Utilitas skrip untuk menghasilkan swagger.json statis guna digenerasi
 * oleh alat frontend di pipeline.
 */
async function generateStaticOpenApiFile(): Promise<void> {
  // Jangan listen pada port, cukup inisialisasi context aplikasi
  const app = await NestFactory.create(AppModule, { logger: false });

  const config = new DocumentBuilder()
    .setTitle('Enterprise API System')
    .setDescription('Spesifikasi API untuk pembuatan Client SDK.')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  
  const targetPath = join(process.cwd(), 'swagger.json');
  
  writeFileSync(targetPath, JSON.stringify(document, null, 2), { encoding: 'utf-8' });
  
  console.log(`[SUCCESS] Dokumen OpenAPI berhasil diekstrak dan disimpan di ${targetPath}`);
  
  await app.close();
  process.exit(0);
}

generateStaticOpenApiFile().catch((error: unknown) => {
  console.error('[ERROR] Gagal merender spesifikasi OpenAPI:', error);
  process.exit(1);
});
```

### 3.2. Integrasi Pipeline via `package.json`

Tambahkan tool `openapi-typescript` ke dependensi *development*, lalu rangkai skrip perintah *generate*.

```json
{
  "scripts": {
    "openapi:extract": "ts-node scripts/generate-openapi.ts",
    "openapi:generate-types": "openapi-typescript ./swagger.json -o ./frontend-sdk/types.d.ts",
    "openapi:sync": "npm run openapi:extract && npm run openapi:generate-types"
  },
  "devDependencies": {
    "openapi-typescript": "^6.0.0",
    "ts-node": "^10.9.1"
  }
}
```

## 4. Analisis Trade-Off

### Kelebihan
1. **End-to-End Type Safety:** Setiap perubahan atribut yang dilakukan pada Backend (misalnya mengubah *string* menjadi *number*) akan langsung memutuskan kompilasi Frontend sehingga masalah dapat tertangkap segera di fase CI (Shift-left security and validation).
2. **Efisiensi Developer Frontend:** Developer UI tidak perlu lagi menyusun tipe Axios dan interface TS satu per satu secara manual. Semua fungsi HTTP Client (*GET, POST*) dan antarmuka *payload* datang dari *autocomplete* IDE secara sihir.
3. **Dokumentasi Hidup yang Wajib Dipatuhi:** Memaksa tim backend untuk benar-benar mengurus definisi dan tipe di NestJS. Kebohongan pada JSDoc akan memantul keras pada kerusakan SDK aplikasi kustomer.

### Kekurangan
1. **Peningkatan Beban Pipeline (Overhead):** Menjalankan Nest application context di tengah CI/CD untuk mengekstraksi JSON memakan waktu 3 - 10 detik, menambah latensi pada siklus *deployment*.
2. **Tipe Kompleks Sering Hancur:** Penggunaan dekorator yang eksotis dan modifikasi polymorfis (mis. `@ApiExtraModels`, `oneOf`, `anyOf`) terkadang diinterpretasikan salah oleh generator, mengharuskan modifikasi pemodelan di tingkat NestJS.
3. **Peringatan Perubahan Pecah (Breaking Changes):** Tim backend tidak bisa semena-mena mengubah API untuk uji coba kecil karena akan langsung me-reject build di repo *frontend*, yang dapat menyulut konflik jika manajemen versi (*versioning*) API kurang matang.

## 5. Anti-Patterns & Best Practices

### ❌ Anti-Pattern 1: Menyimpan (Commit) Hasil SDK ke Repositori Backend
Banyak tim me-*run* script generasi dan meng-*commit* `types.d.ts` langsung ke dalam *monorepo* backend secara paksa, sehingga memperbesar ukuran repositori tak wajar.

```bash
# ❌ SALAH: Menyatukan hasil generate SDK bersama logika aplikasi ke Git Repo
git add frontend-sdk/types.d.ts
git commit -m "update SDK"
```
```bash
# ✅ BENAR: Generasi harus bersifat ephemeral (sementara) dalam pipeline CI. 
# Hasil SDK yang matang diterbitkan sebagai package npm.
npm publish ./frontend-sdk --access restricted
```

### ❌ Anti-Pattern 2: Pembuatan Tipe secara Manual (Ducking Types)
Frontend Engineer memandang sebelah mata hasil generator dan lebih memilih mendefinisikan interface palsu yang menyerupai API (Duck Typing).

```typescript
// ❌ SALAH: Developer frontend menerka-nerka respon dari Postman
interface UserResponse { id: string, name: any }
```
```typescript
// ✅ BENAR: Menggunakan referensi inferensi langsung dari OpenAPI Schema
import { components } from './generated/api-schema';
type UserResponse = components['schemas']['UserDTO'];
```

## 6. Production Edge Cases

1. **Circular Dependencies pada NestJS Model:**
   Saat Entitas A merujuk ke Entitas B dan B merujuk ke A, JSON stringify dokumentasi Swagger dapat terperosok ke jurang rekursi tak berhingga (Stack Overflow) atau generator TypeScript di Frontend akan macet. Biasakan menggunakan skema hirarki terbatas (DTO terpisah dari Entity murni).
2. **Pola Penamaan Duplikat (Naming Collisions):**
   Mungkin ada `CreateUserDto` di dua buah *module* NestJS yang berbeda (misal module *Admin* dan module *Client*). Swagger secara bawaan akan meremukkan (override) nama yang berkonflik. Selalu tetapkan penamaan yang unik dan absolut.
3. **Perubahan Kredensial Environment Saat Start-Up:**
   Karena script `generate-openapi.ts` harus me-*load* `AppModule`, sistem akan menolak booting jika modul database gagal melakukan verifikasi variabel *environment* (karena berjalan di pipeline dummy CI). Triknya adalah memilah *AppModule* sehingga komponen database dapat dilewati (*bypassed/mocked*) khusus untuk profil "Swagger Extraction".

## 7. Swagger JSON Extractions Test Suite

```typescript
import { execSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';

describe('OpenAPI SDK Automatic Generation Pipeline Test Suite', () => {
  const targetJsonPath = join(process.cwd(), 'swagger.json');

  beforeAll(() => {
    // Bersihkan sebelum mulai
    if (existsSync(targetJsonPath)) {
      unlinkSync(targetJsonPath);
    }
  });

  afterAll(() => {
    // Bersihkan setelah tes
    if (existsSync(targetJsonPath)) {
      unlinkSync(targetJsonPath);
    }
  });

  it('Script ekstraksi harus menghasilkan file swagger.json yang memvalidasi skema OpenAPI murni', () => {
    // Jalankan skrip pembantu menggunakan eksekusi node statis
    // Ini mensimulasikan lingkungan CI/CD
    try {
      execSync('npx ts-node scripts/generate-openapi.ts', { stdio: 'pipe' });
    } catch (error) {
      console.error('Eksekusi gagal:', error);
      throw new Error('Skrip ekstraksi ts-node melempar exception.');
    }

    // Verifikasi apakah file JSON Swagger dihasilkan
    expect(existsSync(targetJsonPath)).toBe(true);

    const swaggerContentBuffer = readFileSync(targetJsonPath, 'utf8');
    const parsedSwagger = JSON.parse(swaggerContentBuffer);

    // Validasi skema meta (Minimal versi 3.0.x)
    expect(parsedSwagger.openapi).toMatch(/^3\.0\.\d+$/);
    
    // Verifikasi judul harus Enterprise API System
    expect(parsedSwagger.info.title).toEqual('Enterprise API System');
    
    // Pastikan skema komponen dan path telah diinisialisasi
    expect(parsedSwagger.paths).toBeDefined();
    expect(parsedSwagger.components).toBeDefined();
  });
});
```
