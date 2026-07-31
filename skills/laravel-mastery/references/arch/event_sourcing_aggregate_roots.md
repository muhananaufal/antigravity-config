# Event Sourcing & Aggregate Roots di Laravel (Top 1% Quality)

## 1. Teori Mendalam (Deep Theory)

### Apa itu Event Sourcing?
Secara konvensional, aplikasi menyimpan status (state) terkini dari sebuah entitas di dalam database. Jika sebuah data diubah, data lama akan ditimpa (overwrite). Event Sourcing mengubah paradigma ini dengan menyimpan *semua* kejadian (event) yang pernah terjadi secara berurutan. State terkini dari sebuah entitas diperoleh dengan memutar kembali (replaying) semua event tersebut dari awal hingga akhir. Ini memberikan jejak audit (audit trail) yang sempurna, kemampuan "time travel" untuk debugging, dan kemampuan untuk memproyeksikan data ke dalam berbagai bentuk tabel pembacaan (read models / CQRS).

### Apa itu Aggregate Root?
Aggregate Root adalah konsep utama dalam Domain-Driven Design (DDD). Aggregate adalah sekelompok entitas dan value objects yang berelasi dan diperlakukan sebagai satu kesatuan dalam perubahan data. Aggregate Root adalah entitas utama (pintu gerbang) di dalam Aggregate tersebut. Setiap interaksi dan perubahan state pada bagian manapun di dalam Aggregate *harus* melalui Aggregate Root. Hal ini memastikan integritas transaksional dan menjaga invarian (aturan bisnis) agar tidak terlanggar.

Dalam konteks Event Sourcing, Aggregate Root bertugas menerima Command (niat untuk mengubah), memvalidasi aturan bisnis, dan merekam Event (fakta yang sudah terjadi). Aggregate Root kemudian mengubah state internalnya (apply event) tanpa menyentuh database secara langsung. Event yang direkam (uncommitted events) baru akan disimpan ke dalam Event Store oleh infrastruktur.

### Kapan Menggunakan Event Sourcing?
- **Sistem Keuangan/Fintech:** Membutuhkan jejak audit absolut (misal: saldo dompet dihitung dari seluruh mutasi).
- **Logistik & Supply Chain:** Pelacakan perubahan status barang secara kronologis.
- **Sistem dengan Aturan Bisnis Kompleks:** Dimana "bagaimana sebuah state dicapai" sama pentingnya dengan "state saat ini".

## 2. Arsitektur Komprehensif dengan Clean Architecture

Kita akan menggunakan pendekatan Clean Architecture (FormRequest -> Controller -> Action -> AggregateRoot). Dalam ekosistem Laravel, kita sering menggunakan package seperti `spatie/laravel-event-sourcing` untuk menangani infrastruktur Event Store, Replaying, Projections, dan Reactors.

- **Command:** Representasi niat dari user (contoh: `TransferFundsCommand`).
- **Aggregate Root:** Domain model yang mengeksekusi logika bisnis dan me-record events.
- **Event:** Fakta tak terbantahkan bahwa sesuatu telah terjadi (contoh: `FundsTransferred`).
- **Projection (Read Model):** Listener yang mendengarkan event dan memperbarui tabel database standar (untuk keperluan query/baca yang cepat).
- **Reactor (Side Effects):** Listener yang mendengarkan event dan memicu side-effect (seperti mengirim email, memanggil API eksternal).

## 3. Anti-Patterns & Best Practices

### ❌ Anti-Pattern 1: Memasukkan Side-Effects ke dalam Aggregate Root
Mengirim email atau memanggil API eksternal secara langsung dari dalam fungsi `apply` di Aggregate Root sangat berbahaya. Ketika event di-replay (misalnya untuk membangun ulang database pembacaan), fungsi `apply` akan dipanggil berulang kali. Jika ada pemanggilan API di sana, API eksternal akan dipanggil ratusan kali, menyebabkan kekacauan.

```php
declare(strict_types=1);

namespace App\Domain\Wallet\Aggregates;

use Spatie\EventSourcing\AggregateRoots\AggregateRoot;

class WrongWalletAggregate extends AggregateRoot
{
    public function addMoney(int $amount): static
    {
        $this->recordThat(new MoneyAdded($amount));
        return $this;
    }

    // ❌ SANGAT BERBAHAYA: State mutation bercampur side effect!
    public function applyMoneyAdded(MoneyAdded $event): void
    {
        $this->balance += $event->amount;
        
        // JIKA EVENT DI-REPLAY, EMAIL INI AKAN TERKIRIM BERKALI-KALI!
        Mail::to('user@example.com')->send(new MoneyAddedEmail($event->amount)); 
    }
}
```

### ✅ Best Practice 1: Memisahkan Side-Effects menggunakan Reactor
Gunakan Reactor untuk semua side-effects. Reactor hanya dipanggil saat event *pertama kali* terjadi dan masuk ke event store, dan *tidak* akan dipanggil saat proses event replay.

```php
declare(strict_types=1);

namespace App\Domain\Wallet\Reactors;

use App\Domain\Wallet\Events\MoneyAdded;
use Illuminate\Support\Facades\Mail;
use Illuminate\Contracts\Queue\ShouldQueue;
use Spatie\EventSourcing\EventHandlers\Reactors\Reactor;

final class SendEmailOnMoneyAddedReactor extends Reactor implements ShouldQueue
{
    public function onMoneyAdded(MoneyAdded $event): void
    {
        // ✅ AMAN: Reactor tidak dipanggil saat replay.
        Mail::to('user@example.com')->send(new MoneyAddedEmail($event->amount));
    }
}
```

### ❌ Anti-Pattern 2: Aggregate Root Terlalu Besar (God Object) / Membawa Data Terlalu Banyak
Memasukkan seluruh data aplikasi ke dalam satu Aggregate (misalnya `UserAggregate` yang menyimpan profile, wallet, cart, dan orders sekaligus). Ini menyebabkan konkurensi (Concurrency Exception) sangat tinggi karena semua perubahan harus mengunci root yang sama. Selain itu, event menjadi terlalu besar dan memakan memori berlebih (Memory Risk).

```php
declare(strict_types=1);

namespace App\Domain\Shop\Aggregates;

use Spatie\EventSourcing\AggregateRoots\AggregateRoot;

class GodUserAggregate extends AggregateRoot
{
    // ❌ MEMORY RISK: Menyimpan ratusan history transaksi ke array.
    public array $walletTransactions = [];
    public array $orderHistory = [];

    public function checkout(array $cartItems): static
    {
        // ...
        $this->recordThat(new OrderPlaced($cartItems));
        return $this;
    }
}
```

### ✅ Best Practice 2: Aggregate yang Ramping (Small Aggregates)
Pecah Aggregate menjadi bagian-bagian kecil yang hanya menjaga invarian transaksional masing-masing. Jangan menyimpan list data (array) tak terbatas di properti Aggregate. Hanya simpan state minimal yang dibutuhkan untuk memvalidasi aturan bisnis (misalnya saldo total, bukan list history).

```php
declare(strict_types=1);

namespace App\Domain\Wallet\Aggregates;

use Spatie\EventSourcing\AggregateRoots\AggregateRoot;

final class WalletAggregate extends AggregateRoot
{
    // ✅ AMAN: Hanya menyimpan total balance, memory sangat efisien.
    private int $balance = 0;
    
    // ...
}
```

## 4. Implementasi Production-Ready: Sistem Dompet (Wallet System)

Di bawah ini adalah kode komprehensif, strongly typed dengan PHP 8.3/8.4, Laravel 11, clean architecture dan library `spatie/laravel-event-sourcing`.

### 4.1. Domain Events

```php
declare(strict_types=1);

namespace App\Domain\Wallet\Events;

use Spatie\EventSourcing\StoredEvents\ShouldBeStored;

final class WalletCreated extends ShouldBeStored
{
    public function __construct(
        public readonly string $walletUuid,
        public readonly string $userUuid,
        public readonly string $currency
    ) {}
}
```

```php
declare(strict_types=1);

namespace App\Domain\Wallet\Events;

use Spatie\EventSourcing\StoredEvents\ShouldBeStored;

final class FundsDeposited extends ShouldBeStored
{
    public function __construct(
        public readonly string $walletUuid,
        public readonly int $amount,
        public readonly string $reference
    ) {}
}
```

```php
declare(strict_types=1);

namespace App\Domain\Wallet\Events;

use Spatie\EventSourcing\StoredEvents\ShouldBeStored;

final class FundsWithdrawn extends ShouldBeStored
{
    public function __construct(
        public readonly string $walletUuid,
        public readonly int $amount,
        public readonly string $reference
    ) {}
}
```

### 4.2. Aggregate Root (Core Business Logic)

```php
declare(strict_types=1);

namespace App\Domain\Wallet\Aggregates;

use App\Domain\Wallet\Events\FundsDeposited;
use App\Domain\Wallet\Events\FundsWithdrawn;
use App\Domain\Wallet\Events\WalletCreated;
use DomainException;
use Spatie\EventSourcing\AggregateRoots\AggregateRoot;

final class WalletAggregate extends AggregateRoot
{
    private bool $isCreated = false;
    private int $balance = 0;
    private string $currency = 'IDR';

    public function createWallet(string $userUuid, string $currency): static
    {
        if ($this->isCreated) {
            throw new DomainException("Wallet already exists.");
        }

        $this->recordThat(new WalletCreated($this->uuid(), $userUuid, $currency));

        return $this;
    }

    public function deposit(int $amount, string $reference): static
    {
        if (! $this->isCreated) {
            throw new DomainException("Wallet has not been created.");
        }

        if ($amount <= 0) {
            throw new DomainException("Deposit amount must be greater than zero.");
        }

        $this->recordThat(new FundsDeposited($this->uuid(), $amount, $reference));

        return $this;
    }

    public function withdraw(int $amount, string $reference): static
    {
        if (! $this->isCreated) {
            throw new DomainException("Wallet has not been created.");
        }

        if ($amount <= 0) {
            throw new DomainException("Withdraw amount must be greater than zero.");
        }

        if ($this->balance < $amount) {
            throw new DomainException("Insufficient funds.");
        }

        $this->recordThat(new FundsWithdrawn($this->uuid(), $amount, $reference));

        return $this;
    }

    // --- State Mutators (Apply Functions) ---
    // Ingat: fungsi apply tidak boleh memiliki logic pengecekan IF (logic ada di metode atas)
    // dan sama sekali tidak boleh ada side effects (seperti HTTP Request, Email, DB Queries).

    protected function applyWalletCreated(WalletCreated $event): void
    {
        $this->isCreated = true;
        $this->currency = $event->currency;
    }

    protected function applyFundsDeposited(FundsDeposited $event): void
    {
        $this->balance += $event->amount;
    }

    protected function applyFundsWithdrawn(FundsWithdrawn $event): void
    {
        $this->balance -= $event->amount;
    }
}
```

### 4.3. Projection (Read Model)

Projection bertanggung jawab mendengarkan event dan menulis data ke tabel yang biasa dibaca oleh user (misalnya tabel Eloquent `wallets`).

```php
declare(strict_types=1);

namespace App\Domain\Wallet\Projections;

use App\Domain\Wallet\Events\FundsDeposited;
use App\Domain\Wallet\Events\FundsWithdrawn;
use App\Domain\Wallet\Events\WalletCreated;
use App\Models\Wallet;
use Spatie\EventSourcing\EventHandlers\Projectors\Projector;

final class WalletBalanceProjector extends Projector
{
    public function onWalletCreated(WalletCreated $event): void
    {
        Wallet::query()->create([
            'uuid' => $event->walletUuid,
            'user_uuid' => $event->userUuid,
            'currency' => $event->currency,
            'balance' => 0,
        ]);
    }

    public function onFundsDeposited(FundsDeposited $event): void
    {
        Wallet::query()
            ->where('uuid', $event->walletUuid)
            ->increment('balance', $event->amount);
    }

    public function onFundsWithdrawn(FundsWithdrawn $event): void
    {
        Wallet::query()
            ->where('uuid', $event->walletUuid)
            ->decrement('balance', $event->amount);
    }
}
```

### 4.4. Actions (Application Service)

Action membungkus pemanggilan ke AggregateRoot dan menyimpannya. Di sini kita memfasilitasi Clean Architecture agar Controller tetap kurus.

```php
declare(strict_types=1);

namespace App\Domain\Wallet\Actions;

use App\Domain\Wallet\Aggregates\WalletAggregate;
use Illuminate\Support\Str;

final class DepositFundsAction
{
    public function execute(string $walletUuid, int $amount, string $reference): string
    {
        // 1. Retrieve or create the aggregate root
        $wallet = WalletAggregate::retrieve($walletUuid);

        // 2. Invoke behavior on the aggregate root
        $wallet->deposit($amount, $reference);

        // 3. Persist the newly recorded events to the Event Store
        $wallet->persist();

        return $walletUuid;
    }
}
```

### 4.5. Controller & Form Request (HTTP Layer)

```php
declare(strict_types=1);

namespace App\Http\Requests\Wallet;

use Illuminate\Foundation\Http\FormRequest;

final class DepositRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'wallet_uuid' => ['required', 'uuid'],
            'amount' => ['required', 'integer', 'min:1'],
            'reference' => ['required', 'string', 'max:255'],
        ];
    }
}
```

```php
declare(strict_types=1);

namespace App\Http\Controllers\Wallet;

use App\Domain\Wallet\Actions\DepositFundsAction;
use App\Http\Controllers\Controller;
use App\Http\Requests\Wallet\DepositRequest;
use Illuminate\Http\JsonResponse;

final class DepositController extends Controller
{
    public function __construct(
        private readonly DepositFundsAction $depositAction,
    ) {}

    public function __invoke(DepositRequest $request): JsonResponse
    {
        $validated = $request->validated();

        $this->depositAction->execute(
            walletUuid: $validated['wallet_uuid'],
            amount: (int) $validated['amount'],
            reference: $validated['reference']
        );

        return response()->json([
            'message' => 'Deposit successful. Events are being processed.',
            'data' => [
                'wallet_uuid' => $validated['wallet_uuid'],
            ],
        ], 202); // 202 Accepted, as projection might be async (queued)
    }
}
```

## 5. Edge Cases & High Availability

### Snapshots
Membaca event (replaying) dari awal untuk merekonstruksi state aggregate bisa sangat lambat jika entitas memiliki ribuan events. Solusinya adalah membuat Snapshot secara periodik. Snapshot menyimpan representasi "state saat ini". Dengan snapshot, kita hanya me-replay events yang terjadi *setelah* snapshot terakhir diambil.

```php
declare(strict_types=1);

namespace App\Domain\Wallet\Aggregates;

use Spatie\EventSourcing\AggregateRoots\AggregateRoot;
use Spatie\EventSourcing\Snapshots\Snapshot;

final class WalletAggregate extends AggregateRoot
{
    // Snapshotting methods available in Spatie Event Sourcing
    // You typically dispatch a command or job to snapshot aggregates 
    // that have more than 1000 events.
}
```

### Optimistic Concurrency Control (OCC)
Jika dua thread mengeksekusi Aggregate Root yang sama di saat bersamaan, keduanya bisa menulis event dan mengakibatkan saldo kacau. Aggregate Root di `spatie/laravel-event-sourcing` mendukung pengecekan versi (version checking) untuk menjamin inkonsistensi tidak terjadi.

Ketika `persist()` dipanggil, event akan menyimpan versi aggregate saat ini. Jika dalam jeda tersebut versi di database telah berubah (thread lain telah menyimpan sesuatu), ia akan melempar `ConcurrencyException`, dan request bisa di-retry otomatis.

## 6. Unit & Architecture Testing (Pest v3)

Berikut adalah pengujian menyeluruh (Unit & Architecture) menggunakan framework Pest v3 (Top 1% Quality standard).

### 6.1. Architecture Testing (`tests/Arch/DomainArchitectureTest.php`)

```php
declare(strict_types=1);

use Spatie\EventSourcing\AggregateRoots\AggregateRoot;
use Spatie\EventSourcing\EventHandlers\Projectors\Projector;
use Spatie\EventSourcing\EventHandlers\Reactors\Reactor;

it('ensures aggregate roots extend the base AggregateRoot')
    ->expect('App\Domain\*\Aggregates')
    ->toBeClasses()
    ->toExtend(AggregateRoot::class)
    ->toHaveMethod('apply*');

it('ensures projectors extend Projector')
    ->expect('App\Domain\*\Projections')
    ->toBeClasses()
    ->toExtend(Projector::class);

it('ensures reactors extend Reactor')
    ->expect('App\Domain\*\Reactors')
    ->toBeClasses()
    ->toExtend(Reactor::class);

it('ensures domain layers do not depend on HTTP controllers')
    ->expect('App\Domain')
    ->toNotUse('App\Http');

it('ensures actions do not use facades directly (dependency injection preferred)')
    ->expect('App\Domain\*\Actions')
    ->toNotUse('Illuminate\Support\Facades');
```

### 6.2. Aggregate Unit Testing (`tests/Unit/WalletAggregateTest.php`)

Kita bisa memverifikasi bahwa sebuah aksi mencatatkan event dengan benar (Arrange-Act-Assert pada Event Sourcing).

```php
declare(strict_types=1);

use App\Domain\Wallet\Aggregates\WalletAggregate;
use App\Domain\Wallet\Events\FundsDeposited;
use App\Domain\Wallet\Events\FundsWithdrawn;
use App\Domain\Wallet\Events\WalletCreated;
use Illuminate\Support\Str;

test('it creates a new wallet successfully', function () {
    $walletUuid = Str::uuid()->toString();
    $userUuid = Str::uuid()->toString();

    WalletAggregate::fake($walletUuid)
        ->given([]) // No prior events
        ->when(function (WalletAggregate $wallet) use ($userUuid) {
            $wallet->createWallet($userUuid, 'IDR');
        })
        ->assertRecorded(new WalletCreated($walletUuid, $userUuid, 'IDR'));
});

test('it prevents creating a wallet that already exists', function () {
    $walletUuid = Str::uuid()->toString();
    $userUuid = Str::uuid()->toString();

    WalletAggregate::fake($walletUuid)
        ->given([
            new WalletCreated($walletUuid, $userUuid, 'IDR'),
        ])
        ->when(function (WalletAggregate $wallet) use ($userUuid) {
            $wallet->createWallet($userUuid, 'IDR');
        })
        ->assertNotRecorded(WalletCreated::class)
        ->assertException(DomainException::class, 'Wallet already exists.');
});

test('it can deposit funds to an existing wallet', function () {
    $walletUuid = Str::uuid()->toString();
    $userUuid = Str::uuid()->toString();

    WalletAggregate::fake($walletUuid)
        ->given([
            new WalletCreated($walletUuid, $userUuid, 'IDR'),
        ])
        ->when(function (WalletAggregate $wallet) {
            $wallet->deposit(50000, 'DEP-001');
        })
        ->assertRecorded(new FundsDeposited($walletUuid, 50000, 'DEP-001'));
});

test('it fails to withdraw if insufficient funds', function () {
    $walletUuid = Str::uuid()->toString();
    $userUuid = Str::uuid()->toString();

    WalletAggregate::fake($walletUuid)
        ->given([
            new WalletCreated($walletUuid, $userUuid, 'IDR'),
            new FundsDeposited($walletUuid, 10000, 'DEP-001'),
        ])
        ->when(function (WalletAggregate $wallet) {
            $wallet->withdraw(15000, 'WD-001');
        })
        ->assertNotRecorded(FundsWithdrawn::class)
        ->assertException(DomainException::class, 'Insufficient funds.');
});

test('it can withdraw if funds are sufficient', function () {
    $walletUuid = Str::uuid()->toString();
    $userUuid = Str::uuid()->toString();

    WalletAggregate::fake($walletUuid)
        ->given([
            new WalletCreated($walletUuid, $userUuid, 'IDR'),
            new FundsDeposited($walletUuid, 50000, 'DEP-001'),
        ])
        ->when(function (WalletAggregate $wallet) {
            $wallet->withdraw(20000, 'WD-001');
        })
        ->assertRecorded(new FundsWithdrawn($walletUuid, 20000, 'WD-001'));
});
```

### 6.3. Projection Testing (`tests/Unit/WalletBalanceProjectorTest.php`)

Projection perlu ditest untuk menjamin logic penambahan dan pengurangan saldo masuk ke Eloquent Model dengan benar.

```php
declare(strict_types=1);

use App\Domain\Wallet\Events\FundsDeposited;
use App\Domain\Wallet\Events\WalletCreated;
use App\Domain\Wallet\Projections\WalletBalanceProjector;
use App\Models\Wallet;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;

uses(RefreshDatabase::class);

test('it projects wallet creation', function () {
    $walletUuid = Str::uuid()->toString();
    $userUuid = Str::uuid()->toString();
    
    $event = new WalletCreated($walletUuid, $userUuid, 'USD');
    $projector = new WalletBalanceProjector();
    
    $projector->onWalletCreated($event);
    
    expect(Wallet::query()->count())->toBe(1)
        ->and(Wallet::first()->uuid)->toBe($walletUuid)
        ->and(Wallet::first()->balance)->toBe(0);
});

test('it projects funds deposition', function () {
    $walletUuid = Str::uuid()->toString();
    
    // Create base read model
    Wallet::factory()->create([
        'uuid' => $walletUuid,
        'balance' => 0,
    ]);
    
    $event = new FundsDeposited($walletUuid, 10000, 'DEP-123');
    $projector = new WalletBalanceProjector();
    
    $projector->onFundsDeposited($event);
    
    expect(Wallet::where('uuid', $walletUuid)->first()->balance)->toBe(10000);
});
```

## Ringkasan (TL;DR)
1. **Aggregate Root:** Titik masuk utama untuk operasi logika bisnis. Melindungi integritas data.
2. **Commands:** Niat untuk merubah state.
3. **Events:** Fakta sejarah mutlak bahwa perubahan telah terjadi.
4. **Projections:** Model baca (CQRS), mendengarkan event dan membangun state table.
5. **Reactors:** Menangani side-effects tanpa berdampak saat replaying.
6. **Security & Memory:** Jaga agar aggregate kecil (small aggregates), hindari mutasi global, dan gunakan optimistic concurrency control jika perlu.
