# Implementasi Finite State Machines (FSM) & Statecharts dengan XState v5 di NestJS

Dalam domain pemrosesan transaksi yang kompleks (seperti pesanan e-commerce, *payment gateways*, atau persetujuan pinjaman), menjaga kebenaran status (State Correctness) adalah prioritas puncak. Pendekatan ad-hoc menggunakan kolom string Enum dalam database sering kali berujung pada *illegal state jumping* (misalnya: pesanan dengan status `CANCELED` dipaksa masuk ke status `SHIPPED` melalui eksploitasi API paralel).

**XState v5** menawarkan kerangka kerja definitif berbasis matematika (Statecharts) untuk mengunci transisi ini. Dokumen ini menjelaskan integrasi murni XState di *layer service* NestJS dan peristensinya di PostgreSQL.

## Arsitektur & Peran (State Machine Controller)

Alih-alih menyebar kondisi `if (order.status === 'X')` di ratusan fungsi, mesin status (FSM) bertindak sebagai *source of truth* terpusat yang memvalidasi setiap niat (event) pengguna secara statis.

```ascii
+--------------------+      Event (PAY)       +-----------------------+      Transition
| Client HTTP API    | ---------------------> | XState Order Machine  | ----------------+
| (NestJS Controller)|                        | (Strict Transitions)  |                 |
+--------------------+                        +-----------------------+                 |
                                                          | Reject                      v
                                                          | (Illegal Transition) +-------------+
                                                          v                      | PostgreSQL  |
                                                +-------------------+            | (Save State)|
                                                | HTTP 422 Error    |            +-------------+
                                                +-------------------+
```

## Implementasi Produksi

Berikut implementasi type-safe XState v5 untuk mengunci transisi pesanan.

### 1. Definisi Event, Context, dan Tipe

```typescript
// xstate.types.ts
export type OrderContext = {
  orderId: string;
  totalAmount: number;
  paymentMethod: string | null;
  cancelReason: string | null;
};

export type OrderEvent =
  | { type: 'PAY'; paymentMethod: string }
  | { type: 'PACK' }
  | { type: 'SHIP' }
  | { type: 'DELIVER' }
  | { type: 'CANCEL'; reason: string };

export type OrderStateValue = 
  | 'PENDING'
  | 'PAID'
  | 'PACKING'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELED';
```

### 2. Definisi Mesin State (Statechart)

Mesin dikonfigurasi dengan *guards* (pelindung) untuk memastikan transisi hanya valid bila kondisi bisnis terpenuhi.

```typescript
// order.machine.ts
import { setup, assign } from 'xstate';
import { OrderContext, OrderEvent } from './xstate.types';

export const orderMachine = setup({
  types: {
    context: {} as OrderContext,
    events: {} as OrderEvent,
  },
  guards: {
    hasValidPaymentAmount: ({ context }) => context.totalAmount > 0,
    hasValidCancelReason: ({ event }) => {
      if (event.type === 'CANCEL') {
        return event.reason.length > 5;
      }
      return false;
    }
  },
  actions: {
    setPaymentMethod: assign({
      paymentMethod: ({ event }) => (event.type === 'PAY' ? event.paymentMethod : null),
    }),
    setCancelReason: assign({
      cancelReason: ({ event }) => (event.type === 'CANCEL' ? event.reason : null),
    }),
  }
}).createMachine({
  id: 'orderProcess',
  initial: 'PENDING',
  context: {
    orderId: '',
    totalAmount: 0,
    paymentMethod: null,
    cancelReason: null,
  },
  states: {
    PENDING: {
      on: {
        PAY: {
          target: 'PAID',
          guard: 'hasValidPaymentAmount',
          actions: 'setPaymentMethod',
        },
        CANCEL: {
          target: 'CANCELED',
          guard: 'hasValidCancelReason',
          actions: 'setCancelReason',
        },
      }
    },
    PAID: {
      on: {
        PACK: {
          target: 'PACKING',
        }
      }
    },
    PACKING: {
      on: {
        SHIP: {
          target: 'SHIPPED',
        }
      }
    },
    SHIPPED: {
      on: {
        DELIVER: {
          target: 'DELIVERED',
        }
      }
    },
    DELIVERED: {
      type: 'final',
    },
    CANCELED: {
      type: 'final',
    }
  }
});
```

### 3. NestJS Service Integration (Persistensi)

Service memulihkan status (restore state) dari database, menerapkan *event*, dan menyimpan status baru kembali ke database jika transisi berhasil.

```typescript
// order.service.ts
import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { createActor } from 'xstate';
import { orderMachine } from './order.machine';
import { OrderEvent, OrderStateValue, OrderContext } from './xstate.types';

@Injectable()
export class OrderFsmService {
  private readonly logger = new Logger(OrderFsmService.name);

  // Mock dependency: Bayangkan ini adalah repositori TypeORM/Prisma
  private databaseMock = new Map<string, { stateValue: OrderStateValue, context: OrderContext }>();

  async createNewOrder(orderId: string, amount: number): Promise<void> {
    const actor = createActor(orderMachine, {
      input: { orderId, totalAmount: amount, paymentMethod: null, cancelReason: null }
    }).start();

    const snapshot = actor.getSnapshot();
    
    // Persistensi ke database
    this.databaseMock.set(orderId, {
      stateValue: snapshot.value as OrderStateValue,
      context: snapshot.context,
    });
  }

  async processEvent(orderId: string, event: OrderEvent): Promise<OrderStateValue> {
    const persistedData = this.databaseMock.get(orderId);
    
    if (!persistedData) {
      throw new BadRequestException('Order tidak ditemukan');
    }

    // Bangkitkan mesin dari state sebelumnya (rehydration)
    const actor = createActor(orderMachine, {
      state: {
        value: persistedData.stateValue,
        context: persistedData.context,
      } as any,
    }).start();

    // Validasi apakah transisi diizinkan?
    if (!actor.getSnapshot().can(event)) {
      throw new BadRequestException(`Transisi tidak sah: tidak bisa ${event.type} saat status ${persistedData.stateValue}`);
    }

    // Terapkan transisi
    actor.send(event);
    const newSnapshot = actor.getSnapshot();

    // Persistensi ke database
    this.databaseMock.set(orderId, {
      stateValue: newSnapshot.value as OrderStateValue,
      context: newSnapshot.context,
    });

    this.logger.log(`Order ${orderId} bertransisi ke ${newSnapshot.value}`);
    return newSnapshot.value as OrderStateValue;
  }
}
```

### 4. Suite Pengujian Mock (Jest)

Pengujian harus memverifikasi transisi valid dan *guard conditions*.

```typescript
// order.fsm.spec.ts
import { OrderFsmService } from './order.service';
import { BadRequestException } from '@nestjs/common';

describe('OrderFsmService', () => {
  let service: OrderFsmService;

  beforeEach(() => {
    service = new OrderFsmService();
  });

  it('seharusnya memproses pembayaran dan transisi ke PAID', async () => {
    await service.createNewOrder('ORD-1', 150000);
    const newState = await service.processEvent('ORD-1', { type: 'PAY', paymentMethod: 'CREDIT_CARD' });
    
    expect(newState).toBe('PAID');
  });

  it('seharusnya MENOLAK pengiriman (SHIP) pesanan yang belum dibayar', async () => {
    await service.createNewOrder('ORD-2', 150000);
    
    await expect(service.processEvent('ORD-2', { type: 'SHIP' }))
      .rejects
      .toThrow(BadRequestException);
      
    // Pastikan pesannya mencerminkan status penolakan
    await expect(service.processEvent('ORD-2', { type: 'SHIP' }))
      .rejects
      .toThrow(/Transisi tidak sah: tidak bisa SHIP saat status PENDING/);
  });

  it('seharusnya menolak pembatalan dengan alasan terlalu pendek (Guard test)', async () => {
    await service.createNewOrder('ORD-3', 150000);
    
    // "No" panjangnya hanya 2 karakter (harus > 5 sesuai guard)
    await expect(service.processEvent('ORD-3', { type: 'CANCEL', reason: 'No' }))
      .rejects
      .toThrow(BadRequestException);
  });
});
```

## Analisis Trade-Off

**Kelebihan:**
1.  **Keamanan Statis Ekstrem:** Transisi status dijamin aman oleh matematika. Celah bug terkait *race conditions* logic tumpang tindih nyaris tereliminasi.
2.  **Visualisasi Nyata:** File konfigurasi XState dapat dieskpor ke Visualizer. Hal ini mempermudah Product Manager (PM) untuk membaca alur *flow* secara grafis, menyelaraskan komunikasi bisnis-teknis.
3.  **Audit Trail Rehydration:** Persistensi state terstruktur (*context* dan *value*) sangat ramah dengan pola *Event Sourcing* jika diperlukan.

**Kekurangan:**
1.  **Konfigurasi Bertele-tele (Boilerplate):** Pendefinisian FSM yang kompleks untuk aplikasi ringan membutuhkan jumlah kode TypeScript dua hingga tiga kali lebih panjang daripada `if/else` biasa.
2.  **Beban Memori Instansiasi:** Membuat `createActor` per interaksi REST API menambah sedikit alokasi memori berulang dibandingkan mengubah kolom ORM secara mutlak.
3.  **Kesulitan Migrasi State Berjalan:** Jika mendefinisikan *state node* baru pada iterasi produk selanjutnya, entitas lama di database yang menahan nama status usang (deprecated) akan macet atau gagal di-*hydrate*.

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menyebar Status Ad-Hoc di Controller
Sebuah pesanan tidak boleh diedit secara brutal dengan penugasan properti absolut melalui permintaan input.

```typescript
// ❌ CONTOH SALAH (Penyalahgunaan Enum, Mengabaikan Flow FSM)
@Put('force-ship')
async shipOrder(@Body() dto: any) {
  // BERBAHAYA: Pesanan BISA DIKIRIM (SHIPPED) meskipun belum dibayar!
  await this.db.update(dto.orderId, { status: 'SHIPPED' }); 
}
```

```typescript
// ✅ CONTOH BENAR (Mengandalkan Validasi Statechart)
@Put('ship')
async shipOrder(@Body() dto: any) {
  // FSM Controller akan otomatis MENOLAK dengan 422 HTTP jika status saat ini BUKAN 'PACKING'
  await this.orderFsmService.processEvent(dto.orderId, { type: 'SHIP' });
}
```

### ❌ Anti-Pattern 2: Menaruh Efek Samping Database di dalam XState Actions
XState Actions seharusnya murni untuk mengubah (assign) struktur memori `context`. Memanggil basis data di dalam *action block* (tanpa infrastruktur asinkron Actor yang tepat) dapat menyebabkan *race conditions* dan transaksi terputus. Lakukan I/O sebelum atau sesudah inisialisasi Actor, atau gunakan XState `invoke` (layanan asinkron), tetapi cara paling portabel di NestJS adalah *orchestrating* via Service class.

## Production Edge Cases (Kasus Ekstrem)

1.  **Pembaruan Status Konkuren (Race Condition):** Jika dua permintaan HTTP mencoba merubah status pada milidetik yang sama, FSM di instansi pertama mungkin sukses (memperbarui DB), tetapi FSM di instansi kedua mungkin me-load state DB yang kedaluwarsa. Gunakan optimistik locking (kolom `version` di PostgreSQL) pada saat melakukan query dan update (`UPDATE orders SET state = X, version = version + 1 WHERE id = Y AND version = Z`).
2.  **Hydration State Kuno:** Mesin yang ditingkatkan konfigurasinya mungkin membuang tipe state (misalnya, state `PENDING_REVIEW` dihilangkan di versi 2). Rekaman DB beraliran lama yang memuat nilai state ini akan *crash* saat dibangkitkan. Penanganan membutuhkan migrasi migrasi *on-the-fly* atau pemetaan *compatibility layer* di repositori.
3.  **State Ledakan (State Explosion):** Desain Statechart hierarkis dan paralel yang terlalu granular bisa melahirkan ratusan kombinasi tak terduga. Batasi cakupan FSM hanya untuk entitas domain utama.
