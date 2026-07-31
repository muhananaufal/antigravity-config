# Laravel Pennant: Enterprise Feature Flagging & Rollout Management

## 1. Konsep Dasar & Paradigma Feature Flagging

Feature flagging (atau feature toggles) bukan sekadar `if ($condition)` sederhana, melainkan pola desain arsitektural yang memungkinkan pengembang memodifikasi perilaku sistem saat runtime tanpa deployment ulang kode. Di sistem modern dengan continuous deployment (CI/CD), feature flag memungkinkan tim untuk:
- Melakukan deployment kode ke production tanpa langsung merilis fitur ke end-user (Decoupling Deploy & Release).
- Melakukan A/B testing secara masif untuk memvalidasi hipotesis bisnis.
- Menjalankan Canary releases (gradual rollout) untuk meminimalisir risiko kegagalan sistem.
- Mengelola limitasi akses berbasis role, tier subscription, atau entitas multi-tenant.

Laravel Pennant membakukan pola ini sebagai first-party package dengan menyediakan API terpusat, memori caching internal yang sangat efisien untuk menghindari *N+1 query*, serta driver persisten (database) dan non-persisten (array). 

Di era PHP 8.3/8.4 dan Laravel 11/12, penggunaan Pennant dituntut untuk *fully type-safe*, terhindar dari *magic strings*, dan terintegrasi mulus dengan prinsip Clean Architecture.

### Arsitektur Driver Pennant
1. **Array Driver**: Digunakan untuk testing dan lingkungan development lokal tanpa kebutuhan persistensi lintas-request. State akan reset setiap request HTTP selesai.
2. **Database Driver**: Default untuk environment production. Menyimpan state (status, scope) fitur per entitas di tabel `features`.
3. **Custom Driver**: Memungkinkan integrasi dengan layanan eksternal atau memori in-memory mutakhir (seperti Redis terpusat atau API LaunchDarkly untuk arsitektur microservices).

---

## 2. Kelas Fitur (Class-Based Features) vs Closure

Pendekatan Closure (menggunakan `Feature::define('nama', fn() => ... )`) dalam `AppServiceProvider` sah secara teknis, tetapi berisiko besar membengkakkan ukuran Provider dan menghilangkan kepastian *type-safety*.
Standard Top 1% mewajibkan penggunaan **Class-Based Features** untuk memenuhi Single Responsibility Principle (SRP) dan mempermudah auto-completion serta *statical analysis* (PHPStan/Rector).

### Contoh Implementasi Class-Based Feature yang Benar

```php
<?php

declare(strict_types=1);

namespace App\Features;

use App\Models\User;
use Illuminate\Support\Lottery;

final readonly class NewPaymentGateway
{
    /**
     * Tentukan resolusi default dari fitur ini.
     * Dapat menggunakan kelas Lottery untuk menentukan persentase rollout secara acak (contoh: 20% populasi).
     */
    public function resolve(User $user): mixed
    {
        // Guard Clause 1: Pengecualian mutlak, entitas super-admin selalu mendapat akses.
        if ($user->is_super_admin) {
            return true;
        }

        // Guard Clause 2: Segmentasi khusus, hanya berlaku untuk user berlangganan premium.
        if (! $user->hasActiveSubscription()) {
            return false;
        }

        // Rollout acak 20% dari populasi yang lolos tahap di atas.
        return Lottery::odds(1, 5)->choose();
    }
}
```

---

## 3. Integrasi Clean Architecture (Controller -> Action -> Provider)

Dalam Clean Architecture, Feature Flags dilarang keras meracuni domain layer atau berserakan di layer penyajian (Blade views atau SPA API responses) tanpa struktur. 
1. Gunakan Middleware untuk membatasi akses endpoint secara menyeluruh.
2. Injeksikan logika pemilihan layanan di level Action/Service, atau gunakan pola Factory yang bergantung pada State dari Pennant.

### Controller, Request, dan Action (Pola Bersih & Valid)

**1. Form Request**
```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class ProcessPaymentRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // Autorisasi gatekeeping HTTP diserahkan ke middleware atau Policy, bukan request validation
    }

    /**
     * @return array<string, \Illuminate\Contracts\Validation\ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'amount' => ['required', 'numeric', 'min:10.00'],
            'currency' => ['required', 'string', 'size:3'],
        ];
    }
}
```

**2. Domain Action / Service Class**
```php
<?php

declare(strict_types=1);

namespace App\Services;

use App\Features\NewPaymentGateway;
use App\Models\User;
use App\Contracts\PaymentGatewayInterface;
use Laravel\Pennant\Feature;

final readonly class PaymentProcessingAction
{
    public function __construct(
        private PaymentGatewayInterface $legacyGateway,
        private PaymentGatewayInterface $newGateway,
    ) {}

    public function execute(User $user, float $amount, string $currency): string
    {
        // Injeksi logic berdasarkan resolusi feature flag
        $gateway = Feature::active(NewPaymentGateway::class)
            ? $this->newGateway
            : $this->legacyGateway;

        return $gateway->charge($user, $amount, $currency);
    }
}
```

**3. Controller API**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Requests\ProcessPaymentRequest;
use App\Services\PaymentProcessingAction;
use Illuminate\Http\JsonResponse;

final class PaymentController
{
    public function store(
        ProcessPaymentRequest $request,
        PaymentProcessingAction $action
    ): JsonResponse {
        $transactionId = $action->execute(
            user: $request->user(),
            amount: (float) $request->validated('amount'),
            currency: $request->validated('currency')
        );

        return response()->json([
            'message' => 'Payment processed successfully',
            'data' => ['transaction_id' => $transactionId],
        ], 201);
    }
}
```

---

## 4. Anti-Patterns Spesifik & Solusi Puncak (Top 1%)

### Anti-Pattern 1: Hardcoding Magic Strings dan Penyebaran Logika Fitur
❌ **KODE SALAH**: Mendefinisikan dan memanggil fitur menggunakan string biasa di banyak titik dalam codebase.
```php
<?php
// Di dalam controller atau view
use Laravel\Pennant\Feature;

if (Feature::active('new-api-v2')) {
    // Jalankan logika v2
}
```
**Mengapa Berbahaya (Maintenance Risk)**:
Menggunakan magic strings tidak aman dari typo. Jika nama fitur perlu diganti/dicabut, Anda harus melakukan *global search-and-replace* yang rentan menimbulkan *silent bugs*. Tidak ada auto-completion dari IDE (PHPStorm/VSCode), dan definisi logika tersebar di berbagai layer, melanggar DRY (Don't Repeat Yourself).

✅ **KODE BENAR**: Menggunakan *Class-Based Features* sebagai Single Source of Truth (SSOT).
```php
<?php
declare(strict_types=1);

// Pengecekan di seluruh aplikasi harus menggunakan class referensi penuh FQCN
if (Feature::active(NewPaymentApiV2::class)) {
    // Jalankan logika baru
}
```
**Kelebihan**: Menjamin *type-safety*, mempermudah refactoring (IDE akan tahu ke mana class digunakan), dan semua algoritma "syarat fitur" terenkapsulasi secara aman.

---

### Anti-Pattern 2: N+1 Database Query pada Iterasi Koleksi (Memory Exhaustion)
❌ **KODE SALAH**: Mengecek fitur di dalam loop tanpa *eager loading*.
```php
<?php
// Di dalam Command atau Job yang memproses batch data
$users = User::all();

foreach ($users as $user) {
    // FATAL: Menghasilkan query terpisah (SELECT * FROM features WHERE scope = 'User|X') untuk setiap user
    if (Feature::for($user)->active(BetaDashboardAccess::class)) {
        // Kirim notifikasi email rilis beta
    }
}
```
**Mengapa Berbahaya (Performance Risk)**:
Jika terdapat 10.000 user, baris tersebut akan mengeksekusi 10.000 *queries* database secara sekuensial (N+1 Problem). Ini akan membebani database connection pool, menyebabkan perlambatan masif atau crash total (Memory Limit Exceeded / DB Timeout).

✅ **KODE BENAR**: Memanfaatkan kapabilitas *Eager Loading* bawaan `Feature::load()`.
```php
<?php
declare(strict_types=1);

use Laravel\Pennant\Feature;
use App\Features\BetaDashboardAccess;

// Ambil model (gunakan chunking atau pagination untuk dataset skala enterprise)
$users = User::where('is_active', true)->limit(1000)->get();

// Load state fitur secara massal untuk semua model dalam 1 query saja
Feature::for($users)->load(BetaDashboardAccess::class);

foreach ($users as $user) {
    // Cek O(1) di RAM secara langsung, 0 hitungan DB query.
    if (Feature::for($user)->active(BetaDashboardAccess::class)) {
        // Proses logic bisnis
    }
}
```

---

### Anti-Pattern 3: Penggunaan Real Database untuk Pengujian Fitur
❌ **KODE SALAH**: Membiarkan Pennant memodifikasi tabel database asli saat unit test.
```php
// Test File
test('payment uses new gateway', function () {
    // FATAL: Mengubah state di tabel database 'features' secara persisten!
    Feature::activateForEveryone(NewPaymentGateway::class); 
    // ...
});
```
**Mengapa Berbahaya (Test Pollution Risk)**:
State database bisa persisten antara satu test dan test lainnya, membuat test suite menjadi lambat dan berpotensi memunculkan flakiness. Uji test ke-2 bisa jadi gagal tanpa alasan jelas karena test ke-1 tidak mereset state dari `NewPaymentGateway`.

✅ **KODE BENAR**: Menggunakan *testing fakes* untuk mengisolasi state ke memory.
```php
// Test File (Pest / PHPUnit)
test('payment uses new gateway', function () {
    Feature::fake(); // Mencegah akses ke DB asli, memori digantikan array in-memory
    Feature::activateForEveryone(NewPaymentGateway::class);
    // ... jalankan test suite
}); // Memori ter-reset aman setelah fungsi selesai.
```

---

### Anti-Pattern 4: Menyimpan State Fitur Sementara sebagai Kolom Database User
❌ **KODE SALAH**: Menambahkan metadata sementara / hasil A/B test sebagai schema fisik database table.
```php
<?php
Schema::table('users', function (Blueprint $table) {
    // KOTOR: Menambahkan kolom spesifik fitur eksklusif
    $table->boolean('has_beta_dashboard')->default(false);
});

// Pengecekan di logic:
if ($user->has_beta_dashboard) { ... }
```
**Mengapa Berbahaya (Schema Rigidness)**:
Semakin banyak fitur yang dicoba (A/B testing, eksperimen), semakin bengkak jumlah kolom di dalam database tabel `users`. Ini melanggar Open-Closed Principle (OCP). Setelah fitur A/B dihentikan, kolom ini akan tertinggal menjadi sampah abadi (Technical Debt) kecuali developer berani me-rollback skema migration di production.

✅ **KODE BENAR**: Mendelegasikan 100% manajemen state ke driver Pennant (yang menyimpan state serialisasi otomatis di tabel `features` generik miliknya).
```php
<?php
// Tanpa menyentuh skema 'users', manfaatkan tabel polymorfik Pennant:
if (Feature::for($user)->active(BetaDashboardAccess::class)) { ... }
```
Ini sangat bersih. Saat eksperimen selesai, developer hanya perlu menghapus class `BetaDashboardAccess.php` dan menjalankan `php artisan pennant:purge` untuk membersihkan rekaman di tabel Pennant.

---

## 5. Middleware Integrasi Otomatis HTTP

Laravel Pennant mempermudah limitasi akses API atau rute web dengan Middleware bawaan. Gunakan middleware ini pada `Route` untuk mencegat request apabila flag dinonaktifkan.

```php
<?php

declare(strict_types=1);

use App\Features\NewPaymentGateway;
use App\Http\Controllers\PaymentController;
use Illuminate\Support\Facades\Route;
use Laravel\Pennant\Middleware\EnsureFeaturesAreActive;

// Di dalam routes/api.php
Route::post('/payments', [PaymentController::class, 'store'])
    ->middleware(EnsureFeaturesAreActive::class.':'.NewPaymentGateway::class);
```

Untuk mengubah JSON response default saat akses ditolak (400 Bad Request), konfigurasi exception handler atau response custom di dalam `AppServiceProvider::boot()`:

```php
<?php
use Laravel\Pennant\Middleware\EnsureFeaturesAreActive;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;

EnsureFeaturesAreActive::whenInactive(function (Request $request, array $features): JsonResponse {
    return response()->json([
        'error' => 'Akses ditolak: Rute ini membutuhkan partisipasi dalam fase beta eksperimental.',
        'missing_features' => $features,
    ], 403);
});
```

---

## 6. Uji Mutakhir Pest v3 (Architecture & Unit Testing)

Keunggulan Clean Architecture baru terbukti nyata jika kode tersebut dilingkupi pengujian menyeluruh (High Coverage). Pastikan integrasi trait `actingAs` dikombinasikan sempurna bersama isolasi `Feature::fake()`.

```php
<?php

declare(strict_types=1);

use App\Features\NewPaymentGateway;
use App\Models\User;
use Laravel\Pennant\Feature;
use function Pest\Laravel\actingAs;
use function Pest\Laravel\postJson;

// 1. Architecture Test: Validasi bahwa Feature Flagging
// tidak tereksekusi tanpa kontrol atau hardcoded.
arch('pennant uses only class-based architecture')
    ->expect('Laravel\Pennant\Feature')
    ->not->toBeUsed()
    ->ignoring([
        'App\Services',       // Valid: Logic penentuan domain
        'App\Http\Middleware',// Valid: Route restriction
        'App\Providers',      // Valid: Resolusi behavior
    ]);

describe('Payment Gateway Feature Toggle Tests', function () {
    
    beforeEach(function () {
        // Persiapan di setiap test: isolasi state Feature DB
        Feature::fake();
    });

    it('routes through the V2 New Gateway when feature is explicitly active', function () {
        // Arrange
        $user = User::factory()->create(['is_super_admin' => true]);
        
        // Memaksa flag on secara spesifik di memory state testing,
        // meskipun logic asli is_super_admin mungkin diubah nantinya.
        Feature::for($user)->activate(NewPaymentGateway::class);
        actingAs($user);
        
        // Act
        $response = postJson('/api/payments', [
            'amount' => 150.00,
            'currency' => 'USD',
        ]);
        
        // Assert
        $response->assertStatus(201)
                 ->assertJsonPath('message', 'Payment processed successfully');
                 
        // Mock Assertion dapat dilakukan di sini untuk memastikan "V2 API dipanggil"
    });

    it('falls back to Legacy Gateway gracefully when feature is deactivated', function () {
        // Arrange
        $user = User::factory()->create(['is_super_admin' => false]);
        
        // Menonaktifkan eksperimen secara manual bagi aktor ini
        Feature::for($user)->deactivate(NewPaymentGateway::class);
        actingAs($user);
        
        // Act
        $response = postJson('/api/payments', [
            'amount' => 50.00,
            'currency' => 'EUR',
        ]);
        
        // Assert
        $response->assertStatus(201);
    });
});
```

---

## 7. Lanjutan: Rich Feature Values (Nilai Non-Boolean)

Pennant tak selamanya terbatas pada operasi *on/off* Boolean. Anda dapat mereturn *string*, konfigurasi *array*, bahkan nilai Enum! Fitur ini luar biasa berguna bagi A/B testing desain UI kompleks, di mana ada lebih dari dua variasi (misalnya: varian 'merah', 'biru', 'hijau').

```php
<?php

declare(strict_types=1);

namespace App\Features;

use App\Models\User;
use Illuminate\Support\Lottery;

final readonly class DashboardLayoutExperiment
{
    /**
     * Resolve string pengidentifikasi desain UI
     */
    public function resolve(User $user): string
    {
        return match (true) {
            $user->is_developer => 'variant-omega',
            default => Lottery::odds(1, 3)->choose('variant-beta', 'variant-alpha') // Jika kalah lottery, fallback alpha
        };
    }
}
```

Implementasinya dalam level controller/service menjadi sangat ekspresif:

```php
<?php
$layoutVariant = Feature::value(DashboardLayoutExperiment::class);

return match ($layoutVariant) {
    'variant-omega' => inertia('Dashboard/Omega'),
    'variant-beta'  => inertia('Dashboard/Beta'),
    default         => inertia('Dashboard/Alpha'),
};
```

---

## 8. Persistensi RAM, Konsistensi Antar-Sesi, dan Housekeeping

### Konsistensi User Experience (Anti-Flapping)
Apabila sebuah feature dieksekusi dengan fungsi acak (seperti `Lottery::odds()`), maka user bisa saja mendapat hasil *true* saat load page hari ini. Jika besok dia me-reload page, apakah *Lottery* dipanggil ulang dan hasilnya bisa *false*? 
**Tidak.** 
Pennant mengunci dan mem-persist hasil eksekusi pertama dari method `resolve()` (beserta seluruh cabangnya) ke *driver* yang dikonfigurasi (database). Konsekuensinya, pengalaman user 100% konsisten (tidak *flapping* UI).

### Housekeeping Command (Pembersihan)
Menumpuk eksperimen tanpa batas adalah indikasi manajemen teknis yang buruk. Setiap perilisan yang selesai (sudah dirilis global), class fiturnya harus dihapus dari sistem.
Untuk membersihkan data metadatanya di database production, gunakan Command Purge:
```bash
# Menghapus spesifik metadata class tertentu
php artisan pennant:purge App\Features\DashboardLayoutExperiment

# Membersihkan (Truncate) semua catatan eksperimen tanpa ampun (misal di staging)
php artisan pennant:purge
```

---

## 9. Ekstensi Custom Driver (Integrasi Redis In-Memory Berkecepatan Tinggi)

Bila performa membaca RDBMS untuk mem-fetch array data metadata feature-state menjadi leher botol (bottleneck), Laravel Pennant sangat siap dialihkan ke Redis.

```php
<?php

declare(strict_types=1);

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use Laravel\Pennant\Feature;
use App\Pennant\Drivers\RedisFeatureDriver;

final class AppServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        // 1. Daftarkan custom memory store / driver redis
        Feature::extend('redis-enterprise', function () {
            return new RedisFeatureDriver(
                app('redis')->connection('features')
            );
        });
    }
}
```
Cukup atur *env variable* `PENNANT_STORE=redis-enterprise` dan seluruh fungsionalitas A/B testing enterprise akan berpindah dari *Disk IO* (MySQL/PostgreSQL) ke *In-Memory IO* seketika.

## Kesimpulan Parameter Keberhasilan Top 1%

Standard Top 1% di Laravel Pennant didefinisikan oleh konsistensi penuh di empat area:
1. **O(1) Data Loading** via Eager Loading `Feature::for()->load()` pada iterasi array masif.
2. **Absolute Typing** via penyebutan *Fully Qualified Class Names* ketimbang string `Feature::active('string-nama')`.
3. **Penyapuan State Housekeeping** berkala via implementasi CI/CD untuk running `pennant:purge`.
4. **Resistensi 100% Test Pollution** via pemanggilan wajib `Feature::fake()` dalam block `beforeEach` Pest Test Suite.
