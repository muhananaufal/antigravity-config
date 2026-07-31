# Managing & Eradicating Technical Debt in Laravel Applications

## 1. Konsep Dasar Technical Debt

Technical Debt (Hutang Teknis) dalam Laravel terjadi ketika pengembang memilih solusi cepat (shortcut) ketimbang arsitektur yang benar, meninggalkan "hutang" yang harus dibayar kelak berupa waktu refactoring, bug, dan degradasi performa. Dalam PHP 8.3/8.4 dan Laravel 11/12, hutang teknis sering bermanifestasi dalam bentuk God Models, Hardcoded Configs, Magic Strings, dan pelanggaran SOLID principles.

Tujuan utama dokumen ini adalah memberikan cetak biru tingkat elit untuk mengidentifikasi, mengisolasi, dan membasmi hutang teknis dengan pendekatan berbasis **Clean Architecture** dan pengujian presisi tinggi menggunakan **Pest v3**.

Aturan absolut untuk menghindari hutang teknis baru:
1. `declare(strict_types=1);` mutlak digunakan.
2. Gunakan Environment/Config files, jangan pernah melakukan *hardcode*.
3. Pecah objek besar menjadi komponen tersendiri (Actions, Services, Traits).

---

## 2. Strategi Refactoring & Isolasi

Refactoring sistem legacy harus dilakukan secara bertahap (Strangler Fig Pattern) tanpa mengganggu operasi bisnis. 

### 2.1. Memecah God Models
"God Model" adalah Model Eloquent yang berisi ribuan baris kode, menangani segalanya dari relasi, validasi bisnis, hingga formatting. Kita memecahnya menjadi:
- **Repository** untuk query database.
- **Actions** untuk logika bisnis transaksional.
- **Casts / Accessors** spesifik untuk formatting.

---

## 3. Anti-Patterns & Best Practices

### 3.1. Anti-Pattern: Hardcoded Secrets & Magic Numbers

❌ **KODE SALAH (Hardcoding Secrets & Logic in Service)**
```php
<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;

class NotificationService
{
    public function sendSMS($phone, $message)
    {
        // 1. Hardcoded API Key & URL
        $apiKey = 'sk_live_1234567890abcdef';
        $url = 'https://api.sms-provider.com/v1/send';

        // 2. Magic numbers
        if (strlen($message) > 160) {
            return false; 
        }

        $response = Http::withHeaders([
            'Authorization' => 'Bearer ' . $apiKey
        ])->post($url, [
            'phone' => $phone,
            'message' => $message
        ]);

        return $response->successful();
    }
}
```
**Mengapa Berbahaya?**
- **Security Breach Risk**: Menyimpan API Key di kode akan mengkspos rahasia tersebut ke source control (GitHub/GitLab). Jika repository bocor, infrastruktur akan dikompromikan.
- **Technical Debt**: Jika URL provider atau standar panjang pesan berubah (misal dari 160 ke 200), kita harus mengubahnya di banyak tempat dalam source code, yang rentan bug.

✅ **KODE BENAR (Config/Env Driven & Constants)**
```php
<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Config;

final class NotificationService
{
    private const int MAX_SMS_LENGTH = 160;

    /**
     * @param string $phone
     * @param string $message
     * @return bool
     */
    public function sendSMS(string $phone, string $message): bool
    {
        if (mb_strlen($message) > self::MAX_SMS_LENGTH) {
            return false;
        }

        $apiKey = Config::get('services.sms_provider.key');
        $url = Config::get('services.sms_provider.url');

        if (!is_string($apiKey) || !is_string($url)) {
            throw new \RuntimeException('SMS provider configuration is invalid.');
        }

        $response = Http::withToken($apiKey)->post($url, [
            'phone' => $phone,
            'message' => $message
        ]);

        return $response->successful();
    }
}
```
*(Pastikan konfigurasi ditaruh di `config/services.php` yang membaca dari `.env`)*.

### 3.2. Anti-Pattern: God Model & Fat Observers

❌ **KODE SALAH (Massive Model dengan Logika Sampingan)**
```php
<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Log;

class Order extends Model
{
    // Model menangani seluruh logika bisnis dalam method boot
    protected static function boot()
    {
        parent::boot();

        static::created(function ($order) {
            // Masalah 1: Side effects tersembunyi
            Mail::to($order->user->email)->send(new \App\Mail\OrderCreated($order));
            
            // Masalah 2: Integrasi pihak ketiga langsung di Model
            $erp = new \App\Services\ERPIntegration();
            $erp->syncOrder($order);
            
            Log::info("Order {$order->id} created.");
        });
    }
    
    // Logika perhitungan kompleks yang seharusnya di Action/Service
    public function calculateComplexTax()
    {
        $tax = 0;
        foreach ($this->items as $item) {
            if ($item->category == 'electronics') $tax += $item->price * 0.1;
            else clone $tax += $item->price * 0.05;
        }
        return $tax;
    }
}
```
**Mengapa Berbahaya?**
- **Hidden Side Effects**: Saat membuat order untuk Testing atau Data Seeding menggunakan `Order::create()`, aplikasi secara tidak sengaja akan mengirim email asli dan mensinkronisasi ke sistem ERP.
- **SRP Violation**: Model bertanggung jawab atas Database mapping, Emailing, Logging, ERP sync, dan Tax Calculation. Ini adalah definisi utama Hutang Teknis tingkat tinggi.

✅ **KODE BENAR (Event Dispatcher & Action Classes)**
```php
<?php

declare(strict_types=1);

namespace App\Models;

use App\Events\OrderCreatedEvent;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

final class Order extends Model
{
    protected $dispatchesEvents = [
        'created' => OrderCreatedEvent::class,
    ];

    /**
     * @return HasMany<OrderItem>
     */
    public function items(): HasMany
    {
        return $this->hasMany(OrderItem::class);
    }
}
```

Lalu, lepaskan logika bisnis ke Listener spesifik:
```php
<?php

declare(strict_types=1);

namespace App\Listeners;

use App\Events\OrderCreatedEvent;
use App\Services\Contracts\ERPIntegrationInterface;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;

final readonly class SyncOrderToERPListener implements ShouldQueue
{
    public function __construct(
        private ERPIntegrationInterface $erpIntegration
    ) {}

    public function handle(OrderCreatedEvent $event): void
    {
        $this->erpIntegration->syncOrder($event->order);
        Log::info("Order {$event->order->id} synced to ERP.");
    }
}
```

---

## 4. Testing dan Resolusi Hutang dengan Pest v3

Refactoring tanpa Test adalah bunuh diri. Kita menggunakan Pest v3 untuk memvalidasi perubahan.

### 4.1. Unit Test untuk Notifikasi (Fakes HTTP)

```php
<?php

declare(strict_types=1);

use App\Services\NotificationService;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Config;

uses()->group('services', 'notification');

it('successfully sends sms when length is valid', function () {
    // Arrange
    Config::set('services.sms_provider.key', 'fake-key');
    Config::set('services.sms_provider.url', 'https://fake-url.com');

    Http::fake([
        'https://fake-url.com' => Http::response(['status' => 'ok'], 200)
    ]);

    $service = new NotificationService();

    // Act
    $result = $service->sendSMS('08123456789', 'Hello World');

    // Assert
    expect($result)->toBeTrue();
    Http::assertSent(function ($request) {
        return $request->hasHeader('Authorization', 'Bearer fake-key') &&
               $request['phone'] === '08123456789';
    });
});

it('fails when message exceeds max length', function () {
    // Arrange
    $service = new NotificationService();
    $longMessage = str_repeat('A', 161);

    // Act
    $result = $service->sendSMS('08123456789', $longMessage);

    // Assert
    expect($result)->toBeFalse();
    Http::assertNothingSent();
});
```

### 4.2. Arsitektur Check (`tests/ArchTest.php`)
Melindungi agar God Models tidak kembali tercipta.

```php
<?php

declare(strict_types=1);

arch('models should not send emails directly')
    ->expect('App\Models')
    ->not->toUse('Illuminate\Support\Facades\Mail')
    ->not->toUse('App\Mail');

arch('models should not dispatch HTTP requests')
    ->expect('App\Models')
    ->not->toUse('Illuminate\Support\Facades\Http')
    ->not->toUse('GuzzleHttp\Client');

arch('events should be placed in App\Events')
    ->expect('App\Events')
    ->toHaveSuffix('Event');
```

## 5. Kesimpulan
Mengatasi hutang teknis butuh kedisiplinan tingkat dewa. Pisahkan integrasi (HTTP/Mail) ke Service/Listener. Gunakan `.env` untuk kredensial. Selalu bersandar pada Clean Architecture. Dengan PHP 8.4 dan Pest, hutang teknis dicegah sebelum ia berhasil masuk ke dalam branch `main`.


---

## 5. Pest v3 Architectural & Refactoring Verification Suite

`php
<?php

declare(strict_types=1);

use App\Services\LegacyRefactoringService;
use App\Repositories\OrderRepositoryInterface;
use Illuminate\Support\Facades\Http;

uses()->group('quality-governance', 'technical-debt');

it('successfully decouples legacy monolith order processing without side-effects', function () {
    Http::fake([
        'payment-gateway.internal/*' => Http::response(['status' => 'APPROVED', 'tx_id' => 'TX12345'], 200),
    ]);

     = Mockery::mock(OrderRepositoryInterface::class);
    ->shouldReceive('updateStatus')->once()->andReturn(true);

     = new LegacyRefactoringService();
     = ->migrateLegacyOrder(99812);

    expect(->isSuccessful())->toBeTrue();
    Http::assertSentCount(1);
});

arch('legacy controllers must not instantiate Eloquent models directly')
    ->expect('App\\Http\\Controllers\\Legacy')
    ->not->toUse('App\\Models')
    ->ignoring('App\\Http\\Controllers\\Legacy\\HealthController');
`


---

## 6. Gotchas & Production Hardening Nuances

### 6.1. High-Throughput Memory Leak & Connection Pool Gotchas
Pada lingkungan produksi dengan high throughput (seperti Swoole, FrankenPHP, atau Horizon workers dengan ribuan job per menit), perhatikan beberapa jebakan umum berikut:
1. **Request-Scoped State Leaks**: Variabel statis atau singleton instances yang menyimpan state request sebelumnya tidak dibersihkan secara otomatis. Selalu reset state pada event listener Illuminate\Foundation\Events\LocaleUpdated atau via config octane.flush.
2. **Database Idle Timeout & Disconnection**: Connection pool di Octane dapat terputus oleh database server jika idle lebih lama dari interactive_timeout. Pastikan DB::reconnect() dipanggil secara otomatis atau set pool.max_idle_time secara konservatif.
3. **Correlation ID Context Propagation**: Pastikan Log::withContext(['correlation_id' => ->header('X-Request-ID')]) dipropagasi ke seluruh asynchronous queue jobs menggunakan trait $middleware atau $jobContext.

### 6.2. Security Checklist & OWASP Validation
- **SQL Injection Prevention**: Gunakan Query Builder dengan parameter binding whereRaw('status = ?', []) alih-alih konkatenasi string.
- **CSRF & Rate Limiting Guard**: Selalu pasang 	hrottle:api middleware pada endpoint publik untuk mencegah Brute-Force & Denial of Service.
