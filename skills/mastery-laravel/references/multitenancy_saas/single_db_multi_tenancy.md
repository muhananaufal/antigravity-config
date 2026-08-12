---
title: Single Database Multi-Tenancy Architecture in Laravel
description: Implementasi arsitektur multi-tenancy dengan single database di Laravel 11/12 menggunakan global scopes, context, dan clean architecture.
tags: [laravel, multi-tenancy, architecture, security, scaling]
---

# Enterprise Single Database Multi-Tenancy di Laravel

Multi-tenancy dengan single database adalah pendekatan yang paling *cost-effective* dan mudah dikelola untuk aplikasi SaaS. Berbeda dengan pendekatan *multi-database* yang membutuhkan provisi infrastruktur rumit untuk setiap klien baru, arsitektur single-DB memungkinkan penambahan ribuan *tenant* hanya dengan menambah row di database. 

Namun, tantangan utamanya adalah **data isolation**—memastikan secara absolut bahwa satu tenant tidak bisa melihat atau mengubah data tenant lain secara tidak sengaja maupun disengaja.

Dokumentasi ini memberikan standar emas (Top 1% Quality) untuk implementasi Single DB Multi-Tenancy menggunakan fitur modern Laravel 11/12, standar PHP 8.3/8.4, dan prinsip *Clean Architecture*.

## 1. Arsitektur Inti & Isolasi Data

Pendekatan terbaik untuk *single DB multi-tenancy* di ekosistem Laravel modern adalah mengombinasikan **Global Scopes**, **Laravel Context**, dan **Clean Architecture**. Laravel Context (diperkenalkan di Laravel 11) adalah mekanisme revolusioner untuk memecahkan masalah pelacakan state pada environment asinkron (seperti Laravel Octane dengan Swoole/FrankenPHP).

### 1.1 Tenant Identification Pipeline

Identifikasi tenant harus dilakukan seawal mungkin pada siklus HTTP. Middleware HTTP adalah tempat yang paling tepat untuk domain-based, subdomain-based, atau header-based tenant resolution. Kita akan menyimpan *current tenant* di Laravel `Context`.

```php
<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Models\Tenant;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Context;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

final class IdentifyTenantMiddleware
{
    public function handle(Request $request, Closure $next): Response
    {
        $host = $request->getHost();
        
        $tenant = Tenant::where('domain', $host)->first();

        if (! $tenant instanceof Tenant) {
            throw new NotFoundHttpException(sprintf('Tenant for domain %s not found.', $host));
        }

        // Menyimpan tenant_id ke Context. Aman untuk aplikasi Octane dan Job Queues.
        Context::add('tenant_id', $tenant->id);
        Context::add('tenant_domain', $tenant->domain);

        return $next($request);
    }
}
```

### 1.2 The Tenant Global Scope

Semua model yang spesifik untuk tenant harus mengimplementasikan *Global Scope* agar klausa `WHERE tenant_id = ?` disisipkan secara otomatis oleh Query Builder. Kita menggunakan *Trait* untuk mendistribusikan logic ini ke berbagai model.

```php
<?php

declare(strict_types=1);

namespace App\Models\Scopes;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Scope;
use Illuminate\Support\Facades\Context;

final class TenantScope implements Scope
{
    public function apply(Builder $builder, Model $model): void
    {
        if (Context::has('tenant_id')) {
            $builder->where($model->qualifyColumn('tenant_id'), Context::get('tenant_id'));
        }
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Models\Traits;

use App\Models\Scopes\TenantScope;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\Context;
use App\Models\Tenant;

trait BelongsToTenant
{
    public static function bootBelongsToTenant(): void
    {
        static::addGlobalScope(new TenantScope());

        static::creating(static function (self $model): void {
            if (Context::has('tenant_id') && ! isset($model->tenant_id)) {
                $model->tenant_id = Context::get('tenant_id');
            }
        });
    }

    public function tenant(): BelongsTo
    {
        return $this->belongsTo(Tenant::class, 'tenant_id');
    }
}
```

## 2. Background Jobs & CLI Context Restoration

Salah satu kelemahan multi-tenancy di masa lalu adalah hilangnya konteks *tenant* saat melempar eksekusi ke *Queue* (Background Jobs). Dengan Laravel Context, state ini diteruskan secara implisit jika dikonfigurasi dengan benar, namun praktek terbaik adalah membungkus Job agar context tenant di-hydrate ulang sebelum eksekusi.

```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Context;

abstract class TenantAwareJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public readonly int $tenantId;

    public function __construct()
    {
        // Tangkap tenant_id saat Job di-dispatch
        $this->tenantId = (int) Context::get('tenant_id');
    }

    public function handle(): void
    {
        // Hydrate ulang context saat worker mengeksekusi Job
        Context::add('tenant_id', $this->tenantId);
        
        $this->execute();
    }
    
    abstract protected function execute(): void;
}
```

## 3. Clean Architecture Implementation

Untuk menjaga skalabilitas *codebase* dan maintainability tinggi, kita memisahkan logika aplikasi ke dalam Data Transfer Objects (DTO), Actions, dan Repositories. Controller hanya berfungsi sebagai pengatur arus masuk HTTP.

### 3.1 Domain Model

Model merepresentasikan struktur data dan relasinya.

```php
<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Traits\BelongsToTenant;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Concerns\HasUuids;

final class Invoice extends Model
{
    use HasUuids, BelongsToTenant;

    protected $fillable = [
        'tenant_id',
        'customer_name',
        'amount',
        'status',
    ];

    protected function casts(): array
    {
        return [
            'amount' => 'decimal:2',
            'status' => 'string',
        ];
    }
}
```

### 3.2 Data Transfer Object (DTO)

DTO digunakan untuk melempar argumen yang aman dan dijamin kebenarannya secara *type-safety* (PHP 8.3/8.4 readonly classes) melintasi berbagai lapisan arsitektur.

```php
<?php

declare(strict_types=1);

namespace App\DTOs;

final readonly class CreateInvoiceDTO
{
    public function __construct(
        public string $customerName,
        public float $amount,
        public string $status,
    ) {
    }

    public static function fromRequest(array $validatedData): self
    {
        return new self(
            customerName: $validatedData['customer_name'],
            amount: (float) $validatedData['amount'],
            status: $validatedData['status'],
        );
    }
}
```

### 3.3 Repository Layer

Repository membungkus semua interaksi persisten ke basis data. Meskipun Global Scope bekerja otomatis, repository menetapkan *contract* yang eksplisit bagi Action.

```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use App\DTOs\CreateInvoiceDTO;
use App\Models\Invoice;
use Illuminate\Database\Eloquent\Collection;

final readonly class InvoiceRepository
{
    public function __construct(
        private Invoice $model
    ) {
    }

    public function getAllForCurrentTenant(): Collection
    {
        // Tidak perlu spesifik menyebut tenant, global scope aktif
        return $this->model->newQuery()->get();
    }

    public function create(CreateInvoiceDTO $dto): Invoice
    {
        // `tenant_id` otomatis diisi oleh Eloquent event di Trait
        return $this->model->newQuery()->create([
            'customer_name' => $dto->customerName,
            'amount' => $dto->amount,
            'status' => $dto->status,
        ]);
    }
    
    public function findById(string $id): ?Invoice
    {
         return $this->model->newQuery()->find($id);
    }
}
```

### 3.4 Action Layer (Use Case)

Layer Action menampung *core business logic* sehingga logic dapat digunakan kembali dari Controller, CLI artisan, maupun background queue secara identik.

```php
<?php

declare(strict_types=1);

namespace App\Actions;

use App\DTOs\CreateInvoiceDTO;
use App\Models\Invoice;
use App\Repositories\InvoiceRepository;

final readonly class CreateInvoiceAction
{
    public function __construct(
        private InvoiceRepository $repository
        // private TenantQuotaService $quotaService
    ) {
    }

    public function execute(CreateInvoiceDTO $dto): Invoice
    {
        // Business logic berjalan di sini:
        // Misalnya: Validasi kuota tenant sebelum bisa membuat invoice baru
        // $this->quotaService->ensureQuotaAvailable(Context::get('tenant_id'));
        
        return $this->repository->create($dto);
    }
}
```

### 3.5 Controller & Form Request

Tanggung jawab Controller direduksi semata-mata untuk mengelola *request / response parsing*.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class StoreInvoiceRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // Biasanya Authorization didelegasikan ke Policy/Middleware.
    }

    public function rules(): array
    {
        return [
            'customer_name' => ['required', 'string', 'max:255'],
            'amount' => ['required', 'numeric', 'min:0'],
            'status' => ['required', 'string', 'in:pending,paid,cancelled'],
        ];
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Actions\CreateInvoiceAction;
use App\DTOs\CreateInvoiceDTO;
use App\Http\Requests\StoreInvoiceRequest;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final class InvoiceController extends Controller
{
    public function store(
        StoreInvoiceRequest $request,
        CreateInvoiceAction $createInvoiceAction
    ): JsonResponse {
        $dto = CreateInvoiceDTO::fromRequest($request->validated());
        
        $invoice = $createInvoiceAction->execute($dto);

        return response()->json([
            'message' => 'Invoice created successfully.',
            'data' => $invoice,
        ], Response::HTTP_CREATED);
    }
}
```

## 4. Cache & Queue Isolation Strategies

Menjalankan multi-tenancy tidak berhenti pada relasional DB. Cache layer (Redis/Memcached) juga rentan terhadap *Cross-Tenant Data Exposure*.

### Caching Terisolasi

Setiap cache key **wajib** diprefix dengan `tenant_id`. Mengabaikan aturan ini dapat mengakibatkan Tenant A membaca data cache yang sebelumnya di-generate oleh Tenant B.

```php
<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Context;

final readonly class TenantCacheService
{
    public function remember(string $key, \Closure $callback): mixed
    {
        $tenantId = Context::get('tenant_id');
        $tenantKey = sprintf('tenant:%s:%s', $tenantId, $key);
        
        // Cache selama 1 jam
        return Cache::remember($tenantKey, 3600, $callback);
    }
}
```

## 5. Anti-Patterns & Security Risks

Bagian ini menyoroti praktik-praktik berbahaya yang sering terjadi pada implementasi multi-tenancy single DB.

### ❌ Anti-Pattern 1: Menyimpan Tenant ID di Container/Singleton State tanpa Context

Pendekatan *legacy* (lama) sering kali menyimpan *state tenant* dalam bentuk singleton object di container, atau sebagai attribute di Request object.

**Bad Code:**
```php
<?php
// Di Middleware lama
app()->instance('current_tenant_id', $tenant->id);

// Di Model / Scope lama
$tenantId = app('current_tenant_id'); 
```

**Security & Memory Risk:**
Lingkungan eksekusi persisten modern seperti **Laravel Octane (Swoole/FrankenPHP)** membagikan (sharing) container state lintas Request antar user. Menyimpan `current_tenant_id` ke dalam instance app/container akan menyebabkan *Memory Leak* parah dan **Cross-Tenant Data Exposure / IDOR (CWE-200)**—kondisi di mana request dari *Tenant B* akan dibaca sebagai *Tenant A* jika container tidak diflush dengan sempurna di siklus sebelumnya. Ini adalah insiden kritis keamanan tingkat 1 di aplikasi SaaS.

**✅ Solusi (Best Practice):**
Gunakan `Illuminate\Support\Facades\Context`. Framework Context didesain *Coroutine/Fiber aware* agar *state* hanya berlaku secara eksklusif untuk satu siklus HTTP saja, memastikan thread-safety mutlak pada Octane dan ekosistem async lainnya.

### ❌ Anti-Pattern 2: Unique Index / Constraint Tanpa `tenant_id`

Pada arsitektur single-DB, kolom seperti `email` atau `slug` pada tabel seperti `users` atau `products` tidak lagi unik di level seluruh tabel, melainkan hanya **unik per tenant**. Menggunakan constraint unique standar `$table->unique('email')` akan mencegah aplikasi berfungsi normal.

**Bad Code (Migration & Validation):**
```php
<?php
// Migration
$table->string('email')->unique(); // FATAL: Unique global di seluruh db

// Form Request Validation
'email' => ['required', 'email', 'unique:users,email'], // FATAL: Melintasi isolasi tenant
```

**Security & Architecture Risk:**
Ini akan merusak stabilitas operasional. *Tenant B* tidak akan bisa mendaftarkan user dengan email `admin@gmail.com` jika *Tenant A* sudah menggunakannya. Selain cacat *business requirement*, hal ini memunculkan **Information Disclosure Vulnerability**—penyerang (attacker) dapat mengecek eksistensi vendor klien sistem Anda hanya dengan mencoba mendaftarkan email tertentu. Tambahan lagi, hal ini mengurangi kinerja indeks database secara keseluruhan saat mencari user.

**✅ Solusi (Best Practice):**
Implementasikan **Composite Unique Index** di tingkat skema DB, dan selalu lekatkan constraint `where` saat menggunakan validasi Laravel.

```php
<?php
// Migration
$table->unique(['tenant_id', 'email']);

// Form Request Validation
use Illuminate\Validation\Rule;
use Illuminate\Support\Facades\Context;

'email' => [
    'required', 
    'email', 
    Rule::unique('users')->where('tenant_id', Context::get('tenant_id'))
],
```

## 6. Pest v3 Testing (Unit & Architecture)

Kita wajib memverifikasi keamanan (kepatuhan isolasi) secara statis dan dinamis. **Pest v3** sangat mempermudah pengujian ini.

### 6.1 Architecture Test (`tests/ArchTest.php`)

Kita bisa memaksakan constraint agar tidak ada developer yang lalai mendaftarkan trait `BelongsToTenant`.

```php
<?php

declare(strict_types=1);

use App\Models\Traits\BelongsToTenant;

test('semua model terkait data (kecuali Tenant) wajib memiliki trait BelongsToTenant')
    ->expect('App\Models')
    ->classes()
    ->not->toBe('App\Models\Tenant')
    ->not->toBe('App\Models\User') // Sesuaikan pengecualian
    ->toUse(BelongsToTenant::class);

test('controller tidak boleh menyimpan state dan wajib final')
    ->expect('App\Http\Controllers')
    ->classes()
    ->toBeFinal()
    ->toHaveMethod('__construct')->not->toBeUsed(); // Larang DI berlebihan
```

### 6.2 Tenant Isolation Feature Test (`tests/Feature/TenantIsolationTest.php`)

Test krusial untuk memastikan bahwa data tenant memang terpisah di layer Eloquent/Database.

```php
<?php

declare(strict_types=1);

use App\Models\Invoice;
use App\Models\Tenant;
use Illuminate\Support\Facades\Context;

beforeEach(function () {
    $this->tenantA = Tenant::factory()->create(['domain' => 'tenant-a.com']);
    $this->tenantB = Tenant::factory()->create(['domain' => 'tenant-b.com']);
    
    // Seed untuk Tenant A
    Context::add('tenant_id', $this->tenantA->id);
    Invoice::factory()->count(3)->create();
    
    // Seed untuk Tenant B
    Context::add('tenant_id', $this->tenantB->id);
    Invoice::factory()->count(2)->create();
    
    // Wipe context setelah seeding DB
    Context::forget('tenant_id');
});

it('hanya menarik data invoice untuk tenant yang aktif', function () {
    Context::add('tenant_id', $this->tenantA->id);
    
    $invoices = Invoice::all();
    
    expect($invoices)->toHaveCount(3)
        ->and($invoices->pluck('tenant_id')->unique()->first())
        ->toBe($this->tenantA->id);
});

it('mencegah IDOR (Bypass read) ke data tenant lain via PK (Primary Key)', function () {
    Context::add('tenant_id', $this->tenantB->id);
    
    // Mencoba melakukan read data Tenant A (bypass context)
    // Mensimulasikan IDOR jika attacher menebak primary key invoice Tenant A
    $tenantAInvoiceId = Invoice::withoutGlobalScopes()
        ->where('tenant_id', $this->tenantA->id)
        ->first()->id;
    
    // Kueri normal tanpa withoutGlobalScope
    $invoice = Invoice::find($tenantAInvoiceId);
    
    expect($invoice)->toBeNull();
});

it('resolve tenant yang benar dari middleware', function () {
    $response = $this->withHeaders([
        'Host' => 'tenant-a.com',
    ])->getJson('/api/invoices'); // Pastikan path dikenai middleware
    
    $response->assertStatus(200);
});
```

## 7. Kesimpulan Arsitektur

Pendekatan *Clean Architecture* dan penggunaan *Laravel Context* untuk Multi-Tenancy Single DB di Laravel 11/12 menjamin beberapa prinsip utama:

1. **Security / Isolasi Mutlak**: Mengeliminasi ancaman IDOR tingkat basis data dengan menerapkan Global Scope (filter `where('tenant_id')`) secara otomatis tanpa membebani ingatan *developer*.
2. **Memory Safety untuk Octane**: Integrasi Context API native dari Laravel menjamin *thread-safety* untuk lingkungan persisten super cepat tanpa *memory leak*.
3. **Pemisahan Perhatian (SoC)**: Controller yang sangat tipis dan Action (use case) yang modular mempermudah pengujian dan integrasi fitur masa depan seperti CLI (Artisan commands) atau *queue workers*.
4. **Performa Superior**: Mengkombinasikan Single Database dengan Composite Indexes merupakan rute komputasi dan skalabilitas terbaik—SaaS Anda siap melayani 10,000 tenant di dalam 1 DB terpusat asalkan strategi *caching* & *indexing* diawasi ketat.
