# Hexagonal Architecture (Ports and Adapters) di Laravel 11/12

Hexagonal Architecture, yang juga dikenal sebagai Ports and Adapters Pattern, diperkenalkan oleh Alistair Cockburn pada tahun 2005. Tujuan utamanya adalah untuk memisahkan logika aplikasi utama (Core/Domain) dari layanan eksternal, framework, antarmuka pengguna (UI), dan database. Dengan menerapkan Hexagonal Architecture, aplikasi dapat diuji secara independen (isolated) tanpa bergantung pada database atau web server.

Dalam konteks Laravel, mengadopsi arsitektur ini mencegah _framework lock-in_ dan memudahkan maintenance jangka panjang, terutama ketika kompleksitas bisnis mulai berkembang. Alih-alih membiarkan model Eloquent atau logika infrastruktur menyebar di seluruh aplikasi, kita membatasinya pada lapisan "Adapters" terluar.

## Konsep Inti Hexagonal Architecture

1.  **Core Domain / Application**: Ini adalah inti dari aplikasi Anda yang berisi aturan bisnis (Entities, Value Objects, Domain Events). Lapisan ini **tidak boleh** memiliki dependensi pada framework (Laravel), database (Eloquent), atau pustaka pihak ketiga eksternal. Semua interaksi keluar dari Core menggunakan "Ports".
2.  **Ports (Antarmuka/Interfaces)**: Port adalah definisi antarmuka (interfaces/contracts) tentang bagaimana Core berinteraksi dengan dunia luar. Terdapat dua jenis Port:
    *   **Inbound / Primary Ports**: Antarmuka yang mengekspos _Use Case_ atau operasi bisnis ke dunia luar (misalnya, dipanggil oleh HTTP Controller, Console Command, atau Event Listener). Biasanya berupa interface `UseCase` atau `Action`.
    *   **Outbound / Secondary Ports**: Antarmuka yang dibutuhkan oleh Core untuk berinteraksi dengan infrastruktur eksternal (misalnya, mendapatkan data dari database, mengirim email, memanggil API eksternal). Biasanya berupa interface `Repository` atau `Gateway`.
3.  **Adapters (Implementasi)**: Adapter adalah jembatan antara dunia luar dan Ports. Terdapat dua jenis Adapter:
    *   **Inbound / Primary Adapters**: Kode yang mengonsumsi Inbound Ports. Contoh: HTTP Controllers, Livewire Components, Artisan Commands, Job Handlers. Adapter ini menerjemahkan request spesifik (misal HTTP) menjadi panggilan ke Port aplikasi.
    *   **Outbound / Secondary Adapters**: Kode yang mengimplementasikan Outbound Ports. Contoh: Eloquent Repositories, Redis Cache, AWS S3 File Storage, Mailgun Sender. Adapter ini menerjemahkan panggilan dari Port aplikasi menjadi panggilan ke infrastruktur fisik (query database, HTTP API request).

---

## Anti-Patterns dalam Arsitektur Laravel Standar

Berikut adalah masalah umum (Anti-Patterns) ketika menulis kode tanpa memisahkan *concern* di Laravel, dan bagaimana Hexagonal Architecture menyelesaikannya.

### ❌ Anti-Pattern 1: Leaking Infrastructure to Core

Masalah: Membiarkan objek framework (seperti `Illuminate\Http\Request`) masuk ke dalam Service atau Domain layer. Hal ini sangat berbahaya karena membuat Service tidak bisa digunakan di luar konteks HTTP (misalnya dari Artisan Console atau Job Queue) dan sulit untuk di-test secara independen. Ini melanggar isolasi Domain.

**❌ KODE SALAH (Berbahaya & Terikat HTTP):**
```php
<?php

declare(strict_types=1);

namespace App\Services;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;

final class UserRegistrationService
{
    // ❌ BAD: Service menerima Request langsung dari Controller.
    // Tidak bisa dipanggil dari CLI command tanpa melakukan fake request.
    public function execute(Request $request): User
    {
        // ❌ BAD: Validasi di dalam service menggunakan request langsung (leaky abstraction)
        $request->validate([
            'email' => ['required', 'email', 'unique:users,email'],
            'password' => ['required', 'min:8'],
        ]);

        return User::create([
            'name' => $request->string('name')->toString(),
            'email' => $request->string('email')->toString(),
            'password' => Hash::make($request->string('password')->toString()),
        ]);
    }
}
```

**✅ KODE BENAR (Hexagonal: Data Transfer Object & Use Case):**
```php
<?php

declare(strict_types=1);

namespace Core\User\Application\UseCases;

use Core\User\Application\DTO\RegisterUserCommand;
use Core\User\Domain\Contracts\UserRepositoryInterface;
use Core\User\Domain\Contracts\HashServiceInterface;
use Core\User\Domain\Entities\User;

final readonly class RegisterUserUseCase
{
    public function __construct(
        private UserRepositoryInterface $userRepository,
        private HashServiceInterface $hashService,
    ) {}

    // ✅ GOOD: Menerima DTO murni, bukan HTTP Request.
    // Dapat dipanggil secara persis dari Controller, CLI, atau Job.
    public function execute(RegisterUserCommand $command): User
    {
        if ($this->userRepository->existsByEmail($command->email)) {
            throw new \DomainException("User with email {$command->email} already exists.");
        }

        $user = new User(
            id: null,
            name: $command->name,
            email: $command->email,
            passwordHash: $this->hashService->make($command->password),
        );

        return $this->userRepository->save($user);
    }
}
```

### ❌ Anti-Pattern 2: Active Record / Eloquent Menjadi Core Domain

Masalah: Model Eloquent (`Illuminate\Database\Eloquent\Model`) menangani urusan database (koneksi, query builder, mutator), tetapi seringkali dibebani dengan logika bisnis, rules kalkulasi, dan pengiriman notifikasi. Ini melanggar _Single Responsibility Principle_ dan membuat testing lambat karena selalu memerlukan database (walaupun in-memory sqlite). Selain itu, perubahan struktur database akan langsung memaksa perubahan pada logika bisnis.

**❌ KODE SALAH (Fat Model):**
```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use App\Notifications\OrderConfirmed;
use Illuminate\Support\Facades\Notification;

final class Order extends Model
{
    // ❌ BAD: Model database memegang logika bisnis dan memanggil layanan eksternal (Notification)
    public function confirmAndNotify(): void
    {
        if ($this->status !== 'pending') {
            throw new \Exception('Only pending orders can be confirmed');
        }

        $this->update(['status' => 'confirmed']);
        $this->calculateTotalWithTaxes();
        
        // ❌ BAD: Model melakukan Side-Effect (Notification/Email)
        Notification::send($this->user, new OrderConfirmed($this));
    }

    private function calculateTotalWithTaxes(): void
    {
        // ... kompleksitas kalkulasi pajak langsung di model database
    }
}
```

**✅ KODE BENAR (Hexagonal: Pure Domain Entity & Outbound Port):**
```php
<?php

declare(strict_types=1);

namespace Core\Order\Domain\Entities;

use Core\Order\Domain\ValueObjects\OrderId;
use Core\Order\Domain\ValueObjects\Money;
use Core\Order\Domain\Enums\OrderStatus;

// ✅ GOOD: Pure PHP Class. Sama sekali tidak extend model Eloquent.
final class Order
{
    private OrderStatus $status;
    
    public function __construct(
        public readonly OrderId $id,
        private Money $totalAmount,
        OrderStatus $status,
    ) {
        $this->status = $status;
    }

    // ✅ GOOD: Logika bisnis diisolasi di Domain Entity murni, tanpa efek samping infrastruktur.
    public function confirm(): void
    {
        if ($this->status !== OrderStatus::PENDING) {
            throw new \DomainException('Only pending orders can be confirmed.');
        }

        $this->status = OrderStatus::CONFIRMED;
    }
    
    public function getStatus(): OrderStatus
    {
        return $this->status;
    }
}
```

---

## Struktur Direktori Rekomendasi (Domain-Driven Hexagonal)

Untuk mengimplementasikan Hexagonal Architecture dengan baik, ubah struktur standar Laravel agar lebih merefleksikan _Bounded Contexts_ dan pemisahan lapisan (Layers).

```text
app/
├── Http/                   # Inbound Adapters (Controllers, Middleware, Requests)
├── Console/                # Inbound Adapters (Artisan Commands)
├── Infrastructure/         # Outbound Adapters (Eloquent, Third Party APIs, Mails)
│   ├── Persistence/        # Implementasi Repository (EloquentRepository)
│   └── Services/           # Implementasi Service eksternal (StripeAdapter)
src/
└── Core/                   # The Hexagon (Core Application)
    └── Order/              # Bounded Context: Order
        ├── Application/    # Application Layer
        │   ├── DTO/        # Data Transfer Objects untuk input Use Cases
        │   └── UseCases/   # Inbound Ports (Application Services)
        └── Domain/         # Domain Layer
            ├── Contracts/  # Outbound Ports (Repository Interfaces, Service Interfaces)
            ├── Entities/   # Pure PHP Domain Models
            ├── ValueObjects/ # Immutable Domain Objects (Money, Email, UUID)
            └── Exceptions/ # Domain-specific Exceptions
```

---

## Implementasi Kode Komprehensif: Sistem Pemesanan

Mari kita lihat contoh aliran lengkap dari Controller (Inbound Adapter) ke Use Case (Inbound Port) ke Entity (Core) hingga ke Eloquent Repository (Outbound Adapter).

### 1. Domain (Entities & Value Objects)

Domain layer adalah inti aplikasi. Tidak boleh ada `use Illuminate\...` di sini (kecuali Collections jika sangat dibutuhkan, meskipun array murni/DTO collection lebih baik).

```php
<?php

declare(strict_types=1);

namespace Core\Order\Domain\ValueObjects;

use InvalidArgumentException;

final readonly class EmailAddress
{
    public function __construct(public string $value)
    {
        if (!filter_var($value, FILTER_VALIDATE_EMAIL)) {
            throw new InvalidArgumentException("Invalid email format: {$value}");
        }
    }
}
```

### 2. Outbound Ports (Interfaces)

Mendefinisikan kontrak yang harus dipenuhi oleh infrastruktur (database, payment gateway).

```php
<?php

declare(strict_types=1);

namespace Core\Order\Domain\Contracts;

use Core\Order\Domain\Entities\Order;
use Core\Order\Domain\ValueObjects\OrderId;

interface OrderRepositoryInterface
{
    /**
     * Menyimpan domain entity Order ke storage
     */
    public function save(Order $order): void;

    /**
     * Mengambil domain entity Order berdasarkan ID
     * 
     * @throws \Core\Order\Domain\Exceptions\OrderNotFoundException
     */
    public function getById(OrderId $id): Order;
}
```

```php
<?php

declare(strict_types=1);

namespace Core\Order\Domain\Contracts;

use Core\Order\Domain\Entities\Order;

interface PaymentGatewayInterface
{
    /**
     * Mengisi / men-charge payment untuk sebuah order
     *
     * @throws \Core\Order\Domain\Exceptions\PaymentFailedException
     */
    public function charge(Order $order, string $paymentToken): bool;
}
```

### 3. Application Layer (DTOs & Use Cases)

Application layer mengatur orkestrasi antara domain objects dan outbound ports.

```php
<?php

declare(strict_types=1);

namespace Core\Order\Application\DTO;

final readonly class ProcessCheckoutCommand
{
    public function __construct(
        public string $customerId,
        public array $itemIds,
        public string $paymentToken,
    ) {}
}
```

```php
<?php

declare(strict_types=1);

namespace Core\Order\Application\UseCases;

use Core\Order\Application\DTO\ProcessCheckoutCommand;
use Core\Order\Domain\Contracts\OrderRepositoryInterface;
use Core\Order\Domain\Contracts\PaymentGatewayInterface;
use Core\Order\Domain\Entities\Order;
use Core\Order\Domain\ValueObjects\OrderId;

final readonly class ProcessCheckoutUseCase
{
    public function __construct(
        private OrderRepositoryInterface $orderRepository,
        private PaymentGatewayInterface $paymentGateway,
    ) {}

    public function execute(ProcessCheckoutCommand $command): Order
    {
        // 1. Rekonstruksi atau pembuatan Entity (Biasanya dipanggil dari factory)
        $order = Order::create(
            id: OrderId::generate(),
            customerId: $command->customerId,
            items: $command->itemIds
        );
        
        // 2. Interaksi dengan dunia luar via Outbound Port
        $this->paymentGateway->charge($order, $command->paymentToken);
        
        // 3. Mutasi status domain (Business Rule)
        $order->confirm();
        
        // 4. Simpan ke infrastruktur via Outbound Port
        $this->orderRepository->save($order);
        
        return $order;
    }
}
```

### 4. Inbound Adapters (HTTP Controller & Form Request)

Menerjemahkan request HTTP framework menjadi DTO yang dimengerti oleh Application Layer.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Order;

use Illuminate\Foundation\Http\FormRequest;

final class CheckoutRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // Asumsi ada middleware auth
    }

    public function rules(): array
    {
        return [
            'items' => ['required', 'array', 'min:1'],
            'items.*' => ['required', 'string', 'uuid'],
            'payment_token' => ['required', 'string'],
        ];
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Order;

use App\Http\Controllers\Controller;
use App\Http\Requests\Order\CheckoutRequest;
use Core\Order\Application\DTO\ProcessCheckoutCommand;
use Core\Order\Application\UseCases\ProcessCheckoutUseCase;
use Illuminate\Http\JsonResponse;

final class CheckoutController extends Controller
{
    public function __construct(
        private readonly ProcessCheckoutUseCase $checkoutUseCase
    ) {}

    public function __invoke(CheckoutRequest $request): JsonResponse
    {
        // 1. Translasi framework HTTP request menjadi aplikasi DTO murni
        $command = new ProcessCheckoutCommand(
            customerId: (string) $request->user()->id,
            itemIds: $request->array('items'),
            paymentToken: $request->string('payment_token')->toString(),
        );

        // 2. Eksekusi Use Case
        $order = $this->checkoutUseCase->execute($command);

        // 3. Kembalikan representasi ke framework (Inbound Adapter responsibility)
        return response()->json([
            'message' => 'Order processed successfully.',
            'order_id' => $order->id->value,
        ], 201);
    }
}
```

### 5. Outbound Adapters (Eloquent Repository)

Menerjemahkan penyimpanan Domain Entity murni menjadi interaksi database Eloquent.

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Persistence\Order;

use Core\Order\Domain\Contracts\OrderRepositoryInterface;
use Core\Order\Domain\Entities\Order;
use Core\Order\Domain\ValueObjects\OrderId;
use Core\Order\Domain\Exceptions\OrderNotFoundException;
use App\Models\Order as EloquentOrder; // Model Eloquent framework

final readonly class EloquentOrderRepository implements OrderRepositoryInterface
{
    public function save(Order $order): void
    {
        // Translasi Domain Model -> Database Model (Data Mapper Pattern)
        EloquentOrder::updateOrCreate(
            ['id' => $order->id->value],
            [
                'customer_id' => $order->getCustomerId(),
                'status' => $order->getStatus()->value,
                'total_amount' => $order->getTotal()->getAmount(),
            ]
        );
    }

    public function getById(OrderId $id): Order
    {
        $eloquentModel = EloquentOrder::find($id->value);

        if ($eloquentModel === null) {
            throw new OrderNotFoundException("Order with ID {$id->value} not found.");
        }

        // Translasi Database Model -> Domain Model
        return new Order(
            id: new OrderId($eloquentModel->id),
            customerId: $eloquentModel->customer_id,
            // ... instansiasi domain object
        );
    }
}
```

*Catatan: Jangan lupa me-register repository binding di Service Provider (contoh `AppServiceProvider`).*
```php
$this->app->bind(OrderRepositoryInterface::class, EloquentOrderRepository::class);
```

---

## Pest v3 Testing (Architecture & Unit Testing)

Keuntungan utama Hexagonal Architecture adalah *testability*. Kita dapat menggunakan **Pest v3** untuk Architecture Testing guna mencegah _leaking_ (pelanggaran batas arsitektur) dan Unit Testing yang super cepat karena tidak memerlukan database atau framework booting penuh.

### 1. Architecture Testing (Arch Pest)

Pest menyediakan plugin `pestphp/pest-plugin-arch` untuk memastikan aturan Hexagonal Architecture ditaati oleh tim pengembang. Kita akan membuat tes untuk memastikan layer `Core` (Domain dan Application) murni dari Framework Laravel.

File: `tests/Feature/Architecture/HexagonalArchTest.php`

```php
<?php

declare(strict_types=1);

use Pest\Expectation;

// 1. Memastikan Domain Layer MURNI (Tidak ada ketergantungan ke framework atau infrastruktur)
test('domain layer is pure and does not depend on framework or infrastructure')
    ->expect('Core\*\Domain')
    ->toUseNothing()
    ->ignoring([
        'InvalidArgumentException',
        'DomainException',
        'Exception',
        'Stringable',
        // Izinkan native PHP types dan class murni PHP lainnya
    ])
    ->and('Core\*\Domain')
    ->not->toUse([
        'Illuminate',
        'App\Models',
        'App\Http',
        'App\Infrastructure'
    ]);

// 2. Memastikan Application Layer hanya bergantung pada Domain dan DTO
test('application layer only depends on domain and its own DTOs')
    ->expect('Core\*\Application\UseCases')
    ->toOnlyUse([
        'Core\*\Domain',
        'Core\*\Application\DTO',
    ])
    ->ignoring([
        // exception standar, interface khusus log jika disetujui, dll.
    ]);

// 3. Memastikan Controllers (Inbound Adapter) tidak mengakses Eloquent Model secara langsung (Strict Layering)
test('controllers must not use eloquent models directly, they must use application use cases')
    ->expect('App\Http\Controllers')
    ->not->toUse('App\Models')
    ->and('App\Http\Controllers')
    ->toUse('Core\*\Application\UseCases');

// 4. Memastikan Infrastruktur di-implementasi secara independen
test('infrastructure layer must depend on outbound ports')
    ->expect('App\Infrastructure\Persistence')
    ->toUse('Core\*\Domain\Contracts');
```

### 2. Unit Testing Murni Cepat Tanpa Database

Karena Use Case (Application layer) menerima Outbound Ports sebagai interface, kita bisa membuat Fakes murni (Mocking) untuk mempercepat testing. **Tanpa perlu traits `RefreshDatabase`.**

File: `tests/Unit/Application/ProcessCheckoutUseCaseTest.php`

```php
<?php

declare(strict_types=1);

namespace Tests\Unit\Application;

use Core\Order\Application\DTO\ProcessCheckoutCommand;
use Core\Order\Application\UseCases\ProcessCheckoutUseCase;
use Core\Order\Domain\Contracts\OrderRepositoryInterface;
use Core\Order\Domain\Contracts\PaymentGatewayInterface;
use Core\Order\Domain\Entities\Order;
use Core\Order\Domain\Exceptions\PaymentFailedException;

// Membuat fakes sederhana untuk testing.
// Bisa juga menggunakan mock library dari Pest/Mockery, namun fakes anonymous class lebih transparan dan tipe-aman.
$repositoryFake = new class implements OrderRepositoryInterface {
    public ?Order $savedOrder = null;
    public function save(Order $order): void {
        $this->savedOrder = $order;
    }
    public function getById(\Core\Order\Domain\ValueObjects\OrderId $id): Order {
        throw new \Exception('Not implemented for test');
    }
};

$paymentFake = new class implements PaymentGatewayInterface {
    public bool $shouldFail = false;
    public function charge(Order $order, string $paymentToken): bool {
        if ($this->shouldFail) {
            throw new PaymentFailedException("Card declined");
        }
        return true;
    }
};

beforeEach(function () use ($repositoryFake, $paymentFake) {
    $this->repository = clone $repositoryFake;
    $this->paymentGateway = clone $paymentFake;
    $this->useCase = new ProcessCheckoutUseCase($this->repository, $this->paymentGateway);
});

it('successfully processes checkout and saves confirmed order', function () {
    // Arrange
    $command = new ProcessCheckoutCommand(
        customerId: 'customer-123',
        itemIds: ['item-1', 'item-2'],
        paymentToken: 'tok_visa_valid'
    );

    // Act
    $order = $this->useCase->execute($command);

    // Assert
    expect($order)->toBeInstanceOf(Order::class);
    
    // Verifikasi state business rules. Order harus berstatus CONFIRMED (bukan PENDING).
    expect($order->getStatus()->value)->toBe('confirmed');
    
    // Verifikasi bahwa data disimpan ke repository (Outbound Port terpanggil)
    expect($this->repository->savedOrder)->toBe($order);
});

it('fails checkout if payment is declined', function () {
    // Arrange
    $this->paymentGateway->shouldFail = true;
    
    $command = new ProcessCheckoutCommand(
        customerId: 'customer-123',
        itemIds: ['item-1'],
        paymentToken: 'tok_declined'
    );

    // Act & Assert
    expect(fn() => $this->useCase->execute($command))
        ->toThrow(PaymentFailedException::class, "Card declined");
        
    // Verifikasi bahwa order tidak tersimpan ke DB karena charge gagal sebelumnya
    expect($this->repository->savedOrder)->toBeNull();
});
```

---

## Kesimpulan Trade-Offs

**Kelebihan:**
1.  **Framework Agnostic:** Logika bisnis tidak terkunci ke satu versi Laravel (atau bahkan ke framework PHP lain).
2.  **Highly Testable:** Unit tests dapat berjalan seketika karena dapat dengan mudah mem-mock Outbound Ports tanpa bootstrapping framework database yang berat.
3.  **Modular & Maintainable:** Mudah digabungkan dalam arsitektur berskala besar; developer baru bisa fokus membaca folder `Core/` saja untuk memahami aturan bisnis tanpa distraksi routing/ORM.
4.  **Adaptabilitas Infrastruktur Tinggi:** Jika mengganti payment gateway dari Stripe ke Xendit, atau mengganti Elasticsearch dengan Meilisearch, cukup ubah Adapternya, _tanpa pernah menyentuh Core layer_.

**Kekurangan:**
1.  **Overhead Kode (Boilerplate):** Lebih banyak class dan interface (DTO, Ports, UseCases, Repositories, Entities) dibanding arsitektur Controller-Eloquent standar.
2.  **Kurva Pembelajaran:** Developer yang terbiasa dengan "Laravel-way" Active Record (Eloquent magic) akan butuh adaptasi mental karena strict isolation.
3.  **Tidak Cocok untuk CRUD Sederhana:** Jika aplikasi hanya menampilkan database ke views/API (Create, Read, Update, Delete murni), Hexagonal justru membuat over-engineering. Harus digunakan secara cermat pada _Complex Bounded Contexts_ saja.
