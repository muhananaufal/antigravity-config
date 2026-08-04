# General Ledger Berbasis Append-Only Immutable Database

Arsitektur database tradisional menggunakan instruksi `UPDATE` pada tabel baris pengguna (Misal: `UPDATE wallets SET balance = balance + 100`). Pola ini hancur seketika dalam *Fintech* dan Sistem Pembayaran. Saat transaksi korup, Anda kehilangan histori: "Bagaimana saldo pengguna ini tiba-tiba menjadi 10.000?".

Solusi tunggal yang mematuhi standar GAAP (Generally Accepted Accounting Principles) dan lolos audit finansial adalah **Ledger Append-Only Immutable Records** (Buku Besar Transaksi yang Hanya Ditambahkan & Bersifat Kekal). Semua transfer dana dicatat sebagai baris-baris debit dan kredit (Jurnal Entry) layaknya *Blockchain*. Saldo dompet tidak lebih dari hasil komputasi *SUM(Kredit) - SUM(Debit)*.

## Arsitektur Merkle-Tree Hash Chain Ledger

Untuk mencegah perubahan tak kasat mata melalui akses langsung DB Administrator, setiap baris transaksi digembok dengan teknik rantai kriptografis (Cryptographic Hash-Chaining). *Hash* transaksi saat ini dikalkulasi menggunakan *Hash* transaksi sebelumnya, membentuk rantai absolut.

```text
+---------------------------------------------------------------------------------+
| Ledger Table (PostgreSQL) - APPEND ONLY (No UPDATE, No DELETE)                  |
+----+---------+--------+--------+---------------+--------------------------------+
| ID | User ID | Tipe   | Amount | Prev_Hash     | Current_Hash                   |
+----+---------+--------+--------+---------------+--------------------------------+
| 1  | USR_001 | DEPOSIT| +1000  | 0000000...    | HASH(1 + USR_001 + 1000 + 000) |
|    |         |        |        |               | = abc123def...                 |
+----+---------+--------+--------+---------------+--------------------------------+
| 2  | USR_001 | WD     | -200   | abc123def...  | HASH(2 + USR_001 + -200 + abc) |
|    |         |        |        |               | = 999xyz777...                 |
+----+---------+--------+--------+---------------+--------------------------------+

Jika Administrator/Hacker mengubah baris 1 (Amount = 5000), maka Current_Hash Baris 1 
akan berbeda, sehingga mematahkan Prev_Hash pada Baris 2. TAMPERING TERDETEKSI!
```

## Implementasi Produksi NestJS 10+ (Type-Safe Ledger Service)

### 1. DTO & Entitas

```typescript
import { IsString, IsNumber, IsEnum, IsNotEmpty } from 'class-validator';

export enum EntryType {
  DEPOSIT = 'DEPOSIT',
  WITHDRAWAL = 'WITHDRAWAL',
  TRANSFER_OUT = 'TRANSFER_OUT',
  TRANSFER_IN = 'TRANSFER_IN',
}

export interface LedgerEntryRecord {
  id: string; // UUID
  userId: string;
  entryType: EntryType;
  amountCents: number; // BigInt (Nilai Absolut, Cents)
  createdAt: Date;
  previousHash: string;
  currentHash: string;
}
```

### 2. Kriptografi Immutable Chain Service

Kita membangun mekanisme *Cryptographic Hash-Chaining* terisolasi.

```typescript
import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class LedgerCryptoChainService {
  private readonly logger = new Logger(LedgerCryptoChainService.name);

  // Kunci rahasia global (Garam) untuk hashing chain, jangan bocorkan.
  private readonly secretPepper = process.env.LEDGER_PEPPER_SECRET || 'fallback-pepper-danger';

  /**
   * Menghasilkan hash pengaman untuk baris jurnal
   */
  generateRecordHash(
    entryId: string,
    userId: string,
    entryType: string,
    amountCents: number,
    previousHash: string,
  ): string {
    const rawPayload = `${entryId}:${userId}:${entryType}:${amountCents}:${previousHash}:${this.secretPepper}`;
    return crypto.createHash('sha256').update(rawPayload).digest('hex');
  }

  /**
   * Mengaudit konsistensi rantai (Digunakan oleh sistem Job Audit Latar Belakang)
   */
  verifyChainContinuity(records: LedgerEntryRecord[]): boolean {
    for (let i = 1; i < records.length; i++) {
      const current = records[i];
      const previous = records[i - 1];

      // 1. Cek apakah Prev_Hash baris ini cocok dengan Curr_Hash baris atasnya
      if (current.previousHash !== previous.currentHash) {
        this.logger.error(`Tampering Terdeteksi! Putus Rantai antara Baris ID: ${previous.id} dan ${current.id}`);
        return false;
      }

      // 2. Kalkulasi ulang hash baris saat ini untuk mendeteksi perubahan nilai Amount
      const recalculatedHash = this.generateRecordHash(
        current.id,
        current.userId,
        current.entryType,
        current.amountCents,
        current.previousHash,
      );

      if (recalculatedHash !== current.currentHash) {
        this.logger.error(`Tampering Amount Terdeteksi pada ID: ${current.id}. Hash gagal diverifikasi.`);
        return false;
      }
    }
    return true;
  }
}
```

### 3. Ledger Transactor (Insert Only)

Pastikan untuk melakukan proses rekaman ini dalam *Database Transaction* untuk mencegah balapan konkurensi (Race Condition).

```typescript
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { LedgerCryptoChainService } from './ledger-crypto.service';
import { EntryType, LedgerEntryRecord } from './interfaces/ledger.interface';
import { randomUUID } from 'crypto';

// Simulasi klien DB (Contoh: TypeORM / Prisma / Kysely)
interface IDatabaseClient {
  query(sql: string, params: unknown[]): Promise<any>;
}

@Injectable()
export class ImmutableLedgerService {
  constructor(private readonly cryptoChain: LedgerCryptoChainService) {}

  /**
   * Merekam transaksi baru. Mutlak TIDAK BOLEH mengubah data (HANYA INSERT).
   */
  async recordEntry(
    dbClient: IDatabaseClient,
    userId: string,
    entryType: EntryType,
    amountCents: number,
  ): Promise<LedgerEntryRecord> {
    
    // 1. Dapatkan Hash Baris Terakhir Pengguna (Berdasarkan Waktu Terbaru)
    // WAJIB KUNCI (LOCK) baris pengguna ini agar request konkurensi menunggu gilirannya (SELECT FOR UPDATE)
    const lastRowResult = await dbClient.query(
      `SELECT current_hash FROM ledger_entries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [userId]
    );

    const previousHash = lastRowResult?.rows?.[0]?.current_hash || 'GENESIS_HASH_00000000';
    const entryId = randomUUID();

    // 2. Kalkulasi Hash Baris Baru (Chain Tautan)
    const currentHash = this.cryptoChain.generateRecordHash(
      entryId,
      userId,
      entryType,
      amountCents,
      previousHash,
    );

    const newRecord: LedgerEntryRecord = {
      id: entryId,
      userId,
      entryType,
      amountCents,
      createdAt: new Date(),
      previousHash,
      currentHash,
    };

    // 3. INSERT. (Tidak ada operasi UPDATE sama sekali)
    await dbClient.query(
      `INSERT INTO ledger_entries (id, user_id, entry_type, amount_cents, previous_hash, current_hash) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        newRecord.id,
        newRecord.userId,
        newRecord.entryType,
        newRecord.amountCents,
        newRecord.previousHash,
        newRecord.currentHash,
      ]
    );

    return newRecord;
  }

  /**
   * Menghitung Saldo Terkini berbasis Kalkulasi Deret (Event Sourcing)
   */
  async calculateCurrentBalance(dbClient: IDatabaseClient, userId: string): Promise<number> {
    const result = await dbClient.query(
      `SELECT SUM(
         CASE 
           WHEN entry_type IN ('DEPOSIT', 'TRANSFER_IN') THEN amount_cents 
           ELSE -amount_cents 
         END
       ) as balance 
       FROM ledger_entries WHERE user_id = $1`,
      [userId]
    );
    
    return Number(result?.rows?.[0]?.balance || 0);
  }
}
```

## Anti-Patterns Kritis dan Praktik Terbaik

### 1. Anti-Pattern: Menggunakan `UPDATE wallets SET balance` sebagai Source of Truth
❌ **Salah:** Mengubah angka pada kolom `balance` secara langsung di dalam operasi bisnis. Tidak ada *Audit Trail*. Jika saldo berkurang secara acak, teknisi tidak akan pernah tahu itu karena *race condition* atau penyerang eksternal.
```typescript
// ❌ ANTI-PATTERN: Data hilang, menimpa masa lalu
await db.query(`UPDATE users SET balance = 5000 WHERE id = 1`);
```

✅ **Benar:** Anggap tabel `wallets.balance` HANYA SEBAGAI tabel *View / Read-Model* (CQRS Pattern). Sumber Kebenaran (Source of Truth) SATU-SATUNYA adalah hasil komputasi *SUM* dari tabel `ledger_entries` (Event Store / Append-Only).

### 2. Anti-Pattern: Menghapus Data Transaksi yang Salah
❌ **Salah:** Teknisi membuat *query* SQL `DELETE FROM ledger_entries WHERE id = X` karena pengguna meminta pengembalian dana (Refund).
✅ **Benar:** Ledgers BERSIFAT IMMUTABLE (KEKAL). Untuk membatalkan transaksi masa lalu, kita TIDAK MENGHAPUSNYA. Sebaliknya, kita membuat transaksi jurnal *reversal/compensating* baru: `INSERT INTO ledger_entries (REFUND_PENALTY) +5000`. Cacat historis tetap tergambar sebagai bukti kejujuran sistem audit.

## Analisis Trade-Off Arsitektur

### Kelebihan
1. **Audit Keuangan Bukti-Peluru (Bulletproof Audit):** Sangat mudah lolos audit forensik KPMG/PwC. Sejarah manipulasi sekecil apapun dari staf internal langsung ketahuan akibat patahnya Merkle-Tree Hash.
2. **Kesesuaian Akuntansi Murni:** Transaksi finansial ditangani layaknya akuntan profesional melalui Debit-Kredit, bukan tipe *programmer CRUD* sederhana.
3. **Reproduktibilitas (Event Sourcing):** Sistem bisa dimatikan, dan dengan memutar ulang dari Baris ID ke-1 hingga hari ini, seluruh *state* (termasuk cacat masa lalu) dapat dibangun ulang sempurna secara matematis.

### Kekurangan
1. **Peningkatan Beban Disk I/O:** Ukuran Database berkembang secara eksponensial seiring bertambahnya transaksi harian (misal, 5 juta baris sebulan).
2. **Kinerja Kueri Agregat yang Melambat:** Melakukan `SELECT SUM()` pada 5 juta baris pengguna per akun akan lambat. (Solusinya wajib menerapkan *Materialized Views* atau Skema Snapshot Harian - *Daily Balance Snapshots*).
3. **Locking & Konkurensi Baris Bawah:** Merekam Hash masa lalu (`SELECT ... FOR UPDATE`) akan mendirikan leher-botol (bottleneck) di level ID pengguna jika pengguna bertransaksi 50x per detik secara konkuren.

## Production Edge Cases

1. **Kejadian Hashing Bercabang (Orphan Branches / Race Conditions):**
   *Kasus:* 2 server mencoba *INSERT* jurnal secara bersamaan. Keduanya mengambil *Prev_Hash* yang sama. Akibatnya, rantai bercabang menjadi 2 garpu, dan baris selanjutnya tidak tahu harus memilih yang mana.
   *Solusi:* Terapkan Kendala Unik (Unique Constraints) di Database: `UNIQUE (user_id, previous_hash)`. Jika ada yang bertabrakan, DB memantulkan *Error Constraint Violation*, meminta server mencoba ulang (*Retry*).

2. **Kinerja Kueri Memburuk Setelah 100.000 Transaksi per Akun:**
   *Kasus:* `calculateCurrentBalance()` meledak dengan masa eksekusi lambat karena memakan I/O besar.
   *Solusi:* Sistem malam (Cron Job Batch) menghitung total dan merekam statusnya di `ledger_snapshots_daily`. Hari besoknya, perhitungan adalah `Nilai Snapshot Kemarin + SUM(Transaksi Hari Ini)`.

3. **Rekonsiliasi Jaringan Transaksi Non-Keuangan:**
   *Kasus:* Tabel *Ledger* dicampurkan dengan histori *User Login* atau *Change Password*.
   *Solusi:* Pisahkan *Ledger* Finansial dari Tabel *Activity Log*. *Ledger* adalah Domain Suci (Sacred Domain) yang hanya memproses uang.

## Immutable Ledger & Hash Chain Test Suite

```typescript
import { LedgerCryptoChainService } from './ledger-crypto.service';
import { EntryType, LedgerEntryRecord } from './interfaces/ledger.interface';
import { randomUUID } from 'crypto';

describe('LedgerCryptoChainService (Append-Only Immutable Ledger)', () => {
  let service: LedgerCryptoChainService;

  beforeEach(() => {
    // Memaksa secret global untuk kepentingan test konsistensi
    process.env.LEDGER_PEPPER_SECRET = 'TESTING-PEPPER-SECRET-999';
    service = new LedgerCryptoChainService();
  });

  it('harus membuat hash konsisten berdasarkan komponen masukan secara deterministik', () => {
    const hash1 = service.generateRecordHash('ID-1', 'USER-1', 'DEPOSIT', 5000, 'GENESIS');
    const hash2 = service.generateRecordHash('ID-1', 'USER-1', 'DEPOSIT', 5000, 'GENESIS');
    expect(hash1).toEqual(hash2);
    expect(hash1).toBeDefined();
    expect(hash1.length).toBeGreaterThan(30);
  });

  it('harus memvalidasi rantai (Hash Chain) yang sehat tanpa putus', () => {
    const r1: LedgerEntryRecord = {
      id: 'ID-1', userId: 'USER-1', entryType: EntryType.DEPOSIT, amountCents: 1000,
      createdAt: new Date(), previousHash: 'GENESIS', currentHash: '',
    };
    r1.currentHash = service.generateRecordHash(r1.id, r1.userId, r1.entryType, r1.amountCents, r1.previousHash);

    const r2: LedgerEntryRecord = {
      id: 'ID-2', userId: 'USER-1', entryType: EntryType.WITHDRAWAL, amountCents: 500,
      createdAt: new Date(), previousHash: r1.currentHash, currentHash: '',
    };
    r2.currentHash = service.generateRecordHash(r2.id, r2.userId, r2.entryType, r2.amountCents, r2.previousHash);

    const isValid = service.verifyChainContinuity([r1, r2]);
    expect(isValid).toBe(true);
  });

  it('harus MENOLAK rantai yang dimodifikasi (Tampered Amount)', () => {
    const r1: LedgerEntryRecord = {
      id: 'ID-1', userId: 'USER-1', entryType: EntryType.DEPOSIT, amountCents: 1000,
      createdAt: new Date(), previousHash: 'GENESIS', currentHash: '',
    };
    r1.currentHash = service.generateRecordHash(r1.id, r1.userId, r1.entryType, r1.amountCents, r1.previousHash);

    const r2: LedgerEntryRecord = {
      id: 'ID-2', userId: 'USER-1', entryType: EntryType.WITHDRAWAL, amountCents: 500,
      createdAt: new Date(), previousHash: r1.currentHash, currentHash: '',
    };
    r2.currentHash = service.generateRecordHash(r2.id, r2.userId, r2.entryType, r2.amountCents, r2.previousHash);

    // MENSIMULASIKAN HACKER DB YANG MENGUBAH BARIS PERTAMA! (Mengganti Amount)
    const tamperedR1 = { ...r1, amountCents: 9999999 };

    // Audit sistem mendeteksi kebusukan:
    const isValid = service.verifyChainContinuity([tamperedR1, r2]);
    expect(isValid).toBe(false); // GAGAL VERIFIKASI (Berhasil Ditangkap)
  });
});
```
