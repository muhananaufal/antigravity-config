# Laravel Unit Testing Mastery: Standard Top 1% (Pest v3, Clean Architecture, PHP 8.4)

Unit testing pada aplikasi Laravel berskala enterprise bukan sekadar tentang mengejar *code coverage*, melainkan memastikan stabilitas, prediktabilitas, dan keamanan dari setiap komponen yang terisolasi. Dokumen ini mendefinisikan standar tertinggi (Top 1%) dalam menulis Unit Test di ekosistem Laravel 11/12 dengan PHP 8.3/8.4 menggunakan Pest v3.

Standar ini mengadopsi prinsip **Clean Architecture**, di mana logika bisnis terisolasi dari framework, dan setiap lapisan (Controller -> Action/Service -> Repository -> Model) diuji secara spesifik sesuai dengan tanggung jawabnya.

---

## 1. Arsitektur Pest v3 & Konfigurasi Dasar

Pest v3 menghadirkan sintaks yang lebih ekspresif, dukungan *Architecture Testing* (Arch), dan integrasi yang sangat baik dengan ekosistem Laravel. Sebelum menulis tes, pastikan konfigurasi dasar telah memenuhi standar *strict type* dan isolasi *state*.

### Konfigurasi `Pest.php`
Berkas konfigurasi Pest (`tests/Pest.php`) adalah fondasi dari seluruh *test suite*. Di sinilah kita mendefinisikan *traits* dan *helpers*.

```php
<?php

declare(strict_types=1);

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Foundation\Testing\TestCase;
use Tests\CreatesApplication;

/*
|--------------------------------------------------------------------------
| Test Case Configuration
|--------------------------------------------------------------------------
*/
uses(
    TestCase::class,
    CreatesApplication::class,
    RefreshDatabase::class,
)->in('Feature', 'Unit');

/*
|--------------------------------------------------------------------------
| Expectations
|--------------------------------------------------------------------------
*/
expect()->extend('toBeValidUuid', function () {
    return $this->toMatch('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i');
});
```

---

## 2. Pest Arch Testing (Menjaga Clean Architecture)

*Architecture testing* memastikan bahwa batas-batas komponen arsitektur tidak dilanggar. Ini adalah lapis pertama *automated testing* untuk menjaga kebersihan kode.

```php
<?php

declare(strict_types=1);

test('models should not depend on controllers or actions')
    ->expect('App\Models')
    ->not->toUse([
        'App\Http\Controllers',
        'App\Actions',
        'App\Services'
    ]);

test('actions should only depend on repositories and domain models')
    ->expect('App\Actions')
    ->toUse([
        'App\Repositories',
        'App\Models',
        'Illuminate\Support',
    ])
    ->not->toUse('App\Http\Controllers');

test('controllers should not access models directly')
    ->expect('App\Http\Controllers')
    ->not->toUse('App\Models')
    ->ignoring('App\Http\Controllers\Auth');

test('strict types are used everywhere')
    ->expect('App')
    ->toUseStrictTypes();
```

---

## 3. Anti-Patterns dalam Unit Testing Laravel

Menulis tes yang buruk lebih berbahaya daripada tidak menulis tes sama sekali, karena memberikan *false sense of security* dan memperlambat *refactoring*. Berikut adalah *anti-patterns* yang paling sering ditemukan dan bagaimana memperbaikinya.

### 🔴 Anti-Pattern 1: Menguji Detail Implementasi (Tightly Coupled Mocks)

**Masalah:** Menggunakan *mock* secara berlebihan untuk setiap *method call* dari *dependency*, sehingga ketika implementasi internal berubah (tanpa mengubah hasil akhir), tes akan gagal (*brittle tests*).
**Risiko Keamanan & Memori:** Mocks berlebihan membebani memori karena PHP harus melakukan instansiasi objek anonim berulang kali. Ini juga mematikan kapabilitas *refactoring*.

**❌ KODE SALAH:**
```php
<?php

declare(strict_types=1);

test('it creates user with tight mocking', function () {
    $userMock = Mockery::mock(User::class);
    $userMock->shouldReceive('setAttribute')->with('name', 'John')->once();
    $userMock->shouldReceive('setAttribute')->with('email', 'john@example.com')->once();
    $userMock->shouldReceive('save')->once()->andReturn(true);
    
    $repositoryMock = Mockery::mock(UserRepository::class);
    $repositoryMock->shouldReceive('newInstance')->once()->andReturn($userMock);
    
    $action = new CreateUserAction($repositoryMock);
    $action->execute(new UserDTO('John', 'john@example.com', 'password123'));
});
```

**✅ KODE BENAR (Behavior-Driven Testing):**
Alih-alih menguji *method* mana yang dipanggil, ujilah *state* akhir atau *return value*. Gunakan *Fakes* atau *In-Memory Database* untuk menguji Repository, dan gunakan *stubs* sederhana untuk Action.

```php
<?php

declare(strict_types=1);

use App\Actions\CreateUserAction;
use App\DTOs\UserDTO;
use App\Models\User;
use App\Repositories\EloquentUserRepository;
use Illuminate\Support\Facades\Hash;

it('creates a new user successfully', function () {
    // Arrange
    Hash::fake();
    $repository = new EloquentUserRepository(new User());
    $action = new CreateUserAction($repository);
    $dto = new UserDTO(
        name: 'John Doe',
        email: 'john@example.com',
        password: 'SecurePassword123!',
    );

    // Act
    $user = $action->execute($dto);

    // Assert
    expect($user)
        ->toBeInstanceOf(User::class)
        ->name->toBe('John Doe')
        ->email->toBe('john@example.com');
        
    $this->assertDatabaseHas('users', [
        'email' => 'john@example.com',
    ]);
});
```

### 🔴 Anti-Pattern 2: God Classes & Logic Bleeding di Controller

**Masalah:** Meletakkan logika bisnis, validasi, dan manipulasi *database* langsung di dalam Controller dan mengujinya melalui Feature Test tanpa isolasi.
**Risiko Keamanan & Memori:** Membuat aplikasi sangat sulit dilindungi dari kerentanan injeksi data karena Controller mem-bypass validasi DTO (*Data Transfer Object*). Feature test memakan waktu lebih lama karena harus melewati seluruh *middleware stack*, membuang resource CPU dan I/O *database*.

**❌ KODE SALAH:**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\Order;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class OrderController extends Controller
{
    public function store(Request $request)
    {
        // LOGIC BLEEDING
        $validated = $request->validate([
            'amount' => 'required|numeric|min:10',
            'product_id' => 'required|exists:products,id'
        ]);

        DB::beginTransaction();
        try {
            $order = new Order();
            $order->amount = $validated['amount'];
            $order->product_id = $validated['product_id'];
            $order->status = 'pending';
            $order->save();
            DB::commit();
            return response()->json($order, 201);
        } catch (\Exception $e) {
            DB::rollBack();
            return response()->json(['error' => 'Failed'], 500);
        }
    }
}
```

**✅ KODE BENAR (Clean Architecture Isolation):**
Pisahkan validasi ke `FormRequest`, injeksi ketergantungan menggunakan DTO, pindahkan logika transaksi ke dalam `Action` class, dan gunakan `Repository` untuk berinteraksi dengan database.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Requests\StoreOrderRequest;
use App\Actions\ProcessOrderAction;
use App\DTOs\OrderDTO;
use Illuminate\Http\JsonResponse;

final readonly class OrderController
{
    public function __construct(
        private ProcessOrderAction $processOrderAction
    ) {}

    public function store(StoreOrderRequest $request): JsonResponse
    {
        $orderDTO = OrderDTO::fromRequest($request);
        
        $order = $this->processOrderAction->execute($orderDTO);
        
        return response()->json($order, 201);
    }
}
```

---

## 4. Full Implementation: Studi Kasus Pembuatan Order (Clean Architecture)

Berikut adalah implementasi menyeluruh (dari Model hingga Action) yang sepenuhnya memenuhi standar kode *enterprise*, bebas dari *magic strings*, *strongly typed*, dan diuji menggunakan Pest v3.

### 1. Data Transfer Object (DTO)
DTO menjembatani komunikasi antara request dan lapisan bisnis. DTO bersifat *immutable* dan sangat *type-safe*.

```php
<?php

declare(strict_types=1);

namespace App\DTOs;

use Illuminate\Http\Request;

final readonly class OrderDTO
{
    public function __construct(
        public int $productId,
        public int $quantity,
        public float $amount,
        public int $userId,
    ) {}

    public static function fromRequest(Request $request, int $userId): self
    {
        return new self(
            productId: (int) $request->validated('product_id'),
            quantity: (int) $request->validated('quantity'),
            amount: (float) $request->validated('amount'),
            userId: $userId,
        );
    }
}
```

### 2. Repository Interface & Implementation
Repository memisahkan *business logic* dari Eloquent (lapisan *persistence*). Ini memudahkan kita untuk *mocking* dalam *unit test* aksi.

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Contracts;

use App\Models\Order;
use App\DTOs\OrderDTO;

interface OrderRepositoryInterface
{
    public function createOrder(OrderDTO $dto, string $status): Order;
    public function findById(int $id): ?Order;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use App\Models\Order;
use App\DTOs\OrderDTO;
use App\Repositories\Contracts\OrderRepositoryInterface;
use Illuminate\Database\DatabaseManager;

final readonly class EloquentOrderRepository implements OrderRepositoryInterface
{
    public function __construct(
        private Order $model,
        private DatabaseManager $database
    ) {}

    public function createOrder(OrderDTO $dto, string $status): Order
    {
        return $this->database->transaction(function () use ($dto, $status) {
            $order = $this->model->newInstance();
            $order->product_id = $dto->productId;
            $order->user_id = $dto->userId;
            $order->quantity = $dto->quantity;
            $order->amount = $dto->amount;
            $order->status = $status;
            
            $order->save();
            
            return $order;
        });
    }

    public function findById(int $id): ?Order
    {
        return $this->model->find($id);
    }
}
```

### 3. Action Class (Business Logic)
Class yang hanya memiliki satu tanggung jawab (SRP) untuk memproses logika bisnis pembuatan Order.

```php
<?php

declare(strict_types=1);

namespace App\Actions;

use App\DTOs\OrderDTO;
use App\Models\Order;
use App\Repositories\Contracts\OrderRepositoryInterface;
use App\Exceptions\InsufficientStockException;
use App\Services\InventoryService;

final readonly class ProcessOrderAction
{
    public function __construct(
        private OrderRepositoryInterface $orderRepository,
        private InventoryService $inventoryService
    ) {}

    /**
     * @throws InsufficientStockException
     */
    public function execute(OrderDTO $dto): Order
    {
        // Validasi domain bisnis: Cek stok di inventory service
        if (! $this->inventoryService->hasSufficientStock($dto->productId, $dto->quantity)) {
            throw new InsufficientStockException("Stock is insufficient for product ID: {$dto->productId}");
        }

        // Reserve stock
        $this->inventoryService->reserveStock($dto->productId, $dto->quantity);

        // Buat Order
        return $this->orderRepository->createOrder($dto, 'pending');
    }
}
```

---

## 5. Unit Testing Menyeluruh (Pest v3)

Unit testing yang baik akan mengisolasi setiap komponen. Mari kita uji `ProcessOrderAction` dengan mengisolasi `OrderRepositoryInterface` dan `InventoryService`.

### Uji Coba: `ProcessOrderActionTest.php`

```php
<?php

declare(strict_types=1);

use App\Actions\ProcessOrderAction;
use App\DTOs\OrderDTO;
use App\Models\Order;
use App\Repositories\Contracts\OrderRepositoryInterface;
use App\Services\InventoryService;
use App\Exceptions\InsufficientStockException;
use Mockery\MockInterface;

uses()->group('actions', 'order');

beforeEach(function () {
    // Setup DTO standard untuk testing
    $this->dto = new OrderDTO(
        productId: 100,
        quantity: 2,
        amount: 500.00,
        userId: 1,
    );
});

it('successfully processes an order when stock is sufficient', function () {
    // Arrange: Mock InventoryService
    $inventoryService = Mockery::mock(InventoryService::class, function (MockInterface $mock) {
        $mock->shouldReceive('hasSufficientStock')
            ->once()
            ->with($this->dto->productId, $this->dto->quantity)
            ->andReturn(true);
            
        $mock->shouldReceive('reserveStock')
            ->once()
            ->with($this->dto->productId, $this->dto->quantity)
            ->andReturn(true);
    });

    // Arrange: Mock Repository
    $expectedOrder = new Order(['id' => 1, 'status' => 'pending']);
    
    $orderRepository = Mockery::mock(OrderRepositoryInterface::class, function (MockInterface $mock) use ($expectedOrder) {
        $mock->shouldReceive('createOrder')
            ->once()
            ->with($this->dto, 'pending')
            ->andReturn($expectedOrder);
    });

    $action = new ProcessOrderAction($orderRepository, $inventoryService);

    // Act
    $result = $action->execute($this->dto);

    // Assert
    expect($result)
        ->toBeInstanceOf(Order::class)
        ->id->toBe(1)
        ->status->toBe('pending');
});

it('throws exception when stock is insufficient', function () {
    // Arrange: Mock InventoryService (simulasi stok habis)
    $inventoryService = Mockery::mock(InventoryService::class, function (MockInterface $mock) {
        $mock->shouldReceive('hasSufficientStock')
            ->once()
            ->with($this->dto->productId, $this->dto->quantity)
            ->andReturn(false);
            
        // ReserveStock tidak boleh dipanggil
        $mock->shouldNotReceive('reserveStock');
    });

    // Arrange: Mock Repository (tidak boleh dipanggil sama sekali)
    $orderRepository = Mockery::mock(OrderRepositoryInterface::class, function (MockInterface $mock) {
        $mock->shouldNotReceive('createOrder');
    });

    $action = new ProcessOrderAction($orderRepository, $inventoryService);

    // Act & Assert (Pest exception handling)
    expect(fn () => $action->execute($this->dto))
        ->toThrow(InsufficientStockException::class, "Stock is insufficient for product ID: {$this->dto->productId}");
});
```

### Uji Coba: `EloquentOrderRepositoryTest.php`

Repositori harus selalu diuji melawan *database* karena fungsinya adalah menerjemahkan operasi abstrak ke SQL (*persistence layer*).

```php
<?php

declare(strict_types=1);

use App\Repositories\Eloquent\EloquentOrderRepository;
use App\Models\Order;
use App\DTOs\OrderDTO;
use Illuminate\Database\DatabaseManager;

uses(\Illuminate\Foundation\Testing\RefreshDatabase::class)->group('repositories', 'database');

beforeEach(function () {
    $this->database = app(DatabaseManager::class);
    $this->repository = new EloquentOrderRepository(new Order(), $this->database);
});

it('creates an order and stores it in the database safely', function () {
    // Arrange
    $dto = new OrderDTO(
        productId: 101,
        quantity: 5,
        amount: 2500.50,
        userId: 10
    );

    // Act
    $order = $this->repository->createOrder($dto, 'completed');

    // Assert
    expect($order)
        ->toBeInstanceOf(Order::class)
        ->product_id->toBe(101)
        ->quantity->toBe(5)
        ->amount->toBe(2500.50)
        ->status->toBe('completed');
        
    $this->assertDatabaseHas('orders', [
        'id' => $order->id,
        'product_id' => 101,
        'user_id' => 10,
        'quantity' => 5,
        'amount' => 2500.50,
        'status' => 'completed',
    ]);
});

it('returns null if order is not found by ID', function () {
    $order = $this->repository->findById(99999);
    
    expect($order)->toBeNull();
});
```

---

## Kesimpulan

Pendekatan *Top 1% Unit Testing* pada ekosistem Laravel modern (PHP 8.4 + Pest v3 + Clean Architecture) difokuskan pada:

1.  **Strong Typing:** Penggunaan ketat dari tipe data (`declare(strict_types=1)`), DTOs, dan tipe pengembalian.
2.  **Strict Boundaries (Arch Test):** Larangan ketat untuk layer agar tidak saling memotong struktur (*Controller tidak boleh memanggil Model*).
3.  **Behavior-Driven Isolation:** *Unit Test* yang berfokus pada hasil akhir operasi, bukan *implementation details*. Menghindari *mocking* yang sangat ketat kecuali saat menguji Action terhadap Dependency terluarnya.
4.  **Keamanan State:** Repositori yang memanfaatkan *Database Transactions* dan penanganan pengecualian pada *Domain layer* memastikan tidak ada jejak inkonsistensi saat kegagalan logika bisnis terjadi. 

Dengan mengikuti standar ini, tim *engineering* dapat melakukan proses *refactoring* sebesar apa pun dengan rasa percaya diri 100%, menghasilkan aplikasi web Laravel yang *robust*, *maintainable*, dan tangguh di produksi.
