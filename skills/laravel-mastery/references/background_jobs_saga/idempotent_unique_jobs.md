# Laravel Idempotent Unique Jobs & Redis Atomic Locks

Masalah pemrosesan ganda (double processing) sangat kritis pada sistem pembayaran. Saat menerima webhook dari payment gateway seperti Stripe atau Xendit, jaringan bisa menyebabkan timeout di pihak gateway, memicu retry webhook (pengiriman ulang payload yang sama). Tanpa kontrol ketat, kita berisiko memberikan saldo atau memproses pesanan berkali-kali.

Kombinasi `ShouldBeUniqueUntilProcessing`, Redis Atomic Locks, dan pola *Idempotency Key Ledger* berbasis database menjamin eksekusi *exactly-once*.

## Arsitektur & Diagram ASCII

```text
+-------------------+
| Stripe / Xendit   | -- Webhook (Event-Id: 999) --> (API Endpoint)
+-------------------+                                      |
       (Retry 1)                                           v
+-------------------+                              +---------------------+
| Stripe / Xendit   | -- Webhook (Event-Id: 999)-->| Dispatch Job        |
+-------------------+                              +---------------------+
                                                           |
+----------------------------------------------------------|---------+
| WORKER NODE                                              v         |
| +----------------------------------------------------------------+ |
| | Check Unique Job Lock (Redis)                                  | |
| |  [KEY: laravel_unique_job:ProcessPaymentWebhook_999]           | |
| +----------------------------------------------------------------+ |
|          | (Lock acquired)                                         |
|          v                                                         |
| +----------------------------------------------------------------+ |
| | Database Transaction                                           | |
| |  1. Check Idempotency Ledger: SELECT * WHERE key = '999'       | |
| |  2. If exist -> abort (Idempotent Return)                      | |
| |  3. Process Business Logic                                     | |
| |  4. INSERT INTO idempotency_ledger (key, status, response)     | |
| +----------------------------------------------------------------+ |
+--------------------------------------------------------------------+
```

## Implementasi Kode Produksi (PHP 8.3 / Laravel 11 / PHPStan Level 9)

```php
<?php

declare(strict_types=1);

namespace App\Domain\Payment\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldBeUniqueUntilProcessing;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

final class ProcessPaymentWebhook implements ShouldQueue, ShouldBeUniqueUntilProcessing
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 3;
    public int $timeout = 60;
    public int $uniqueFor = 3600;

    public function __construct(
        public readonly string $eventId,
        public readonly array $payload
    ) {}

    public function uniqueId(): string
    {
        return $this->eventId;
    }

    public function backoff(): array
    {
        return [10, 30, 90]; // Exponential backoff untuk retries
    }

    public function handle(): void
    {
        // Secondary level protection: Idempotency Ledger in DB
        DB::transaction(function (): void {
            // Gunakan Pessimistic Locking untuk menghindari race condition tingkat DB
            $existingProcess = DB::table('idempotency_ledger')
                ->where('idempotency_key', $this->eventId)
                ->lockForUpdate()
                ->first();

            if ($existingProcess !== null) {
                Log::info('Webhook already processed.', ['event_id' => $this->eventId]);
                return;
            }

            // Simulasi pemrosesan bisnis yang lambat (misal alokasi resource)
            $this->processBusinessLogic();

            // Catat hasil ke ledger
            DB::table('idempotency_ledger')->insert([
                'idempotency_key' => $this->eventId,
                'resource_type' => 'payment_webhook',
                'status' => 'completed',
                'created_at' => now(),
            ]);

            Log::info('Webhook processed successfully.', ['event_id' => $this->eventId]);
        });
    }

    private function processBusinessLogic(): void
    {
        $amount = (float) ($this->payload['data']['object']['amount'] ?? 0.0);
        $userId = (int) ($this->payload['data']['object']['metadata']['user_id'] ?? 0);

        if ($userId === 0 || $amount <= 0.0) {
            throw new \InvalidArgumentException('Invalid payload data');
        }

        DB::table('wallets')->where('user_id', $userId)->increment('balance', $amount);
    }
}
```

## Unit & Arch Tests (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Domain\Payment\Jobs\ProcessPaymentWebhook;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Queue;

arch('webhook jobs should implement ShouldBeUnique')
    ->expect('App\Domain\Payment\Jobs')
    ->toImplement(Illuminate\Contracts\Queue\ShouldBeUniqueUntilProcessing::class);

test('job respects idempotency ledger and avoids double execution', function () {
    $eventId = 'evt_test_123';
    $payload = ['data' => ['object' => ['amount' => 500, 'metadata' => ['user_id' => 1]]]];

    DB::table('wallets')->insert(['user_id' => 1, 'balance' => 0]);

    // Initial dispatch
    (new ProcessPaymentWebhook($eventId, $payload))->handle();
    
    // Balance should be 500
    expect((float) DB::table('wallets')->where('user_id', 1)->value('balance'))->toBe(500.0);
    
    // Assert ledger entry exists
    $ledger = DB::table('idempotency_ledger')->where('idempotency_key', $eventId)->first();
    expect($ledger)->not->toBeNull();

    // Second dispatch with same event_id
    (new ProcessPaymentWebhook($eventId, $payload))->handle();
    
    // Balance should STILL be 500 (idempotent)
    expect((float) DB::table('wallets')->where('user_id', 1)->value('balance'))->toBe(500.0);
});
```

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Hanya Mengandalkan Redis `ShouldBeUnique`
Banyak developer mengira `ShouldBeUnique` sudah cukup. Tapi bagaimana jika Redis terhapus (flush) atau instance di-restart? Lock akan hilang, dan retry payload yang tertunda akan masuk, memicu double processing.
```php
// ❌ SALAH: Tidak ada secondary protection di Database
public function handle() {
    Wallet::addBalance($this->payload['amount']); // Rentan double charge jika Redis lock hilang!
}
```
✅ **Solusi**: Wajib memiliki *Idempotency Ledger* di database RDBMS (PostgreSQL/MySQL) yang persisten sebagai benteng terakhir.

### ❌ Anti-Pattern 2: Validasi Idempotency Tanpa Pesimistik Lock
Melakukan pengecekan `$exists = DB::table('ledger')->where('key', $key)->exists();` tanpa `lockForUpdate()` dalam transaksi dapat tembus saat 2 request memukul DB di milidetik yang sama (Race Condition).
```php
// ❌ SALAH: Select tanpa Lock
if (! Ledger::where('key', $id)->exists()) {
    // Race condition mematikan di blok ini
    Ledger::create(['key' => $id]);
}
```
✅ **Solusi**: Gunakan transaksi DB dengan `lockForUpdate()` saat mengecek eksistensi key.

## Production Edge Cases

1. **Redis OOM Expulsion:** Saat RAM Redis penuh, Redis bisa membuang key acak (tergantung eviction policy `allkeys-lru`). Ini dapat menghapus lock unik Job Anda sebelum waktunya. Pastikan instance Redis untuk Job Locks dipisahkan (Dedicated Cache) dengan kebijakan eviction `noeviction` atau `volatile-ttl`.
2. **Database Lock Contention Akibat Webhook Ganda Spikers:** Saat provider mengirim ribuan webhook identik secara liar (karena error internal mereka), antrean tabel *ledger* kita akan terkunci beramai-ramai (`lockForUpdate`), memicu spike CPU RDS/MySQL. Batasi konkurensi listener webhook pada level load balancer (Rate Limit) dan gunakan primary key/unique constraint pada kolom `idempotency_key` (Index level protection).
3. **Deadlock Pada Idempotency & Wallet:** Jika job mencoba mengambil lock di Ledger, lalu memperbarui tabel Wallet, pastikan urutan locking tabel (Ledger -> Wallet) selalu konsisten di seluruh aplikasi untuk menghindari Database Deadlocks.
