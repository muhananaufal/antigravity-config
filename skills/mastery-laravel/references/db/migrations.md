# Laravel Mastery: Database Migrations, Architecture & Data Persistence (Deep Dive & Best Practices)

Dalam ekosistem Laravel modern (Laravel 11/12) dan PHP 8.3/8.4, migrasi database bukan sekadar sekumpulan script untuk membuat tabel. Ia adalah fondasi arsitektur data, manifestasi keandalan sistem (reliability), dan dokumentasi *living schema* yang harus dirancang dengan pendekatan defensif dan zero-downtime. Dokumen ini membahas strategi advanced dalam mengelola migrasi, index optimization, handling large data, anti-patterns, dan pengujiannya menggunakan Pest v3 dengan konsep Clean Architecture.

---

## 1. Anatomi Migrasi Modern di Laravel 11/12

Laravel modern secara default merampingkan format migrasi dengan anonymous classes. Kombinasi PHP 8.3/8.4 dengan `declare(strict_types=1);` memastikan keamanan tipe di tingkat sistem.

### 1.1. Struktur Dasar Migrasi & Indexing Strategy

Setiap tabel krusial harus dirancang dengan mempertimbangkan volume data. Tipe data harus efisien, dan indeks harus strategis.

```php
<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('financial_transactions', function (Blueprint $table): void {
            // Gunakan BigInt untuk ID agar scalable
            $table->id();
            
            // Penggunaan UUID (atau ULID) sebagai external ID untuk security dan integrasi sistem.
            // Jangan pernah expose auto-increment ID ke public API untuk mencegah Enumeration Attack.
            $table->uuid('reference_id')->unique();
            
            // Relasi ke tabel users. 
            // - cascadeOnUpdate: Menjaga integritas saat ada update pada FK parent.
            // - restrictOnDelete: Cegah penghapusan user jika mereka masih punya transaksi. Sangat krusial di ranah fintech.
            $table->foreignId('user_id')
                  ->constrained('users')
                  ->cascadeOnUpdate()
                  ->restrictOnDelete(); 
                  
            // Enums dan Statuses dengan tipe data yang efisien (tinyInteger).
            // Default value harus didefinisikan secara explicit.
            $table->unsignedTinyInteger('status')->default(1)->comment('1: Pending, 2: Success, 3: Failed');
            
            // Amount dalam sen (integer). 
            // Float/Double HARUS dihindari untuk transaksi keuangan (Precision Loss Issue).
            $table->unsignedBigInteger('amount_cents');
            
            // Decimal jika presisi fixed sangat dibutuhkan (contoh: Tax, Kripto)
            $table->decimal('tax_amount', 12, 4)->default(0.0000);
            
            // JSON column untuk metadata tambahan (fleksibilitas schema-less dalam tabel relasional).
            $table->json('metadata')->nullable();
            
            // Soft deletes dan Timestamps
            $table->softDeletes();
            $table->timestamps();
            
            // Composite Index untuk optimasi query agregasi dan filter (Contoh: Laporan bulanan user).
            $table->index(['user_id', 'status', 'created_at']);
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('financial_transactions');
    }
};
```

### 1.2. Constraints & Triggers dalam Migrasi

Migrasi tingkat lanjut terkadang memerlukan raw constraints yang belum sepenuhnya tercover oleh wrapper Laravel Schema. 
Contohnya, mencegah `amount_cents` bernilai negatif menggunakan Check Constraint.

```php
    public function up(): void
    {
        Schema::create('wallets', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->bigInteger('balance_cents')->default(0);
            $table->timestamps();
        });

        // Menambahkan raw statement untuk CHECK constraint
        DB::statement('ALTER TABLE wallets ADD CONSTRAINT check_balance_positive CHECK (balance_cents >= 0)');
    }
```

---

## 2. Advanced Migration Strategies: Zero-Downtime

Melakukan migrasi di environment production dengan jutaan *row* tidak boleh mengunci tabel (*table lock*) dalam waktu lama. 

**Prinsip Zero-Downtime (Expand & Contract Pattern):**
1. **Expand**: Tambah kolom baru, namun kode aplikasi menulis ke kolom lama dan baru secara paralel (Double Write).
2. **Backfill**: Sinkronisasi data historis dari kolom lama ke kolom baru menggunakan proses batching background.
3. **Migrate Code**: Kode aplikasi diubah untuk membaca secara eksklusif dari kolom baru.
4. **Contract**: Hapus/drop kolom lama di database.

#### Contoh Kasus: Mengubah Kolom `status` dari string (`varchar`) ke `status_id` (`tinyint`)

**Langkah 1: Migrasi Pertama (Tambah Kolom Baru)**
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
        Schema::table('orders', function (Blueprint $table): void {
            $table->unsignedTinyInteger('status_id')->nullable()->after('status_string');
        });
    }

    public function down(): void
    {
        Schema::table('orders', function (Blueprint $table): void {
            $table->dropColumn('status_id');
        });
    }
};
```

**Langkah 2: Data Sinkronisasi (Idempotent Background Job)**
```php
<?php

declare(strict_types=1);

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

final class BackfillOrderStatusCommand extends Command
{
    protected $signature = 'db:backfill-order-status';
    protected $description = 'Backfill status_id based on legacy status_string via cursor chunking';

    public function handle(): int
    {
        $this->info('Starting backfill...');
        
        DB::table('orders')
            ->whereNull('status_id') // Filter memastikan job idempotent
            ->orderBy('id')
            ->chunkById(1000, function ($orders): void {
                foreach ($orders as $order) {
                    $statusId = match ($order->status_string) {
                        'pending' => 1,
                        'completed' => 2,
                        'failed' => 3,
                        default => 1,
                    };
                    
                    DB::table('orders')
                        ->where('id', $order->id)
                        ->update(['status_id' => $statusId]);
                }
            });
            
        $this->info('Backfill complete!');
        return Command::SUCCESS;
    }
}
```

**Langkah 3: Migrasi Hapus Kolom (Dilakukan di cycle deployment berikutnya setelah codebase terupdate membaca `status_id`)**
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
        Schema::table('orders', function (Blueprint $table): void {
            $table->dropColumn('status_string');
        });
    }
};
```

---

## 3. Clean Architecture: Orchestrating Request to Persistence

Pola `Controller -> Model` terlalu *coupled* (rapat) untuk sistem berskala besar. Kita harus memisahkan tanggung jawab (Separation of Concerns).

**Alur Clean Architecture:**
1. **FormRequest**: Menangani validasi dan otorisasi input.
2. **Controller**: Menerima input tervalidasi, memanggil Action/Service, dan merespons HTTP (Presentation Layer).
3. **Action (Service)**: Menangani *Business Logic*, memanggil repository, merangkai transaksi database, dan memicu *events*.
4. **Repository**: Menangani kueri *Data Access*, spesifik untuk abstraksi database (Eloquent).
5. **Model**: Murni representasi Data dan definisi Relasi, tanpa kueri rumit di dalamnya.

### 3.1. Model Definition

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\SoftDeletes;

/**
 * @property int $id
 * @property string $reference_id
 * @property int $user_id
 * @property int $status
 * @property int $amount_cents
 * @property array $metadata
 */
final class FinancialTransaction extends Model
{
    use HasFactory;
    use SoftDeletes;

    protected $fillable = [
        'reference_id',
        'user_id',
        'status',
        'amount_cents',
        'metadata',
    ];

    protected $casts = [
        'status' => 'integer',
        'amount_cents' => 'integer',
        'metadata' => 'array',
    ];

    /**
     * @return BelongsTo<User, FinancialTransaction>
     */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
```

### 3.2. FormRequest (Validation Layer)

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class StoreTransactionRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'user_id' => ['required', 'integer', 'exists:users,id'],
            'amount' => ['required', 'numeric', 'min:0.01'],
            'metadata' => ['nullable', 'array'],
        ];
    }
}
```

### 3.3. Repository (Data Access Layer)

```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Models\FinancialTransaction;
use Illuminate\Support\Str;

final class TransactionRepository
{
    /**
     * @param array<string, mixed> $data
     */
    public function create(array $data): FinancialTransaction
    {
        return FinancialTransaction::create([
            'reference_id' => Str::uuid()->toString(),
            'user_id' => (int) $data['user_id'],
            'status' => 1, // Default state: Pending
            'amount_cents' => (int) round(((float) $data['amount']) * 100),
            'metadata' => $data['metadata'] ?? [],
        ]);
    }
}
```

### 3.4. Action Class (Business Logic Layer)

```php
<?php

declare(strict_types=1);

namespace App\Actions;

use App\Models\FinancialTransaction;
use App\Repositories\TransactionRepository;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;
use RuntimeException;

final readonly class ProcessNewTransactionAction
{
    public function __construct(
        private TransactionRepository $repository
    ) {}

    /**
     * @param array<string, mixed> $data
     * @throws RuntimeException
     */
    public function execute(array $data): FinancialTransaction
    {
        try {
            // Membungkus dalam DB::transaction menjamin Atomic Operations.
            return DB::transaction(function () use ($data): FinancialTransaction {
                $transaction = $this->repository->create($data);
                
                // Pada titik ini bisa ditambahkan pemanggilan ke third party (contoh: payment gateway)
                // Atau memperbarui balance dari Wallet Model.
                
                Log::info('Transaction successfully initialized.', [
                    'reference_id' => $transaction->reference_id,
                    'user_id' => $transaction->user_id,
                ]);
                
                return $transaction;
            });
        } catch (Throwable $exception) {
            Log::error('Critical failure while processing transaction.', [
                'error_message' => $exception->getMessage(),
                'payload' => $data,
            ]);
            throw new RuntimeException('Unable to process the transaction. Please try again.', 500, $exception);
        }
    }
}
```

### 3.5. Controller (Presentation Layer)

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Actions\ProcessNewTransactionAction;
use App\Http\Requests\StoreTransactionRequest;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

final class TransactionController extends Controller
{
    public function __construct(
        private readonly ProcessNewTransactionAction $processAction
    ) {}

    public function store(StoreTransactionRequest $request): JsonResponse
    {
        try {
            // Melempar array yang sudah terjamin tipe dan keberadaannya via request->validated()
            $transaction = $this->processAction->execute($request->validated());

            return response()->json([
                'status' => 'success',
                'data' => [
                    'reference_id' => $transaction->reference_id,
                    'status' => $transaction->status,
                ],
            ], Response::HTTP_CREATED);
        } catch (Throwable $exception) {
            return response()->json([
                'status' => 'error',
                'message' => 'Internal Server Error. Our team has been notified.',
            ], Response::HTTP_INTERNAL_SERVER_ERROR);
        }
    }
}
```

---

## 4. Anti-Patterns Kritis dalam Migrasi & ORM Eloquent

Memahami Anti-Pattern lebih penting daripada menghafal fungsi-fungsi dasar. Kegagalan memahami poin ini dapat mengakibatkan server *crash* (*Out of Memory*) atau bottleneck I/O Database.

### Anti-Pattern 1: Migrasi dengan Mass Data Manipulation (Memory Exhaustion)

❌ **KODE SALAH:**
```php
<?php

declare(strict_types=1);

use App\Models\User;
use Illuminate\Database\Migrations\Migration;

return new class extends Migration
{
    public function up(): void
    {
        // ANTI-PATTERN: N+1 Update dan Penarikan data besar-besaran (All data into RAM)!
        // Ini akan memuat jutaan baris record User ke memori PHP (Fatal Error: Allowed memory size exhausted).
        // Selain itu, `update` dalam foreach akan menghasilkan query satu persatu (N query).
        $users = User::all();
        foreach ($users as $user) {
            $user->update(['is_active' => true]);
        }
    }
};
```

✅ **KODE BENAR:**
```php
<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        // BENAR: Menggunakan Query Builder secara langsung.
        // DML Batching ini mengeksekusi operasi tepat di DB Server (satu query instruksi SQL langsung), 
        // tanpa menarik baris-baris data tersebut ke RAM PHP.
        DB::table('users')
            ->whereNull('is_active')
            ->update(['is_active' => true]);
    }
};
```

**Penjelasan:** Pada dataset besar, tidak diperbolehkan menarik ribuan/jutaan row ke dalam object ORM di dalam migration. Gunakan operasi set-based dengan Query Builder `DB::table(...)`.

### Anti-Pattern 2: N+1 Query (Masalah Performa Paling Klasik)

❌ **KODE SALAH:**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\FinancialTransaction;
use Illuminate\Http\JsonResponse;

final class TransactionListController extends Controller
{
    public function index(): JsonResponse
    {
        // ANTI-PATTERN: Menarik transaksi tanpa Eager Loading.
        $transactions = FinancialTransaction::latest()->limit(50)->get();
        
        $data = $transactions->map(function ($trx) {
            return [
                'id' => $trx->id,
                // KODE BERBAHAYA: Pemanggilan relasi dinamis di sini memicu query ke DB secara implisit.
                // Jika ada 50 transaksi, maka akan ada tambahan 50 query tunggal ke tabel users! (1 + 50 query).
                'user_name' => $trx->user->name,
                'amount' => $trx->amount_cents,
            ];
        });

        return response()->json(['data' => $data]);
    }
}
```

✅ **KODE BENAR:**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\FinancialTransaction;
use Illuminate\Http\JsonResponse;

final class TransactionListController extends Controller
{
    public function index(): JsonResponse
    {
        // BENAR: Menggunakan Eager Loading `with()`
        // Ini memastikan Eloquent menyelesaikan semuanya hanya dalam 2 query SQL, terlepas dari berapapun jumlah datanya!
        $transactions = FinancialTransaction::with('user:id,name') // Batasi kolom yang diambil untuk efisiensi
                                            ->latest()
                                            ->limit(50)
                                            ->get();
        
        $data = $transactions->map(function ($trx) {
            return [
                'id' => $trx->id,
                'user_name' => $trx->user->name,
                'amount' => $trx->amount_cents,
            ];
        });

        return response()->json(['data' => $data]);
    }
}
```

**Penjelasan:** Selalu antisipasi N+1 Query Problem dengan secara eksplisit mendaftarkan relasi yang dibutuhkan dalam klausa `with(...)`. Pastikan Anda membatasi kolom yang diambil dari relasi tersebut dengan format string `relation:column1,column2`.

---

## 5. Komprehensif Testing Framework Menggunakan Pest v3

Pengujian menyeluruh menjaga codebase bebas dari regresi. Pest v3 memberikan sintaks yang ekspresif, functional chaining, serta pengujian arsitektur bawaan.

### 5.1. Architectural Testing (tests/ArchTest.php)

Validasi batas-batas layer Anda secara otomatis!

```php
<?php

declare(strict_types=1);

// Pastikan Controller hanya bertugas sebagai gateway dan tidak menyentuh database
test('controllers should not use Eloquent or DB facades directly')
    ->expect('App\Http\Controllers')
    ->not->toUse('Illuminate\Database\Eloquent\Model')
    ->not->toUse('Illuminate\Support\Facades\DB');

// Pastikan Model murni untuk data
test('models should not use Http Request classes')
    ->expect('App\Models')
    ->not->toUse('Illuminate\Http\Request');

// Pastikan tipe ketat diterapkan 100% pada layer inti
test('strict types are enforced across core architecture')
    ->expect(['App\Actions', 'App\Repositories', 'App\Http\Controllers', 'App\Models'])
    ->toUseStrictTypes();
```

### 5.2. Unit & Integration Testing (tests/Unit/Actions/ProcessNewTransactionActionTest.php)

Menguji Behavior Business Logic Action dan integrasinya dengan layer Repository.

```php
<?php

declare(strict_types=1);

use App\Actions\ProcessNewTransactionAction;
use App\Models\FinancialTransaction;
use App\Models\User;
use App\Repositories\TransactionRepository;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Log;

uses(RefreshDatabase::class);

it('successfully processes a new transaction with correct calculations', function (): void {
    // Arrange (Persiapan)
    $user = User::factory()->create();
    $data = [
        'user_id' => $user->id,
        'amount' => 150.50, // Akan dikonversi menjadi 15050 cents
        'metadata' => ['device' => 'ios'],
    ];
    
    $repository = new TransactionRepository();
    $action = new ProcessNewTransactionAction($repository);
    
    // Memantau Logger agar tes tidak menghasilkan I/O ke file
    Log::spy(); 
    
    // Act (Eksekusi)
    $transaction = $action->execute($data);
    
    // Assert (Verifikasi)
    expect($transaction)
        ->toBeInstanceOf(FinancialTransaction::class)
        ->amount_cents->toBe(15050)
        ->user_id->toBe($user->id)
        ->status->toBe(1)
        ->metadata->toHaveKey('device', 'ios');
        
    // Pastikan log sistem mencatatnya
    Log::shouldHaveReceived('info')
        ->with('Transaction successfully initialized.', [
            'reference_id' => $transaction->reference_id,
            'user_id' => $transaction->user_id,
        ])
        ->once();
        
    // Pastikan data benar-benar menetap di Database
    $this->assertDatabaseHas('financial_transactions', [
        'user_id' => $user->id,
        'amount_cents' => 15050,
    ]);
});

it('rolls back database transaction and throws exception on invalid data', function (): void {
    // Arrange
    $data = [
        'user_id' => 999999, // User yang tidak ada akan memicu error integritas referensial dari DB
        'amount' => 100,
    ];
    
    $repository = new TransactionRepository();
    $action = new ProcessNewTransactionAction($repository);
    
    Log::spy();
    
    // Act & Assert
    expect(fn () => $action->execute($data))
        ->toThrow(RuntimeException::class, 'Unable to process the transaction. Please try again.');
        
    // Memastikan kegagalan tercatat secara log level error
    Log::shouldHaveReceived('error')->once();
    
    // Memastikan tidak ada data kotor yang masuk ke database karena proses rollback DB Transaction
    $this->assertDatabaseCount('financial_transactions', 0);
});
```

### 5.3. Feature Testing API Endpoint (tests/Feature/Http/Controllers/TransactionControllerTest.php)

Uji end-to-end simulasi *HTTP Request* memastikan *FormRequest* validasi berfungsi dan merespon kode yang tepat.

```php
<?php

declare(strict_types=1);

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Symfony\Component\HttpFoundation\Response;

uses(RefreshDatabase::class);

it('validates required fields preventing bad requests on transaction creation', function (): void {
    // Act
    $response = $this->postJson('/api/transactions', []);
    
    // Assert
    $response->assertStatus(Response::HTTP_UNPROCESSABLE_ENTITY)
             ->assertJsonValidationErrors(['user_id', 'amount']);
});

it('creates transaction successfully via API endpoint', function (): void {
    // Arrange
    $user = User::factory()->create();
    $payload = [
        'user_id' => $user->id,
        'amount' => 500.00,
        'metadata' => ['source' => 'web'],
    ];
    
    // Act
    $response = $this->postJson('/api/transactions', $payload);
    
    // Assert
    $response->assertStatus(Response::HTTP_CREATED)
             ->assertJsonStructure([
                 'status',
                 'data' => [
                     'reference_id',
                     'status',
                 ],
             ]);
             
    // Verifikasi database sinkron melalui API call
    $this->assertDatabaseHas('financial_transactions', [
        'user_id' => $user->id,
        'amount_cents' => 50000,
    ]);
});
```

---

## Kesimpulan Eksekutif

Migrasi di aplikasi Laravel Modern (v11/12) adalah fondasi stabilitas aplikasi Anda. Membangun aplikasi tingkat *enterprise* yang berskala besar bukan hanya soal penulisan *script SQL*, namun bagaimana setiap baris kode dari lapisan HTTP (*FormRequest* -> *Controller*) dihubungkan dan ditangani secara *Atomic* melalui *Business Layer* (*Action*) dan *Data Access Layer* (*Repository*). 

Dengan menguasai *Zero-Downtime Deployment*, menghindari Anti-Pattern *N+1 Memory Leaks*, dan mengukuhkan standar tinggi menggunakan arsitektur keamanan *Strict Type* yang diuji ketat (*Architectural Tests* & *Feature Tests*) melalui Pest v3, Anda menjamin *Software Resilience* kelas atas dan performa berkelanjutan.
