# Laravel Queue & Workers: Internals, Scaling, and Resilience

Ekosistem Queue dan Worker pada Laravel adalah salah satu tulang punggung dalam membangun aplikasi web yang highly scalable dan responsif. Dengan mendelegasikan tugas-tugas berat, I/O bound, atau sinkronisasi data ke background process, waktu respons aplikasi dapat dijaga pada level optimal (biasanya di bawah 200ms). Dokumen ini membahas mendalam mengenai arsitektur internal, manajemen scaling menggunakan Laravel Horizon, penanganan kegagalan (failure handling), telemetri, implementasi berarsitektur bersih (Clean Architecture), serta pengujian menggunakan Pest v3.

## 1. Arsitektur Internal Queue & Worker

Secara fundamental, sistem Queue Laravel beroperasi berdasarkan mekanisme Producer-Consumer.
- **Producer**: Aplikasi (via Controller/Service) yang melakukan *dispatch* Job.
- **Broker**: Sistem penyimpanan antrean (contoh: Redis, RabbitMQ, SQS, Database).
- **Consumer**: Proses worker CLI (`php artisan queue:work`) yang mengambil (pop) Job dari Broker dan mengeksekusinya.

### Siklus Hidup Eksekusi Job (The Job Execution Lifecycle)

1. **Serialization**: Saat Job di-*dispatch*, Laravel mengonversi objek Job dan semua propertinya (termasuk model Eloquent menggunakan tipe khusus seperti `ModelIdentifier`) ke dalam representasi string (biasanya JSON).
2. **Push**: Representasi string ini disimpan di broker antrean.
3. **Pop**: Worker mengambil string tersebut secara atomik dari broker. Di Redis, ini memanfaatkan perintah LPOP atau mekanisme reserved list untuk menjamin atomisitas.
4. **Unserialization**: Payload JSON diubah kembali menjadi objek PHP. Model Eloquent akan ditarik ulang secara segar dari database menggunakan ID yang disimpan (mencegah modifikasi data asinkron tertimpa oleh data usang).
5. **Execution**: Worker mengeksekusi metode `handle()` pada Job.

## 2. Scaling dengan Laravel Horizon (Redis)

Laravel Horizon adalah dashboard elegan dan sistem manajemen worker khusus untuk driver Redis. Alih-alih menjalankan proses worker secara manual melalui systemd atau supervisor, Horizon mengambil alih sebagai *master process* yang dapat memantau, menghentikan, serta melahirkan (spawn) worker-worker anak sesuai beban kerja (Auto-Scaling).

### Konfigurasi Horizon (config/horizon.php)

Berikut adalah pengaturan ideal untuk lingkungan produksi (Production) yang memerlukan isolasi antrean, auto-scaling berdasar latensi, dan prioritas antrean.

```php
<?php

declare(strict_types=1);

return [
    'domain' => env('HORIZON_DOMAIN', null),
    'path' => env('HORIZON_PATH', 'horizon'),
    'use' => 'default',
    'prefix' => env('HORIZON_PREFIX', 'horizon:'),
    'middleware' => ['web'],
    'waits' => [
        'redis:high' => 60,
        'redis:default' => 60,
    ],
    'trim' => [
        'recent' => 60,
        'pending' => 60,
        'completed' => 60,
        'recent_failed' => 10080,
        'failed' => 10080,
        'monitored' => 10080,
    ],
    'fast_termination' => false,
    'memory_limit' => 256,
    'defaults' => [
        'supervisor-1' => [
            'connection' => 'redis',
            'queue' => ['high', 'default', 'low'],
            'balance' => 'auto',
            'autoScalingStrategy' => 'time', // Waktu tunggu rata-rata
            'maxProcesses' => 20,
            'minProcesses' => 2,
            'maxTime' => 0,
            'maxJobs' => 0,
            'memory' => 128,
            'tries' => 3,
            'timeout' => 60,
            'nice' => 0,
        ],
    ],
    'environments' => [
        'production' => [
            'supervisor-1' => [
                'maxProcesses' => 50,
                'balanceMaxShift' => 5,
                'balanceCooldown' => 2,
            ],
        ],
        'local' => [
            'supervisor-1' => [
                'maxProcesses' => 3,
            ],
        ],
    ],
];
```

## 3. Failure Handling & Telemetry

Kegagalan eksekusi (Failure) adalah bagian pasti dalam komputasi terdistribusi (Distributed Computing). Laravel menyediakan mekanisme untuk `tries`, `timeout`, `backoff`, dan penanganan pengecualian (exception handling) secara mendetail pada level Job.

### Advanced Job Resilience

```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use App\Models\Order;
use App\Services\Payment\PaymentGatewayInterface;
use Throwable;

final class ProcessPaymentJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    /**
     * Jumlah percobaan maksimal sebelum job dianggap gagal.
     */
    public int $tries = 5;

    /**
     * Jumlah detik maksimum sebelum job terkena timeout (tergantung driver).
     */
    public int $timeout = 120;

    /**
     * Jumlah percobaan ulang berantai (exponential backoff).
     *
     * @return array<int, int>
     */
    public function backoff(): array
    {
        return [10, 30, 60, 120];
    }

    public function __construct(
        public readonly Order $order
    ) {}

    public function handle(PaymentGatewayInterface $paymentGateway): void
    {
        // Pengecekan pra-eksekusi untuk menghindari balapan (race condition)
        if ($this->order->isPaid()) {
            return;
        }

        $paymentGateway->charge($this->order);
        $this->order->markAsPaid();
    }

    /**
     * Telemetri: Laporkan kegagalan sistemik, hindari pelaporan log untuk error semantik.
     */
    public function failed(Throwable $exception): void
    {
        // Simpan log ke layanan eksternal misal Sentry atau Datadog
        report($exception);
        
        $this->order->markAsFailed();
    }
}
```

## 4. Implementasi Clean Architecture pada Job Dispatch

Mendispatch sebuah Job langsung dari Controller seringkali membuat Controller terikat kuat (tightly coupled) dengan detail eksekusi. Clean Architecture mempromosikan alur: **FormRequest** -> **Controller** -> **Action/Service** -> **Job/Repository** -> **Model**.

Berikut implementasi dunia nyata (Real-world) sistem registrasi pengguna.

### FormRequest (Validasi)

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\User;

use Illuminate\Foundation\Http\FormRequest;

final class RegisterUserRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'string', 'email', 'max:255', 'unique:users,email'],
            'password' => ['required', 'string', 'min:8', 'confirmed'],
        ];
    }
}
```

### Action (Bisnis Logika & Job Dispatch)

```php
<?php

declare(strict_types=1);

namespace App\Actions\User;

use App\Models\User;
use App\Repositories\User\UserRepositoryInterface;
use App\Jobs\SendWelcomeEmailJob;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use App\DataTransferObjects\UserRegistrationData;

final readonly class RegisterUserAction
{
    public function __construct(
        private UserRepositoryInterface $userRepository
    ) {}

    public function execute(UserRegistrationData $data): User
    {
        return DB::transaction(function () use ($data): User {
            $user = $this->userRepository->create([
                'name' => $data->name,
                'email' => $data->email,
                'password' => Hash::make($data->password),
            ]);

            // Dispatch job secara sinkron terhadap transaksi (After Commit)
            SendWelcomeEmailJob::dispatch($user)->afterCommit();

            return $user;
        });
    }
}
```

### Controller

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\User;

use App\Http\Controllers\Controller;
use App\Http\Requests\User\RegisterUserRequest;
use App\Actions\User\RegisterUserAction;
use App\DataTransferObjects\UserRegistrationData;
use Illuminate\Http\JsonResponse;

final class RegisterUserController extends Controller
{
    public function __construct(
        private readonly RegisterUserAction $registerUserAction
    ) {}

    public function __invoke(RegisterUserRequest $request): JsonResponse
    {
        $dto = new UserRegistrationData(
            name: $request->validated('name'),
            email: $request->validated('email'),
            password: $request->validated('password'),
        );

        $user = $this->registerUserAction->execute($dto);

        return response()->json([
            'message' => 'User registered successfully.',
            'data' => clone $user,
        ], 201);
    }
}
```

## 5. Anti-Patterns dalam Queue

Ketika menggunakan Queues, sangat penting untuk menjaga performa memori dan integritas data. Berikut adalah Anti-Pattern umum, dampaknya, serta pendekatan yang benar.

### Anti-Pattern 1: Menyimpan Konten File Besar atau Data Lengkap dalam Job Payload

❌ **KODE SALAH (Berbahaya)**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Jobs\ProcessVideoJob;
use Illuminate\Http\Request;

class VideoController extends Controller
{
    public function store(Request $request): void
    {
        // Mengambil isi keseluruhan file (puluhan Megabytes) ke dalam memory string
        $fileContent = file_get_contents($request->file('video')->getRealPath());
        
        // Meneruskan RAW STRING bytes file ke dalam konstruktor Job
        // Payload antrean (Redis/DB) akan membengkak gila-gilaan, dan berisiko Redis OOM!
        ProcessVideoJob::dispatch($fileContent);
    }
}
```
**Penjelasan Risiko:** Menyimpan data berjumlah besar seperti byte stream dari file, array besar berisi ribuan baris data CSV secara langsung ke dalam konstruktor Job (payload Job) akan memakan beban bandwidth yang besar terhadap Redis (Broker). Memori worker juga berisiko meledak (Out of Memory/OOM) saat mencoba melakukan deserialisasi (unserialization) array JSON yang masif. Payload Queue idealnya harus seminimal mungkin (ID atau Referensi File Saja).

✅ **KODE BENAR (Optimal & Aman)**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Jobs\ProcessVideoJob;
use Illuminate\Http\Request;

class VideoController extends Controller
{
    public function store(Request $request): void
    {
        // Menyimpan file di disk, yang dapat diakses oleh Worker (biasanya object storage spt S3)
        $filePath = $request->file('video')->store('videos', 's3');
        
        // Meneruskan *HANYA REFERENSI PATH/ID* ke dalam Job
        // Worker bertugas untuk mengambil file dari storage
        ProcessVideoJob::dispatch($filePath);
    }
}
```

### Anti-Pattern 2: Tidak Mempersiapkan Race Condition pada Background Worker

❌ **KODE SALAH (Berbahaya)**
```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Models\Wallet;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;

final class ProcessRewardJob implements ShouldQueue
{
    use Dispatchable, Queueable;

    public function __construct(public Wallet $wallet, public int $amount) {}

    public function handle(): void
    {
        // BAHAYA: Ini dapat memicu kondisi balapan (Race Condition)
        // Jika job dijalankan oleh 2 worker secara berdekatan (karena backoff/retry loop), 
        // kalkulasi uang bisa ganda karena `balance` dibaca di memori!
        $this->wallet->balance += $this->amount;
        $this->wallet->save();
    }
}
```
**Penjelasan Risiko:** Job berjalan secara konkuren dan tidak terprediksi. Melakukan update terhadap saldo menggunakan bacaan properti asinkron (di memori) dan menimpanya ke DB secara telanjang sangat berisiko race condition, karena Model diserialisasi dan status data bisa berubah selama delay waktu `dispatch` hingga `handle`.

✅ **KODE BENAR (Optimal & Aman)**
```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Models\Wallet;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Support\Facades\DB;

final class ProcessRewardJob implements ShouldQueue
{
    use Dispatchable, Queueable;

    // Memastikan framework mengambil data fresh dari database, bukan menahan kondisi memori lampau
    public function __construct(public Wallet $wallet, public int $amount) {}

    public function handle(): void
    {
        // Cara Aman: Pindahkan update kalkulasi saldo (arithmetic increment)
        // langsung di tingkat mesin database menggunakan Atomic Locks atau DB transaction locking
        DB::transaction(function (): void {
            // Pessimistic Locking untuk keamanan ganda jika skenario finansial kompleks
            $freshWallet = Wallet::where('id', $this->wallet->id)->lockForUpdate()->firstOrFail();
            $freshWallet->increment('balance', $this->amount);
        });
    }
}
```

## 6. Pengujian (Testing) dengan Pest v3

Dalam arsitektur teruji, kita harus memastikan:
1. Validasi Arsitektur (Architecture rules ditaati).
2. Konfigurasi Job di-dispatch dengan benar (Faking Queue).
3. Logika internal dalam method `handle()` berjalan tanpa kesalahan (Integration test dengan Database).

### Arch Testing untuk Job

Gunakan fitur bawaan dari Pest untuk menegakkan kebijakan statis arsitektur kode.

```php
<?php

declare(strict_types=1);

// tests/Arch/JobsArchTest.php

use Illuminate\Contracts\Queue\ShouldQueue;

arch('jobs_strict_rules')
    ->expect('App\Jobs')
    ->toBeFinal() // Menuntut kelas Job menjadi final class
    ->toImplement(ShouldQueue::class)
    ->toUseStrictTypes()
    ->toHaveConstructor();
```

### Unit/Feature Testing untuk Worker Dispatch dan Eksekusi

```php
<?php

declare(strict_types=1);

// tests/Feature/Actions/RegisterUserActionTest.php

use App\Actions\User\RegisterUserAction;
use App\DataTransferObjects\UserRegistrationData;
use App\Jobs\SendWelcomeEmailJob;
use App\Models\User;
use App\Repositories\User\UserRepositoryInterface;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Hash;
use Mockery\MockInterface;

it('creates a user and dispatches a welcome email job after transaction commit', function (): void {
    // Fake system queue untuk menghindari real execution
    Queue::fake();

    /** @var UserRepositoryInterface|MockInterface $repository */
    $repository = Mockery::mock(UserRepositoryInterface::class);
    $action = new RegisterUserAction($repository);

    $dto = new UserRegistrationData(
        name: 'John Doe',
        email: 'john@example.com',
        password: 'securePassword123'
    );

    $createdUser = new User([
        'id' => 1,
        'name' => 'John Doe',
        'email' => 'john@example.com',
        'password' => Hash::make('securePassword123'),
    ]);

    $repository->shouldReceive('create')->once()->andReturn($createdUser);

    $user = $action->execute($dto);

    // Assert User dikembalikan dengan benar
    expect($user->email)->toBe('john@example.com');

    // Assert Queue benar-benar mendispatch Job yang tepat
    Queue::assertPushed(SendWelcomeEmailJob::class, function (SendWelcomeEmailJob $job) use ($createdUser): bool {
        return $job->user->id === $createdUser->id;
    });
});
```

### Testing Logika Handler Job (Integration)

```php
<?php

declare(strict_types=1);

// tests/Feature/Jobs/ProcessPaymentJobTest.php

use App\Jobs\ProcessPaymentJob;
use App\Models\Order;
use App\Services\Payment\PaymentGatewayInterface;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Mockery\MockInterface;

uses(RefreshDatabase::class);

it('charges payment and updates order status successfully', function (): void {
    $order = Order::factory()->create([
        'status' => 'pending',
    ]);

    /** @var PaymentGatewayInterface|MockInterface $paymentGateway */
    $paymentGateway = Mockery::mock(PaymentGatewayInterface::class);
    $paymentGateway->shouldReceive('charge')->once()->with($order);

    $job = new ProcessPaymentJob($order);
    
    // Mengeksekusi manual dengan menyuntikkan mock
    $job->handle($paymentGateway);

    // Refresh model dari db
    $order->refresh();

    // Pastikan order status terganti
    expect($order->status)->toBe('paid');
});

it('aborts charge if order is already paid', function (): void {
    $order = Order::factory()->create([
        'status' => 'paid',
    ]);

    $paymentGateway = Mockery::mock(PaymentGatewayInterface::class);
    $paymentGateway->shouldReceive('charge')->never();

    $job = new ProcessPaymentJob($order);
    $job->handle($paymentGateway);
});
```

## Kesimpulan

Mengoperasikan Laravel Queue dan Workers untuk lingkungan skala besar menuntut kewaspadaan penuh terhadap batasan eksekusi asinkron: hindari race condition, kecilkan footprint memori (payload yang padat), sediakan retries yang memadai, dan amankan setiap entitas model dengan pembaharuan data termutakhir (fresh instance / locks). Horizon menawarkan visibilitas yang mumpuni, sedangkan Pest v3 memvalidasi keamanan ini sebelum rilis ke Production, menjamin kualitas aplikasi (Code Quality) selalu berada di atas standar 1%.
