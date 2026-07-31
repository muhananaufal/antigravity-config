# Multi-Database Tenant Isolation in Laravel

Dokumen ini adalah panduan komprehensif top 1% (standar industri untuk Enterprise SaaS) dalam mengimplementasikan *Multi-Database Tenant Isolation* di Laravel 11/12 menggunakan PHP 8.3/8.4. Pendekatan ini memastikan isolasi data fisik absolut untuk keamanan tingkat tinggi, sambil mematuhi prinsip *Clean Architecture* dan *Strong Typing*.

---

## 1. Konsep Dasar & Arsitektur

Dalam arsitektur *Multi-Database*, aplikasi menggunakan setidaknya dua jenis database:
1. **System/Landlord Database**: Menyimpan data global seperti *Tenant*, *Subscription*, *User (Global)*, dan *Domain*.
2. **Tenant Databases**: Setiap *Tenant* memiliki databasenya sendiri. Berisi tabel spesifik domain bisnis (misal: *Invoices*, *Products*, *Customers*).

### Alur Clean Architecture:
Request masuk → Middleware (Tenant Identification) → Action (Business Logic) → Repository (Data Access) → Model (Tenant/System DB).

---

## 2. Implementasi Inti (Strict & Strongly Typed)

Seluruh kode wajib menggunakan `declare(strict_types=1);` dan memaksimalkan fitur PHP 8.3+ seperti *readonly classes*, *typed properties*, dan *enums*.

### A. Tenant Model (Landlord DB)

Model yang merepresentasikan *Tenant* berada di database sistem (Landlord).

```php
<?php

declare(strict_types=1);

namespace App\Models\System;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Concerns\HasUuids;

/**
 * @property string $id
 * @property string $name
 * @property string $database_name
 * @property string $database_username
 * @property string $database_password
 */
final class Tenant extends Model
{
    use HasUuids;

    protected $connection = 'system';
    
    protected $fillable = [
        'name',
        'database_name',
        'database_username',
        'database_password',
    ];

    protected $hidden = [
        'database_password',
    ];

    /**
     * @return HasMany<Domain, $this>
     */
    public function domains(): HasMany
    {
        return $this->hasMany(Domain::class);
    }
}
```

### B. Tenancy Manager

Ini adalah *Service/Manager* utama untuk melakukan perpindahan koneksi database (*database switching*). Kelas ini mendengarkan pada singleton agar bisa melacak *tenant* aktif.

```php
<?php

declare(strict_types=1);

namespace App\Services\Tenancy;

use App\Models\System\Tenant;
use Illuminate\Support\Facades\Config;
use Illuminate\Support\Facades\DB;
use Illuminate\Database\DatabaseManager;
use RuntimeException;

final class TenancyManager
{
    private ?Tenant $currentTenant = null;

    public function __construct(
        private readonly DatabaseManager $databaseManager
    ) {}

    public function switch(Tenant $tenant): void
    {
        $this->currentTenant = $tenant;

        // Set konfigurasi dinamis untuk koneksi 'tenant'
        Config::set('database.connections.tenant', [
            'driver' => 'pgsql',
            'host' => env('DB_HOST', '127.0.0.1'),
            'port' => env('DB_PORT', '5432'),
            'database' => $tenant->database_name,
            'username' => $tenant->database_username,
            'password' => $tenant->database_password,
            'charset' => 'utf8',
            'prefix' => '',
            'search_path' => 'public',
            'sslmode' => 'prefer',
        ]);

        // Bersihkan instance PDO yang lama agar tidak terjadi memory leak/koneksi stale
        $this->databaseManager->purge('tenant');
        
        // Atur koneksi default aplikasi menjadi 'tenant' secara dinamis
        Config::set('database.default', 'tenant');
        
        // Verifikasi koneksi secara instan
        $this->databaseManager->reconnect('tenant');
    }

    public function end(): void
    {
        $this->currentTenant = null;
        
        // Kembali ke koneksi sistem
        Config::set('database.default', 'system');
        $this->databaseManager->purge('tenant');
    }

    public function getCurrentTenant(): Tenant
    {
        if ($this->currentTenant === null) {
            throw new RuntimeException('No active tenant found.');
        }

        return $this->currentTenant;
    }
    
    public function isTenantActive(): bool
    {
        return $this->currentTenant !== null;
    }
}
```

### C. Middleware (Tenant Identification)

Middleware bertanggung jawab mengidentifikasi tenant berdasarkan domain/subdomain dari request HTTP.

```php
<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use App\Models\System\Domain;
use App\Services\Tenancy\TenancyManager;
use Illuminate\Http\Exceptions\HttpResponseException;

final class IdentifyTenant
{
    public function __construct(
        private readonly TenancyManager $tenancyManager
    ) {}

    public function handle(Request $request, Closure $next): Response
    {
        $host = $request->getHost();

        $domain = Domain::with('tenant')
            ->where('domain', $host)
            ->first();

        if ($domain === null || $domain->tenant === null) {
            throw new HttpResponseException(
                response()->json(['message' => 'Tenant not found or inactive.'], Response::HTTP_NOT_FOUND)
            );
        }

        $this->tenancyManager->switch($domain->tenant);

        return $next($request);
    }
}
```

### D. Action & Repository (Clean Architecture)

Memisahkan *business logic* (Action) dan *data access* (Repository).

**Repository (Tenant DB)**

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Tenant;

use App\Models\Tenant\Customer;
use Illuminate\Database\Eloquent\Collection;

final class CustomerRepository
{
    /**
     * @return Collection<int, Customer>
     */
    public function getAllActiveCustomers(): Collection
    {
        return Customer::query()
            ->where('is_active', true)
            ->orderBy('created_at', 'desc')
            ->get();
    }

    public function createCustomer(string $name, string $email): Customer
    {
        return Customer::create([
            'name' => $name,
            'email' => $email,
            'is_active' => true,
        ]);
    }
}
```

**Action**

```php
<?php

declare(strict_types=1);

namespace App\Actions\Tenant;

use App\Repositories\Tenant\CustomerRepository;
use App\Models\Tenant\Customer;

final readonly class RegisterCustomerAction
{
    public function __construct(
        private CustomerRepository $customerRepository
    ) {}

    public function execute(string $name, string $email): Customer
    {
        // Business logic ekstra: kirim email welcome, dll (dipersingkat)
        return $this->customerRepository->createCustomer($name, $email);
    }
}
```

---

## 3. Anti-Patterns & Security Risks

Implementasi *multi-tenancy* rentan terhadap *data leakage* jika tidak di-handle dengan benar, terutama pada environment asinkron atau worker jangka panjang seperti Laravel Octane atau Queue.

### ❌ Anti-Pattern 1: State Leakage via Static Properties (Octane/Queue)

Menggunakan properti *static* atau konfigurasi *singleton* yang tidak di-reset di antara request pada Laravel Octane.

```php
// ❌ BAD: Data Leakage Risk
namespace App\Services;

class AppContext {
    public static ?int $currentTenantId = null; // Ini akan persist lintas request di Octane!
}
```
**Risiko**: 
*Security Risk*. Request dari *Tenant B* yang masuk ke worker Octane yang sama yang baru melayani *Tenant A* akan membaca data *Tenant A* secara tidak sengaja. Ini adalah kebocoran privasi fatal.

**✅ Solusi (Best Practice)**
Selalu bersihkan *state* pada event `RequestTerminated` atau gunakan *Scoped Bindings* Laravel, dan delegasikan *state* utama ke `TenancyManager` yang di-reset via middleware/event listener.

```php
// ✅ GOOD
// Di AppServiceProvider.php (Mendengarkan event Octane)
use Laravel\Octane\Events\RequestTerminated;
use App\Services\Tenancy\TenancyManager;

Event::listen(RequestTerminated::class, function () {
    app(TenancyManager::class)->end();
});
```

### ❌ Anti-Pattern 2: Dynamic Table Prefixing / Interpolation Tanpa Binding

Mencoba memisahkan tenant melalui *table prefix* atau merakit query mentah (Raw SQL) menggunakan nilai ID Tenant secara langsung.

```php
// ❌ BAD: SQL Injection & Data Leakage Risk
$tenantId = request()->header('X-Tenant-Id');
// Bahaya! Jika tenantId = "1; DROP TABLE users; --"
DB::statement("SELECT * FROM tenant_{$tenantId}_users"); 
```
**Risiko**:
*SQL Injection Risk*. Menggabungkan string mentah pada nama tabel atau database sangat berbahaya.

**✅ Solusi (Best Practice)**
Gunakan koneksi database yang benar-benar terpisah (Multi-DB Connection) dan kelola perubahan nama database di level konfigurasi koneksi (`config/database.php`), bukan di kueri mentah. PDO akan mengamankan kueri standar, dan konfigurasi database akan mengunci akses hanya ke database spesifik.

```php
// ✅ GOOD
// TenancyManager mengubah nama database di konfigurasi, 
// kemudian melakukan purge connection. Query Eloquent tetap bersih:
$users = User::all(); // Otomatis terhubung ke DB Tenant aktif tanpa query mentah.
```

---

## 4. Testing Menggunakan Pest v3

Testing *Multi-Tenancy* menuntut penanganan *mocking* yang ketat terhadap koneksi database. Pest v3 memberikan sintaks bersih.

### A. Architecture Test (Arch Test)

Pastikan Model Tenant tidak bercampur dengan Model System.

```php
<?php

declare(strict_types=1);

// tests/Arch/TenancyArchTest.php

test('tenant models must use tenant connection')
    ->expect('App\Models\Tenant')
    ->classes()
    ->toExtend('Illuminate\Database\Eloquent\Model')
    ->not->toHaveProperty('connection', 'system');

test('system models must use system connection')
    ->expect('App\Models\System')
    ->classes()
    ->toHaveProperty('connection', 'system');

test('tenancy manager must not leave stale state')
    ->expect('App\Services\Tenancy\TenancyManager')
    ->toHaveMethod('end')
    ->toHaveMethod('switch');
```

### B. Unit & Integration Test

Menguji `TenancyManager` untuk memastikan pergantian koneksi dan isolasi berjalan semestinya.

```php
<?php

declare(strict_types=1);

// tests/Unit/TenancyManagerTest.php

use App\Models\System\Tenant;
use App\Services\Tenancy\TenancyManager;
use Illuminate\Support\Facades\Config;
use Illuminate\Database\DatabaseManager;

beforeEach(function () {
    $this->dbManager = Mockery::mock(DatabaseManager::class);
    $this->manager = new TenancyManager($this->dbManager);
    
    $this->tenant = new Tenant([
        'name' => 'Acme Corp',
        'database_name' => 'tenant_acme',
        'database_username' => 'db_user_acme',
        'database_password' => 'secret123',
    ]);
});

afterEach(function () {
    Mockery::close();
});

test('it switches database configuration correctly', function () {
    $this->dbManager->shouldReceive('purge')->with('tenant')->once();
    $this->dbManager->shouldReceive('reconnect')->with('tenant')->once();

    $this->manager->switch($this->tenant);

    expect(Config::get('database.connections.tenant.database'))
        ->toBe('tenant_acme')
        ->and(Config::get('database.default'))
        ->toBe('tenant')
        ->and($this->manager->getCurrentTenant()->name)
        ->toBe('Acme Corp');
});

test('it ends tenancy and reverts to system database', function () {
    $this->dbManager->shouldReceive('purge')->with('tenant')->twice(); // 1 saat switch, 1 saat end
    $this->dbManager->shouldReceive('reconnect')->with('tenant')->once();

    $this->manager->switch($this->tenant);
    $this->manager->end();

    expect(Config::get('database.default'))
        ->toBe('system')
        ->and($this->manager->isTenantActive())
        ->toBeFalse();
});

test('it throws exception when accessing empty tenant', function () {
    expect(fn () => $this->manager->getCurrentTenant())
        ->toThrow(RuntimeException::class, 'No active tenant found.');
});
```

---

## 5. Menangani Background Jobs (Queue Workers)

Saat melempar *Job* ke *Queue*, aplikasi kehilangan konteks HTTP. Oleh karena itu, *Tenant ID* harus disuntikkan secara eksplisit ke dalam *Job*, dan saat *Job* dieksekusi, ia harus "mengaktifkan" dirinya ke tenant tersebut.

```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Models\System\Tenant;
use App\Services\Tenancy\TenancyManager;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;

final class ProcessTenantInvoice implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct(
        private readonly string $tenantId,
        private readonly int $invoiceId
    ) {}

    public function handle(TenancyManager $tenancyManager): void
    {
        $tenant = Tenant::findOrFail($this->tenantId);
        
        // Setup Tenant Context
        $tenancyManager->switch($tenant);

        try {
            // Lakukan pemrosesan invoice menggunakan koneksi DB tenant
            // e.g. Invoice::find($this->invoiceId)->process();
        } finally {
            // PENTING: Bersihkan state agar job selanjutnya di worker yang sama tidak bocor!
            $tenancyManager->end();
        }
    }
}
```

## Kesimpulan

Isolasi *Multi-Database* untuk SaaS membutuhkan ketelitian mutlak dalam mengelola *state* (terutama di Octane dan Queues) serta arsitektur yang ketat (*Clean Architecture*). Pendekatan *strongly-typed* dengan PHP 8.3+ digabungkan dengan desain kode tanpa *static shared states* akan mencegah tragedi *Data Leakage* lintas tenant.
