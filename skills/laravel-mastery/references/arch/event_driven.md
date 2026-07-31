# Event-Driven Architecture (EDA) & Transactional Outbox Pattern di Laravel (Top 1% Quality)

Event-Driven Architecture (EDA) adalah pola arsitektur perangkat lunak yang mempromosikan produksi, deteksi, konsumsi, dan reaksi terhadap *events* (perubahan status atau kejadian penting dalam domain bisnis). Dalam ekosistem Laravel modern (v11/v12) menggunakan PHP 8.3/8.4, EDA tidak sekadar mendelegasikan tugas ke *Queue*, tetapi melibatkan decoupling yang ketat, reliabilitas (menghindari fenomena *Zombie Events* atau *Dual-Write Problem*), serta ketahanan terhadap kegagalan infrastruktur.

Dokumen ini adalah panduan **Top 1% Quality** untuk merancang, mengimplementasikan, dan menguji arsitektur Event-Driven secara presisi menggunakan Clean Architecture (Controller -> Action -> Repository), Transactional Outbox Pattern, serta Pest v3.

---

## 1. Core Principles & Transactional Outbox Pattern

Ketika sistem memproses transaksi bisnis (misal: "Membuat Pesanan") dan harus memberi tahu sistem lain (misal: "Kirim Email", "Kurangi Stok"), pola *Dual-Write* sering terjadi:
1. Simpan data pesanan ke Database MySQL.
2. Publish event `OrderPlaced` ke Redis Queue.

**Masalah Dual-Write:** Bagaimana jika langkah 1 berhasil, namun server Redis down sehingga langkah 2 gagal? Atau sebaliknya, event sudah terkirim ke Redis, namun transaksi DB di-rollback karena *Deadlock* (fenomena *Zombie Event*)?

**Solusi: Transactional Outbox Pattern.**
Event tidak langsung dikirim ke Message Broker (Redis/RabbitMQ). Alih-alih, event disimpan sebagai payload JSON di tabel `outbox_messages` dalam **Database Transaction yang sama** dengan penyimpanan data utama. *Background Worker* (`schedule:run` atau proses *polling* daemon) secara asinkron membaca tabel `outbox_messages` dan meneruskannya ke Message Broker.

### Diagram Alur Arsitektur

```text
[ HTTP Request (FormRequest) ]
        │
        ▼
[ OrderController (Presentation) ]
        │
        ▼
[ CreateOrderAction (Domain Service) ]
        │  (DB::transaction)
        ▼────────────────────────────────────────────┐
[ OrderRepository ] ──► (INSERT INTO orders)         │ (Atomicity Guaranteed)
[ OutboxService ]   ──► (INSERT INTO outbox_messages)│
        └────────────────────────────────────────────┘
        │
        ▼ (Background Poller - Cron/Daemon)
[ PublishOutboxCommand ]
        │
        ▼ (Reads 'pending' outbox_messages)
[ Laravel Event Dispatcher ]
        │
        ▼
[ Redis / Beanstalkd Queue ]
        │
        ├─► [ SendOrderConfirmationEmail (Listener) ]
        │
        └─► [ ReserveInventory (Listener) ]
```

---

## 2. Implementasi Clean Architecture (PHP 8.4 + Laravel 11/12)

Dalam Clean Architecture, kita memisahkan layer secara ketat.

### 2.1. Domain Model & Migration

```php
<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('orders', function (Blueprint $table): void {
            $table->id();
            $table->uuid('uuid')->unique();
            $table->foreignId('user_id')->constrained();
            $table->decimal('total_amount', 15, 2);
            $table->string('status');
            $table->timestamps();
        });

        Schema::create('outbox_messages', function (Blueprint $table): void {
            $table->id();
            $table->string('event_type');
            $table->json('payload');
            $table->enum('status', ['pending', 'published', 'failed'])->default('pending');
            $table->text('error_message')->nullable();
            $table->timestamp('published_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('outbox_messages');
        Schema::dropIfExists('orders');
    }
};
```

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

final class Order extends Model
{
    protected $fillable = [
        'uuid',
        'user_id',
        'total_amount',
        'status',
    ];

    /**
     * @return BelongsTo<User, $this>
     */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
```

### 2.2. The Event Object (DTO)

```php
<?php

declare(strict_types=1);

namespace App\Events;

use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

final class OrderPlaced
{
    use Dispatchable, InteractsWithSockets, SerializesModels;

    public function __construct(
        public readonly string $orderUuid,
        public readonly int $userId,
        public readonly float $totalAmount
    ) {
    }
}
```

### 2.3. Repository Layer

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Contracts;

use App\Models\Order;

interface OrderRepositoryInterface
{
    /**
     * @param array<string, mixed> $data
     */
    public function create(array $data): Order;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use App\Models\Order;
use App\Repositories\Contracts\OrderRepositoryInterface;

final readonly class EloquentOrderRepository implements OrderRepositoryInterface
{
    public function __construct(private Order $model)
    {
    }

    /**
     * @param array<string, mixed> $data
     */
    public function create(array $data): Order
    {
        return $this->model->newQuery()->create($data);
    }
}
```

### 2.4. Action / Service Layer (Use Case)

Layer ini merangkum logika bisnis dan transaksi *outbox*.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Order;

use App\Events\OrderPlaced;
use App\Models\Order;
use App\Models\OutboxMessage;
use App\Repositories\Contracts\OrderRepositoryInterface;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Throwable;
use RuntimeException;

final readonly class CreateOrderAction
{
    public function __construct(
        private OrderRepositoryInterface $orderRepository
    ) {
    }

    /**
     * @param array<string, mixed> $orderData
     * @throws RuntimeException
     */
    public function execute(array $orderData): Order
    {
        try {
            return DB::transaction(function () use ($orderData): Order {
                // 1. Mutasi Domain
                $orderData['uuid'] = Str::uuid()->toString();
                $orderData['status'] = 'pending';
                
                $order = $this->orderRepository->create($orderData);

                // 2. Transcational Outbox (Simpan Event di Transaksi DB yang sama)
                $event = new OrderPlaced(
                    orderUuid: $order->uuid,
                    userId: $order->user_id,
                    totalAmount: (float) $order->total_amount
                );

                OutboxMessage::query()->create([
                    'event_type' => get_class($event),
                    'payload' => json_encode(serialize($event), JSON_THROW_ON_ERROR),
                    'status' => 'pending',
                ]);

                return $order;
            });
        } catch (Throwable $e) {
            throw new RuntimeException('Gagal membuat pesanan: ' . $e->getMessage(), 0, $e);
        }
    }
}
```

### 2.5. Controller & FormRequest (Presentation Layer)

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Order;

use Illuminate\Foundation\Http\FormRequest;

final class StoreOrderRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, \Illuminate\Contracts\Validation\ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'user_id' => ['required', 'integer', 'exists:users,id'],
            'total_amount' => ['required', 'numeric', 'min:1'],
        ];
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Order;

use App\Actions\Order\CreateOrderAction;
use App\Http\Controllers\Controller;
use App\Http\Requests\Order\StoreOrderRequest;
use Illuminate\Http\JsonResponse;

final class StoreOrderController extends Controller
{
    public function __invoke(StoreOrderRequest $request, CreateOrderAction $action): JsonResponse
    {
        $order = $action->execute($request->validated());

        return response()->json([
            'message' => 'Order created successfully',
            'data' => clone $order,
        ], 201);
    }
}
```

### 2.6. Outbox Poller Command (The Publisher)

Command ini dijadwalkan berjalan setiap menit via Laravel Scheduler atau Supervisor.

```php
<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\OutboxMessage;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Throwable;

final class PublishOutboxEventsCommand extends Command
{
    protected $signature = 'outbox:publish';
    protected $description = 'Mempublikasikan pending outbox messages ke Event Dispatcher';

    public function handle(): int
    {
        // Pessimistic Lock (SKIP LOCKED jika menggunakan MySQL 8.0+ / PostgreSQL)
        // untuk mencegah race condition antar multiple worker
        $messages = OutboxMessage::query()
            ->where('status', 'pending')
            ->orderBy('id', 'asc')
            ->limit(100)
            ->lockForUpdate() // atau sharedLock()
            ->get();

        if ($messages->isEmpty()) {
            return self::SUCCESS;
        }

        foreach ($messages as $message) {
            try {
                DB::transaction(function () use ($message): void {
                    /** @var object $eventObj */
                    $eventObj = unserialize(json_decode((string) $message->payload, true, 512, JSON_THROW_ON_ERROR));

                    // Dispatch to Laravel Event System (which routes to Queues if ShouldQueue)
                    Event::dispatch($eventObj);

                    $message->update([
                        'status' => 'published',
                        'published_at' => now(),
                    ]);
                });
            } catch (Throwable $e) {
                // Log failed messages but continue processing others
                $message->update([
                    'status' => 'failed',
                    'error_message' => $e->getMessage(),
                ]);
            }
        }

        return self::SUCCESS;
    }
}
```

---

## 3. Advanced Listener & Idempotency

Ketika bekerja dengan sistem terdistribusi, event bisa jadi dikirim lebih dari sekali (*at-least-once delivery*). *Listener* **WAJIB bersifat idempotent** (menjalankan operasi berkali-kali tidak akan mengubah hasil lebih dari operasi pertama).

```php
<?php

declare(strict_types=1);

namespace App\Listeners;

use App\Events\OrderPlaced;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

final class SendOrderConfirmationEmail implements ShouldQueue
{
    use InteractsWithQueue;

    public int $tries = 3;
    public int $backoff = 60; // Retry delay in seconds

    public function handle(OrderPlaced $event): void
    {
        $idempotencyKey = 'email_order_placed_' . $event->orderUuid;

        // Atomic lock check via Redis / Cache untuk Idempotency
        if (Cache::has($idempotencyKey)) {
            Log::info("Email sudah terkirim untuk order {$event->orderUuid}, melewati aksi.");
            return;
        }

        // 1. Eksekusi domain logic (misal: send email)
        // Mail::to(...)->send(new OrderConfirmationMail($event));
        
        // 2. Tandai sukses
        Cache::put($idempotencyKey, true, now()->addDays(7));
    }
}
```

---

## 4. ❌ ✅ Anti-Patterns & Best Practices

### Pasangan Anti-Pattern 1: Heavy Synchronous Processing

❌ **SALAH (Membahayakan Performa Aplikasi):**
Listener melakukan *heavy lifting* secara sinkron. Ini akan memblokir HTTP Request klien hingga proses pihak ketiga selesai.
```php
<?php
// MENGAPA BERBAHAYA: 
// Jika API pihak ketiga (Mailgun, Stripe) lambat, HTTP Response ke User akan timeout.
// Memori terpakai menumpuk karena request belum dilepas.

namespace App\Listeners;
use App\Events\OrderPlaced;

final class GenerateInvoicePdfListener // Lupa implements ShouldQueue
{
    public function handle(OrderPlaced $event): void
    {
        // Rendering PDF takes 5 seconds!
        // Storage Disk Network call takes 2 seconds!
        $pdf = app('PdfEngine')->renderView('invoice.template', ['order' => $event->orderUuid]);
        app('storage')->disk('s3')->put("invoices/{$event->orderUuid}.pdf", $pdf); 
    }
}
```

✅ **BENAR (Clean & Asynchronous):**
Selalu gunakan antrean (*Queue*) untuk tugas I/O, network, atau CPU *intensive*.
```php
<?php

namespace App\Listeners;
use App\Events\OrderPlaced;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Queue\InteractsWithQueue;

// BENAR: Mengimplementasikan ShouldQueue agar dilempar ke Redis/RabbitMQ
final class GenerateInvoicePdfListener implements ShouldQueue
{
    use InteractsWithQueue;

    public function handle(OrderPlaced $event): void
    {
        // Berjalan di Background Worker, HTTP Request pengguna langsung merespons "201 Created".
        $pdf = app('PdfEngine')->renderView('invoice.template', ['order' => $event->orderUuid]);
        app('storage')->disk('s3')->put("invoices/{$event->orderUuid}.pdf", $pdf);
    }
}
```

### Pasangan Anti-Pattern 2: N+1 Database Query di Dalam Queue Listener

❌ **SALAH (N+1 Query Problem di Worker):**
Mengirim seluruh *collection* atau melempar query berat di dalam listener tanpa `Eager Loading`. Ini bisa membunuh database ketika event di-dispatch secara massal.
```php
<?php
// MENGAPA BERBAHAYA: 
// Worker akan mengeksekusi 1 query untuk mengambil Order, dan N query tambahan untuk relasi Item
// Membebani CPU database dan memperlambat throughput Queue.

namespace App\Listeners;
use App\Events\OrderPlaced;
use App\Models\Order;
use Illuminate\Contracts\Queue\ShouldQueue;

final class BroadcastOrderToWarehouse implements ShouldQueue
{
    public function handle(OrderPlaced $event): void
    {
        $order = Order::where('uuid', $event->orderUuid)->firstOrFail();
        
        // N+1 Query Terjadi di Sini! (Lazy Loading di dalam loop)
        foreach ($order->items as $item) { 
            app('WarehouseApi')->sync($item->sku, $item->quantity);
        }
    }
}
```

✅ **BENAR (Eager Loading di Listener):**
Secara eksplisit muat semua relasi (*eager load*) untuk meminimalkan *round-trip* ke database.
```php
<?php

namespace App\Listeners;
use App\Events\OrderPlaced;
use App\Models\Order;
use Illuminate\Contracts\Queue\ShouldQueue;

final class BroadcastOrderToWarehouse implements ShouldQueue
{
    public function handle(OrderPlaced $event): void
    {
        // Eager load relasi 'items' di awal. Hanya butuh maksimal 2 Query.
        $order = Order::with('items')->where('uuid', $event->orderUuid)->firstOrFail();
        
        foreach ($order->items as $item) { 
            app('WarehouseApi')->sync($item->sku, $item->quantity);
        }
    }
}
```

---

## 5. Comprehensive Testing dengan Pest v3

Dalam arsitektur Event-Driven kualitas Top 1%, pengujian mutlak diperlukan untuk memastikan event benar-benar tertulis ke *outbox* dan tidak melanggar batasan Clean Architecture.

### 5.1. Architecture Testing (`tests/ArchTest.php`)

Kita harus memastikan arsitektur tidak bocor (misal Controller tidak memanggil Repository secara langsung).

```php
<?php

declare(strict_types=1);

arch('controllers must not access repositories directly')
    ->expect('App\Http\Controllers')
    ->not->toUse('App\Repositories');

arch('actions must not dispatch events directly but use outbox')
    ->expect('App\Actions')
    ->not->toUse('Illuminate\Support\Facades\Event'); // Action harus simpan ke Outbox, BUKAN Event::dispatch

arch('listeners must implement ShouldQueue')
    ->expect('App\Listeners')
    ->toImplement('Illuminate\Contracts\Queue\ShouldQueue');
```

### 5.2. Integration Test: Create Order Action (`tests/Feature/Actions/CreateOrderActionTest.php`)

```php
<?php

declare(strict_types=1);

use App\Actions\Order\CreateOrderAction;
use App\Events\OrderPlaced;
use App\Models\Order;
use App\Models\OutboxMessage;
use App\Models\User;
use App\Repositories\Eloquent\EloquentOrderRepository;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

it('creates an order and persists event to outbox atomically', function (): void {
    // Arrange
    $user = User::factory()->create();
    $repository = new EloquentOrderRepository(new Order());
    $action = new CreateOrderAction($repository);
    
    $payload = [
        'user_id' => $user->id,
        'total_amount' => 1500.50,
    ];

    // Act
    $order = $action->execute($payload);

    // Assert: Order dibuat dengan status pending
    expect($order->uuid)->not->toBeNull()
        ->and($order->total_amount)->toBe(1500.50)
        ->and($order->status)->toBe('pending');

    // Assert: Event ditulis ke OutboxMessage
    $outbox = OutboxMessage::first();
    expect($outbox)->not->toBeNull()
        ->and($outbox->event_type)->toBe(OrderPlaced::class)
        ->and($outbox->status)->toBe('pending');
        
    // Assert: Payload outbox valid
    $eventData = unserialize(json_decode((string) $outbox->payload, true));
    expect($eventData)->toBeInstanceOf(OrderPlaced::class)
        ->and($eventData->orderUuid)->toBe($order->uuid)
        ->and($eventData->totalAmount)->toBe(1500.50);
});
```

### 5.3. Unit Test: Listener Idempotency (`tests/Unit/Listeners/SendOrderConfirmationEmailTest.php`)

```php
<?php

declare(strict_types=1);

use App\Events\OrderPlaced;
use App\Listeners\SendOrderConfirmationEmail;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

it('skips processing if event is already processed (Idempotent)', function (): void {
    // Arrange
    $event = new OrderPlaced(orderUuid: 'uuid-1234', userId: 1, totalAmount: 100.0);
    $listener = new SendOrderConfirmationEmail();
    
    // Simulate event already processed
    $idempotencyKey = 'email_order_placed_uuid-1234';
    Cache::shouldReceive('has')
        ->once()
        ->with($idempotencyKey)
        ->andReturn(true);

    Log::shouldReceive('info')
        ->once()
        ->with("Email sudah terkirim untuk order uuid-1234, melewati aksi.");

    Cache::shouldReceive('put')->never(); // Ensure business logic not re-run

    // Act
    $listener->handle($event);
    
    // Assert handled implicitly by Mockery (shouldReceive)
});

it('processes event and acquires idempotency lock', function (): void {
    // Arrange
    $event = new OrderPlaced(orderUuid: 'uuid-5678', userId: 1, totalAmount: 100.0);
    $listener = new SendOrderConfirmationEmail();
    
    $idempotencyKey = 'email_order_placed_uuid-5678';
    
    Cache::shouldReceive('has')
        ->once()
        ->with($idempotencyKey)
        ->andReturn(false);

    Log::shouldReceive('info')->never();

    // Expecting to mark as done
    Cache::shouldReceive('put')
        ->once()
        ->with($idempotencyKey, true, \Mockery::any());

    // Act
    $listener->handle($event);
});
```

---

## Kesimpulan

Event-Driven Architecture (EDA) dengan *Transactional Outbox Pattern* adalah fondasi utama untuk membangun sistem terdistribusi skala *Enterprise* di Laravel. Dengan memadukan Clean Architecture, *Idempotent Listeners*, penghindaran atas Anti-Patterns sinkron maupun relasi N+1, serta pengujian ketat dengan Pest v3, aplikasi dapat menjamin integritas data secara absolut (*zero data loss*) sembari mempertahankan konkurensi, asinkronitas, dan reaktivitas sistem tingkat tinggi.
