# Panduan Lengkap Spatie Laravel Data: Best Practices & Arsitektur Kelas Enterprise

Package `spatie/laravel-data` adalah game-changer dalam ekosistem Laravel modern (v11/12). Package ini menyatukan tiga konsep penting yang seringkali terpisah: **Data Transfer Objects (DTO)**, **FormRequests**, dan **API Resources (Transformers)**. Dengan menggunakan Laravel Data, kita dapat mengurangi boilerplate secara drastis, meningkatkan type-safety, dan memastikan konsistensi data dari request input hingga response output. Panduan ini akan membahas implementasi tingkat lanjut menggunakan PHP 8.3/8.4, Laravel 11/12, dan prinsip Clean Architecture.

---

## 1. Filosofi dan Konsep Dasar

Dalam arsitektur tradisional Laravel, aliran data seringkali seperti ini:
1. `Request` ditangkap dan divalidasi oleh `FormRequest`.
2. Data dari `FormRequest` diambil dalam bentuk array asosiatif (misal: `$request->validated()`) dan dikirim ke Service atau Action.
3. Service/Action memproses array tersebut dan mengembalikan model Eloquent.
4. Model tersebut di-format oleh `JsonResource` untuk dikirimkan sebagai response API.

Masalah dari pendekatan ini adalah hilangnya type-safety di tengah jalan (array asosiatif tidak memiliki tipe) dan duplikasi kode antara definisi Request dan Resource. `spatie/laravel-data` menyelesaikan masalah ini dengan mendefinisikan satu kelas Data yang menangani validasi, transformasi, dan representasi tipe data yang kuat (strongly typed).

---

## 2. Implementasi Clean Architecture

Dalam Clean Architecture, kita membagi tanggung jawab menjadi beberapa layer: Controller -> Action/Service -> Repository -> Model. Laravel Data sangat cocok ditempatkan sebagai batas komunikasi antar layer.

### 2.1. Mendefinisikan Kelas Data

Kita mulai dengan mendefinisikan kelas Data. Kelas ini akan berfungsi sebagai DTO untuk input, validasi otomatis, sekaligus transformer untuk output.

```php
<?php

declare(strict_types=1);

namespace App\Data;

use Spatie\LaravelData\Data;
use Spatie\LaravelData\Attributes\Validation\Email;
use Spatie\LaravelData\Attributes\Validation\Min;
use Spatie\LaravelData\Attributes\Validation\Max;
use Spatie\LaravelData\Attributes\Validation\Rule;
use App\Enums\UserRole;

class UserData extends Data
{
    public function __construct(
        public readonly ?int $id,
        
        #[Min(3), Max(50)]
        public readonly string $name,
        
        #[Email]
        #[Rule('unique:users,email')]
        public readonly string $email,
        
        public readonly UserRole $role,
        
        public readonly ?string $avatarUrl = null,
    ) {}
}
```

### 2.2. Implementasi Controller

Di Controller, kita langsung menginjeksi `UserData`. Spatie Laravel Data secara otomatis akan menangkap HTTP Request, melakukan validasi berdasarkan atribut yang ada di `UserData`, dan membuat instance objek jika validasi berhasil.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Data\UserData;
use App\Actions\Users\CreateUserAction;
use Illuminate\Http\JsonResponse;

class UserController extends Controller
{
    public function __construct(
        private readonly CreateUserAction $createUserAction
    ) {}

    public function store(UserData $userData): JsonResponse
    {
        // $userData sudah tervalidasi dan strongly typed
        $user = $this->createUserAction->execute($userData);
        
        // Kita bisa menggunakan UserData lagi untuk memformat output
        return response()->json([
            'message' => 'User created successfully',
            'data' => UserData::from($user),
        ], 201);
    }
}
```

### 2.3. Implementasi Action / Service

Action bertanggung jawab untuk bisnis logika. Action menerima DTO (`UserData`) dan tidak perlu tahu tentang HTTP Request.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Users;

use App\Data\UserData;
use App\Models\User;
use App\Repositories\Contracts\UserRepositoryInterface;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

class CreateUserAction
{
    public function __construct(
        private readonly UserRepositoryInterface $userRepository
    ) {}

    public function execute(UserData $userData): User
    {
        // Business logic di sini, contohnya mengenerate password acak
        $password = Str::random(12);
        
        $user = $this->userRepository->create([
            'name' => $userData->name,
            'email' => $userData->email,
            'role' => $userData->role->value,
            'password' => Hash::make($password),
        ]);
        
        // Di aplikasi nyata, kita mungkin akan mengirim email berisi password
        // Mail::to($user)->send(new WelcomeEmail($password));
        
        return $user;
    }
}
```

### 2.4. Implementasi Repository dan Model

Repository bertugas mengabstraksi interaksi dengan database (Eloquent).

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Contracts;

use App\Models\User;

interface UserRepositoryInterface
{
    /**
     * @param array<string, mixed> $attributes
     */
    public function create(array $attributes): User;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use App\Models\User;
use App\Repositories\Contracts\UserRepositoryInterface;

class UserRepository implements UserRepositoryInterface
{
    public function create(array $attributes): User
    {
        return User::create($attributes);
    }
}
```

---

## 3. Fitur Lanjutan (Advanced Features)

### 3.1. Mapping Property Names

Terkadang, penamaan properti di API (misal `snake_case`) berbeda dengan standar penamaan properti di PHP (`camelCase`). Laravel Data dapat menanganinya dengan mudah menggunakan fitur Map.

```php
<?php

declare(strict_types=1);

namespace App\Data;

use Spatie\LaravelData\Data;
use Spatie\LaravelData\Attributes\MapInputName;
use Spatie\LaravelData\Attributes\MapOutputName;
use Spatie\LaravelData\Mappers\SnakeCaseMapper;

#[MapInputName(SnakeCaseMapper::class)]
#[MapOutputName(SnakeCaseMapper::class)]
class UserProfileData extends Data
{
    public function __construct(
        public readonly string $firstName,
        public readonly string $lastName,
        public readonly string $phoneNumber,
    ) {}
}
```

Jika client mengirim `{"first_name": "John", "last_name": "Doe", "phone_number": "1234"}`, Laravel Data otomatis memetakan ke `$firstName`, `$lastName`, dan `$phoneNumber`. Dan saat diubah kembali menjadi array/JSON, akan menggunakan `snake_case` lagi.

### 3.2. Nested Data Objects (Objek Bersarang)

Untuk relasi kompleks, kita dapat menggunakan kelas Data di dalam kelas Data lainnya. Laravel Data mendukung Collection/DataCollection.

```php
<?php

declare(strict_types=1);

namespace App\Data;

use Spatie\LaravelData\Data;
use Spatie\LaravelData\Attributes\DataCollectionOf;
use Spatie\LaravelData\DataCollection;

class OrderData extends Data
{
    public function __construct(
        public readonly int $id,
        public readonly string $orderNumber,
        public readonly UserData $customer,
        
        #[DataCollectionOf(OrderItemData::class)]
        public readonly DataCollection $items,
        
        public readonly float $totalAmount,
    ) {}
}
```

### 3.3. Lazy Properties

Saat menggunakan Laravel Data sebagai API Resource, terkadang kita tidak ingin selalu menyertakan relasi kecuali diminta secara eksplisit. Fitur `Lazy` memecahkan masalah N+1 query dan ukuran payload.

```php
<?php

declare(strict_types=1);

namespace App\Data;

use Spatie\LaravelData\Data;
use Spatie\LaravelData\Lazy;
use App\Models\Post;

class PostData extends Data
{
    public function __construct(
        public readonly int $id,
        public readonly string $title,
        public readonly Lazy|UserData $author,
    ) {}
    
    public static function fromModel(Post $post): self
    {
        return new self(
            id: $post->id,
            title: $post->title,
            author: Lazy::create(fn() => UserData::from($post->author))
                ->defaultIncluded() // Jika eager loaded, maka sertakan
        );
    }
}
```

---

## 4. Anti-Patterns & Best Practices

Berikut adalah beberapa pola yang salah (Anti-Patterns) yang sering terjadi saat menggunakan `spatie/laravel-data` dan solusinya.

### 4.1. Anti-Pattern: Mengembalikan Model Eloquent langsung ke View/API (Leakage)

**❌ KODE SALAH (Membocorkan Model)**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\JsonResponse;

class UserController extends Controller
{
    public function show(int $id): JsonResponse
    {
        $user = User::findOrFail($id);
        
        // BAHAYA: Mengirimkan seluruh model Eloquent secara langsung.
        // Dapat membocorkan field sensitif seperti 'password' atau 'remember_token'
        // jika developer lupa menambahkannya ke dalam $hidden di Model.
        // Selain itu, jika skema database berubah, struktur API akan langsung berubah (breaking change).
        return response()->json($user);
    }
}
```

**✅ KODE BENAR (Menggunakan Data Object sebagai Transformer)**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use App\Data\UserData;
use Illuminate\Http\JsonResponse;

class UserController extends Controller
{
    public function show(int $id): JsonResponse
    {
        $user = User::findOrFail($id);
        
        // AMAN: Data object bertindak sebagai kontrak (contract) yang stabil.
        // Hanya field yang didefinisikan secara eksplisit dalam UserData yang akan diekspos.
        // Menyembunyikan kompleksitas database dan menjaga format JSON API konsisten.
        return response()->json([
            'data' => UserData::from($user)
        ]);
    }
}
```
**Penjelasan:** Mengirim Model Eloquent langsung ke response sangat berisiko membocorkan informasi sensitif. Jika suatu hari ada developer yang menambahkan kolom `api_key` atau `two_factor_secret` dan lupa mengupdate array `$hidden`, data tersebut akan bocor. Menggunakan Laravel Data menjamin hanya properti yang tertulis secara eksplisit yang di-export.

### 4.2. Anti-Pattern: Melakukan Query Database di dalam Kelas Data

**❌ KODE SALAH (Logic Leak di Data Class)**
```php
<?php

declare(strict_types=1);

namespace App\Data;

use Spatie\LaravelData\Data;
use App\Models\Role;

class RegistrationData extends Data
{
    public function __construct(
        public readonly string $email,
        public readonly int $roleId,
    ) {}
    
    // BAHAYA: Data Class seharusnya murni sebagai struktur data.
    // Menaruh query database di dalam Data class akan mempersulit testing,
    // dapat menyebabkan N+1 issue, dan melanggar prinsip Single Responsibility.
    public function getRoleName(): string
    {
        return Role::find($this->roleId)->name;
    }
}
```

**✅ KODE BENAR (Data Class murni untuk State, Logic di Service/Action)**
```php
<?php

declare(strict_types=1);

namespace App\Data;

use Spatie\LaravelData\Data;

class RegistrationData extends Data
{
    public function __construct(
        public readonly string $email,
        public readonly int $roleId,
    ) {}
    
    // Data class murni. Bebas dari business logic atau side-effects seperti query database.
}
```
**Penjelasan:** Objek Data (DTO) harus "bodoh" (dumb objects). Mereka hanya boleh berisi properti, validasi atribut, dan transformasi ringan (seperti cast tipe). Menggabungkan query atau business logic ke dalam objek Data (Active Record style) membuat kelas tersebut menjadi sulit dites dalam isolasi dan berisiko terkena masalah koneksi database saat instance tersebut dikirim antar service atau diserialisasi ke dalam queue.

---

## 5. Pengujian (Testing) dengan Pest v3

Dalam ekosistem modern, Pest v3 menjadi pilihan utama untuk pengujian PHP karena sintaksnya yang bersih dan ekspresif. Kita akan menguji arsitektur dan fungsionalitas dari implementasi kita.

### 5.1. Uji Arsitektur (Architecture Testing)

Kita menggunakan Pest Arch Testing untuk memastikan semua Data Object mengikuti standar dan tidak ada kebocoran (leak) logika database di dalamnya.

```php
<?php

declare(strict_types=1);

use Spatie\LaravelData\Data;

test('data objects must extend Spatie Data', function () {
    expect('App\Data')
        ->toBeClasses()
        ->toExtend(Data::class)
        ->toHaveSuffix('Data');
});

test('data objects must not contain database logic', function () {
    expect('App\Data')
        ->not->toUse('Illuminate\Support\Facades\DB')
        ->not->toUse('App\Models'); // Kecuali untuk type-hinting factory method
});

test('controllers must use data objects instead of form requests', function () {
    expect('App\Http\Controllers')
        ->not->toUse('Illuminate\Foundation\Http\FormRequest');
});

test('strict types must be enforced globally', function () {
    expect('App')
        ->toUseStrictTypes();
});
```

### 5.2. Unit Testing untuk Kelas Data (Validation)

Kita akan menguji bahwa validasi berjalan semestinya pada `UserData`.

```php
<?php

declare(strict_types=1);

use App\Data\UserData;
use App\Enums\UserRole;
use Illuminate\Validation\ValidationException;

it('validates successful user data creation', function () {
    $data = UserData::from([
        'id' => null,
        'name' => 'John Doe',
        'email' => 'john@example.com',
        'role' => UserRole::ADMIN->value,
    ]);
    
    expect($data)->toBeInstanceOf(UserData::class)
        ->and($data->name)->toBe('John Doe')
        ->and($data->role)->toBe(UserRole::ADMIN);
});

it('throws validation exception for invalid email', function () {
    UserData::from([
        'id' => null,
        'name' => 'John Doe',
        'email' => 'invalid-email-format',
        'role' => UserRole::USER->value,
    ]);
})->throws(ValidationException::class);

it('throws validation exception when name is too short', function () {
    UserData::from([
        'id' => null,
        'name' => 'Jo', // Min 3 karakter
        'email' => 'valid@example.com',
        'role' => UserRole::USER->value,
    ]);
})->throws(ValidationException::class);
```

### 5.3. Feature Testing untuk Endpoint Controller

Kita memvalidasi bahwa API Controller menerima data dan mengembalikannya dalam format JSON yang tepat.

```php
<?php

declare(strict_types=1);

use App\Models\User;
use App\Enums\UserRole;
use function Pest\Laravel\postJson;

it('can create a user via api endpoint and return expected format', function () {
    $payload = [
        'name' => 'Jane Smith',
        'email' => 'jane@example.com',
        'role' => UserRole::MANAGER->value,
    ];
    
    $response = postJson('/api/users', $payload);
    
    $response->assertStatus(201)
        ->assertJsonStructure([
            'message',
            'data' => [
                'name',
                'email',
                'role',
            ]
        ])
        ->assertJsonPath('data.name', 'Jane Smith')
        ->assertJsonPath('data.role', UserRole::MANAGER->value);
        
    expect(User::where('email', 'jane@example.com')->exists())->toBeTrue();
});

it('returns 422 unprocessable entity on validation failure', function () {
    $payload = [
        'name' => '', // Empty name not allowed
        'email' => 'jane@example.com',
        'role' => UserRole::MANAGER->value,
    ];
    
    $response = postJson('/api/users', $payload);
    
    $response->assertStatus(422)
        ->assertJsonValidationErrors(['name']);
});
```

### 5.4. Unit Testing untuk Action dengan Mock Repository

Kita akan memverifikasi bahwa Action class bekerja dengan benar dengan menggunakan mock (pengganti objek tiruan) dari Repository untuk menjamin unit test murni dan cepat, tanpa menyentuh database sungguhan.

```php
<?php

declare(strict_types=1);

use App\Actions\Users\CreateUserAction;
use App\Data\UserData;
use App\Enums\UserRole;
use App\Models\User;
use App\Repositories\Contracts\UserRepositoryInterface;

it('creates a user through the action class using mock repository', function () {
    // Arrange: Siapkan DTO
    $userData = new UserData(
        id: null,
        name: 'Alex Turner',
        email: 'alex@arctic.com',
        role: UserRole::USER
    );

    // Arrange: Buat mock instance dari User model
    $expectedUser = new User([
        'name' => 'Alex Turner',
        'email' => 'alex@arctic.com',
        'role' => UserRole::USER->value,
    ]);
    $expectedUser->id = 1;

    // Arrange: Mock Repository
    $repositoryMock = Mockery::mock(UserRepositoryInterface::class);
    $repositoryMock->shouldReceive('create')
        ->once()
        ->withArgs(function (array $attributes) {
            return $attributes['name'] === 'Alex Turner'
                && $attributes['email'] === 'alex@arctic.com'
                && isset($attributes['password']);
        })
        ->andReturn($expectedUser);

    // Act: Jalankan Action
    $action = new CreateUserAction($repositoryMock);
    $result = $action->execute($userData);

    // Assert: Verifikasi hasil
    expect($result)->toBeInstanceOf(User::class)
        ->and($result->name)->toBe('Alex Turner')
        ->and($result->id)->toBe(1);
});
```

---

## 6. Kesimpulan

`spatie/laravel-data` adalah komponen vital dalam membangun sistem backend yang skalabel dengan Laravel. Pendekatan ini menyelesaikan fragmentasi antara FormRequests, API Resources, dan DTO internal yang sering membuat pusing pengembang saat proyek membesar.

**Nilai Utama yang Didapatkan:**
1. **Type-Safety End-to-End**: Mulai dari HTTP payload hingga masuk ke database, tipe data dijamin sesuai.
2. **Pengurangan Boilerplate**: Tidak perlu lagi membuat Request dan Resource class yang isinya sangat identik.
3. **Mendukung Refactoring**: Karena setiap properti didefinisikan dengan jelas, refactoring dengan IDE menjadi jauh lebih mudah dan aman.
4. **Clean Architecture Fit**: Memisahkan layer HTTP dari business logic menjadi sangat natural karena DTO bisa dilempar ke service manapun tanpa mengikutkan komponen framework HTTP.
