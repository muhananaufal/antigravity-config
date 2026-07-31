# Panduan Definitif: Laravel Sail & VS Code DevContainers untuk Laravel 11 (Top 1% Standar Industri)

Ekosistem pengembangan modern menuntut konsistensi, isolasi, dan reproduksibilitas. Pada ekosistem Laravel 11 dan PHP 8.3/8.4, Laravel Sail telah merevolusi cara kita berinteraksi dengan Docker, mengabstraksi kompleksitas `docker-compose` menjadi antarmuka CLI yang intuitif. Namun, untuk mencapai efisiensi yang optimal—khususnya pada level *Enterprise*—integrasi Sail dengan **VS Code DevContainers** adalah sebuah keharusan mutlak.

DevContainers memungkinkan seluruh tim pengembangan, tanpa memandang sistem operasi asal (Windows, macOS, Linux), untuk bekerja di dalam environment Linux terisolasi yang identik dengan *production*. Hal ini secara efektif membunuh alasan klasik: *"It works on my machine"*.

Dokumen ini adalah referensi komprehensif tingkat lanjut (Top 1%) yang membahas konfigurasi arsitektur DevOps lokal menggunakan Laravel Sail, integrasi DevContainer, serta implementasi *Clean Architecture* dengan standardisasi kode yang ketat, pencegahan Anti-Pattern, dan pengujian mendalam menggunakan Pest v3.

---

## 1. Konfigurasi Infrastruktur DevContainer & Laravel Sail

### 1.1 Konfigurasi `docker-compose.yml` Teroptimasi
Konfigurasi berikut mensyaratkan PHP 8.3 (atau 8.4), PostgreSQL, Redis, dan Meilisearch.

```yaml
# docker-compose.yml
version: '3'
services:
    laravel.test:
        build:
            context: ./vendor/laravel/sail/runtimes/8.3
            dockerfile: Dockerfile
            args:
                WWWGROUP: '${WWWGROUP}'
        image: sail-8.3/app
        extra_hosts:
            - 'host.docker.internal:host-gateway'
        ports:
            - '${APP_PORT:-80}:80'
            - '${VITE_PORT:-5173}:${VITE_PORT:-5173}'
        environment:
            WWWUSER: '${WWWUSER}'
            LARAVEL_SAIL: 1
            XDEBUG_MODE: '${SAIL_XDEBUG_MODE:-off}'
            XDEBUG_CONFIG: '${SAIL_XDEBUG_CONFIG:-client_host=host.docker.internal}'
            IGNITION_LOCAL_SITES_PATH: '${PWD}'
        volumes:
            - '.:/var/www/html'
        networks:
            - sail
        depends_on:
            - pgsql
            - redis
            - meilisearch
    pgsql:
        image: 'postgres:15'
        ports:
            - '${FORWARD_DB_PORT:-5432}:5432'
        environment:
            PGPASSWORD: '${DB_PASSWORD:-secret}'
            POSTGRES_DB: '${DB_DATABASE}'
            POSTGRES_USER: '${DB_USERNAME}'
            POSTGRES_PASSWORD: '${DB_PASSWORD:-secret}'
        volumes:
            - 'sail-pgsql:/var/lib/postgresql/data'
            - './vendor/laravel/sail/database/pgsql/create-testing-database.sql:/docker-entrypoint-initdb.d/10-create-testing-database.sql'
        networks:
            - sail
        healthcheck:
            test:
                - CMD
                - pg_isready
                - '-q'
                - '-d'
                - '${DB_DATABASE}'
                - '-U'
                - '${DB_USERNAME}'
            retries: 3
            timeout: 5s
    redis:
        image: 'redis:alpine'
        ports:
            - '${FORWARD_REDIS_PORT:-6379}:6379'
        volumes:
            - 'sail-redis:/data'
        networks:
            - sail
        healthcheck:
            test:
                - CMD
                - redis-cli
                - ping
            retries: 3
            timeout: 5s
    meilisearch:
        image: 'getmeili/meilisearch:latest'
        ports:
            - '${FORWARD_MEILISEARCH_PORT:-7700}:7700'
        environment:
            MEILI_NO_ANALYTICS: '${MEILISEARCH_NO_ANALYTICS:-false}'
        volumes:
            - 'sail-meilisearch:/meili_data'
        networks:
            - sail
        healthcheck:
            test:
                - CMD
                - wget
                - '--no-verbose'
                - '--spider'
                - 'http://localhost:7700/health'
            retries: 3
            timeout: 5s
networks:
    sail:
        driver: bridge
volumes:
    sail-pgsql:
        driver: local
    sail-redis:
        driver: local
    sail-meilisearch:
        driver: local
```

### 1.2 Setup Eksekusi Terisolasi `.devcontainer/devcontainer.json`
VS Code DevContainers membutuhkan spesifikasi JSON untuk mengatur environment, ekstensi IDE, dan post-command.

```json
{
    "name": "Laravel 11 Pro Environment",
    "dockerComposeFile": ["../docker-compose.yml"],
    "service": "laravel.test",
    "workspaceFolder": "/var/www/html",
    "customizations": {
        "vscode": {
            "settings": {
                "php.suggest.basic": false,
                "editor.formatOnSave": true,
                "editor.defaultFormatter": "esbenp.prettier-vscode",
                "[php]": {
                    "editor.defaultFormatter": "bmewburn.vscode-intelephense-client"
                },
                "intelephense.environment.phpVersion": "8.3.0"
            },
            "extensions": [
                "bmewburn.vscode-intelephense-client",
                "xdebug.php-debug",
                "mikestead.dotenv",
                "christian-kohler.path-intellisense",
                "esbenp.prettier-vscode",
                "amiralizadeh94.laravel-extra-intellisense",
                "bradlc.vscode-tailwindcss"
            ]
        }
    },
    "forwardPorts": [80, 5173, 5432, 6379, 7700],
    "postCreateCommand": "composer install --no-interaction && npm install && npm run build",
    "remoteUser": "sail"
}
```

---

## 2. Implementasi Clean Architecture dalam Kontainer (Study Case: Workspace Provisioning)

Untuk mendemonstrasikan keandalan environment ini, kita akan membangun fitur simulasi Provisioning Workspace untuk developer, menerapkan prinsip **Clean Architecture**: `FormRequest -> Controller -> Action/Service -> Repository -> Model`. Seluruh kode di bawah ini 100% *type-safe* dan mewajibkan `declare(strict_types=1);`.

### 2.1 Model & Migration
Model bertindak sebagai entitas bisnis dengan *property casting* yang tegas.

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

final class DeveloperWorkspace extends Model
{
    use HasFactory;
    use HasUuids;
    use SoftDeletes;

    protected $table = 'developer_workspaces';

    protected $fillable = [
        'developer_id',
        'project_name',
        'php_version',
        'is_active',
        'provisioned_at',
    ];

    protected $casts = [
        'is_active' => 'boolean',
        'provisioned_at' => 'datetime',
    ];
}
```

### 2.2 Data Transfer Object (DTO)
Kita gunakan DTO khusus untuk melewatkan data dari lapis Presentasi ke lapis Bisnis secara aman tanpa ketergantungan pada *Request Object* HTTP.

```php
<?php

declare(strict_types=1);

namespace App\DTOs;

readonly class ProvisionWorkspaceDTO
{
    public function __construct(
        public string $developerId,
        public string $projectName,
        public string $phpVersion
    ) {}
}
```

### 2.3 Form Request (Validasi Input)
Bertanggung jawab secara eksklusif atas validasi input HTTP.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Workspace;

use App\DTOs\ProvisionWorkspaceDTO;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

final class StoreWorkspaceRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, array<int, string|\Illuminate\Validation\Rules\In>>
     */
    public function rules(): array
    {
        return [
            'developer_id' => ['required', 'uuid'],
            'project_name' => ['required', 'string', 'min:3', 'max:255', 'alpha_dash'],
            'php_version' => ['required', 'string', Rule::in(['8.2', '8.3', '8.4'])],
        ];
    }

    public function toDTO(): ProvisionWorkspaceDTO
    {
        return new ProvisionWorkspaceDTO(
            developerId: (string) $this->validated('developer_id'),
            projectName: (string) $this->validated('project_name'),
            phpVersion: (string) $this->validated('php_version')
        );
    }
}
```

### 2.4 Repository Interface & Implementation (Data Access Layer)
Abstraksi akses data menjamin lapisan bisnis (Action) tidak bergantung pada Eloquent atau database spesifik.

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Contracts;

use App\Models\DeveloperWorkspace;

interface WorkspaceRepositoryInterface
{
    /**
     * @param array<string, mixed> $data
     */
    public function create(array $data): DeveloperWorkspace;

    public function existsForProject(string $projectName): bool;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use App\Models\DeveloperWorkspace;
use App\Repositories\Contracts\WorkspaceRepositoryInterface;

final class EloquentWorkspaceRepository implements WorkspaceRepositoryInterface
{
    public function __construct(private readonly DeveloperWorkspace $model)
    {
    }

    /**
     * @param array<string, mixed> $data
     */
    public function create(array $data): DeveloperWorkspace
    {
        return $this->model->newQuery()->create($data);
    }

    public function existsForProject(string $projectName): bool
    {
        return $this->model->newQuery()->where('project_name', $projectName)->exists();
    }
}
```

*(Jangan lupa mendaftarkan binding di `AppServiceProvider`)*:
```php
$this->app->bind(WorkspaceRepositoryInterface::class, EloquentWorkspaceRepository::class);
```

### 2.5 Action / Service (Business Logic Layer)
Logika inti aplikasi. Mengisolasi tugas spesifik, mudah di-test, dan patuh pada prinsip *Single Responsibility*.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Workspace;

use App\DTOs\ProvisionWorkspaceDTO;
use App\Exceptions\Workspace\WorkspaceAlreadyExistsException;
use App\Models\DeveloperWorkspace;
use App\Repositories\Contracts\WorkspaceRepositoryInterface;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

final class ProvisionWorkspaceAction
{
    public function __construct(
        private readonly WorkspaceRepositoryInterface $repository
    ) {}

    /**
     * @throws WorkspaceAlreadyExistsException
     * @throws \Throwable
     */
    public function execute(ProvisionWorkspaceDTO $dto): DeveloperWorkspace
    {
        if ($this->repository->existsForProject($dto->projectName)) {
            Log::warning('Percobaan duplikasi provisioning workspace', ['project' => $dto->projectName]);
            throw new WorkspaceAlreadyExistsException("Workspace untuk {$dto->projectName} sudah ada.");
        }

        return DB::transaction(function () use ($dto): DeveloperWorkspace {
            $workspace = $this->repository->create([
                'developer_id' => $dto->developerId,
                'project_name' => $dto->projectName,
                'php_version' => $dto->phpVersion,
                'is_active' => true,
                'provisioned_at' => Carbon::now(),
            ]);

            Log::info('Workspace berhasil di-provision.', ['workspace_id' => $workspace->id]);

            event(new WorkspaceProvisionedEvent($workspace->id));

            return $workspace;
        });
    }
}
```

### 2.6 Controller (Delivery Layer)
Sangat tipis, hanya menerima *request*, memanggil Action, dan memformat *response*.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Workspace;

use App\Actions\Workspace\ProvisionWorkspaceAction;
use App\Exceptions\Workspace\WorkspaceAlreadyExistsException;
use App\Http\Controllers\Controller;
use App\Http\Requests\Workspace\StoreWorkspaceRequest;
use Illuminate\Http\JsonResponse;

final class WorkspaceController extends Controller
{
    public function __construct(
        private readonly ProvisionWorkspaceAction $provisionAction
    ) {}

    public function store(StoreWorkspaceRequest $request): JsonResponse
    {
        try {
            $dto = $request->toDTO();
            $workspace = $this->provisionAction->execute($dto);

            return response()->json([
                'message' => 'Workspace berhasil di-provision.',
                'data' => [
                    'id' => $workspace->id,
                    'project_name' => $workspace->project_name,
                    'is_active' => $workspace->is_active,
                ],
            ], 201);
        } catch (WorkspaceAlreadyExistsException $e) {
            return response()->json([
                'message' => $e->getMessage(),
            ], 409);
        } catch (\Throwable $e) {
            return response()->json([
                'message' => 'Terjadi kesalahan sistem saat mem-provision workspace.',
            ], 500);
        }
    }
}
```

---

## 3. Anti-Patterns Kritis dalam Lingkungan DevOps / Laravel

### 3.1 Anti-Pattern 1: Eksekusi Langsung Subprocess (Shell) Tanpa Sanitasi dan Sandboxing
Menggabungkan input langsung ke eksekusi command line di dalam DevContainer dapat memicu eksploitasi RCE (Remote Code Execution).

❌ **KODE SALAH (Sangat Berbahaya):**
```php
<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use Illuminate\Http\Request;

final class DevopsController extends Controller 
{
    public function restartContainer(Request $request): void 
    {
        // FATAL: Input pengguna digabungkan langsung ke argumen shell.
        $container = $request->input('container_name');
        shell_exec("docker restart " . $container); 
        // Jika container_name = "laravel.test; rm -rf /" maka kiamat.
    }
}
```

✅ **KODE BENAR (Menggunakan Abstraksi, Sanitasi, dan Lapisan Bisnis):**
```php
<?php
declare(strict_types=1);

namespace App\Actions\Docker;

use Illuminate\Support\Facades\Process;
use InvalidArgumentException;

final class RestartContainerAction 
{
    public function execute(string $containerName): bool 
    {
        // Validasi ketat (hanya alphanumeric dan dash)
        if (!preg_match('/^[a-zA-Z0-9\-]+$/', $containerName)) {
            throw new InvalidArgumentException("Nama kontainer tidak valid.");
        }

        // Gunakan Process API Laravel dengan array command (mencegah command injection)
        $result = Process::run(['docker', 'restart', $containerName]);

        return $result->successful();
    }
}
```
**Penjelasan Mengapa Berbahaya:** Penggunaan API shell mentah seperti `shell_exec` dan perangkaian *string* tanpa validasi membuka peluang Command Injection. API Modern dari Laravel Process (`Process::run`) mengisolasi argumen dengan tepat, menjamin *memory safety* dari eksploitasi bash pada tingkat OS di container Anda.

### 3.2 Anti-Pattern 2: Hardcoding Akses Service dan Logika Bisnis di Controller
Mencampuradukkan *Infrastructure concern* dan operasi logika tebal di Controller mengakibatkan kode sulit dites dan sangat ketat (*tightly coupled*).

❌ **KODE SALAH (Tightly Coupled & Melanggar SRP):**
```php
<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\DeveloperWorkspace;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

final class BadWorkspaceController extends Controller 
{
    public function store(Request $request) 
    {
        // 1. Logika validasi terekspos di sini
        $request->validate(['name' => 'required', 'version' => 'required']);
        
        // 2. Infrastruktur (DB transaction) & Logika Bisnis bercampur aduk
        if (DeveloperWorkspace::where('name', $request->name)->exists()) {
             return response()->json(['error' => 'Exists'], 400);
        }
        
        // 3. Bergantung langsung pada framework internal
        $workspace = new DeveloperWorkspace();
        $workspace->name = $request->name;
        $workspace->version = $request->version;
        $workspace->save();
        
        return response()->json(['ok' => true]);
    }
}
```

✅ **KODE BENAR:**
*(Persis seperti yang diimplementasikan pada Bab 2.3 hingga 2.6 di atas — menggunakan `FormRequest`, `DTO`, `Action`, dan `RepositoryInterface`.)*

**Penjelasan Mengapa Berbahaya:** Pada arsitektur yang salah (Fat Controller), menguji coba Controller mewajibkan kita membangun seluruh *database environment*. Pada arsitektur Clean (Kode Benar), kita dapat melakukan *mocking* pada kelas `ProvisionWorkspaceAction` atau `WorkspaceRepositoryInterface` untuk melakukan Unit Test sangat cepat (*lightning-fast*) di dalam memori tanpa menyentuh database sama sekali (mencegah I/O bottleneck & risiko kebocoran state database).

---

## 4. Pengujian Otomatis Tingkat Lanjut dengan Pest v3

Menjamin kualitas kode di DevContainer membutuhkan otomatisasi pengujian. Pest v3 memberikan sintaks yang ekspresif, cepat, dan *type-safe*.

### 4.1 Unit Test (Menguji Action dengan Mocking Repository)
Di sini kita menguji logika bisnis tanpa menyentuh database nyata, mengandalkan *Fakes/Mocking* pada Repository.

```php
<?php

declare(strict_types=1);

use App\Actions\Workspace\ProvisionWorkspaceAction;
use App\DTOs\ProvisionWorkspaceDTO;
use App\Exceptions\Workspace\WorkspaceAlreadyExistsException;
use App\Models\DeveloperWorkspace;
use App\Repositories\Contracts\WorkspaceRepositoryInterface;
use Illuminate\Support\Str;

it('berhasil melakukan provision workspace secara sukses', function () {
    // 1. Arrange
    $dto = new ProvisionWorkspaceDTO(
        developerId: Str::uuid()->toString(),
        projectName: 'super-app',
        phpVersion: '8.3'
    );

    $workspaceMock = new DeveloperWorkspace([
        'id' => Str::uuid()->toString(),
        'project_name' => 'super-app',
        'is_active' => true,
    ]);

    $repositoryMock = Mockery::mock(WorkspaceRepositoryInterface::class);
    $repositoryMock->shouldReceive('existsForProject')
        ->once()
        ->with('super-app')
        ->andReturn(false);
        
    $repositoryMock->shouldReceive('create')
        ->once()
        ->andReturn($workspaceMock);

    $action = new ProvisionWorkspaceAction($repositoryMock);

    // 2. Act
    $result = $action->execute($dto);

    // 3. Assert
    expect($result)->toBeInstanceOf(DeveloperWorkspace::class)
        ->and($result->project_name)->toBe('super-app')
        ->and($result->is_active)->toBeTrue();
});

it('melempar exception ketika workspace sudah ada (Conflict)', function () {
    // Arrange
    $dto = new ProvisionWorkspaceDTO(
        developerId: Str::uuid()->toString(),
        projectName: 'existing-app',
        phpVersion: '8.3'
    );

    $repositoryMock = Mockery::mock(WorkspaceRepositoryInterface::class);
    $repositoryMock->shouldReceive('existsForProject')
        ->once()
        ->with('existing-app')
        ->andReturn(true);

    $action = new ProvisionWorkspaceAction($repositoryMock);

    // Act & Assert
    expect(fn () => $action->execute($dto))
        ->toThrow(
            WorkspaceAlreadyExistsException::class, 
            "Workspace untuk existing-app sudah ada."
        );
});
```

### 4.2 Architecture Testing (Arch Test)
Arch tests sangat krusial di level enterprise untuk mencegah pelanggaran aturan oleh anggota tim (*preventing technical debt*).

```php
<?php

declare(strict_types=1);

arch('memastikan seluruh sistem menggunakan tipe data strict')
    ->expect('App')
    ->toUseStrictTypes();

arch('memastikan controller tidak menggunakan Model atau Repository langsung tanpa lewat Action')
    ->expect('App\Http\Controllers')
    ->not->toUse([
        'App\Models',
        'App\Repositories',
    ])
    ->ignoring('App\Http\Controllers\Controller');

arch('memastikan seluruh DTO adalah kelas readonly')
    ->expect('App\DTOs')
    ->toBeReadonly();

arch('memastikan controller hanya memiliki suffix Controller')
    ->expect('App\Http\Controllers')
    ->toHaveSuffix('Controller');

arch('memastikan request classes mewarisi FormRequest')
    ->expect('App\Http\Requests')
    ->toExtend(\Illuminate\Foundation\Http\FormRequest::class);

arch('menghindari penggunaan class debugging tertinggal')
    ->expect(['dd', 'dump', 'var_dump', 'ray'])
    ->not->toBeUsed();
```

---

## 5. Kesimpulan & Manfaat Strategis

Menggunakan konfigurasi Laravel Sail dan VS Code DevContainers, tim Anda mendapatkan keuntungan berupa:
1. **Zero Setup Time**: Pengembang baru (*newcomers*) hanya perlu melakukan Git Clone dan me-run DevContainer. VS Code dan Docker akan secara otomatis menangani instalasi OS, database, runtime PHP 8.3/8.4, dan ekstensi IDE.
2. **Deterministic Parity**: Lingkungan lokal seratus persen identik dengan lingkungan *staging* dan *production*, mengurangi bug anomali platform.
3. **Clean Architecture Governance**: Struktur `Request -> DTO -> Controller -> Action -> Repository` mengamankan logika bisnis dari detail penyampaian HTTP dan manipulasi ORM murni.
4. **Agility dengan Safety**: Pengujian mendalam (Unit & Arch test) bersama *strict-types* meminimalisir kesalahan interpretasi tipe data yang berakibat fatal pada sistem devops mikro yang sensitif.

Infrastruktur kode pada level standar 1% ini bukan lagi sekadar menulis skrip, melainkan mendirikan arsitektur perangkat lunak yang berfokus pada isolasi sistem, kemampuan pemeliharaan jangka panjang (*long-term maintainability*), dan keamanan arsitektural (*security by design*).
