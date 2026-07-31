---
title: "Automated Testing & CI/CD Pipelines in Laravel (Top 1% Standards)"
description: "Panduan komprehensif implementasi Automated Testing dengan Pest v3 dan optimasi CI/CD Pipeline di ekosistem Laravel 11/12."
version: 1.0.0
tags: [laravel, testing, pest, ci-cd, github-actions, gitlab-ci, architecture]
---

# Automated Testing & CI/CD Pipelines in Laravel (Top 1% Standards)

Membangun aplikasi Enterprise dengan Laravel 11/12 membutuhkan lebih dari sekadar kode yang berfungsi; ia menuntut jaminan kualitas yang terotomatisasi secara presisi. Top 1% engineers tidak melakukan pengujian secara manual atau mengandalkan pipeline yang lambat dan rapuh. Mereka menerapkan **Clean Architecture**, menulis pengujian deskriptif dengan **Pest v3**, dan mengonfigurasi **CI/CD Pipelines** (GitHub Actions / GitLab CI) yang efisien, paralel, dan deterministik.

Dokumen ini adalah referensi definitif untuk merancang sistem *Automated Testing* dan *Continuous Integration / Continuous Deployment* (CI/CD) yang mencapai skor tertinggi dalam skalabilitas, keamanan, dan *maintainability*.

---

## 1. Fondasi Clean Architecture (Persiapan Pengujian)

Sebelum menulis tes, arsitektur kode harus mendukung *testability*. Pendekatan *Fat Controller* adalah mimpi buruk untuk pengujian. Kita akan mengadopsi pola **FormRequest -> Controller -> Action -> Repository -> Model** agar setiap komponen dapat diuji secara terisolasi (Unit Test) maupun terintegrasi (Feature Test).

Sebagai studi kasus, kita akan mengimplementasikan fitur **"Transfer Saldo Pengguna"**.

### A. Model & Factory
```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

class Wallet extends Model
{
    use HasFactory, SoftDeletes;

    protected $fillable = [
        'user_id',
        'balance',
        'currency',
        'status',
    ];

    protected $casts = [
        'balance' => 'integer', // Disimpan dalam satuan terkecil (sen)
    ];

    /**
     * @return HasMany<Transaction>
     */
    public function transactions(): HasMany
    {
        return $this->hasMany(Transaction::class);
    }
}
```

### B. Repository Contract & Implementation
Repository memisahkan logika query Eloquent dari layer bisnis.

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Contracts;

use App\Models\Wallet;

interface WalletRepositoryInterface
{
    public function findByUserIdLockedForUpdate(int $userId): ?Wallet;
    public function updateBalance(Wallet $wallet, int $amount): bool;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use App\Models\Wallet;
use App\Repositories\Contracts\WalletRepositoryInterface;

readonly class WalletRepository implements WalletRepositoryInterface
{
    public function findByUserIdLockedForUpdate(int $userId): ?Wallet
    {
        return Wallet::where('user_id', $userId)
            ->lockForUpdate()
            ->first();
    }

    public function updateBalance(Wallet $wallet, int $amount): bool
    {
        $wallet->balance += $amount;
        return $wallet->save();
    }
}
```

### C. Action (Domain Logic)
Action class berisi murni logika bisnis dan dapat di-test dengan mocking terhadap dependencies.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Finance;

use App\Exceptions\InsufficientBalanceException;
use App\Exceptions\WalletNotFoundException;
use App\Repositories\Contracts\WalletRepositoryInterface;
use Illuminate\Support\Facades\DB;
use Throwable;

readonly class TransferBalanceAction
{
    public function __construct(
        private WalletRepositoryInterface $walletRepository
    ) {}

    /**
     * @throws WalletNotFoundException
     * @throws InsufficientBalanceException
     * @throws Throwable
     */
    public function execute(int $senderId, int $receiverId, int $amount): void
    {
        if ($amount <= 0) {
            throw new \InvalidArgumentException('Transfer amount must be strictly positive.');
        }

        DB::transaction(function () use ($senderId, $receiverId, $amount): void {
            $senderWallet = $this->walletRepository->findByUserIdLockedForUpdate($senderId);
            $receiverWallet = $this->walletRepository->findByUserIdLockedForUpdate($receiverId);

            if (! $senderWallet || ! $receiverWallet) {
                throw new WalletNotFoundException('Sender or receiver wallet not found.');
            }

            if ($senderWallet->balance < $amount) {
                throw new InsufficientBalanceException('Sender does not have enough balance.');
            }

            $this->walletRepository->updateBalance($senderWallet, -$amount);
            $this->walletRepository->updateBalance($receiverWallet, $amount);
        }, 3); // 3 retries for deadlocks
    }
}
```

### D. FormRequest & Controller
FormRequest menangani validasi, sedangkan Controller hanya mengatur aliran HTTP.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Finance;

use Illuminate\Foundation\Http\FormRequest;

class TransferBalanceRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // Asumsikan otorisasi ditangani di middleware
    }

    /**
     * @return array<string, array<int, string|\Illuminate\Validation\Rules\Exists>>
     */
    public function rules(): array
    {
        return [
            'receiver_id' => ['required', 'integer', 'exists:users,id', 'different:sender_id'],
            'amount' => ['required', 'integer', 'min:100'], // Minimal 1.00 USD/IDR
        ];
    }
    
    protected function prepareForValidation(): void
    {
        $this->merge([
            'sender_id' => $this->user()?->id,
        ]);
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Actions\Finance\TransferBalanceAction;
use App\Exceptions\InsufficientBalanceException;
use App\Exceptions\WalletNotFoundException;
use App\Http\Controllers\Controller;
use App\Http\Requests\Finance\TransferBalanceRequest;
use Illuminate\Http\JsonResponse;

class TransferController extends Controller
{
    public function __construct(
        private readonly TransferBalanceAction $transferBalanceAction
    ) {}

    public function __invoke(TransferBalanceRequest $request): JsonResponse
    {
        try {
            $this->transferBalanceAction->execute(
                senderId: (int) $request->user()->id,
                receiverId: (int) $request->validated('receiver_id'),
                amount: (int) $request->validated('amount')
            );

            return response()->json([
                'success' => true,
                'message' => 'Transfer completed successfully.',
            ], 200);

        } catch (WalletNotFoundException | InsufficientBalanceException $e) {
            return response()->json([
                'success' => false,
                'message' => $e->getMessage(),
            ], 422);
        } catch (\Throwable $e) {
            return response()->json([
                'success' => false,
                'message' => 'An internal error occurred.',
            ], 500);
        }
    }
}
```

---

## 2. Pengujian dengan Pest v3 (Unit, Feature, Arch)

Pest PHP v3 adalah standar *de-facto* untuk Laravel testing, mengungguli PHPUnit tradisional berkat sintaks ekspresifnya, plugin *Architecture Testing*, dan fitur paralel asali.

### A. Architecture Tests (`tests/ArchTest.php`)
Pest Arch memastikan tim tidak melanggar aturan arsitektur.

```php
<?php

declare(strict_types=1);

arch('globals')
    ->expect(['dd', 'dump', 'env', 'ray'])
    ->not->toBeUsed()
    ->ignoring('config');

arch('controllers')
    ->expect('App\Http\Controllers')
    ->toBeClasses()
    ->toHaveSuffix('Controller')
    ->not->toBeUsedOutside([
        'App\Http\Controllers',
        'App\Providers',
        'Illuminate\Support\Facades\Route'
    ]);

arch('repositories_are_interfaces_and_implementations')
    ->expect('App\Repositories')
    ->toUseStrictTypes()
    ->and('App\Repositories\Contracts')
    ->toBeInterfaces()
    ->toHaveSuffix('Interface')
    ->and('App\Repositories\Eloquent')
    ->toBeClasses()
    ->toHaveSuffix('Repository')
    ->toImplement(fn (string $class) => str_replace(['Eloquent', 'Repository'], ['Contracts', 'RepositoryInterface'], $class));

arch('actions')
    ->expect('App\Actions')
    ->toBeClasses()
    ->toHaveSuffix('Action')
    ->toUseStrictTypes()
    ->toBeReadonly();
```

### B. Unit Tests (`tests/Unit/Actions/Finance/TransferBalanceActionTest.php`)
Unit test menguji isolasi fungsi (Action) menggunakan *Mocking* dari repository, sehingga cepat dan tidak memerlukan *database connection*.

```php
<?php

declare(strict_types=1);

use App\Actions\Finance\TransferBalanceAction;
use App\Exceptions\InsufficientBalanceException;
use App\Models\Wallet;
use App\Repositories\Contracts\WalletRepositoryInterface;
use Illuminate\Support\Facades\DB;

uses()->group('finance', 'unit');

beforeEach(function () {
    // Mem-bypass DB::transaction agar langsung mengeksekusi closure di dalamnya
    DB::shouldReceive('transaction')
        ->andReturnUsing(fn (Closure $callback) => $callback());
        
    $this->repositoryMock = Mockery::mock(WalletRepositoryInterface::class);
    $this->action = new TransferBalanceAction($this->repositoryMock);
});

it('throws exception if transfer amount is zero or negative', function (int $invalidAmount) {
    expect(fn () => $this->action->execute(1, 2, $invalidAmount))
        ->toThrow(InvalidArgumentException::class, 'Transfer amount must be strictly positive.');
})->with([0, -100, -5000]);

it('successfully transfers balance between two wallets', function () {
    $senderWallet = new Wallet(['user_id' => 1, 'balance' => 5000]);
    $receiverWallet = new Wallet(['user_id' => 2, 'balance' => 1000]);

    $this->repositoryMock
        ->shouldReceive('findByUserIdLockedForUpdate')
        ->with(1)
        ->once()
        ->andReturn($senderWallet);

    $this->repositoryMock
        ->shouldReceive('findByUserIdLockedForUpdate')
        ->with(2)
        ->once()
        ->andReturn($receiverWallet);

    $this->repositoryMock
        ->shouldReceive('updateBalance')
        ->with($senderWallet, -1500)
        ->once()
        ->andReturnTrue();

    $this->repositoryMock
        ->shouldReceive('updateBalance')
        ->with($receiverWallet, 1500)
        ->once()
        ->andReturnTrue();

    $this->action->execute(1, 2, 1500);
    
    // Test passes if no exceptions are thrown and mocks are verified
    expect(true)->toBeTrue(); 
});

it('throws exception if sender has insufficient balance', function () {
    $senderWallet = new Wallet(['user_id' => 1, 'balance' => 1000]);
    $receiverWallet = new Wallet(['user_id' => 2, 'balance' => 1000]);

    $this->repositoryMock->shouldReceive('findByUserIdLockedForUpdate')->with(1)->andReturn($senderWallet);
    $this->repositoryMock->shouldReceive('findByUserIdLockedForUpdate')->with(2)->andReturn($receiverWallet);

    expect(fn () => $this->action->execute(1, 2, 1500))
        ->toThrow(InsufficientBalanceException::class, 'Sender does not have enough balance.');
});
```

### C. Feature Tests (`tests/Feature/Api/V1/TransferControllerTest.php`)
Feature Test menguji aplikasi end-to-end melalui HTTP call dan database nyata (menggunakan trait `RefreshDatabase`).

```php
<?php

declare(strict_types=1);

use App\Models\User;
use App\Models\Wallet;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class)->group('finance', 'feature', 'api');

beforeEach(function () {
    $this->sender = User::factory()->create();
    $this->receiver = User::factory()->create();

    $this->senderWallet = Wallet::factory()->create([
        'user_id' => $this->sender->id,
        'balance' => 10000,
    ]);

    $this->receiverWallet = Wallet::factory()->create([
        'user_id' => $this->receiver->id,
        'balance' => 2000,
    ]);
});

it('allows an authenticated user to transfer balance', function () {
    $response = $this->actingAs($this->sender, 'sanctum')
        ->postJson('/api/v1/transfer', [
            'receiver_id' => $this->receiver->id,
            'amount' => 3000,
        ]);

    $response->assertStatus(200)
        ->assertJson([
            'success' => true,
            'message' => 'Transfer completed successfully.',
        ]);

    expect($this->senderWallet->fresh()->balance)->toBe(7000)
        ->and($this->receiverWallet->fresh()->balance)->toBe(5000);
});

it('rejects transfer if validation fails (e.g. amount too low)', function () {
    $response = $this->actingAs($this->sender, 'sanctum')
        ->postJson('/api/v1/transfer', [
            'receiver_id' => $this->receiver->id,
            'amount' => 50, // Below minimum 100
        ]);

    $response->assertStatus(422)
        ->assertJsonValidationErrors(['amount']);
});
```

---

## 3. Anti-Patterns dalam Automated Testing

### Anti-Pattern 1: Terlalu Banyak Mocking di Feature Test
Mocking adalah alat untuk Unit Test guna mengisolasi komponen. Namun, di Feature Test, melakukan mock pada Model/Eloquent atau Repository akan menghilangkan esensi pengujian integrasi. Jika database query rusak (contoh typo kolom), Feature Test yang di-*mock* akan tetap lulus (False Positive).

❌ **KODE SALAH (Mocking di Feature Test)**
```php
// DILARANG: Feature test menggunakan mock Eloquent / Action secara berlebihan
it('transfers balance (anti-pattern)', function () {
    $actionMock = Mockery::mock(TransferBalanceAction::class);
    $actionMock->shouldReceive('execute')->once();
    $this->app->instance(TransferBalanceAction::class, $actionMock);

    // HTTP test akan selalu pass walaupun query database sesungguhnya error
    $this->actingAs(User::factory()->create())
        ->postJson('/api/v1/transfer', ['receiver_id' => 2, 'amount' => 1000])
        ->assertStatus(200); 
});
```

✅ **KODE BENAR (Gunakan RefreshDatabase & Data Nyata)**
```php
// WAJIB: Feature Test memverifikasi State Database sebenarnya
it('transfers balance correctly', function () {
    $sender = User::factory()->hasWallet(['balance' => 5000])->create();
    $receiver = User::factory()->hasWallet(['balance' => 0])->create();

    $this->actingAs($sender)
        ->postJson('/api/v1/transfer', ['receiver_id' => $receiver->id, 'amount' => 1000])
        ->assertStatus(200);

    // Assert database diubah dengan benar
    $this->assertDatabaseHas('wallets', [
        'user_id' => $sender->id,
        'balance' => 4000
    ]);
});
```
*Mengapa Berbahaya:* Feature test berfungsi sebagai simulasi sistem yang berjalan. Memalsukan internal state di feature test menciptakan ilusi keamanan. Perubahan schema database atau relasi yang rusak tidak akan terdeteksi hingga terjadi *critical error* di production.

### Anti-Pattern 2: Time Dependency & Flaky Tests
Pengujian yang bergantung pada waktu sistem (seperti masa kedaluwarsa token, perhitungan bunga) sering menjadi *flaky*—kadang lulus, kadang gagal—tergantung kecepatan *runner* CI/CD atau waktu eksekusi.

❌ **KODE SALAH (Menggunakan `now()` atau `sleep()` langsung)**
```php
// DILARANG: Mengandalkan waktu nyata atau delay eksplisit
it('expires token after 1 hour', function () {
    $token = Token::create(['expires_at' => now()->addHour()]);
    
    // Buruk: Menggunakan sleep() memperlambat test suite secara signifikan
    sleep(3601); 
    
    expect($token->fresh()->isExpired())->toBeTrue();
});
```

✅ **KODE BENAR (Menggunakan Time Traveling via `Carbon::setTestNow` atau Trait Laravel)**
```php
// WAJIB: Memanipulasi waktu secara statis
it('expires token after 1 hour', function () {
    // Freeze time pada saat token dibuat
    $this->travelTo(now());
    $token = Token::create(['expires_at' => now()->addHour()]);
    
    // Pergi ke masa depan
    $this->travel(1)->hours()->and(1)->seconds();
    
    expect($token->fresh()->isExpired())->toBeTrue();
    
    // Reset waktu di kembalikan
    $this->travelBack();
});
```
*Mengapa Berbahaya:* *Flaky test* merusak kepercayaan *engineering team* terhadap pipeline CI. Jika sebuah *pipeline* gagal sesekali tanpa ada perubahan kode, *engineer* cenderung mengabaikan kegagalan merah, yang pada akhirnya meloloskan *bug* asli ke production.

---

## 4. CI/CD Pipeline Architecture (Top 1% Setup)

Pipeline yang baik harus cepat (di bawah 5 menit), menggunakan *caching* secara efisien, menjalankan *static analysis* (PHPStan/Pint), dan menjalankan *tests* secara paralel.

### A. GitHub Actions (`.github/workflows/ci.yml`)

Implementasi *GitHub Actions* dengan optimasi *cache* Composer, MySQL Service, Laravel Pint (linter), PHPStan (static analysis), dan eksekusi tes secara paralel (`pest --parallel`).

```yaml
name: CI Pipeline (Top 1%)

on:
  push:
    branches: ["main", "staging"]
  pull_request:
    branches: ["main", "staging"]

jobs:
  code-quality-and-tests:
    runs-on: ubuntu-24.04
    timeout-minutes: 15

    services:
      mysql:
        image: mysql:8.0
        env:
          MYSQL_ALLOW_EMPTY_PASSWORD: yes
          MYSQL_DATABASE: testing_db
        ports:
          - 3306:3306
        options: >-
          --health-cmd="mysqladmin ping"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=3

      redis:
        image: redis:7.0-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd="redis-cli ping"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=3

    steps:
      - name: ⬇️ Checkout Source Code
        uses: actions/checkout@v4

      - name: ⚙️ Setup PHP 8.3
        uses: shivammathur/setup-php@v2
        with:
          php-version: '8.3'
          extensions: mbstring, xml, ctype, iconv, intl, pdo_mysql, pcntl, redis
          coverage: pcov # Pcov is much faster than Xdebug for coverage

      - name: 📦 Cache Composer Packages
        id: composer-cache
        uses: actions/cache@v4
        with:
          path: vendor
          key: ${{ runner.os }}-php-${{ hashFiles('**/composer.lock') }}
          restore-keys: |
            ${{ runner.os }}-php-

      - name: 📥 Install Dependencies
        if: steps.composer-cache.outputs.cache-hit != 'true'
        run: composer install -q --no-ansi --no-interaction --no-scripts --no-progress --prefer-dist

      - name: 📄 Copy Environment File
        run: cp .env.testing.example .env

      - name: 🔑 Generate App Key
        run: php artisan key:generate

      - name: 💅 Check Code Style (Laravel Pint)
        run: ./vendor/bin/pint --test

      - name: 🕵️ Static Analysis (PHPStan)
        run: ./vendor/bin/phpstan analyse --memory-limit=2G

      - name: 🗄️ Run Database Migrations
        env:
          DB_CONNECTION: mysql
          DB_HOST: 127.0.0.1
          DB_PORT: 3306
          DB_DATABASE: testing_db
          DB_USERNAME: root
          DB_PASSWORD: ''
        run: php artisan migrate:fresh --seed

      - name: 🧪 Execute Automated Tests (Pest Parallel)
        env:
          DB_CONNECTION: mysql
          DB_HOST: 127.0.0.1
          DB_PORT: 3306
          DB_DATABASE: testing_db
          DB_USERNAME: root
          DB_PASSWORD: ''
          CACHE_DRIVER: redis
          QUEUE_CONNECTION: sync
        # Flag --parallel wajib untuk memangkas waktu tes
        # Flag --min=85 memastikan coverage minimal 85% untuk mergenya PR
        run: ./vendor/bin/pest --parallel --processes=4 --coverage --min=85
```

### B. GitLab CI (`.gitlab-ci.yml`)

Bagi tim yang menggunakan GitLab, ini adalah padanan *pipeline* teroptimasi dengan *caching* dan pembagian *stages*.

```yaml
image: php:8.3-cli

stages:
  - setup
  - lint
  - static_analysis
  - test

variables:
  MYSQL_DATABASE: testing_db
  MYSQL_ALLOW_EMPTY_PASSWORD: "yes"
  DB_CONNECTION: mysql
  DB_HOST: mysql
  DB_PORT: 3306
  DB_USERNAME: root
  DB_PASSWORD: ""
  CACHE_DRIVER: redis
  REDIS_HOST: redis

cache:
  key:
    files:
      - composer.lock
  paths:
    - vendor/

services:
  - name: mysql:8.0
    alias: mysql
  - name: redis:7.0-alpine
    alias: redis

setup:
  stage: setup
  script:
    - apt-get update && apt-get install -y libzip-dev zip unzip default-mysql-client
    - docker-php-ext-install pdo_mysql zip pcntl
    - curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
    - composer install --prefer-dist --no-interaction --no-progress
    - cp .env.testing.example .env
    - php artisan key:generate

lint_code:
  stage: lint
  needs: ["setup"]
  script:
    - ./vendor/bin/pint --test

phpstan:
  stage: static_analysis
  needs: ["setup"]
  script:
    - ./vendor/bin/phpstan analyse --memory-limit=2G

pest_tests:
  stage: test
  needs: ["setup", "lint_code", "phpstan"]
  script:
    # Coverage requires PCOV or XDebug to be installed on the PHP image
    - pecl install pcov && docker-php-ext-enable pcov
    - php artisan migrate:fresh --env=testing
    - ./vendor/bin/pest --parallel --processes=4 --coverage --min=85
  artifacts:
    when: always
    reports:
      junit: report.xml
      coverage_report:
        coverage_format: cobertura
        path: coverage/cobertura-coverage.xml
```

---

## 5. Kaidah Tambahan (Best Practices)

1.  **DILARANG `env()` di luar Config:**
    Dalam pengujian, Laravel me-load cache konfigurasi. Pemanggilan `env('API_KEY')` di dalam Action atau Controller akan mengembalikan `null`. Selalu gunakan `config('services.api.key')`. Ini bisa diverifikasi menggunakan Pest Arch.
2.  **Gunakan FormFactory / Seeder Secara Ekstensif:**
    Membuat objek Model dengan array `create()` manual mengurangi kejelasan. Gunakan `User::factory()->hasWallets(1)->create()` sebagai metode standar inisialisasi state di Feature Test.
3.  **Terapkan Data Providers (Pest `with()`):**
    Untuk menguji kombinasi input form yang gagal, hindari duplikasi blok `it()`. Gunakan *Dataset / Data Provider* yang disediakan Pest menggunakan metode `->with()`.
4.  **Enforce Coverage Requirements Secara Bertahap:**
    Jika mengadopsi testing di *legacy app*, atur Pest flag `--min=30`. Tingkatkan angka `--min` 5% setiap sprint hingga mencapai target ideal (80%-95% untuk *business critical code*).
