# Hashing Zero-Overhead Milidetik via N-API Rust Bridges

Dalam arsitektur mikroservis atau gateway API yang menangani otentikasi masif (ribuan Request Per Second - RPS), implementasi *password hashing* menggunakan algoritma tahan lama (seperti Argon2id atau bcrypt) sepenuhnya memblokir sumber daya CPU. 

Implementasi bawaan JavaScript (meski menggunakan *crypto* bawaan Node.js) kerap terhalang oleh inefisiensi alokasi memori V8. Mentransplantasi komputasi hashing ke modul Rust N-API (`napi-rs`) melahirkan jembatan *zero-overhead* yang melepaskan beban _Event Loop_ dan memecahkan batasan skalabilitas asimtotik komputasi Node.js.

## Diagram Alir Offloading Hashing

```text
+-------------------+           +-----------------------+           +----------------------+
| NestJS Auth Guard |           |   N-API Bridge Async  |           | Rust Libuv Thread    |
| (V8 Main Thread)  |           |   (Promise/Future)    |           | (Argon2 Execution)   |
+-------------------+           +-----------------------+           +----------------------+
          |                                 |                                 |
   hashPassword(pwd)  ================>   Spawn Task  ---------------->  Compute Hashing
          |                                 |                            (No V8 Blocking)
   (Can serve other HTTP)                   |                                 |
          | <======================  Resolve JS Promise  <---------------  Return String
```

## Implementasi Produksi

Berikut penerapan skema Async Task di Rust untuk menjamin bahwa Thread utama V8 NestJS TIDAK PERNAH terblokir saat mengeksekusi komputasi Argon2id yang notabene memakan ratusan milidetik.

### 1. N-API Rust Module (`src/lib.rs`)

```rust
#![deny(clippy::all)]

use napi::{Task, Env, Result};
use napi_derive::napi;
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHasher, SaltString},
    Argon2,
};

pub struct AsyncHashTask {
    password: String,
}

#[napi]
impl Task for AsyncHashTask {
    type Output = String;
    type JsValue = String;

    /// Dijalankan di Thread-Pool Libuv (Paralel, Non-Blocking)
    fn compute(&mut self) -> Result<Self::Output> {
        let salt = SaltString::generate(&mut OsRng);
        // Inisialisasi spesifikasi Argon2id modern
        let argon2 = Argon2::default();

        let password_hash = argon2
            .hash_password(self.password.as_bytes(), &salt)
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))?
            .to_string();

        Ok(password_hash)
    }

    /// Mengembalikan hasil komputasi (String) menjadi nilai balik JS (V8 String)
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Fungsi yang dapat dipanggil dari JS (mengembalikan Promise<string>)
#[napi]
pub fn hash_password_async(password: String) -> AsyncTask<AsyncHashTask> {
    AsyncTask::new(AsyncHashTask { password })
}
```

### 2. Integrasi NestJS AuthService

```typescript
import { Injectable, Logger } from '@nestjs/common';
// Binding import 
import { hashPasswordAsync } from '../native-bindings/binding';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  public async registerUser(plainText: string): Promise<{ hash: string; ts: number }> {
    if (!plainText || plainText.length < 8) {
      throw new Error('Kredensial terlalu lemah.');
    }

    const t0 = performance.now();
    try {
      // Panggilan ini TIDAK akan menghentikan sistem NestJS merespons request lain!
      const hashedPassword = await hashPasswordAsync(plainText);
      const t1 = performance.now();

      this.logger.debug(`Hashing Native Rust selesai dalam ${Math.round(t1 - t0)}ms`);
      return {
        hash: hashedPassword,
        ts: Date.now(),
      };
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.logger.error(`Kegagalan modul Kripto Rust: ${error.message}`, error.stack);
      }
      throw new Error('Internal Security Error');
    }
  }
}
```

## Unit Testing / Service Mock Test Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';

jest.mock('../native-bindings/binding', () => ({
  hashPasswordAsync: jest.fn().mockImplementation(async (pwd: string) => {
    if (pwd === 'error_trigger') throw new Error('Rust panic simulated');
    return `$argon2id$v=19$m=19456,t=2,p=1$mocked_salt$mocked_hash`;
  }),
}));

describe('AuthService Native Cryptography', () => {
  let service: AuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AuthService],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should reject short passwords', async () => {
    await expect(service.registerUser('1234567')).rejects.toThrow('Kredensial terlalu lemah.');
  });

  it('should return hashed password from native rust bridge', async () => {
    const result = await service.registerUser('strong_password_here');
    expect(result.hash).toContain('$argon2id');
  });

  it('should handle rust native errors safely', async () => {
    await expect(service.registerUser('error_trigger')).rejects.toThrow('Internal Security Error');
  });
});
```

## Analisis Trade-Off

**Kelebihan:**
1. **Unblocked Event Loop:** Komputasi berat kriptografi tidak membuat thread Node.js menjerit atau *hang*. Node.js tetap bisa melayani ratusan request I/O database bersamaan.
2. **Kinerja Eksekusi Super Tinggi:** Crate (Library) kriptografi Rust umumnya dioptimasi di tingkat _assembly_ instruksi CPU SIMD, jauh melampaui porting JavaScript/WASM.
3. **Standar Keamanan Abadi:** Ekosistem _Crypto_ Rust (seperti crate `argon2`) diaudit sangat ketat secara memori (tidak ada *Buffer Overflow* yang merusak integritas kunci enkripsi).

**Kekurangan:**
1. **Thread Pool Exhaustion:** Karena memanfaatkan Libuv _thread pool_, jika ada serbuan 50 request *login* secara paralel di NestJS (sedangkan pool standar `UV_THREADPOOL_SIZE` hanya 4), sisa request ke-5 akan macet tertunda (_queued_).
2. **Distribusi Biner yang Sulit:** Sama seperti binding N-API umumnya, *deployment pipeline* (Docker/CI) wajib mampu mengkompilasi *toolchain* Rust yang memperlambat waktu build.
3. **String Allocation Overhead:** Memindahkan (copy) tipe data *String* dari JS ke Rust tetap memiliki biaya kecil (meskipun milidetik) akibat konversi *encoding* V8 (UTF-16) ke UTF-8 (Rust).

## Anti-Patterns

❌ **Anti-Pattern 1: Menggunakan fungsi Hashing Synchronous (Blocking)**
```rust
// SALAH: Jika dieksekusi, V8 terhenti total selama 500ms. Node.js tidak responsif!
#[napi]
pub fn hash_password_sync(password: String) -> String {
    let argon2 = Argon2::default();
    // Blocking eksekusi...
}
```

✅ **Best Practice 1: Mendelegasikan ke Libuv AsyncTask**
```rust
// BENAR: Menggunakan trait Task dari N-API agar dieksekusi di background thread
pub fn hash_password_async(password: String) -> AsyncTask<AsyncHashTask> { ... }
```

❌ **Anti-Pattern 2: Menangani error panik ke dunia JS tanpa Result**
```rust
// SALAH: Jika `unwrap()` panik, seluruh service Node.js langsung Crash mematikan!
let hash = argon2.hash_password(pwd, &salt).unwrap(); 
```

✅ **Best Practice 2: Pemetaan Error Rust ke Status Eksepsi NAPI**
```rust
// BENAR: Melaporkan kegagalan secara bersih agar tertangkap catch() di JS
let hash = argon2.hash_password(pwd, &salt)
    .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))?;
```

## Production Edge Cases

1. **Kehabisan Libuv Threads (Starvation):** Secara bawaan, Node.js hanya punya 4 background threads. Jika modul kripto sering dipanggil (high load API), *thread pool* akan sesak napas. Solusi mutlak adalah mendefinisikan `process.env.UV_THREADPOOL_SIZE = "16"` di root `main.ts` atau via _System Environment_ sebelum aplikasi NestJS hidup.
2. **Batas Ukuran Payload String Hashing:** Algoritma hash tertentu memiliki restriksi panjang (misal bcrypt maksimal 72 byte). Jika pengguna menginput teks 100kb, API akan menolaknya di dalam mesin Rust yang menghasilkan error. Validasi sisi TypeScript wajib mengunci string maksimal (misal Max 100 *Chars*) sebelum mengirimnya menyeberang *bridge*.
3. **Kebocoran Memori String (Zeroization):** Dalam keamanan mutlak (militer/finansial), parameter *password string* dalam memori RAM harus dihapus atau di-nol-kan (zeroed out) setelah hashing selesai agar *memory dump* peretas tidak menemukan teks *plain*. Menggunakan crate `zeroize` di Rust adalah kewajiban tersembunyi yang tidak disediakan N-API secara cuma-cuma.

## Perbandingan Performa: WASM vs N-API

Dalam ekosistem Node.js modern, terdapat dua opsi populer untuk offloading komputasi kriptografi: WebAssembly (WASM) dan N-API. Walaupun WASM menawarkan portabilitas tingkat tinggi dan isolasi sandbox yang aman, kinerjanya sering kali tersendat ketika berhadapan dengan operasi I/O dan alokasi memori string yang terus-menerus melintasi batas runtime.

1. **Overhead Konversi Tipe Data:** WASM beroperasi pada model memori linear tersendiri. Setiap kali data (seperti plaintext password) dikirim dari JavaScript ke WASM, diperlukan penyalinan byte secara penuh (memory copy). Sebaliknya, N-API memungkinkan akses langsung atau konversi string V8 yang lebih minim penyalinan.
2. **Akses ke Instruksi Prosesor (SIMD & Threading):** N-API memanggil modul _native_ (.node) yang dikompilasi secara spesifik untuk arsitektur target (x86_64, aarch64). Ini membuka akses murni ke eksekusi SIMD (AVX2, AVX-512) dan manajemen thread native (pthread), sementara fungsionalitas SIMD di dalam mesin WASM V8 (melalui `wasm-simd`) memiliki limitasi performa dan harus melewati lapisan abstraksi.
3. **Latensi Inisialisasi:** Memuat modul WASM memerlukan waktu parsial untuk kompilasi Just-In-Time (JIT) pada awal aplikasi. Modul N-API berupa shared library C-ABI yang dimuat instan oleh OS loader.

Secara umum, N-API menghasilkan *throughput* 2x-5x lebih tinggi dalam komputasi beban berat murni kriptografi dibanding modul WASM yang identik.

## Akselerasi SIMD via Rust

Rust sangat unggul karena mampu mengeksekusi komputasi paralel pada tingkat level prosesor (instruksi SIMD) secara deterministik. Pada saat melakukan Argon2, kita bisa memastikan crate `argon2` memaksimalkan fitur hardware.

### Konfigurasi Cargo.toml untuk SIMD
Agar Rust benar-benar memaksimalkan arsitektur server (misalnya instance AWS Graviton atau Intel Xeon), kita harus menyetel *flags* kompilasi di level *Cargo*.

```toml
[profile.release]
lto = true
codegen-units = 1
opt-level = 3
panic = 'abort'

# Di build pipeline, selalu setel RUSTFLAGS="-C target-cpu=native"
```

Implementasi SIMD di sisi Rust beroperasi transparan. Tidak ada perubahan drastis pada kode NestJS, namun CPU akan memproses register matriks (256-bit atau 512-bit) secara paralel di level silikon. Ini memangkas konsumsi milidetik Argon2 secara drastis (hingga 60% waktu eksekusi).

## Benchmarks Throughput Batch Processing

Ketika menangani _import_ jutaan pengguna (seperti migrasi sistem lama ke NestJS), proses autentikasi memerlukan kalkulasi hash massal (*batching*). Jika kita melakukan pemanggilan `hashPasswordAsync` dalam iterasi `Promise.all` ribuan elemen sekaligus, kita berisiko membanjiri pool UV (Libuv).

Berikut adalah representasi throughput benchmark antara metode iteratif biasa, *Promise.all* buta, vs *Chunked Batch Processing*.

| Strategi Paralelisme Node.js | RPS Hashing (Argon2id) | Kondisi Event Loop | Risiko Memory Leak |
|------------------------------|------------------------|--------------------|--------------------|
| Sinkronus Hashing (Loop)     | 2 Request / sec        | Terblokir 100%     | Rendah             |
| `Promise.all` (Unbounded)    | Crash (OOM/Timeout)    | Antrian Macet      | Sangat Tinggi      |
| **Batch Chunking (100 item)**| **400 Request / sec**  | Lancar             | Sangat Rendah      |

### Strategi Produksi: Chunked Batch Processing TypeScript

```typescript
export class CryptoBatchService {
  /**
   * Mengatur arus lalu lintas hash agar Libuv tidak crash.
   */
  public async hashInBatches(passwords: string[], chunkSize: number = 10): Promise<string[]> {
    const results: string[] = [];
    // Memecah beban kerja berdasarkan ukuran chunk
    for (let i = 0; i < passwords.length; i += chunkSize) {
      const chunk = passwords.slice(i, i + chunkSize);
      // Hanya kirim sejumlah kecil task ke background thread Libuv
      const chunkResults = await Promise.all(chunk.map((pwd) => hashPasswordAsync(pwd)));
      results.push(...chunkResults);
    }
    return results;
  }
}
```

## Komputasi Hash Secara Streaming

Untuk _file hashing_ skala besar (misalnya ISO image 50GB atau video enkripsi P2P), membaca file utuh ke memori RAM Node.js adalah bencana (OOM Exception). N-API Rust memungkinkan penerimaan _stream buffer_ per bongkahan file untuk diumpankan ke state mesin SHA-256 atau BLAKE3 tanpa merusak RAM Node.js.

### Implementasi TypeScript Streaming Hash (NestJS Interceptor/Stream)

```typescript
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
// Asumsikan kita memiliki transform stream N-API Rust untuk hashing
import { NativeHashStream } from '../native-bindings/binding';

export class FileSecurityService {
  public async verifyFileIntegrity(filePath: string): Promise<string> {
    const readStream = createReadStream(filePath, { highWaterMark: 1024 * 1024 }); // 1MB Buffer
    const hasherStream = new NativeHashStream(); // C++ / Rust Object Wrapped via NAPI

    try {
      // Mengalirkan file berukuran gigabyte dalam memori kecil
      await pipeline(readStream, hasherStream);
      
      const finalHashDigest: string = hasherStream.digest('hex');
      return finalHashDigest;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown IO Error';
      throw new Error(`Gagal memverifikasi stream file: ${errMsg}`);
    }
  }
}
```

### Simulasi N-API Streaming Hasher di Rust

```rust
use napi::{Env, JsBuffer, Result};
use napi_derive::napi;
use sha2::{Sha256, Digest};

#[napi(custom_finalize)]
pub struct NativeHashStream {
    hasher: Option<Sha256>,
}

#[napi]
impl NativeHashStream {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            hasher: Some(Sha256::new()),
        }
    }

    /// Metode update akan terus menerima bongkahan (chunk) data buffer dari Node.js stream
    #[napi]
    pub fn update(&mut self, chunk: JsBuffer) -> Result<()> {
        let buffer_data = chunk.into_value()?;
        
        if let Some(h) = self.hasher.as_mut() {
            h.update(&buffer_data);
        } else {
            return Err(napi::Error::new(
                napi::Status::GenericFailure,
                "State hasher telah ditutup atau memori korup".to_string(),
            ));
        }
        
        Ok(())
    }

    /// Mengekstrak digest akhir (sebagai Hex String) dan me-null-kan state internal
    #[napi]
    pub fn digest(&mut self) -> Result<String> {
        let hasher_instance = self.hasher.take().ok_or_else(|| {
            napi::Error::new(
                napi::Status::GenericFailure,
                "Digest sudah dikomputasi, instance tidak bisa digunakan lagi".to_string(),
            )
        })?;
        
        let result = hasher_instance.finalize();
        Ok(hex::encode(result))
    }
}

impl napi::ObjectFinalize for NativeHashStream {
    fn finalize(self, mut _env: Env) -> Result<()> {
        // Rust secara otomatis akan menghancurkan self.hasher (Drop) saat object ini dibersihkan GC Node.js
        Ok(())
    }
}
```

## Analisis Trade-Off Streaming N-API

**Kelebihan:**
1. **Zero RAM Explosion:** File bergigabyte dapat dienkripsi/hashing dengan konsumsi RAM konstan (O(1)).
2. **Backpressure Terkelola:** Node.js Streams secara otomatis memberikan jeda (*pause*) saat Rust sedang sibuk menghitung instruksi SIMD, menjaga harmoni sistem.
3. **Penyatuan ke Fastify/Express:** Stream NAPI ini bisa langsung dikoneksikan (`pipe`) dengan HTTP Request Upload Stream (seperti `multipart/form-data`) tanpa menyimpan file fisik.

**Kekurangan:**
1. **Kompleksitas State di C/Rust:** _Garbage Collector_ JavaScript dan _Drop Checker_ Rust tidak selalu selaras saat Stream ditutup mendadak. Harus diatur _clean up_ manual agar tidak *memory leak*.
2. **Overhead Konteks Switch Berulang:** Jika ukuran *chunk* stream terlalu kecil (misal 1KB), biaya panggilan N-API (menyeberang dari V8 ke Native) bisa lebih mahal dari kalkulasi hash itu sendiri. Disarankan buffer 1MB-5MB per _chunk_.

## Tambahan Anti-Patterns & Best Practices

❌ **Anti-Pattern 3: Menghajar UV Thread Pool Tanpa Batas**
```typescript
// SALAH: Mencekik Event Loop dan me-reject requests dengan OutOfMemory atau timeout 
export class AntiPatternBatch {
  async processMillions(users: string[]) {
    await Promise.all(users.map(u => hashPasswordAsync(u)));
  }
}
```

✅ **Best Practice 3: Throttle menggunakan Semaphore atau Batch Chunking**
Gunakan library seperti `p-limit` atau implementasikan chunking logis seperti pola `CryptoBatchService` di atas.

❌ **Anti-Pattern 4: Menyimpan secret state secara persisten di NAPI Global**
```rust
// SALAH: Menyimpan objek state hasher di variabel global statik C++ / Rust (Memicu Data Race di multithreading)
static mut GLOBAL_HASHER: Option<Argon2> = None;
```

✅ **Best Practice 4: State Lifecycle Terisolasi**
```rust
// BENAR: Mengikat referensi memori (Hashes, Context) ke instance Object/Class NAPI yang spesifik per Request
#[napi(custom_finalize)]
pub struct ScopedNativeHashStream {
    hasher: Option<blake3::Hasher>
}
```

## Edge Cases Tambahan Produksi
1. **Pemutusan Koneksi Saat Streaming HTTP (Client Abort):** Saat client memutus koneksi di tengah upload _file_ besar, Stream Node.js akan menembakkan _event_ `error` atau `close`. Objek _NativeHashStream_ yang dialokasikan N-API bisa menjadi 'zombie' dalam _heap_ C++ bila _destructor_ (metode *Drop* di Rust atau *Finalize* NAPI) tidak diimplementasikan dengan sempurna merespons instruksi pembatalan _GC_.
2. **Inkompatibilitas CPU Kuno:** Pemaksaan aktivasi kompilasi _flag_ SIMD ekstrim (seperti instruksi AVX-512) akan memicu _Instruction Fault_ / _Segmentation Fault (Core Dumped)_ jika _node_ container dijalankan pada instans cloud lawas atau hardware ARM yang tidak mendukung *opcode* tersebut. Wajib ada perlindungan deteksi *CPU Feature runtime fallback* pada saat program berjalan.
