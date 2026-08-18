# Panduan Definitif Laravel Scout dengan Meilisearch & Algolia

Pencarian (Search) adalah salah satu fitur paling krusial dalam aplikasi berskala besar. Pencarian teks tradisional menggunakan `LIKE %query%` di SQL akan gagal (timeout, degradasi performa, beban database tinggi) seiring bertambahnya data. Oleh karena itu, kita membutuhkan Full-Text Search Engine khusus seperti **Meilisearch** atau **Algolia**, yang dihubungkan ke aplikasi Laravel menggunakan **Laravel Scout**.

Dokumen ini adalah referensi komprehensif (Top 1% Quality) yang mencakup teori mendalam, praktik Clean Architecture, optimasi performa tinggi, Anti-Patterns kritis, dan pengujian (testing) arsitektur serta unit test dengan Pest v3 untuk Laravel 11/12 (PHP 8.3/8.4).

---

## 1. Fondasi Teoretis: Inverted Index dan Typo Tolerance

Baik Meilisearch maupun Algolia beroperasi berdasarkan struktur data **Inverted Index**. Alih-alih mencari setiap baris data untuk mencocokkan string, inverted index memetakan kata (token) ke dokumen di mana kata tersebut muncul. 

**Keunggulan Meilisearch & Algolia:**
1. **Typo Tolerance:** Menggunakan algoritma jarak Levenshtein untuk mengoreksi kesalahan pengetikan pengguna.
2. **Relevance Customization:** Pengembang dapat mengatur atribut mana yang memiliki bobot pencarian lebih tinggi (misal: `title` lebih penting dari `description`).
3. **Filtering & Faceting:** Memungkinkan filter berdasarkan kategori atau rentang nilai tanpa mengorbankan performa pencarian teks.
4. **Synonyms:** Menyamakan istilah yang berbeda namun memiliki arti yang sama (misal: "sepatu" = "sneakers").

---

## 2. Persiapan dan Konfigurasi Model (Laravel Scout)

Langkah pertama adalah memastikan model terkonfigurasi dengan tepat untuk diindeks oleh Scout. 

### Model: `Product`

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Laravel\Scout\Searchable;

final class Product extends Model
{
    use HasFactory;
    use Searchable;

    protected $fillable = [
        'store_id',
        'sku',
        'name',
        'description',
        'price',
        'is_active',
        'category',
    ];

    protected $casts = [
        'is_active' => 'boolean',
        'price' => 'integer', // Selalu simpan harga dalam satuan terkecil (sen/rupiah tanpa desimal)
    ];

    /**
     * Tentukan indeks mana yang digunakan (opsional jika nama indeks berbeda dari nama tabel)
     */
    public function searchableAs(): string
    {
        return 'products_index';
    }

    /**
     * Data yang akan dikirim ke Search Engine.
     * JANGAN kirim semua kolom. Kirim hanya kolom yang dicari (searchable) atau difilter (filterable).
     *
     * @return array<string, mixed>
     */
    public function toSearchableArray(): array
    {
        return [
            'id' => (string) $this->id,
            'store_id' => (string) $this->store_id, // Untuk Multi-tenancy filtering
            'sku' => $this->sku,
            'name' => $this->name,
            'description' => $this->description,
            'price' => $this->price,
            'category' => $this->category,
            'is_active' => $this->is_active,
        ];
    }

    /**
     * Kondisi apakah model ini boleh diindeks.
     * Hanya indeks produk yang aktif.
     */
    public function shouldBeSearchable(): bool
    {
        return $this->is_active;
    }

    /**
     * Relasi untuk eager loading saat Scout mengembalikan hasil.
     */
    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }
}
```

---

## 3. Implementasi Clean Architecture

Dalam Clean Architecture, kita memisahkan tanggung jawab: FormRequest untuk validasi input, Controller sebagai pengatur lalu lintas HTTP, Action/Service untuk orkestrasi bisnis, dan Repository untuk abstraksi query.

### A. Data Transfer Object (DTO)

```php
<?php

declare(strict_types=1);

namespace App\DTOs;

final readonly class ProductSearchDTO
{
    public function __construct(
        public string $query,
        public ?string $category = null,
        public ?int $minPrice = null,
        public ?int $maxPrice = null,
        public int $page = 1,
        public int $perPage = 15,
    ) {
    }
}
```

### B. FormRequest

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use App\DTOs\ProductSearchDTO;
use Illuminate\Foundation\Http\FormRequest;

final class SearchProductRequest extends FormRequest
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
            'q' => ['nullable', 'string', 'max:100'],
            'category' => ['nullable', 'string', 'max:50'],
            'min_price' => ['nullable', 'integer', 'min:0'],
            'max_price' => ['nullable', 'integer', 'gte:min_price'],
            'page' => ['nullable', 'integer', 'min:1'],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:100'],
        ];
    }

    public function toDTO(): ProductSearchDTO
    {
        return new ProductSearchDTO(
            query: (string) $this->validated('q', ''),
            category: $this->validated('category'),
            minPrice: $this->validated('min_price') !== null ? (int) $this->validated('min_price') : null,
            maxPrice: $this->validated('max_price') !== null ? (int) $this->validated('max_price') : null,
            page: (int) $this->validated('page', 1),
            perPage: (int) $this->validated('per_page', 15),
        );
    }
}
```

### C. Repository (Akses Pencarian)

```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use App\DTOs\ProductSearchDTO;
use App\Models\Product;
use Illuminate\Pagination\LengthAwarePaginator;
use Meilisearch\Endpoints\Indexes;

final class ProductSearchRepository
{
    /**
     * @return LengthAwarePaginator<Product>
     */
    public function search(ProductSearchDTO $dto, int $storeId): LengthAwarePaginator
    {
        $search = Product::search($dto->query, function (Indexes $meilisearch, string $query, array $options) use ($dto, $storeId) {
            // Meilisearch spesifik options filtering
            $filters = ["store_id = {$storeId}"];
            
            if ($dto->category !== null) {
                $filters[] = "category = '{$dto->category}'";
            }
            
            if ($dto->minPrice !== null) {
                $filters[] = "price >= {$dto->minPrice}";
            }
            
            if ($dto->maxPrice !== null) {
                $filters[] = "price <= {$dto->maxPrice}";
            }
            
            $options['filter'] = implode(' AND ', $filters);
            
            return $meilisearch->search($query, $options);
        });

        // Eager load relasi untuk menghindari N+1 query dari hasil pencarian
        $search->query(function ($query) {
            $query->with(['store']);
        });

        return $search->paginate($dto->perPage, 'page', $dto->page);
    }
}
```

### D. Action / Service

```php
<?php

declare(strict_types=1);

namespace App\Actions;

use App\DTOs\ProductSearchDTO;
use App\Repositories\ProductSearchRepository;
use Illuminate\Pagination\LengthAwarePaginator;

final class PerformProductSearchAction
{
    public function __construct(
        private readonly ProductSearchRepository $repository,
    ) {
    }

    /**
     * @return LengthAwarePaginator<\App\Models\Product>
     */
    public function execute(ProductSearchDTO $dto, int $storeId): LengthAwarePaginator
    {
        // Business logic or metrics tracking could go here
        // Example: TrackSearchAnalyticsJob::dispatch($dto->query, $storeId);
        
        return $this->repository->search($dto, $storeId);
    }
}
```

### E. Controller

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Actions\PerformProductSearchAction;
use App\Http\Requests\SearchProductRequest;
use Illuminate\Http\JsonResponse;

final class ProductSearchController
{
    public function __invoke(
        SearchProductRequest $request, 
        PerformProductSearchAction $action
    ): JsonResponse {
        $storeId = (int) $request->user()->store_id; // Asumsi Multi-tenant berdasarkan user auth

        $paginator = $action->execute(
            $request->toDTO(), 
            $storeId
        );

        return response()->json([
            'data' => $paginator->items(),
            'meta' => [
                'current_page' => $paginator->currentPage(),
                'last_page' => $paginator->lastPage(),
                'total' => $paginator->total(),
            ]
        ]);
    }
}
```

---

## 4. Anti-Patterns & Best Practices

### Anti-Pattern 1: Mengirim Data Sensitif dan Relasi Berlebihan ke Index (Data Leakage & Bloat)

❌ **KODE SALAH (Membahayakan Security & Performa):**
```php
public function toSearchableArray(): array
{
    // BAHAYA: Ini memanggil toArray() yang mungkin memuat 
    // relasi (N+1) atau password_hash, API keys, dll.
    // Selain itu index search engine menjadi sangat gemuk.
    return $this->toArray(); 
}
```
**Mengapa Berbahaya:** 
Memanggil `toArray()` secara mentah dapat secara tidak sengaja mengindeks data rahasia seperti `password`, `api_token`, atau `cost_price` (harga modal) ke Algolia/Meilisearch. Apabila key pencarian klien terekspos, pihak luar dapat mengambil data rahasia tersebut tanpa melalui backend Laravel kita. Lebih lanjut, query relasi N+1 akan terjadi jika `toArray()` men-trigger relasi tak termuat.

✅ **KODE BENAR:**
```php
public function toSearchableArray(): array
{
    // Hanya masukkan kolom yang BENAR-BENAR digunakan untuk:
    // 1. Text Search (title, description)
    // 2. Faceting & Filtering (category, price, is_active)
    // 3. Multi-tenancy isolation (tenant_id)
    return [
        'id' => (string) $this->id,
        'tenant_id' => (string) $this->tenant_id,
        'title' => $this->title,
        'public_price' => $this->price,
        'status' => $this->status,
    ];
}
```

### Anti-Pattern 2: N+1 Query pada Hasil Pencarian Scout

❌ **KODE SALAH (Membahayakan Performa Database):**
```php
$products = Product::search($query)->get();

foreach ($products as $product) {
    // BAHAYA: Jika ada 50 produk, maka akan ada 50 query tambahan ke tabel 'categories'
    echo $product->category->name; 
}
```
**Mengapa Berbahaya:**
Scout bekerja dengan cara mendapatkan ID dari search engine (Algolia/Meilisearch), kemudian melakukan satu query `WHERE IN (id_1, id_2, ...)` ke database Laravel untuk mendapatkan Eloquent model secara penuh. Namun relasi tidak dimuat secara otomatis. Jika di view (Blade) atau API Resource kita mengakses relasinya, kita memicu masalah klasik N+1 query.

✅ **KODE BENAR:**
```php
$products = Product::search($query)
    ->query(function ($query) {
        // Eager load semua relasi yang diperlukan secara paralel dengan WHERE IN
        $query->with(['category', 'images', 'store']);
    })
    ->get();

foreach ($products as $product) {
    // AMAN: Tidak ada query ekstra ke database
    echo $product->category->name; 
}
```

### Anti-Pattern 3: Bulk Update yang Menghabiskan RAM dan Hit API Limit Algolia

❌ **KODE SALAH (Memory Risk & Rate Limiting):**
```php
// BAHAYA: Memuat sejuta data produk ke RAM sekaligus, dan
// melakukan iterasi lambat, serta memicu jutaan HTTP request ke Algolia.
$products = Product::all();
foreach ($products as $product) {
    $product->searchable();
}
```

✅ **KODE BENAR:**
```php
// 1. Gunakan chunking bawaan Scout melalui artisan command untuk bulk import:
// php artisan scout:import "App\Models\Product"

// 2. Atau dalam kode PHP (Misal via Job), gunakan chunkById dan queue:
Product::where('is_active', true)->chunkById(500, function ($products) {
    // Memasukkan 500 records ke dalam 1 HTTP request (bulk payload)
    $products->searchable(); 
});
```

---

## 5. Security & Multi-Tenancy Search

Penting untuk mencegah "Tenant B" melihat dokumen milik "Tenant A" lewat search engine. 
Ada 2 pendekatan utama:

### Pendekatan 1: Secured API Keys (Algolia Khusus)

Algolia memiliki fitur *Secured API Keys*, di mana backend Laravel men-generate Token JWT khusus yang telah di-inject filter (contoh: `filters: tenant_id=1`). Klien frontend hanya memegang kunci ini untuk pencarian langsung ke Algolia tanpa melewati Laravel backend. 

### Pendekatan 2: Backend Proxy (Laravel Bertindak sebagai Middleware)

Seperti yang kita buat di `ProductSearchRepository`. Semua query HTTP frontend ditembak ke Laravel, lalu Laravel yang menempelkan `store_id = {$storeId}` dan berkomunikasi dengan Meilisearch. Cara ini sedikit menambah latensi karena HTTP hop ekstra (Frontend -> Laravel -> Meilisearch), tetapi 100% aman dan lebih mudah jika Anda perlu menyisipkan *authorization* kompleks.

---

## 6. Testing (Pest v3)

Kode pencarian dan arsitektur wajib diuji dengan solid.

### A. Architecture Testing

Memastikan layer Repository dan Action tidak dilanggar.

```php
<?php

declare(strict_types=1);

test('models use Searchable trait if they implement toSearchableArray', function () {
    expect('App\Models')
        ->toHaveMethod('toSearchableArray')
        ->toUseTrait(\Laravel\Scout\Searchable::class);
});

test('repositories must be suffixed with Repository and reside in correct namespace', function () {
    expect('App\Repositories')
        ->toBeClasses()
        ->toHaveSuffix('Repository')
        ->toOnlyBeUsedIn('App\Actions');
});

test('controllers cannot use Repositories directly, must go through Actions', function () {
    expect('App\Http\Controllers')
        ->not->toUse('App\Repositories');
});
```

### B. Unit & Integration Testing (Search Repository)

Untuk testing Meilisearch, kita bisa me-mock engine-nya atau menggunakan SQLite local dan driver `scout` array (sync).

```php
<?php

declare(strict_types=1);

use App\DTOs\ProductSearchDTO;
use App\Models\Product;
use App\Models\Store;
use App\Repositories\ProductSearchRepository;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    // Menggunakan driver array/database untuk mocking test agar tidak hit API Meilisearch beneran
    config(['scout.driver' => 'collection']);
});

test('it filters search by category and price constraints correctly', function () {
    $store = Store::factory()->create();
    
    // Seed produk
    Product::factory()->create([
        'store_id' => $store->id,
        'name' => 'Laptop Pro 15',
        'category' => 'Electronics',
        'price' => 15000000,
        'is_active' => true,
    ]);
    Product::factory()->create([
        'store_id' => $store->id,
        'name' => 'Laptop Basic',
        'category' => 'Electronics',
        'price' => 5000000,
        'is_active' => true,
    ]);
    Product::factory()->create([
        'store_id' => $store->id,
        'name' => 'Office Chair',
        'category' => 'Furniture',
        'price' => 1500000,
        'is_active' => true,
    ]);

    $repository = app(ProductSearchRepository::class);

    // Kasus 1: Filter kategori Electronics
    $dto1 = new ProductSearchDTO(query: 'Laptop', category: 'Electronics');
    $results1 = $repository->search($dto1, $store->id);
    expect($results1->total())->toBe(2);

    // Kasus 2: Filter harga maksimal
    $dto2 = new ProductSearchDTO(query: 'Laptop', maxPrice: 6000000);
    $results2 = $repository->search($dto2, $store->id);
    
    expect($results2->total())->toBe(1)
        ->and($results2->items()[0]->name)->toBe('Laptop Basic');
});
```

### C. Test Payload Struktur Inverted Index

```php
<?php

declare(strict_types=1);

use App\Models\Product;

test('toSearchableArray only returns safe fields', function () {
    $product = new Product([
        'id' => 1,
        'store_id' => 5,
        'sku' => 'TEST-123',
        'name' => 'Secret Product',
        'description' => 'A secret',
        'price' => 5000,
        'is_active' => true,
    ]);
    
    // Simulate hidden column existing in database but should not be exported
    $product->internal_cost = 1000; 

    $searchableArray = $product->toSearchableArray();

    expect($searchableArray)
        ->toHaveKeys(['id', 'store_id', 'sku', 'name', 'description', 'price', 'category', 'is_active'])
        ->and($searchableArray)->not->toHaveKey('internal_cost')
        ->and($searchableArray['id'])->toBeString() // ID harus direcast ke string untuk engine seperti Meilisearch
        ->and($searchableArray['price'])->toBeInt();
});
```

---

## 7. Penutup: Kunci Mencapai Top 1% dalam Search Engine Implementation

Mencapai performa maksimal dan stabilitas pada sistem pencarian memerlukan perhatian pada 3 aspek kunci:

1. **Sinkronisasi Asynchronous:** Pastikan `SCOUT_QUEUE=true` diset pada file `.env` di tahap produksi. Menggunakan queue (seperti Redis) memastikan bahwa ketika User melakukan Create/Update/Delete (CUD) pada Model, HTTP response ke User tetap instan sementara proses upload JSON document ke Meilisearch/Algolia dieksekusi di background worker.
2. **Batching Updates:** Jangan gunakan `save()` berulang-ulang di dalam loop besar yang akan meluncurkan job Scout per baris. Selalu gunakan `Model::withoutSyncingToSearch(fn () => ...)` saat melakukan mass update, kemudian gunakan command `php artisan scout:import` setelahnya, atau eksekusi `searchable()` dalam kumpulan (chunking).
3. **Index Optimization (Khusus Meilisearch):** Selalu set `filterableAttributes` dan `sortableAttributes` via Artisan Command atau API secara eksplicit. Jangan jadikan deskripsi panjang sebagai filterable (akan menghabiskan memori RAM Server secara masif untuk membangun Facet Tree). 
