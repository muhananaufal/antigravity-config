# Laravel Horizon & Enterprise Queue Monitoring: Panduan Masterclass (Top 1%)

Laravel Horizon memberikan dashboard dan konfigurasi code-driven untuk Redis queue pada ekosistem Laravel. Di level enterprise, Horizon bukan sekadar dashboard, melainkan orchestration tool krusial untuk menangani jutaan asynchronous jobs, mendeteksi bottleneck, auto-scaling worker process, dan menjaga ketersediaan sistem. Panduan ini mengupas tuntas implementasi Horizon dengan standar PHP 8.4 dan Laravel 11/12 menggunakan Clean Architecture, Pest v3, dan standar defensive programming.

---

## 1. Arsitektur Internal dan Mekanisme Kerja Horizon

Berbeda dengan perintah `queue:work` standar yang sering berjalan secara *standalone* melalui Supervisor atau Systemd, Horizon mengadopsi model *Master-Worker*.

1.  **Master Process (`horizon`)**: Proses utama yang membaca file konfigurasi `config/horizon.php`.
2.  **Supervisor Process**: Master process melahirkan (spawn) satu atau beberapa supervisor process. Supervisor bertanggung jawab atas *pool* antrean (queue) tertentu.
3.  **Worker Processes**: Supervisor memantau dan melahirkan worker process yang sesungguhnya menjalankan `queue:work`. Supervisor dapat menambah (scale up) atau mengurangi (scale down) jumlah worker berdasarkan *workload* aktual (metrics).
4.  **Redis Data Structures**: Horizon menggunakan Redis secara ekstensif (hashes, sets, lists) untuk mencatat metrik (throughput, waktu tunggu, job gagal) tanpa membebani database SQL.
5.  **Snapshots**: Horizon secara berkala mengeksekusi *snapshot* untuk menyimpan tren kinerja dalam Redis, yang kemudian dirender di dashboard.

### Kapan Menggunakan Horizon?
Horizon *wajib* digunakan ketika Anda menggunakan driver Redis dan membutuhkan:
- Visibilitas real-time untuk job failures, throughput, dan puncaknya (spikes).
- Konfigurasi supervisor yang terdefinisi di dalam kontrol versi (git) alih-alih hardcoded di server `/etc/supervisor/conf.d`.
- Auto-scaling proses queue tanpa intervensi manual tim DevOps.

---

## 2. Konfigurasi Tingkat Enterprise (Auto-Scaling & Silo)

Dalam skala besar, memisahkan *queue* menjadi beberapa prioritas adalah keharusan mutlak. File `config/horizon.php` harus dioptimalkan.

```php
<?php

declare(strict_types=1);

use Illuminate\Support\Str;

return [
    'domain' => env('HORIZON_DOMAIN'),
    'path' => env('HORIZON_PATH', 'horizon'),
    'use' => 'default',
    'prefix' => env('HORIZON_PREFIX', Str::slug(env('APP_NAME', 'laravel'), '_').'_horizon:'),

    'middleware' => ['web', 'horizon.auth'],
    
    'waits' => [
        'redis:default' => 60,
        'redis:critical' => 30, // Peringatan jika job antre > 30 detik
        'redis:reports' => 300,
    ],

    'trim' => [
        'recent' => 60,
        'pending' => 60,
        'completed' => 60,
        'recent_failed' => 10080, // 7 hari
        'failed' => 10080,
        'monitored' => 10080,
    ],

    'metrics' => [
        'trim_snapshots' => [
            'job' => 24,
            'queue' => 24,
        ],
    ],

    'fast_termination' => true, // Kirim SIGTERM, worker akan menyelesaikan job berjalan, baru mati

    'memory_limit' => 128,

    'environments' => [
        'production' => [
            'supervisor-critical' => [
                'connection' => 'redis',
                'queue' => ['critical'],
                'balance' => 'auto',
                'autoScalingStrategy' => 'time', // Scaling berdasarkan waktu tunggu, bukan jumlah job
                'minProcesses' => 5,
                'maxProcesses' => 20,
                'balanceMaxShift' => 1,
                'balanceCooldown' => 3,
                'tries' => 3,
                'timeout' => 60,
            ],
            'supervisor-default' => [
                'connection' => 'redis',
                'queue' => ['default', 'notifications', 'emails'],
                'balance' => 'auto',
                'minProcesses' => 1,
                'maxProcesses' => 15,
                'tries' => 3,
                'timeout' => 120, // Timeout lebih lama untuk email/notifikasi
            ],
            'supervisor-heavy' => [
                'connection' => 'redis',
                'queue' => ['reports', 'export'],
                'balance' => 'simple', // Tidak auto-scale, proses tetap konstan
                'processes' => 3,
                'tries' => 1,
                'timeout' => 3600, // Long running task
            ],
        ],
    ],
];
```

---

## 3. Clean Architecture: Job sebagai Orkestrator Eksekusi

Pada arsitektur enterprise, Job Class tidak boleh berisi domain logic kompleks. Job berfungsi mirip dengan Controller; ia menerima input, mendelegasikan eksekusi ke Action atau Service layer, dan menangani state kegagalan (retry/release).

### Domain Model & Repository (Infrastructure)

```php
<?php

declare(strict_types=1);

namespace App\Domain\Invoices\Models;

use Illuminate\Database\Eloquent\Model;

final class Invoice extends Model
{
    protected $fillable = ['status', 'amount', 'customer_id', 'pdf_path'];
    
    // Properti class definition opsional via dockblock atau properti strongly typed
}
```

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Persistence\Repositories;

use App\Domain\Invoices\Models\Invoice;

final class InvoiceRepository
{
    public function findById(int $id): ?Invoice
    {
        return Invoice::query()->find($id);
    }
    
    public function updateStatus(Invoice $invoice, string $status): bool
    {
        return $invoice->update(['status' => $status]);
    }
}
```

### Action/Service Layer (Domain Logic)

```php
<?php

declare(strict_types=1);

namespace App\Application\Actions\Invoices;

use App\Domain\Invoices\Models\Invoice;
use App\Infrastructure\Persistence\Repositories\InvoiceRepository;
use Illuminate\Support\Facades\Log;

final readonly class GenerateInvoicePdfAction
{
    public function __construct(
        private InvoiceRepository $repository,
        private PdfGeneratorService $pdfGenerator,
    ) {}

    public function execute(int $invoiceId): void
    {
        $invoice = $this->repository->findById($invoiceId);
        
        if (! $invoice) {
            Log::warning("Invoice not found for PDF generation", ['id' => $invoiceId]);
            return; // Exit graceful, jangan throw error jika dihapus
        }
        
        if ($invoice->status !== 'pending') {
            return; // Idempotency check
        }

        $path = $this->pdfGenerator->generate($invoice);
        
        $invoice->pdf_path = $path;
        $this->repository->updateStatus($invoice, 'generated');
    }
}
```

### Job Class (Orkestrator Asynchronous)

```php
<?php

declare(strict_types=1);

namespace App\Jobs\Invoices;

use App\Application\Actions\Invoices\GenerateInvoicePdfAction;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Queue\Middleware\WithoutOverlapping;
use Throwable;

final class GenerateInvoicePdfJob implements ShouldQueue, ShouldBeUnique
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;
    use SerializesModels;

    /**
     * The number of times the job may be attempted.
     */
    public int $tries = 3;
    
    /**
     * The number of seconds the job can run before timing out.
     */
    public int $timeout = 120;

    /**
     * Indicate if the job should be marked as failed on timeout.
     */
    public bool $failOnTimeout = true;

    /**
     * Create a new job instance.
     */
    public function __construct(
        public readonly int $invoiceId,
    ) {
        $this->onQueue('critical');
    }

    /**
     * The unique ID of the job.
     */
    public function uniqueId(): string
    {
        return (string) $this->invoiceId;
    }

    /**
     * Get the middleware the job should pass through.
     * 
     * @return array<int, object>
     */
    public function middleware(): array
    {
        // Cegah eksekusi paralel untuk invoice yang sama
        return [
            (new WithoutOverlapping((string) $this->invoiceId))->dontRelease()
        ];
    }

    /**
     * Execute the job.
     */
    public function handle(GenerateInvoicePdfAction $action): void
    {
        $action->execute($this->invoiceId);
    }
    
    /**
     * Handle a job failure.
     */
    public function failed(Throwable $exception): void
    {
        // Event spesifik yang dilempar saat terjadi kegagalan permanen
        // event(new InvoicePdfGenerationFailed($this->invoiceId, $exception));
    }
}
```

---

## 4. Anti-Patterns & Defensive Programming

Dalam mengelola antrean (queues), celah kecil dalam arsitektur dapat merusak seluruh server Redis dan menyebabkan memory leak atau bottleneck yang parah.

### Anti-Pattern 1: Mengirim Objek Eloquent Utuh dan Payload Raksasa
Ketika mendelegasikan job ke antrean, Horizon (melalui Redis) menyimpan state tersebut sebagai JSON (serialized payload). Jika Anda melempar model Eloquent utuh yang sudah di-*load* bersama relasi-relasinya (N+1), ukuran payload membengkak (bisa puluhan MB per job).

❌ **KODE SALAH (Memory Bloat & Stale Data Risk):**
```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use App\Domain\Users\Models\User;

final class ProcessUserExportJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    // BAHAYA: Menyimpan objek utuh, jika User memiliki relasi e.g., $user->posts
    // maka ribuan posts juga ikut di-serialize masuk ke Redis!
    // Lebih parah lagi: saat job jalan (misal besok), data di objek ini sudah STALE (basi).
    public function __construct(
        public User $user,
        public array $hugeArrayData
    ) {}

    public function handle(): void
    {
        // Proses datanya secara lambat karena OOM
        $exportData = collect($this->hugeArrayData)->map(fn($data) => $this->user->id);
    }
}
```

✅ **KODE BENAR (Hanya mengirim ID dan primitive types):**
```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use App\Infrastructure\Persistence\Repositories\UserRepository;

final class ProcessUserExportJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    // AMAN: Hanya mengirim primitive type (ID). Payload sangat ringan (< 1KB).
    // Data query ulang (fresh) di eksekusi.
    public function __construct(
        public readonly int $userId,
        public readonly string $exportFilterToken // Simpan data besar di cache/DB, passing tokennya saja
    ) {}

    public function handle(UserRepository $repository): void
    {
        $user = $repository->findById($this->userId);
        if (! $user) {
            return; // Graceful degradation
        }
        
        // Eksekusi proses dengan data fresh
    }
}
```
**Penjelasan Risiko:** Menyimpan *state* Eloquent secara tidak hati-hati berisiko *Max Memory Reached* pada Redis (OOM - Out of Memory). Redis akan mulai membuang key (eviction) atau menolak write operation, yang membuat aplikasi mati total. Selain itu, *SerializesModels* dapat memuat ulang model yang mungkin sudah terhapus, melempar exception ghaib `ModelNotFoundException` yang sulit di-debug.

### Anti-Pattern 2: Job Tanpa Batasan (Infinite Retries, Overlapping, No Rate Limiting)
Tidak membentengi Job dari API pihak ketiga atau operasi bersamaan (race condition).

❌ **KODE SALAH (Blind Execution):**
```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Http;

final class ChargeCreditCardJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;
    
    public function __construct(public int $paymentId) {}

    public function handle(): void
    {
        // BAHAYA 1: Tidak ada timeout pada cURL/Http
        // BAHAYA 2: Tidak ada WithoutOverlapping, double dispatch bisa men-charge 2x
        // BAHAYA 3: Tidak ada limit retries, jika API mati, job muter selamanya
        $response = Http::post('https://api.stripe.com/charge', ['payment_id' => $this->paymentId]);
        
        if ($response->failed()) {
            throw new \Exception("Stripe failed");
        }
    }
}
```

✅ **KODE BENAR (Defensive Queueing & Idempotency):**
```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Queue\Middleware\RateLimited;
use Illuminate\Queue\Middleware\WithoutOverlapping;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Redis;

final class ChargeCreditCardJob implements ShouldQueue, ShouldBeUnique
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;
    
    public int $tries = 3;
    public int $timeout = 30; // Max execution 30 detik
    
    // Backoff eksponensial: retry dalam 10s, 30s, 90s.
    public array $backoff = [10, 30, 90]; 

    public function __construct(public readonly int $paymentId) {}

    public function uniqueId(): string
    {
        return (string) $this->paymentId;
    }

    public function middleware(): array
    {
        return [
            // Cegah eksekusi duplikat di worker berbeda bersamaan
            (new WithoutOverlapping((string) $this->paymentId))->releaseAfter(60),
            // Rate limit ke third party (contoh: 10 req / detik)
            (new RateLimited('stripe_api')),
        ];
    }

    public function handle(): void
    {
        // Idempotency Check tambahan
        if ($this->isAlreadyPaid($this->paymentId)) {
            return;
        }

        // AMAN: Memakai timeout 10 detik agar tidak menggantung worker
        $response = Http::timeout(10)->post('https://api.stripe.com/charge', [
            'payment_id' => $this->paymentId,
            'idempotency_key' => 'charge_' . $this->paymentId
        ]);
        
        if ($response->serverError()) {
            // Lempar ke delay retry
            $this->release(30); 
            return;
        }

        if ($response->clientError()) {
            // Jangan retry kalau error 400 (bad request), buang job.
            $this->fail(new \Exception("Invalid payload: " . $response->body()));
            return;
        }
    }
    
    private function isAlreadyPaid(int $id): bool
    {
        return (bool) Redis::get('payment_status:'.$id);
    }
}
```
**Penjelasan Risiko:** Job tanpa defense mechanism seperti timeout, `WithoutOverlapping`, dan eksternal timeout dapat membuat Worker Horizon Anda terkunci (stuck). Supervisor akan melihat *queue latency* naik tajam, mencoba me-spawn worker baru, yang akhirnya juga stuck, menghabiskan seluruh memori dan koneksi sistem (Cascading Failure).

---

## 5. Instrumentasi: Telemetri Horizon

Untuk memastikan sistem queue berjalan optimal di production, daftarkan Event Listener untuk memonitor queue yang macet atau job yang terus gagal, misalnya mengintegrasikan notifikasi ke Slack.

Buat file di `app/Providers/HorizonServiceProvider.php`:

```php
<?php

declare(strict_types=1);

namespace App\Providers;

use Illuminate\Support\Facades\Event;
use Illuminate\Queue\Events\JobFailed;
use Laravel\Horizon\Events\LongWaitDetected;
use Illuminate\Support\ServiceProvider;
use Illuminate\Support\Facades\Log;

final class HorizonServiceProvider extends ServiceProvider
{
    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        Event::listen(LongWaitDetected::class, function (LongWaitDetected $event): void {
            // Queue mengalami penumpukan (melebihi konfigurasi config/horizon.php 'waits')
            Log::critical("Horizon Alert: Long wait detected on queue", [
                'connection' => $event->connection,
                'queue' => $event->queue,
                'wait_seconds' => $event->seconds,
            ]);
            // Notifikasi PagerDuty atau sistem Monitoring (NewRelic, Datadog)
        });

        Event::listen(JobFailed::class, function (JobFailed $event): void {
            Log::error("Job Failed permanently", [
                'connection_name' => $event->connectionName,
                'job' => $event->job->resolveName(),
                'exception' => $event->exception->getMessage(),
            ]);
        });
    }
}
```

---

## 6. Pest v3 Testing: Unit, Integration & Architecture

Di level enterprise, kita tidak hanya menguji secara unit (apakah logika benar), tapi juga secara arsitektur (apakah setiap Job diprogram dengan benar). Pest v3 sangat superior untuk ini.

### Architecture Testing (Mencegah Kebocoran Konvensi)

```php
<?php

declare(strict_types=1);

// tests/Arch/JobArchitectureTest.php

uses()->group('architecture');

test('all jobs must implement ShouldQueue interface')
    ->expect('App\Jobs')
    ->toImplement(\Illuminate\Contracts\Queue\ShouldQueue::class)
    ->and('App\Jobs')
    ->toHaveMethod('handle');

test('jobs should not use Eloquent models as public properties directly')
    ->expect('App\Jobs')
    ->not->toUse('Illuminate\Database\Eloquent\Model'); // Memaksa agar hanya ID yg di passing

test('horizon configuration must be strictly typed array')
    ->expect(config('horizon'))
    ->toBeArray();
```

### Unit & Integration Testing Job & Action

```php
<?php

declare(strict_types=1);

// tests/Feature/Jobs/GenerateInvoicePdfJobTest.php

use App\Jobs\Invoices\GenerateInvoicePdfJob;
use App\Application\Actions\Invoices\GenerateInvoicePdfAction;
use App\Application\Actions\Invoices\PdfGeneratorService;
use App\Domain\Invoices\Models\Invoice;
use Illuminate\Support\Facades\Queue;
use function Pest\Laravel\assertDatabaseHas;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Mockery;

uses(RefreshDatabase::class);

it('dispatches the GenerateInvoicePdfJob onto the critical queue', function () {
    Queue::fake();

    // Trigger dari service manapun yang memanggil dispatch
    GenerateInvoicePdfJob::dispatch(123);

    Queue::assertPushed(GenerateInvoicePdfJob::class, function (GenerateInvoicePdfJob $job) {
        return $job->invoiceId === 123 && $job->queue === 'critical';
    });
});

it('executes the action when job is handled', function () {
    // 1. Arrange
    $actionMock = Mockery::mock(GenerateInvoicePdfAction::class);
    $actionMock->shouldReceive('execute')
        ->once()
        ->with(999);

    $job = new GenerateInvoicePdfJob(999);

    // 2. Act
    $job->handle($actionMock);

    // 3. Assert (dihandle oleh once() dari Mockery)
    expect(true)->toBeTrue();
});

it('verifies integration of GenerateInvoicePdfAction', function () {
    // 1. Arrange DB
    $invoice = Invoice::create([
        'status' => 'pending',
        'amount' => 1000,
        'customer_id' => 1,
        'pdf_path' => null,
    ]);

    // Fakes PdfGeneratorService if bound in container
    $pdfServiceMock = Mockery::mock(PdfGeneratorService::class);
    $pdfServiceMock->shouldReceive('generate')
        ->once()
        ->andReturn('/storage/pdfs/inv-1.pdf');
    
    app()->instance(PdfGeneratorService::class, $pdfServiceMock);

    $action = app(GenerateInvoicePdfAction::class);

    // 2. Act
    $action->execute($invoice->id);

    // 3. Assert
    assertDatabaseHas('invoices', [
        'id' => $invoice->id,
        'status' => 'generated',
        'pdf_path' => '/storage/pdfs/inv-1.pdf',
    ]);
});
```

## Kesimpulan

Mengimplementasikan Laravel Horizon di skala *Enterprise* bukan hanya soal menjalankan artisan command. Ini mencakup pemahaman mendalam tentang **Clean Architecture** (memisahkan Job orchestrator dari Business Logic), penerapan **Defensive Programming** untuk memitigasi cascading failures, pengelolaan memory yang cerdas dengan menghindari serialize Model secara rakus, dan menjaganya dengan arsitektur testing (Pest Arch) agar kode tetap berada di jalur *Top 1% Quality*.
