# Laravel 11/12 Eloquent Relationships & Advanced Database Architecture (PHP 8.3+)

*Comprehensive Guide to Eloquent Relationships, Eager Loading, N+1 Prevention, Polymorphic Relations, and Clean Architecture Integration.*

Dalam aplikasi Laravel skala enterprise, pengelolaan database dan relasi antar tabel merupakan core dari fungsionalitas sistem. Menggunakan Eloquent ORM dengan benar tidak hanya meningkatkan kecepatan development, tetapi juga memastikan performa query yang efisien dan codebase yang terstruktur rapi. Dokumen ini membahas deep dive ke dalam Eloquent relationships, anti-patterns umum, strategi caching relasi, dan integrasinya dengan **Clean Architecture (FormRequest -> Controller -> Action -> Repository -> Model)** dan testing menggunakan **Pest v3**.

## 1. Domain Modeling & Typed Eloquent Models (PHP 8.3+)

Sejak PHP 8.1+ dan Laravel 11/12, strongly typed properties dan return types merupakan standar wajib. Semua Eloquent Models harus merepresentasikan Domain Entity dengan *strict types* dan *casts* yang eksplisit.

### 1.1 Base Model Setup
```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Concerns\HasUlids;

abstract class BaseModel extends Model
{
    use HasFactory;
    use HasUlids;

    /**
     * Disable mass assignment protection temporarily for repositories.
     * Repositories or FormRequests should handle the authorization and validation.
     */
    protected $guarded = [];
}
```

### 1.2 Strongly Typed Models & Relationships

**User Model:**
```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Database\Eloquent\Relations\MorphMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Carbon\CarbonImmutable;

/**
 * @property string $id
 * @property string $name
 * @property string $email
 * @property CarbonImmutable|null $email_verified_at
 * @property string $password
 * @property CarbonImmutable $created_at
 * @property CarbonImmutable $updated_at
 */
final class User extends Authenticatable
{
    use HasApiTokens;
    use Notifiable;

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'email_verified_at' => 'immutable_datetime',
            'password' => 'hashed',
            'is_active' => 'boolean',
        ];
    }

    /**
     * @return HasOne<UserProfile, $this>
     */
    public function profile(): HasOne
    {
        return $this->hasOne(UserProfile::class);
    }

    /**
     * @return HasMany<Order, $this>
     */
    public function orders(): HasMany
    {
        return $this->hasMany(Order::class);
    }

    /**
     * @return MorphMany<ActivityLog, $this>
     */
    public function activityLogs(): MorphMany
    {
        return $this->morphMany(ActivityLog::class, 'subject');
    }
    
    protected function name(): Attribute
    {
        return Attribute::make(
            get: fn (string $value) => ucfirst($value),
            set: fn (string $value) => strtolower($value),
        );
    }
}
```

**Order Model (BelongsTo):**
```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

final class Order extends BaseModel
{
    protected function casts(): array
    {
        return [
            'total_amount' => 'decimal:2',
            'placed_at' => 'immutable_datetime',
            'status' => OrderStatus::class, // Backed Enum
        ];
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /**
     * @return HasMany<OrderItem, $this>
     */
    public function items(): HasMany
    {
        return $this->hasMany(OrderItem::class);
    }
}
```

## 2. Advanced Relationship Types

### 2.1 Polymorphic Relationships

Polymorphic relations mengizinkan sebuah model untuk belong to ke lebih dari satu tipe model lain dalam satu asosiasi yang sama.

**ActivityLog Model:**
```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Relations\MorphTo;

final class ActivityLog extends BaseModel
{
    protected function casts(): array
    {
        return [
            'properties' => 'array',
        ];
    }

    /**
     * @return MorphTo<Model, $this>
     */
    public function subject(): MorphTo
    {
        return $this->morphTo();
    }
}
```

**Mendaftarkan Morph Map (di AppServiceProvider.php):**
Mencegah FQCN (Fully Qualified Class Name) disimpan di database untuk `subject_type`, sehingga memudahkan refactoring class namespace di masa depan.
```php
<?php

declare(strict_types=1);

namespace App\Providers;

use Illuminate\Database\Eloquent\Relations\Relation;
use Illuminate\Support\ServiceProvider;
use Illuminate\Database\Eloquent\Model;

final class AppServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        // Enforce strict mode in non-production environments
        Model::shouldBeStrict(! $this->app->isProduction());

        Relation::enforceMorphMap([
            'user' => \App\Models\User::class,
            'order' => \App\Models\Order::class,
            'product' => \App\Models\Product::class,
        ]);
    }
}
```

### 2.2 Many-to-Many with Pivot Data

Ketika menggunakan relasi Many-to-Many, seringkali kita butuh menyimpan data di tabel pivot (tabel perantara).

**Role & Permission Example:**
```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Relations\BelongsToMany;

final class Role extends BaseModel
{
    /**
     * @return BelongsToMany<Permission, $this>
     */
    public function permissions(): BelongsToMany
    {
        return $this->belongsToMany(Permission::class)
            ->withPivot(['granted_by', 'granted_at'])
            ->withTimestamps()
            ->using(RolePermissionPivot::class); // Gunakan custom pivot model
    }
}
```

**Custom Pivot Model:**
```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Relations\Pivot;

final class RolePermissionPivot extends Pivot
{
    protected $table = 'permission_role';

    protected function casts(): array
    {
        return [
            'granted_at' => 'immutable_datetime',
        ];
    }
}
```


## 3. 🚨 Anti-Patterns & Best Practices

Berikut adalah beberapa anti-pattern mematikan dalam penggunaan Eloquent yang sering tidak disadari developer dan bagaimana memperbaikinya.

### 3.1 🚨 Anti-Pattern 1: The N+1 Query Problem in Loops

Masalah paling umum dalam ORM adalah N+1 queries. Mengakses relasi di dalam loop tanpa eager loading akan mengeksekusi query database untuk setiap iterasi.

❌ **KODE SALAH (N+1 Query Problem)**
```php
// Action / Controller
public function generateReport(): array
{
    $orders = Order::where('status', OrderStatus::COMPLETED)->get(); // 1 Query
    
    $report = [];
    foreach ($orders as $order) {
        // ERROR: Men-trigger 1 query untuk setiap order. Jika ada 1000 orders = 1001 queries!
        $report[] = [
            'order_id' => $order->id,
            'customer_name' => $order->user->name, 
            'total_items' => $order->items->count(), // ERROR: Query count di-trigger berulang
        ];
    }
    
    return $report;
}
```

✅ **KODE BENAR (Eager Loading & Aggregate Relations)**
```php
// Action / Repository
public function generateReport(): array
{
    // Menggunakan eager loading (with) dan withCount untuk agregasi yang efisien
    // Hanya mengeksekusi maksimal 2-3 query terlepas dari jumlah order.
    $orders = Order::query()
        ->where('status', OrderStatus::COMPLETED)
        ->with(['user:id,name']) // Eager load spesifik kolom untuk hemat memori
        ->withCount('items') // Melakukan COUNT() di level query SQL, bukan di memory PHP
        ->get();
    
    $report = [];
    foreach ($orders as $order) {
        $report[] = [
            'order_id' => $order->id,
            'customer_name' => $order->user->name, 
            'total_items' => $order->items_count, // Hasil dari withCount('items')
        ];
    }
    
    return $report;
}
```
**Penjelasan:** Menggunakan `with()` memuat semua relasi secara bersamaan dalam satu atau dua query (`SELECT * FROM users WHERE id IN (...)`). Menggunakan `withCount()` menghasilkan agregasi subquery yang jauh lebih ringan daripada memuat seluruh koleksi relasi. Di Laravel 11/12, `Model::preventLazyLoading(!app()->isProduction())` di `AppServiceProvider` akan melempar Exception jika terjadi N+1.

### 3.2 🚨 Anti-Pattern 2: Business Logic & Heavy Queries in Controllers

Meletakkan query database yang kompleks atau logic bisnis di dalam Controller melanggar Single Responsibility Principle (SRP) dan membuat kode tidak bisa di-test (untestable) secara unit.

❌ **KODE SALAH (Fat Controller & Direct Model Usage)**
```php
// OrderController.php
public function store(Request $request)
{
    // 1. Validasi manual tanpa FormRequest
    $request->validate(['user_id' => 'required', 'product_id' => 'required', 'qty' => 'required']);
    
    // 2. Query DB langsung di Controller
    $product = Product::find($request->product_id);
    if ($product->stock < $request->qty) {
        return response()->json(['error' => 'Out of stock'], 400);
    }
    
    // 3. Logic Bisnis & Transaksi di Controller
    DB::beginTransaction();
    try {
        $order = Order::create([
            'user_id' => $request->user_id,
            'total_amount' => $product->price * $request->qty,
            'status' => 'pending'
        ]);
        
        OrderItem::create([
            'order_id' => $order->id,
            'product_id' => $product->id,
            'qty' => $request->qty,
            'price' => $product->price
        ]);
        
        $product->decrement('stock', $request->qty);
        
        DB::commit();
        return response()->json(['message' => 'Order created', 'data' => $order], 201);
    } catch (\Exception $e) {
        DB::rollBack();
        return response()->json(['error' => 'Failed'], 500);
    }
}
```

✅ **KODE BENAR (Clean Architecture: Request -> Controller -> Action/Service -> Repository)**

**1. Form Request (Validasi Input):**
```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class StoreOrderRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // Biasanya ditangani Policy/Middleware
    }

    public function rules(): array
    {
        return [
            'user_id' => ['required', 'string', 'exists:users,id'],
            'items' => ['required', 'array', 'min:1'],
            'items.*.product_id' => ['required', 'string', 'exists:products,id'],
            'items.*.qty' => ['required', 'integer', 'min:1'],
        ];
    }
}
```

**2. Data Transfer Object (DTO):**
```php
<?php

declare(strict_types=1);

namespace App\DTOs;

final readonly class CreateOrderData
{
    public function __construct(
        public string $userId,
        public array $items,
    ) {}
}
```

**3. Action / Service (Business Logic):**
```php
<?php

declare(strict_types=1);

namespace App\Actions\Orders;

use App\DTOs\CreateOrderData;
use App\Models\Order;
use App\Models\OrderStatus;
use App\Repositories\Contracts\OrderRepositoryInterface;
use App\Repositories\Contracts\ProductRepositoryInterface;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpKernel\Exception\UnprocessableEntityHttpException;

final class CreateOrderAction
{
    public function __construct(
        private readonly OrderRepositoryInterface $orderRepository,
        private readonly ProductRepositoryInterface $productRepository,
    ) {}

    public function execute(CreateOrderData $data): Order
    {
        return DB::transaction(function () use ($data) {
            $totalAmount = 0.0;
            $orderItemsData = [];

            foreach ($data->items as $item) {
                // Gunakan lockForUpdate untuk mencegah Race Condition saat cek stok
                $product = $this->productRepository->findByIdWithLock($item['product_id']);
                
                if (! $product || $product->stock < $item['qty']) {
                    throw new UnprocessableEntityHttpException("Product {$item['product_id']} is out of stock.");
                }

                $subtotal = $product->price * $item['qty'];
                $totalAmount += $subtotal;

                $orderItemsData[] = [
                    'product_id' => $product->id,
                    'qty' => $item['qty'],
                    'price' => $product->price,
                    'subtotal' => $subtotal,
                ];

                $this->productRepository->decrementStock($product->id, $item['qty']);
            }

            return $this->orderRepository->createWithItems(
                userId: $data->userId,
                totalAmount: $totalAmount,
                status: OrderStatus::PENDING,
                itemsData: $orderItemsData
            );
        });
    }
}
```

**4. Repository (Database Operations):**
```php
<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use App\Models\Order;
use App\Models\OrderStatus;
use App\Repositories\Contracts\OrderRepositoryInterface;

final class EloquentOrderRepository implements OrderRepositoryInterface
{
    public function createWithItems(string $userId, float $totalAmount, OrderStatus $status, array $itemsData): Order
    {
        $order = Order::create([
            'user_id' => $userId,
            'total_amount' => $totalAmount,
            'status' => $status,
        ]);

        $order->items()->createMany($itemsData);

        return $order->load('items');
    }
}
```

**5. Slim Controller:**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Actions\Orders\CreateOrderAction;
use App\DTOs\CreateOrderData;
use App\Http\Controllers\Controller;
use App\Http\Requests\StoreOrderRequest;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final class OrderController extends Controller
{
    public function __construct(
        private readonly CreateOrderAction $createOrderAction
    ) {}

    public function store(StoreOrderRequest $request): JsonResponse
    {
        $data = new CreateOrderData(
            userId: $request->validated('user_id'),
            items: $request->validated('items'),
        );

        $order = $this->createOrderAction->execute($data);

        return response()->json([
            'message' => 'Order created successfully',
            'data' => $order,
        ], Response::HTTP_CREATED);
    }
}
```
**Penjelasan:** Pemisahan responsibilitas membuat *Controller* murni hanya menangani HTTP I/O. *FormRequest* validasi input secara deklaratif. *Action* menampung business rules dan transaksi. *Repository* menyembunyikan implementasi ORM spesifik. Ini memungkinkan pembuatan unit test secara independen menggunakan mocking dan fakes.

## 4. Pest v3 Testing (Architecture & Feature)

Testing modern di Laravel harus melibatkan testing Arsitektur (memastikan standar dipatuhi) dan Feature Testing dengan pendekatan Pest yang ekspresif.

### 4.1 Architecture Testing (tests/ArchTest.php)

Pest menyediakan fitur Arch Testing yang brilian untuk menegakkan struktur dan style kode secara otomatis.

```php
<?php

declare(strict_types=1);

arch('strict types are enforced')
    ->expect('App')
    ->toUseStrictTypes();

arch('controllers must not use models directly')
    ->expect('App\Http\Controllers')
    ->not->toUse('App\Models')
    ->ignoring('App\Models\User'); // Pengecualian misal untuk auth user

arch('actions must be final and independent of HTTP layer')
    ->expect('App\Actions')
    ->toBeFinal()
    ->not->toUse(['Illuminate\Http', 'App\Http\Requests']);

arch('repositories implement interfaces')
    ->expect('App\Repositories\Eloquent')
    ->toImplement('App\Repositories\Contracts')
    ->toHaveSuffix('Repository');

arch('avoid open debug statements')
    ->expect(['dd', 'dump', 'ray', 'var_dump'])
    ->not->toBeUsed();
```

### 4.2 Feature Testing with Fakes & Factories (tests/Feature/Orders/CreateOrderTest.php)

Gunakan factory setup modern dan pest functions `it()` atau `test()`.

```php
<?php

declare(strict_types=1);

use App\Models\Product;
use App\Models\User;
use App\Models\OrderStatus;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Symfony\Component\HttpFoundation\Response;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->user = User::factory()->create();
    $this->product = Product::factory()->create([
        'price' => 100.00,
        'stock' => 50,
    ]);
});

it('creates an order successfully through the API', function () {
    // Arrange
    $payload = [
        'user_id' => $this->user->id,
        'items' => [
            [
                'product_id' => $this->product->id,
                'qty' => 2,
            ],
        ],
    ];

    // Act
    $response = $this->actingAs($this->user)->postJson('/api/orders', $payload);

    // Assert API Response
    $response->assertStatus(Response::HTTP_CREATED)
             ->assertJsonPath('message', 'Order created successfully')
             ->assertJsonStructure(['data' => ['id', 'total_amount', 'status']]);

    // Assert Database state
    $this->assertDatabaseHas('orders', [
        'user_id' => $this->user->id,
        'total_amount' => 200.00,
        'status' => OrderStatus::PENDING->value,
    ]);

    $this->assertDatabaseHas('order_items', [
        'product_id' => $this->product->id,
        'qty' => 2,
        'price' => 100.00,
        'subtotal' => 200.00,
    ]);

    // Assert side-effects (stock deduction)
    $this->assertDatabaseHas('products', [
        'id' => $this->product->id,
        'stock' => 48, // 50 - 2
    ]);
});

it('returns validation error if stock is insufficient', function () {
    // Arrange
    $payload = [
        'user_id' => $this->user->id,
        'items' => [
            [
                'product_id' => $this->product->id,
                'qty' => 100, // Melebihi stok 50
            ],
        ],
    ];

    // Act
    $response = $this->actingAs($this->user)->postJson('/api/orders', $payload);

    // Assert - Unprocessable Entity from Action Exception
    $response->assertStatus(Response::HTTP_UNPROCESSABLE_ENTITY)
             ->assertJsonFragment(['message' => "Product {$this->product->id} is out of stock."]);
             
    // Ensure no order was created (Transaction rolled back)
    $this->assertDatabaseEmpty('orders');
});
```

### 4.3 Unit Testing Action Class (tests/Unit/Actions/CreateOrderActionTest.php)

Dalam Clean Architecture, sangat mudah melakukan Unit Test terhadap Action Class dengan mem-mock layer Repository.

```php
<?php

declare(strict_types=1);

use App\Actions\Orders\CreateOrderAction;
use App\DTOs\CreateOrderData;
use App\Models\Order;
use App\Models\OrderStatus;
use App\Models\Product;
use App\Repositories\Contracts\OrderRepositoryInterface;
use App\Repositories\Contracts\ProductRepositoryInterface;
use Symfony\Component\HttpKernel\Exception\UnprocessableEntityHttpException;

it('executes order creation logic and delegates to repositories', function () {
    // Arrange: Create Mock objects
    $orderRepoMock = Mockery::mock(OrderRepositoryInterface::class);
    $productRepoMock = Mockery::mock(ProductRepositoryInterface::class);

    $action = new CreateOrderAction($orderRepoMock, $productRepoMock);

    $product = new Product(['id' => 'prod-1', 'price' => 50, 'stock' => 10]);
    $expectedOrder = new Order(['id' => 'ord-1']);

    $dto = new CreateOrderData(
        userId: 'user-1',
        items: [['product_id' => 'prod-1', 'qty' => 2]]
    );

    // Asserting interactions
    $productRepoMock->shouldReceive('findByIdWithLock')
        ->once()
        ->with('prod-1')
        ->andReturn($product);

    $productRepoMock->shouldReceive('decrementStock')
        ->once()
        ->with('prod-1', 2);

    $orderRepoMock->shouldReceive('createWithItems')
        ->once()
        ->with('user-1', 100.0, OrderStatus::PENDING, [
            ['product_id' => 'prod-1', 'qty' => 2, 'price' => 50.0, 'subtotal' => 100.0]
        ])
        ->andReturn($expectedOrder);

    // Act
    $result = $action->execute($dto);

    // Assert
    expect($result)->toBe($expectedOrder);
});
```

## 5. Performance Tips & Advanced Query Scopes

### 5.1 Local Scopes
Gunakan Scopes untuk membungkus kondisi-kondisi Where yang repetitif menjadi metode model yang readable.

```php
<?php
// Di dalam Order Model

/**
 * @param \Illuminate\Database\Eloquent\Builder $query
 * @return \Illuminate\Database\Eloquent\Builder
 */
public function scopeCompleted($query)
{
    return $query->where('status', OrderStatus::COMPLETED);
}

public function scopeRecent($query, int $days = 7)
{
    return $query->where('created_at', '>=', now()->subDays($days));
}

// Usage:
// Order::query()->completed()->recent(30)->get();
```

### 5.2 Chunking & Cursor Pagination
Saat memproses ribuan/jutaan record, `get()` akan memakan semua memory dan membuat server crash.

❌ **Bad: Memuat semua ke memory**
```php
$users = User::all();
foreach ($users as $user) { /* process */ }
```

✅ **Good: Chunking (menggunakan limit/offset)**
```php
User::query()->chunk(500, function ($users) {
    foreach ($users as $user) { /* process */ }
});
```

✅ **Better: Cursor Iteration (Sangat hemat memory, menggunakan yield generator PHP)**
```php
foreach (User::query()->cursor() as $user) {
    // Process 1 model at a time tanpa memuat ke array memory besar
}
```

✅ **API Pagination: Cursor Pagination (jauh lebih cepat untuk Big Data dibanding traditional Offset-based Paginator)**
```php
// Di Controller API
return User::query()->orderBy('id', 'desc')->cursorPaginate(15);
// Mengembalikan cursor string next/prev alih-alih number page. Tidak menghitung total().
```

## 6. Kesimpulan

Dengan menerapkan strict types PHP 8.3, struktur clean architecture, pencegahan N+1 queries, penanganan transaksi database dengan locking yang benar, dan testing komprehensif dengan Pest v3, aplikasi Laravel Anda akan memiliki arsitektur enterprise-grade yang sangat scalable, maintainable, aman, dan efisien. Jangan lupa untuk senantiasa mengaktifkan `Model::shouldBeStrict()` di environment lokal sebagai pertahanan lapis pertama melawan masalah performa ORM.
