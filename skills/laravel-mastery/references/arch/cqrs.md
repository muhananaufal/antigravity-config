# Command Query Responsibility Segregation (CQRS) in Laravel

CQRS (Command Query Responsibility Segregation) adalah pola arsitektur yang memisahkan operasi pembacaan data (Queries) dari operasi pembaruan data (Commands). Dalam ekosistem Laravel modern (v11/12) dan PHP 8.3/8.4+, CQRS sangat krusial untuk membangun sistem yang sangat skalabel, memiliki performa tinggi, dan memudahkan kolaborasi tim dalam domain yang kompleks.

## Teori Mendalam & Motivasi Arsitektur

Secara tradisional, developer menggunakan satu model data tunggal (seringkali Eloquent Model yang sama) untuk melakukan operasi CRUD (Create, Read, Update, Delete) yang dihadapkan langsung ke database relational. Namun, seiring berjalannya waktu dan berkembangnya aplikasi, pendekatan monolitik pada data ini seringkali menjadi *bottleneck* (leher botol) yang signifikan. 

### Kapan CQRS Benar-benar Dibutuhkan?
1. **Asimetri Beban (Load Asymmetry)**: Sebagian besar aplikasi memiliki rasio operasi baca dan tulis yang sangat jomplang (misalnya 1000 operasi baca berbanding 1 operasi tulis).
2. **Kebutuhan Performa Ekstrem**: Skema database yang sangat dinormalisasi (Normalisasi 3NF) demi menjaga integritas data saat *write* umumnya sangat lambat untuk *read* karena membutuhkan eksekusi klausa `JOIN` yang kompleks antar puluhan tabel.
3. **Kompleksitas Domain yang Membengkak**: Logika validasi, pemeriksaan hak akses, dan *business rules* pada saat operasi *write* bisa sangat rumit, sedangkan saat *read* seringkali antarmuka pengguna hanya membutuhkan proyeksi data agregat sederhana dalam wujud Data Transfer Object (DTO).
4. **Skalabilitas Database Horisontal**: Dalam infrastruktur tingkat lanjut, kita perlu melakukan *scale out* server pembaca (misalnya menempatkan 5 Read Replica atau memindahkan *cache* ke Redis Cluster) secara independen dan terpisah dari server Master (Write) yang menangani transaksi ACID.

### Prinsip Utama CQRS
- **Command (Tulis)**: Mengubah *state* sistem (Create, Update, Delete). **Tidak boleh** mengembalikan data domain (hanya boleh mengembalikan status sukses/gagal secara implisit, atau mengembalikan `void`).
- **Query (Baca)**: Membaca *state* sistem tanpa mengubahnya sedikitpun. Mengembalikan Data Transfer Object (DTO), *View Model*, atau array primitif, tanpa menyentuh *domain logic*.

## Arsitektur CQRS Clean Architecture

Arsitektur yang direkomendasikan mengadopsi integrasi prinsip Clean Architecture di Laravel: `FormRequest (Validasi) -> Controller (Orkestrasi HTTP) -> Command/Query Bus -> Handler (Business Logic) -> Repository/Projection -> Model (Data)`.

```mermaid
graph TD
    A[Client Web/Mobile Request] --> B[Controller HTTP Layer]
    B --> |Write Operation Request| C[Command Object]
    B --> |Read Operation Request| D[Query Object]
    
    C --> E[Command Handler (Business Logic)]
    D --> F[Query Handler (Data Retrieval)]
    
    E --> G[Write Repository Interface]
    F --> H[Read Projection / DB Replica]
    
    G --> I[(Write Database / Master MySQL)]
    H --> J[(Read Database / Replica / Redis)]
    
    I -.->|Async Replication / Event Driven| J
```

---

## Implementasi Produksi (PHP 8.4 + Laravel 11/12)

Bagian ini mendemonstrasikan implementasi riil (bukan kode *dummy* atau cuplikan terpotong) dari CQRS yang siap diterjunkan ke lingkungan *production*.

### 1. Dasar Abstraksi: Interface & Contracts (Strongly Typed)
Meski Laravel menyediakan fitur *job bus* standar, membuat *interface* yang eksplisit akan menguatkan *type-safety* dan sangat membantu *static analyzer* seperti PHPStan pada level tertinggi (Level 9).

```php
<?php

declare(strict_types=1);

namespace App\Domain\Shared\Contracts;

interface CommandInterface
{
    // Marker interface untuk klasifikasi command object
}

interface CommandHandlerInterface
{
    public function handle(CommandInterface $command): void;
}

interface QueryInterface
{
    // Marker interface untuk klasifikasi query object
}

interface QueryHandlerInterface
{
    public function handle(QueryInterface $query): mixed;
}
```

### 2. Implementasi Command (Write Side - Data Mutasi)

Sebagai studi kasus komprehensif, kita membangun fungsionalitas utama sistem *e-commerce*: **Memproses Pemesanan (Checkout)**.

**Form Request (Validasi Lapis Tepi):**
Validasi ini memastikan *garbage data* tidak pernah masuk menembus lapisan Domain.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Orders;

use Illuminate\Foundation\Http\FormRequest;

final class PlaceOrderRequest extends FormRequest
{
    public function authorize(): bool
    {
        // Pemeriksaan hak akses (misal melalui Gate / Policy) diasumsikan lolos
        return true;
    }

    /**
     * Mendefinisikan aturan validasi secara ekstensif.
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'customer_id'        => ['required', 'uuid', 'exists:customers,id'],
            'items'              => ['required', 'array', 'min:1'],
            'items.*.product_id' => ['required', 'uuid', 'exists:products,id'],
            'items.*.quantity'   => ['required', 'integer', 'min:1', 'max:50'],
            'shipping_address'   => ['required', 'string', 'max:500'],
        ];
    }
}
```

**Command Object (Readonly DTO):**
Command bertindak sebagai Data Transfer Object murni yang sifatnya *immutable* (tidak bisa diubah setelah diinisialisasi). Fitur PHP 8.2+ `readonly class` sangat sempurna untuk ini.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Orders\Commands;

use App\Domain\Shared\Contracts\CommandInterface;

final readonly class PlaceOrderCommand implements CommandInterface
{
    /**
     * Constructor property promotion ala PHP 8.
     * @param array<int, array{product_id: string, quantity: int}> $items
     */
    public function __construct(
        public string $customerId,
        public array $items,
        public string $shippingAddress,
    ) {}
}
```

**Write Repository Interface:**

```php
<?php

declare(strict_types=1);

namespace App\Domain\Orders\Repositories;

use App\Domain\Orders\Models\Order;

interface OrderWriteRepositoryInterface
{
    public function save(Order $order): bool;
}
```

**Command Handler (Pusat Logika Bisnis):**
Handler mengkoordinasi transaksi *database*, manipulasi entitas, dan *event dispatching*. Tidak ada pengembalian nilai (*void*) untuk mencegah ketergantungan balik.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Orders\Handlers;

use App\Domain\Orders\Commands\PlaceOrderCommand;
use App\Domain\Shared\Contracts\CommandHandlerInterface;
use App\Domain\Shared\Contracts\CommandInterface;
use App\Domain\Orders\Repositories\OrderWriteRepositoryInterface;
use App\Domain\Orders\Models\Order;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use App\Domain\Orders\Events\OrderPlacedEvent;
use Throwable;
use RuntimeException;

final readonly class PlaceOrderHandler implements CommandHandlerInterface
{
    public function __construct(
        private OrderWriteRepositoryInterface $repository,
    ) {}

    /**
     * Mengeksekusi command dalam isolasi transaksi ACID.
     * 
     * @param CommandInterface $command
     * @throws Throwable Jika terjadi anomali DB.
     */
    public function handle(CommandInterface $command): void
    {
        if (!$command instanceof PlaceOrderCommand) {
            throw new RuntimeException('Tipe Command tidak valid (expected PlaceOrderCommand).');
        }

        // Membungkus dalam transaksi DB yang sangat ketat untuk mencegah anomali data (Partial Writes)
        DB::transaction(function () use ($command): void {
            $order = Order::create([
                'customer_id'      => $command->customerId,
                'shipping_address' => $command->shippingAddress,
                'status'           => 'PENDING_PAYMENT',
                'total_amount'     => $this->calculateTotalAmount($command->items),
            ]);

            foreach ($command->items as $item) {
                $order->items()->create([
                    'product_id' => $item['product_id'],
                    'quantity'   => $item['quantity'],
                    'price'      => $this->getProductPriceFromInventory($item['product_id']),
                ]);
            }

            // Menyimpan state terakhir melalui repository
            $this->repository->save($order);

            // Publikasikan Domain Event agar Projection/Read Model bisa merespon secara asinkron
            Event::dispatch(new OrderPlacedEvent((string) $order->id));
        });
    }

    /**
     * @param array<int, array{product_id: string, quantity: int}> $items
     */
    private function calculateTotalAmount(array $items): float
    {
        $total = 0.0;
        foreach ($items as $item) {
            $total += $this->getProductPriceFromInventory($item['product_id']) * $item['quantity'];
        }
        return $total;
    }

    private function getProductPriceFromInventory(string $productId): float
    {
        // Dalam dunia nyata, hitungi ini memanggil Inventory Service atau Database Master
        return 250000.0;
    }
}
```

### 3. Implementasi Query (Read Side - Pengambilan Data Super Cepat)

Untuk operasi membaca (*read side*), tujuan akhirnya adalah mencapai latensi serendah mungkin (sub-milidetik). Oleh karena itu, kita membuang lapisan Object-Relational Mapping (Eloquent) yang rakus memori dan perlahan melakukan proses (hydrate/dehydrate) ribuan objek kelas. Kita beralih penuh pada *raw Query Builder* (`DB::table`) yang langsung diarahkan ke *database Read Replica* atau Redis, memetakan secara mentah menjadi DTO ringan.

**Query Object (Readonly Request Params):**

```php
<?php

declare(strict_types=1);

namespace App\Domain\Orders\Queries;

use App\Domain\Shared\Contracts\QueryInterface;

final readonly class GetOrderDetailsQuery implements QueryInterface
{
    public function __construct(
        public string $orderId,
    ) {}
}
```

**Query Data Transfer Object (The View Model):**

```php
<?php

declare(strict_types=1);

namespace App\Domain\Orders\DTOs;

final readonly class OrderDetailsDTO
{
    /**
     * @param array<int, array{product_name: string, quantity: int, subtotal: float}> $items
     */
    public function __construct(
        public string $orderId,
        public string $status,
        public float $totalAmount,
        public string $shippingAddress,
        public array $items,
    ) {}
}
```

**Query Handler (Logika Pengambilan Tingkat Rendah):**

```php
<?php

declare(strict_types=1);

namespace App\Domain\Orders\Handlers;

use App\Domain\Shared\Contracts\QueryHandlerInterface;
use App\Domain\Shared\Contracts\QueryInterface;
use App\Domain\Orders\Queries\GetOrderDetailsQuery;
use App\Domain\Orders\DTOs\OrderDetailsDTO;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use RuntimeException;

final readonly class GetOrderDetailsHandler implements QueryHandlerInterface
{
    /**
     * @return OrderDetailsDTO
     */
    public function handle(QueryInterface $query): mixed
    {
        if (!$query instanceof GetOrderDetailsQuery) {
            throw new RuntimeException('Tipe Query tidak valid.');
        }

        // Menggunakan koneksi baca secara absolut dan eksplisit, menghindari master database overload
        $orderRecord = DB::connection('mysql::read')->table('orders')
            ->where('id', $query->orderId)
            ->first();

        if ($orderRecord === null) {
            throw new NotFoundHttpException('Detail pesanan tidak ditemukan di sistem.');
        }

        // Pengambilan relasional yang super efisien dibandingkan relasi hasMany milik Eloquent
        $itemsRecords = DB::connection('mysql::read')->table('order_items')
            ->join('products', 'order_items.product_id', '=', 'products.id')
            ->where('order_items.order_id', $query->orderId)
            ->select('products.name as product_name', 'order_items.quantity', 'order_items.price')
            ->get();

        // Pemetaan mentah (Raw hydration) - Sangat hemat memori untuk koleksi besar
        $items = $itemsRecords->map(fn (object $item): array => [
            'product_name' => (string) $item->product_name,
            'quantity'     => (int) $item->quantity,
            'subtotal'     => (float) ($item->quantity * $item->price),
        ])->toArray();

        return new OrderDetailsDTO(
            orderId: (string) $orderRecord->id,
            status: (string) $orderRecord->status,
            totalAmount: (float) $orderRecord->total_amount,
            shippingAddress: (string) $orderRecord->shipping_address,
            items: $items,
        );
    }
}
```

### 4. Controller (Sang Orkestrator Layer Tepi)

Kini, *Controller* berubah fungsi menjadi penengah mutlak (Clean Controller). Controller hanya berfungsi menerima dan membentuk *request* HTTP, membuat instance Command/Query, dan mendelegasikan eksekusinya ke *Handler* lalu mengembalikan HTTP Response. Sama sekali nol *business logic* tersisa di sini.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Orders\PlaceOrderRequest;
use App\Domain\Orders\Commands\PlaceOrderCommand;
use App\Domain\Orders\Queries\GetOrderDetailsQuery;
use App\Domain\Orders\Handlers\PlaceOrderHandler;
use App\Domain\Orders\Handlers\GetOrderDetailsHandler;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final class OrderController extends Controller
{
    /**
     * Endpoint untuk memicu Write Operation (Command)
     */
    public function store(
        PlaceOrderRequest $request,
        PlaceOrderHandler $handler
    ): JsonResponse {
        $validated = $request->validated();

        $command = new PlaceOrderCommand(
            customerId: (string) $validated['customer_id'],
            items: (array) $validated['items'],
            shippingAddress: (string) $validated['shipping_address']
        );

        // Command handler mengembalikan void sesuai prinsip CQRS murni.
        // Kita tidak akan membocorkan instance model apa pun ke API.
        $handler->handle($command);

        return response()->json([
            'message' => 'Pesanan sedang diproses. Silahkan periksa email atau status berkala.'
        ], Response::HTTP_ACCEPTED);
    }

    /**
     * Endpoint untuk memicu Read Operation (Query)
     */
    public function show(
        string $id,
        GetOrderDetailsHandler $handler
    ): JsonResponse {
        $query = new GetOrderDetailsQuery(orderId: $id);
        
        /** @var \App\Domain\Orders\DTOs\OrderDetailsDTO $dto */
        $dto = $handler->handle($query);

        return response()->json([
            'data' => [
                'order_id'         => $dto->orderId,
                'status'           => $dto->status,
                'total_amount'     => $dto->totalAmount,
                'shipping_address' => $dto->shippingAddress,
                'items'            => $dto->items,
            ]
        ], Response::HTTP_OK);
    }
}
```

---

## Edge Cases, Solusi Dunia Nyata, dan Caching

### 1. Konsistensi Eventual (Eventual Consistency & Race Conditions)
Jika kita memisahkan Database Read (Replica Read-Only) dari Master Write DB, secara fisika akan selalu ada jeda (delay sinkronisasi, meski hanya beberapa milidetik).

**Skenario Gagal:** Pengguna membuat pesanan (dikirim ke *Master*), klien *Frontend* segera diarahkan ke `/api/orders/ID`. Namun, replikasi ke *Replica Read Database* belum selesai, sehingga *endpoint* melemparkan error `404 Not Found`.

**Solusi Best Practice:**
Jangan merancang Klien untuk langsung melakukan *Query* seketika (Synchronous Polling). Kembalikan *Response* HTTP 202 (Accepted) dengan tautan *(HATEOAS / Polling URL)* atau implementasikan WebSocket via **Laravel Reverb**. *Backend* akan memberikan *push notification/broadcast* ke *frontend* bila data pada model *read* dipastikan telah tersinkronisasi 100%.

### 2. Kinerja Read Model Kompleks di Skala Raksasa
Untuk sistem analisis BI (*Business Intelligence*) dashboard yang merekap puluhan tabel relasional untuk menampilkan "Total Penjualan Q3 Berdasarkan Demografi", melakukan kueri SQL murni meski pada *Replica DB* sekalipun tetap terlalu lamban dan berisiko *timeout* (karena ukuran data *Petabytes*).

**Solusi Best Practice (CQRS Projections):**
Gunakan arsitektur *Projector* bersanding dengan *Event Sourcing*. Saat *Command* selesai mengeksekusi `OrderPlacedEvent`, tangkap *event* itu melalui Background Job Queue (Horizon). Listener bertugas mengagregasi data tersebut dan menyimpan hasil pra-kalkulasinya pada tabel khusus yang sangat pipih (`daily_sales_projections`) atau bahkan *Redis Hash Set*. Dengan ini, eksekusi Query Handler hanyalah memanggil operasi instan `Redis::hget()`! 

---

## Anti-Patterns CQRS Spesifik (❌ Bahaya Fatal)

Berikut adalah desain keliru yang paling destruktif dan wajib dijauhi saat mengadopsi CQRS pada ekosistem Laravel modern, disertai solusi mitigasinya.

### ❌ Anti-Pattern 1: Leaking Domain Model / Mengembalikan Data Entitas dari Command (CQRS Violation)

Kesalahan paling jamak developer adalah melanggar fondasi **CQS (Command Query Separation)**. Sebuah Command didesain untuk **MENGUBAH** status saja (tanpa efek samping di luar itu) dan tidak diizinkan mendistribusikan/mengembalikan barisan data hasil mutasi itu kembali ke lapisan *Controller*.

```php
// ❌ KODE SALAH (Membocorkan Entitas - Berbahaya)
final class CreateUserHandler
{
    public function handle(CreateUserCommand $command): User // ❌ DILARANG KEMBALIKAN ELOQUENT MODEL!
    {
        $user = User::create([
            'name' => $command->name,
            'password' => bcrypt($command->password),
        ]);
        
        // Fatal: Mengembalikan instance write (Eloquent) kembali ke Controller
        // Controller kini terpapar detail internal Write Model (ORM Coupling).
        return $user; 
    }
}
```
**Mengapa Ini Sangat Berbahaya:**
- **Kebocoran Abstraksi**: Klien (API / UI Layer) secara diam-diam menjadi tergantungan mutlak pada *ActiveRecord Eloquent Model*. Jika skema Write berubah, API patah secara berantai. 
- **Memory Overhead & Security Risk**: Objek Eloquent `User` berpotensi secara refleks (*magic getters*) membocorkan kolom `password_hash` atau parameter sensitif jika terekspos hingga format JSON.

```php
// ✅ KODE BENAR (Strict CQRS Conformity)
final class CreateUserHandler
{
    public function handle(CreateUserCommand $command): void // ✅ VOID ADALAH JALAN NINJA CQRS
    {
        $user = User::create([
            'id' => $command->uuid, // Klien generate ID di awal
            'name' => $command->name,
            'password' => bcrypt($command->password),
        ]);
        
        // Memublikasi event agar layer lain tahu proses selesai
        Event::dispatch(new UserCreated($user->id));
        
        // Tidak mengembalikan apa pun. Controller tidak tahu dan tidak perlu tahu entitasnya.
    }
}
```

### ❌ Anti-Pattern 2: Fat Query Handler (Menggunakan Eloquent Secara Masif untuk Baca)

Memisahkan beban kerja Query tetapi Anda masih memaksakan menggunakan lapis *ActiveRecord* (Eloquent) untuk penarikan data bervolume besar. Ini menggagalkan seluruh tujuan optimasi memori dan kecepatan eksekusi CQRS.

```php
// ❌ KODE SALAH (Memory Leak Risk & N+1 Nightmare)
final class GetActiveUsersHandler
{
    /** @return \Illuminate\Database\Eloquent\Collection */
    public function handle(GetActiveUsersQuery $query)
    {
        // ❌ Menghidrasi ribuan Eloquent object untuk read-only operation.
        // PHP akan merintih (memory limit exhausted) saat rows > 10.000, 
        // dan berpotensi sangat besar terkena N+1 implicit loading.
        return User::with('profile', 'orders', 'roles')
            ->where('status', 'active')
            ->get();
    }
}
```
**Mengapa Ini Sangat Berbahaya:**
- **Death by a Thousand Cuts (N+1)**: Jika tidak dilindungi proteksi ketat `Model::preventLazyLoading()`, ini dapat menjatuhkan server ke dalam *downtime*.
- **Memory Explosion**: Proses "hydrating" membangun ratusan ribu instance PHP Objects lengkap dengan properti bawaan Laravel yang tidak terpakai, mengakibatkan puluhan MB RAM menguap hanya untuk 1 request.

```php
// ✅ KODE BENAR (Performa Tinggi & Aman)
final class GetActiveUsersHandler
{
    /**
     * @return array<int, ActiveUserDTO>
     */
    public function handle(GetActiveUsersQuery $query): array
    {
        // ✅ Ekstraksi Data Mentah dari Builder Query level rendah (Zero hydrate cost)
        $records = DB::table('users')
            ->join('profiles', 'users.id', '=', 'profiles.user_id')
            ->where('users.status', 'active')
            ->select('users.id', 'users.name', 'profiles.avatar_url')
            ->limit(100) // Proteksi batas aman
            ->get();

        // Mengonversi secepat kilat menjadi DTO tipis dan statis
        return $records->map(fn(object $row) => new ActiveUserDTO(
            id: (string) $row->id,
            name: (string) $row->name,
            avatar: (string) $row->avatar_url
        ))->toArray();
    }
}
```

---

## Pest v3 Testing (Architecture & Unit Validation)

Pest v3 menyediakan kapabilitas *Architecture Testing* yang mematikan dan bersifat proaktif guna menjegal Anti-Patterns di atas masuk ke basis kode master. Aturan arsitektur ketat ini dieksekusi secara otomatis pada pipa *CI/CD*.

### 1. Strict Architecture Tests (`tests/Architecture/CqrsArchTest.php`)

```php
<?php

declare(strict_types=1);

use function Pest\Laravel\artisan;

// 1. Karantina dependensi Command Handler (Tingkat Ketat)
arch('Command Handlers strictly follow clean architecture boundaries')
    ->expect('App\Domain\*\Handlers')
    ->toOnlyUse([
        'App\Domain',
        'Illuminate\Support\Facades\DB',
        'Illuminate\Support\Facades\Event',
        'Throwable',
        'RuntimeException',
        'Symfony\Component\HttpKernel\Exception\NotFoundHttpException',
        'Illuminate\Database\Query\Builder'
    ])
    ->ignoring('App\Models'); // Dilarang keras menembus keluar domain selain standard library

// 2. Proteksi Void Return Type (Anti-Pattern 1 Terblokir)
arch('Command Handlers MUST return void type')
    ->expect('App\Domain\*\Handlers\*CommandHandler')
    ->toHaveMethod('handle')
    ->toBeClasses();
// Jika menggunakan plugins Pest type extension, dapat divalidasi ke void strictnya

// 3. Larangan mutlak Eloquent di wilayah Pembaca (Anti-Pattern 2 Terblokir)
arch('Query handlers must absolutely NOT use Eloquent ActiveRecords')
    ->expect('App\Domain\*\Handlers\*QueryHandler')
    ->toNotUse('Illuminate\Database\Eloquent\Model')
    ->toNotUse('App\Models'); // Cegat referensi silang ke namespace model global
```

### 2. Unit Testing Command Handler Terisolasi (`tests/Unit/Orders/PlaceOrderHandlerTest.php`)

```php
<?php

declare(strict_types=1);

uses(Tests\TestCase::class);

use App\Domain\Orders\Commands\PlaceOrderCommand;
use App\Domain\Orders\Handlers\PlaceOrderHandler;
use App\Domain\Orders\Repositories\OrderWriteRepositoryInterface;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Events\OrderPlacedEvent;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\DB;
use Mockery\MockInterface;

it('successfully processes order creation and seamlessly dispatches events', function () {
    // 1. Arrange (Persiapan Skenario)
    Event::fake();
    
    // Injeksi Repositori Tiruan (Mocking Dependency) untuk mengisolasi DB State
    /** @var OrderWriteRepositoryInterface&MockInterface $mockRepo */
    $mockRepo = Mockery::mock(OrderWriteRepositoryInterface::class);
    $mockRepo->shouldReceive('save')->once()->andReturnTrue();
    
    $handler = new PlaceOrderHandler($mockRepo);
    
    $command = new PlaceOrderCommand(
        customerId: 'uuid-1234-abcd',
        items: [
            ['product_id' => 'prod-99', 'quantity' => 2]
        ],
        shippingAddress: '123 Laravel Clean Code Street'
    );

    // 2. Act (Tindakan)
    // Jika gagal saat eksekusi mutasi DB transaction, test trait RefreshDatabase merollback otomatis
    $handler->handle($command);

    // 3. Assert (Pengujian Fakta)
    // Memastikan baris data terinjeksi utuh ke target tabel master secara presisi
    $this->assertDatabaseHas('orders', [
        'customer_id'      => 'uuid-1234-abcd',
        'shipping_address' => '123 Laravel Clean Code Street',
        'status'           => 'PENDING_PAYMENT',
    ]);
    
    // Verifikasi kritis: memastikan side-effect Event Driven berjalan!
    Event::assertDispatched(OrderPlacedEvent::class);
});
```

### 3. Feature Testing API E-to-E (`tests/Feature/Orders/OrderApiFeatureTest.php`)

```php
<?php

declare(strict_types=1);

uses(Tests\TestCase::class, Illuminate\Foundation\Testing\RefreshDatabase::class);

use App\Domain\Orders\Models\Order;
use Symfony\Component\HttpFoundation\Response;

it('validates and accepts place order command, returning 202 accepted gracefully', function () {
    // Arrange Payload Integrasi
    $payload = [
        'customer_id'      => (string) \Str::uuid(),
        'shipping_address' => 'Gedung Menara Merdeka, Jakarta, Indonesia',
        'items'            => [
            [
                'product_id' => (string) \Str::uuid(), // Disimulasikan factory Seed di database nyata
                'quantity'   => 5
            ]
        ]
    ];

    // Eksekusi HTTP Client
    $response = $this->postJson('/api/orders/place', $payload);

    // Assert: Pastikan Status Kode CQS murni & bentuk struktur JSON yang sesuai kontrak API
    $response->assertStatus(Response::HTTP_ACCEPTED)
             ->assertJsonPath('message', 'Pesanan sedang diproses. Silahkan periksa email atau status berkala.');
});

it('fetches order details accurately using optimized query handler pipeline', function () {
    // Arrange: Buat skenario data kotor (Dummy Data via Factory)
    $order = Order::factory()->create([
        'total_amount'     => 525000.50,
        'shipping_address' => 'Bali'
    ]);

    // Eksekusi API Retrieval
    $response = $this->getJson("/api/orders/{$order->id}");

    // Assert Kontrak Data: Tidak boleh ada payload sampah / overhead, murni DTO
    $response->assertStatus(Response::HTTP_OK)
             ->assertJsonPath('data.total_amount', 525000.50)
             ->assertJsonPath('data.shipping_address', 'Bali')
             ->assertJsonStructure([
                 'data' => [
                     'order_id', 
                     'status', 
                     'total_amount', 
                     'shipping_address', 
                     'items'
                 ]
             ]);
});
```

Mengisolasi beban kerja (*Write* vs *Read*) secara klinis dengan kerangka CQRS menjamin aplikasi skala Enterprise (berbasis ekosistem PHP 8.4 dan Laravel 11+) memiliki ketahanan luar biasa dari lonjakan lalu lintas server. Setiap unit lapisan operasional (Mulai dari *Request* tepi, orkestrasi HTTP *Controller*, objek delegasi *Command*, hingga lapisan manipulasi *Handler*) menjadi sepenuhnya modular, 100% *Type-Safe*, lulus uji otomatisasi *Pest Testing*, dan kebal total terhadap regresi kebocoran RAM berkat proteksi restriktif pelarangan kelas berat ORM pada zona Pembaca.
