# Advanced Logging & Monitoring dengan Laravel Pail untuk Laravel 11/12

Laravel Pail adalah package revolusioner yang diperkenalkan di ekosistem Laravel 11 untuk melakukan *tailing* pada file log aplikasi secara *real-time* langsung dari terminal. Pail menawarkan pengalaman yang jauh lebih superior dibandingkan `tail -f storage/logs/laravel.log` biasa karena ia memahami konteks aplikasi Laravel Anda, mendukung *filtering* yang cerdas, menyorot *exception* dengan warna, dan merampingkan tumpukan kesalahan (*stack traces*) yang panjang menjadi sangat mudah dibaca.

Dokumen ini akan membedah secara mendalam bagaimana merancang sistem *logging* kelas perusahaan (*enterprise-grade*) menggunakan PHP 8.3/8.4, arsitektur Clean Architecture, serta bagaimana Pail berperan dalam *monitoring* dan *debugging* tingkat tinggi.

---

## 1. Arsitektur Logging Kelas Enterprise (Clean Architecture)

Dalam aplikasi berskala besar, mencatat log tidak boleh dilakukan sembarangan dari *Controller* atau *Model*. Kita membutuhkan lapisan terisolasi (Action/Service) untuk menangani *business logic* sambil menyuntikkan *logging context* secara konsisten.

Berikut adalah implementasi *Clean Architecture* dari alur pembuatan pesanan (*order processing*) yang menghasilkan log yang sangat kaya informasi, yang nantinya akan sangat indah saat dibaca melalui Laravel Pail.

### Domain Model & Form Request

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
        'total_amount',
        'status',
    ];

    protected $casts = [
        'total_amount' => 'decimal:2',
    ];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Orders;

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

### Repository Layer

*Repository* murni untuk interaksi *database*, tanpa *logging* logika bisnis.

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Orders;

use App\Models\Order;
use Illuminate\Support\Collection;

final readonly class OrderRepository
{
    public function createOrder(int $userId, int $productId, float $totalAmount): Order
    {
        return Order::create([
            'user_id' => $userId,
            'product_id' => $productId,
            'total_amount' => $totalAmount,
            'status' => 'pending',
        ]);
    }
}
```

### Action/Service Layer (Core Business Logic + Logging)

Di sinilah *logging* yang *context-aware* terjadi. Kita menggunakan `Log::withContext()` untuk memastikan setiap log berikutnya dalam siklus *request* ini memiliki konteks yang sama, sangat berguna ketika difilter oleh Pail.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Orders;

use App\Models\Order;
use App\Models\Product;
use App\Repositories\Orders\OrderRepository;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\DB;
use Throwable;
use RuntimeException;

final readonly class ProcessNewOrderAction
{
    public function __construct(
        private OrderRepository $orderRepository
    ) {}

    /**
     * @throws RuntimeException
     */
    public function execute(int $userId, int $productId, int $quantity): Order
    {
        // Menambahkan context global untuk log request ini
        Log::withContext([
            'action' => 'process_new_order',
            'user_id' => $userId,
            'product_id' => $productId,
            'quantity' => $quantity,
            'trace_id' => request()->header('X-Trace-Id', uniqid('trace_', true)),
        ]);

        Log::info('Memulai pemrosesan pesanan baru.');

        try {
            return DB::transaction(function () use ($userId, $productId, $quantity): Order {
                $product = Product::lockForUpdate()->findOrFail($productId);
                
                if ($product->stock < $quantity) {
                    Log::warning('Stok produk tidak mencukupi.', [
                        'current_stock' => $product->stock,
                        'requested_quantity' => $quantity
                    ]);
                    
                    throw new RuntimeException('Stok tidak mencukupi untuk memproses pesanan.');
                }

                $totalAmount = $product->price * $quantity;
                
                $order = $this->orderRepository->createOrder($userId, $productId, $totalAmount);
                
                $product->decrement('stock', $quantity);
                
                Log::info('Pesanan berhasil dibuat dan stok diperbarui.', [
                    'order_id' => $order->id,
                    'total_amount' => $totalAmount
                ]);

                return $order;
            });
        } catch (Throwable $e) {
            // Error log akan otomatis menangkap stack trace yang akan di-parsing dengan rapi oleh Laravel Pail
            Log::error('Gagal memproses pesanan.', [
                'exception_message' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ]);

            throw new RuntimeException('Terjadi kesalahan saat memproses pesanan: ' . $e->getMessage(), 0, $e);
        }
    }
}
```

### Controller Layer

*Controller* menjadi sangat tipis, hanya menerima *request* dan memanggil *Action*.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Actions\Orders\ProcessNewOrderAction;
use App\Http\Controllers\Controller;
use App\Http\Requests\Orders\StoreOrderRequest;
use Illuminate\Http\JsonResponse;
use RuntimeException;

final class OrderController extends Controller
{
    public function __construct(
        private readonly ProcessNewOrderAction $processOrderAction
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
                'data' => $order,
            ], 201);
            
        } catch (RuntimeException $e) {
            return response()->json([
                'message' => $e->getMessage(),
            ], 422);
        }
    }
}
```

---

## 2. Menggunakan Laravel Pail untuk Monitoring

Setelah kode di atas berjalan, Anda dapat menggunakan Laravel Pail untuk memonitor log.

### Instalasi Pail
```bash
composer require laravel/pail --dev
```

### Filtering Lanjutan dengan Pail

Karena kita menggunakan `Log::withContext()` dan menyertakan *context array* yang kaya, Pail dapat memfilter log dengan sangat spesifik:

1. **Memantau hanya Exception/Error:**
   ```bash
   php artisan pail --level=error
   ```

2. **Memantau Error dari User Tertentu:**
   Pail memungkinkan pencarian string di dalam log (*context* akan diubah menjadi JSON di file log).
   ```bash
   php artisan pail --filter="\"user_id\":42"
   ```

3. **Memantau Transaksi/Trace ID Spesifik:**
   Sangat berguna di *microservices* ketika *Trace ID* dilempar melalui *header*.
   ```bash
   php artisan pail --filter="trace_64a2b1"
   ```

Pail akan menata ulang format log mentah menjadi format UI *console* yang mudah dibaca: menyembunyikan *vendor stack trace* secara *default*, memberikan warna berbeda untuk *info*, *warning*, dan *error*, serta menampilkan *context* dalam format JSON yang cantik (*pretty-printed*).

---

## 3. Anti-Pattern vs Best Practices dalam Logging

Implementasi *logging* yang buruk tidak hanya membuat *debugging* sulit, tetapi juga dapat memicu kebocoran data sensitif (*security risk*) dan masalah kehabisan memori (*memory leak/disk space exhaustion*).

### Anti-Pattern 1: Logging Data Sensitif Tanpa Masking & Penggabungan String
❌ **KODE SALAH (Memicu Security Risk & Unstructured Logs):**
```php
<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\Log;

final class PaymentService
{
    public function processPayment(array $paymentData): void
    {
        // ANTI-PATTERN 1: String interpolation untuk log. Sulit difilter oleh Pail.
        // ANTI-PATTERN 2: Logging password / CVV mentah! BAHAYA KEAMANAN TINGGI (OWASP).
        Log::info("Memproses pembayaran untuk kartu {$paymentData['card_number']} dengan CVV {$paymentData['cvv']} untuk user {$paymentData['user_email']}");
        
        try {
            $this->gateway->charge($paymentData['card_number'], $paymentData['amount']);
        } catch (\Exception $e) {
            // ANTI-PATTERN 3: Hanya log pesan error tanpa context atau object Exception.
            // Pail tidak bisa mengekstrak Stack Trace dari ini.
            Log::error("Pembayaran gagal: " . $e->getMessage());
        }
    }
}
```
**Penjelasan Mengapa Berbahaya:**
- **Security Risk:** Log akan tersimpan dalam *plain-text* di `laravel.log` atau terkirim ke *monitoring stack* eksternal (ELK, Datadog). Jika *server* diretas, *hacker* mendapatkan nomor kartu kredit dan CVV murni secara gratis.
- **Unstructured:** Jika menggunakan string *interpolation*, mustahil bagi Laravel Pail atau Kibana untuk mem- *filter* pencarian khusus ke `card_number` tertentu tanpa *full-text search* yang lambat.
- **Trace Hilang:** Mem- *parsing* `$e->getMessage()` saja membuang informasi berharga seperti baris, *file*, dan rantai *exception*.

✅ **KODE BENAR (Masking & Structured Context Logging):**
```php
<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Throwable;

final class PaymentService
{
    public function processPayment(array $paymentData): void
    {
        // BEST PRACTICE 1: Context array. Pail bisa memfilter `--filter="user_email: john@example.com"`
        // BEST PRACTICE 2: Masking data sensitif.
        Log::info("Memulai proses pembayaran", [
            'user_email' => $paymentData['user_email'],
            'card_last_four' => Str::substr($paymentData['card_number'], -4),
            'has_cvv' => !empty($paymentData['cvv']), // Hanya catat keberadaan, bukan nilainya
        ]);
        
        try {
            $this->gateway->charge($paymentData['card_number'], $paymentData['amount']);
        } catch (Throwable $e) {
            // BEST PRACTICE 3: Melempar object Exception secara utuh.
            // Pail akan me-render vendor-less stack trace berwarna dengan sangat indah.
            Log::error("Pembayaran gagal diproses", [
                'exception' => $e,
                'user_email' => $paymentData['user_email'],
            ]);
        }
    }
}
```

---

### Anti-Pattern 2: Logging Data Objek Utuh di Dalam Loop (*Memory Risk*)
❌ **KODE SALAH (Memory Exhaustion & Disk Space Bloat):**
```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Models\User;
use Illuminate\Support\Facades\Log;

final class SyncUsersJob
{
    public function handle(): void
    {
        $users = User::all(); // ANTI-PATTERN: Mengambil semua data ke RAM
        
        foreach ($users as $user) {
            // ANTI-PATTERN: Melempar keseluruhan objek model ($user) ke context.
            // Model Eloquent berisi semua relasi, konfigurasi DB, hidden attributes, 
            // yang akan di-serialize ke JSON. Menyebabkan log bengkak dan memakan memori!
            Log::info("Sinkronisasi user berjalan", ['user' => $user]);
            
            $this->syncUserToExternalCrm($user);
        }
    }
}
```
**Penjelasan Mengapa Berbahaya:**
- **Memory/Disk Risk:** Objek Eloquent `User` sangat besar (ratusan properti internal). Melakukan serialisasi json untuk seluruh *model object* per iterasi akan menghabiskan ratusan megabyte ruang disk dalam hitungan menit dan memberatkan CPU. Pail juga akan lag (*freeze*) mencoba me- *render output* JSON yang sangat raksasa di terminal.

✅ **KODE BENAR (Chunking & Plucking ID):**
```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Models\User;
use Illuminate\Support\Facades\Log;
use Illuminate\Database\Eloquent\Collection;

final class SyncUsersJob
{
    public function handle(): void
    {
        // BEST PRACTICE 1: Chunking data
        User::select('id', 'email', 'status')
            ->chunkById(500, function (Collection $users) {
                // BEST PRACTICE 2: Ekstraksi hanya data yang dibutuhkan, dan logging dalam batch
                Log::info("Sinkronisasi batch user", [
                    'count' => $users->count(),
                    'user_ids' => $users->pluck('id')->toArray(),
                ]);
                
                foreach ($users as $user) {
                    // Cukup log ID jika perlu level individual, BUKAN seluruh model.
                    Log::debug("Sinkronisasi user individu", ['user_id' => $user->id]);
                    // ...
                }
            });
    }
}
```

---

## 4. Pest v3 Testing (Architecture & Unit Tests)

Untuk memastikan implementasi *logging* dan arsitektur kelas perusahaan ditaati, kita mengamankannya dengan **Pest v3**. Kita membutuhkan *Arch Tests* untuk tata letak *Clean Architecture* dan *Unit Tests* dengan *fakes* untuk memvalidasi *logging*.

### Architecture Test (`tests/ArchTest.php`)

```php
<?php

declare(strict_types=1);

arch('strict types digunakan di mana-mana')
    ->expect('App')
    ->toUseStrictTypes();

arch('controller layer bersih dari interaksi DB langsung')
    ->expect('App\Http\Controllers')
    ->not->toUse('Illuminate\Support\Facades\DB')
    ->not->toUse('App\Models') // Controller harus via Action/Service
    ->ignoring('App\Http\Controllers\Controller'); // Kecuali base controller

arch('actions layer hanya digunakan oleh controller atau job')
    ->expect('App\Actions')
    ->toBeUsedIn([
        'App\Http\Controllers',
        'App\Console\Commands',
        'App\Jobs',
        'App\Actions', // Action memanggil Action lain
    ]);

arch('log facade tidak boleh digunakan langsung dari model (langgar SRP)')
    ->expect('App\Models')
    ->not->toUse('Illuminate\Support\Facades\Log');
```

### Unit Test untuk Logic & Logging (`tests/Unit/Actions/ProcessNewOrderActionTest.php`)

```php
<?php

declare(strict_types=1);

use App\Actions\Orders\ProcessNewOrderAction;
use App\Models\Order;
use App\Models\Product;
use App\Models\User;
use App\Repositories\Orders\OrderRepository;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Event;

uses()->group('orders', 'actions');

beforeEach(function () {
    // Siapkan mock repository agar kita tidak bergantung ke database sungguhan jika tidak perlu
    $this->orderRepository = Mockery::mock(OrderRepository::class);
    $this->action = new ProcessNewOrderAction($this->orderRepository);
});

it('berhasil memproses pesanan dan mencatat log info', function () {
    // Arrange
    Log::spy(); // Menggunakan Log Spy bawaan Laravel untuk Pest
    
    $user = User::factory()->create();
    $product = Product::factory()->create([
        'price' => 100.00,
        'stock' => 10,
    ]);
    
    $expectedOrder = new Order(['id' => 999]);
    
    $this->orderRepository
        ->shouldReceive('createOrder')
        ->once()
        ->with($user->id, $product->id, 200.00) // 100 * 2
        ->andReturn($expectedOrder);

    // Act
    $order = $this->action->execute($user->id, $product->id, 2);

    // Assert
    expect($order)->toBeInstanceOf(Order::class)
        ->and($product->fresh()->stock)->toBe(8); // Pastikan stock berkurang (DB transaction assert)

    // Log Assertions: Memastikan context dan pesan dicatat dengan benar
    Log::shouldHaveReceived('info')
        ->with('Memulai pemrosesan pesanan baru.')
        ->once();

    Log::shouldHaveReceived('info')
        ->with('Pesanan berhasil dibuat dan stok diperbarui.', [
            'order_id' => 999,
            'total_amount' => 200.00,
        ])
        ->once();
});

it('melempar exception dan mencatat log error jika stock tidak cukup', function () {
    // Arrange
    Log::spy();
    
    $user = User::factory()->create();
    $product = Product::factory()->create([
        'price' => 100.00,
        'stock' => 1, // Stock hanya 1
    ]);
    
    // Act & Assert Exception
    expect(fn() => $this->action->execute($user->id, $product->id, 5))
        ->toThrow(RuntimeException::class, 'Terjadi kesalahan saat memproses pesanan: Stok tidak mencukupi untuk memproses pesanan.');

    // Log Assertions
    Log::shouldHaveReceived('warning')
        ->with('Stok produk tidak mencukupi.', [
            'current_stock' => 1,
            'requested_quantity' => 5
        ])
        ->once();

    Log::shouldHaveReceived('error')
        ->withArgs(function ($message, $context) {
            return $message === 'Gagal memproses pesanan.' &&
                   isset($context['exception_message']) &&
                   $context['exception_message'] === 'Stok tidak mencukupi untuk memproses pesanan.';
        })
        ->once();
        
    // Memastikan order tidak dibuat sama sekali
    $this->orderRepository->shouldNotHaveReceived('createOrder');
    
    // Memastikan stock tidak berubah
    expect($product->fresh()->stock)->toBe(1);
});
```

---

## 5. Kesimpulan & Relevansi dengan DevOps

Penggunaan **Laravel Pail** dalam kombinasi dengan pola **Clean Architecture** (memisahkan *Actions/Services* untuk *logging*) serta **Context-Aware Logging** (menggunakan array/objek sebagai parameter kedua `Log::info`) merupakan standar tertinggi (Top 1%) dalam pengembangan perangkat lunak berbasis Laravel saat ini.

Keuntungannya sangat nyata dari sisi Operasional DevOps:
1. **Developer Experience (DX):** Pengembang tidak lagi perlu membuka file `storage/logs/laravel.log` dengan teks editor atau melakukan `grep` yang rumit. Cukup ketik `php artisan pail` maka seluruh sistem tercermin di depan mata secara *real-time*.
2. **Monitoring Terstruktur:** Karena log selalu menyertakan atribut JSON (melalui *context parameter*), alat *monitoring* eksternal seperti Datadog, New Relic, atau ELK (*Elasticsearch, Logstash, Kibana*) dapat dengan mudah menelan log ini dan mengubahnya menjadi *dashboard* grafik tanpa repot menyusun *regex parsing*.
3. **Traceability:** Injeksi `trace_id` di awal *Action Layer* menjamin seluruh rentetan sistem, dari mulai klik tombol pelanggan, hingga eksekusi *database*, dapat dirangkai dan di- *debug* sebagai satu kesatuan organik. Pail memudahkan hal ini dengan satu *flag* sederhana: `--filter`.

Gunakan kombinasi teknik di atas, dan aplikasi Laravel Anda akan memiliki daya tahan (*resilience*) dan kemudahan pemeliharaan (*maintainability*) tingkat *Enterprise*.
