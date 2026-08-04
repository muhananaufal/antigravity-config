# Integrasi Mutakhir WebSocket: Fastify WS Adapter di NestJS

Membangun ekosistem komunikasi *real-time* dengan performa maksimum di NestJS mensyaratkan kolaborasi tangguh antara HTTP Engine dan protokol WebSocket murni. Berbeda dengan Socket.io yang memberikan lapisan tebal berupa sistem rotasi *polling* ke WS, `@fastify/websocket` menawarkan komunikasi dua arah absolut murni (*raw websocket*) dengan overhead minimal. Panduan ini menjelaskan cara memaksakan dan mengimplementasikan adapter kustom untuk NestJS.

## 1. Topologi Arsitektur WebSocket & Adapter Interface

NestJS memiliki abstraksi gerbang ganda, `WsAdapter`. Dengan menggunakan adaptor kustom yang membungkus `@fastify/websocket`, kita membuat jembatan langsung tanpa polusi pustaka eksternal.

```ascii
[Client WS/WSS] (misal: wss://api.domain.com/events)
       |
       | (Upgrade HTTP/1.1 -> WebSocket TCP)
       v
+-----------------------------------+
|      Fastify HTTP Server          |
|    (@fastify/websocket hook)      |
+-----------------------------------+
       | (Stream Soket Dibuka)
       v
+-----------------------------------+
|  NestJS WsAdapter (Custom)        |
|  (RxJS Subject/Observable Stream) |
+-----------------------------------+
       |
       v
+-----------------------------------+
| NestJS @WebSocketGateway()        |
| (Manajemen Sesi / Ruang)          |
+-----------------------------------+
```

## 2. Pembuatan Custom Fastify WsAdapter

Secara *default*, NestJS tidak membawa Adapter asli yang dirakit untuk `@fastify/websocket`. Kita wajib membuat kelas adaptor implementasi `WebSocketAdapter` kita sendiri.

```typescript
// --- 1. Adapter Implementation ---
import { WebSocketAdapter, INestApplicationContext } from '@nestjs/common';
import { MessageMappingProperties } from '@nestjs/websockets/gateway-metadata-explorer';
import { Observable, fromEvent, EMPTY } from 'rxjs';
import { mergeMap, filter } from 'rxjs/operators';
import * as WebSocket from 'ws';

export class FastifyWsAdapter implements WebSocketAdapter {
  constructor(private app: INestApplicationContext) {}

  public create(port: number, options: Record<string, unknown> = {}): any {
    // Di sini kita seharusnya mengaitkan server WS ke Instance Fastify
    // Untuk demo sederhana, Fastify HTTP server sudah mem-binding @fastify/websocket 
    // pada route spesifik. Implementasi nyata tingkat lanjut akan mengikatkan 
    // ws: true route configuration dari FastifyInstance.
    throw new Error('Gunakan Fastify adapter route decorator secara manual, atau ikat hook server instance');
  }
  
  public bindClientConnect(server: any, callback: (client: any) => void): void {
    server.on('connection', callback);
  }

  public bindMessageHandlers(
    client: WebSocket,
    handlers: MessageMappingProperties[],
    transform: (data: any) => Observable<any>,
  ): void {
    fromEvent(client, 'message')
      .pipe(
        mergeMap((data: any) => this.bindMessageHandler(data, handlers, transform, client)),
        filter((result) => result !== undefined),
      )
      .subscribe((response) => client.send(JSON.stringify(response)));
  }

  public bindMessageHandler(
    buffer: any,
    handlers: MessageMappingProperties[],
    transform: (data: any) => Observable<any>,
    client: WebSocket
  ): Observable<any> {
    try {
      const message = JSON.parse(buffer.data);
      const messageHandler = handlers.find(
        (handler) => handler.message === message.event,
      );
      if (!messageHandler) {
        return EMPTY;
      }
      return transform(messageHandler.callback(message.data, client));
    } catch {
      return EMPTY;
    }
  }

  public close(server: any): void {
    server.close();
  }
}
```

### Integrasi dengan Fastify Plugin

Karena merakit ulang lifecycle WS NestJS sangat kompleks untuk raw-WS, cara yang lebih aman di lingkungan produksi adalah **menggabungkan langsung rute WebSocket dengan FastifyPlugin**, melewati `@WebSocketGateway` secara keseluruhan demi latensi nanodetik!

```typescript
import { Controller, Injectable, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { FastifyInstance } from 'fastify';
import { SocketStream } from '@fastify/websocket';

@Injectable()
export class DirectWebsocketService implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  public onModuleInit(): void {
    const fastify: FastifyInstance = this.adapterHost.httpAdapter.getInstance();

    // Pastikan app.register(fastifyWebsocket) telah dipanggil di main.ts
    fastify.get('/v1/realtime', { websocket: true }, (connection: SocketStream, req) => {
      // Autentikasi / Rate limit bisa diperiksa dari 'req' HTTP Upgrade awal
      
      connection.socket.on('message', (message: Buffer) => {
        const messageString = message.toString();
        // Pemrosesan logik ultra-cepat (misalnya: Orderbook matching)
        
        // Echo balik
        connection.socket.send(JSON.stringify({ 
          status: 'ACK', 
          received: messageString 
        }));
      });

      connection.socket.on('close', () => {
        // Tangani pembersihan (Cleanup)
      });
    });
  }
}
```

## 3. Analisis Trade-Off WebSocket Murni

**Kelebihan:**
1. **Zero-Bloat Protocol:** Tidak ada beban pengodean pesan milik `Socket.io`. *Raw* WS memberikan throughput TCP telanjang yang krusial bagi HFT (High-Frequency Trading) dan Multiplayer Games latensi rendah.
2. **Bandwidth Jaringan Ringkas:** Tanpa siklus *handshake polling* (HTTP Long-Polling) HTTP/1.1 yang mubazir dari `Socket.io`, menghemat konsumsi koneksi TLS/TCP secara drastis.
3. **Standarisasi Bahasa Universal:** *Raw* WebSocket mudah digabungkan dengan klien C++, Rust, atau Go murni tanpa harus membawa klien SDK kustom berukuran besar (misal: socket.io-client).

**Kekurangan:**
1. **Tanpa Fitur Bawaan (No Batteries Included):** Tidak ada konsep `rooms`, `namespaces`, atau `broadcasting` yang tertanam; Anda harus membangun struktur memori penyiaran (*pub/sub*) sendiri via Redis.
2. **Ketiadaan Auto-Reconnect:** Berbeda dengan library tingkat tinggi, klien *raw* WS wajib memprogram sendiri logika jeda re-koneksi logaritmik (*exponential backoff*).
3. **Bypass NestJS Gateway:** Memakai `@fastify/websocket` di *routing* level dasar berarti Anda mengorbankan fungsionalitas dekorator NestJS (`@SubscribeMessage`, Guards otomatis, *Exception filters*).

## 4. Critical Anti-Patterns

### Anti-Pattern 1: Menyimpan Koneksi Socket di Array/Variabel Lokal Node
Menyimpan state daftar *client websocket* aktif (sebagai Array Memory) hanya akan bekerja dalam mode *single-instance*. Saat disebarkan dengan Pod K8s ganda, koneksi antar pengguna terisolasi.

❌ **Salah:** Menyimpan `connections.push(socket)` dalam variabel array lokal di memori.
```typescript
const activeSockets: SocketStream[] = [];
// Jika user A konek ke Pod 1, dan user B ke Pod 2, mereka tak bisa chat.
```

✅ **Benar:** Gunakan infrastruktur Redis Pub/Sub Adapter (Stateless WSS).
```typescript
// Setiap pesan yang masuk ke socket, dipublikasi (Publish) ke Redis Channel.
// Setiap Pod NestJS berlangganan (Subscribe) channel Redis yang sama,
// dan menyiarkannya (Broadcast) ke client lokalnya masing-masing.
```

### Anti-Pattern 2: Melupakan Penanganan "Ping/Pong" (Liveness Probe)
Sambungan *idle* TCP pada perantara (*Load Balancer*/AWS ALB/Nginx) secara otomatis akan mendrop (mematikan) koneksi WebSocket yang diam selama lebih dari 60 detik.

❌ **Salah:** Hanya menunggu `socket.on('message')`. TCP akan mati diam-diam dan membuat "Zombie Sockets" (Memory Leak).
✅ **Benar:** Kirim siklus `Ping` ke *client* setiap 30 detik. Jika dalam 10 detik *client* tidak merespons `Pong`, tutup *socket* secara paksa (Terminate).

## 5. Production Edge Cases

1. **Max Connection Spike Drowning (Thundering Herd):** Saat server *restart*, 10.0.000 *client* mencoba *reconnect* berbarengan dalam 1 detik. Server NestJS akan OOM/CPU *Lock*! Pastikan *Client* memiliki varian jeda kejut (*Jitter Backoff*).
2. **Limit Deskriptor Berkas Habis (Ulimit Exceeded):** Setiap koneksi WebSocket memakan 1 file deskriptor OS (di Linux, batas bawaannya sering kali hanya `1024`). Wajib mengatur `ulimit -n 650000` di dalam konfigurasi docker/OS *Host* Anda!
3. **Kebocoran Memori akibat Unsubscribe:** Saat *client* terputus secara kotor (mati lampu tiba-tiba), event `close` mungkin tidak tertangkap langsung. Observasi RxJS yang mengikat soket tersebut tidak termusnahkan, memori pelan-pelan bocor. Wajib menggunakan `takeUntil(disconnectEvent)` yang terikat pada *heartbeat timeout*.

## 6. Uji Integrasi Socket dengan Fastify

Kita bisa melakukan validasi *mock upgrade* WS tanpa membuka port fisik asli.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Controller, OnModuleInit } from '@nestjs/common';
import fastifyWebsocket from '@fastify/websocket';
import { HttpAdapterHost } from '@nestjs/core';

@Controller('dummy')
class DummyController implements OnModuleInit {
  constructor(private host: HttpAdapterHost) {}
  public onModuleInit() {
    const fastify = this.host.httpAdapter.getInstance();
    fastify.get('/ws', { websocket: true }, (connection: any) => {
      connection.socket.on('message', (msg: Buffer) => {
        connection.socket.send(`ECHO: ${msg.toString()}`);
      });
    });
  }
}

describe('Fastify WebSocket Test Suite', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [DummyController],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyWebsocket);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('harus memvalidasi route websocket telah terdaftar dan menerima HTTP upgrade', async () => {
    const fastify = app.getHttpAdapter().getInstance();
    
    // Inject request untuk HTTP Upgrade simulation
    const response = await fastify.inject({
      method: 'GET',
      url: '/ws',
      headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', // Dummy base64 ws key
      }
    });

    // Validasi bahwa Fastify bersedia untuk switch protocols (101)
    expect(response.statusCode).toBe(101);
    expect(response.headers.upgrade).toBe('websocket');
    expect(response.headers.connection?.toLowerCase()).toBe('upgrade');
  });
});
```

*Side Note: Menggunakan WebSocket Adapter mentah memerlukan kehati-hatian tingkat tinggi. Selalu uji sistem penanganan pesan terisolasi secara menyeluruh (unit tests) sebelum dipasangkan dengan adaptor real-time.*
