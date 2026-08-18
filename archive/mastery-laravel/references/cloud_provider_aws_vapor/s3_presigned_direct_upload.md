# AWS S3 Presigned Direct Upload di Laravel Vapor (Bypassing Server RAM)

## Arsitektur & Motivasi
Upload file besar (gigabyte) melalui server PHP (terutama di lingkungan serverless Lambda/Vapor yang memiliki constraint `/tmp` 512MB dan timeout 15 menit) adalah anti-pattern kritis. Solusi produksi Top 1% adalah mengizinkan browser client mengupload langsung ke S3 bucket menggunakan IAM Presigned URL (POST) dengan Signature V4.

### Diagram Alur CORS Presigned Direct Upload
```text
[Browser/Client]                         [Laravel Vapor API]                           [Amazon S3 Bucket]
      |                                           |                                            |
      | 1. Request Presigned URL (POST /upload)   |                                            |
      |------------------------------------------>| (Verify Auth & Generate URL)               |
      |                                           | 2. Generate Signed POST Policy             |
      | 3. Return JSON: {url, fields, path}       |<===========================================|
      |<------------------------------------------|                                            |
      |                                           |                                            |
      | 4. Multipart/Form-Data POST to S3 URL     |                                            |
      |    (Bypassing Laravel Server & RAM)       |                                            |
      |--------------------------------------------------------------------------------------->|
      |                                           |                                            |
      |                                           |                  5. S3 Event Notification  |
      |                                           |<===========================================|
      |                                           | (SQS Queue -> Process S3 Webhook Callback) |
```

## Implementasi PHP 8.3 / Laravel 11 (PHPStan Level 9)

```php
<?php

declare(strict_types=1);

namespace App\Services\Storage;

use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Support\Facades\Storage;
use Aws\S3\S3Client;
use Aws\S3\PostObjectV4;
use RuntimeException;
use App\Exceptions\S3PresignedGenerationException;

final readonly class S3PresignedUrlGenerator
{
    /**
     * @param array<string, mixed> $options
     */
    public function __construct(
        private int $expiresInMinutes = 15,
        private string $disk = 's3'
    ) {}

    /**
     * Generate S3 Signed POST payload for direct client upload.
     *
     * @param string $directory
     * @param string $uuidFilename
     * @param int $maxFileSizeByte
     * @param string $contentType
     * @return array{url: string, fields: array<string, string>}
     * @throws S3PresignedGenerationException
     */
    public function generatePost(
        string $directory,
        string $uuidFilename,
        int $maxFileSizeByte = 1073741824, // 1GB
        string $contentType = 'application/octet-stream'
    ): array {
        try {
            /** @var Filesystem $storage */
            $storage = Storage::disk($this->disk);
            
            /** @var \Illuminate\Filesystem\AwsS3V3Adapter $adapter */
            $adapter = $storage; // @phpstan-ignore-line (Internal casting)
            
            /** @var S3Client $client */
            $client = $adapter->getClient();
            $bucket = $adapter->getConfig()['bucket'] ?? throw new RuntimeException('S3 Bucket not configured');
            $prefix = $adapter->getConfig()['root'] ?? '';

            $path = trim($prefix . '/' . $directory . '/' . $uuidFilename, '/');
            
            $options = [
                ['starts-with', '$key', $path],
                ['content-length-range', 1, $maxFileSizeByte],
                ['eq', '$Content-Type', $contentType],
                ['eq', '$acl', 'private'],
            ];

            $formInputs = [
                'acl' => 'private',
                'key' => $path,
                'Content-Type' => $contentType,
            ];

            $postObject = new PostObjectV4(
                $client,
                (string) $bucket,
                $formInputs,
                $options,
                sprintf('+%d minutes', $this->expiresInMinutes)
            );

            return [
                'url' => $postObject->getFormAttributes()['action'],
                'fields' => $postObject->getFormInputs(),
            ];
        } catch (\Throwable $e) {
            throw new S3PresignedGenerationException('Failed generating S3 Presigned URL: ' . $e->getMessage(), (int) $e->getCode(), $e);
        }
    }
}
```

## S3 Webhook Handler (via SQS Event)

```php
<?php

declare(strict_types=1);

namespace App\Jobs\Storage;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Log;

final class ProcessS3UploadEvent implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 3;
    public int $timeout = 120;

    /**
     * @param array<string, mixed> $s3EventPayload
     */
    public function __construct(
        private readonly array $s3EventPayload
    ) {}

    public function handle(): void
    {
        $records = $this->s3EventPayload['Records'] ?? [];
        foreach ($records as $record) {
            if (($record['eventName'] ?? '') === 'ObjectCreated:Post') {
                $bucket = $record['s3']['bucket']['name'] ?? '';
                $key = $record['s3']['object']['key'] ?? '';
                $size = (int) ($record['s3']['object']['size'] ?? 0);

                Log::info(sprintf('S3 Object Uploaded: s3://%s/%s (Size: %d bytes)', $bucket, $key, $size));
                
                // Proses update DB, media conversion, dll.
            }
        }
    }
}
```

## Pest v3 Tests

```php
<?php

use App\Services\Storage\S3PresignedUrlGenerator;
use Illuminate\Support\Facades\Storage;
use Aws\S3\S3Client;
use Aws\S3\PostObjectV4;

test('generates valid s3 presigned post payload', function () {
    config()->set('filesystems.disks.s3', [
        'driver' => 's3',
        'key' => 'fake-key',
        'secret' => 'fake-secret',
        'region' => 'us-east-1',
        'bucket' => 'test-bucket',
    ]);
    
    $generator = new S3PresignedUrlGenerator();
    $result = $generator->generatePost('uploads/videos', 'file-uuid-123.mp4', 1048576, 'video/mp4');
    
    expect($result)
        ->toBeArray()
        ->toHaveKeys(['url', 'fields'])
        ->and($result['fields'])
        ->toHaveKey('key', 'uploads/videos/file-uuid-123.mp4')
        ->toHaveKey('Content-Type', 'video/mp4');
});
```

## Anti-Patterns & Edge Cases

### ❌ Anti-Pattern 1: Menyimpan File Besar Lewat PHP / Laravel Server
```php
// SALAH: Laravel akan membaca seluruh file ke RAM / disk sementara. 
// Lambda akan crash karena out of memory atau space (/tmp penuh).
public function upload(Request $request) {
    $path = $request->file('video')->store('videos', 's3');
}
```
✅ **Benar:** Gunakan Presigned URL dan biarkan client upload langsung ke S3.

### ❌ Anti-Pattern 2: Presigned GET untuk Upload
```php
// SALAH: Presigned GET tidak bisa mengontrol filesize atau MIME type.
$url = Storage::disk('s3')->temporaryUrl('file.jpg', now()->addMinutes(5));
```
✅ **Benar:** Gunakan S3 `PostObjectV4` yang mendukung policy (content-length-range, Content-Type, ACL).

### Production Edge Cases
1. **Token Expiration Saat Slow Network:** Client dengan koneksi lambat mungkin mengalami timeout S3 POST karena presigned URL expired di tengah upload. **Mitigasi:** Tambahkan retry logic di frontend dengan meminta token presigned baru dan resume via Multipart Upload.
2. **CORS Misconfiguration di S3:** Bucket S3 secara default menolak POST request dari browser. **Mitigasi:** Pastikan Terraform/AWS Console mengatur CORS configuration S3 dengan `AllowedMethods: ["POST", "PUT"]`, `AllowedOrigins: ["https://app.domain.com"]`, `ExposeHeaders: ["ETag"]`.
3. **Malicious File Upload Bypass:** Hacker memodifikasi ekstensi di POST request. **Mitigasi:** Wajibkan `['eq', '$Content-Type', $mime]` di POST policy dan verifikasi ulang payload dengan S3 webhook event (MIME type sniffing via AWS Lambda Edge) sebelum di-serve.
