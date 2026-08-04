# Jest SWC Supercharged Suite: Eksekusi Test 20x Lebih Cepat di NestJS

## Pengantar
Di dunia rekayasa perangkat lunak enterprise modern, kecepatan *feedback loop* adalah segalanya. Penggunaan `ts-jest` bawaan pada proyek NestJS seringkali menjadi hambatan utama dalam eksekusi unit testing berskala besar (ribuan *test cases*). Kompilasi *TypeScript* secara *real-time* yang dilakukan oleh `ts-jest` memakan waktu yang sangat signifikan. Sebagai Principal Testing & QA Master, solusi mutlak untuk memecahkan masalah kompilasi ini adalah dengan mengganti *compiler* bawaan dengan **SWC (Speedy Web Compiler)**—sebuah *compiler* super cepat berbasis bahasa pemrograman Rust. 

Dengan integrasi `@swc/jest`, kita bisa memangkas waktu kompilasi hingga 20 kali lipat, mengizinkan tim *engineering* untuk mencapai *feedback loop* yang instan.

---

## Arsitektur Kompilasi SWC vs TS-Jest

```text
+-------------------------------------------------------------+
|               TRADITIONAL TS-JEST PIPELINE                  |
+-------------------------------------------------------------+
| TypeScript Code -> tsc (Node.js) -> Type Check -> Jest Exec |
| (Slow, Single Threaded, Memory Intensive)                   |
+-------------------------------------------------------------+
                              VS
+-------------------------------------------------------------+
|                  SWC/JEST RUST PIPELINE                     |
+-------------------------------------------------------------+
| TypeScript Code -> SWC (Rust) -> AST Transpile -> Jest Exec |
| (Blazing Fast, Multi-Threaded, No Type Check Overhead)      |
+-------------------------------------------------------------+
```

## Konfigurasi Jest SWC di NestJS

Integrasi SWC membutuhkan perubahan pada konfigurasi Jest. Kita harus menghapus referensi ke `ts-jest` dan menggantinya dengan `@swc/jest`.

### `jest.config.ts`

```typescript
import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s?$': [
      '@swc/jest',
      {
        jsc: {
          target: 'es2022',
          parser: {
            syntax: 'typescript',
            decorators: true,
            dynamicImport: true,
          },
          transform: {
            legacyDecorator: true,
            decoratorMetadata: true,
          },
        },
      },
    ],
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
};

export default config;
```

## Contoh Implementasi Kode & Test Suite

Berikut adalah contoh modul service *fintech* sederhana beserta test suite-nya.

### `transaction.service.ts`

```typescript
import { Injectable, BadRequestException } from '@nestjs/common';

export interface TransactionPayload {
  readonly accountId: string;
  readonly amount: number;
  readonly currency: string;
}

export interface TransactionResult {
  readonly transactionId: string;
  readonly status: 'SUCCESS' | 'FAILED';
  readonly timestamp: Date;
}

@Injectable()
export class TransactionService {
  public async processTransaction(payload: TransactionPayload): Promise<TransactionResult> {
    if (payload.amount <= 0) {
      throw new BadRequestException('Amount must be strictly positive');
    }

    if (payload.currency !== 'IDR' && payload.currency !== 'USD') {
      throw new BadRequestException('Unsupported currency format');
    }

    // Simulasi pemrosesan asinkron
    await this.delayExecution(50);

    return {
      transactionId: `TXN-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      status: 'SUCCESS',
      timestamp: new Date(),
    };
  }

  private delayExecution(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

### `transaction.service.spec.ts`

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { TransactionService, TransactionPayload } from './transaction.service';
import { BadRequestException } from '@nestjs/common';

describe('TransactionService (SWC Supercharged)', () => {
  let transactionService: TransactionService;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [TransactionService],
    }).compile();

    transactionService = moduleRef.get<TransactionService>(TransactionService);
  });

  it('should be defined properly', () => {
    expect(transactionService).toBeDefined();
  });

  it('should successfully process a valid IDR transaction', async () => {
    const payload: TransactionPayload = {
      accountId: 'ACC-991823',
      amount: 1500000,
      currency: 'IDR',
    };

    const result = await transactionService.processTransaction(payload);

    expect(result).toBeDefined();
    expect(result.status).toStrictEqual('SUCCESS');
    expect(result.transactionId).toMatch(/^TXN-\d+-\d+$/);
    expect(result.timestamp).toBeInstanceOf(Date);
  });

  it('should reject transactions with negative amounts', async () => {
    const payload: TransactionPayload = {
      accountId: 'ACC-991823',
      amount: -500,
      currency: 'USD',
    };

    await expect(transactionService.processTransaction(payload)).rejects.toThrow(
      BadRequestException,
    );
    await expect(transactionService.processTransaction(payload)).rejects.toThrow(
      'Amount must be strictly positive',
    );
  });

  it('should reject transactions with unsupported currencies', async () => {
    const payload: TransactionPayload = {
      accountId: 'ACC-991823',
      amount: 1000,
      currency: 'JPY',
    };

    await expect(transactionService.processTransaction(payload)).rejects.toThrow(
      BadRequestException,
    );
    await expect(transactionService.processTransaction(payload)).rejects.toThrow(
      'Unsupported currency format',
    );
  });
});
```

---

## Analisis Trade-Off

### Kelebihan
1. **Kecepatan Eksekusi Ekstrim**: Karena ditulis menggunakan Rust, kompilasi TypeScript via SWC secara drastis jauh lebih cepat dibandingkan dengan `ts-jest` yang menggunakan ekosistem Node.js.
2. **Penggunaan Memori Efisien**: SWC jauh lebih hemat memori, mencegah masalah `heap out of memory` yang sering terjadi di CI/CD ketika menjalankan ribuan pengujian.
3. **Dukungan Decorators Langsung**: Secara bawaan mendukung `legacyDecorators` dan `decoratorMetadata` yang mana merupakan syarat mutlak agar fitur Dependency Injection NestJS bisa bekerja dengan baik.

### Kekurangan
1. **Tidak Ada Pengecekan Tipe (Type Checking)**: SWC hanya melakukan transpiler kode tanpa memvalidasi tipe TypeScript. Kompilasi mungkin sukses tapi terdapat error tipe. 
2. **Kompabilitas Modul EcmaScript (ESM)**: Terkadang penggabungan beberapa pustaka pihak ketiga dengan format ESM murni bisa menimbulkan masalah kecil yang memerlukan konfigurasi khusus.
3. **Beban Penyiapan Awal**: Berpindah dari `ts-jest` standar NestJS membutuhkan pemahaman mendalam mengenai konfigurasi transformasi Jest dan target ECMAScript yang sesuai.

---

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menggunakan ts-jest dengan isolasi penuh tanpa pengecekan tipe
Mengubah `isolatedModules: true` di `ts-jest` memang mempercepat kompilasi dengan mematikan fitur pengecekan tipe, namun performanya masih jauh di bawah keaslian binary Rust milik SWC.

```typescript
// ❌ CONTOH SALAH - Setup Jest TS-Jest yang dipaksakan cepat namun tetap memakan memori
export default {
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true }],
  },
};
```

```typescript
// ✅ CONTOH BENAR - Transisi seutuhnya ke SWC Native
export default {
  transform: {
    '^.+\\.(t|j)s?$': ['@swc/jest', { /* konfigurasi rust compiler swc */ }],
  },
};
```

### ❌ Anti-Pattern 2: Melupakan Decorator Metadata di SWC
Jika Anda lupa mengaktifkan konfigurasi metadata decorator, Dependency Injection NestJS akan hancur dan gagal memetakan injeksi *class*.

```json
// ❌ CONTOH SALAH - Tidak menyalakan fitur reflection metadata
"transform": {
  "legacyDecorator": false,
  "decoratorMetadata": false
}
```

```json
// ✅ CONTOH BENAR - Menyalakan fitur standar yang dibutuhkan TypeScript dan NestJS
"transform": {
  "legacyDecorator": true,
  "decoratorMetadata": true
}
```

---

## Production Edge Cases

1. **Absennya Type Checking di CI Pipeline**: Karena `@swc/jest` menghilangkan beban kompilasi tipe (*type-checking*), Anda diwajibkan menyertakan tahap kompilasi `tsc --noEmit` di lintasan CI/CD terpisah sebelum atau sesudah tahap uji coba (testing) berjalan agar cacat tipe (type bugs) tetap tertangkap secara utuh.
2. **Resolusi Path Mapping (tsconfig paths)**: Saat menggunakan `@swc/jest`, penangan `paths` di file `tsconfig.json` harus disinkronisasikan juga ke konfigurasi Jest melalui properti `moduleNameMapper` yang disediakan, jika tidak injeksi direktori *absolute* akan gagal dimuat.
3. **Eksekusi Jest Terlalu Cepat Mengakibatkan Kegagalan Database**: Terkadang, kecepatan eksekusi super kilat dari SWC pada tahap setup/teardown dapat menimbulkan *race condition* jika integrasi ke database tiruan lambat memproses koneksi (misalnya *SQLite in-memory* yang memakan waktu), ini memaksa tim QA untuk menambahkan strategi retry atau *delay logic* pada `beforeAll` dan `afterAll`.

Gunakan SWC untuk membuka potensi kecepatan tak terbatas dalam proses *quality assurance*!


## ? Anti-Pattern vs ? Best Practice (SWC Integration)

? **Anti-Pattern: Membiarkan Type Checking Terjadi di Runtime Tes**
Menjalankan 	s-jest konvensional dengan tipe checking aktif pada seluruh rangkaian tes E2E dan Unit Tes yang besar akan menyebabkan bottleneck parah (hingga 10x lebih lambat dibandingkan transpiler native).

? **Best Practice: SWC untuk Transpilasi Cepat & TSC untuk Type Check Paralel**
Gunakan @swc/jest untuk kecepatan eksekusi tes murni (Hanya *stripping* tipe tanpa verifikasi). Untuk memastikan type safety, jalankan 	sc --noEmit dalam *step* terpisah di CI/CD atau gunakan fitur Type-Checking asinkron pada *pre-commit hook*. Hal ini menjamin *feedback loop* TDD yang instan bagi engineer di lokal tanpa mengorbankan integritas keamanan tipe. Ini adalah standar de facto dalam ekosistem monorepo Enterprise saat ini.

### Edge Cases pada Mocking SWC
Dalam skenario *Hoisting* module dengan jest.mock(), perhatikan bahwa SWC terkadang memproses *import statments* sedikit berbeda dari Babel. Jika Anda menemukan error Cannot read properties of undefined pada mock, pastikan penempatan deklarasi mock berada di posisi paling atas (Top-level) agar selaras dengan aturan *hoisting* ketat dari standar ECMAScript terbaru.
