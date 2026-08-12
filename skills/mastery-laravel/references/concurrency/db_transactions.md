# Laravel Mastery: Database Transactions (Concurrency)

*Database Transactions* memastikan bahwa satu set kueri database bekerja secara **Atomik** (Prinsip ACID). Artinya, semua operasi dalam transaksi tersebut sukses sepenuhnya, atau jika satu saja gagal, keseluruhan operasi dibatalkan (*rolled back*). Ini vital untuk mencegah data yang korup sebagian (misalnya uang keluar dari pengirim, tetapi sistem crash sebelum masuk ke penerima).

Di lingkungan *high concurrency*, cara Anda merancang dan memanggil transaksi akan menentukan performa dan keandalan sistem. Panduan *Top 1% Quality* ini membahas penerapan, mitigasi *deadlock*, dan arsitektur *Clean Laravel*.

## 1. Arsitektur & Transaksi Database

Transaksi database idealnya diletakkan di **Action Layer** (jika mengatur koordinasi antar berbagai entitas/repository) atau **Repository Layer** (jika hanya spesifik ke satu agregat data). Tidak boleh ada pemanggilan transaksi di *Controller*.

### 1.1 Implementasi Clean Architecture: Transfer Dana

Berikut adalah contoh transfer dana dompet digital (*e-wallet*) yang menuntut keandalan 100%.

#### A. DTO
```php
<?php

declare(strict_types=1);

namespace App\DTOs\Wallet;

final readonly class TransferFundsDTO
{
    public function __construct(
        public string $senderId,
        public string $receiverId,
        public float $amount,
    ) {}
}
```

#### B. Action (Transaction Management)
```php
<?php

declare(strict_types=1);

namespace App\Actions\Wallet;

use App\DTOs\Wallet\TransferFundsDTO;
use App\Models\Wallet;
use App\Models\TransactionHistory;
use Illuminate\Support\Facades\DB;
use App\Exceptions\Wallet\InsufficientBalanceException;
use App\Exceptions\Wallet\WalletNotFoundException;

final class TransferFundsAction
{
    /**
     * @throws InsufficientBalanceException
     * @throws WalletNotFoundException
     * @throws \Throwable
     */
    public function execute(TransferFundsDTO $dto): bool
    {
        // DB::transaction dengan argumen kedua "3" berarti:
        // Jika terjadi Deadlock, Laravel akan otomatis meretry transaksi ini maksimal 3 kali.
        return DB::transaction(function () use ($dto) {
            
            // Lock for update wajib untuk mencegah Race Conditions saat transfer bersamaan
            // Pastikan mengambil record berurutan untuk mencegah Deadlock silang.
            // Contoh pengurutan:
            $walletIds = [$dto->senderId, $dto->receiverId];
            sort($walletIds); // Sortir ID untuk menghindari deadlock A->B vs B->A
            
            // Penguncian terurut (Mencegah Deadlock)
            Wallet::whereIn('id', $walletIds)->lockForUpdate()->get();
            
            $senderWallet = Wallet::find($dto->senderId);
            $receiverWallet = Wallet::find($dto->receiverId);

            if (! $senderWallet || ! $receiverWallet) {
                throw new WalletNotFoundException('One of the wallets does not exist.');
            }

            if ($senderWallet->balance < $dto->amount) {
                throw new InsufficientBalanceException('Sender balance is insufficient.');
            }

            // Deduct & Add
            $senderWallet->balance -= $dto->amount;
            $receiverWallet->balance += $dto->amount;
            
            $senderWallet->save();
            $receiverWallet->save();

            // Record history
            TransactionHistory::create([
                'sender_id' => $dto->senderId,
                'receiver_id' => $dto->receiverId,
                'amount' => $dto->amount,
                'status' => 'success',
            ]);

            return true;

        }, 3);
    }
}
```

---

## 2. Anti-Patterns & Best Practices

Memahami apa yang *tidak boleh* dilakukan sama pentingnya dengan mengetahui apa yang *harus* dilakukan.

### 2.1 Anti-Pattern 1: Menyisipkan Operasi Eksternal Lambat (I/O) di Dalam Transaksi

❌ **KODE SALAH (Memblokir Database)**
```php
<?php
DB::transaction(function () use ($user) {
    // 1. Kunci Baris
    $order = Order::where('id', $orderId)->lockForUpdate()->first();
    
    // 2. Operasi database ringan
    $order->status = 'paid';
    $order->save();
    
    // SALAH! Memanggil API eksternal di dalam blok Transaksi Database!
    // Jika API stripe delay 5 detik, row "Order" akan terkunci 5 detik, 
    // memblokir semua proses background lain yang butuh mengakses order ini!
    $stripeResponse = Http::post('https://api.stripe.com/charge', [...]); 
    
    // SALAH! Mengirim email sinkron
    Mail::to($user)->send(new OrderPaid($order)); 
});
```
**Mengapa Berbahaya:** Koneksi *Database* dan memori *Lock* sangat mahal. Menggunakan fungsi I/O lambat (*cURL HTTP*, pengiriman surel sinkron, memanipulasi *file*) dalam transaksi menyebabkan transaksi berumur panjang (*Long-lived Transactions*). Ini memicu penumpukan koneksi MySQL, *lock wait timeout*, dan akhirnya *database crash*.

✅ **KODE BENAR (Dispatcher / After Commit)**
```php
<?php
DB::transaction(function () use ($orderId, $user) {
    $order = Order::where('id', $orderId)->lockForUpdate()->first();
    $order->status = 'paid';
    $order->save();

    // Gunakan Job yang akan di-dispatch hanya JIKA transaksi database sukses.
    // Jika ada rollback, job ini otomatis DIBATALKAN.
    ProcessStripeCharge::dispatch($order)->afterCommit();
});
// ATAU, pisahkan HTTP call sebelum/sesudah blok DB::transaction.
```

### 2.2 Anti-Pattern 2: Manual Transaction Handling dengan Catch yang Menelan Error

❌ **KODE SALAH (Transaksi tidak rollback dengan benar)**
```php
<?php
DB::beginTransaction();
try {
    $user->delete();
    $profile->delete();
    // Jika delete profile throw exception
    DB::commit();
} catch (\Exception $e) {
    DB::rollBack();
    // SALAH: Menelan exception. Logika bisnis di luarnya mengira ini sukses padahal gagal!
    Log::error($e->getMessage()); 
    // Controller mungkin akan me-return 200 OK
}
```
**Mengapa Berbahaya:** Ketika menggunakan `beginTransaction()` dan `rollBack()` manual, menelan *Exception* tanpa melemparnya kembali (*rethrowing*) merusak alur kontrol eksekusi. Fitur *Clean Architecture* tidak akan tahu bahwa kegagalan terjadi, menyebabkan respons HTTP menjadi 200 OK (sukses palsu).

✅ **KODE BENAR (Menggunakan `DB::transaction` Closure)**
```php
<?php
// DB::transaction otomatis melakukan begin, commit, rollback jika ada exception,
// DAN otomatis melempar ulang exception (rethrow) ke atas!
DB::transaction(function () use ($user, $profile) {
    $user->delete();
    $profile->delete();
});
```
*(Catatan: Jika sangat harus manual, WAJIB memanggil `throw $e;` setelah `DB::rollBack()`)*

---

## 3. Tingkatan Isolasi Database (Isolation Levels)

Dalam aplikasi *Top 1%*, penting menyadari bahwa *Database Engine* mengatur visibilitas baris antar-transaksi. MySQL InnoDB default menggunakan `REPEATABLE READ`.

- **READ UNCOMMITTED**: Transaksi B dapat melihat data yang belum di-commit dari Transaksi A. Sangat berbahaya (Dirty Read).
- **READ COMMITTED**: Transaksi B hanya melihat data yang telah di-commit. Bebas dari *Dirty Read*, tetapi ada *Non-repeatable Read*.
- **REPEATABLE READ** (Default MySQL): Sekali Transaksi membaca sebuah baris, hasil bacaannya dijamin sama (*snapshot* konsisten) sampai ia di-*commit*, bahkan jika transaksi lain mengubahnya.
- **SERIALIZABLE**: Ketat dan meniadakan segala bentuk *concurrency problem* dengan mengunci sangat agresif, menyebabkan lambat.

Untuk mengubah level secara spesifik pada kueri:
```php
DB::statement('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
DB::transaction(function() { ... });
```

---

## 4. Pest v3 Testing (Architecture & Unit)

Kita harus memastikan transaksi tidak bocor dan bekerja atomik, bahkan saat melempar kegagalan.

### 4.1 Architecture Testing (`tests/ArchTest.php`)
```php
<?php

declare(strict_types=1);

arch('controllers should not use database facades')
    ->expect('App\Http\Controllers')
    ->not->toUse('Illuminate\Support\Facades\DB'); // Paksa transaksi di Action/Repository
```

### 4.2 Feature Testing (`tests/Feature/Actions/TransferFundsActionTest.php`)
```php
<?php

declare(strict_types=1);

use App\Actions\Wallet\TransferFundsAction;
use App\DTOs\Wallet\TransferFundsDTO;
use App\Models\Wallet;
use App\Exceptions\Wallet\InsufficientBalanceException;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

it('transfers funds successfully and records history', function () {
    // Arrange
    $sender = Wallet::create(['id' => 'u1', 'balance' => 1000]);
    $receiver = Wallet::create(['id' => 'u2', 'balance' => 500]);

    $dto = new TransferFundsDTO('u1', 'u2', 200);
    $action = app(TransferFundsAction::class);

    // Act
    $result = $action->execute($dto);

    // Assert
    expect($result)->toBeTrue();
    
    $sender->refresh();
    $receiver->refresh();
    
    expect($sender->balance)->toEqual(800)
        ->and($receiver->balance)->toEqual(700);

    $this->assertDatabaseHas('transaction_histories', [
        'sender_id' => 'u1',
        'receiver_id' => 'u2',
        'amount' => 200,
    ]);
});

it('rolls back completely if sender has insufficient balance', function () {
    // Arrange
    $sender = Wallet::create(['id' => 'u1', 'balance' => 100]);
    $receiver = Wallet::create(['id' => 'u2', 'balance' => 500]);

    $dto = new TransferFundsDTO('u1', 'u2', 200);
    $action = app(TransferFundsAction::class);

    // Act & Assert
    expect(fn () => $action->execute($dto))
        ->toThrow(InsufficientBalanceException::class);
        
    // Pastikan tidak ada uang yang pindah secara partial (Atomic!)
    $sender->refresh();
    $receiver->refresh();
    
    expect($sender->balance)->toEqual(100)
        ->and($receiver->balance)->toEqual(500);

    // Pastikan tidak ada history yang tersimpan!
    $this->assertDatabaseMissing('transaction_histories', [
        'sender_id' => 'u1',
        'receiver_id' => 'u2',
    ]);
});
```

## 5. Kesimpulan

- Prioritaskan blok `DB::transaction(Closure, retryCount)` di Laravel dibandingkan `beginTransaction/rollBack` manual.
- Operasi di dalam *Closure* transaksi harus **ringan, deterministik, dan bebas I/O lambat**.
- Gunakan fitur `dispatch(...)->afterCommit()` untuk antrean (*jobs*) yang berkaitan dengan database yang baru saja di-*commit*.
- Sorting ID record sebelum `lockForUpdate` (*Lexicographical Lock Ordering*) adalah teknik canggih untuk mencegah MySQL *Deadlock* pada pertukaran dua arah (A -> B dan B -> A).
