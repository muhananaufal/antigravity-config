# Laravel Artisan Daemon Commands & Memory Leak Prevention

Menjalankan proses daemon jarak jauh (long-running commands) di PHP menghadirkan tantangan signifikan: Zend Engine PHP aslinya tidak didesain untuk berjalan terus menerus berbulan-bulan tanpa henti (seperti Go atau Rust). Memory leaks dari static array, caching internal DB PDO, event listeners, dan service providers sangat lazim terjadi.

Di Laravel 11, perintah `php artisan queue:work` sudah memiliki mekanisme internal untuk manajemen memori, namun untuk *custom daemons* (misal command kustom `php artisan worker:consume` via Kafka/RabbitMQ), kita wajib mengelola signal Linux, memory garbage collection, dan state koneksi DB secara manual.

## Arsitektur & Diagram ASCII

```text
+--------------------------------------------------------+
| Linux Daemon (Supervisor/Systemd)                      |
|                                                        |
| +----------------------------------------------------+ |
| | php artisan worker:consume                         | |
| |                                                    | |
| | [Infinite Loop (while true)]                       | |
| |  |                                                 | |
| |  |-> 1. Cek PCNTL Signal (SIGTERM / SIGINT)        | |
| |  |-> 2. Tarik Pesan (RabbitMQ/Kafka)               | |
| |  |-> 3. Proses Pesan & Interaksi DB                | |
| |  |-> 4. Bersihkan Model Events & Cache (Crucial)   | |
| |  |-> 5. Disconnect DB jika idle timeout            | |
| |  |-> 6. Panggil gc_collect_cycles()                | |
| |  v                                                 | |
| | [Loop kembali]                                     | |
| +----------------------------------------------------+ |
+--------------------------------------------------------+
```

## Implementasi Kode Produksi (PHP 8.3 / Laravel 11 / PHPStan Level 9)

```php
<?php

declare(strict_types=1);

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

final class CustomDaemonConsumeCommand extends Command
{
    protected $signature = 'worker:consume';
    protected $description = 'Run custom background daemon without memory leaks';

    private bool $shouldQuit = false;

    public function handle(): int
    {
        $this->listenForSignals();
        Log::info("Custom daemon started. PID: " . getmypid());

        while (! $this->shouldQuit) {
            try {
                // 1. Dispatch signals to ensure SIGTERM is processed
                pcntl_signal_dispatch();
                
                if ($this->shouldQuit) {
                    break;
                }

                // 2. Consume from external queue/stream (Simulated)
                $message = $this->consumeMessage();
                if ($message === null) {
                    // Sleep if idle to prevent CPU thrashing
                    usleep(500_000); 
                    continue;
                }

                // 3. Process business logic
                $this->process($message);

            } catch (\Throwable $e) {
                Log::error("Daemon error: " . $e->getMessage());
                // Don't die on exception, let the loop continue unless critical
            } finally {
                // 4. CRUCIAL MEMORY MANAGEMENT
                $this->flushMemoryLeaks();
            }
        }

        Log::info("Custom daemon stopped gracefully.");
        return self::SUCCESS;
    }

    private function listenForSignals(): void
    {
        if (extension_loaded('pcntl')) {
            $handler = function (int $signal): void {
                Log::info("Received signal {$signal}, initiating graceful shutdown.");
                $this->shouldQuit = true;
            };

            pcntl_signal(SIGTERM, $handler);
            pcntl_signal(SIGINT, $handler);
        }
    }

    private function consumeMessage(): ?array
    {
        // Simulated consumption from a source like Apache Kafka or Redis Streams
        // In reality this might be a blocking pop operation
        return random_int(1, 10) > 8 ? ['id' => random_int(1, 9999)] : null;
    }

    private function process(array $message): void
    {
        // Must use DB transaction. Ensures PDO connection is checked and active.
        DB::transaction(function () use ($message): void {
            DB::table('daemon_logs')->insert([
                'message_id' => (string) $message['id'],
                'processed_at' => now(),
            ]);
        });
    }

    private function flushMemoryLeaks(): void
    {
        // A. Clear Eloquent booted models to prevent static array growth
        Model::clearBootedModels();
        
        // B. Reconnect DB if it has been lost or to reset state
        // In high-throughput, you might only do this periodically or upon exceptions
        // DB::connection()->reconnect();

        // C. Clear internal event listeners if you bind dynamic closures
        // app('events')->forget('eloquent.saved: *');

        // D. Explicit Garbage Collection trigger
        if (function_exists('gc_collect_cycles')) {
            gc_collect_cycles();
        }
    }
}
```

## Unit & Arch Tests (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Console\Commands\CustomDaemonConsumeCommand;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;

arch('console commands should be final')
    ->expect('App\Console\Commands')
    ->toBeFinal();

test('daemon executes safely and can be terminated', function () {
    // Ini menguji struktur dan logic tanpa infinite loop.
    // Kita panggil class langsung dan injeksi sinyal palsu atau set flag
    
    $command = new CustomDaemonConsumeCommand();
    
    // Gunakan reflection untuk mensimulasikan signal interupsi
    $reflection = new ReflectionClass($command);
    $property = $reflection->getProperty('shouldQuit');
    $property->setAccessible(true);
    
    // Set langsung ke true agar loop langsung berhenti saat test
    $property->setValue($command, true);
    
    $exitCode = $command->handle();
    
    expect($exitCode)->toBe(0);
});
```

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Mengabaikan Model Memory Leaks
Eloquent menyimpan cache event listeners untuk model secara statis. Jika Anda menggunakan dynamic model events, array statis akan membengkak hingga PHP kehabisan memori.
```php
// ❌ SALAH: Tidak membersihkan model
while (true) {
    User::create(['name' => 'Test']); // Lama kelamaan memori naik perlahan
}
```
✅ **Solusi**: Panggil `Model::clearBootedModels();` di akhir iterasi loop.

### ❌ Anti-Pattern 2: Koneksi Database Kedaluwarsa (MySQL "Gone Away")
Jika antrean idle lama, koneksi PDO ke MySQL bisa diputus oleh server (`wait_timeout`). Saat pesan baru masuk, request ke DB akan langsung melempar error fatal "MySQL server has gone away" dan daemon mati (crash).
```php
// ❌ SALAH: Koneksi idle
$message = $queue->pop(timeout: 3600); // Tunggu 1 jam
DB::table('users')->insert(...); // Crash! Koneksi DB sudah terputus.
```
✅ **Solusi**: Panggil `DB::connection()->reconnect();` atau tangkap error dan ping ulang. Fitur internal Laravel (seperti `DB::reconnect()`) kadang perlu dipicu manual di custom daemons.

## Production Edge Cases

1. **Kematian Senyap karena Fatal Error Ekstensi C:** Jika pustaka bawah (seperti ext-rdkafka) mengalami *segmentation fault*, `try-catch` di PHP tidak bisa menangkapnya. Proses mati seketika. Solusinya: Selalu bungkus daemon Anda dengan *Process Monitor* (seperti `Supervisor` atau systemd) dengan flag `autorestart=true`.
2. **Zombie Daemons paska Deployment:** Saat mendeploy kode baru, daemons lama masih terus berjalan dengan memori kode lama karena PHP tidak hot-reloading di CLI. Solusi: Pipeline CI/CD Anda WAJIB mengirim signal SIGTERM ke seluruh proses daemon sebelum menghentikan service atau symlink release baru. `kill -15 $(pgrep -f 'worker:consume')`.
3. **Signal `SIGCONT` Terjebak Docker:** Terkadang di environment Docker/K8s, sinyal SIGTERM tidak diteruskan ke proses PHP jika entrypoint tidak diatur dengan `exec php ...` (menjalankan sebagai PID 1). Akibatnya daemon terbunuh keras (SIGKILL) saat container dimatikan, merusak transaksi database di tengah jalan.
