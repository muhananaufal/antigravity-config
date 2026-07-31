# Laravel Mastery: Database Locking (Pessimistic & Optimistic)

Pada aplikasi dengan *concurrency* tinggi (seperti *flash sale*, sistem *ticketing*, atau *fintech* e-wallet), banyak transaksi akan mencoba mengubah data yang sama (*row*) di *database* pada saat bersamaan. Jika tidak ada mekanisme *locking* pada level *database*, akan terjadi **Lost Updates** atau nilai data menjadi tidak konsisten.

Dokumen ini mendalami teknik *Pessimistic Locking* (via SQL `FOR UPDATE`) dan *Optimistic Locking* (via *Version Control*) menggunakan ekosistem Laravel 11/12 dengan PHP 8.3/8.4, menerapkan standar arsitektur **Top 1%**.

## 1. Pessimistic vs Optimistic Locking

- **Pessimistic Locking (`lockForUpdate()` / `sharedLock()`)**: Mencegah proses lain membaca/menulis baris (*row*) database sampai transaksi saat ini selesai. Digunakan untuk data kritikal (saldo bank, kuota tiket) di mana *conflict rate* tinggi.
- **Optimistic Locking**: Tidak mengunci *database*. Sebaliknya, menggunakan kolom `version` atau `updated_at`. Saat *save*, akan diverifikasi apakah `version` masih sama dengan saat pertama kali dibaca. Jika beda, transaksi ditolak (*throw Exception*). Digunakan untuk sistem di mana peluang konflik (*collision*) rendah.

---

## 2. Implementasi Pessimistic Locking (Clean Architecture)

Contoh kasus: Pembelian tiket konser (*Flash Sale*).

### 2.1 Model & Migration
Tidak ada modifikasi skema yang diperlukan untuk Pessimistic Locking, ia sepenuhnya bergantung pada *Database Engine* (mis. InnoDB di MySQL / PostgreSQL).

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

final class ConcertTicket extends Model
{
    protected $fillable = ['concert_id', 'available_quota', 'price'];
}
```

### 2.2 DTO
```php
<?php

declare(strict_types=1);

namespace App\DTOs\Concert;

final readonly class PurchaseTicketDTO
{
    public function __construct(
        public string $concertId,
        public int $quantity,
        public string $userId,
    ) {}
}
```

### 2.3 Action (Business Logic)
Logika *locking* harus ditempatkan di dalam *Database Transaction* untuk bekerja.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Concert;

use App\DTOs\Concert\PurchaseTicketDTO;
use App\Models\ConcertTicket;
use Illuminate\Support\Facades\DB;
use App\Exceptions\Concert\SoldOutException;
use App\Exceptions\Concert\TicketNotFoundException;

final class PurchaseTicketAction
{
    /**
     * @throws SoldOutException
     * @throws TicketNotFoundException
     * @throws \Throwable
     */
    public function execute(PurchaseTicketDTO $dto): bool
    {
        // Membungkus dalam database transaction agar lock di-release otomatis saat commit/rollback
        return DB::transaction(function () use ($dto) {
            
            // lockForUpdate() akan menerjemahkan ke 'SELECT ... FOR UPDATE'
            // row ini tidak bisa dibaca atau dimodifikasi oleh transaksi lain (Pessimistic)
            $ticket = ConcertTicket::where('concert_id', $dto->concertId)
                ->lockForUpdate()
                ->first();

            if (! $ticket) {
                throw new TicketNotFoundException('Concert ticket not found.');
            }

            if ($ticket->available_quota < $dto->quantity) {
                throw new SoldOutException('Not enough tickets available.');
            }

            // Pengurangan yang aman karena sudah di-lock
            $ticket->available_quota -= $dto->quantity;
            $ticket->save();

            // Insert ke tabel pemesanan...
            DB::table('orders')->insert([
                'concert_id' => $dto->concertId,
                'user_id' => $dto->userId,
                'qty' => $dto->quantity,
                'created_at' => now(),
            ]);

            return true;
            
        }, 3); // Coba retry transaksi maksimal 3 kali jika terjadi deadlock
    }
}
```

---

## 3. Anti-Patterns & Best Practices (Pessimistic)

### 3.1 Anti-Pattern 1: Menggunakan Pessimistic Lock Tanpa Transaction

❌ **KODE SALAH (Locking tidak bekerja)**
```php
<?php
public function deductBalance(int $userId, float $amount): void
{
    // SALAH! lockForUpdate() dipanggil di luar DB::transaction.
    // Lock akan langsung dilepas sesaat setelah query eksekusi karena tidak ada transaksi yang mengikatnya.
    $wallet = Wallet::where('user_id', $userId)->lockForUpdate()->first();
    
    if ($wallet->balance >= $amount) {
        $wallet->balance -= $amount;
        $wallet->save();
    }
}
```
**Mengapa Berbahaya:** Konsep `FOR UPDATE` di level SQL hanya valid dalam satu sesi transaksi yang aktif. Tanpa transaksi, *engine database* akan menggunakan *autocommit*, menyebabkan *lock* langsung terlepas seketika setelah `SELECT`. Hasilnya? *Race condition* tetap terjadi, dan uang digital (*balance*) bisa minus!

✅ **KODE BENAR (Menggunakan `DB::transaction`)**
```php
<?php
public function deductBalance(int $userId, float $amount): void
{
    DB::transaction(function () use ($userId, $amount) {
        $wallet = Wallet::where('user_id', $userId)->lockForUpdate()->first();
        
        if ($wallet->balance >= $amount) {
            $wallet->balance -= $amount;
            $wallet->save();
        } else {
            throw new InsufficientBalanceException();
        }
    });
}
```

### 3.2 Anti-Pattern 2: N+1 Locking / Full Table Scan Lock

❌ **KODE SALAH (Table Lock & N+1 Lock)**
```php
<?php
DB::transaction(function () {
    // SALAH: Jika tidak menggunakan indeks dengan benar atau mengambil terlalu banyak data,
    // Database bisa mengubah row lock menjadi TABLE LOCK (mengunci seluruh tabel).
    $allWallets = Wallet::lockForUpdate()->get();
    
    foreach ($allWallets as $wallet) {
        $wallet->balance += 10;
        $wallet->save();
    }
});
```
**Mengapa Berbahaya:** Mengambil ribuan baris dengan `lockForUpdate` akan menyebabkan *locking* masif pada *database*. Pada *MySQL/InnoDB*, jika klausa `WHERE` tidak menggunakan *Index*, ia akan jatuh pada *Table Lock*, menghentikan seluruh sistem yang berinteraksi dengan tabel `wallets`. Selain itu, proses ini berisiko kehabisan memori.

✅ **KODE BENAR (Batch Update / Raw Update)**
```php
<?php
// Jauh lebih cepat, atomik, dan menggunakan internal lock database secara aman
Wallet::where('status', 'active')
      ->update(['balance' => DB::raw('balance + 10')]);
```

---

## 4. Implementasi Optimistic Locking

*Optimistic Locking* mencegah manipulasi ganda di Laravel. Laravel tidak menyediakannya secara *native* di *Eloquent* (harus pakai *package* pihak ketiga atau implementasi manual). Kita akan melakukan implementasi *native clean approach*.

### 4.1 Schema Migration
Tambahkan kolom `version` bertipe integer.

### 4.2 Model Trait Implementation
```php
<?php

declare(strict_types=1);

namespace App\Traits;

use App\Exceptions\Database\StaleObjectException;

trait OptimisticLocking
{
    public function bootOptimisticLocking(): void
    {
        static::updating(function ($model) {
            $expectedVersion = $model->getOriginal('version');
            $newVersion = $expectedVersion + 1;

            $affectedRows = $model->newQuery()
                ->where($model->getKeyName(), $model->getKey())
                ->where('version', $expectedVersion)
                ->update(['version' => $newVersion]);

            if ($affectedRows === 0) {
                throw new StaleObjectException('Record has been modified by another process.');
            }

            // Sync the model's new version in memory
            $model->version = $newVersion;
            
            // Return false to prevent normal save() since we already manually updated version
            // Or alternatively, let the normal save proceed by injecting the new version into attributes.
            // For true optimistic lock, you manipulate the Builder instance in updating.
        });
    }
}
```

---

## 5. Pest v3 Testing (Architecture & Feature)

Kita wajib menulis unit/feature test untuk mensimulasikan *Pessimistic Locking* dan *Transaction deadlock retry*.

### 5.1 Architecture Testing (`tests/ArchTest.php`)
```php
<?php

declare(strict_types=1);

arch('models should not use lock methods outside transactions')
    // Ini konsep lanjutan, kita asumsikan rule Pest kustom atau review statis
    ->preset()->php();
```

### 5.2 Feature Testing (`tests/Feature/Actions/PurchaseTicketActionTest.php`)
```php
<?php

declare(strict_types=1);

use App\Actions\Concert\PurchaseTicketAction;
use App\DTOs\Concert\PurchaseTicketDTO;
use App\Models\ConcertTicket;
use App\Exceptions\Concert\SoldOutException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;

uses(RefreshDatabase::class);

it('decreases ticket quota atomically using pessimistic locking', function () {
    // Arrange
    $ticket = ConcertTicket::create([
        'concert_id' => 'BTS-2027',
        'available_quota' => 10,
        'price' => 1000,
    ]);

    $dto = new PurchaseTicketDTO('BTS-2027', 2, 'user-999');
    $action = app(PurchaseTicketAction::class);

    // Act
    $result = $action->execute($dto);

    // Assert
    expect($result)->toBeTrue();
    
    $ticket->refresh();
    expect($ticket->available_quota)->toBe(8);
    
    $this->assertDatabaseHas('orders', [
        'concert_id' => 'BTS-2027',
        'user_id' => 'user-999',
        'qty' => 2,
    ]);
});

it('throws SoldOutException if quota is insufficient', function () {
    // Arrange
    ConcertTicket::create([
        'concert_id' => 'COLDPLAY-2028',
        'available_quota' => 1,
        'price' => 1000,
    ]);

    $dto = new PurchaseTicketDTO('COLDPLAY-2028', 2, 'user-999');
    $action = app(PurchaseTicketAction::class);

    // Act & Assert
    expect(fn () => $action->execute($dto))
        ->toThrow(SoldOutException::class, 'Not enough tickets available.');
        
    $this->assertDatabaseMissing('orders', [
        'user_id' => 'user-999',
    ]);
});
```

## 6. Kesimpulan

- Selalu gunakan `DB::transaction` saat mengoperasikan `lockForUpdate()` atau `sharedLock()`. Tanpanya, *lock* tidak akan bekerja.
- `lockForUpdate()` (Pessimistic) cocok untuk entitas berisiko tinggi (*Financial*, *Inventory*) dengan durasi transaksi yang SANGAT SINGKAT.
- Minimalkan operasi non-database (misal: *API Calls*, *Email Sending*) di dalam blok transaksi yang terdapat `lockForUpdate()`, karena akan memblokir tabel/baris terlalu lama. Pindahkan operasi eksternal ke luar blok `DB::transaction`.
