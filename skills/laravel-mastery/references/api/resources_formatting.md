# Laravel API Resources & Data Formatting Mastery (Top 1% Quality)

## 1. Pendahuluan & Filosofi

Dalam pengembangan API skala enterprise, struktur respons JSON adalah sebuah **kontrak**. Klien API (Frontend, Mobile App, atau layanan pihak ketiga) sangat bergantung pada konsistensi struktur ini. Mengembalikan langsung Eloquent Model dari Controller adalah praktik yang buruk karena mengekspos struktur database, berisiko membocorkan data sensitif, dan membuat API menjadi rapuh terhadap perubahan skema database.

Laravel API Resources (`Illuminate\Http\Resources\Json\JsonResource` dan `ResourceCollection`) memberikan lapisan transformasi yang elegan dan terpusat. Lapisan ini bertindak sebagai jembatan yang menerjemahkan *domain entity* (Model) ke *data contract* (JSON).

Standar Top 1% dalam API Resources mewajibkan penggunaan PHP 8.3+, type-hinting ketat, serta pengkondisian relasi dan atribut untuk mencegah ekspektasi performa yang buruk seperti N+1 query problem dan ukuran payload yang membengkak (payload bloat).

## 2. Struktur Dasar & Clean Architecture

Dalam Clean Architecture, API Resource dipanggil di layer Controller setelah Action/Service/Repository memproses data. Lapisan Service tidak boleh mereturn JsonResource; service cukup mengembalikan Collection, Paginator, atau DTO independen, yang kemudian diterjemahkan oleh Resource di layer HTTP.

### Struktur Controller (Penempatan yang Tepat)
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\Api\V1\User\IndexUserRequest;
use App\Http\Resources\Api\V1\User\UserCollection;
use App\Services\User\UserQueryService;
use Illuminate\Http\JsonResponse;

final class UserController extends Controller
{
    public function __construct(
        private readonly UserQueryService $queryService
    ) {}

    public function index(IndexUserRequest $request): JsonResponse
    {
        $filters = $request->validated();
        
        $users = $this->queryService->paginateUsers(
            filters: $filters,
            perPage: 15
        );

        return (new UserCollection($users))
            ->response()
            ->setStatusCode(200);
    }
}
```

### Pembuatan Single Resource (`JsonResource`)

Resource tunggal harus mendeklarasikan tipe properti `$resource` melalui PHPDoc untuk mengaktifkan autocompletion di IDE dan analisis statis (PHPStan). Terapkan tipe array secara ketat.

```php
<?php

declare(strict_types=1);

namespace App\Http\Resources\Api\V1\User;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * @property User $resource
 */
final class UserResource extends JsonResource
{
    /**
     * Transform the resource into an array.
     *
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->resource->id,
            'name' => $this->resource->name,
            'email' => $this->resource->email,
            'status' => $this->resource->status->value, // Enum formatting
            'is_verified' => $this->resource->hasVerifiedEmail(),
            
            // Conditional Attributes (Hanya dikirim jika user yang auth adalah Admin)
            'phone' => $this->when(
                $request->user()?->isAdmin(),
                $this->resource->phone
            ),
            
            // Date formatting ISO 8601
            'created_at' => $this->resource->created_at?->toIso8601String(),
            'updated_at' => $this->resource->updated_at?->toIso8601String(),
            
            // Relasi (Conditional Loading)
            'profile' => new ProfileResource($this->whenLoaded('profile')),
            'roles' => RoleResource::collection($this->whenLoaded('roles')),
        ];
    }
}
```

### Pembuatan Collection (`ResourceCollection`) & Kustomisasi Meta

Ketika berurusan dengan endpoint *List* (Index), disarankan menggunakan class `ResourceCollection` kustom dibandingkan metode statis `::collection()`. Hal ini memungkinkan kustomisasi metadatan, properti wrap, dan format tambahan.

```php
<?php

declare(strict_types=1);

namespace App\Http\Resources\Api\V1\User;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\ResourceCollection;

final class UserCollection extends ResourceCollection
{
    /**
     * Indikasi Resource class yang digunakan.
     *
     * @var class-string<UserResource>
     */
    public $collects = UserResource::class;

    /**
     * Transform the resource collection into an array.
     *
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'data' => $this->collection,
            'meta' => [
                'api_version' => 'v1',
                'timestamp' => now()->toIso8601String(),
                'query_params' => $request->query(),
            ],
            // 'links' otomatis di-generate oleh Laravel saat instance berasal dari LengthAwarePaginator
        ];
    }
}
```

## 3. Best Practices & Fitur Lanjutan

### A. Conditional Loading Relasi (`whenLoaded`)
Pemuatan relasi ke dalam resource **wajib** menggunakan `$this->whenLoaded()`. Fitur ini mencegah masalah *N+1 queries* ketika resource dicetak tanpa relasi yang dimuat secara *eager* di Controller/Service.

```php
'posts' => PostResource::collection($this->whenLoaded('posts')),
'comments_count' => $this->whenCounted('comments'), // Menangani withCount()
```

### B. Merge & Pivot Attributes (`mergeWhen` & `whenPivotLoaded`)
Gunakan `mergeWhen` untuk menggabungkan sekumpulan atribut berdasarkan kondisi tertentu, menghindarkan kode duplikat dan logika kotor.

```php
$this->mergeWhen($request->user()?->isAdmin(), [
    'internal_score' => $this->resource->score,
    'risk_flag' => $this->resource->risk_flag,
]),
```

Untuk relasi *Many-to-Many*, akses pivot table dengan `whenPivotLoaded` secara aman:

```php
'pivot' => $this->whenPivotLoaded('role_user', function () {
    return [
        'assigned_at' => $this->resource->pivot->created_at?->toIso8601String(),
        'assigned_by' => $this->resource->pivot->assigned_by,
    ];
}),
```

### C. Standardisasi Wrapper (Root Element)
Secara default, Laravel membungkus data dalam atribut `data`. Praktik ini sesuai dengan spesifikasi format standar (seperti JSON:API atau JSend). Jika proyek memaksa untuk menghilangkan wrapper `data` secara parsial, lebih aman melakukannya via `JsonResource::withoutWrapping()` dalam `AppServiceProvider`, namun tidak disarankan karena akan merusak konsistensi saat data di-paginate (paginator membutuhkan meta & links paralel dengan data).

### D. Penanganan Formatting & Tipe Data
- **Timestamp**: Selalu format tanggal menggunakan ISO 8601 (`toIso8601String()`) agar di-parse di frontend tanpa ambiguitas zona waktu (terutama dengan library seperti date-fns atau moment).
- **Tipe Numerik & Boolean**: Lakukan eksplisit type-casting. String '0' dan int 0 adalah tipe yang berbeda di mobile native apps (Swift/Kotlin).
- **Polymorphic Relations**: Gunakan `$this->whenLoaded()` digabung dengan instansiasi dinamis berdasarkan class untuk merender resource polimorfik.
- **Null Safety**: API harus mereturn atribut dengan nilai `null` daripada menghilangkan atributnya sama sekali saat data kosong. Jangan membuang keys!

## 4. Anti-Patterns (❌ vs ✅)

### ❌ Anti-Pattern 1: Mengekspos Model Langsung Tanpa Resource
Mengekspos Eloquent model langsung ke respons dapat membocorkan kredensial, kolom tersembunyi (jika pengembang lupa menetapkan properti `$hidden`), dan menyebabkan integrasi klien hancur jika kolom database berubah namanya.

```php
// ❌ KODE SALAH
public function show(User $user): JsonResponse
{
    // Bahaya: seluruh data dari tabel (termasuk kolom pivot, flag internal) bisa bocor, 
    // juga tidak ada formatting pada tanggal atau enums.
    return response()->json($user);
}
```

```php
// ✅ KODE BENAR
public function show(User $user): JsonResponse
{
    // Aman: Data yang di-render di-filter ketat oleh DTO/Resource layer.
    return (new UserResource($user))
        ->response()
        ->setStatusCode(200);
}
```
**Penjelasan:** Dengan menggunakan API Resource, data yang diekspos dibatasi secara eksplisit melalui daftar izin (allow-list). Kontrak API menjadi stabil, memungkinkan pengembang Backend merubah schema DB tanpa mengganggu tim Frontend.

### ❌ Anti-Pattern 2: N+1 & Missing Conditional Loading di Resource
Sangat umum pengembang pemula memanggil relasi langsung menggunakan properti dinamis di dalam Resource, memaksa (lazy load) dan menghancurkan optimasi di lapisan Service.

```php
// ❌ KODE SALAH
public function toArray(Request $request): array
{
    return [
        'id' => $this->resource->id,
        // FATAL: Ini akan memicu lazy load relasi 'profile' di SETIAP iterasi dalam collection.
        // Jika terdapat 50 user, terjadi tambahan 50 query ke database.
        'profile' => new ProfileResource($this->resource->profile),
    ];
}
```

```php
// ✅ KODE BENAR
public function toArray(Request $request): array
{
    return [
        'id' => $this->resource->id,
        // TEPAT: Relasi hanya disertakan (di-render) jika telah di eager-load 
        // dengan `$query->with('profile')` di Controller atau Service.
        'profile' => new ProfileResource($this->whenLoaded('profile')),
    ];
}
```
**Penjelasan:** Tanpa `whenLoaded()`, model Eloquent akan menjalankan *magic accessor* untuk secara malas (lazy) mengambil data yang belum termuat (kecuali ada mode strict `$db->preventLazyLoading()`). Akibatnya respons memakan waktu sangat lama seiring bertambahnya data.

### ❌ Anti-Pattern 3: Format Waktu & Tipe Data Berantakan
Mengirimkan field timestamp langsung dari obyek Carbon sering menyebabkan format tergantung setelan default PHP, biasanya `"Y-m-d H:i:s"`. Hal ini fatal bagi aplikasi lintas zona waktu.

```php
// ❌ KODE SALAH
public function toArray(Request $request): array
{
    return [
        'is_active' => $this->resource->status === 'active' ? 1 : 0, // Frontend menerima int, bukan bool
        'created_at' => $this->resource->created_at, // Menghasilkan string: "2024-05-12 14:00:00"
    ];
}
```

```php
// ✅ KODE BENAR
public function toArray(Request $request): array
{
    return [
        'is_active' => $this->resource->status === 'active', // Frontend mendapat boolean ketat true/false
        // Mengubah objek Carbon ke ISO 8601 (ex: "2024-05-12T14:00:00.000000Z")
        'created_at' => $this->resource->created_at?->toIso8601String(), 
    ];
}
```
**Penjelasan:** Format ISO 8601 memiliki indikator timezone mutlak (seperti huruf `Z` untuk UTC). Parsing otomatis di Android, iOS, maupun JS client lebih tangguh dengan string jenis ini dan tidak akan bergeser saat perangkat user pindah zona waktu. Selalu hormati boolean dan integers sesuai tipe datanya, API tidak boleh menjawab boolean dengan nilai `"true"` atau `1`.

### ❌ Anti-Pattern 4: Bisnis Logika Bertumpuk dalam Resource
Resource semata-mata adalah formatter, bukan tempat mengambil keputusan bisnis, melakukan query tambahan, maupun perhitungan agresif.

```php
// ❌ KODE SALAH
public function toArray(Request $request): array
{
    return [
        'id' => $this->resource->id,
        // DILARANG KERAS: Resource melakukan query Database langsung atau hitungan berat.
        'total_spent' => DB::table('orders')->where('user_id', $this->resource->id)->sum('amount'),
    ];
}
```

```php
// ✅ KODE BENAR
public function toArray(Request $request): array
{
    return [
        'id' => $this->resource->id,
        // Atribut ini harus dihitung sebelumnya pada layer Service/Repository 
        // atau dikirim melalui method withSum() pada builder DB.
        'total_spent' => (float) $this->resource->orders_sum_amount,
    ];
}
```
**Penjelasan:** Mengizinkan query tereksekusi di dalam class Resource akan mematikan performa secara masif dan melanggar aturan Single Responsibility Principle (SRP). Jika memerlukan agregasi data, sediakan datanya di level model sebelum dilempar ke layer resource.

## 5. Pengujian dengan Pest v3 (Top 1% Quality)

Di tingkat arsitektur *Top 1%*, kelas API Resource diposisikan sebagai kontrak eksternal yang diuji keutuhan strukturnya. Kami melakukan Architecture Testing (untuk menjamin kedisiplinan direktori & konvensi) serta Unit Testing (untuk memvalidasi kondisional & mutasi string).

### Pest Unit Testing: Memvalidasi Struktur Resource

File: `tests/Unit/Http/Resources/Api/V1/User/UserResourceTest.php`

```php
<?php

declare(strict_types=1);

use App\Http\Resources\Api\V1\User\ProfileResource;
use App\Http\Resources\Api\V1\User\UserResource;
use App\Models\User;
use App\Models\UserProfile;
use Illuminate\Http\Request;

it('transforms user model to strictly typed array without relations', function () {
    // Arrange: Create stub/mock or factory instance
    $user = User::factory()->make([
        'id' => 101,
        'name' => 'John Doe',
        'email' => 'john@example.com',
        'status' => App\Enums\UserStatus::ACTIVE,
        'created_at' => now(),
    ]);

    $request = Request::create('/api/v1/users/101', 'GET');

    // Act
    $resource = new UserResource($user);
    $array = $resource->toArray($request);

    // Assert: Struktur data konsisten
    expect($array)
        ->toBeArray()
        ->toHaveKeys(['id', 'name', 'email', 'status', 'is_verified', 'created_at'])
        ->and($array['id'])->toBeInt()->toBe(101)
        ->and($array['is_verified'])->toBeBool()
        ->and($array['created_at'])->toBe($user->created_at->toIso8601String())
        ->and($array)->not->toHaveKey('profile'); // pastikan relasi skip by default
});

it('conditionally includes profile relation only when loaded explicitly', function () {
    $user = User::factory()
        ->has(UserProfile::factory(), 'profile')
        ->create();

    // Explicit Eager Load relasi (misalnya hasil dari repository layer)
    $user->load('profile');

    $request = Request::create('/api/v1/users/' . $user->id, 'GET');

    $resource = new UserResource($user);
    $array = $resource->toArray($request);

    expect($array)
        ->toHaveKey('profile')
        ->and($array['profile'])->toBeInstanceOf(ProfileResource::class);
});

it('exposes admin-only fields based on authorized user permission', function () {
    // Skenario dimana current auth user adalah Admin
    $admin = User::factory()->admin()->make();
    $targetUser = User::factory()->make(['phone' => '123456789']);

    $request = Request::create('/api/v1/users', 'GET');
    $request->setUserResolver(fn () => $admin);

    $resource = new UserResource($targetUser);
    $array = $resource->toArray($request);

    expect($array)
        ->toHaveKey('phone')
        ->and($array['phone'])->toBe('123456789');
});
```

### Pest Architecture Testing: Validasi Clean Architecture di Layer View/HTTP

Gunakan Pest Architect (Expectations) untuk menjamin Resource hanya berlokasi di direktori tertentu dan membatasi penyalahgunaan facade.

File: `tests/Feature/Architecture/ResourceArchitectureTest.php`

```php
<?php

declare(strict_types=1);

use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Http\Resources\Json\ResourceCollection;

arch('api resources must follow strict inheritance conventions')
    ->expect('App\Http\Resources')
    ->classes()
    ->toExtend(JsonResource::class)
    ->ignoring('App\Http\Resources\*\**Collection');

arch('api collections must strictly extend resource collection')
    ->expect('App\Http\Resources')
    ->classes()
    ->toExtend(ResourceCollection::class)
    ->ignoring('App\Http\Resources\*\**Resource');

arch('api resources must never perform database queries or business logic')
    ->expect('App\Http\Resources')
    ->not->toUse('Illuminate\Support\Facades\DB')
    ->not->toUse('Illuminate\Database\Eloquent\Builder')
    ->not->toUse('App\Services'); // Resource tidak boleh memanggil logic service!

arch('controllers must enforce strict dto formatting via resources')
    ->expect('App\Http\Controllers\Api')
    ->not->toReturn('Illuminate\Database\Eloquent\Model')
    ->not->toReturn('Illuminate\Database\Eloquent\Collection');
```

## 6. Security & Performance Checklist
Sebelum deployment (CI/CD pipelines), validasi manual/otomatis dari Resource harus mencakup:

1. **[ ] Type Safe Strictness:** `declare(strict_types=1);` aktif di semua file. Fungsi `toArray` wajib memiliki return-type `array`.
2. **[ ] Minimal Payload Footprint:** Hanya data yang dibutuhkan UI yang terkirim (jangan "dump & pray" semua data backend).
3. **[ ] Safe Null Defaults:** Tangani null property. Ubah value menjadi null, BUKAN menghapus atribut JSON tersebut (missing keys pada JSON merusak strongly typed deserializer pada frontend seperti Dart/Kotlin).
4. **[ ] Zero Implicit Queries (N+1 Proof):** Validasi penuh bahwa *semua* atribut relasi dilingkupi `whenLoaded()`. Tidak ada lazy load tanpa kesengajaan.
5. **[ ] Uniform Timezones:** Pakai standar waktu internasional (UTC) di aplikasi, serahkan format data sepenuhnya lewat `->toIso8601String()`.
6. **[ ] Architecture Isolations:** Tidak ada facade/koneksi DB atau *Services* yang dipanggil pada level klas Resource. Formatter hanya melakukan instruksi format.
