# Zod / Joi Schema Validation for Environment Startup (Safety Gate)

## 1. Pendahuluan
Salah satu penyebab terbesar insiden "Crash in Production" adalah hilangnya atau salahnya format variabel lingkungan (Environment Variables) pada file `.env`. Di arsitektur Enterprise, aplikasi Node.js tidak boleh berhasil booting jika konfigurasi infrastruktur tidak lengkap. Kita menggunakan konsep **Startup Safety Gate** melalui validasi skema `.env` ketat (menggunakan `Zod` atau `Joi`) pada `ConfigModule` NestJS, menjamin bahwa kegagalan (Fail Fast) terjadi sedini mungkin. Penambahan **Fail-fast startup validation pattern**, **type coercion vs strict parsing**, **complex union types**, dan **multi-environment config strategy** akan dibahas mendalam.

## 2. Diagram Arsitektur
```ascii
+-----------------------+       +-------------------+       +-----------------------+
|  Container / VM       |       | NestJS Bootstrap  |       | Output (Console)      |
|                       |       |                   |       |                       |
|  .env / ENV_VARS  ----+------>+ Zod Validator     +---X-->+ FATAL: DB_PORT is     |
|                       |       | Fail-fast Gate    |       | missing! (Exit 1)     |
|                       |       |                   |       |                       |
|  (Dev/Prod/Staging)   |       | [Pass]            |       +-----------------------+
+-----------------------+       +----|--------------+       
                                     |
                              +------v-------------+
                              | App Listens on 3000|
                              +--------------------+
```

## 3. Konsep Lanjutan & Pattern

### a. Fail-Fast Startup Validation Pattern
Pola ini memaksa aplikasi untuk memvalidasi seluruh kebutuhannya sebelum menerima trafik. Daripada gagal saat *runtime* (misal: saat fungsi email dipanggil dan ternyata kredensial SMTP kosong), kita memindahkan titik kegagalan ke waktu *booting*. Ini sangat krusial dalam lingkungan orkestrasi (seperti Kubernetes) di mana kontainer yang gagal *booting* tidak akan pernah dimasukkan ke dalam *Load Balancer pool*.

### b. Type Coercion vs Strict Parsing
Di dalam `process.env`, semua nilai pada dasarnya adalah `string`. 
- **Type Coercion:** Secara otomatis mencoba mengubah tipe data, misalnya string `"3000"` menjadi number `3000`, atau `"true"` menjadi boolean `true`.
- **Strict Parsing:** Mewajibkan data sudah dalam tipe yang benar. Karena `process.env` selalu string, `Strict Parsing` tanpa *pre-processing* akan selalu gagal untuk tipe non-string. Zod menyediakan `z.coerce` untuk mengatasi masalah ini dengan sangat elegan tanpa mematikan strict type checking untuk struktur akhirnya.

### c. Complex Union Types
Terkadang environment variable bisa memiliki tipe gabungan, misalnya variabel `LOG_LEVEL` yang hanya boleh bernilai `'info' | 'warn' | 'error'`, atau konfigurasi `STORAGE_DRIVER` yang memilih antara `'local'` atau `'s3'`. Kita menggunakan `z.union` atau `z.enum` untuk memaksa validasi *Union Types* yang kompleks.

### d. Multi-Environment Config Strategy
Strategi ini mengizinkan skema untuk menyesuaikan aturan berdasarkan *environment* tempat ia berjalan (Development, Staging, Production). Misalnya, `JWT_SECRET` mungkin opsional atau memiliki *default* lemah di `development`, namun Wajib dan harus kuat di `production`.

## 4. Implementasi Kode Produksi TypeScript 5+ & NestJS 10+ (Menggunakan Zod)

### a. Instalasi Dependencies
```bash
npm install @nestjs/config zod
```

### b. Pembuatan Skema Validasi
```typescript
// src/config/env.validation.ts
import { z } from 'zod';

export const envValidationSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test', 'staging']).default('development'),
  PORT: z.coerce.number().min(1024).max(65535).default(3000),
  
  // Database Config
  DATABASE_HOST: z.string().min(1),
  DATABASE_PORT: z.coerce.number().default(5432),
  DATABASE_USER: z.string().min(1),
  DATABASE_PASSWORD: z.string().min(1),
  
  // Secrets (Harus kuat)
  JWT_SECRET: z.string().min(32, 'JWT Secret must be at least 32 characters long'),
  
  // Complex Union Types untuk tipe storage
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  
  // S3 Config (opsional jika STORAGE_DRIVER = local, wajib jika s3)
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
}).superRefine((data, ctx) => {
  // Multi-environment Config Strategy & Complex Dependency
  if (data.STORAGE_DRIVER === 's3') {
    if (!data.S3_BUCKET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_BUCKET'],
        message: 'S3_BUCKET is required when STORAGE_DRIVER is s3',
      });
    }
    if (!data.S3_REGION) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_REGION'],
        message: 'S3_REGION is required when STORAGE_DRIVER is s3',
      });
    }
  }
  
  // Aturan ketat khusus produksi
  if (data.NODE_ENV === 'production' && data.DATABASE_PASSWORD.length < 12) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DATABASE_PASSWORD'],
      message: 'Production database password must be at least 12 characters long',
    });
  }
});

// Ekspor tipe untuk type-safety saat injeksi
export type EnvironmentVariables = z.infer<typeof envValidationSchema>;

// Fungsi Jembatan untuk NestJS ConfigModule - Menerapkan Fail-fast startup validation pattern
export function validate(config: Record<string, unknown>) {
  const parsed = envValidationSchema.safeParse(config);
  
  if (!parsed.success) {
    console.error('❌ FATAL ERROR: Invalid environment variables:');
    parsed.error.errors.forEach((err) => {
      console.error(`- ${err.path.join('.')}: ${err.message}`);
    });
    // Fail Fast: Segera hentikan proses jika environment tidak valid
    throw new Error('Application startup aborted due to invalid environment variables.');
  }
  
  return parsed.data;
}
```

### c. Mengikat pada App Module
```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validate } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // Konfigurasi tersedia secara global di semua modul
      validate,       // Hook Zod validation ke NestJS
      cache: true,    // Cache proses getter memori (process.env lambat)
      expandVariables: true, // Dukungan untuk variabel env yang bersarang
    }),
  ],
})
export class AppModule {}
```

### d. Unit Testing
```typescript
// src/config/env.validation.spec.ts
import { validate } from './env.validation';

describe('Environment Validation (Fail-Fast Gate)', () => {
  it('should validate successfully with correct variables', () => {
    const mockEnv: Record<string, string> = {
      NODE_ENV: 'development',
      PORT: '8080',
      DATABASE_HOST: 'localhost',
      DATABASE_USER: 'admin',
      DATABASE_PASSWORD: process.env.TEST_DB_PASSWORD ?? 'password123_fallback',
      JWT_SECRET: process.env.TEST_JWT_SECRET ?? 'super_secret_key_that_is_at_least_32_chars_long',
      STORAGE_DRIVER: 'local',
    };

    const result = validate(mockEnv);
    expect(result.PORT).toBe(8080); // coerce from string to number
  });

  it('should throw an error if required variable is missing', () => {
    const mockEnv: Record<string, string> = {
      NODE_ENV: 'development',
      // DATABASE_HOST hilang
    };

    expect(() => validate(mockEnv)).toThrow('Application startup aborted');
  });
  
  it('should apply complex union validation correctly (S3 config missing)', () => {
    const mockEnv: Record<string, string> = {
      NODE_ENV: 'development',
      PORT: '8080',
      DATABASE_HOST: 'localhost',
      DATABASE_USER: 'admin',
      DATABASE_PASSWORD: process.env.TEST_DB_PASSWORD ?? 'password123_fallback',
      JWT_SECRET: process.env.TEST_JWT_SECRET ?? 'super_secret_key_that_is_at_least_32_chars_long',
      STORAGE_DRIVER: 's3',
      // S3_BUCKET dan S3_REGION sengaja dihilangkan padahal wajib jika STORAGE_DRIVER = s3
    };

    expect(() => validate(mockEnv)).toThrow('Application startup aborted');
  });
});
```

## 5. Analisis Trade-Off
### Kelebihan:
1. **Fail Fast:** Mendeteksi insiden kredensial/port hilang sebelum request pertama masuk ke aplikasi, melindungi reputasi API dan *server-side rendering*. Ini mengurangi risiko kegagalan laten.
2. **Type Coercion:** Zod secara cerdas mengubah string `"3000"` dari file `.env` menjadi tipe `number` yang aman digunakan langsung, menghindari bug tipe data yang sulit dilacak.
3. **Dokumentasi Hidup (Living Document):** Skema `z.object` berfungsi sebagai dokumentasi primer bagi developer DevOps, menunjukkan dengan pasti kunci, format, tipe, dan kondisi (*complex union types*) apa yang wajib disediakan.
4. **Multi-Environment Adaptability:** Aturan dapat menyesuaikan keamanan berdasarkan `NODE_ENV`, memudahkan pengembangan lokal tanpa melemahkan keamanan produksi.

### Kekurangan:
1. **Crash Loop Kubernetes:** Jika Environment salah dan aplikasi terus-menerus gagal dan `exit(1)`, orchestrator seperti k8s akan mengalami status `CrashLoopBackOff`, menyebabkan *deployment* terjebak (ini by-design namun sulit didebug dari luar oleh tim infrastruktur tanpa akses log).
2. **Beban Maintenance:** Saat skema `.env` ditambahkan, developer harus mengingat untuk menuliskannya ganda: satu di file `.env.example`, dan satu di skema validasi Zod.
3. **Mengekspos Error Terlalu Bebas:** Kadang pesan validasi bocor ke log startup CI/CD publik jika konfigurasi salah dikelola (mengekspos nama field kredensial DB internal, meskipun *value*-nya tidak terekspos).

## 6. Anti-Patterns Kritis

### Anti-Pattern 1: Menyediakan Fallback Kredensial Produksi (The "Never Crash" Fallacy)
❌ **Salah:** Memberikan *default password* untuk environment produksi agar aplikasi "tidak crash".
```typescript
// z.string().default('admin123') // SANGAT BAHAYA DI PRODUKSI
```
✅ **Benar:** Biarkan crash (Fail-fast). Password HARUS dari environment (di-inject).
```typescript
// z.string().min(1) // Wajib diisi!
```

### Anti-Pattern 2: Silent Validation Ignore
❌ **Salah:** Mengembalikan `{}` kosong atau sebagian data saat terjadi error tanpa melempar Exception, membuat aplikasi berlari secara cacat buta dan menimbulkan *runtime error* di tempat tak terduga.
✅ **Benar:** Gunakan `throw new Error()` atau `process.exit(1)` dengan log *fatal* yang jelas mengindikasikan field mana yang salah.

### Anti-Pattern 3: Strict Parsing Tanpa Coercion pada Environment Variables
❌ **Salah:** Menggunakan strict types seperti `.number()` murni tanpa menyadari `process.env` selalu menghasilkan `string`. Ini akan menyebabkan aplikasi tidak pernah bisa *boot*.
✅ **Benar:** Gunakan `z.coerce.number()` atau pre-processing parsing.

## 7. Production Edge Cases
1. **Boolean Parsing Issue (Environment Edge):**
   `process.env.DEBUG` berisi string `"false"`. Jika tidak ada coercion boolean ketat, `if (process.env.DEBUG)` akan bernilai `TRUE` (karena `"false"` bukan *falsy* di JavaScript). Zod menyelesaikan ini dengan `z.coerce.boolean()`, yang menerjemahkan `"false"` secara harfiah menjadi nilai boolean `false`.
2. **Dynamic Secrets via Secret Manager (AWS/Vault):**
   Skema ini hanya memvalidasi environment saat *startup*. Jika Anda menarik *rahasia tambahan asinkron* lewat HashiCorp Vault setelah bootstrap, skema awal mungkin belum memiliki kredensial tersebut. Strategi terbaik adalah memisahkan tahap validasi menjadi dua *ronde*: Ronde 1 (validasi env statis saat boot), Ronde 2 (validasi dinamis setelah secrets ditarik).
3. **Docker Compose & Dotenv Overlaps:**
   Terjadi perebutan *override* antara `.env` di file sistem, `.env` file Docker, dan *inject environment* dari Container orchestrator, sering mengakibatkan prioritas validasi yang membingungkan. Sangat direkomendasikan untuk menonaktifkan pemuatan `.env` file fisik di lingkungan produksi dan 100% bergantung pada injeksi murni dari orkestrator (seperti *ConfigMap* / *Secrets* K8s).
4. **Validasi Union Type yang Saling Bertentangan (Race Condition Config):**
   Ketika migrasi sistem, beberapa flag *legacy* mungkin masih terpasang. Konfigurasi `superRefine` harus memastikan tidak ada dua opsi yang saling meniadakan aktif secara bersamaan, memastikan *state* aplikasi deterministik.
