# Panduan Komprehensif Audit Logging dan Keamanan Log di Laravel 11/12 (PHP 8.3+)

Audit logging merupakan salah satu pilar utama dalam strategi keamanan aplikasi enterprise. Tanpa sistem logging yang komprehensif, investigasi insiden keamanan (forensik digital), pemantauan kepatuhan (compliance) seperti SOC2, HIPAA, atau GDPR, serta deteksi anomali perilaku pengguna menjadi mustahil dilakukan.

Dalam ekosistem Laravel 11 dan 12 (berjalan di atas PHP 8.3+), implementasi audit logging harus dirancang sedemikian rupa sehingga:
1. **Tidak mengganggu performa utama aplikasi (Non-Blocking)**: Proses penulisan log tidak boleh memperlambat respons HTTP.
2. **Aman dari manipulasi (Tamper-Evident)**: Log bersifat *append-only* (hanya bisa ditambah, tidak bisa diubah).
3. **Peka terhadap privasi (Privacy-Aware)**: Secara otomatis melakukan sanitasi dan *redaction* terhadap data sensitif seperti kata sandi, token otentikasi, nomor kartu kredit, atau Personally Identifiable Information (PII) sebelum disimpan.

Dokumen ini membedah secara teknis arsitektur audit logging menggunakan standar Clean Architecture, implementasi *best practices*, pengungkapan Anti-Patterns yang berisiko tinggi dan sering ditemukan di industri, serta pengujian terstruktur menggunakan framework Pest v3.

---

## 1. Arsitektur Audit Logging (Clean Architecture)

Implementasi yang ideal akan memisahkan tanggung jawab (*Separation of Concerns*) menjadi beberapa lapisan (*layer*) agar modul tetap *maintainable* dan *testable*:

1. **Domain/Model**: Representasi entitas `AuditLog` beserta *value objects* atau konfigurasi *casts* spesifik Laravel 11.
2. **Data Transfer Object (DTO)**: Kelas *readonly* yang membawa data log dari titik pemicu (*trigger* seperti Observer, Middleware, atau Controller) ke lapisan logika bisnis tanpa terikat pada *HTTP Request*.
3. **Repository Layer**: Abstraksi akses ke sistem persistensi (basis data). Abstraksi ini memudahkan peralihan penyimpanan log eksternal di masa depan (misalnya ke Elasticsearch, AWS CloudWatch, atau Datadog) tanpa mengubah *Action*.
4. **Action/Service Layer**: Berisi logika bisnis spesifik untuk menyiapkan data log, melakukan sanitasi (*redaction*), lalu mendistribusikannya ke antrean (*Queue*).
5. **Event/Observer/Middleware Layer**: Interseptor otomatis yang mengawasi interaksi pengguna atau perubahan data (Eloquent Lifecycle) dan memicu pemanggilan *Action*.

---

## 2. Anti-Patterns dalam Audit Logging

Berikut adalah beberapa implementasi berbahaya yang sering tidak disadari pengembang web.

### Anti-Pattern 1: Menyimpan Log Secara Sinkron pada Main Thread HTTP

Sering kali pengembang menulis log langsung ke basis data dalam siklus *request-response*. Ini sangat berisiko dari sisi ketersediaan layanan (*availability*). Jika terjadi *spike* trafik atau tabel basis data log mengalami latensi karena ukurannya membesar, proses penyimpanan (insert) akan melambat, dan seluruh respons aplikasi ke pengguna (API / Web) akan mengalami *bottleneck*. Ini bisa memicu *timeout* dan menghabiskan ketersediaan koneksi FPM/Octane.

#### ❌ KODE SALAH (Synchronous & Blocking Database I/O)
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\AuditLog;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;

class UserController extends Controller
{
    public function update(Request $request, int $id): JsonResponse
    {
        $user = User::findOrFail($id);
        $user->update($request->validated());

        // BAHAYA: Menulis log secara sinkron.
        // I/O Bound: Jika DB lambat (misal table lock), request pengguna ikut terblokir (blocked thread).
        // Risiko: Degradasi performa yang parah pada Peak Hours.
        AuditLog::create([
            'user_id' => auth()->id(),
            'action' => 'UPDATE_USER',
            'payload' => json_encode($request->all()),
            'ip_address' => $request->ip(),
        ]);

        return response()->json(['status' => 'success']);
    }
}
```

#### ✅ KODE BENAR (Asynchronous & Clean Architecture Pipeline)
Gunakan kombinasi DTO, Action, dan Job Queue agar penulisan log secara I/O dipindahkan ke *background worker process*.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Actions\Audit\DispatchAuditLogAction;
use App\DTOs\AuditLogData;
use App\Http\Requests\UserUpdateRequest;
use App\Models\User;
use Illuminate\Http\JsonResponse;

readonly class UserController
{
    public function __construct(
        private DispatchAuditLogAction $dispatchAuditLog,
    ) {}

    public function update(UserUpdateRequest $request, int $id): JsonResponse
    {
        $user = User::findOrFail($id);
        $user->update($request->validated());

        // BENAR: Pembentukan DTO dan log di-dispatch ke queue. 
        // CPU hanya menghabiskan 1-2 milidetik, sementara insert ke DB ditangani Worker.
        $this->dispatchAuditLog->execute(new AuditLogData(
            eventType: 'UPDATE_USER',
            userId: $request->user()?->id,
            auditableType: User::class,
            auditableId: $user->id,
            oldValues: $user->getOriginal(),
            newValues: $user->getChanges(),
            ipAddress: $request->ip(),
            userAgent: $request->userAgent() ?? 'Unknown'
        ));

        return response()->json(['status' => 'success']);
    }
}
```
**Penjelasan Singkat:** Mengirim tugas logging ke *Queue Worker* (seperti Redis atau RabbitMQ) memastikan waktu respons P99 Latency aplikasi terhadap *request* pengguna tetap sangat cepat, sekaligus memisahkan kegagalan log (misalnya DB mati) dari transaksi utama (pengguna tetap bisa bertransaksi meski log *pending*).

---

### Anti-Pattern 2: Logging Data Sensitif dalam Plaintext (PII Leakage)

Melakukan logging mentah (seperti `$request->all()` atau `$model->getAttributes()`) sering kali menyebabkan kebocoran fatal berupa penyimpanan data otentikasi atau PII ke dalam log *plaintext*. Jika log manajemen dapat diakses oleh tim internal atau bobol, maka seluruh sistem terkompromi.

#### ❌ KODE SALAH (Blind Logging - Merekam Semua Data Tanpa Filter)
```php
<?php

declare(strict_types=1);

namespace App\Observers;

use App\Models\User;
use Illuminate\Support\Facades\Log;

class UserObserver
{
    public function updated(User $user): void
    {
        // BAHAYA SECURITY: $user->getChanges() mungkin berisi 'password' baru atau 
        // kolom 'credit_card'. Data sensitif ini masuk ke file .log lokal / cloud secara plaintext!
        // Melanggar kepatuhan PCI-DSS dan GDPR.
        Log::info('User profile updated', [
            'changes' => $user->getChanges(),
        ]);
    }
}
```

#### ✅ KODE BENAR (Redaction / Obfuscation Pipeline)
Implementasikan komponen *Data Sanitization / Redactor* di level servis untuk secara otomatis me-masking (*mask*) properti sensitif sebelum dikirim ke repositori atau antrean (*queue*).

```php
<?php

declare(strict_types=1);

namespace App\Services\Security;

final class DataRedactor
{
    /**
     * Daftar kata kunci (keys) yang datanya harus diamankan.
     */
    private const array SENSITIVE_KEYS = [
        'password', 'password_confirmation', 'token', 
        'credit_card', 'ccv', 'secret', 'authorization', 'api_key'
    ];

    /**
     * Merecursively memeriksa dan melakukan redaction pada array payload.
     *
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function redact(array $payload): array
    {
        $redacted = [];
        
        foreach ($payload as $key => $value) {
            // Traverse jika nested array
            if (is_array($value)) {
                $redacted[$key] = $this->redact($value);
                continue;
            }

            // Jika key sensitif ditemukan, ganti valuenya
            if ($this->isSensitiveKey((string) $key)) {
                $redacted[$key] = '[REDACTED]';
                continue;
            }

            $redacted[$key] = $value;
        }

        return $redacted;
    }

    private function isSensitiveKey(string $key): bool
    {
        $normalizedKey = strtolower($key);
        foreach (self::SENSITIVE_KEYS as $sensitiveKey) {
            if (str_contains($normalizedKey, $sensitiveKey)) {
                return true;
            }
        }

        return false;
    }
}
```
**Penjelasan Singkat:** Menyisipkan *Data Redactor* dalam *pipeline* log menjamin bahwa informasi yang sangat kredensial tidak pernah tersentuh oleh subsistem penyimpanan log, memitigasi risiko pembobolan ganda (*secondary data leak*).

---

## 3. Implementasi Core Architecture (PHP 8.3 & Laravel 11/12)

Bagian ini menyajikan set kode *production-ready* berlandaskan Clean Architecture, yang terdiri atas Migration, Model (dengan fitur Laravel terbaru), DTO (PHP 8.2+), Repository, Action, dan Job.

### 3.1 Migration Schema
Desain skema basis data audit log yang mendukung polimorfisme (untuk berbagai tipe entitas) dan pencarian JSON (*JSON querying*).

```php
<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('audit_logs', function (Blueprint $table) {
            $table->uuid('id')->primary(); // UUID digunakan agar log sulit ditebak urutannya / terhindar dari ID enumeration
            $table->unsignedBigInteger('user_id')->nullable()->index(); // ID aktor/pelaku
            $table->string('event_type', 100)->index(); // CREATED, UPDATED, DELETED, FAILED_LOGIN
            $table->string('auditable_type', 150)->nullable()->index(); // Namespace class dari entitas
            $table->unsignedBigInteger('auditable_id')->nullable()->index();
            $table->json('old_values')->nullable(); // Snapshot data lama
            $table->json('new_values')->nullable(); // Snapshot data baru
            $table->ipAddress('ip_address')->nullable();
            $table->string('user_agent', 500)->nullable();
            
            // Append-only audit log: hanya memiliki created_at
            $table->timestamp('created_at')->useCurrent()->index();

            // Index gabungan (Compound Index) untuk mempercepat pencarian histori berdasarkan satu entitas spesifik
            $table->index(['auditable_type', 'auditable_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('audit_logs');
    }
};
```

### 3.2 Eloquent Model
Memanfaatkan fitur pembatasan mutasi (append-only nature) dan pendefinisian array casts secara native menggunakan PHP method `casts()`.

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\MorphTo;

class AuditLog extends Model
{
    use HasUuids;

    // Menonaktifkan kolom updated_at karena log audit bersifat append-only
    public const string UPDATED_AT = null; 

    protected $table = 'audit_logs';

    /** @var array<int, string> */
    protected $fillable = [
        'user_id',
        'event_type',
        'auditable_type',
        'auditable_id',
        'old_values',
        'new_values',
        'ip_address',
        'user_agent',
    ];

    /**
     * Memanfaatkan fitur native laravel untuk casting json dan custom datetime.
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'old_values' => 'json',
            'new_values' => 'json',
            'created_at' => 'immutable_datetime', // Menggunakan CarbonImmutable
        ];
    }

    /**
     * Relasi morphTo untuk memetakan log ini milik entitas mana (misal: User, Order, Invoice).
     * @return MorphTo<Model, self>
     */
    public function auditable(): MorphTo
    {
        return $this->morphTo();
    }
}
```

### 3.3 Data Transfer Object (DTO)
Pemisahan domain agar data dari HTTP layer (*Request*) dan event (*Observer*) diseragamkan dalam format yang seragam, persisten (readonly), dan sangat tipis.

```php
<?php

declare(strict_types=1);

namespace App\DTOs;

final readonly class AuditLogData
{
    /**
     * DTO direpresentasikan sebagai readonly class (PHP 8.2+) yang strict-type.
     * 
     * @param array<string, mixed>|null $oldValues
     * @param array<string, mixed>|null $newValues
     */
    public function __construct(
        public string $eventType,
        public ?int $userId = null,
        public ?string $auditableType = null,
        public ?int $auditableId = null,
        public ?array $oldValues = null,
        public ?array $newValues = null,
        public ?string $ipAddress = null,
        public ?string $userAgent = null,
    ) {}
}
```

### 3.4 Repository Interface dan Implementation
Abstraksi repositori mengisolasi Laravel Eloquent dari layer servis utama. Hal ini sesuai dengan prinsip Dependency Inversion pada Clean Architecture.

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Contracts;

use App\DTOs\AuditLogData;
use App\Models\AuditLog;

interface AuditLogRepositoryInterface
{
    public function store(AuditLogData $data): AuditLog;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use App\DTOs\AuditLogData;
use App\Models\AuditLog;
use App\Repositories\Contracts\AuditLogRepositoryInterface;

final readonly class AuditLogRepository implements AuditLogRepositoryInterface
{
    /**
     * Menyimpan objek DTO ke dalam basis data melalui Eloquent.
     */
    public function store(AuditLogData $data): AuditLog
    {
        return AuditLog::create([
            'user_id' => $data->userId,
            'event_type' => $data->eventType,
            'auditable_type' => $data->auditableType,
            'auditable_id' => $data->auditableId,
            'old_values' => $data->oldValues,
            'new_values' => $data->newValues,
            'ip_address' => $data->ipAddress,
            'user_agent' => $data->userAgent,
        ]);
    }
}
```

### 3.5 Action dan Background Job
Di sinilah kombinasi antara pengamanan data (*redaction*) dan pendelegasian proses asynchronous terjadi. `DispatchAuditLogAction` membersihkan data, lalu membungkus DTO bersih ke dalam antrean.

```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use App\DTOs\AuditLogData;
use App\Repositories\Contracts\AuditLogRepositoryInterface;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;

final class ProcessAuditLogJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct(
        public readonly AuditLogData $auditLogData
    ) {}

    public function handle(AuditLogRepositoryInterface $repository): void
    {
        $repository->store($this->auditLogData);
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Actions\Audit;

use App\DTOs\AuditLogData;
use App\Jobs\ProcessAuditLogJob;
use App\Services\Security\DataRedactor;

final readonly class DispatchAuditLogAction
{
    public function __construct(
        private DataRedactor $redactor
    ) {}

    public function execute(AuditLogData $data): void
    {
        // 1. Sanitasi snapshot data menggunakan DataRedactor
        $sanitizedOld = $data->oldValues ? $this->redactor->redact($data->oldValues) : null;
        $sanitizedNew = $data->newValues ? $this->redactor->redact($data->newValues) : null;

        // 2. Rekonstruksi DTO dengan data yang sudah direduksi
        $sanitizedData = new AuditLogData(
            eventType: $data->eventType,
            userId: $data->userId,
            auditableType: $data->auditableType,
            auditableId: $data->auditableId,
            oldValues: $sanitizedOld,
            newValues: $sanitizedNew,
            ipAddress: $data->ipAddress,
            userAgent: $data->userAgent,
        );

        // 3. Dispatch Job (lempar ke sistem antrean agar bersifat non-blocking HTTP request)
        ProcessAuditLogJob::dispatch($sanitizedData)->onQueue('audit-logs');
    }
}
```

### 3.6 Otomatisasi dengan Eloquent Observer (Opsional)
Untuk entitas kritis seperti `User` atau `Transaction`, kita bisa mengikat Observer untuk otomatis memproduksi audit log.

```php
<?php

declare(strict_types=1);

namespace App\Observers;

use App\Actions\Audit\DispatchAuditLogAction;
use App\DTOs\AuditLogData;
use Illuminate\Database\Eloquent\Model;

final readonly class GenericAuditObserver
{
    public function __construct(
        private DispatchAuditLogAction $action
    ) {}

    public function updated(Model $model): void
    {
        $this->action->execute(new AuditLogData(
            eventType: 'MODEL_UPDATED',
            userId: auth()->id(), // Resolusi user konteks
            auditableType: $model::class,
            auditableId: (int) $model->getKey(),
            oldValues: $model->getOriginal(),
            newValues: $model->getChanges(),
            ipAddress: request()->ip(),
            userAgent: request()->userAgent() ?? 'System'
        ));
    }
}
```

---

## 4. Pengujian Terintegrasi dengan Pest v3

Menulis arsitektur yang solid hanya terjamin kualitasnya jika dilakukan *Unit Testing* yang sama solidnya. Menggunakan Pest v3, kita dapat melakukan asersi tipe arsitektur, unit murni, dan integrasi penuh dari servis kita.

### 4.1 Architecture Testing (Clean Architecture Enforcement)
Memastikan aturan dependensi (*Dependency Rule*) antara layer Clean Architecture tidak dilanggar secara tidak sengaja oleh tim pengembang lain di kemudian hari.
Berkas: `tests/Arch/AuditLogArchTest.php`

```php
<?php

declare(strict_types=1);

arch('strict types are used everywhere in Audit module')
    ->expect('App\Actions\Audit')
    ->toUseStrictTypes();

arch('DTOs should be readonly classes to prevent mutation bugs')
    ->expect('App\DTOs\AuditLogData')
    ->toBeClasses()
    ->toBeReadonly();

arch('Controllers cannot interact directly with Repositories')
    ->expect('App\Http\Controllers')
    ->not->toUse('App\Repositories')
    ->ignoring('App\Repositories\Contracts'); // Interface boleh di-bind, tapi idealnya via Action

arch('Audit models should not be updatable or deletable (Append-Only Enforcement)')
    ->expect('App\Models\AuditLog')
    ->not->toUse('Illuminate\Database\Eloquent\SoftDeletes')
    ->not->toUse('Illuminate\Database\Eloquent\Concerns\HasTimestamps'); // Karena kita batasi hanya created_at
```

### 4.2 Unit Testing: Menguji Sanitasi Data Sensitif (Data Redactor)
Memastikan algoritme penyensoran bekerja secara rekursif pada properti kunci, bahkan jika struktur array JSON diubah-ubah.
Berkas: `tests/Unit/Services/Security/DataRedactorTest.php`

```php
<?php

declare(strict_types=1);

use App\Services\Security\DataRedactor;

covers(DataRedactor::class);

it('redacts simple sensitive keys from a flat array', function () {
    $redactor = new DataRedactor();
    $payload = [
        'name' => 'John Doe',
        'password' => 'secret123',
        'email' => 'john@example.com',
        'API_KEY' => 'key_abc_123'
    ];

    $result = $redactor->redact($payload);

    expect($result)
        ->toHaveKey('name', 'John Doe')
        ->toHaveKey('email', 'john@example.com')
        ->toHaveKey('password', '[REDACTED]')
        ->toHaveKey('API_KEY', '[REDACTED]');
});

it('redacts sensitive keys recursively from a deeply nested array', function () {
    $redactor = new DataRedactor();
    $payload = [
        'user' => [
            'id' => 1,
            'credit_card' => '1234-5678-9012-3456', // Harus terkena sensor
        ],
        'metadata' => [
            'authorization' => 'Bearer eyJhbG...' // Harus terkena sensor
        ]
    ];

    $result = $redactor->redact($payload);

    expect($result['user']['credit_card'])->toBe('[REDACTED]')
        ->and($result['metadata']['authorization'])->toBe('[REDACTED]')
        ->and($result['user']['id'])->toBe(1);
});
```

### 4.3 Feature Testing: Dispatching Audit Log ke Queue
Menguji fungsionalitas Action dalam menerima DTO, menyensor (*redact*), dan melemparkan (*dispatch*) log tersebut ke dalam sistem `Queue` Laravel tanpa harus mengeksekusi I/O ke database (Mocks).
Berkas: `tests/Feature/Actions/DispatchAuditLogActionTest.php`

```php
<?php

declare(strict_types=1);

use App\Actions\Audit\DispatchAuditLogAction;
use App\DTOs\AuditLogData;
use App\Jobs\ProcessAuditLogJob;
use App\Services\Security\DataRedactor;
use Illuminate\Support\Facades\Queue;

uses(\Illuminate\Foundation\Testing\RefreshDatabase::class);

it('dispatches the audit log job to the background queue with correctly redacted payload', function () {
    // 1. Arrange: Fake the Queue bus to assert against it later.
    Queue::fake();

    $redactor = new DataRedactor();
    $action = new DispatchAuditLogAction($redactor);

    $data = new AuditLogData(
        eventType: 'USER_CREATED',
        userId: 99,
        newValues: [
            'name' => 'Admin System',
            'password' => 'super_secret',
        ]
    );

    // 2. Act: Execute action synchronously
    $action->execute($data);

    // 3. Assert: Verify the job was placed on the correct queue channel with censored data.
    Queue::assertPushedOn('audit-logs', ProcessAuditLogJob::class, function (ProcessAuditLogJob $job) {
        $queuedData = $job->auditLogData;

        return $queuedData->eventType === 'USER_CREATED'
            && $queuedData->userId === 99
            && $queuedData->newValues['name'] === 'Admin System'
            && $queuedData->newValues['password'] === '[REDACTED]'; // Memastikan payload di-masking sebelum di-enqueue
    });
});
```

### 4.4 Feature Testing: Resolusi Job dan Repositori
Menguji siklus akhir (*end-to-end* secara asinkron di belakang layar) apakah eksekusi `Job` benar-benar meneruskan data DTO masuk ke dalam penyimpanan Eloquent melalui antarmuka Repositori.
Berkas: `tests/Feature/Jobs/ProcessAuditLogJobTest.php`

```php
<?php

declare(strict_types=1);

use App\DTOs\AuditLogData;
use App\Jobs\ProcessAuditLogJob;
use App\Models\AuditLog;
use App\Repositories\Eloquent\AuditLogRepository;

uses(\Illuminate\Foundation\Testing\RefreshDatabase::class);

it('stores the final audit log into the database when background job is processed', function () {
    // Arrange
    $data = new AuditLogData(
        eventType: 'CRITICAL_ACTION_PERFORMED',
        userId: 1,
        ipAddress: '192.168.1.1'
    );

    $job = new ProcessAuditLogJob($data);
    $repository = new AuditLogRepository();
    
    // Act: Simulate Job Handle executed by Queue Worker
    $job->handle($repository);

    // Assert
    expect(AuditLog::count())->toBe(1);
    
    $log = AuditLog::first();
    expect($log->event_type)->toBe('CRITICAL_ACTION_PERFORMED')
        ->and($log->user_id)->toBe(1)
        ->and($log->ip_address)->toBe('192.168.1.1')
        ->and($log->auditable_id)->toBeNull(); // Karena pada DTO di atas tidak disertakan
});
```

## Kesimpulan Akhir

Audit Logging yang dirancang dengan kokoh merupakan perlindungan defensif lapisan kedua yang transparan dan dapat diandalkan oleh sistem enterprise. Dengan mematuhi standar *Clean Architecture*, menggunakan *Asynchronous Queue Pipeline* (non-blocking HTTP), menyaring *PII* melalui *Redactor Service*, serta melapisinya dengan pengujian unit & arsitektur menggunakan *Pest v3*, pengembang dapat memastikan sistem Laravel mereka efisien, tangguh dari anomali I/O, serta memenuhi semua *compliance audit* industri.
