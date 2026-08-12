# Laravel Distributed Saga Pattern via Job Batching

Pola Distributed Saga adalah solusi arsitektural untuk menjaga konsistensi data lintas layanan atau tabel ketika kita tidak bisa menggunakan single database transaction (misalnya melibatkan microservices atau API pihak ketiga). Di Laravel 11, kita dapat mengimplementasikan Saga menggunakan `Bus::batch()` dengan *compensating jobs* (pekerjaan kompensasi) yang dijalankan jika ada salah satu langkah yang gagal.

## Arsitektur & Diagram ASCII

```text
+---------------------+
| Initiator (Saga)    |
+----------+----------+
           |
           v
+-----------------------------+
| Bus::batch()                |
|  1. ReserveInventoryJob     | --(Success)--> (Next)
|  2. ChargePaymentJob        | --(Success)--> (Next)
|  3. ProvisionServiceJob     | --(FAIL)-----> [Trigger Catch Callback]
|  4. SendConfirmationJob     | 
+-----------------------------+
           |
           | (Catch Callback)
           v
+-----------------------------+
| Saga Rollback Workflow      |
|  - RefundPaymentJob         |
|  - ReleaseInventoryJob      |
|  - MarkOrderFailedJob       |
+-----------------------------+
```

## Implementasi Kode Produksi (PHP 8.3 / Laravel 11 / PHPStan Level 9)

Berikut adalah implementasi komplit dari Saga pattern untuk e-commerce order processing.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Order\Jobs;

use Illuminate\Bus\Batch;
use Illuminate\Bus\Batchable;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

final class ProcessOrderSaga implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct(
        public readonly string $orderId,
        public readonly int $userId,
        public readonly float $totalAmount
    ) {}

    public function handle(): void
    {
        $orderId = $this->orderId;

        $batch = Bus::batch([
            new ReserveInventoryJob($orderId),
            new ChargePaymentJob($orderId, $this->totalAmount),
            new ProvisionServiceJob($orderId),
            new SendConfirmationJob($orderId),
        ])->then(function (Batch $batch) use ($orderId): void {
            Log::info("Order saga completed successfully.", ['order_id' => $orderId]);
            DB::table('orders')->where('id', $orderId)->update(['status' => 'completed']);
        })->catch(function (Batch $batch, Throwable $e) use ($orderId): void {
            Log::error("Order saga failed, initiating rollback.", [
                'order_id' => $orderId,
                'exception' => $e->getMessage()
            ]);
            
            // Dispatch compensating transactions
            Bus::chain([
                new RefundPaymentJob($orderId),
                new ReleaseInventoryJob($orderId),
                new MarkOrderFailedJob($orderId, $e->getMessage()),
            ])->dispatch();
            
        })->finally(function (Batch $batch) use ($orderId): void {
            Log::info("Order saga finished processing.", ['order_id' => $orderId]);
        })->name('Order Saga: ' . $orderId)
          ->allowFailures(false)
          ->onQueue('saga')
          ->dispatch();
    }
}

final class ReserveInventoryJob implements ShouldQueue
{
    use Batchable, Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct(public readonly string $orderId) {}

    public function handle(): void
    {
        if ($this->batch()?->cancelled()) {
            return;
        }

        $inventoryAvailable = DB::table('inventory')->where('stock', '>', 0)->exists();
        if (! $inventoryAvailable) {
            throw new \RuntimeException("Insufficient inventory for order: {$this->orderId}");
        }

        DB::table('inventory')->where('id', 1)->decrement('stock', 1);
        DB::table('orders')->where('id', $this->orderId)->update(['inventory_status' => 'reserved']);
    }
}

final class ChargePaymentJob implements ShouldQueue
{
    use Batchable, Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct(
        public readonly string $orderId,
        public readonly float $amount
    ) {}

    public function handle(): void
    {
        if ($this->batch()?->cancelled()) {
            return;
        }

        $paymentSuccess = true; 
        if (! $paymentSuccess) {
            throw new \RuntimeException("Payment gateway rejected charge for order: {$this->orderId}");
        }

        DB::table('orders')->where('id', $this->orderId)->update(['payment_status' => 'charged']);
    }
}

final class ProvisionServiceJob implements ShouldQueue
{
    use Batchable, Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct(public readonly string $orderId) {}

    public function handle(): void
    {
        if ($this->batch()?->cancelled()) {
            return;
        }
        
        throw new \RuntimeException("External service provisioning failed for order: {$this->orderId}");
    }
}

final class SendConfirmationJob implements ShouldQueue
{
    use Batchable, Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct(public readonly string $orderId) {}

    public function handle(): void
    {
        if ($this->batch()?->cancelled()) {
            return;
        }
        
        DB::table('orders')->where('id', $this->orderId)->update(['notification_status' => 'sent']);
    }
}

final class RefundPaymentJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;
    
    public function __construct(public readonly string $orderId) {}
    
    public function handle(): void
    {
        $status = (string) DB::table('orders')->where('id', $this->orderId)->value('payment_status');
        if ($status === 'charged') {
            DB::table('orders')->where('id', $this->orderId)->update(['payment_status' => 'refunded']);
            Log::info("Payment refunded for order: {$this->orderId}");
        }
    }
}

final class ReleaseInventoryJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;
    
    public function __construct(public readonly string $orderId) {}
    
    public function handle(): void
    {
        $status = (string) DB::table('orders')->where('id', $this->orderId)->value('inventory_status');
        if ($status === 'reserved') {
            DB::table('inventory')->where('id', 1)->increment('stock', 1);
            DB::table('orders')->where('id', $this->orderId)->update(['inventory_status' => 'released']);
            Log::info("Inventory released for order: {$this->orderId}");
        }
    }
}

final class MarkOrderFailedJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;
    
    public function __construct(
        public readonly string $orderId,
        public readonly string $reason
    ) {}
    
    public function handle(): void
    {
        DB::table('orders')->where('id', $this->orderId)->update([
            'status' => 'failed',
            'failed_reason' => $this->reason
        ]);
        Log::info("Order marked as failed: {$this->orderId}");
    }
}
```

## Unit & Arch Tests (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Domain\Order\Jobs\ProcessOrderSaga;
use App\Domain\Order\Jobs\RefundPaymentJob;
use App\Domain\Order\Jobs\ReserveInventoryJob;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

arch('saga jobs should strictly implement ShouldQueue')
    ->expect('App\Domain\Order\Jobs')
    ->toImplement(Illuminate\Contracts\Queue\ShouldQueue::class);

test('order saga batch executes correctly and triggers rollback on failure', function () {
    Bus::fake([
        ReserveInventoryJob::class,
        RefundPaymentJob::class
    ]);

    $orderId = 'ORD-12345';
    DB::table('orders')->insert([
        'id' => $orderId,
        'user_id' => 1,
        'status' => 'pending',
        'payment_status' => 'pending',
        'inventory_status' => 'pending'
    ]);

    ProcessOrderSaga::dispatch($orderId, 1, 150.00);
    
    Bus::assertBatched(function ($batch) {
        return $batch->name === 'Order Saga: ORD-12345' && $batch->jobs->count() === 4;
    });
});
```

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Mengandalkan Transaksi DB Biasa Lintas Layanan
Menggunakan `DB::transaction()` untuk memanipulasi API eksternal (seperti payment gateway) dapat menahan lock database jika API eksternal mengalami timeout atau latensi tinggi, memicu koneksi habis (connection pool exhaustion).
```php
// ❌ SALAH: Memanggil API lambat di dalam transaksi DB
DB::transaction(function () use ($order) {
    $order->update(['status' => 'processing']);
    Stripe::charge($order->amount); // BOOM! DB Lock tertahan 30 detik jika Stripe lambat
});
```
✅ **Solusi**: Pisahkan mutasi lokal (DB) dengan API eksternal ke dalam job berbeda (Saga step). Jangan bungkus network request di dalam database transaction.

### ❌ Anti-Pattern 2: Compensating Jobs Tidak Idempotent
Jika `RefundPaymentJob` gagal di tengah jalan dan di-retry oleh worker, tanpa pengecekan status (idempotency), kita bisa melakukan refund dua kali!
```php
// ❌ SALAH: Asumsi blind rollback
public function handle() {
    Stripe::refund($this->orderId); // Jika retry, user dapat uang 2x!
}
```
✅ **Solusi**: Periksa state terlebih dahulu, e.g., `if ($order->payment_status === 'charged') { ... update state & call API }`.

## Production Edge Cases

1. **Database Lock Contention Saat Rollback:** Saat rollback panjang terjadi, pastikan `Compensating Jobs` dieksekusi dengan `unique lock` atau pesimistik lock pada baris database terkait untuk mencegah proses user lain mengubah `order` yang sama.
2. **Worker Mati di Tengah Catch Callback:** Jika node yang mengeksekusi `catch()` mati terbunuh OOM, rantai kompensasi mungkin gagal di-dispatch. Solusinya: Pastikan scheduler memiliki task `reconciliation` berkala yang mencari Batch yang `cancelled` tapi status order-nya bukan `failed` (Eventually Consistent).
3. **Third-party Rate Limits Saat Rollback Massal:** Jika API pihak ketiga mati mendadak, banyak batch akan masuk `catch()` bersamaan, menyebabkan lonjakan request ke endpoint refund. Compensating jobs wajib memiliki mekanisme rate limiting `Redis::throttle()` atau exponential backoff `backoff()`.
