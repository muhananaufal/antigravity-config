# Service-Repository Pattern di Laravel 11/12 (PHP 8.3+)

Pola arsitektur Service-Repository memisahkan logika bisnis (Service) dari logika akses data (Repository). Pola ini mendasari Clean Architecture di Laravel, memastikan kode yang modular, dapat diuji (testable), dan mudah dipelihara.

Dokumen ini adalah panduan Top 1% untuk mengimplementasikan Service-Repository Pattern di Laravel 11/12 dengan PHP 8.3/8.4, mengedepankan keamanan tipe (type-safety), performa tinggi, dan struktur kode kelas enterprise.

---

## 1. Clean Architecture Workflow

Alur request dalam Clean Architecture Laravel yang ideal adalah sebagai berikut:
`Route -> Middleware -> FormRequest -> Controller -> Action/Service -> Repository -> Model -> Database`

1.  **FormRequest**: Validasi data mentah (HTTP Request) menjadi DTO (Data Transfer Object) atau struktur data yang divalidasi.
2.  **Controller**: Menerima request, memanggil Service/Action, dan mengembalikan HTTP Response (JSON/View). Tidak ada logika bisnis di sini.
3.  **Service / Action**: Mengandung *Business Logic* atau *Use Cases*. Berkomunikasi dengan Repository untuk akses data. Tidak boleh tahu tentang HTTP.
4.  **Repository**: Mengelola *Data Access Logic*. Satu-satunya tempat di mana query database (Eloquent/Query Builder) ditulis. Mengembalikan Entity/Model atau DTO.
5.  **Model**: Representasi tabel database dan relasinya. Tidak boleh ada query kompleks di Model, hanya *relationships*, *casts*, dan konfigurasi dasar.

---

## 2. Implementasi Enterprise-Grade

### 2.1. The Data Transfer Object (DTO)
Gunakan DTO agar tipe data terjamin ketat dari FormRequest hingga Service.

```php
<?php

declare(strict_types=1);

namespace App\DTOs\User;

readonly class UserRegistrationDTO
{
    public function __construct(
        public string $name,
        public string $email,
        public string $password,
        public ?string $phoneNumber = null,
        public array $roles = ['user'],
    ) {}

    public static function fromRequest(array $validatedData): self
    {
        return new self(
            name: $validatedData['name'],
            email: $validatedData['email'],
            password: $validatedData['password'],
            phoneNumber: $validatedData['phone_number'] ?? null,
            roles: $validatedData['roles'] ?? ['user'],
        );
    }
}
```

### 2.2. The Repository Interface & Implementation

Interface Repository menjamin bahwa Service tidak bergantung pada implementasi spesifik (misal MySQL, Redis, atau API Eksternal).

```php
<?php

declare(strict_types=1);

namespace App\Contracts\Repositories;

use App\Models\User;
use Illuminate\Support\Collection;

interface UserRepositoryInterface
{
    public function findById(int $id): ?User;
    
    public function findByEmail(string $email): ?User;
    
    public function create(array $data): User;
    
    public function update(int $id, array $data): bool;
    
    /**
     * @return Collection<int, User>
     */
    public function getActiveUsers(int $limit = 100): Collection;
    
    public function assignRoles(int $userId, array $roles): void;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Repositories\User;

use App\Contracts\Repositories\UserRepositoryInterface;
use App\Models\User;
use Illuminate\Support\Collection;
use Illuminate\Database\DatabaseManager;

readonly class EloquentUserRepository implements UserRepositoryInterface
{
    public function __construct(
        private User $model,
        private DatabaseManager $db
    ) {}

    public function findById(int $id): ?User
    {
        return $this->model->newQuery()->find($id);
    }

    public function findByEmail(string $email): ?User
    {
        return $this->model->newQuery()->where('email', $email)->first();
    }

    public function create(array $data): User
    {
        return $this->model->newQuery()->create($data);
    }

    public function update(int $id, array $data): bool
    {
        return (bool) $this->model->newQuery()->where('id', $id)->update($data);
    }

    /**
     * @return Collection<int, User>
     */
    public function getActiveUsers(int $limit = 100): Collection
    {
        return $this->model->newQuery()
            ->where('is_active', true)
            ->with(['roles'])
            ->limit($limit)
            ->get();
    }
    
    public function assignRoles(int $userId, array $roles): void
    {
        $user = $this->findById($userId);
        if ($user !== null) {
            $user->roles()->sync($roles);
        }
    }
}
```

### 2.3. The Service / Action

Service class akan memproses *Business Logic* yang kompleks (seperti enkripsi password, mengirim notifikasi, dan pengelolaan transaksi database).

```php
<?php

declare(strict_types=1);

namespace App\Services\User;

use App\Contracts\Repositories\UserRepositoryInterface;
use App\DTOs\User\UserRegistrationDTO;
use App\Models\User;
use Illuminate\Database\DatabaseManager;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Throwable;
use Exception;

readonly class UserRegistrationService
{
    public function __construct(
        private UserRepositoryInterface $userRepository,
        private DatabaseManager $databaseManager
    ) {}

    /**
     * @throws Exception
     */
    public function execute(UserRegistrationDTO $dto): User
    {
        if ($this->userRepository->findByEmail($dto->email) !== null) {
            throw new Exception('Email already exists in the system.');
        }

        try {
            return $this->databaseManager->transaction(function () use ($dto) {
                $user = $this->userRepository->create([
                    'name' => $dto->name,
                    'email' => $dto->email,
                    'password' => Hash::make($dto->password),
                    'phone_number' => $dto->phoneNumber,
                    'is_active' => true,
                ]);

                $this->userRepository->assignRoles($user->id, $dto->roles);
                
                // Event atau notifikasi bisa di-trigger di sini
                // event(new UserRegistered($user));

                return $user;
            });
        } catch (Throwable $exception) {
            Log::error('User registration failed', [
                'email' => $dto->email,
                'error' => $exception->getMessage(),
                'trace' => $exception->getTraceAsString(),
            ]);
            
            throw new Exception('Failed to register user. Please try again later.');
        }
    }
}
```

### 2.4. The FormRequest

Form Request mengatur validasi sebelum data mencapai Controller.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\User;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rules\Password;

class RegisterUserRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'string', 'email:rfc,dns', 'max:255', 'unique:users,email'],
            'password' => ['required', 'string', 'confirmed', Password::defaults()],
            'phone_number' => ['nullable', 'string', 'max:20'],
            'roles' => ['nullable', 'array'],
            'roles.*' => ['string', 'exists:roles,name'],
        ];
    }
}
```

### 2.5. The Controller

Controller bertugas mengatur input (dari request) dan output (ke response), memanggil Service sebagai perantara.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\DTOs\User\UserRegistrationDTO;
use App\Http\Controllers\Controller;
use App\Http\Requests\User\RegisterUserRequest;
use App\Services\User\UserRegistrationService;
use Illuminate\Http\JsonResponse;
use Throwable;

final class UserRegistrationController extends Controller
{
    public function __construct(
        private readonly UserRegistrationService $registrationService
    ) {}

    public function __invoke(RegisterUserRequest $request): JsonResponse
    {
        try {
            $dto = UserRegistrationDTO::fromRequest($request->validated());
            
            $user = $this->registrationService->execute($dto);
            
            return response()->json([
                'message' => 'User registered successfully',
                'data' => [
                    'id' => $user->id,
                    'name' => $user->name,
                    'email' => $user->email,
                ],
            ], 201);
            
        } catch (Throwable $e) {
            return response()->json([
                'message' => $e->getMessage(),
            ], 400);
        }
    }
}
```

---

## 3. Anti-Patterns & Best Practices (Wajib Dihindari)

### 3.1. Controller Mengandung Business Logic & Database Query (Fat Controller)

**❌ KODE SALAH:**
```php
<?php

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\DB;

class UserController extends Controller
{
    public function store(Request $request)
    {
        // 1. Validasi manual (TIDAK ADA FormRequest)
        $request->validate(['email' => 'required|email|unique:users']);
        
        DB::beginTransaction();
        try {
            // 2. Query eloquent bocor ke controller (TIDAK ADA Repository)
            $user = User::create([
                'name' => $request->name,
                'email' => $request->email,
                'password' => Hash::make($request->password)
            ]);
            
            // 3. Logika bisnis rumit di controller (TIDAK ADA Service)
            if ($request->has('role')) {
                $role = DB::table('roles')->where('name', $request->role)->first();
                DB::table('user_roles')->insert(['user_id' => $user->id, 'role_id' => $role->id]);
            }
            DB::commit();
            return response()->json($user);
        } catch (\Exception $e) {
            DB::rollBack();
            return response()->json(['error' => 'Failed'], 500);
        }
    }
}
```
**Mengapa Berbahaya?**
- **Testing:** Sulit melakukan mock. Untuk menguji fungsi ini, Anda harus menggunakan database sungguhan (integration test yang lambat).
- **Security & Reusability:** Jika kita ingin membuat user via CLI Artisan Command, kita harus copy-paste logika ini dari Controller, membuka peluang bug dan inkonsistensi. Transaction bocor di level controller berisiko ketika terjadi HTTP connection drop.

**✅ KODE BENAR:**
Gunakan arsitektur Service-Repository yang telah diilustrasikan di atas.

### 3.2. N+1 Query Problem di dalam Repository/Service loop

**❌ KODE SALAH:**
```php
<?php

namespace App\Services;

use App\Repositories\UserRepository;

class UserReportService
{
    public function __construct(private UserRepository $userRepo) {}

    public function generateReport(): array
    {
        $users = $this->userRepo->getAllActiveUsers(); // get() tanpa eager loading
        
        $report = [];
        foreach ($users as $user) {
            // Mengakses relasi (property) dalam loop akan men-trigger query baru
            $report[] = [
                'name' => $user->name,
                'role_count' => $user->roles->count(), // N+1 Query!
                'latest_login' => $user->logins()->latest()->first()?->created_at, // N+1 Query!
            ];
        }
        
        return $report;
    }
}
```
**Mengapa Berbahaya?**
- **Performance & Memory Risk:** Jika terdapat 1,000 user, fungsi ini akan melakukan `1 + 1000 + 1000 = 2001` query database. Resource server akan terkuras, koneksi DB akan habis (connection pool exhaustion), dan response time melambat eksponensial.

**✅ KODE BENAR:**
Lakukan Eager Loading di tingkat Repository dan hindari eksekusi query dalam loop.

```php
<?php
// Di dalam Repository:
public function getActiveUsersWithRolesAndLogins(int $limit = 100): Collection
{
    return $this->model->newQuery()
        ->where('is_active', true)
        ->with(['roles', 'logins' => function ($query) {
            $query->latest()->limit(1); // Eager load relasi terbaru
        }])
        ->limit($limit)
        ->get();
}

// Di dalam Service:
public function generateReport(): array
{
    $users = $this->userRepo->getActiveUsersWithRolesAndLogins(); // 2-3 queries total, no matter the user count
    
    $report = [];
    foreach ($users as $user) {
        $report[] = [
            'name' => $user->name,
            'role_count' => $user->roles->count(), // Sudah di-load ke memory
            'latest_login' => $user->logins->first()?->created_at, // Sudah di-load ke memory
        ];
    }
    
    return $report;
}
```

---

## 4. Pest v3 Testing (Unit & Arch Tests)

Gunakan Pest PHP versi 3 untuk melakukan testing yang bersih dan deklaratif. 

### 4.1. Architecture Testing
Pastikan Clean Architecture dihormati. Service tidak boleh memanggil Controller, Repository tidak boleh menggunakan tipe HTTP, dll.

```php
<?php

declare(strict_types=1);

// tests/ArchTest.php
use Illuminate\Http\Request;
use Illuminate\Foundation\Http\FormRequest;

arch('it validates controllers')
    ->expect('App\Http\Controllers')
    ->toBeClasses()
    ->toHaveSuffix('Controller')
    ->toExtend('App\Http\Controllers\Controller')
    ->toOnlyBeUsedIn('App\Http\Controllers');

arch('it validates services')
    ->expect('App\Services')
    ->toBeClasses()
    ->toHaveSuffix('Service')
    ->not->toUse([Request::class, FormRequest::class]) // Service harus murni dari request HTTP
    ->toOnlyBeUsedIn([
        'App\Http\Controllers',
        'App\Console\Commands',
        'App\Jobs',
        'App\Services',
    ]);

arch('it validates repositories')
    ->expect('App\Repositories')
    ->toBeClasses()
    ->toHaveSuffix('Repository')
    ->toImplementAnything() // Harus implemen sebuah interface
    ->not->toUse([Request::class, FormRequest::class]);

arch('it ensures models only use specific traits')
    ->expect('App\Models')
    ->toBeClasses()
    ->toExtend('Illuminate\Database\Eloquent\Model');
    
arch('strict types enforcement')
    ->expect('App')
    ->toUseStrictTypes();
```

### 4.2. Unit Testing Service dengan Mocks (Pest Fakes/Mockery)
Menguji logika bisnis di Service secara terisolasi tanpa menyentuh Database, menggunakan Repository Mock.

```php
<?php

declare(strict_types=1);

// tests/Unit/Services/UserRegistrationServiceTest.php

use App\Contracts\Repositories\UserRepositoryInterface;
use App\DTOs\User\UserRegistrationDTO;
use App\Models\User;
use App\Services\User\UserRegistrationService;
use Illuminate\Database\DatabaseManager;

uses()->group('unit', 'services', 'user');

it('successfully registers a user', function () {
    // 1. Arrange
    $dto = new UserRegistrationDTO(
        name: 'John Doe',
        email: 'john@example.com',
        password: 'password123',
        phoneNumber: '081234567890',
        roles: ['user', 'editor']
    );

    $userModel = new User();
    $userModel->id = 1;
    $userModel->name = 'John Doe';
    $userModel->email = 'john@example.com';

    // Mock Repository
    $userRepositoryMock = Mockery::mock(UserRepositoryInterface::class);
    $userRepositoryMock->shouldReceive('findByEmail')
        ->once()
        ->with('john@example.com')
        ->andReturn(null); // Asumsikan user belum ada

    $userRepositoryMock->shouldReceive('create')
        ->once()
        ->andReturn($userModel);

    $userRepositoryMock->shouldReceive('assignRoles')
        ->once()
        ->with(1, ['user', 'editor'])
        ->andReturnNull();

    // Mock DatabaseManager (karena transaction dipanggil di DB Facade/Manager)
    $dbManagerMock = Mockery::mock(DatabaseManager::class);
    $dbManagerMock->shouldReceive('transaction')
        ->once()
        ->andReturnUsing(function ($callback) {
            return $callback(); // Langsung eksekusi isi transaksi untuk testing
        });

    $service = new UserRegistrationService($userRepositoryMock, $dbManagerMock);

    // 2. Act
    $result = $service->execute($dto);

    // 3. Assert
    expect($result)
        ->toBeInstanceOf(User::class)
        ->and($result->email)->toBe('john@example.com');
});

it('throws exception if email already exists', function () {
    // 1. Arrange
    $dto = new UserRegistrationDTO(
        name: 'John Doe',
        email: 'existing@example.com',
        password: 'password123'
    );
    
    $existingUser = new User();

    $userRepositoryMock = Mockery::mock(UserRepositoryInterface::class);
    $userRepositoryMock->shouldReceive('findByEmail')
        ->once()
        ->with('existing@example.com')
        ->andReturn($existingUser);

    $dbManagerMock = Mockery::mock(DatabaseManager::class);

    $service = new UserRegistrationService($userRepositoryMock, $dbManagerMock);

    // 2 & 3. Act & Assert Expectation
    expect(fn() => $service->execute($dto))
        ->toThrow(Exception::class, 'Email already exists in the system.');
});
```

---

## Kesimpulan
Dengan menerapkan arsitektur Service-Repository yang dipadukan dengan DTO, Anda:
1. **Separation of Concerns:** Menjamin Controller hanya mengurus HTTP, Service mengurus logika, dan Repository mengurus DB.
2. **Testability:** Memungkinkan unit testing tanpa interaksi database berkat injection repository melalui kontrak interface.
3. **Reusability & Safety:** Logika service dapat dipanggil dari mana pun (Command, Jobs, API Controller, Web Controller) dan Data Transfer Object (DTO) mengamankan tipe data Anda sepanjang eksekusi program.
