# Laravel 11/12 & PHP 8.3/8.4 Code Standards & Clean Architecture

## 1. Filosofi Arsitektur dan Standar Dasar

Dokumen ini mendefinisikan standar pengkodean absolut untuk aplikasi Laravel tingkat enterprise. Dengan PHP 8.3 dan 8.4, kita memanfaatkan fitur-fitur modern seperti Typed Class Constants, Readonly Classes, Asymmetric Visibility, dan proper type hinting. Tujuan utamanya adalah menciptakan basis kode yang:
- **Type-Safe**: Kesalahan terdeteksi oleh PHPStan (Level 9) sebelum runtime.
- **Testable**: Setiap komponen terisolasi dan mudah diuji.
- **Maintainable**: Mengikuti prinsip Clean Architecture (FormRequest -> Controller -> Action/Service -> Repository -> Model).

### Aturan Wajib
1. `declare(strict_types=1);` **WAJIB** berada di baris pertama setiap file PHP.
2. Gunakan *Readonly Classes* untuk DTO (Data Transfer Objects) dan Actions.
3. Hindari `mixed`, selesaikan semua peringatan tipe statis.
4. Jangan pernah menaruh logika bisnis di Controller atau Model.

---

## 2. Clean Architecture: Layer by Layer

Arsitektur yang bersih memisahkan tanggung jawab (Separation of Concerns).

### 2.1. FormRequest (Input Validation & DTO Creation)
Semua validasi HTTP dan transformasi ke DTO terjadi di sini.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\User;

use App\DTOs\User\CreateUserDTO;
use Illuminate\Foundation\Http\FormRequest;

final class StoreUserRequest extends FormRequest
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
            'email' => ['required', 'string', 'email', 'unique:users,email'],
            'password' => ['required', 'string', 'min:8'],
            'role_id' => ['required', 'integer', 'exists:roles,id'],
        ];
    }

    public function toDTO(): CreateUserDTO
    {
        return new CreateUserDTO(
            name: $this->validated('name'),
            email: $this->validated('email'),
            password: $this->validated('password'),
            roleId: (int) $this->validated('role_id'),
        );
    }
}
```

### 2.2. Controller (HTTP Routing)
Controller HANYA menerima request, memanggil Action/Service, dan mengembalikan response.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\User;

use App\Actions\User\CreateUserAction;
use App\Http\Controllers\Controller;
use App\Http\Requests\User\StoreUserRequest;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final class UserController extends Controller
{
    public function __construct(
        private readonly CreateUserAction $createUserAction,
    ) {}

    public function store(StoreUserRequest $request): JsonResponse
    {
        $user = $this->createUserAction->execute($request->toDTO());

        return response()->json([
            'message' => 'User created successfully',
            'data' => $user->toArray(),
        ], Response::HTTP_CREATED);
    }
}
```

### 2.3. Action (Business Logic)
Action menangani satu use case spesifik.

```php
<?php

declare(strict_types=1);

namespace App\Actions\User;

use App\DTOs\User\CreateUserDTO;
use App\Models\User;
use App\Repositories\Contracts\UserRepositoryInterface;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Exception;
use RuntimeException;

final readonly class CreateUserAction
{
    public function __construct(
        private UserRepositoryInterface $userRepository,
    ) {}

    /**
     * @throws RuntimeException
     */
    public function execute(CreateUserDTO $dto): User
    {
        try {
            $hashedPassword = Hash::make($dto->password);
            
            $user = $this->userRepository->create([
                'name' => $dto->name,
                'email' => $dto->email,
                'password' => $hashedPassword,
                'role_id' => $dto->roleId,
            ]);
            
            // Logika bisnis tambahan seperti mengirim email welcome dll
            
            return $user;
        } catch (Exception $e) {
            Log::error('Failed to create user: ' . $e->getMessage());
            throw new RuntimeException('Unable to create user at this time.');
        }
    }
}
```

### 2.4. Repository (Data Access)
Memisahkan Eloquent dari lapisan bisnis.

```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Models\User;
use App\Repositories\Contracts\UserRepositoryInterface;

final readonly class UserRepository implements UserRepositoryInterface
{
    /**
     * @param array<string, mixed> $data
     */
    public function create(array $data): User
    {
        /** @var User $user */
        $user = User::query()->create($data);
        return $user;
    }
    
    public function findById(int $id): ?User
    {
        /** @var User|null $user */
        $user = User::query()->find($id);
        return $user;
    }
}
```

---

## 3. Anti-Patterns & Best Practices

### 3.1. Anti-Pattern: Fat Controller (Logika Bisnis di Controller)

❌ **KODE SALAH (Fat Controller)**
```php
<?php

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;

class RegisterController extends Controller
{
    public function register(Request $request)
    {
        // 1. Validasi manual tanpa FormRequest
        $request->validate([
            'name' => 'required',
            'email' => 'required|email',
            'password' => 'required'
        ]);

        // 2. Logika hashing di controller
        $password = Hash::make($request->password);

        // 3. Akses Eloquent langsung di controller
        $user = new User();
        $user->name = $request->name;
        $user->email = $request->email;
        $user->password = $password;
        $user->save();

        // 4. Side-effect langsung di controller
        Mail::raw('Welcome', function ($message) use ($user) {
            $message->to($user->email);
        });

        return response()->json($user);
    }
}
```
**Mengapa Berbahaya?**
- **Security & Testing**: Logika terikat kuat dengan HTTP Request, membuatnya hampir mustahil diuji secara unit test (harus integration test).
- **Maintenance**: Jika kita ingin menambahkan user dari Console Command (CLI) atau Job, kita harus menduplikasi semua logika pembuatan user dan pengiriman email.
- **SRP Violation**: Controller mengurus validasi, hashing, database saving, dan pengiriman email sekaligus.

✅ **KODE BENAR (Clean Architecture)**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Actions\User\RegisterUserAction;
use App\Http\Requests\Auth\RegisterRequest;
use Illuminate\Http\JsonResponse;

final class RegisterController
{
    public function __construct(
        private readonly RegisterUserAction $registerUserAction
    ) {}

    public function __invoke(RegisterRequest $request): JsonResponse
    {
        $user = $this->registerUserAction->execute($request->toDTO());
        return response()->json(['data' => $user]);
    }
}
```
(Logika dipindah ke `RegisterUserAction` dan validasi di `RegisterRequest`).

### 3.2. Anti-Pattern: N+1 Query & Eloquent API Leakage

❌ **KODE SALAH (N+1 Query di Controller/View)**
```php
<?php

namespace App\Http\Controllers;

use App\Models\Post;

class PostController extends Controller
{
    public function index()
    {
        // Masalah: N+1 Query akan terjadi saat mengakses $post->author->name
        $posts = Post::all();
        
        $data = [];
        foreach ($posts as $post) {
            $data[] = [
                'title' => $post->title,
                'author' => $post->author->name, // Query baru dijalankan setiap iterasi!
            ];
        }
        
        return response()->json($data);
    }
}
```
**Mengapa Berbahaya?**
- **Performance Risk**: Jika ada 1000 post, aplikasi akan menjalankan 1 query untuk mengambil post + 1000 query terpisah untuk mengambil author. Ini akan membunuh database (CPU/IO bottleneck).
- **Memory Risk**: `Post::all()` meload seluruh isi tabel ke dalam memory (RAM PHP), menyebabkan Out of Memory (OOM) jika tabel membesar.

✅ **KODE BENAR (Eager Loading & Pagination di Repository)**
```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Models\Post;
use Illuminate\Pagination\LengthAwarePaginator;

final class PostRepository
{
    /**
     * @return LengthAwarePaginator<Post>
     */
    public function getPaginatedWithAuthor(int $perPage = 15): LengthAwarePaginator
    {
        // Menggunakan with() untuk Eager Loading dan paginate() untuk memory safety
        return Post::query()
            ->with(['author'])
            ->latest()
            ->paginate($perPage);
    }
}

// Controller usage
namespace App\Http\Controllers;

use App\Repositories\PostRepository;
use Illuminate\Http\JsonResponse;
use App\Http\Resources\PostResource;

final class PostController extends Controller
{
    public function __construct(
        private readonly PostRepository $postRepository
    ) {}

    public function index(): JsonResponse
    {
        $posts = $this->postRepository->getPaginatedWithAuthor();
        
        // Memanfaatkan Eloquent API Resource untuk pemetaan data
        return PostResource::collection($posts)->response();
    }
}
```

---

## 4. Testing dengan Pest v3

Unit Test dan Architecture Test wajib menggunakan Pest v3. Pest mendukung sintaksis yang elegan dan fungsi Arch untuk memastikan clean architecture tidak dirusak.

### 4.1. Architecture Test (`tests/ArchTest.php`)
Memastikan layer tidak saling melangkahi batasan.

```php
<?php

declare(strict_types=1);

arch('strict types are enforced everywhere')
    ->expect('App')
    ->toUseStrictTypes();

arch('controllers should not use models directly')
    ->expect('App\Http\Controllers')
    ->not->toUse('App\Models')
    ->ignoring('App\Http\Controllers\Controller'); // Exception untuk base controller

arch('actions should not use http requests')
    ->expect('App\Actions')
    ->not->toUse('Illuminate\Http\Request');

arch('controllers should be suffixed with Controller')
    ->expect('App\Http\Controllers')
    ->toHaveSuffix('Controller');

arch('models should extend Eloquent Model')
    ->expect('App\Models')
    ->toBeClasses()
    ->toExtend('Illuminate\Database\Eloquent\Model');
```

### 4.2. Action Unit Test (`tests/Unit/Actions/CreateUserActionTest.php`)
Menguji bisnis logika terisolasi dengan fakes/mocks.

```php
<?php

declare(strict_types=1);

use App\Actions\User\CreateUserAction;
use App\DTOs\User\CreateUserDTO;
use App\Models\User;
use App\Repositories\Contracts\UserRepositoryInterface;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;

uses()->group('actions', 'user');

it('successfully creates a user', function () {
    // Arrange
    $dto = new CreateUserDTO(
        name: 'John Doe',
        email: 'john@example.com',
        password: 'password123',
        roleId: 1
    );

    $userModel = new User(['id' => 1, 'name' => 'John Doe', 'email' => 'john@example.com']);

    $repositoryMock = Mockery::mock(UserRepositoryInterface::class);
    $repositoryMock->shouldReceive('create')
        ->once()
        ->withArgs(function ($data) use ($dto) {
            return $data['name'] === $dto->name &&
                   $data['email'] === $dto->email &&
                   Hash::check($dto->password, $data['password']);
        })
        ->andReturn($userModel);

    Hash::fake();
    
    $action = new CreateUserAction($repositoryMock);

    // Act
    $result = $action->execute($dto);

    // Assert
    expect($result)
        ->toBeInstanceOf(User::class)
        ->and($result->name)->toBe('John Doe')
        ->and($result->email)->toBe('john@example.com');
});

it('logs an error and throws exception if repository fails', function () {
    // Arrange
    $dto = new CreateUserDTO(
        name: 'John Doe',
        email: 'john@example.com',
        password: 'password123',
        roleId: 1
    );

    $repositoryMock = Mockery::mock(UserRepositoryInterface::class);
    $repositoryMock->shouldReceive('create')
        ->once()
        ->andThrow(new Exception('Database error'));

    Log::shouldReceive('error')
        ->once()
        ->with('Failed to create user: Database error');

    $action = new CreateUserAction($repositoryMock);

    // Act & Assert
    expect(fn() => $action->execute($dto))
        ->toThrow(RuntimeException::class, 'Unable to create user at this time.');
});
```

### 4.3. Controller Feature Test (`tests/Feature/Controllers/UserControllerTest.php`)
Menguji integrasi HTTP Endpoint.

```php
<?php

declare(strict_types=1);

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Response;

uses(RefreshDatabase::class)->group('controllers', 'user');

it('validates incoming request and creates user', function () {
    // Arrange
    $payload = [
        'name' => 'Jane Doe',
        'email' => 'jane@example.com',
        'password' => 'securepassword',
        'role_id' => 2,
    ];

    // Act
    $response = $this->postJson('/api/users', $payload);

    // Assert
    $response->assertStatus(Response::HTTP_CREATED)
             ->assertJsonPath('data.name', 'Jane Doe')
             ->assertJsonPath('data.email', 'jane@example.com');

    $this->assertDatabaseHas('users', [
        'email' => 'jane@example.com'
    ]);
});

it('rejects invalid email format', function () {
    // Arrange
    $payload = [
        'name' => 'Jane Doe',
        'email' => 'invalid-email',
        'password' => 'securepassword',
        'role_id' => 2,
    ];

    // Act
    $response = $this->postJson('/api/users', $payload);

    // Assert
    $response->assertStatus(Response::HTTP_UNPROCESSABLE_ENTITY)
             ->assertJsonValidationErrors(['email']);
});
```

## 5. Kesimpulan
Dengan menerapkan arsitektur 5 layer (Request -> Controller -> Action -> Repository -> Model), strict types PHP 8.3/8.4, dan pengujian komprehensif Pest v3, aplikasi dapat bertahan terhadap Technical Debt. Kepatuhan terhadap standar di atas bersifat MUTLAK untuk segala pengembangan enterprise.
