# Laravel Mastery: Database & Integration Testing dengan Pest v3

**Domain:** `testing_automated`
**Topik:** Integration & Database Testing
**Versi PHP:** 8.3/8.4+
**Versi Laravel:** 11/12+
**Test Framework:** Pest v3

---

## 1. Pendahuluan: Kompleksitas Integration Testing

Integration Testing dalam konteks aplikasi backend modern (khususnya Laravel) bukan sekadar menguji apakah dua kelas bisa saling berinteraksi. Ini adalah pengujian komprehensif yang memvalidasi aliran data dari HTTP Request (Controller), tervalidasi oleh FormRequest, diproses melalui Bussiness Logic (Action/Service), disimpan melalui Data Access Layer (Repository), hingga berinteraksi dengan Object-Relational Mapper (Model) dan Database Relasional itu sendiri.

Tantangan terbesar dalam Database Integration Testing adalah **Test Isolation (Isolasi Pengujian)** dan **State Leakage (Kebocoran State)**. Jika satu pengujian mengubah state database dan tidak dibersihkan dengan benar, pengujian berikutnya bisa gagal secara tidak terduga (Flaky Tests). Laravel memberikan `Illuminate\Foundation\Testing\RefreshDatabase` untuk menangani hal ini secara transparan dengan membungkus setiap tes dalam database transaction dan me-rollback-nya setelah tes selesai.

Dalam panduan ini, kita akan menerapkan **Clean Architecture** secara ketat untuk mendemonstrasikan cara menguji setiap lapisan integrasi menggunakan **Pest v3**, framework testing yang elegan dan berkinerja tinggi, yang memaksimalkan *developer experience*.

---

## 2. Arsitektur Domain: Pemrosesan Pesanan (Order Processing)

Untuk menunjukkan integration testing yang komprehensif, kita membangun fitur pemrosesan pesanan yang melibatkan validasi, transaksi database, pembaruan stok, dan delegasi ke event.

### 2.1. Model dan Database

Model menggunakan PHP 8.3+ Typed Properties dan Laravel 11/12 attributes.

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

final class Order extends Model
{
    use HasFactory;

    protected $fillable = [
        'user_id',
        'product_id',
        'quantity',
        'total_amount',
        'status',
    ];

    protected $casts = [
        'total_amount' => 'decimal:2',
        'quantity' => 'integer',
    ];

    /**
     * @return BelongsTo<Product, Order>
     */
    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }

    /**
     * @return BelongsTo<User, Order>
     */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
```

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
        'price',
        'stock',
    ];

    protected $casts = [
        'price' => 'decimal:2',
        'stock' => 'integer',
    ];
}
```

### 2.2. FormRequest

Validasi ketat pada layer awal.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class StoreOrderRequest extends FormRequest
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
            'product_id' => ['required', 'integer', 'exists:products,id'],
            'quantity' => ['required', 'integer', 'min:1', 'max:100'],
        ];
    }
}
```

### 2.3. Repository Pattern

Mengabstraksi logika data access untuk kemudahan mocking dan pemisahan *concern*.

```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Models\Order;
use App\Models\Product;
use Illuminate\Support\Facades\DB;
use RuntimeException;

interface OrderRepositoryInterface
{
    public function createOrderWithTransaction(int $userId, int $productId, int $quantity): Order;
}

final class OrderRepository implements OrderRepositoryInterface
{
    public function createOrderWithTransaction(int $userId, int $productId, int $quantity): Order
    {
        return DB::transaction(function () use ($userId, $productId, $quantity): Order {
            /** @var Product|null $product */
            $product = Product::query()->lockForUpdate()->find($productId);

            if (! $product) {
                throw new RuntimeException('Product not found.');
            }

            if ($product->stock < $quantity) {
                throw new RuntimeException('Insufficient stock.');
            }

            $product->decrement('stock', $quantity);

            $order = Order::query()->create([
                'user_id' => $userId,
                'product_id' => $product->id,
                'quantity' => $quantity,
                'total_amount' => $product->price * $quantity,
                'status' => 'PENDING',
            ]);

            return $order;
        }, 3); // 3 retries on deadlock
    }
}
```

### 2.4. Action / Service Class

Mengenkapkapsulasi *Business Logic*. Action ini dapat diuji secara terisolasi dengan me-mock Repository, atau diuji secara integrasi.

```php
<?php

declare(strict_types=1);

namespace App\Actions;

use App\Events\OrderPlaced;
use App\Models\Order;
use App\Repositories\OrderRepositoryInterface;
use Illuminate\Support\Facades\Log;
use Throwable;

final readonly class ProcessOrderAction
{
    public function __construct(
        private OrderRepositoryInterface $orderRepository
    ) {}

    public function execute(int $userId, int $productId, int $quantity): Order
    {
        try {
            $order = $this->orderRepository->createOrderWithTransaction($userId, $productId, $quantity);
            
            OrderPlaced::dispatch($order);
            
            return $order;
        } catch (Throwable $e) {
            Log::error('Order processing failed', [
                'user_id' => $userId,
                'product_id' => $productId,
                'error' => $e->getMessage()
            ]);
            
            throw $e;
        }
    }
}
```

### 2.5. Controller

Controller yang ramping, hanya mendelegasikan HTTP request ke Action.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Actions\ProcessOrderAction;
use App\Http\Requests\StoreOrderRequest;
use Illuminate\Http\JsonResponse;

final class OrderController extends Controller
{
    public function __construct(
        private readonly ProcessOrderAction $processOrderAction
    ) {}

    public function store(StoreOrderRequest $request): JsonResponse
    {
        try {
            $order = $this->processOrderAction->execute(
                $request->user()->id,
                (int) $request->validated('product_id'),
                (int) $request->validated('quantity')
            );

            return response()->json([
                'message' => 'Order created successfully',
                'data' => $order
            ], 201);
        } catch (\RuntimeException $e) {
            return response()->json([
                'message' => $e->getMessage()
            ], 422);
        }
    }
}
```

---

## 3. Anti-Pattern dalam Database & Integration Testing

Berikut adalah pola-pola yang salah (namun sering dilakukan developer) beserta solusi dan alasannya.

### ❌ Anti-Pattern 1: Menguji state database dari endpoint HTTP secara berlebihan tanpa isolasi

Developer sering kali membuat test feature yang menembak endpoint HTTP berulang kali dalam satu file test panjang tanpa mereset state, dan melakukan dependensi antar-state test (Test A bergantung pada state Test B).

```php
// ❌ KODE SALAH: Test saling bergantung (State Leakage) & Assertion lemah
test('it processes order flow', function () {
    // Langkah 1: Buat produk
    $response = $this->postJson('/api/products', ['name' => 'Laptop', 'price' => 1000, 'stock' => 10]);
    $productId = $response->json('id');
    
    // Langkah 2: Buat order berdasarkan ID dari test sebelumnya (TIDAK ISOLATIF)
    $this->postJson('/api/orders', [
        'product_id' => $productId,
        'quantity' => 2
    ])->assertStatus(201);
    
    // Assertion sangat longgar, tidak ngecek sisa stock di database
    $this->assertDatabaseHas('orders', ['quantity' => 2]);
});
```

**Mengapa Berbahaya (Memory & Stability Risk):**
1. **Flaky Tests:** Tes ini tidak bisa dijalankan secara paralel. Jika dijalankan acak (shuffle), tes akan gagal karena dependensi *state*.
2. **State Leakage:** Jika test ini error di tengah jalan, state data kotor akan tersisa dan merusak ratusan test lain di suite.
3. **Weak Assertions:** Tidak memvalidasi *side effect* krusial (apakah stok produk benar-benar berkurang?).

### ✅ KODE BENAR: Isolasi Test, `RefreshDatabase`, dan Validasi Side Effect

Kita WAJIB menggunakan trait `RefreshDatabase` atau metode `uses(RefreshDatabase::class)` pada Pest untuk memastikan setiap blok tes (`it()`) memiliki state bersih.

```php
// ✅ KODE BENAR: Isolasi Penuh, Setup Explicit, dan Deep Assertion

uses(RefreshDatabase::class);

it('creates an order and decrements product stock via API', function () {
    // 1. Arrange: Siapkan state yang bersih & terisolasi khusus test ini
    $user = User::factory()->create();
    $product = Product::factory()->create([
        'price' => 1000.00,
        'stock' => 10,
    ]);

    // 2. Act: Lakukan tindakan
    $response = $this->actingAs($user)->postJson('/api/orders', [
        'product_id' => $product->id,
        'quantity' => 2,
    ]);

    // 3. Assert: Verifikasi HTTP Response
    $response->assertCreated()
             ->assertJsonPath('data.total_amount', 2000.00)
             ->assertJsonPath('data.status', 'PENDING');

    // 4. Assert: Verifikasi Database State
    $this->assertDatabaseHas('orders', [
        'user_id' => $user->id,
        'product_id' => $product->id,
        'quantity' => 2,
        'total_amount' => 2000.00,
    ]);

    // 5. Assert: Verifikasi Side Effect (Stok harus berkurang)
    expect($product->fresh()->stock)->toBe(8);
});
```

---

### ❌ Anti-Pattern 2: Tidak Menghentikan Eksekusi Event/Jobs Eksternal di Integration Test

Saat melakukan pengujian integrasi database ke layer controller, sistem mungkin memicu (dispatch) Event atau Queue Jobs (misal: mengirim email resi, memanggil third-party API webhook). Jika tidak di-fake, test suite akan mengeksekusi job aslinya secara sinkron.

```php
// ❌ KODE SALAH: Membiarkan Event dan Job berjalan tanpa Fake
it('handles order process without faking external calls', function () {
    $user = User::factory()->create();
    $product = Product::factory()->create(['stock' => 5]);

    // Saat hit API, Action class akan memicu `OrderPlaced` event.
    // Event ini bisa jadi memiliki listener `SendEmailToUser` atau `SyncToErpJob`
    // Ini akan menyebabkan test melambat, memakan memori berlebih, atau
    // menghabiskan kuota API third party saat CI/CD berjalan.
    $this->actingAs($user)->postJson('/api/orders', [
        'product_id' => $product->id,
        'quantity' => 1,
    ])->assertCreated();
});
```

**Mengapa Berbahaya (Network & Memory Risk):**
1. **Side Effect Eksternal:** Aplikasi Anda akan mengirim *spam* email ke *developer/dummy address* atau menghantam rate-limit API eksternal saat pipeline CI dijalankan.
2. **Kinerja Buruk (Slow Tests):** Menjalankan HTTP request eksternal sinkron dalam test akan memperlambat suite dari hitungan detik menjadi puluhan menit.

### ✅ KODE BENAR: Menggunakan `Event::fake()` dan `Queue::fake()`

Di Laravel, kita memiliki utilitas Fake. Untuk Integration Test dari Controller, kita membiarkan HTTP dan Database berjalan nyata, tetapi kita mencegat (intercept) antrean asinkron dan event bus.

```php
// ✅ KODE BENAR: Mengisolasi layer asinkron / eksternal
use Illuminate\Support\Facades\Event;
use App\Events\OrderPlaced;

it('dispatches OrderPlaced event upon successful order creation', function () {
    // 1. Arrange
    Event::fake(); // Mencegat semua Event agar tidak diteruskan ke Listener
    
    $user = User::factory()->create();
    $product = Product::factory()->create(['stock' => 5]);

    // 2. Act
    $this->actingAs($user)->postJson('/api/orders', [
        'product_id' => $product->id,
        'quantity' => 1,
    ])->assertCreated();

    // 3. Assert (Database Integration valid)
    $this->assertDatabaseHas('orders', [
        'product_id' => $product->id,
        'quantity' => 1,
    ]);

    // 4. Assert (Event dispatched with correct payload)
    Event::assertDispatched(OrderPlaced::class, function (OrderPlaced $event) use ($product) {
        return $event->order->product_id === $product->id 
            && $event->order->quantity === 1;
    });
});
```

---

## 4. Pest v3: Implementasi Test Suite Komprehensif

Pest v3 dirancang khusus untuk Developer Experience (DX) terbaik dengan sintaks deklaratif. Mari kita bangun file test secara keseluruhan.

### 4.1. Setup Lingkungan Uji (`tests/Pest.php`)

Pastikan semua file test di dalam folder `Feature` menggunakan `RefreshDatabase`.

```php
<?php

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

// Terapkan traits RefreshDatabase hanya untuk directory Feature
uses(TestCase::class, RefreshDatabase::class)->in('Feature');
```

### 4.2. Architecture Testing (Arch Tests)

Sebelum menguji integrasi database, kita uji arsitektur aplikasinya terlebih dahulu dengan fitur built-in Pest v3 Arch Testing.

```php
<?php
// tests/Feature/ArchitectureTest.php

declare(strict_types=1);

test('models strictly extend laravel model', function () {
    arch()
        ->expect('App\Models')
        ->toBeClasses()
        ->toExtend(\Illuminate\Database\Eloquent\Model::class)
        ->not->toBeFinal(); // Eloquent models cannot be final due to proxying/mocking limits (optional, but good practice in basic setups, though in our code above we used final for strictness. Let's adjust rule).
        // Catatan: Jika Model di-set final (seperti di contoh awal), hilangkan not->toBeFinal()
});

test('controllers do not interact with database directly', function () {
    arch()
        ->expect('App\Http\Controllers')
        ->not->toUse('Illuminate\Support\Facades\DB')
        ->not->toUse('App\Models'); // Memaksa penggunaan Action/Repository
});

test('repositories must implement interfaces', function () {
    arch()
        ->expect('App\Repositories')
        ->classes()
        ->toImplementNothing() // default
        ->ignoring('App\Repositories\OrderRepositoryInterface');
        // Pest bisa memeriksa implementasi interface.
});
```

### 4.3. Repository Integration Test (Database I/O Layer)

Di sini kita menguji kueri database secara langsung, termasuk *pessimistic locking* dan validasi transaksi.

```php
<?php
// tests/Feature/Repositories/OrderRepositoryTest.php

declare(strict_types=1);

use App\Models\Product;
use App\Models\User;
use App\Repositories\OrderRepository;
use RuntimeException;

it('creates an order within transaction and decreases stock', function () {
    // Arrange
    $user = User::factory()->create();
    $product = Product::factory()->create([
        'price' => 500,
        'stock' => 10
    ]);
    
    $repository = new OrderRepository();

    // Act
    $order = $repository->createOrderWithTransaction($user->id, $product->id, 3);

    // Assert
    expect($order)
        ->toBeInstanceOf(\App\Models\Order::class)
        ->total_amount->toEqual(1500) // 500 * 3
        ->status->toBe('PENDING');
        
    $this->assertDatabaseHas('orders', [
        'id' => $order->id,
        'quantity' => 3
    ]);
    
    expect($product->fresh()->stock)->toBe(7);
});

it('throws exception and rollbacks transaction if stock is insufficient', function () {
    // Arrange
    $user = User::factory()->create();
    $product = Product::factory()->create(['stock' => 2]);
    $repository = new OrderRepository();

    // Act & Assert
    expect(fn() => $repository->createOrderWithTransaction($user->id, $product->id, 5))
        ->toThrow(RuntimeException::class, 'Insufficient stock.');

    // Database should be untouched (rollback validation)
    $this->assertDatabaseEmpty('orders');
    expect($product->fresh()->stock)->toBe(2);
});
```

### 4.4. Action Integration Test (Business Logic Layer)

Menguji Action untuk memastikan bahwa logika bisnis berjalan secara end-to-end tanpa melibatkan request/response HTTP.

```php
<?php
// tests/Feature/Actions/ProcessOrderActionTest.php

declare(strict_types=1);

use App\Actions\ProcessOrderAction;
use App\Events\OrderPlaced;
use App\Models\Product;
use App\Models\User;
use App\Repositories\OrderRepository;
use Illuminate\Support\Facades\Event;

it('processes order successfully and dispatches event', function () {
    Event::fake();

    // Arrange
    $user = User::factory()->create();
    $product = Product::factory()->create(['stock' => 10, 'price' => 100]);
    
    // Resolve action via container to auto-inject repository
    $action = app(ProcessOrderAction::class);

    // Act
    $order = $action->execute($user->id, $product->id, 2);

    // Assert
    expect($order->total_amount)->toBe('200.00'); // Note string due to decimal casting in DB/test assert context
    $this->assertDatabaseCount('orders', 1);

    Event::assertDispatched(OrderPlaced::class);
});
```

### 4.5. HTTP Controller Integration Test (E2E API Test)

Ini adalah uji integrasi tingkat tertinggi yang memverifikasi HTTP request, middleware (auth), Request Validation, pemanggilan Action, dan JSON Response.

```php
<?php
// tests/Feature/Http/Controllers/OrderControllerTest.php

declare(strict_types=1);

use App\Models\Product;
use App\Models\User;

it('validates incoming payload using FormRequest', function () {
    $user = User::factory()->create();

    $response = $this->actingAs($user)->postJson('/api/orders', [
        'product_id' => 9999, // ID tidak ada di database
        'quantity' => 0,      // Kurang dari minimal 1
    ]);

    $response->assertStatus(422)
        ->assertJsonValidationErrors(['product_id', 'quantity']);
});

it('returns 422 if business logic throws runtime exception', function () {
    $user = User::factory()->create();
    $product = Product::factory()->create(['stock' => 5]);

    $response = $this->actingAs($user)->postJson('/api/orders', [
        'product_id' => $product->id,
        'quantity' => 10, // Stock tidak cukup
    ]);

    // Memvalidasi penanganan exception dari OrderController
    $response->assertStatus(422)
        ->assertJsonPath('message', 'Insufficient stock.');
});

it('successfully stores order and returns 201 response', function () {
    $user = User::factory()->create();
    $product = Product::factory()->create(['stock' => 100, 'price' => 20]);

    $response = $this->actingAs($user)->postJson('/api/orders', [
        'product_id' => $product->id,
        'quantity' => 5,
    ]);

    $response->assertStatus(201)
        ->assertJsonStructure([
            'message',
            'data' => [
                'id',
                'user_id',
                'product_id',
                'quantity',
                'total_amount',
                'status',
            ]
        ])
        ->assertJsonPath('data.total_amount', 100.00); // 20 * 5
        
    $this->assertDatabaseHas('orders', [
        'user_id' => $user->id,
        'quantity' => 5
    ]);
});
```

---

## 5. Ringkasan Praktik Terbaik

Untuk mencapai skor maksimal dalam Database & Integration Testing di Laravel:

1. **Gunakan Pest v3** secara ekstensif karena memiliki syntax `expect()` (Higher-Order Expectations) yang luar biasa intuitif dibandingkan dengan PHPUnit Tradisional.
2. **Setup Isolation:** Selalu gunakan `RefreshDatabase` atau `DatabaseTransactions` (untuk DB besar) guna mencegah flakiness.
3. **Mute External Side-Effects:** Cegat Events (`Event::fake()`), Jobs (`Queue::fake()`), Notifications, dan Mails saat menguji integrasi database agar memori tidak jebol dan performa terjaga.
4. **Assert Database Secara Eksplisit:** Jangan hanya percaya pada JSON response API (`assertStatus(201)`). Buktikan bahwa baris data di tabel `orders` benar-benar masuk dengan data yang tepat menggunakan `$this->assertDatabaseHas()`.
5. **Architectural Guardrails:** Lindungi arsitektur Clean Code dari regresi dengan Arch Testing (Pest Arch), mencegah Controller tiba-tiba menggunakan facade DB secara langsung.
6. **Strong Typing:** Gunakan `declare(strict_types=1);` dan properti ter-type pada semua layer (Action, Repository, Request) agar bug terdeteksi di level statis sebelum menabrak test database.
