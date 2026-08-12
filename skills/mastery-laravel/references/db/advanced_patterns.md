# Advanced Database Patterns in Laravel

Panduan mendalam ini membahas pola-pola tingkat lanjut dalam berinteraksi dengan database menggunakan Laravel Eloquent dan Query Builder. Berfokus pada performa, skalabilitas, keamanan tipe (type-safety) menggunakan PHP 8.3/8.4, Laravel 11/12, serta prinsip Clean Architecture.

## 1. Clean Architecture dalam Database Operations

Dalam aplikasi skala besar, meletakkan logika database di dalam Controller adalah sebuah *anti-pattern*. Kita akan menggunakan pendekatan Clean Architecture dengan alur:
`FormRequest` -> `Controller` -> `Action/Service` -> `Repository` -> `Model`.

### 1.1 Model & Tipe Data Modern
Pastikan menggunakan `declare(strict_types=1);` dan memanfaatkan fitur PHP 8.3+ seperti Readonly classes atau typed properties, dan Laravel 11 Casts.

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\SoftDeletes;

/**
 * @property string $id
 * @property string $user_id
 * @property int $amount
 * @property string $currency
 * @property \App\Enums\TransactionStatus $status
 * @property \Carbon\CarbonImmutable $created_at
 * @property \Carbon\CarbonImmutable $updated_at
 */
final class Transaction extends Model
{
    use HasUuids;
    use SoftDeletes;

    protected $fillable = [
        'user_id',
        'amount',
        'currency',
        'status',
    ];

    protected function casts(): array
    {
        return [
            'amount' => 'integer',
            'status' => \App\Enums\TransactionStatus::class,
            'created_at' => 'immutable_datetime',
            'updated_at' => 'immutable_datetime',
        ];
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
```

### 1.2 Data Transfer Object (DTO)
Gunakan readonly class untuk mentransfer data antar layer, memastikan immutability.

```php
<?php

declare(strict_types=1);

namespace App\DTOs;

use App\Enums\TransactionStatus;

final readonly class CreateTransactionDTO
{
    public function __construct(
        public string $userId,
        public int $amount,
        public string $currency,
        public TransactionStatus $status = TransactionStatus::PENDING,
    ) {}
}
```

### 1.3 Repository Pattern
Repository bertanggung jawab atas abstraksi layer database. Jangan memaparkan query Eloquent di layer service.

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Contracts;

use App\DTOs\CreateTransactionDTO;
use App\Models\Transaction;
use Illuminate\Pagination\LengthAwarePaginator;

interface TransactionRepositoryInterface
{
    public function findById(string $id): ?Transaction;
    public function create(CreateTransactionDTO $dto): Transaction;
    
    /**
     * @return LengthAwarePaginator<Transaction>
     */
    public function getLatestByUserId(string $userId, int $perPage = 15): LengthAwarePaginator;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use App\DTOs\CreateTransactionDTO;
use App\Models\Transaction;
use App\Repositories\Contracts\TransactionRepositoryInterface;
use Illuminate\Pagination\LengthAwarePaginator;
use Illuminate\Support\Facades\DB;

final class TransactionRepository implements TransactionRepositoryInterface
{
    public function findById(string $id): ?Transaction
    {
        return Transaction::find($id);
    }

    public function create(CreateTransactionDTO $dto): Transaction
    {
        return Transaction::create([
            'user_id' => $dto->userId,
            'amount' => $dto->amount,
            'currency' => $dto->currency,
            'status' => $dto->status,
        ]);
    }

    public function getLatestByUserId(string $userId, int $perPage = 15): LengthAwarePaginator
    {
        return Transaction::query()
            ->where('user_id', $userId)
            ->latest('created_at')
            ->paginate($perPage);
    }
}
```

### 1.4 Action / Service Layer
Business logic diletakkan di layer ini. Gunakan Transaction block jika ada beberapa operasi berantai.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Transactions;

use App\DTOs\CreateTransactionDTO;
use App\Models\Transaction;
use App\Repositories\Contracts\TransactionRepositoryInterface;
use Illuminate\Support\Facades\DB;
use Throwable;
use RuntimeException;

final readonly class CreateTransactionAction
{
    public function __construct(
        private TransactionRepositoryInterface $transactionRepository,
    ) {}

    /**
     * @throws RuntimeException
     */
    public function execute(CreateTransactionDTO $dto): Transaction
    {
        try {
            return DB::transaction(function () use ($dto) {
                // Contoh: Mungkin ada logika validasi limit harian di sini
                
                $transaction = $this->transactionRepository->create($dto);
                
                // Trigger event, notify user, etc.
                
                return $transaction;
            }, 3); // 3 retries untuk deadlock
        } catch (Throwable $e) {
            throw new RuntimeException('Gagal membuat transaksi: ' . $e->getMessage(), 0, $e);
        }
    }
}
```

### 1.5 FormRequest & Controller
Validasi tipe yang ketat, kembalikan DTO ke Action.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Transactions;

use Illuminate\Foundation\Http\FormRequest;

final class StoreTransactionRequest extends FormRequest
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
            'amount' => ['required', 'integer', 'min:1000'],
            'currency' => ['required', 'string', 'size:3'],
        ];
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Transactions;

use App\Actions\Transactions\CreateTransactionAction;
use App\DTOs\CreateTransactionDTO;
use App\Http\Controllers\Controller;
use App\Http\Requests\Transactions\StoreTransactionRequest;
use Illuminate\Http\JsonResponse;

final class TransactionController extends Controller
{
    public function store(StoreTransactionRequest $request, CreateTransactionAction $action): JsonResponse
    {
        $dto = new CreateTransactionDTO(
            userId: (string) $request->user()->id,
            amount: (int) $request->validated('amount'),
            currency: (string) $request->validated('currency'),
        );

        $transaction = $action->execute($dto);

        return response()->json([
            'message' => 'Transaksi berhasil dibuat',
            'data' => $transaction,
        ], 201);
    }
}
```

## 2. Anti-Patterns dalam Database Operations

### 2.1 The N+1 Query Problem

N+1 query terjadi ketika kita mengambil sebuah koleksi entitas dan kemudian melakukan iterasi untuk mendapatkan relasi masing-masing entitas tersebut tanpa melakukan *eager loading*.

❌ **KODE SALAH (N+1 Problem):**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Models\Post;
use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;

final class PostController extends Controller
{
    public function index(): JsonResponse
    {
        $posts = Post::all(); // 1 query

        $data = [];
        foreach ($posts as $post) {
            // N queries (Satu query untuk setiap iterasi)
            $data[] = [
                'title' => $post->title,
                'author_name' => $post->author->name, 
            ];
        }

        return response()->json($data);
    }
}
```
**Penjelasan Kesalahan:**
Jika tabel `posts` memiliki 1000 baris, kode di atas akan mengeksekusi 1 query untuk mengambil post, dan 1000 query terpisah untuk mengambil author dari masing-masing post. Ini sangat lambat dan membebani database (1001 query total).

✅ **KODE BENAR (Eager Loading):**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Models\Post;
use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;

final class PostController extends Controller
{
    public function index(): JsonResponse
    {
        // Eager load relasi 'author', hanya membutuhkan 2 query
        $posts = Post::with('author:id,name')->get(); 

        $data = $posts->map(fn (Post $post) => [
            'title' => $post->title,
            'author_name' => $post->author->name,
        ]);

        return response()->json($data);
    }
}
```
**Penjelasan Solusi:**
Menggunakan `with('author')` memberitahu Eloquent untuk mengekstrak ID author dari semua post yang diambil, dan melakukan 1 *single query* (menggunakan `WHERE IN`) untuk mengambil semua author secara langsung. Selain itu, menambahkan `:id,name` pada eager loading merupakan praktik bagus agar tidak melakukan `SELECT *` yang mengambil memory lebih besar. Total hanya 2 query (1 untuk post, 1 untuk semua author relevan). Anda bisa mengaktifkan *Model strict mode* di `AppServiceProvider` via `Model::preventLazyLoading(!app()->isProduction());` untuk menangkap isu N+1 otomatis.

### 2.2 Massive Memory Consumption dengan `all()` atau `get()`

Ketika berurusan dengan jutaan record, menggunakan `all()` atau `get()` akan memuat seluruh record tersebut ke dalam memory (RAM) server PHP secara bersamaan.

❌ **KODE SALAH (Memory Exhaustion):**
```php
<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\User;
use Illuminate\Console\Command;

final class ProcessUsersCommand extends Command
{
    protected $signature = 'users:process';
    protected $description = 'Process all users';

    public function handle(): int
    {
        // Menarik 1 Juta record ke memory secara bersamaan! PHP akan Fatal Error (Memory Exhausted)
        $users = User::where('status', 'active')->get();

        foreach ($users as $user) {
            // Lakukan pekerjaan yang sangat berat...
            $this->performHeavyTask($user);
        }

        return Command::SUCCESS;
    }

    private function performHeavyTask(User $user): void
    {
        // Simulasi tugas berat
        sleep(0.1); 
    }
}
```
**Penjelasan Kesalahan:**
Metode `get()` mengambil semua hasil dari query dan membangun array (atau Collection) yang memuat Model object ke dalam memory. Jika recordnya ribuan atau jutaan, RAM PHP (biasanya terbatas di 128MB atau 512MB) akan langsung habis, dan aplikasi akan crash.

✅ **KODE BENAR (Chunking atau Lazy/Cursor):**
```php
<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\User;
use Illuminate\Console\Command;

final class ProcessUsersCommand extends Command
{
    protected $signature = 'users:process';
    protected $description = 'Process all users without memory leaks';

    public function handle(): int
    {
        // Menggunakan lazy() (generator) sehingga hanya meload sejumlah baris tertentu di RAM (default 1000)
        // Cursor akan meng-query dan yield 1 model object per iterasi secara efisien.
        foreach (User::where('status', 'active')->cursor() as $user) {
            $this->performHeavyTask($user);
        }

        // Alternatif jika akan mengubah data yang di-query (menghindari chunk loop bug):
        /*
        User::where('status', 'active')->chunkById(1000, function ($users) {
            foreach ($users as $user) {
                $this->performHeavyTask($user);
                $user->update(['status' => 'processed']);
            }
        });
        */

        return Command::SUCCESS;
    }

    private function performHeavyTask(User $user): void
    {
        // Simulasi tugas berat
        sleep(0.1);
    }
}
```
**Penjelasan Solusi:**
Metode `cursor()` menggunakan PDO generators untuk mengambil satu record dalam satu waktu, meminimalisir pemakaian RAM tanpa peduli besarnya tabel. Jika ada *update* pada field yang ada di dalam klausa `WHERE`, lebih disarankan menggunakan `chunkById()` untuk menjaga urutan dan pagination tidak terganggu, memecah eksekusi ke potongan kecil.


## 3. Optimasi Tingkat Lanjut (Indexing, Locking, CTE)

### 3.1 Pessimistic Locking (`lockForUpdate`)

Digunakan pada skenario konkuren, misal pengurangan saldo wallet atau stock inventory.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Wallets;

use App\Models\Wallet;
use Illuminate\Support\Facades\DB;
use RuntimeException;

final readonly class DeductWalletAction
{
    /**
     * @throws RuntimeException
     */
    public function execute(string $userId, int $amount): void
    {
        DB::transaction(function () use ($userId, $amount) {
            // lockForUpdate akan mencegah SELECT concurrent lain sampai transaksi ini commit
            $wallet = Wallet::where('user_id', $userId)->lockForUpdate()->firstOrFail();

            if ($wallet->balance < $amount) {
                throw new RuntimeException('Saldo tidak mencukupi.');
            }

            $wallet->balance -= $amount;
            $wallet->save();
        });
    }
}
```

### 3.2 Common Table Expressions (CTE) di Laravel

Laravel menyediakan dukungan native untuk CTE, sangat berguna untuk rekursi atau query analitik rumit.

```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use Illuminate\Support\Facades\DB;

final class AnalyticsRepository
{
    /**
     * @return array<int, object>
     */
    public function getRevenueReport(): array
    {
        return DB::table('daily_revenue')
            ->withExpression('revenue_cte', function ($query) {
                $query->selectRaw('DATE(created_at) as date, SUM(amount) as total')
                    ->from('transactions')
                    ->where('status', 'COMPLETED')
                    ->groupByRaw('DATE(created_at)');
            })
            ->select('date', 'total')
            ->from('revenue_cte')
            ->orderBy('date', 'desc')
            ->get()
            ->toArray();
    }
}
```


## 4. Pest v3 Testing (Architecture & Unit Testing)

Pengujian dalam arsitektur yang kuat membutuhkan unit, feature, dan architectural test yang komprehensif. Pest v3 memberikan sintaks yang elegan dan ekspresif.

### 4.1 Architecture Testing (Arch Testing)

Pastikan dependensi di dalam arsitektur tidak saling silang secara sembarangan.

```php
<?php

declare(strict_types=1);

// tests/ArchTest.php

use function Pest\Expectations\expect;

test('globals are not used')
    ->expect(['dd', 'dump', 'env', 'die', 'var_dump'])
    ->not->toBeUsed();

test('controllers depend on actions and requests but not repositories directly')
    ->expect('App\Http\Controllers')
    ->toUse('App\Actions')
    ->toUse('App\Http\Requests')
    ->not->toUse('App\Repositories\Contracts');

test('actions do not use http components')
    ->expect('App\Actions')
    ->not->toUse('Illuminate\Http');

test('models are strictly typed and immutable where necessary')
    ->expect('App\Models')
    ->toBeClasses()
    ->toExtend('Illuminate\Database\Eloquent\Model');
```

### 4.2 Feature & Unit Testing dengan Fakes & Mocks

Uji `CreateTransactionAction` secara isolasi.

```php
<?php

declare(strict_types=1);

// tests/Unit/Actions/CreateTransactionActionTest.php

use App\Actions\Transactions\CreateTransactionAction;
use App\DTOs\CreateTransactionDTO;
use App\Enums\TransactionStatus;
use App\Models\Transaction;
use App\Repositories\Contracts\TransactionRepositoryInterface;
use Illuminate\Support\Facades\DB;
use Mockery\MockInterface;

uses()->group('transactions');

it('successfully creates a transaction', function () {
    // Arrange
    $dto = new CreateTransactionDTO(
        userId: 'uuid-1234',
        amount: 50000,
        currency: 'IDR'
    );

    $expectedTransaction = new Transaction([
        'user_id' => 'uuid-1234',
        'amount' => 50000,
        'currency' => 'IDR',
        'status' => TransactionStatus::PENDING,
    ]);

    /** @var TransactionRepositoryInterface|MockInterface $repository */
    $repository = Mockery::mock(TransactionRepositoryInterface::class);
    $repository->shouldReceive('create')
        ->once()
        ->with($dto)
        ->andReturn($expectedTransaction);

    // Mencegah actual database hit pada DB::transaction
    DB::shouldReceive('transaction')
        ->once()
        ->andReturnUsing(function ($closure) {
            return $closure();
        });

    $action = new CreateTransactionAction($repository);

    // Act
    $result = $action->execute($dto);

    // Assert
    expect($result)->toBeInstanceOf(Transaction::class)
        ->and($result->amount)->toBe(50000)
        ->and($result->currency)->toBe('IDR');
});

it('throws exception when repository fails', function () {
    // Arrange
    $dto = new CreateTransactionDTO(
        userId: 'uuid-1234',
        amount: 50000,
        currency: 'IDR'
    );

    /** @var TransactionRepositoryInterface|MockInterface $repository */
    $repository = Mockery::mock(TransactionRepositoryInterface::class);
    $repository->shouldReceive('create')
        ->once()
        ->andThrow(new Exception('Database Error'));

    // Allow actual fallback to DB testing behaviour or mock transaction to rethrow
    DB::shouldReceive('transaction')
        ->once()
        ->andReturnUsing(function ($closure) {
            return $closure();
        });

    $action = new CreateTransactionAction($repository);

    // Act & Assert
    expect(fn () => $action->execute($dto))
        ->toThrow(RuntimeException::class, 'Gagal membuat transaksi: Database Error');
});
```

### 4.3 Feature Test API Endpoint

Gunakan factory dan RefreshDatabase untuk menguji endpoint end-to-end.

```php
<?php

declare(strict_types=1);

// tests/Feature/Api/Transactions/TransactionControllerTest.php

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use function Pest\Laravel\actingAs;
use function Pest\Laravel\postJson;

uses(RefreshDatabase::class)->group('api', 'transactions');

it('can store a transaction via api', function () {
    // Arrange
    $user = tap(User::factory()->create(), function(User $u) {
        $u->id = 'uuid-user-1';
        $u->save();
    });

    $payload = [
        'amount' => 150000,
        'currency' => 'IDR',
    ];

    // Act
    $response = actingAs($user)->postJson('/api/transactions', $payload);

    // Assert
    $response->assertStatus(201)
        ->assertJsonPath('message', 'Transaksi berhasil dibuat')
        ->assertJsonPath('data.amount', 150000)
        ->assertJsonPath('data.currency', 'IDR');

    // Pastikan tersimpan di DB
    $this->assertDatabaseHas('transactions', [
        'user_id' => $user->id,
        'amount' => 150000,
        'currency' => 'IDR',
    ]);
});

it('validates request before storing', function () {
    // Arrange
    $user = User::factory()->create();

    $payload = [
        'amount' => 500, // Invalid: min 1000
        'currency' => 'ID', // Invalid: size 3
    ];

    // Act
    $response = actingAs($user)->postJson('/api/transactions', $payload);

    // Assert
    $response->assertStatus(422)
        ->assertJsonValidationErrors(['amount', 'currency']);
});
```

## Kesimpulan

Membangun layer database yang kokoh di Laravel memerlukan pemahaman arsitektur berlapis (Clean Architecture), meminimalisir logic tersembunyi dengan DTO yang mutlak, mencegah *anti-patterns* mematikan (seperti N+1 dan Memory Leak), dan mempertegas keamanan sistem menggunakan pengujian bergradasi melalui Pest v3 dari sisi Architecture hingga HTTP layer.
