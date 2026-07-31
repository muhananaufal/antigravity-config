# Alpine.js State Management di Ekosistem Laravel (Top 1% Quality)

Alpine.js adalah framework JavaScript yang sangat ringan (minimalis) namun tangguh untuk menangani interaktivitas di sisi klien (client-side) tanpa perlu menggunakan framework berat seperti Vue atau React. Dalam ekosistem Laravel, Alpine.js menjadi partner sempurna bagi Livewire (TALL Stack) karena berbagi filosofi reaktivitas yang mirip dan dirancang khusus untuk bekerja sama dengan mulus.

Dokumen ini adalah *deep dive* komprehensif tentang bagaimana merancang, menstruktur, dan mengamankan aplikasi menggunakan Alpine.js di dalam ekosistem Laravel 11/12 (PHP 8.3/8.4), dilengkapi dengan implementasi Clean Architecture, arsitektur Pest v3, serta penghindaran Anti-Pattern secara mutlak.

---

## 1. Filosofi Alpine.js dalam TALL Stack

Alpine.js dirancang dengan konsep *Progressive Enhancement* dan *Declarative UI*. Kita tidak membangun SPA (Single Page Application) secara murni, melainkan memperkaya HTML yang sudah di-render oleh server (Blade/Livewire) dengan interaktivitas JavaScript.

### Kapan Menggunakan Alpine.js?
- Modals, Dropdowns, Tabs, Alerts (UI state lokal).
- DOM Manipulation sederhana tanpa perlu bolak-balik ke server.
- Bindings input dan validasi di sisi klien sebelum dikirim.
- Menjembatani komunikasi antara JavaScript pihak ketiga (misalnya chart.js, mapbox) dengan komponen Livewire.

### Kapan TIDAK Menggunakan Alpine.js?
- Logika bisnis yang kompleks dan kritis (pindahkan ke server/Livewire).
- State yang memerlukan sinkronisasi database intensif (gunakan Livewire).
- Komponen yang memiliki > 300 baris logika JavaScript (saatnya beralih ke Vue/React atau pecah menjadi Alpine Store).

---

## 2. Struktur Data dan Integrasi Backend (Clean Architecture)

Sebelum membahas Alpine.js, kita harus memastikan bahwa data yang disediakan oleh backend (Laravel) untuk dikonsumsi oleh sisi klien sudah dirancang dengan Clean Architecture. Data harus tervalidasi, terstruktur, dan tidak membocorkan struktur database.

### 2.1 Backend Pipeline: FormRequest -> Controller -> Action -> Repository

#### Form Request (Validasi Data Input dari Alpine)
```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Products;

use Illuminate\Foundation\Http\FormRequest;

final class UpdateProductStockRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()?->can('update-stock', $this->route('product')) ?? false;
    }

    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'quantity' => ['required', 'integer', 'min:1', 'max:10000'],
            'warehouse_id' => ['required', 'uuid', 'exists:warehouses,id'],
        ];
    }
}
```

#### Action (Business Logic)
```php
<?php

declare(strict_types=1);

namespace App\Actions\Products;

use App\Models\Product;
use App\Repositories\Contracts\ProductRepositoryInterface;
use Illuminate\Support\Facades\DB;
use InvalidArgumentException;

final readonly class UpdateProductStockAction
{
    public function __construct(
        private ProductRepositoryInterface $productRepository
    ) {}

    public function execute(Product $product, int $quantity, string $warehouseId): Product
    {
        if ($quantity <= 0) {
            throw new InvalidArgumentException('Quantity must be greater than zero.');
        }

        return DB::transaction(function () use ($product, $quantity, $warehouseId) {
            $product->stock += $quantity;
            $this->productRepository->save($product);

            $this->productRepository->recordStockHistory(
                productId: $product->id,
                warehouseId: $warehouseId,
                quantity: $quantity,
                type: 'addition'
            );

            return $product;
        });
    }
}
```

#### Controller (Orchestrator)
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Actions\Products\UpdateProductStockAction;
use App\Http\Requests\Products\UpdateProductStockRequest;
use App\Models\Product;
use Illuminate\Http\JsonResponse;

final class ProductStockController
{
    public function update(
        UpdateProductStockRequest $request,
        Product $product,
        UpdateProductStockAction $action
    ): JsonResponse {
        $updatedProduct = $action->execute(
            product: $product,
            quantity: (int) $request->validated('quantity'),
            warehouseId: (string) $request->validated('warehouse_id')
        );

        return response()->json([
            'status' => 'success',
            'data' => [
                'new_stock' => $updatedProduct->stock,
                'updated_at' => $updatedProduct->updated_at->toIso8601String(),
            ]
        ]);
    }
}
```

---

## 3. Integrasi Alpine.js di Blade (Frontend)

Sekarang, mari kita konsumsi API di atas menggunakan Alpine.js di dalam file Blade secara elegan.

### 3.1 Pendekatan Moduler dengan `Alpine.data()`
Jangan menaruh fungsi JavaScript yang panjang langsung di dalam atribut HTML (inline). Gunakan `Alpine.data()`.

**`resources/js/components/stockUpdater.js`**
```javascript
export default (initialStock, updateUrl) => ({
    stock: initialStock,
    quantity: 1,
    warehouseId: '',
    isLoading: false,
    errorMessage: '',
    successMessage: '',

    async updateStock() {
        this.isLoading = true;
        this.errorMessage = '';
        this.successMessage = '';

        try {
            const response = await fetch(updateUrl, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
                },
                body: JSON.stringify({
                    quantity: this.quantity,
                    warehouse_id: this.warehouseId
                })
            });

            const data = await response.json();

            if (!response.ok) {
                if (response.status === 422) {
                    this.errorMessage = Object.values(data.errors).flat().join(', ');
                    return;
                }
                throw new Error(data.message || 'Something went wrong');
            }

            this.stock = data.data.new_stock;
            this.successMessage = 'Stock updated successfully!';
            this.quantity = 1; // Reset form
        } catch (error) {
            this.errorMessage = error.message;
        } finally {
            this.isLoading = false;
        }
    }
});
```

**`resources/js/app.js`**
```javascript
import './bootstrap';
import Alpine from 'alpinejs';
import stockUpdater from './components/stockUpdater';

window.Alpine = Alpine;

Alpine.data('stockUpdater', stockUpdater);

Alpine.start();
```

**`resources/views/products/show.blade.php`**
```html
<div x-data="stockUpdater({{ $product->stock }}, '{{ route('api.products.stock.update', $product) }}')">
    <h2>Current Stock: <span x-text="stock"></span></h2>
    
    <div x-show="errorMessage" x-text="errorMessage" class="text-red-600 font-bold mb-4"></div>
    <div x-show="successMessage" x-text="successMessage" class="text-green-600 font-bold mb-4" x-transition></div>

    <form @submit.prevent="updateStock" class="flex flex-col gap-4 max-w-sm">
        <div>
            <label for="quantity" class="block font-medium">Add Quantity</label>
            <input type="number" id="quantity" x-model.number="quantity" class="border rounded px-3 py-2 w-full" min="1" required>
        </div>

        <div>
            <label for="warehouse" class="block font-medium">Warehouse</label>
            <select id="warehouse" x-model="warehouseId" class="border rounded px-3 py-2 w-full" required>
                <option value="">Select Warehouse...</option>
                @foreach($warehouses as $warehouse)
                    <option value="{{ $warehouse->id }}">{{ $warehouse->name }}</option>
                @endforeach
            </select>
        </div>

        <button type="submit" 
                :disabled="isLoading || warehouseId === ''" 
                class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center">
            <span x-show="!isLoading">Update Stock</span>
            <span x-show="isLoading" class="animate-spin ml-2">↻</span>
        </button>
    </form>
</div>
```

---

## 4. Anti-Patterns dalam Alpine.js & Laravel

### ❌ Anti-Pattern 1: XSS Vulnerability melalui @js atau JSON rendering tanpa escaping
Mengoper data PHP secara langsung ke atribut Alpine menggunakan interpolasi mentah sangat berbahaya jika data tersebut berasal dari input user.

❌ **KODE SALAH (Berbahaya - XSS Risk):**
```html
<!-- Jika $user->bio berisi payload `<script>alert('xss')</script>` atau memutus quote json -->
<div x-data='{ bio: {!! json_encode($user->bio) !!} }'>
    <span x-html="bio"></span>
</div>
```
*Mengapa Berbahaya:* Attacker dapat memanipulasi property `bio` untuk melakukan injeksi HTML kustom atau memecah sintaks JSON, mengeksekusi payload JavaScript yang mencuri token CSRF.

✅ **KODE BENAR (Aman - Protected via @js Directive & x-text):**
```html
<!-- Menggunakan helper @js bawaan Laravel yang melakukan escape dengan aman -->
<div x-data="{ bio: @js($user->bio) }">
    <!-- Selalu gunakan x-text kecuali benar-benar perlu merender HTML, 
         jika pakai x-html, pastikan di backend sudah di-sanitize dengan HTMLPurifier -->
    <span x-text="bio"></span>
</div>
```

### ❌ Anti-Pattern 2: State God Object di Alpine
Menaruh seluruh state aplikasi dalam satu object `x-data` di root level `<body>`.

❌ **KODE SALAH (Berbahaya - Memory & Performance Risk):**
```html
<body x-data="{ 
    user: @js($user), 
    products: @js($products), 
    settings: @js($settings), 
    isSidebarOpen: false, 
    cart: [] 
}">
    <!-- Semua reaktivitas akan memicu evaluasi di seluruh tree dom -->
</body>
```
*Mengapa Berbahaya:* Alpine bereaksi dengan memonitor perubahan variabel. Jika semua data diletakkan di objek besar, setiap perubahan kecil (misal `isSidebarOpen = true`) akan memaksa Alpine mengevaluasi ulang *banyak* directive di seluruh DOM tree. Hal ini mengakibatkan memory bloat dan lag parah pada interaksi UI.

✅ **KODE BENAR (Isolasi & Alpine Store):**
Pecah state menjadi bagian-bagian kecil (Component-level state) dan gunakan `Alpine.store` untuk global state (hanya jika memang diperlukan lintas komponen).

**`resources/js/app.js`**
```javascript
Alpine.store('sidebar', {
    isOpen: false,
    toggle() { this.isOpen = !this.isOpen }
});
```

**Blade UI:**
```html
<!-- Global layout state -->
<header x-data>
    <button @click="$store.sidebar.toggle()">Menu</button>
</header>

<aside x-data x-show="$store.sidebar.isOpen">...</aside>

<!-- Local component state -->
<main>
    @foreach($products as $product)
        <div x-data="{ quantity: 1, add() { /*...*/ } }">
            ...
        </div>
    @endforeach
</main>
```

---

## 5. Pengujian (Testing) Arsitektur Menggunakan Pest v3

Untuk memastikan backend yang menyokong frontend Alpine ini kokoh, kita harus mengujinya dengan standar tertinggi menggunakan Pest.

### 5.1 Architecture Testing (`tests/ArchTest.php`)
Memastikan aturan Clean Architecture dan Strict Types tidak dilanggar oleh developer lain.

```php
<?php

declare(strict_types=1);

arch('it enforce strict types in all application files')
    ->expect('App')
    ->toUseStrictTypes();

arch('controllers should not use models directly to perform write operations')
    ->expect('App\Http\Controllers')
    ->toUse('App\Actions')
    ->and('App\Http\Controllers')
    ->not->toUse('App\Models\Product::create')
    ->not->toUse('App\Models\Product::update')
    ->not->toUse('App\Models\Product::save');

arch('actions should be final and readonly classes')
    ->expect('App\Actions')
    ->toBeFinal()
    ->toBeReadonly();
```

### 5.2 Unit Testing Action (`tests/Unit/Actions/UpdateProductStockActionTest.php`)
Menguji business logic secara terisolasi tanpa intervensi HTTP.

```php
<?php

declare(strict_types=1);

use App\Actions\Products\UpdateProductStockAction;
use App\Models\Product;
use App\Repositories\Contracts\ProductRepositoryInterface;
use Illuminate\Support\Facades\DB;

uses()->group('actions', 'products');

it('updates product stock successfully and records history', function () {
    // Arrange
    $product = Mockery::mock(Product::class)->makePartial();
    $product->id = 1;
    $product->stock = 10;
    
    $warehouseId = 'wh-uuid-123';
    $quantity = 5;

    $repositoryMock = Mockery::mock(ProductRepositoryInterface::class);
    $repositoryMock->shouldReceive('save')->once()->with($product);
    $repositoryMock->shouldReceive('recordStockHistory')
        ->once()
        ->with(1, $warehouseId, $quantity, 'addition');

    DB::shouldReceive('transaction')
        ->once()
        ->andReturnUsing(fn(Closure $closure) => $closure());

    $action = new UpdateProductStockAction($repositoryMock);

    // Act
    $result = $action->execute($product, $quantity, $warehouseId);

    // Assert
    expect($result->stock)->toBe(15)
        ->and($result)->toBeInstanceOf(Product::class);
});

it('throws exception if quantity is zero or less', function () {
    // Arrange
    $product = new Product(['stock' => 10]);
    $repositoryMock = Mockery::mock(ProductRepositoryInterface::class);
    $action = new UpdateProductStockAction($repositoryMock);

    // Act & Assert
    expect(fn() => $action->execute($product, 0, 'wh-123'))
        ->toThrow(InvalidArgumentException::class, 'Quantity must be greater than zero.');
});
```

### 5.3 Feature Testing Endpoint (`tests/Feature/Api/ProductStockControllerTest.php`)
Menguji dari sisi permintaan HTTP (mensimulasikan request dari Alpine.js).

```php
<?php

declare(strict_types=1);

use App\Models\Product;
use App\Models\User;
use App\Models\Warehouse;

uses()->group('api', 'products');

it('allows authorized users to update stock via api', function () {
    // Arrange
    $user = User::factory()->create();
    // Beri permission (asumsi menggunakan spatie/laravel-permission)
    $user->givePermissionTo('update-stock'); 

    $product = Product::factory()->create(['stock' => 50]);
    $warehouse = Warehouse::factory()->create();

    // Act
    $response = $this->actingAs($user)
        ->putJson(route('api.products.stock.update', $product), [
            'quantity' => 15,
            'warehouse_id' => $warehouse->id,
        ]);

    // Assert
    $response->assertOk()
        ->assertJson([
            'status' => 'success',
            'data' => [
                'new_stock' => 65
            ]
        ]);

    $this->assertDatabaseHas('products', [
        'id' => $product->id,
        'stock' => 65,
    ]);
});

it('prevents unauthorized users from updating stock', function () {
    // Arrange
    $user = User::factory()->create(); // Tanpa permission
    $product = Product::factory()->create(['stock' => 10]);
    $warehouse = Warehouse::factory()->create();

    // Act
    $response = $this->actingAs($user)
        ->putJson(route('api.products.stock.update', $product), [
            'quantity' => 5,
            'warehouse_id' => $warehouse->id,
        ]);

    // Assert
    $response->assertForbidden();
});
```

---

## 6. Integrasi Tingkat Lanjut: Alpine.js + Livewire `@entangle`

Alpine sering digunakan untuk berbagi state langsung dengan Livewire secara real-time tanpa perlu request manual HTTP. Inilah mengapa `wire:model` dan `@entangle` merupakan fitur pamungkas.

**Livewire Component (`app/Livewire/SettingsModal.php`):**
```php
<?php

declare(strict_types=1);

namespace App\Livewire;

use Livewire\Component;

final class SettingsModal extends Component
{
    public bool $showModal = false;
    public string $theme = 'dark';

    public function saveSettings(): void
    {
        // Validasi dan simpan ke database...
        
        $this->showModal = false; // Akan menutup modal via Alpine otomatis
    }

    public function render()
    {
        return view('livewire.settings-modal');
    }
}
```

**Blade View (`resources/views/livewire/settings-modal.blade.php`):**
```html
<div x-data="{ open: @entangle('showModal') }">
    <!-- Tombol untuk membuka modal (dimanipulasi via Alpine murni di browser) -->
    <button @click="open = true" class="btn btn-primary">Open Settings</button>

    <!-- Modal Background -->
    <div x-show="open" class="fixed inset-0 bg-black/50" x-cloak>
        <!-- Modal Content -->
        <div @click.outside="open = false" class="bg-white p-6 rounded shadow-lg m-auto mt-20 max-w-lg">
            <h2 class="text-xl mb-4">Settings</h2>
            
            <div>
                <label>Theme</label>
                <!-- Terhubung langsung dengan variable $theme di backend via Livewire -->
                <select wire:model="theme" class="border p-2 w-full">
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                </select>
            </div>

            <div class="mt-6 flex justify-end gap-2">
                <button @click="open = false" class="px-4 py-2 bg-gray-200 rounded">Cancel</button>
                
                <!-- Memanggil fungsi backend -->
                <button wire:click="saveSettings" class="px-4 py-2 bg-blue-600 text-white rounded">
                    Save
                </button>
            </div>
        </div>
    </div>
</div>
```
Dalam pola di atas, UI modal di-*toggle* kecepatannya sama dengan kecepatan render browser lokal (zero latency) menggunakan Alpine, namun logika bisnis (validasi, simpan) diamankan oleh Livewire di server.

---

## Kesimpulan

Menggunakan Alpine.js di ekosistem Laravel merupakan seni dalam menjaga keseimbangan antara interaktivitas klien dan validasi/keamanan server. Dengan mematuhi standar Clean Architecture untuk API yang dikonsumsi, menghindari state bloat di sisi klien, mencegah XSS, dan secara ketat menggunakan Pest v3 untuk pengujian, aplikasi Laravel akan memiliki performa top 1% tanpa mengorbankan stabilitas operasional dan skalabilitas bisnis.
