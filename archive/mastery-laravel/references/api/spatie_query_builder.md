# Spatie Query Builder: Advanced Mastery & Best Practices (Top 1% Quality)

Spatie Query Builder adalah pustaka esensial di ekosistem Laravel untuk membangun API RESTful yang fleksibel dan kuat. Pustaka ini memfasilitasi pembuatan kueri database kompleks berdasarkan parameter request HTTP (URL query strings) dengan cara yang aman dan efisien.

Panduan ini mencakup implementasi `spatie/laravel-query-builder` tingkat lanjut (Top 1%) pada PHP 8.3/8.4 dan Laravel 11/12, menekankan **Clean Architecture**, **Strict Typing**, dan **Performance Optimization**.

---

## 1. Fondasi Clean Architecture

Dalam pengembangan API modern, kita wajib memisahkan tanggung jawab (Separation of Concerns). `QueryBuilder` TIDAK BOLEH diletakkan langsung di dalam Controller. Alur yang benar adalah:
**FormRequest -> Controller -> Action/Service -> Repository/Query Object -> Model**

### 1.1. Model Definition (PHP 8.3+)

Pastikan Model menggunakan typed properties (jika didukung) dan cast yang ketat.

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\SoftDeletes;

final class Article extends Model
{
    use HasFactory;
    use HasUuids;
    use SoftDeletes;

    protected $fillable = [
        'title',
        'slug',
        'content',
        'status',
        'published_at',
        'author_id',
    ];

    protected function casts(): array
    {
        return [
            'status' => 'string', // Bisa menggunakan Enum
            'published_at' => 'datetime',
        ];
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function author(): BelongsTo
    {
        return $this->belongsTo(User::class, 'author_id');
    }
}
```

### 1.2. Validasi dengan FormRequest

Jangan izinkan parameter kueri liar masuk ke dalam sistem. Validasi apa saja yang boleh dicari (filter), diurutkan (sort), atau dimuat (include).

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Api\V1\Article;

use Illuminate\Foundation\Http\FormRequest;

final class ListArticleRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'filter' => ['sometimes', 'array'],
            'filter.title' => ['sometimes', 'string', 'max:100'],
            'filter.status' => ['sometimes', 'string', 'in:draft,published,archived'],
            
            'sort' => ['sometimes', 'string', 'in:title,-title,published_at,-published_at,created_at,-created_at'],
            
            'include' => ['sometimes', 'string', 'in:author'],
            
            'page' => ['sometimes', 'array'],
            'page.number' => ['sometimes', 'integer', 'min:1'],
            'page.size' => ['sometimes', 'integer', 'min:1', 'max:100'], // Batasi paginasi max 100!
        ];
    }
}
```

### 1.3. Query Object (Repository / Query Builder)

Gunakan *Query Object Pattern* untuk mengenkapsulasi logika `QueryBuilder`.

```php
<?php

declare(strict_types=1);

namespace App\Queries\Article;

use App\Models\Article;
use Illuminate\Http\Request;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Pagination\LengthAwarePaginator;
use Spatie\QueryBuilder\AllowedFilter;
use Spatie\QueryBuilder\AllowedSort;
use Spatie\QueryBuilder\QueryBuilder;

final readonly class ArticleListQuery
{
    /**
     * @return LengthAwarePaginator<Article>
     */
    public function execute(Request $request): LengthAwarePaginator
    {
        $perPage = (int) $request->input('page.size', 15);

        return QueryBuilder::for(Article::class, $request)
            ->allowedFilters([
                AllowedFilter::partial('title'),
                AllowedFilter::exact('status'),
                AllowedFilter::scope('published_after'),
            ])
            ->allowedSorts([
                'title',
                'published_at',
                AllowedSort::field('created_at', 'created_at'),
            ])
            ->allowedIncludes([
                'author',
            ])
            ->defaultSort('-created_at')
            ->paginate($perPage)
            ->appends($request->query());
    }
}
```

### 1.4. Controller Eksekutor

Controller hanya bertugas menerima HTTP request (yang sudah divalidasi oleh FormRequest), memanggil Query Object, dan mengembalikan HTTP response.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\Api\V1\Article\ListArticleRequest;
use App\Http\Resources\Api\V1\ArticleResource;
use App\Queries\Article\ArticleListQuery;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;

final class ArticleController extends Controller
{
    public function __construct(
        private readonly ArticleListQuery $articleListQuery
    ) {}

    public function index(ListArticleRequest $request): AnonymousResourceCollection
    {
        $paginator = $this->articleListQuery->execute($request);

        return ArticleResource::collection($paginator);
    }
}
```

---

## 2. Fitur Lanjutan (Advanced Customizations)

### 2.1. Custom Filters
Terkadang filter bawaan `AllowedFilter::exact()` atau `AllowedFilter::partial()` tidak cukup, misal untuk mencari berdasarkan JSON column atau perhitungan kompleks.

```php
<?php

declare(strict_types=1);

namespace App\Filters;

use Illuminate\Database\Eloquent\Builder;
use Spatie\QueryBuilder\Filters\Filter;

final readonly class JsonContainsFilter implements Filter
{
    public function __invoke(Builder $query, mixed $value, string $property): void
    {
        if (!is_array($value)) {
            $value = [$value];
        }

        foreach ($value as $val) {
            $query->whereJsonContains($property, $val);
        }
    }
}
```
**Penggunaan di Query Object:**
```php
AllowedFilter::custom('tags', new JsonContainsFilter(), 'metadata->tags')
```

### 2.2. Custom Sorts
Menyortir berdasarkan relasi atau agregasi bisa berbahaya (N+1). Gunakan `CustomSort` untuk melakukan sub-query atau `join` yang aman.

```php
<?php

declare(strict_types=1);

namespace App\Sorts;

use Illuminate\Database\Eloquent\Builder;
use Spatie\QueryBuilder\Sorts\Sort;

final readonly class AuthorNameSort implements Sort
{
    public function __invoke(Builder $query, bool $descending, string $property): void
    {
        $direction = $descending ? 'DESC' : 'ASC';

        $query->orderBy(
            User::select('name')
                ->whereColumn('users.id', 'articles.author_id')
                ->limit(1),
            $direction
        );
    }
}
```
**Penggunaan di Query Object:**
```php
AllowedSort::custom('author_name', new AuthorNameSort())
```

---

## 3. Anti-Patterns & Best Practices

Berikut adalah perbandingan penerapan Spatie Query Builder yang SALAH vs BENAR.

### 🔴 Anti-Pattern 1: God Controller (Fat Controller)
Menggandeng Form Validation, Logic, dan Query Builder di dalam controller. Hal ini menyalahi *Single Responsibility Principle* (SRP) dan membuat controller sangat sulit untuk diuji dengan unit testing (mocking).

❌ **KODE SALAH:**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\Article;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Spatie\QueryBuilder\QueryBuilder;
use Spatie\QueryBuilder\AllowedFilter;

final class ArticleController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        // 1. Tidak ada Form Request Validation
        // 2. Logika Kueri numpuk di controller
        $articles = QueryBuilder::for(Article::class)
            ->allowedFilters([
                AllowedFilter::exact('status'),
                AllowedFilter::partial('title'),
            ])
            ->allowedIncludes('author')
            ->defaultSort('-created_at')
            ->paginate($request->input('per_page', 15));

        return response()->json($articles);
    }
}
```

✅ **KODE BENAR:**
Memisahkan validasi di `ListArticleRequest` dan ekstraksi query builder ke `ArticleListQuery` (seperti yang ditunjukkan di Bagian 1). Controller menjadi sangat tipis dan fokus pada HTTP I/O.

---

### 🔴 Anti-Pattern 2: Uncapped Pagination & Missing Selects
Tidak membatasi ukuran halaman (page size) menyebabkan kerentanan DDoS jika penyerang mengirimkan `?page[size]=100000`. Selain itu, tidak mendefinisikan kolom yang di-`select` akan membebani memori jika ada kolom TEXT/JSON berukuran besar.

❌ **KODE SALAH:**
```php
// ... dalam QueryObject/Controller
$perPage = $request->input('page.size', 15); // Nilai ini bisa dimanipulasi user!

return QueryBuilder::for(Article::class)
    ->allowedFilters(['status'])
    ->paginate($perPage); 
    // SELECT * FROM articles
```

✅ **KODE BENAR:**
Batasi limit maksimum `page.size` lewat FormRequest (misal max: 100), dan gunakan metode `select()` atau `allowedFields()` untuk menghindari kelebihan muatan.

```php
// 1. FormRequest membatasi: 'page.size' => ['integer', 'max:100']

// 2. Query Object
return QueryBuilder::for(Article::class, $request)
    ->allowedFields(['id', 'title', 'status', 'created_at']) // Membatasi kolom
    ->allowedFilters(['status'])
    ->paginate((int) $request->input('page.size', 15));
```

---

## 4. Testing dengan Pest v3

Kode tingkat tinggi wajib disertai Unit Test dan Architecture Test. Pest v3 memberikan sintaks ekspresif.

### 4.1. Unit / Feature Test
Kita akan menguji apakah Query Object merespons dengan benar terhadap parameter filter.

```php
<?php

declare(strict_types=1);

use App\Models\Article;
use App\Models\User;
use Illuminate\Support\Facades\Http;
use function Pest\Laravel\getJson;

it('dapat menyaring artikel berdasarkan title secara partial', function () {
    // Arrange
    $user = User::factory()->create();
    Article::factory()->create(['title' => 'Laravel 11 Released', 'status' => 'published']);
    Article::factory()->create(['title' => 'Vue 3 Updates', 'status' => 'draft']);

    // Act
    $response = getJson('/api/v1/articles?filter[title]=Laravel');

    // Assert
    $response->assertStatus(200)
             ->assertJsonCount(1, 'data')
             ->assertJsonPath('data.0.title', 'Laravel 11 Released');
});

it('gagal divalidasi jika ukuran halaman terlalu besar', function () {
    $response = getJson('/api/v1/articles?page[size]=500');

    $response->assertStatus(422)
             ->assertJsonValidationErrors(['page.size']);
});
```

### 4.2. Architecture Test
Memastikan semua *Query Objects* ditempatkan pada namespace yang tepat, bersifat final, read-only (opsional), dan memiliki dependensi ketat.

```php
<?php

declare(strict_types=1);

arch('query objects harus bersifat final dan hanya memiliki satu metode execute')
    ->expect('App\Queries')
    ->toBeFinal()
    ->toUseStrictTypes()
    ->toHaveMethod('execute');

arch('controller tidak boleh memanggil eloquent secara langsung')
    ->expect('App\Http\Controllers')
    ->not->toUse('Illuminate\Database\Eloquent\Model')
    ->ignoring('App\Http\Controllers\Auth'); // Kecuali domain khusus
```

---

## 5. Security Checklist (Top 1% Standards)

Sebelum menerapkan Spatie Query Builder ke Production, centang seluruh daftar berikut:

- [ ] **Strict Typing:** `declare(strict_types=1);` aktif di semua file terkait.
- [ ] **Validation First:** Tidak ada satupun URL query yang diproses tanpa melalui filter `FormRequest` (termasuk `page.number` dan `page.size`).
- [ ] **Cap Page Size:** Paginasi dibatasi ke nilai logis maksimal (misal `100` atau `500`) untuk mencegah DoS lewat eksploitasi memori DB.
- [ ] **No Hidden Columns:** Selalu eksplisit soal `allowedFields()`. Cegah attacker memanggil `?fields[users]=password`.
- [ ] **Relationship Safety:** Jangan mengizinkan relasi yang memakan banyak *processing time* di-include tanpa batas.
- [ ] **Index on Filters:** Jika kolom diizinkan di `allowedFilters['status', 'category']`, pastikan ada Index Database yang sesuai pada kolom-kolom tersebut.

---

Dengan mengikuti pedoman tingkat lanjut ini, implementasi Spatie Query Builder Anda akan stabil, sangat aman, mudah diuji, dan memenuhi standar kode berskala Enterprise Top 1%.
