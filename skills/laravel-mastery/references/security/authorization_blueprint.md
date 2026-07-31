# Blueprint: Advanced Authorization & Role-Based Access Control (RBAC) di Laravel 11+

## 1. Pendahuluan

Otorisasi adalah mekanisme fundamental dalam aplikasi web modern untuk memastikan bahwa pengguna yang telah diautentikasi (authenticated) hanya memiliki akses ke sumber daya dan aksi yang memang diizinkan untuk mereka. Dalam ekosistem Laravel 11+, mekanisme otorisasi dibangun di atas komponen `Gate` dan `Policy`. Blueprint ini menguraikan standar implementasi otorisasi tingkat lanjut (Top 1% Engineering) menggunakan pendekatan Clean Architecture. 

Fokus utama dari dokumen ini adalah memastikan kejelasan pemisahan tanggung jawab, pencegahan celah keamanan serius seperti Insecure Direct Object References (IDOR), Escalation of Privilege, serta penerapan arsitektur perangkat lunak yang tangguh, terukur, dan mudah dipelihara. Seluruh contoh kode ditulis menggunakan standar PHP 8.4 dan Laravel 11+, mengutamakan tipe data yang kuat (strong typing), penggunaan `declare(strict_types=1);`, serta implementasi prinsip desain SOLID.

## 2. Arsitektur Otorisasi Clean Architecture

Pada aplikasi berskala besar, menyematkan logika otorisasi di dalam Controller secara langsung adalah praktik yang amat buruk karena memicu duplikasi kode yang parah dan melanggar prinsip Single Responsibility. Sebaliknya, pendekatan Clean Architecture mengadopsi alur kendali yang terpisah:

`Routing -> Middleware -> FormRequest (Initial AuthZ) -> Controller -> Action/Service (Domain AuthZ) -> Repository (Data Access) -> Model`

Otorisasi akan dilakukan pada tiga lapis pelindung utama:
1. **Middleware & Route Definition:** Untuk membatasi akses pada tingkat rute, menggunakan nama fungsi atau definisi akses dasar (seperti memastikan pengguna terautentikasi dan terverifikasi).
2. **Form Request:** Untuk otorisasi tahap awal sebelum payload data HTTP divalidasi. Ini bertindak sebagai pintu gerbang (gateway) masuk.
3. **Policy:** Didaftarkan dan dipanggil secara eksplisit baik dari Form Request, Controller, maupun Action Service untuk validasi akses tingkat entitas domain (record-level authorization).

### 2.1. Implementasi Model (Domain Entities)

Model harus murni sebagai representasi tabel dan relasi ORM (Object-Relational Mapping). DILARANG meletakkan logika HTTP, pembacaan session Auth, atau rule authorisasi kompleks di dalam Model. Kita juga menggunakan trait `HasUuids` bawaan Laravel untuk mencegah enumerasi ID (serangan dasar IDOR).

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

final class User extends Authenticatable
{
    use HasFactory, HasUuids;

    /** @var array<int, string> */
    protected $fillable = [
        'name',
        'email',
        'password',
        'is_admin',
    ];

    /** @var array<string, string> */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'is_admin' => 'boolean',
        ];
    }

    /**
     * @return HasMany<Document, $this>
     */
    public function documents(): HasMany
    {
        return $this->hasMany(Document::class);
    }

    /**
     * @return BelongsToMany<Role, $this>
     */
    public function roles(): BelongsToMany
    {
        return $this->belongsToMany(Role::class);
    }

    /**
     * Memeriksa apakah pengguna memiliki permission spesifik
     */
    public function hasPermission(string $permissionName): bool
    {
        if ($this->is_admin) {
            return true;
        }

        return $this->roles()->whereHas('permissions', function ($query) use ($permissionName) {
            $query->where('name', $permissionName);
        })->exists();
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

final class Document extends Model
{
    use HasUuids;

    /** @var array<int, string> */
    protected $fillable = [
        'user_id',
        'title',
        'content',
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

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

final class Role extends Model
{
    use HasUuids;

    protected $fillable = ['name', 'slug'];

    /**
     * @return BelongsToMany<Permission, $this>
     */
    public function permissions(): BelongsToMany
    {
        return $this->belongsToMany(Permission::class);
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;

final class Permission extends Model
{
    use HasUuids;

    protected $fillable = ['name', 'description'];
}
```

### 2.2. Registrasi Gate Global (AppServiceProvider)

Terkadang kita butuh pengecekan otorisasi yang tidak terikat pada satu Model tertentu, misalnya akses melihat dashboard. Ini didefinisikan menggunakan `Gate`. Pada Laravel 11+, hal ini biasa dilakukan dalam metode `boot()` di `App\Providers\AppServiceProvider`.

```php
<?php

declare(strict_types=1);

namespace App\Providers;

use App\Models\User;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\ServiceProvider;

final class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // ...
    }

    public function boot(): void
    {
        // Global interception, SuperAdmin bypass for all policies/gates
        Gate::before(function (User $user, string $ability) {
            if ($user->is_admin) {
                return true;
            }
            return null; // Jatuh ke default policy checks jika bukan admin
        });

        // Independent Gates
        Gate::define('view-financial-dashboard', function (User $user) {
            return $user->hasPermission('view_finance_reports');
        });
    }
}
```

### 2.3. Implementasi Policy

Policy menangani seluruh logika bisnis otorisasi untuk satu jenis entitas (Model). Di Laravel 11+, Policy ditemukan secara otomatis asalkan mematuhi konvensi penamaan standar. Semua metode policy mengembalikan instance `\Illuminate\Auth\Access\Response` untuk memberikan pesan penolakan yang informatif.

```php
<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Document;
use App\Models\User;
use Illuminate\Auth\Access\Response;

final class DocumentPolicy
{
    public function viewAny(User $user): Response
    {
        return $user->hasPermission('view_documents')
            ? Response::allow()
            : Response::denyAsNotFound('Dokumen tidak ditemukan atau Anda tidak memiliki akses.');
    }

    public function view(User $user, Document $document): Response
    {
        if ($user->hasPermission('view_all_documents')) {
            return Response::allow();
        }

        // Response::denyAsNotFound mengaburkan fakta apakah ID tersebut ada atau tidak
        // Ini adalah praktik standar untuk mencegah attacker menebak ID yang valid (Information Disclosure)
        return $user->id === $document->user_id
            ? Response::allow()
            : Response::denyAsNotFound('Dokumen tidak ditemukan.');
    }

    public function create(User $user): Response
    {
        return $user->hasPermission('create_documents')
            ? Response::allow()
            : Response::deny('Anda tidak memiliki izin untuk membuat dokumen.');
    }

    public function update(User $user, Document $document): Response
    {
        if ($document->status === 'archived') {
            return Response::deny('Dokumen yang diarsipkan (archived) sudah terkunci dan tidak dapat diubah.');
        }

        return $user->id === $document->user_id
            ? Response::allow()
            : Response::deny('Hanya pemilik dokumen yang dapat melakukan pembaruan informasi.');
    }

    public function delete(User $user, Document $document): Response
    {
        if ($user->hasPermission('delete_any_document')) {
            return Response::allow();
        }

        return $user->id === $document->user_id
            ? Response::allow()
            : Response::deny('Hanya pemilik dokumen yang memiliki izin untuk menghapus rekaman ini.');
    }
}
```

### 2.4. Implementasi Form Request

Form Request adalah benteng perlindungan pertama dari masukan pengguna (user input). Method `authorize()` mutlak digunakan untuk mengeksekusi gate atau policy, memastikan pengguna berhak sebelum sistem membuang sumber daya komputasi untuk memvalidasi masukan.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Document;

use App\Models\Document;
use Illuminate\Foundation\Http\FormRequest;

final class UpdateDocumentRequest extends FormRequest
{
    public function authorize(): bool
    {
        /** @var Document|null $document */
        $document = $this->route('document');
        
        if (! $document instanceof Document) {
            return false;
        }
        
        // Memanfaatkan kemampuan gate authorization terintegrasi pada FormRequest
        return $this->user()?->can('update', $document) ?? false;
    }

    /**
     * @return array<string, array<int, \Illuminate\Contracts\Validation\ValidationRule|string>>
     */
    public function rules(): array
    {
        return [
            'title' => ['required', 'string', 'max:255'],
            'content' => ['required', 'string'],
            'status' => ['required', 'string', 'in:draft,published'],
        ];
    }
}
```

### 2.5. Implementasi Repository dan Action (Clean Architecture)

**Repository Interface & Implementation**
Tanggung jawab akses ke basis data dipisahkan. Repository tidak tahu menahu mengenai current HTTP User Request.

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Contracts;

use App\Models\Document;
use Illuminate\Support\Collection;

interface DocumentRepositoryInterface
{
    /**
     * @return Collection<int, Document>
     */
    public function getAllForUser(string $userId): Collection;
    
    public function findById(string $id): ?Document;
    
    /**
     * @param array<string, mixed> $data
     */
    public function update(Document $document, array $data): bool;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use App\Models\Document;
use App\Repositories\Contracts\DocumentRepositoryInterface;
use Illuminate\Support\Collection;

final class DocumentRepository implements DocumentRepositoryInterface
{
    public function getAllForUser(string $userId): Collection
    {
        return Document::query()
            ->where('user_id', $userId)
            ->latest()
            ->get();
    }

    public function findById(string $id): ?Document
    {
        return Document::query()->find($id);
    }

    public function update(Document $document, array $data): bool
    {
        return $document->update($data);
    }
}
```

**Action Class**
Action mengeksekusi logika bisnis inti (use-cases). Pengecekan authorization tambahan yang rumit (contoh: status dari service eksternal) bisa diletakkan di sini jika diperlukan.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Document;

use App\Models\Document;
use App\Repositories\Contracts\DocumentRepositoryInterface;
use Illuminate\Support\Facades\Log;

final readonly class UpdateDocumentAction
{
    public function __construct(
        private DocumentRepositoryInterface $documentRepository
    ) {}

    /**
     * @param array<string, mixed> $data
     */
    public function execute(Document $document, array $data): Document
    {
        $this->documentRepository->update($document, $data);
        
        Log::info('Document successfully updated via Action', [
            'document_id' => $document->id,
            'changes_made' => array_keys($data)
        ]);
        
        return $document->refresh();
    }
}
```

### 2.6. Implementasi Controller

Sesuai Clean Architecture, Controller dipangkas habis dan menjadi jembatan murni (Thin Controller). Semua urusan otentikasi, otorisasi, dan validasi diselesaikan sebelum controller tereksekusi.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Actions\Document\UpdateDocumentAction;
use App\Http\Controllers\Controller;
use App\Http\Requests\Document\UpdateDocumentRequest;
use App\Models\Document;
use Illuminate\Http\JsonResponse;

final class DocumentController extends Controller
{
    public function update(
        UpdateDocumentRequest $request, 
        Document $document, 
        UpdateDocumentAction $action
    ): JsonResponse {
        // PERHATIAN: Di titik ini request sudah dijamin diautentikasi, diotorisasi, dan divalidasi.
        
        $updatedDocument = $action->execute(
            $document, 
            $request->validated()
        );

        return response()->json([
            'message' => 'Document successfully updated.',
            'data' => [
                'id' => $updatedDocument->id,
                'title' => $updatedDocument->title,
                'status' => $updatedDocument->status,
                'updated_at' => $updatedDocument->updated_at->toISOString(),
            ],
        ]);
    }
}
```

## 3. Anti-Patterns dalam Otorisasi (Hal-hal yang Wajib Dihindari)

Pengembangan perangkat lunak sering diracuni oleh pola-pola salah kaprah (Anti-Patterns). Berikut ini adalah beberapa kesalahan fatal yang paling sering ditemui dalam proyek Laravel, disertai dampaknya pada keamanan dan performa (Memory/Security Risk).

### Anti-Pattern 1: Hardcoding Roles & Logika Otorisasi di Controller (The God Controller)

❌ **KODE SALAH (Sangat Membahayakan Keamanan dan Maintainability)**
```php
<?php

namespace App\Http\Controllers;

use App\Models\Document;
use Illuminate\Http\Request;

class BadDocumentController extends Controller
{
    public function update(Request $request, $id)
    {
        $document = Document::find($id);
        
        if (!$document) {
            abort(404);
        }

        // ❌ Anti-pattern: Hardcode pengecekan role secara eksplisit di Controller
        if (auth()->user()->role_id !== 1 && auth()->user()->id !== $document->user_id) {
            abort(403, 'Unauthorized action.');
        }
        
        // ❌ Anti-pattern: Logika bisnis dan otorisasi tercampur dengan status entitas
        if ($document->status === 'archived' && auth()->user()->role_id !== 1) {
             abort(403, 'Cannot edit archived document');
        }

        // ❌ Anti-pattern Mass Assignment Bypass: tidak ada validasi request terstruktur!
        $document->update($request->all());

        return response()->json($document);
    }
}
```
**Mengapa Berbahaya:**
- **Security Risk:** Ini membuka celah **Mass Assignment**. Penyerang dapat mengirim atribut krusial seperti `user_id` atau `is_admin` di payload JSON dan secara tidak sengaja ter-update. Selain itu, hardcode nilai boolean/integer ID untuk otorisasi berisiko jika endpoint baru dibuat dan developer lupa meng-copy-paste logika pengecekan yang sama.
- **Maintenance Risk:** Jika manajemen meminta perombakan role (contoh: menambah role "Manager" dengan hak serupa), developer harus membongkar puluhan file Controller dan memperbaiki klausa `IF` di semua tempat secara manual, meningkatkan persentase potensi bug.

✅ **KODE BENAR (Policy Driven & Form Request)**
Semua terbungkus dengan rapi di dalam Policy. Controller sama sekali tidak peduli siapa yang mengaksesnya selama Form Request meloloskan.
```php
<?php

// Di dalam App\Policies\DocumentPolicy
public function update(User $user, Document $document): Response
{
    if ($document->status === 'archived') {
        return Response::deny('Archived documents are immutable.');
    }
    
    // Admin secara otomatis lulus dari Gate::before()
    return $user->id === $document->user_id
        ? Response::allow()
        : Response::deny('Anda bukan pemilik dokumen ini.');
}

// Di dalam App\Http\Requests\Document\UpdateDocumentRequest
public function authorize(): bool
{
    return $this->user()->can('update', $this->route('document'));
}
```

### Anti-Pattern 2: Global Scope Berbasis Auth Session yang Diikat ke Model

❌ **KODE SALAH (Risiko Memory Leak dan Context Bleeding)**
```php
<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;

class BadDocument extends Model
{
    protected static function booted()
    {
        parent::booted();
        
        // ❌ Anti-pattern: Memaksakan otorisasi tingkat query dengan mengandalkan global facade HTTP/Session
        static::addGlobalScope('authorized_owner', function (Builder $builder) {
            if (auth()->check() && !auth()->user()->is_admin) {
                $builder->where('user_id', auth()->id());
            }
        });
    }
}
```
**Mengapa Berbahaya:**
- **Architecture & Lifecycle Risk:** Model Eloquent murni tidak boleh bergantungan pada lingkungan Web/HTTP (Auth Session). Saat Model diinstansiasi dari proses CLI (`php artisan`), Cron Scheduler, atau di dalam Background Queue Worker, nilai `auth()->check()` akan mengembalikan `false` atau exception karena tidak ada HTTP Session yang berjalan!
- Akibat paling fatal: Background job yang sebetulnya butuh memproses seluruh data dokumen (untuk report bulanan misalnya) malah akan gagal, atau lebih buruk lagi: memberikan hasil kosong yang diam-diam salah (Silent Failure).

✅ **KODE BENAR (Pemisahan Melalui Repository dan Context Passing)**
Gunakan parameter pada layer Repository. Biarkan pemanggil (Action atau Service) yang memberikan konteks kepemilikan tersebut.
```php
<?php

namespace App\Repositories\Eloquent;

use App\Models\Document;
use App\Repositories\Contracts\DocumentRepositoryInterface;
use Illuminate\Database\Eloquent\Collection;

final class DocumentRepository implements DocumentRepositoryInterface
{
    public function getDocumentsForUser(string $userId, bool $isAdmin = false): Collection
    {
        $query = Document::query();
        
        // Otorisasi injeksi dinamis berdasarkan parameter, bukan State Global HTTP
        if (! $isAdmin) {
            $query->where('user_id', $userId);
        }
        
        return $query->get();
    }
}
```

## 4. Testing Komprehensif (Pest v3)

Tidak ada jaminan arsitektur berjalan tanpa adanya pengujian (testing) otomatis. Menggunakan ekosistem Pest v3 di Laravel 11, pengujian dibagi menjadi dua segmen utama: Unit/Integration Testing (menjamin implementasi Policy) dan Architecture Testing (menjamin arsitek mentaati batasan Clean Architecture).

### 4.1. Unit & Integration Test

Pest v3 memungkinkan syntax yang luwes (fluent) tanpa harus menulis kelas PHP panjang. Kita akan memverifikasi fungsi Policy secara ketat.

```php
<?php

declare(strict_types=1);

use App\Models\Document;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Gate;

uses(RefreshDatabase::class);

describe('Document Policy Integrations', function () {
    
    it('allows the authentic owner to successfully update their active document', function () {
        /** @var User $owner */
        $owner = User::factory()->create(['is_admin' => false]);
        
        /** @var Document $document */
        $document = Document::factory()->create([
            'user_id' => $owner->id,
            'status' => 'draft',
        ]);
        
        $response = $this->actingAs($owner)
                         ->putJson("/api/documents/{$document->id}", [
                             'title' => 'Updated Secure Title',
                             'content' => 'Secure content modification',
                             'status' => 'draft',
                         ]);
                         
        $response->assertStatus(200)
                 ->assertJsonPath('data.title', 'Updated Secure Title');
                 
        $this->assertDatabaseHas('documents', [
            'id' => $document->id,
            'title' => 'Updated Secure Title'
        ]);
    });
    
    it('categorically denies a user from updating documents owned by others (IDOR Prevention)', function () {
        /** @var User $owner */
        $owner = User::factory()->create();
        
        /** @var User $attacker */
        $attacker = User::factory()->create(['is_admin' => false]);
        
        /** @var Document $document */
        $document = Document::factory()->create([
            'user_id' => $owner->id,
            'status' => 'draft',
        ]);
        
        $response = $this->actingAs($attacker)
                         ->putJson("/api/documents/{$document->id}", [
                             'title' => 'Malicious Modification',
                             'content' => 'Injecting payload',
                             'status' => 'published',
                         ]);
                         
        $response->assertStatus(403);
        
        $this->assertDatabaseMissing('documents', [
            'title' => 'Malicious Modification'
        ]);
    });

    it('denies the authentic owner from updating an already archived document', function () {
        /** @var User $owner */
        $owner = User::factory()->create(['is_admin' => false]);
        
        /** @var Document $document */
        $document = Document::factory()->create([
            'user_id' => $owner->id,
            'status' => 'archived',
        ]);
        
        $response = $this->actingAs($owner)
                         ->putJson("/api/documents/{$document->id}", [
                             'title' => 'Sneaky Update Attempt',
                             'content' => 'Trying to modify locked state',
                             'status' => 'draft',
                         ]);
                         
        $response->assertStatus(403)
                 ->assertJsonPath('message', 'Archived documents are immutable.');
    });
});
```

### 4.2. Architecture Test (Pengawalan Kode)

Mencegah Anti-Patterns dapat dilakukan dengan menguji kode dan struktur folder itu sendiri. Pest memiliki engine arsitektural bawaan yang sangat hebat, mencegah developer junior memasukkan kode sampah atau melakukan pelanggaran prinsip.

```php
<?php

declare(strict_types=1);

test('controllers must not contain any business or authorization logic direct calls')
    ->expect('App\Http\Controllers')
    ->not->toUse('Illuminate\Support\Facades\Gate')
    ->and('App\Http\Controllers')->not->toUse('Illuminate\Support\Facades\Auth');

test('all form requests must securely override authorize method')
    ->expect('App\Http\Requests')
    ->toHaveMethod('authorize');

test('models must be pure and not depend on volatile HTTP states')
    ->expect('App\Models')
    ->not->toUse('Illuminate\Http\Request')
    ->and('App\Models')->not->toUse('Illuminate\Support\Facades\Auth')
    ->and('App\Models')->not->toUse('Illuminate\Support\Facades\Session');

test('actions must be structurally sealed and strictly typed')
    ->expect('App\Actions')
    ->toBeFinal()
    ->and('App\Actions')->toUseStrictTypes()
    ->and('App\Actions')->toHaveConstructor();
    
test('policies must be sealed from inheritance to prevent bypass')
    ->expect('App\Policies')
    ->toBeFinal()
    ->and('App\Policies')->toUseStrictTypes();
    
test('no debugging statements allowed in production directories')
    ->expect(['App', 'routes'])
    ->not->toUse(['dd', 'dump', 'var_dump', 'ray']);
```

## 5. Kesimpulan

Menerapkan otorisasi tingkat atas (Top 1% Engineering Standard) dalam framework Laravel tidak sekadar memanggil metode proteksi. Hal ini menuntut perancangan disiplin serta alur data yang ketat.  
Dengan menggunakan kombinasi dari **Form Requests** untuk penyaringan (filtering) gerbang awal dan **Policy** sebagai sistem keputusan akhir akses data, sistem kita menjamin pemisahan kekhawatiran (separation of concerns).

Sementara itu, memindahkan logika data fetching ke lapis **Repository** dan eksekusi use-cases ke lapis **Service/Action Class** membebaskan Model dari ketergantungan konteks dan menjaga kebersihan Controller.

Implementasi yang mengadopsi standar PHP 8.4, Laravel 11+, Strict Types, serta dukungan Quality Assurance dari arsitektural Pest v3, menjamin ekosistem aplikasi memiliki skalabilitas nyaris tanpa batas, pengujian yang transparan, isolasi kesalahan yang efektif, dan jaminan keamanan spesifikasi Enterprise-grade di mana celah konvensional seperti Mass Assignment dan IDOR sepenuhnya terbasmi.
