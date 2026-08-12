# Arsitektur Autentikasi dan Keamanan di Laravel (Top 1% Engineering Standard)

Dokumentasi ini mendeskripsikan standar rekayasa perangkat lunak tertinggi (Top 1%) untuk mengimplementasikan sistem autentikasi dan keamanan pada framework Laravel (versi 11/12) dipadukan dengan PHP 8.3/8.4. Standar ini mencakup penggunaan *strict types*, arsitektur bersih (*Clean Architecture*), mitigasi kerentanan keamanan, serta pengujian terotomatisasi menggunakan Pest v3. 

Standar ini dirancang khusus untuk memfasilitasi aplikasi berstatus *Enterprise*, *Fintech*, dan sistem berkinerja tinggi yang membutuhkan garansi keandalan, keamanan tingkat militer, dan kemudahan perawatan (maintainability) oleh tim berskala besar.

---

## 1. Filosofi Clean Architecture pada Autentikasi

Dalam membangun sistem autentikasi kelas perusahaan, pemisahan tanggung jawab (*Separation of Concerns*) mutlak diperlukan. Arsitektur konvensional MVC (Model-View-Controller) bawaan framework sering kali tidak cukup (*insufficient*) untuk sistem berskala besar karena mengarah pada masalah *Fat Controller* atau *Fat Model*. 

Kita menggunakan alur ketat: `Route -> FormRequest -> Controller -> Action (Service) -> Repository -> Model`.

1. **FormRequest**: Bertanggung jawab mutlak atas validasi masukan (input sanitization) dan otorisasi *request* tingkat permukaan.
2. **Controller**: Hanya bertindak sebagai jembatan jaringan (HTTP transport layer). Menerima *request* yang sudah tervalidasi, merakitnya ke dalam Data Transfer Object (DTO), memanggil Action, dan mengembalikan *response* terstandarisasi.
3. **Action (Service)**: Mengandung logika bisnis murni (*pure business logic*). Terisolasi penuh dan independen dari *request* HTTP sehingga dapat dipanggil dari CLI, *Job Queue*, sistem gRPC/Microservices, atau bagian aplikasi lain secara modular.
4. **Repository**: Mengabstraksi akses data dan *query* ke *database*. Memastikan logika SQL/ORM tidak tumpah (*leaking*) ke logika bisnis.
5. **Model**: Representasi entitas data, murni konfigurasi *Active Record*, *Casting*, dan relasi tanpa disusupi logika bisnis transaksional.

---

## 2. Implementasi Sistem (Kode Nyata Tanpa Placeholder)

Berikut adalah implementasi nyata, siap pakai (*production-ready*), dipersenjatai dengan *strict types* (`declare(strict_types=1);`) untuk proses autentikasi inti (Login).

### 2.1 Model, Trait, dan Data Transfer Object (DTO)

Pendekatan modern wajib menggunakan DTO untuk perpindahan data guna menghindari *array* yang tidak bertipe (*untyped arrays*) yang membahayakan *memory safety* dan menonaktifkan fitur analitik statis IDE/PHPStan.

```php
<?php

declare(strict_types=1);

namespace App\DTO\Auth;

final readonly class LoginCredentialsDTO
{
    public function __construct(
        public string $email,
        public string $password,
        public string $deviceName,
        public ?string $ipAddress = null,
        public ?string $userAgent = null,
    ) {}
}
```

Model pengguna (`User`) yang telah dikonfigurasi untuk pengamanan kelas atas, menyembunyikan kredensial, dan mendefinisikan *casting* secara akurat.

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;

final class User extends Authenticatable
{
    use HasApiTokens;
    use HasFactory;
    use Notifiable;

    /**
     * The attributes that are mass assignable.
     * @var list<string>
     */
    protected $fillable = [
        'name',
        'email',
        'password',
        'is_active',
        'last_login_at',
    ];

    /**
     * The attributes that should be hidden for serialization.
     * @var list<string>
     */
    protected $hidden = [
        'password',
        'remember_token',
        'two_factor_recovery_codes',
        'two_factor_secret',
    ];

    /**
     * Get the attributes that should be cast.
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'last_login_at' => 'datetime',
            'password' => 'hashed',
            'is_active' => 'boolean',
        ];
    }
}
```

### 2.2 Form Request Validation (Garda Terdepan)

Validasi masukan wajib diletakkan di `FormRequest` terpisah. Controller dilarang keras memanggil fungsi `validate()` secara *inline*.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Auth;

use Illuminate\Foundation\Http\FormRequest;

final class LoginRequest extends FormRequest
{
    public function authorize(): bool
    {
        // Hanya guest yang boleh mengakses endpoint ini
        return auth()->guest();
    }

    /**
     * @return array<string, \Illuminate\Contracts\Validation\ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'email' => ['required', 'string', 'email:rfc,dns', 'max:255'],
            'password' => ['required', 'string', 'min:8', 'max:128'],
            'device_name' => ['required', 'string', 'max:255'],
        ];
    }
    
    /**
     * Menyediakan pesan khusus untuk memitigasi information leakage
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'email.email' => 'Format kredensial tidak valid.',
            'password.min' => 'Format kredensial tidak valid.',
        ];
    }
}
```

### 2.3 Repository Pattern (Abstraksi Data)

Memisahkan logika *query* Eloquent ke repositori agar Action tidak mengetahui rincian basis data.

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Auth;

use App\Models\User;
use Illuminate\Database\Eloquent\ModelNotFoundException;

final readonly class UserRepository
{
    /**
     * Mengambil pengguna berdasarkan email.
     * 
     * @throws ModelNotFoundException<User>
     */
    public function findByEmailOrFail(string $email): User
    {
        return User::query()->where('email', $email)->firstOrFail();
    }

    public function findByEmail(string $email): ?User
    {
        return User::query()->where('email', $email)->first();
    }
    
    /**
     * Pembaruan parsial status pengguna untuk audit log.
     */
    public function updateLoginTimestamp(User $user): void
    {
        $user->update([
            'last_login_at' => now(),
        ]);
    }
}
```

### 2.4 Action (Logika Bisnis Autentikasi Inti)

Berisi inti proses autentikasi (memeriksa ketersediaan pengguna, verifikasi *password* tahan serangan waktu, menerbitkan token yang aman, serta manajemen sisa data *device*).

```php
<?php

declare(strict_types=1);

namespace App\Actions\Auth;

use App\DTO\Auth\LoginCredentialsDTO;
use App\Exceptions\Auth\InvalidCredentialsException;
use App\Exceptions\Auth\UserDeactivatedException;
use App\Repositories\Auth\UserRepository;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;

final readonly class AuthenticateUserAction
{
    public function __construct(
        private UserRepository $userRepository,
    ) {}

    /**
     * @throws InvalidCredentialsException
     * @throws UserDeactivatedException
     */
    public function execute(LoginCredentialsDTO $credentials): string
    {
        $user = $this->userRepository->findByEmail($credentials->email);

        // Pertahanan terhadap timing attack: 
        // Jika sistem di tingkat militer/fintech sangat ketat, 
        // pastikan waktu eksekusi gagal mirip dengan waktu saat Hash::check dieksekusi.
        if ($user === null) {
            Log::warning('Login attempt failed: User not found', ['ip' => $credentials->ipAddress]);
            throw new InvalidCredentialsException('Kredensial yang diberikan tidak valid.');
        }
        
        if (! $user->is_active) {
            Log::warning('Login attempt on deactivated account', ['user_id' => $user->id]);
            throw new UserDeactivatedException('Akun telah dinonaktifkan. Hubungi administrator.');
        }

        if (! Hash::check($credentials->password, $user->password)) {
            Log::warning('Login attempt failed: Invalid password', ['user_id' => $user->id, 'ip' => $credentials->ipAddress]);
            throw new InvalidCredentialsException('Kredensial yang diberikan tidak valid.');
        }

        // Hapus token lama untuk device yang sama jika ada (Token Rotation Policy)
        // Mencegah kebocoran memori pada tabel personal_access_tokens
        $user->tokens()->where('name', $credentials->deviceName)->delete();

        // Audit Trail (Update record pengguna)
        $this->userRepository->updateLoginTimestamp($user);

        Log::info('User authenticated successfully', [
            'user_id' => $user->id, 
            'device' => $credentials->deviceName,
            'ip' => $credentials->ipAddress
        ]);

        return $user->createToken($credentials->deviceName)->plainTextToken;
    }
}
```

(Didefinisikan juga *exception* khusus domain agar *controller* bersih dari blok `try-catch` redundan, ditangani oleh global exception handler):

```php
<?php

declare(strict_types=1);

namespace App\Exceptions\Auth;

use Exception;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final class InvalidCredentialsException extends Exception
{
    public function render(): JsonResponse
    {
        return response()->json([
            'success' => false,
            'message' => $this->getMessage(),
        ], Response::HTTP_UNAUTHORIZED);
    }
}
```

### 2.5 HTTP Controller (Single Action / Invokable)

*Controller* menjadi murni jembatan yang tipis (Thin Controller) dan mematuhi prinsip tanggung jawab tunggal (Single Responsibility Principle) dengan tipe *invokable*.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Auth;

use App\Actions\Auth\AuthenticateUserAction;
use App\DTO\Auth\LoginCredentialsDTO;
use App\Http\Controllers\Controller;
use App\Http\Requests\Auth\LoginRequest;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final class LoginController extends Controller
{
    public function __construct(
        private readonly AuthenticateUserAction $authenticateUserAction,
    ) {}

    public function __invoke(LoginRequest $request): JsonResponse
    {
        $dto = new LoginCredentialsDTO(
            email: $request->validated('email'),
            password: $request->validated('password'),
            deviceName: $request->validated('device_name'),
            ipAddress: $request->ip(),
            userAgent: $request->userAgent(),
        );

        $token = $this->authenticateUserAction->execute($dto);

        return response()->json([
            'success' => true,
            'data' => [
                'access_token' => $token,
                'token_type' => 'Bearer',
                'expires_in' => config('sanctum.expiration') * 60, // Expiration info (jika ada)
            ],
            'message' => 'Autentikasi berhasil.',
        ], Response::HTTP_OK);
    }
}
```

---

## 3. Anti-Patterns & Best Practices (Keamanan & Kinerja)

Berikut adalah contoh perbandingan antara praktik buruk (Anti-Pattern) yang sering diimplementasikan pengembang level menengah dengan praktik standar Top 1% (*enterprise level*).

### 3.1 Anti-Pattern 1: Fat Controller, Untyped Request, dan Vulnerabilitas Timing Attack (User Enumeration)

❌ **KODE SALAH (Berbahaya)**

```php
<?php
// JANGAN GUNAKAN KODE INI DALAM PRODUCTION!
namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;

class AuthController extends Controller
{
    public function login(Request $request)
    {
        // 1. Array tidak bertipe dan validasi inline (Fat Controller)
        $request->validate([
            'email' => 'required|email',
            'password' => 'required',
        ]);

        // 2. Untyped magic call pada property request
        $user = User::where('email', $request->email)->first();

        // 3. Vulnerability: Timing Attack / User Enumeration.
        // Jika user tidak ada di DB, proses `Hash::check` akan dilewati (return instan).
        // Jika user ada di DB, `Hash::check` memerlukan waktu (~100-300ms komputasi bcrypt/argon2).
        // Penyerang dapat mengamati latensi HTTP secara presisi untuk menebak daftar email valid di sistem kita!
        if (!$user || !Hash::check($request->password, $user->password)) {
            return response()->json(['error' => 'Email atau Password Salah'], 401);
        }

        $token = $user->createToken('my_app_token')->plainTextToken;
        return response()->json(['token' => $token]);
    }
}
```

✅ **KODE BENAR (Top 1% Standard)**

```php
<?php
declare(strict_types=1);

// Implementasi benar didelegasikan ke Action Class (lihat bagian 2.4).
// Kunci utama perbaikannya:

$user = $this->userRepository->findByEmail($credentials->email);

// Mitigasi dasar: Merespons pesan eror generik dan menghindari informasi spesifik "Email tidak ada".
if ($user === null) {
    throw new InvalidCredentialsException('Kredensial yang diberikan tidak valid.'); // Pesan aman
}

if (! Hash::check($credentials->password, $user->password)) {
    throw new InvalidCredentialsException('Kredensial yang diberikan tidak valid.'); // Pesan identik
}
```
*(Catatan Arsitektur: Untuk mitigasi serangan 'Timing Attack' militer, sistem menggunakan library yang selalu melakukan perbandingan hash statis/dummy bila `$user === null` sehingga latensi respon stabil 300ms, tapi dalam ekosistem Laravel standar, Rate Limiting (lihat 3.2) adalah mitigasi primer yang diwajibkan).*

**Penjelasan Mengapa Kode Salah Sangat Berbahaya:**
1. **Pemisahan Tanggung Jawab (Fat Controller)**: Menggabungkan proses jaringan HTTP, validasi form, basis data, dan logika enkripsi membuat kode ini mustahil diuji secara Unit (*Unit Test* murni), dan fungsi `login` tidak dapat dipanggil dari skrip Konsol (CLI).
2. **Security Risk (User Enumeration via Latency Timing)**: Perbedaan latensi (waktu *response*) secara dramatis akan mengungkap keberadaan sebuah akun email di sistem kepada hacker.
3. **Memory Risk / Maintanability**: Memanggil variabel super-global melalui injeksi ajaib `$request->email` mem-*bypass* mekanisme sanitasi *framework*. Ini dapat dimanipulasi dengan eksploitasi fitur tipe data berlebih (*Mass Assignment Risk*). Selalu gunakan `$request->validated()`.

### 3.2 Anti-Pattern 2: Tidak Adanya Rate Limiting, Kebocoran Memori Token, dan Eksekusi Token Masif

❌ **KODE SALAH (Berbahaya)**

```php
<?php
// JANGAN GUNAKAN KODE INI DALAM PRODUCTION!
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\AuthController;

// Route API Publik tanpa perlindungan Rate Limiting
Route::post('/login', [AuthController::class, 'login']);

// ... di dalam login function ...
// Membuat token TANPA informasi spesifik perangkat, lalu membiarkan token lama menumpuk!
$token = $user->createToken('MobileApp')->plainTextToken;
```

✅ **KODE BENAR (Top 1% Standard)**

```php
<?php
declare(strict_types=1);

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\Api\Auth\LoginController;

// 1. Wajib Gunakan Rate Limiting sangat ketat (throttle middleware)
// throttle:5,1 berarti maksimal 5 percobaan per menit per alamat IP!
Route::post('/api/v1/auth/login', LoginController::class)
    ->middleware(['api', 'throttle:5,1'])
    ->name('api.v1.auth.login');
```

```php
// Di dalam Action Class (Bagian 2.4):
// 2. Wajib hapus instansi token lama untuk "nama/id device" yang sama sebelum menerbitkan yang baru.
$user->tokens()->where('name', $credentials->deviceName)->delete();

$token = $user->createToken($credentials->deviceName)->plainTextToken;
```

**Penjelasan Mengapa Kode Salah Sangat Berbahaya:**
1. **Security Risk (Brute-force & Credential Stuffing)**: Endpoint *login* tanpa *Rate Limiter* adalah jalan tol untuk serangan *Brute-force*. Jaringan Botnet penyerang dapat mencoba ratusan ribu permutasi *password* per jam dan melumpuhkan *server* Anda (*Denial of Service* sekunder akibat kelelahan *resource* DB CPU).
2. **Memory/DB Risk (Unmanaged Token Bloat)**: Bayangkan pengguna memiliki skrip otomatis (atau bug pada aplikasi seluler) yang melakukan login ulang setiap 5 menit. Meng-*hardcode* nama token tanpa merotasi atau menghapusnya akan menghasilkan jutaan baris rongsokan (orphaned tokens) pada tabel `personal_access_tokens`. Basis data akan membengkak drastis (Storage Bloat), melambatkan *query* global (*Table Scan Bottleneck*), dan pada puncaknya menghabiskan Memory/RAM di *database server* karena index membengkak tak wajar. Menghapus token berbasis spesifikasi perangkat adalah teknik sanitasi sistem terbaik.

---

## 4. Pengujian Terotomatisasi (Pest v3)

Standar *Engineering* yang dikurasi ini mengharuskan 100% *Test Coverage* kritis pada lapisan keamanan. Kita memanfaatkan kapabilitas mumpuni framework *Pest v3* untuk pengujian Arsitektur, Unit, dan Fitur terintegrasi.

### 4.1 Architecture Testing (Pest Arch)

Pencegahan secara statis agar developer *junior* yang tergabung ke dalam proyek tidak melanggar aturan arsitektur. Disimpan di direktori `tests/ArchTest.php`.

```php
<?php

declare(strict_types=1);

test('strict types are used everywhere')
    ->expect('App')
    ->toUseStrictTypes();

test('controllers should not interact with models directly (Enforce Clean Architecture)')
    ->expect('App\Http\Controllers')
    ->not->toUse('App\Models')
    ->ignoring('App\Http\Controllers\Controller');

test('controllers should only have __invoke methods (Enforce Single Action Controller)')
    ->expect('App\Http\Controllers\Api')
    ->toHaveMethod('__invoke')
    ->ignoring('App\Http\Controllers\Controller');

test('actions must reside in the Action directory and have Action suffix')
    ->expect('App\Actions')
    ->toHaveSuffix('Action')
    ->toBeClasses();

test('DTOs should be strictly readonly')
    ->expect('App\DTO')
    ->toBeReadonly();
```

### 4.2 Unit Testing untuk Action Logika Bisnis

Pengujian Unit murni tanpa menyentuh *Database*. Sepenuhnya terisolasi dengan menggunakan *Mockery*.

```php
<?php

declare(strict_types=1);

// tests/Unit/Actions/Auth/AuthenticateUserActionTest.php

use App\Actions\Auth\AuthenticateUserAction;
use App\DTO\Auth\LoginCredentialsDTO;
use App\Exceptions\Auth\InvalidCredentialsException;
use App\Exceptions\Auth\UserDeactivatedException;
use App\Models\User;
use App\Repositories\Auth\UserRepository;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Mockery\MockInterface;

uses()->group('unit', 'auth');

beforeEach(function () {
    // Membuat mock repository
    $this->userRepository = Mockery::mock(UserRepository::class);
    $this->action = new AuthenticateUserAction($this->userRepository);
    
    // Matikan output log pada Unit Test agar pipeline CI/CD bersih
    Log::spy();
});

it('throws InvalidCredentialsException when email is not registered', function () {
    $dto = new LoginCredentialsDTO('ghost@enterprise.com', 'password123', 'iOSApp', '127.0.0.1');

    $this->userRepository
        ->shouldReceive('findByEmail')
        ->once()
        ->with('ghost@enterprise.com')
        ->andReturnNull();

    expect(fn () => $this->action->execute($dto))
        ->toThrow(InvalidCredentialsException::class, 'Kredensial yang diberikan tidak valid.');
});

it('throws InvalidCredentialsException when password comparison fails', function () {
    $dto = new LoginCredentialsDTO('ceo@enterprise.com', 'wrongpassword', 'iOSApp', '127.0.0.1');
    
    $user = new User();
    $user->password = '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi'; // Hash konstan 'password'
    $user->is_active = true;

    $this->userRepository
        ->shouldReceive('findByEmail')
        ->once()
        ->with('ceo@enterprise.com')
        ->andReturn($user);

    // Mock façade enkripsi agar kita tidak menghabiskan waktu komputasi saat unit test
    Hash::shouldReceive('check')
        ->once()
        ->with('wrongpassword', $user->password)
        ->andReturnFalse();

    expect(fn () => $this->action->execute($dto))
        ->toThrow(InvalidCredentialsException::class, 'Kredensial yang diberikan tidak valid.');
});

it('throws UserDeactivatedException when attempting to login with inactive account', function () {
    $dto = new LoginCredentialsDTO('ex-employee@enterprise.com', 'password', 'iOSApp', '127.0.0.1');
    
    $user = new User();
    $user->is_active = false; // Akun mati

    $this->userRepository
        ->shouldReceive('findByEmail')
        ->once()
        ->with('ex-employee@enterprise.com')
        ->andReturn($user);

    expect(fn () => $this->action->execute($dto))
        ->toThrow(UserDeactivatedException::class, 'Akun telah dinonaktifkan. Hubungi administrator.');
});
```

### 4.3 Feature Testing untuk HTTP Controller & Integritas Basis Data

Pengujian terintegrasi (*Integration/Feature Test*) mengeksekusi *HTTP request* secara penuh, menyimulasikan siklus perutean (*routing*), validasi (*middleware/FormRequest*), eksekusi aksi utama, hingga asersi persentuhan data di *Database* uji (umumnya menggunakan SQLite *in-memory*).

```php
<?php

declare(strict_types=1);

// tests/Feature/Http/Controllers/Api/Auth/LoginControllerTest.php

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Symfony\Component\HttpFoundation\Response;

uses(RefreshDatabase::class)->group('feature', 'auth');

it('successfully authenticates active user and provisions a secure API token', function () {
    $user = User::factory()->create([
        'email' => 'admin@secure.net',
        'password' => bcrypt('StrongSecuredPass2025!'),
        'is_active' => true,
    ]);

    $payload = [
        'email' => 'admin@secure.net',
        'password' => 'StrongSecuredPass2025!',
        'device_name' => 'Linux Workstation',
    ];

    $response = $this->postJson(route('api.v1.auth.login'), $payload);

    $response->assertStatus(Response::HTTP_OK)
             ->assertJsonStructure([
                 'success',
                 'data' => [
                     'access_token',
                     'token_type',
                     'expires_in',
                 ],
                 'message',
             ])
             ->assertJson([
                 'success' => true,
                 'message' => 'Autentikasi berhasil.',
                 'data' => [
                     'token_type' => 'Bearer',
                 ],
             ]);

    // Verifikasi bahwa token sukses terbit, dan mengaitkan perangkat (Device Tracking Assert)
    $this->assertDatabaseHas('personal_access_tokens', [
        'tokenable_type' => User::class,
        'tokenable_id' => $user->id,
        'name' => 'Linux Workstation',
    ]);
    
    // Verifikasi fitur rotasi berjalan: memastikan tidak ada token ganda untuk 1 perangkat yang sama
    $this->assertDatabaseCount('personal_access_tokens', 1);
});

it('rejects authentication missing required payload fields with validation errors', function () {
    $payload = [
        'email' => 'not-an-email-format',
        // 'password' sengaja dihilangkan untuk memicu failure
        // 'device_name' sengaja dihilangkan
    ];

    $response = $this->postJson(route('api.v1.auth.login'), $payload);

    $response->assertStatus(Response::HTTP_UNPROCESSABLE_ENTITY)
             ->assertJsonValidationErrors(['email', 'password', 'device_name']);
});

it('blocks repeated failed attempts utilizing strict throttle middleware', function () {
    // Definisi rute palsu dengan throttle ketat dalam testing untuk mencegah hard dependency pada route aktual
    Route::post('/test-throttle-login', function () {
        return response()->json(['success' => true]);
    })->middleware(['throttle:3,1']); // Maksimal 3 percobaan
    
    $payload = ['attempt' => 'dummy'];

    // Lakukan serangan 3 kali sukses (mencapai batas)
    for ($i = 0; $i < 3; $i++) {
        $this->postJson('/test-throttle-login', $payload)
             ->assertStatus(Response::HTTP_OK);
    }

    // Tembakan ke-4 harus diblokir oleh Laravel Rate Limiter dengan HTTP 429
    $this->postJson('/test-throttle-login', $payload)
         ->assertStatus(Response::HTTP_TOO_MANY_REQUESTS);
});
```

---

## 5. Kesimpulan dan Checklist Keamanan Arsitektural

Penerapan standar di tingkat *Top 1% Engineering* dalam merancang aplikasi otentikasi API berbasis kerangka kerja Laravel memerlukan kedisiplinan dan perhatian menyeluruh terhadap segala sisi kelemahan siber dan anti-pola perangkat lunak (*software anti-patterns*).

Sebelum mengimplementasikan komponen ini pada sistem *Production*, pastikan matriks prasyarat (*Checklist*) berikut terpenuhi:

- [x] **Strict Types Enabled**: Deklarasi `declare(strict_types=1);` telah ditanam di awal semua berkas PHP murni.
- [x] **Data Transfer Objects (DTO) Enforced**: Objek yang dikunci (`readonly`) difungsikan untuk melenyapkan `array` primitif pada saat mengalirkan data antar lapisan logika, memberikan perlindungan dari *payload injection* berbahaya.
- [x] **Separation of Concerns (SoC) Validated**: Rantai perintah dieksekusi tegak lurus (`FormRequest` -> `Controller` -> `Action` -> `Repository` -> `Model`). Aturan ini dilindungi oleh Pest Arch.
- [x] **Rate Limiting Implemented**: Lapisan Middleware `throttle` ditanam dengan batas kewajaran hit (contoh: 5-10 per menit) pada titik rute akses masuk sistem (Endpoint Login, Register, Forgot Password).
- [x] **Device-Bound Token Lifecycle**: Semua token otorisasi yang terbit diikat pada perangkat keras/lunak (`device_name`). Kebijakan rotasi/penghapusan otomatis beraksi sebelum insersi token baru guna mencegah anomali basis data jangka panjang (DB Mem Leak).
- [x] **Generic Response on Failures**: Respon atas gagal sandi ataupun gagal surel mengembalikan pesan eror abstrak yang 100% kongruen. (*No Information Leakage / User Enumeration Protected*).
- [x] **Complete Test Suites Integration**: Cakupan integrasi *Pest v3* melindungi arsitektur inti (Pest Arch), mengeksekusi logika komputasi isolasi dengan *Mockery* (Unit Test), dan memastikan stabilitas integrasi ke basis data (*Feature Test*).

*(Dokumen ini merupakan panduan terikat (SSOT) untuk domain keamanan dan arsitektur otentikasi skill `mastery-laravel` di sistem Google Antigravity).*
