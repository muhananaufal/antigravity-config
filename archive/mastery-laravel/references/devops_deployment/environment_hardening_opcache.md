# Panduan Definitif: Environment Hardening & OPcache Optimization di Laravel 11 (PHP 8.3+)

Dalam ekosistem pengembangan aplikasi enterprise dengan Laravel 11 dan PHP 8.3/8.4, keamanan environment (Environment Hardening) dan optimasi performa melalui OPcache (termasuk JIT Compiler) bukan lagi sekadar opsi, melainkan kewajiban absolut. Kegagalan dalam mengamankan konfigurasi dan memaksimalkan OPcache dapat mengakibatkan kebocoran data (data breach), serangan eksekusi jarak jauh (RCE), serta degradasi performa yang signifikan saat aplikasi menghadapi *traffic spike*.

Dokumen ini menyajikan panduan arsitektural komprehensif tingkat *Top 1%*, lengkap dengan implementasi *Clean Architecture*, *Anti-Patterns*, dan pengujian ketat menggunakan Pest v3.

---

## 1. OPcache & JIT (Just-In-Time) Compiler Configuration

OPcache menyimpan *precompiled bytecode* dari skrip PHP di *shared memory*, sehingga menghilangkan kebutuhan bagi PHP untuk memuat dan mem-parsing skrip pada setiap *request*. Pada PHP 8.3+, JIT Compiler memberikan dorongan performa ekstra untuk operasi yang membutuhkan komputasi berat (CPU-bound).

### Konfigurasi `php.ini` untuk Production

Berikut adalah konfigurasi *production-ready* yang harus diaplikasikan pada server Anda (misal di `/etc/php/8.3/fpm/php.ini`):

```ini
[opcache]
opcache.enable=1
opcache.enable_cli=1
opcache.memory_consumption=512
opcache.interned_strings_buffer=64
opcache.max_accelerated_files=65407
opcache.validate_timestamps=0
opcache.save_comments=1
opcache.revalidate_freq=0
opcache.fast_shutdown=1

; PHP 8.3+ JIT Configuration
opcache.jit=tracing
opcache.jit_buffer_size=128M
```

**Penjelasan Parameter Kunci:**
- `opcache.validate_timestamps=0`: Parameter ini sangat krusial. Dalam production, kita tidak ingin OPcache mengecek apakah file PHP telah berubah setiap kali file dipanggil. File hanya diperbarui saat *deployment* dengan me-restart PHP-FPM.
- `opcache.max_accelerated_files=65407`: Angka prima yang direkomendasikan untuk mencegah *hash collisions* dalam tabel penyimpanan OPcache. Laravel memiliki ribuan file (termasuk vendor), jadi nilai tinggi ini diperlukan.
- `opcache.jit_buffer_size=128M`: Mengalokasikan 128MB untuk JIT buffer. Sangat berguna untuk Laravel jika ada *heavy computational tasks*.

---

## 2. Environment Hardening & Security

Environment hardening bertujuan untuk menutup celah dari serangan *Information Disclosure* dan membatasi akses pada level *File System* dan *PHP Runtime*.

### PHP-FPM Hardening (`www.conf`)
```ini
; Menonaktifkan fungsi berbahaya
php_admin_value[disable_functions] = exec,passthru,shell_exec,system,proc_open,popen,curl_multi_exec,parse_ini_file,show_source

; Menyembunyikan versi PHP dari header response
php_admin_flag[expose_php] = off

; Mengamankan session cookie
php_admin_flag[session.cookie_httponly] = on
php_admin_flag[session.cookie_secure] = on
php_admin_value[session.cookie_samesite] = "Strict"
```

---

## 3. Anti-Patterns vs Best Practices

Bagian ini menyoroti kesalahan umum yang sering dilakukan developer menengah dalam mengakses environment dan konfigurasi, serta solusi *Clean Architecture* yang tepat.

### Anti-Pattern 1: Menggunakan Helper `env()` di Dalam Business Logic

❌ **KODE SALAH (Berbahaya & Degradasi Performa):**

```php
<?php

declare(strict_types=1);

namespace App\Services;

class PaymentGatewayService
{
    public function processPayment(float $amount): bool
    {
        // ❌ ANTI-PATTERN: Membaca .env secara langsung dalam runtime logic.
        // Bahaya 1: Jika perintah `php artisan config:cache` dijalankan di production,
        // semua pemanggilan env() akan mengembalikan nilai null, merusak aplikasi.
        // Bahaya 2: Membaca file disk terus menerus sangat lambat dan bypass OPcache.
        $apiKey = env('STRIPE_SECRET_KEY');
        $isSandbox = env('APP_ENV') === 'local';

        if ($isSandbox) {
            return true;
        }

        return $this->callStripeApi($apiKey, $amount);
    }

    private function callStripeApi(?string $apiKey, float $amount): bool
    {
        // Mocked implementation
        return true;
    }
}
```

✅ **KODE BENAR (Aman & Teroptimasi):**

```php
<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Contracts\Config\Repository as ConfigRepository;

class PaymentGatewayService
{
    private string $apiKey;
    private string $environment;

    public function __construct(private readonly ConfigRepository $config)
    {
        // ✅ BEST PRACTICE: Ambil nilai dari konfigurasi Laravel (bukan file env).
        // Konfigurasi ini sudah masuk dalam memory (OPcache) saat `config:cache` dijalankan.
        $this->apiKey = (string) $this->config->get('services.stripe.secret');
        $this->environment = (string) $this->config->get('app.env');
    }

    public function processPayment(float $amount): bool
    {
        $isSandbox = $this->environment === 'local';

        if ($isSandbox) {
            return true;
        }

        return $this->callStripeApi($this->apiKey, $amount);
    }

    private function callStripeApi(string $apiKey, float $amount): bool
    {
        // Implementasi integrasi Stripe yang aman dengan strict types
        if ($apiKey === '') {
            throw new \InvalidArgumentException('Stripe API Key is missing');
        }
        return true;
    }
}
```

**Penjelasan:** Menjalankan `php artisan config:cache` di production adalah wajib. Proses ini menggabungkan semua file config menjadi satu file yang di-cache dan dimuat super cepat oleh OPcache. Jika menggunakan `env()` di luar file `config/`, aplikasi akan gagal *fail-open* atau *fail-closed* karena `env()` me-return null.

### Anti-Pattern 2: Hardcoding & Exposing System Paths

❌ **KODE SALAH (Security Risk - Path Traversal & Information Disclosure):**

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;

class FileDownloadController
{
    public function download(Request $request): JsonResponse
    {
        // ❌ ANTI-PATTERN: Membaca path langsung dari request tanpa validasi 
        // dan menggunakan base_path atau public_path secara mentah.
        // Bahaya: Attacker bisa mengirim '../.env' untuk mengunduh kredensial!
        $file = $request->input('file');
        $content = file_get_contents(public_path('uploads/' . $file));

        return response()->json(['data' => $content]);
    }
}
```

✅ **KODE BENAR (Secure File Access via Storage Facade):**

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use App\Http\Requests\DownloadFileRequest;
use App\Actions\DownloadSecureFileAction;

class FileDownloadController
{
    public function __construct(
        private readonly DownloadSecureFileAction $downloadAction
    ) {}

    public function download(DownloadFileRequest $request): JsonResponse
    {
        // ✅ BEST PRACTICE: Validasi Request, Clean Architecture, 
        // dan penggunaan Storage subsystem dengan isolasi disk.
        $content = $this->downloadAction->execute($request->validated('file_id'));

        return response()->json([
            'status' => 'success',
            'data' => base64_encode($content)
        ]);
    }
}
```

---

## 4. Implementasi Clean Architecture: Secure System Health Check

Untuk memastikan OPcache berjalan dengan baik tanpa mengekspos informasi internal, kita membuat *health check endpoint* dengan Clean Architecture.

### 1. Form Request (Validasi Input & Otorisasi)

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\System;

use Illuminate\Foundation\Http\FormRequest;

class HealthCheckRequest extends FormRequest
{
    public function authorize(): bool
    {
        // Hanya izinkan akses internal atau admin dengan token spesifik
        $token = $this->bearerToken();
        $expectedToken = config('system.health_check_token');
        
        return $token !== null && hash_equals((string) $expectedToken, $token);
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'detailed' => ['sometimes', 'boolean'],
        ];
    }
}
```

### 2. DTO (Data Transfer Object)

```php
<?php

declare(strict_types=1);

namespace App\DTOs\System;

final readonly class SystemHealthDTO
{
    public function __construct(
        public bool $isOpcacheEnabled,
        public bool $isJitEnabled,
        public string $environment,
        public float $memoryUsageMb
    ) {}

    /**
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return [
            'opcache_enabled' => $this->isOpcacheEnabled,
            'jit_enabled' => $this->isJitEnabled,
            'environment' => $this->environment,
            'memory_usage_mb' => $this->memoryUsageMb,
            'status' => $this->isOpcacheEnabled ? 'Healthy' : 'Degraded',
        ];
    }
}
```

### 3. Repository / Service (Integrasi Layer Eksternal)

```php
<?php

declare(strict_types=1);

namespace App\Repositories\System;

class PhpRuntimeRepository
{
    public function isOpcacheEnabled(): bool
    {
        return function_exists('opcache_get_status') 
            && (opcache_get_status(false) !== false);
    }

    public function isJitEnabled(): bool
    {
        if (! $this->isOpcacheEnabled()) {
            return false;
        }

        $status = opcache_get_status(false);
        if (! is_array($status)) {
            return false;
        }

        return isset($status['jit']) && $status['jit']['enabled'] === true;
    }

    public function getMemoryUsageMb(): float
    {
        return round(memory_get_usage(true) / 1024 / 1024, 2);
    }
}
```

### 4. Action (Business Logic)

```php
<?php

declare(strict_types=1);

namespace App\Actions\System;

use App\Repositories\System\PhpRuntimeRepository;
use App\DTOs\System\SystemHealthDTO;
use Illuminate\Contracts\Config\Repository as ConfigRepository;

final readonly class CheckSystemHealthAction
{
    public function __construct(
        private PhpRuntimeRepository $runtimeRepository,
        private ConfigRepository $config
    ) {}

    public function execute(): SystemHealthDTO
    {
        return new SystemHealthDTO(
            isOpcacheEnabled: $this->runtimeRepository->isOpcacheEnabled(),
            isJitEnabled: $this->runtimeRepository->isJitEnabled(),
            environment: (string) $this->config->get('app.env', 'production'),
            memoryUsageMb: $this->runtimeRepository->getMemoryUsageMb()
        );
    }
}
```

### 5. Controller (HTTP Delivery)

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\System;

use App\Http\Requests\System\HealthCheckRequest;
use App\Actions\System\CheckSystemHealthAction;
use Illuminate\Http\JsonResponse;

final class HealthCheckController
{
    public function __construct(
        private readonly CheckSystemHealthAction $checkHealthAction
    ) {}

    public function __invoke(HealthCheckRequest $request): JsonResponse
    {
        $healthDto = $this->checkHealthAction->execute();

        return response()->json([
            'success' => true,
            'timestamp' => now()->toIso8601String(),
            'data' => $healthDto->toArray()
        ]);
    }
}
```

---

## 5. Architecture & Unit Testing (Pest v3)

Untuk menjamin level sekuritas dan integrasi komponen, pengujian ketat dilakukan menggunakan Pest v3 dengan pendekatan *Architecture Testing* (Arch Test) untuk memaksa kepatuhan arsitektur, dan *Feature/Unit Testing* untuk logika bisnis.

```php
<?php

declare(strict_types=1);

use App\Actions\System\CheckSystemHealthAction;
use App\DTOs\System\SystemHealthDTO;
use App\Http\Controllers\System\HealthCheckController;
use App\Repositories\System\PhpRuntimeRepository;
use Illuminate\Contracts\Config\Repository as ConfigRepository;
use Illuminate\Support\Facades\Config;
use function Pest\Laravel\getJson;
use function Pest\Laravel\withToken;

// ==========================================
// ARCHITECTURE TESTS
// ==========================================

arch('strict types is enforced everywhere')
    ->expect('App')
    ->toUseStrictTypes();

arch('controllers only use actions and requests')
    ->expect('App\Http\Controllers')
    ->toOnlyUse([
        'App\Http\Requests',
        'App\Actions',
        'Illuminate\Http\JsonResponse',
        'Illuminate\Http\Request',
        'Illuminate\Routing\Controller',
    ])
    ->ignoring('App\Http\Controllers\Controller'); // Jika ada base controller bawaan

arch('actions do not access env directly')
    ->expect('App\Actions')
    ->not->toUse('env')
    ->not->toUse('Illuminate\Support\Facades\Env');

// ==========================================
// UNIT TESTS (Action Level)
// ==========================================

it('returns correct system health dto when opcache is enabled', function () {
    // Arrange (Mocking repository & config)
    $runtimeMock = Mockery::mock(PhpRuntimeRepository::class);
    $runtimeMock->shouldReceive('isOpcacheEnabled')->once()->andReturn(true);
    $runtimeMock->shouldReceive('isJitEnabled')->once()->andReturn(true);
    $runtimeMock->shouldReceive('getMemoryUsageMb')->once()->andReturn(24.5);

    $configMock = Mockery::mock(ConfigRepository::class);
    $configMock->shouldReceive('get')->with('app.env', 'production')->once()->andReturn('production');

    $action = new CheckSystemHealthAction($runtimeMock, $configMock);

    // Act
    $result = $action->execute();

    // Assert
    expect($result)->toBeInstanceOf(SystemHealthDTO::class)
        ->and($result->isOpcacheEnabled)->toBeTrue()
        ->and($result->isJitEnabled)->toBeTrue()
        ->and($result->environment)->toBe('production')
        ->and($result->memoryUsageMb)->toBe(24.5)
        ->and($result->toArray()['status'])->toBe('Healthy');
});

// ==========================================
// FEATURE TESTS (Controller Level)
// ==========================================

it('blocks unauthorized access to health check endpoint', function () {
    // Act & Assert
    getJson('/api/system/health')
        ->assertStatus(401)
        ->assertJson(['message' => 'Unauthenticated.']);
});

it('allows authorized access and returns health data', function () {
    // Arrange
    Config::set('system.health_check_token', 'secure-secret-token-123');
    
    // Act & Assert
    withToken('secure-secret-token-123')
        ->getJson('/api/system/health')
        ->assertStatus(200)
        ->assertJsonStructure([
            'success',
            'timestamp',
            'data' => [
                'opcache_enabled',
                'jit_enabled',
                'environment',
                'memory_usage_mb',
                'status'
            ]
        ])
        ->assertJsonPath('success', true);
});

it('fails when token is incorrect', function () {
    // Arrange
    Config::set('system.health_check_token', 'secure-secret-token-123');
    
    // Act & Assert
    withToken('invalid-token')
        ->getJson('/api/system/health')
        ->assertStatus(403) // Atau 401 tergantung middleware Exception handler
        ->assertJson(['message' => 'This action is unauthorized.']);
});
```

## Kesimpulan

Environment hardening dan OPcache optimization di Laravel bukan sekadar tentang kecepatan, tapi mengenai membangun infrastruktur yang tangguh secara arsitektur. Dengan memindahkan logika konfigurasi keluar dari ketergantungan disk `.env` menuju OPcache-accelerated configuration (via `config:cache`), menonaktifkan fungsi berbahaya di PHP-FPM, dan menerapkan *Clean Architecture* menggunakan DTO serta Repository pattern, aplikasi Anda akan beroperasi di level *enterprise-grade* dengan keamanan maksimal dan performa optimal (Top 1%). Pengujian statis berbasis arsitektur dengan Pest v3 menjamin bahwa praktik terbaik ini tidak rusak akibat *regression* oleh pengembang lain.
