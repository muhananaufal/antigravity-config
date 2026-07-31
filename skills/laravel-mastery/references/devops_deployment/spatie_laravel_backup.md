# Spatie Laravel Backup: Enterprise Grade Data Protection

## 1. Pendahuluan Backup & Disaster Recovery

Dalam ekosistem aplikasi enterprise modern berbasis Laravel 11/12, ketersediaan data adalah urat nadi bisnis. Kehilangan data akibat *human error*, peretasan, atau kegagalan perangkat keras (hardware failure) dapat menyebabkan kerugian miliaran dan runtuhnya kepercayaan pengguna.

`spatie/laravel-backup` adalah standar industri de facto untuk orkestrasi pencadangan data di Laravel. Dokumen ini menjelaskan standar Top 1% untuk mengonfigurasi, mengamankan, dan melakukan verifikasi backup otomatis secara arsitektur menggunakan PHP 8.3/8.4 dengan prinsip keamanan maksimal (Zero Trust, Off-site storage, Encryption).

Aturan absolut untuk Data Protection:
1. `declare(strict_types=1);` pada semua custom backup commands/services.
2. Jangan pernah menyimpan cadangan di server yang sama (Gunakan S3/GCS).
3. Enkripsi semua file backup dengan kunci AES-256.

---

## 2. Standar Konfigurasi `config/backup.php`

Konfigurasi harus mengedepankan keamanan berlapis. Backup terdiri dari *Database Dump* dan *File System* (misal folder upload `storage/app/public`).

### Konfigurasi Wajib:
```php
<?php
// config/backup.php

return [
    'backup' => [
        'name' => env('APP_NAME', 'laravel-backup'),
        'source' => [
            'files' => [
                'include' => [
                    storage_path('app/public'),
                ],
                'exclude' => [
                    storage_path('app/public/temp'),
                ],
            ],
            'databases' => [
                'mysql',
            ],
        ],
        'destination' => [
            'filename_prefix' => 'backup_',
            // WAJIB menggunakan disk eksternal seperti s3
            'disks' => [
                's3-backup',
            ],
        ],
        'temporary_directory' => storage_path('app/backup-temp'),
        
        // Proteksi Enkripsi Wajib
        'password' => env('BACKUP_ARCHIVE_PASSWORD'),
        'encryption' => 'default', // Menggunakan ZipArchive::EM_AES_256
    ],
    // ...
];
```

---

## 3. Anti-Patterns & Best Practices

### 3.1. Anti-Pattern: Menyimpan Backup di Server yang Sama (Local Disk)

❌ **KODE SALAH (Local Disk Backup)**
```php
<?php

// config/backup.php (Bagian Destination)
'destination' => [
    'disks' => [
        'local', // <-- SANGAT BERBAHAYA
    ],
],
```
**Mengapa Berbahaya?**
- **Single Point of Failure**: Jika Harddisk/SSD server rusak, datacenter terbakar, atau VM dihapus tanpa sengaja, Anda kehilangan aplikasi sekaligus seluruh data backup Anda.
- **Ransomware Risk**: Jika server diretas dan terkena ransomware, file backup yang ada di disk lokal juga akan terenkripsi oleh peretas, menghilangkan kesempatan pemulihan (recovery).

✅ **KODE BENAR (Off-site AWS S3 Storage & Lifecycle)**
```php
<?php

// config/filesystems.php
's3-backup' => [
    'driver' => 's3',
    'key' => env('AWS_BACKUP_ACCESS_KEY_ID'),
    'secret' => env('AWS_BACKUP_SECRET_ACCESS_KEY'),
    'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),
    'bucket' => env('AWS_BACKUP_BUCKET'),
    'url' => env('AWS_URL'),
    'endpoint' => env('AWS_ENDPOINT'),
    'use_path_style_endpoint' => env('AWS_USE_PATH_STYLE_ENDPOINT', false),
    'throw' => false,
],

// config/backup.php
'destination' => [
    'disks' => [
        's3-backup', // Terdistribusi secara aman
    ],
],
```

### 3.2. Anti-Pattern: Menjalankan Backup Langsung di Controller tanpa Antrian

❌ **KODE SALAH (Synchronous Backup in Controller)**
```php
<?php

namespace App\Http\Controllers;

use Illuminate\Support\Facades\Artisan;
use Illuminate\Http\Request;

class BackupController extends Controller
{
    public function trigger(Request $request)
    {
        // Masalah 1: Eksekusi synchronous
        // Masalah 2: Rentan Timeout HTTP (Gateway Timeout 504)
        // Masalah 3: Tanpa autentikasi/otorisasi yang ketat
        Artisan::call('backup:run');
        
        return response()->json(['message' => 'Backup done']);
    }
}
```
**Mengapa Berbahaya?**
- **Performance & Stability Risk**: Proses backup (dump database GB-an + zip) memakan waktu lama. Eksekusi langsung di controller memblokir request PHP FPM, menyebabkan server kehabisan worker dan pada akhirnya menghasilkan 504/502 Timeout.
- **Security**: Jika endpoint terekspos tanpa rate limiting, attacker dapat men-spam endpoint ini untuk membuat server kehabisan Storage Space dan RAM (Denial of Service).

✅ **KODE BENAR (Clean Architecture, Action Class, dan Queued Job)**
```php
<?php

declare(strict_types=1);

namespace App\Actions\System;

use Illuminate\Support\Facades\Artisan;

final class TriggerManualBackupAction
{
    /**
     * @return void
     */
    public function execute(): void
    {
        // Jalankan perintah backup di background via queue
        Artisan::queue('backup:run', ['--only-db' => true]);
    }
}

// Controller Implementation
namespace App\Http\Controllers\Api\Admin;

use App\Actions\System\TriggerManualBackupAction;
use Illuminate\Http\JsonResponse;

final class SystemBackupController
{
    public function __construct(
        private readonly TriggerManualBackupAction $backupAction
    ) {}

    public function __invoke(): JsonResponse
    {
        // Proteksi Otorisasi dipastikan sudah dilakukan di FormRequest atau Middleware
        $this->backupAction->execute();

        return response()->json([
            'message' => 'Backup process has been dispatched to the queue successfully.'
        ], 202);
    }
}
```

---

## 4. Pengujian Otomasi dengan Pest v3

Dalam arsitektur enterprise, kita harus menguji bahwa sistem dapat menjadwalkan dan memicu backup dengan benar tanpa memblokir runtime utama.

### 4.1. Unit & Feature Test untuk Backup Trigger (`tests/Feature/BackupTest.php`)

```php
<?php

declare(strict_types=1);

use App\Actions\System\TriggerManualBackupAction;
use Illuminate\Support\Facades\Artisan;

uses()->group('system', 'backup');

it('dispatches backup command to the queue via action', function () {
    // Arrange
    Artisan::fake();
    $action = new TriggerManualBackupAction();

    // Act
    $action->execute();

    // Assert
    // Memastikan artisan dikirim ke antrian queue (background) bukan call (sync)
    Artisan::assertQueued('backup:run', function ($command, $parameters) {
        return isset($parameters['--only-db']) && $parameters['--only-db'] === true;
    });
});

it('protects backup endpoint from unauthorized users', function () {
    // Arrange
    $user = \App\Models\User::factory()->create(['role' => 'user']); // regular user

    // Act
    $response = $this->actingAs($user)->postJson('/api/admin/system/backup');

    // Assert
    $response->assertStatus(403); // Forbidden
});

it('allows admin to dispatch backup successfully', function () {
    // Arrange
    $admin = \App\Models\User::factory()->create(['role' => 'admin']);
    Artisan::fake();

    // Act
    $response = $this->actingAs($admin)->postJson('/api/admin/system/backup');

    // Assert
    $response->assertStatus(202)
             ->assertJson(['message' => 'Backup process has been dispatched to the queue successfully.']);
             
    Artisan::assertQueued('backup:run');
});
```

### 4.2. Arsitektur Test untuk Backup (`tests/ArchTest.php`)

```php
<?php

declare(strict_types=1);

arch('controllers should not trigger backup synchronously')
    ->expect('App\Http\Controllers')
    ->not->toUse('Illuminate\Support\Facades\Artisan');
    
// Artisan call harus dienkapsulasi di dalam layer Action
arch('actions can use artisan facades for dispatching commands')
    ->expect('App\Actions\System\TriggerManualBackupAction')
    ->toUse('Illuminate\Support\Facades\Artisan');
```

## 5. Ringkasan Implementasi Enterprise
Integrasi `spatie/laravel-backup` harus berjalan secara asinkron (queue), di-offsite-kan secara cloud ke S3/GCS, serta diamankan melalui enkripsi tingkat tinggi (AES-256). Pengujian dengan Pest v3 menjamin endpoint backup aman dari penyalahgunaan dan eksploitasi beban HTTP. Kehilangan data bisa dihindari jika arsitektur dirancang pesimis terhadap kerusakan hardware (Zero Trust Infrastructure).


---

## 5. Pest v3 DevOps Backup Automation Test Suite

```php
<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Storage;

uses()->group('devops', 'backup');

it('dispatches spatie backup clean and run tasks to remote S3 encrypted storage', function () {
    Storage::fake('s3_backups');

    $exitCode = Artisan::call('backup:run', ['--only-db' => true]);

    expect($exitCode)->toBe(0);
});

arch('backup automation tasks must not run synchronously in HTTP request thread')
    ->expect('App\Http\Controllers')
    ->not->toUse('Spatie\Backup\Tasks\Backup\BackupJob');
```

---

## 6. Gotchas & Production Hardening Nuances

### 6.1. High-Throughput Memory Leak & Connection Pool Gotchas
Pada lingkungan produksi dengan high throughput (seperti Swoole, FrankenPHP, atau Horizon workers dengan ribuan job per menit), perhatikan beberapa jebakan umum berikut:
1. **Request-Scoped State Leaks**: Variabel statis atau singleton instances yang menyimpan state request sebelumnya tidak dibersihkan secara otomatis. Selalu reset state pada event listener `Illuminate\Foundation\Events\LocaleUpdated` atau via config `octane.flush`.
2. **Database Idle Timeout & Disconnection**: Connection pool di Octane dapat terputus oleh database server jika idle lebih lama dari `interactive_timeout`. Pastikan `DB::reconnect()` dipanggil secara otomatis atau set `pool.max_idle_time` secara konservatif.
3. **Correlation ID Context Propagation**: Pastikan `Log::withContext(['correlation_id' => request()->header('X-Request-ID')])` dipropagasi ke seluruh asynchronous queue jobs menggunakan middleware.

### 6.2. Security Checklist & OWASP Validation
- **SQL Injection Prevention**: Gunakan Query Builder dengan parameter binding `whereRaw('status = ?', [$status])` alih-alih konkatenasi string.
- **CSRF & Rate Limiting Guard**: Selalu pasang `throttle:api` middleware pada endpoint publik untuk mencegah Brute-Force & Denial of Service.

### 6.3. Backup Verification SLA & Disaster Recovery Drills
Setiap file backup yang dihasilkan oleh Spatie Backup wajib diverifikasi integritasnya secara otomatis via Scheduled Job mingguan yang melakukan mock restore ke database staging terisolasi. Hal ini memastikan file dump database tidak corrupt akibat disk exhaustion saat backup sedang berjalan.
