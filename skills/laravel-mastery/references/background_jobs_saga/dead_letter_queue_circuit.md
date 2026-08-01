# Dead-Letter Queue (DLQ) & Circuit Breaker pada Laravel Jobs

Ketika background jobs gagal berulang kali dan menguras resource sistem (CPU, API Rate Limits, koneksi DB), kita memerlukan mekanisme perlindungan. Dalam sistem *high-throughput*, jobs yang gagal setelah upaya (retries) maksimal harus disingkirkan ke *Dead-Letter Queue* (DLQ) alias *Poison Queue* untuk diinvestigasi nanti.

Jika jumlah kegagalan mendadak naik tajam melampaui batas wajar (spike), pola *Circuit Breaker* harus terbuka (Open) untuk memblokir dispatch baru atau mengalihkan trafik, serta memicu alarm via PagerDuty/Slack.

## Arsitektur & Diagram ASCII

```text
+-----------------------+      (Circuit Closed = Normal)
| Dispatch Job          | ------------------------------------+
+-----------------------+                                     |
           | (Circuit Open = Fails Fast/Bypass)               v
           v                                       +--------------------+
[ Reject & Trigger Alert ]                         | Laravel Queue      |
                                                   | (Redis/SQS)        |
                                                   +--------------------+
                                                              |
                                                              v
+-----------------------------------------------------------------------+
| WORKER NODE (queue:work)                                              |
|                                                                       |
|  [ Attempt 1: Tries ] -> [ Attempt 2: Backoff 60s ] -> [ Attempt 3 ]  |
|                                                                       |
+-----------------------------------------------------------------------+
      | (All retries failed)
      v
+-----------------------+
| Dead-Letter Queue     | -> (Tabel: failed_jobs)
| (failed())            | -> [ Pruning Cron Job: Delete > 7 Days ]
+-----------------------+
      |
      +-> [ Circuit Breaker Tracker (Redis) ]
            | (If errors > 100 per minute)
            v
       [ FIRE ALARM: PagerDuty / Slack via Laravel Pulse ]
```

## Implementasi Kode Produksi (PHP 8.3 / Laravel 11 / PHPStan Level 9)

```php
<?php

declare(strict_types=1);

namespace App\Domain\Integration\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

final class PushDataToErpJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 4;
    
    public function __construct(public readonly array $dataPayload) {}

    /**
     * Terapkan Exponential Backoff untuk mencegah hammering saat ERP down.
     * Attempt 1 (gagal) -> Tunggu 10s
     * Attempt 2 (gagal) -> Tunggu 60s (1 menit)
     * Attempt 3 (gagal) -> Tunggu 300s (5 menit)
     * Attempt 4 (gagal) -> Masuk ke Failed Jobs (DLQ)
     * 
     * @return array<int, int>
     */
    public function backoff(): array
    {
        return [10, 60, 300];
    }

    public function handle(): void
    {
        // 1. Cek State Circuit Breaker sebelum memulai request berat
        if ($this->isCircuitBreakerOpen()) {
            // Re-release to queue with delay instead of throwing, or just fail immediately.
            $this->release(60); 
            return;
        }

        $response = Http::timeout(5)->post('https://erp.internal/api/sync', $this->dataPayload);

        if ($response->failed()) {
            throw new \RuntimeException("ERP Sync Failed with Status: " . $response->status());
        }
    }

    /**
     * Dipanggil ketika job telah melewati batasan $tries dan masuk ke Dead-Letter Queue (failed_jobs table).
     */
    public function failed(?Throwable $exception): void
    {
        Log::error("Job moved to DLQ (Poison Queue)", [
            'payload' => $this->dataPayload,
            'exception' => $exception?->getMessage()
        ]);

        $this->recordFailureForCircuitBreaker();
    }

    private function isCircuitBreakerOpen(): bool
    {
        // Jika Redis flag 'erp_circuit_open' aktif, berarti circuit terbuka
        return Cache::store('redis')->has('erp_circuit_open');
    }

    private function recordFailureForCircuitBreaker(): void
    {
        $key = 'erp_failure_count';
        // Hitung kegagalan per menit
        $count = (int) Cache::store('redis')->increment($key);
        
        // Pastikan key kedaluwarsa setelah 1 menit jika baru dibuat
        if ($count === 1) {
            Cache::store('redis')->put($key, 1, 60);
        }

        // Jika > 100 kegagalan dalam 1 menit, buka circuit breaker selama 5 menit
        if ($count > 100 && ! Cache::store('redis')->has('erp_circuit_open')) {
            Cache::store('redis')->put('erp_circuit_open', true, 300);
            
            // FIRE ALARM: PagerDuty / Slack 
            Log::emergency("CIRCUIT BREAKER OPEN: ERP Integration is down! Escalating to PagerDuty.");
            // e.g. Notification::route('slack', '...')->notify(new CircuitBreakerAlert());
        }
    }
}
```

## Pruning Failed Jobs (Cron)

Jobs mati di tabel `failed_jobs` lama kelamaan membengkak. Wajib ada jadwal pembersihan.
Di `routes/console.php` (Laravel 11):

```php
use Illuminate\Support\Facades\Schedule;
use Illuminate\Support\Facades\Artisan;

Schedule::command('queue:prune-failed --hours=168')->daily(); // Hapus failed jobs > 7 hari (168 jam)
```

## Unit & Arch Tests (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Domain\Integration\Jobs\PushDataToErpJob;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

arch('erp integration jobs must use strict backoff array')
    ->expect('App\Domain\Integration\Jobs')
    ->toHaveMethod('backoff');

test('job tracks failures and opens circuit breaker when threshold exceeded', function () {
    Cache::store('redis')->flush();
    
    $job = new PushDataToErpJob(['id' => 1]);
    
    // Simulate 100 failures
    for ($i = 0; $i < 100; $i++) {
        $job->failed(new \RuntimeException("Simulated Error"));
    }
    
    // Circuit should NOT be open yet at exactly 100
    expect(Cache::store('redis')->has('erp_circuit_open'))->toBeFalse();
    
    // The 101st failure opens the circuit
    $job->failed(new \RuntimeException("Simulated Error 101"));
    
    expect(Cache::store('redis')->has('erp_circuit_open'))->toBeTrue();
    
    // Assert Log emergency was called via mocking Log facade (pseudo-code logic)
});

test('job respects circuit breaker state and releases early', function () {
    Cache::store('redis')->put('erp_circuit_open', true, 300);
    
    Http::fake([
        'https://erp.internal/api/sync' => Http::response('ok', 200)
    ]);
    
    // Test logic here using reflection or queue fake to assert `release()` is called.
    // P.S: Laravel's Bus::fake() handles `assertReleased()`.
});
```

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Retries Tanpa Batas / Tanpa Backoff
Mengatur `$tries = 0` (tak terbatas) atau menggunakan retry default (langsung mengulang secepat mungkin) saat API tujuan sedang *down*, akan menghancurkan (DDoS) API tersebut dan memblokir antrean job internal Anda.
```php
// ❌ SALAH: Spamming API yang down
public int $tries = 0; // Akan terus looping tanpa henti menguras CPU worker
```
✅ **Solusi**: Tentukan `$tries = 3` atau gunakan `$backoff` berbentuk array (Exponential Backoff).

### ❌ Anti-Pattern 2: Menimbun Dead-Letter Jobs
Mengabaikan pemeliharaan tabel `failed_jobs`. Sistem dibiarkan berjalan berbulan-bulan sampai jutaan baris menumpuk di `failed_jobs`, memperlambat kueri monitoring.
✅ **Solusi**: Implementasi command `queue:prune-failed` mingguan di Scheduler.

## Production Edge Cases

1. **Thundering Herd Paska Circuit Tertutup (Closed):** Setelah 5 menit *Circuit Breaker* menutup (pulih), ribuan job yang berstatus `released(60)` di antrean akan mencoba mengeksekusi bersamaan, berisiko menjatuhkan API tujuan lagi. Solusi: Tambahkan jitter (pengacakan waktu) pada delay release, misal `release(60 + random_int(1, 30))`.
2. **Pulse/Horizon Monitoring Alert Fatigue:** Jika Anda menyetel alert pada setiap job yang masuk ke DLQ tanpa threshold *Circuit Breaker*, tim on-call akan menerima ratusan notifikasi Slack saat ada flapped network. Ini memicu *Alert Fatigue* (kelelahan notifikasi, alarm diabaikan). Gunakan batasan laju (`throttle`) pada pengiriman notifikasi Slack.
3. **Pesan Racun Murni (Poison Pill):** Sebuah job gagal terus menerus bukan karena API down, tapi karena payload-nya memicu bug fatal di kode worker (misal pembagian angka nol, Uncaught TypeError). Jika retry, job akan terus membunuh worker process (crash) sebelum masuk `failed()`. Solusi: Pastikan payload memiliki skema validasi yang ketat dan block `try-catch (\Throwable $e)` raksasa di level Handle (opsional jika supervisor tidak otomatis restart worker).
