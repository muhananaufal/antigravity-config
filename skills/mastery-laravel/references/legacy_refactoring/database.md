# Legacy Refactoring: Eksekusi Raw SQL, Fat Controller, & Database Abstraction ke Clean Architecture

Proyek Laravel legacy sering kali dijangkiti oleh **Fat Controllers** yang mengakses database secara langsung, **Raw SQL Queries** yang di-hardcode dengan string concatenation (memicu kerentanan SQL Injection), serta pemrosesan data tanpa batching (memicu Memory Exhaustion). Dokumen ini adalah spesifikasi arsitektur komprehensif, Top 1% Quality, yang mengatur standarisasi refactoring dari kode legacy yang buruk menjadi arsitektur modern berstandar enterprise menggunakan PHP 8.4 dan Laravel 11/12.

---

## 1. Konsep Utama: Security, Scalability, & Clean Architecture

Dalam sistem enterprise, ketergantungan langsung pada database driver (MySQL/PostgreSQL) via `DB::raw()` akan menghancurkan portabilitas. Selain itu, meletakkan kueri kompleks di dalam Controller melanggar **Single Responsibility Principle (SRP)**.

Arsitektur yang diwajibkan adalah pemisahan layer secara presisi:
1.  **FormRequest**: Validasi statis, sanitasi payload, aturan autorisasi request awal.
2.  **Controller**: Menangani siklus HTTP (Request/Response), memetakan FormRequest menjadi DTO (Data Transfer Object), memanggil Action/Service, mereturn standard HTTP Response.
3.  **Action/Service**: Mengandung logika bisnis murni, orkestrasi transaksi, dan validasi dinamis (domain-level).
4.  **Repository**: Abstraksi akses data. Controller dan Action DILARANG mengakses Model `::query()` secara langsung; semuanya harus melewati Repository Interface.
5.  **Model (Eloquent)**: Merepresentasikan struktur tabel, cast, relasi, dan local scope murni tanpa logika bisnis HTTP.

---

## 2. Implementasi Full Stack Clean Architecture

Berikut adalah implementasi end-to-end tanpa ada potongan kode yang hilang, mendemonstrasikan pencarian data (filtering) dengan aggregasi yang kompleks namun dieksekusi secara efisien dan aman.

### 2.1. Model (Eloquent) - `App\Models\User.php`

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

final class User extends Model
{
    use HasFactory;
    use SoftDeletes;

    protected $table = 'users';

    protected $fillable = [
        'name',
        'email',
        'status',
        'age',
        'role_id',
    ];

    protected function casts(): array
    {
        return [
            'age' => 'integer',
            'status' => 'string',
            'created_at' => 'immutable_datetime',
            'updated_at' => 'immutable_datetime',
            'deleted_at' => 'immutable_datetime',
        ];
    }

    /**
     * @return HasMany<Order, $this>
     */
    public function orders(): HasMany
    {
        return $this->hasMany(Order::class, 'user_id', 'id');
    }
}
```

### 2.2. FormRequest (Validation Layer) - `App\Http\Requests\User\GetActiveUsersRequest.php`

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\User;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

final class GetActiveUsersRequest extends FormRequest
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
            'min_age' => ['sometimes', 'integer', 'min:18', 'max:100'],
            'status' => ['sometimes', 'string', Rule::in(['active', 'banned', 'pending'])],
            'min_orders' => ['sometimes', 'integer', 'min:1', 'max:1000'],
            'per_page' => ['sometimes', 'integer', 'min:5', 'max:100'],
        ];
    }
}
```

### 2.3. DTO (Data Transfer Object) - `App\DTOs\User\UserFilterDTO.php`

```php
<?php

declare(strict_types=1);

namespace App\DTOs\User;

final readonly class UserFilterDTO
{
    public function __construct(
        public int $minAge,
        public string $status,
        public int $minOrders,
        public int $perPage,
    ) {
    }

    public static function fromRequest(array $validatedData): self
    {
        return new self(
            minAge: (int) ($validatedData['min_age'] ?? 18),
            status: (string) ($validatedData['status'] ?? 'active'),
            minOrders: (int) ($validatedData['min_orders'] ?? 1),
            perPage: (int) ($validatedData['per_page'] ?? 15),
        );
    }
}
```

### 2.4. Repository Layer (Interface & Implementation)

#### `App\Repositories\Contracts\UserRepositoryInterface.php`
```php
<?php

declare(strict_types=1);

namespace App\Repositories\Contracts;

use App\DTOs\User\UserFilterDTO;
use Illuminate\Pagination\LengthAwarePaginator;

interface UserRepositoryInterface
{
    public function getPaginatedUsersWithOrderStats(UserFilterDTO $filterDTO): LengthAwarePaginator;
}
```

#### `App\Repositories\Eloquent\UserRepository.php`
```php
<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use App\DTOs\User\UserFilterDTO;
use App\Models\Order;
use App\Models\User;
use App\Repositories\Contracts\UserRepositoryInterface;
use Illuminate\Pagination\LengthAwarePaginator;
use Illuminate\Support\Facades\DB;

final class UserRepository implements UserRepositoryInterface
{
    public function getPaginatedUsersWithOrderStats(UserFilterDTO $filterDTO): LengthAwarePaginator
    {
        // Menggunakan Eloquent Builder secara elegan dan aman dari SQL Injection
        return User::query()
            ->select('users.*')
            ->where('users.status', $filterDTO->status)
            ->where('users.age', '>=', $filterDTO->minAge)
            // Subquery terenkapsulasi secara aman, tanpa loop dan raw join kotor
            ->addSelect([
                'total_completed_orders' => Order::selectRaw('COUNT(*)')
                    ->whereColumn('user_id', 'users.id')
                    ->where('status', 'completed')
            ])
            // Memfilter berdasarkan hasil agregasi relasi dengan whereHas
            ->whereHas('orders', function ($query) use ($filterDTO) {
                $query->where('status', 'completed');
            }, '>=', $filterDTO->minOrders)
            ->orderByDesc('users.created_at')
            ->paginate($filterDTO->perPage);
    }
}
```

### 2.5. Action / Service Layer - `App\Actions\User\FetchActiveUsersAction.php`

```php
<?php

declare(strict_types=1);

namespace App\Actions\User;

use App\DTOs\User\UserFilterDTO;
use App\Repositories\Contracts\UserRepositoryInterface;
use Illuminate\Pagination\LengthAwarePaginator;
use Illuminate\Support\Facades\Log;

final readonly class FetchActiveUsersAction
{
    public function __construct(
        private UserRepositoryInterface $userRepository
    ) {
    }

    public function execute(UserFilterDTO $filterDTO): LengthAwarePaginator
    {
        // Business logic, telemetry, & logging dapat ditempatkan di sini
        Log::info('Fetching active users with order stats', [
            'status' => $filterDTO->status,
            'min_age' => $filterDTO->minAge,
        ]);

        return $this->userRepository->getPaginatedUsersWithOrderStats($filterDTO);
    }
}
```

### 2.6. Controller - `App\Http\Controllers\Api\UserController.php`

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Actions\User\FetchActiveUsersAction;
use App\DTOs\User\UserFilterDTO;
use App\Http\Controllers\Controller;
use App\Http\Requests\User\GetActiveUsersRequest;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final class UserController extends Controller
{
    public function index(
        GetActiveUsersRequest $request,
        FetchActiveUsersAction $fetchAction
    ): JsonResponse {
        $dto = UserFilterDTO::fromRequest($request->validated());
        
        $paginatedUsers = $fetchAction->execute($dto);
        
        return response()->json([
            'status' => 'success',
            'data' => $paginatedUsers->items(),
            'meta' => [
                'current_page' => $paginatedUsers->currentPage(),
                'last_page' => $paginatedUsers->lastPage(),
                'total' => $paginatedUsers->total(),
            ]
        ], Response::HTTP_OK);
    }
}
```

---

## 3. Anti-Patterns & Kesalahan Umum Mendalam (Danger Zones)

Bagian ini membongkar anti-patterns fatal yang sering dijumpai pada sistem legacy, menjabarkan ancamannya, dan memberikan substitusi solid dengan penjelasan teknisnya.

### ❌ Anti-Pattern 1: SQL Injection melalui String Concatenation di `DB::raw()`
Salah satu kecacatan paling berbahaya (OWASP Top 10) adalah penggabungan string variabel yang tidak disanitasi ke dalam klausa SQL murni.

#### ❌ KODE SALAH (Security Risk)
```php
<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use Illuminate\Support\Facades\DB;

class BadUserRepository 
{
    public function getSuspiciousUsers(string $status, string $userInputName): array
    {
        // BAHAYA: Variabel $userInputName digabung langsung.
        // Jika $userInputName berisi: "'; DROP TABLE users; --"
        // Database akan dieksekusi secara harfiah dan menghancurkan data.
        return DB::select(
            "SELECT * FROM users WHERE status = '" . $status . "' AND name LIKE '%" . $userInputName . "%'"
        );
    }
}
```
**Mengapa Berbahaya:** Serangan SQL Injection dapat dengan mudah mengeksploitasi concatenation ini, mem-bypass logika autentikasi, mengekstraksi data rahasia, atau menjatuhkan keseluruhan database (`DROP TABLE`). Tidak ada PDO Escaping yang dilakukan oleh Laravel jika ditulis seperti ini.

#### ✅ KODE BENAR (Parameterized Binding / Eloquent)
```php
<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use App\Models\User;
use Illuminate\Database\Eloquent\Collection;

class GoodUserRepository 
{
    public function getSuspiciousUsers(string $status, string $userInputName): Collection
    {
        // AMAN: Parameter di-bind secara otomatis oleh Laravel Eloquent melalui PDO prepare statements.
        return User::query()
            ->where('status', $status)
            ->where('name', 'LIKE', '%' . $userInputName . '%')
            ->get();
    }
}
```

---

### ❌ Anti-Pattern 2: Memory Exhaustion akibat Pemrosesan Tanpa Chunking / Cursor
Sistem legacy sering memuat puluhan ribu bahkan jutaan baris data ke dalam RAM melalui method `->all()` atau `->get()` sebelum melakukan mutasi/pemrosesan.

#### ❌ KODE SALAH (Memory Risk)
```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Models\User;

class BadProcessUsersJob
{
    public function handle(): void
    {
        // BAHAYA: Memuat 500,000+ baris data User ke dalam Array Objects di RAM PHP secara bersamaan.
        // Fatal Error: Allowed memory size of 134217728 bytes exhausted
        $users = User::all(); 

        foreach ($users as $user) {
            if ($user->age > 60) {
                $user->status = 'retired';
                $user->save();
            }
        }
    }
}
```
**Mengapa Berbahaya:** `User::all()` akan melakukan instansiasi ribuan objek Eloquent Model ke dalam RAM, menciptakan Memory Leak dan mengakibatkan aplikasi crash seketika (`Allowed memory size exhausted`). Ini menyebabkan downtime dan hilangnya ketersediaan (Availability OWASP).

#### ✅ KODE BENAR (Lazy Collections / Chunking / DB Cursor)
```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Models\User;
use Illuminate\Support\Facades\DB;

class GoodProcessUsersJob
{
    public function handle(): void
    {
        // AMAN 1: Memproses dengan Cursor (LazyCollection), memuat 1 record pada satu waktu
        foreach (User::where('age', '>', 60)->cursor() as $user) {
            $user->update(['status' => 'retired']);
        }
        
        // AMAN 2 (Bahkan Lebih Cepat): Menggunakan Bulk Update langsung di level SQL
        User::query()
            ->where('age', '>', 60)
            ->where('status', '!=', 'retired') // Defensive check
            ->update(['status' => 'retired']);
    }
}
```

---

### ❌ Anti-Pattern 3: N+1 Query Mutation di dalam Loop (Performance Risk)
Mengakses relasi objek tanpa Eager Loading (via metode dinamis Eloquent `->orders`) di dalam *loop* akan menghasilkan kueri SQL baru di setiap iterasi.

#### ❌ KODE SALAH (Performance Risk)
```php
<?php

declare(strict_types=1);

namespace App\Services;

use App\Models\User;
use Illuminate\Database\Eloquent\Collection;

class BadReportingService
{
    public function generateReport(): array
    {
        $users = User::where('status', 'active')->get();
        $report = [];

        foreach ($users as $user) {
            // BAHAYA: Mengakses ->orders (tanpa eager load) akan memicu 1 SQL query per loop.
            // Jika ada 1000 users, maka akan tereksekusi 1001 Queries (1 + 1000). (N+1 Problem)
            $totalAmount = $user->orders->sum('total_price');
            
            $report[] = [
                'user' => $user->name,
                'total_spent' => $totalAmount
            ];
        }

        return $report;
    }
}
```
**Mengapa Berbahaya:** Beban koneksi TCP ke Database Server akan meledak secara linear `O(N)`. 10,000 baris akan memicu 10,001 TCP Queries ke RDBMS, menaikkan I/O Load, menguras Connection Pool, dan menyebabkan database *Lock/Stall*.

#### ✅ KODE BENAR (Eager Loading dengan `withSum`)
```php
<?php

declare(strict_types=1);

namespace App\Services;

use App\Models\User;
use Illuminate\Support\Collection;

class GoodReportingService
{
    public function generateReport(): Collection
    {
        // AMAN: Memanfaatkan fungsi agregasi RDBMS secara asali tanpa memuat relasi penuh ke memori
        return User::query()
            ->where('status', 'active')
            // withSum secara otomatis membuat Subquery SQL `SUM(...)` dan menambahkan properti `orders_sum_total_price`
            ->withSum('orders', 'total_price') 
            ->get()
            ->map(function (User $user) {
                return [
                    'user' => $user->name,
                    'total_spent' => (float) ($user->orders_sum_total_price ?? 0.0),
                ];
            });
    }
}
```

---

## 4. Testing & Verifikasi Arsitektur Menggunakan Pest v3

Dalam standarisasi codebase enterprise, Unit Testing dan Architecture Testing wajib eksis secara absolut. Pest v3 memberikan fluiditas dan ketatnya pengecekan arsitektur (Arch Testing).

### 4.1. Architecture Testing (`tests/ArchTest.php`)
Memastikan aturan-aturan Clean Architecture dipertahankan selamanya. DILARANG menghapus *Arch Test* jika pipeline gagal.

```php
<?php

declare(strict_types=1);

test('models should not be accessed directly by controllers')
    ->expect('App\Models')
    ->not->toBeUsedIn('App\Http\Controllers')
    ->ignoring('App\Models\User'); // (Contoh Pengecualian: User model untuk auth user() diizinkan)

test('repositories must implement an interface')
    ->expect('App\Repositories\Eloquent')
    ->toImplement('App\Repositories\Contracts\UserRepositoryInterface')
    ->ignoring('App\Repositories\Eloquent\BaseRepository');

test('strict types must be enforced everywhere')
    ->expect('App')
    ->toUseStrictTypes();

test('no dead code or debugging functions exist in production')
    ->expect(['dd', 'dump', 'ray', 'env', 'print_r', 'var_dump'])
    ->not->toBeUsed();
```

### 4.2. Feature & Unit Testing (`tests/Feature/User/GetFilteredUsersTest.php`)
Memvalidasi fungsionalitas end-to-end tanpa berinteraksi dengan database sesungguhnya (menggunakan SQLite in-memory / RefreshDatabase trait).

```php
<?php

declare(strict_types=1);

use App\Models\User;
use App\Models\Order;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Symfony\Component\HttpFoundation\Response;

uses(RefreshDatabase::class)->in('Feature/User');

it('fetches active users correctly applying all business rules and filters', function () {
    // 1. Arrange: Siapkan Data Dummy & Kondisi Database
    $activeOldUser = User::factory()->create([
        'status' => 'active',
        'age' => 45,
    ]);
    
    // Memberikan 2 buah order completed
    Order::factory()->count(2)->create([
        'user_id' => $activeOldUser->id,
        'status' => 'completed',
    ]);

    $activeYoungUser = User::factory()->create([
        'status' => 'active',
        'age' => 20, // tidak memenuhi min_age 30
    ]);
    Order::factory()->create([
        'user_id' => $activeYoungUser->id,
        'status' => 'completed',
    ]);

    $bannedUser = User::factory()->create([
        'status' => 'banned',
        'age' => 50,
    ]);

    // 2. Act: Panggil API endpoint
    $response = $this->getJson('/api/v1/users?status=active&min_age=30&min_orders=1&per_page=10');

    // 3. Assert: Pastikan output memenuhi spesifikasi ketat HTTP & Business Logic
    $response->assertStatus(Response::HTTP_OK)
             ->assertJsonStructure([
                 'status',
                 'data' => [
                     '*' => ['id', 'name', 'status', 'age', 'total_completed_orders']
                 ],
                 'meta' => ['current_page', 'last_page', 'total']
             ])
             ->assertJsonPath('data.0.id', $activeOldUser->id)
             ->assertJsonCount(1, 'data') // Harus mereturn tepat 1 user (activeOldUser)
             ->assertJsonPath('meta.total', 1);
});

it('fails validation when providing invalid input types', function () {
    // 1. Arrange & Act
    $response = $this->getJson('/api/v1/users?min_age=not-an-integer&status=invalid_status');

    // 2. Assert
    $response->assertStatus(Response::HTTP_UNPROCESSABLE_ENTITY)
             ->assertJsonValidationErrors(['min_age', 'status']);
});
```

---

## Kesimpulan

Strategi Refactoring Legacy Code tidak sekadar mengubah sintaks `DB::raw()` menjadi `User::where()`. Melainkan, merupakan perbaikan desain secara komprehensif mulai dari masuknya request (FormRequest validation), orkestrasi pemrosesan (Action), dan penjagaan integritas data yang diakses via Repository Pattern. Membaca arsitektur secara arsitektural (Pest Arch), mendesain kode bertahan terhadap memori leak & N+1 (Defensive Querying), dan mencegah insersi injeksi secara total akan membawa legacy codebase menuju kualitas **Top 1% Engineering Standards**.
