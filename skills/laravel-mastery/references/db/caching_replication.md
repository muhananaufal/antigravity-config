# Database Caching & Replication di Laravel 11/12 (PHP 8.3+)

## 1. Konsep Dasar Caching & Replika di Laravel

Dalam aplikasi berskala besar, menangani beban baca (read load) yang tinggi pada database adalah sebuah keharusan. Dua teknik utama untuk mencapai ini adalah **Caching** dan **Database Replication** (Master-Slave / Read-Write splitting). Laravel menyediakan integrasi out-of-the-box yang kuat untuk keduanya, memungkinkan developer membangun aplikasi high-concurrency dengan Clean Architecture.

### 1.1 Database Replication (Read-Write Splitting)

Database replication melibatkan pengaturan satu database Master (untuk `INSERT`, `UPDATE`, `DELETE`) dan satu atau lebih database Slave/Replica (hanya untuk `SELECT`). Laravel menangani routing kueri ini secara transparan jika dikonfigurasi dengan benar di `config/database.php`.

```php
// config/database.php
'mysql' => [
    'driver' => 'mysql',
    'read' => [
        'host' => [
            '192.168.1.2',
            '192.168.1.3',
        ],
    ],
    'write' => [
        'host' => [
            '192.168.1.1',
        ],
    ],
    'sticky' => true, // Penting! Memastikan read setelah write mengambil dari master.
    'database' => env('DB_DATABASE', 'forge'),
    'username' => env('DB_USERNAME', 'forge'),
    'password' => env('DB_PASSWORD', ''),
    'charset' => 'utf8mb4',
    'collation' => 'utf8mb4_unicode_ci',
    'prefix' => '',
],
```

### 1.2 Cache Layering

Caching database query mengurangi beban pada database. Laravel mendukung berbagai driver cache (Redis, Memcached). Dalam skenario tingkat lanjut, penggunaan pola **Cache-Aside** (atau Lazy Loading) sering digabungkan dengan **Tagging** (pada Redis/Memcached) untuk invalidasi cache yang presisi.

---

## 2. Implementasi Clean Architecture

Pendekatan Clean Architecture (FormRequest -> Controller -> Action/Service -> Repository -> Model) membantu mengisolasi logika caching dari bisnis logik.

### 2.1 Model & Migration

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

final class Product extends Model
{
    use HasFactory;

    protected $fillable = [
        'name',
        'slug',
        'price',
        'stock',
        'is_active',
    ];

    protected $casts = [
        'price' => 'decimal:2',
        'stock' => 'integer',
        'is_active' => 'boolean',
    ];
}
```

### 2.2 Data Transfer Object (DTO)

```php
<?php

declare(strict_types=1);

namespace App\DTOs;

final readonly class ProductData
{
    public function __construct(
        public string $name,
        public string $slug,
        public float $price,
        public int $stock,
        public bool $isActive,
    ) {}
}
```

### 2.3 Repository Layer (Cache & Database Interaction)

Repository bertugas mengambil data dari cache jika ada, atau dari database jika belum ada, kemudian menyimpannya ke cache. Pada Laravel, kita bisa menggunakan `Cache::tags` untuk mempermudah invalidasi.

```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Models\Product;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Support\Facades\Cache;

final class ProductRepository
{
    private const int CACHE_TTL = 3600; // 1 jam

    /**
     * @return Collection<int, Product>
     */
    public function getActiveProducts(): Collection
    {
        return Cache::tags(['products'])->remember(
            'products:active',
            self::CACHE_TTL,
            fn (): Collection => Product::where('is_active', true)
                ->orderBy('id', 'desc')
                ->get()
        );
    }

    public function getProductById(int $id): ?Product
    {
        return Cache::tags(['products'])->remember(
            sprintf('product:%d', $id),
            self::CACHE_TTL,
            fn (): ?Product => Product::find($id)
        );
    }

    public function createProduct(array $data): Product
    {
        $product = Product::create($data);
        
        // Invalidasi cache yang terkait dengan list produk
        Cache::tags(['products'])->flush();
        
        return $product;
    }

    public function updateProduct(Product $product, array $data): bool
    {
        $updated = $product->update($data);
        
        // Invalidasi cache spesifik produk dan list
        Cache::tags(['products'])->flush();
        
        return $updated;
    }

    public function deleteProduct(Product $product): bool
    {
        $deleted = $product->delete();
        
        Cache::tags(['products'])->flush();
        
        return $deleted;
    }
}
```

### 2.4 Service / Action Layer

Action classes memisahkan use case bisnis.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Products;

use App\DTOs\ProductData;
use App\Models\Product;
use App\Repositories\ProductRepository;
use Illuminate\Support\Facades\DB;
use Throwable;

final readonly class CreateProductAction
{
    public function __construct(
        private ProductRepository $repository
    ) {}

    /**
     * @throws Throwable
     */
    public function execute(ProductData $data): Product
    {
        // Menggunakan transaksi yang otomatis di-route ke database WRITE (Master)
        return DB::transaction(function () use ($data): Product {
            return $this->repository->createProduct([
                'name' => $data->name,
                'slug' => $data->slug,
                'price' => $data->price,
                'stock' => $data->stock,
                'is_active' => $data->isActive,
            ]);
        });
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Actions\Products;

use App\Models\Product;
use App\Repositories\ProductRepository;

final readonly class GetProductAction
{
    public function __construct(
        private ProductRepository $repository
    ) {}

    public function execute(int $id): ?Product
    {
        return $this->repository->getProductById($id);
    }
}
```

### 2.5 FormRequest Validation

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Products;

use Illuminate\Foundation\Http\FormRequest;

final class StoreProductRequest extends FormRequest
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
            'slug' => ['required', 'string', 'max:255', 'unique:products,slug'],
            'price' => ['required', 'numeric', 'min:0'],
            'stock' => ['required', 'integer', 'min:0'],
            'is_active' => ['required', 'boolean'],
        ];
    }
}
```

### 2.6 Controller

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Actions\Products\CreateProductAction;
use App\Actions\Products\GetProductAction;
use App\DTOs\ProductData;
use App\Http\Controllers\Controller;
use App\Http\Requests\Products\StoreProductRequest;
use Illuminate\Http\JsonResponse;
use Throwable;

final class ProductController extends Controller
{
    /**
     * @throws Throwable
     */
    public function store(StoreProductRequest $request, CreateProductAction $action): JsonResponse
    {
        $productData = new ProductData(
            name: $request->validated('name'),
            slug: $request->validated('slug'),
            price: (float) $request->validated('price'),
            stock: (int) $request->validated('stock'),
            isActive: (bool) $request->validated('is_active')
        );

        $product = $action->execute($productData);

        return response()->json([
            'message' => 'Product created successfully',
            'data' => $product,
        ], 201);
    }

    public function show(int $id, GetProductAction $action): JsonResponse
    {
        $product = $action->execute($id);

        if ($product === null) {
            return response()->json([
                'message' => 'Product not found',
            ], 404);
        }

        return response()->json([
            'data' => $product,
        ]);
    }
}
```

---

## 3. Anti-Patterns (❌ vs ✅)

### Anti-Pattern 1: N+1 Query Tersembunyi di Cache & Masalah Konkurensi (Cache Stampede)

Seringkali developer memasukkan kueri relasi secara lazy di dalam callback cache, menyebabkan N+1 di database saat cache expire, dan tidak memitigasi cache stampede jika banyak request masuk bersamaan saat cache kosong.

❌ **KODE SALAH (Memicu N+1 & Cache Stampede):**

```php
// Di dalam controller atau repository yang buruk
public function getTopSellers()
{
    // 1. Tidak menggunakan Cache lock (rentan Cache Stampede)
    // 2. Mengakses relasi lazy loading di dalam cache (N+1)
    return Cache::remember('products:top_sellers', 3600, function () {
        $products = Product::where('is_active', true)->limit(10)->get();
        
        $results = [];
        foreach ($products as $product) {
            // N+1 Query: Mengakses $product->category secara lazy
            $results[] = [
                'id' => $product->id,
                'name' => $product->name,
                'category_name' => $product->category->name, 
            ];
        }
        return $results;
    });
}
```
**Penjelasan Salah:** Ketika cache expire, puluhan atau ratusan request bersamaan akan menjalankan callback. Di dalam callback terjadi N+1 query karena `$product->category` tidak di-eager-load (`with('category')`). Ini akan membuat database master/slave terbebani seketika dan bisa menyebabkan down.

✅ **KODE BENAR (Menggunakan `Cache::flexible` / Atomic Lock & Eager Loading):**

```php
// Menggunakan Atomic Lock atau fitur Cache::flexible (Stale-While-Revalidate)
public function getTopSellers()
{
    // Menggunakan eager loading `with('category')`
    // Dan memitigasi cache stampede menggunakan Atomic Lock 
    // atau di Laravel 11+ bisa menggunakan flexible()
    return Cache::tags(['products', 'categories'])
        ->lock('products:top_sellers:lock', 10)
        ->get(function () {
            return Cache::remember('products:top_sellers', 3600, function () {
                $products = Product::with('category')
                    ->where('is_active', true)
                    ->limit(10)
                    ->get();
                
                return $products->map(fn(Product $product) => [
                    'id' => $product->id,
                    'name' => $product->name,
                    'category_name' => $product->category?->name ?? 'Uncategorized',
                ])->toArray();
            });
        });
}
```
*Catatan:* Laravel 11/12 memiliki helper cache yang lebih canggih untuk mengatasi masalah konkurensi, misalnya menggunakan `Cache::lock()` saat mengambil data yang berat, atau Stale-While-Revalidate logic untuk mengembalikan data lama sementara background job memperbarui cache.

### Anti-Pattern 2: Read-After-Write Consistency pada Replikasi Database

Ketika menggunakan Master-Slave replication, replikasi data dari master ke slave membutuhkan waktu (replication lag). Jika kita menulis data ke master lalu langsung membacanya dari slave, data tersebut mungkin belum ada.

❌ **KODE SALAH (Replication Lag Issue):**

```php
public function updateStock(int $id, int $quantity)
{
    // Write ke Master
    $product = Product::find($id);
    $product->update(['stock' => $product->stock - $quantity]);
    
    // Developer melakukan fetch ulang data (terkadang di event listener)
    // Fetch ini bisa ter-routing ke SLAVE
    $updatedProduct = Product::find($id); 
    
    // $updatedProduct->stock mungkin belum terupdate karena replication lag!
    return response()->json($updatedProduct);
}
```
**Penjelasan Salah:** Query `Product::find($id)` kedua bisa di-route ke koneksi `read` (Slave). Karena replikasi bisa telat sekian milidetik, slave mengembalikan data stok lama.

✅ **KODE BENAR (Sticky Connection & Explicit Master Routing):**

```php
public function updateStock(int $id, int $quantity)
{
    // 1. Pastikan config 'sticky' => true di config/database.php sudah aktif!
    // 'sticky' akan memaksa koneksi membaca dari WRITE connection 
    // pada request cycle yang sama setelah operasi penulisan dilakukan.

    $product = Product::findOrFail($id);
    $product->update(['stock' => $product->stock - $quantity]);
    
    // Atau jika butuh eksplisit mengambil dari master di cycle/job berbeda:
    $updatedProduct = Product::onWriteConnection()->find($id);
    
    return response()->json($updatedProduct);
}
```

---

## 4. Pengujian dengan Pest v3

Dalam arsitektur berbasis cache dan replication, pengujian menjadi sangat penting. Kita perlu memvalidasi bahwa cache digunakan (Cache Hits), invalidasi cache berjalan saat write (Cache Flush), dan memastikan architecture berjalan dengan `arch()`.

### 4.1 Architecture Test

```php
<?php

declare(strict_types=1);

use function Pest\PestPluginArch\arch;

arch('models_must_be_final')
    ->expect('App\Models')
    ->not->toBeFinal(); // Model Laravel sebaiknya tidak final untuk kebutuhan mocking relasi, kecuali secara ketat desain kita melarangnya

arch('dtos_must_be_readonly')
    ->expect('App\DTOs')
    ->toBeClasses()
    ->toBeReadonly();

arch('actions_must_be_final_and_readonly')
    ->expect('App\Actions')
    ->toBeClasses()
    ->toBeFinal()
    ->toBeReadonly();

arch('controllers_must_not_use_eloquent_directly')
    ->expect('App\Http\Controllers')
    ->not->toUse('Illuminate\Database\Eloquent\Model')
    ->ignoring('App\Models');
```

### 4.2 Repository Test (Cache Assertion)

Pest memungkinkan kita memata-matai (`spy`) facade `Cache` untuk memastikan data ditaruh dan diambil dari cache.

```php
<?php

declare(strict_types=1);

use App\Models\Product;
use App\Repositories\ProductRepository;
use Illuminate\Support\Facades\Cache;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

it('caches the active products', function () {
    // Arrange
    Product::factory()->count(3)->create(['is_active' => true]);
    Product::factory()->count(2)->create(['is_active' => false]);
    
    $repository = new ProductRepository();
    
    // Spy on cache facade
    Cache::spy();
    
    // Act
    $result = $repository->getActiveProducts();
    
    // Assert
    expect($result)->toHaveCount(3);
    
    Cache::shouldHaveReceived('tags')->with(['products'])->once();
});

it('invalidates products cache on creation', function () {
    // Arrange
    $repository = new ProductRepository();
    $data = [
        'name' => 'New Product',
        'slug' => 'new-product',
        'price' => 100.0,
        'stock' => 10,
        'is_active' => true,
    ];
    
    // Gunakan Mocking pada tags untuk menangkap call flush
    $tagMock = Mockery::mock();
    $tagMock->shouldReceive('flush')->once();
    Cache::shouldReceive('tags')->with(['products'])->andReturn($tagMock);
    
    // Act
    $repository->createProduct($data);
    
    // Assert database
    $this->assertDatabaseHas('products', ['slug' => 'new-product']);
});
```

### 4.3 Action Test (Business Logic & Transactions)

```php
<?php

declare(strict_types=1);

use App\Actions\Products\CreateProductAction;
use App\DTOs\ProductData;
use App\Models\Product;
use App\Repositories\ProductRepository;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

it('creates a product via action and stores in database', function () {
    // Arrange
    $repository = new ProductRepository();
    $action = new CreateProductAction($repository);
    
    $dto = new ProductData(
        name: 'Gaming Mouse',
        slug: 'gaming-mouse',
        price: 49.99,
        stock: 150,
        isActive: true
    );
    
    // Act
    $product = $action->execute($dto);
    
    // Assert
    expect($product)
        ->toBeInstanceOf(Product::class)
        ->name->toBe('Gaming Mouse')
        ->stock->toBe(150);
        
    $this->assertDatabaseHas('products', [
        'slug' => 'gaming-mouse',
        'price' => 49.99,
    ]);
});
```

### 4.4 Controller Test (Endpoint Verification)

```php
<?php

declare(strict_types=1);

use App\Models\Product;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

it('can store a new product via API', function () {
    // Act
    $response = $this->postJson('/api/products', [
        'name' => 'Keyboard Mechanical',
        'slug' => 'keyboard-mechanical',
        'price' => 129.50,
        'stock' => 20,
        'is_active' => true,
    ]);
    
    // Assert
    $response->assertStatus(201)
        ->assertJsonStructure([
            'message',
            'data' => [
                'id',
                'name',
                'slug',
                'price',
                'stock',
                'is_active',
            ],
        ]);
});

it('fails validation when creating product with invalid data', function () {
    // Act
    $response = $this->postJson('/api/products', [
        'name' => '', // Failed: required
        'slug' => 'valid-slug',
        'price' => -10, // Failed: min 0
        'stock' => 10,
        'is_active' => true,
    ]);
    
    // Assert
    $response->assertStatus(422)
        ->assertJsonValidationErrors(['name', 'price']);
});
```

---

## 5. Ringkasan & Best Practices

1. **Gunakan Redis untuk Cache / Queue**: Memcached memiliki fitur tags yang rumit, Redis adalah standar emas untuk `Cache::tags` di ekosistem Laravel.
2. **Atomic Locks untuk Query Berat**: Selalu lindungi cache rebuilding yang mahal dengan Lock (`Cache::lock`) untuk mencegah server mati akibat Cache Stampede.
3. **Sticky Connections**: Aktifkan `sticky => true` di konfig replikasi jika aplikasi sangat bergantung pada read-after-write consistency.
4. **Pisahkan Domain Cache Logic**: Letakkan cache logic di `Repository` layer atau implementasikan Decorator pattern. Jangan kotori Controller atau Business Action (Service) dengan syntax `Cache::remember`.
5. **Monitoring Hit/Miss Ratio**: Gunakan tools seperti Laravel Telescope atau Datadog untuk memantau seberapa efektif cache yang dibuat (apakah sering di-*hit* atau malah sering di-*miss* / ter-*flush* terlalu sering).
