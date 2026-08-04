# Forensik Kebocoran Memori (OOM) dan Analisis Heap Snapshots di NestJS

## Pengantar
Di balik keunggulan sistem manajemen memori murni dengan penagihan sampah (Garbage Collector / GC) pada V8 Engine, satu kelengahan kode mampu menghabisi ketahanan *Server Instance* Anda dalam hitungan jam. Kejadian memori merambat (Memory Leak) atau insiden OOM (*Out Of Memory - Fatal Process Exit*) umumnya bersumber dari *Retainers Chain* yang tidak wajar: event listeners yang tidak pernah dibunuh, *closures* abadi di konteks *Request-Scoped* pada Provider NestJS, serta penumpukan *Promise-Chaining* terputus. Pendekatan forensik kelas elit mewajibkan pengambilan *Heap Snapshot* (`.heapsnapshot`) pada terminal produksi dan mendiagnosanya lewat antarmuka grafis di Chrome DevTools.

## Arsitektur Diagram ASCII: Heap Snapshot Retainers Chain

```ascii
+-----------------------------------------------------------+
|               V8 GARBAGE COLLECTOR (GC Roots)             |
|                                                           |
| 1. GLOBAL (window / global) --> [ Map Cache Objects ]     |
| 2. CLOSURE (Event Emitters) --> [ Logger Services ]       |
|                                                           |
+-----------------------------------------------------------+
                             |
   (Memori Buntu - OOM Leak Retainers Path - Tidak Dihapus)
                             v
+-----------------------------------------------------------+
|   [ Array of Socket Users ]  (Root Array)                 |
|            |                                              |
|            +-> [ User ID: 1, Socket: <Ref> ]              |
|            |      |-> (Listener 'data' merujuk Service X) |
|            |                                              |
|            +-> [ User ID: 2, Socket: <Ref> ]              |
|            |      |-> (Listener 'data' merujuk Service Y) |
+-----------------------------------------------------------+
   * Selama Array Global mempertahankan Referensi Socket,   
   * Maka Service X & Y tidak akan PERNAH dihapus oleh GC.
```

## Implementasi Sistem: Induksi Leak dan Analisis Snapshot (`v8`)
Berikut adalah arsitektur diagnostik `MemoryLeakForensicService` di NestJS. Kita akan mensimulasikan sumber kebocoran dan memicu generasi *Snapshot Dump* langsung dari baris terminal tanpa harus mematikan proses utama API.

```typescript
import { Injectable, Logger } from '@nestjs/common';
import * as v8 from 'node:v8';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';

@Injectable()
export class MemoryLeakForensicService {
  private readonly logger = new Logger(MemoryLeakForensicService.name);
  
  // ANTI-PATTERN: Variabel ini bersarang di kelas global
  // Bertindak sebagai GC Root Retainer abadi
  private readonly leakedClosureArray: Array<{ timestamp: Date; largeData: number[] }> = [];
  
  private readonly fakeEmitter = new EventEmitter();

  /**
   * Mensimulasikan skenario HTTP Handler di mana objek besar disuntikkan ke
   * array tanpa adanya sistem "penyapuan" (Eviction/TTL/Cleanup).
   */
  public triggerMemoryLeakEvent(): void {
    const hugePayload = new Array(10000).fill(Math.random());
    
    this.leakedClosureArray.push({
      timestamp: new Date(),
      largeData: hugePayload,
    });

    // ANTI-PATTERN: Closure Listener baru tanpa memanggil removeListener
    this.fakeEmitter.on('ping', () => {
      // Fungsi anonim ini menyimpan ref ke payload
      const x = hugePayload.length;
    });

    this.logger.warn(`Memori bocor tersimpan! Array size: ${this.leakedClosureArray.length}`);
  }

  /**
   * Fungsi Forensik: Melakukan Dump murni ke sistem operasi dalam
   * format .heapsnapshot yang dapat di-Load ke Chrome DevTools (Memory Tab).
   */
  public generateHeapSnapshotDump(): string {
    const memUsage = process.memoryUsage();
    this.logger.log(`[FORENSIC] Ekstraksi Heap Snapshot. V8 RAM: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    
    const dumpFileName = `oom-forensic-${Date.now()}.heapsnapshot`;
    const destinationPath = path.join(os.tmpdir(), dumpFileName);

    // Engine V8 akan berhenti sejenak (Halt/Blocking) 
    // selama melakukan pemindaian seluruh struktur pohon memori.
    const snapshotPath = v8.writeHeapSnapshot(destinationPath);
    
    this.logger.log(`[FORENSIC] Analisis Snapshot V8 sukses ditulis di: ${snapshotPath}`);
    return snapshotPath;
  }
  
  public getArraySize(): number {
    return this.leakedClosureArray.length;
  }
}
```

## Unit Test & Forensik Assertion (Jest)
Pengujian untuk mendemonstrasikan bahwa sistem mampu mengeluarkan file diagnostik dan memvalidasi keberadaannya di FS.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { MemoryLeakForensicService } from './memory-leak-forensic.service';
import * as fs from 'node:fs';

describe('MemoryLeakForensicService', () => {
  let service: MemoryLeakForensicService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MemoryLeakForensicService],
    }).compile();

    service = module.get<MemoryLeakForensicService>(MemoryLeakForensicService);
  });

  it('should intentionally increase internal array size (simulating leak)', () => {
    expect(service.getArraySize()).toBe(0);
    service.triggerMemoryLeakEvent();
    service.triggerMemoryLeakEvent();
    expect(service.getArraySize()).toBe(2);
  });

  it('should generate a valid v8 .heapsnapshot dump in temp directory', () => {
    // Membangkitkan beban tiruan
    service.triggerMemoryLeakEvent();

    // Mengambil ekstrak dump
    const dumpPath = service.generateHeapSnapshotDump();
    
    // Verifikasi forensik
    expect(dumpPath).toBeDefined();
    expect(dumpPath.endsWith('.heapsnapshot')).toBeTruthy();
    expect(fs.existsSync(dumpPath)).toBeTruthy();
    
    // Validasi isi dump (minimal bukan file kosong)
    const stats = fs.statSync(dumpPath);
    expect(stats.size).toBeGreaterThan(0);

    // Cleanup tes agar Hard Drive tidak dipenuhi snapshot dump besar
    fs.unlinkSync(dumpPath);
  });
});
```

## Analisis Trade-Off
**Kelebihan (Pros):**
1. **Analisis Akar Masalah Nyata:** Dibanding menebak-nebak, Dump Snapshot menjabarkan grafik relasional antara node instan dengan node akar. Anda pasti menemukan asal mula OOM.
2. **Tidak Perlu Restart:** Snapshot dapat diekstrak tepat saat HTTP/APM mendeteksi memori 85% memicu alert, server terus beroperasi meskipun V8 halt sementara waktu.
3. **Ekosistem Standar Industri:** Format `.heapsnapshot` adalah de-facto standar global yang dapat dibuka, dibedah dan di-_compare_ oleh Chrome DevTools, Datadog Profiler, dll.

**Kekurangan (Cons):**
1. **Blocking Main Thread Mutlak:** Rutin `v8.writeHeapSnapshot()` adalah proses sinkron primitif. Jika Heap RAM berisi 1.5 GB data raksasa, Event Loop akan mandek hingga 1-5 Detik total, yang menyebabkan putusnya HTTP secara masif.
2. **Ukurannya Gigantik:** Memori bocor 2 GB = File Snapshot 2 GB lebih. Menaruh hasil *dump* pada OS Alpine Docker kontainer dengan volume 5 GB sangat berisiko menghabiskan disk (`No Space Left on Device`).
3. **Security PII Leak:** File heap snapshot secara gamblang mengantongi *plain text* dari variabel string saat itu, termasuk Secret Key, JSON klien, data CC dan kata sandi DB.

## Anti-Patterns Kritis & Resolusi
### 1. Request-Scoped Provider Memory Trap
❌ **Salah (Anti-Pattern):** Membuat Provider NestJS menjadi Request Scoped dan membungkus intervensi HTTP `res` atau `req` dengan `setInterval` atau `EventEmitter`. Ketika response ditutup, GC tidak akan membunuh instansi Service, dan ini merupakan *disaster*.
```typescript
@Injectable({ scope: Scope.REQUEST })
export class TragicService {
  constructor() {
    // ANTI-PATTERN: Akan menduplikasi interval ke jutaan instance tiap HTTP call 
    // dan menghalangi GC untuk membunuh class 'TragicService'.
    setInterval(() => console.log('I live forever'), 1000); 
  }
}
```
✅ **Benar (Resolusi):** Hindari scope `REQUEST` bila tidak mutlak perlu (Kembalikan ke Singleton Standard). Jika terpaksa, hentikan seluruh listerner aktif di hook lifecycle. Emitters harus dibunuh (`clearInterval` atau `.removeAllListeners()`).

### 2. Phantom Promise & Callback Hell Retainers
❌ **Salah (Anti-Pattern):** Mengeksekusi Promise yang *tertunda (pending)* abadi yang membungkus referensi objek lokal/luas dan luput dari `resolve()/reject()`.
```typescript
async function fetchForever(largeContext: any) {
  return new Promise((resolve) => {
    // BENCANA: Jika event 'finish' tidak pernah dipanggil, 
    // objek 'largeContext' tidak akan tersapu GC.
    myEmitter.once('finish', () => resolve(largeContext)); 
  });
}
```
✅ **Benar (Resolusi):** Tanamkan `setTimeout` di dalam pemanggilan Promise untuk menjatuhkan klaim memori dengan *Timeout Rejection*.
```typescript
async function fetchWithTimeout(largeContext: any) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), 5000);
    myEmitter.once('finish', () => {
      clearTimeout(timer);
      resolve(largeContext);
    });
  });
}
```

## Production Edge Cases
1. **Gagal Tulis Snapshot dalam Kontainer Tanpa Hak (Unprivileged Docker):** V8 dump ke path root (`/`) atau read-only file systems akan langsung `Crash / Fatal Exception`. Gunakan path spesifik OS Temp Dir `/tmp/`.
2. **Buffer Stream Memory Blow-Up:** Membaca/mengirim file Video 4K (Gigabytes) via NestJS menggunakan memori primitif (`fs.readFileSync`) akan langsung *Crash* melanggar V8 Limit (maks ~1.4GB di 64bit secara bawaan). Wajib gunakan Node `Streams` dan `.pipe()`.
3. **Penyumbatan Map/Set pada Custom Caching:** Banyak implementasi memori *cache* lokal berbasis TypeScript `Map<string, User>` di NestJS yang tidak mengintegrasikan sistem TTL. Hal ini adalah gerbang bocor nomer 1. Selalu gunakan `lru-cache` package bila ingin caching memori lokal yang memangkas data tua.
