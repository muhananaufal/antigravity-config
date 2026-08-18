# BigInt, Zero-Trust Currency Accounting, & Decimal Safety

Kesalahan paling mematikan dalam pembuatan sistem *fintech* dengan JavaScript/TypeScript (termasuk NestJS) adalah menggunakan tipe data `Number` standar untuk mempresentasikan uang. Tipe bawaan JS menggunakan standar *IEEE 754 Double Precision Floating-Point*, yang dapat dan pasti akan menghasilkan masalah pembulatan (*Rounding Errors*) secara matematis (Misal: `0.1 + 0.2 === 0.30000000000000004`).

Standar Top 1% Engineering mewajibkan representasi mata uang dalam bentuk **Integer Murni** (satuan terkecil, seperti *Cents* untuk USD atau Rupiah penuh tanpa desimal) yang disimpan secara absolut, dan direpresentasikan di dalam RAM aplikasi menggunakan kelas presisi tinggi seperti `BigInt`, `Dinero.js`, atau `Decimal.js`.

## Arsitektur Zero-Trust Currency Pipeline

```text
+---------------------+           +------------------------+           +-------------------+
|     Client / API    | --------> |    NestJS Controller   | --------> | Database (PG/SQL) |
|                     |   String  |                        |  Integer  |                   |
| { "amount": "9.99"} | --------> | Parse ke BigInt(999)   | --------> | balance: 999      |
|    (Representasi    |           | (Atau Dinero/Decimal)  | (Cents)   | (Tipe: BIGINT)    |
|       String)       |           | Validasi: No Decimals! |           |                   |
+---------------------+           +------------------------+           +-------------------+
                                             |  ^
                                             |  |
                                             v  |
                                  +------------------------+
                                  |    Layanan Finansial   |
                                  | Penambahan / Potongan  |
                                  | BigInt(999) - BigInt(5)|
                                  +------------------------+
```

## Implementasi Produksi NestJS 10+ (Type-Safe & Dinero.js)

Pendekatan modern adalah membungkus jumlah (amount) ke dalam objek Nilai Uang (Value Object) yang memiliki informasi mata uang dan mencegah penambahan dua mata uang berbeda.

### 1. DTO dengan Validasi String Ketat

Data dari klien TIDAK BOLEH dikirim sebagai tipe Number (karena akan kehilangan presisi di level JSON parser Node.js). Klien harus mengirim uang dalam format String.

```typescript
import { IsString, Matches, IsNotEmpty } from 'class-validator';

export class TopUpRequestDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'Amount harus berupa string numerik desimal valid. Maksimum 2 desimal (contoh: "15.99" atau "100")',
  })
  readonly amount: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'Currency wajib ISO-4217 (contoh: IDR, USD)' })
  readonly currency: string;
}
```

### 2. Money Value Object dengan Dinero.js (atau Decimal.js)

```typescript
import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import * as Dinero from 'dinero.js';

// Mengatur konfigurasi default secara global
Dinero.globalLocale = 'id-ID';

export class MoneyWrapper {
  private constructor(private readonly dineroInstance: Dinero.Dinero) {}

  /**
   * Membuat objek Money dari format String yang aman (Misal "15.99" -> 1599 sen)
   */
  static fromStringFormat(amountString: string, currency: string = 'USD'): MoneyWrapper {
    if (isNaN(Number(amountString))) {
      throw new BadRequestException('Format uang tidak valid');
    }

    // Parsing string ke cents (mengasumsikan semua mata uang berbasis 2 desimal - perlu adaptasi untuk JPY dll)
    const floatValue = parseFloat(amountString);
    // Konversi dengan Math.round untuk keamanan parsing string ke integer cent
    const amountInCents = Math.round(floatValue * 100);

    return new MoneyWrapper(
      Dinero({ amount: amountInCents, currency: currency as Dinero.Currency })
    );
  }

  /**
   * Membuat langsung dari Integer Sen (Sangat dianjurkan saat menarik data dari DB)
   */
  static fromCents(cents: number, currency: string = 'USD'): MoneyWrapper {
    if (!Number.isInteger(cents)) {
      throw new Error('Nilai internal wajib menggunakan integer murni');
    }
    return new MoneyWrapper(Dinero({ amount: cents, currency: currency as Dinero.Currency }));
  }

  /**
   * Aman menambahkan dua saldo
   */
  add(other: MoneyWrapper): MoneyWrapper {
    return new MoneyWrapper(this.dineroInstance.add(other.dineroInstance));
  }

  /**
   * Aman mengurangi saldo, memicu error logika jika defisit
   */
  subtract(other: MoneyWrapper): MoneyWrapper {
    const result = this.dineroInstance.subtract(other.dineroInstance);
    // Contoh validasi bisnis pencegahan saldo minus
    if (result.getAmount() < 0) {
      throw new BadRequestException('Insufficient Funds: Saldo tidak boleh negatif.');
    }
    return new MoneyWrapper(result);
  }

  // Mengeluarkan output mentah dalam sen (untuk disimpan di DB PostgreSQL tipe BIGINT/INT)
  toCents(): number {
    return this.dineroInstance.getAmount();
  }

  getCurrency(): string {
    return this.dineroInstance.getCurrency();
  }
}
```

### 3. Integrasi Service

```typescript
@Injectable()
export class AccountLedgerService {
  private readonly logger = new Logger(AccountLedgerService.name);

  // Simulasi repositori
  async processTopUp(accountId: string, amountStr: string, currency: string): Promise<number> {
    const incomingMoney = MoneyWrapper.fromStringFormat(amountStr, currency);
    
    this.logger.log(`Memproses Top-Up dalam Cent: ${incomingMoney.toCents()} (${incomingMoney.getCurrency()})`);

    // Tarik nilai cent integer dari DB
    const currentBalanceCentsFromDB = 10000; // Contoh: $100.00
    const currentBalanceMoney = MoneyWrapper.fromCents(currentBalanceCentsFromDB, 'USD');

    // Mencegah pencampuran USD dan IDR (Dinero akan otomatis memicu error)
    try {
      const newBalanceMoney = currentBalanceMoney.add(incomingMoney);
      
      // Simpan newBalanceMoney.toCents() ke Database PostgreSQL
      const centsToSaveToDb = newBalanceMoney.toCents();
      
      return centsToSaveToDb;
    } catch (e: unknown) {
      if (e instanceof Error) {
        this.logger.error(`Operasi moneter gagal: ${e.message}`);
      }
      throw new BadRequestException('Operasi mata uang dilarang/tidak valid');
    }
  }
}
```

## Anti-Patterns Kritis dan Praktik Terbaik

### 1. Anti-Pattern: Menggunakan `Number` dan Tipe Data DB `FLOAT`
❌ **Salah:** Menggunakan `number` bawaan JS dan menyimpannya di DB sebagai `FLOAT` atau `DOUBLE`.
```typescript
// ❌ ANTI-PATTERN: Presisi Miring
let balance = 0.1;
let topup = 0.2;
let finalBalance = balance + topup; // Output: 0.30000000000000004
await db.query(`UPDATE wallets SET balance = ${finalBalance}`); // Korupsi Data!
```

✅ **Benar:** Representasikan di JS sebagai BigInt/Dinero dan simpan di PostgreSQL sebagai kolom tipe `BIGINT` atau `NUMERIC(19,4)` dalam bentuk bilangan bulat.

### 2. Anti-Pattern: Tidak Memvalidasi Mata Uang Campuran (Currency Mixup)
❌ **Salah:** Menambahkan saldo tanpa mengecek asal mata uangnya. USD 10 ditambahkan dengan IDR 15.000 menjadi total "15.010 uang gaib".
```typescript
// ❌ ANTI-PATTERN
const usdAmount = 10;
const idrAmount = 15000;
const finalAmount = usdAmount + idrAmount; // Bencana Akuntansi!
```

✅ **Benar:** Objek enkapsulasi mata uang (seperti `Dinero.js`) secara otomatis memutus eksekusi dan memicu *Exception* jika dua mata uang dikalikan/ditambahkan tanpa fungsi konversi *Exchange Rate* (Forex) yang sah.

## Analisis Trade-Off Arsitektur

### Kelebihan
1. **Presisi Absolut:** Bebas 100% dari kesalahan pembulatan (*rounding error*).
2. **Standardisasi:** Penyimpanan di database menjadi jauh lebih sederhana (cukup tipe integer), indeks DB mencari integer jauh lebih cepat dibanding mencari teks (*string*).
3. **Safety by Design:** *Value object* (seperti `MoneyWrapper`) mencegah *programmer junior* di tim tanpa sengaja melakukan operasi matematis yang ilegal.

### Kekurangan
1. **Beban Parsing:** Memerlukan kebiasaan mental ekstra. Harus selalu melakukan transformasi ke atas (*string -> cents*) dan transformasi ke bawah saat disajikan ke layar pengguna.
2. **Keterbatasan JavaScript BigInt Asli:** Menggunakan fitur Native ES2020 `BigInt` (misal `100n`) tidak mendukung operasi desimal sama sekali, tidak bisa menggunakan `Math.floor/round`, dan serialisasi JSON-nya akan putus kecuali jika di-*polyfill*.
3. **Perhitungan Kompleks (Pajak, Bunga):** Jika persentase bunga menuntut fraksi dari satuan sen (misal $0.005), membulatkannya ke atas atau ke bawah secara tidak konsisten akan menimbulkan lubang neraca. (Maka butuh Bankeller's Rounding / Half-Even Rounding).

## Production Edge Cases

1. **JSON Payload `BigInt` Error:**
   *Kasus:* API mengembalikan `{ balance: 100n }`. Pustaka standard `JSON.stringify` akan *crash* melempar `TypeError: Do not know how to serialize a BigInt`.
   *Solusi:* Tangani serialisasi BigInt dengan teknik kustom, mengubahnya menjadi string sebelum ditransfer: `{ balance: "100" }`.

2. **Perbedaan Basis Desimal Antar Mata Uang:**
   *Kasus:* JPY (Yen Jepang) tidak memiliki *cents* (0 desimal). OMR (Oman Rial) menggunakan 3 desimal. Sistem *hardcode* 2 desimal akan memicu bug fatal.
   *Solusi:* Pustaka `Dinero.js` mendukung profil desimal per mata uang secara dinamis berdasarkan ISO-4217 standar ISO.

3. **Database Integer Overflow:**
   *Kasus:* Sistem hiperinflasi (seperti mata uang fiksional game atau mata uang dunia nyata tertentu) melampaui angka maksimum INT32 (`2.14` Miliar Sen = hanya ~$21 Juta USD).
   *Solusi:* Wajib, *wajib*, gunakan `BIGINT` (64-bit Integer) di skema PostgreSQL.

## Zero-Trust Currency Test Suite

```typescript
import { MoneyWrapper } from './money-wrapper';
import { BadRequestException } from '@nestjs/common';

describe('MoneyWrapper - Zero Trust Accounting', () => {
  it('harus memparsing string berformat desimal secara akurat ke Cents tanpa kehilangan presisi', () => {
    const m = MoneyWrapper.fromStringFormat('19.99', 'USD');
    expect(m.toCents()).toBe(1999);
  });

  it('harus menolak string yang tidak valid', () => {
    expect(() => MoneyWrapper.fromStringFormat('sepuluh', 'USD')).toThrow(BadRequestException);
  });

  it('harus berhasil menambahkan dua mata uang yang sama', () => {
    const a = MoneyWrapper.fromCents(1000, 'IDR'); // Rp 10.00
    const b = MoneyWrapper.fromCents(500, 'IDR'); // Rp 5.00
    const result = a.add(b);
    
    expect(result.toCents()).toBe(1500);
    expect(result.getCurrency()).toBe('IDR');
  });

  it('harus melempar error jika mencampurkan dua mata uang berbeda secara matematis', () => {
    const a = MoneyWrapper.fromCents(1000, 'USD');
    const b = MoneyWrapper.fromCents(1000, 'IDR');
    
    // Bergantung pada implementasi internal Dinero, ini melempar TypeError bawaan Dinero
    expect(() => a.add(b)).toThrow();
  });

  it('harus mencegah pengurangan uang yang menghasilkan saldo negatif', () => {
    const a = MoneyWrapper.fromCents(500, 'USD'); // $5.00
    const b = MoneyWrapper.fromCents(1000, 'USD'); // $10.00
    
    expect(() => a.subtract(b)).toThrow(BadRequestException);
  });
});
```
