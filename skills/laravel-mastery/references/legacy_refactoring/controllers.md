# Panduan Definitif Refactoring Controller Legacy di Laravel 11/12 (Top 1% Engineering Standard)

Refactoring *legacy controllers* (sering disebut *God Controllers* atau *Fat Controllers*) adalah salah satu tantangan terbesar dalam memelihara aplikasi skala enterprise. Controller dalam arsitektur modern (terutama pada Laravel 11 dan PHP 8.3/8.4) tidak boleh lagi memiliki *business logic*. Tugas controller harus sangat sederhana: **Menerima Request HTTP, mendelegasikan tugas ke layer bisnis, dan merespons (Response HTTP).**

Dokumen ini mendefinisikan standar **Top 1% Quality** dalam menangani refactoring dari *Fat Controller* menjadi struktur *Clean Architecture* yang mematuhi prinsip SOLID, sangat *type-safe*, mudah diuji (testable), dan aman dari segi memori serta keamanan sistem.

---

## 1. Arsitektur Berlapis (Clean Architecture) pada Laravel

Pendekatan *Clean Architecture* pada Controller di Laravel diwujudkan dengan urutan aliran data yang ketat. Ini memastikan setiap komponen mematuhi *Single Responsibility Principle (SRP)*:

1.  **Router:** Menerapkan middleware, filter, otorisasi, dan Route Model Binding.
2.  **FormRequest (Data Transfer Object - DTO):** Menangani validasi komprehensif dan transformasi input HTTP menjadi DTO yang *type-safe*. Tidak ada validasi yang boleh masuk ke dalam wilayah Controller.
3.  **Controller:** Hanya berisi maksimal 3-5 baris kode per metode. Tugasnya secara eksklusif memanggil Action/Service.
4.  **Action / Service Layer:** Menangani *business logic* inti. Bertanggung jawab atas koordinasi, operasi transaksional database, memicu *event*, dan dispatching *job*.
5.  **Repository (Opsional, untuk kueri kompleks):** Memisahkan *logic* kueri Eloquent yang rumit atau spesifik agar dapat digunakan kembali (*reusable*), terisolasi, dan menutupi akar dari *N+1 problem*.
6.  **Model:** Representasi entitas murni dan pendefinisian relasi tanpa implementasi *logic* spesifik domain aplikasi tingkat tinggi.

Semua komponen tanpa terkecuali WAJIB menggunakan deklarasi tipe ketat:
```php
<?php

declare(strict_types=1);
```

---

## 2. Anti-Pattern 1: God Controller (Business Logic & Side Effects Bocor)

Ini adalah bentuk paling umum dari *legacy code* di mana satu metode Controller melakukan semua hal mulai dari validasi, ekstraksi logika komputasi, manipulasi persisten, pemanggilan pihak ketiga (seperti pengiriman email), hingga formatting JSON response.

### ❌ KODE SALAH (Fat Controller & Pelanggaran SRP)

```php
<?php
// Legacy code, no strict types, high cognitive complexity

namespace App\Http\Controllers;

use App\Models\Order;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Exception;

class OrderController extends Controller
{
    public function store(Request $request)
    {
        // 1. Validation inside controller (Bloated and Hard to test)
        $request->validate([
            'user_id' => 'required|exists:users,id',
            'product_id' => 'required|exists:products,id',
            'quantity' => 'required|integer|min:1',
            'discount_code' => 'nullable|string',
        ]);

        try {
            DB::beginTransaction();

            // 2. Direct model instantiation & business logic leakage
            $order = new Order();
            $order->user_id = $request->user_id;
            $order->product_id = $request->product_id;
            $order->quantity = $request->quantity;
            $order->status = 'pending';

            // 3. Logic calculation mixed in (Should be tested in isolation)
            if ($request->discount_code === 'PROMO50') {
                $order->total_price = ($request->quantity * 100) - 50; // Hardcoded parameters!
            } else {
                $order->total_price = $request->quantity * 100;
            }

            $order->save();

            // 4. Side effects direct execution (Slows down HTTP request lifecycle)
            $user = User::find($request->user_id);
            Mail::raw("Order placed", function ($message) use ($user) {
                $message->to($user->email)->subject('Order Confirmation');
            });

            DB::commit();

            return response()->json(['status' => 'success', 'order' => $order]);
        } catch (Exception $e) {
            DB::rollBack();
            // 5. Exposing internal errors to the public! (Vulnerability)
            return response()->json(['error' => $e->getMessage()], 500); 
        }
    }
}
```

#### 🚨 Analisis Bahaya (Mengapa Berbahaya):
1.  **Security Risk (Error Exposure & Info Disclosure):** Menggunakan `return response()->json(['error' => $e->getMessage()], 500)` dapat membocorkan informasi sensitif seperti *credentials* database, IP internal, atau versi infrastruktur ke pihak eksternal (termasuk *hacker*).
2.  **Memory & Performance Risk (Synchronous Trap):** Sinkronus email via `Mail::raw()` di dalam siklus HTTP request akan memblokir *thread* dan menahan koneksi. Memori pekerja PHP terkunci, menurunkan *throughput* aplikasi secara drastis saat *traffic* tinggi, yang bisa memicu *Distributed Denial of Service (DDoS)* secara tak terduga.
3.  **Maintainability (SRP Violation):** Jika ada perubahan cara kalkulasi harga diskon, kita harus mengedit Controller. Jika Controller juga bertugas sebagai antarmuka API, Web, atau CLI, *logic* ini berisiko besar terduplikasi di banyak tempat.

### ✅ KODE BENAR (Clean Architecture, DTO, dan Actions)

Praktik terbaik mendikte pemisahan tanggung jawab menjadi `StoreOrderRequest` untuk validasi & DTO, `CreateOrderAction` untuk *Business Logic*, dan Controller tipis yang sangat berfokus.

**Form Request / Data Transfer Object (DTO):**
```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use App\DTOs\OrderDataDto;
use Illuminate\Foundation\Http\FormRequest;

final class StoreOrderRequest extends FormRequest
{
    public function authorize(): bool
    {
        // Otorisasi dipusatkan di sini sebelum mencapai Controller
        return $this->user()->can('create-order');
    }

    /**
     * @return array<string, \Illuminate\Contracts\Validation\ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'product_id' => ['required', 'integer', 'exists:products,id'],
            'quantity' => ['required', 'integer', 'min:1'],
            'discount_code' => ['nullable', 'string', 'max:20'],
        ];
    }

    public function toDto(): OrderDataDto
    {
        return new OrderDataDto(
            userId: $this->user()->id,
            productId: (int) $this->input('product_id'),
            quantity: (int) $this->input('quantity'),
            discountCode: $this->input('discount_code')
        );
    }
}
```

**Data Transfer Object (DTO) Definition:**
```php
<?php

declare(strict_types=1);

namespace App\DTOs;

final readonly class OrderDataDto
{
    public function __construct(
        public int $userId,
        public int $productId,
        public int $quantity,
        public ?string $discountCode = null,
    ) {}
}
```

**Action / Service Layer (Business Logic Terenkapsulasi):**
```php
<?php

declare(strict_types=1);

namespace App\Actions;

use App\DTOs\OrderDataDto;
use App\Models\Order;
use App\Events\OrderCreated;
use Illuminate\Support\Facades\DB;
use Throwable;

final class CreateOrderAction
{
    /**
     * Mengeksekusi pembuatan pesanan dan memicu delegasi asinkronus.
     * 
     * @throws Throwable
     */
    public function execute(OrderDataDto $dto): Order
    {
        return DB::transaction(function () use ($dto): Order {
            $totalPrice = $this->calculateTotal($dto->productId, $dto->quantity, $dto->discountCode);

            $order = Order::create([
                'user_id' => $dto->userId,
                'product_id' => $dto->productId,
                'quantity' => $dto->quantity,
                'status' => 'pending',
                'total_price' => $totalPrice,
            ]);

            // Delegasikan side-effects ke asinkronus events/jobs agar tidak memblokir thread HTTP
            OrderCreated::dispatch($order);

            return $order;
        });
    }

    private function calculateTotal(int $productId, int $quantity, ?string $discountCode): int
    {
        // Dalam implementasi nyata, harga dasar akan dikueri dari $productId
        $basePrice = 100 * $quantity;
        return $discountCode === 'PROMO50' ? $basePrice - 50 : $basePrice;
    }
}
```

**Refactored Controller (Thin & Clean):**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Requests\StoreOrderRequest;
use App\Actions\CreateOrderAction;
use Illuminate\Http\JsonResponse;
use Throwable;
use Illuminate\Support\Facades\Log;

final class OrderController extends Controller
{
    public function __construct(
        private readonly CreateOrderAction $createOrderAction
    ) {}

    public function store(StoreOrderRequest $request): JsonResponse
    {
        try {
            // Menerima input, meneruskan DTO ke layer Action. Sangat bersih.
            $order = $this->createOrderAction->execute($request->toDto());

            return response()->json([
                'status' => 'success',
                'data' => $order
            ], 201);
        } catch (Throwable $e) {
            // Contextual Logging untuk debugging internal tanpa mengeksposnya ke eksternal.
            Log::error('Order creation failed', [
                'error' => $e->getMessage(),
                'user_id' => $request->user()->id,
            ]);
            
            return response()->json([
                'status' => 'error',
                'message' => 'Unable to process order at this time. Please try again later.'
            ], 500);
        }
    }
}
```

---

## 3. Anti-Pattern 2: Implicit N+1 & Otorisasi Terlewat

Dalam pembangunan legacy API, *developer* sangat sering mem-bypass otorisasi dan langsung membuat model berdasarkan input HTTP, lalu tidak mempedulikan masalah *eager loading*, sehingga terjadi *N+1 problem* dan celah mematikan seperti IDOR.

### ❌ KODE SALAH (IDOR Risk, N+1 Problem, Out-of-Memory)

```php
<?php
// Legacy code, implicit relationships trap

namespace App\Http\Controllers;

use App\Models\Post;
use Illuminate\Http\Request;

class PostController extends Controller
{
    public function show(Request $request)
    {
        // 1. Missing Authorization! Anyone can pass any ID.
        // IDOR (Insecure Direct Object Reference) risk memuncak.
        $post = Post::find($request->id);

        if (!$post) {
            return response()->json(['error' => 'Not found'], 404);
        }

        // 2. N+1 Problem saat memformat response secara manual.
        $data = [
            'title' => $post->title,
            'author_name' => $post->author->name, // N+1 occurs here!
            'comments' => $post->comments->map(function($comment) { // N+1 occurs here!
                return [
                    'text' => $comment->text,
                    'user' => $comment->user->name // Nested N+1 loop!
                ];
            })
        ];

        return response()->json($data);
    }
}
```

#### 🚨 Analisis Bahaya (Mengapa Berbahaya):
1.  **Security Risk (IDOR):** Tidak adanya pemeriksaan otorisasi (apakah user pengakses diperbolehkan melihat post dengan ID ini). `Post::find($request->id)` memercayai input ID dari sembarang klien.
2.  **Performance Risk (N+1 Query Explosion):** Pemanggilan dinamis `$post->author` (lazy loading) dan iterasi di `$post->comments` menyebabkan query ke database dilakukan di dalam *looping*. Jika post memiliki 500 komentar, maka akan terjadi minimal 500+ kueri database. Aplikasi akan lumpuh dengan CPU spike ke 100%.
3.  **Memory Risk (OOM):** Jika array relasi sangat masif dan tidak dipaginasi di database, PHP terpaksa mengalokasikan semuanya ke memori secara sinkronus. Puncak *Memory Allocation* akan terlampaui sehingga terjadi *Fatal Error: Out of Memory*.

### ✅ KODE BENAR (Route Binding, Gates, Repositories, & API Resources)

Pendekatan profesional wajib mengintegrasikan *Route Model Binding*, memvalidasi izin dengan *Gates/Policies*, menggunakan *Repository Pattern* untuk menyembunyikan query relasional yang kompleks, dan membungkus hasil ke dalam *API Resources*.

**Repository (Menangani Eager Loading Secara Aman):**
```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Models\Post;

final class PostRepository
{
    public function getPostWithRelations(Post $post): Post
    {
        // Mencegah N+1 dengan Strict Eager Loading
        // Serta membatasi jumlah baris relasi yang ditarik untuk mencegah OOM.
        return $post->load([
            'author:id,name',
            'comments' => fn ($query) => $query->latest()->limit(50), 
            'comments.user:id,name'
        ]);
    }
}
```

**API Resource (Transformasi Data Ketat):**
```php
<?php

declare(strict_types=1);

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * @property \App\Models\Post $resource
 */
final class PostResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->resource->id,
            'title' => $this->resource->title,
            // $this->whenLoaded menjamin error tidak terpicu jika relasi lupa di-load (mencegah N+1).
            'author_name' => clone $this->whenLoaded('author', fn () => $this->resource->author->name),
            'comments' => CommentResource::collection($this->whenLoaded('comments')),
        ];
    }
}
```

**Refactored Controller:**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\Post;
use App\Repositories\PostRepository;
use App\Http\Resources\PostResource;
use Illuminate\Support\Facades\Gate;
use Illuminate\Http\JsonResponse;

final class PostController extends Controller
{
    public function __construct(
        private readonly PostRepository $postRepository
    ) {}

    /**
     * Route implicit binding guarantees $post exists (or throws 404).
     */
    public function show(Post $post): JsonResponse
    {
        // 1. Otorisasi Ketat (Mencegah kerentanan IDOR)
        Gate::authorize('view', $post);

        // 2. Load Relasi Efisien & Terbatas (Mencegah N+1 & Membatasi Memori)
        $loadedPost = $this->postRepository->getPostWithRelations($post);

        // 3. Response representasional yang seragam
        return response()->json([
            'status' => 'success',
            'data' => new PostResource($loadedPost)
        ]);
    }
}
```

---

## 4. Pest v3 Testing (Unit, Feature, & Architecture)

Menerapkan kode modern tanpa disertai pengujian otomatis berpotensi menciptakan kerusakan (regression). Dengan Pest v3 di Laravel 11, kita memvalidasi fungsionalitas, *mocking*, dan integritas batas antar *layer architecture*.

### Setup Inti (tests/Pest.php)
```php
<?php

declare(strict_types=1);

uses(
    Tests\TestCase::class,
    Illuminate\Foundation\Testing\RefreshDatabase::class,
)->in('Feature', 'Unit');
```

### Unit Test untuk Action Layer (Bisnis Terisolasi)
```php
<?php

declare(strict_types=1);

namespace Tests\Unit\Actions;

use App\Actions\CreateOrderAction;
use App\DTOs\OrderDataDto;
use App\Events\OrderCreated;
use App\Models\User;
use Illuminate\Support\Facades\Event;

test('action executes successfully, calculates price, and dispatches event', function () {
    // Arrange (Isolasi event)
    Event::fake();
    $user = User::factory()->create();
    
    $dto = new OrderDataDto(
        userId: $user->id,
        productId: 1,
        quantity: 2,
        discountCode: 'PROMO50'
    );
    
    $action = new CreateOrderAction();

    // Act
    $order = $action->execute($dto);

    // Assert (Fokus pada validitas hasil, bukan routing)
    expect($order)
        ->toBeInstanceOf(\App\Models\Order::class)
        ->and($order->quantity)->toBe(2)
        ->and($order->total_price)->toBe(150); // Validasi logika pricing: (2*100) - 50

    // Validasi side-effects
    Event::assertDispatched(OrderCreated::class, function ($event) use ($order) {
        return $event->order->id === $order->id;
    });
});
```

### Feature Test (Integrasi HTTP, Validasi, Kontrol Eksekusi)
```php
<?php

declare(strict_types=1);

namespace Tests\Feature\Controllers;

use App\Models\User;
use App\Models\Product;
use App\Actions\CreateOrderAction;
use App\Models\Order;
use Mockery\MockInterface;

it('rejects order creation with 403 if user is unauthorized via policy', function () {
    $user = User::factory()->create(['role' => 'guest']); // Tidak diotorisasi FormRequest
    
    $response = $this->actingAs($user)->postJson('/api/orders', [
        'product_id' => 1,
        'quantity' => 1,
    ]);

    $response->assertForbidden();
});

it('delegates valid request to action layer correctly (Using Mocks)', function () {
    $user = User::factory()->create(['role' => 'customer']); // Authorized
    $product = Product::factory()->create();
    
    // Mencegah Action nyata dijalankan, memvalidasi isolasi Controller.
    $this->mock(CreateOrderAction::class, function (MockInterface $mock) {
        $mock->shouldReceive('execute')
             ->once()
             ->andReturn(new Order(['id' => 101, 'total_price' => 200]));
    });

    $response = $this->actingAs($user)->postJson('/api/orders', [
        'product_id' => $product->id,
        'quantity' => 2,
    ]);

    $response->assertCreated()
             ->assertJsonPath('data.id', 101)
             ->assertJsonPath('status', 'success');
});
```

### Architecture Testing (Arch Testing)

Pest menyediakan fitur revolusioner *Arch Testing* untuk mengunci batas arsitektur sehingga tidak ada junior/senior *developer* yang tidak sengaja menulis ulang *God Controller*.

```php
<?php

declare(strict_types=1);

namespace Tests\Architecture;

test('controllers strict architecture rules')
    ->expect('App\Http\Controllers')
    ->toBeClasses()
    ->toBeFinal() // Memaksa Open-Closed Principle secara ekstrem.
    ->toUseStrictTypes()
    ->toOnlyHaveMethods(['index', 'create', 'store', 'show', 'edit', 'update', 'destroy', '__construct']);

test('controllers must not access database models directly')
    ->expect('App\Http\Controllers')
    ->not->toUse('Illuminate\Database\Eloquent\Model')
    ->ignoring('App\Http\Controllers\Controller'); // Izinkan controller induk dari internal

test('form requests are type safe and independent')
    ->expect('App\Http\Requests')
    ->toBeClasses()
    ->toUseStrictTypes()
    ->toExtend('Illuminate\Foundation\Http\FormRequest');

test('actions must remain unaware of the HTTP layer')
    ->expect('App\Actions')
    ->not->toUse('Illuminate\Http\Request') // Mencegah dependensi HTTP di dalam *business logic*
    ->not->toUse('Illuminate\Http\JsonResponse')
    ->toBeFinal()
    ->toUseStrictTypes();
```

---

## 5. Ringkasan Kunci (Top 1% Checklist)

1.  **Strict Types Everywhere:** Mulai dari DTO, Actions, hingga Test, setiap baris kode PHP diawali dengan `declare(strict_types=1);`.
2.  **Immutability:** Manfaatkan constructur `readonly class` pada DTO. Mencegah manipulasi state oleh *developer* secara tak terduga dalam antrean objek.
3.  **Encapsulation (Final Keyword):** Class Action, API Resource, dan Controller yang mengadopsi clean-architecture idealnya selalu `final` untuk mencegah perpanjangan hierarki tak terkendali yang dapat mem-bypass batasan logika asal.
4.  **No Exceptions as Control Flow:** Eksepsi hanya boleh dilempar pada kasus krusial. Tangkap eksekusi gagal di controller dengan `try...catch`, laporkan error log internal melalui `report()` atau `Log::error()`, dan tutupi pesan error tersebut dengan balasan umum kepada pihak *client*.
5.  **Event-Driven Side Effects:** Pengiriman email, notifikasi push, regenerasi *cache*, atau manipulasi API *third-party* (seperti payment gateway callback webhook) WAJIB didelegasikan ke *Events/Jobs* latar belakang.
6.  **Pest Architecture Lock:** Pastikan *Clean Architecture* dipertahankan dengan *architecture test rules*. Evaluasi pipeline CI/CD tidak akan membiarkan *regressions* arsitektural terjadi.
