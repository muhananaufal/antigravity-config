# Anatomi V8 Engine dan Libuv Event Loop di Ekosistem Node.js/NestJS

## Pengantar
Di balik layar dari arsitektur *non-blocking* Node.js dan performa tinggi NestJS, terdapat dua mesin utama: V8 Engine (eksekutor JavaScript yang melakukan kompilasi Just-In-Time ke *machine code*) dan Libuv (library C yang menyediakan antarmuka *Event Loop* lintas platform untuk I/O asinkron). Pemahaman tingkat *Principal Engineer* tentang interaksi antara *Microtask Queue*, *Macrotask Queue*, dan Fase Libuv mutlak diperlukan untuk mencegah insiden *Event Loop Lag* (penundaan eksekusi timer/I/O) yang bisa meruntuhkan *throughput* API secara drastis saat menangani beban HTTP berat atau koneksi WebSocket masif.

## Arsitektur Diagram ASCII: Libuv Event Loop Phases & V8 Microtasks

```ascii
+-----------------------------------------------------------+
|                      V8 ENGINE HEAP                       |
|  [ Call Stack ] --> [ Microtask Queue (nextTick, Promise) ]
+-------|-----------------------^---------------------------+
        |                       | (Dikosongkan setiap jeda fase)
        v                       |
+-----------------------------------------------------------+
|                     LIBUV EVENT LOOP                      |
|                                                           |
|  +-----------------------------------------------------+  |
|  | 1. TIMERS PHASE (setTimeout, setInterval)           |  |
|  +-----------------------------------------------------+  |
|                            |                              |
|  +-----------------------------------------------------+  |
|  | 2. PENDING CALLBACKS (I/O callbacks tertunda)       |  |
|  +-----------------------------------------------------+  |
|                            |                              |
|  +-----------------------------------------------------+  |
|  | 3. IDLE, PREPARE (Internal libuv)                   |  |
|  +-----------------------------------------------------+  |
|                            |                              |
|  +-----------------------------------------------------+  |
|  | 4. POLL PHASE (Retrieve I/O events, eksekusi cb)    |  |
|  |    * Menunggu I/O baru jika antrean kosong          |  |
|  +-----------------------------------------------------+  |
|                            |                              |
|  +-----------------------------------------------------+  |
|  | 5. CHECK PHASE (setImmediate callbacks)             |  |
|  +-----------------------------------------------------+  |
|                            |                              |
|  +-----------------------------------------------------+  |
|  | 6. CLOSE CALLBACKS (socket.on('close', ...))        |  |
|  +-----------------------------------------------------+  |
+-----------------------------------------------------------+
```

## Analisis Mendalam: Fase Libuv vs V8 Queue
1. **Timers Phase:** Event loop memulai iterasinya dengan mengeksekusi *callback* dari `setTimeout` atau `setInterval` yang waktu tundanya telah berlalu. Namun, waktu eksekusi tidak 100% presisi karena sangat bergantung pada kepadatan beban pada *Poll Phase*.
2. **Poll Phase:** Jantung dari I/O. Jika antrean (Queue) tidak kosong, loop memproses I/O synchronous sampai batas habis (limit). Jika kosong, ia akan menunggu event I/O baru di-polling dari OS, KECUALI jika ada script yang dijadwalkan `setImmediate`.
3. **Check Phase:** Didesain khusus untuk menjalankan *callback* `setImmediate` sesegera mungkin setelah *Poll Phase* berakhir. Sangat baik untuk menjadwalkan tugas *yielding*.
4. **Microtask Queue (`process.nextTick` & Promise):** Ini murni wilayah V8. Node.js akan menghentikan Event Loop Libuv sesaat untuk mengosongkan antrean *Microtask* DI ANTARA setiap fase event loop. Jika *Microtask* ditumpuk rekursif tanpa henti, Event Loop Libuv akan **tercekik total** (Starvation).

## Implementasi Sistem: Event Loop Lag Monitor di NestJS
Dalam skala produksi kelas *Enterprise*, kita harus memiliki metrik untuk membaca lag pada Event Loop dan menggunakan *Circuit Breaker* apabila server terindikasi tersedak. Berikut adalah implementasi *Service* di NestJS:

```typescript
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { perf_hooks } from 'node:perf_hooks';

export interface LoopLagMetrics {
  currentLagMs: number;
  isStressed: boolean;
}

@Injectable()
export class EventLoopMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventLoopMonitorService.name);
  private lagMonitorInterval: NodeJS.Timeout | null = null;
  private currentLagMs: number = 0;
  private readonly LAG_THRESHOLD_MS: number = 50;

  public onModuleInit(): void {
    this.startLagMonitor();
  }

  public onModuleDestroy(): void {
    if (this.lagMonitorInterval) {
      clearInterval(this.lagMonitorInterval);
    }
  }

  /**
   * Mengukur interval deviasi menggunakan setTimeout. 
   * Selisih antara waktu nyata dan harapan merepresentasikan seberapa
   * parah Event Loop terblokir.
   */
  private startLagMonitor(): void {
    const EXPECTED_INTERVAL_MS = 1000;
    let lastTime = perf_hooks.performance.now();

    this.lagMonitorInterval = setInterval(() => {
      const currentTime = perf_hooks.performance.now();
      const elapsed = currentTime - lastTime;
      this.currentLagMs = Math.max(0, elapsed - EXPECTED_INTERVAL_MS);
      lastTime = currentTime;

      if (this.currentLagMs > this.LAG_THRESHOLD_MS) {
        this.logger.warn(`[CRITICAL] EVENT LOOP LAG DETECTED: ${this.currentLagMs.toFixed(2)}ms`);
      }
    }, EXPECTED_INTERVAL_MS);
    
    // Non-blocking pada termination OS
    this.lagMonitorInterval.unref();
  }

  public getMetrics(): LoopLagMetrics {
    return {
      currentLagMs: this.currentLagMs,
      isStressed: this.currentLagMs > this.LAG_THRESHOLD_MS,
    };
  }

  /**
   * Teknik Yielding ke Event Loop via Macrotask setImmediate.
   * Fungsi ini memecah array gigantik sehingga I/O jaringan 
   * dapat menyelinap masuk dan terproses di Poll Phase.
   */
  public async processLargeArrayNonBlocking(items: number[]): Promise<number> {
    let sum = 0;
    const CHUNK_SIZE = 10000;

    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);
      
      sum += chunk.reduce((acc, curr) => acc + curr, 0);

      // Yielding: Kembalikan kendali ke Libuv Poll Phase
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    return sum;
  }
}
```

## Unit Test & Event Loop Assertion (Jest)
Pengujian untuk memastikan bahwa teknik *yielding* kita tidak memblokir antrean *Timer* atau *Microtask*.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { EventLoopMonitorService } from './event-loop-monitor.service';

describe('EventLoopMonitorService', () => {
  let service: EventLoopMonitorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EventLoopMonitorService],
    }).compile();

    service = module.get<EventLoopMonitorService>(EventLoopMonitorService);
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('should process large arrays without starving the event loop', async () => {
    const hugeArray = Array.from({ length: 50000 }, (_, i) => i);
    
    let timerFired = false;
    const testTimer = setTimeout(() => {
      timerFired = true;
    }, 5); // Sangat singkat

    const result = await service.processLargeArrayNonBlocking(hugeArray);

    const expectedSum = (49999 * 50000) / 2;
    expect(result).toBe(expectedSum);
    
    // Jika timer meletus sebelum fungsi asinkron panjang selesai,
    // berarti Event Loop yielding menggunakan setImmediate sukses besar.
    expect(timerFired).toBe(true);
    clearTimeout(testTimer);
  });

  it('should return valid metrics structure', () => {
    const metrics = service.getMetrics();
    expect(metrics).toHaveProperty('currentLagMs');
    expect(metrics.currentLagMs).toBeGreaterThanOrEqual(0);
    expect(typeof metrics.isStressed).toBe('boolean');
  });
});
```

## Analisis Trade-Off
**Kelebihan (Pros):**
1. **Asynchronous Non-Blocking I/O:** Memungkinkan Node.js menangani 10.000+ koneksi serentak (C10K problem) secara hemat memori (dibanding model thread-per-request layaknya Java lawas).
2. **Kestabilan Response Time:** Memecah (yielding) tugas komputasi berat ke *Macrotask* (`setImmediate`) menjamin I/O klien HTTP tidak mendadak macet total (jitter).
3. **Observabilitas Transparan:** Menggunakan metrik `Lag` yang tepat bisa diintegrasikan dengan Kubernetes Liveness/Readiness probe agar traffic dialihkan dari pod yang sibuk.

**Kekurangan (Cons):**
1. **Konsekuensi Overhead Yielding:** Memecah perulangan (loop) secara sengaja menggunakan `setImmediate` pada iterasi besar jutaan data justru memperlambat eksekusi spesifik tugas tersebut akibat intervensi (Context Switching) antrean Libuv.
2. **Single Point of Failure (SPOF):** Satu insiden di mana blok sinkron tak-disengaja di eksekusi (seperti serialisasi JSON raksasa), SELURUH event HTTP klien membeku hingga batas I/O timeout.
3. **Palsunya Multithreading:** Node.js I/O tidak terblokir, tetapi operasi V8 (JavaScript) tetap dieksekusi 1-per-1. Core CPU tambahan tidak tersentuh tanpa campur tangan `Worker Threads`.

## Anti-Patterns Kritis & Resolusi
### 1. The `process.nextTick` Recursive Starvation (Microtask Hell)
❌ **Salah (Anti-Pattern):** Pemanggilan `process.nextTick` yang bersifat rekursif. Ini tidak akan membiarkan Libuv bergeser dari fasenya, sehingga koneksi DB, HTTP, dan OS tertolak total.
```typescript
// Bencana Event Loop (Crash)
function recursiveStarvation(count: number): void {
  if (count <= 0) return;
  process.nextTick(() => recursiveStarvation(count - 1)); 
}
```
✅ **Benar (Resolusi):** Gunakan `setImmediate` (*Macrotask* Check Phase) yang membiarkan *Poll Phase* (I/O) dan *Timers* bernapas.
```typescript
// Produksi aman
function recursiveYielding(count: number): void {
  if (count <= 0) return;
  setImmediate(() => recursiveYielding(count - 1));
}
```

### 2. Synchronous Crypto / Parsing
❌ **Salah (Anti-Pattern):** Hashing *password* puluhan ribu iterasi dengan metode `Sync` dalam alur Request HTTP (Sangat fatal).
```typescript
import * as crypto from 'crypto';
// Menahan loop seluruh klien selama ~100ms per request.
const hash = crypto.pbkdf2Sync('password', 'salt', 100000, 64, 'sha512'); 
```
✅ **Benar (Resolusi):** Wajib asinkron (Libuv internal Thread Pool).
```typescript
import * as crypto from 'crypto';
import { promisify } from 'util';
const pbkdf2Async = promisify(crypto.pbkdf2);
// Dijalankan di Libuv Thread Pool (di luar Main Event Loop)
const hash = await pbkdf2Async('password', 'salt', 100000, 64, 'sha512');
```

## Production Edge Cases
1. **RegExp Catastrophic Backtracking:** Mengevaluasi ekspresi RegEx yang rapuh terhadap string payload berukuran besar yang spesifik dapat menahan thread V8 hingga beberapa menit. Pilihlah dependensi tanpa *backtracking* eksponensial.
2. **Database Connection Pool Exhaustion vs Lag:** Saat Event Loop tertahan lama, *Driver* database (seperti pg/Redis) kehilangan siklus untuk menjawab *keep-alive*, menimbulkan koneksi terputus tiba-tiba atau "Timeout" palsu meskipun kueri server DB usai.
3. **Promise.all() Memory & CPU Bomb:** Menyelesaikan ribuan eksekusi asinkron simultan yang memuat *Microtask Queue* secara penuh. Gunakan *Chunking/Batching* semacam package `p-map` agar alokasi memori V8 dan tekanan CPU tersebar merata.
