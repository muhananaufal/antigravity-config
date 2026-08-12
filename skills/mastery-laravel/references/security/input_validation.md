# Panduan Komprehensif: Validasi Input dan Keamanan di Laravel 11/12

## Pendahuluan

Validasi input adalah garis pertahanan pertama (first line of defense) dalam membangun aplikasi web yang aman dan tangguh. Tanpa validasi yang ketat, aplikasi rentan terhadap berbagai serangan seperti SQL Injection, Cross-Site Scripting (XSS), Command Injection, dan Mass Assignment. Dalam ekosistem Laravel modern (versi 11 dan 12) dipadukan dengan PHP 8.3/8.4, pendekatan yang digunakan bukan sekadar memvalidasi data di layer Controller, melainkan menerapkan prinsip **Defense in Depth** dan **Clean Architecture**.

Dokumen ini adalah standarisasi Top 1% dalam mengimplementasikan validasi input. Kita tidak hanya membahas fitur standar Laravel, tetapi juga pola arsitektur, *typing* tingkat lanjut, hingga isolasi proses melalui *Form Requests*, *Data Transfer Objects* (DTOs), *Actions/Services*, dan lapisan repositori. 

---

## 1. Fondasi Keamanan: Mengapa Validasi Sangat Krusial?

Setiap data yang masuk ke dalam sistem web—baik dari *request body* (JSON/Form Data), *query parameters*, *headers*, hingga file *uploads*—bersifat "Tainted" (kotor dan tidak dapat dipercaya) sampai terbukti valid dan di-sanitasi.

Risiko jika mengabaikan validasi tingkat lanjut:
1.  **Mass Assignment Vulnerabilities:** Attacker menyusupkan *field* tersembunyi (seperti `is_admin = true`) dalam *payload* untuk mendapatkan eskalasi hak akses.
2.  **Type Juggling & Memory Issues:** Eksekusi kode rentan memakan memori tinggi karena pengiriman payload berukuran raksasa jika batasan panjang (*length*) tidak diatur secara eksplisit.
3.  **Data Corruption:** Format yang tidak standar merusak integritas di dalam sistem dan database (contoh: string kosong masuk sebagai status, atau array masuk di mana string diharapkan).

Dengan PHP 8.3/8.4, kewajiban kita adalah mengombinasikan *strict typing* (`declare(strict_types=1);`), *Readonly Classes*, *Enums*, dan *FormRequests* untuk memastikan "Data yang salah tidak akan pernah mencapai inti bisnis logika".

---

## 2. Arsitektur Validasi Input: Pendekatan Clean Architecture

Kita memisahkan tanggung jawab validasi dari logika bisnis. Alur sistem bekerja sebagai berikut:
`Route` -> `FormRequest (Validasi Eksternal)` -> `Controller (Orkestrasi)` -> `Action/Service (Logika Bisnis)` -> `Repository/Model (Persistensi)`.

### 2.1 Domain Enums

Gunakan enumerasi bawaan PHP 8.1+ untuk membatasi nilai yang diterima secara eksak, bukan validasi string semata.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Users\Enums;

enum UserRole: string
{
    case ADMIN = 'admin';
    case MANAGER = 'manager';
    case CUSTOMER = 'customer';

    public function label(): string
    {
        return match($this) {
            self::ADMIN => 'Administrator',
            self::MANAGER => 'Manager',
            self::CUSTOMER => 'Customer',
        };
    }
}

enum UserStatus: string
{
    case ACTIVE = 'active';
    case PENDING = 'pending';
    case BANNED = 'banned';
}
```

### 2.2 Form Request Validation (Garis Depan)

Gunakan *Form Request* khusus. Jangan pernah melakukan validasi `$request->validate()` di dalam *Controller*. Di Laravel 11/12, fungsionalitas Form Request dikembangkan lebih baik dengan kombinasi *attributes* dan tipe *built-in*.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Users;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Rules\Password;
use App\Domain\Users\Enums\UserRole;

final class RegisterUserRequest extends FormRequest
{
    /**
     * Tentukan otoritas pengguna.
     */
    public function authorize(): bool
    {
        // Contoh: Hanya dapat mendaftar jika belum login.
        return auth()->guest();
    }

    /**
     * Dapatkan aturan validasi untuk request.
     *
     * @return array<string, \Illuminate\Contracts\Validation\ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'first_name' => ['required', 'string', 'min:2', 'max:50', 'regex:/^[a-zA-Z\s\-]+$/'],
            'last_name' => ['nullable', 'string', 'min:2', 'max:50', 'regex:/^[a-zA-Z\s\-]+$/'],
            'email' => [
                'required',
                'string',
                'email:rfc,dns,spoof', // Validasi strict: spoof check & DNS MX record
                'max:255',
                Rule::unique('users', 'email'),
            ],
            'password' => [
                'required',
                'confirmed',
                // Password rules yang kuat untuk production
                Password::min(12)
                    ->letters()
                    ->mixedCase()
                    ->numbers()
                    ->symbols()
                    ->uncompromised(3), // Memastikan tidak ada di database kebocoran kata sandi
            ],
            'role' => [
                'required',
                Rule::enum(UserRole::class), // Hanya membolehkan nilai spesifik dari enum
            ],
            'ip_address' => ['nullable', 'ip'],
        ];
    }
    
    /**
     * Persiapkan data untuk validasi (Sanitasi Awal).
     */
    protected function prepareForValidation(): void
    {
        // Strip whitespace pada input email dan konversi ke lowercase
        $this->merge([
            'email' => strtolower(trim((string) $this->input('email', ''))),
            'first_name' => trim(strip_tags((string) $this->input('first_name', ''))),
            'last_name' => $this->has('last_name') 
                ? trim(strip_tags((string) $this->input('last_name'))) 
                : null,
            'ip_address' => $this->ip(), // Menyuntikkan IP secara internal untuk log
        ]);
    }
}
```

### 2.3 Data Transfer Object (DTO)

Setelah divalidasi oleh HTTP Request, jangan sembarangan mengoper tipe `array` (atau Collection) ke *Action Class*. Konversikan menjadi *Data Transfer Object* (DTO). PHP 8.3 Readonly classes membuat ini sangat aman dari mutasi tak terduga (*memory-safe and thread-safe logic*).

```php
<?php

declare(strict_types=1);

namespace App\Domain\Users\DTOs;

use App\Domain\Users\Enums\UserRole;

final readonly class RegisterUserData
{
    public function __construct(
        public string $firstName,
        public ?string $lastName,
        public string $email,
        public string $password,
        public UserRole $role,
        public ?string $ipAddress,
    ) {}

    /**
     * Konversi dari Form Request yang sudah tervalidasi.
     */
    public static function fromRequest(array $validatedData): self
    {
        return new self(
            firstName: $validatedData['first_name'],
            lastName: $validatedData['last_name'] ?? null,
            email: $validatedData['email'],
            password: $validatedData['password'],
            role: UserRole::from($validatedData['role']),
            ipAddress: $validatedData['ip_address'] ?? null,
        );
    }
}
```

### 2.4 Action Class (Logika Bisnis Terisolasi)

Logika inti pendaftaran diletakkan pada kelas Action. Karena kita menginjeksi DTO, kita mendapat jaminan kepastian tipe (*Type Safety*).

```php
<?php

declare(strict_types=1);

namespace App\Domain\Users\Actions;

use App\Domain\Users\DTOs\RegisterUserData;
use App\Domain\Users\Models\User;
use Illuminate\Support\Facades\Hash;
use App\Domain\Users\Repositories\UserRepositoryInterface;

final class RegisterUserAction
{
    public function __construct(
        private readonly UserRepositoryInterface $userRepository
    ) {}

    public function execute(RegisterUserData $data): User
    {
        // Pada titik ini, kita memiliki keyakinan 100% pada struktur data.
        $userData = [
            'first_name' => $data->firstName,
            'last_name' => $data->lastName,
            'email' => $data->email,
            'password' => Hash::make($data->password), // Enkripsi password
            'role' => $data->role->value,
            'registration_ip' => $data->ipAddress,
        ];

        return $this->userRepository->create($userData);
    }
}
```

### 2.5 Controller (Sutradara Proses)

Controller kini murni menangani masuknya request HTTP dan memberikan respons.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\Users\RegisterUserRequest;
use App\Domain\Users\DTOs\RegisterUserData;
use App\Domain\Users\Actions\RegisterUserAction;
use Illuminate\Http\JsonResponse;

final class AuthController extends Controller
{
    public function register(
        RegisterUserRequest $request,
        RegisterUserAction $action
    ): JsonResponse {
        // Validasi otomatis terjadi di RegisterUserRequest.
        // Konversi data array yang valid ke dalam representasi DTO ketat.
        $dto = RegisterUserData::fromRequest($request->validated());

        // Jalankan Action class.
        $user = $action->execute($dto);

        return response()->json([
            'status' => 'success',
            'message' => 'User registered successfully',
            'data' => [
                'user_id' => $user->id,
                'email' => $user->email,
            ],
        ], 201);
    }
}
```

---

## 3. Anti-Patterns: Kegagalan Fatal dalam Validasi

Untuk benar-benar menguasai keamanan validasi Laravel, Anda wajib menghindari anti-pattern berikut. Kode yang sekilas berjalan normal dapat menimbulkan bahaya *security* yang besar.

### Anti-Pattern 1: Request `all()` dan Mass Assignment

**❌ KODE SALAH (Berbahaya / Vulnerability: Mass Assignment & Over-posting)**

```php
<?php
// Di dalam controller
public function updateProfile(Request $request, User $user)
{
    // BAHAYA FATAL! 
    // Menggunakan $request->all() mengizinkan semua key/value dari request
    // untuk masuk tanpa filter. Jika Attacker menyisipkan 'is_admin' => 1
    // atau 'balance' => 999999, model akan mem-bypass validasi.
    $user->update($request->all());

    return response()->json(['message' => 'Profile updated!']);
}
```

**✅ KODE BENAR (Safe with Validated Attributes)**

```php
<?php
declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Users\UpdateProfileRequest;
use App\Domain\Users\Models\User;
use Illuminate\Http\JsonResponse;

final class ProfileController extends Controller
{
    public function updateProfile(UpdateProfileRequest $request, User $user): JsonResponse
    {
        // AMAN! $request->validated() HANYA mengembalikan field
        // yang secara tertulis dan definitif terdapat di rules() FormRequest.
        // Atribut beracun yang disuntikkan akan otomatis dibuang (Ignored).
        $user->update($request->validated());

        return response()->json(['message' => 'Profile updated safely!']);
    }
}
```

**Penjelasan Keamanan:**
Jika attacker mengirimkan `{"first_name":"Joko","is_admin":true}`. Metode salah `$request->all()` akan meneruskan `is_admin` ke model. Laravel secara teoretis mencegahnya dengan `fillable`, namun developer sering mendisable ini atau melakukan *unguard*. Metode yang benar `$request->validated()` membersihkan input dan membuang `is_admin` sepenuhnya karena field tersebut tidak dideklarasikan di dalam kelas Form Request.

---

### Anti-Pattern 2: Tidak Membatasi Tipe Data Array atau Ukuran Berkas

**❌ KODE SALAH (Memory Exhaustion & CPU DoS)**

```php
<?php
// Di dalam FormRequest
public function rules(): array
{
    return [
        'user_ids' => 'required|array',
        'document' => 'required|file', 
    ];
}
```

**✅ KODE BENAR (Strict Typing, Bounding & Mime Checks)**

```php
<?php
declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class ProcessDocumentsRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            // Membatasi array HANYA array of integer dan panjang maksimal 100 item.
            // Tanpa limit ini, attacker bisa mengirim 1 juta array dan menyebabkan PHP Out Of Memory.
            'user_ids' => ['required', 'array', 'max:100'],
            'user_ids.*' => ['required', 'integer', 'min:1'],
            
            // Validasi Mimetypes secara spesifik, ukuran max 5MB (5120 KB)
            // Memastikan dokumen pdf valid tanpa membiarkan shell scripts lolos.
            'document' => [
                'required',
                'file',
                'mimes:pdf,docx,jpg',
                'max:5120',
            ],
        ];
    }
}
```

**Penjelasan Keamanan / Memory Risk:**
Aturan dasar dalam pemrograman *secure* adalah "Unbounded is dangerous" (Tanpa batasan adalah bahaya). Aturan `required|array` tanpa limit mengizinkan *payload injection* ribuan data, memaksa *garbage collector* PHP bekerja berat (CPU Denial of Service) dan kehabisan memori. Limitasi pada elemen `max:100` adalah standar mutlak. Demikian pula pembatasan maksimal dari berkas (`max:5120`) menghemat alokasi buffer IO server dan menahan eksploitasi unggahan besar secara repetitif.

---

## 4. Architecture & Unit Testing Menggunakan Pest v3

Sebagai standar *Top Tier*, semua kode yang ditulis wajib melalui fase *Architecture Testing* dan *Feature/Unit Testing*. Kita menggunakan Pest v3 untuk pengujian efisien.

### 4.1 Architecture Testing (`tests/ArchTest.php`)

Kita memastikan tidak ada pengembang (developer) di tim yang melanggar arsitektur. Misal, dilarang memanggil `Validator` atau fungsi `request()` di dalam Model, atau DTO tidak memanggil HTTP Client.

```php
<?php

declare(strict_types=1);

arch('models do not use http requests')
    ->expect('App\Domain\Users\Models')
    ->not->toUse([
        'Illuminate\Http\Request',
        'request',
    ]);

arch('form requests should enforce strong typing')
    ->expect('App\Http\Requests')
    ->toHaveMethod('rules')
    ->toExtend('Illuminate\Foundation\Http\FormRequest');

arch('controllers must strictly depend on DTOs and Actions')
    ->expect('App\Http\Controllers')
    ->not->toUse('Illuminate\Support\Facades\Validator'); // Wajib memakai Form Request

arch('domain models strict types')
    ->expect('App\Domain')
    ->toUseStrictTypes();
```

### 4.2 Feature Testing Controller & Validation (`tests/Feature/Api/V1/AuthControllerTest.php`)

Kita menguji jalur kegagalan (validation rules bekerja) dan jalur berhasil.

```php
<?php

declare(strict_types=1);

use function Pest\Laravel\{postJson, assertDatabaseHas};
use App\Domain\Users\Enums\UserRole;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

it('requires complete fields to register', function () {
    $response = postJson('/api/v1/register', []);

    $response->assertStatus(422)
             ->assertJsonValidationErrors([
                 'first_name', 'email', 'password', 'role'
             ]);
});

it('rejects invalid email formats', function () {
    $response = postJson('/api/v1/register', [
        'first_name' => 'John',
        'email' => 'invalid-email',
        'password' => 'SecurePassw0rd!#123',
        'password_confirmation' => 'SecurePassw0rd!#123',
        'role' => UserRole::CUSTOMER->value,
    ]);

    $response->assertStatus(422)
             ->assertJsonValidationErrors(['email']);
});

it('rejects weak passwords', function () {
    $response = postJson('/api/v1/register', [
        'first_name' => 'John',
        'email' => 'john.doe@example.com',
        'password' => 'password123', // Tidak mengandung huruf besar, simbol
        'password_confirmation' => 'password123',
        'role' => UserRole::CUSTOMER->value,
    ]);

    $response->assertStatus(422)
             ->assertJsonValidationErrors(['password']);
});

it('successfully registers user with valid inputs and uses strict DTO', function () {
    $payload = [
        'first_name' => 'Alice',
        'last_name' => 'Smith', // Optional field tested
        'email' => 'alice.smith@example.com',
        'password' => 'Str0ngP@ssw0rd!2024',
        'password_confirmation' => 'Str0ngP@ssw0rd!2024',
        'role' => UserRole::MANAGER->value,
    ];

    $response = postJson('/api/v1/register', $payload);

    $response->assertStatus(201)
             ->assertJsonPath('data.email', 'alice.smith@example.com');

    // Pastikan data benar-benar tersimpan ke DB
    assertDatabaseHas('users', [
        'email' => 'alice.smith@example.com',
        'role' => UserRole::MANAGER->value,
    ]);
});
```

### 4.3 Unit Testing Action Class (`tests/Unit/Domain/Users/Actions/RegisterUserActionTest.php`)

Kita bisa memfalsifikasi (*fake/mock*) repositori untuk mengetes kelas *Action* murni tanpa menyentuh *Database*.

```php
<?php

declare(strict_types=1);

use App\Domain\Users\Actions\RegisterUserAction;
use App\Domain\Users\DTOs\RegisterUserData;
use App\Domain\Users\Enums\UserRole;
use App\Domain\Users\Models\User;
use App\Domain\Users\Repositories\UserRepositoryInterface;
use Illuminate\Support\Facades\Hash;
use Mockery\MockInterface;

it('creates user and hashes the password correctly', function () {
    // 1. Arrange Data
    $dto = new RegisterUserData(
        firstName: 'Bob',
        lastName: null,
        email: 'bob@example.com',
        password: 'PlainTextPassword',
        role: UserRole::ADMIN,
        ipAddress: '127.0.0.1'
    );

    $mockedUser = new User([
        'id' => 10,
        'first_name' => 'Bob',
        'email' => 'bob@example.com'
    ]);

    // 2. Setup Mock Repository
    $repositoryMock = test()->mock(UserRepositoryInterface::class, function (MockInterface $mock) use ($mockedUser) {
        $mock->shouldReceive('create')
             ->once()
             ->withArgs(function (array $data) {
                 // Verifikasi bahwa tipe diubah secara benar
                 expect($data['email'])->toBe('bob@example.com')
                       ->and($data['role'])->toBe('admin')
                       ->and(Hash::check('PlainTextPassword', $data['password']))->toBeTrue();
                       
                 return true;
             })
             ->andReturn($mockedUser);
    });

    // 3. Act
    $action = new RegisterUserAction($repositoryMock);
    $result = $action->execute($dto);

    // 4. Assert
    expect($result->id)->toBe(10)
          ->and($result->first_name)->toBe('Bob');
});
```

---

## 5. Kesimpulan dan Best Practices Tambahan

1. **Gunakan Validasi Berjenjang (Defense in Depth):** Mulai dari `FormRequest` untuk validasi format (Regex, Length, Types) -> `DTO` untuk tipe kuat -> `Action/Service` untuk logika validasi bisnis (seperti pengecekan saldo cukup atau stok tersedia).
2. **Jangan Percayai Apapun:** Implementasikan `strip_tags` atau `htmlspecialchars` di `prepareForValidation()` untuk input yang sering terpapar risiko XSS.
3. **Database Constraints sebagai Pelengkap:** Validasi aplikasi *HARUS* sinkron dengan constraint database (misalnya Foreign Key Constraint, Unique Index, dan panjang VARCHAR maksimum di schema tabel). Validasi Laravel bukanlah pengganti constraint tingkat database.

Dengan mengadopsi standar PHP 8.3/8.4 dengan Laravel 11/12 yang ketat ini, celah keamanan akibat input pengguna dapat diredam hampir pada tingkat nol (Zero-Tolerance Security Pattern).
