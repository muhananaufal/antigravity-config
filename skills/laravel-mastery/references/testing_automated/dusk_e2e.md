---
title: "Top 1% Mastery: E2E Testing with Laravel Dusk & Pest v3"
description: "Panduan Definitif End-to-End Testing menggunakan Laravel Dusk, Pest v3, Page Objects, dan CI/CD Strategies"
---

# 🚀 Top 1% Mastery: End-to-End (E2E) Testing dengan Laravel Dusk & Pest v3

Dokumen ini adalah referensi komprehensif tingkat lanjut (Top 1% standar industri) untuk pengujian *End-to-End* menggunakan **Laravel Dusk** yang terintegrasi secara mulus dengan kerangka pengujian **Pest v3** di ekosistem **Laravel 11/12** dan **PHP 8.3+**. Membangun pengujian browser otomatis (*automated browser tests*) yang andal, cepat, tidak *flaky* (gagal tanpa alasan yang jelas), dan mudah di-maintain membutuhkan pemahaman arsitektur pengujian tingkat lanjut serta disiplin menulis kode yang ketat.

Di lingkungan *enterprise*, E2E test menjadi benteng pertahanan terakhir sebelum rilis produksi. Oleh karena itu, *test suite* harus menjamin bahwa alur bisnis kritis dapat dieksekusi dengan sempurna di kondisi dunia nyata (browser nyata, database nyata, interaksi nyata).

---

## 🌟 1. Fundamental Arsitektur Pengujian E2E

End-to-End (E2E) Testing dengan Laravel Dusk tidak berjalan pada isolasi tingkat rendah seperti *Unit Test*. E2E memvalidasi seluruh *stack* aplikasi: UI/UX (DOM), JavaScript, Layer HTTP, Controller, Middleware, Service/Action, Repository, Cache, hingga transaksi Database.

### Mengapa Laravel Dusk + Pest v3?

1. **Browser Control:** Dusk mengendalikan ChromeDriver (atau browser berbasis Selenium lainnya) langsung dari PHP.
2. **Pest v3 Elegance:** Sintaks Pest yang fungsional dan minimalis secara drastis mengurangi *boilerplate* *class-based* dari PHPUnit.
3. **Flaky Resistance:** Dusk memiliki sistem penungguan otomatis (*auto-wait*) dan metode asinkronus yang cerdas (`waitFor`, `waitUntilMissing`) untuk menangani aplikasi SPA/JavaScript modern seperti Inertia.js atau Livewire.

---

## 🛑 2. Anti-Patterns & Best Practices dalam E2E Testing

Menulis *test* yang buruk lebih berbahaya daripada tidak memiliki *test* sama sekali. *Flaky test* menghancurkan kepercayaan tim developer terhadap proses CI/CD. Berikut adalah perbandingan pola buruk dan pola tingkat lanjut (Top 1%).

### Anti-Pattern 1: Selector Kerapuhan Tinggi (High Fragility Selectors)

Mendasarkan pengujian pada *class CSS* yang berorientasi pada utilitas (seperti Tailwind CSS) atau hierarki DOM yang rumit adalah resep pasti menuju bencana pemeliharaan. Jika desain berubah, *test* akan rusak (meskipun fungsionalitasnya benar).

❌ **KODE SALAH (Berbahaya & Flaky)**
```php
<?php

declare(strict_types=1);

use Laravel\Dusk\Browser;

test('pengguna dapat menambahkan produk ke keranjang (BURUK)', function () {
    $this->browse(function (Browser $browser) {
        $browser->visit('/products/1')
                // BURUK: Bergantung pada class Tailwind, jika desainer mengubah warna, test gagal!
                ->click('.bg-blue-500.text-white.font-bold')
                // BURUK: Hardcode jeda waktu statis. Membuang waktu atau menyebabkan timeout.
                ->pause(2000)
                // BURUK: Bergantung pada elemen child yang dalam
                ->assertSeeIn('div > div:nth-child(2) > span', 'Added');
    });
});
```

✅ **KODE BENAR (Top 1% Quality)**
```php
<?php

declare(strict_types=1);

use Laravel\Dusk\Browser;

test('pengguna dapat menambahkan produk ke keranjang secara tangguh', function () {
    $this->browse(function (Browser $browser) {
        $browser->visit('/products/1')
                // BENAR: Menggunakan selector khusus untuk testing (Dusk selectors `dusk="..."`)
                // yang kebal terhadap perubahan desain UI/CSS.
                ->click('@add-to-cart-button')
                // BENAR: Menunggu kondisi spesifik secara asinkron tanpa memblokir thread secara statis.
                ->waitForTextIn('@cart-notification', 'Produk berhasil ditambahkan', 5)
                ->assertSeeIn('@cart-notification', 'Produk berhasil ditambahkan')
                ->assertSeeIn('@cart-counter', '1');
    });
});
```
**Penjelasan Trade-Off & Risiko:** 
Penggunaan class utility seperti `.bg-blue-500` berarti *test logic* terikat kuat dengan representasi visual. Praktik terbaik (*Best Practice*) menganjurkan penambahan atribut `dusk="add-to-cart-button"` pada elemen HTML. Ini memisahkan DOM struktur visual dengan *Test Hooks*. Penggunaan `waitForTextIn` mengatasi latensi jaringan (JavaScript/AJAX) tanpa risiko *memory leak* dari jeda statis menggunakan `sleep()` atau `pause()`, menjaga pipeline CI/CD berjalan sangat efisien.

### Anti-Pattern 2: Kebocoran Keadaan (State Leakage) antar Test E2E

Karena Laravel Dusk E2E berjalan di proses *browser* terpisah, metode standar `DatabaseTransactions` (yang me-*rollback* *database state* pasca *test*) tidak akan berfungsi jika aplikasi dan test runner tidak berbagi koneksi yang sama. Hal ini menyebabkan tes satu mencemari hasil tes lainnya.

❌ **KODE SALAH (Risiko Kebocoran Data)**
```php
<?php

declare(strict_types=1);

use App\Models\User;
use Laravel\Dusk\Browser;
use Illuminate\Foundation\Testing\DatabaseTransactions; // TIDAK BERFUNGSI UNTUK DUSK E2E!

uses(DatabaseTransactions::class);

test('pengguna admin dapat menghapus user (BURUK)', function () {
    $admin = User::factory()->create(['role' => 'admin']);
    $targetUser = User::factory()->create();

    $this->browse(function (Browser $browser) use ($admin, $targetUser) {
        $browser->loginAs($admin)
                ->visit('/users')
                ->click('.delete-user-'.$targetUser->id)
                ->assertSee('User deleted successfully');
    });
    
    // Test berikutnya akan GAGAL jika mengandalkan status database bersih,
    // karena DatabaseTransactions mem-*rollback* sesi PHPUnit, 
    // namun Dusk melakukan call HTTP ke server lokal terpisah yang menyimpan secara asli di DB.
});
```

✅ **KODE BENAR (Isolasi Lingkungan Ketat dengan DatabaseTruncation)**
```php
<?php

declare(strict_types=1);

use App\Models\User;
use Laravel\Dusk\Browser;
use Illuminate\Foundation\Testing\DatabaseTruncation;

// BENAR: Gunakan DatabaseTruncation pada Pest Test Case untuk Dusk.
uses(DatabaseTruncation::class)->in('Browser');

test('pengguna admin dapat menghapus user secara terisolasi', function () {
    $admin = User::factory()->create(['role' => 'admin']);
    $targetUser = User::factory()->create();

    $this->browse(function (Browser $browser) use ($admin, $targetUser) {
        $browser->loginAs($admin->id)
                ->visit('/users')
                ->waitFor('@delete-button-'.$targetUser->id, 5)
                ->click('@delete-button-'.$targetUser->id)
                ->waitForText('Pengguna berhasil dihapus', 5)
                ->assertSee('Pengguna berhasil dihapus')
                ->assertDontSeeIn('@user-list', $targetUser->email);
    });
    
    // Pest dan Laravel 11 akan memenggal (truncate) seluruh tabel secara efisien 
    // pada akhir request sehingga DB selalu siap untuk test selanjutnya.
});
```
**Penjelasan Trade-Off & Risiko:** 
Kesalahan paling fatal pemula di Laravel Dusk adalah menggunakan trait `RefreshDatabase` atau `DatabaseTransactions` dengan pengaturan env default, yang justru membuat *race conditions*. Proses web server yang diakses ChromeDriver adalah proses terpisah dari PHPUnit/Pest. Menggunakan `DatabaseTruncation` pada Laravel 11 jauh lebih aman secara memori dan konsistensi state karena ia hanya menghapus data dari tabel yang dimodifikasi, menjadikan database steril namun berkecepatan tinggi saat dibersihkan, mencegah *flaky test*.

---

## 🧩 3. Arsitektur Page Objects (Meningkatkan Skalabilitas)

Dalam *software engineering* tingkat lanjut, jangan pernah menduplikasi *test logic* di berbagai tempat. Jika desain rute login atau keranjang belanja berubah, Anda harus memperbarui puluhan baris *test*. **Page Objects** adalah pola arsitektur esensial untuk E2E.

Kita definisikan sebuah struktur Clean Architecture untuk Page Object. 

### Langkah 1: Definisikan Page Object (Login Page)

```php
<?php

declare(strict_types=1);

namespace Tests\Browser\Pages;

use Laravel\Dusk\Browser;
use Laravel\Dusk\Page;

final class LoginPage extends Page
{
    /**
     * Dapatkan path rute halaman.
     */
    public function url(): string
    {
        return '/login';
    }

    /**
     * Pastikan browser telah memuat halaman secara penuh.
     */
    public function assert(Browser $browser): void
    {
        $browser->assertPathIs($this->url())
                ->assertPresent('@login-form');
    }

    /**
     * Definisikan elemen macro untuk halaman ini.
     * Mengikat selector kompleks ke nama sederhana.
     *
     * @return array<string, string>
     */
    public function elements(): array
    {
        return [
            '@login-form'    => 'form[action="/login"]',
            '@email-input'   => 'input[name="email"]',
            '@password-input'=> 'input[name="password"]',
            '@submit-button' => 'button[type="submit"]',
        ];
    }

    /**
     * Custom tindakan yang membungkus logika halaman.
     */
    public function authenticate(Browser $browser, string $email, string $password): void
    {
        $browser->type('@email-input', $email)
                ->type('@password-input', $password)
                ->click('@submit-button');
    }
}
```

### Langkah 2: Menggunakan Page Object pada Pest v3

Dalam arsitektur Pest, hal ini memberikan pemisahan wewenang. File *test* berfokus pada asersi, Page Object berfokus pada interaksi DOM.

```php
<?php

declare(strict_types=1);

use App\Models\User;
use Laravel\Dusk\Browser;
use Tests\Browser\Pages\LoginPage;
use Tests\Browser\Pages\DashboardPage;

test('pengguna terdaftar dapat melakukan login dengan valid kredensial menggunakan page object', function () {
    $user = User::factory()->create([
        'email' => 'admin@top-tier-app.com',
        'password' => bcrypt('SecurePassword123!'),
    ]);

    $this->browse(function (Browser $browser) use ($user) {
        $browser->visit(new LoginPage())
                // Fungsi kustom dari Page Object
                ->authenticate($user->email, 'SecurePassword123!')
                // Validasi bahwa kita berhasil dialihkan ke halaman dashboard
                ->on(new DashboardPage())
                ->assertSee('Selamat Datang Kembali');
    });
})->group('auth', 'e2e');
```

---

## 🛠️ 4. Menghubungkan Backend Clean Architecture dengan E2E

Ketika membangun aplikasi, E2E bertugas memastikan *Action/Service*, *Repository*, dan *Model* saling mendukung hingga titik akhir ke interaksi pengguna. Berikut gambaran fungsional yang akan kita tes: FormRequest → Action → Model.

### Implementasi Sistem Backend (Payment Checkout)

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class ProcessPaymentRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'amount' => ['required', 'numeric', 'min:1000'],
            'payment_method' => ['required', 'string', 'in:credit_card,bank_transfer'],
            'idempotency_key' => ['required', 'string', 'uuid'],
        ];
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Actions\Payments;

use App\Models\Payment;
use Illuminate\Support\Facades\DB;
use App\Exceptions\PaymentProcessingException;
use Throwable;

final class ProcessSecurePaymentAction
{
    /**
     * Memproses pembayaran menggunakan sistem transaksional.
     * ZERO Placeholder. Penanganan Error Kelas Enterprise.
     */
    public function execute(float $amount, string $method, string $userId, string $idempotencyKey): Payment
    {
        // Mencegah double charging melalui idempotency
        $existing = Payment::where('idempotency_key', $idempotencyKey)->first();
        if ($existing !== null) {
            return $existing;
        }

        try {
            return DB::transaction(function () use ($amount, $method, $userId, $idempotencyKey) {
                // Mensimulasikan call API ke payment gateway pihak ketiga
                $gatewaySuccess = $this->callExternalGateway($amount, $method);
                
                if (!$gatewaySuccess) {
                    throw new PaymentProcessingException('Gateway ditolak secara internal.');
                }

                $payment = new Payment([
                    'user_id' => $userId,
                    'amount' => $amount,
                    'method' => $method,
                    'status' => 'settled',
                    'idempotency_key' => $idempotencyKey,
                ]);
                $payment->saveOrFail();
                
                return $payment;
            });
        } catch (Throwable $e) {
            // Logging Kegagalan dan melempar Exception terpusat
            report($e);
            throw new PaymentProcessingException('Pembayaran gagal diproses: ' . $e->getMessage(), 0, $e);
        }
    }

    private function callExternalGateway(float $amount, string $method): bool
    {
        // Di lingkungan nyata, ini memanggil cURL/HTTP Client
        return $amount > 0;
    }
}
```

### Eksekusi E2E Test (Memvalidasi Interaksi Web UI terhadap Sistem Tersebut)

```php
<?php

declare(strict_types=1);

use App\Models\User;
use Laravel\Dusk\Browser;
use Illuminate\Support\Str;

test('pengguna dapat memproses checkout secara atomik melalui antarmuka checkout', function () {
    $user = User::factory()->create();
    $idempotency = Str::uuid()->toString();

    $this->browse(function (Browser $browser) use ($user, $idempotency) {
        $browser->loginAs($user->id)
                ->visit('/checkout')
                ->waitFor('@checkout-form', 5)
                // Mengisi data form
                ->type('@amount-input', '500000')
                ->select('@payment-method-select', 'bank_transfer')
                // Menginjeksi key tersembunyi
                ->script("document.querySelector('[dusk=\"idempotency-input\"]').value = '{$idempotency}';");
                
        $browser->click('@pay-button')
                // Tunggu proses backend yang mungkin lambat (simulasi load)
                ->waitUntilMissing('@loading-spinner', 10)
                ->waitForText('Pembayaran Berhasil!', 5)
                ->assertSee('Pembayaran Berhasil!')
                ->assertPathIs('/checkout/success');
    });

    // Melakukan pengecekan asersi Database untuk sinkronisasi akhir
    $this->assertDatabaseHas('payments', [
        'user_id' => $user->id,
        'amount' => 500000,
        'status' => 'settled',
        'idempotency_key' => $idempotency,
    ]);
});
```

---

## 📐 5. Architecture & Arch Testing dengan Pest v3

Kualitas E2E juga bergantung pada kebersihan kerangka pengujian itu sendiri. Dalam ekosistem Top 1%, kita harus menjamin file arsitektur test *Dusk* tidak bocor ke dalam layer produksi atau unit test.

Pest menyediakan plugin `arch()` yang sangat *powerful*. 

```php
<?php

declare(strict_types=1);

// file: tests/ArchTest.php

test('halaman Dusk Page Objects wajib di extends dari abstract Page', function () {
    expect('Tests\Browser\Pages')
        ->toBeClasses()
        ->toExtend(Laravel\Dusk\Page::class)
        ->toHaveMethod('url')
        ->toHaveMethod('elements');
});

test('tidak ada logika model atau database langsung dalam kelas Dusk Test', function () {
    expect('Tests\Browser')
        ->not->toUse('Illuminate\Support\Facades\DB')
        ->not->toUse('App\Actions');
});

test('test E2E tidak memanggil HTTP Client secara langsung, menggunakan Browser interaction', function () {
    expect('Tests\Browser')
        ->not->toUse('Illuminate\Support\Facades\Http');
});

// Menjamin Strict Types di seluruh aplikasi
test('aplikasi wajib menggunakan deklarasi strict_types')
    ->expect('App')
    ->toUseStrictTypes();
```

---

## 🌐 6. Optimasi Pipeline CI/CD untuk Dusk (GitHub Actions)

*Flaky tests* dalam lingkungan *Continous Integration* (seperti GitHub Actions) 90% disebabkan oleh *race condition* sumber daya server (CPU/RAM limit, atau container startup lambat) serta kegagalan *Headless Chrome*.

Berikut konfigurasi wajib (`dusk.yml`) untuk tingkat keberhasilan tertinggi.

```yaml
name: Dusk E2E Tests

on:
  push:
    branches: [ "main", "develop" ]
  pull_request:

jobs:
  dusk-tests:
    runs-on: ubuntu-latest
    
    services:
      mysql:
        image: mysql:8.0
        env:
          MYSQL_ROOT_PASSWORD: password
          MYSQL_DATABASE: testing
        ports:
          - 3306:3306
        options: --health-cmd="mysqladmin ping" --health-interval=10s --health-timeout=5s --health-retries=3

    steps:
      - uses: actions/checkout@v4

      - name: Setup PHP
        uses: shivammathur/setup-php@v2
        with:
          php-version: '8.3'
          extensions: dom, curl, libxml, mbstring, zip, pcntl, pdo, sqlite, pdo_sqlite, bcmath, soap, intl, gd, exif, iconv, imagick, fileinfo, mysql
          coverage: none

      - name: Setup Node.js (Vite Asset compilation)
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install Composer Dependencies
        run: composer install --prefer-dist --no-interaction --no-progress --optimize-autoloader

      - name: Install NPM Dependencies & Build Assets
        run: |
          npm ci
          npm run build
          
      - name: Configure .env
        run: cp .env.testing.example .env.testing

      - name: Setup Database
        run: |
          php artisan key:generate --env=testing
          php artisan migrate:fresh --env=testing --seed

      - name: Install Chrome Driver for Dusk
        run: php artisan dusk:chrome-driver --detect

      - name: Start Built-in Web Server
        # WAJIB: Gunakan port konstan, background process '&', dan tunggu server siap
        run: |
          php artisan serve --env=testing --host=127.0.0.1 --port=8000 &
          sleep 3
        
      - name: Run Dusk Test Suite (Pest)
        env:
          APP_URL: "http://127.0.0.1:8000"
        # Menjalankan grup E2E
        run: php artisan test --group=e2e
        
      - name: Upload Dusk Screenshots / Console Logs on Failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: dusk-failure-artifacts
          path: |
            tests/Browser/screenshots/
            tests/Browser/console/
```

### Tips Penanganan Layar Headless
Secara default, di dalam `tests/DuskTestCase.php`, pastikan kapabilitas driver Anda sudah disetel untuk ukuran viewport konsisten agar elemen responsif tidak bersembunyi (misalnya menu *hamburger* versi mobile).

```php
<?php

declare(strict_types=1);

namespace Tests;

use Facebook\WebDriver\Chrome\ChromeOptions;
use Facebook\WebDriver\Remote\DesiredCapabilities;
use Facebook\WebDriver\Remote\RemoteWebDriver;
use Laravel\Dusk\TestCase as BaseTestCase;

abstract class DuskTestCase extends BaseTestCase
{
    /**
     * Prepare the environment before running tests.
     */
    public static function prepare(): void
    {
        if (! static::runningInSail()) {
            static::startChromeDriver();
        }
    }

    /**
     * Create the RemoteWebDriver instance.
     */
    protected function driver(): RemoteWebDriver
    {
        $options = (new ChromeOptions)->addArguments(array_filter([
            $this->shouldStartMaximized() ? '--start-maximized' : '--window-size=1920,1080',
            '--disable-search-engine-choice-screen',
            '--headless=new', // Wajib menggunakan 'new' di versi Chrome terbaru
            '--disable-gpu',
            '--no-sandbox',
            '--disable-dev-shm-usage', // Kritis di CI/CD untuk menghindari crash memori
        ]));

        return RemoteWebDriver::create(
            $_ENV['DUSK_DRIVER_URL'] ?? 'http://localhost:9515',
            DesiredCapabilities::chrome()->setCapability(ChromeOptions::CAPABILITY, $options)
        );
    }
}
```

Dengan mengadopsi standar Top 1% di atas, tim Anda akan memastikan kualitas kode E2E yang berkinerja tinggi, aman, anti-flaky, serta menyatu kuat secara fungsional melalui struktur fungsional **Pest v3**.
