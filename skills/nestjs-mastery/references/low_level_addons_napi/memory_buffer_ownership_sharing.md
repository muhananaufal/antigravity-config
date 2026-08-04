# Manajemen Ownership Buffer antara V8 dan Memori Asli Rust (Zero-Copy)

Batas (boundary) serialisasi V8 memicu biaya fatal pada transfer objek masif. Mengirim data citra, *machine learning tensors*, atau file media ratusan Megabyte (MB) ke modul Native untuk diproses akan mematikan aplikasi seketika bila data tersebut mengalami duplikasi di RAM (Copying).

*Zero-Copy Buffer Overlapping* menyelaraskan obyek *ArrayBuffer* atau `Buffer` pada ekosistem TypeScript NestJS ke *byte slice* memori murni (`&[u8]`) milik subsistem Rust tanpa menduplikasi data sedikitpun. Keduanya melihat dan memanipulasi rentang heksadesimal RAM yang persis sama.

## Skema Transfer Pointer Zero-Copy RAM

```text
       NODE.JS (V8 HEAP)                         RUST NATIVE MEMORY (C-ABI)
+-------------------------------+             +------------------------------+
| const buf = Buffer.alloc(1GB) |             | #[napi]                      |
|                               |             | fn process(data: Buffer)     |
| [ 0x01, 0xFF, 0x4A, ... ]     |             |                              |
|           ^                   |             |                              |
+-----------|-------------------+             +------------------------------+
            |                                                |
            +--- (Mengirim POINTER ke alamat memori asli) ---+
                 Bukan mengkopi data byte per byte!
                 (0 ms Transfer Time, 0 MB Extra RAM)
```

## Implementasi Produksi

Praktik manipulasi tingkat dewa ini menuntut Rust mengolah data *buffer* yang dialokasikan di dunia JavaScript, memodifikasinya (mutasi in-place), lalu membiarkan TypeScript membacanya kembali.

### 1. N-API Rust Module (`src/lib.rs`)

Dengan API `napi::bindgen_prelude::Buffer`, NAPI-RS memberikan proteksi kepemilikan memori sementara _pointer_ dipinjamkan.

```rust
#![deny(clippy::all)]

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// Mengubah dan mengenkripsi Buffer raksasa TANPA MENGGANDAKAN memori (Mutasi In-Place)
/// Buffer ini harus dilewatkan dari Node.js sebagai Buffer Objects.
#[napi]
pub fn fast_invert_image_colors_in_place(mut data_buffer: Buffer) {
    // data_buffer.as_mut() memberikan akses mutlak ke RAM milik V8!
    let raw_slice: &mut [u8] = data_buffer.as_mut();

    // Memproses memori berkecepatan tinggi dengan Iterator SIMD-friendly
    // Misal: Inversi Warna Gambar (255 - pixel)
    for byte in raw_slice.iter_mut() {
        // Melakukan mutasi langsung di alamat memori!
        *byte = 255 - *byte;
    }
}
```

### 2. Integrasi NestJS Service (V8 Side)

Di dunia NestJS, kita melempar `Buffer` dan setelah fungsi FFI (Foreign Function Interface) kembali, memori `Buffer` tersebut sudah termodifikasi gaib (magic) dalam waktu 0 milidetik _overhead_.

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { fastInvertImageColorsInPlace } from '../native-bindings/binding';
import * as crypto from 'crypto';

@Injectable()
export class BufferProcessorService {
  private readonly logger = new Logger(BufferProcessorService.name);

  public invertLargeData(sizeInMb: number): Buffer {
    // Alokasi memori berukuran sangat besar (Misal 100 Megabytes)
    // Buffer dialokasikan di luar V8 Heap utama, menjauhi Garbage Collector
    const largeBuffer = crypto.randomBytes(sizeInMb * 1024 * 1024);

    this.logger.log(`Mengalokasikan ${sizeInMb}MB Buffer. Memulai mutasi Rust...`);
    const start = performance.now();

    try {
      // Mengoper POINTER buffer, BUKAN duplikat (Zero-Copy Transfer).
      // Mutasi terjadi di dalam RAM yang sama.
      fastInvertImageColorsInPlace(largeBuffer);
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.logger.error(`Kesalahan modul native N-API: ${error.message}`, error.stack);
      }
      throw error;
    }

    const end = performance.now();
    this.logger.log(`Mutasi ${sizeInMb}MB selesai murni dalam ${end - start}ms.`);

    // largeBuffer sekarang isinya sudah berubah total hasil sentuhan tangan Rust!
    return largeBuffer;
  }
}
```

## Unit Testing / Service Mock Test Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { BufferProcessorService } from './buffer-processor.service';

// Mock modul C++/Rust Binding
jest.mock('../native-bindings/binding', () => ({
  fastInvertImageColorsInPlace: jest.fn().mockImplementation((buf: Buffer) => {
    // Simulasi inversi di mock test
    for (let i = 0; i < buf.length; i++) {
      buf[i] = 255 - buf[i];
    }
  }),
}));

describe('BufferProcessorService (Zero Copy)', () => {
  let service: BufferProcessorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BufferProcessorService],
    }).compile();

    service = module.get<BufferProcessorService>(BufferProcessorService);
  });

  it('should allocate buffer and modify it directly', () => {
    // Buat data test kecil namun nyata
    const testSizeMB = 1; // 1 MB test
    
    // Mata-matai crypto agar buffer yang dikeluarkan statis (mudah dites)
    const crypto = require('crypto');
    jest.spyOn(crypto, 'randomBytes').mockReturnValue(Buffer.from([0, 100, 255]));

    const resultBuffer = service.invertLargeData(testSizeMB);

    expect(resultBuffer).toBeInstanceOf(Buffer);
    // Verifikasi Mutasi RAM 255 - value
    expect(resultBuffer[0]).toBe(255);
    expect(resultBuffer[1]).toBe(155);
    expect(resultBuffer[2]).toBe(0);
  });
});
```

## Analisis Trade-Off

**Kelebihan:**
1. **0% Overhead Duplikasi:** Membawa kecepatan transmisi (Serialization Latency) menjadi mutlak 0ms berapapun ukuran Buffernya (entah itu 100KB atau 2 Gigabytes).
2. **Ultra Low Latency:** Sangat esensial untuk kasus aplikasi High Frequency Trading (HFT) WebSocket, atau stream parsing IoT di mana delay 5ms tidak dapat ditolerir.
3. **Penghematan RAM:** Server produksi cloud (misal AWS EC2) tidak berteriak kehabisan memori. Mutasi 500MB gambar tidak menuntut alokasi 1GB RAM gabungan Node+Rust.

**Kekurangan:**
1. **Sifat Mutasi yang Berbahaya:** Data asli dihancurkan secara permanen. Pengembang yang terbiasa gaya *Functional Programming* murni akan sangat rentan terkena _side-effect_ bug yang tidak terduga.
2. **Race Conditions Paralelisme:** Jika Node.js mengirim *Buffer* ke Thread background Rust, namun V8 Thread secara asinkron (karena timer) juga mencoba membaca/memodifikasi array JavaScript tersebut bersamaan, akan terjadi korupsi struktur data!
3. **V8 Garbage Collector Complication:** Meminjam memori berarti Rust harus ekstra ketat (Lifetime) memegang _pointer_. Jika Node.js melepaskan *Buffer* itu dan GC (Garbage Collector) menyapunya sebelum Rust selesai, Rust akan menabrak alamat RAM ilegal (Segmentation Fault).

## Anti-Patterns

❌ **Anti-Pattern 1: Mengirim Data Besar melalui Tipe Array atau String standar JS**
```rust
// SALAH: Jika di-passing sebagai `Vec<u8>` normal atau String, 
// V8 akan MENDUPLIKASI data. 500MB string JS = 500MB alokasi baru di RAM Rust.
#[napi]
pub fn slow_process(data: Vec<u8>) {} 
```

✅ **Best Practice 1: Memaksa Penggunaan tipe `Buffer` NAPI Murni**
```rust
// BENAR: Tipe napi::bindgen_prelude::Buffer me-wrap pointer langsung
#[napi]
pub fn fast_process(data: Buffer) {}
```

❌ **Anti-Pattern 2: Menahan Pointer Buffer di State Global Rust**
```rust
// SALAH KRITIS: Pointer disimpan di variabel statis. 
// GC V8 dapat menghapus Buffer aslinya besok pagi, tapi Rust masih menyimpan 
// pointernya dan jika diakses = SERVER CRASH MATI!
static mut DANGEROUS_POINTER: Option<*mut u8> = None;
```

✅ **Best Practice 2: Eksekusi Scoped dan Transien (Umur pendek)**
```rust
// BENAR: Buffer hanya dipinjam selama fungsi berlangsung, lalu segera dikembalikan.
#[napi]
pub fn safe_process(mut data: Buffer) { /* akses selesai saat fungsi return */ }
```

## Production Edge Cases

1. **Memory Alignment Issues (Arsitektur ARM/M1/M2):** V8 tidak menjamin *Buffer* akan beralamat rata (_memory aligned_) secara byte kelipatan besar (misal 64-byte untuk SIMD). Jika instruksi vektor (SIMD AVX) di Rust memaksa membaca array *unaligned*, prosesor akan *kernel panic* (Signal BUS). Wajib menggunakan _read_unaligned_ di level *unsafe* Rust.
2. **GC Dethatching / Buffer Detachment:** Dalam *Worker Threads* Node.js mutakhir (`worker_threads`), ArrayBuffer bisa ditransfer (Detached) ke thread lain. Jika Rust sedang memegang *pointer*-nya melalui N-API lalu thread JS mendetachnya, Rust akan membaca wilayah RAM kosong yang memicu _segfault crash_.
3. **Liveness Tracking (Penguncian Lifetime):** Selama eksekusi Async (dipindah ke Background Task), N-API secara otomatis menggunakan *Reference Counting* menahan garansi obyek Buffer dari sapuan Garbage Collector. Jika ada *Memory Leak* (Promise tidak ter-resolve dari Rust), maka memori 1GB tidak akan pernah terbebas selamanya di NestJS!

## SharedArrayBuffer dan Atomics Safety

Ketika menggunakan `SharedArrayBuffer` (SAB) pada Node.js, memori dapat dibagikan langsung antar *Worker Threads* dan Native Rust tanpa proses *serialization*. Berbeda dengan `Buffer` standar, SAB mengizinkan modifikasi paralel di mana thread Node.js dan thread Rust dapat menulis di memori yang sama secara simultan, sebuah resep sempurna untuk *Data Races*.

Untuk menangani *Data Races*, kita wajib memanfaatkan `Atomics` (di level JavaScript) dan operasi `Atomic` standar (di level Rust).

### Contoh Implementasi Atomics Safety

**Di sisi NestJS (TypeScript):**
```typescript
import { Injectable, Logger } from '@nestjs/common';
import { processSharedBuffer } from '../native-bindings/binding';

@Injectable()
export class SharedMemoryService {
  private readonly logger = new Logger(SharedMemoryService.name);

  public processParallelData(): Int32Array {
    // Alokasikan 4MB Shared Memory
    const sharedBuffer = new SharedArrayBuffer(4 * 1024 * 1024);
    const int32View = new Int32Array(sharedBuffer);

    this.logger.log('Mengirim SharedArrayBuffer ke Rust...');
    
    // Rust akan berjalan di background dan menulis ke buffer ini
    processSharedBuffer(sharedBuffer);

    // Menggunakan Atomics.load agar tidak membaca data setengah matang (stale data)
    const firstElement = Atomics.load(int32View, 0);
    this.logger.log(`Data pertama yang dibaca aman: ${firstElement}`);

    return int32View;
  }
}
```

**Di sisi Rust:**
```rust
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::atomic::{AtomicI32, Ordering};
use std::{slice, thread};

#[napi]
pub fn process_shared_buffer(mut shared_buffer: Buffer) -> Result<()> {
    // Memastikan pointer dialihkan menjadi Atomic type
    let ptr = shared_buffer.as_mut_ptr() as *mut AtomicI32;
    let length = shared_buffer.len() / 4; // Ukuran i32

    // SAFETY: Harus memastikan Node.js benar-benar melempar SharedArrayBuffer
    let atomic_slice: &'static [AtomicI32] = unsafe { slice::from_raw_parts(ptr, length) };

    thread::spawn(move || {
        // Melakukan mutasi secara aman di background thread
        atomic_slice[0].store(42, Ordering::SeqCst);
    });

    Ok(())
}
```

### Analisis Trade-Off Atomics
**Kelebihan:**
1. **Parallel Execution Aman:** Modifikasi multithread bisa dilakukan tanpa merusak integritas *pointer* atau menimpa memori parsial.
2. **Kinerja Non-blocking Terbaik:** Menghilangkan kunci (*Lock-Free*) pada skenario algoritma *wait-free*.

**Kekurangan:**
1. **Instruksi CPU Lebih Lambat:** Operasi `SeqCst` (Sequential Consistency) pada Atomics mengunci bus memori (*cache coherence traffic*), menyebabkan operasi spesifik menjadi lebih lambat dari read/write normal.
2. **Kompleksitas Reasoning:** Sangat sulit mendeteksi bug konkurensi *ABA problem* atau *deadlock* saat salah menggunakan `Atomics.wait`.

## Strategi Manajemen Buffer Pool (GC Pressure Reduction)

Alokasi *Buffer* besar berulang kali memicu _Garbage Collection_ (GC) masif di Node.js. Ketika GC bekerja untuk membersihkan 1GB memori usang, seluruh _Event Loop_ berhenti (Stop-The-World pause). 

Strategi **Buffer Pool Management** mengatasi ini dengan mengalokasikan satu *chunk* memori raksasa di awal (misal 512MB), lalu melakukan operasi *slicing* (`subarray`) untuk memberikan blok-blok kecil tanpa meminta RAM baru ke sistem operasi.

### Implementasi Buffer Pool Singleton

```typescript
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

@Injectable()
export class BufferPoolManager implements OnApplicationBootstrap {
  private readonly logger = new Logger(BufferPoolManager.name);
  private pool!: Buffer;
  private offset = 0;
  private readonly poolSize = 512 * 1024 * 1024; // 512MB

  public onApplicationBootstrap(): void {
    this.logger.log(`Mengalokasikan Buffer Pool utama sebesar ${this.poolSize / 1024 / 1024}MB`);
    this.pool = Buffer.allocUnsafeSlow(this.poolSize);
  }

  public acquire(size: number): Buffer {
    if (this.offset + size > this.poolSize) {
      throw new Error('Buffer Pool Exhausted! Diperlukan strategi Eviction atau GC paksa.');
    }
    
    // Memberikan reference / slice ke area pool utama (Zero-Copy slice)
    const chunk = this.pool.subarray(this.offset, this.offset + size);
    this.offset += size;
    return chunk;
  }

  public reset(): void {
    // Pada skenario tertentu (misal pergantian epoch/frame rendering), reset pointer 
    // agar pool bisa dipakai ulang tanpa mengalokasi ulang memori di tingkat OS
    this.offset = 0;
    this.logger.log('Buffer Pool telah di-reset untuk epoch selanjutnya.');
  }
}
```

### Analisis Trade-Off Buffer Pool
**Kelebihan:**
1. **GC Pressure Turun Drastis:** Menghilangkan penundaan aplikasi karena V8 Heap tak perlu dirombak terus-menerus.
2. **Alokasi O(1):** Meminta memori hanya memajukan _pointer_ (O(1) time complexity), berbanding dengan negosiasi sistem operasi untuk memori memori asli.

**Kekurangan:**
1. **Risiko Fragmentasi Memori:** Manajemen memori internal (Custom Allocator) diperlukan jika aplikasi mengembalikan (free) ukuran _chunk_ yang berbeda-beda.
2. **Potensi Memory Leak Permanen:** Memori 512MB ini akan terus dicadangkan (*reserved*) meski sistem sedang menganggur (*idle*).

## Zero-Copy IPC Strategies & Semantik Transfer Kepemilikan (Ownership Transfer)

Komunikasi Antar Proses (IPC - Inter-Process Communication), misalnya antara Node.js main thread dan Rust Daemon terpisah, secara tradisional memerlukan serialisasi (menyebabkan serialize/deserialize memory copy).

Dengan **Transfer Semantics**, kepemilikan struktur data dipindah sepenuhnya (*Moved*). Memori *Buffer* didetach dari thread lama sehingga memicu nol overhead.

### Implementasi Detachable ArrayBuffer (Worker Threads)

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Worker } from 'worker_threads';
import * as path from 'path';

@Injectable()
export class IPCZeroCopyService {
  private readonly logger = new Logger(IPCZeroCopyService.name);

  public delegateToWorker(): void {
    const workerPath = path.join(__dirname, 'heavy-worker.js');
    const worker = new Worker(workerPath);

    const bufferToTransfer = new ArrayBuffer(100 * 1024 * 1024); // 100MB

    this.logger.log(`Ukuran Buffer Sebelum Transfer: ${bufferToTransfer.byteLength} byte`);

    // Melempar bufferToTransfer melalui list Transferable objects
    worker.postMessage({ buffer: bufferToTransfer }, [bufferToTransfer]);

    // Buffer asli langsung kosong (Detached) setelah perintah transfer dieksekusi!
    this.logger.log(`Ukuran Buffer Sesudah Transfer: ${bufferToTransfer.byteLength} byte`);
    // Output: 0 byte. Memori telah diserahkan tanpa disalin!
  }
}
```

### Analisis Trade-Off Ownership Transfer
**Kelebihan:**
1. **Isolasi 100%:** Memori tak bisa diakses lagi oleh thread lama. Bebas mutlak dari _Data Races_.
2. **Efisiensi Transfer Gigabytes:** 10GB Data dapat dipindah antar _thread_ dalam < 1 milidetik karena hanya _Pointer Address_ yang dipindah tangankan.

**Kekurangan:**
1. **Thread Lama "Buta":** Pengembang tidak bisa memantau progres perubahan data di memori tersebut kecuali thread baru mengirim pesan balik.
2. **Validasi Tipe Data Hilang:** V8 menganggap memori lama sebagai detached (terlepas). Mengaksesnya menyebabkan *TypeError: Cannot perform %TypedArray%.prototype.slice on a neutered ArrayBuffer*.

## Edge Cases Lanjutan Produksi

1. **NUMA Node Crossing:** Pada Server berarsitektur Multi-CPU (Non-Uniform Memory Access), Buffer Pool yang dialokasikan di CPU-0 tapi diproses di thread Rust pada CPU-1 akan mengalami penalti bus komunikasi. Sistem harus mem-pin Thread (CPU Affinity) agar sesuai dengan wilayah fisik memori.
2. **Buffer.allocUnsafeSlow vs Buffer.alloc:** Penggunaan `Buffer.alloc()` menginisialisasi seluruh memori menjadi 0 (proses *Zeroing*), yang memakan CPU Time tinggi untuk Buffer GB. Gunakan `allocUnsafeSlow()` untuk menembus V8 internal pool batasan 8KB dan langsung memanggil C++ `malloc`, namun *developer* WAJIB menimpa (*overwrite*) seluruh sel memori sebelum diekspos keluar guna menghindari eksploitasi keamanan kebocoran RAM OS.
3. **Mmap Backed Buffers:** Ketika ukuran data melebihi RAM fisik, Node.js dan Rust dapat dikawinkan dengan operasi OS level `mmap()`. Rust melakukan File-Memory mapping, lalu mengirim _pointer_ mentahnya ke Node.js sebagai *External Buffer*. Operasi baca Node.js transparan (seperti baca RAM), padahal OS melakukan _Page Faults_ membaca blok dari SSD NVMe (Zero-Copy dari Disk ke JavaScript).

## Anti-Pattern vs Best Practice Lanjutan

❌ **Anti-Pattern 3: Polling SharedArrayBuffer tanpa Atomics.wait**
```typescript
// SALAH: Thread Node.js melakukan while-loop CPU Spin yang 
// membakar siklus CPU (100% Core Usage) hanya untuk menunggu sinyal Rust.
function waitWrong(sharedView: Int32Array): void {
  while (sharedView[0] !== 1) { 
    // CPU BURN
  }
}
```

✅ **Best Practice 3: Atomics.wait Blocking Ramah Sistem**
```typescript
// BENAR: Mengistirahatkan eksekusi Node (Sleep) secara efisien, OS melakukan 
// Context Switch hingga Rust memanggil Atomics.notify()
function waitRight(sharedView: Int32Array): void {
  const status = Atomics.wait(sharedView, 0, 0, 5000); // Timeout 5 detik
  if (status === 'timed-out') {
    throw new Error('Rust IPC Deadlock Detected');
  }
}
```
