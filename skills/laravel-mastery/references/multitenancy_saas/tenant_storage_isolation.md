---
title: "Tenant Storage Isolation in Laravel"
description: "Mastering zero-leak, highly secure, and highly scalable tenant storage isolation in Laravel 11/12 utilizing Clean Architecture and PHP 8.4"
author: "Antigravity Laravel Mastery"
tags: ["laravel", "multitenancy", "storage", "security", "octane", "pest"]
---

# 🚀 Enterprise Multi-Tenancy: Tenant Storage Isolation Masterclass

Dalam arsitektur Software-as-a-Service (SaaS), pemisahan data penyewa (tenant) merupakan harga mati. Walaupun pemisahan pada level *Database* seringkali menjadi fokus utama (melalui skema atau Row-Level Security), isolasi *File Storage* kerap kali diimplementasikan secara ceroboh. Kegagalan dalam mengisolasi storage tenant dapat mengakibatkan kebocoran data sensitif antar perusahaan (Cross-Tenant Data Leakage) dan berujung pada tuntutan hukum, terutama jika menangani data regulasi seperti HIPAA atau GDPR.

Panduan ini merinci implementasi *Tenant Storage Isolation* tingkat Top 1% menggunakan **PHP 8.3/8.4** dan **Laravel 11/12**. Kita akan menerapkan **Clean Architecture**, menghindari kebocoran memori pada *long-running runtimes* (Laravel Octane/FrankenPHP), dan memastikan keamanan dari serangan *Path Traversal*.

---

## 🛑 1. Critical Anti-Patterns dalam Storage Multitenancy

Sebelum membangun sistem yang benar, kita harus mengenali jebakan umum yang sering dilakukan developer menengah.

### Anti-Pattern 1: Hardcoding & Path Concatenation tanpa Sanitasi (Path Traversal Risk)

Banyak developer mengira menggabungkan ID Tenant dengan nama file sudah cukup untuk melakukan isolasi. Ini sangat berbahaya.

❌ **Bad Practice (Security & Data Leak Risk):**
```php
declare(strict_types=1);

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;

class InsecureTenantStorageController
{
    public function store(Request $request): void
    {
        // 🚨 BAHAYA: Mengambil tenant_id dari request payload (mudah di-spoof)
        $tenantId = $request->input('tenant_id'); 
        
        // 🚨 BAHAYA: Menggunakan original client name yang rentan terhadap Path Traversal
        // Jika nama file = "../../../etc/passwd", file bisa ter-overwrite!
        $filename = $request->file('document')->getClientOriginalName();
        
        // 🚨 BAHAYA: Hardcoded path concatenation
        Storage::disk('s3')->put("tenants/{$tenantId}/{$filename}", $request->file('document')->getContent());
    }
}
```
**Risiko:** Serangan Directory Traversal, Cross-Tenant Write, Spoofing.

✅ **Best Practice: Scoped Disks & UUIDs**
Konfigurasi `Storage::disk('tenant')` secara dinamis pada saat *Tenant Identification Middleware*, dan selalu *generate* nama file unik (UUID/Hash).

---

### Anti-Pattern 2: Global State Mutation di Lingkungan Octane (Memory/State Leak Risk)

Di Laravel Octane (Swoole/FrankenPHP), aplikasi Anda tetap hidup (resident in memory) di antara *requests*. Mengubah konfigurasi global (`config()`) tanpa mengembalikannya (reset) akan menyebabkan *State Leakage* antar tenant.

❌ **Bad Practice (State Leak di Octane):**
```php
declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

class BadTenantIdentification
{
    public function handle(Request $request, Closure $next)
    {
        $tenant = $this->resolveTenant($request);
        
        // 🚨 BAHAYA DI OCTANE: Konfigurasi ini akan bertahan untuk request berikutnya
        // Jika request berikutnya gagal mengidentifikasi tenant, ia akan menggunakan konfigurasi tenant sebelumnya!
        config(['filesystems.disks.tenant.root' => storage_path("app/tenants/{$tenant->id}")]);
        
        return $next($request);
    }
}
```

✅ **Best Practice: Scoped Singletons / Context API**
Gunakan fitur bawaan Laravel 11 `Context` API atau *Scoped Bindings* untuk memastikan *state* hancur setelah request selesai, atau konfigurasi ulang filesystem disk factory untuk membuat instansi baru secara dinamis.

---

## 🏗️ 2. Clean Architecture Implementation

Kita akan membangun *Tenant Storage Service* menggunakan **Clean Architecture** (Request -> Controller -> Action -> Repository -> Model). Semua kode bersifat *strongly typed*.

### A. Domain Models

Model `Tenant` dan `TenantFile` yang merepresentasikan struktur *database* kita.

```php
<?php

declare(strict_types=1);

namespace Domain\Tenant\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * @property string $id
 * @property string $name
 * @property string $storage_prefix
 */
final class Tenant extends Model
{
    use HasUuids;

    protected $fillable = [
        'name',
        'storage_prefix',
    ];

    /**
     * @return HasMany<TenantFile, $this>
     */
    public function files(): HasMany
    {
        return $this->hasMany(TenantFile::class);
    }
}
```

```php
<?php

declare(strict_types=1);

namespace Domain\Tenant\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * @property string $id
 * @property string $tenant_id
 * @property string $original_name
 * @property string $storage_path
 * @property string $mime_type
 * @property int $size_bytes
 */
final class TenantFile extends Model
{
    use HasUuids;

    protected $fillable = [
        'tenant_id',
        'original_name',
        'storage_path',
        'mime_type',
        'size_bytes',
    ];

    /**
     * @return BelongsTo<Tenant, $this>
     */
    public function tenant(): BelongsTo
    {
        return $this->belongsTo(Tenant::class);
    }
}
```

### B. The Storage Repository Contract & Implementation

Repository bertanggung jawab murni untuk *persistence* (menyimpan metadata ke *database*) dan abstraksi eksekusi *filesystem*.

```php
<?php

declare(strict_types=1);

namespace Domain\Tenant\Repositories;

use Domain\Tenant\Models\Tenant;
use Domain\Tenant\Models\TenantFile;
use Illuminate\Http\UploadedFile;

interface TenantStorageRepositoryInterface
{
    /**
     * Store file physical data to the tenant's isolated disk.
     */
    public function putFile(Tenant $tenant, UploadedFile $file, string $directory = ''): string;
    
    /**
     * Delete file physical data from the tenant's isolated disk.
     */
    public function deleteFile(Tenant $tenant, string $path): bool;
    
    /**
     * Save metadata record to the database.
     */
    public function createMetadata(Tenant $tenant, array $data): TenantFile;
}
```

```php
<?php

declare(strict_types=1);

namespace Infrastructure\Tenant\Repositories;

use Domain\Tenant\Models\Tenant;
use Domain\Tenant\Models\TenantFile;
use Domain\Tenant\Repositories\TenantStorageRepositoryInterface;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use InvalidArgumentException;
use RuntimeException;

final readonly class EloquentTenantStorageRepository implements TenantStorageRepositoryInterface
{
    public function putFile(Tenant $tenant, UploadedFile $file, string $directory = ''): string
    {
        $disk = $this->getTenantDisk($tenant);
        
        $extension = $file->getClientOriginalExtension();
        $safeFileName = Str::uuid()->toString() . '.' . $extension;
        
        // Memastikan direktori tidak memiliki path traversal attack payload
        $safeDirectory = Str::replace(['..', '/', '\\'], '', $directory);
        $finalPath = trim($safeDirectory . '/' . $safeFileName, '/');

        $success = $disk->put($finalPath, $file->getContent());

        if (! $success) {
            throw new RuntimeException("Failed to write file to tenant disk: {$tenant->id}");
        }

        return $finalPath;
    }

    public function deleteFile(Tenant $tenant, string $path): bool
    {
        return $this->getTenantDisk($tenant)->delete($path);
    }

    public function createMetadata(Tenant $tenant, array $data): TenantFile
    {
        /** @var TenantFile $tenantFile */
        $tenantFile = $tenant->files()->create($data);
        
        return $tenantFile;
    }

    /**
     * Isolasi disk secara real-time yang AMAN untuk Octane.
     * Menggunakan factory `Storage::build()` tanpa meracuni konfigurasi global.
     */
    private function getTenantDisk(Tenant $tenant): \Illuminate\Contracts\Filesystem\Filesystem
    {
        // Untuk S3, ganti driver menjadi 's3' dan tambahkan prefix
        return Storage::build([
            'driver' => 'local',
            'root' => storage_path("app/tenants/{$tenant->storage_prefix}"),
            'visibility' => 'private',
            'throw' => true,
        ]);
    }
}
```

### C. The Action Layer (Business Logic)

*Action classes* melakukan orkestrasi antara *Request*, *Repository*, dan *Event Dispatchers*. Ini adalah inti bisnis logik aplikasi.

```php
<?php

declare(strict_types=1);

namespace Domain\Tenant\Actions;

use Domain\Tenant\Models\Tenant;
use Domain\Tenant\Models\TenantFile;
use Domain\Tenant\Repositories\TenantStorageRepositoryInterface;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Throwable;

final readonly class StoreTenantFileAction
{
    public function __construct(
        private TenantStorageRepositoryInterface $repository
    ) {}

    /**
     * @throws Throwable
     */
    public function execute(Tenant $tenant, UploadedFile $file, string $directory = 'uploads'): TenantFile
    {
        // Menggunakan transaksi database agar metadata tidak tersimpan 
        // jika penulisan fisik file gagal.
        return DB::transaction(function () use ($tenant, $file, $directory): TenantFile {
            
            // 1. Simpan fisik file
            $path = $this->repository->putFile($tenant, $file, $directory);
            
            // 2. Simpan metadata
            return $this->repository->createMetadata($tenant, [
                'original_name' => $file->getClientOriginalName(),
                'storage_path'  => $path,
                'mime_type'     => $file->getMimeType() ?? 'application/octet-stream',
                'size_bytes'    => $file->getSize(),
            ]);
            
        });
    }
}
```

### D. The Form Request (Validation)

Validasi *incoming data* di ujung sistem.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Tenant;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rules\File;

final class UploadTenantFileRequest extends FormRequest
{
    public function authorize(): bool
    {
        // Pastikan hanya user yang memiliki akses ke tenant saat ini yang dapat mengunggah
        return $this->user() !== null && $this->user()->belongsToCurrentTenant();
    }

    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'document' => [
                'required',
                File::types(['pdf', 'jpg', 'png', 'csv'])
                    ->max(10 * 1024), // Max 10MB
            ],
            'directory' => [
                'nullable',
                'string',
                'regex:/^[a-zA-Z0-9_-]+$/', // Sanitasi level-1 untuk direktori
                'max:50',
            ],
        ];
    }
}
```

### E. The Controller (Delivery Mechanism)

*Controller* menjadi sangat tipis (*Thin Controller*), hanya memompa data dari HTTP Request ke *Action*, lalu mengembalikan HTTP Response.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Tenant;

use App\Http\Controllers\Controller;
use App\Http\Requests\Tenant\UploadTenantFileRequest;
use Domain\Tenant\Actions\StoreTenantFileAction;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Context;
use Symfony\Component\HttpFoundation\Response;
use Domain\Tenant\Models\Tenant;
use RuntimeException;

final class TenantFileController extends Controller
{
    public function __construct(
        private readonly StoreTenantFileAction $storeAction,
    ) {}

    public function store(UploadTenantFileRequest $request): JsonResponse
    {
        /** @var Tenant|null $tenant */
        $tenant = Context::get('current_tenant');
        
        if (! $tenant instanceof Tenant) {
            throw new RuntimeException('Context tenant hilang. Middleware gagal mengatur context.');
        }

        $file = $request->file('document');
        $directory = $request->validated('directory', 'general');

        $tenantFile = $this->storeAction->execute($tenant, $file, $directory);

        return response()->json([
            'message' => 'File uploaded successfully securely.',
            'data' => [
                'id'            => $tenantFile->id,
                'original_name' => $tenantFile->original_name,
                'size'          => $tenantFile->size_bytes,
            ]
        ], Response::HTTP_CREATED);
    }
}
```

---

## 🔒 3. Keamanan Tambahan & AWS S3 Prefixing

Jika menggunakan penyedia *Cloud Storage* seperti AWS S3, pendekatan isolasi berpusat pada **IAM Policies** dan **Prefixing**.

Di S3, Anda **tidak** boleh membiarkan satu kredensial memiliki akses ke seluruh *bucket* untuk operasi *frontend upload*. Sebagai gantinya, di backend saat mengolah file:

```php
// Pada repositori S3, gunakan Storage::build() untuk prefix:
private function getTenantS3Disk(Tenant $tenant): \Illuminate\Contracts\Filesystem\Filesystem
{
    return Storage::build([
        'driver'                  => 's3',
        'key'                     => config('services.aws.key'),
        'secret'                  => config('services.aws.secret'),
        'region'                  => config('services.aws.region'),
        'bucket'                  => config('services.aws.bucket'),
        // Kunci utamanya adalah mengunci root path ke storage prefix milik tenant
        'root'                    => "tenants/{$tenant->storage_prefix}", 
        'url'                     => config('services.aws.url'),
        'endpoint'                => config('services.aws.endpoint'),
        'use_path_style_endpoint' => config('services.aws.use_path_style_endpoint', false),
        'throw'                   => true,
    ]);
}
```
**Keuntungan Pendekatan `Storage::build()` (Octane-Safe):**
Karena ia membuat *instance* baru, ia tidak menyentuh susunan array global konfigurasi aplikasi. Konfigurasi terisolasi sempurna pada skala *request*.

---

## 🧪 4. Pest v3 Testing (Unit & Arch)

Pengujian tingkat tinggi dengan Pest v3. Kita memastikan standar arsitektur dan memverifikasi fungsionalitas isolasi *storage* menggunakan *fake storage*.

### A. Architectural Testing (`tests/ArchTest.php`)

Kita memastikan Clean Architecture terjaga. *Domain layer* tidak boleh bergantung pada *App layer* (HTTP/Controllers).

```php
<?php

declare(strict_types=1);

test('domain layer tidak boleh bergantung pada aplikasi HTTP atau Controllers')
    ->expect('Domain')
    ->not->toUse('App\Http')
    ->not->toUse('App\Console');

test('action class harus ditandai sebagai final dan readonly')
    ->expect('Domain\Tenant\Actions')
    ->toBeFinal()
    ->toBeReadonly();

test('hindari pemanggilan config() global di Middleware yang dapat meracuni Octane')
    ->expect('App\Http\Middleware')
    ->not->toUse('config');
```

### B. Unit & Integration Testing (`tests/Unit/TenantStorageTest.php`)

```php
<?php

declare(strict_types=1);

use Domain\Tenant\Actions\StoreTenantFileAction;
use Domain\Tenant\Models\Tenant;
use Infrastructure\Tenant\Repositories\EloquentTenantStorageRepository;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Str;

beforeEach(function () {
    // Siapkan memori DB untuk unit testing (Sqlite in-memory)
    $this->tenant = Tenant::create([
        'id'             => Str::uuid()->toString(),
        'name'           => 'Acme Corp',
        'storage_prefix' => 'acme_uuid_123',
    ]);
    
    $this->repository = new EloquentTenantStorageRepository();
    $this->action = new StoreTenantFileAction($this->repository);
});

it('can securely store file in isolated tenant storage using build disk', function () {
    // Fake file upload
    $file = UploadedFile::fake()->image('avatar.jpg')->size(100);
    
    // Execute Action
    $tenantFile = $this->action->execute($this->tenant, $file, 'profiles');

    // Assert file record is saved in Database
    expect($tenantFile->original_name)->toBe('avatar.jpg')
        ->and($tenantFile->mime_type)->toBe('image/jpeg')
        ->and($tenantFile->size_bytes)->toBe(102400); // 100kb
        
    // Assert file physical data exists in the specific tenant path
    // Karena kita memakai Storage::build() untuk root `storage_path("app/tenants/{$tenant->storage_prefix}")`
    // File seharusnya ada di sana.
    $expectedPath = storage_path("app/tenants/{$this->tenant->storage_prefix}/" . $tenantFile->storage_path);
    
    expect(file_exists($expectedPath))->toBeTrue();
    
    // Cleanup fake file for testing
    @unlink($expectedPath);
});

it('prevents path traversal attacks in directory name', function () {
    $file = UploadedFile::fake()->create('document.pdf', 50, 'application/pdf');
    
    // Payload percobaan eksploitasi traversal directory
    $maliciousDirectory = '../../../etc/hacked';
    
    $tenantFile = $this->action->execute($this->tenant, $file, $maliciousDirectory);
    
    // Repositori harus membersihkan path tersebut.
    // 'etchacked' terbentuk karena filter Str::replace(['..', '/', '\\'], '', $directory)
    expect($tenantFile->storage_path)->toStartWith('etchacked/');
});
```

## 🏆 Kesimpulan

1. **Gunakan `Storage::build()`**: Daripada memutasi konfigurasi global menggunakan `config(['filesystems...'])`, gunakan *factory* bawaan Laravel untuk membangun *instance disk* secara *on-the-fly*. Hal ini mencegah kebocoran *state* pada Laravel Octane.
2. **Bersihkan Path (Sanitize)**: Jangan pernah mempercayai masukan (input) string yang akan dijadikan direktori. Buang karakter `.` dan `/`.
3. **Database Sinkron**: Gunakan transaksi `DB::transaction` ketika menyimpan metadata yang memiliki ekuivalensi fisik di media *storage*.
4. **UUIDs for Filenames**: Nama file dari pengguna rentan membawa karakter berbahaya, memengaruhi URL *encoding*, dan berisiko tabrakan (collision). Selalu *hash* atau generate *UUID* di level penyimpanan *(storage level)*.
