---
title: "Docker Multi-Stage Builds with FrankenPHP for Laravel 11"
description: "Panduan mendalam untuk men-deploy aplikasi Laravel 11 menggunakan arsitektur Docker Multi-Stage dengan server FrankenPHP (Caddy-based PHP) untuk performa maksimum."
tags: [devops, docker, frankenphp, laravel-11, clean-architecture]
---

# Docker Multi-Stage Builds with FrankenPHP untuk Laravel 11

Implementasi **Docker Multi-Stage Builds** yang dikombinasikan dengan **FrankenPHP** memberikan loncatan performa signifikan bagi aplikasi Laravel 11. FrankenPHP merupakan server aplikasi modern yang ditulis menggunakan bahasa Go (berbasis Caddy) yang memungkinkan aplikasi PHP berjalan dalam mode *worker* (Octane) secara *native* sehingga menghilangkan *overhead* dari CGI atau FPM tradisional.

## 1. Arsitektur Clean Architecture dalam Deployment

Sebelum kita masuk ke level Docker, aplikasi harus mematuhi prinsip **Clean Architecture**. Pemisahan antar *layer* (FormRequest -> Controller -> Action -> Repository -> Model) tidak hanya membuat kode *maintainable*, tapi juga *testable* dan siap berjalan efisien di atas FrankenPHP Worker.

### Struktur Layer Clean Architecture (PHP 8.3/8.4 + Laravel 11)

Semua *file* PHP wajib menggunakan deklarasi strict types.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class DeployFrankenRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, \Illuminate\Contracts\Validation\ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'service_name' => ['required', 'string', 'max:255', 'alpha_dash'],
            'worker_count' => ['required', 'integer', 'min:1', 'max:64'],
        ];
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Requests\DeployFrankenRequest;
use App\Actions\DeployFrankenServiceAction;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final class DeployController extends Controller
{
    public function __construct(
        private readonly DeployFrankenServiceAction $deployAction
    ) {}

    public function __invoke(DeployFrankenRequest $request): JsonResponse
    {
        $result = $this->deployAction->execute(
            serviceName: $request->validated('service_name'),
            workerCount: (int) $request->validated('worker_count')
        );

        return response()->json([
            'status' => 'success',
            'data'   => $result,
        ], Response::HTTP_CREATED);
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Actions;

use App\Repositories\DeploymentRepositoryInterface;

final readonly class DeployFrankenServiceAction
{
    public function __construct(
        private DeploymentRepositoryInterface $deploymentRepository
    ) {}

    public function execute(string $serviceName, int $workerCount): array
    {
        // Validasi dan eksekusi deployment (simulasi)
        $deploymentData = [
            'service' => $serviceName,
            'workers' => $workerCount,
            'status'  => 'deployed',
            'time'    => now()->toIso8601String(),
        ];

        return $this->deploymentRepository->saveDeployment($deploymentData);
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Repositories;

interface DeploymentRepositoryInterface
{
    public function saveDeployment(array $data): array;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Models\Deployment;

final class DeploymentRepository implements DeploymentRepositoryInterface
{
    public function saveDeployment(array $data): array
    {
        $model = Deployment::create($data);
        return $model->toArray();
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

final class Deployment extends Model
{
    protected $fillable = [
        'service',
        'workers',
        'status',
        'time',
    ];
}
```

## 2. Docker Multi-Stage Build Script (Dockerfile)

Kita menggunakan teknik *multi-stage* untuk memisahkan *environment build* (di mana *composer install* dan *npm run build* dijalankan) dari *environment runtime* (*production image* akhir yang ringan).

```dockerfile
# syntax=docker/dockerfile:1.4

# ---------------------------------------------------------
# STAGE 1: Composer dependencies
# ---------------------------------------------------------
FROM dunglas/frankenphp:php8.3-alpine AS vendor

WORKDIR /app

# Install git and zip for composer
RUN apk add --no-cache git zip unzip

# Copy composer files
COPY composer.json composer.lock ./

# Install dependencies efficiently without dev requirements and autoloader (yet)
RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer && \
    composer install --no-dev --no-interaction --no-progress --no-scripts --no-autoloader

# ---------------------------------------------------------
# STAGE 2: Node dependencies & Build assets
# ---------------------------------------------------------
FROM node:22-alpine AS assets

WORKDIR /app

# Copy package config
COPY package.json package-lock.json ./
RUN npm ci

# Copy application files needed for build
COPY webpack.mix.js vite.config.js ./
COPY resources/ ./resources/
COPY public/ ./public/

# Build production assets
RUN npm run build

# ---------------------------------------------------------
# STAGE 3: Final Production Image
# ---------------------------------------------------------
FROM dunglas/frankenphp:php8.3-alpine AS runner

# Set production environment variables
ENV APP_ENV=production \
    APP_DEBUG=false \
    FRANKENPHP_CONFIG="worker ./public/index.php" \
    MAX_REQUESTS=1000

# Install required PHP extensions (e.g., opcache, pdo_pgsql, redis)
RUN install-php-extensions \
    opcache \
    pdo_pgsql \
    redis \
    pcntl \
    && rm -rf /tmp/*

WORKDIR /app

# Copy vendor from stage 1
COPY --from=vendor /app/vendor/ /app/vendor/

# Copy built assets from stage 2
COPY --from=assets /app/public/build/ /app/public/build/
COPY --from=assets /app/public/mix-manifest.json /app/public/ 2>/dev/null || true

# Copy application source code
COPY . /app

# Generate autoloader and optimize
RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer && \
    composer dump-autoload --optimize --no-dev --classmap-authoritative && \
    php artisan config:cache && \
    php artisan route:cache && \
    php artisan view:cache

# Set permissions
RUN chown -R www-data:www-data /app/storage /app/bootstrap/cache

# Switch to non-root user (www-data) for security
USER www-data

# Expose standard web port
EXPOSE 80 443

# Start FrankenPHP in worker mode
CMD ["frankenphp", "run", "--config", "/etc/caddy/Caddyfile"]
```

## 3. Anti-Patterns vs Best Practices (Studi Kasus)

Berikut adalah *anti-patterns* yang sangat berbahaya namun masih sering ditemukan di dunia nyata, beserta solusinya menggunakan standar Top 1%.

### ❌ Anti-Pattern 1: Menyalin Seluruh Direktori (Memory Risk & Image Bloat)

**KODE SALAH (Dockerfile):**
```dockerfile
FROM dunglas/frankenphp:php8.3-alpine

WORKDIR /app
COPY . .
RUN composer install
RUN npm install && npm run build
CMD ["frankenphp", "run"]
```
**Mengapa Berbahaya?**
- **Image Bloat:** *Image* akan mengandung folder `.git`, `node_modules`, `tests`, dan berkas dokumentasi internal, menyebabkan ukuran *image* bisa mencapai >1 GB.
- **Memory Risk & Security:** Berkas rahasia (seperti `.env.local` atau `phpunit.xml` yang berisi *credentials* DB tes) akan terbawa ke *production*.
- **Slow Pipeline:** Setiap kali ada satu *file* berubah, Docker *cache* akan rusak sepenuhnya, menyebabkan proses `composer install` dan `npm install` harus dijalankan ulang dari nol.

**✅ KODE BENAR (Gunakan .dockerignore dan Multi-Stage):**
Pastikan Anda menggunakan `.dockerignore`:
```text
.git
.env*
node_modules
tests
/storage/*.key
/vendor
npm-debug.log
```
Dan gunakan *Multi-Stage build* seperti pada skrip di Bagian 2 di atas. Hanya *artifact* final (`/vendor` dan `/public/build`) yang disalin ke `runner stage`.

### ❌ Anti-Pattern 2: Menjalankan FrankenPHP sebagai `root` (Security Risk)

**KODE SALAH (Dockerfile):**
```dockerfile
FROM dunglas/frankenphp:php8.3-alpine

WORKDIR /app
COPY . /app
RUN chown -R root:root /app
CMD ["frankenphp", "run"]
```
**Mengapa Berbahaya?**
- **RCE to Root Escelation:** Jika terdapat celah RCE (*Remote Code Execution*) di aplikasi Laravel (misalnya akibat manipulasi *unserialize* atau *LFI*), penyerang akan langsung mendapatkan akses `root` di dalam kontainer. Dari sini, penyerang bisa mencoba melakukan *container escape* untuk meretas mesin *host*.

**✅ KODE BENAR (Drop Privileges ke Non-Root User):**
Gunakan *user* `www-data` (atau buat *user* khusus).
```dockerfile
# Ubah kepemilikan khusus untuk direktori yang butuh akses tulis
RUN chown -R www-data:www-data /app/storage /app/bootstrap/cache
# Turunkan privilege
USER www-data
CMD ["frankenphp", "run", "--config", "/etc/caddy/Caddyfile"]
```

## 4. Testing dengan Pest v3 (Unit & Architecture)

Kita akan memastikan bahwa *layer* Clean Architecture diterapkan dengan benar dan fitur asinkron/penjadwalan berjalan tanpa memanggil kelas `Model` secara langsung dari `Controller`.

### Arch Testing (`tests/Feature/ArchitectureTest.php`)

```php
<?php

declare(strict_types=1);

test('app ignores debug statements')
    ->expect(['dd', 'dump', 'ray', 'env'])
    ->not->toBeUsed();

test('strict types declaration is enforced')
    ->expect('App')
    ->toUseStrictTypes();

test('controllers must not interact directly with models')
    ->expect('App\Http\Controllers')
    ->not->toUse('App\Models')
    ->ignoring('App\Models\User'); // Pengecualian hanya untuk Type-Hint Auth

test('repositories must implement interface')
    ->expect('App\Repositories')
    ->classes()
    ->toImplementAnything();
```

### Unit Testing (`tests/Unit/Actions/DeployFrankenServiceActionTest.php`)

```php
<?php

declare(strict_types=1);

use App\Actions\DeployFrankenServiceAction;
use App\Repositories\DeploymentRepositoryInterface;
use Illuminate\Support\Carbon;

it('executes deployment and returns formatted array', function () {
    // 1. Arrange (Mock the Repository)
    $mockRepo = Mockery::mock(DeploymentRepositoryInterface::class);
    
    // Freeze time for assertion
    Carbon::setTestNow(Carbon::parse('2026-01-01 10:00:00'));

    $expectedData = [
        'service' => 'franken-service',
        'workers' => 10,
        'status'  => 'deployed',
        'time'    => '2026-01-01T10:00:00+00:00',
    ];

    $mockRepo->shouldReceive('saveDeployment')
        ->once()
        ->with($expectedData)
        ->andReturn($expectedData);

    // Instantiate Action with injected mock
    $action = new DeployFrankenServiceAction($mockRepo);

    // 2. Act
    $result = $action->execute('franken-service', 10);

    // 3. Assert
    expect($result)->toBeArray()
        ->and($result['service'])->toBe('franken-service')
        ->and($result['workers'])->toBe(10)
        ->and($result['status'])->toBe('deployed');
});
```

### Integration Testing (`tests/Feature/Controllers/DeployControllerTest.php`)

```php
<?php

declare(strict_types=1);

use App\Actions\DeployFrankenServiceAction;
use App\Models\User;
use Illuminate\Testing\Fluent\AssertableJson;

it('creates deployment successfully via API endpoint', function () {
    // Fake the Action so we don't hit the real DB or Repository
    $mockAction = Mockery::mock(DeployFrankenServiceAction::class);
    $mockAction->shouldReceive('execute')
        ->once()
        ->with('web-app', 16)
        ->andReturn([
            'service' => 'web-app',
            'workers' => 16,
            'status'  => 'deployed',
            'time'    => now()->toIso8601String(),
        ]);
        
    $this->instance(DeployFrankenServiceAction::class, $mockAction);

    // Create a dummy admin user to bypass Auth middleware if any
    $user = User::factory()->create();

    // Perform Request
    $response = $this->actingAs($user, 'sanctum')
                     ->postJson('/api/deploy', [
                         'service_name' => 'web-app',
                         'worker_count' => 16,
                     ]);

    // Assertion
    $response->assertCreated()
             ->assertJson(fn (AssertableJson $json) =>
                 $json->where('status', 'success')
                      ->has('data', fn (AssertableJson $data) =>
                          $data->where('service', 'web-app')
                               ->where('workers', 16)
                               ->where('status', 'deployed')
                               ->etc()
                      )
             );
});
```

Dengan mengimplementasikan arsitektur ini, proyek Laravel 11 siap dieksekusi oleh FrankenPHP secara efisien dan sejalan dengan standar industri terbaik, tanpa cela RCE, dan dengan *zero downtime*.
