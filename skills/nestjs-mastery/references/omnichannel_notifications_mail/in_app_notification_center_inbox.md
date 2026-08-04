# Sistem Lonceng Notifikasi In-App Real-time (WebSocket & Inbox Zero)

Referensi top tier ini memandu implementasi in-app notification center yang mirip dengan milik Facebook/LinkedIn. Menggabungkan arsitektur push secara waktu-nyata via WebSocket, manajemen state dibaca/belum-dibaca, dan prunning history untuk performa basis data relasional.

## Arsitektur Sistem Lonceng Notifikasi

```ascii
[Client App / Browser]
        ^  | (WebSocket Connect)
        |  v
  [WebSocket Gateway (Socket.IO / ws)]
        |  ^
        |  | (Subscribe to User Room)
        v  |
   [Redis Pub/Sub] <-------+
                           | (Publish Event)
                     [NotificationEngineService]
                           ^
                           | (Persist to DB)
                           v
                   [PostgreSQL DB]
                    - notifications
                    - user_notification_status (read tracking)
```

## Implementasi Kode Produksi (TypeScript 5+ & NestJS 10+)

```typescript
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger, UseGuards } from '@nestjs/common';
// import { WsJwtGuard } from './ws-jwt.guard'; // Assume proper Auth Guard

export interface NotificationPayload {
  id: string;
  userId: string;
  type: 'alert' | 'message' | 'system';
  title: string;
  content: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  isRead: boolean;
}

@Injectable()
export class InAppNotificationService {
  private readonly logger = new Logger(InAppNotificationService.name);
  
  // Dalam production, inject Repository/PrismaService
  // constructor(private prisma: PrismaService) {}

  async createAndBroadcast(payload: Omit<NotificationPayload, 'id' | 'createdAt' | 'isRead'>, gateway: NotificationGateway) {
    // 1. Persist to Database (Mocking DB save)
    const newNotification: NotificationPayload = {
      id: crypto.randomUUID(),
      ...payload,
      createdAt: new Date(),
      isRead: false,
    };
    
    // await this.prisma.notification.create({ data: newNotification });

    // 2. Broadcast via WebSocket Gateway
    gateway.emitToUser(payload.userId, 'new_notification', newNotification);
    this.logger.log(`Broadcasted notification to user ${payload.userId}`);
    
    return newNotification;
  }

  async markAsRead(userId: string, notificationId: string) {
    // await this.prisma.notification.update({ where: { id: notificationId, userId }, data: { isRead: true }});
    return { success: true };
  }
}

// @UseGuards(WsJwtGuard) // Protect gateway
@WebSocketGateway({
  cors: {
    origin: '*',
  },
  namespace: '/notifications',
})
export class NotificationGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;
  
  private readonly logger = new Logger(NotificationGateway.name);

  handleConnection(client: Socket) {
    // Ekstraksi userId dari token (diatur oleh WsJwtGuard / middleware)
    const userId = client.handshake.auth.userId as string;
    if (userId) {
      client.join(`user_${userId}`);
      this.logger.log(`Client ${client.id} joined room user_${userId}`);
    } else {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client ${client.id} disconnected`);
  }

  emitToUser(userId: string, event: string, payload: any) {
    this.server.to(`user_${userId}`).emit(event, payload);
  }

  @SubscribeMessage('mark_read')
  async handleMarkRead(@ConnectedSocket() client: Socket, @MessageBody() data: { notificationId: string }) {
    const userId = client.handshake.auth.userId as string;
    // Panggil Service DB (mocking console.log for structure)
    // await this.notificationService.markAsRead(userId, data.notificationId);
    
    // Feedback ke client bahwa sukses diupdate
    return { event: 'notification_updated', data: { id: data.notificationId, isRead: true } };
  }
}
```

## Unit / Mock Test Suite (Jest)

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { InAppNotificationService, NotificationGateway } from './in-app-notification';
import { Server } from 'socket.io';

describe('InAppNotification Engine', () => {
  let service: InAppNotificationService;
  let gateway: NotificationGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [InAppNotificationService, NotificationGateway],
    }).compile();

    service = module.get<InAppNotificationService>(InAppNotificationService);
    gateway = module.get<NotificationGateway>(NotificationGateway);
    
    // Mock WebSocket Server
    gateway.server = {
      to: jest.fn().mockReturnValue({
        emit: jest.fn(),
      }),
    } as unknown as Server;
  });

  it('should save notification and emit to user room', async () => {
    const mockPayload = {
      userId: 'user-123',
      type: 'alert' as const,
      title: 'Test',
      content: 'Hello World',
    };

    const result = await service.createAndBroadcast(mockPayload, gateway);

    expect(result.id).toBeDefined();
    expect(result.userId).toBe('user-123');
    expect(result.isRead).toBe(false);

    expect(gateway.server.to).toHaveBeenCalledWith('user_user-123');
    expect((gateway.server.to('user_user-123') as any).emit).toHaveBeenCalledWith('new_notification', result);
  });
});
```

## Analisis Trade-Off

### Kelebihan
1. **Real-time UX:** User menerima umpan balik instan tanpa perlu memuat ulang halaman (Polling free).
2. **Inbox Zero Psikologi:** Counter "unread" badge langsung ter-update secara akurat dengan sinkronisasi dual-way.
3. **Efisiensi Server:** Menghindari badai HTTP Polling dari klien yang mengecek "Apakah ada notifikasi baru?".

### Kekurangan
1. **Manajemen Koneksi Berat (Stateful):** Memelihara jutaan koneksi WebSockets terbuka mengkonsumsi memori RAM (file descriptors) tinggi di server.
2. **Ketergantungan Redis Adapter:** Untuk men-scale WebSocket node secara horizontal (multi-instance), wajib mengkonfigurasi `RedisAdapter` (socket.io-redis) agar pub/sub sampai ke semua node.
3. **Sinkronisasi State yang Kompleks:** Jika koneksi websocket terputus sementara (flaky connection) saat ada pesan masuk, client perlu melakukan HTTP fetch `sync` saat reconnect.

## Anti-Patterns & Best Practices

### Anti-Pattern 1: Data Retensi Tak Terbatas
❌ **Salah:** Tidak pernah menghapus tabel `notifications`. Jika sistem mengirim ribuan notifikasi per hari, dalam setahun tabel akan bloated dan merusak performa join query.
✅ **Benar:** Menjadwalkan Cron Job (menggunakan `@nestjs/schedule`) untuk melakukan soft-delete/hard-delete (Retention Pruning) pada notifikasi yang berumur lebih dari 30 hari.

### Anti-Pattern 2: Global Broadcasting untuk Personal Data
❌ **Salah:** Meng-emit notifikasi personal ke namespace root `/` tanpa pemisahan Room, menyebabkan klien lain bisa menguping data privat.
```typescript
this.server.emit('notification', privateData); // BAHAYA!
```
✅ **Benar:** Wajib menggunakan isolasi Room berbasis User ID terenkripsi.
```typescript
this.server.to(`user_${userId}`).emit('notification', privateData);
```

## Production Edge Cases
1. **Badge Counter Out-of-Sync:** Jika pengguna membuka aplikasi di Tab A dan Tab B, menekan "read" di Tab A harus memicu *broadcast "mark_read" ke dirinya sendiri* sehingga Tab B ikut merespons dan menurunkan counter (optimistic UI update).
2. **Race Conditions Saat Penulisan DB:** Jika sebuah sistem Batch mem-publish 100 notifikasi kepada satu orang di detik yang sama, query insert ke PostgreSQL bisa menyebabkan Deadlock atau membebani CPU. Gunakan strategi bulk insert `insertMany` lalu trigger 1 websocket message array `new_notifications_batch`.
3. **Mobile App Background State:** WebSockets akan terbunuh (terputus) oleh OS (iOS/Android) saat aplikasi masuk *background mode*. Harus dikombinasikan dengan Push Notification (FCM/APNs) untuk membangunkan klien, baru melakukan HTTP fetch notifikasi terbaru saat *app resumes*.
