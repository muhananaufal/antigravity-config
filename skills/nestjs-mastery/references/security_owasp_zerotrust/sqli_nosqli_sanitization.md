# Pencegahan SQL & NoSQL Injection & Input Sanitization di NestJS

## 1. Konsep Inti & Ringkasan

SQL Injection (SQLi) dan NoSQL Injection (NoSQLi) tetap menjadi kerentanan paling kritis (OWASP Top 10) dalam aplikasi web modern. Dalam arsitektur zero-trust, setiap batasan input (input boundary) wajib divalidasi, disanitasi, dan dipastikan tipe datanya sebelum menyentuh layer database.

```ascii
+-------------------+      +-------------------------+      +--------------------------+      +----------------+
|                   |      |                         |      |                          |      |                |
| Untrusted Payload +----->+ Validation/Sanitization +----->+ Type-Safe ORM/Query Bldr +----->+ Database (SQL/ |
| (HTTP/gRPC/Kafka) |      | (NestJS Pipes/Guards)   |      | (Prisma/TypeORM/Drizzle) |      | NoSQL Engine)  |
|                   |      |                         |      |                          |      |                |
+-------------------+      +-------------------------+      +--------------------------+      +----------------+
                                       ^                                ^                             ^
                                       |                                |                             |
                             Tolak Tipe Tidak Valid             Parameterized Queries           WAF & RLS Policies
```

## 2. Input Sanitization Pipeline (NestJS Pipes)

Untuk mencegah XSS, SSTI, dan vektor injeksi dasar, kita mengimplementasikan global sanitization pipe di NestJS menggunakan `DOMPurify` dan `validator`.

```typescript
import { PipeTransform, Injectable, ArgumentMetadata, BadRequestException } from '@nestjs/common';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import validator from 'validator';

const window = new JSDOM('').window;
const purify = DOMPurify(window);

@Injectable()
export class StrictSanitizationPipe implements PipeTransform {
  public transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (!value) {
      return value;
    }

    if (typeof value === 'string') {
      return this.sanitizeString(value);
    }

    if (typeof value === 'object') {
      return this.sanitizeObject(value);
    }

    return value;
  }

  private sanitizeString(val: string): string {
    // Mencegah XSS dan SSTI dengan membersihkan tag HTML
    const purified = purify.sanitize(val, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
    // Validasi tambahan untuk menolak pola SQL injection yang sangat kentara
    if (validator.matches(purified, /UNION\s+SELECT/i) || validator.matches(purified, /DROP\s+TABLE/i)) {
      throw new BadRequestException('Malicious payload detected');
    }
    return purified;
  }

  private sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
    const sanitizedObj: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      // Mencegah prototype pollution
      if (key === '__proto__' || key === 'constructor') {
        continue;
      }
      if (typeof val === 'string') {
        sanitizedObj[key] = this.sanitizeString(val);
      } else if (typeof val === 'object' && val !== null) {
        sanitizedObj[key] = this.sanitizeObject(val as Record<string, unknown>);
      } else {
        sanitizedObj[key] = val;
      }
    }
    return sanitizedObj;
  }
}
```

## 3. Pencegahan SQL Injection (TypeORM / Prisma / Drizzle)

Cara paling efektif untuk mencegah SQLi adalah menggunakan parameterized queries. Dilarang keras menggabungkan string secara manual untuk membangun kueri SQL.

### Anti-Pattern: Raw SQL Concatenation ❌

```typescript
// BERBAHAYA: Rentan terhadap SQL Injection
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class VulnerableUserService {
  public constructor(private readonly dataSource: DataSource) {}

  public async getUserByEmail(email: string): Promise<unknown> {
    // Jika email bernilai "' OR 1=1 --", otentikasi dapat di-bypass
    return this.dataSource.query(`SELECT * FROM users WHERE email = '${email}'`);
  }
}
```

### Best Practice: Parameterized Query Builder ✅

```typescript
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from './user.entity';

@Injectable()
export class SecureUserService {
  public constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  public async getUserByEmail(email: string): Promise<UserEntity | null> {
    return this.userRepository
      .createQueryBuilder('user')
      .where('user.email = :email', { email }) // Aman: Ter-parameterisasi secara otomatis
      .getOne();
  }
}
```

## 4. Pencegahan NoSQL Injection (MongoDB)

MongoDB rentan terhadap NoSQL injection, khususnya Operator Injection (`$gt`, `$ne`) dan eksekusi JavaScript berbahaya melalui `$where`.

### Anti-Pattern: Menerima Objek Mentah dalam Kueri ❌

```typescript
// BERBAHAYA: Rentan terhadap Operator Injection
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UserDocument } from './user.schema';

@Injectable()
export class VulnerableMongoService {
  public constructor(@InjectModel('User') private readonly userModel: Model<UserDocument>) {}

  public async findUsers(queryParam: unknown): Promise<UserDocument[]> {
    // Jika queryParam adalah { "$ne": null }, kueri ini akan mengembalikan semua user
    return this.userModel.find({ username: queryParam }).exec();
  }
}
```

### Best Practice: Strict Typing dan Input Validation ✅

```typescript
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UserDocument } from './user.schema';

@Injectable()
export class SecureMongoService {
  public constructor(@InjectModel('User') private readonly userModel: Model<UserDocument>) {}

  public async findUserByUsername(username: string): Promise<UserDocument | null> {
    // Memastikan input harus persis bertipe string, bukan objek yang mengandung operator NoSQL
    if (typeof username !== 'string') {
        throw new Error('Invalid input type');
    }
    return this.userModel.findOne({ username: { $eq: username } }).exec();
  }
}
```

## 5. Second-Order SQL Injection

Second-order SQLi terjadi ketika input pengguna aman saat dimasukkan (parameterized) ke database, tetapi di kemudian hari diambil kembali dan digabungkan secara tidak aman ke dalam kueri baru. 
Pencegahan: Pastikan SEMUA kueri, termasuk kueri yang menggunakan data hasil baca dari database itu sendiri, tetap menggunakan statement yang parameterized. Perlakukan database sebagai sumber yang tidak terpercaya saat membuat kueri dinamis.

## 6. Deteksi Blind SQL Injection & Integrasi WAF

Blind SQLi bergantung pada respons aplikasi untuk menyimpulkan data (misalnya delay waktu atau perbedaan hasil boolean).
1.  **Time-Based:** Penyerang menggunakan fungsi seperti `pg_sleep()` atau `WAITFOR DELAY`.
2.  **Boolean-Based:** Penyerang mengubah kueri untuk memanipulasi hasil logika boolean.

**Pertahanan (Defense):**
- Gunakan batasan waktu eksekusi kueri yang ketat di level database (contoh: `statement_timeout` di PostgreSQL).
- Integrasikan Web Application Firewall (WAF) seperti Cloudflare atau AWS WAF untuk mendeteksi dan memblokir payload berbahaya atau tingkat error abnormal dari IP tunggal.

## 7. Trade-Off: Stored Procedures vs ORM Query Builder

### Stored Procedures
**Kelebihan:**
1. Rencana eksekusi (execution plan) sudah terkompilasi sehingga performa tinggi untuk logika kompleks.
2. Mengabstraksikan struktur database murni dari layer aplikasi.
3. Dapat memaksakan batas akses izin (permission boundaries) secara ketat di DB (hak akses execute-only).

**Kekurangan:**
1. Sulit untuk di-version control dan diuji (unit testing) dibandingkan dengan kode aplikasi.
2. Business logic bocor ke layer database, menyebabkan fragmentasi arsitektur.
3. Mengalami vendor lock-in yang tinggi pada engine database spesifik.

### ORM Query Builder
**Kelebihan:**
1. Agnostik terhadap database dan terjamin keamanan tipenya (type-safe) melalui ekosistem TypeScript.
2. Kode berada di bawah version control, mudah dipelihara dan di-unit test.
3. Mengurangi beban context switching bagi developer full-stack.

**Kekurangan:**
1. Potensi bahaya masalah kueri N+1 jika tidak menggunakan relasi atau dataloader secara hati-hati.
2. Kueri kompleks terkadang di-generate menjadi SQL yang tidak efisien.
3. Kehilangan optimalisasi execution plan default yang dimiliki oleh stored procedure.

## 8. Kasus Khusus Produksi (Production Edge Cases)

1. **Ekstraksi Kolom JSONB:** Ketika melakukan query pada kolom JSONB, memasukkan nama key dinamis dari input pengguna bisa me-bypass parameterization. Pastikan key tervalidasi secara ketat dengan allowlist.
2. **Klausa Order By & Group By:** Kita tidak dapat melakukan parameterisasi nama kolom di dalam klausa `ORDER BY`. Jika sisi klien mengirimkan nama kolom untuk pengurutan data, input tersebut WAJIB divalidasi terhadap allowlist ketat (misalnya enum).
3. **Array Binding di IN Clause:** Ketika menggunakan `IN (:...ids)`, pastikan array `ids` TIDAK BOLEH kosong (empty) untuk menghindari error syntax DB, dan validasi bahwa setiap elemen merupakan tipe data primitif yang benar (contoh: angka atau UUID string) sebelum dimasukkan ke ORM.

## 9. Unit Test Suite

```typescript
import { StrictSanitizationPipe } from './sanitization.pipe';
import { BadRequestException } from '@nestjs/common';

describe('StrictSanitizationPipe', () => {
  let pipe: StrictSanitizationPipe;

  beforeEach(() => {
    pipe = new StrictSanitizationPipe();
  });

  it('seharusnya menghapus tag HTML untuk mencegah XSS', () => {
    const input = '<script>alert("xss")</script>Hello';
    const result = pipe.transform(input, { type: 'body' });
    expect(result).toBe('Hello');
  });

  it('seharusnya melempar BadRequestException jika mendeteksi pola SQLi', () => {
    const input = 'UNION SELECT * FROM users';
    expect(() => pipe.transform(input, { type: 'body' })).toThrow(BadRequestException);
  });

  it('seharusnya melakukan sanitasi rekursif pada objek bertingkat', () => {
    const input = { data: { text: '<img src=x onerror=alert(1)>' } };
    const result = pipe.transform(input, { type: 'body' });
    expect((result as Record<string, Record<string, string>>).data.text).toBe('');
  });
  
  it('tidak seharusnya mengganggu string valid yang aman', () => {
      const input = 'John Doe';
      const result = pipe.transform(input, { type: 'body' });
      expect(result).toBe('John Doe');
  });
});
```
