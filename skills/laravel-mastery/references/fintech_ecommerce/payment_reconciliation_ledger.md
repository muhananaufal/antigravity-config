# Sistem Rekonsiliasi Pembayaran dan Immutable Ledger di Laravel (PHP 8.3+)

Dalam aplikasi Fintech dan E-Commerce skala besar, integritas data keuangan adalah harga mati. Sistem tidak boleh hanya mengandalkan perubahan state (misal: saldo berubah dari 100 ke 50), melainkan harus mencatat **setiap pergerakan dana** melalui sistem *Immutable Ledger* (buku besar yang tidak dapat diubah) dan melakukan rekonsiliasi pembayaran secara berkala.

Panduan ini menguraikan implementasi sistem *Payment Reconciliation* dan *Ledger* menggunakan arsitektur bersih (Clean Architecture) pada Laravel 11/12 dan PHP 8.3+.

---

## 1. Skema Database (Database Migrations)

Sistem ledger harus bersifat append-only (hanya penambahan). Kita tidak pernah melakukan `UPDATE` atau `DELETE` pada record ledger.

```php
declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Tabel Accounts: Menyimpan saldo agregat (cached balance)
        Schema::create('financial_accounts', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('owner_type'); // misal: App\Models\User, App\Models\Merchant
            $table->uuid('owner_id');
            $table->string('currency', 3)->default('IDR');
            $table->bigInteger('balance_cents')->default(0); // Selalu gunakan Integer (cents)
            $table->timestamps();

            $table->unique(['owner_type', 'owner_id', 'currency']);
        });

        // Tabel Ledger Entries: Menyimpan pergerakan dana (Immutable)
        Schema::create('ledger_entries', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('financial_account_id');
            $table->string('transaction_reference')->index(); // ID transaksi eksternal/internal
            $table->bigInteger('amount_cents'); // Positif untuk kredit, Negatif untuk debit
            $table->string('entry_type'); // DEPOSIT, WITHDRAWAL, PAYMENT, REFUND
            $table->string('description');
            $table->json('metadata')->nullable();
            $table->timestamp('created_at')->useCurrent();
            
            // Ledger entry is immutable, no updated_at

            $table->foreign('financial_account_id')
                  ->references('id')
                  ->on('financial_accounts')
                  ->cascadeOnDelete();
        });

        // Tabel Rekonsiliasi
        Schema::create('reconciliation_batches', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('payment_gateway');
            $table->date('reconciliation_date');
            $table->integer('total_transactions_processed');
            $table->integer('total_discrepancies_found');
            $table->string('status'); // PENDING, COMPLETED, FAILED
            $table->timestamps();
        });

        Schema::create('reconciliation_discrepancies', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('reconciliation_batch_id');
            $table->string('transaction_reference');
            $table->bigInteger('system_amount_cents');
            $table->bigInteger('gateway_amount_cents');
            $table->string('reason');
            $table->string('resolution_status')->default('UNRESOLVED');
            $table->timestamps();

            $table->foreign('reconciliation_batch_id')
                  ->references('id')
                  ->on('reconciliation_batches')
                  ->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('reconciliation_discrepancies');
        Schema::dropIfExists('reconciliation_batches');
        Schema::dropIfExists('ledger_entries');
        Schema::dropIfExists('financial_accounts');
    }
};
```

---

## 2. Data Transfer Objects (DTOs)

Penggunaan array asosiatif (array shape) rentan terhadap typo dan tidak type-safe. DTO memastikan struktur data valid saat melewati batas lapisan arsitektur.

```php
declare(strict_types=1);

namespace App\Domain\Ledger\DTOs;

readonly class LedgerEntryDTO
{
    public function __construct(
        public string $accountId,
        public int $amountCents,
        public string $transactionReference,
        public string $entryType,
        public string $description,
        public array $metadata = []
    ) {
        if ($this->amountCents === 0) {
            throw new \InvalidArgumentException('Ledger entry amount cannot be zero.');
        }
    }
}
```

```php
declare(strict_types=1);

namespace App\Domain\Reconciliation\DTOs;

readonly class GatewayTransactionDTO
{
    public function __construct(
        public string $reference,
        public int $amountCents,
        public string $status,
        public \DateTimeImmutable $transactionDate
    ) {}
}
```

---

## 3. Repositories (Kontrak dan Implementasi)

Pemisahan logika akses data memungkinkan pengujian yang lebih mudah dan abstraksi dari framework ORM.

```php
declare(strict_types=1);

namespace App\Domain\Ledger\Repositories;

use App\Domain\Ledger\DTOs\LedgerEntryDTO;
use App\Models\LedgerEntry;

interface LedgerRepositoryInterface
{
    public function recordEntry(LedgerEntryDTO $dto): LedgerEntry;
    public function calculateBalance(string $accountId): int;
}
```

```php
declare(strict_types=1);

namespace App\Infrastructure\Persistence\Repositories;

use App\Domain\Ledger\DTOs\LedgerEntryDTO;
use App\Domain\Ledger\Repositories\LedgerRepositoryInterface;
use App\Models\LedgerEntry;
use App\Models\FinancialAccount;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

final class EloquentLedgerRepository implements LedgerRepositoryInterface
{
    public function recordEntry(LedgerEntryDTO $dto): LedgerEntry
    {
        $entry = new LedgerEntry();
        $entry->id = Str::uuid()->toString();
        $entry->financial_account_id = $dto->accountId;
        $entry->amount_cents = $dto->amountCents;
        $entry->transaction_reference = $dto->transactionReference;
        $entry->entry_type = $dto->entryType;
        $entry->description = $dto->description;
        $entry->metadata = $dto->metadata;
        
        $entry->save();

        return $entry;
    }

    public function calculateBalance(string $accountId): int
    {
        return (int) LedgerEntry::where('financial_account_id', $accountId)
            ->sum('amount_cents');
    }
}
```

---

## 4. Actions / Services (Bisnis Logika)

Lapisan action bertugas memproses use case. Di sini kita mengatur transaksi database dan race conditions.

```php
declare(strict_types=1);

namespace App\Domain\Ledger\Actions;

use App\Domain\Ledger\DTOs\LedgerEntryDTO;
use App\Domain\Ledger\Repositories\LedgerRepositoryInterface;
use App\Models\FinancialAccount;
use Illuminate\Support\Facades\DB;

final readonly class PostLedgerTransactionAction
{
    public function __construct(
        private LedgerRepositoryInterface $ledgerRepository
    ) {}

    /**
     * Mencatat entri ledger dan memperbarui saldo agregat secara aman (Atomic).
     *
     * @throws \Exception
     */
    public function execute(LedgerEntryDTO $dto): void
    {
        DB::transaction(function () use ($dto) {
            // Pessimistic locking (lockForUpdate) untuk menghindari race conditions saat update saldo
            $account = FinancialAccount::where('id', $dto->accountId)->lockForUpdate()->firstOrFail();

            if ($dto->amountCents < 0 && $account->balance_cents < abs($dto->amountCents)) {
                throw new \DomainException('Insufficient balance.');
            }

            // Record immuntable ledger
            $this->ledgerRepository->recordEntry($dto);

            // Update cached balance
            $account->balance_cents += $dto->amountCents;
            $account->save();
        });
    }
}
```

### Action Rekonsiliasi

Action ini membandingkan data dari Payment Gateway dengan sistem internal.

```php
declare(strict_types=1);

namespace App\Domain\Reconciliation\Actions;

use App\Domain\Reconciliation\DTOs\GatewayTransactionDTO;
use App\Models\LedgerEntry;
use App\Models\ReconciliationBatch;
use App\Models\ReconciliationDiscrepancy;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

final readonly class PerformReconciliationAction
{
    /**
     * @param GatewayTransactionDTO[] $gatewayTransactions
     */
    public function execute(string $gatewayName, \DateTimeImmutable $date, array $gatewayTransactions): ReconciliationBatch
    {
        return DB::transaction(function () use ($gatewayName, $date, $gatewayTransactions) {
            $batch = new ReconciliationBatch();
            $batch->id = Str::uuid()->toString();
            $batch->payment_gateway = $gatewayName;
            $batch->reconciliation_date = $date->format('Y-m-d');
            $batch->total_transactions_processed = count($gatewayTransactions);
            $batch->total_discrepancies_found = 0;
            $batch->status = 'PROCESSING';
            $batch->save();

            $discrepanciesCount = 0;

            foreach ($gatewayTransactions as $gt) {
                // Cari total mutasi ledger untuk transaksi ini
                $systemAmount = (int) LedgerEntry::where('transaction_reference', $gt->reference)
                    ->sum('amount_cents');

                if ($systemAmount !== $gt->amountCents) {
                    $discrepancy = new ReconciliationDiscrepancy();
                    $discrepancy->id = Str::uuid()->toString();
                    $discrepancy->reconciliation_batch_id = $batch->id;
                    $discrepancy->transaction_reference = $gt->reference;
                    $discrepancy->system_amount_cents = $systemAmount;
                    $discrepancy->gateway_amount_cents = $gt->amountCents;
                    $discrepancy->reason = 'AMOUNT_MISMATCH';
                    $discrepancy->save();

                    $discrepanciesCount++;
                }
            }

            $batch->total_discrepancies_found = $discrepanciesCount;
            $batch->status = $discrepanciesCount > 0 ? 'COMPLETED_WITH_DISCREPANCIES' : 'COMPLETED';
            $batch->save();

            return $batch;
        });
    }
}
```

---

## 5. Anti-Patterns (❌ vs ✅)

### Anti-Pattern 1: Menyimpan Uang Menggunakan Tipe Float/Decimal di Aplikasi

**❌ BAD PRACTICE:**
Menggunakan tipe data `float` untuk merepresentasikan nominal mata uang. Float tidak presisi (floating-point arithmetic error) dan akan menyebabkan bug saat menjumlahkan nilai yang besar atau melakukan rekonsiliasi.
```php
// ❌ Jangan gunakan ini!
$amount = 10.50;
$fee = 0.30;
$total = $amount + $fee; // Hasil bisa jadi 10.79999999999999
```

**✅ BEST PRACTICE:**
Selalu gunakan **Integer** yang merepresentasikan nilai unit terkecil (misal: cents/sen untuk USD, atau nilai asli untuk mata uang tanpa pecahan seperti IDR, namun disepakati sebagai "cents" untuk konsistensi sistem).
```php
// ✅ Benar!
$amountCents = 1050; // $10.50
$feeCents = 30;     // $0.30
$totalCents = $amountCents + $feeCents; // Tepat 1080 ($10.80)
```

### Anti-Pattern 2: Memperbarui Saldo Tanpa Database Locking

**❌ BAD PRACTICE:**
Memperbarui baris dari tabel dengan membacanya dan kemudian menyimpannya tanpa melindunginya dari race condition (terutama dalam aplikasi bervolume tinggi seperti Fintech).
```php
// ❌ Rentan terhadap Race Condition / Double Spending
$account = FinancialAccount::find($accountId);
if ($account->balance_cents >= $withdrawalAmount) {
    $account->balance_cents -= $withdrawalAmount;
    $account->save();
}
```

**✅ BEST PRACTICE:**
Gunakan transaksi database bersarang dengan pembatasan kunci pesimistis (Pessimistic Locking / `lockForUpdate()`). Ini akan memblokir proses lain dari membaca baris tersebut hingga proses kita selesai.
```php
// ✅ Benar dan Aman!
DB::transaction(function () use ($accountId, $withdrawalAmount) {
    $account = FinancialAccount::where('id', $accountId)->lockForUpdate()->firstOrFail();
    if ($account->balance_cents >= $withdrawalAmount) {
        $account->balance_cents -= $withdrawalAmount;
        $account->save();
        // Insert withdrawal to Ledger...
    }
});
```

---

## 6. Pengujian Mutu (Testing) dengan Pest v3

Sistem keuangan harus mematuhi pengujian yang ketat (TDD/BDD). Kita akan menggunakan Pest v3.

### 6.1 Unit Tests (Aksi Ledger)

```php
// tests/Unit/Ledger/PostLedgerTransactionActionTest.php
declare(strict_types=1);

use App\Domain\Ledger\Actions\PostLedgerTransactionAction;
use App\Domain\Ledger\DTOs\LedgerEntryDTO;
use App\Infrastructure\Persistence\Repositories\EloquentLedgerRepository;
use App\Models\FinancialAccount;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;

uses(RefreshDatabase::class);

it('successfully posts a deposit transaction and updates cached balance', function () {
    $account = FinancialAccount::factory()->create([
        'balance_cents' => 1000,
    ]);

    $dto = new LedgerEntryDTO(
        accountId: $account->id,
        amountCents: 500, // Deposit 500
        transactionReference: 'TRX-' . Str::random(10),
        entryType: 'DEPOSIT',
        description: 'Deposit via Bank Transfer'
    );

    $repository = new EloquentLedgerRepository();
    $action = new PostLedgerTransactionAction($repository);

    $action->execute($dto);

    // Assert account balance updated
    expect($account->refresh()->balance_cents)->toBe(1500);

    // Assert ledger entry created
    $this->assertDatabaseHas('ledger_entries', [
        'financial_account_id' => $account->id,
        'amount_cents' => 500,
        'entry_type' => 'DEPOSIT',
    ]);
});

it('throws exception if withdrawal exceeds balance', function () {
    $account = FinancialAccount::factory()->create([
        'balance_cents' => 100, // Saldo hanya 100
    ]);

    $dto = new LedgerEntryDTO(
        accountId: $account->id,
        amountCents: -500, // Coba tarik 500
        transactionReference: 'TRX-WD-' . Str::random(10),
        entryType: 'WITHDRAWAL',
        description: 'ATM Withdrawal'
    );

    $repository = new EloquentLedgerRepository();
    $action = new PostLedgerTransactionAction($repository);

    expect(fn() => $action->execute($dto))
        ->toThrow(\DomainException::class, 'Insufficient balance.');

    // Assert saldo tidak berubah
    expect($account->refresh()->balance_cents)->toBe(100);
});
```

### 6.2 Unit Tests (Aksi Rekonsiliasi)

```php
// tests/Unit/Reconciliation/PerformReconciliationActionTest.php
declare(strict_types=1);

use App\Domain\Reconciliation\Actions\PerformReconciliationAction;
use App\Domain\Reconciliation\DTOs\GatewayTransactionDTO;
use App\Models\FinancialAccount;
use App\Models\LedgerEntry;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

it('creates reconciliation batch and flags discrepancies', function () {
    $account = FinancialAccount::factory()->create();
    
    // Sistem mencatat transaksi 1000 cents
    LedgerEntry::factory()->create([
        'financial_account_id' => $account->id,
        'transaction_reference' => 'TRX-001',
        'amount_cents' => 1000,
    ]);

    // Gateway mengatakan transaksi tersebut adalah 1200 cents (Terdapat diskrepansi)
    $gatewayTransactions = [
        new GatewayTransactionDTO(
            reference: 'TRX-001',
            amountCents: 1200,
            status: 'SUCCESS',
            transactionDate: new \DateTimeImmutable('2023-10-01')
        ),
    ];

    $action = new PerformReconciliationAction();
    $batch = $action->execute('STRIPE', new \DateTimeImmutable('2023-10-01'), $gatewayTransactions);

    expect($batch->total_transactions_processed)->toBe(1)
        ->and($batch->total_discrepancies_found)->toBe(1)
        ->and($batch->status)->toBe('COMPLETED_WITH_DISCREPANCIES');

    $this->assertDatabaseHas('reconciliation_discrepancies', [
        'reconciliation_batch_id' => $batch->id,
        'transaction_reference' => 'TRX-001',
        'system_amount_cents' => 1000,
        'gateway_amount_cents' => 1200,
        'reason' => 'AMOUNT_MISMATCH',
    ]);
});
```

### 6.3 Architecture Tests (Pest v3 Arch Testing)

Arsitektur yang bersih harus ditegakkan melalui CI/CD.

```php
// tests/Arch/DomainArchitectureTest.php
declare(strict_types=1);

arch('DTOs should be readonly classes')
    ->expect('App\Domain\*\DTOs')
    ->toBeClasses()
    ->toBeReadonly();

arch('Repositories must be implemented by Infrastructure')
    ->expect('App\Domain\*\Repositories')
    ->toBeInterfaces();

arch('Domain layer should not depend on external Framework facades (except core support)')
    ->expect('App\Domain')
    ->not->toUse(['Illuminate\Http', 'Illuminate\Routing', 'Illuminate\Support\Facades\Request']);

arch('Models must not contain business logic (No domain actions)')
    ->expect('App\Models')
    ->not->toUse('App\Domain\*\Actions');

arch('Strict types must be enforced everywhere')
    ->expect('App')
    ->toUseStrictTypes();
```
