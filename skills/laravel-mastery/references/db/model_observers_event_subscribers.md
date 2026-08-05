# Model Observers, Events & Mutators (Top 1% Architecture)

## 1. Fundamental Law & Mechanical Sympathy

Di dunia arsitektur rekayasa perangkat lunak, sistem berbasis *Event* adalah cara terbaik untuk menerapkan pelepasan ketergantungan (*Decoupling*) dan mematuhi prinsip tanggung jawab tunggal (*Single Responsibility Principle / SRP*). Di Laravel, pola ini seringkali direalisasikan melalui **Eloquent Observers** dan **Event Subscribers**. Mekanismenya sangat elegan: ketika *state* dari sebuah entitas berubah (contoh: `User::create()`), Model akan secara internal memancarkan sinyal siklus hidup (misalnya `creating`, `created`, `updating`, `updated`). Sinyal ini ditangkap oleh *Observer* atau *Listener* terkait.

Secara mekanik (*Mechanical Sympathy*), pancaran sinyal ini dijalankan secara **sinkron dan berurutan** di dalam ruang memori *thread* utama secara *default*. Ini berarti jika Anda memiliki tiga kelas *Observer* untuk satu model `User`, PHP harus menyelesaikan eksekusi ketiga kelas tersebut sebelum memulangkan nilai kembalian metode `create()`. Tanpa pengawasan ketat, pola yang tadinya bertujuan *decoupling* ini akan berbalik mematikan performa secara eksponensial (melalui masalah *N+1 Queries*) dan menghancurkan integritas transaksional *database*.

## 2. Top 1% Production Architecture

Arsitektur produksi tingkat tinggi selalu mengatur *Observer* dan *Event Listener* dengan dua doktrin utama: **Isolasi Transaksi Database (Transactional Integrity)** dan **Penggantian Konteks Asinkron (Async Offloading)**.

### 2.1 The "$afterCommit" Safe Observer
Satu kesalahan paling mengerikan di aplikasi *enterprise* adalah melempar antrean tugas asinkron (misal: mengirim notifikasi) di dalam *Observer* sesaat setelah Model dibuat, namun transaksi *database* utama *gagal/di-rollback* sepersekian milidetik kemudian. Pekerja asinkron (Queue Worker) akan mengeksekusi tugas tersebut tanpa menemukan data yang dimaksud di *database*. Solusi Top 1% adalah secara eksplisit memberlakukan `$afterCommit = true`.

```php
namespace App\Observers;

use App\Models\Order;
use App\Jobs\Fulfillment\ProcessOrderDispatching;

class OrderObserver
{
    /**
     * Handle events after all open database transactions are committed.
     * This strictly prevents the Queue worker from encountering "Model Not Found" exceptions.
     */
    public bool $afterCommit = true;

    /**
     * Handle the Order "created" event.
     */
    public function created(Order $order): void
    {
        // Offload heavy processing to Horizon/Redis queues immediately
        ProcessOrderDispatching::dispatch($order->id);
    }
    
    /**
     * Handle the Order "updated" event.
     */
    public function updated(Order $order): void
    {
        if ($order->wasChanged('status') && $order->status === 'paid') {
            // Trigger domain events securely
            event(new \App\Events\OrderPaymentSecured($order));
        }
    }
}
```

### 2.2 Event Subscribers untuk Peta Domain Terpusat
Untuk kejadian lintas domain (domain *Events*, bukan hanya sekadar Model *CRUD*), gunakan *Event Subscriber*. Ini memusatkan semua keterkaitan langganan dalam satu berkas, daripada menyebar ratusan deklarasi `Event::listen` di berbagai *Provider*.

```php
namespace App\Listeners;

use Illuminate\Events\Dispatcher;
use App\Events\UserRegistered;
use App\Events\UserUpgradedPlan;
use Illuminate\Contracts\Queue\ShouldQueue;

class UserDomainSubscriber implements ShouldQueue
{
    public function handleUserRegistered(UserRegistered $event): void
    {
        // Provision initial workspace limits
    }

    public function handleUserUpgradedPlan(UserUpgradedPlan $event): void
    {
        // Propagate billing changes to SaaS CRM
    }

    /**
     * Register the listeners for the subscriber.
     */
    public function subscribe(Dispatcher $events): array
    {
        return [
            UserRegistered::class => 'handleUserRegistered',
            UserUpgradedPlan::class => 'handleUserUpgradedPlan',
        ];
    }
}
```

## 3. Failure & Edge-Case Anomaly Matrix

| Kelas Anomali | Gejala / Dampak Mutlak | Matriks Mitigasi (Top 1% Tactic) |
| :--- | :--- | :--- |
| **Silent Cascading Infinite Loop** | Server lumpuh (OOM/Timeout) akibat Model `A` di-update, memicu Observer A yang meng-update Model `B`, yang memicu Observer B yang kembali meng-update Model `A`. | Hati-hati menggunakan metode `save()` atau `update()` di dalam Observer. Selalu gunakan `updateQuietly()` jika Anda perlu mengubah *state* internal tanpa memicu ulang pemicu kejadian berantai (*event cascade*). |
| **Ghost Writes on Bulk Operations** | Anda menulis logika penting di Observer `updated`, namun saat Anda mengeksekusi *Bulk Update* seperti `User::where('active', false)->update(['status' => 'banned'])`, Observer tersebut **tidak pernah terpanggil**. | Pahami secara mekanik: *Bulk Queries* (memanggil metode `update/delete` langsung di Query Builder) berinteraksi dengan basis data secara absolut dan **melewati** *(bypass)* Model PHP. Akibatnya, Laravel tidak menembakkan siklus hidup Model. Jika Observer kritis diperlukan, Anda wajib melakukan `get()` terlebih dahulu dan memproses data melalui memori PHP secara berulang (*foreach*). |
| **Transactional Misfire (The Race Condition)** | Data yang terkait dengan model (misal *relation* `OrderItems`) belum tersimpan karena transaksi belum selesai, namun *Event Listener* di *queue worker* sudah berjalan dan melempar *Null Pointer Exception*. | Seperti poin 2.1, wajib gunakan properti `$afterCommit = true` pada *Observer* dan penanda `ShouldHandleEventsAfterCommit` pada Listener asinkron. |

## 4. High-Assurance Testing

Pengujian arsitektur *Observer* harus berfokus pada asersi pemancaran kejadian (*Events Faked*) dan penjagaan isolasi basis data. Kita tidak ingin mengirimkan sinyal nyata (contoh: notifikasi *webhook* pihak ketiga) saat pengujian `create()` dijalankan.

```php
namespace Tests\Feature\Observers;

use Tests\TestCase;
use App\Models\Order;
use Illuminate\Support\Facades\Event;
use App\Events\OrderPaymentSecured;
use Illuminate\Support\Facades\Queue;
use App\Jobs\Fulfillment\ProcessOrderDispatching;

class OrderObserverTest extends TestCase
{
    public function test_order_creation_dispatches_fulfillment_job(): void
    {
        Queue::fake();

        // Triggering the Observer via factory
        $order = Order::factory()->create();

        Queue::assertPushed(ProcessOrderDispatching::class, function ($job) use ($order) {
            return $job->orderId === $order->id;
        });
    }

    public function test_order_status_update_fires_payment_secured_event(): void
    {
        Event::fake([OrderPaymentSecured::class]);

        $order = Order::factory()->create(['status' => 'pending']);
        
        $order->update(['status' => 'paid']);

        Event::assertDispatched(OrderPaymentSecured::class, function ($event) use ($order) {
            return $event->order->id === $order->id;
        });
    }
}
```

## 5. Anti-Patterns & "When NOT to Use" Matrix

### Anti-Pattern: Mencampuradukkan Business Domain Logic di dalam Eloquent Observers
Seringkali *developer* memasukkan seluruh logika penghitungan faktur yang rumit, pembuatan entitas berlapis, dan validasi kredit secara langsung di dalam Observer `created`. 

**Mengapa ini fatal?**
- **Pros:** Awalnya terlihat bersih karena *Controller* Anda menjadi sangat tipis (*fat models, skinny controllers*).
- **Cons (1):** *Hidden Magic (Spooky Action at a Distance)*. Rekan kerja Anda yang membuat perintah sederhana `Order::create()` tidak akan menyadari bahwa operasi tersebut secara sepihak memotong saldo pengguna, mengirim email, dan menerbitkan tiga resi cetak ke *warehouse*.
- **Cons (2):** Arsitektur berubah menjadi sangat sulit untuk diuji (*brittle*). Menyiapkan pengujian untuk *Order* secara langsung mengaktifkan 5 proses logika tersembunyi yang saling terkait.

**Kapan Observers TIDAK Boleh Digunakan:**
- **Aturan Domain Inti (Core Business Workflows):** Jika kejadiannya adalah bagian dari alur bisnis sentral (misal: "Saat Transaksi Selesai, berikan Poin Loyalitas"), alur ini harus ditulis secara **eksplisit** di dalam *Service Class* atau *Command Handler* (contoh: `CompleteTransactionService::execute()`). Observers idealnya HANYA digunakan untuk hal sekunder yang tidak mengganggu alur utama (misalnya *cache clearing*, indeks *Elasticsearch*, pelacakan audit, metrik telemetri).
