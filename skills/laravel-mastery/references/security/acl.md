# Laravel Access Control List (ACL) & Security Mastery

Dokumen ini merangkum praktik terbaik, standar arsitektur tingkat lanjut, dan pedoman keamanan untuk mengimplementasikan Access Control List (ACL), otorisasi, dan Role-Based Access Control (RBAC) di aplikasi Laravel 11/12 yang menggunakan PHP 8.3/8.4. Keamanan bukan sekadar fitur, melainkan fondasi arsitektur yang harus diintegrasikan di setiap lapisan aplikasi (Defense in Depth). 

Sistem ACL yang tangguh memastikan prinsip *Least Privilege* diterapkan dengan ketat, mencegah eksploitasi *Broken Access Control* (OWASP Top 10), dan memisahkan logika bisnis dari aturan otorisasi.

---

## 1. Fondasi Otorisasi di Laravel

Laravel menyediakan dua mekanisme utama untuk otorisasi: **Gates** (gerbang) dan **Policies** (kebijakan). 

- **Gates**: Fungsi *closure* sederhana yang menentukan apakah pengguna diizinkan melakukan tindakan tertentu, biasanya tidak terkait dengan model spesifik (contoh: mengakses dasbor admin).
- **Policies**: Kelas yang mengelompokkan logika otorisasi seputar model atau resource tertentu (contoh: mengedit atau menghapus artikel).

Dalam arsitektur *Enterprise*, kita mendefinisikan *Permissions* menggunakan `Enum` PHP 8.1+ untuk menjamin *type-safety* dan mencegah *typo* (kesalahan ketik) pada string permission.

### 1.1 Mendefinisikan Permission Enum

```php
<?php

declare(strict_types=1);

namespace App\Domain\Security\Enums;

enum Permission: string
{
    case VIEW_USERS = 'users.view';
    case CREATE_USERS = 'users.create';
    case UPDATE_USERS = 'users.update';
    case DELETE_USERS = 'users.delete';
    
    case VIEW_ARTICLES = 'articles.view';
    case CREATE_ARTICLES = 'articles.create';
    case UPDATE_ARTICLES = 'articles.update';
    case DELETE_ARTICLES = 'articles.delete';
}
```

### 1.2 Mendaftarkan Super Admin via Gate Interception

Seringkali kita membutuhkan peran `Super Admin` yang selalu dapat melewati semua pengecekan otorisasi. Praktik terbaik adalah mendaftarkan *interceptor* di `AppServiceProvider`.

```php
<?php

declare(strict_types=1);

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use Illuminate\Support\Facades\Gate;
use App\Domain\User\Models\User;

final class AppServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        // Implicitly grant "Super Admin" role all permissions
        // This works with spatie/laravel-permission as well
        Gate::before(static function (User $user, string $ability): ?bool {
            if ($user->hasRole('Super Admin')) {
                return true;
            }
            
            return null; // Fallback to regular authorization checks
        });
    }
}
```

---

## 2. Integrasi Clean Architecture pada ACL

Dalam Clean Architecture, alur request harus melewati tahapan yang ketat: `Route` -> `FormRequest` -> `Controller` -> `Action/Service` -> `Repository` -> `Model`. 

Otorisasi tidak boleh bergantung sepenuhnya pada satu layer. Kita menerapkan "Defense in Depth" dengan mengecek otorisasi di tingkat *Request* (menggunakan FormRequest atau Middleware) dan juga melakukan *Data Scoping* di tingkat *Repository/Action*.

### 2.1 Model & Trait RBAC

Kita asumsikan penggunaan package seperti `spatie/laravel-permission` yang dikonfigurasi secara kustom.

```php
<?php

declare(strict_types=1);

namespace App\Domain\User\Models;

use Illuminate\Foundation\Auth\User as Authenticatable;
use Spatie\Permission\Traits\HasRoles;

final class User extends Authenticatable
{
    use HasRoles;

    protected $fillable = [
        'name',
        'email',
        'password',
    ];
    
    // ...
}
```

```php
<?php

declare(strict_types=1);

namespace App\Domain\Article\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use App\Domain\User\Models\User;

final class Article extends Model
{
    protected $fillable = [
        'user_id',
        'title',
        'content',
        'status',
    ];
    
    /**
     * @return BelongsTo<User, Article>
     */
    public function author(): BelongsTo
    {
        return $this->belongsTo(User::class, 'user_id');
    }
}
```

### 2.2 Policy Definition

Policy bertugas murni memverifikasi akses, tanpa melakukan operasi database yang berat jika memungkinkan.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Article\Policies;

use App\Domain\User\Models\User;
use App\Domain\Article\Models\Article;
use App\Domain\Security\Enums\Permission;
use Illuminate\Auth\Access\HandlesAuthorization;
use Illuminate\Auth\Access\Response;

final class ArticlePolicy
{
    use HandlesAuthorization;

    public function viewAny(User $user): Response
    {
        return $user->hasPermissionTo(Permission::VIEW_ARTICLES->value)
            ? Response::allow()
            : Response::deny('Anda tidak memiliki izin untuk melihat daftar artikel.');
    }

    public function view(User $user, Article $article): Response
    {
        // Pembuat artikel selalu bisa melihat artikelnya sendiri.
        // Jika bukan pembuat, periksa permission global.
        if ($user->id === $article->user_id) {
            return Response::allow();
        }
        
        return $user->hasPermissionTo(Permission::VIEW_ARTICLES->value)
            ? Response::allow()
            : Response::deny('Anda tidak diizinkan melihat artikel ini.');
    }

    public function update(User $user, Article $article): Response
    {
        // Hanya pembuat artikel atau admin dengan hak akses khusus yang bisa mengedit.
        if ($user->id === $article->user_id) {
            return Response::allow();
        }

        return $user->hasPermissionTo(Permission::UPDATE_ARTICLES->value)
            ? Response::allow()
            : Response::deny('Anda tidak diizinkan mengubah artikel ini.');
    }
}
```

### 2.3 FormRequest untuk Validasi dan Otorisasi Awal

Langkah pertama menangkal akses ilegal adalah fungsi `authorize` pada `FormRequest`. Ini menahan serangan sebelum data diproses.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Article;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Support\Facades\Gate;
use App\Domain\Article\Models\Article;

final class UpdateArticleRequest extends FormRequest
{
    public function authorize(): bool
    {
        /** @var Article $article */
        $article = $this->route('article');
        
        // Meneruskan request ke fungsi update di ArticlePolicy
        return Gate::allows('update', $article);
    }

    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'title' => ['required', 'string', 'max:255'],
            'content' => ['required', 'string'],
        ];
    }
}
```

### 2.4 Controller sebagai Dispatcher

Controller tidak boleh mengandung logika otorisasi yang rumit. Ia hanya menerima validasi, meneruskan ke Action, dan mengembalikan Response.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Article\UpdateArticleRequest;
use App\Domain\Article\Models\Article;
use App\Domain\Article\Actions\UpdateArticleAction;
use Illuminate\Http\JsonResponse;

final class ArticleController extends Controller
{
    public function __construct(
        private readonly UpdateArticleAction $updateArticleAction
    ) {}

    public function update(UpdateArticleRequest $request, Article $article): JsonResponse
    {
        // Otorisasi sudah dilakukan secara transparan di UpdateArticleRequest
        $updatedArticle = $this->updateArticleAction->execute(
            article: $article,
            title: $request->validated('title'),
            content: $request->validated('content')
        );

        return response()->json([
            'message' => 'Artikel berhasil diperbarui',
            'data' => $updatedArticle,
        ]);
    }
}
```

### 2.5 Action & Repository (Defense in Depth)

Lapisan Action melakukan eksekusi bisnis murni. Namun, untuk menjaga keamanan level-data, Repository bertugas menjamin bahwa data yang dikembalikan memang valid untuk diakses (Data Scoping / Multi-tenancy isolation).

```php
<?php

declare(strict_types=1);

namespace App\Domain\Article\Actions;

use App\Domain\Article\Models\Article;
use App\Domain\Article\Repositories\ArticleRepositoryInterface;

final readonly class UpdateArticleAction
{
    public function __construct(
        private ArticleRepositoryInterface $repository
    ) {}

    public function execute(Article $article, string $title, string $content): Article
    {
        return $this->repository->update($article, [
            'title' => $title,
            'content' => $content,
        ]);
    }
}
```

---

## 3. Anti-Patterns Kritis pada Otorisasi Laravel

Mengimplementasikan otorisasi yang buruk dapat menyebabkan kelemahan *Insecure Direct Object Reference* (IDOR) atau pengungkapan data rahasia. Berikut adalah perbandingan anti-pattern dan best practice.

### 🔴 Anti-Pattern 1: Otorisasi Hardcode di Controller dan Mengabaikan Policy
Pendekatan ini menyebabkan kode yang kotor, sulit di-test, dan aturan otorisasi terpecah-pecah di berbagai tempat, meningkatkan risiko IDOR ketika route baru ditambahkan tanpa pengecekan.

❌ **KODE SALAH (Berbahaya)**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use App\Models\Document;
use Illuminate\Support\Facades\Auth;

class DocumentController extends Controller
{
    public function destroy(Request $request, $id)
    {
        $document = Document::findOrFail($id);
        
        // ❌ BAD: Hardcode role check di controller. 
        // Bagaimana jika kita butuh hak akses lewat permission spesifik?
        // Bagaimana jika admin juga tidak boleh menghapus dokumen terarsip?
        if (Auth::user()->role_id !== 1 && Auth::user()->id !== $document->user_id) {
            abort(403, 'Unauthorized');
        }
        
        $document->delete();
        return redirect('/documents');
    }
}
```

✅ **KODE BENAR (Standard Enterprise)**
Gunakan Policy dan serahkan delegasi melalui FormRequest atau middleware.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Domain\Document\Models\Document;
use App\Http\Requests\Document\DeleteDocumentRequest; // Otorisasi terjadi di sini
use App\Domain\Document\Actions\DeleteDocumentAction;
use Illuminate\Http\RedirectResponse;

final class DocumentController extends Controller
{
    public function destroy(
        DeleteDocumentRequest $request, 
        Document $document, 
        DeleteDocumentAction $action
    ): RedirectResponse {
        // ✅ GOOD: Controller sangat tipis. Policy mengevaluasi kondisi.
        $action->execute($document);
        
        return redirect()->route('documents.index')
            ->with('success', 'Dokumen berhasil dihapus.');
    }
}
```
**Mengapa ini kritis:** Hardcoding `role_id` tidak fleksibel. Jika bisnis berubah dari RBAC menjadi Attribute-Based Access Control (ABAC), Anda harus membongkar ratusan controller. Policy memusatkan logika ini di satu tempat yang mudah di-mock dan diuji.

### 🔴 Anti-Pattern 2: Global Scoping Bypassing via Blind Query
Menyediakan fitur *list/index* tanpa memfilter data berdasarkan konteks otorisasi user (Tenancy/Scoping Leak).

❌ **KODE SALAH (Data Leakage Risk)**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\Invoice;
use Illuminate\Http\Request;

class InvoiceController extends Controller
{
    public function index(Request $request)
    {
        // ❌ BAD: Mengambil semua invoice di database!
        // User A bisa melihat Invoice milik User B jika mereka mencegat API response.
        $invoices = Invoice::all(); 
        
        return view('invoices.index', compact('invoices'));
    }
}
```

✅ **KODE BENAR (Secure Scoping & Repository Pattern)**
Gunakan Repository untuk memaksakan "Tenant Context" atau Scope Eloquent agar database query sudah tersaring di level SQL.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Invoice\Repositories;

use App\Domain\Invoice\Models\Invoice;
use App\Domain\User\Models\User;
use Illuminate\Database\Eloquent\Collection;

final class InvoiceRepository
{
    /**
     * @return Collection<int, Invoice>
     */
    public function getInvoicesForUser(User $user): Collection
    {
        // ✅ GOOD: Bahkan jika sistem otorisasi HTTP tembus, SQL query menolak
        // mengekspos data pengguna lain (Defense in Depth).
        return Invoice::query()
            ->where('user_id', $user->id)
            ->latest()
            ->get();
    }
    
    /**
     * @return Collection<int, Invoice>
     */
    public function getAllInvoices(): Collection
    {
        // Hanya dipanggil oleh Action yang sudah diotorisasi khusus Admin
        return Invoice::latest()->get();
    }
}
```

---

## 4. Pengujian Otomatis Menggunakan Pest v3

Dalam arsitektur *Enterprise*, otorisasi adalah fungsionalitas kritis yang tidak boleh regress saat *refactoring*. Kita menggunakan Pest v3 untuk melakukan *Architecture Testing* (menjamin kepatuhan pattern) dan *Unit/Integration Testing* untuk Policy.

### 4.1 Architecture Testing (Arch Test)

Kita ingin menjamin bahwa semua route terlindungi, dan bahwa *FormRequest* digunakan.

```php
<?php

declare(strict_types=1);

// tests/Arch/SecurityArchTest.php

uses()->group('architecture', 'security');

arch('all controllers must use FormRequests for validation')
    ->expect('App\Http\Controllers')
    ->not->toUse('Illuminate\Http\Request')
    ->ignoring('App\Http\Controllers\Auth');

arch('all form requests must override the authorize method')
    ->expect('App\Http\Requests')
    ->toHaveMethod('authorize');

arch('policies must not execute database queries directly')
    ->expect('App\Domain\*\Policies')
    ->not->toUse('Illuminate\Support\Facades\DB')
    ->not->toUse('App\Domain\*\Repositories');
```

### 4.2 Unit / Integration Testing untuk Policies

Kita wajib mensimulasikan skenario di mana User A tidak dapat mengedit artikel User B, kecuali User A adalah Super Admin atau memiliki permission khusus.

```php
<?php

declare(strict_types=1);

// tests/Feature/Security/ArticlePolicyTest.php

use App\Domain\User\Models\User;
use App\Domain\Article\Models\Article;
use App\Domain\Security\Enums\Permission;
use Illuminate\Support\Facades\Gate;
use Spatie\Permission\Models\Role;

uses(\Illuminate\Foundation\Testing\RefreshDatabase::class)->group('security', 'policies');

beforeEach(function () {
    // Setup roles and permissions in test database
    $this->adminRole = Role::create(['name' => 'Super Admin']);
    $this->editorRole = Role::create(['name' => 'Editor']);
    
    \Spatie\Permission\Models\Permission::create(['name' => Permission::UPDATE_ARTICLES->value]);
    $this->editorRole->givePermissionTo(Permission::UPDATE_ARTICLES->value);
});

it('allows author to update their own article', function () {
    /** @var User $author */
    $author = User::factory()->create();
    
    /** @var Article $article */
    $article = Article::factory()->create([
        'user_id' => $author->id,
    ]);

    expect(Gate::forUser($author)->allows('update', $article))->toBeTrue();
});

it('denies random user from updating anothers article', function () {
    /** @var User $author */
    $author = User::factory()->create();
    
    /** @var User $randomUser */
    $randomUser = User::factory()->create();
    
    /** @var Article $article */
    $article = Article::factory()->create([
        'user_id' => $author->id,
    ]);

    expect(Gate::forUser($randomUser)->allows('update', $article))->toBeFalse();
});

it('allows editor to update anothers article using global permission', function () {
    /** @var User $author */
    $author = User::factory()->create();
    
    /** @var User $editor */
    $editor = User::factory()->create();
    $editor->assignRole('Editor'); // Has Permission::UPDATE_ARTICLES
    
    /** @var Article $article */
    $article = Article::factory()->create([
        'user_id' => $author->id,
    ]);

    expect(Gate::forUser($editor)->allows('update', $article))->toBeTrue();
});

it('allows super admin to update anothers article bypassing explicit permissions', function () {
    /** @var User $author */
    $author = User::factory()->create();
    
    /** @var User $superAdmin */
    $superAdmin = User::factory()->create();
    $superAdmin->assignRole('Super Admin'); 
    // Does not have explicit update permission, but Gate::before interceptor grants it
    
    /** @var Article $article */
    $article = Article::factory()->create([
        'user_id' => $author->id,
    ]);

    expect(Gate::forUser($superAdmin)->allows('update', $article))->toBeTrue();
});
```

### 4.3 Feature Testing API Endpoints

Selalu pastikan otorisasi HTTP merespons dengan benar (`403 Forbidden`).

```php
<?php

declare(strict_types=1);

// tests/Feature/Api/Article/UpdateArticleApiTest.php

use App\Domain\User\Models\User;
use App\Domain\Article\Models\Article;
use Illuminate\Testing\Fluent\AssertableJson;

uses(\Illuminate\Foundation\Testing\RefreshDatabase::class)->group('api', 'articles');

it('returns 403 when unauthorized user tries to update article', function () {
    /** @var User $author */
    $author = User::factory()->create();
    
    /** @var User $hacker */
    $hacker = User::factory()->create();
    
    /** @var Article $article */
    $article = Article::factory()->create([
        'user_id' => $author->id,
        'title' => 'Original Title',
    ]);

    $response = $this->actingAs($hacker)->putJson("/api/articles/{$article->id}", [
        'title' => 'Hacked Title',
        'content' => 'Malicious Content',
    ]);

    // Assert that the request was rejected
    $response->assertStatus(403);
    
    // Assert database was not modified
    $this->assertDatabaseHas('articles', [
        'id' => $article->id,
        'title' => 'Original Title',
    ]);
});

it('returns 200 and updates article when authorized author performs update', function () {
    /** @var User $author */
    $author = User::factory()->create();
    
    /** @var Article $article */
    $article = Article::factory()->create([
        'user_id' => $author->id,
    ]);

    $response = $this->actingAs($author)->putJson("/api/articles/{$article->id}", [
        'title' => 'Updated Title',
        'content' => 'Updated Content',
    ]);

    $response->assertStatus(200)
             ->assertJson(fn (AssertableJson $json) => 
                $json->where('message', 'Artikel berhasil diperbarui')
                     ->has('data')
                     ->etc()
             );
    
    $this->assertDatabaseHas('articles', [
        'id' => $article->id,
        'title' => 'Updated Title',
    ]);
});
```

## Kesimpulan
Sistem Access Control List (ACL) yang baik di Laravel harus bersifat *type-safe* menggunakan Enum, terkonsolidasi dalam *Policies*, dieksekusi secara otomatis oleh *FormRequest* pada lapisan presentasi, didukung oleh *Defense in Depth* melalui *Repository scoping*, dan diuji secara ketat menggunakan framework modern seperti Pest v3. Praktik ini menjamin keamanan *Enterprise-grade* yang tahan terhadap regresi dan eksploitasi otorisasi.
