---
title: "Secure File Uploads di Laravel 11/12"
description: "Panduan arsitektur dan mitigasi keamanan (OWASP) untuk menangani unggahan file pada aplikasi Laravel 11/12 berskala enterprise."
---

# Secure File Uploads (Keamanan Unggahan File)

Unggahan file adalah salah satu celah keamanan terbesar dalam aplikasi web. Kesalahan dalam validasi dan penyimpanan dapat menyebabkan *Remote Code Execution* (RCE), *Cross-Site Scripting* (XSS), *Path Traversal*, hingga *Denial of Service* (DoS). Di Laravel 11/12 dan PHP 8.3/8.4, perlindungan ini harus ditangani di beberapa lapisan: Request, Processing, dan Storage.

## 1. Vektor Serangan Utama

1. **Malicious Code Execution (RCE):** Attacker mengunggah *shell* PHP (misal: `shell.php` atau `image.php.jpg` yang diinterpretasikan oleh server Nginx/Apache) ke direktori publik.
2. **Client-Side Mime Spoofing:** Attacker mengklaim file adalah `image/png` padahal isinya adalah *executable* atau *script* HTML dengan *payload* XSS.
3. **Path Traversal / Overwrite:** Nama file yang diunggah berisi `../../../etc/passwd` atau bertujuan menimpa konfigurasi `.env`.
4. **Denial of Service (DoS):** File berukuran gigabytes atau bom kompresi (ZIP bomb) yang meledakkan RAM.

---

## 2. Anti-Pattern: Security Risk Fatal

Berikut adalah cara-cara umum yang sangat berbahaya dalam menangani file di PHP/Laravel.

### 2.1 Anti-Pattern 1: Mengandalkan Nama & Ekstensi dari Klien

❌ **KODE SALAH (Bad Practice)**

Menyimpan file langsung ke direktori publik menggunakan nama asli (original filename) dari *client* tanpa mengubahnya dan tanpa mengecek *magic bytes*.

```php
declare(strict_types=1);

namespace App\Http\Controllers;

use Illuminate\Http\Request;

class ProfileController extends Controller
{
    public function uploadAvatar(Request $request)
    {
        // BERBAHAYA: 
        // 1. Tidak ada validasi Mime/Magic bytes
        // 2. Menggunakan ekstensi bawaan client (getClientOriginalExtension())
        // 3. Menyimpan di local disk (public) dengan nama asli
        $file = $request->file('avatar');
        
        $filename = $file->getClientOriginalName();
        $file->move(public_path('uploads/avatars'), $filename);

        return response()->json(['path' => 'uploads/avatars/' . $filename]);
    }
}
```

> **Risiko Security:** Attacker dapat mengunggah file bernama `webshell.php`. Jika web server (Nginx/Apache) dikonfigurasi untuk mengeksekusi ekstensi `.php` di folder `public/uploads`, server akan diambil alih (RCE). Attacker juga bisa melakukan *Path Traversal* dengan mengubah payload *filename* di multipart form-data.

✅ **KODE BENAR (Best Practice)**

Gunakan Hash/UUID acak untuk nama file, validasi ketat via FormRequest, gunakan Flysystem (Storage Facade), dan simpan di Cloud Storage (seperti AWS S3) atau disk non-publik, jauh dari *document root* web server.

```php
declare(strict_types=1);

namespace App\Actions\User;

use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

readonly class UploadAvatarAction
{
    public function execute(UploadedFile $file): string
    {
        // Aman: Generate nama file acak, ekstensi diverifikasi oleh MimeType PHP
        // Bukan berdasar klaim client.
        $extension = $file->extension(); 
        $filename = Str::uuid()->toString() . '.' . $extension;

        // Simpan di S3 (terisolasi dari web server engine)
        $path = Storage::disk('s3')->putFileAs(
            'avatars', 
            $file, 
            $filename
        );

        return $path;
    }
}
```

### 2.2 Anti-Pattern 2: Mempercayai `Mime-Type` Client (Header Multipart)

❌ **KODE SALAH (Bad Practice)**

Mengecek tipe file menggunakan atribut Mime dari HTTP Request client.

```php
declare(strict_types=1);

namespace App\Services;

use Illuminate\Http\UploadedFile;

class DocumentService
{
    public function isValid(UploadedFile $file): bool
    {
        // BERBAHAYA: Client Mime Type mudah dipalsukan (Spoofing) via Burp Suite
        $mime = $file->getClientMimeType();
        
        return in_array($mime, ['application/pdf', 'image/png']);
    }
}
```

> **Risiko Security:** Penyerang dapat mengunggah `virus.exe` namun mengirim header `Content-Type: image/png`. Jika sistem Anda hanya mengecek `getClientMimeType()`, file tersebut akan lolos.

✅ **KODE BENAR (Best Practice)**

Gunakan Laravel Validation Rules `mimes` atau `mimetypes` yang secara internal (di background) menggunakan ekstensi PHP `finfo` (File Information) untuk memeriksa *Magic Bytes* (struktur header file sesungguhnya pada disk).

```php
declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UploadDocumentRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            // 'mimes' mengecek magic bytes, BUKAN ekstensi client
            // 'max:2048' (2MB) mencegah DoS via file raksasa
            'document' => ['required', 'file', 'mimes:pdf,png,jpg', 'max:2048'],
        ];
    }
}
```

---

## 3. Implementasi Clean Architecture

Berikut arsitektur aman untuk fitur unggahan dokumen identitas (KTP/Passport) yang sensitif.

### 3.1 Form Request (Layer Validasi)

```php
declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rules\File;

class IdentityUploadRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            // Menggunakan Laravel 11/12 File Rule Builder (Lebih modern dan kuat)
            'identity_card' => [
                'required',
                File::types(['jpg', 'jpeg', 'png', 'pdf'])
                    ->max(5 * 1024), // Max 5MB
            ],
            'user_id' => ['required', 'integer', 'exists:users,id']
        ];
    }
}
```

### 3.2 Repository (Mencatat File ke DB)

```php
declare(strict_types=1);

namespace App\Repositories;

use App\Models\UserDocument;

class DocumentRepository
{
    public function saveDocumentInfo(int $userId, string $path, string $originalName, string $mimeType, int $size): UserDocument
    {
        return UserDocument::create([
            'user_id' => $userId,
            'file_path' => $path,
            'original_name' => $originalName,
            'mime_type' => $mimeType,
            'size_bytes' => $size,
        ]);
    }
}
```

### 3.3 Action (Processing & Storage S3)

Proses ini menangani unggahan ke *bucket private* S3, memastikan file tidak bisa diakses publik tanpa otorisasi.

```php
declare(strict_types=1);

namespace App\Actions\Document;

use App\Models\UserDocument;
use App\Repositories\DocumentRepository;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use RuntimeException;

readonly class UploadIdentityDocumentAction
{
    public function __construct(
        private DocumentRepository $repository
    ) {}

    public function execute(int $userId, UploadedFile $file): UserDocument
    {
        // 1. Ekstensi berbasis Magic Bytes (finfo)
        $extension = $file->extension();
        if (empty($extension)) {
            throw new RuntimeException('Unable to determine secure file extension.');
        }

        // 2. UUID untuk anti-Path Traversal dan anti-Overwrite
        $secureFilename = Str::uuid()->toString() . '.' . $extension;

        // 3. Simpan ke Disk 's3-private'
        $path = Storage::disk('s3-private')->putFileAs(
            "identities/{$userId}",
            $file,
            $secureFilename
        );

        if (!$path) {
            throw new RuntimeException('Failed to store file to cloud.');
        }

        // 4. Catat di DB untuk audit trail
        return $this->repository->saveDocumentInfo(
            $userId,
            $path,
            $file->getClientOriginalName(), // Disimpan hanya untuk UX, tidak untuk filepath
            $file->getClientMimeType(),     // Disimpan hanya untuk referensi
            $file->getSize()
        );
    }
}
```

### 3.4 Controller (Menerima Request)

```php
declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Actions\Document\UploadIdentityDocumentAction;
use App\Http\Controllers\Controller;
use App\Http\Requests\IdentityUploadRequest;
use Illuminate\Http\JsonResponse;

class IdentityController extends Controller
{
    public function __construct(
        private readonly UploadIdentityDocumentAction $uploadAction
    ) {}

    public function upload(IdentityUploadRequest $request): JsonResponse
    {
        $document = $this->uploadAction->execute(
            (int) $request->validated('user_id'),
            $request->file('identity_card')
        );

        return response()->json([
            'success' => true,
            'message' => 'Document securely uploaded',
            'data' => [
                'document_id' => $document->id,
            ]
        ], 201);
    }
}
```

---

## 4. Testing dengan Pest v3

Dalam arsitektur *security-first*, kita mensimulasikan percobaan peretasan dan memastikan validasi *magic bytes* bekerja.

### 4.1 Architecture Testing (`tests/ArchTest.php`)

```php
declare(strict_types=1);

uses()->group('architecture', 'security');

test('no direct file moving or public_path usage', function () {
    // Kita memaksa developer menggunakan Storage Facade (Flysystem)
    expect(['move_uploaded_file', 'public_path'])
        ->not->toBeUsed();
});
```

### 4.2 Unit Testing Action (`tests/Unit/Actions/UploadIdentityDocumentActionTest.php`)

```php
declare(strict_types=1);

use App\Actions\Document\UploadIdentityDocumentAction;
use App\Models\UserDocument;
use App\Repositories\DocumentRepository;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;

uses()->group('unit', 'upload');

beforeEach(function () {
    Storage::fake('s3-private');
    
    $this->repository = Mockery::mock(DocumentRepository::class);
    $this->action = new UploadIdentityDocumentAction($this->repository);
});

it('securely uploads and stores document in cloud', function () {
    // Arrange
    $file = UploadedFile::fake()->image('my-id.jpg')->size(1024); // 1MB Fake Image
    
    $expectedModel = new UserDocument(['id' => 999]);
    
    $this->repository->shouldReceive('saveDocumentInfo')
        ->once()
        ->andReturn($expectedModel);

    // Act
    $result = $this->action->execute(123, $file);

    // Assert
    expect($result->id)->toBe(999);
    
    // Verifikasi file benar-benar masuk ke fake disk S3-private
    // Dan menggunakan path userId/UUID.jpg, bukan my-id.jpg
    $files = Storage::disk('s3-private')->allFiles("identities/123");
    
    expect($files)->toHaveCount(1);
    expect($files[0])->not->toContain('my-id.jpg'); // Pastikan UUID digunakan
});
```

### 4.3 Integration Testing Security (`tests/Feature/Security/FileUploadSecurityTest.php`)

Di sini kita melakukan *Mime Spoofing*: Membuat file PHP berbahaya, tetapi kita beri tahu Laravel bahwa itu adalah `.jpg` dengan tipe *image/jpeg*.

```php
declare(strict_types=1);

use Illuminate\Http\UploadedFile;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class)->group('integration', 'security');

it('blocks mime spoofing and malicious php uploads', function () {
    // Memalsukan isi file menjadi eksekusi PHP (webshell)
    $maliciousContent = '<?php echo system($_GET["cmd"]); ?>';
    $tmpPath = sys_get_temp_dir() . '/shell.jpg';
    file_put_contents($tmpPath, $maliciousContent);
    
    // Attacker mengirim file ini, mengatakan ekstensi .jpg dan mime type image/jpeg
    $spoofedFile = new UploadedFile(
        $tmpPath,
        'shell.jpg',
        'image/jpeg', // Fake mime type!
        null,
        true // test mode
    );

    // Act
    $response = $this->postJson('/api/identities/upload', [
        'user_id' => 1,
        'identity_card' => $spoofedFile,
    ]);

    // Assert
    // Validation rule (File::types()) akan gagal karena finfo menyadari 
    // konten aslinya adalah PHP script, bukan JPEG image.
    $response->assertStatus(422)
             ->assertJsonValidationErrors(['identity_card']);
             
    unlink($tmpPath);
});

it('blocks files exceeding size limit', function () {
    // Memalsukan file raksasa (6MB) -> batas adalah 5MB
    $hugeFile = UploadedFile::fake()->create('heavy.pdf', 6000, 'application/pdf');

    $response = $this->postJson('/api/identities/upload', [
        'user_id' => 1,
        'identity_card' => $hugeFile,
    ]);

    $response->assertStatus(422)
             ->assertJsonValidationErrors(['identity_card']);
});
```

---
## Kesimpulan

*   **Pemisahan Infrastruktur:** Server Web (Nginx/Apache/PHP-FPM) harus terpisah dari *Storage* file (S3, GCS). Ini menjamin meskipun attacker berhasil mengunggah file `shell.php` via celah tak terduga, server Nginx/PHP di *node* aplikasi tidak dapat mengakses apalagi mengeksekusi file tersebut karena tersimpan di infrastruktur berbeda.
*   **Finfo (Magic Bytes) Mutlak:** Jangan pernah percaya ekstensi (`.jpg`, `.pdf`) maupun header `Content-Type` yang dikirim dari klien via API/Web. Keduanya dimanipulasi dengan satu klik di Burp Suite.
*   **UUID:** Menggunakan nama acak (UUID/Hash) mencegah *Path Traversal* (misal nama `../../../root/.ssh/authorized_keys`) dan mencegah file saling menimpa satu sama lain dalam sistem berskala tinggi.
