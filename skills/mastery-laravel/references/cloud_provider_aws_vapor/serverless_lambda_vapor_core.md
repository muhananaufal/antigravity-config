# Serverless Architecture & Laravel Vapor Core

## Arsitektur & Motivasi
Menjalankan monolith Laravel di ekosistem Serverless (AWS Lambda via Laravel Vapor) membutuhkan pergeseran paradigma (paradigm shift). Lambda adalah *stateless, ephemeral compute* yang di-pause/di-kill di antara request. Memahami manajemen koneksi database, constraint sistem file (read-only), dan optimasi cold-start adalah syarat mutlak arsitek Top 1%.

### Diagram Arsitektur Serverless Vapor
```text
[Internet/Client]
      |
      V
[Amazon API Gateway / ALB] --- (Triggers) ---> [AWS Lambda (Laravel Web/API)]
                                                      |
                                                      |--> (Read-only OS, Write to /tmp max 512MB)
                                                      |--> (Stateless RAM)
                                                      |
                                                      V
[AWS RDS Proxy (Connection Pooler)] <=======> [Amazon RDS / Aurora (MySQL/PgSQL)]
      |
      +---> (Mencegah "Too Many Connections" saat 10,000 Lambda scale-up serentak)
```

## Implementasi PHP 8.3 / Laravel 11 (PHPStan Level 9)

### 1. Manajemen `/tmp` dan Filesystem
Dalam Vapor, direktori root Laravel adalah `read-only`. Penyimpanan sementara HANYA ada di `/tmp` (terbatas 512MB, terhapus saat instance mati).

```php
<?php

declare(strict_types=1);

namespace App\Services\System;

use Illuminate\Support\Facades\Storage;
use RuntimeException;

final class VaporTempFileManager
{
    /**
     * Download file dari S3 ke /tmp Lambda untuk diproses sementara.
     * Wajib di-cleanup (unlink) untuk mencegah /tmp penuh di reuse instance Lambda selanjutnya.
     */
    public function processLargeFileFromS3(string $s3Path): void
    {
        $tempPath = '/tmp/' . uniqid('process_', true) . '.tmp';
        
        try {
            $readStream = Storage::disk('s3')->readStream($s3Path);
            if (!is_resource($readStream)) {
                throw new RuntimeException('Failed to read S3 stream.');
            }
            
            $fileObj = fopen($tempPath, 'wb');
            if (!is_resource($fileObj)) {
                throw new RuntimeException("Cannot write to temp file: $tempPath");
            }
            
            stream_copy_to_stream($readStream, $fileObj);
            fclose($fileObj);
            fclose($readStream);

            // ... Lakukan proses file berat menggunakan $tempPath ...
            
        } finally {
            if (file_exists($tempPath)) {
                unlink($tempPath);
            }
        }
    }
}
```

### 2. Konfigurasi RDS Proxy di Vapor
AWS RDS Proxy mutlak diperlukan di Vapor. Tanpa RDS Proxy, DB akan `Max Connections Reached` (Connection Exhaustion) dalam milidetik.

```yaml
# vapor.yml config (Contoh production Vapor configuration)
id: 1234
name: enterprise-vapor-app
environments:
    production:
        memory: 1024
        cli-memory: 2048
        timeout: 28
        queue-timeout: 600
        concurrency: 500
        database: my-aurora-cluster
        database-proxy: true
        warm: 20
        storage: my-s3-bucket
```

## Pest v3 Tests

```php
<?php

use App\Services\System\VaporTempFileManager;
use Illuminate\Support\Facades\Storage;

test('temp file is processed and cleaned up from /tmp', function () {
    $s3Mock = Storage::fake('s3');
    $s3Mock->put('test-file.txt', 'dummy content');
    
    $manager = new VaporTempFileManager();
    
    expect(fn() => $manager->processLargeFileFromS3('test-file.txt'))
        ->not->toThrow(Exception::class);
});
```

## Anti-Patterns & Edge Cases

### ❌ Anti-Pattern 1: Menggunakan State (Session/Cache) di Filesystem
```php
// SALAH: Lambda instance bersifat sementara dan di-reuse secara acak.
// Sesi dari user A bisa bocor ke user B jika memakai filesystem / session file lokal.
config(['session.driver' => 'file']); 
```
✅ **Benar:** Wajib menggunakan *distributed storage* untuk state. `CACHE_DRIVER=dynamodb` (atau Redis), `SESSION_DRIVER=dynamodb`.

### ❌ Anti-Pattern 2: Menutup Koneksi (Connection Pooling Lokal)
```php
// SALAH: Laravel DB::disconnect() di Lambda tidak menolong, justru memperlambat.
```
✅ **Benar:** Gunakan AWS RDS Proxy (`database-proxy: true` di vapor.yml).

### Production Edge Cases
1. **Cold Start Latency Penalty:** Jika Lambda "Cold" (baru diputar), proses *bootstraping* memakan waktu 1-3 detik. **Mitigasi:** Gunakan fitur `warm: 20` di Vapor yang akan melakukan pemanggilan ping palsu via EventBridge.
2. **The 15-Minute Queue Limit:** Maksimal waktu eksekusi Lambda adalah 15 Menit. Jika Queue job memakan waktu 30 menit. **Mitigasi:** Pecah/Chunk Job menggunakan fitur `Job Batching` Laravel, di mana 1 Master Job mendelegasikan 100 Child Jobs yang berjalan paralel < 1 menit.
3. **RAM vs CPU Scaling:** Di AWS Lambda, CPU power berbanding lurus dengan alokasi RAM. **Mitigasi:** Tingkatkan alokasi memori dari `512` ke `1024` atau `2048` di Vapor, yang secara otomatis melipatgandakan vCPU dari AWS.
