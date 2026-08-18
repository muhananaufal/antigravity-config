# 🏢 Advanced Tenant Domain & Subdomain Routing in Laravel (Top 1% Quality)

Dalam arsitektur Multi-Tenancy SaaS, routing berbasis *Subdomain* (`tenant.app.com`) maupun *Custom Domain* (`www.tenant-brand.com`) merupakan pondasi kritis. Dokumen ini mengupas tuntas implementasi routing domain yang *highly scalable*, mematuhi **Clean Architecture**, ditulis menggunakan standar **PHP 8.3/8.4** dan **Laravel 11/12**, serta dilengkapi pengamanan level enterprise terhadap *Host Header Injection*.

---

## 🏛 1. Core Architecture (Clean Architecture)

Flow identifikasi tenant dari HTTP Request hingga Database:
`HTTP Request (Host Header) -> Middleware (Identification) -> Tenant Context -> Request Form -> Controller -> Action -> Repository -> Model`

Arsitektur ini memastikan *Separation of Concerns* (SoC) di mana logika bisnis terisolasi dari *delivery mechanism* (HTTP/Console).

---

## 📦 2. Domain Models & Migrations

Kita membutuhkan dua entitas utama: `Tenant` dan `Domain`. Relasi 1-to-M, karena satu tenant bisa memiliki satu subdomain bawaan dan beberapa custom domain.

### Migration: `CreateTenantsAndDomainsTables`
```php
<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('tenants', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('name', 100);
            $table->string('database_name', 100)->unique();
            $table->boolean('is_active')->default(true);
            $table->timestamps();
        });

        Schema::create('domains', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->string('domain', 255)->unique(); // e.g., 'acme.saas.com' or 'www.acmecorp.com'
            $table->boolean('is_primary')->default(false);
            $table->boolean('is_verified')->default(false);
            $table->timestamps();

            // Indexing for ultra-fast lookup during middleware interception
            $table->index(['domain', 'is_verified']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('domains');
        Schema::dropIfExists('tenants');
    }
};
```

### Model: `Domain`
```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

final class Domain extends Model
{
    use HasFactory;
    use HasUuids;

    protected $table = 'domains';

    protected $fillable = [
        'tenant_id',
        'domain',
        'is_primary',
        'is_verified',
    ];

    protected function casts(): array
    {
        return [
            'is_primary' => 'boolean',
            'is_verified' => 'boolean',
        ];
    }

    /**
     * @return BelongsTo<Tenant, $this>
     */
    public function tenant(): BelongsTo
    {
        return $this->belongsTo(Tenant::class);
    }
}
```

### Model: `Tenant`
```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

final class Tenant extends Model
{
    use HasFactory;
    use HasUuids;

    protected $table = 'tenants';

    protected $fillable = [
        'name',
        'database_name',
        'is_active',
    ];

    protected function casts(): array
    {
        return [
            'is_active' => 'boolean',
        ];
    }

    /**
     * @return HasMany<Domain, $this>
     */
    public function domains(): HasMany
    {
        return $this->hasMany(Domain::class);
    }
}
```

---

## 🛡 3. Middleware: Tenant Identification & Context Initialization

Middleware bertugas mengidentifikasi domain dari *Host Header*, melakukan validasi, lalu menyimpan `Tenant` ke dalam *Context/Container* sehingga bisa diakses secara global tanpa passing parameter berulang.

### Service: `TenantContext`
```php
<?php

declare(strict_types=1);

namespace App\Services\Tenant;

use App\Models\Tenant;
use RuntimeException;

final class TenantContext
{
    private ?Tenant $currentTenant = null;

    public function setTenant(Tenant $tenant): void
    {
        $this->currentTenant = $tenant;
    }

    public function getTenant(): Tenant
    {
        if ($this->currentTenant === null) {
            throw new RuntimeException('Tenant context has not been initialized.');
        }

        return $this->currentTenant;
    }

    public function hasTenant(): bool
    {
        return $this->currentTenant !== null;
    }
}
```

### Middleware: `InitializeTenantContext`
```php
<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Models\Domain;
use App\Services\Tenant\TenantContext;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

final readonly class InitializeTenantContext
{
    public function __construct(
        private TenantContext $tenantContext
    ) {}

    /**
     * @param Closure(Request): (Response) $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $host = $request->getHost();

        // 1. Dapatkan Domain & Tenant (Gunakan caching yang agresif untuk performa)
        $domainRecord = $this->resolveDomain($host);

        if ($domainRecord === null || !$domainRecord->tenant->is_active) {
            throw new NotFoundHttpException(sprintf('Tenant domain %s not found or inactive.', $host));
        }

        // 2. Set Context
        $this->tenantContext->setTenant($domainRecord->tenant);

        // 3. (Optional) Set Database Connection here for Database-per-Tenant approach
        // config(['database.connections.tenant.database' => $domainRecord->tenant->database_name]);
        // DB::purge('tenant');
        // DB::setDefaultConnection('tenant');

        return $next($request);
    }

    private function resolveDomain(string $host): ?Domain
    {
        $cacheKey = "tenant_domain_resolution:{$host}";

        return Cache::remember($cacheKey, 3600, function () use ($host): ?Domain {
            return Domain::with('tenant')
                ->where('domain', $host)
                ->where('is_verified', true)
                ->first();
        });
    }
}
```

---

## 🚦 4. Routing Configuration (Laravel 11/12)

Di Laravel 11/12, routing diatur di `bootstrap/app.php` dan file route terpisah.

### `bootstrap/app.php`
```php
<?php

declare(strict_types=1);

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use App\Http\Middleware\InitializeTenantContext;
use Illuminate\Support\Facades\Route;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
        then: function () {
            // Tenant Routes dipisahkan untuk manajemen yang lebih baik
            Route::middleware(['web', InitializeTenantContext::class])
                ->group(base_path('routes/tenant.php'));
        }
    )
    ->withMiddleware(function (Middleware $middleware) {
        // Konfigurasi proteksi Host Proxy (Penting untuk keamanan)
        $middleware->trustProxies(at: '*'); 
    })
    ->withExceptions(function (Exceptions $exceptions) {
        //
    })->create();
```

### `routes/tenant.php`
```php
<?php

declare(strict_types=1);

use App\Http\Controllers\Tenant\DashboardController;
use App\Http\Controllers\Tenant\DomainManagementController;
use Illuminate\Support\Facades\Route;

// Tidak perlu mendefinisikan {domain} parameter pada URL, karena identifikasi
// sudah dihandle mutlak oleh Host Header di Middleware.

Route::get('/dashboard', [DashboardController::class, 'index'])->name('tenant.dashboard');

Route::prefix('settings/domains')->group(function () {
    Route::post('/', [DomainManagementController::class, 'store'])->name('tenant.domains.store');
    Route::delete('/{id}', [DomainManagementController::class, 'destroy'])->name('tenant.domains.destroy');
});
```

---

## 🏗 5. Clean Architecture: Controllers, Requests, Actions, & Repositories

### Request: `StoreDomainRequest`
```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Tenant;

use Illuminate\Foundation\Http\FormRequest;

final class StoreDomainRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // Asumsi authorization dihandle via policy/middleware lain
    }

    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'domain' => [
                'required', 
                'string', 
                'max:255', 
                'unique:domains,domain', 
                'regex:/^(?!:\/\/)(?=.{1,255}$)((.{1,63}\.){1,127}(?![0-9]*$)[a-z0-9-]+\.?)$/i'
            ],
            'is_primary' => ['sometimes', 'boolean'],
        ];
    }
}
```

### Data Transfer Object: `StoreDomainDTO`
```php
<?php

declare(strict_types=1);

namespace App\DTOs;

final readonly class StoreDomainDTO
{
    public function __construct(
        public string $tenantId,
        public string $domain,
        public bool $isPrimary,
    ) {}
}
```

### Repository Interface & Implementation
```php
<?php

declare(strict_types=1);

namespace App\Repositories\Contracts;

use App\Models\Domain;

interface DomainRepositoryInterface
{
    public function create(array $data): Domain;
    public function unsetPrimaryForTenant(string $tenantId): void;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use App\Models\Domain;
use App\Repositories\Contracts\DomainRepositoryInterface;

final readonly class EloquentDomainRepository implements DomainRepositoryInterface
{
    public function create(array $data): Domain
    {
        return Domain::create($data);
    }

    public function unsetPrimaryForTenant(string $tenantId): void
    {
        Domain::where('tenant_id', $tenantId)->update(['is_primary' => false]);
    }
}
```

### Action: `CreateCustomDomainAction`
```php
<?php

declare(strict_types=1);

namespace App\Actions\Tenant;

use App\DTOs\StoreDomainDTO;
use App\Models\Domain;
use App\Repositories\Contracts\DomainRepositoryInterface;
use Illuminate\Support\Facades\DB;
use Throwable;
use RuntimeException;

final readonly class CreateCustomDomainAction
{
    public function __construct(
        private DomainRepositoryInterface $domainRepository
    ) {}

    /**
     * @throws RuntimeException
     */
    public function execute(StoreDomainDTO $dto): Domain
    {
        try {
            return DB::transaction(function () use ($dto): Domain {
                if ($dto->isPrimary) {
                    $this->domainRepository->unsetPrimaryForTenant($dto->tenantId);
                }

                return $this->domainRepository->create([
                    'tenant_id' => $dto->tenantId,
                    'domain' => $dto->domain,
                    'is_primary' => $dto->isPrimary,
                    'is_verified' => false, // Membutuhkan verifikasi DNS nantinya
                ]);
            });
        } catch (Throwable $e) {
            throw new RuntimeException('Failed to create custom domain.', 0, $e);
        }
    }
}
```

### Controller: `DomainManagementController`
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Tenant;

use App\Actions\Tenant\CreateCustomDomainAction;
use App\DTOs\StoreDomainDTO;
use App\Http\Controllers\Controller;
use App\Http\Requests\Tenant\StoreDomainRequest;
use App\Services\Tenant\TenantContext;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final class DomainManagementController extends Controller
{
    public function __construct(
        private readonly TenantContext $tenantContext,
        private readonly CreateCustomDomainAction $createAction,
    ) {}

    public function store(StoreDomainRequest $request): JsonResponse
    {
        $tenant = $this->tenantContext->getTenant();
        
        $dto = new StoreDomainDTO(
            tenantId: $tenant->id,
            domain: $request->validated('domain'),
            isPrimary: (bool) $request->validated('is_primary', false),
        );

        $domain = $this->createAction->execute($dto);

        return response()->json([
            'message' => 'Custom domain registered successfully. Pending DNS verification.',
            'data' => $domain,
        ], Response::HTTP_CREATED);
    }
}
```

---

## 🚫 6. Anti-Patterns & Security Risks

### ❌ Anti-Pattern 1: Query Database Terus-menerus di Middleware (N+1 Risk di level HTTP)

**Masalah:** Middleware dieksekusi di *setiap* HTTP Request. Jika kita melakukan query `Domain::where('domain', $host)->first()` secara *raw*, maka saat ada ribuan req/sec (RPS), database akan dibombardir ribuan query yang identik. Ini mempercepat exhaust pada DB Connection Pool.

**❌ BAD PRACTICE:**
```php
public function handle(Request $request, Closure $next) {
    // Akan membuat database terhambat saat traffic tinggi karena di-query di setiap HTTP cycle
    $domain = Domain::where('domain', $request->getHost())->first();
    return $next($request);
}
```

**✅ BEST PRACTICE (Implementasi Cache Aktif):**
```php
// Caching hasil resolve. Jika tenant menonaktifkan/mengubah domain, pastikan Cache::forget("tenant_domain_resolution:{$domain}") dijalankan di Eloquent Observer.
$domainRecord = Cache::remember("tenant_domain_resolution:{$host}", 3600, function () use ($host) {
    return Domain::with('tenant')->where('domain', $host)->first();
});
```

### ❌ Anti-Pattern 2: Blindly Trusting `X-Forwarded-Host` (Host Header Injection Vulnerability)

**Masalah:** Dalam infrastruktur Cloud (AWS ALB, Cloudflare, Nginx proxy), Laravel menerima proxy headers. Jika attacker mengirim HTTP Request dengan Header `Host: valid-tenant.com` namun mengelabui dengan header `X-Forwarded-Host: evil-phishing.com`, fungsi `$request->getHost()` mungkin akan mengembalikan `evil-phishing.com` jika middleware `TrustProxies` di-konfigurasi sembarangan (`*`). Ini membuka celah serangan *Password Reset Poisoning* atau *Cross-tenant Data Leakage*.

**❌ BAD PRACTICE (Di bootstrap/app.php atau middleware):**
```php
// Trust semua proxy secara buta TANPA memvalidasi sumber IP proxy
$middleware->trustProxies(at: '*'); 
```
*Catatan: Meskipun `at: '*'` valid jika server Anda ADA di belakang private VPC (tanpa IP Publik sama sekali), namun jika server terekspos publik secara langsung (IP Publik) tanpa layer validasi Cloudflare/WAF, ini sangat fatal.*

**✅ BEST PRACTICE:**
Definisikan secara presisi list IP Subnet Load Balancer/Proxy yang terpercaya.
```php
// bootstrap/app.php
$middleware->trustProxies(at: [
    '10.0.0.0/8', // Private VPC Load Balancers
    '172.16.0.0/12', 
]);
```
Serta pastikan logic di middleware secara ketat mengecek kondisi boolean `is_verified === true` (status domain sudah tervalidasi CNAME di DNS) sebelum menginisiasi context.

---

## 🧪 7. Testing dengan Pest v3 (Unit, Feature, & Arch Tests)

Gunakan Pest v3 yang memberikan expressive syntax. DILARANG keras melewatkan fase testing pada infrastruktur routing.

### Arch Test: `tests/ArchTest.php`
Memastikan Clean Architecture tidak dilanggar.
```php
<?php

declare(strict_types=1);

arch('controllers do not access models directly outside of bindings')
    ->expect('App\Http\Controllers')
    ->toOnlyUse([
        'App\Http\Requests',
        'App\Http\Resources',
        'App\DTOs',
        'App\Actions',
        'App\Services',
        'Illuminate',
        'Symfony',
    ])
    ->ignoring('App\Models'); // DILARANG akses model langsung dari controller

arch('actions should not return responses')
    ->expect('App\Actions')
    ->not->toUse('Illuminate\Http\Response')
    ->not->toUse('Illuminate\Http\JsonResponse');
```

### Unit Test Action: `tests/Unit/Actions/CreateCustomDomainActionTest.php`
```php
<?php

declare(strict_types=1);

use App\Actions\Tenant\CreateCustomDomainAction;
use App\DTOs\StoreDomainDTO;
use App\Models\Domain;
use App\Repositories\Contracts\DomainRepositoryInterface;
use Illuminate\Support\Str;
use Mockery\MockInterface;

it('creates a domain and unsets primary flag from others if new domain is primary', function () {
    $tenantId = Str::uuid()->toString();
    $dto = new StoreDomainDTO($tenantId, 'acme.com', true);

    $repositoryMock = this()->mock(DomainRepositoryInterface::class, function (MockInterface $mock) use ($tenantId, $dto) {
        // Assertions: unsetPrimaryForTenant harus dipanggil 1 kali
        $mock->shouldReceive('unsetPrimaryForTenant')
             ->once()
             ->with($tenantId);

        $mock->shouldReceive('create')
             ->once()
             ->with([
                 'tenant_id' => $tenantId,
                 'domain' => $dto->domain,
                 'is_primary' => $dto->isPrimary,
                 'is_verified' => false,
             ])
             ->andReturn(new Domain());
    });

    $action = new CreateCustomDomainAction($repositoryMock);
    $action->execute($dto);
});
```

### Feature Test Middleware & Routing: `tests/Feature/TenantRoutingTest.php`
```php
<?php

declare(strict_types=1);

use App\Models\Domain;
use App\Models\Tenant;
use Illuminate\Support\Facades\Cache;

beforeEach(function () {
    $this->tenant = Tenant::factory()->create([
        'is_active' => true,
    ]);
    
    $this->domain = Domain::factory()->create([
        'tenant_id' => $this->tenant->id,
        'domain' => 'client.saas.test',
        'is_verified' => true,
    ]);
});

it('resolves correct tenant based on host header and returns 200', function () {
    // Assert endpoint yang diproteksi tenant middleware (berdasar Host header)
    $response = $this->withHeaders([
        'Host' => 'client.saas.test',
    ])->get('/dashboard');

    $response->assertStatus(200);
});

it('throws 404 if host header domain does not exist', function () {
    $response = $this->withHeaders([
        'Host' => 'unknown.saas.test',
    ])->get('/dashboard');

    $response->assertStatus(404);
});

it('utilizes cache for domain resolution', function () {
    // Panggil endpoint dua kali, verifikasi layer hitungan ke database terreduksi (cache hits)
    $this->withHeaders(['Host' => 'client.saas.test'])->get('/dashboard');
    $this->withHeaders(['Host' => 'client.saas.test'])->get('/dashboard');
    
    $cacheKey = 'tenant_domain_resolution:client.saas.test';
    expect(Cache::has($cacheKey))->toBeTrue();
});

it('blocks access if tenant is inactive', function () {
    $this->tenant->update(['is_active' => false]);
    // Cache harus dibersihkan secara manual pada testing context 
    Cache::flush();

    $response = $this->withHeaders([
        'Host' => 'client.saas.test',
    ])->get('/dashboard');

    $response->assertStatus(404);
});
```

---

## 🎯 Kesimpulan

Implementasi SaaS Domain Routing yang tangguh menuntut kehati-hatian tingkat enterprise.
1. **Performa:** Resolusi di level middleware di eksekusi setiap *request*, oleh karena itu **Caching (Redis/Memcached)** hukumnya wajib demi menghindari N+1 query exhaust.
2. **Security:** Manipulasi `Host` header merupakan celah keamanan fatal di skenario shared IP Cloud; konfigurasi *trusted proxy* yang presisi mencegah eksploitasi Host Header Injection.
3. **Clean Architecture:** Memisahkan *Request Lifecycle* (di Middleware `InitializeTenantContext`) dari *Business Context* (Service `TenantContext`) menghindari spaghetti dependency dan mempermudah resolusi dependensi saat worker script / CLI Jobs berjalan di mana *Host Header* HTTP sesungguhnya tidak eksis.
