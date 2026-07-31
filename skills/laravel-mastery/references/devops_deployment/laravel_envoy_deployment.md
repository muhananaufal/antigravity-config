---
title: "Zero-Downtime Deployment with Laravel Envoy for Laravel 11"
description: "Panduan komprehensif, arsitektur, dan praktik terbaik (Top 1% Quality) untuk mengonfigurasi Zero-Downtime Deployment menggunakan Laravel Envoy."
author: "Antigravity"
date: "2026-07-31"
---

# 🚀 Top 1% Mastery: Zero-Downtime Deployment with Laravel Envoy

Zero-Downtime Deployment (ZDD) memastikan aplikasi tetap hidup dan melayani permintaan saat proses pembaruan (deployment) sedang berlangsung. Pada Laravel 11, ZDD umumnya dicapai menggunakan pendekatan symlink, di mana direktori *release* baru disiapkan, diinstal *dependencies*-nya, kemudian symlink direktori aktif dipindahkan dalam hitungan milidetik.

Dokumen ini mencakup panduan *end-to-end* menggunakan **Laravel Envoy**, *anti-patterns*, struktur Clean Architecture untuk manajemen deployment, dan pengujian dengan Pest v3.

## 🌟 1. Arsitektur Direktori Zero-Downtime

Sebelum menggunakan Envoy, struktur direktori server harus dirancang untuk ZDD.

```text
/var/www/my-app/
├── current -> /var/www/my-app/releases/20260731103924
├── .env
├── storage/
└── releases/
    ├── 20260729100000
    ├── 20260730100000
    └── 20260731103924
```

- **`current`**: Symlink ke rilis terbaru. Web server (Nginx/Apache) diarahkan ke `/var/www/my-app/current/public`.
- **`.env`**: File environment global. Di-symlink ke setiap rilis.
- **`storage`**: Direktori persisten untuk file cache, log, dan upload. Di-symlink ke setiap rilis.
- **`releases`**: Menyimpan riwayat deployment untuk kemudahan *rollback*.

## 🛠️ 2. Konfigurasi `Envoy.blade.php` Tingkat Lanjut

`Envoy.blade.php` adalah file utama untuk mendefinisikan *tasks* SSH. Simpan file ini di *root* proyek Laravel Anda.

```blade
@servers(['web' => 'deployer@192.168.1.10 -p 22'])

@setup
    $repository = 'git@github.com:vendor/project.git';
    $releases_dir = '/var/www/my-app/releases';
    $app_dir = '/var/www/my-app';
    $release = date('YmdHis');
    $new_release_dir = $releases_dir .'/'. $release;
    $keep_releases = 5;
@endsetup

@story('deploy')
    clone_repository
    run_composer
    update_symlinks
    optimize_laravel
    clean_old_releases
    restart_services
@endstory

@task('clone_repository')
    echo 'Cloning repository...'
    [ -d {{ $releases_dir }} ] || mkdir -p {{ $releases_dir }}
    git clone --depth 1 {{ $repository }} {{ $new_release_dir }}
    cd {{ $new_release_dir }}
    git reset --hard HEAD
@endtask

@task('run_composer')
    echo "Starting deployment ({{ $release }})..."
    cd {{ $new_release_dir }}
    composer install --prefer-dist --no-scripts -q -o
@endtask

@task('update_symlinks')
    echo "Linking storage directory..."
    rm -rf {{ $new_release_dir }}/storage
    ln -nfs {{ $app_dir }}/storage {{ $new_release_dir }}/storage

    echo 'Linking .env file...'
    ln -nfs {{ $app_dir }}/.env {{ $new_release_dir }}/.env

    echo 'Linking current release...'
    ln -nfs {{ $new_release_dir }} {{ $app_dir }}/current
@endtask

@task('optimize_laravel')
    echo 'Optimizing application...'
    cd {{ $app_dir }}/current
    php artisan clear-compiled
    php artisan optimize
    php artisan migrate --force
@endtask

@task('clean_old_releases')
    echo 'Cleaning up old releases...'
    cd {{ $releases_dir }}
    ls -dt */ | tail -n +{{ $keep_releases + 1 }} | xargs rm -rf;
@endtask

@task('restart_services')
    echo 'Restarting FPM and Horizon...'
    sudo systemctl reload php8.4-fpm
    cd {{ $app_dir }}/current
    php artisan horizon:terminate
@endtask
```

## 🚨 3. Anti-Patterns & Best Practices (Keamanan & Performa)

### ❌ Anti-Pattern 1: Migrasi Database Blocking & Destruktif
Melakukan perubahan skema *database* (seperti `dropColumn` atau me-*rename* kolom) pada tabel berukuran besar dalam satu deployment ZDD akan merusak rilis sebelumnya (saat *rollback*) dan menyebabkan *downtime* (table lock).

```php
// ❌ KODE SALAH: Migrasi yang memblokir dan merusak ZDD (Tidak Backward Compatible)
declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // Berbahaya: Jika deployment dibatalkan (rollback), kode aplikasi lama 
        // akan error karena kolom 'old_status' hilang. 
        // Selain itu, eksekusi pada tabel besar menyebabkan lock.
        Schema::table('transactions', function (Blueprint $table) {
            $table->dropColumn('old_status');
            $table->string('new_status', 50)->index();
        });
    }
};
```

**✅ Solusi Benar: Expand and Contract Pattern**
Bagikan menjadi beberapa fase deployment. Fase 1: Tambahkan kolom baru. Fase 2: Tulis ke kedua kolom. Fase 3: Migrasi data historis. Fase 4: Hapus kolom lama.

```php
// ✅ KODE BENAR: Menambahkan kolom baru tanpa menghapus kolom lama (Fase 1 ZDD)
declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // Aman: Menambahkan kolom secara non-blocking dan kompatibel 
        // dengan kode rilis sebelumnya.
        Schema::table('transactions', function (Blueprint $table) {
            $table->string('new_status', 50)->nullable()->index();
        });
    }

    public function down(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->dropColumn('new_status');
        });
    }
};
```

**Penjelasan:** Migrasi yang kompatibel ke belakang (backward-compatible) sangat kritis dalam ZDD. Anda tidak boleh menghapus atau mengubah nama kolom yang sedang digunakan oleh kode yang masih berjalan (meskipun hanya hitungan milidetik saat symlink berganti).

### ❌ Anti-Pattern 2: Hardcoding Credentials dalam Deployment Script
Menyimpan *passwords* atau *SSH keys* di dalam file `Envoy.blade.php` atau mengeksekusi Composer dengan *root* (*sudo*).

```blade
@setup
    // ❌ KODE SALAH: Hardcoded password & user root
    $server = 'root:Mypa$$w0rd!@192.168.1.10';
@endsetup

@task('run_composer')
    // ❌ KODE SALAH: Composer berjalan sebagai root (Memory Risk & Security)
    sudo composer install 
@endtask
```

**✅ Solusi Benar: SSH Keys & Dedicated Deployer User**
Gunakan SSH Key Authentication (Forwarding) dan buat *user* khusus (misal: `deployer`) tanpa hak akses *sudo* (kecuali `systemctl reload php-fpm` via `visudo`).

```blade
@servers(['web' => 'deployer@192.168.1.10'])

@setup
    // ✅ KODE BENAR: Mengandalkan SSH Key Authentication Agent Forwarding
    $new_release_dir = '/var/www/app/releases/' . date('YmdHis');
@endsetup

@task('run_composer')
    // ✅ KODE BENAR: Composer dijalankan dengan prefer-dist dan tanpa dev dependencies
    cd {{ $new_release_dir }}
    composer install --no-dev --optimize-autoloader --no-interaction
@endtask
```

**Penjelasan:** Menjalankan Composer sebagai *root* memungkinkan skrip nakal dari pihak ketiga mendapatkan kendali penuh atas sistem operasi. Selalu gunakan `deployer` terisolasi.

---

## 🏛️ 4. Clean Architecture: Manajemen Deployment melalui API

Dalam ekosistem Enterprise, Anda mungkin membangun *dashboard* atau sistem CI/CD internal untuk memicu deployment Envoy. Di bawah ini adalah contoh arsitektur *clean* untuk memicu dan mencatat log deployment.

### Domain Model: Deployment
```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

final class Deployment extends Model
{
    use HasFactory;

    protected $fillable = [
        'commit_hash',
        'status',
        'triggered_by',
        'log_output'
    ];

    protected $casts = [
        'created_at' => 'immutable_datetime',
        'updated_at' => 'immutable_datetime',
    ];
}
```

### FormRequest: Validasi Input
```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class TriggerDeploymentRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('trigger-deployment');
    }

    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'commit_hash' => ['required', 'string', 'size:40'],
            'environment' => ['required', 'string', 'in:production,staging'],
        ];
    }
}
```

### Repository Pattern: Abstraksi Database
```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Models\Deployment;
use Illuminate\Database\Eloquent\Collection;

interface DeploymentRepositoryInterface
{
    public function createPending(string $commitHash, int $userId): Deployment;
    public function updateStatus(Deployment $deployment, string $status, string $log): bool;
}

final class DeploymentRepository implements DeploymentRepositoryInterface
{
    public function createPending(string $commitHash, int $userId): Deployment
    {
        return Deployment::create([
            'commit_hash' => $commitHash,
            'status' => 'pending',
            'triggered_by' => $userId,
            'log_output' => 'Deployment queued...',
        ]);
    }

    public function updateStatus(Deployment $deployment, string $status, string $log): bool
    {
        return $deployment->update([
            'status' => $status,
            'log_output' => $log,
        ]);
    }
}
```

### Action / Service: Logika Bisnis Utama
Kita akan membuat `TriggerEnvoyDeploymentAction` yang menggunakan PHP `Process` (tersedia sejak Laravel 10+) untuk memicu command `envoy`.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Deployment;

use App\Models\Deployment;
use App\Repositories\DeploymentRepositoryInterface;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Log;

final readonly class TriggerEnvoyDeploymentAction
{
    public function __construct(
        private DeploymentRepositoryInterface $repository
    ) {}

    public function execute(string $commitHash, int $userId): Deployment
    {
        $deployment = $this->repository->createPending($commitHash, $userId);

        try {
            // Memicu envoy secara asinkron atau sinkron.
            // Di produksi, disarankan menggunakan Queue/Jobs.
            $result = Process::run("vendor/bin/envoy run deploy --commit={$commitHash}");

            $status = $result->successful() ? 'completed' : 'failed';
            $log = $result->output() . "\n" . $result->errorOutput();

            $this->repository->updateStatus($deployment, $status, $log);

            if ($result->failed()) {
                Log::error("Deployment failed: {$log}");
            }

            return $deployment;

        } catch (\Throwable $exception) {
            $this->repository->updateStatus($deployment, 'failed', $exception->getMessage());
            Log::critical("Deployment exception: " . $exception->getMessage());
            throw $exception;
        }
    }
}
```

### Controller: HTTP Layer
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Actions\Deployment\TriggerEnvoyDeploymentAction;
use App\Http\Requests\TriggerDeploymentRequest;
use Illuminate\Http\JsonResponse;

final class DeploymentController extends Controller
{
    public function __construct(
        private readonly TriggerEnvoyDeploymentAction $triggerDeploymentAction
    ) {}

    public function store(TriggerDeploymentRequest $request): JsonResponse
    {
        $deployment = $this->triggerDeploymentAction->execute(
            $request->validated('commit_hash'),
            $request->user()->id
        );

        return response()->json([
            'message' => 'Deployment process finished.',
            'data' => $deployment
        ], 201);
    }
}
```

---

## 🧪 5. Pest v3 Testing (Architecture & Unit)

Kode harus divalidasi dengan baik, menggunakan Pest v3 dengan fitur *Architecture Testing* untuk memastikan struktur *Clean Architecture* dan *Unit Testing* yang kuat.

### `tests/ArchTest.php` - Validasi Arsitektur
Mencegah pelanggaran *layer* Clean Architecture (misalnya Controller memanggil Model secara langsung).

```php
<?php

declare(strict_types=1);

arch('strict types are used everywhere')
    ->expect('App')
    ->toUseStrictTypes();

arch('controllers must not use models directly')
    ->expect('App\Http\Controllers')
    ->not->toUse('App\Models')
    ->ignoring('App\Models\User'); // Pengecualian untuk Auth User

arch('actions must be final and readonly')
    ->expect('App\Actions')
    ->toBeClasses()
    ->toBeFinal()
    ->toBeReadonly();

arch('repositories must implement interfaces')
    ->expect('App\Repositories')
    ->toImplementAnything()
    ->ignoring('App\Repositories\*Interface');
```

### `tests/Unit/Actions/TriggerEnvoyDeploymentActionTest.php`
Menguji *Action* bisnis logika dengan *Mocking* Proses CLI menggunakan Laravel Process Fakes.

```php
<?php

declare(strict_types=1);

use App\Actions\Deployment\TriggerEnvoyDeploymentAction;
use App\Models\Deployment;
use App\Repositories\DeploymentRepositoryInterface;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Log;

uses(Tests\TestCase::class);

it('executes envoy deployment successfully', function () {
    // 1. Arrange
    $commitHash = '1234567890abcdef1234567890abcdef12345678';
    $userId = 1;
    
    $deploymentModel = new Deployment([
        'id' => 1,
        'commit_hash' => $commitHash,
        'status' => 'pending',
    ]);

    $repositoryMock = Mockery::mock(DeploymentRepositoryInterface::class);
    $repositoryMock->shouldReceive('createPending')
        ->once()
        ->with($commitHash, $userId)
        ->andReturn($deploymentModel);

    $repositoryMock->shouldReceive('updateStatus')
        ->once()
        ->with($deploymentModel, 'completed', "Deploy success\n")
        ->andReturnTrue();

    // Fake Process CLI output
    Process::fake([
        "vendor/bin/envoy run deploy*" => Process::result(
            output: 'Deploy success',
            errorOutput: '',
            exitCode: 0
        ),
    ]);

    $action = new TriggerEnvoyDeploymentAction($repositoryMock);

    // 2. Act
    $result = $action->execute($commitHash, $userId);

    // 3. Assert
    expect($result)->toBeInstanceOf(Deployment::class)
        ->and($result->commit_hash)->toBe($commitHash);

    Process::assertRan("vendor/bin/envoy run deploy --commit={$commitHash}");
});

it('handles failed envoy deployment', function () {
    // 1. Arrange
    $commitHash = '1234567890abcdef1234567890abcdef12345678';
    $userId = 1;
    
    $deploymentModel = new Deployment([
        'id' => 1,
        'commit_hash' => $commitHash,
        'status' => 'pending',
    ]);

    $repositoryMock = Mockery::mock(DeploymentRepositoryInterface::class);
    $repositoryMock->shouldReceive('createPending')
        ->once()
        ->with($commitHash, $userId)
        ->andReturn($deploymentModel);

    $repositoryMock->shouldReceive('updateStatus')
        ->once()
        ->with($deploymentModel, 'failed', "Deploy start\nError syntax")
        ->andReturnTrue();

    // Fake Process CLI failed output
    Process::fake([
        "vendor/bin/envoy run deploy*" => Process::result(
            output: 'Deploy start',
            errorOutput: 'Error syntax',
            exitCode: 1
        ),
    ]);

    Log::shouldReceive('error')
        ->once()
        ->withArgs(fn($msg) => str_contains($msg, 'Deployment failed:'));

    $action = new TriggerEnvoyDeploymentAction($repositoryMock);

    // 2. Act
    $result = $action->execute($commitHash, $userId);

    // 3. Assert
    expect($result)->toBeInstanceOf(Deployment::class);
});
```

---

## 🎯 Kesimpulan
Dengan implementasi **Laravel Envoy Zero-Downtime Deployment**, *Clean Architecture*, dan *Pest v3*, Anda memiliki sistem deployment yang:
1. **Aman (Security):** Tanpa credential hardcoded, berjalan sebagai user non-root.
2. **Handal (Reliability):** Bebas *downtime*, rollback instan via `current` symlink.
3. **Terkontrol (Maintainability):** Dipicu melalui API berbasis *Clean Architecture* dan diuji penuh menggunakan fitur *Architecture Testing* Pest.
