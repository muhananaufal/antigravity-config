# Offloading Komputasi CPU-Bound dengan Worker Threads & Piscina

## Pengantar
Meskipun Node.js/NestJS mematikan persaingan pada arsitektur I/O Asinkron yang berat, kelemahannya terletak secara murni pada **Komputasi CPU-Bound**. Tugas-tugas kalkulasi berat—seperti enkripsi kriptografi masif, kompresi/ekstraksi ZIP/Excel (*xlsx/csv*) berskala Gigabyte, *Image Cropping/Resizing*, dan perangkaian *Merkle Tree* di Web3—akan menahan V8 Main Thread sepenuhnya. Di ranah Top 1% Engineering, penyelesaian mutlak untuk masalah ini adalah dengan mendelegasikan tugas-tugas tersebut keluar dari jalurnya utama. Menggunakan `worker_threads` yang dikelola secara tangguh oleh pustaka *Thread Pool* spesifik seperti **Piscina**.

## Arsitektur Diagram ASCII: Piscina Worker Pool

```ascii
+-----------------------------------------------------------+
|                    MAIN EVENT LOOP (NestJS)               |
|                                                           |
| [ API Request ] -> [ Piscina Pool Dispatcher (Main) ]     |
|                             |                             |
+-----------------------------|-----------------------------+
                              | MessageChannel (IPC)
          +-------------------+-------------------+
          |                   |                   |
          v                   v                   v
+------------------+ +------------------+ +------------------+
|  Worker Node 1   | |  Worker Node 2   | |  Worker Node N   |
| (V8 Isolate)     | | (V8 Isolate)     | | (V8 Isolate)     |
|                  | |                  | |                  |
| - Excel Parsing  | | - Kriptografi    | | - Image Resizing |
| - Data Hashing   | | - Data Hashing   | | - Data Hashing   |
+------------------+ +------------------+ +------------------+
          |                   |                   |
          +-------------------+-------------------+
                              | Result via Promise
                              v
+-----------------------------------------------------------+
|          MAIN EVENT LOOP (HTTP Response Terkirim)         |
+-----------------------------------------------------------+
```
*Catatan: Setiap Worker memiliki salinan (Isolate) Engine V8 miliknya sendiri, menempati Thread OS terpisah, sehingga tidak mencekik Event Loop utama.*

## Implementasi NestJS: Offloading dengan Piscina Provider
Kita perlu membungkus instansiasi Piscina ke dalam modul Singleton agar NestJS memelihara kolam (pool) dengan benar selama siklus *lifecycle* aplikasi berjalan.

### 1. The Worker Script (`cpu-heavy.worker.ts`)
```typescript
import { createHash } from 'node:crypto';

// Ini dieksekusi murni di dalam worker thread V8 terpisah
export default function processGiganticPayload(dataString: string): string {
  // Simulasi kalkulasi ekstrim yang akan memblokir thread
  let resultHash = '';
  for (let i = 0; i < 5000; i++) {
    const hash = createHash('sha512');
    hash.update(dataString + i.toString() + resultHash);
    resultHash = hash.digest('hex');
  }
  return resultHash;
}
```

### 2. NestJS Piscina Provider (`piscina.service.ts`)
```typescript
import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import Piscina from 'piscina';
import { resolve } from 'node:path';

@Injectable()
export class PiscinaWorkerPoolService implements OnModuleDestroy {
  private readonly logger = new Logger(PiscinaWorkerPoolService.name);
  private readonly workerPool: Piscina;

  constructor() {
    // Inisialisasi pool yang aman dari blok thread
    this.workerPool = new Piscina({
      // Resolusi path ke script worker terkompilasi (.js)
      filename: resolve(__dirname, 'cpu-heavy.worker.js'),
      // Opsional: Membatasi resource sesuai CPU Core OS
      minThreads: 2,
      maxThreads: Math.max(2, Math.floor(require('node:os').cpus().length * 0.8)), 
      maxQueue: 100, // Backpressure protection (Circuit breaker)
    });
    
    this.logger.log(`Piscina Pool initialized with max ${this.workerPool.maxThreads} threads.`);
  }

  /**
   * Mendelegasikan kalkulasi yang menyiksa CPU secara remote.
   * Event Loop utama 100% aman untuk melayani klien lain.
   */
  public async hashPayloadOffloaded(payload: string): Promise<string> {
    try {
      // Mengirimkan pesan melalui IPC (Inter-Process Communication)
      const result: string = await this.workerPool.run(payload);
      return result;
    } catch (error) {
      this.logger.error(`Piscina Task Failed: ${(error as Error).message}`);
      throw error;
    }
  }

  // Membersihkan thread secara rapi pada saat SIGTERM/SIGINT
  public async onModuleDestroy(): Promise<void> {
    this.logger.warn('Destroying Piscina Worker Pool...');
    await this.workerPool.destroy();
  }
}
```

## Unit / Worker Test Suite (Jest)
Pengujian untuk menjamin bahwasanya *task* berhasil di-run menggunakan arsitektur kolam Piscina dan menghasilkan tipe data yang sesuai.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { PiscinaWorkerPoolService } from './piscina.service';
import * as path from 'path';
import * as fs from 'fs';

describe('PiscinaWorkerPoolService', () => {
  let service: PiscinaWorkerPoolService;
  
  // Dummy file agar Piscina tidak crash saat tes dijalankan
  const dummyWorkerPath = path.resolve(__dirname, 'cpu-heavy.worker.js');

  beforeAll(() => {
    fs.writeFileSync(dummyWorkerPath, `
      const { createHash } = require('node:crypto');
      module.exports = function(dataString) {
        return "mock_hash_result_of_" + dataString.substring(0, 5);
      };
    `);
  });

  afterAll(() => {
    if (fs.existsSync(dummyWorkerPath)) {
      fs.unlinkSync(dummyWorkerPath);
    }
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PiscinaWorkerPoolService],
    }).compile();

    service = module.get<PiscinaWorkerPoolService>(PiscinaWorkerPoolService);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('should offload task successfully and return expected mock result', async () => {
    const input = 'super_secret_payload_123';
    
    // Piscina .run() mengembalikan promise yang dilempar oleh worker
    const result = await service.hashPayloadOffloaded(input);
    
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result).toEqual('mock_hash_result_of_super');
  });
});
```

## Analisis Trade-Off
**Kelebihan (Pros):**
1. **Penyelamatan Event Loop:** Memblokir V8 dalam worker thread tidak berpengaruh sedetik pun terhadap koneksi API yang masuk dan respons klien. Main Thread tetap bersih 100%.
2. **Pemanfaatan Multi-Core Maksimal:** Node.js (V8) bukan sekadar mainan 1 CPU (Single Core) lagi; arsitektur server dapat menghabiskan seluruh potensi 16-Core atau 32-Core AWS EC2.
3. **Isolasi Memori & Keamanan:** Jika sebuah operasi eksklusif (seperti parsing CSV hancur) memicu Out-Of-Memory (OOM) atau crash, hanya Worker tersebut yang mati dan diganti; Aplikasi Induk tetap berdiri tegak.

**Kekurangan (Cons):**
1. **Biaya IPC (Serialization Cost):** Mengirimkan data via IPC (Inter-Process) membutuhkan kloning V8 terstruktur (Structured Clone Algorithm). Mengirim Array Objek 500MB dari Utama ke Worker bisa lebih mematikan ketimbang menyelesaikannya di tempat utama akibat Overhead (Kloning).
2. **Kompleksitas Injeksi Dependencies:** Thread eksekusi (*worker.ts*) tidak memiliki akses ke konteks NestJS Dependency Injection, Repositori TypeORM, atau Cache. Ia berjalan secara terisolasi murni.
3. **Penggunaan Memori Super Tinggi:** Setiap *Worker* mengeksekusi mesin V8 seutuhnya. Menambah 10 Worker berarti membuang memori tambahan minimal 30MB-60MB x 10, murni tanpa muatan payload sekalipun.

## Anti-Patterns Kritis & Resolusi
### 1. Passing Object Reference & Massive Payload
❌ **Salah (Anti-Pattern):** Melakukan I/O transfer Array Objek (JSON) raksasa. Kloningnya melahap I/O IPC dan CPU utama (Main Thread lag).
```typescript
// Membekukan Main Thread hanya karena kloning Serialized IPC
const gigabyteJson = JSON.parse(fs.readFileSync('huge.json', 'utf8'));
const result = await pool.run(gigabyteJson);
```
✅ **Benar (Resolusi):** Operasikan dengan `SharedArrayBuffer` jika memungkinkan, atau lempar HANYA lokasinya (*file path*), dan biarkan Pekerja/Worker yang membaca data tersebut.
```typescript
// Kirim Path file. Pekerja yang membaca dan me-return agregat kecil
const result = await pool.run({ filePath: 'huge.json', type: 'parse' });
```

### 2. Piscina Instantiation per-Request
❌ **Salah (Anti-Pattern):** Menciptakan pool Piscina di dalam controller/service method yang dieksekusi per request. Biaya inisiasi *Worker* merusak kecepatan eksekusi (Overhead).
```typescript
public async badRouteHandler(data: string) {
  // BENCANA CPU OS (Spawn V8 sangat lamban)
  const pool = new Piscina({ filename: 'worker.js' }); 
  return pool.run(data);
}
```
✅ **Benar (Resolusi):** Jadikan *Provider NestJS Singleton* yang hanya dikunci sekali pada modul awal seperti implementasi di atas (Dikelola dalam Constructor).

## Production Edge Cases
1. **Backpressure (Queue Overflow):** Jika request API yang membutuhkan Worker sangat banyak namun pool terbatas, antrean *Task* Piscina bisa meledak ke ribuan tugas. Wajib implementasi circuit-breaker batas `maxQueue` dan tolak secara halus *request* (HTTP 429) kepada klien.
2. **Koneksi Database Ghosting:** Worker Thread tidak semestinya digunakan untuk terhubung ke SQLC/TypeORM (meskipun hal tersebut dimungkinkan). Konsekuensi pool koneksi (10 Worker * 10 koneksi max) dapat mem-banjir-i PostgreSQL secara instan. Desain Worker sebagai "Pure Computational Pipeline".
3. **Zombie Worker di Alpine Linux:** Mematikan main node dengan paksa tanpa `await pool.destroy()` (atau sinyal SIGKILL agresif Kubernetes) sesekali dapat memicu sisa utas OS yang beroperasi sebagai *Zombie Process* (membuang memori). Wajib panggil fungsi bersih-bersih (*cleanup*) di `onModuleDestroy`.
