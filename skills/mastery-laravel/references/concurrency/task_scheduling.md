# Laravel Task Scheduling & Background Jobs Automation

## 1. Konsep Dasar & Internal Mekanisme Cron (Deep Dive)

Dalam Laravel, Task Scheduling menyediakan antarmuka (API) yang sangat deklaratif, fasih (fluent), dan berorientasi pada objek untuk mendefinisikan jadwal tugas—mulai dari Artisan Command, Queue Job, invokable class, hingga operasi sistem shell (OS shell command) di dalam ekosistem aplikasi. Daripada mengelola ratusan baris di file `crontab` server operasi yang rawan kesalahan dan tidak tercatat dalam *version control* (Git), pendekatan Laravel memusatkan seluruh jadwal ini ke dalam satu titik masuk.

### Bagaimana Laravel Menjalankan Jadwal Secara Internal?
Anda hanya perlu menambahkan satu entri Cron di tingkat server sistem operasi (Ubuntu/Alpine Linux) yang akan memicu eksekusi scheduler milik Laravel setiap satu menit:

```bash
* * * * * cd /var/www/html/my-project && php artisan schedule:run >> /dev/null 2>&1
```

Secara mekanis, proses yang terjadi di belakang layar (`schedule:run`) adalah sebagai berikut:
1. **Application Bootstrapping**: Command dijalankan, menyebabkan kerangka kerja Laravel memuat semua penyedia layanan (*service providers*), menginisiasi koneksi basis data (database), dan mengonfigurasi pengaturan cache/Redis. Proses ini krusial agar tugas yang berjalan memiliki konteks penuh atas status aplikasi.
2. **Kompilasi & Registrasi Event**: Laravel memuat definisi tugas yang berada di file `routes/console.php` (atau metode `schedule()` di `App\Console\Kernel` pada versi Laravel terdahulu). Semua metode penjadwalan seperti `->daily()`, `->everyFiveMinutes()`, akan diterjemahkan menjadi instansi kelas `Illuminate\Console\Scheduling\Event`. Instansi ini memegang ekspresi cron mentah yang dikonversi (misal: `0 0 * * *` untuk *daily*).
3. **Pengecekan Kelaikan Waktu (Time-Due Evaluation)**: Setiap event akan divalidasi menggunakan pustaka mutakhir `dragonmantank/cron-expression`. Fungsi `isDue()` membandingkan ekspresi cron milik *Event* terhadap timestamp server saat ini (`Carbon::now()`). Selain waktu kronologis, scheduler mengevaluasi *truth test* kustom, seperti batasan lingkungan (`->environments('production')`), atau batasan kondisi boolean (`->when(fn() => $kondisiTerpenuhi)`).
4. **Eksekusi Paralel atau Sekuensial**: Jika event tersebut berstatus *due* (layak dijalankan sekarang), Laravel akan mengeksekusi tugas tersebut. Secara bawaan, eksekusi berjalan lurus (sekuensial). Namun, dengan memanggil `->runInBackground()`, Laravel menggunakan operator asinkron OS (seperti `&` di bash) untuk menjalankan tugas sebagai proses latar belakang secara independen. Hal ini mencegah satu tugas lambat menghalangi (*blocking*) jadwal tugas lainnya yang jatuh pada menit yang sama.

---

## 2. Fitur Utama Penjadwalan Tingkat Lanjut & Orkestrasi Lintas Server

### A. Penanganan Overlapping (WithoutOverlapping)
Pada tugas dengan durasi komputasi yang panjang (misalnya laporan bulanan atau sinkronisasi basis data bervolume jutaan baris), eksekusi bisa saja melampaui jadwal pemanggilan berikutnya. Akibatnya, dua atau lebih proses memori dari perintah yang sama akan berjalan menumpuk (overlapping). Hal ini menyebabkan *race condition* yang mematikan, konsumsi RAM yang eksponensial ganda (memory exhaustion), dan deadlock pada database.
Gunakan metode pelindung `->withoutOverlapping(int $expiresAt = 1440)` untuk memperoleh *mutex lock* via driver sistem tembolok (cache) aplikasi. Cache driver seperti Redis akan menyimpan *atomic lock* beridentifikasi hash tugas tersebut. Jika tugas selanjutnya aktif namun *lock* masih eksis dari tugas sebelumnya, Laravel akan secara aman menghentikan eksekusi yang baru.

### B. Isolasi Multi-Server (onOneServer)
Dalam infrastruktur modern (seperti Kubernetes atau AWS Auto Scaling), aplikasi Anda didistribusikan ke 3, 5, atau lebih peladen (server). Jika masing-masing server menjalankan daemon cron yang identik, sebuah tugas email promosi dapat terkirim 5 kali ke pelanggan yang sama di detik yang persis.
Untuk mengatasi ini, Laravel menyediakan fitur `->onOneServer()`. Fungsi ini secara cerdas memanfaatkan sentralisasi Cache Store (seperti kluster Memcached atau Redis) untuk mendistribusikan "Izin Tunggal" (*Master Lock*). Server pertama yang berhasil mengamankan gembok ini akan memroses tugas; sementara server lain yang mencoba mengamankan kunci akan ditolak dan menggugurkan niat mereka.

### C. Timezone & Pengendalian Lokasi Geografis Waktu
Menjalankan jadwal di ranah global memerlukan akurasi yang ketat. Mengandalkan zona waktu server dasar (`UTC`) sangat berbahaya bagi tugas berorientasi bisnis lokal. 
Anda dapat menegakkan eksekusi berdasarkan wilayah dengan metode berantai `->timezone('Asia/Jakarta')`. Laravel akan menggeser referensi waktu `Carbon::now()` menyesuaikan zona sebelum komparasi fungsi `isDue()` dilakukan, memastikan surel promo yang ditargetkan terkirim pada jam sarapan pelanggan, bukan pukul 3 pagi akibat persilangan wilayah.

### D. Penanganan Kegagalan & Pendelegasian Telemetri Eksternal (Webhooks)
Lingkungan *production* mewajibkan pelacakan agresif terhadap kebisuan sistem (*silent failure*).
- `->emailOutputOnFailure('sre-team@perusahaan.com')`: Mentransmisikan *Standard Error* terminal lengkap beserta jejak eksekusi (stack trace) kepada insinyur DevOps bila proses *exit code* gagal.
- Panggilan Monitoring (Healthchecks): 
  - `->thenPing('https://sentry.io/webhook-endpoint')`: Memberi konfirmasi tugas berakhir sukses.
  - `->pingOnFailure('https://betteruptime.com/api/v1/trigger')`: Segera menyalakan alarm panggilan pager (*pager duty*) jika proses kron lumpuh seketika.

### E. One-off Tasks (Tugas Sekali Jalan / Delayed Jobs)
Sistem penjadwalan Laravel secara teknis dan historikal dirancang untuk *recurring schedules* (tugas harian, per jam, per menit). Jika spesifikasi bisnis menuntut tindakan **satu kali eksekusi** (seperti penghapusan akun 30 hari ke depan setelah pengguna menekan "Tutup Akun"), mengeksploitasi Cron adalah praktek antipola.
Sebaliknya, arsitektur terbaik adalah memanfaatkan sistem antrean (`Queues`) dengan instrumen penundaan (delay time):
```php
<?php

declare(strict_types=1);

use App\Jobs\Account\PermanentlyDeleteUserJob;
use Carbon\CarbonImmutable;

// Tugas eksekusi spesifik dijadwalkan tepat 30 hari dari sekarang pada waktu detik ini
PermanentlyDeleteUserJob::dispatch($userId)
    ->delay(CarbonImmutable::now()->addDays(30));
```

---

## 3. Arsitektur Domain-Driven Design (Clean Architecture) pada Real Case

Mari beralih dari koding spageti dan membingkai modul pelaporan pendapatan (Revenue Report) dengan memisahkan *Interface*, *Application Action*, dan *Data Access Layer (Repository)*. 

### Layer 1: Infrastructure / Repository
Bertanggung jawab tunggal mengamankan ekstraksi sumber data tanpa menyertakan logika komputasi.
```php
<?php

declare(strict_types=1);

namespace App\Domain\Reports\Repositories;

use App\Models\Order;
use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\Collection;

final class OrderReportRepository
{
    /**
     * @return Collection<int, Order>
     */
    public function getCompletedOrdersForDate(CarbonImmutable $date): Collection
    {
        return Order::query()
            ->select(['id', 'total_amount', 'completed_at', 'status'])
            ->where('status', 'completed')
            ->whereDate('completed_at', $date->toDateString())
            ->get();
    }
}
```

### Layer 2: Application / Action Layer
Merangkai logika, orkestrasi model entitas, mengalkulasi metrik, dan mengeksekusi integrasi eksternal (Email). Error tertangkap diekskalasi dengan baik.
```php
<?php

declare(strict_types=1);

namespace App\Actions\Reports;

use App\Domain\Reports\Repositories\OrderReportRepository;
use App\Mail\DailyReportMail;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Log;
use Throwable;

final readonly class GenerateAndSendDailyReportAction
{
    public function __construct(
        private OrderReportRepository $repository
    ) {}

    public function execute(CarbonImmutable $date): void
    {
        try {
            $orders = $this->repository->getCompletedOrdersForDate($date);

            if ($orders->isEmpty()) {
                Log::info('Daily report skipped: No completed orders found.', [
                    'date' => $date->toDateString()
                ]);
                
                return;
            }

            $totalRevenue = $orders->sum('total_amount');

            // Dispatch asinkron pada background antrean default (pengiriman email tidak memblokade)
            Mail::to('manager@company.com')->send(
                new DailyReportMail($orders->count(), $totalRevenue)
            );

            Log::info('Daily report generated and queued successfully.', [
                'date' => $date->toDateString(),
                'orders_count' => $orders->count(),
                'total_revenue' => $totalRevenue,
            ]);
        } catch (Throwable $exception) {
            Log::error('CRITICAL: Failed to generate daily report.', [
                'error' => $exception->getMessage(),
                'trace' => $exception->getTraceAsString(),
            ]);
            
            throw $exception; // Re-throw sangat penting untuk trigger notifikasi kegagalan cron
        }
    }
}
```

### Layer 3: Console Command (Delivery Interface Layer)
Menjadi adaptor untuk injeksi *Dependency Injection Container* dan interaksi masukan sistem konsol.
```php
<?php

declare(strict_types=1);

namespace App\Console\Commands\Reports;

use App\Actions\Reports\GenerateAndSendDailyReportAction;
use Carbon\CarbonImmutable;
use Illuminate\Console\Command;

final class SendDailyReportCommand extends Command
{
    protected $signature = 'reports:send-daily';
    protected $description = 'Generate and send the daily order report to executive managers.';

    public function handle(GenerateAndSendDailyReportAction $action): int
    {
        $this->info('Starting daily report generation...');
        
        // Selalu gunakan CarbonImmutable; hindari manipulasi state yang mencederai determinisme objek 
        $targetDate = CarbonImmutable::yesterday();
        $action->execute($targetDate);
        
        $this->info('Daily report process finished securely.');
        
        return self::SUCCESS;
    }
}
```

### Registrasi Penjadwalan Tingkat Produksi (`routes/console.php`)
```php
<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Schedule;
use App\Console\Commands\Reports\SendDailyReportCommand;

Schedule::command(SendDailyReportCommand::class)
    ->dailyAt('08:00')
    ->timezone('Asia/Jakarta')
    ->withoutOverlapping(60) // Mengamankan lock maksimum 1 jam
    ->onOneServer()
    ->runInBackground() // Melimpahkan proses eksekusi cron agar sinkron parallel
    ->emailOutputOnFailure('devops@company.com')
    ->pingOnSuccess(env('MONITORING_CRON_PING_URL'));
```

---

## 4. Anti-Patterns & Resolusi Ketat Keamanan Performa

### ❌ Anti-Pattern 1: Menyusupkan Eksekusi Closure Penuh Logika Bisnis Langsung di File Penjadwalan
**Analisis Akar Masalah**: Mengikat secara masif fungsi Closure raksasa yang mengandung *query builder* berat ke dalam `routes/console.php`.
**Bencana Performa / Memory Risk**: Setiap aplikasi merespon API atau halaman web, atau melayani boot load awal console, router memuat dan menyimpan alokasi *Closure binding* ini ke dalam tumpukan RAM meskipun event jadwal belum waktunya dijalankan. Ini adalah sumber kebocoran memori (Memory Leak) paling masif di aplikasi Laravel berskala besar yang mengolah puluhan ribu data.

```php
// ❌ KODE SALAH (Membahayakan Server Ram & Non-Testable)
use Illuminate\Support\Facades\Schedule;
use App\Models\User;
use App\Mail\InvoiceMail;
use Illuminate\Support\Facades\Mail;

Schedule::call(function () {
    // MENARIK SEMUA DATA SEKALIGUS = OOM (Out of Memory) crash pada 50,000+ baris.
    $users = User::where('wants_billing', true)->get(); 
    
    foreach ($users as $user) {
        $invoice = $user->createInvoice();
        Mail::to($user)->send(new InvoiceMail($invoice));
    }
})->monthly();
```

✅ **KODE BENAR (Orkestrasi Job dengan teknik Delegation, Chunking & Queues)**
**Mekanisme Ketahanan Sistem (Resilience)**: Merombak fungsionalitas ke dalam arsitektur Queue berbasis Job Class terisolasi. Penarikan data dipisah dengan iterasi `chunkById` untuk mengekstrak baris tanpa melebihi batas (misal: 10 MB limit memori). Pekerjaan pembuatan invoice kemudian dilempar asinkronus ke server pekerja sekunder (Queue Workers).

```php
// ✅ KODE BENAR (Skalabilitas Skala Horisontal & Memory-Safe)

// Di dalam file `routes/console.php`:
use Illuminate\Support\Facades\Schedule;
use App\Jobs\Billing\ProcessMonthlyBillingJob;

Schedule::job(new ProcessMonthlyBillingJob())
    ->monthly()
    ->withoutOverlapping()
    ->onOneServer();

// Di dalam class isolasi ProcessMonthlyBillingJob.php:
<?php

declare(strict_types=1);

namespace App\Jobs\Billing;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use App\Models\User;
use App\Jobs\Billing\GenerateUserInvoiceJob;
use Illuminate\Database\Eloquent\Collection;

final class ProcessMonthlyBillingJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function handle(): void
    {
        // ChunkById mencegah memory crash dengan query limit offset berbasis index primer.
        User::query()
            ->where('wants_billing', true)
            ->chunkById(500, function (Collection $users) {
                foreach ($users as $user) {
                    // Delegasi pekerjaan berat komputasi ke background worker seutuhnya
                    GenerateUserInvoiceJob::dispatch($user->id);
                }
            });
    }
}
```

### ❌ Anti-Pattern 2: Tidak Menggunakan Proteksi Penumpang Tindih pada Mutasi API Pihak Ketiga
**Analisis Akar Masalah**: Mengoperasikan eksekusi rutinitas integrasi dua arah sinkronisasi dengan *External CRM API* setiap menit tanpa fitur proteksi Overlapping dan proteksi Timeout Eksekusi Jaringan.
**Bencana Arsitektur Keamanan (Security/Deadlock Risk)**: Jika API Server Eksternal mengalami pelambatan latensi tajam (300 detik per request), penjadwal Laravel tetap secara buta me-respons per menit. Ini menghasilkan lonjakan beban komputasi lokal dengan penumpukan 5+ skrip yang memperebutkan baris row mutasi SQL yang sama di database internal, menciptakan `Dead Lock Exception`, kehabisan konektor *Database Connection Pool*, dan pembekuan total web node.

```php
// ❌ KODE SALAH (Rentan Race-condition dan Connection Pool Exhaustion)
use Illuminate\Support\Facades\Schedule;
use App\Console\Commands\SyncExternalApiCommand;

Schedule::command(SyncExternalApiCommand::class)->everyMinute();
```

✅ **KODE BENAR (Mengunci Atomic Failsafe Mutex dengan Batas Waktu)**
**Mekanisme Ketahanan Sistem**: Laravel akan menolak peluncuran *worker* ganda dalam detik yang identik melalui `Cache Lock`. Menambahkan proteksi *Lock Expiration Time* secara spesifik memastikan bahwa jika proses utama *crash/fatal error* tertutup paksa sehingga tidak melepas gemboknya secara alami (Unlocking), kunci *Mutex* otomatis kadaluwarsa menghindari kelumpuhan sistem permanen.

```php
// ✅ KODE BENAR (Pengamanan Komprehensif Skala Data Center)
use Illuminate\Support\Facades\Schedule;
use App\Console\Commands\SyncExternalApiCommand;

Schedule::command(SyncExternalApiCommand::class)
    ->everyMinute()
    ->withoutOverlapping(15) // Mutex lock akan tertahan maskimal 15 menit sebagai Fail-Safe
    ->onOneServer()          // Satu server eksekusi tunggal dari loadbalancer pool
    ->runInBackground()      // Non-blocking OS thread spawn
    ->emailOutputOnFailure('critical-response@company.com');
```

---

## 5. Pengujian Berlapis (Testing) Menggunakan Pest v3

Menulis tes untuk fitur penjadwalan bukan hanya memastikan ketepatan algoritma bisnis, melainkan menjaga kontrak penjadwal dan integritas arsitektur tetap teratur. Kami memecah testing ke level arsitektur (Arch) lalu level mikroskopik (Unit).

### A. Pengujian Ekspektasi Arsitektur (Architecture Testing)
Dalam tim besar, sangat mudah bagi junior developer untuk membuat Console command di folder yang salah, atau membuat metodenya kotor dan memanggil fungsi eksternal mentah seperti `env()` atau `dd()`. Pest v3 Arch test mencegah kode antipola ini masuk ke master branch.

```php
<?php

declare(strict_types=1);

use Illuminate\Console\Command;

test('semua class schedule command disusun kuat secara objektif')
    ->expect('App\Console\Commands')
    ->toBeClasses()
    ->toExtend(Command::class)
    ->toHaveMethod('handle')
    ->toBeFinal() // Memaksa final untuk proteksi modifikasi turunan
    ->toUseStrictTypes(); // Menjamin deklarasi strict type aktif di semua class

test('tidak ada penggunaan helper debug yang bocor ke lingkungan jadwal')
    ->expect(['dd', 'dump', 'env', 'print_r'])
    ->not->toBeUsed();
```

### B. Unit Testing Komputasi Terisolasi (Action Layer Isolation)
Menguji `GenerateAndSendDailyReportAction` di mana database dimock (*Mocking/Stubbing*), log dilacak dengan *Spy*, dan fasad Mail diverifikasi tanpa transmisi surel asli yang mencederai stabilitas tes CI/CD.

```php
<?php

declare(strict_types=1);

namespace Tests\Unit\Actions\Reports;

use App\Actions\Reports\GenerateAndSendDailyReportAction;
use App\Domain\Reports\Repositories\OrderReportRepository;
use App\Mail\DailyReportMail;
use App\Models\Order;
use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Log;
use Mockery;

beforeEach(function () {
    // Intervensi infrastruktur komunikasi eksternal
    Mail::fake();
    Log::spy();
    
    // Inisiasi Mock Repository dan Action Target
    $this->repository = Mockery::mock(OrderReportRepository::class);
    $this->action = new GenerateAndSendDailyReportAction($this->repository);
});

it('berhasil memproduksi dan mendelegasikan email laporan bila pesanan terdata', function () {
    // Kunci determinisme temporal objek tanggal
    $date = CarbonImmutable::create(2026, 7, 30);
    
    $orderDataA = new Order(['total_amount' => 250.0]);
    $orderDataB = new Order(['total_amount' => 125.5]);
    $ordersCollection = new Collection([$orderDataA, $orderDataB]);
    
    $this->repository
        ->shouldReceive('getCompletedOrdersForDate')
        ->once()
        ->with(Mockery::on(fn($arg) => $arg->isSameDay($date)))
        ->andReturn($ordersCollection);

    $this->action->execute($date);

    Mail::assertSent(DailyReportMail::class, function (DailyReportMail $mail) {
        $mail->build();
        return $mail->hasTo('manager@company.com') &&
               $mail->ordersCount === 2 &&
               $mail->totalRevenue === 375.5;
    });
    
    Log::shouldHaveReceived('info')->with(
        'Daily report generated and queued successfully.',
        Mockery::any()
    );
});

it('secara aman membisukan laporan operasi apabila tiada data transaksi', function () {
    $date = CarbonImmutable::create(2026, 7, 30);
    
    $this->repository
        ->shouldReceive('getCompletedOrdersForDate')
        ->once()
        ->andReturn(new Collection());

    $this->action->execute($date);

    Mail::assertNothingSent();
    
    Log::shouldHaveReceived('info')->with(
        'Daily report skipped: No completed orders found.',
        ['date' => $date->toDateString()]
    );
});
```

### C. Feature Testing pada Pendaftaran Rutin Penjadwal Konsol (Kernel Binding)
Menguji registrasi ke internal service container `Illuminate\Console\Scheduling\Schedule` guna memastikan bahwa perintah dikonfigurasi pada rentang waktu kron, timezone, dan kondisi pelindung yang spesifik. Kegagalan tes ini membuktikan konfigurasi cron server berpotensi rusak dan tak teregistrasi.

```php
<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use Illuminate\Console\Scheduling\Event;
use Illuminate\Console\Scheduling\Schedule;

it('berhasil mengikat konfigurasi command harian akurat pukul 08:00 AM WIB dengan proteksi lengkap', function () {
    // Ekstraksi instansi jadwal yang diresolusi dari inti kerangka kerja
    $scheduleApp = app()->make(Schedule::class);
    $registeredEvents = collect($scheduleApp->events());
    
    // Pemindaian pencarian event jadwal spesifik komando harian kita
    $dailyReportEventTarget = $registeredEvents->first(function (Event $event) {
        return str_contains($event->command, 'reports:send-daily');
    });
    
    expect($dailyReportEventTarget)
        ->not->toBeNull('Perintah lapor harian gagal didaftarkan pada jadwal root.')
        
        // Memastikan sintaksis pola waktu Cron mutlak di detik angka 0 menit 0 dan jam 8
        ->and($dailyReportEventTarget->expression)
        ->toBe('0 8 * * *')
        
        // Memastikan penjadwalan dikunci secara khusus pada zona waktu Jakarta
        ->and($dailyReportEventTarget->timezone)
        ->toBe('Asia/Jakarta')
        
        // Memastikan Atomic Lock / Tanpa Tumpang Tindih aktif untuk mencegah race condition
        ->and($dailyReportEventTarget->withoutOverlapping)
        ->toBeTrue()
        
        // Memastikan konfigurasi Single Server Pool dihidupkan untuk Multi-node
        ->and($dailyReportEventTarget->onOneServer)
        ->toBeTrue();
});
```
