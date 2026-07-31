# FFI Bridge (C/Rust) di PHP 8.4 & Laravel 11/12

## 1. Pendahuluan & Konsep Dasar FFI (Foreign Function Interface)

PHP 7.4 memperkenalkan FFI (Foreign Function Interface), yang memungkinkan PHP untuk memanggil fungsi C dan menggunakan tipe data C dari dalam PHP tanpa perlu menulis ekstensi PHP menggunakan C (PHP extension). Pada PHP 8.3 dan 8.4, FFI mendapatkan peningkatan stabilitas dan performa, menjadikannya pilihan ideal untuk mengintegrasikan library performa tinggi yang ditulis dalam bahasa seperti Rust atau C, langsung ke dalam aplikasi Laravel 11/12 Anda.

Penggunaan Rust sangat direkomendasikan karena *memory safety*, *thread safety*, dan zero-cost abstractions yang tidak dimiliki oleh C/C++. FFI memungkinkan Laravel untuk mendelegasikan komputasi berat (seperti kriptografi, pemrosesan citra, machine learning, atau algoritma pencarian kompleks) ke Rust, mendapatkan performa tingkat native sambil tetap mempertahankan produktivitas ekosistem Laravel.

## 2. Arsitektur Clean Architecture untuk FFI

Dalam Clean Architecture, FFI harus diperlakukan sebagai **External Detail** (Infrastructure Layer). Kode Domain dan Application Use Cases tidak boleh mengetahui adanya FFI. Kita menggunakan prinsip Dependency Inversion dengan mendefinisikan Interface di Domain Layer, dan mengimplementasikannya di Infrastructure Layer.

### 2.1. Domain Layer (Interfaces & DTOs)

```php
<?php

declare(strict_types=1);

namespace App\Domain\Crypto\Contracts;

use App\Domain\Crypto\ValueObjects\HashResult;

interface FastCryptoServiceInterface
{
    /**
     * Menghasilkan hash kriptografi berkecepatan tinggi menggunakan implementasi Rust native.
     *
     * @param string $input Data yang akan di-hash.
     * @return HashResult
     */
    public function generateHash(string $input): HashResult;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Domain\Crypto\ValueObjects;

final readonly class HashResult
{
    public function __construct(
        public string $hash,
        public float $executionTimeMs,
    ) {}
}
```

## 3. Implementasi Native (Rust)

Berikut adalah implementasi library Rust yang akan dipanggil oleh PHP.

**`Cargo.toml`**
```toml
[package]
name = "laravel_rust_crypto"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
sha2 = "0.10.8"
libc = "0.2.153"
```

**`src/lib.rs`**
```rust
use libc::c_char;
use sha2::{Digest, Sha256};
use std::ffi::{CStr, CString};
use std::time::Instant;

#[repr(C)]
pub struct CryptoResult {
    pub hash: *mut c_char,
    pub execution_time_ms: f64,
}

#[no_mangle]
pub extern "C" fn rust_generate_hash(input: *const c_char) -> CryptoResult {
    let start = Instant::now();

    let c_str = unsafe {
        assert!(!input.is_null());
        CStr::from_ptr(input)
    };

    let r_str = c_str.to_str().unwrap_or("");
    
    let mut hasher = Sha256::new();
    hasher.update(r_str);
    let result = hasher.finalize();
    
    let hash_string = format!("{:x}", result);
    let c_hash_string = CString::new(hash_string).expect("CString::new failed");

    let execution_time = start.elapsed().as_secs_f64() * 1000.0;

    CryptoResult {
        hash: c_hash_string.into_raw(),
        execution_time_ms: execution_time,
    }
}

#[no_mangle]
pub extern "C" fn rust_free_string(s: *mut c_char) {
    unsafe {
        if s.is_null() {
            return;
        }
        let _ = CString::from_raw(s);
    }
}
```

*Build dengan perintah `cargo build --release` untuk menghasilkan `liblaravel_rust_crypto.so` (Linux) atau `.dll` (Windows) atau `.dylib` (Mac).*

## 4. Implementasi PHP (Infrastructure Layer)

Kita menggunakan `FFI::cdef` untuk memuat library tersebut ke PHP.

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Crypto;

use App\Domain\Crypto\Contracts\FastCryptoServiceInterface;
use App\Domain\Crypto\ValueObjects\HashResult;
use FFI;
use FFI\CData;
use RuntimeException;
use Throwable;

final class RustCryptoService implements FastCryptoServiceInterface
{
    private FFI $ffi;
    private string $libPath;

    public function __construct()
    {
        $this->libPath = base_path('ffi/rust/target/release/liblaravel_rust_crypto.so');
        $this->initializeFFI();
    }

    private function initializeFFI(): void
    {
        if (!file_exists($this->libPath)) {
            throw new RuntimeException("Rust library tidak ditemukan di: {$this->libPath}");
        }

        $cdef = <<<CDEF
        struct CryptoResult {
            char* hash;
            double execution_time_ms;
        };

        struct CryptoResult rust_generate_hash(const char* input);
        void rust_free_string(char* s);
CDEF;

        $this->ffi = FFI::cdef($cdef, $this->libPath);
    }

    public function generateHash(string $input): HashResult
    {
        $resultData = null;
        try {
            /** @var CData $resultData */
            $resultData = $this->ffi->rust_generate_hash($input);
            
            $hashString = FFI::string($resultData->hash);
            $executionTime = (float) $resultData->execution_time_ms;

            return new HashResult(
                hash: $hashString,
                executionTimeMs: $executionTime,
            );
        } catch (Throwable $e) {
            throw new RuntimeException("FFI execution failed: " . $e->getMessage(), 0, $e);
        } finally {
            if ($resultData !== null && $resultData->hash !== null) {
                // Mencegah Memory Leak dengan mendelegasikan pembersihan ke Rust
                $this->ffi->rust_free_string($resultData->hash);
            }
        }
    }
}
```

## 5. Anti-Patterns (❌ vs ✅)

### 5.1. Anti-Pattern 1: Leaking FFI Abstraction ke Controller (Tight Coupling)

❌ **Bad Practice:** Memanggil FFI secara langsung di Controller atau Command. Ini merusak Clean Architecture dan mempersulit testing karena FFI tidak dapat di-mock dengan mudah.

```php
<?php
declare(strict_types=1);
namespace App\Http\Controllers;

class CryptoController extends Controller {
    public function hash(Request $request) {
        // SANGAT BURUK: FFI instansiasi langsung di controller, 
        // menyebabkan runtime crash jika library gagal diload, dan tidak bisa di mock.
        $ffi = \FFI::cdef("char* do_hash(char* in);", "lib.so");
        $hash = \FFI::string($ffi->do_hash($request->input('data')));
        return response()->json(['hash' => $hash]);
    }
}
```

✅ **Best Practice:** Sembunyikan FFI di balik Interface (Clean Architecture) dan injeksi interface tersebut melalui Service Container Laravel.

```php
<?php
declare(strict_types=1);
namespace App\Http\Controllers;

use App\Domain\Crypto\Contracts\FastCryptoServiceInterface;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

final readonly class CryptoController
{
    public function __construct(
        private FastCryptoServiceInterface $cryptoService
    ) {}

    public function hash(Request $request): JsonResponse
    {
        $result = $this->cryptoService->generateHash($request->string('data')->value());
        
        return response()->json([
            'hash' => $result->hash,
            'time_ms' => $result->executionTimeMs,
        ]);
    }
}
```

### 5.2. Anti-Pattern 2: Memory Leaks dari Pointer C

❌ **Bad Practice:** Tidak membebaskan memori yang dialokasikan oleh Rust/C yang dikembalikan ke PHP sebagai pointer. Zend Engine GC tidak melacak memori yang dialokasikan di luar PHP. Ini akan menyebabkan memory leak, terutama pada environment long-running seperti Laravel Octane.

```php
<?php
declare(strict_types=1);

public function process(): string {
    $result = $this->ffi->rust_generate_hash("secret");
    $hash = \FFI::string($result->hash);
    
    // BURUK: Pointer $result->hash yang di-malloc oleh Rust tidak pernah di-free.
    // Memory leak akan bertambah setiap kali function ini dipanggil.
    
    return $hash;
}
```

✅ **Best Practice:** Selalu sediakan fungsi pembebasan memori (misalnya `rust_free_string()`) di sisi C/Rust, dan pastikan memanggilnya di block `finally` pada sisi PHP.

```php
<?php
declare(strict_types=1);

public function process(): string {
    $result = null;
    try {
        $result = $this->ffi->rust_generate_hash("secret");
        return \FFI::string($result->hash);
    } finally {
        if ($result !== null) {
            // BAIK: Memori secara eksplisit dikembalikan ke OS melalui allocator Rust.
            $this->ffi->rust_free_string($result->hash);
        }
    }
}
```

## 6. Pest v3 Testing (Unit & Architecture)

Pest v3 mendukung pengujian yang elegan, termasuk Architecture Testing untuk memastikan tidak ada pelanggaran layer.

### 6.1. Architecture Tests

Pastikan FFI hanya digunakan di layer Infrastructure dan tidak membocorkan detail implementasi.

**`tests/Arch/FfiArchitectureTest.php`**
```php
<?php

declare(strict_types=1);

use FFI;

arch('FFI classes should only be used in Infrastructure layer')
    ->expect(FFI::class)
    ->not->toBeUsedIn([
        'App\Domain',
        'App\Application',
        'App\Http',
        'App\Console',
    ])
    ->ignoring('App\Infrastructure');

arch('Crypto Domain Interfaces should be strictly typed')
    ->expect('App\Domain\Crypto\Contracts')
    ->toBeInterfaces();
```

### 6.2. Unit / Integration Tests

Untuk menguji Service yang menggunakan FFI, kita bisa menggunakan mock untuk interface-nya, tetapi sangat penting juga melakukan Integration Test nyata (jika library Rust tersedia) untuk memastikan binding C-ABI berfungsi tanpa segfault.

**`tests/Integration/RustCryptoServiceTest.php`**
```php
<?php

declare(strict_types=1);

use App\Infrastructure\Crypto\RustCryptoService;
use App\Domain\Crypto\ValueObjects\HashResult;

beforeEach(function () {
    // Memastikan environment untuk test memiliki library yang sudah di build
    $this->service = new RustCryptoService();
});

it('can generate a valid sha256 hash using Rust FFI', function () {
    $input = 'laravel_php_8_4_is_fast';
    
    // Expected SHA-256 for 'laravel_php_8_4_is_fast'
    $expectedHash = hash('sha256', $input);
    
    $result = $this->service->generateHash($input);
    
    expect($result)->toBeInstanceOf(HashResult::class)
        ->and($result->hash)->toBe($expectedHash)
        ->and($result->executionTimeMs)->toBeGreaterThan(0.0)
        ->and($result->executionTimeMs)->toBeLessThan(100.0);
});

it('prevents memory leaks when called repeatedly (Stress Test)', function () {
    $memoryBefore = memory_get_usage();
    
    for ($i = 0; $i < 1000; $i++) {
        $result = $this->service->generateHash("payload_" . $i);
        expect($result->hash)->not->toBeEmpty();
    }
    
    $memoryAfter = memory_get_usage();
    $memoryDifference = $memoryAfter - $memoryBefore;
    
    // Toleransi memori overhead PHP (< 500KB), membuktikan pointer Rust telah di free.
    expect($memoryDifference)->toBeLessThan(500 * 1024);
});
```

## 7. Kesimpulan
Integrasi C/Rust via FFI di PHP 8.4 dan Laravel memberikan solusi pamungkas bagi bottleneck CPU-bound. Dengan mematuhi Clean Architecture, menjaga memory lifecycle (alokasi dan de-alokasi), serta memanfaatkan kekuatan testing Pest v3, aplikasi dapat menikmati performa C/Rust tanpa merusak maintainability di sisi PHP. Selalu prioritaskan `declare(strict_types=1)` untuk meminimalkan *mismatch type* saat berinteraksi dengan C API.
