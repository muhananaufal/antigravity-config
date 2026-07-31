# Spatie Permission & Roles Mastery (Laravel 11/12)

Dalam ekosistem pengembangan aplikasi berbasis Laravel, package `spatie/laravel-permission` telah menjadi standar industri *de-facto* untuk mengelola peran (Roles) dan hak akses (Permissions). Mengimplementasikan package ini pada proyek skala *enterprise* memerlukan pendekatan struktural yang kuat untuk memastikan performa yang optimal, keamanan yang tidak tertembus (impenetrable), serta kemudahan dalam proses pemeliharaan seiring dengan berjalannya waktu. Dokumen ini menyajikan panduan mendalam *Top 1%* mengenai manajemen otorisasi tingkat lanjut dengan mengedepankan prinsip *Clean Architecture* dan *Domain-Driven Design* (DDD) adaptif, khusus dirancang untuk PHP 8.3/8.4 dan ekosistem Laravel 11/12.

---

## 1. Fondasi Domain Otorisasi (Security Domain)

Pada tingkat *enterprise*, otorisasi tidak boleh tersebar tanpa kendali di berbagai bagian sistem. Semua *Permissions* harus direpresentasikan secara eksplisit sebagai *Enum* (khususnya *Backed Enums* yang diperkenalkan pada PHP 8.1 dan ditingkatkan pada PHP 8.3), sehingga aplikasi tidak pernah bergantung pada *magic strings* yang rawan terhadap *typo* (salah ketik) dan sulit untuk di-*refactor*.

### 1.1 Definisi Permission Enum

```php
<?php

declare(strict_types=1);

namespace App\Domain\Security\Enums;

enum PermissionType: string
{
    case VIEW_USERS = 'view users';
    case CREATE_USERS = 'create users';
    case EDIT_USERS = 'edit users';
    case DELETE_USERS = 'delete users';
    
    case VIEW_ROLES = 'view roles';
    case MANAGE_ROLES = 'manage roles';
    
    case VIEW_REPORTS = 'view reports';
    case EXPORT_REPORTS = 'export reports';

    /**
     * Mengembalikan daftar semua permissions yang tersedia
     *
     * @return array<int, string>
     */
    public static function values(): array
    {
        return array_column(self::cases(), 'value');
    }
}
```

### 1.2 Definisi Role Enum

Sama halnya dengan *Permission*, *Roles* inti juga perlu didefinisikan sebagai *Enum* untuk mencegah penggunaan *string* yang berpotensi menyebabkan ketidakkonsistenan saat menjalankan operasi otorisasi.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Security\Enums;

enum RoleType: string
{
    case SUPER_ADMIN = 'super-admin';
    case MANAGER = 'manager';
    case EDITOR = 'editor';
    case VIEWER = 'viewer';
}
```

---

## 2. Arsitektur Data & Model

Spatie Laravel Permission menyediakan *Traits* dan implementasi *Model* bawaan. Namun, sangat disarankan untuk melakukan *extend* terhadap model standar yang mereka sediakan untuk menambahkan tipe-tipe spesifik (typing) maupun relasi tambahan yang relevan dengan kebutuhan bisnis.

### 2.1 Model Custom Role

```php
<?php

declare(strict_types=1);

namespace App\Domain\Security\Models;

use App\Domain\Security\Enums\RoleType;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Spatie\Permission\Models\Role as SpatieRole;

final class Role extends SpatieRole
{
    use HasFactory;

    /**
     * Atribut yang tidak boleh dilakukan mass-assignment.
     *
     * @var array<int, string>
     */
    protected $guarded = ['id'];
    
    /**
     * Konversi tipe data otomatis (Casting).
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'name' => RoleType::class,
            'created_at' => 'immutable_datetime',
            'updated_at' => 'immutable_datetime',
        ];
    }
}
```

### 2.2 Model User dengan Trait Spatie

```php
<?php

declare(strict_types=1);

namespace App\Domain\User\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Spatie\Permission\Traits\HasRoles;

final class User extends Authenticatable
{
    use HasFactory;
    use Notifiable;
    use HasRoles;

    /**
     * Atribut yang boleh diisi.
     *
     * @var array<int, string>
     */
    protected $fillable = [
        'name',
        'email',
        'password',
    ];

    /**
     * Atribut tersembunyi untuk array/JSON serialization.
     *
     * @var array<int, string>
     */
    protected $hidden = [
        'password',
        'remember_token',
    ];

    /**
     * Dapatkan format attributes yang dikonversi.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
        ];
    }
}
```

---

## 3. Clean Architecture Implementation

Pemrosesan penugasan peran (*role assignment*) dan hak akses (*permissions*) tidak boleh diletakkan langsung di dalam `Controller`. Hal ini melanggar *Single Responsibility Principle* (SRP) dan membuat kode menjadi sulit untuk diuji (*untestable*). Pendekatan yang benar adalah menggunakan pola `FormRequest -> Controller -> Action/Service -> Repository -> Model`.

### 3.1 Repository (Data Access Layer)

*Repository* bertugas menyembunyikan detail interaksi basis data. Spatie sudah memberikan interaksi model yang bagus, namun abstraksi di layer *Repository* memastikan kita dapat melakukan *caching* kustom atau melakukan *query* gabungan tanpa mengotori *Service/Action*.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Security\Repositories;

use App\Domain\User\Models\User;
use Spatie\Permission\Contracts\Role;
use Spatie\Permission\Models\Role as SpatieRole;

final readonly class RoleRepository
{
    /**
     * Temukan role berdasarkan nama.
     *
     * @param string $name
     * @return Role
     * @throws \Spatie\Permission\Exceptions\RoleDoesNotExist
     */
    public function findByName(string $name): Role
    {
        return SpatieRole::findByName($name);
    }
    
    /**
     * Dapatkan seluruh roles.
     *
     * @return \Illuminate\Database\Eloquent\Collection<int, \Spatie\Permission\Models\Role>
     */
    public function getAllRoles(): \Illuminate\Database\Eloquent\Collection
    {
        return SpatieRole::all();
    }
}
```

### 3.2 Action / Service Layer

*Action* kelas ini memegang kontrol bisnis logika terkait sinkronisasi (pemberian/pencabutan) *role* ke seorang *user*.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Security\Actions;

use App\Domain\User\Models\User;
use App\Domain\Security\Repositories\RoleRepository;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

final readonly class AssignRoleToUserAction
{
    public function __construct(
        private RoleRepository $roleRepository
    ) {}

    /**
     * Memberikan role(s) ke user secara sinkron.
     * Menggunakan transaksi basis data untuk memastikan atomic operation.
     *
     * @param User $user
     * @param array<int, string> $roles
     * @return void
     * @throws \Throwable
     */
    public function execute(User $user, array $roles): void
    {
        DB::beginTransaction();

        try {
            // Validasi: pastikan role memang eksis di database (via Spatie behavior)
            // Namun Spatie SyncRoles sudah meng-handle lemparan exception RoleDoesNotExist
            // Kita gunakan fitur bawaan namun dikemas dalam atomic transaction
            
            $user->syncRoles($roles);
            
            // Log aktivitas penting
            Log::info("Roles assigned to user", [
                'user_id' => $user->id,
                'assigned_roles' => $roles,
            ]);

            DB::commit();
        } catch (\Throwable $exception) {
            DB::rollBack();
            Log::error("Failed assigning roles to user", [
                'user_id' => $user->id,
                'roles' => $roles,
                'error' => $exception->getMessage()
            ]);
            throw $exception;
        }
    }
}
```

### 3.3 Form Request (Validation Layer)

Gunakan `FormRequest` untuk memvalidasi masukan secara mendalam sebelum menyentuh lapisan *Controller*. Validasi ini termasuk memeriksa keabsahan *role* berbasis tipe *Enum*.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Security;

use App\Domain\Security\Enums\RoleType;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

final class AssignRoleRequest extends FormRequest
{
    /**
     * Tentukan apakah pengguna diizinkan membuat permintaan ini.
     * 
     * @return bool
     */
    public function authorize(): bool
    {
        // Hanya SUPER_ADMIN yang boleh memberikan/mengubah role
        return $this->user()?->hasRole(RoleType::SUPER_ADMIN->value) ?? false;
    }

    /**
     * Aturan validasi.
     *
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'roles' => ['required', 'array', 'min:1'],
            'roles.*' => ['required', 'string', Rule::enum(RoleType::class)],
        ];
    }
}
```

### 3.4 Controller (Delivery / Transport Layer)

*Controller* harus dibiarkan seringan mungkin (*Thin Controller*). Ia hanya bertanggung jawab untuk menerima `Request`, mendelegasikannya ke `Action`, dan mengembalikan `Response` HTTP.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Security;

use App\Domain\Security\Actions\AssignRoleToUserAction;
use App\Domain\User\Models\User;
use App\Http\Requests\Security\AssignRoleRequest;
use Illuminate\Http\JsonResponse;
use Illuminate\Routing\Controller;
use Symfony\Component\HttpFoundation\Response;

final class AssignRoleController extends Controller
{
    public function __construct(
        private readonly AssignRoleToUserAction $assignRoleAction
    ) {}

    /**
     * Handle the incoming request.
     *
     * @param AssignRoleRequest $request
     * @param User $user
     * @return JsonResponse
     */
    public function __invoke(AssignRoleRequest $request, User $user): JsonResponse
    {
        /** @var array<int, string> $roles */
        $roles = $request->validated('roles');

        $this->assignRoleAction->execute($user, $roles);

        return response()->json([
            'message' => 'Roles successfully synchronized.',
            'data' => [
                'user_id' => $user->id,
                'current_roles' => $user->getRoleNames(),
            ]
        ], Response::HTTP_OK);
    }
}
```

---

## 4. Anti-Patterns & Security Risks

Kesalahan implementasi dalam manajemen otorisasi dapat berakibat fatal pada keamanan aplikasi dan mengganggu performa server. Berikut adalah analisis dari dua pasangan *Anti-Pattern* vs *Best Practice* paling kritikal:

### 4.1 Anti-Pattern 1: Hardcoded String untuk Otorisasi (The Magic String Problem)

Menuliskan nama otorisasi secara langsung dalam bentuk *string* keras (*hardcoded*) akan menimbulkan kerentanan terhadap kesalahan pengetikan dan merusak abstraksi aplikasi, terutama ketika nama otorisasi perlu diganti.

❌ **KODE SALAH (Berbahaya - Magic Strings)**

```php
<?php
// ... dalam Controller atau Blade
if ($user->can('ediit users')) { // Typo di 'edit' tidak terdeteksi oleh compiler/IDE!
    // Lakukan operasi edit
}

// Di tempat lain
if ($user->hasRole('admin')) { // Apa bedanya dengan 'super-admin' atau 'Admin'?
    // Lakukan sesuatu
}
```

**Penjelasan Resiko**:
Kesalahan pengetikan (typo) tidak akan mengeluarkan error di PHP, namun hanya menghasilkan `false`. Ini berpotensi membuat fitur terkunci secara misterius atau lebih buruk lagi: memberikan bypass jika nama yang diketik tidak terkelola. Tidak ada mekanisme *autocomplete* dari IDE.

✅ **KODE BENAR (Menggunakan Enum)**

```php
<?php
// ...
use App\Domain\Security\Enums\PermissionType;
use App\Domain\Security\Enums\RoleType;

// Aman, autocomplete aktif, dan typo mustahil karena IDE / Linter / PHPStan akan komplain
if ($user->can(PermissionType::EDIT_USERS->value)) {
    // Eksekusi operasi aman
}

// Penggunaan Gate di Boot ServiceProvider
use Illuminate\Support\Facades\Gate;

Gate::before(function (User $user, string $ability) {
    if ($user->hasRole(RoleType::SUPER_ADMIN->value)) {
        return true;
    }
});
```

### 4.2 Anti-Pattern 2: N+1 Query pada Daftar Pengguna + Otorisasi

Menampilkan daftar pengguna sekaligus mengecek *role/permission* dalam *loop* dapat menghancurkan database server (*N+1 Query Issue*).

❌ **KODE SALAH (Memory/Performance Risk - Lazy Loading dalam Loop)**

```php
<?php

// Di Controller:
$users = User::all();
return view('users.index', compact('users'));

// Di View (Blade) atau Resource Collection JSON:
foreach ($users as $user) {
    // 💥 N+1 Query meledak di sini:
    // Setiap pemanggilan hasRole() atau akses ->roles memicu SELECT baru
    if ($user->hasRole('manager')) {
        echo "Manager: " . $user->name;
    }
}
```

**Penjelasan Resiko**:
Untuk 1.000 pengguna, kode salah di atas akan mengeksekusi setidaknya `1 + 1000 = 1001` queries ke database. Akibatnya, koneksi DB *pool* habis, memori PHP meledak karena koleksi data lambat dimuat, menyebabkan *Denial of Service* (DoS) berbasis performa secara tidak sengaja.

✅ **KODE BENAR (Eager Loading menggunakan 'with')**

```php
<?php
// Controller / Repository Level
// Muat relasi roles secara Eager 
$users = User::with('roles')->paginate(50);

// Di layer presentasi/resource, relasi sudah diload di memory
foreach ($users as $user) {
    // ✅ Aman! Memori hanya dialokasikan untuk 50 user, dan query hanya ada 2 buah
    if ($user->hasRole(RoleType::MANAGER->value)) {
        echo "Manager: " . $user->name;
    }
}
```
*Tips Ekstra: Paket Spatie sudah me-load permissions dalam Cache secara default. Namun kita tetap wajib Eager Load relasi (misalnya `roles` dan `permissions`) jika merender list User berjumlah besar.*

---

## 5. Cache Strategy & Performance Tuning

Spatie Laravel Permission mem-bypass query *permissions* reguler berkat penerapan struktur *caching*. Akan tetapi pada konfigurasi tingkat lanjut (terutama bila menggunakan arsitektur *Multi-Tenant* atau skala horizontal), beberapa opsi *cache* wajib dioptimasi.

### Cache Key Prefix (Config)
Di dalam `config/permission.php`:

```php
<?php

return [
    // ...
    'cache' => [
        'expiration_time' => \DateInterval::createFromDateString('24 hours'),
        'key' => 'spatie.permission.cache', // Ubah jika ada multi-app di Redis yang sama
        'store' => 'redis', // Wajib gunakan driver memory cepat spt Redis/Memcached (Bukan file)
    ],
];
```

*Clear Cache Command in Deployment:*
Saat melakukan *deployment* (CI/CD) yang mengubah daftar *role/permissions*, pastikan command ini dipanggil sebelum memproses *queue*:
```bash
php artisan permission:cache-reset
```

---

## 6. Architecture & Unit Testing (Pest v3)

Otorisasi adalah lapisan krusial (*security perimeter*). Tanpa implementasi pengujian yang ketat, celah keamanan akan terbuka lebar saat terjadi evolusi aplikasi. Kita akan memakai kerangka pengujian *Pest v3* dengan pendekatan deklaratif.

### 6.1 Architecture Testing (Arch Tests)

Memastikan tidak ada bagian kode terlarang yang melanggar arsitektur.
Lokasi: `tests/Arch/SecurityArchTest.php`

```php
<?php

declare(strict_types=1);

arch('security enums must be backed enums')
    ->expect('App\Domain\Security\Enums')
    ->toBeEnums()
    ->toBeBackedEnums();

arch('security actions must be final')
    ->expect('App\Domain\Security\Actions')
    ->toBeClasses()
    ->toBeFinal()
    ->toHaveMethod('execute');

arch('controllers must not interact directly with models')
    ->expect('App\Http\Controllers')
    ->not->toUse('App\Domain\User\Models'); // Boleh dihapus bila controller boleh menggunakan type-hint model binding, tapi hindari logic langsung di dalam
```

### 6.2 Unit Testing Action (Service Layer)

Lokasi: `tests/Unit/Domain/Security/Actions/AssignRoleToUserActionTest.php`

```php
<?php

declare(strict_types=1);

use App\Domain\Security\Actions\AssignRoleToUserAction;
use App\Domain\Security\Enums\RoleType;
use App\Domain\Security\Repositories\RoleRepository;
use App\Domain\User\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

uses(Tests\TestCase::class);

it('assigns roles to user safely within a transaction', function () {
    // 1. Arrange
    Log::spy();
    
    $userMock = Mockery::mock(User::class);
    $userMock->shouldReceive('getAttribute')->with('id')->andReturn(123);
    $userMock->shouldReceive('syncRoles')
             ->once()
             ->with([RoleType::EDITOR->value]);

    $repository = Mockery::mock(RoleRepository::class);
    
    $action = new AssignRoleToUserAction($repository);

    // 2. Act
    $action->execute($userMock, [RoleType::EDITOR->value]);

    // 3. Assert
    Log::shouldHaveReceived('info')->once();
    // Jika kita menggunakan Mockery secara intens pada transaksi DB, test ini perlu dipastikan isolation level-nya
});
```

### 6.3 Feature Testing Controller (Integration)

Lokasi: `tests/Feature/Http/Controllers/Security/AssignRoleControllerTest.php`

```php
<?php

declare(strict_types=1);

use App\Domain\Security\Enums\RoleType;
use App\Domain\User\Models\User;
use Spatie\Permission\Models\Role;
use Symfony\Component\HttpFoundation\Response;

uses(Tests\TestCase::class)->in('Feature');
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    // Siapkan role di database test
    Role::create(['name' => RoleType::SUPER_ADMIN->value]);
    Role::create(['name' => RoleType::EDITOR->value]);
});

it('prevents non super-admin from assigning roles', function () {
    /** @var User $unauthorizedUser */
    $unauthorizedUser = User::factory()->create();
    
    /** @var User $targetUser */
    $targetUser = User::factory()->create();

    $this->actingAs($unauthorizedUser)
         ->postJson("/api/users/{$targetUser->id}/roles", [
             'roles' => [RoleType::EDITOR->value]
         ])
         ->assertStatus(Response::HTTP_FORBIDDEN);
});

it('allows super-admin to assign roles successfully', function () {
    /** @var User $superAdmin */
    $superAdmin = User::factory()->create();
    $superAdmin->assignRole(RoleType::SUPER_ADMIN->value);
    
    /** @var User $targetUser */
    $targetUser = User::factory()->create();

    $response = $this->actingAs($superAdmin)
         ->postJson("/api/users/{$targetUser->id}/roles", [
             'roles' => [RoleType::EDITOR->value]
         ]);

    $response->assertStatus(Response::HTTP_OK)
             ->assertJsonPath('data.current_roles.0', RoleType::EDITOR->value);
             
    expect($targetUser->fresh()->hasRole(RoleType::EDITOR->value))->toBeTrue();
});
```

## Kesimpulan

Penerapan *Spatie Laravel Permission* tidak semestinya berhenti pada pengaturan dasar dari dokumentasinya. Mengangkat penggunaannya ke kelas *enterprise/Top 1%* berarti menyertakan tingkat ketat dengan mengisolasi tipe *Roles/Permissions* dalam bentuk tipe *BackedEnum*, menata validasi dengan *FormRequest*, mengenkapsulasi *logika update* dalam *Action class*, serta menerapkan sistem proteksi anti-regresi dengan *Pest v3 Arch dan Feature Tests*. Menerapkan disiplin ketat ini mencegah masalah pemeliharaan seiring kompleksitas proyek bertambah besar, serta menghindari eksploitasi otorisasi lintas-aktor dalam skala produksi.
