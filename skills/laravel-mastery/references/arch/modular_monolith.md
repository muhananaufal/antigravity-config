# Laravel Modular Monolith Architecture (Top 1% Engineering)

Pendekatan **Modular Monolith** adalah jawaban untuk tim engineering skala menengah hingga besar yang ingin mencapai fleksibilitas layaknya Microservices tanpa mengorbankan kesederhanaan dan kemudahan deployment sebuah aplikasi Monolith. Dalam arsitektur ini, kode dibagi ke dalam beberapa modul independen (Bounded Contexts) yang diisolasi dengan ketat namun tetap berjalan di atas satu aplikasi (satu server, satu database utama atau multitenant, dan memori yang sama).

## 1. Filosofi & Domain-Driven Design (DDD)

Modular monolith sangat erat kaitannya dengan DDD. Fokus utama adalah pada isolasi domain. Sistem tidak lagi dipisahkan berdasarkan fungsi teknis seperti `Controllers`, `Models`, dan `Services` secara global, melainkan dipecah berdasarkan area bisnis. Misalnya, e-commerce dibagi menjadi domain `Catalog`, `Orders`, `Payments`, dan `Shipping`.

### Keuntungan Utama
1. **Low Latency**: Komunikasi antar domain terjadi di level in-memory (method calls/events), bukan melalui jaringan gRPC atau HTTP API (REST) yang lambat.
2. **Atomic Transactions**: Anda masih dapat melakukan transaksi database lintas modul secara aman jika memang diperlukan, tanpa perlu implementasi saga pattern yang kompleks, meskipun best practice menganjurkan eventual consistency.
3. **Easy Refactoring**: Jika di masa depan `Payments` butuh di-scale secara terpisah, memindahkannya menjadi microservice jauh lebih mudah karena batasan modul sudah terdefinisi ketat sejak awal.
4. **Cognitive Load Rendah**: Engineer baru hanya perlu memahami modul tempat mereka bekerja, bukan keseluruhan aplikasi yang masif.

---

## 2. Struktur Direktori (Modul Tersendiri)

Dalam Laravel 11/12, kita memindahkan fokus dari `app/` ke `src/` atau `modules/`. Berikut contoh struktur untuk modul `Order`:

```text
modules/
└── Order/
    ├── src/
    │   ├── Actions/          # Business logic, single responsibility class
    │   ├── Contracts/        # Interface untuk internal & eksternal
    │   ├── Controllers/      # HTTP layer, hanya mengarahkan trafik
    │   ├── DataTransferObjects/ # DTO untuk passing data
    │   ├── Events/           # Domain events
    │   ├── Models/           # Eloquent Model (Internal to Module)
    │   ├── Providers/        # Service Provider modul
    │   ├── Repositories/     # Abstraksi database
    │   └── Requests/         # FormRequest validation
    ├── database/
    │   └── migrations/       # Migrasi spesifik modul
    ├── routes/
    │   └── api.php           # Rute API spesifik modul
    └── tests/                # Testing (Pest PHP) spesifik modul
```

---

## 3. Implementasi Clean Architecture dalam Modul

Clean Architecture memastikan logika bisnis tidak terikat pada framework atau database. Alur yang disarankan adalah: **FormRequest -> Controller -> Action/Service -> Repository -> Model**.

### 3.1. DTO (Data Transfer Object)
Kita gunakan DTO menggunakan `readonly class` pada PHP 8.3/8.4 untuk melempar payload secara strongly-typed ke lapisan Action.

```php
<?php

declare(strict_types=1);

namespace Modules\Order\DataTransferObjects;

final readonly class CreateOrderDto
{
    public function __construct(
        public string $customerId,
        public array $items,
        public string $shippingAddress,
        public string $paymentMethod,
    ) {}
}
```

### 3.2. FormRequest Validation
FormRequest digunakan murni untuk validasi dan mentransformasi request menjadi DTO.

```php
<?php

declare(strict_types=1);

namespace Modules\Order\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Modules\Order\DataTransferObjects\CreateOrderDto;

final class StoreOrderRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // Biasanya diganti dengan policy authorization
    }

    public function rules(): array
    {
        return [
            'customer_id'      => ['required', 'uuid'],
            'items'            => ['required', 'array', 'min:1'],
            'items.*.product_id' => ['required', 'uuid'],
            'items.*.quantity'   => ['required', 'integer', 'min:1'],
            'shipping_address' => ['required', 'string', 'max:500'],
            'payment_method'   => ['required', 'string', 'in:credit_card,bank_transfer,e_wallet'],
        ];
    }

    public function toDto(): CreateOrderDto
    {
        return new CreateOrderDto(
            customerId: $this->validated('customer_id'),
            items: $this->validated('items'),
            shippingAddress: $this->validated('shipping_address'),
            paymentMethod: $this->validated('payment_method'),
        );
    }
}
```

### 3.3. Controller
Controller harus sangat tipis (Thin Controller). Hanya bertugas menerima DTO dari request dan melemparnya ke Action class.

```php
<?php

declare(strict_types=1);

namespace Modules\Order\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Routing\Controller;
use Modules\Order\Requests\StoreOrderRequest;
use Modules\Order\Actions\PlaceNewOrderAction;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

final class OrderController extends Controller
{
    public function __construct(
        private readonly PlaceNewOrderAction $placeNewOrderAction,
    ) {}

    public function store(StoreOrderRequest $request): JsonResponse
    {
        try {
            $order = $this->placeNewOrderAction->execute($request->toDto());

            return response()->json([
                'message' => 'Order successfully placed',
                'data'    => $order->toArray(),
            ], Response::HTTP_CREATED);
        } catch (Throwable $exception) {
            // Error handling di tingkat controller, atau didelegasikan ke Exception Handler global
            return response()->json([
                'error'   => 'Failed to place order',
                'details' => $exception->getMessage(),
            ], Response::HTTP_UNPROCESSABLE_ENTITY);
        }
    }
}
```

### 3.4. Repository & Interface
Repository Pattern mengisolasi akses ke persistence layer (Database/Eloquent).

```php
<?php

declare(strict_types=1);

namespace Modules\Order\Contracts;

use Modules\Order\Models\Order;

interface OrderRepositoryInterface
{
    public function create(array $data): Order;
    public function findById(string $id): ?Order;
}
```

```php
<?php

declare(strict_types=1);

namespace Modules\Order\Repositories;

use Modules\Order\Contracts\OrderRepositoryInterface;
use Modules\Order\Models\Order;

final class EloquentOrderRepository implements OrderRepositoryInterface
{
    public function create(array $data): Order
    {
        return Order::create($data);
    }

    public function findById(string $id): ?Order
    {
        return Order::find($id);
    }
}
```

### 3.5. Action Class (Business Logic)
Action berisi inti logika bisnis. Dapat memanggil Repository atau Event dispatcher. Kelas ini wajib single-responsibility (hanya 1 public method `execute` atau `handle`).

```php
<?php

declare(strict_types=1);

namespace Modules\Order\Actions;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Modules\Order\Contracts\OrderRepositoryInterface;
use Modules\Order\DataTransferObjects\CreateOrderDto;
use Modules\Order\Events\OrderPlaced;
use Modules\Order\Models\Order;
use Exception;

final class PlaceNewOrderAction
{
    public function __construct(
        private readonly OrderRepositoryInterface $orderRepository,
    ) {}

    public function execute(CreateOrderDto $dto): Order
    {
        return DB::transaction(function () use ($dto): Order {
            // 1. Buat entity order
            $order = $this->orderRepository->create([
                'customer_id'      => $dto->customerId,
                'shipping_address' => $dto->shippingAddress,
                'payment_method'   => $dto->paymentMethod,
                'status'           => 'pending',
                'total_amount'     => $this->calculateTotal($dto->items),
            ]);

            // 2. Insert items
            foreach ($dto->items as $item) {
                $order->items()->create([
                    'product_id' => $item['product_id'],
                    'quantity'   => $item['quantity'],
                    // Ideally price is fetched from a Product module RPC/Contract, 
                    // not trusted from client
                ]);
            }

            // 3. Dispatch domain event
            Event::dispatch(new OrderPlaced($order->id, $dto->customerId));

            return $order;
        });
    }

    private function calculateTotal(array $items): float
    {
        // Dummy logic untuk simplifikasi.
        // Aslinya kita harus memanggil modul Catalog/Product untuk memastikan harga.
        $total = 0.0;
        foreach ($items as $item) {
            $total += 100.0 * $item['quantity']; // 100.0 is a dummy price
        }
        return $total;
    }
}
```

---

## 4. Komunikasi Antar Modul

Komunikasi yang baik pada Modular Monolith terjadi melalui Event (Asynchronous) atau Interface/Contract (Synchronous). Dilarang keras satu modul memanggil langsung kelas internal modul lain.

### Event-Driven (Eventual Consistency)
Modul `Order` men-dispatch `OrderPlaced`. Modul `Inventory` mendengarkan event tersebut dan mengurangi stok.

```php
<?php

declare(strict_types=1);

namespace Modules\Inventory\Listeners;

use Illuminate\Contracts\Queue\ShouldQueue;
use Modules\Order\Events\OrderPlaced;
use Modules\Inventory\Actions\ReserveStockAction;
use Illuminate\Queue\InteractsWithQueue;

final class ReserveStockForOrder implements ShouldQueue
{
    use InteractsWithQueue;

    public function __construct(
        private readonly ReserveStockAction $reserveStockAction,
    ) {}

    public function handle(OrderPlaced $event): void
    {
        // Panggil action dari dalam modul Inventory sendiri
        $this->reserveStockAction->execute($event->orderId);
    }
}
```

---

## 5. Anti-Patterns & Edge Cases (❌ vs ✅)

### Anti-Pattern 1: Mengakses Model Database Modul Lain Secara Langsung (Direct DB Coupling)
**Mengapa Berbahaya?** Ini melanggar batas modular. Jika tim `Inventory` mengubah schema database atau relasi model mereka, maka modul `Order` akan langsung rusak (Crash). Ini menciptakan tightly coupled monolith atau biasa disebut Big Ball of Mud. Risiko memory leak tidak langsung, tapi runtime error tinggi saat deployment terpisah.

❌ **KODE SALAH (Bad Practice):**
```php
<?php

declare(strict_types=1);

namespace Modules\Order\Actions;

use Modules\Inventory\Models\Product; // ❌ Pelanggaran Boundary

final class CalculateTotalAction
{
    public function execute(array $items): float
    {
        $total = 0;
        foreach ($items as $item) {
            // ❌ Memanggil model modul lain, direct DB hit.
            $product = Product::find($item['product_id']); 
            $total += $product->price * $item['quantity'];
        }
        return $total;
    }
}
```

✅ **KODE BENAR (Good Practice):**
Gunakan Public Contract/API antar modul. Buat interface di modul asal yang diimplementasikan di modul lain atau panggil service interface yang dieskpos.
```php
<?php

declare(strict_types=1);

namespace Modules\Order\Contracts;

interface ProductPriceProviderInterface
{
    public function getPriceForProduct(string $productId): float;
}
```

```php
<?php

declare(strict_types=1);

namespace Modules\Order\Actions;

use Modules\Order\Contracts\ProductPriceProviderInterface;

final class CalculateTotalAction
{
    public function __construct(
        private readonly ProductPriceProviderInterface $priceProvider,
    ) {}

    public function execute(array $items): float
    {
        $total = 0;
        foreach ($items as $item) {
            // ✅ Memanggil melalui abstraction (contract)
            $price = $this->priceProvider->getPriceForProduct($item['product_id']); 
            $total += $price * $item['quantity'];
        }
        return $total;
    }
}
```

### Anti-Pattern 2: God Controller / Fat Action Classes
**Mengapa Berbahaya?** Menaruh semua proses bisnis dalam controller (atau satu action class besar) membuat kode tidak bisa di-test (untestable), sulit dirawat (unmaintainable), rentan bug jika terjadi perubahan bisnis, dan menyebabkan pelanggaran prinsip Single Responsibility (SRP). Jika proses ini besar, memory footprint dari controller akan naik signifikan saat GC belum berjalan.

❌ **KODE SALAH (Bad Practice):**
```php
<?php

declare(strict_types=1);

namespace Modules\User\Controllers;

use Illuminate\Http\Request;
use Modules\User\Models\User;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use Illuminate\Routing\Controller;
use Exception;

final class RegisterController extends Controller
{
    public function register(Request $request)
    {
        // ❌ Validasi di Controller
        $request->validate(['email' => 'required|email']); 
        
        // ❌ Manipulasi Model Langsung
        $user = new User();
        $user->email = $request->email;
        $user->password = Hash::make($request->password);
        $user->save();

        // ❌ Eksekusi 3rd party logic secara synchronous
        Mail::to($user)->send(new WelcomeEmail());

        return response()->json($user);
    }
}
```

✅ **KODE BENAR (Good Practice):**
Gunakan DTO, FormRequest, Action, dan Job/Event untuk hal-hal yang asinkron (pengiriman email).

```php
<?php

declare(strict_types=1);

namespace Modules\User\Controllers;

use Modules\User\Requests\RegisterRequest;
use Modules\User\Actions\RegisterNewUserAction;
use Illuminate\Http\JsonResponse;
use Illuminate\Routing\Controller;
use Symfony\Component\HttpFoundation\Response;

final class RegisterController extends Controller
{
    public function __construct(
        private readonly RegisterNewUserAction $registerAction
    ) {}

    public function register(RegisterRequest $request): JsonResponse
    {
        // ✅ Validasi diurus FormRequest, Controller hanya orchestrator
        $user = $this->registerAction->execute($request->toDto());

        return response()->json($user, Response::HTTP_CREATED);
    }
}
```

```php
<?php
// Di dalam RegisterNewUserAction.php
// Dispatch event UserRegistered, lalu ada Event Listener yang mengirim email via Queue.
```

---

## 6. Testing di Modular Monolith (Pest v3)

Pest v3 menawarkan DX yang luar biasa untuk menguji modular monolith, dari level fitur hingga batasan arsitektur menggunakan arsitektur bawaannya (Arch Testing).

### 6.1. Unit Test & Feature Test
Gunakan `uses()` untuk meregistrasi test case secara elegan. Kita test action menggunakan `fakes` atau `mocks`.

```php
<?php

declare(strict_types=1);

use Modules\Order\Actions\PlaceNewOrderAction;
use Modules\Order\DataTransferObjects\CreateOrderDto;
use Modules\Order\Contracts\OrderRepositoryInterface;
use Modules\Order\Events\OrderPlaced;
use Modules\Order\Models\Order;
use Illuminate\Support\Facades\Event;

uses(Tests\TestCase::class)->in('Feature');

it('places a new order successfully and dispatches event', function () {
    // Arrange
    Event::fake();
    
    $dto = new CreateOrderDto(
        customerId: 'cus_123',
        items: [['product_id' => 'prd_1', 'quantity' => 2]],
        shippingAddress: '123 Laravel Street',
        paymentMethod: 'credit_card',
    );

    $mockOrder = new Order(['id' => 'ord_123']);
    
    $mockRepo = Mockery::mock(OrderRepositoryInterface::class);
    $mockRepo->shouldReceive('create')
             ->once()
             ->andReturn($mockOrder);
             
    // Fake relasi items() - ini hanya simulasi logic
    $mockOrder->shouldReceive('items->create')->once();

    $action = new PlaceNewOrderAction($mockRepo);

    // Act
    $result = $action->execute($dto);

    // Assert
    expect($result)->toBeInstanceOf(Order::class)
        ->and($result->id)->toBe('ord_123');

    Event::assertDispatched(OrderPlaced::class, function (OrderPlaced $event) {
        return $event->orderId === 'ord_123';
    });
});
```

### 6.2. Architecture Test (Pest Arch)
Arch testing memastikan batasan antar modul dipatuhi tanpa perlu review manusia secara manual. Ini mencegah "spaghetti code" dan kebocoran domain.

```php
<?php

declare(strict_types=1);

test('order module must not depend on inventory module directly')
    ->expect('Modules\Order')
    ->not->toUse('Modules\Inventory');

test('controllers must only use actions and requests')
    ->expect('Modules\Order\Controllers')
    ->toUse([
        'Modules\Order\Actions',
        'Modules\Order\Requests',
        'Illuminate\Http',
        'Symfony\Component\HttpFoundation'
    ])
    ->not->toUse('Modules\Order\Models'); // Controller tidak boleh panggil Model langsung

test('models should be restricted to repositories or actions')
    ->expect('Modules\Order\Models')
    ->toOnlyBeUsedIn([
        'Modules\Order\Repositories',
        'Modules\Order\Actions',
        'Modules\Order\Contracts'
    ]);

test('actions must be strictly typed and single responsibility')
    ->expect('Modules\Order\Actions')
    ->toHaveMethod('execute')
    ->toUseStrictTypes();
```

---

## 7. Penutup & Pertimbangan Skalabilitas

Arsitektur Modular Monolith tidak hanya memisahkan file-file fisik, melainkan menyekat domain logic sedemikian rupa sehingga:
- Setiap domain bisa dipindahkan ke repository terpisah kelak.
- Migrasi dari DB tersentralisasi ke skema _tenant-based_ atau _module-based schema_ bisa dilakukan mulus karena Controller tidak pernah hit tabel relasional dari domain lain secara langsung.
- Peningkatan Testability hingga 100% Code Coverage lebih mungkin diraih menggunakan isolated Unit Tests via mock di DTO / Action level.

Dengan patuh terhadap Clean Architecture (Request -> Controller -> Action -> Repo -> Model) dan pemanfaatan PHP 8.3 `readonly class` DTO serta strict typing, aplikasi Monolith yang masif sekalipun tidak akan pernah menjadi kode warisan (legacy) yang busuk.
