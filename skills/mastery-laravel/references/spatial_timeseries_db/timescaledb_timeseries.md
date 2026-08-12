# TimescaleDB & Time-Series Data in Laravel (Top 1% Quality Guide)

## 1. Pengenalan & Arsitektur TimescaleDB di Laravel

TimescaleDB adalah ekstensi PostgreSQL yang dioptimalkan untuk data time-series (runtun waktu). Dalam ekosistem Laravel, integrasi TimescaleDB memungkinkan pengelolaan miliaran baris metrik, IoT telemetry, atau data log finansial dengan performa query yang luar biasa, berkat arsitektur **Hypertable**.

Dokumen ini memandu Anda menerapkan arsitektur berkelas Enterprise (Clean Architecture) menggunakan PHP 8.3/8.4 dan Laravel 11+, lengkap dengan strategi partisi, agregasi kontinu (Continuous Aggregates), kompresi, dan retensi data.

## 2. Setup & Skema Migrasi (Hypertable & CAGA)

Dalam TimescaleDB, tabel fisik dipartisi secara transparan menjadi *chunks* berdasarkan dimensi waktu. Ini disebut Hypertable.

### Migrasi Hypertable

File: `database/migrations/2026_01_01_000000_create_device_telemetries_table.php`

```php
<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // 1. Buat tabel standar PostgreSQL
        Schema::create('device_telemetries', function (Blueprint $table): void {
            // Gunakan timestamptz untuk data time-series global
            $table->timestampTz('measured_at')->index();
            $table->uuid('device_id')->index();
            $table->double('temperature');
            $table->double('humidity');
            $table->jsonb('metadata')->nullable();
            
            // TimescaleDB membutuhkan waktu sebagai bagian dari primary key jika ada PK
            $table->primary(['measured_at', 'device_id']);
        });

        // 2. Konversi ke Hypertable (Partisi by time, per 7 hari)
        DB::statement("SELECT create_hypertable('device_telemetries', 'measured_at', chunk_time_interval => INTERVAL '7 days');");

        // 3. Aktifkan Kompresi (Sangat penting untuk efisiensi penyimpanan)
        DB::statement("ALTER TABLE device_telemetries SET (timescaledb.compress, timescaledb.compress_segmentby = 'device_id');");
        
        // Kompres data yang usianya lebih dari 30 hari
        DB::statement("SELECT add_compression_policy('device_telemetries', INTERVAL '30 days');");

        // 4. Retensi Data (Hapus data yang lebih tua dari 1 tahun)
        DB::statement("SELECT add_retention_policy('device_telemetries', INTERVAL '1 year');");
        
        // 5. Continuous Aggregate (Materialized View otomatis untuk agregat per jam)
        DB::unprepared("
            CREATE MATERIALIZED VIEW hourly_device_telemetries
            WITH (timescaledb.continuous) AS
            SELECT 
                time_bucket('1 hour', measured_at) AS bucket_time,
                device_id,
                AVG(temperature) as avg_temp,
                MAX(temperature) as max_temp,
                AVG(humidity) as avg_humidity
            FROM device_telemetries
            GROUP BY bucket_time, device_id
            WITH NO DATA;
        ");
        
        // Policy untuk me-refresh view agregat setiap jam
        DB::statement("SELECT add_continuous_aggregate_policy('hourly_device_telemetries', start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour');");
    }

    public function down(): void
    {
        DB::statement('DROP MATERIALIZED VIEW IF EXISTS hourly_device_telemetries;');
        Schema::dropIfExists('device_telemetries');
    }
};
```

## 3. Clean Architecture Implementation

### A. Model

Model merepresentasikan tabel time-series. Karena ini hypertable, kita mendisable incrementing ID dan timestamps Laravel standar.

File: `app/Models/DeviceTelemetry.php`

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

final class DeviceTelemetry extends Model
{
    use HasFactory;

    public $table = 'device_telemetries';
    
    // Hypertable tidak menggunakan auto-increment ID standar
    public $incrementing = false;
    
    // Disable default created_at / updated_at, kita menggunakan measured_at
    public $timestamps = false;

    protected $fillable = [
        'measured_at',
        'device_id',
        'temperature',
        'humidity',
        'metadata',
    ];

    protected $casts = [
        'measured_at' => 'immutable_datetime',
        'temperature' => 'float',
        'humidity' => 'float',
        'metadata' => 'array',
    ];
}
```

### B. Request Validation

Data time-series biasanya masuk dalam jumlah besar (batch). Validasi harus efisien.

File: `app/Http/Requests/StoreTelemetryBatchRequest.php`

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class StoreTelemetryBatchRequest extends FormRequest
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
            'telemetries' => ['required', 'array', 'min:1', 'max:5000'],
            'telemetries.*.device_id' => ['required', 'uuid'],
            'telemetries.*.measured_at' => ['required', 'date_format:Y-m-d\TH:i:s.u\Z'],
            'telemetries.*.temperature' => ['required', 'numeric', 'between:-100,100'],
            'telemetries.*.humidity' => ['required', 'numeric', 'between:0,100'],
            'telemetries.*.metadata' => ['nullable', 'array'],
        ];
    }
}
```

### C. Data Transfer Object (DTO)

File: `app/DTOs/TelemetryEntryDTO.php`

```php
<?php

declare(strict_types=1);

namespace App\DTOs;

use DateTimeImmutable;

readonly class TelemetryEntryDTO
{
    public function __construct(
        public string $deviceId,
        public DateTimeImmutable $measuredAt,
        public float $temperature,
        public float $humidity,
        public ?array $metadata = null,
    ) {}

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        return new self(
            deviceId: (string) $data['device_id'],
            measuredAt: new DateTimeImmutable((string) $data['measured_at']),
            temperature: (float) $data['temperature'],
            humidity: (float) $data['humidity'],
            metadata: $data['metadata'] ?? null,
        );
    }
}
```

### D. Repository

Repository bertanggung jawab atas operasi I/O DB, memanfaatkan fitur analitik tingkat lanjut TimescaleDB seperti `time_bucket`.

File: `app/Repositories/TelemetryRepository.php`

```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Models\DeviceTelemetry;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

final readonly class TelemetryRepository
{
    /**
     * Bulk insert menggunakan mekanisme paling efisien (upsert/insert).
     * 
     * @param array<int, array<string, mixed>> $records
     */
    public function insertBatch(array $records): bool
    {
        // Chunk insert untuk mencegah kehabisan memory dan timeout
        return DB::transaction(function () use ($records): bool {
            foreach (array_chunk($records, 1000) as $chunk) {
                DeviceTelemetry::insert($chunk);
            }
            return true;
        });
    }

    /**
     * Mengambil agregasi time-bucket langsung dari TimescaleDB.
     * Sangat efisien karena diproses langsung di level database.
     *
     * @return Collection<int, object>
     */
    public function getHourlyAggregates(string $deviceId, string $startAt, string $endAt): Collection
    {
        return DB::table('hourly_device_telemetries')
            ->select([
                'bucket_time',
                'avg_temp',
                'max_temp',
                'avg_humidity'
            ])
            ->where('device_id', $deviceId)
            ->whereBetween('bucket_time', [$startAt, $endAt])
            ->orderBy('bucket_time')
            ->get();
    }
    
    /**
     * Time bucket on-the-fly (apabila tidak ada Continuous Aggregate).
     *
     * @return Collection<int, object>
     */
    public function getDynamicTimeBucket(string $deviceId, string $interval, string $startAt, string $endAt): Collection
    {
        return DB::table('device_telemetries')
            ->selectRaw("time_bucket(?, measured_at) AS bucket", [$interval])
            ->selectRaw("AVG(temperature) AS avg_temp")
            ->selectRaw("MAX(temperature) AS max_temp")
            ->where('device_id', $deviceId)
            ->whereBetween('measured_at', [$startAt, $endAt])
            ->groupBy('bucket')
            ->orderBy('bucket')
            ->get();
    }
}
```

### E. Action

Action membungkus logika bisnis dan transformasi data dari Request DTO ke bentuk yang dikonsumsi oleh Repository.

File: `app/Actions/Telemetry/StoreBatchTelemetryAction.php`

```php
<?php

declare(strict_types=1);

namespace App\Actions\Telemetry;

use App\DTOs\TelemetryEntryDTO;
use App\Repositories\TelemetryRepository;

final readonly class StoreBatchTelemetryAction
{
    public function __construct(
        private TelemetryRepository $repository
    ) {}

    /**
     * @param array<int, TelemetryEntryDTO> $dtos
     */
    public function execute(array $dtos): bool
    {
        if (empty($dtos)) {
            return false;
        }

        $records = array_map(function (TelemetryEntryDTO $dto): array {
            return [
                'device_id' => $dto->deviceId,
                'measured_at' => $dto->measuredAt->format('Y-m-d H:i:s.uP'),
                'temperature' => $dto->temperature,
                'humidity' => $dto->humidity,
                // Cast array ke JSON string untuk raw insert/bulk insert
                'metadata' => $dto->metadata !== null ? json_encode($dto->metadata, JSON_THROW_ON_ERROR) : null,
            ];
        }, $dtos);

        return $this->repository->insertBatch($records);
    }
}
```

### F. Controller

Controller hanya menerima Request, mem-parsing DTO, memanggil Action, dan mengembalikan HTTP Response.

File: `app/Http/Controllers/Api/TelemetryController.php`

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Actions\Telemetry\StoreBatchTelemetryAction;
use App\DTOs\TelemetryEntryDTO;
use App\Http\Requests\StoreTelemetryBatchRequest;
use Illuminate\Http\JsonResponse;
use Illuminate\Routing\Controller;

final class TelemetryController extends Controller
{
    public function storeBatch(
        StoreTelemetryBatchRequest $request,
        StoreBatchTelemetryAction $action
    ): JsonResponse {
        $data = $request->validated('telemetries');
        
        $dtos = array_map(
            static fn (array $item): TelemetryEntryDTO => TelemetryEntryDTO::fromArray($item),
            $data
        );

        $action->execute($dtos);

        return response()->json([
            'message' => 'Telemetry batch stored successfully',
            'count' => count($dtos)
        ], 201);
    }
}
```

## 4. Anti-Patterns & Best Practices di TimescaleDB (❌ vs ✅)

### Anti-Pattern 1: Menyimpan Time-Series dengan Loop (N+1 Insert)

TimescaleDB menangani *ingestion* data berskala besar. Melakukan perulangan `Model::create()` atau `Model::save()` akan sangat lambat karena membuat ratusan query INSERT satu per satu, menyebabkan lonjakan IOPS dan Latency.

❌ **Bad Practice: N+1 Insert (Risiko Performa dan Koneksi Tersedak)**
```php
public function store(array $data) {
    foreach ($data as $item) {
        // Memicu query ke DB di tiap iterasi. 
        // 5000 item = 5000 query.
        DeviceTelemetry::create($item); 
    }
}
```

✅ **Best Practice: Bulk Insert dengan Chunking**
Gunakan `Model::insert()` untuk memasukkan banyak data dalam satu query. Partisi *batch* besar menjadi bagian-bagian lebih kecil (misal: 1000 baris per *chunk*) agar tidak melampaui batas parameter bind PostgreSQL (max 65535 parameter).

```php
public function store(array $data) {
    // 5000 item di-chunk menjadi 5 query (masing-masing 1000 row).
    // Transaksi memastikan all-or-nothing.
    DB::transaction(function() use ($data) {
        foreach (array_chunk($data, 1000) as $chunk) {
            DeviceTelemetry::insert($chunk);
        }
    });
}
```

### Anti-Pattern 2: Menggunakan PHP Array/Collection untuk Agregasi Time-Series

Menarik jutaan row data telemetri mentah ke PHP hanya untuk menghitung rata-rata harian akan memakan *Memory* yang masif (Memory Exhaustion Error) dan sangat lambat.

❌ **Bad Practice: PHP In-Memory Aggregation (Risiko OOM - Out of Memory)**
```php
// Menarik jutaan data ke RAM PHP Server! Server akan crash.
$data = DeviceTelemetry::where('device_id', $id)->get(); 
$hourly = $data->groupBy(function($item) {
    return $item->measured_at->format('Y-m-d H');
})->map(function($group) {
    return $group->avg('temperature');
});
```

✅ **Best Practice: Gunakan `time_bucket` atau Continuous Aggregates (CAGA) TimescaleDB**
Biarkan Database PostgreSQL yang ditulis di C/Rust yang melakukan komputasi agregat secara terdistribusi.

```php
// Menarik hanya puluhan baris data agregat yang sudah dihitung oleh DB
$hourly = DB::table('hourly_device_telemetries')
    ->where('device_id', $id)
    ->get();
```

## 5. Pest v3 Testing (Arch & Unit)

Pastikan Clean Architecture tidak ternoda dan logika Time-Series tervalidasi melalui Pest v3.

### A. Architectural Testing

File: `tests/Arch/CleanArchitectureTest.php`

```php
<?php

declare(strict_types=1);

arch('models_must_not_access_http_layer')
    ->expect('App\Models')
    ->toOnlyUse([
        'Illuminate\Database',
        'Illuminate\Support',
        'Carbon',
    ]);

arch('actions_must_not_access_http_request')
    ->expect('App\Actions')
    ->not->toUse('Illuminate\Http\Request');

arch('controllers_must_only_depend_on_actions_and_dtos')
    ->expect('App\Http\Controllers')
    ->toOnlyUse([
        'App\Actions',
        'App\DTOs',
        'App\Http\Requests',
        'Illuminate\Http\JsonResponse',
        'Illuminate\Routing\Controller',
    ]);
    
arch('strict_types_must_be_used')
    ->expect('App')
    ->toUseStrictTypes();
```

### B. Unit & Feature Testing

File: `tests/Feature/TelemetryControllerTest.php`

```php
<?php

declare(strict_types=1);

use App\Models\DeviceTelemetry;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;

uses(RefreshDatabase::class);

it('successfully bulk inserts telemetry data', function (): void {
    // Arrange
    $deviceId = Str::uuid()->toString();
    $payload = [
        'telemetries' => [
            [
                'device_id' => $deviceId,
                'measured_at' => '2026-07-31T10:00:00.000000Z',
                'temperature' => 25.5,
                'humidity' => 60.2,
                'metadata' => ['sensor_v' => '1.2']
            ],
            [
                'device_id' => $deviceId,
                'measured_at' => '2026-07-31T10:05:00.000000Z',
                'temperature' => 26.1,
                'humidity' => 59.8,
                'metadata' => null
            ]
        ]
    ];

    // Act
    $response = $this->postJson('/api/telemetry/batch', $payload);

    // Assert
    $response->assertStatus(201)
             ->assertJson([
                 'message' => 'Telemetry batch stored successfully',
                 'count' => 2
             ]);

    $this->assertDatabaseCount('device_telemetries', 2);
    $this->assertDatabaseHas('device_telemetries', [
        'device_id' => $deviceId,
        'temperature' => 25.5
    ]);
});

it('rejects invalid telemetry payload', function (): void {
    // Arrange: temperature out of bounds (>100)
    $payload = [
        'telemetries' => [
            [
                'device_id' => Str::uuid()->toString(),
                'measured_at' => '2026-07-31T10:00:00.000000Z',
                'temperature' => 150.0, 
                'humidity' => 60.2,
            ]
        ]
    ];

    // Act
    $response = $this->postJson('/api/telemetry/batch', $payload);

    // Assert
    $response->assertStatus(422)
             ->assertJsonValidationErrors(['telemetries.0.temperature']);
});
```

## Kesimpulan

Dengan menerapkan TimescaleDB di atas Laravel menggunakan Clean Architecture, Anda mengamankan dua pilar utama Enterprise:
1. **Skalabilitas Data:** Mampu menangani insert jutaan row per menit dan query analitik kilat berkat *Hypertable*, kompresi kolumnar, dan CAGA.
2. **Skalabilitas Kode:** Tim developer dapat memodifikasi logika bisnis (Action) tanpa menyentuh optimasi query (Repository), sehingga *maintenance* sistem jauh lebih terjamin dan aman (Type-Safe).
