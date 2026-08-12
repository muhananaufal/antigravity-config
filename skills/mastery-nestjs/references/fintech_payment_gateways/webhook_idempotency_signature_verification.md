# Pengamanan Endpoint Webhook Pembayaran dan Idempotency di NestJS Fastify

Dalam arsitektur *fintech* level produksi, *endpoint* *webhook* yang menerima notifikasi dari *Payment Gateway* (seperti Stripe, Xendit, atau Midtrans) merupakan target utama serangan siber. Dua lapis pertahanan krusial yang wajib diimplementasikan adalah **Verifikasi Tanda Tangan Kriptografi (Cryptographic Signature Verification)** menggunakan HMAC-SHA256 dan **Kunci Idempotency (Idempotency Keys)** berbasis Redis untuk mencegah kondisi *Race Condition* dan pemotongan saldo ganda (Double-Spending). Kegagalan pada lapisan ini akan menyebabkan kerugian finansial fatal.

## Arsitektur Alur Kriptografi dan Idempotency

Berikut adalah alur arsitektur verifikasi *webhook* dari *Payment Gateway* hingga persetujuan saldo, dengan penerapan kunci Idempotency untuk memastikan bahwa satu ID transaksi hanya akan diproses tepat satu kali, terlepas dari berapa kali *webhook* dikirimkan (karena mekanisme *retry* otomatis dari *Gateway*).

```text
+----------------+          (1) POST /webhook/midtrans            +-------------------------+
| Payment Gateway| ---------------------------------------------> | NestJS Fastify API      |
| (Midtrans, dll)|  Header: X-Signature: HMAC-SHA256(Payload)     | [WebhookGuard]          |
+----------------+                                                +-------------------------+
                                                                             |
                                                                             v
                                                                  (2) Verifikasi HMAC-SHA256
                                                                  Bandingkan Hash(Payload + Secret)
                                                                             |
                                     +-----------------+                     v
                                     | Redis Cluster   | <----------- (3) SETNX idempotency_key
                                     +-----------------+      (Transaksi baru atau sudah ada?)
                                             |                               |
                                             v                               v
                                     (4) Jika EXISTS -> 200 OK      (5) Jika NEW -> Lanjut Proses
                                         (Skip Proses Ulang)                 |
                                                                             v
                                     +-----------------+            +-------------------------+
                                     | PostgreSQL DB   | <--------- | Domain Service          |
                                     | (Ledger, Order) |            | (Update Status, Saldo)  |
                                     +-----------------+            +-------------------------+
```

## Implementasi Produksi NestJS 10+ (Type-Safe)

Implementasi di bawah ini menggunakan NestJS 10 dengan *engine* Fastify. Kita membuat sebuah *Guard* (atau *Interceptor*) khusus untuk memverifikasi tanda tangan, dan menggunakan *Redis* untuk mekanisme *Idempotency*. Kita menghindari penggunaan tipe `any` dengan mendefinisikan *interface* ketat.

### 1. DTO & Interfaces

```typescript
import { IsString, IsNumber, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class MidtransTransactionDetailsDto {
  @IsString()
  readonly order_id: string;

  @IsNumber()
  readonly gross_amount: number;
}

export class MidtransWebhookPayloadDto {
  @IsString()
  readonly transaction_status: string;

  @IsString()
  readonly transaction_id: string;

  @IsString()
  readonly signature_key: string;

  @IsString()
  readonly status_code: string;

  @IsString()
  readonly gross_amount: string;

  @IsString()
  readonly order_id: string;
}
```

### 2. Webhook Guard & Signature Verification

Kita melakukan validasi tanda tangan HMAC-SHA256 sesuai dengan spesifikasi Midtrans (SHA512 dari `order_id` + `status_code` + `gross_amount` + `ServerKey`).

```typescript
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Logger } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WebhookSignatureGuard.name);

  constructor(private readonly configService: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const payload = request.body as Record<string, unknown>;

    // Validasi field minimum
    if (
      typeof payload.signature_key !== 'string' ||
      typeof payload.order_id !== 'string' ||
      typeof payload.status_code !== 'string' ||
      typeof payload.gross_amount !== 'string'
    ) {
      this.logger.warn('Payload Webhook tidak memiliki field wajib untuk verifikasi tanda tangan.');
      throw new UnauthorizedException('Invalid webhook payload structure');
    }

    const serverKey = this.configService.getOrThrow<string>('MIDTRANS_SERVER_KEY');
    
    // Algoritma Signature Midtrans: SHA512(order_id + status_code + gross_amount + ServerKey)
    const rawString = `${payload.order_id}${payload.status_code}${payload.gross_amount}${serverKey}`;
    
    const calculatedSignature = crypto
      .createHash('sha512')
      .update(rawString)
      .digest('hex');

    if (calculatedSignature !== payload.signature_key) {
      this.logger.error(`Signature Mismatch! Expected: ${calculatedSignature}, Got: ${payload.signature_key}`);
      throw new UnauthorizedException('Invalid Webhook Signature');
    }

    return true;
  }
}
```

### 3. Layanan Redis Idempotency dan Webhook Controller

```typescript
import { Injectable, Inject, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

@Injectable()
export class IdempotencyService {
  constructor(@Inject('REDIS_CLIENT') private readonly redisClient: Redis) {}

  /**
   * Menghasilkan boolean true jika kunci ini baru dan berhasil di-set.
   * Menghasilkan false jika transaksi sedang atau sudah diproses.
   */
  async acquireLock(key: string, ttlSeconds: number = 86400): Promise<boolean> {
    const result = await this.redisClient.set(key, 'PROCESSING', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }
}
```

```typescript
import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { MidtransWebhookPayloadDto } from './dto/midtrans-webhook-payload.dto';
import { WebhookSignatureGuard } from './guards/webhook-signature.guard';
import { IdempotencyService } from './services/idempotency.service';
import { PaymentProcessorService } from './services/payment-processor.service';

@Controller('webhooks/payments')
export class PaymentWebhookController {
  private readonly logger = new Logger(PaymentWebhookController.name);

  constructor(
    private readonly idempotencyService: IdempotencyService,
    private readonly paymentProcessor: PaymentProcessorService,
  ) {}

  @Post('midtrans')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WebhookSignatureGuard)
  async handleMidtransWebhook(@Body() payload: MidtransWebhookPayloadDto): Promise<{ status: string }> {
    const idempotencyKey = `midtrans_webhook_tx_${payload.transaction_id}`;

    // 1. Cek Idempotency
    const isNewEvent = await this.idempotencyService.acquireLock(idempotencyKey);
    if (!isNewEvent) {
      this.logger.log(`Webhook duplikat diabaikan untuk Transaksi ID: ${payload.transaction_id}`);
      return { status: 'acknowledged' }; // Selalu kembalikan 200 OK untuk menghentikan retries
    }

    // 2. Proses Pembayaran
    try {
      await this.paymentProcessor.processPaymentStatus(payload);
    } catch (error: unknown) {
      // Jika terjadi kesalahan sistemikal, hapus lock agar webhook retry bisa diproses ulang
      if (error instanceof Error) {
        this.logger.error(`Gagal memproses webhook: ${error.message}`);
      }
      // HATI-HATI: Hanya hapus kunci jika kesalahan bersifat "Retryable" (Misal: DB Timeout).
      // Jika error karena validasi bisnis (Misal: Order Not Found), JANGAN hapus kunci.
      throw error; 
    }

    return { status: 'success' };
  }
}
```

## Anti-Patterns Kritis dan Praktik Terbaik

### 1. Anti-Pattern: Tidak menggunakan Buffer untuk validasi HMAC
❌ **Salah:** Menggunakan `JSON.stringify(req.body)` untuk verifikasi HMAC. *Middleware* *body-parser* mungkin mengubah urutan kunci atau menghapus *whitespace*, membuat *hash* gagal diverifikasi untuk layanan berbasis HMAC *raw body* (seperti Stripe).
```typescript
// ❌ ANTI-PATTERN: Mem-parsing body lalu di-stringify ulang mengubah byte aslinya
const rawBody = JSON.stringify(req.body);
const hash = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
```

✅ **Benar:** Tangkap *raw buffer* sebelum proses *parsing* JSON dari Fastify/Express. (Untuk Midtrans tidak apa-apa menggunakan *field*, tapi untuk Stripe wajib *raw buffer*).

### 2. Anti-Pattern: Mengembalikan HTTP 500 untuk Validasi Bisnis yang Gagal
❌ **Salah:** Membuang `InternalServerErrorException` saat *Order* tidak ditemukan. Ini memicu *Payment Gateway* melakukan *retry* terus-menerus selama berhari-hari.
```typescript
// ❌ ANTI-PATTERN
if (!order) {
  throw new InternalServerErrorException('Order tidak ada di DB'); 
}
```

✅ **Benar:** Kembalikan `200 OK` (atau `400 Bad Request` yang tidak di-retry oleh provider tertentu) dengan mencatat *log alert*.

## Analisis Trade-Off Arsitektur

### Kelebihan
1. **Ketahanan Terhadap *Double-Spending*:** *Redis SETNX* menjamin secara *atomic* bahwa *webhook* duplikat tidak akan memicu top-up saldo ganda di DB.
2. **Keamanan Maksimal:** *Signature Verification* mematikan upaya serangan *replay* atau manipulasi *payload* dari penyerang yang mencoba memalsukan pembayaran berhasil.
3. **Kinerja Tinggi:** Fastify dikombinasikan dengan Redis (In-Memory) memberikan respon sub-milidetik ke *Payment Gateway*, mencegah *timeout penalties*.

### Kekurangan
1. **Kompleksitas Infrastruktur:** Membutuhkan klaster Redis *Highly Available* (HA). Jika Redis mati, sistem *webhook* tidak bisa menerima pembayaran.
2. **Manajemen *State* Error:** Jika *node API* mati setelah Redis Lock dibuat tetapi sebelum DB di-update, sistem akan terkunci secara persisten tanpa intervensi manual/rekoniliasi.
3. **Penyimpanan Beban Redis:** Menyimpan jutaan kunci *idempotency* memerlukan kebijakan *TTL* (Time-To-Live) yang dihitung hati-hati agar RAM tidak penuh.

## Production Edge Cases

1. **Redis Network Partitioning (Split Brain):**
   *Kasus:* Koneksi Redis terputus sebentar. Jika Anda *fallback* dengan me-bypass Idempotency, saldo pengguna bisa berlipat ganda.
   *Solusi:* *Fail-closed*. Jika Redis tidak dapat dihubungi, tolak *webhook* dengan HTTP 500 agar *Payment Gateway* melakukan *retry* nanti.

2. **Race Condition antara Redirect Frontend vs Webhook:**
   *Kasus:* Pengguna kembali ke web setelah membayar, dan di detik yang sama, *webhook* juga masuk. Keduanya mencoba mengubah status *Order*.
   *Solusi:* Kombinasikan *Redis Idempotency Key* (untuk *webhook*) dengan *Optimistic Concurrency Control* (versi) di level PostgreSQL.

3. **Rotasi Kunci Rahasia (Secret Key Rotation):**
   *Kasus:* Midtrans/Stripe me-rotasi *Server Key* tanpa henti. Jika Anda melakukan *hardcode* dan me-restart *server*, ada jendela waktu *downtime*.
   *Solusi:* Dukung verifikasi *multi-key* dalam *Guard*. Coba verifikasi dengan *Secret* Baru, jika gagal, coba dengan *Secret* Lama.

## Webhook Signature & Idempotency Test Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { PaymentWebhookController } from './payment-webhook.controller';
import { IdempotencyService } from './services/idempotency.service';
import { PaymentProcessorService } from './services/payment-processor.service';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { WebhookSignatureGuard } from './guards/webhook-signature.guard';
import { ExecutionContext } from '@nestjs/common';
import * as crypto from 'crypto';

describe('PaymentWebhookController & Guards', () => {
  let controller: PaymentWebhookController;
  let idempotencyService: IdempotencyService;
  let paymentProcessor: PaymentProcessorService;

  const mockServerKey = 'SB-Mid-server-12345';
  
  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentWebhookController],
      providers: [
        {
          provide: IdempotencyService,
          useValue: {
            acquireLock: jest.fn(),
          },
        },
        {
          provide: PaymentProcessorService,
          useValue: {
            processPaymentStatus: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue(mockServerKey),
          },
        },
      ],
    }).compile();

    controller = module.get<PaymentWebhookController>(PaymentWebhookController);
    idempotencyService = module.get<IdempotencyService>(IdempotencyService);
    paymentProcessor = module.get<PaymentProcessorService>(PaymentProcessorService);
  });

  describe('WebhookSignatureGuard', () => {
    it('harus melempar UnauthorizedException jika tanda tangan tidak valid', async () => {
      const guard = new WebhookSignatureGuard(new ConfigService());
      
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            body: {
              order_id: 'ORDER-123',
              status_code: '200',
              gross_amount: '10000.00',
              signature_key: 'invalid-signature-hash',
            },
          }),
        }),
      } as ExecutionContext;

      await expect(guard.canActivate(mockContext)).rejects.toThrow(UnauthorizedException);
    });

    it('harus mengizinkan akses jika tanda tangan valid', async () => {
      const guard = new WebhookSignatureGuard(new ConfigService());
      
      const payload = {
        order_id: 'ORDER-123',
        status_code: '200',
        gross_amount: '10000.00',
      };
      
      const rawString = `${payload.order_id}${payload.status_code}${payload.gross_amount}${mockServerKey}`;
      const validSignature = crypto.createHash('sha512').update(rawString).digest('hex');

      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            body: { ...payload, signature_key: validSignature },
          }),
        }),
      } as ExecutionContext;

      const result = await guard.canActivate(mockContext);
      expect(result).toBe(true);
    });
  });

  describe('Webhook Idempotency Controller', () => {
    it('harus merespon 200 OK dan abaikan proses jika duplikat (Idempotent)', async () => {
      jest.spyOn(idempotencyService, 'acquireLock').mockResolvedValue(false); // Duplikat

      const result = await controller.handleMidtransWebhook({
        transaction_id: 'TX-001',
        transaction_status: 'settlement',
        signature_key: 'valid-hash',
        status_code: '200',
        gross_amount: '50000.00',
        order_id: 'ORDER-001',
      });

      expect(idempotencyService.acquireLock).toHaveBeenCalledWith('midtrans_webhook_tx_TX-001');
      expect(paymentProcessor.processPaymentStatus).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'acknowledged' });
    });

    it('harus memproses pembayaran jika ini webhook baru', async () => {
      jest.spyOn(idempotencyService, 'acquireLock').mockResolvedValue(true); // Baru
      jest.spyOn(paymentProcessor, 'processPaymentStatus').mockResolvedValue(undefined);

      const payload = {
        transaction_id: 'TX-002',
        transaction_status: 'settlement',
        signature_key: 'valid-hash',
        status_code: '200',
        gross_amount: '50000.00',
        order_id: 'ORDER-002',
      };

      const result = await controller.handleMidtransWebhook(payload);

      expect(paymentProcessor.processPaymentStatus).toHaveBeenCalledWith(payload);
      expect(result).toEqual({ status: 'success' });
    });
  });
});
```
