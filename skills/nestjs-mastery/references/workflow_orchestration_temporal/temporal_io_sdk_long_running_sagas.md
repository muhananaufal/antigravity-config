# Integrasi Temporal.io TypeScript SDK: Durable Execution & Long-Running Sagas di NestJS

Eksekusi yang tahan lama (*Durable Execution*) adalah fondasi dari sistem terdistribusi modern di mana kegagalan node, jaringan, atau dependensi pihak ketiga dianggap sebagai hal yang wajar (first-class citizen). Temporal.io menyediakan paradigma di mana *state* dari eksekusi kode (lokal variabel, program counter) dipertahankan ke dalam basis data (event sourcing) secara otomatis. Dokumen ini merinci implementasi *Durable Execution* dengan Temporal TypeScript SDK di dalam arsitektur NestJS 10+.

## Arsitektur & Peran (Workflow vs Activity)

Dalam Temporal, ada pemisahan tegas antara dua entitas:
1.  **Workflow:** Fungsi deterministik yang tidak boleh memiliki efek samping (side-effects). Fungsi ini merancang orkestrasi dan menahan state. Dilarang keras melakukan I/O langsung (HTTP, DB, waktu acak) di dalam Workflow.
2.  **Activity:** Fungsi yang tidak deterministik, tempat terjadinya I/O dan operasi dunia nyata. Activity adalah titik di mana *retries* tak terbatas bisa terjadi tanpa mengganggu kestabilan orkestrasi.

```ascii
+-----------------------+       +-------------------+       +-----------------------+
|   NestJS API Server   | ----> | Temporal Cluster  | <---- | NestJS Worker Process |
| (Workflow Controller) |       | (State/Event DB)  |       | (Executes Workflows)  |
+-----------------------+       +-------------------+       +-----------------------+
           |                                                            |
           |                                                            v
           |                                                +-----------------------+
           +----------------------------------------------> |      Activities       |
                                                            | (DB, Payment Gateway) |
                                                            +-----------------------+
```

## Implementasi Produksi

Berikut adalah kode TypeScript tingkat produksi untuk e-commerce Saga (Pemesanan -> Pembayaran -> Penahan Stok -> Pengiriman).

### 1. Definisi Tipe dan Antarmuka

```typescript
// types.ts
export interface OrderPayload {
  orderId: string;
  userId: string;
  items: Array<{ productId: string; quantity: number; price: number }>;
  totalAmount: number;
}

export interface PaymentResult {
  transactionId: string;
  status: 'SUCCESS' | 'FAILED';
  clearedAt: string;
}

export interface InventoryResult {
  reserved: boolean;
  warehouseId: string;
}

export interface ShipmentResult {
  trackingNumber: string;
  courier: string;
}
```

### 2. Implementasi Activities

Activity adalah layanan standar NestJS yang dapat disuntikkan (injected) dengan dependensi.

```typescript
// order.activities.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderPayload, PaymentResult, InventoryResult, ShipmentResult } from './types';

@Injectable()
export class OrderActivities {
  private readonly logger = new Logger(OrderActivities.name);

  constructor(private readonly configService: ConfigService) {}

  async processPayment(payload: OrderPayload): Promise<PaymentResult> {
    this.logger.log(`Memproses pembayaran untuk pesanan ${payload.orderId}`);
    const apiKey = this.configService.getOrThrow<string>('PAYMENT_GATEWAY_API_KEY');
    
    // Simulasi panggilan jaringan ke Payment Gateway
    if (!apiKey) {
      throw new Error('API Key tidak ditemukan, menghentikan aktivitas.');
    }
    
    // Logika dunia nyata yang berpotensi gagal (timeout, 5xx)
    return {
      transactionId: `TXN-${Date.now().toString()}`,
      status: 'SUCCESS',
      clearedAt: new Date().toISOString(),
    };
  }

  async reserveInventory(payload: OrderPayload): Promise<InventoryResult> {
    this.logger.log(`Menahan stok untuk pesanan ${payload.orderId}`);
    // Simulasi mutasi database/stok
    return {
      reserved: true,
      warehouseId: 'WH-JKT-01',
    };
  }

  async dispatchShipment(payload: OrderPayload): Promise<ShipmentResult> {
    this.logger.log(`Mengirim barang pesanan ${payload.orderId}`);
    // Simulasi pemanggilan API logistik pihak ketiga
    return {
      trackingNumber: `AWB-${Math.floor(Math.random() * 1000000).toString()}`,
      courier: 'JNE',
    };
  }
}
```

### 3. Implementasi Workflow (Deterministik)

Workflow TIDAK diinjeksi oleh dependensi NestJS. Ia berjalan di isolasi v8 (sandbox) yang disediakan oleh Temporal Worker.

```typescript
// order.workflow.ts
import { proxyActivities, sleep } from '@temporalio/workflow';
import type { OrderActivities } from './order.activities';
import { OrderPayload } from './types';

// Definisi proxy untuk memanggil activities dengan policy retri.
const activities = proxyActivities<OrderActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '10 seconds',
    backoffCoefficient: 2,
    maximumAttempts: 10, // Atau hilangkan untuk retri tak terbatas
  },
});

export async function orderFulfillmentWorkflow(payload: OrderPayload): Promise<string> {
  // 1. Tagih Pembayaran
  const payment = await activities.processPayment(payload);
  
  if (payment.status !== 'SUCCESS') {
    throw new Error(`Pembayaran gagal untuk pesanan: ${payload.orderId}`);
  }

  // 2. Tahan Inventaris / Stok
  const inventory = await activities.reserveInventory(payload);
  
  if (!inventory.reserved) {
    throw new Error(`Inventaris tidak mencukupi untuk pesanan: ${payload.orderId}`);
  }

  // Jeda buatan deterministik tanpa memblokir thread worker (Aman dari crash)
  await sleep('10 seconds');

  // 3. Eksekusi Pengiriman
  const shipment = await activities.dispatchShipment(payload);

  return `Pesanan ${payload.orderId} berhasil diproses dengan resi ${shipment.trackingNumber}`;
}
```

### 4. NestJS Temporal Client Service

Service ini memicu eksekusi Workflow dari Controller HTTP atau Event Broker.

```typescript
// temporal.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Connection, Client } from '@temporalio/client';
import { ConfigService } from '@nestjs/config';
import { orderFulfillmentWorkflow } from './order.workflow';
import { OrderPayload } from './types';

@Injectable()
export class TemporalClientService implements OnModuleInit, OnModuleDestroy {
  private client!: Client;
  private connection!: Connection;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const temporalAddress = this.configService.getOrThrow<string>('TEMPORAL_ADDRESS');
    this.connection = await Connection.connect({ address: temporalAddress });
    this.client = new Client({ connection: this.connection });
  }

  async onModuleDestroy() {
    await this.connection.close();
  }

  async startOrderWorkflow(orderPayload: OrderPayload): Promise<string> {
    const handle = await this.client.workflow.start(orderFulfillmentWorkflow, {
      args: [orderPayload],
      taskQueue: 'ecommerce-fulfillment-queue',
      workflowId: `order-fulfillment-${orderPayload.orderId}`,
    });

    return handle.workflowId;
  }
}
```

### 5. Suite Pengujian Mock (Jest)

Pengujian Temporal Workflows memerlukan `@temporalio/testing` environment untuk menyimulasikan waktu (time-travel) dan aktivitas tiruan.

```typescript
// order.workflow.spec.ts
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { orderFulfillmentWorkflow } from './order.workflow';
import { OrderPayload, PaymentResult, InventoryResult, ShipmentResult } from './types';

describe('Order Fulfillment Workflow', () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  });

  afterAll(async () => {
    await testEnv?.teardown();
  });

  it('seharusnya mengeksekusi pipeline e-commerce dengan sukses', async () => {
    const { client, nativeConnection } = testEnv;
    const taskQueue = 'test-ecommerce-queue';

    const mockPayload: OrderPayload = {
      orderId: 'TEST-123',
      userId: 'USER-1',
      items: [{ productId: 'P-1', quantity: 1, price: 50000 }],
      totalAmount: 50000,
    };

    const mockActivities = {
      processPayment: async (_p: OrderPayload): Promise<PaymentResult> => ({
        transactionId: 'TXN-1',
        status: 'SUCCESS',
        clearedAt: new Date().toISOString(),
      }),
      reserveInventory: async (_p: OrderPayload): Promise<InventoryResult> => ({
        reserved: true,
        warehouseId: 'WH-1',
      }),
      dispatchShipment: async (_p: OrderPayload): Promise<ShipmentResult> => ({
        trackingNumber: 'AWB-123',
        courier: 'JNE',
      }),
    };

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./order.workflow'),
      activities: mockActivities,
    });

    await worker.runUntil(async () => {
      const handle = await client.workflow.start(orderFulfillmentWorkflow, {
        args: [mockPayload],
        workflowId: 'test-workflow-id',
        taskQueue,
      });

      const result = await handle.result();
      expect(result).toBe('Pesanan TEST-123 berhasil diproses dengan resi AWB-123');
    });
  });
});
```

## Analisis Trade-Off

**Kelebihan:**
1.  **Ketahanan Ekstrem (Extreme Durability):** Jika pod/server NestJS yang mengeksekusi mati di tengah-tengah transaksi, *worker* lain akan mengambil alih statusnya persis di titik kegagalan karena state tersimpan di *event history*.
2.  **Pengurangan Beban RAM:** Waktu tunggu yang panjang (misalnya `sleep('30 days')`) tidak mengonsumsi RAM aplikasi, melainkan hanya *record timer* di database Temporal.
3.  **Observabilitas Sempurna:** UI Temporal memvisualisasikan setiap tahapan eksekusi secara grafis dan histori lengkap (jejak jejak deterministik).

**Kekurangan:**
1.  **Kurva Pembelajaran Curam:** Pemisahan paksa antara Workflow (harus deterministik) dan Activity (non-deterministik) menyulitkan insinyur pemula.
2.  **Infrastruktur Berat:** Memerlukan klaster Temporal (PostgreSQL/Cassandra, Elasticsearch, Temporal Server) yang rumit untuk dikelola jika *self-hosted*.
3.  **Hukuman Versioning:** Mengubah kode Workflow secara sembarangan bisa merusak instansi *workflow* yang sedang berjalan di *production* karena jejak aslinya tidak cocok. Perlu menggunakan API `patching`.

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menggunakan Tanggal, Acak (Random), atau I/O di dalam Workflow
Workflow harus murni deterministik. Fungsi `Math.random()`, `Date.now()`, atau pemanggilan HTTP langsung akan membuat status hancur saat di-*replay*.

```typescript
// ❌ CONTOH SALAH (Non-deterministik di Workflow)
import axios from 'axios';

export async function badWorkflow(payload: any) {
  const date = Date.now(); // ❌ ILEGAL
  const rnd = Math.random(); // ❌ ILEGAL
  const res = await axios.post('https://api.gateway.com', payload); // ❌ ILEGAL
}
```

```typescript
// ✅ CONTOH BENAR
import { proxyActivities, uuid4 } from '@temporalio/workflow';
const activities = proxyActivities<MyActivities>({ startToCloseTimeout: '1m' });

export async function goodWorkflow(payload: any) {
  // Gunakan aktivitas untuk I/O
  const res = await activities.postData(payload);
  // Gunakan uuid4 dari @temporalio/workflow untuk hasil acak yang persisten
  const id = uuid4(); 
}
```

### ❌ Anti-Pattern 2: Data Payload Terlalu Besar
Menyimpan payload JSON besar (misalnya string Base64 dari gambar 5MB) di dalam parameter/argumen Workflow akan memperlambat database Temporal secara signifikan.

```typescript
// ❌ CONTOH SALAH (Mengirim Base64 Image)
await client.workflow.start(processImageWorkflow, { args: [base64ImageString5MB] });
```

```typescript
// ✅ CONTOH BENAR (Menggunakan S3 Reference)
await client.workflow.start(processImageWorkflow, { args: ['s3://bucket/image1.jpg'] });
```

## Production Edge Cases (Kasus Ekstrem)

1.  **Activity Poison Pill:** Jika Activity menerima data tak terduga yang menyebabkannya selalu gagal secara deterministik (misalnya Null Pointer Exception), *infinite retries* akan menyebabkan aktivitas *stuck* selamanya tanpa bisa *timeout*. Selalu pastikan error non-transient dideklarasikan sebagai *Non-Retryable Error*.
2.  **Workflow Versioning Drift:** Jika kode Workflow diubah, instansi yang sedang berjalan (in-flight) yang sedang di-*pause* akan mencoba *replay* history lama dengan kode baru, memicu `NonDeterministicWorkflowError`. Penanganan membutuhkan strategi `patching` atau versi *Worker* yang terpisah via antrean tugas (*task queues*).
3.  **Signal/Query Throttling:** Sistem e-commerce yang dihujani permintaan pelanggan secara massal untuk menanyakan status pesanan bisa memperlambat *worker*. Hindari menggunakan query Temporal sebagai pembacaan berat, sinkronisasikan statusnya ke ElasticSearch atau basis data Read Replica (CQRS pattern) pada setiap penyelesaian *activity*.
