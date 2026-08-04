# Skala Horizontal Rute WebSocket via Redis Pub/Sub (WsAdapter Cluster)

Dokumen ini mendefinisikan standar **Top 1% Engineering** untuk membangun jaringan *Real-time Socket* terdistribusi yang sangat diskalakan di NestJS. Saat Anda mengerahkan (deploy) aplikasi di atas Kubernetes atau lebih dari satu simpul (*node*), klien dapat terhubung secara acak ke *Pod A* sementara peristiwa dikirimkan dari *Pod B*. Kita harus menggunakan **Redis Pub/Sub** agar siaran (*broadcast*) pesan tersalurkan merata ke seluruh *node* (klasterisasi).

## Arsitektur Skala Horizontal WebSocket

```ascii
                                +-------------------+
                                |                   |
+-------------------+           |   Redis Server    |            +-------------------+
|                   | <-------+ |  (Pub/Sub Broker) | +--------> |                   |
|   Client 1 (Bob)  |           |                   |            |  Client 2 (Alice) |
|                   |           +---------+---------+            |                   |
+---------+---------+                     |                      +---------+---------+
          | (WS Connect)                  |                                | (WS Connect)
          |                               |                                |
+---------v---------+                     |                      +---------v---------+
|                   | (Publish Event)     |    (Subscribe Event) |                   |
| NestJS Pod A (WS) | +-------------------+--------------------> | NestJS Pod B (WS) |
|   (Socket.IO/ws)  |                                            |   (Socket.IO/ws)  |
+-------------------+                                            +-------------------+
```

## Implementasi Redis IoAdapter (Socket.io) Khusus

Di sini kita menginisialisasi `RedisIoAdapter` khusus yang mengikat peladen WebSocket internal NestJS (`@nestjs/platform-socket.io`) dengan klien ioredis ganda (satu untuk mempublikasikan, satu untuk melanggan) guna meneruskan lalu lintas.

```typescript
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { Logger, INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// 1. Adapter Implementation
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter> | undefined;
  private readonly logger = new Logger(RedisIoAdapter.name);
  private pubClient: ReturnType<typeof createClient> | undefined;
  private subClient: ReturnType<typeof createClient> | undefined;

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  public async connectToRedis(): Promise<void> {
    const configService = this.app.get(ConfigService);
    const redisHost = configService.get<string>('REDIS_HOST') ?? 'localhost';
    const redisPort = configService.get<number>('REDIS_PORT') ?? 6379;
    const redisPassword = configService.get<string>('REDIS_PASSWORD');
    
    const redisUrl = `redis://${redisPassword ? `:${redisPassword}@` : ''}${redisHost}:${redisPort}`;

    try {
      this.pubClient = createClient({ url: redisUrl });
      this.subClient = this.pubClient.duplicate();

      this.pubClient.on('error', (err) => this.logger.error('PubClient Redis Error:', err));
      this.subClient.on('error', (err) => this.logger.error('SubClient Redis Error:', err));

      await Promise.all([this.pubClient.connect(), this.subClient.connect()]);

      // Mengaitkan Socket.io adapter factory
      this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
      this.logger.log(`Terhubung ke Redis Adapter pada ${redisHost}:${redisPort}`);
    } catch (error) {
      this.logger.error(`Gagal menghubungkan Redis Adapter: ${(error as Error).message}`);
      throw error;
    }
  }

  // Override method milik IoAdapter NestJS
  public createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    } else {
      this.logger.warn('Redis adapter tidak terinisialisasi, fallback ke memori in-process');
    }
    
    return server;
  }
}
```

### Inisialisasi di `main.ts`

```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Mengaktifkan adapter terdistribusi
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  
  app.useWebSocketAdapter(redisIoAdapter);
  
  await app.listen(3000);
}
bootstrap();
```

## Unit & Integration Test Redis Adapter (Mock)

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { RedisIoAdapter } from './redis-io.adapter';
import { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Mock modul redis murni
jest.mock('redis', () => ({
  createClient: jest.fn().mockReturnValue({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(true),
    duplicate: jest.fn().mockReturnValue({
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(true),
    }),
  }),
}));

describe('RedisIoAdapter', () => {
  let adapter: RedisIoAdapter;
  let mockAppCtx: INestApplicationContext;

  beforeEach(async () => {
    mockAppCtx = {
      get: jest.fn().mockImplementation((token) => {
        if (token === ConfigService) {
          return { get: jest.fn().mockReturnValue('localhost') };
        }
        return null;
      }),
    } as unknown as INestApplicationContext;

    adapter = new RedisIoAdapter(mockAppCtx);
  });

  it('harus membuat koneksi Pub dan Sub ke klaster Redis tanpa gagal', async () => {
    // Mengeksekusi connect logic
    await expect(adapter.connectToRedis()).resolves.not.toThrow();
  });

  it('harus menginjeksi adapter redis ke dalam konfigurasi server Socket.io', () => {
    // Menyediakan mock server objek dari super.createIOServer
    const mockAdapterSetter = jest.fn();
    const mockServer = { adapter: mockAdapterSetter };
    
    adapter['adapterConstructor'] = jest.fn() as any; // Memalsukan factory adapter telah siap
    
    // Menge-stub metode bapak (super)
    jest.spyOn(Object.getPrototypeOf(adapter), 'createIOServer').mockReturnValue(mockServer);

    adapter.createIOServer(3000, {});
    
    expect(mockAdapterSetter).toHaveBeenCalled();
  });
});
```

## Analisis Trade-Off

### Kelebihan
1. **Penskalaan Horizontal Tanpa Batas:** Memungkinkan arsitektur *Stateless Node*; *Pod* WebSocket bisa dihancurkan atau ditambah secara dinamis karena status koneksi tersinkronisasi lewat Redis.
2. **Siaran Global (Global Broadcasting):** Memancarkan *event* seperti `.emit()` atau `.broadcast.to(room)` secara instan diteruskan ke seluruh server dalam proksi NGINX/K8s, menghubungkan pengguna lintas *server*.
3. **Penggunaan Sesi Silang (Cross-Session Usage):** Layanan mikro (*Microservice*) API biasa HTTP dapat melempar pesan Redis Pub/Sub untuk memperbarui WebSocket tanpa harus membina koneksi internal yang kotor.

### Kekurangan
1. **Titik Tunggal Kegagalan (Single Point of Failure):** Jika peladen klaster Redis mati (*downtime*), seluruh kemampuan propagasi pesan lintas-*Pod* terhenti.
2. **Biaya Jaringan Tambahan:** Setiap pesan WebSocket yang di- *broadcast* akan melalui saluran kabel (I/O network) menuju Redis dan diteruskan kembali, meningkatkan latensi sistem walau sangat tipis.
3. **Memory Pressure di Broker:** Ruang kanal (rooms) dengan ribuan anggotanya dicatat di Redis, mengakibatkan penggunaan memori Redis meroket untuk instalasi multitenant berkapasitas besar.

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menyebarkan Payload Raksasa (>1MB) Melalui Redis Pub/Sub
Redis Pub/Sub bukan *message queue* berat (seperti RabbitMQ). Mengirim file biner 4MB lewat `.emit()` akan memblokir *single-threaded event loop* Redis dan menyebabkan penundaan (delay) dramatis pada pesan pengguna lain.

```typescript
// SALAH: Mem-broadcast base64 file utuh via Redis socket adapter
this.server.to('room1').emit('new_image', { data: base64Raksasa }); 
```

```typescript
// BENAR: Mengirim UUID dan meminta klien mengunduh resource raksasa dari CDN
this.server.to('room1').emit('new_image_notification', { id: 'img-1234.jpg' });
// Klien mendownload https://cdn.com/img-1234.jpg via HTTP GET
```

### ❌ Anti-Pattern 2: Tidak Menggunakan Duplicate Client
Memaksa peladen untuk memakai satu koneksi Redis *client* yang sama untuk Pub dan Sub akan memicu blokade protokol karena klien di mode *Subscribe* tidak boleh mengeksekusi komando lain.

```typescript
// SALAH: Memakai 1 klien untuk publikasi dan langganan
const client = createClient();
createAdapter(client, client); // CRASH!
```

```typescript
// BENAR: Mengkloning klien
const pubClient = createClient();
const subClient = pubClient.duplicate();
createAdapter(pubClient, subClient);
```

## Production Edge Cases

1. **Efek Split-Brain pada Redis Cluster:** Ketika arsitektur di-*deploy* menggunakan mode *Redis Cluster* beralur ganda (master-slave/sentinel) yang kehilangan konsensus sinkronisasi. Sebagian *node* WebSocket gagal mengirimkan paket *broadcast* ke sisi lain karena *Pub/Sub channels* tidak tersebar sempurna di klaster.
   - **Mitigasi:** Gunakan varian arsitektur khusus untuk redis (ioredis + mode klaster yang mendukung penanganan perutean khusus *pubsub* secara mulus).
2. **Kebocoran Redis Connections Saat Server Restart:** NestJS tidak memutus koneksi `pubClient` dan `subClient` secara rapi ketika servis di-HMR (Hot Module Replacement) pada fase *Development* atau di-*shutdown* tak wajar.
   - **Mitigasi:** Tambahkan *lifecycle hook* `OnApplicationShutdown` di `main.ts` atau kelas Adapter untuk memicu `.quit()` secara anggun.
3. **Thundering Herd "Room Join/Leave":** Kapanpun 5000 klien secara acak melakukan koneksi/diskoneksi bersamaan saat rilis fitur jam sibuk, serbuan *metadata "Join Room"* Socket.io akan membanjiri CPU Redis karena operasi serialisasi *Set* (Struktur Data).
   - **Mitigasi:** Pertimbangkan memutus penggabungan (*batching*) jika terjadi pada skala ultra, atau gunakan broker yang dirancang murni bagi WebSocket masif semacam *NATS* (bukan redis pub/sub) untuk klaster lebih dari 50,000 koneksi serentak.
