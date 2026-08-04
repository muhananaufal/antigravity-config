# Pengamanan Rute WebSocket Gateway Menggunakan WsGuard di NestJS

Dokumen ini mendefinisikan standar **Top 1% Engineering** untuk mengamankan komunikasi WebSocket di NestJS menggunakan `WsGuard`. Pengamanan ini krusial karena koneksi WebSocket sifatnya persisten dan rentan terhadap berbagai serangan seperti DoS, pembajakan sesi, dan *resource exhaustion*. Kita akan menerapkan verifikasi JWT yang ketat pada *handshake* dan proteksi tingkat pesan (*message-level*).

## Arsitektur Alur Keamanan WebSocket

```ascii
+-------------------+       Handshake (HTTP Upgrade)       +-----------------------+
|                   | -----------------------------------> |                       |
|   Client (Browser/|       [URL Query: ?token=JWT]        |   NestJS HTTP Server  |
|   Mobile App)     | <----------------------------------- |                       |
|                   |        101 Switching Protocols       +-----------+-----------+
+---------+---------+                                                  |
          |                                                            |
          |                                                   +--------v--------+
          |                  WebSocket Frame                  |                 |
          +-------------------------------------------------> |   WsAuthGuard   |
                    [Event: 'message', Data: Payload]         | (JWT Validator) |
                                                              |                 |
                                                              +--------+--------+
                                                                       |
                                                              +--------v--------+
                                                              |                 |
                                                              | WsThrottlerGuard|
                                                              | (Rate Limiting) |
                                                              |                 |
                                                              +--------+--------+
                                                                       |
                                                              +--------v--------+
                                                              |                 |
                                                              | @SubscribeMessage|
                                                              |  (Gateway Logic)|
                                                              +-----------------+
```

## Implementasi `WsGuard` dan Gateway

Berikut adalah implementasi lengkap untuk pengamanan *gateway* menggunakan verifikasi JWT dan pembatasan laju (*rate limiting*).

```typescript
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UseGuards,
  UseFilters,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { Observable } from 'rxjs';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  BaseWsExceptionFilter,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';

// 1. Interfaces
export interface JwtPayload {
  readonly sub: string;
  readonly email: string;
  readonly role: string;
}

export interface AuthenticatedSocket extends Socket {
  user?: JwtPayload;
}

// 2. WsGuard Implementation
@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'ws') {
      return true;
    }

    const client: AuthenticatedSocket = context.switchToWs().getClient<AuthenticatedSocket>();
    const token = this.extractTokenFromClient(client);

    if (!token) {
      this.logger.warn(`Koneksi ditolak: Token tidak ditemukan (Socket ID: ${client.id})`);
      throw new WsException('Unauthorized: Missing Authentication Token');
    }

    try {
      const secret = this.configService.get<string>('JWT_SECRET');
      if (!secret) {
        throw new Error('Konfigurasi JWT_SECRET tidak ditemukan');
      }

      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: secret,
      });
      
      client.user = payload;
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`Autentikasi gagal untuk socket ${client.id}: ${errorMessage}`);
      throw new WsException('Unauthorized: Invalid or Expired Token');
    }
  }

  private extractTokenFromClient(client: AuthenticatedSocket): string | null {
    // Mencoba mengambil dari handshake auth, lalu fallback ke query
    const authHeader = client.handshake.auth?.token as string | undefined;
    const queryToken = client.handshake.query?.token as string | undefined;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.split(' ')[1];
    }
    
    if (queryToken) {
      return queryToken;
    }
    
    return null;
  }
}

// 3. Ws Throttler Guard (Rate Limiting)
@Injectable()
export class WsThrottlerGuard extends ThrottlerGuard {
  protected async handleRequest(
    context: ExecutionContext,
    limit: number,
    ttl: number,
    throttler: any,
  ): Promise<boolean> {
    const client = context.switchToWs().getClient<AuthenticatedSocket>();
    const ip = client.handshake.address;
    
    // Implementasi manual pengecekan throttler
    // Catatan: Ini adalah adaptasi abstrak untuk WS, bergantung pada store throttler.
    const key = this.generateKey(context, ip, throttler.name);
    const { totalHits } = await this.storageService.increment(key, ttl);
    
    if (totalHits > limit) {
      throw new WsException('Too Many Requests');
    }
    return true;
  }
}

// 4. WebSocket Gateway Implementation
@UseFilters(new BaseWsExceptionFilter())
@WebSocketGateway({
  cors: {
    origin: '*', // Sebaiknya dikonfigurasi via env di production
    credentials: true,
  },
  namespace: '/secure-events',
})
export class SecureEventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  public readonly server!: Server;
  
  private readonly logger = new Logger(SecureEventsGateway.name);

  constructor(private readonly jwtService: JwtService, private readonly configService: ConfigService) {}

  public async handleConnection(client: AuthenticatedSocket): Promise<void> {
    this.logger.log(`Klien mencoba terhubung: ${client.id}`);
    
    // Autentikasi manual saat fase Handshake
    try {
      const tokenHeader = client.handshake.auth?.token as string | undefined;
      const tokenQuery = client.handshake.query?.token as string | undefined;
      let token = tokenHeader?.startsWith('Bearer ') ? tokenHeader.split(' ')[1] : (tokenQuery || null);

      if (!token) {
        throw new WsException('Token tidak ditemukan saat handshake');
      }

      const secret = this.configService.get<string>('JWT_SECRET') ?? '';
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, { secret });
      client.user = payload;
      
      this.logger.log(`Klien terautentikasi: ${client.id} (User: ${payload.sub})`);
    } catch (error) {
      this.logger.error(`Handshake ditolak untuk ${client.id}: ${(error as Error).message}`);
      client.disconnect(true);
    }
  }

  public handleDisconnect(client: AuthenticatedSocket): void {
    this.logger.log(`Klien terputus: ${client.id}`);
  }

  @UseGuards(WsJwtGuard, WsThrottlerGuard)
  @SubscribeMessage('send_secure_message')
  public handleSecureMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: { content: string },
  ): { status: string; received: string; user: string } {
    if (!client.user) {
      throw new WsException('User not authenticated in context');
    }

    this.logger.log(`Pesan dari ${client.user.sub}: ${payload.content}`);
    
    return {
      status: 'success',
      received: payload.content,
      user: client.user.sub,
    };
  }
}
```

## Unit Test & Mocking WebSocket Gateway

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { SecureEventsGateway, WsJwtGuard, AuthenticatedSocket } from './secure-events.gateway';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { WsException } from '@nestjs/websockets';

describe('SecureEventsGateway', () => {
  let gateway: SecureEventsGateway;
  let jwtService: jest.Mocked<JwtService>;

  beforeEach(async () => {
    const mockJwtService = {
      verifyAsync: jest.fn(),
    };
    
    const mockConfigService = {
      get: jest.fn().mockReturnValue('super-secret'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SecureEventsGateway,
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    gateway = module.get<SecureEventsGateway>(SecureEventsGateway);
    jwtService = module.get(JwtService);
  });

  it('harus menolak koneksi jika token tidak valid', async () => {
    const mockClient = {
      id: 'socket-1',
      handshake: { auth: {}, query: {} },
      disconnect: jest.fn(),
    } as unknown as AuthenticatedSocket;

    await gateway.handleConnection(mockClient);
    
    expect(mockClient.disconnect).toHaveBeenCalledWith(true);
  });

  it('harus menerima pesan jika guard meloloskan socket yang memiliki user', () => {
    const mockClient = {
      id: 'socket-1',
      user: { sub: 'user-1', email: 'test@test.com', role: 'USER' },
    } as AuthenticatedSocket;

    const result = gateway.handleSecureMessage(mockClient, { content: 'hello' });
    
    expect(result).toEqual({
      status: 'success',
      received: 'hello',
      user: 'user-1',
    });
  });
});
```

## Analisis Trade-Off

### Kelebihan
1. **Keamanan Ekstraktif Tinggi:** Mencegah akses tak sah pada lapisan *handshake*, menolak koneksi bahkan sebelum soket stabil (menghemat sumber daya server).
2. **Konteks Stateful:** Informasi pengguna (`client.user`) tertanam langsung pada objek soket, mempermudah validasi otorisasi di seluruh metode `@SubscribeMessage`.
3. **Pemisahan Kekhawatiran (SoC):** Penanganan otentikasi dipisahkan secara rapi ke dalam `WsGuard`, yang membuat logika Gateway tetap bersih dan berfokus pada domain bisnis.

### Kekurangan
1. **Kompleksitas Distribusi Token:** Klien WebSocket browser (*native*) tidak mendukung penambahan *Header* khusus. Token seringkali harus dikirim via *Query Params* yang berisiko tercatat di log server.
2. **Overhead CPU Tambahan:** Verifikasi kriptografi JWT pada setiap koneksi baru membebani CPU, terutama saat terjadi lonjakan rekoneksi massal.
3. **Invalidasi Agak Sulit:** Jika JWT di-revoke (misal user logout), koneksi WebSocket yang sudah terjalin tetap hidup karena JWT tidak dicek ulang setiap saat kecuali dipaksa.

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menyimpan Kredensial Sensitif di Log atau Payload
Membiarkan token terlihat di log atau tidak menghapusnya dari struktur saat serialisasi adalah praktik yang buruk.

```typescript
// SALAH: Logging seluruh objek handshake yang mencakup JWT token
public async handleConnection(client: Socket) {
  this.logger.log(`Koneksi dari: ${JSON.stringify(client.handshake)}`); // BAHAYA KEBOCORAN TOKEN!
}
```

```typescript
// BENAR: Ekstrak hanya informasi yang aman dan hindari logging token
public async handleConnection(client: Socket) {
  this.logger.log(`Koneksi dari IP: ${client.handshake.address} ID: ${client.id}`); 
}
```

### ❌ Anti-Pattern 2: Tidak Menggunakan Error Handling yang Spesifik di WsGuard
Mengembalikan nilai `false` biasa pada Guard WebSocket seringkali menyebabkan koneksi tidak merespons secara informatif (*silent failure*), berbeda dengan HTTP.

```typescript
// SALAH: Mengembalikan false tanpa throw WsException
if (!isValid) {
  return false; // Klien tidak tahu apa yang salah
}
```

```typescript
// BENAR: Melemparkan exception WS yang tertangkap oleh WsExceptionFilter
if (!isValid) {
  throw new WsException({ status: 'error', message: 'Token Kadaluarsa' });
}
```

## Production Edge Cases

1. **Mass Disconnect & Reconnect Storms (The Thundering Herd):** Saat server *restart*, ribuan klien akan mencoba terhubung kembali di saat bersamaan. Verifikasi JWT massal bisa menghabiskan *Event Loop*.
   - **Mitigasi:** Gunakan algoritma *exponential backoff* di sisi klien (seperti *socket.io-client* secara *default*), dan gunakan implementasi verifikasi asinkron non-blocking yang dipartisi.
2. **Token Expiration on Active Sockets:** Pengguna sedang aktif mengirim pesan, namun JWT-nya telah *expired* 10 menit lalu. Karena WebSocket persisten, koneksi tetap berjalan dan mengabaikan batas kedaluwarsa otentikasi.
   - **Mitigasi:** Terapkan pembaruan token berkala (*periodic re-authentication*) melalui kanal *event* khusus, atau jalankan *cron job* internal server yang memeriksa kedaluwarsa JWT dari memori untuk mendiskoneksikan soket secara paksa.
3. **Log Poisoning & Injection melalui Query Params:** Token JWT dikirim via URL Parameter (`ws://.../?token=...`). Penyerang dapat mengirim *payload* raksasa (>10MB) sebagai token yang memicu *out-of-memory* atau menumbangkan *logger*.
   - **Mitigasi:** Batasi panjang string parameter pada tingkat Ingress/NGINX atau segera *drop* koneksi di Gateway jika panjang parameter `token` melampaui batas waras (misal > 2048 karakter).
