# Heartbeat Ping/Pong & Connection Harvesting di WebSocket

Dokumen ini mendefinisikan standar **Top 1% Engineering** untuk pemurnian dan pemeliharaan kesehatan koneksi soket di NestJS. *Zombie Connections*—soket yang secara fisik telah terputus (misalnya pengguna masuk terowongan sehingga kehilangan sinyal 4G) tetapi sistem operasi (TCP) belum melaporkan diskoneksi—dapat merampas memori *File Descriptor* peladen hingga menyebabkan `EMFILE` (*Too many open files*). 

Mekanisme **Heartbeat Ping/Pong** dan **Connection Harvesting** digunakan untuk menyapu bersih koneksi hantu tersebut secara agresif namun anggun.

## Arsitektur Heartbeat Ping/Pong Siklikal

```ascii
+-------------------+                                            +-----------------------+
|                   |   [Waktu 0s] Ping Frame (Opcode 0x9)       |                       |
|                   | <----------------------------------------- |                       |
|   Klien Mobile /  |   [Waktu 1s] Pong Frame (Opcode 0xA)       |  NestJS WS Server     |
|   Browser         | -----------------------------------------> |  (WsGateway/Engine)   |
|                   |                                            |                       |
+---------+---------+   [Waktu 10s] Ping Frame (Opcode 0x9)      +-----------+-----------+
          |           <-----------------------------------------             |
          |             (Klien Masuk Terowongan - Sinyal Mati)               |
          |                                                                  |
          X             [Waktu 15s] Timeout! Pong tidak diterima.   +--------v--------+
                        Tindakan: Harvest (Gunting Paksa Koneksi)   |                 |
                                                                    | Connection      |
                                                                    | Harvester Job   |
                                                                    +-----------------+
```

## Implementasi Pembersihan Soket Kustom (Platform-WS)

Berikut ini mengilustrasikan mekanisme Heartbeat yang diimplementasikan pada `@nestjs/platform-ws` (abstraksi `ws` murni). `socket.io` memilikinya secara *built-in*, namun abstraksi WS murni lebih sulit dan lebih menguntungkan secara kinerja mentah.

```typescript
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, WebSocket } from 'ws';
import { Logger } from '@nestjs/common';
import { Request } from 'express';

// Interface Ekstensi untuk melacak detak jantung (heartbeat)
export interface HeartbeatWebSocket extends WebSocket {
  isAlive: boolean;
  clientId: string;
}

@WebSocketGateway({ path: '/raw-events' })
export class ConnectionHarvestingGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  public readonly server!: Server;
  private readonly logger = new Logger(ConnectionHarvestingGateway.name);
  
  // Referensi ke interval sweeping memory
  private harvestIntervalId: NodeJS.Timeout | null = null;
  private readonly PING_INTERVAL_MS = 30000; // 30 Detik

  // Dijalankan sekali saat gateway hidup
  public afterInit(server: Server): void {
    this.logger.log('Gateway WS Raw diinisialisasi. Memulai Harvesting Job.');
    
    // Mekanisme Connection Harvesting (Penyapuan Memori)
    this.harvestIntervalId = setInterval(() => {
      let sweptCount = 0;
      
      this.server.clients.forEach((client: WebSocket) => {
        const hbClient = client as HeartbeatWebSocket;
        
        if (hbClient.isAlive === false) {
          this.logger.log(`Memanen Zombie Socket: ${hbClient.clientId}`);
          sweptCount++;
          return hbClient.terminate(); // Penghentian agresif & paksa (bukan diskoneksi halus)
        }

        // Tandai klien sebagai "mati" sementara, tunggu ia membalas Pong
        hbClient.isAlive = false;
        hbClient.ping(); // Kirim ICMP WS murni Ping Frame
      });

      if (sweptCount > 0) {
        this.logger.warn(`Telah membersihkan ${sweptCount} koneksi zombie.`);
      }
    }, this.PING_INTERVAL_MS);
  }

  public handleConnection(client: HeartbeatWebSocket, request: Request): void {
    client.isAlive = true;
    client.clientId = request.headers['sec-websocket-key'] as string; // Identifikasi ID Unik
    
    this.logger.log(`Koneksi Mentah Masuk: ${client.clientId}`);

    // Menangani respons "Pong" yang datang dari klien
    client.on('pong', () => {
      // Set status menjadi Hidup! Selamat dari eksekusi mati.
      client.isAlive = true;
    });
  }

  public handleDisconnect(client: HeartbeatWebSocket): void {
    this.logger.log(`Koneksi Terputus Resmi/Tamat: ${client.clientId}`);
  }

  // Penting untuk memastikan memori interval dihentikan (Graceful Shutdown)
  public onApplicationShutdown(): void {
    if (this.harvestIntervalId) {
      clearInterval(this.harvestIntervalId);
    }
  }
}
```

## Unit Test Logic Pemungut Jantung (Heartbeat Harvester)

Fokus utama adalah membuktikan bahwa koneksi yang mati akan dilibas, dan koneksi yang berdetak akan dipertahankan oleh peladen.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConnectionHarvestingGateway, HeartbeatWebSocket } from './harvest.gateway';

describe('ConnectionHarvestingGateway', () => {
  let gateway: ConnectionHarvestingGateway;
  
  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ConnectionHarvestingGateway],
    }).compile();

    gateway = module.get<ConnectionHarvestingGateway>(ConnectionHarvestingGateway);
    
    // Melakukan Bypass ke logger supaya log terminal di Test tetap bersih
    gateway['logger'].log = jest.fn();
    gateway['logger'].warn = jest.fn();
  });

  afterEach(() => {
    gateway.onApplicationShutdown();
  });

  it('harus mengatur isAlive ke true ketika menerima pong dari socket', () => {
    // Membuat tiruan soket mentah
    const mockClient = {
      isAlive: false,
      on: jest.fn().mockImplementation((event, callback) => {
        if (event === 'pong') {
          callback(); // mensimulasikan kejadian 'pong' yang tertrigger
        }
      }),
    } as unknown as HeartbeatWebSocket;

    const mockRequest = { headers: { 'sec-websocket-key': 'uuid-123' } } as any;

    gateway.handleConnection(mockClient, mockRequest);
    
    expect(mockClient.isAlive).toBe(true);
    expect(mockClient.clientId).toBe('uuid-123');
  });

  it('harus memutus koneksi (terminate) socket jika tidak merespons isAlive = false di interval', () => {
    jest.useFakeTimers(); // Membengkokkan waktu setTimeout/Interval
    
    // Mock server WS dengan satu koneksi
    const mockTerminate = jest.fn();
    const mockPing = jest.fn();
    
    const mockZombieClient = {
      isAlive: false, // Berbohong, dia tidak pernah merespons
      clientId: 'zombie-1',
      terminate: mockTerminate,
      ping: mockPing,
    } as unknown as HeartbeatWebSocket;

    gateway.server = {
      clients: new Set([mockZombieClient]),
    } as any;

    gateway.afterInit(gateway.server);

    // Memajukan waktu agar setInterval 30-detik tereksekusi
    jest.advanceTimersByTime(30000);

    // Karena isAlive-nya false sebelum siklus berjalan, soket harus diterkam mati
    expect(mockTerminate).toHaveBeenCalled();
    expect(mockPing).not.toHaveBeenCalled(); // Tidak akan repot diping lagi
    
    jest.useRealTimers();
  });
});
```

## Analisis Trade-Off

### Kelebihan
1. **Perlindungan Terhadap "Too Many Open Files" (Maksimum FDs):** Membersihkan soket yang diam (*idle*) membuat OS tidak kehabisan *File Descriptors*, yang akan membuat aplikasi Node.js terhenti menolak HTTP *request* normal.
2. **Pengurangan Konsumsi RAM Secara Drastis:** Di V8 Engine, satu soket yang menggantung dapat menahan puluhan KB ruang di *heap* karena struktur *Event Emitter*-nya. Memangkas jutaan soket tak berguna berarti menurunkan tagihan server.
3. **Ketersediaan Metadata Kehadiran (Presence):** Sangat berguna saat merancang fitur "Status Online Pengguna". Jika klien di- *harvest*, status daring di basis data bisa dialihkan menjadi "Baru Dilihat" seketika.

### Kekurangan
1. **Interval Blokir di Event Loop:** `setInterval` yang menelusuri 100.000 (O(N)) objek klien di dalam Set setiap 30 detik memakan irisan waktu di *Event Loop*, menyebabkan *micro-stuttering* atau lonjakan latensi.
2. **Kesalahan Pemutusan Koneksi (False Positives):** Pengguna di area 4G yang buruk (*packet loss*) tidak sempat mengembalikan frame "Pong" dalam jangka durasi, mengakibatkan ia dibunuh padahal sistem operasinya belum mendiskoneksi secara permanen.
3. **Kesenjangan Socket.io (Socket.io Redundancy):** Di `socket.io`, hal ini sudah dikelola melalui `pingTimeout` / `pingInterval`. Menggabungkan pemanenan manual (di sisi kita) dan perlakuan asli Socket.io akan memicu *Double-pinging* (boros pita lebar internet).

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Mengirim Data JSON Manual Sebagai Ping (Polio Ping)
Gagal mengenali fasilitas native `Ping (0x9)` dan `Pong (0xA)` di spesifikasi WebSocket, lalu mengirim string JSON secara eksplisit lewat event `.emit('ping')`. 

```typescript
// SALAH: Boros bandwidth aplikasi. Mengirim text-frame (Opcode 0x1) biasa.
setInterval(() => {
  server.clients.forEach(c => c.send(JSON.stringify({ type: 'PING' })));
}, 1000);
```

```typescript
// BENAR: Menggunakan opcode biner ping murni, ditangani otomatis browser secara rahasia
setInterval(() => {
  server.clients.forEach(c => c.ping());
}, 30000);
```

### ❌ Anti-Pattern 2: Mengabaikan Penutupan Memory Saat Server Turun (Orphan Interval)
Tidak mendaftarkan pembersihan Interval akan menjangkiti *Test Runner* (seperti Jest) dengan interval melayang, mengakibatkan kebocoran waktu.

```typescript
// SALAH: Interval tidak disimpan di variabel
public afterInit() {
  setInterval(() => this.harvest(), 1000);
}
```

```typescript
// BENAR: Menyimpan timer ID & membersihkannya (Clear)
public onApplicationShutdown() {
  clearInterval(this.harvestIntervalId);
}
```

## Production Edge Cases

1. **Jeda Komputasi Klien Ekstrem (Browser Frozen/Backgrounded):** Di iOS Safari atau Android Chrome, tab yang masuk latar belakang (Background) atau mengalami tidur lelap (*Sleep mode*) sering tidak memproses *Event Loop* sehingga balasan *Pong* meleset.
   - **Mitigasi:** Atur *Ping Interval* ke durasi pernapasan yang lebih lambat, misalnya 60 detik atau lebih lambat jika aplikasi dominan diakses dari gawai genggam (seluler).
2. **Keterbatasan V8 Garbage Collector:** Setelah melibas/memanen (`terminate()`) 50.000 soket sekaligus, memori V8 akan kotor. Saat siklus *Mark-and-Sweep Garbage Collection* terpicu, *Thread* utama Node.js tertunda sekian ratus milidetik, merusak performa.
   - **Mitigasi:** Gunting (*Terminate*) klien dalam *batch*. Gunting 500 soket di *tick* pertama, berikan jeda `setImmediate`, potong 500 sisanya. Pembersihan perlahan (Pacing).
3. **Perselisihan dengan AWS Application Load Balancer:** ALB di AWS mencetuskan batas durasi mati (*idle timeout*) secara bawaan (biasanya 60 detik). Bila *Ping Interval* disetel pada 70 Detik, ALB AWS secara paksa memutuskan koneksi karena menganggap tiada transfer *byte*.
   - **Mitigasi:** Selalu sinkronkan (pastikan lebih pendek) *Interval Ping* aplikasi (< 50 detik) dari nilai Batas Kedaluwarsa AWS ALB/Cloudflare (60 detik) supaya soket terus terasa "Hangat" (*Keep-alive Warming*).
