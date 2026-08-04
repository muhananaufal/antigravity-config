# Protokol Two-Phase Commit (2PC) dan Arsitektur Saga Terdistribusi

Dalam arsitektur perbankan mikro (Microservices) yang menggunakan gRPC pada NestJS, mengelola konsistensi data finansial antar layanan yang terpisah adalah tantangan level-dewa (Top 1% Engineering). Transfer dana dari Layanan Dompet (Wallet Service) ke Layanan Poin (Loyalty Service) melintasi batasan basis data fisik yang berbeda. Kegagalan tanpa mekanisme penarikan kembali (*rollback*) akan menyebabkan hilangnya uang atau pencetakan uang gaib.

Dua pola utama untuk menyelesaikan masalah ini adalah **Two-Phase Commit (2PC)** (ketat, tersinkronisasi) dan **Saga Pattern** (berbasis koreografi/orkestrasi, eventual consistency). Pada dokumen ini, kita akan merancang Orkestrator Saga yang mensimulasikan pendekatan konsistensi kuat menggunakan gRPC.

## Arsitektur Orkestrasi Distributed Transactions

Berikut adalah diagram Orkestrator Saga yang memastikan transaksi bersifat ACID.

```text
+-----------------------+
|   API Gateway (HTTP)  |
+-----------------------+
           | 1. POST /transfer
           v
+-----------------------+       (3) gRPC: Reserve()         +-------------------------+
| Transaction Orchestr. | --------------------------------> | Wallet Service (Postgres) |
| (Saga Coordinator)    | <-------------------------------- | Lock Saldo (Pending)    |
| - State Machine       |            OK                     +-------------------------+
| - Postgres DB         |
|                       |       (4) gRPC: AddPoints()       +-------------------------+
|                       | --------------------------------> | Loyalty Service (MySQL) |
|                       | <-------------------------------- | + Points (Commit)       |
|                       |            ERROR                  +-------------------------+
|                       |
|                       |       (5) gRPC: ReleaseLock()     +-------------------------+
|                       | --------------------------------> | Wallet Service (Postgres) |
|                       | <-------------------------------- | Rollback Saldo ke Awal  |
+-----------------------+            ABORTED                +-------------------------+
```

## Implementasi Produksi NestJS 10+ (Type-Safe gRPC)

### 1. Definisi Protobuf untuk gRPC

```protobuf
syntax = "proto3";

package wallet;

service WalletService {
  rpc ReserveFunds (ReserveRequest) returns (ReserveResponse) {}
  rpc CommitFunds (CommitRequest) returns (CommitResponse) {}
  rpc RollbackFunds (RollbackRequest) returns (RollbackResponse) {}
}

message ReserveRequest {
  string transaction_id = 1;
  string user_id = 2;
  int64 amount_cents = 3;
}

message ReserveResponse {
  bool success = 1;
  string error_message = 2;
}

// ... pesan Commit/Rollback mengikuti pola serupa
```

### 2. Antarmuka Client gRPC yang Ketat (Strict Interfaces)

Hindari penggunaan tipe `any`. Definisikan *interfaces* yang berkorelasi tepat dengan *Protobuf*.

```typescript
import { Observable } from 'rxjs';

export interface ReserveRequest {
  transaction_id: string;
  user_id: string;
  amount_cents: number; // Dalam Sen (Cents)
}

export interface GrpcStandardResponse {
  success: boolean;
  error_message: string;
}

export interface WalletGrpcService {
  reserveFunds(data: ReserveRequest): Observable<GrpcStandardResponse>;
  commitFunds(data: { transaction_id: string }): Observable<GrpcStandardResponse>;
  rollbackFunds(data: { transaction_id: string }): Observable<GrpcStandardResponse>;
}
```

### 3. Layanan Orkestrator Saga (Saga Coordinator)

Kode di bawah ini mendemonstrasikan orkestrasi 2 Fase. Fase 1: Meminta kesiapan/pemesanan (Prepare). Fase 2: Eksekusi (Commit) atau Kompensasi (Rollback/Abort).

```typescript
import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { WalletGrpcService, GrpcStandardResponse } from './interfaces/wallet-grpc.interface';
import { LoyaltyGrpcService } from './interfaces/loyalty-grpc.interface';
import { firstValueFrom } from 'rxjs';

export interface TransferContext {
  transactionId: string;
  userId: string;
  amountCents: number;
}

@Injectable()
export class SagaOrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(SagaOrchestratorService.name);
  
  private walletService!: WalletGrpcService;
  private loyaltyService!: LoyaltyGrpcService;

  constructor(
    @Inject('WALLET_PACKAGE') private readonly walletClient: ClientGrpc,
    @Inject('LOYALTY_PACKAGE') private readonly loyaltyClient: ClientGrpc,
  ) {}

  onModuleInit(): void {
    this.walletService = this.walletClient.getService<WalletGrpcService>('WalletService');
    this.loyaltyService = this.loyaltyClient.getService<LoyaltyGrpcService>('LoyaltyService');
  }

  /**
   * Menjalankan transaksi terdistribusi secara ACID menggunakan pola Saga/2PC terdesentralisasi
   */
  async executeTransfer(context: TransferContext): Promise<{ success: boolean; message: string }> {
    this.logger.log(`Memulai transaksi Saga: ${context.transactionId}`);

    try {
      // FASE 1: PREPARE (Pesan Dana)
      const reserveResult = await firstValueFrom(
        this.walletService.reserveFunds({
          transaction_id: context.transactionId,
          user_id: context.userId,
          amount_cents: context.amountCents,
        }),
      );

      if (!reserveResult.success) {
        this.logger.warn(`Saga Dibatalkan. Reserve gagal: ${reserveResult.error_message}`);
        return { success: false, message: reserveResult.error_message };
      }

      // FASE 2: EXECUTE Layanan Eksternal (Tambah Poin)
      const loyaltyResult = await firstValueFrom(
        this.loyaltyService.addPoints({
          transaction_id: context.transactionId,
          user_id: context.userId,
          points: Math.floor(context.amountCents / 100), // 1 Poin per Dolar/Rupiah Utuh
        }),
      );

      // JIKA GAGAL -> KOMPENSASI (ROLLBACK)
      if (!loyaltyResult.success) {
        this.logger.error(`Loyalty gagal. Melakukan kompensasi (Rollback) dompet...`);
        await this.compensateWallet(context.transactionId);
        return { success: false, message: 'Transfer gagal pada sistem Poin, Saldo dikembalikan.' };
      }

      // FASE 3: COMMIT (Finalisasi)
      const commitResult = await firstValueFrom(
        this.walletService.commitFunds({ transaction_id: context.transactionId }),
      );

      if (!commitResult.success) {
        // FATAL ERROR: Transaksi menggantung. Butuh rekonsiliasi manual.
        this.logger.fatal(`CRITICAL: Commit Dompet gagal setelah Poin diberikan! TX_ID: ${context.transactionId}`);
        throw new Error('Inconsistent State Detected. Rekonsiliasi manual dibutuhkan.');
      }

      return { success: true, message: 'Transaksi Terdistribusi Berhasil' };

    } catch (error: unknown) {
      // Tangkap Error Jaringan gRPC (Timeout/Disconnect)
      this.logger.error(`Network Error pada Saga: ${(error as Error).message}`);
      await this.compensateWallet(context.transactionId);
      return { success: false, message: 'Sistem sedang sibuk. Transaksi dibatalkan secara aman.' };
    }
  }

  private async compensateWallet(transactionId: string): Promise<void> {
    try {
      const rollbackResult = await firstValueFrom(
        this.walletService.rollbackFunds({ transaction_id: transactionId }),
      );
      if (!rollbackResult.success) {
        this.logger.fatal(`CRITICAL: Rollback Dompet Gagal! TX_ID: ${transactionId}`);
      } else {
        this.logger.log(`Kompensasi Dompet Berhasil: ${transactionId}`);
      }
    } catch (e) {
      this.logger.fatal(`CRITICAL: gRPC Error saat Rollback! TX_ID: ${transactionId}`);
    }
  }
}
```

## Anti-Patterns Kritis dan Praktik Terbaik

### 1. Anti-Pattern: Menggunakan Transaksi Database Panjang (Long-Running DB Transactions)
❌ **Salah:** Membuka transaksi PostgreSQL (`BEGIN`), lalu memanggil layanan eksternal gRPC secara tersinkronisasi, dan kemudian `COMMIT`. Ini menyebabkan koneksi DB habis (Connection Pool Exhaustion) dan merusak *throughput*.
```typescript
// ❌ ANTI-PATTERN: Menahan lock DB saat memanggil layanan eksternal
await db.transaction(async (trx) => {
  await trx.query('UPDATE wallets SET balance = balance - 100'); // LOCK DIPEGANG
  await grpcClient.addPoints(); // JIKA INI TIMEOUT 10 DETIK, SELURUH TABEL WALLET TERKUNCI!
  await trx.query('COMMIT');
});
```

✅ **Benar:** Gunakan mekanisme status lokal (*Pending, Completed, Failed*). Perbarui status lokal menjadi *Pending*, lepaskan koneksi DB, panggil gRPC, lalu buat transaksi DB baru yang pendek untuk mengubah status menjadi *Completed*.

### 2. Anti-Pattern: Mengabaikan Dead-Letter Queue / Rekonsiliasi
❌ **Salah:** Menganggap bahwa tahap kompensasi (*Rollback*) selalu 100% berhasil. Jika layanan gRPC mati total, *rollback* juga akan gagal, meninggalkan sistem dalam inkonsistensi abadi.

✅ **Benar:** Tangkap kegagalan kompensasi, lalu catat ID Transaksi ke tabel `dead_letters_saga`. Buat Cron Job di latar belakang yang terus mencoba melakukan rekonsiliasi hingga sukses.

## Analisis Trade-Off Arsitektur

### Kelebihan
1. **Ketahanan Terhadap Kegagalan Parsial:** Mencegah terjadinya inkonsistensi yang tidak terdeteksi ketika salah satu layanan mikro mati.
2. **Keterpisahan Domain (Decoupling):** Orkestrator memegang logika bisnis saga, sehingga layanan Dompet dan Poin tidak perlu saling mengetahui, meningkatkan modularitas.
3. **Kinerja gRPC:** gRPC dengan *Protobuf* menggunakan format binari yang jauh lebih cepat dan ringan dibandingkan HTTP/REST JSON, memangkas *latency* komputasi di jaringan.

### Kekurangan
1. **Kompleksitas Logika Kompensasi:** Mengimplementasikan *Rollback* secara deterministik seringkali jauh lebih sulit daripada implementasi *Execute*.
2. **Eventual Consistency Latency:** Tidak ada "isolasi ketat" secara seketika; saldo mungkin terlihat "hilang" (karena sedang dipesan) selama beberapa milidetik bagi sistem pelaporan baca.
3. **Bahaya Split-Brain:** Di bawah tekanan jaringan yang kacau, Orkestrator mungkin mengira fase *Commit* gagal (karena batas waktu/timeout), padahal layanan tujuan berhasil menerimanya.

## Production Edge Cases

1. **Jaringan Timeout di Tengah Transaksi:**
   *Kasus:* Orkestrator memanggil `addPoints()`, layanan Poin berhasil menambah poin, namun respons balasan mengalami batas waktu karena jaringan putus. Orkestrator mengira itu gagal lalu melakukan `Rollback` Dompet. Akibatnya pengguna mendapat Poin gratis, dan uangnya dikembalikan.
   *Solusi:* Wajib pasang *Idempotency Keys* yang sama pada setiap panggillan gRPC, dan layanan hilir harus mengembalikan *status* yang sebenarnya jika ID tersebut sudah pernah di-*commit*.

2. **Layanan Kompensasi Down Permanen:**
   *Kasus:* Perintah *Rollback* gagal terus menerus walau sudah dicoba (retry) 5 kali.
   *Solusi:* Sistem harus memasukkan transaksi tersebut ke "Admin Manual Review Queue" melalui notifikasi *Slack/Email* kepada *Engineering On-Call*.

3. **Orkestrator Saga Mati Mendadak (Crash):**
   *Kasus:* Proses Node.js *Out-Of-Memory* dan mati tepat di antara Fase 2 dan Fase 3.
   *Solusi:* Orkestrator harus menyimpan *State Machine* per fase ke DB sebelum lanjut ke langkah berikutnya (Event Sourcing). Saat Orkestrator hidup kembali, ia akan membaca "transaksi terputus" dan melanjutkannya.

## Distributed Saga Orchestrator Test Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { SagaOrchestratorService } from './saga-orchestrator.service';
import { of, throwError } from 'rxjs';
import { ClientGrpc } from '@nestjs/microservices';

describe('SagaOrchestratorService - 2PC', () => {
  let service: SagaOrchestratorService;
  
  const mockWalletService = {
    reserveFunds: jest.fn(),
    commitFunds: jest.fn(),
    rollbackFunds: jest.fn(),
  };

  const mockLoyaltyService = {
    addPoints: jest.fn(),
  };

  const mockWalletClient = {
    getService: jest.fn().mockReturnValue(mockWalletService),
  };

  const mockLoyaltyClient = {
    getService: jest.fn().mockReturnValue(mockLoyaltyService),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SagaOrchestratorService,
        { provide: 'WALLET_PACKAGE', useValue: mockWalletClient },
        { provide: 'LOYALTY_PACKAGE', useValue: mockLoyaltyClient },
      ],
    }).compile();

    service = module.get<SagaOrchestratorService>(SagaOrchestratorService);
    service.onModuleInit();
    
    jest.clearAllMocks();
  });

  it('harus menyelesaikan seluruh transaksi jika semua sistem sukses', async () => {
    mockWalletService.reserveFunds.mockReturnValue(of({ success: true }));
    mockLoyaltyService.addPoints.mockReturnValue(of({ success: true }));
    mockWalletService.commitFunds.mockReturnValue(of({ success: true }));

    const result = await service.executeTransfer({
      transactionId: 'TX-999',
      userId: 'USER-1',
      amountCents: 10000,
    });

    expect(result.success).toBe(true);
    expect(mockWalletService.reserveFunds).toHaveBeenCalled();
    expect(mockLoyaltyService.addPoints).toHaveBeenCalled();
    expect(mockWalletService.commitFunds).toHaveBeenCalled();
    expect(mockWalletService.rollbackFunds).not.toHaveBeenCalled();
  });

  it('harus melakukan rollback dompet jika layanan poin gagal', async () => {
    mockWalletService.reserveFunds.mockReturnValue(of({ success: true }));
    // Poin gagal secara logika bisnis
    mockLoyaltyService.addPoints.mockReturnValue(of({ success: false, error_message: 'Loyalty Offline' }));
    mockWalletService.rollbackFunds.mockReturnValue(of({ success: true }));

    const result = await service.executeTransfer({
      transactionId: 'TX-888',
      userId: 'USER-2',
      amountCents: 5000,
    });

    expect(result.success).toBe(false);
    expect(mockWalletService.reserveFunds).toHaveBeenCalled();
    expect(mockLoyaltyService.addPoints).toHaveBeenCalled();
    // COMMIT tidak boleh dipanggil
    expect(mockWalletService.commitFunds).not.toHaveBeenCalled();
    // ROLLBACK wajib dipanggil
    expect(mockWalletService.rollbackFunds).toHaveBeenCalledWith({ transaction_id: 'TX-888' });
  });

  it('harus melakukan rollback dompet jika layanan poin mengalami Timeout/Exception', async () => {
    mockWalletService.reserveFunds.mockReturnValue(of({ success: true }));
    // Poin gagal secara jaringan (Timeout)
    mockLoyaltyService.addPoints.mockReturnValue(throwError(() => new Error('gRPC Timeout')));
    mockWalletService.rollbackFunds.mockReturnValue(of({ success: true }));

    const result = await service.executeTransfer({
      transactionId: 'TX-777',
      userId: 'USER-3',
      amountCents: 2000,
    });

    expect(result.success).toBe(false);
    expect(mockWalletService.rollbackFunds).toHaveBeenCalledWith({ transaction_id: 'TX-777' });
  });
});
```
