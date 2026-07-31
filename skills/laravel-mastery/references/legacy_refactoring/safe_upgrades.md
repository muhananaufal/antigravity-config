# 🚀 Panduan Komprehensif: Legacy Refactoring & Safe Upgrades di Laravel 11/12

Memperbarui aplikasi legacy dari versi Laravel lama (misalnya Laravel 7, 8, atau 9) ke Laravel 11/12 (beserta PHP 8.3/8.4) adalah tugas yang menantang namun esensial. Panduan ini berfokus pada strategi *Zero-Downtime Refactoring*, *Strangler Fig Pattern*, dan transisi dari arsitektur *Spaghetti/Fat Controller* menuju *Clean Architecture* tingkat Enterprise (Top 1%).

Setiap baris kode di bawah ini mematuhi standar PHP 8.4 terbaru dengan `declare(strict_types=1);`, tipe data ketat, dan metodologi *Domain-Driven Design* (DDD) lite.

---

## 🏗️ 1. Strategi Upgrade Aman (The Strangler Fig Pattern)

Dalam sistem monolitik legacy, mencoba untuk menulis ulang aplikasi sekaligus (*Big Bang Rewrite*) memiliki tingkat kegagalan hingga 80%. Pendekatan yang benar adalah iteratif:

1. **Static Analysis Check**: Gunakan PHPStan di level tertinggi (Level 9) dan Rector untuk otomatisasi upgrade sintaks (misal dari PHP 7.4/8.0 ke PHP 8.4).
2. **Expand & Contract Database**: Hindari migrasi skema destruktif. Gunakan *dual writing* sebelum menghapus kolom lama.
3. **Facade API Gateway**: Gunakan Nginx atau API Gateway untuk membagi trafik antara *Legacy App* dan *Modern App* per endpoint/modul.

---

## 🚫 2. Anti-Patterns: Analisis Kritis Kesalahan Umum

Sebelum melangkah ke arsitektur bersih, kita wajib memahami mengapa *Fat Controller* dan pola MVC klasik di aplikasi legacy sangat mematikan.

### Anti-Pattern 1: Fat Controller, Validasi Lemah, & Transaksi Tersembunyi

Banyak aplikasi legacy menumpuk logika bisnis, akses database, validasi, dan event dispatching ke dalam satu fungsi Controller raksasa. Hal ini membuat aplikasi tidak bisa dites (untestable), rentan terhadap *race conditions*, dan sulit di-*scale*.

❌ **KODE SALAH (Legacy / Berbahaya):**
```php
<?php
// App\Http\Controllers\OrderController.php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use App\Models\Order;
use App\Models\Product;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;

class OrderController extends Controller
{
    public function store(Request $request)
    {
        // ❌ Security Risk: Validasi inline, mudah terlewat
        $request->validate([
            'user_id' => 'required',
            'product_id' => 'required',
            'qty' => 'required'
        ]);

        // ❌ Logic Leak: Controller mengambil stok langsung
        $product = Product::find($request->product_id);
        
        if ($product->stock < $request->qty) {
            return response()->json(['error' => 'Out of stock'], 400);
        }

        // ❌ Race Condition: Mengurangi stok tanpa Row-level Lock
        $product->stock = $product->stock - $request->qty;
        $product->save();

        $order = new Order();
        $order->user_id = $request->user_id;
        $order->product_id = $request->product_id;
        $order->qty = $request->qty;
        $order->total = $product->price * $request->qty;
        $order->status = 'pending';
        $order->save();

        // ❌ Slow API: Mengirim email secara synchronous
        Mail::send('emails.order', ['order' => $order], function($message) use ($request) {
            $message->to($request->user()->email);
        });

        return response()->json($order);
    }
}
```

**🔍 Mengapa Berbahaya?**
- **Security & Race Condition (TOC/TOU):** Saat pengecekan `$product->stock`, user lain bisa mengambil sisa stok secara paralel sebelum `save()` dijalankan. Ini akan menghasilkan stok minus (Negative Inventory).
- **Maintenance Nightmare:** Logic tersentralisasi di controller. Jika ada order dari API CLI atau sistem Cron, logic harus di duplikasi.
- **Performance:** Mengirim email secara sinkron (Synchronous) memblokir request HTTP. Waktu response meningkat tajam.

---

### Anti-Pattern 2: N+1 Query pada Serialisasi Data

Aplikasi legacy sering tidak menyadari masalah pemuatan relasi yang tertunda (Lazy Loading), menyebabkan puluhan query database beruntun (N+1 Problem) saat melakukan return response.

❌ **KODE SALAH (Memory & CPU Hog):**
```php
<?php

namespace App\Http\Controllers;

use App\Models\Order;

class ReportController extends Controller
{
    public function getDailyOrders()
    {
        // ❌ Fatal Error: Mengambil data tanpa pagination atau limits
        $orders = Order::whereDate('created_at', today())->get();
        
        $result = [];
        foreach ($orders as $order) {
            // ❌ N+1 Problem: Mengakses relasi tanpa Eager Loading!
            // Men-trigger 1 query untuk setiap order. Jika ada 1000 orders = 1001 queries.
            $result[] = [
                'id' => $order->id,
                'customer_name' => $order->user->name,
                'product_name' => $order->product->name,
            ];
        }

        return response()->json($result);
    }
}
```

**🔍 Mengapa Berbahaya?**
- **Database Meltdown:** N+1 Query akan membakar resource koneksi ke Database. 
- **Memory OOM (Out Of Memory):** Memuat semua data (menggunakan `get()` tanpa `paginate()`) pada hari yang sibuk akan meruntuhkan node server.

---

## ✅ 3. Solusi Modern: Clean Architecture (The Top 1% Standard)

Kita akan melakukan refactor dari kode legacy di atas ke standar Enterprise dengan stack PHP 8.4 + Laravel 11. 
Alur data: **FormRequest -> DTO -> Controller -> Action/Service -> Repository -> Model**.

### A. Model (Dengan Strict Typing & Attributes)

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\SoftDeletes;

final class Order extends Model
{
    use HasFactory, SoftDeletes;

    // Strict attributes untuk mass assignment. Jangan gunakan $guarded = [].
    protected $fillable = [
        'user_id',
        'product_id',
        'qty',
        'total',
        'status',
    ];

    /**
     * Casting nilai dengan fitur baru PHP/Laravel
     * 
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'total' => 'decimal:2',
            'qty' => 'integer',
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
     * @return BelongsTo<Product, $this>
     */
    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }
}
```

### B. Data Transfer Object (DTO)

Data Transfer Object memastikan konsistensi data dari lapisan Controller menuju Service, menghindari pengiriman array longgar atau instance `Request` yang kotor.

```php
<?php

declare(strict_types=1);

namespace App\DTOs;

final readonly class OrderCreationDTO
{
    public function __construct(
        public int $userId,
        public int $productId,
        public int $qty,
    ) {}

    /**
     * Ekstrak DTO dari array validasi (terhubung dari FormRequest)
     * 
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        return new self(
            userId: (int) $data['user_id'],
            productId: (int) $data['product_id'],
            qty: (int) $data['qty'],
        );
    }
}
```

### C. Repository (Akses Database Terisolasi)

Repository mengabstraksi lapisan database untuk mempermudah penggantian dan Mocking saat testing.

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Contracts;

use App\Models\Product;
use Illuminate\Database\Eloquent\ModelNotFoundException;

interface ProductRepositoryInterface
{
    /**
     * Mencari produk dan mengunci baris (Pessimistic Locking) untuk mencegah race condition.
     * 
     * @throws ModelNotFoundException
     */
    public function findAndLockForUpdate(int $productId): Product;
    
    public function decrementStock(Product $product, int $qty): void;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use App\Models\Product;
use App\Repositories\Contracts\ProductRepositoryInterface;
use Illuminate\Database\Eloquent\ModelNotFoundException;

final class EloquentProductRepository implements ProductRepositoryInterface
{
    public function findAndLockForUpdate(int $productId): Product
    {
        // Menggunakan lockForUpdate (SELECT ... FOR UPDATE) pada transaksi DB
        return Product::lockForUpdate()->findOrFail($productId);
    }

    public function decrementStock(Product $product, int $qty): void
    {
        // Decrement atomically menggunakan fungsi query DB 
        $product->decrement('stock', $qty);
    }
}
```

### D. Action / Service (Business Logic Penuh)

Action class bersifat invokable, melakukan tugas tunggal spesifik (Single Responsibility Principle) dan membungkus logic dengan DB Transaction.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Orders;

use App\DTOs\OrderCreationDTO;
use App\Models\Order;
use App\Repositories\Contracts\ProductRepositoryInterface;
use App\Events\OrderPlaced;
use Illuminate\Support\Facades\DB;
use Exception;
use InvalidArgumentException;

final class ProcessOrderAction
{
    public function __construct(
        private readonly ProductRepositoryInterface $productRepository
    ) {}

    /**
     * Menjalankan proses order dengan garansi transaksi
     *
     * @throws Exception|InvalidArgumentException
     */
    public function execute(OrderCreationDTO $dto): Order
    {
        return DB::transaction(function () use ($dto) {
            $product = $this->productRepository->findAndLockForUpdate($dto->productId);

            if ($product->stock < $dto->qty) {
                throw new InvalidArgumentException(sprintf('Insufficient stock for product ID: %d', $dto->productId));
            }

            // Potong stok (Race condition tertangani dengan lockForUpdate)
            $this->productRepository->decrementStock($product, $dto->qty);

            $order = Order::create([
                'user_id' => $dto->userId,
                'product_id' => $dto->productId,
                'qty' => $dto->qty,
                'total' => clone($product->price)->multiply($dto->qty), // Asumsi price adalah custom currency object, atau kalikan biasa jika int.
                'status' => 'pending',
            ]);

            // Dispatch event untuk dihandle oleh async listeners (menghindari synchronous email lambat)
            OrderPlaced::dispatch($order);

            return $order;
        });
    }
}
```

### E. Form Request (Validasi Di-layer Paling Luar)

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class StoreOrderRequest extends FormRequest
{
    /**
     * Cek otorisasi user (misalnya role buyer)
     */
    public function authorize(): bool
    {
        // Contoh: return $this->user()->can('create', Order::class);
        return true; 
    }

    /**
     * @return array<string, \Illuminate\Contracts\Validation\ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'user_id' => ['required', 'integer', 'exists:users,id'],
            'product_id' => ['required', 'integer', 'exists:products,id'],
            'qty' => ['required', 'integer', 'min:1', 'max:100'],
        ];
    }
}
```

### F. Controller (Slim and Dumb)

Controller kini hanya mengurusi HTTP Request (Menerima `FormRequest`), mendelegasikan mapping ke DTO, dan menjalankan Action, lalu mereturn HTTP Response.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Actions\Orders\ProcessOrderAction;
use App\DTOs\OrderCreationDTO;
use App\Http\Requests\StoreOrderRequest;
use Illuminate\Http\JsonResponse;
use InvalidArgumentException;
use Symfony\Component\HttpFoundation\Response;

final class OrderController extends Controller
{
    public function __construct(
        private readonly ProcessOrderAction $processOrderAction
    ) {}

    public function store(StoreOrderRequest $request): JsonResponse
    {
        try {
            // Mapping FormRequest validated data menuju DTO
            $dto = OrderCreationDTO::fromArray($request->validated());

            // Eksekusi logic terisolasi
            $order = $this->processOrderAction->execute($dto);

            return response()->json([
                'message' => 'Order created successfully',
                'data' => $order
            ], Response::HTTP_CREATED);
            
        } catch (InvalidArgumentException $e) {
            // Tangkap business logic exception spesifik (e.g., stok habis)
            return response()->json([
                'error' => 'Business Rule Violation',
                'details' => $e->getMessage()
            ], Response::HTTP_UNPROCESSABLE_ENTITY);
        } catch (\Exception $e) {
            // Fallback general error (Di production logger terintegrasi otomatis)
            return response()->json([
                'error' => 'Internal Server Error',
            ], Response::HTTP_INTERNAL_SERVER_ERROR);
        }
    }
}
```

---

## 🛡️ 4. Pengujian Pest v3 (Arch & Feature Testing)

Pest 3.x menawarkan arsitektur testing modern untuk memastikan refactoring tidak rusak (*regression test*) dan memastikan programmer junior tidak melanggar aturan arsitektur.

### A. Architecture Testing (`tests/ArchTest.php`)

Pastikan pattern yang disepakati berjalan:

```php
<?php

declare(strict_types=1);

arch('controllers must not invoke eloquent models directly')
    ->expect('App\Http\Controllers')
    ->toUseNothingIn('App\Models') // Controller dilarang pakai model langsung, harus lewat service/action/repository
    ->ignoring('App\Models\User'); // Pengecualian Auth user misalnya

arch('actions must be invokable or only have specific methods')
    ->expect('App\Actions')
    ->toHaveMethod('execute');

arch('controllers must only have standard http methods or be invokable')
    ->expect('App\Http\Controllers')
    ->toUseStrictTypes()
    ->toHaveSuffix('Controller');
    
arch('all files must use strict types')
    ->expect('App')
    ->toUseStrictTypes();
```

### B. Unit/Feature Testing (`tests/Feature/Order/ProcessOrderActionTest.php`)

```php
<?php

declare(strict_types=1);

use App\Actions\Orders\ProcessOrderAction;
use App\DTOs\OrderCreationDTO;
use App\Events\OrderPlaced;
use App\Models\Product;
use App\Models\User;
use App\Repositories\Contracts\ProductRepositoryInterface;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\DB;

uses()->group('orders');

it('successfully processes order and decrements stock atomically', function () {
    // Arrange
    Event::fake([OrderPlaced::class]);
    
    $product = Product::factory()->create(['stock' => 10, 'price' => 100]);
    $user = User::factory()->create();
    
    // Binding manual/mock pada dependency repository
    // Meskipun dalam feature test, kita bisa biarkan ini real atau di mock
    $action = app(ProcessOrderAction::class);
    
    $dto = new OrderCreationDTO(
        userId: $user->id,
        productId: $product->id,
        qty: 3
    );

    // Act
    $order = $action->execute($dto);

    // Assert
    expect($order)
        ->not->toBeNull()
        ->qty->toBe(3)
        ->total->toEqual('300.00'); // (100 * 3)

    // Cek record DB produk telah dipotong nilainya dengan benar
    expect($product->fresh()->stock)->toBe(7);
    
    // Pastikan event berjalan
    Event::assertDispatched(OrderPlaced::class, function ($event) use ($order) {
        return $event->order->id === $order->id;
    });
});

it('throws exception if stock is insufficient', function () {
    // Arrange
    $product = Product::factory()->create(['stock' => 2]);
    $user = User::factory()->create();
    
    $action = app(ProcessOrderAction::class);
    
    $dto = new OrderCreationDTO(
        userId: $user->id,
        productId: $product->id,
        qty: 5 // Melebihi stok
    );

    // Act & Assert
    expect(fn() => $action->execute($dto))
        ->toThrow(InvalidArgumentException::class, 'Insufficient stock for product ID: ' . $product->id);
});
```

---

## 🔥 5. Ringkasan Kunci (TL;DR untuk Top 1% Engineers)

1. **Strict Typing is Law:** Seluruh layer sekarang wajib memiliki tipe argumen dan pengembalian (`public function execute(DTO $dto): Model`). Tidak ada lagi tipe *mixed* atau *magic array*.
2. **Prevent Race Conditions:** Pada legacy kode keuangan, *Pessimistic Locking* (e.g. `lockForUpdate()`) di DB transactions adalah fundamental sebelum melakukan mutasi state.
3. **Architecture Enforced by Tests:** Jangan andalkan review kode manusia yang rawan lolos (human error). Paksakan *Clean Architecture* lewat **Pest Architecture Testing**. 
4. **Asynchronous Execution:** Controller tidak boleh mengirim email pihak ketiga atau API calls yang berat secara sinkron (blocking). Lemparkan Job atau Event (e.g., `OrderPlaced::dispatch($order)`).
5. **No God Classes:** Pecah controller raksasa (Fat Controller) dengan konsep *Invokable Action* (misal: `ProcessOrderAction`), lalu oper operan parameter memakai **Data Transfer Object (DTO)** untuk menjaga kekakuan skema data internal. 

*Dokumen di atas adalah representasi "State of the Art" yang akan membimbing tim engineering keluar dari lubang jarum sistem monolitik kotor Laravel menuju arsitektur yang solid, aman, siap-scaling, dan dapat dideploy ke sistem Kubernetes / terdistribusi masa depan.*
