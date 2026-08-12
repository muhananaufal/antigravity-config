# Engineering Metrics & Code Quality Tracking in Laravel

## 1. Pendahuluan Metrik Kualitas Kode

Pengembangan perangkat lunak tanpa metrik yang terukur ibarat menerbangkan pesawat tanpa instrumen. Pada ekosistem Laravel modern (v11/12) dan PHP 8.3/8.4, rekayasa perangkat lunak bergantung pada analitik presisi: tingkat kompleksitas kode, analisis statis mendalam, dan cakupan pengujian (Code Coverage). 

Dokumen ini menetapkan standar wajib (Top 1% Quality) yang mencakup:
- **Static Analysis**: Kepatuhan PHPStan Level 9 secara mutlak.
- **Cyclomatic Complexity**: Standar kompleksitas fungsi maksimal 10.
- **Code Coverage**: Minimal 85% cakupan untuk Test coverage, 100% pada Critical Paths (Keuangan/Auth).
- **Code Style**: Otomatisasi dengan Laravel Pint.

### `declare(strict_types=1);`
Kesalahan tipe data dapat menghancurkan aplikasi. Secara global, kita harus menegakkan standar strict typing.

---

## 2. Parameter Metrik & Tools

### 2.1 PHPStan (Static Analysis)
PHPStan akan memeriksa kode tanpa menjalankannya untuk menemukan potensi bug tipe. Di Level 9 (Level Tertinggi), ia memaksa setiap tipe data dideklarasikan dengan tegas, tidak ada pengecualian untuk array tanpa tipe generik atau `mixed`.

**Konfigurasi Wajib `phpstan.neon`**:
```neon
includes:
    - vendor/larastan/larastan/extension.neon

parameters:
    level: 9
    paths:
        - app/
        - tests/
    checkMissingIterableValueType: true
    checkGenericClassInNonGenericObjectType: true
    treatPhpDocTypesAsCertain: false
```

### 2.2 Laravel Pint (Code Styling)
Code format harus terstandarisasi. Kita tidak mendebatkan letak kurung kurawal.

**Konfigurasi `pint.json`**:
```json
{
    "preset": "laravel",
    "rules": {
        "declare_strict_types": true,
        "strict_param": true,
        "array_push": true,
        "modernize_types_casting": true,
        "no_useless_else": true,
        "no_useless_return": true,
        "logical_operators": true
    }
}
```

### 2.3 Code Coverage (Pest v3)
Cakupan tes memastikan bahwa persentase logika yang terverifikasi berada di atas batas aman. Kita menggunakan fitur coverage built-in dari Pest.

---

## 3. Anti-Patterns & Best Practices

### 3.1. Anti-Pattern: Mengabaikan Static Analysis (Penggunaan `mixed`)

❌ **KODE SALAH (Blind Types & Mixed)**
```php
<?php

namespace App\Services;

class PaymentService
{
    // Masalah 1: Tidak ada return type
    // Masalah 2: Parameter array tidak diketahui isinya
    // Masalah 3: Menggunakan mixed
    public function processPayment(array $data, $gateway)
    {
        $amount = $data['amount'] ?? 0;
        
        if ($gateway === 'stripe') {
            return $this->stripe($amount);
        }
        
        return false;
    }
    
    private function stripe($amount)
    {
        // ...
        return ["status" => "success"];
    }
}
```
**Mengapa Berbahaya?**
- **Security & Bug Risk**: Jika `$data['amount']` ternyata berupa string '1000' dan dikirim ke gateway, bisa menyebabkan fatal error runtime atau manipulasi nominal.
- **Maintenance Nightmare**: Array shape tidak diketahui. Engineer yang meneruskan kode ini harus menggunakan `dd()` untuk tahu apa isi `$data`. PHPStan Level 9 akan menolak keras kode ini.

✅ **KODE BENAR (Strict Types & DTOs)**
```php
<?php

declare(strict_types=1);

namespace App\Services;

use App\DTOs\Payment\PaymentRequestDTO;
use App\Enums\PaymentGateway;
use App\Responses\Payment\PaymentResult;

final class PaymentService
{
    /**
     * Memproses pembayaran secara type-safe.
     */
    public function processPayment(PaymentRequestDTO $dto, PaymentGateway $gateway): PaymentResult
    {
        return match ($gateway) {
            PaymentGateway::STRIPE => $this->processStripe($dto->amountInCents),
            PaymentGateway::PAYPAL => $this->processPaypal($dto->amountInCents),
        };
    }
    
    private function processStripe(int $amountInCents): PaymentResult
    {
        // Proses Stripe Integrasi
        return new PaymentResult(success: true, transactionId: 'txn_123');
    }

    private function processPaypal(int $amountInCents): PaymentResult
    {
        // Proses Paypal Integrasi
        return new PaymentResult(success: false, transactionId: null);
    }
}
```

### 3.2. Anti-Pattern: High Cyclomatic Complexity (If-Else Bersarang)

❌ **KODE SALAH (Arrow Code / Deep Nesting)**
```php
<?php

namespace App\Actions;

class CalculateDiscountAction
{
    public function calculate($user, $cart)
    {
        $discount = 0;
        
        if ($user != null) {
            if ($user->isActive()) {
                if ($cart->total > 1000) {
                    if ($user->type == 'vip') {
                        $discount = 20;
                    } else {
                        $discount = 10;
                    }
                } else {
                    $discount = 5;
                }
            }
        }
        
        return $discount;
    }
}
```
**Mengapa Berbahaya?**
- **Mental Load**: Cyclomatic complexity sangat tinggi (Banyak cabang bersarang). Semakin tinggi kompleksitas, semakin tinggi kemungkinan bug.
- **Testing Nightmare**: Menguji semua jalur (paths) membutuhkan sangat banyak skenario test. Metrik kode akan mengkategorikan fungsi ini sebagai berisiko tinggi.

✅ **KODE BENAR (Early Return & Guard Clauses)**
```php
<?php

declare(strict_types=1);

namespace App\Actions;

use App\Models\User;
use App\Models\Cart;

final readonly class CalculateDiscountAction
{
    public function execute(?User $user, Cart $cart): int
    {
        // Guard clauses
        if ($user === null || !$user->isActive()) {
            return 0;
        }

        if ($cart->total <= 1000) {
            return 5;
        }

        // Return berdasarkan match atau if
        return $user->type === 'vip' ? 20 : 10;
    }
}
```

---

## 4. Testing dan Enforcement dengan Pest v3

Dalam ekosistem Pest, kita tidak hanya menguji logika, tapi kita bisa menguji cakupan dan arsitektur sebagai bagian dari metrik CI/CD.

### 4.1. Memeriksa Code Coverage dengan Pest
Perintah eksekusi di CI/CD:
```bash
./vendor/bin/pest --coverage --min=85
```
Pest akan menghentikan pipeline CI (Exit code 1) jika coverage turun di bawah 85%.

### 4.2. Pest v3 Type Coverage Test (`tests/ArchTest.php`)
Pastikan setiap fungsi memiliki return type.

```php
<?php

declare(strict_types=1);

arch('all source files are strictly typed')
    ->expect('App')
    ->toUseStrictTypes();

arch('all methods must have return types')
    ->expect('App\Services')
    ->toHaveReturnTypes();

arch('all interfaces must be placed in Contracts directory')
    ->expect('App\Repositories')
    ->interfaces()
    ->toBeIn('App\Repositories\Contracts');
```

### 4.3. Unit Test untuk Guard Clauses (`tests/Unit/Actions/CalculateDiscountActionTest.php`)
Memastikan Code Coverage 100% untuk `CalculateDiscountAction`.

```php
<?php

declare(strict_types=1);

use App\Actions\CalculateDiscountAction;
use App\Models\User;
use App\Models\Cart;

uses()->group('metrics', 'actions');

it('returns 0 if user is null', function () {
    // Arrange
    $action = new CalculateDiscountAction();
    $cart = new Cart();
    $cart->total = 2000;

    // Act
    $discount = $action->execute(null, $cart);

    // Assert
    expect($discount)->toBe(0);
});

it('returns 0 if user is not active', function () {
    $user = Mockery::mock(User::class);
    $user->shouldReceive('isActive')->andReturn(false);
    
    $action = new CalculateDiscountAction();
    $cart = new Cart();
    
    expect($action->execute($user, $cart))->toBe(0);
});

it('returns 5 if cart total is 1000 or less', function () {
    $user = Mockery::mock(User::class);
    $user->shouldReceive('isActive')->andReturn(true);
    $user->type = 'regular';
    
    $cart = new Cart();
    $cart->total = 1000;
    
    $action = new CalculateDiscountAction();
    
    expect($action->execute($user, $cart))->toBe(5);
});

it('returns 20 for vip users with cart total over 1000', function () {
    $user = Mockery::mock(User::class);
    $user->shouldReceive('isActive')->andReturn(true);
    $user->type = 'vip';
    
    $cart = new Cart();
    $cart->total = 1001;
    
    $action = new CalculateDiscountAction();
    
    expect($action->execute($user, $cart))->toBe(20);
});
```

## 5. Ringkasan Implementasi

1. **PHPStan**: Pastikan `phpstan analyze --level=9` lolos tanpa error.
2. **Pint**: Otomatisasi perbaikan strict types dan standar format.
3. **Pest Coverage**: Pertahankan limit >= 85%.
4. **Refactoring**: Kurangi IF Statements yang bersarang dengan Guard Clauses/Early Return.

Mengikuti metrik ini secara presisi menjamin base kode Laravel menjadi anti-rapuh dan dapat diskalakan untuk Enterprise.


---

## 5. Pest v3 Architectural & Metrics Verification Suite

`php
<?php

declare(strict_types=1);

use App\Services\EngineeringMetricsCalculator;
use App\ValueObjects\QualityThreshold;

uses()->group('quality-governance', 'metrics');

it('calculates cyclomatic complexity and enforces quality thresholds', function () {
     = new EngineeringMetricsCalculator();
     = ->analyzeDirectory(app_path('Services'));

    expect(->averageComplexity())->toBeLessThan(10.0)
        ->and(->hasViolations())->toBeFalse();
});

it('fails CI gate if code coverage drops below required SLA target', function () {
     = new EngineeringMetricsCalculator();
     = ->getCurrentCoveragePercentage();

    expect()->toBeGreaterThanOrEqual(85.0);
});

arch('all application services must strictly enforce level 9 typing and no debug statements')
    ->expect('App\\Services')
    ->toUseStrictTypes()
    ->not->toUse(['dd', 'dump', 'var_dump', 'ray', 'print_r'])
    ->toOnlyUse([
        'Illuminate\\Support',
        'Illuminate\\Contracts',
        'App\\Services',
        'App\\Repositories',
        'App\\Models',
    ]);
`


---

## 6. Gotchas & Production Hardening Nuances

### 6.1. High-Throughput Memory Leak & Connection Pool Gotchas
Pada lingkungan produksi dengan high throughput (seperti Swoole, FrankenPHP, atau Horizon workers dengan ribuan job per menit), perhatikan beberapa jebakan umum berikut:
1. **Request-Scoped State Leaks**: Variabel statis atau singleton instances yang menyimpan state request sebelumnya tidak dibersihkan secara otomatis. Selalu reset state pada event listener Illuminate\Foundation\Events\LocaleUpdated atau via config octane.flush.
2. **Database Idle Timeout & Disconnection**: Connection pool di Octane dapat terputus oleh database server jika idle lebih lama dari interactive_timeout. Pastikan DB::reconnect() dipanggil secara otomatis atau set pool.max_idle_time secara konservatif.
3. **Correlation ID Context Propagation**: Pastikan Log::withContext(['correlation_id' => ->header('X-Request-ID')]) dipropagasi ke seluruh asynchronous queue jobs menggunakan trait $middleware atau $jobContext.

### 6.2. Security Checklist & OWASP Validation
- **SQL Injection Prevention**: Gunakan Query Builder dengan parameter binding whereRaw('status = ?', []) alih-alih konkatenasi string.
- **CSRF & Rate Limiting Guard**: Selalu pasang 	hrottle:api middleware pada endpoint publik untuk mencegah Brute-Force & Denial of Service.
