# Laravel Database Query Optimization Deep Dive (PHP 8.3/8.4 & Laravel 11/12)

Dalam aplikasi enterprise, performa database seringkali menjadi bottleneck utama. Penggunaan Eloquent ORM di Laravel, meskipun sangat developer-friendly, bisa menjadi pedang bermata dua jika tidak dipahami di balik layarnya. Panduan ini akan memberikan penjelasan mendalam, strategi mitigasi, dan implementasi arsitektur bersih untuk optimalisasi query database di ekosistem Laravel modern (versi 11 dan 12) dengan PHP 8.3 ke atas.

Setiap kode yang ditulis dalam panduan ini mengasumsikan standar _strict typing_ (`declare(strict_types=1);`) dan mengikuti kaidah _Clean Architecture_ untuk memisahkan domain logik dari framework logik.

---

## 1. Pemahaman Dasar Kinerja Eloquent

Eloquent mengubah interaksi database dari raw SQL menjadi manipulasi objek yang mudah dipahami. Namun, proses ini (hydration) memakan waktu dan memori. Mengambil 10,000 baris data melalui Eloquent akan menghasilkan 10,000 instance object PHP.

### Hydration Cost
Hydration adalah proses mengubah baris data dari database menjadi model Eloquent. Semakin banyak baris yang diambil, semakin lambat aplikasi Anda. Jika Anda hanya membutuhkan format array sederhana (misal, untuk respons JSON API langsung tanpa manipulasi), menggunakan Query Builder seringkali lebih cepat secara eksponensial.

---

## 2. Anti-Pattern: N+1 Query Problem

Masalah N+1 adalah pembunuh kinerja yang paling umum dalam ORM. Masalah ini terjadi ketika Anda melakukan iterasi pada koleksi model dan memanggil relasinya tanpa melakukan _eager loading_.

### ❌ Anti-Pattern 1: KODE SALAH (N+1 Query)

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Routing\Controller;

final class UserController extends Controller
{
    public function index(): JsonResponse
    {
        // ❌ Mengambil semua user (1 query)
        $users = User::all();
        $response = [];

        foreach ($users as $user) {
            // ❌ Jika ada 1000 user, baris ini memicu 1000 query tambahan! (N queries)
            // Total query: 1 + 1000 = 1001 queries
            $response[] = [
                'id' => $user->id,
                'name' => $user->name,
                'company_name' => $user->company->name,
                'latest_post_title' => $user->posts()->latest()->first()?->title,
            ];
        }

        return response()->json(['data' => $response]);
    }
}
```

**Penjelasan Masalah:**
Kode di atas akan membunuh database jika jumlah data besar. `User::all()` memuat semua user, kemudian di dalam loop, relasi `company` dan relasi `posts` dipanggil, memicu ratusan hingga ribuan query individual.

### ✅ KODE BENAR (Eager Loading & Clean Architecture)

Kita akan memperbaiki ini dengan menerapkan Clean Architecture: Controller memanggil Action, Action memanggil Repository. Kita juga menggunakan `with()` untuk _eager loading_.

**1. Data Transfer Object / Request Model**

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class UserIndexRequest extends FormRequest
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
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ];
    }
}
```

**2. Repository Interface & Implementation**

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Contracts;

use Illuminate\Contracts\Pagination\LengthAwarePaginator;

interface UserRepositoryInterface
{
    public function getPaginatedWithRelations(int $perPage): LengthAwarePaginator;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use App\Models\User;
use App\Repositories\Contracts\UserRepositoryInterface;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;

final readonly class EloquentUserRepository implements UserRepositoryInterface
{
    public function getPaginatedWithRelations(int $perPage = 15): LengthAwarePaginator
    {
        // ✅ Eager load relasi dengan array untuk relasi berlapis
        // ✅ Hanya men-select kolom yang dibutuhkan pada relasi
        return User::query()
            ->select(['id', 'name', 'company_id'])
            ->with([
                'company:id,name', // ✅ Select kolom spesifik di relasi
                'latestPost:id,user_id,title', // ✅ Menggunakan hasOne relasi untuk latest post, BUKAN query di dalam loop
            ])
            ->paginate($perPage);
    }
}
```

**Catatan pada Model User:**
Untuk mengoptimalkan `latest_post`, kita menggunakan relasi `hasOne` alih-alih `hasMany` untuk mencegah memuat semua post.

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasOne;

final class User extends Model
{
    public function company(): BelongsTo
    {
        return $this->belongsTo(Company::class);
    }

    public function latestPost(): HasOne
    {
        return $this->hasOne(Post::class)->latestOfMany();
    }
}
```

**3. Action / Service Class**

```php
<?php

declare(strict_types=1);

namespace App\Actions\User;

use App\Repositories\Contracts\UserRepositoryInterface;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;

final readonly class GetPaginatedUsersAction
{
    public function __construct(
        private UserRepositoryInterface $userRepository
    ) {}

    public function execute(int $perPage): LengthAwarePaginator
    {
        return $this->userRepository->getPaginatedWithRelations($perPage);
    }
}
```

**4. Controller**

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Actions\User\GetPaginatedUsersAction;
use App\Http\Requests\UserIndexRequest;
use Illuminate\Http\JsonResponse;
use Illuminate\Routing\Controller;

final class UserController extends Controller
{
    public function index(UserIndexRequest $request, GetPaginatedUsersAction $action): JsonResponse
    {
        $perPage = (int) $request->validated('per_page', 15);
        
        $users = $action->execute($perPage);

        // ✅ Pemetaan Data secara efisien. Query tetap konstan (maksimal 3 query) berapapun jumlah datanya.
        $transformed = $users->through(static fn (object $user): array => [
            'id' => $user->id,
            'name' => $user->name,
            'company_name' => $user->company?->name,
            'latest_post_title' => $user->latestPost?->title,
        ]);

        return response()->json($transformed);
    }
}
```

---

## 3. Anti-Pattern: Memory Exhaustion dengan Chunking yang Salah

Ketika memproses jutaan baris (misalnya untuk pembuatan laporan, ekspor data, atau pembaruan batch), pengembang sering menggunakan memory secara ceroboh.

### ❌ Anti-Pattern 2: KODE SALAH (Memory Exhaustion & Update N+1)

```php
<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\Invoice;
use Illuminate\Console\Command;

final class ProcessInvoicesCommand extends Command
{
    protected $signature = 'invoices:process';
    
    public function handle(): void
    {
        // ❌ Memuat JUTAAN record ke dalam RAM sekaligus! Akan memicu Out of Memory (OOM).
        $invoices = Invoice::where('status', 'pending')->get();

        foreach ($invoices as $invoice) {
            // ❌ Update dipanggil N kali! Sangat memberatkan koneksi database.
            $invoice->update(['status' => 'processing']);
            
            // Proses logika berat...
            $this->processLogic($invoice);
        }
    }

    private function processLogic(Invoice $invoice): void
    {
        // Simulasi logika bisnis
        sleep(1);
    }
}
```

**Penjelasan Masalah:**
`get()` pada data berjumlah besar adalah bunuh diri. Menggunakan `foreach` untuk menyimpan data kembali memicu ratusan ribu update statemen terpisah.

### ✅ KODE BENAR (Lazy Collections / Cursors & Batch Updates)

Untuk membaca tanpa OOM, gunakan `cursor()` atau `lazy()`. Untuk update, gunakan `toBase()->update()` atau mass updates. Namun, jika Anda harus memproses setiap item karena ada integrasi API eksternal, gunakan `chunkById()` untuk stabilitas.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Invoice;

use App\Models\Invoice;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

final class ProcessPendingInvoicesAction
{
    public function execute(): int
    {
        $processedCount = 0;

        // ✅ Menggunakan chunkById untuk kestabilan memori. 
        // Menggunakan id memastikan jika record di-update dan tidak lagi 'pending', 
        // pagination chunking tidak akan meleset/skip.
        Invoice::query()
            ->where('status', 'pending')
            ->select(['id', 'amount', 'reference_code']) // 🚀 Hanya ambil kolom penting
            ->chunkById(500, function (Collection $invoices) use (&$processedCount): void {
                
                $invoiceIds = $invoices->pluck('id')->toArray();
                
                // ✅ UPDATE BATCH SECARA LANGSUNG, HANYA 1 QUERY PER CHUNK!
                Invoice::query()
                    ->whereIn('id', $invoiceIds)
                    ->update(['status' => 'processing']);

                foreach ($invoices as $invoice) {
                    try {
                        $this->sendToExternalApi($invoice);
                        $processedCount++;
                    } catch (\Throwable $e) {
                        Log::error("Gagal memproses invoice: {$invoice->id}", ['exception' => $e]);
                    }
                }
                
                // ✅ Update Batch lagi jika berhasil
                Invoice::query()
                    ->whereIn('id', $invoiceIds)
                    ->update(['status' => 'completed']);
            });

        return $processedCount;
    }

    private function sendToExternalApi(Invoice $invoice): void
    {
        // Simulasi panggilan HTTP berat
    }
}
```

---

## 4. Penggunaan Indeks & Migrasi Berkinerja Tinggi

Optimasi query tidak ada gunanya jika skema database tidak mendukung. Indeks B-Tree memecahkan masalah pemindaian tabel secara penuh (Full Table Scan).

### Composite Indexing

Seringkali kita query lebih dari satu kolom bersamaan. Jika kita punya kondisi `WHERE status = 'active' AND type = 'premium'`, index terpisah pada `status` dan `type` tidak seefisien _composite index_.

```php
<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('subscriptions', static function (Blueprint $table): void {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('status'); // active, expired, cancelled
            $table->string('plan_type'); // basic, premium, pro
            $table->timestamp('expires_at')->nullable();
            $table->timestamps();

            // ✅ Composite Index
            // Urutan SANGAT penting! Kolom dengan cardinality (keunikan) tertinggi 
            // atau kolom yang paling sering digunakan dalam WHERE '=' harus ditaruh di kiri.
            $table->index(['status', 'plan_type', 'expires_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('subscriptions');
    }
};
```

---

## 5. Menghindari `COUNT(*)` pada Dataset Raksasa

Pada tabel dengan jutaan baris (misal InnoDB pada MySQL), menghitung total record dengan `paginate()` atau `count()` sangat melumpuhkan CPU.

Solusi:
1. **Gunakan `simplePaginate()`** alih-alih `paginate()`. Ini hanya menggunakan limit & offset, menghilangkan kalkulasi total data secara penuh.
2. **Gunakan Cursor Pagination** (`cursorPaginate()`). Ini adalah yang tercepat untuk dataset besar, menggunakan pointer ID terakhir daripada `OFFSET` yang melambat secara eksponensial di halaman tinggi (Deep Pagination).

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use App\Models\LogEntry;
use Illuminate\Contracts\Pagination\CursorPaginator;

final readonly class LogEntryRepository
{
    public function getLatestLogs(int $perPage = 50): CursorPaginator
    {
        // 🚀 Cursor pagination menghindari query COUNT(*) dan menghindari perlambatan OFFSET.
        return LogEntry::query()
            ->orderBy('id', 'desc')
            ->cursorPaginate($perPage);
    }
}
```

---

## 6. PEST v3 Testing Komprehensif

Dalam arsitektur modern, kita harus menguji query count dan memory leak. Berikut adalah setup test Pest v3 lengkap untuk memastikan arsitektur yang kita bangun tidak mengalami N+1.

### Setup Architecture Testing

```php
<?php
// tests/Feature/ArchTest.php

declare(strict_types=1);

uses()->group('arch');

it('memastikan model hanya digunakan di Repository, tidak di Controller langsung', function () {
    expect('App\Models')
        ->not->toBeUsedIn('App\Http\Controllers');
});

it('memastikan Controller hanya memanggil Action, Request, atau Resources', function () {
    expect('App\Http\Controllers')
        ->toUse([
            'App\Actions',
            'App\Http\Requests',
            'Illuminate\Http',
            'Illuminate\Routing\Controller'
        ]);
});

it('strict types is declared globally', function () {
    expect('App')->toUseStrictTypes();
});
```

### Setup Feature Testing (Performance & DB Assertion)

```php
<?php
// tests/Feature/UserControllerTest.php

declare(strict_types=1);

use App\Models\Company;
use App\Models\Post;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Pest\Expectation;

uses(RefreshDatabase::class);

it('mengembalikan daftar pengguna tanpa memicu N+1 query problem', function (): void {
    // 1. Arrange Data
    $companies = Company::factory()->count(5)->create();
    
    foreach ($companies as $company) {
        $users = User::factory()->count(10)->create(['company_id' => $company->id]);
        
        foreach ($users as $user) {
            Post::factory()->count(3)->create(['user_id' => $user->id]);
        }
    }
    
    // Total User = 50. Total Company = 5. Total Post = 150.
    
    // 2. Mocking/Spying DB Queries
    DB::enableQueryLog();
    $initialQueryCount = count(DB::getQueryLog());

    // 3. Act
    $response = $this->getJson('/api/users?per_page=50');

    // 4. Assert Data & Status
    $response->assertOk()
        ->assertJsonStructure([
            'data' => [
                '*' => [
                    'id',
                    'name',
                    'company_name',
                    'latest_post_title',
                ]
            ]
        ])
        ->assertJsonCount(50, 'data');

    // 5. Assert Performance (N+1 Prevented)
    $finalQueryCount = count(DB::getQueryLog());
    $totalQueriesExecuted = $finalQueryCount - $initialQueryCount;

    // Maksimal kita mengharapkan:
    // 1. SELECT users (dengan Limit 50)
    // 2. SELECT companies WHERE id IN (...)
    // 3. SELECT posts WHERE user_id IN (...)
    // 4. SELECT count aggregate (karena lengthAwarePaginator)
    expect($totalQueriesExecuted)
        ->toBeLessThanOrEqual(4, 'Jumlah query melebihi batas. Terindikasi ada kebocoran N+1 query!');
});

it('memvalidasi input pagination', function (): void {
    $response = $this->getJson('/api/users?per_page=99999');
    
    $response->assertUnprocessable()
        ->assertJsonValidationErrors(['per_page']);
});
```

### Setup Unit Testing (Mocking Action/Repository)

Jika kita hanya ingin menguji Controller tanpa memukul database secara nyata, kita bisa melakukan _Fakes/Mocks_.

```php
<?php
// tests/Unit/UserControllerUnitTest.php

declare(strict_types=1);

use App\Actions\User\GetPaginatedUsersAction;
use App\Http\Controllers\Api\UserController;
use Illuminate\Pagination\LengthAwarePaginator;
use Mockery\MockInterface;
use App\Models\User;
use App\Models\Company;

it('controller memetakan paginator menjadi json secara benar', function (): void {
    // Faking the Action
    $mockAction = $this->mock(GetPaginatedUsersAction::class, function (MockInterface $mock): void {
        $user = new User(['id' => 1, 'name' => 'John Doe']);
        $user->setRelation('company', new Company(['name' => 'Acme Corp']));
        
        $paginator = new LengthAwarePaginator([$user], 1, 15, 1);
        
        $mock->shouldReceive('execute')
            ->once()
            ->with(15)
            ->andReturn($paginator);
    });

    // Act
    $response = $this->getJson('/api/users');
    
    // Assert
    $response->assertOk()
        ->assertExactJson([
            'current_page' => 1,
            'data' => [
                [
                    'id' => 1,
                    'name' => 'John Doe',
                    'company_name' => 'Acme Corp',
                    'latest_post_title' => null, // Karena relation latestPost tidak diset mocknya
                ]
            ],
            // ... (pagination attributes)
        ]);
});
```

---

## 7. Kesimpulan dan Checklist Optimasi
1. **Gunakan Eager Loading (`with`)** pada relasi yang dipanggil di dalam iterasi/looping.
2. **Spesifikkan Kolom (`select`)** yang diambil dari database untuk mengurangi konsumsi RAM secara masif.
3. **Gunakan Pagination atau Chunking** untuk perulangan berskala massal. Hindari memori exhausted.
4. **Perhatikan Batch Updates** tinimbang meng-update row demi row dalam iterasi (N+1 Update).
5. **Manfaatkan Indeks Database** secara cermat. Indeks komposit memecahkan problem multi-column search.
6. **Pisahkan Logika Akses (Clean Arch)**. Controller murni bertugas menangani request HTTP, Action untuk eksekusi Use-Case bisnis, Repository mengatur query spesifik Eloquent.
7. **Test Semuanya** menggunakan arch test dan assertions query log dengan PEST.

Menerapkan panduan di atas menjamin aplikasi skala enterprise dengan Laravel dapat menangani ribuan RPM (Request Per Minute) tanpa memberatkan server database.
