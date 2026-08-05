# Artisan Console & Task Scheduling (Top 1% Architecture)

## 1. Fundamental Law & Mechanical Sympathy

Dalam sistem *backend enterprise*, **Task Scheduling** di Laravel merupakan evolusi modern dari *cron jobs* UNIX tradisional. Alih-alih mendaftarkan puluhan baris eksekusi di `/etc/crontab` yang sulit dilacak, sulit diuji, dan sulit dikelola di bawah kontrol versi (Git), Laravel memadatkan seluruh jadwal ke dalam satu perintah absolut: `* * * * * cd /path-to-your-project && php artisan schedule:run >> /dev/null 2>&1`.

Secara mekanik (*Mechanical Sympathy*), ketika `schedule:run` dieksekusi, Laravel Kernel (Console) akan memuat kelas `App\Console\Kernel`, mengevaluasi ekspresi Cron dari setiap *Command*, mencocokkannya dengan waktu absolut *server* saat ini (memperhitungkan zona waktu), dan mengeksekusi komando yang jatuh tempo. Di lingkungan produksi skala besar (misal Kubernetes dengan puluhan *pods*), eksekusi naif akan memicu komando yang sama dijalankan 20 kali secara serentak. Oleh karena itu, penguasaan atas mekanisme *Atomic Locks* di Redis (melalui `withoutOverlapping` dan `onOneServer`) adalah pembeda mutlak antara insinyur junior dan Arsitek Sistem Top 1%.

## 2. Top 1% Production Architecture

Arsitektur Console terbaik menuntut isolasi, konkurensi terkontrol, dan penanganan kegagalan yang deterministik.

### 2.1 The Distributed Cron Matrix (Multi-Server Handling)
Ketika aplikasi Anda berjalan di balik *Load Balancer* dengan banyak *worker nodes*, satu *cron job* dapat dieksekusi berulang kali oleh masing-masing server. Gunakan `onOneServer()` untuk menjamin hanya node pertama yang mengeksekusi perintah tersebut (menggunakan Cache Mutex, biasanya Redis).

```php
namespace App\Console;

use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Console\Kernel as ConsoleKernel;

class Kernel extends ConsoleKernel
{
    protected function schedule(Schedule $schedule): void
    {
        $schedule->command('billing:process-recurring')
                 ->hourly()
                 ->withoutOverlapping(60)
                 ->onOneServer()
                 ->runInBackground()
                 ->appendOutputTo(storage_path('logs/billing-schedule.log'))
                 ->emailOutputOnFailure('sre-alerts@enterprise.com');
    }
}
```

**Anatomi Arsitektur di Atas:**
1. `withoutOverlapping(60)`: Mencegah eksekusi ganda jika proses jam sebelumnya belum selesai. Mengunci (*mutex lock*) selama maksimal 60 menit.
2. `onOneServer()`: Kunci atomik Redis agar hanya 1 *pod/server* yang menjalankan perintah ini.
3. `runInBackground()`: Menginstruksikan sistem operasi untuk melempar perintah ini ke *background process* (`&` pada sistem Linux), sehingga Kernel dapat segera memproses jadwal perintah berikutnya tanpa terblokir.

### 2.2 Graceful Command Isolation (Command Structure)
Sebuah komando Console di level produksi tidak boleh menjadi skrip prosedural yang rapuh. Ia harus memiliki *Exit Codes* standar POSIX, *chunking* untuk memori, dan penanganan interupsi sinyal (SIGINT/SIGTERM) agar aman di-hentikan *(graceful shutdown)* oleh Kubernetes atau Supervisor.

```php
namespace App\Console\Commands;

use Illuminate\Console\Command;
use App\Models\Invoice;
use Symfony\Component\Console\Command\Command as SymfonyCommand;

class ProcessInvoicesCommand extends Command
{
    protected $signature = 'billing:process-recurring {--dry-run : Simulate the process without charging}';
    protected $description = 'Process all pending recurring invoices securely';

    public function handle(): int
    {
        $isDryRun = $this->option('dry-run');
        
        // Use chunkById to prevent memory exhaustion (OOM) on 10M+ rows
        Invoice::where('status', 'pending')
            ->chunkById(500, function ($invoices) use ($isDryRun) {
                foreach ($invoices as $invoice) {
                    $this->processSingleInvoice($invoice, $isDryRun);
                }
            });

        $this->info('All pending invoices processed successfully.');
        return SymfonyCommand::SUCCESS; // Exit code 0
    }
}
```

## 3. Failure & Edge-Case Anomaly Matrix

| Kelas Anomali | Gejala / Dampak Mutlak | Matriks Mitigasi (Top 1% Tactic) |
| :--- | :--- | :--- |
| **Zombie Mutex (Lock Hanging)** | Perintah cron mati karena OOM atau *server crash*, namun kunci `withoutOverlapping` masih menyala di Redis. Cron tidak pernah berjalan lagi selamanya. | Selalu atur kedaluwarsa waktu (*expiration time*) maksimum yang logis pada `withoutOverlapping($minutes)`. Jangan biarkan nilai *default* 24 jam jika *job* seharusnya selesai dalam 10 menit. |
| **Timezone Drift Skew** | *Daylight Saving Time* (DST) menyebabkan transaksi harian dieksekusi 2 kali atau tidak sama sekali pada hari pergantian zona waktu. | Standarkan `timezone('UTC')` secara eksplisit pada metode pemanggilan `$schedule` Anda, terlepas dari konfigurasi *server* lokal. |
| **Sequential Blocking (The Bottleneck)** | Perintah pertama memakan waktu 40 menit, menyebabkan 5 perintah di bawahnya gagal dieksekusi tepat waktu (telat 40 menit). | WAJIB memanggil rantai `runInBackground()` untuk perintah berat, agar proses dijalankan pada *thread* OS independen, membebaskan Kernel untuk mengurus antrean berikutnya secara instan. |

## 4. High-Assurance Testing

Pengujian *Command* dan *Scheduler* tidak memerlukan eksekusi nyata dari sistem operasi Linux. Laravel menyediakan penegasan (*assertions*) bawaan untuk memverifikasi keluaran CLI dan ekspresi *Cron*.

```php
namespace Tests\Feature\Console;

use Tests\TestCase;
use Illuminate\Support\Facades\Event;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Console\Scheduling\Event as ScheduleEvent;

class BillingScheduleTest extends TestCase
{
    public function test_billing_command_is_scheduled_correctly(): void
    {
        /** @var Schedule $schedule */
        $schedule = app()->make(Schedule::class);

        $events = collect($schedule->events())->filter(function (ScheduleEvent $event) {
            return stripos($event->command, 'billing:process-recurring') !== false;
        });

        $this->assertCount(1, $events);
        $this->assertEquals('0 * * * *', $events->first()->expression); // Runs hourly
        $this->assertTrue($events->first()->runInBackground);
    }

    public function test_billing_command_executes_successfully(): void
    {
        $this->artisan('billing:process-recurring', ['--dry-run' => true])
             ->expectsOutput('All pending invoices processed successfully.')
             ->assertSuccessful();
    }
}
```

## 5. Anti-Patterns & "When NOT to Use" Matrix

### Anti-Pattern: Mengeksekusi Logika Bisnis Berat Secara Langsung di Console
Banyak pengembang keliru meletakkan ratusan baris kode untuk memanipulasi *file* CSV, memanggil API eksternal secara berantai, dan menghitung laporan rumit secara langsung di dalam metode `handle()` milik Command.

**Mengapa ini fatal?**
- **Pros:** Lebih mudah ditulis dan di-*debug* secara lokal, tidak memerlukan infrastruktur antrean (Queue Worker).
- **Cons (1):** Perintah CLI berjalan secara sinkron. Jika operasi mandek (timeout jaringan), seluruh *batch* akan gagal tanpa mekanisme *retry* otomatis.
- **Cons (2):** Menghabiskan *memory limit* PHP (OOM Kill) saat mengolah jutaan baris data, karena Command tidak punya sistem *timeout* granular layaknya *Queued Jobs*.
- **Cons (3):** Skalabilitas nol. Anda tidak bisa membagi proses iterasi array (seperti `foreach ($users as $user)`) ke dalam 10 server berbeda. Semuanya tertahan di satu proses CPU tunggal.

**Kapan Command / Scheduler TIDAK Boleh Digunakan:**
- **Pemrosesan Asinkron Skala Masif:** Saat Anda harus memproses 1 juta pengguna, Command HANYA boleh bertugas menembak kueri pencarian, lalu melempar 1 juta hasil tersebut ke dalam **Redis Queue (Jobs)**. Biarkan Laravel Horizon dan 20 *Queue Workers* yang memproses setiap *job* secara paralel. Command dilarang melakukan pekerjaan kotor itu sendiri.
