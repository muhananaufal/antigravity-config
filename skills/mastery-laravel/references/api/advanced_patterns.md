# Advanced API Patterns & Clean Architecture (Laravel 11/12)

Dalam pengembangan API skala enterprise menggunakan Laravel, struktur konvensional MVC (Model-View-Controller) sering kali berujung pada *Fat Controllers* atau *God Models*. Pola *Advanced API* mengadopsi prinsip **Clean Architecture** dan memisahkan domain logic (aturan bisnis) dari HTTP transport layer. 

Dokumen ini adalah standarisasi Top 1% untuk pengembangan API menggunakan PHP 8.3/8.4 dan Laravel 11/12.

---

## 1. Prinsip Utama (The Core Principles)

1. **Strict Typing:** Seluruh file PHP WAJIB mendeklarasikan `declare(strict_types=1);` di baris pertama. Gunakan type-hinting penuh (parameter dan return types).
2. **Thin Controllers, Fat Actions:** Controller hanya berhak menerima Request HTTP, memvalidasinya, mengirimnya ke Action/Service, dan mengembalikan HTTP Response. DILARANG menaruh query database atau business logic di Controller.
3. **Data Transfer Objects (DTO):** Pengiriman data antar layer tidak menggunakan associative arrays, melainkan objek DTO yang `readonly` (fitur PHP 8.2+).
4. **Repository Pattern (Opsional namun Sangat Disarankan):** Abstraksikan query database. Layer bisnis tidak boleh tahu apakah Anda menggunakan MySQL, PostgreSQL, atau Elasticsearch.
5. **Single Responsibility Principle (SRP):** Satu class Action hanya melakukan *satu* operasi (contoh: `CreateOrderAction` daripada `OrderService` yang berisi 50 method).

---

## 2. Struktur Clean Architecture (The Pipeline)

Alur atau pipeline dari sebuah API Request yang bersih adalah sebagai berikut:
`Route -> FormRequest (Validation) -> Controller -> DTO -> Action (Business Logic) -> Repository (Data Access) -> Model`

### A. Form Request (HTTP Validation)
Hanya validasi input HTTP, authorization, dan konversi tipe data yang aman.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Api\V1\Users;

use Illuminate\Foundation\Http\FormRequest;

final class StoreUserRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()?->can('create-users') ?? false;
    }

    /**
     * @return array<string, \Illuminate\Contracts\Validation\ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'email'    => ['required', 'string', 'email:rfc,dns', 'max:255', 'unique:users,email'],
            'password' => ['required', 'string', 'min:12', 'mixedCase', 'numbers', 'symbols'],
            'name'     => ['required', 'string', 'max:100'],
            'role_id'  => ['required', 'integer', 'exists:roles,id'],
        ];
    }
}
```

### B. Data Transfer Object (DTO)
Mencegah penggunaan array sembarangan dengan mendefinisikan struktur data statis. Pada PHP 8.3, gunakan `readonly class`.

```php
<?php

declare(strict_types=1);

namespace App\DataTransferObjects\Users;

final readonly class CreateUserDTO
{
    public function __construct(
        public string $email,
        public string $password,
        public string $name,
        public int $roleId,
    ) {}
}
```

### C. Controller (HTTP Transport Layer)
Controller sangat tipis, tidak ada fungsi logika bisnis selain injeksi, orkestrasi DTO, dan JSON response.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\Api\V1\Users\StoreUserRequest;
use App\DataTransferObjects\Users\CreateUserDTO;
use App\Actions\Users\CreateUserAction;
use App\Http\Resources\Api\V1\UserResource;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final class UserController extends Controller
{
    public function store(
        StoreUserRequest $request,
        CreateUserAction $action
    ): JsonResponse {
        $dto = new CreateUserDTO(
            email: $request->validated('email'),
            password: $request->validated('password'),
            name: $request->validated('name'),
            roleId: (int) $request->validated('role_id'),
        );

        // Eksekusi logic via Action Class
        $user = $action->execute($dto);

        return response()->json([
            'message' => 'User created successfully.',
            'data'    => new UserResource($user),
        ], Response::HTTP_CREATED);
    }
}
```

### D. Action (Domain Logic)
Berisi inti logika sistem. Dibuat `final readonly class` (jika menggunakan dependency injection) atau minimal stateless class.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Users;

use App\DataTransferObjects\Users\CreateUserDTO;
use App\Models\User;
use App\Repositories\Contracts\UserRepositoryInterface;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;

final readonly class CreateUserAction
{
    public function __construct(
        private UserRepositoryInterface $userRepository
    ) {}

    public function execute(CreateUserDTO $dto): User
    {
        // Bungkus dalam Database Transaction agar ACID-compliant
        return DB::transaction(function () use ($dto): User {
            $user = $this->userRepository->create([
                'email'    => $dto->email,
                'password' => Hash::make($dto->password),
                'name'     => $dto->name,
                'role_id'  => $dto->roleId,
            ]);

            // Dispatch domain event atau audit trail
            Log::info('User created via API', ['user_id' => $user->id]);

            return $user;
        });
    }
}
```

### E. Repository (Data Access)
Memisahkan Eloquent Model dari Business Logic. Sangat krusial jika suatu saat struktur tabel diubah.

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Contracts;

use App\Models\User;

interface UserRepositoryInterface
{
    /**
     * @param array<string, mixed> $data
     */
    public function create(array $data): User;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use App\Models\User;
use App\Repositories\Contracts\UserRepositoryInterface;

final readonly class UserRepository implements UserRepositoryInterface
{
    public function create(array $data): User
    {
        return User::create($data);
    }
}
```

---

## 3. Anti-Patterns (Spesifik Laravel API)

Sebagai insinyur Top 1%, identifikasi kode yang salah dengan cepat. Berikut adalah 2 pasang pola kesalahan (Anti-Pattern) paling fatal beserta perbaikannya.

### ❌ Anti-Pattern 1: "The God Controller" (Logic & Query dalam Controller)

**KODE SALAH (Fat Controller):**
Di sini Controller melakukan validasi manual, hashing, database transaction, dan menembak email sekaligus.
```php
<?php

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use Exception;

class UserController extends Controller 
{
    public function store(Request $request) 
    {
        // ❌ Buruk: Validasi di Controller
        $request->validate(['email' => 'required|email|unique:users']);
        
        try {
            // ❌ Buruk: Logic DB & Hashing di Controller
            $user = new User();
            $user->email = $request->email;
            $user->password = Hash::make($request->password);
            $user->save();
            
            // ❌ Buruk: Side effect langsung ditembak, blocking API response
            Mail::to($user->email)->send(new WelcomeEmail());
            
            return response()->json(['status' => 'success', 'data' => $user]);
        } catch (Exception $e) {
            // ❌ Buruk: Menampilkan detail Exception ke End-user
            return response()->json(['error' => $e->getMessage()], 500);
        }
    }
}
```

**✅ KODE BENAR (Clean & Delegated):**
Validasi diserahkan ke `FormRequest`. Side effect diserahkan ke *Event Listeners* atau Queue. Logic diserahkan ke *Action*.
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\Api\V1\Users\StoreUserRequest;
use App\Actions\Users\CreateUserAction;
use App\DataTransferObjects\Users\CreateUserDTO;
use Illuminate\Http\JsonResponse;

final class UserController extends Controller 
{
    public function store(StoreUserRequest $request, CreateUserAction $action): JsonResponse 
    {
        $dto = new CreateUserDTO(
            email: $request->validated('email'),
            password: $request->validated('password'),
            name: $request->validated('name'),
            roleId: (int) $request->validated('role_id')
        );
        
        // Action akan handle DB, dan setelah create melempar Event (UserCreated).
        // Event Listener akan mendengarkan UserCreated dan mengirim Email ke antrian (Queue).
        $user = $action->execute($dto);
        
        return response()->json(['data' => $user], 201);
    }
}
```

### ❌ Anti-Pattern 2: "N+1 Problem dalam API Resources"

**KODE SALAH (Menghasilkan N+1 Queries):**
Resource meload relasi langsung tanpa mengecek apakah relasi itu sudah di-load (eager loaded).
```php
<?php

namespace App\Http\Resources;

use Illuminate\Http\Resources\Json\JsonResource;

class UserResource extends JsonResource
{
    public function toArray($request): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            // ❌ Fatal N+1: Setiap iterasi (contoh list of 100 users) 
            // akan mengeksekusi 1 query tambahan untuk mengambil company!
            'company_name' => $this->company->name, 
        ];
    }
}
```

**✅ KODE BENAR (Safe Eager Loading via `whenLoaded`):**
Hanya render relasi jika Controller / Repository telah melakukan eager load (`with('company')`).
```php
<?php

declare(strict_types=1);

namespace App\Http\Resources\Api\V1;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;
use App\Models\User;

/**
 * @mixin User
 */
final class UserResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            // ✅ Aman: Menghindari N+1 Query. Jika relasi company tidak diload sebelumnya,
            // key 'company' tidak akan ditampilkan (atau akan null).
            'company' => new CompanyResource($this->whenLoaded('company')),
        ];
    }
}
```

---

## 4. Testing dengan Pest v3 (Unit & Architecture)

Untuk menjamin Clean Architecture benar-benar ditaati dan kode teruji, kita wajib menulis automated tests dengan **Pest v3**.

### A. Architecture Test (`tests/Feature/ArchTest.php`)
Pastikan lapisan Clean Architecture kita tidak bocor. Tidak boleh ada model yang dipanggil di Controller langsung (kecuali dependency injection via Repository) dan pastikan *Strict Typing*.

```php
<?php

declare(strict_types=1);

test('globals')
    ->expect(['dd', 'dump', 'env'])
    ->not->toBeUsed();

test('strict types')
    ->expect('App')
    ->toUseStrictTypes();

test('controllers are slim')
    ->expect('App\Http\Controllers')
    ->not->toUse('Illuminate\Support\Facades\DB')
    ->not->toUse('App\Models') // Memaksa via Repository/Action
    ->ignoring('App\Http\Controllers\Controller'); // Kecualikan class parent

test('actions are strictly final')
    ->expect('App\Actions')
    ->toBeFinal()
    ->toBeClasses();
```

### B. Unit Test untuk Action (`tests/Unit/Actions/CreateUserActionTest.php`)

Karena `CreateUserAction` hanya bertumpu pada dependency dan murni, kita dapat meng-mock *Repository* secara langsung untuk isolasi logika.

```php
<?php

declare(strict_types=1);

use App\Actions\Users\CreateUserAction;
use App\DataTransferObjects\Users\CreateUserDTO;
use App\Models\User;
use App\Repositories\Contracts\UserRepositoryInterface;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;

beforeEach(function () {
    // Mock Repository
    $this->userRepository = Mockery::mock(UserRepositoryInterface::class);
    $this->action = new CreateUserAction($this->userRepository);
});

it('creates a user successfully and hashes password', function () {
    // 1. Arrange
    $dto = new CreateUserDTO(
        email: 'ceo@enterprise.com',
        password: 'SuperSecretPassword123!',
        name: 'John Doe',
        roleId: 1
    );

    $expectedUser = new User(['id' => 1, 'email' => $dto->email, 'name' => $dto->name]);

    // Mock DB Transaction agar langsung eksekusi callback
    DB::shouldReceive('transaction')
        ->once()
        ->andReturnUsing(fn ($callback) => $callback());

    // Pastikan hash di-mock untuk konsistensi
    Hash::shouldReceive('make')
        ->with($dto->password)
        ->once()
        ->andReturn('hashed_password');

    Log::shouldReceive('info')->once();

    $this->userRepository
        ->shouldReceive('create')
        ->once()
        ->with([
            'email' => $dto->email,
            'password' => 'hashed_password',
            'name' => $dto->name,
            'role_id' => $dto->roleId,
        ])
        ->andReturn($expectedUser);

    // 2. Act
    $user = $this->action->execute($dto);

    // 3. Assert
    expect($user)->toBeInstanceOf(User::class)
        ->and($user->email)->toBe('ceo@enterprise.com');
});
```

---

## 5. Standar Enterprise Lanjutan (Bonus Checklist)

Sebelum deploy API ke Production, centang seluruh checklist di bawah ini:

- [ ] **Idempotency Keys:** Setiap API Mutasi (POST/PUT/PATCH/DELETE) harus mendukung `Idempotency-Key` di header, untuk menghindari transaksi ganda akibat *network timeout/retries*.
- [ ] **Rate Limiting (Redis-based):** Terapkan limit per-IP atau per-User-ID via `Illuminate\Support\Facades\RateLimiter` atau Laravel Route middleware (contoh: `throttle:60,1`).
- [ ] **API Versioning (URL atau Header):** Gunakan pola direktori `Api/V1/` pada namespace Controller dan Resource.
- [ ] **Graceful Exception Handling:** Jangan biarkan Exception SQL bocor. Tangani via `bootstrap/app.php` (Laravel 11+) untuk meregistrasi custom JSON responses pada instance Exception tertentu (misalnya `ModelNotFoundException` -> `404 Not Found`).
- [ ] **Data Serialization Standards:** Pastikan keys berformat konsisten (misalnya selalu `snake_case` atau `camelCase`). Disarankan menggunakan JSON:API Standard.
- [ ] **UUID / ULID as Primary Keys:** ID *auto-increment* dapat ditebak (Insecure Direct Object Reference). Pada endpoint terbuka, sangat dianjurkan mengekspos UUID (PHP `Str::uuid()`) atau ULID.
