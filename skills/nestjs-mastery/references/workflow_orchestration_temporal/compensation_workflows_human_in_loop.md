# Alur Kerja Kompensasi (Rollback Sagas) & Human-in-the-Loop (HitL) Approvals

Dalam ekosistem layanan mikro terdistribusi (Microservices), tidak ada jaminan bahwa semua tahap transaksi (misalnya, saga pemesanan tiket penerbangan multinasional) akan selalu berhasil. *Distributed Transaction* tradisional (seperti Two-Phase Commit / 2PC) terlalu kaku, rawan kemacetan memori, dan mengunci baris DB, membuatnya anti-skalabel. Sebagai penggantinya, **Compensation Workflows (Sagas Pattern)** memecah transaksi menjadi langkah-langkah independen, dan jika langkah (n) gagal, sistem memanggil rutinitas kompensasi terbalik untuk memutar balik (rollback) langkah 1 hingga (n-1).

Selain itu, skenario tingkat tinggi menuntut persetujuan manual (Human-in-the-Loop) yang menangguhkan alur kerja hingga pengguna bisnis mengirimkan parameter atau sinyal asinkron. Dokumen ini menyajikan arsitektur dan implementasinya dengan Temporal.io TypeScript SDK.

## Arsitektur Kompensasi & HitL (Saga Pattern)

Saga Pattern merekam secara akumulatif tugas pembatalan seiring kemajuan transaksi yang diorkestrasikan oleh Workflow deterministik.

```ascii
[START]
   |
   v
[Deduction: Akun Saldo Pengguna] ------(Simpan Kompensasi)-----> [Refund: Kembalikan Saldo]
   |                                                                  ^
   v                                                                  |
[Reserve: Booking Hotel] --------------(Simpan Kompensasi)-----> [Cancel: Batal Booking]
   |                                                                  ^
   v                                                                  |
[Approval Tunggu Webhook]                                             |
   |                                                                  |
   +---- (Timeout / Ditolak) -----------------------------------------+ (SAGA ROLLBACK EXECUTION)
   |
   +---- (Disetujui Manajer) ---> [Keluarkan E-Ticket] ---> [SUCCESS]
```

## Implementasi Produksi

Berikut implementasi type-safe untuk Rollback Saga & Human-in-the-Loop yang aman dan kebal-crash.

### 1. Saga Orchestration Utility (TypeScript)

Temporal menyediakan paradigma sinyal asinkron dan abstraksi tumpukan ganti rugi (Compensation Stack).

```typescript
// types.ts
export interface RefundPayload {
  transactionId: string;
  userId: string;
  amount: number;
  reason: string;
}
```

```typescript
// human-loop.workflow.ts
import { 
  proxyActivities, 
  defineSignal, 
  setHandler, 
  condition,
  ApplicationFailure 
} from '@temporalio/workflow';
import type { FinancialActivities } from './financial.activities';
import { RefundPayload } from './types';

// Sinyal asinkron dari eksternal (Webhook)
export const managerApprovalSignal = defineSignal<[{ approved: boolean, approverId: string }]>('manager-approval');

const activities = proxyActivities<FinancialActivities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    maximumAttempts: 3,
  },
});

export async function highValueRefundWorkflow(payload: RefundPayload): Promise<string> {
  const compensations: Array<() => Promise<void>> = [];

  try {
    // 1. Kunci saldo (Reserve) sementara
    await activities.reserveRefundFunds(payload);
    // Tambahkan aksi kompensasi pembatalan jika alur kerja nantinya gagal!
    compensations.unshift(async () => {
      await activities.releaseRefundFunds(payload);
    });

    // 2. Tandai tiket sebagai sengketa
    await activities.markTicketDisputed(payload);
    compensations.unshift(async () => {
      await activities.clearTicketDisputedState(payload);
    });

    // 3. HUMAN IN THE LOOP (Menunggu Persetujuan Eksternal)
    let approvalResult: { approved: boolean, approverId: string } | null = null;
    
    setHandler(managerApprovalSignal, (signalPayload) => {
      approvalResult = signalPayload;
    });

    // Workflow akan tidur pasif (Durable Sleep) menunggu webhook masuk atau kadaluarsa!
    // Mengonsumsi 0 CPU/RAM saat sedang menunggu.
    const isApprovedOrTimeout = await condition(
      () => approvalResult !== null,
      '7 days' // Timeout SLA 7 Hari
    );

    if (!isApprovedOrTimeout) {
      throw ApplicationFailure.create({ message: 'SLA 7 Hari terlampaui tanpa persetujuan (Timeout).' });
    }

    if (!approvalResult!.approved) {
      throw ApplicationFailure.create({ message: `Ditolak oleh manajer: ${approvalResult!.approverId}` });
    }

    // 4. Eksekusi Pencairan Final (Finalize)
    await activities.executeFinalRefund(payload);
    
    return `Refund sukses disetujui oleh ${approvalResult!.approverId}`;

  } catch (error) {
    // ---- [BLOK SAGA ROLLBACK] ----
    // Eksekusi semua tumpukan kompensasi secara mundur (LIFO: Last-In-First-Out)
    for (const compensate of compensations) {
      try {
        await compensate();
      } catch (compensationError) {
        // Kompensasi gagal! Hal ini memerlukan intervensi manusia sekunder (Dead-letter).
        throw ApplicationFailure.create({ 
          message: `FATAL SAGA ROLLBACK FAILED. INTERVENSI MANUAL DIBUTUHKAN. Original error: ${error}. Compensation error: ${compensationError}`,
          nonRetryable: true 
        });
      }
    }
    
    // Melemparkan kembali (Rethrow) agar parent caller tahu ini adalah status kegagalan
    throw error;
  }
}
```

### 2. NestJS Webhook Controller (HitL Gateway)

Sistem lain (misalnya panel admin Retool) memanggil endpoint webhook ini untuk menyuntikkan sinyal ke dalam Workflow yang tertidur.

```typescript
// approval.controller.ts
import { Controller, Post, Body, Param, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Client, Connection } from '@temporalio/client';
import { managerApprovalSignal } from './human-loop.workflow';
import { ConfigService } from '@nestjs/config';

@Controller('v1/workflows/approvals')
export class ApprovalController {
  private readonly logger = new Logger(ApprovalController.name);
  
  constructor(private readonly configService: ConfigService) {}

  @Post(':workflowId')
  async submitApproval(
    @Param('workflowId') workflowId: string,
    @Body() body: { approved: boolean; managerId: string }
  ) {
    const temporalAddress = this.configService.getOrThrow<string>('TEMPORAL_ADDRESS');
    
    // Normalnya koneksi dikelola secara singleton via DI
    const connection = await Connection.connect({ address: temporalAddress });
    const client = new Client({ connection });

    try {
      const handle = client.workflow.getHandle(workflowId);
      
      // Mengirimkan sinyal ke instance yang sedang menunggu `condition()`
      await handle.signal(managerApprovalSignal, {
        approved: body.approved,
        approverId: body.managerId,
      });

      this.logger.log(`Sinyal persetujuan sukses terkirim ke workflow ${workflowId}`);
      return { status: 'Signal disalurkan' };
      
    } catch (error) {
      this.logger.error(`Gagal mengirim sinyal ke workflow ${workflowId}`, error);
      throw new HttpException('Workflow tidak ditemukan / sudah selesai', HttpStatus.NOT_FOUND);
    }
  }
}
```

### 3. Suite Pengujian Mock (Jest)

Menguji skenario eksekusi *Human-in-the-Loop* yang melibatkan timeout SLA.

```typescript
// human-loop.workflow.spec.ts
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { highValueRefundWorkflow, managerApprovalSignal } from './human-loop.workflow';
import { RefundPayload } from './types';

describe('Human-in-the-Loop Compensation Workflow', () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    // Time-skipping aktif, tidur 7 hari diuji hanya dalam milidetik!
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  });

  afterAll(async () => {
    await testEnv?.teardown();
  });

  it('seharusnya membatalkan seluruh saga (kompensasi) ketika timeout 7 hari dicapai', async () => {
    const { client, nativeConnection } = testEnv;
    const taskQueue = 'test-refund-queue';

    // Pencatatan spy untuk memastikan rollback dipanggil
    const mockActivities = {
      reserveRefundFunds: jest.fn().mockResolvedValue(true),
      releaseRefundFunds: jest.fn().mockResolvedValue(true),
      markTicketDisputed: jest.fn().mockResolvedValue(true),
      clearTicketDisputedState: jest.fn().mockResolvedValue(true),
      executeFinalRefund: jest.fn().mockResolvedValue(true),
    };

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./human-loop.workflow'),
      activities: mockActivities,
    });

    const payload: RefundPayload = {
      transactionId: 'TX-REF-1',
      userId: 'USR-22',
      amount: 75000000,
      reason: 'Barang tidak sesuai (VIP)',
    };

    await worker.runUntil(async () => {
      const handle = await client.workflow.start(highValueRefundWorkflow, {
        args: [payload],
        workflowId: 'test-timeout-wf',
        taskQueue,
      });

      // Jangan kirim sinyal apapun, langsung lompatkan waktu (Time-Travel)
      await testEnv.sleep('8 days');

      await expect(handle.result()).rejects.toThrow(/SLA 7 Hari terlampaui tanpa persetujuan/);
      
      // Verifikasi Saga Rollback tereksekusi dengan benar (LIFO order)
      expect(mockActivities.reserveRefundFunds).toHaveBeenCalled();
      expect(mockActivities.markTicketDisputed).toHaveBeenCalled();
      expect(mockActivities.executeFinalRefund).not.toHaveBeenCalled(); // Karena batal
      
      // Rollback verifikasi!
      expect(mockActivities.clearTicketDisputedState).toHaveBeenCalled();
      expect(mockActivities.releaseRefundFunds).toHaveBeenCalled();
    });
  });

  it('seharusnya mengeksekusi secara positif jika disetujui webhook', async () => {
    const { client, nativeConnection } = testEnv;
    const taskQueue = 'test-refund-queue';

    const mockActivities = {
      reserveRefundFunds: jest.fn().mockResolvedValue(true),
      releaseRefundFunds: jest.fn().mockResolvedValue(true),
      markTicketDisputed: jest.fn().mockResolvedValue(true),
      clearTicketDisputedState: jest.fn().mockResolvedValue(true),
      executeFinalRefund: jest.fn().mockResolvedValue(true),
    };

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./human-loop.workflow'),
      activities: mockActivities,
    });

    const payload: RefundPayload = {
      transactionId: 'TX-REF-2',
      userId: 'USR-99',
      amount: 150000,
      reason: 'Salah barang',
    };

    await worker.runUntil(async () => {
      const handle = await client.workflow.start(highValueRefundWorkflow, {
        args: [payload],
        workflowId: 'test-success-wf',
        taskQueue,
      });

      // Berikan sinyal persetujuan sesaat setelah mulai
      await handle.signal(managerApprovalSignal, { approved: true, approverId: 'MGR-X' });

      const result = await handle.result();
      expect(result).toBe('Refund sukses disetujui oleh MGR-X');
      
      // Rollback JANGAN dipanggil
      expect(mockActivities.releaseRefundFunds).not.toHaveBeenCalled();
      expect(mockActivities.executeFinalRefund).toHaveBeenCalled();
    });
  });
});
```

## Analisis Trade-Off

**Kelebihan:**
1.  **Durable Suspensions Tanpa Blockers:** Mengantre eksekusi HitL (menunggu manusia) selama berminggu-minggu menggunakan RAM nol. Berbeda dengan pendekatan Node.js `setTimeout` atau basis DB polling panjang yang membakar CPU.
2.  **LIFO Compensation Resilience:** Konstruksi antrean array per Workflow memudahkan pembuatan rutinitas tepercaya, karena operasi pembatalan juga secara inheren mendukung percobaan kembali (retries) tingkat sistem.
3.  **Audit Trail Sempurna & Time-Skipping Test:** Mengetes batas tenggat waktu bertahun-tahun bisa dilakukan dalam hitungan milidetik karena simulasi temporal, memfasilitasi TDD yang kuat untuk penanganan kesalahan waktu.

**Kekurangan:**
1.  **Kompleksitas Non-Atomik:** Operasi kompensasi (pembatalan) bisa gagal dalam dirinya sendiri, berpotensi meletakkan database pada state in-limbo terkorupsi jika fungsi `compensate()` tidak idempoten secara absolut.
2.  **Ledakan Sinyal Liar:** Menerima ratusan ribu webhook sinyal berturut-turut pada state yang belum siap (sebelum `setHandler` aktif) bisa memicu `Unhandled Signal Error` bila desain stateful temporal tidak kuat.
3.  **Ketergantungan Kuat Stateful SDK:** Integrasi mendalam ke arsitektur Temporal mengunci kebebasan migrasi arsitektur infrastruktur sistem (Vendor lock-in arsitektur).

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menyimpan Referensi Non-Serializable sebagai Variabel Kompensasi
Fungsi yang diletakkan dalam *array* `compensations` pada *closure* harus bebas dari objek berat (seperti klien basis data atau file handles) karena workflow dapat mematikan dan merehidrasi status di *Worker* lain.

```typescript
// ❌ CONTOH SALAH (Mengirimkan objek instance class yang un-serializable)
const dbConnection = await createHeavyDbConn(); 
compensations.unshift(async () => {
  // Berbahaya, koneksi akan hilang jika worker restart!
  await dbConnection.execute('ROLLBACK...'); 
});
```

```typescript
// ✅ CONTOH BENAR (Hanya menggunakan Data Payload primitif murni via proxyActivities)
const payload = { userId: '123' };
compensations.unshift(async () => {
  // Aman, Activity bertanggung jawab menyiapkan dan mematikan koneksinya sendiri
  await activities.safeRollback(payload);
});
```

### ❌ Anti-Pattern 2: Rutinitas Kompensasi Tidak Idempoten
Sistem orkestrasi seperti Temporal memfasilitasi pengulangan (retry). Rutinitas pelepasan stok (Release) jika dipanggil ulang 5 kali secara berturut-turut karena koneksi internet putus putus, harus dijamin tidak menciptakan stok palsu berlipat ganda.

## Production Edge Cases (Kasus Ekstrem)

1.  **The Dead-Letter Compensation Failure:** Bagaimana jika API eksternal permanen dihapus dan rutinitas pembatalan hotel gagal secara repetitif selama 3 hari tak terbatas? Arsitektur harus men-deploy pemberitahuan khusus *Dead-Letter/Ops-Alerts* setelah N percobaan `nonRetryable`, dan memicu eskalasi staf devOps.
2.  **Phantom Approval (Sinyal Hantu):** Sinyal persetujuan diterima (via API webhook luar) saat proses Refund baru saja kedaluwarsa secara mandiri dan melempar Timeout di detik yang persis sama. Pastikan API webhook Controller menvalidasi terlebih dahulu ketersediaan dan status terbuka (open) dari Workflow `client.workflow.getHandle(id).describe()` sebelum memompa sinyal masuk.
3.  **Duplicated Signaling Attack:** Seorang aktor jahat bisa mengeksploitasi celah API dengan mengirimkan ribuan permintaan persetujuan sinyal palsu untuk memenuhi memori Workflow execution history. Tangani idempotensi secara lokal dalam handler sinyal (`setHandler(managerApprovalSignal, (sig) => { if (alreadyProcessed) return; ...})`).
