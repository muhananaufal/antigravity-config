# 🚀 API Routing & Versioning Mastery (Laravel 11/12 & PHP 8.3+)

**Status:** `Production Ready` | **Version:** `v2.0` | **Target:** `Enterprise Architecture`

---

## 📖 1. Core Philosophy: Routing as the Application Gateway

Dalam arsitektur *Enterprise*, *Routing* bukan sekadar peta penunjuk arah dari URL ke Controller. *Routing* adalah **lapisan perbatasan (boundary layer)** pertama yang bertanggung jawab atas:
1. **Identifikasi Niat (Intent Identification):** Menangkap apa yang ingin dilakukan klien secara eksplisit melalui kombinasi HTTP Method dan URI.
2. **Traffic Control:** Rate limiting, throttling, dan deteksi dini *abuse* (DDoS mitigation).
3. **Contract Versioning:** Menjaga *backward compatibility* untuk klien lama tanpa menghambat evolusi sistem.
4. **Context Initialization:** Memulai *pipeline* Middleware (autentikasi, lokalisasi, *tenant identification*).

Di Laravel 11 dan 12, dengan hilangnya *boilerplate* yang berat dan transisi ke `bootstrap/app.php`, pengaturan *routing* menjadi lebih ringkas secara struktural namun menuntut kehati-hatian arsitektural yang lebih tinggi.

---

## 🏗️ 2. Arsitektur Routing Laravel 11/12

Sejak Laravel 11, struktur aplikasi disederhanakan. Konfigurasi routing dipusatkan di `bootstrap/app.php`. Untuk aplikasi API berskala besar, memecah file rute menjadi beberapa domain/modul adalah standar industri.

### Konfigurasi Gateway (`bootstrap/app.php`)

```php
<?php

declare(strict_types=1);

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Routing\Router;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
        then: function (Application $app) {
            /** @var Router $router */
            $router = $app->make('router');
            
            // Registrasi rute spesifik untuk versi V2
            $router->middleware('api')
                ->prefix('api/v2')
                ->group(base_path('routes/api_v2.php'));
                
            // Registrasi rute internal microservice (tanpa middleware auth eksternal)
            $router->middleware('internal')
                ->prefix('internal')
                ->group(base_path('routes/internal.php'));
        }
    )
    ->withMiddleware(function (Middleware $middleware) {
        $middleware->api(prepend: [
            \App\Http\Middleware\ForceJsonResponse::class,
            \App\Http\Middleware\CorrelationIdMiddleware::class,
        ]);
        
        $middleware->alias([
            'abilities' => \Laravel\Sanctum\Http\Middleware\CheckAbilities::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions) {
        // Exception handler configuration...
    })->create();
```

---

## 🔄 3. Strategi API Versioning: URI vs Accept Header

Terdapat dua aliran utama dalam versioning API. Kita membedah keduanya secara objektif.

### Pendekatan 1: URI Versioning (Direkomendasikan untuk Publik/B2B)
Pendekatan paling eksplisit dan mudah ditelusuri.
**Format:** `https://api.example.com/v1/users`

**Kelebihan:**
- Mudah digunakan dan diuji via browser/curl sederhana.
- Perutean *reverse-proxy* (Nginx/Cloudflare) lebih mudah dilakukan berbasis *path*.
- *Developer Experience* (DX) tinggi.

**Kekurangan:**
- Mengotori URL, melanggar purisme REST dimana URI harus mewakili *resource*, bukan versinya.

### Pendekatan 2: Header Versioning / Content Negotiation (Purist REST)
Menggunakan HTTP `Accept` header.
**Format:** `Accept: application/vnd.example.v1+json`

**Kelebihan:**
- URI tetap bersih (`/users`).
- Sangat sejalan dengan filosofi REST murni.

**Kekurangan:**
- Sulit di-*cache* oleh CDN biasa tanpa variasi header yang kompleks.
- Pengujian manual lebih merepotkan.

> **Rekomendasi Industri:** Gunakan **URI Versioning** untuk mayoritas kasus karena pragmatisme dan kemudahan *caching* di level infrastruktur.

---

## 🏛️ 4. Clean Architecture Implementation

Struktur routing dan controller harus mencerminkan delegasi tanggung jawab yang ketat. 

**Alur Clean Architecture:**
`Route` ➡️ `FormRequest` (Validasi) ➡️ `Controller` (HTTP Orchestration) ➡️ `Action/Service` (Business Logic) ➡️ `Repository/Model` (Data Access) ➡️ `Resource/DTO` (Output Formatting).

### Struktur File Route (`routes/api_v2.php`)
```php
<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\Api\V2\User\UserController;
use App\Http\Controllers\Api\V2\User\UserStatusController;

Route::middleware(['auth:sanctum', 'throttle:api'])->group(function () {
    // Domain: Users
    Route::prefix('users')->name('users.')->group(function () {
        Route::get('/', [UserController::class, 'index'])->name('index');
        Route::post('/', [UserController::class, 'store'])->name('store');
        Route::get('/{user}', [UserController::class, 'show'])->name('show');
        
        // Single Action Controllers untuk operasi spesifik
        Route::patch('/{user}/status', UserStatusController::class)->name('status.update');
    });
});
```

### Implementasi Controller (HTTP Orchestrator)
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V2\User;

use App\Actions\User\CreateUserAction;
use App\DataTransferObjects\User\CreateUserData;
use App\Http\Controllers\Controller;
use App\Http\Requests\Api\V2\User\StoreUserRequest;
use App\Http\Resources\Api\V2\User\UserResource;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final class UserController extends Controller
{
    /**
     * @param CreateUserAction $createUserAction
     */
    public function __construct(
        private readonly CreateUserAction $createUserAction
    ) {}

    /**
     * Create a new user.
     *
     * @param StoreUserRequest $request
     * @return JsonResponse
     */
    public function store(StoreUserRequest $request): JsonResponse
    {
        // 1. Controller hanya menerima data bersih yang sudah divalidasi
        $dto = CreateUserData::fromRequest($request);

        // 2. Mendelegasikan logika bisnis ke Action class
        $user = $this->createUserAction->execute($dto);

        // 3. Mengembalikan respons yang diformat oleh API Resource
        return response()->json([
            'message' => 'User created successfully.',
            'data' => new UserResource($user),
        ], Response::HTTP_CREATED);
    }
}
```

---

## 🚫 5. Anti-Patterns & Best Practices

### Anti-Pattern #1: "Fat Route Files" dengan Logika Bisnis (Closure Routing)

Menempatkan *business logic* atau kueri DB secara langsung di dalam file route sangat dilarang dalam aplikasi berskala besar. Menghambat pengujian, menghancurkan arsitektur, dan tidak bisa di-*cache* (`route:cache`).

❌ **KODE SALAH (The Anti-Pattern):**
```php
<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Route;
use App\Models\User;
use Illuminate\Http\Request;

// FAT ROUTE: Kueri DB dan logika di dalam file route
Route::post('/api/v1/users', function (Request $request) {
    $request->validate(['name' => 'required', 'email' => 'required|email']);
    
    $user = User::create($request->all());
    
    // Send email logic di route!
    Mail::to($user)->send(new WelcomeEmail($user));
    
    return response()->json($user);
});
```
*Penjelasan Kesalahan:* File route menjadi *God Object*, logika bisnis tidak bisa diuji secara terisolasi, HTTP Request tidak direpresentasikan dalam DTO, dan route cache akan gagal jika menggunakan Closure secara intensif.

✅ **KODE BENAR (The Clean Pattern):**
```php
<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\Api\V1\UserController;

// Route murni hanya sebagai pemetaan ke Controller
Route::post('/api/v1/users', [UserController::class, 'store']);
```
*Penjelasan Kebenaran:* Route bersih. `UserController::class` yang akan mendelegasikan HTTP request ke layer *Action*. File route aman di-*cache*.

### Anti-Pattern #2: Menyatukan Controller untuk Semua Versi API dengan Logika Bersyarat

Menggunakan satu Controller dan memeriksa versi request di dalam *method* (banyak percabangan `if ($version === 'v2')`). Ini melanggar **Single Responsibility Principle** dan **Open-Closed Principle**.

❌ **KODE SALAH (The Anti-Pattern):**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;

class UserController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $users = User::all();
        
        // Logika bersyarat untuk versioning! SANGAT BURUK.
        if ($request->header('X-API-Version') === 'v2') {
            return response()->json([
                'meta' => ['version' => 2],
                'data' => $users->map(fn($u) => ['full_name' => $u->first_name . ' ' . $u->last_name])
            ]);
        }
        
        return response()->json([
            'data' => $users->map(fn($u) => ['name' => $u->name])
        ]);
    }
}
```
*Penjelasan Kesalahan:* Kode menjadi *spaghetti*, sangat sulit dipelihara. Saat versi V3 muncul, kelas ini akan meledak ukurannya dan risiko merusak V1/V2 sangat tinggi saat memodifikasi untuk V3.

✅ **KODE BENAR (The Clean Pattern):**
Pisahkan *Namespace* berdasarkan versi. `App\Http\Controllers\Api\V1\UserController` dan `App\Http\Controllers\Api\V2\UserController`.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V2\User;

use App\Http\Controllers\Controller;
use App\Models\User;
use App\Http\Resources\Api\V2\User\UserCollection;
use Illuminate\Http\JsonResponse;

final class UserController extends Controller
{
    public function index(): JsonResponse
    {
        // Logika spesifik V2 terisolasi sempurna
        $users = clone App\Models\User::paginate(20);
        
        return response()->json(new UserCollection($users));
    }
}
```
*Penjelasan Kebenaran:* Evolusi versi bersifat aditif, tidak merusak. V1 dapat dipelihara (atau di-*deprecate*) sepenuhnya secara independen tanpa risiko *regression bugs* di V2.

---

## 🧪 6. Testing Strategy: Pest v3 (Unit & Architecture)

Untuk menjamin kualitas rute API dan memastikan batas arsitektur tidak dilanggar, kita menggunakan Pest v3 dengan fitur *Architecture Testing*.

### Architecture Testing (`tests/Architecture/ApiArchitectureTest.php`)
Memastikan Controller tidak memiliki ketergantungan silang antar versi dan tidak melanggar batasan layer.

```php
<?php

declare(strict_types=1);

use function Pest\Architecture\expect;

test('API V1 Controllers do not depend on V2')
    ->expect('App\Http\Controllers\Api\V1')
    ->not->toUse('App\Http\Controllers\Api\V2')
    ->not->toUse('App\Http\Resources\Api\V2');

test('Controllers are strictly typed and final')
    ->expect('App\Http\Controllers\Api')
    ->toBeClasses()
    ->toBeFinal()
    ->toUseStrictTypes();

test('Controllers only depend on Actions, Repositories, DTOs, and Resources')
    ->expect('App\Http\Controllers\Api')
    ->not->toUse('Illuminate\Support\Facades\DB') // Melarang DB call dari controller
    ->not->toUse('App\Models'); // Opsional: jika strict menggunakan Repository pattern
```

### Feature Testing Endpoint Routing (`tests/Feature/Api/V2/UserRoutingTest.php`)

```php
<?php

declare(strict_types=1);

use App\Models\User;
use Symfony\Component\HttpFoundation\Response;

use function Pest\Laravel\postJson;
use function Pest\Laravel\actingAs;

test('V2 User creation route responds accurately', function () {
    // Arrange
    $admin = clone User::factory()->admin()->create();
    $payload = [
        'first_name' => 'John',
        'last_name' => 'Doe',
        'email' => 'john.v2@example.com',
        'password' => 'SecurePassword123!',
    ];

    // Act
    $response = actingAs($admin, 'sanctum')
        ->postJson('/api/v2/users', $payload);

    // Assert
    $response->assertStatus(Response::HTTP_CREATED)
        ->assertJsonStructure([
            'message',
            'data' => [
                'id',
                'full_name', // Spek spesifik V2
                'email',
                'created_at'
            ]
        ])
        ->assertJsonPath('data.email', 'john.v2@example.com');
});

test('V2 User route is protected by rate limiting', function () {
    $admin = clone User::factory()->admin()->create();
    
    // Simulate hitting the rate limit
    for ($i = 0; $i < 61; $i++) {
        $response = actingAs($admin, 'sanctum')
            ->postJson('/api/v2/users', []);
    }

    $response->assertStatus(Response::HTTP_TOO_MANY_REQUESTS);
});
```

---

## ✅ 7. Production Checklist (Top 1% Standards)

Sebelum *deployment* ke level Enterprise, pastikan poin berikut terpenuhi:

- [ ] **Route Caching:** Menjalankan `php artisan route:cache` saat deployment (WAJIB tidak ada closure di route).
- [ ] **Rate Limiting:** Pastikan `throttle:api` atau kustom rate limiter diaplikasikan ke semua endpoint publik.
- [ ] **Strict Typing:** Semua file di bawah folder Controller, Action, dan Route menggunakan `declare(strict_types=1);`.
- [ ] **Resource Isolation:** Kelas `ApiResource` dan `FormRequest` juga diversioning dengan rapi (`App\Http\Resources\Api\V1\...`).
- [ ] **Correlation ID:** Menambahkan header `X-Correlation-ID` melalui middleware global untuk memudahkan *tracing logs* di Kibana/Datadog.
- [ ] **Graceful Deprecation:** Untuk versi API lama (misal V1), tambahkan header HTTP standar `Deprecation` dan `Link` (menuju dokumentasi migrasi) via middleware sebelum mematikannya secara total.
- [ ] **OpenAPI / Swagger:** File rute direpresentasikan dalam spek OpenAPI 3.1 yang di-generate otomatis via anotasi atau kode (misal menggunakan Scramble atau Scribe).

---
*Documented by: Antigravity AI | Domain: API Architecture | Framework: Laravel 11/12 | Language: PHP 8.3/8.4*
