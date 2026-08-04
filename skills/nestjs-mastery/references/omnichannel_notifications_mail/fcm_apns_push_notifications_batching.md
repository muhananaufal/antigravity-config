# Sistem Push Notification Skala Masif (FCM/APNs Batching) di NestJS

Dokumen referensi ini menguraikan arsitektur untuk memancarkan Push Notification ke jutaan perangkat (iOS/Android) secara serempak melalui Firebase Cloud Messaging (FCM) dan APNs dengan teknik batch chunking.

## Arsitektur Sistem Push Notification

```ascii
[Notification Trigger] -> (Generate Payload)
                               |
                               v
                       [PushQueue: BullMQ]
                               |
                   +-----------+-----------+
                   |                       |
            [Worker Node 1]         [Worker Node 2]
                   | (Fetch Device Tokens from DB)
                   v
           [Batching Engine] (Chunk array of tokens to 500)
                   |
     +-------------+-------------+
     | (FCM HTTP v1)             | (APNs HTTP/2)
   [FCM API]                 [APNs Server]
     |                           |
[Android Devices]           [iOS Devices]
     |                           |
     v (Feedback / Errors)       v
[Token Invalidation Service] (Remove stale tokens from DB)
```

## Implementasi Kode Produksi (TypeScript 5+ & NestJS 10+)

```typescript
import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { ConfigService } from '@nestjs/config';

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  tokens: string[];
}

export interface BatchSendResult {
  successCount: number;
  failureCount: number;
  invalidTokens: string[];
}

@Injectable()
export class PushNotificationService {
  private readonly logger = new Logger(PushNotificationService.name);
  private firebaseApp: admin.app.App;

  constructor(private configService: ConfigService) {
    const projectId = this.configService.getOrThrow<string>('FIREBASE_PROJECT_ID');
    const clientEmail = this.configService.getOrThrow<string>('FIREBASE_CLIENT_EMAIL');
    // Important: replace \\n with \n in the private key from env
    const privateKey = this.configService.getOrThrow<string>('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n');

    if (!admin.apps.length) {
      this.firebaseApp = admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
    } else {
      this.firebaseApp = admin.app();
    }
  }

  /**
   * Mengirim push notification dalam batch 500 token (Batas Maksimal FCM)
   */
  async sendBatchNotification(payload: PushNotificationPayload): Promise<BatchSendResult> {
    const { title, body, data, tokens } = payload;
    const CHUNK_SIZE = 500;
    
    let totalSuccess = 0;
    let totalFailure = 0;
    const allInvalidTokens: string[] = [];

    // Proses chunking
    for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
      const tokenChunk = tokens.slice(i, i + CHUNK_SIZE);
      
      const message: admin.messaging.MulticastMessage = {
        notification: { title, body },
        data: data || {},
        tokens: tokenChunk,
        android: {
          priority: 'high',
        },
        apns: {
          payload: {
            aps: { sound: 'default' },
          },
        },
      };

      try {
        const response = await this.firebaseApp.messaging().sendEachForMulticast(message);
        
        totalSuccess += response.successCount;
        totalFailure += response.failureCount;

        if (response.failureCount > 0) {
          response.responses.forEach((resp, idx) => {
            if (!resp.success && resp.error) {
              const errorCode = resp.error.code;
              // Identifikasi token yang sudah tidak valid/kedaluwarsa
              if (
                errorCode === 'messaging/invalid-registration-token' ||
                errorCode === 'messaging/registration-token-not-registered'
              ) {
                allInvalidTokens.push(tokenChunk[idx]);
              }
            }
          });
        }
      } catch (error) {
        this.logger.error(`Failed to send chunk starting at index ${i}`, (error as Error).stack);
        throw error;
      }
    }

    // Panggil servis lain di background untuk menghapus invalid tokens dari DB
    if (allInvalidTokens.length > 0) {
      this.logger.warn(`Found ${allInvalidTokens.length} invalid tokens to prune.`);
      // await this.tokenService.removeTokens(allInvalidTokens);
    }

    return {
      successCount: totalSuccess,
      failureCount: totalFailure,
      invalidTokens: allInvalidTokens,
    };
  }
}
```

## Unit / Mock Test Suite (Jest)

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PushNotificationService } from './push-notification.service';
import * as admin from 'firebase-admin';

// Mock Firebase Admin
jest.mock('firebase-admin', () => {
  const sendEachForMulticastMock = jest.fn();
  return {
    apps: [],
    initializeApp: jest.fn(),
    credential: { cert: jest.fn() },
    messaging: () => ({
      sendEachForMulticast: sendEachForMulticastMock,
    }),
  };
});

describe('PushNotificationService', () => {
  let service: PushNotificationService;
  let configService: ConfigService;

  beforeEach(async () => {
    const mockConfigService = {
      getOrThrow: jest.fn().mockImplementation((key) => {
        if (key === 'FIREBASE_PRIVATE_KEY') return 'mock-private-key';
        return `mock-${key}`;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushNotificationService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<PushNotificationService>(PushNotificationService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should process batch sending correctly and identify invalid tokens', async () => {
    const fcmMessagingMock = admin.messaging().sendEachForMulticast as jest.Mock;
    
    fcmMessagingMock.mockResolvedValue({
      successCount: 1,
      failureCount: 1,
      responses: [
        { success: true },
        { success: false, error: { code: 'messaging/registration-token-not-registered' } }
      ]
    });

    const result = await service.sendBatchNotification({
      title: 'Test',
      body: 'Test Body',
      tokens: ['valid-token', 'invalid-token']
    });

    expect(fcmMessagingMock).toHaveBeenCalledTimes(1);
    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(1);
    expect(result.invalidTokens).toEqual(['invalid-token']);
  });
});
```

## Analisis Trade-Off

### Kelebihan
1. **Efisiensi Tinggi:** Memanfaatkan HTTP v1 FCM API secara bulk (`sendEachForMulticast`) mengurangi jumlah koneksi TCP dan I/O, sangat cepat.
2. **Pembersihan Otomatis:** Deteksi presisi untuk token kedaluwarsa (`invalid-registration-token`) menjaga kebersihan database dan mencegah pengiriman sia-sia.
3. **Penyesuaian Ekosistem:** Mendukung payload spesifik platform (Android Priority, APNs Sound) dalam satu objek payload (Polymorphic).

### Kekurangan
1. **Ukuran Payload Terbatas:** FCM membatasi ukuran payload data (maksimal 4KB). Tidak cocok untuk mengirim data besar.
2. **Ketergantungan Ekosistem:** Sangat bergantung pada ketersediaan dan aturan Firebase/Apple; perubahan API mereka dapat memutus sistem.
3. **Kegagalan Parsial (Partial Failure):** Dalam 1 batch 500 token, beberapa bisa berhasil dan beberapa gagal. Mengelola ulang iterasi kegagalan membutuhkan logika retry yang kompleks.

## Anti-Patterns & Best Practices

### Anti-Pattern 1: Loop Sekuensial untuk Mengirim Pesan
❌ **Salah:** Mengirim push satu per satu menggunakan koneksi terpisah.
```typescript
for (const token of tokens) {
  await admin.messaging().send({ token, notification: { title, body } }); // SANGAT LAMBAT!
}
```
✅ **Benar:** Melakukan chunking array token dan memanggil `sendEachForMulticast`.

### Anti-Pattern 2: Mengabaikan Error Token
❌ **Salah:** Tidak mengekstrak dan menghapus token yang gagal dari respons FCM. Database token akan membengkak dengan data kedaluwarsa, yang memperlambat query & API.
✅ **Benar:** Melakukan iterasi pada response FCM dan mem-prune token yang `not-registered`.

## Production Edge Cases
1. **Timeout Jaringan Saat Batch Besar:** Pengiriman chunk batch > 10,000 device bisa menyebabkan timeout HTTP jika network tersendat. Perlu dipecah melalui antrian parallel BullMQ (misal 20 worker masing-masing menangani 1 batch).
2. **Throttling Apple (APNs):** APNs sangat sensitif terhadap terlalu banyak invalid token. Jika tidak diprune secara proaktif, Apple dapat memblokir sertifikat server Anda (APNs connection close).
3. **Overriding Topik Pub-Sub:** Saat menggunakan fitur Topik (`/topics/news`), terkadang payload spesifik pengguna tidak bisa ditimpa. Pendekatan token-based chunking lebih superior daripada topik untuk personalisasi ekstrem (Notification override per user).
