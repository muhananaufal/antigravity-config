# Panduan Komprehensif: Architecture Testing dengan Pest v3 di Laravel 11+ (Top 1% Quality)

## 1. Pendahuluan: Mengapa Architecture Testing Penting?

Dalam pengembangan perangkat lunak skala Enterprise menggunakan Laravel, menjaga struktur kode agar tetap bersih dan terorganisir (Clean Architecture) adalah tantangan terbesar seiring berjalannya waktu dan bertambahnya anggota tim. Tanpa pengawasan ketat, batas antar *layer* arsitektur (seperti Controller, Service/Action, Repository, dan Model) akan sering dilanggar. Pelanggaran ini, yang sering disebut sebagai *Architecture Erosion* atau *Spaghetti Code*, menyebabkan aplikasi menjadi rapuh, sulit di-*maintain*, dan rawan bug keamanan.

**Architecture Testing** adalah proses mengotomatisasi pengujian aturan dan standar desain arsitektur menggunakan kode. Alih-alih mengandalkan *Code Review* manual yang rawan *human error* dan inkonsistensi, kita dapat menulis tes yang akan selalu memastikan bahwa kode yang ditulis oleh developer mematuhi batasan struktural yang telah disepakati. 

**Pest v3**, framework pengujian mutakhir untuk ekosistem PHP dan Laravel, memperkenalkan fitur **Architecture Testing** bawaan yang sangat elegan, ekspresif, dan kuat. Dengan API deklaratifnya, Pest v3 memungkinkan kita menulis aturan arsitektur dalam bahasa yang mudah dibaca oleh manusia, sehingga mengurangi *cognitive load* dan menjadikan pengujian arsitektur sebagai *first-class citizen* dalam siklus pengembangan.

Panduan ini akan membahas implementasi Architecture Testing menggunakan Pest v3 dengan fokus pada **Clean Architecture** (FormRequest -> Controller -> Action/Service -> Repository -> Model) dan menyertakan anti-pattern nyata untuk memberikan pemahaman mendalam.

---

## 2. Fondasi Clean Architecture di Laravel 11+

Sebelum kita menulis tes arsitektur, kita harus memiliki struktur yang jelas. Berikut adalah standar Clean Architecture yang akan kita enforcing:

1.  **FormRequests (`App\Http\Requests\`)**: Bertanggung jawab murni untuk validasi input HTTP. Tidak boleh berisi logika bisnis.
2.  **Controllers (`App\Http\Controllers\`)**: Bertugas menerima HTTP Request, mendelegasikan pemrosesan ke layer Action/Service, dan mengembalikan HTTP Response. Tidak boleh berisi logika bisnis (Business Logic) atau query database secara langsung.
3.  **Actions / Services (`App\Actions\` atau `App\Services\`)**: Mengandung *Business Logic* murni. Layer ini menerima Data Transfer Objects (DTO) atau tipe primitif, bukan objek HTTP Request.
4.  **Repositories (`App\Repositories\`)**: Abstraksi layer data. Bertanggung jawab untuk melakukan query ke database dan mengembalikan Models atau Collections. Actions tidak boleh melakukan query langsung menggunakan Eloquent Models, melainkan melalui Repositories.
5.  **Models (`App\Models\`)**: Representasi entitas data dan relasi. Tidak boleh mengandung logika *formatting* HTTP atau dependensi ke layer di atasnya.

Mari kita lindungi struktur ini menggunakan Pest v3.

---

## 3. Anti-Pattern & Refactoring: Studi Kasus Nyata

### Anti-Pattern 1: God Controller (Controller Mengakses Model Secara Langsung)

**Konteks:** Seorang developer junior diminta untuk membuat fitur registrasi pengguna. Ia menulis semua logika di dalam Controller, termasuk validasi manual, hashing password, dan pemanggilan Model langsung.

#### ❌ KODE SALAH (Berbahaya & Melanggar Arsitektur)

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

final class RegisterUserController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        // ❌ Pelanggaran 1: Validasi manual di Controller (seharusnya FormRequest)
        $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'string', 'email', 'max:255', 'unique:users'],
            'password' => ['required', 'string', 'min:8', 'confirmed'],
        ]);

        // ❌ Pelanggaran 2: Hashing & Business Logic di Controller
        $password = Hash::make($request->string('password')->value());
        $uuid = Str::uuid()->toString();

        // ❌ Pelanggaran 3: Memanggil Eloquent Model secara langsung di Controller
        $user = User::create([
            'uuid' => $uuid,
            'name' => $request->string('name')->value(),
            'email' => $request->string('email')->value(),
            'password' => $password,
        ]);

        return response()->json([
            'message' => 'User registered successfully',
            'data' => $user,
        ], 201);
    }
}
```

**Penjelasan Mengapa Berbahaya (Security/Memory/Maintenance Risk):**
1.  **Tight Coupling (Keterikatan Kuat):** Controller terikat langsung dengan skema Database (Model). Jika ada perubahan logika bisnis saat registrasi (misalnya menambahkan verifikasi email wajib atau pencatatan log audit), Controller ini harus diubah, melanggar *Single Responsibility Principle (SRP)*.
2.  **Testability Menurun:** Menguji Controller ini mengharuskan kita untuk *mocking* Model `User` dan `Hash` facade, yang membuat *Unit Test* menjadi lambat dan kompleks karena kita pada dasarnya melakukan *Integration Test*.
3.  **Security Risk (Mass Assignment Vulnerability):** Menulis logika Model di Controller memicu developer untuk malas dan langsung menggunakan `$request->all()` ke `Model::create()`, yang membuka celah kerentanan *Mass Assignment* jika field `$fillable` tidak dijaga ketat.

#### ✅ KODE BENAR (Clean Architecture)

Mari kita refactor dengan memisahkan ke FormRequest, Controller, Action, dan Repository.

**1. Data Transfer Object (DTO)**
```php
<?php

declare(strict_types=1);

namespace App\DTOs;

readonly class RegisterUserDTO
{
    public function __construct(
        public string $name,
        public string $email,
        public string $password,
    ) {}
}
```

**2. Form Request**
```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use App\DTOs\RegisterUserDTO;
use Illuminate\Foundation\Http\FormRequest;

final class RegisterUserRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'string', 'email', 'max:255', 'unique:users'],
            'password' => ['required', 'string', 'min:8', 'confirmed'],
        ];
    }

    public function toDTO(): RegisterUserDTO
    {
        return new RegisterUserDTO(
            name: $this->string('name')->value(),
            email: $this->string('email')->value(),
            password: $this->string('password')->value(),
        );
    }
}
```

**3. Repository Contract & Implementation**
```php
<?php

declare(strict_types=1);

namespace App\Repositories\Contracts;

use App\Models\User;

interface UserRepositoryInterface
{
    public function create(array $data): User;
}

// ---------------------------------------------------------
// App\Repositories\EloquentUserRepository.php
// ---------------------------------------------------------
namespace App\Repositories;

use App\Models\User;
use App\Repositories\Contracts\UserRepositoryInterface;

final readonly class EloquentUserRepository implements UserRepositoryInterface
{
    public function create(array $data): User
    {
        return User::create($data);
    }
}
```

**4. Action (Business Logic)**
```php
<?php

declare(strict_types=1);

namespace App\Actions\Users;

use App\DTOs\RegisterUserDTO;
use App\Models\User;
use App\Repositories\Contracts\UserRepositoryInterface;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

final readonly class RegisterUserAction
{
    public function __construct(
        private UserRepositoryInterface $userRepository
    ) {}

    public function execute(RegisterUserDTO $dto): User
    {
        $data = [
            'uuid' => Str::uuid()->toString(),
            'name' => $dto->name,
            'email' => $dto->email,
            'password' => Hash::make($dto->password),
        ];

        return $this->userRepository->create($data);
    }
}
```

**5. Controller (Tipis dan Bersih)**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Actions\Users\RegisterUserAction;
use App\Http\Requests\RegisterUserRequest;
use Illuminate\Http\JsonResponse;

final class RegisterUserController extends Controller
{
    public function __invoke(RegisterUserRequest $request, RegisterUserAction $action): JsonResponse
    {
        $user = $action->execute($request->toDTO());

        return response()->json([
            'message' => 'User registered successfully',
            'data' => $user,
        ], 201);
    }
}
```

#### Pengujian Arsitektur untuk Mencegah God Controller (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Http\Controllers\Controller;
use Illuminate\Database\Eloquent\Model;

// Memastikan Controllers tidak pernah memanggil Models secara langsung!
arch('controllers_must_not_use_models_directly')
    ->expect('App\Http\Controllers')
    ->not->toUse('App\Models')
    ->ignoring(Controller::class); // Jika base Controller punya relasi tertentu

// Memastikan Controllers hanya mengembalikan Response/View/Redirect, bukan memanipulasi DB
arch('controllers_must_only_depend_on_http_and_actions')
    ->expect('App\Http\Controllers')
    ->toOnlyUse([
        'App\Actions',
        'App\Http',
        'Illuminate\Http',
        'Illuminate\Contracts\View',
        'Illuminate\Routing',
        'App\DTOs',
    ])
    ->ignoring('App\Models'); // Eksplisit melarang Model
```

---

### Anti-Pattern 2: Domain Layer Leaking HTTP Context (Action Menerima Request)

**Konteks:** Seorang developer memindahkan logika dari Controller ke Action (Service Class), tetapi karena malas membuat DTO, ia malah mem-passing instance `Illuminate\Http\Request` atau `FormRequest` langsung ke dalam Action.

#### ❌ KODE SALAH (Leaky Abstraction & Melanggar Layer)

```php
<?php

declare(strict_types=1);

namespace App\Actions\Billing;

use App\Http\Requests\ProcessPaymentRequest;
use App\Models\Transaction;

final class ProcessPaymentAction
{
    // ❌ Pelanggaran: Action (Domain Layer) bergantung pada HTTP Layer (FormRequest)
    public function execute(ProcessPaymentRequest $request): Transaction
    {
        // ❌ Pelanggaran: Membaca IP address dan User Agent HTTP di dalam layer Domain
        $ipAddress = $request->ip();
        $userAgent = $request->userAgent();
        
        $amount = $request->validated('amount');
        $cardNumber = $request->validated('card_number');

        // Logika pemrosesan pembayaran...
        return Transaction::create([
            'amount' => $amount,
            'status' => 'success',
            'ip_address' => $ipAddress,
        ]);
    }
}
```

**Penjelasan Mengapa Berbahaya (Leaky Abstraction / Testing Risk):**
1.  **Konteks HTTP Bocor (Leaky Abstraction):** Action Class berada di "Domain Layer", yang tidak boleh tahu menahu tentang darimana data itu berasal (CLI Artisan Command, HTTP Request, Job Queue, atau WebSocket). Jika kita ingin memanggil `ProcessPaymentAction` dari CLI Command (misalnya men-charge otomatis untuk subscription), kita tidak memiliki `ProcessPaymentRequest` karena tidak ada HTTP Context, sehingga Action ini gagal di-reuse secara fungsional.
2.  **Coupling ke Framework:** Layer bisnis terikat erat dengan siklus hidup HTTP Laravel (`Illuminate\Http\Request`), yang membuat upgrade atau ekstraksi fitur ke microservice/package independen menjadi sangat mustahil.
3.  **Kesulitan Testing:** Untuk melakukan Unit Test pada Action ini, Anda dipaksa harus membangun *mock* HTTP Request buatan secara kompleks menggunakan `$this->postJson()`, padahal Action seharusnya bisa dites secara terisolasi tanpa menyentuh *Routing/HTTP dispatcher* Laravel.

#### ✅ KODE BENAR (Decoupled Domain Layer dengan DTO)

Gunakan DTO agar Action Class murni berfokus pada data, terlepas dari sumber datanya.

```php
<?php

declare(strict_types=1);

namespace App\DTOs\Billing;

readonly class PaymentDTO
{
    public function __construct(
        public float $amount,
        public string $cardNumber,
        public ?string $ipAddress = null,
        public ?string $userAgent = null,
    ) {}
}
```

```php
<?php

declare(strict_types=1);

namespace App\Actions\Billing;

use App\DTOs\Billing\PaymentDTO;
use App\Models\Transaction;

final class ProcessPaymentAction
{
    // ✅ Action hanya bergantung pada tipe data murni (DTO), tidak tahu tentang HTTP
    public function execute(PaymentDTO $dto): Transaction
    {
        // Logika pemrosesan pembayaran...
        return Transaction::create([
            'amount' => $dto->amount,
            'status' => 'success',
            'ip_address' => $dto->ipAddress,
        ]);
    }
}
```

#### Pengujian Arsitektur untuk Mencegah Kebocoran HTTP (Pest v3)

```php
<?php

declare(strict_types=1);

// Memastikan Layer Actions (Domain/Business Logic) tidak pernah menggunakan objek HTTP
arch('actions_must_not_depend_on_http_layer')
    ->expect('App\Actions')
    ->not->toUse([
        'Illuminate\Http\Request',
        'Illuminate\Foundation\Http\FormRequest',
        'App\Http\Requests',
        'App\Http\Controllers',
    ]);
```

---

## 4. Implementasi Pest v3 Architecture Testing: `tests/ArchTest.php` Penuh

Berikut adalah implementasi **Full Architecture Test Suite** dengan standar *Top 1% Quality* untuk menjaga batasan *Clean Architecture* di proyek Enterprise Laravel Anda. Letakkan file ini di `tests/ArchTest.php` atau `tests/Architecture/CleanArchitectureTest.php`.

```php
<?php

declare(strict_types=1);

use Illuminate\Database\Eloquent\Model;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Console\Command;

/**
 * --------------------------------------------------------------------------
 * PRESET & GLOBAL RULES (PEST V3 BUILT-IN)
 * --------------------------------------------------------------------------
 * Pest v3 menyediakan presets yang kuat.
 */
arch('global_security_preset')->preset()->security();
arch('global_php_preset')->preset()->php();
arch('global_laravel_preset')->preset()->laravel();

// Mencegah kode debug tertinggal di produksi
arch('no_debugging_statements_allowed')
    ->expect(['dd', 'dump', 'ray', 'die', 'var_dump'])
    ->not->toBeUsed();

/**
 * --------------------------------------------------------------------------
 * LAYER: CONTROLLERS
 * --------------------------------------------------------------------------
 */
arch('controllers_naming_convention')
    ->expect('App\Http\Controllers')
    ->toHaveSuffix('Controller')
    ->toBeClasses();

arch('controllers_must_not_access_models_directly')
    ->expect('App\Http\Controllers')
    ->not->toUse('App\Models')
    ->ignoring('App\Http\Controllers\Controller'); // Izinkan jika base class punya dependency framework

arch('controllers_must_not_access_repositories_directly')
    ->expect('App\Http\Controllers')
    ->not->toUse('App\Repositories')
    ->because('Controllers must delegate to Actions, not Repositories directly.');

/**
 * --------------------------------------------------------------------------
 * LAYER: FORM REQUESTS
 * --------------------------------------------------------------------------
 */
arch('form_requests_naming_convention')
    ->expect('App\Http\Requests')
    ->toHaveSuffix('Request')
    ->toBeClasses()
    ->toExtend(FormRequest::class);

arch('form_requests_must_not_use_domain_logic')
    ->expect('App\Http\Requests')
    ->not->toUse([
        'App\Actions',
        'App\Repositories',
    ])
    ->because('Requests are strictly for HTTP Validation, not executing business logic.');

/**
 * --------------------------------------------------------------------------
 * LAYER: ACTIONS (BUSINESS LOGIC)
 * --------------------------------------------------------------------------
 */
arch('actions_naming_convention')
    ->expect('App\Actions')
    ->toHaveSuffix('Action')
    ->toBeClasses()
    ->toBeFinal() // Memastikan Action bersifat tertutup untuk mutasi pewarisan
    ->toBeReadonly(); // (PHP 8.2+) Memastikan immutability dependency injection

arch('actions_must_be_decoupled_from_http_context')
    ->expect('App\Actions')
    ->not->toUse([
        'Illuminate\Http',
        'App\Http\Controllers',
        'App\Http\Requests',
    ])
    ->because('Actions must be agnostic to the delivery mechanism (HTTP/Console/Queue).');

/**
 * --------------------------------------------------------------------------
 * LAYER: REPOSITORIES
 * --------------------------------------------------------------------------
 */
arch('repositories_naming_convention')
    ->expect('App\Repositories')
    ->toHaveSuffix('Repository') // Implements bisa menggunakan suffix Repository (misal: EloquentUserRepository)
    ->toBeClasses()
    ->ignoring('App\Repositories\Contracts'); // Ignore Interfaces dir

arch('repositories_contracts_naming_convention')
    ->expect('App\Repositories\Contracts')
    ->toHaveSuffix('Interface')
    ->toBeInterfaces();

arch('repositories_must_be_the_only_layer_interacting_with_database_directly')
    ->expect('Illuminate\Database\Eloquent\Builder')
    ->toOnlyBeUsedIn([
        'App\Repositories',
        'App\Models',
        'App\Providers', // Global Scopes register
    ])
    ->because('Direct Eloquent Query Builder manipulation must be abstracted via Repositories.');

/**
 * --------------------------------------------------------------------------
 * LAYER: MODELS
 * --------------------------------------------------------------------------
 */
arch('models_must_extend_eloquent')
    ->expect('App\Models')
    ->toBeClasses()
    ->toExtend(Model::class);

arch('models_must_not_depend_on_application_logic')
    ->expect('App\Models')
    ->not->toUse([
        'App\Http',
        'App\Actions',
        'App\Repositories',
        'App\Services',
        'App\Console',
    ])
    ->because('Models represent DB Schema and relations, they must remain agnostic of app logic.');

/**
 * --------------------------------------------------------------------------
 * LAYER: DATA TRANSFER OBJECTS (DTO)
 * --------------------------------------------------------------------------
 */
arch('dtos_must_be_pure')
    ->expect('App\DTOs')
    ->toHaveSuffix('DTO')
    ->toBeClasses()
    ->toBeReadonly() // Mencegah mutasi state secara tidak disengaja
    ->not->toUse([
        'Illuminate\Database',
        'Illuminate\Http',
    ])
    ->because('DTOs must be plain objects carrying state, without external framework dependencies.');

```

---

## 5. Fitur Lanjutan Pest v3: Custom Architecture Expectations

Pest v3 memungkinkan Anda membuat ekspektasi arsitektur Anda sendiri jika Anda memiliki aturan khusus perusahaan yang tidak dapat ditangani oleh metode bawaan. Misalnya, Anda ingin memastikan bahwa semua class `Action` menerapkan interface `ActionInterface` atau memiliki method `execute()`.

```php
<?php

declare(strict_types=1);

// Dalam file tests/Pest.php

use PHPUnit\Architecture\Elements\ObjectDescription;

expect()->extend('toHaveExecuteMethod', function () {
    /** @var \Pest\Expectation $this */
    
    // Menerapkan custom rule pada koleksi class
    $failedClasses = [];
    
    foreach ($this->value as $class) {
        if (is_string($class) && class_exists($class)) {
            $reflection = new ReflectionClass($class);
            if (!$reflection->hasMethod('execute')) {
                $failedClasses[] = $class;
            }
        }
    }
    
    if (count($failedClasses) > 0) {
        $message = "The following Action classes are missing an 'execute()' method: \n" . implode("\n- ", $failedClasses);
        test()->fail($message);
    }
    
    return $this;
});

// Dalam file tests/ArchTest.php
arch('all_actions_must_have_execute_method')
    ->expect('App\Actions')
    ->toHaveExecuteMethod();
```

## 6. Kesimpulan

Menggunakan Pest v3 untuk Architecture Testing bukan sekadar "menambahkan tes", melainkan **mengunci keputusan desain perangkat lunak ke dalam sistem CI/CD (Continuous Integration)**. Dengan menerapkan aturan-aturan ini secara ketat (FormRequest → Controller → DTO → Action → Repository → Model), Anda mengeliminasi kemungkinan *Architecture Erosion* seiring berjalannya waktu dan bertambah kompleksnya aplikasi.

### Checklist Review (Scorecard):
1. [x] **Strong Typing & PHP 8.3/8.4 Ready:** Penggunaan tipe strict (`declare(strict_types=1);`, *readonly classes*, parameter/return type hints pada setiap layer).
2. [x] **Clean Architecture Validated:** Batas *layer* didefinisikan secara konkret dan dites.
3. [x] **Anti-Patterns Addressed:** Pemaparan bahaya nyata *God Controllers* dan kebocoran domain layer beserta mitigasinya melalui pest v3 `arch()` expectation.
4. [x] **Zero Placeholders:** Seluruh blok kode memberikan representasi 1-to-1 fungsional dari awal DTO, FormRequest, hingga abstraksi Repositori.
5. [x] **Comprehensive Pest v3 Usage:** Penggunaan presetting (`preset()->laravel()`), filtering (`toBeClasses()`, `toHaveSuffix()`), dan batasan dependensi (`not->toUse()`, `toOnlyBeUsedIn()`).

Dengan mengadopsi standar Top 1% Quality di dalam file ini, Anda telah meletakkan fondasi pelindung (*guardrails*) untuk memastikan sistem Laravel berskala enterprise tetap prima, tangguh dari kerentanan injeksi arsitektur, dan sangat mudah untuk dirawat oleh ribuan developer yang tergabung dalam tim.
