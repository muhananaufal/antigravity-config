# Integrasi Binding Rust dengan Node.js (N-API) melalui napi-rs

Arsitektur aplikasi berbasis Node.js/NestJS sering dihadapkan pada keterbatasan alamiah V8 JavaScript Engine terkait komputasi CPU intensif (CPU-bound operations) yang memblokir _event loop_, seperti pemrosesan gambar, kriptografi masif, atau _data parsing_ tingkat rendah.

`napi-rs` menghadirkan jembatan elegan: menulis logika berat menggunakan bahasa Rust (C-level performance, Memory Safety murni) dan mengeksposnya sebagai modul asli (`.node` addon) yang dapat diimpor layaknya modul JavaScript biasa di dalam layanan NestJS tanpa _overhead_ serialisasi JSON lambat seperti pada microservices HTTP.

## Arsitektur N-API Jembatan NestJS & Rust

```text
+-----------------------+              +-----------------------+
|  NestJS V8 JS Engine  |              |   Native OS Machine   |
|                       |              |                       |
|  const { process } =  |   FFI Call   |  Rust Compiled Code   |
|   require('./addon')  | ===========> |  (process_data_fn)    |
|                       |              |                       |
|   JS Data Structure   | <=========== |   Rust C-ABI Return   |
+-----------------------+  (Zero-Copy) +-----------------------+
```

## Implementasi Produksi

Berikut adalah praktik mem-bypass V8 dengan mengekspor fungsi kalkulasi matematika kompleks dari Rust, dikompilasi, dan diinjeksi ke NestJS Service secara Type-Safe murni.

### 1. Sisi Rust (Modul `src/lib.rs` dari napi-rs)

Kode Rust ini diekspos secara otomatis dengan anotasi `#[napi]`, menghasilkan file `.node` library Native API.

```rust
#![deny(clippy::all)]

use napi_derive::napi;

#[napi]
pub struct HeavyProcessor {
    base_multiplier: f64,
}

#[napi]
impl HeavyProcessor {
    #[napi(constructor)]
    pub fn new(base_multiplier: f64) -> Self {
        Self { base_multiplier }
    }

    /// Fungsi berat yang berjalan paralel melepaskan Thread V8
    #[napi]
    pub fn calculate_fractal_matrix(&self, iterations: u32) -> f64 {
        let mut total = 0.0;
        // Simulasi komputasi intensif yang mematikan jika di JS
        for i in 0..iterations {
            total += (i as f64 * self.base_multiplier).sqrt().sin();
        }
        total
    }
}
```

### 2. Sisi NestJS (Modul Wrapper & Service)

Setelah Rust dikompilasi (via `@napi-rs/cli`), module akan menghasilkan file `binding.js` beserta TypeScript `.d.ts` definitions yang dijamin type-safe.

```typescript
import { Injectable, Logger } from '@nestjs/common';
// Impor Addon C++ / Rust hasil kompilasi napi-rs
import { HeavyProcessor } from '../native-bindings/binding'; 

@Injectable()
export class ComputationService {
  private readonly logger = new Logger(ComputationService.name);
  private readonly processor: HeavyProcessor;

  constructor() {
    try {
      // Inisialisasi Native Rust Struct
      this.processor = new HeavyProcessor(1.414);
      this.logger.log('Native Rust N-API Processor berhasil dimuat.');
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.logger.error(`Gagal memuat Rust Addon: ${error.message}`, error.stack);
      }
      throw error;
    }
  }

  public getFractalData(iterations: number): number {
    if (iterations <= 0) {
      throw new Error('Jumlah iterasi harus positif.');
    }

    const startTime = performance.now();
    // Eksekusi FFI langsung menuju memori mesin C/Rust!
    const result = this.processor.calculateFractalMatrix(iterations);
    const endTime = performance.now();

    this.logger.debug(`Kalkulasi ${iterations} iterasi via Rust memakan waktu ${endTime - startTime}ms`);
    return result;
  }
}
```

## Unit Testing / Service Mock Test Suite

Menguji _Native Module_ membutuhkan isolasi penuh atau mock file _binding_ jika tidak bisa dikompilasi pada CI test.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ComputationService } from './computation.service';

// 1. Mocking native binding sebelum import service
jest.mock('../native-bindings/binding', () => {
  return {
    HeavyProcessor: jest.fn().mockImplementation(() => ({
      calculateFractalMatrix: jest.fn().mockReturnValue(42.42),
    })),
  };
});

describe('ComputationService', () => {
  let service: ComputationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ComputationService],
    }).compile();

    service = module.get<ComputationService>(ComputationService);
  });

  it('should instantiate native processor successfully', () => {
    expect(service).toBeDefined();
  });

  it('should throw error on negative iteration', () => {
    expect(() => service.getFractalData(-10)).toThrow('Jumlah iterasi harus positif.');
  });

  it('should call native rust module and return f64', () => {
    const result = service.getFractalData(100);
    expect(result).toBe(42.42); // Nilai mock 
  });
});
```

## Analisis Trade-Off

**Kelebihan:**
1. **Kecepatan Maksimal Mutlak:** Komputasi murni setara bahasa C. Menghilangkan bottleneck parsing/JIT JavaScript. Operasi berat berjalan kilat tanpa memblokir sistem NestJS.
2. **Zero Serialization Cost:** FFI (Foreign Function Interface) via N-API tidak memerlukan serialisasi JSON string (berbeda dengan HTTP/gRPC microservice ke golang/rust backend luar).
3. **Memory Safety by Design:** Rust menjamin tidak adanya _Segfaults_ atau kebocoran memori misterius yang umum terjadi jika menggunakan modul _C++ node-gyp_ lama.

**Kekurangan:**
1. **Kompleksitas CI/CD Silang-OS (Cross-Compilation):** Addon `.node` harus dikompilasi ulang secara persis untuk _target machine architecture_ (contoh: build macOS lokal tidak akan jalan di Docker Alpine Linux x86).
2. **Kurva Belajar (Steep Learning Curve):** Menyatukan developer TypeScript backend dengan ekosistem _Borrow Checker_ Rust adalah beban sumber daya manusia tinggi.
3. **Potensi Panic Mematikan (Fatal Crash):** Walaupun aman, jika kode Rust mengalami `panic!` yang tidak ter-catch, seluruh thread utama Node.js akan mati mendadak (_hard crash_).

## Anti-Patterns

❌ **Anti-Pattern 1: Thread-Blocking FFI Murni Tanpa Async**
```rust
// SALAH: Mengunci main thread V8 sepenuhnya selama 5 detik, 
// semua request HTTP NestJS lain ikut mati membeku!
#[napi]
pub fn heavy_work_blocking() {
    std::thread::sleep(std::time::Duration::from_secs(5));
}
```

✅ **Best Practice 1: Offloading ke Worker Thread (Async N-API)**
```rust
// BENAR: Menggunakan Async/Task di N-API (menghasilkan JS Promise)
use napi::{Task, Env, Result};
#[napi]
pub fn heavy_work_async() -> AsyncTask<HeavyTask> {
    // Akan dikerjakan di libuv thread-pool, V8 main thread tetap lancar
}
```

❌ **Anti-Pattern 2: Sering memanggil FFI N-API untuk kalkulasi super kecil**
```typescript
// SALAH: Biaya (overhead) context-switch dari V8 ke Rust lebih lambat
// daripada dieksekusi langsung oleh Node.js untuk operasi remeh!
for (let i = 0; i < 100000; i++) {
  const c = rustBinding.addTwoNumber(1, 2); 
}
```

✅ **Best Practice 2: Batch Transfering / Satu Call Komprehensif**
```typescript
// BENAR: Kumpulkan data di TS, kirim sekaligus ke Rust, biarkan Rust me-looping di dalam.
const data = [/* jutaan elemen */];
const result = rustBinding.processAllAtOnce(data);
```

## Production Edge Cases

1. **Docker / Alpine Musl Mismatch:** Jika server produksi menggunakan base image `node:alpine` (menggunakan `musl libc`), addon yang di-_build_ menggunakan standar GNU `libc` (seperti Ubuntu) akan mengalami fatal error `cannot open shared object file`. Kompilasi harus sesuai target `x86_64-unknown-linux-musl`.
2. **Panic di dalam Rust yang tidak tertangkap (Unwinding the stack):** Jika kode Rust mengalami indeks array di luar batas (Out of Bounds), proses Node.js akan mati dengan Segmentation Fault kotor. Seluruh _logic_ Rust harus dibungkus dengan propagasi _Result_ atau penangkap krisis untuk mengembalikan Error _Exception_ ke alam JavaScript secara bersih.
3. **Versi Node ABI Berubah:** N-API ABI (Application Binary Interface) sangat stabil, namun jika upgrade versi Node.js besar secara drastis, _binding_ wajib direkompilasi untuk memastikan integritas ABI yang tidak bocor.

## Pendalaman Teknis Lanjutan

### Napi-RS Derive Macro Internals (`#[napi]`)

Anotasi `#[napi]` pada Rust sebenarnya adalah _Procedural Macro_ yang menghasilkan _boilerplate_ jembatan C-ABI secara otomatis. Macro ini mengkonversi _struct_ dan tipe data natif Rust menjadi representasi `napi_value` yang dimengerti oleh runtime Node.js.

Proses di balik layar:
1. **Pendaftaran Modul:** `napi_register_module_v1` diekspos secara implisit untuk titik masuk _loader_ Node.
2. **Konversi Tipe Data (Type Conversion):** Parameter fungsi yang berjenis `f64` secara otomatis dibongkar (unwrap) dari `napi_value` dengan asersi tipe yang ketat, menolak argumen jika runtime JS mengirimkan _string_ alih-alih _number_.
3. **Eksposur Metode (Method Exposure):** Implementasi `impl` dari sebuah Struct diubah menjadi abstraksi _JavaScript Class Prototype_.

**Keuntungan Macro Derive:** Menghapus ratusan baris kode C-ABI _unsafe_, sehingga developer cukup menulis kode Rust murni yang idiomatis.

### Async Rust Function Bridging

Memblokir _event loop_ adalah dosa terbesar di Node.js/NestJS. Untuk komputasi berat, N-API menyediakan _thread-pool_ asinkron via `libuv`. Menggunakan `napi-rs`, kita mengembalikan tipe *AsyncTask* yang secara transparan dipetakan sebagai JavaScript `Promise`.

```rust
// src/lib.rs
use napi::{Env, Error, Result, Task};
use napi_derive::napi;
use std::time::Duration;

pub struct HeavyAsyncTask {
    pub payload_size: u32,
}

#[napi]
impl Task for HeavyAsyncTask {
    type Output = u64;
    type JsValue = napi::JsNumber;

    // Berjalan di background thread libuv, TANPA akses ke runtime JS
    fn compute(&mut self) -> Result<Self::Output> {
        let mut result: u64 = 0;
        for i in 0..self.payload_size {
            // Simulasi blocking
            std::thread::sleep(Duration::from_micros(1));
            result += i as u64;
        }
        Ok(result)
    }

    // Berjalan di main thread V8, MENGEMBALIKAN nilai ke JS
    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        env.create_uint32(output as u32)
    }
}

// Ekspos ke JS yang me-return sebuah Promise
#[napi]
pub fn run_heavy_task_async(payload_size: u32) -> AsyncTask<HeavyAsyncTask> {
    AsyncTask::new(HeavyAsyncTask { payload_size })
}
```

Implementasi di TypeScript:
```typescript
import { runHeavyTaskAsync } from '../native-bindings/binding';

export class BackgroundWorker {
  public async processDataAsync(size: number): Promise<number> {
    // Non-blocking, mengizinkan request HTTP lain beroperasi
    const result = await runHeavyTaskAsync(size);
    return result;
  }
}
```

### Error Handling Across FFI Boundary

Dalam lingkungan jembatan Rust ke JS, propagasi _Error_ sangat krusial. Jika terjadi `panic!` pada Rust yang tidak dikendalikan (unwinding), maka _process_ Node.js akan seketika *Crash*.

Best practice: Gunakan Tipe `napi::Result<T>` untuk mengubah konvensi error penanganan _Borrow Checker_ menjadi _Exception_ Javascript yang bisa di `catch` secara transparan.

```rust
// rust side
use napi::{Error, Result, Status};

#[napi]
pub fn divide_safe(a: f64, b: f64) -> Result<f64> {
    if b == 0.0 {
        // Melempar JavaScript Error: "Division by zero"
        return Err(Error::new(
            Status::InvalidArg,
            "Division by zero is not permitted",
        ));
    }
    Ok(a / b)
}
```

```typescript
// typescript side
import { divideSafe } from '../native-bindings/binding';

try {
  const res = divideSafe(10, 0);
} catch (error: unknown) {
  if (error instanceof Error) {
    // Output: Error: Division by zero is not permitted
    console.error(error.message); 
  }
}
```

### Memory Safety Guarantees

N-API memanfaatkan kekuatan terbesar Rust: **Memory Safety tanpa Garbage Collector (GC).**
- **Ownership (Kepemilikan):** Obyek Rust di-_manage_ oleh runtime Rust, sementara objek JS dikelola V8 GC.
- **Dangling Pointers Dihilangkan:** Saat meneruskan _ArrayBuffer_ besar dari Node.js (sebagai _Buffer_) ke Rust tanpa menyalin (Zero-Copy), Rust memverifikasi umur pakai buffer secara statis untuk mencegah _Use-After-Free_.
- **Buffer Transfer:**

```rust
use napi::bindgen_prelude::Buffer;

#[napi]
pub fn parse_binary_buffer(data: Buffer) -> u32 {
    // 'data' mereferensikan memori yang dialokasikan oleh Node.js (V8)
    // Tanpa mengcopy (zero-copy), Rust membaca byte-byte tersebut dengan aman.
    data.len() as u32
}
```

### Cross-Platform Build dengan GitHub Actions

Melakukan kompilasi secara manual untuk banyak OS sangat melelahkan. Napi-rs menyediakan fitur otomatisasi via Matrix Build di GitHub Actions.

```yaml
# .github/workflows/build-napi.yml
name: Build Native Bindings

on:
  push:
    branches: [ "main" ]

jobs:
  build:
    name: Build on ${{ matrix.settings.os }} - ${{ matrix.settings.target }}
    runs-on: ${{ matrix.settings.os }}
    strategy:
      fail-fast: false
      matrix:
        settings:
          - host: macos-latest
            target: x86_64-apple-darwin
          - host: macos-latest
            target: aarch64-apple-darwin
          - host: windows-latest
            target: x86_64-pc-windows-msvc
          - host: ubuntu-latest
            target: x86_64-unknown-linux-gnu
          - host: ubuntu-latest
            target: x86_64-unknown-linux-musl

    steps:
      - uses: actions/checkout@v4
      - name: Install Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.settings.target }}
          
      - name: Build
        run: |
          npm ci
          npm run build:napi -- --target ${{ matrix.settings.target }}
          
      - name: Upload Artifact
        uses: actions/upload-artifact@v4
        with:
          name: bindings-${{ matrix.settings.target }}
          path: '*.node'
```

Pola matrix _build_ ini memastikan `npm install` (atau ketika paket dipublikasikan ke npm/private registry) selalu merujuk pada artefak biner yang tepat (melalui field `optionalDependencies` di _package.json_), mencegah perlunya _node-gyp_ dan _C++ build tools_ ter-install pada *Production Server*.

## Ringkasan Anti-Pattern & Edge Cases Tambahan

❌ **Anti-Pattern 3: Passing Tipe Data Non-Primitif Kompleks (Deep Nested Objects)**
Melakukan deserialisasi/serialize JSON (misal `serde_json::from_str`) hanya agar bisa dilempar sebagai String antara Rust dan JS merusak filosofi performa Zero-Copy.
✅ **Best Practice 3:** Kirim primitif (Number, String singkat) atau representasi *Buffer* Biner (Protobuf / Flatbuffers) sehingga Rust bisa mengurai secara native tanpa overhead.

**Edge Case 4: Thread Limit pada libuv Pool**
Node.js _libuv thread-pool_ secara default hanya bernilai 4 (diatur via variabel lingkungan `UV_THREADPOOL_SIZE`). Jika NestJS meluncurkan 10 operasi Asinkron berbasis NAPI serentak (Async Task), 6 operasi sisanya harus menunggu antrian blokir! Atur env variable ini untuk kapasitas produksi lebih besar jika menggunakan Heavy FFI tasks (contoh: `UV_THREADPOOL_SIZE=16`).
