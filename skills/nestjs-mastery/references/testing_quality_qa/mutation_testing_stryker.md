# Mutation Testing Stryker: Audit Kekebalan Unit Test Abakan

## Pengantar
*Code coverage* sebesar 100% adalah ilusi berbahaya di lingkungan Enterprise. Sebuah *test suite* yang sempurna secara persentase baris kode belum tentu mendeteksi kecacatan logika apabila asersi (*assertions*) yang ditulis ternyata usang, tidak relevan, atau terlalu lemah. 

Sebagai jawaban mutlak, metodologi **Mutation Testing** menggunakan **Stryker Mutator** wajib diterapkan. Stryker secara sistematis dan otomatis menyuntikkan berbagai malfungsi kecil (disebut *Mutants* atau mutan) ke dalam modul TypeScript produksi. Jika unit test gagal mendeteksi kecacatan buatan tersebut (mutan dinyatakan "selamat" atau *survived*), itu mengindikasikan test case terkait teramat bobrok atau abal-abal!

---

## Arsitektur Stryker Mutation Cycle

```text
+-------------------------------------------------------------+
|               STRYKER MUTATION TESTING LOOP                 |
+-------------------------------------------------------------+
| 1. Stryker membaca berkas logika (contoh: service.ts)       |
| 2. Menanam Mutan A (Mengubah `>` menjadi `<=`)              |
| 3. Mengeksekusi Jest Test Suite secara paralel              |
| 4. HASIL:                                                   |
|    - JIKA Test GAGAL (Merah) -> Mutan MATI (KILLED)  ✅     |
|    - JIKA Test LULUS (Hijau) -> Mutan SELAMAT (SURVIVED) ❌ |
| 5. Lanjut Mutan B, Mutan C, ...                             |
+-------------------------------------------------------------+
```

## Konfigurasi & Implementasi Kode Test

Berikut adalah pedoman integrasi mutasi tipe TypeScript tingkat lanjut untuk menemukan titik kelemahan asersi logika *fintech*.

### `stryker.conf.json`

```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "packageManager": "npm",
  "reporters": ["html", "clear-text", "progress", "dashboard"],
  "testRunner": "jest",
  "testRunnerNodeArgs": ["--experimental-vm-modules"],
  "coverageAnalysis": "perTest",
  "mutate": [
    "src/**/*.ts",
    "!src/**/*.spec.ts",
    "!src/main.ts",
    "!src/**/*.module.ts"
  ],
  "checkers": ["typescript"],
  "tsconfigFile": "tsconfig.json",
  "concurrency": 4
}
```

### `discount.service.ts`

```typescript
import { Injectable, BadRequestException } from '@nestjs/common';

export interface DiscountResult {
  readonly finalPrice: number;
  readonly isEligible: boolean;
}

@Injectable()
export class DiscountService {
  public calculateDiscount(originalPrice: number, customerAge: number): DiscountResult {
    if (originalPrice < 0 || customerAge < 0) {
      throw new BadRequestException('Invalid numeric parameter');
    }

    // Target empuk mutasi stryker:
    // 1. Kondisi logika AND (&&) diubah ke OR (||)
    // 2. Operator Batas (>=) diubah menjadi (>) atau (<)
    // 3. Konstanta Literal (100000) dimanipulasi
    if (customerAge >= 60 && originalPrice > 100000) {
      return { finalPrice: originalPrice * 0.8, isEligible: true }; // 20% Off
    }

    return { finalPrice: originalPrice, isEligible: false };
  }
}
```

### `discount.service.spec.ts`

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { DiscountService } from './discount.service';
import { BadRequestException } from '@nestjs/common';

describe('DiscountService (Stryker Ready)', () => {
  let service: DiscountService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DiscountService],
    }).compile();

    service = module.get<DiscountService>(DiscountService);
  });

  // TES INI RENTAN MUTASI! Jika kita hanya menguji umur 65 (melewati > 60), 
  // mutasi yang mengubah >= 60 menjadi > 60 akan LOLOS dan SURVIVED!
  it('should apply discount for senior citizens buying expensive items', () => {
    // Kita WAJIB menguji *boundary limit* mutlak! (Tepat usia 60)
    const result = service.calculateDiscount(100001, 60);

    expect(result.isEligible).toStrictEqual(true);
    // Kita WAJIB memastikan logika perhitungan asertif presisi, tidak sebatas check boolean.
    expect(result.finalPrice).toStrictEqual(80000.8);
  });

  it('should not apply discount for normal users', () => {
    // Batas bawah edge case
    const result = service.calculateDiscount(100001, 59);
    expect(result.isEligible).toStrictEqual(false);
  });

  it('should not apply discount for cheap items below or equal to limit', () => {
    // Batas presisi harga (tepat 100000 tidak dapat diskon)
    const result = service.calculateDiscount(100000, 70);
    expect(result.isEligible).toStrictEqual(false);
  });

  it('should throw bad request on negative inputs', () => {
    expect(() => service.calculateDiscount(-10, 60)).toThrow(BadRequestException);
    expect(() => service.calculateDiscount(100, -5)).toThrow(BadRequestException);
  });
});
```

---

## Analisis Trade-Off

### Kelebihan
1. **Garansi Kebenaran Asersi Mutlak**: Menyaring barisan kode palsu (*dead assertions*) di mana Anda secara teknis tidak menguji apa-apa selain deklarasi kebenaran hampa (`expect(true).toBeTruthy()`).
2. **Menemukan Boundary-Value Errors**: Mutasi kondisi logika batas `<, >, <=, >=` adalah hal yang paling sering terlewatkan pengembang *Node.js*; Stryker secara ekstrem kejam terhadap kecerobohan *boundary logic* ini.
3. **Meningkatkan Metrik QA Enterprise**: Laporan HTML dari Stryker memberikan rasa percaya diri eksponensial saat perakitan sistem finansial (fintech). Lolos dari jeratan Stryker berarti kode 99% tahan peluru.

### Kekurangan
1. **Performa Super Sangat Lambat**: Menjalankan siklus uji coba pada ratusan file bisa memakan waktu bermenit-menit (bahkan jam), menjadikannya tak masuk akal dieksekusi di *pre-commit hook*. Hanya ideal dilakukan pada CI malam (*Nightly Builds*).
2. **Positif Palsu (False Positives/Equivalent Mutants)**: Seringkali, Stryker memutasikan baris kode konfigurasi statis, file DTO dekorator, atau log (console.log/logger), menciptakan mutan abadi yang secara logis tidak dapat dibunuh (*Equivalent Mutants*).
3. **Kelelahan Analisis (*Analysis Fatigue*)**: Merapikan tes dari laporan mutan-mutan bisa menjadi pekerjaan sangat kotor, panjang, dan mematahkan moral *developer* biasa, membutuhkan ketekunan Principal Level QA Engineer.

---

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menyertakan Modul NestJS dalam Lingkup Mutasi
Membiarkan Stryker memutasi file-file dekorator, penyedia inti, dan konfigurasi framework Nest (`app.module.ts`, `main.ts`, file DTO murni). Mutan dari file ini sangat susah dibunuh.

```json
// ❌ CONTOH SALAH - Memutasi segalanya secara rakus
"mutate": ["src/**/*.ts"]
```

```json
// ✅ CONTOH BENAR - Mengkecualikan berkas spesifik kerangka kerja
"mutate": [
  "src/**/*.ts",
  "!src/main.ts",
  "!src/**/*.module.ts",
  "!src/**/*.dto.ts"
]
```

### ❌ Anti-Pattern 2: Asersi Lemah Hanya Pada Keberadaan Fungsi/Properti
Memiliki *test case* yang sekedar mengecek apakah fungsi tidak menyebabkan sistem hancur (*crash*) tanpa benar-benar merazia logika internal.

```typescript
// ❌ CONTOH SALAH - Asersi Abang-abangan (100% Coverage, 0% Stryker Score)
it('should run discount calculation', () => {
  const result = service.calculateDiscount(200000, 65);
  expect(result).toBeDefined(); // MUTAN APAPUN AKAN SELAMAT KARENA SELALU TRUE!
});
```

```typescript
// ✅ CONTOH BENAR - Asersi Tepat Sasaran
it('should run discount calculation and deduct 20%', () => {
  const result = service.calculateDiscount(200000, 65);
  expect(result.finalPrice).toStrictEqual(160000); 
  expect(result.isEligible).toStrictEqual(true);
});
```

---

## Production Edge Cases

1. **Mutan di Dalam Operator Ternary Bersarang**: Ternary ganda (`condition ? a : condition2 ? b : c`) menimbulkan ledakan permutasi (*explosion of permutations*) pada algoritma Stryker, yang menyebabkan mesin pembunuh mutan kehabisan tenaga atau RAM sistem tumpah ruah (*OOM*). Solusi utama adalah refaktorisasi kompleksitas kode produksi, bukan melemahkan Stryker!
2. **Kompilasi TypeScript Gagal di Sesi Transisi (Timeout Mutants)**: Stryker mungkin memutasi kode Anda sedemikian rupa sehingga mengakibatkan *infinite loop* logika (Contoh: `while(true)`). Untungnya, *testRunnerNodeArgs* yang canggih secara bawaan memiliki penjaga batas waktu untuk menandai mutan ini dengan status *Timeout* dan membunuhnya otomatis sebelum Node.js terkunci total (hang).
3. **Sikap Toleransi Pada Logger (Bypass Logger Mutation)**: Di ruang produksi, memutasi `this.logger.debug('Proses selesai')` menjadi `this.logger.debug('')` akan menciptakan mutan yang tak bisa dan tak perlu dibunuh (karena Anda tak seharusnya menguji string spesifik dari sistem Logger). Tambahkan bendera pengecualian spesifik `// Stryker disable next-line StringLiteral` pada kode Anda untuk memaksa bypass uji baris logis yang tak berpengaruh ke bisnis objektif.

## Topik Lanjutan QA Enterprise: Mutation Testing

### 1. Penegakan Ambang Batas Skor Mutasi (Mutation Score Threshold Enforcement)
Stryker bukan hanya sekedar pelapor. Dalam *CI/CD pipeline*, skor mutasi harus berfungsi sebagai gerbang (gatekeeper) yang tegas.
- **Konfigurasi**: Pada `stryker.conf.json`, Anda wajib menyetel nilai `thresholds`.
```json
"thresholds": {
  "high": 85,
  "low": 60,
  "break": 75
}
```
- **Trade-off**: Menyetel batas perpisahan (`break`) ke angka semisal 75% berarti jika lebih dari seperempat mutan berhasil *survived* (selamat), tugas otomatis CI akan GAGAL (exit code 1). Ini akan memaksa tim Anda untuk merawat *test* logika pinggiran (edge cases). Angka yang terlalu ekstrem (misal 95%) justru akan menahan siklus pengiriman perangkat lunak (deployment blocker) akibat positif palsu kecil.

### 2. Analisis Mutant Survival & Pengelompokan Logika
Ketika Stryker selesai, mutan yang tersisa (*survived*) akan mendeskripsikan secara presisi di titik mana tes Anda sangat lemah.
Ada dua jenis mutan yang sering selamat:
- **Logical Bounds**: Merubah `i < 10` menjadi `i <= 10`. Jika mutan ini selamat, artinya Anda belum melakukan uji batas bawah yang tepat (tepat pada angka 9, 10, dan 11).
- **String Manipulations**: Merubah pesan *Error Message* yang di-*throw* (*misalnya* `"Not Found"` menjadi `""`). Jika tidak kritis terhadap bisnis, Anda bisa mendisable uji string ini via fitur konfigurasi pengabaian Stryker (`mutator: { stringLiteral: false }`).

### 3. Incremental Mutation Testing (Optimasi Performa)
Mengoperasikan Stryker pada basis kode skala raksasa dengan >1000 file TypeScript bisa memakan waktu hingga 3-4 jam.
✅ **Praktik Terbaik**: Gunakan mode Inkremental.
- Setel `"incremental": true` pada konfigurasi Stryker Anda. Ini akan meminta Stryker membuat fail tembolok (`.stryker-tmp/incremental.json`). 
- Pada setiap jalannya sesi pengujian, Stryker hanya akan memutasi berkas kode yang terdeteksi ada perubahan modifikasi (berdasarkan git/diff tracker), dan menyajikan laporan hibrida cepat!

### 4. Integrasi Bersama Ambang Batas Code Coverage Standar
Apakah Stryker akan menggantikan Jest Coverage murni (Istanbul/V8)? **TIDAK.**
- Keduanya beroperasi secara berpasangan (*tandem*). Jest Coverage memastikan 100% baris kode dieksekusi selama tes berlangsung.
- Stryker memastikan 100% baris kode yang tereksekusi tersebut DIUJI SECARA SERIUS (bukan sekedar dilalui oleh rutinitas *runtime* tanpa ada `expect()` yang mengawalnya).
- ❌ **Anti-Pattern**: Menonaktifkan Jest Coverage karena sudah ada Stryker.
- ✅ **Praktik Terbaik**: Pertahankan Jest Coverage threshold minimal 90%, dan sandingkan bersama Stryker Mutation threshold minimal 70% sebagai gerbang CI/CD ganda (Double Quality Gates).

### 5. Analisis Biaya-Manfaat (Cost-Benefit) Mutation Testing
- **Keuntungan (Benefit)**: Deteksi instan terhadap "Mocking Hell". Seringkali *mock* untuk modul *database* (seperti `jest.spyOn(repo, 'find').mockResolvedValue([])`) ditulis sedemikian fatalnya sehingga tidak peduli apapun input pencariannya, selalu meloloskan kueri uji. Stryker dengan tajam akan mengungkap "kepalsuan" pengujian semacam ini.
- **Biaya (Cost)**: Kenaikan eksponensial dalam waktu eksekusi CI (dari 2 menit ke 20 menit) dan tingginya biaya komputasi *cloud runner*.
- **Kesimpulan Bisnis**: Sangat direkomendasikan untuk modul fungsional finansial, transaksi, penghitungan diskon, dan kewenangan hak akses (*Authorization Guards*). Kurang relevan untuk diaktifkan di area modul UI murni, dekorator Swagger, atau *boilerplate boilerplate controller* statis murni, gunakan pengecualian `mutate: ["!src/**/*.dto.ts"]`.
