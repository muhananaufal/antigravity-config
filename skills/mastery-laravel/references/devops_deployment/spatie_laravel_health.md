# Application Health Monitoring dengan Spatie Laravel Health (Laravel 11+ & PHP 8.3+)

Pemantauan (monitoring) kesehatan aplikasi adalah aspek fundamental dalam praktik SRE (Site Reliability Engineering) dan pemeliharaan sistem skala produksi. Spatie Laravel Health adalah standar industri di ekosistem Laravel untuk melakukan *health checks* pada infrastruktur server, koneksi database, antrean Redis, beban CPU, hingga layanan API pihak ketiga secara berkala.

Dokumen ini adalah panduan komprehensif (Top 1% Quality) untuk mengimplementasikan Spatie Laravel Health pada Laravel 11 dengan PHP 8.3+. Panduan ini mencakup penerapan *strict typing*, prinsip *Clean Architecture*, pencegahan *Anti-Patterns*, dan praktik keamanan tingkat *Enterprise*.

---

## 1. Instalasi dan Konfigurasi Ekosistem

Langkah pertama adalah menginstal dan mengkonfigurasi *package* Spatie Health ke dalam ekosistem Laravel Anda.

```bash
composer require spatie/laravel-health
php artisan vendor:publish --tag="health-config"
php artisan vendor:publish --tag="health-migrations"
php artisan migrate
```

Pada aplikasi Laravel skala Enterprise, hasil *health check* akan disimpan di database untuk analisis historis. Pastikan konfigurasi di `config/health.php` menggunakan koneksi *database* yang aman (idealnya *database* terpisah dari operasional utama agar tidak membebani sistem transaksi).

---

## 2. Implementasi Clean Architecture pada Health Check

Dalam aplikasi monolitik yang masif, menyuntikkan ratusan konfigurasi *health check* langsung ke `AppServiceProvider` akan melanggar *Single Responsibility Principle* (SRP) dan membuat *provider* menjadi *God Object*. Kita harus menggunakan pola *Action* untuk memisahkan domain pemantauan.

### Action Class: `RegisterHealthChecksAction.php`

Class *Action* ini murni bertanggung jawab untuk menginisialisasi daftar *check*.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Monitoring;

use Spatie\Health\Facades\Health;
use Spatie\Health\Checks\Checks\UsedDiskSpaceCheck;
use Spatie\Health\Checks\Checks\DatabaseCheck;
use Spatie\Health\Checks\Checks\RedisCheck;
use Spatie\Health\Checks\Checks\CacheCheck;
use Spatie\Health\Checks\Checks\OptimizedAppCheck;
use Spatie\Health\Checks\Checks\EnvironmentCheck;
use Spatie\Health\Checks\Checks\QueueCheck;
use App\Monitoring\Checks\PaymentGatewayCheck;

final readonly class RegisterHealthChecksAction
{
    public function execute(): void
    {
        Health::checks([
            // Pengecekan Sistem Utama
            UsedDiskSpaceCheck::new()
                ->warnWhenUsedSpaceIsAbovePercentage(75)
                ->failWhenUsedSpaceIsAbovePercentage(90),
            DatabaseCheck::new(),
            RedisCheck::new(),
            CacheCheck::new(),
            OptimizedAppCheck::new(),
            EnvironmentCheck::new(),
            
            // Pengecekan Antrean Pekerja (Workers)
            QueueCheck::new()
                ->onQueue(['default', 'emails', 'payments'])
                ->failWhenHealthJobTakesLongerThanMinutes(5),

            // Pengecekan Domain Kustom Pihak Ketiga
            PaymentGatewayCheck::new(),
        ]);
    }
}
```

### Registrasi pada `AppServiceProvider`

```php
<?php

declare(strict_types=1);

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use App\Actions\Monitoring\RegisterHealthChecksAction;

final class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Bindings dependency injection bisa ditambahkan di sini
    }

    public function boot(RegisterHealthChecksAction $registerHealthChecksAction): void
    {
        // Mendelegasikan pendaftaran check ke Action class untuk menjaga Clean Architecture
        $registerHealthChecksAction->execute();
    }
}
```

---

## 3. Custom Health Check yang Production-Ready

Sering kali kita perlu memverifikasi ketersediaan sistem hilir (seperti *Payment Gateway*, ERP, atau layanan pihak ketiga). *Custom check* harus memiliki kontrol *timeout* absolut dan penanganan eksepsi yang menyeluruh.

### Class Custom Check: `PaymentGatewayCheck.php`

```php
<?php

declare(strict_types=1);

namespace App\Monitoring\Checks;

use Spatie\Health\Checks\Check;
use Spatie\Health\Checks\Result;
use Illuminate\Support\Facades\Http;
use Illuminate\Http\Client\ConnectionException;
use Exception;

final class PaymentGatewayCheck extends Check
{
    private string $endpoint = 'https://api.payment-gateway.example.com/v1/ping';
    
    /**
     * Timeout wajib sangat kecil (misal 3 detik) untuk menghindari pemblokiran
     * thread/antrean saat scheduler menjalankan puluhan health checks.
     */
    private int $timeoutSeconds = 3;

    public function run(): Result
    {
        $result = Result::make();

        try {
            // Melakukan HTTP request dengan timeout ketat
            $response = Http::timeout($this->timeoutSeconds)->get($this->endpoint);

            if ($response->successful()) {
                return $result->ok()->shortSummary('Payment Gateway is UP');
            }

            return $result->failed("Gateway merespons dengan HTTP Status: {$response->status()}");
        } catch (ConnectionException $exception) {
            return $result->failed("Koneksi timeout setelah {$this->timeoutSeconds} detik.");
        } catch (Exception $exception) {
            return $result->failed("Error infrastruktur tidak terduga: {$exception->getMessage()}");
        }
    }
}
```

---

## 4. Keamanan dan Pemaparan Endpoint Health (Controller & Middleware)

Secara bawaan, Spatie menyediakan *controller* dan *route* macro yang langsung mengekspos metrik JSON (versi OS, kapasitas *disk*, konfigurasi DB) ke jaringan publik. Ini adalah kerentanan keamanan besar (*High Risk Reconnaissance*). Kita harus menerapkan arsitektur *Controller* dan validasi.

### Middleware/Policy untuk Monitoring

Gunakan *FormRequest* atau *Gate* untuk melakukan inspeksi otorisasi secara ketat.

### Controller: `HealthController.php`

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Monitoring;

use App\Http\Controllers\Controller;
use Spatie\Health\Http\Controllers\HealthCheckJsonResultsController;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

final class HealthController extends Controller
{
    public function __invoke(Request $request, HealthCheckJsonResultsController $healthController): JsonResponse
    {
        // Otorisasi: Hanya user dengan hak akses khusus (SRE/DevOps admin) yang diizinkan
        if (! Gate::allows('view-health-metrics', $request->user())) {
            abort(403, 'Akses terlarang. Insiden keamanan akan dicatat oleh sistem audit.');
        }

        // Jika terotorisasi, delegasikan respons kepada package controller bawaan Spatie
        return $healthController($request);
    }
}
```

### Definisi Routing (`routes/api.php`)

```php
<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\Monitoring\HealthController;

// Endpoint ini wajib diproteksi dari akses publik
Route::middleware(['auth:sanctum'])->prefix('system')->group(function () {
    Route::get('/health', HealthController::class)->name('health.metrics.json');
});
```

---

## 5. Anti-Patterns dalam Implementasi Health Check

Health check yang buruk bisa meruntuhkan performa server Anda (bertindak sebagai serangan DDoS lokal) dan menyebabkan kebocoran informasi yang fatal. Perhatikan dua Anti-Pattern berikut yang sering dilakukan oleh *engineer* pemula.

### ❌ Anti-Pattern 1: Heavy/Slow Query di Dalam Custom Check Tanpa Cache (Memory & Timeout Risk)

**Penjelasan Bahaya**: *Health check* dipicu secara otomatis setiap menit via *cron job*, dan bisa dipanggil ratusan kali dalam semenit jika ada layanan eksternal (seperti AWS Route 53 atau Datadog) yang melakukan ping ke endpoint `/health`. Melakukan query database yang memindai jutaan baris data untuk mengecek kesehatan bisnis (seperti pengecekan total transaksi gagal) akan mengunci *database* (karena *Connection Exhaustion* dan pemakaian CPU MySQL 100%).

**❌ KODE SALAH:**

```php
<?php

declare(strict_types=1);

namespace App\Monitoring\Checks\Bad;

use Spatie\Health\Checks\Check;
use Spatie\Health\Checks\Result;
use App\Models\Transaction;

final class TransactionSyncCheck extends Check
{
    public function run(): Result
    {
        // ❌ BAHAYA KRONIS: Query `count()` pada tabel berukuran gigabyte tanpa index/partisi yang sesuai.
        // Jika endpoint API dipanggil 10 kali/detik oleh load balancer, DB akan crash dalam hitungan menit.
        $unsyncedCount = Transaction::where('synced_to_erp', false)->count();

        if ($unsyncedCount > 5000) {
            return Result::make()->warning("Peringatan: Terdapat {$unsyncedCount} transaksi belum sinkron.");
        }

        return Result::make()->ok();
    }
}
```

**✅ KODE BENAR (Decoupled Metrics via Cache):**

Proses perhitungan intensif harus dipisahkan dari *health check*. Gunakan *Background Job* independen yang berjalan terpisah untuk menghitung data berat dan menyimpannya di Redis/Cache. *Health check* hanya perlu membaca nilai di memori (O(1) Time Complexity).

```php
<?php

declare(strict_types=1);

namespace App\Monitoring\Checks\Good;

use Spatie\Health\Checks\Check;
use Spatie\Health\Checks\Result;
use Illuminate\Support\Facades\Cache;

final class TransactionSyncCheck extends Check
{
    public function run(): Result
    {
        // ✅ BENAR: Health check mengambil data metrik agregat yang sudah dihitung sebelumnya dari Redis Cache.
        // Pemanggilan ini sangat cepat (<1 milidetik) tanpa membebani SQL Engine Database Utama.
        $unsyncedCount = (int) Cache::get('metrics:unsynced_transactions_count', 0);

        if ($unsyncedCount > 5000) {
            return Result::make()->warning("Peringatan: Terdapat {$unsyncedCount} transaksi belum tersinkronisasi ke ERP.");
        }

        return Result::make()->ok("Sinkronisasi ERP berjalan optimal.");
    }
}
```

### ❌ Anti-Pattern 2: Mengekspos Health Endpoint Tanpa Otentikasi dan Throttle di Produksi (Security Risk)

**Penjelasan Bahaya**: Hasil balasan dari Spatie Health sangat transparan. Ia mengungkap struktur internal server Anda, versi bahasa pemrograman, letak direktori, dan *library* pendukung. Membiarkannya terbuka di URL `/health` akan mempermudah *hacker* untuk merencanakan serangan sesuai versi rentan yang mereka baca.

**❌ KODE SALAH:**

```php
<?php

// routes/web.php
use Spatie\Health\Http\Controllers\HealthCheckJsonResultsController;
use Illuminate\Support\Facades\Route;

// ❌ BAHAYA: Routing diekspos telanjang di web publik tanpa proteksi apa pun.
// Bot peretas dapat merayapi (crawl) data ini untuk memetakan arsitektur backend Anda.
Route::get('/health', HealthCheckJsonResultsController::class);
```

**✅ KODE BENAR:**

```php
<?php

// routes/api.php
use App\Http\Controllers\Monitoring\HealthController;
use Illuminate\Support\Facades\Route;

// ✅ BENAR: Endpoint menggunakan Controller pembungkus (Wrapper) yang dibekali middleware Sanctum auth
// dan diproteksi dengan rate limiter (throttle: 30 request per menit per pengguna) 
// untuk memitigasi brute-force atau DDoS ringan.
Route::middleware(['throttle:30,1', 'auth:sanctum'])->group(function () {
    Route::get('/monitoring/system/health', HealthController::class)->name('health.secure.endpoint');
});
```

---

## 6. Penjadwalan dan Integrasi Notifikasi (Slack & Webhooks)

Sistem pemantauan tak akan berguna jika tim tidak diberitahu ketika sistem turun (*downtime*). Spatie Health dapat dikonfigurasi untuk mengirim peringatan Slack, Discord, atau Email melalui saluran (channels) logging Laravel.

### Penjadwalan Health Checks (`routes/console.php` di Laravel 11)

Kita wajib menjadwalkan pengecekan terpusat melalui Task Scheduler agar aplikasi secara berkala mengecek parameter-parameter kritis.

```php
<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Schedule;
use Spatie\Health\Models\HealthCheckResultHistoryItem;

// 1. Eksekusi seluruh check dan rekam log ke database setiap 1 menit.
Schedule::command('health:check')->everyMinute();

// 2. Cegah ledakan kapasitas database (tabel historis membengkak)
// Bersihkan hasil pemantauan yang berusia lebih dari 7 hari secara otomatis
Schedule::command('model:prune', [
    '--model' => [
        HealthCheckResultHistoryItem::class,
    ],
])->dailyAt('02:00'); // Dijalankan pada jam 2 pagi waktu server
```

### Konfigurasi Notifikasi (`config/health.php`)

Kustomisasi ke mana pesan error akan dikirim (contoh ke Slack). Pastikan URL Webhook Slack sudah dimasukkan ke variabel `.env`.

```php
    // Dalam config/health.php
    'notifications' => [
        'notifications' => [
            \Spatie\Health\Notifications\CheckFailedNotification::class => ['slack'],
        ],

        'notifiable' => \Spatie\Health\Notifications\Notifiable::class,
    ],
```

---

## 7. Pengujian dengan Pest v3 (Unit & Architecture Tests)

Kode pemantauan wajib dipantau juga! Memastikan *health checks* berfungsi dengan baik sebelum masuk *deployment* sangat penting. Kami mendemonstrasikan pengujian Unit untuk simulasi respon API eksternal dan Architecture Tests.

### Arch Test: `tests/Feature/ArchitectureTest.php`

Architecture tests memastikan *developer* di dalam tim selalu konsisten dengan *Clean Architecture* dan tidak secara sembrono menggunakan fungsi yang berpotensi *bug*.

```php
<?php

declare(strict_types=1);

use Spatie\Health\Checks\Check;

test('Semua class Monitoring Check harus mewarisi Spatie Check')
    ->expect('App\Monitoring\Checks')
    ->toBeClasses()
    ->toExtend(Check::class)
    ->toHaveSuffix('Check');

test('Semua Monitoring Check harus disetel sebagai class final dan immutable/readonly')
    ->expect('App\Monitoring\Checks')
    ->toBeFinal();

test('Tidak boleh ada fungsi debugging seperti dd atau env di dalam kode sumber produksi')
    ->expect(['dd', 'dump', 'env', 'ray', 'die'])
    ->not->toBeUsed();
```

### Unit Test: `tests/Unit/Monitoring/Checks/PaymentGatewayCheckTest.php`

Uji respon logika *check* tanpa melakukan *request HTTP* asli, gunakan fasilitas `Http::fake` yang disediakan oleh Laravel Framework.

```php
<?php

declare(strict_types=1);

use App\Monitoring\Checks\PaymentGatewayCheck;
use Spatie\Health\Checks\Result;
use Illuminate\Support\Facades\Http;
use Illuminate\Http\Client\ConnectionException;

// Menambahkan pest plugin tag untuk mempermudah eksekusi uji parsial
uses()->group('monitoring', 'health-checks');

it('mengembalikan status OK ketika payment gateway menyala (HTTP 200)', function () {
    // Arrange (Persiapan)
    Http::fake([
        'api.payment-gateway.example.com/v1/ping' => Http::response(['status' => 'success'], 200),
    ]);

    $check = PaymentGatewayCheck::new();

    // Act (Aksi)
    $result = $check->run();

    // Assert (Penilaian)
    expect($result)
        ->toBeInstanceOf(Result::class)
        ->and($result->status->value)->toBe('ok')
        ->and($result->shortSummary)->toBe('Payment Gateway is UP');
});

it('mengembalikan status FAILED ketika payment gateway merespons Error (HTTP 500)', function () {
    // Arrange
    Http::fake([
        'api.payment-gateway.example.com/v1/ping' => Http::response(['error' => 'Internal Server Error'], 500),
    ]);

    $check = PaymentGatewayCheck::new();

    // Act
    $result = $check->run();

    // Assert
    expect($result)
        ->toBeInstanceOf(Result::class)
        ->and($result->status->value)->toBe('failed')
        ->and($result->shortSummary)->toContain('Gateway merespons dengan HTTP Status: 500');
});

it('mengembalikan status FAILED ketika terjadi timeout atau kendala koneksi HTTP', function () {
    // Arrange
    Http::fake(function () {
        throw new ConnectionException('Timeout limit reached by cURL');
    });

    $check = PaymentGatewayCheck::new();

    // Act
    $result = $check->run();

    // Assert
    expect($result)
        ->toBeInstanceOf(Result::class)
        ->and($result->status->value)->toBe('failed')
        ->and($result->shortSummary)->toContain('Koneksi timeout');
});
```

---

## Kesimpulan Eksekutif

Mengimplementasikan Spatie Laravel Health bukan hanya sekadar menginstal *package* dan mendaftarkan kelas di `AppServiceProvider`. Secara proaktif menerapkan standar *Top 1% Quality Engineering* dan *Clean Architecture* memastikan:

1. **Pemeliharaan Kode Stabil**: Menghindari *code bloat* di provider inti dengan *Action Classes*.
2. **Keamanan Ekstrim**: Melindungi data infrastruktur dengan *Endpoint Controller* yang diautentikasi secara ketat dan mencegah kebocoran informasi.
3. **Ketahanan Infrastruktur (Resilience)**: Memastikan proses pemantauan otomatis (via cron) tidak crash atau menimbulkan lonjakan CPU *Database* dengan menggunakan data yang diambil dari *Cache* untuk agregasi beban berat.
4. **Kepercayaan Tinggi (Confidence)**: Mengamankan alur pengembangan menggunakan *Pest Arch Tests* untuk standardisasi otomatis dan pengujian *Mock API* yang terisolasi.
