---
title: "Zend Engine Memory & Garbage Collection (GC) di PHP"
description: "Eksplorasi mendalam mengenai manajemen memori, Garbage Collection (GC), dan strategi mencegah Memory Leaks pada aplikasi Laravel long-running (Octane, Horizon, Queue Workers)."
---

# Zend Engine Memory & Garbage Collection (GC)

Dalam eksekusi tradisional PHP (FPM), siklus hidup aplikasi sangat singkat (Request -> Process -> Response -> Die). Pada model ini, *memory leak* jarang menjadi masalah besar karena Zend Engine akan membersihkan memori secara total saat *script* berakhir. 

Namun, di era **Laravel Octane (Swoole/FrankenPHP)**, **Laravel Horizon**, dan **Queue Workers (Daemon)**, aplikasi PHP berjalan secara terus-menerus (*long-running process*). Pada arsitektur ini, sedikit saja *memory leak* akan terus menumpuk dan pada akhirnya membunuh proses tersebut (OOM - Out of Memory).

Artikel ini akan membahas mekanika Zend Engine Garbage Collection dan *Clean Architecture* anti-*leak*.

## 1. Mekanika Reference Counting & Cyclic Garbage Collection

PHP menggunakan sistem **Reference Counting** (Zval). Setiap variabel yang kita buat memiliki *refcount*.
- Saat variabel digunakan oleh variabel lain, *refcount* naik.
- Saat variabel di-*unset* atau keluar dari *scope*, *refcount* turun.
- Jika *refcount* mencapai `0`, Zend Engine langsung menghapus nilainya dari memori.

**Masalah: Circular Reference**
Bagaimana jika Object A menunjuk ke Object B, dan Object B menunjuk balik ke Object A? Meskipun mereka sudah tidak terpakai, *refcount* mereka tidak pernah mencapai `0`. Inilah yang memicu **Garbage Collection (GC)** berjalan secara sinkron untuk membedah *roots* memori dan membersihkan memori siklik. 

---

## 2. Anti-Pattern: Memory Leak & Security Risk

Berikut adalah pola yang sangat berbahaya dalam aplikasi *long-running* Laravel.

### 2.1 Anti-Pattern 1: Akumulasi Array di Properti Static / Singleton

❌ **KODE SALAH (Bad Practice)**

Menyimpan log, riwayat query, atau mem-cache hasil *query database* ke dalam variabel statis atau *singleton* (seperti binding `singleton` di Service Container) tanpa mekanisme pembatasan atau *flushing*.

```php
declare(strict_types=1);

namespace App\Services;

use App\Models\User;

class UserCacheService
{
    // BERBAHAYA: Properti statis ini akan terus membesar selama worker Laravel hidup
    private static array $resolvedUsers = [];

    public function getUser(int $id): User
    {
        if (!isset(self::$resolvedUsers[$id])) {
            self::$resolvedUsers[$id] = User::find($id);
        }

        return self::$resolvedUsers[$id];
    }
}
```

> **Risiko Memory:** Pada Laravel Octane atau Horizon, `UserCacheService` ini akan menahan *instances* Eloquent Model dari satu *request* ke *request* lain. Setelah ribuan *requests*, array `$resolvedUsers` akan memakan gigabytes memori, berujung pada *fatal error Out of Memory* (OOM). Data antar-pengguna juga berisiko bocor (Security Risk).

✅ **KODE BENAR (Best Practice)**

Gunakan fasilitas Cache resmi Laravel (Redis/Memcached) atau bersihkan statik *state* setiap kali request/job selesai. Di Laravel Octane, kita mendengarkan event `RequestTerminated`. Untuk Clean Architecture, gunakan *Action* yang stateless.

```php
declare(strict_types=1);

namespace App\Actions\User;

use App\Models\User;
use Illuminate\Support\Facades\Cache;

readonly class GetUserAction
{
    public function execute(int $id): ?User
    {
        // Menggunakan Laravel Cache yang aman dari memory leak di level worker PHP
        return Cache::store('redis')->remember(
            "user:{$id}",
            3600,
            fn () => User::find($id)
        );
    }
}
```

### 2.2 Anti-Pattern 2: Memuat Seluruh Data Database ke RAM (`get()` vs `chunk()`)

❌ **KODE SALAH (Bad Practice)**

Mengekstrak jutaan baris data menggunakan `get()` alih-alih `chunk()` atau `cursor()`.

```php
declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\Transaction;
use Illuminate\Console\Command;

class ExportTransactionsCommand extends Command
{
    protected $signature = 'export:transactions';

    public function handle(): int
    {
        // BERBAHAYA: Memuat sejuta model Transaction ke RAM sekaligus
        $transactions = Transaction::all();
        
        foreach ($transactions as $transaction) {
            $this->process($transaction);
        }

        return Command::SUCCESS;
    }
    
    private function process(Transaction $transaction): void
    {
        // ...
    }
}
```

> **Risiko Memory:** Model Eloquent di Laravel sangat berat karena membawa banyak *metadata* (casts, relations, mutators, zval reference). Satu model `Transaction` bisa memakan 1KB-5KB. Sejuta data = ~5GB RAM. Server akan *crash*.

✅ **KODE BENAR (Best Practice)**

Gunakan **Lazy Collections** (via `cursor()`) atau `chunkById()` di *Repository Layer*. Bebaskan memori secara agresif dengan `unset()` secara eksplisit bila perlu.

```php
declare(strict_types=1);

namespace App\Repositories;

use App\Models\Transaction;
use Illuminate\Support\LazyCollection;

class TransactionRepository
{
    /**
     * @return LazyCollection<int, Transaction>
     */
    public function streamUnprocessedTransactions(): LazyCollection
    {
        // Cursor menggunakan PHP Generators secara internal
        // Hanya 1 baris model yang dimuat ke RAM pada satu waktu
        return Transaction::where('is_processed', false)
            ->cursor();
    }
}
```

---

## 3. Implementasi Clean Architecture & Batch Processing

Mari kita buat sebuah sistem ekspor transaksi berskala masif yang terjamin tidak mengalami *memory leak*.

### 3.1 Repository (Data Streaming)

```php
declare(strict_types=1);

namespace App\Repositories\Contracts;

use Illuminate\Support\LazyCollection;

interface TransactionRepositoryInterface
{
    public function streamTransactionsForExport(string $startDate, string $endDate): LazyCollection;
}
```

```php
declare(strict_types=1);

namespace App\Repositories;

use App\Models\Transaction;
use App\Repositories\Contracts\TransactionRepositoryInterface;
use Illuminate\Support\LazyCollection;

class TransactionRepository implements TransactionRepositoryInterface
{
    public function streamTransactionsForExport(string $startDate, string $endDate): LazyCollection
    {
        return Transaction::query()
            ->whereBetween('created_at', [$startDate, $endDate])
            ->select(['id', 'amount', 'currency', 'created_at'])
            ->cursor();
    }
}
```

### 3.2 Action (Pemrosesan Data dengan `gc_collect_cycles()`)

Pada pemrosesan jutaan data di *worker*, kita kadang perlu memanggil Garbage Collector secara manual.

```php
declare(strict_types=1);

namespace App\Actions\Export;

use App\Repositories\Contracts\TransactionRepositoryInterface;
use Illuminate\Support\Facades\Storage;

readonly class GenerateLargeExportAction
{
    public function __construct(
        private TransactionRepositoryInterface $repository
    ) {}

    public function execute(string $startDate, string $endDate, string $filename): bool
    {
        $file = fopen(Storage::path($filename), 'w');
        
        if ($file === false) {
            return false;
        }

        fputcsv($file, ['ID', 'Amount', 'Currency', 'Date']);

        $stream = $this->repository->streamTransactionsForExport($startDate, $endDate);
        
        $counter = 0;
        foreach ($stream as $transaction) {
            fputcsv($file, [
                $transaction->id,
                $transaction->amount,
                $transaction->currency,
                $transaction->created_at->format('Y-m-d H:i:s'),
            ]);

            // Opsional namun aman: Secara manual menghapus dari local scope
            unset($transaction);
            
            $counter++;
            // Paksa GC berjalan setiap 10.000 iterasi untuk membersihkan object cycle
            if ($counter % 10000 === 0) {
                gc_collect_cycles();
            }
        }

        fclose($file);
        
        return true;
    }
}
```

### 3.3 Command CLI

```php
declare(strict_types=1);

namespace App\Console\Commands;

use App\Actions\Export\GenerateLargeExportAction;
use Illuminate\Console\Command;

class ExportMassiveTransactionsCommand extends Command
{
    protected $signature = 'export:transactions {start} {end} {file}';
    protected $description = 'Memory-safe massive export of transactions';

    public function handle(GenerateLargeExportAction $action): int
    {
        $this->info("Starting export...");
        
        $action->execute(
            $this->argument('start'),
            $this->argument('end'),
            $this->argument('file')
        );

        $this->info("Export completed safely.");
        return Command::SUCCESS;
    }
}
```

---

## 4. Testing dengan Pest v3

### 4.1 Architecture Testing (`tests/ArchTest.php`)

```php
declare(strict_types=1);

uses()->group('architecture');

test('no memory leaking methods in repositories', function () {
    // Memastikan kita tidak menggunakan all() atau get() di methods
    // Idealnya dikontrol via PHPStan, namun bisa kita cek statik pattern tertentu
    expect('App\Repositories')
        ->not->toUse('Illuminate\Database\Eloquent\Collection');
});

test('actions are stateless and readonly', function () {
    expect('App\Actions')->toBeReadonly();
});
```

### 4.2 Integration & Memory Testing (`tests/Feature/Actions/GenerateLargeExportActionTest.php`)

Di Pest v3 kita bisa melacak konsumsi memori untuk membuktikan bahwa metode *streaming* benar-benar efektif.

```php
declare(strict_types=1);

use App\Actions\Export\GenerateLargeExportAction;
use App\Models\Transaction;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;

uses(RefreshDatabase::class)->group('integration', 'memory');

it('exports data without memory leak', function () {
    // Arrange
    Storage::fake('local');
    $filename = 'test_export.csv';
    Storage::disk('local')->put($filename, ''); // Touch file
    
    // Create 1000 records
    Transaction::factory()->count(1000)->create([
        'created_at' => '2026-01-01 10:00:00'
    ]);

    $action = app(GenerateLargeExportAction::class);
    
    // Catat memori sebelum eksekusi
    $initialMemory = memory_get_usage();

    // Act
    $result = $action->execute('2026-01-01', '2026-01-02', $filename);

    // Catat memori setelah eksekusi
    $finalMemory = memory_get_usage();
    
    // Hitung lonjakan memori (delta) dalam Bytes
    $memorySpike = $finalMemory - $initialMemory;

    // Assert
    expect($result)->toBeTrue();
    
    // Ekspor 1000 baris tidak boleh memakan RAM lebih dari 3MB delta (contoh)
    // Jika menggunakan `get()` memori akan bocor puluhan MB.
    expect($memorySpike)->toBeLessThan(3 * 1024 * 1024);
    
    // Pastikan file CSV terbuat dan berisi 1001 baris (1 header + 1000 data)
    $lines = file(Storage::path($filename));
    expect(count($lines))->toBe(1001);
});
```

---
## Kesimpulan
*   **Lazy Collections (`cursor`)** adalah teknik mutlak saat menangani dataset puluhan ribu hingga jutaan *rows*.
*   Di aplikasi **Laravel Octane / Horizon**, perhatikan ketat penggunaan variabel *static*, *singleton*, atau kelas yang menyimpan array secara akumulatif. Mereka tidak otomatis terhapus saat HTTP request selesai.
*   **Zend GC** (Garbage Collection) tidak selalu berjalan instan. Menggunakan fungsi manual seperti `gc_collect_cycles()` pada *looping* panjang di *Worker* atau *Console Command* sangat dianjurkan untuk mencegah OOM *crash*.
