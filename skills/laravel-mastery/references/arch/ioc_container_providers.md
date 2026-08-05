# IoC Container & Service Providers (Top 1% Architecture)

## 1. Fundamental Law & Mechanical Sympathy

Dalam arsitektur *enterprise* Laravel, **Inversion of Control (IoC) Container** bukanlah sekadar tempat mendaftarkan kelas; ia adalah mesin resolusi graf dependensi (*dependency resolution engine*) yang bertugas mengelola siklus hidup memori (*memory lifecycle*), abstraksi antarmuka (*interface abstraction*), dan instansiasi *lazy-loaded*. 

Secara mekanik (*Mechanical Sympathy*), Container Laravel memanfaatkan **PHP Reflection API** (`ReflectionClass`) untuk membaca tipe parameter (*type-hinting*) pada konstruktor suatu kelas secara *runtime*, kemudian secara rekursif memecahkan graf dependensi tersebut. Operasi ini cukup membebani CPU jika dilakukan untuk ribuan kelas pada setiap *request*. Oleh karena itu, arsitektur Top 1% sangat mengandalkan *Deferred Service Providers* dan *Singleton bindings* untuk memastikan resolusi hanya terjadi ketika *(dan hanya jika)* instans tersebut benar-benar dipanggil.

## 2. Top 1% Production Architecture

Arsitektur produksi tingkat tinggi selalu memisahkan *interface* dari *implementation* dan merajutnya menggunakan fitur tingkat lanjut Container seperti **Contextual Binding** dan **Deferred Providers**.

### 2.1 Contextual Binding untuk Polymorphism
Ketika aplikasi Anda membutuhkan dua implementasi berbeda dari satu *interface* yang sama (misalnya `StorageInterface`), Anda tidak boleh menggunakan *if-else* di dalam *controller*. Gunakan *Contextual Binding* untuk menginjeksi implementasi yang tepat berdasarkan kelas mana yang membutuhkannya.

```php
namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use App\Services\Storage\StorageInterface;
use App\Services\Storage\S3StorageAdapter;
use App\Services\Storage\LocalStorageAdapter;
use App\Http\Controllers\VideoProcessingController;
use App\Http\Controllers\InvoiceController;

class StorageServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->when(VideoProcessingController::class)
                  ->needs(StorageInterface::class)
                  ->give(S3StorageAdapter::class);

        $this->app->when(InvoiceController::class)
                  ->needs(StorageInterface::class)
                  ->give(LocalStorageAdapter::class);
    }
}
```

### 2.2 Deferred Service Providers
Untuk layanan berat (seperti koneksi ke ERP eksternal atau inisialisasi SDK pihak ketiga), *Service Provider* wajib diatur sebagai **Deferred**. Ini menjamin kode pendaftaran *(booting)* hanya dijalankan apabila *interface* tersebut benar-benar diminta melalui Container, menghemat puluhan milidetik pada *request* yang tidak membutuhkannya.

```php
namespace App\Providers;

use Illuminate\Contracts\Support\DeferrableProvider;
use Illuminate\Support\ServiceProvider;
use App\Services\Erp\ErpClientInterface;
use App\Services\Erp\SapErpClient;

class ErpIntegrationServiceProvider extends ServiceProvider implements DeferrableProvider
{
    public function register(): void
    {
        $this->app->singleton(ErpClientInterface::class, function ($app) {
            return new SapErpClient(config('services.sap.api_key'));
        });
    }

    /**
     * @return array<int, string>
     */
    public function provides(): array
    {
        return [ErpClientInterface::class];
    }
}
```

## 3. Failure & Edge-Case Anomaly Matrix

| Kelas Anomali | Gejala / Dampak Mutlak | Matriks Mitigasi (Top 1% Tactic) |
| :--- | :--- | :--- |
| **State Leakage (Singleton)** | Data dari HTTP *request* pertama bocor ke *request* kedua saat menggunakan Laravel Octane (Swoole). | JANGAN pernah menyimpan variabel spesifik pengguna (seperti ID atau *tenant*) di dalam kelas yang di-*bind* sebagai `singleton()`. Gunakan `bind()` atau *scoped instances* pada Octane (`$app->scoped()`). |
| **Circular Dependency** | PHP melempar `Maximum function nesting level of '256' reached` akibat Service A membutuhkan B, dan B membutuhkan A. | Ubah arsitektur. Ekstrak *shared logic* ke Service C, atau gunakan *setter injection* alih-alih *constructor injection* untuk salah satu dependensi, memutus rantai siklus. |
| **Uncached Reflection Overhead** | Lonjakan latensi 20-40ms saat aplikasi melakukan *booting* ratusan dependensi. | Eksekusi `php artisan optimize` di jalur CI/CD (menyatukan config, route, dan *compiled services* ke dalam satu berkas statis `bootstrap/cache/services.php`). |

## 4. High-Assurance Testing

Pengujian arsitektur berbasis Container menuntut Anda untuk memanfaatkan fungsi `Mockery` guna mengganti implementasi nyata dengan objek tiruan secara langsung di dalam Container. Ini memastikan bahwa *controller* atau *job* Anda menerima instans tiruan tanpa menyadari perubahannya.

```php
namespace Tests\Feature;

use Tests\TestCase;
use Mockery;
use Mockery\MockInterface;
use App\Services\Payment\PaymentGatewayInterface;

class CheckoutProcessTest extends TestCase
{
    public function test_checkout_charges_payment_gateway_successfully(): void
    {
        $this->mock(PaymentGatewayInterface::class, function (MockInterface $mock) {
            $mock->shouldReceive('charge')
                 ->once()
                 ->with(15000, 'USD')
                 ->andReturn(true);
        });

        $response = $this->postJson('/api/v1/checkout', [
            'amount' => 15000,
            'currency' => 'USD',
        ]);

        $response->assertStatus(200)
                 ->assertJson(['status' => 'success']);
    }
}
```

## 5. Anti-Patterns & "When NOT to Use" Matrix

### Anti-Pattern: Penggunaan `app()` Global Helper di dalam Logika Bisnis
Memanggil `app(SomeService::class)` atau `resolve()` secara serampangan di tengah-tengah metode *domain logic* adalah pelanggaran keras terhadap prinsip *Inversion of Control*. Ini adalah pola *Service Locator*, bukan *Dependency Injection*.

**Mengapa ini fatal?**
- **Pros:** Cepat ditulis, mengurangi jumlah parameter pada konstruktor.
- **Cons (1):** Menyembunyikan graf dependensi (developer tidak tahu kelas ini bergantung pada apa tanpa membaca seluruh baris kodenya).
- **Cons (2):** Merusak *testability* karena sangat sulit untuk menyuntikkan *mock object* sebelum titik di mana `app()` dipanggil.
- **Cons (3):** Memicu penggandengan erat (*tight coupling*) dengan kerangka kerja Laravel (kelas *domain* Anda sekarang bergantung mutlak pada fungsi global Laravel).

**Kapan DI Container (Binding Kompleks) TIDAK Boleh Digunakan:**
- **Value Objects (VO) / Data Transfer Objects (DTO):** Objek yang hanya berisi keadaan *(state/data)* seperti kordinat lokasi atau muatan JSON tidak boleh diselesaikan melalui Container. Mereka harus diinstansiasi secara manual menggunakan operator `new`.
- **Fungsi Murni (Pure Functions):** Operasi matematis statis atau utilitas *string* yang deterministik tidak memerlukan injeksi dependensi.
