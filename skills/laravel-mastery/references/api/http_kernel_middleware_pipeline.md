# HTTP Kernel & Terminable Middleware (Top 1% Architecture)

## 1. Fundamental Law & Mechanical Sympathy

Dalam arsitektur *web framework* modern berbasis *Request-Response*, **HTTP Kernel** adalah panggung utama di mana *Middleware Pipeline* dieksekusi secara berurutan (*Onion Architecture*). Mekanisme ini bekerja secara fundamental dengan cara membungkus panggilan inti aplikasi (Controller) di dalam antrean panjang *closures* (fungsi tanpa nama). Setiap *middleware* berhak melakukan mutasi pada objek HTTP Request sebelum mencapai *controller*, dan memanipulasi objek HTTP Response sesudahnya.

Secara mekanik (*Mechanical Sympathy*), salah satu tantangan terbesar dari aplikasi API dengan *traffic* tinggi adalah **Response Latency**. Banyak *developer* keliru meletakkan tugas berat seperti pelaporan *Analytics*, pengiriman *Audit Trail*, atau sinkronisasi metrik di dalam *Controller*, yang memaksa *client* menunggu ekstra 50-100ms. Untuk mengatasi hal ini tanpa menggunakan antrean eksternal (Queue), Laravel menyediakan fitur **Terminable Middleware**. Menggunakan protokol `fastcgi_finish_request()` (jika berjalan di PHP-FPM) atau *non-blocking response stream* di Swoole/Octane, Laravel dapat mengirimkan *Response* kepada *client* secara instan, dan *setelah* koneksi ditutup, mengeksekusi sisa kode (melalui metode `terminate`) sepenuhnya secara transparan.

## 2. Top 1% Production Architecture

Arsitektur produksi tingkat tinggi selalu mengisolasi logika yang tidak memblokir antarmuka (*non-blocking logic*) dari siklus kritis *Request-Response*. 

### 2.1 The Terminable Audit Logger
Contoh di bawah mengilustrasikan sebuah *middleware* pencatatan log tingkat tinggi yang mencegat setiap *request* mutasi (`POST`, `PUT`, `DELETE`). Pencatatan ke *database* atau layanan *Data Warehouse* dilakukan murni pada metode `terminate`.

```php
namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use App\Services\Audit\TelemetryClient;

class TerminableAuditLogger
{
    public function __construct(private TelemetryClient $telemetry) {}

    /**
     * Handle an incoming request.
     */
    public function handle(Request $request, Closure $next): Response
    {
        // Inject a correlation ID into the request for end-to-end tracking
        if (!$request->headers->has('X-Correlation-ID')) {
            $request->headers->set('X-Correlation-ID', (string) \Illuminate\Support\Str::uuid());
        }

        // Start timing the execution
        $request->attributes->set('start_time', microtime(true));

        return $next($request);
    }

    /**
     * Handle tasks after the response has been sent to the browser.
     */
    public function terminate(Request $request, Response $response): void
    {
        // Only audit mutating requests
        if ($request->isMethodSafe()) {
            return;
        }

        $duration = microtime(true) - $request->attributes->get('start_time');

        // This heavy HTTP call to the telemetry server happens AFTER the client received the response
        $this->telemetry->record([
            'correlation_id' => $request->headers->get('X-Correlation-ID'),
            'endpoint' => $request->path(),
            'method' => $request->method(),
            'status' => $response->getStatusCode(),
            'duration_ms' => round($duration * 1000, 2),
            'payload' => $request->except(['password', 'credit_card']),
        ]);
    }
}
```

### 2.2 Global Exception Interception di Kernel
Pastikan HTTP Kernel Anda (`App\Http\Kernel`) mendaftarkan *middleware* yang krusial seperti perlindungan laju (*Rate Limiting*) dan CORS pada tumpukan teratas (paling luar dari bawang), sehingga *request* ilegal ditolak sebelum aplikasi terinisialisasi lebih jauh.

## 3. Failure & Edge-Case Anomaly Matrix

| Kelas Anomali | Gejala / Dampak Mutlak | Matriks Mitigasi (Top 1% Tactic) |
| :--- | :--- | :--- |
| **Octane Memory Leaks (Terminable State)** | Karena `terminate()` berjalan setelah *response* dikirim, injeksi dependensi berupa `Singleton` di dalam *Terminable Middleware* pada Laravel Octane akan terus membesar (*memory leak*) atau menyimpan *state user* sebelumnya. | Gunakan kelas yang dideklarasikan dengan `$app->bind()` alih-alih `singleton()`, atau panggil *Container* secara eksplisit dengan metode *Scoped* untuk menghindari akumulasi status lintas-*request*. |
| **FPM Thread Blocking** | PHP-FPM memiliki *pool worker* yang terbatas. Walaupun klien sudah terputus, proses `terminate()` masih menahan satu *FPM worker*. Jika `terminate()` memakan waktu 5 detik (misal: *timeout* jaringan), FPM akan kehabisan *worker* (*502 Bad Gateway*). | Jangan jadikan `terminate()` sebagai pengganti *Message Queue*. `terminate()` eksklusif HANYA untuk operasi *I/O* berdurasi pendek (<100ms) seperti metrik UDP atau pencatatan sinkron ke Redis lokal. Logika berat tetap WAJIB dilempar ke Horizon. |
| **Bypass on Fatal Errors** | Jika terjadi *Fatal Error* atau *Exception* yang tidak tertangani di dalam *Controller*, siklus Laravel mungkin terhenti secara mendadak sebelum metode `terminate()` dipanggil pada semua *middleware*. | Pastikan Anda memiliki *Global Exception Handler* yang kuat. Jangan mengandalkan `terminate()` untuk memutar balik (*rollback*) transaksi *database*; gunakan *try-catch* secara eksplisit pada *Controller/Service*. |

## 4. High-Assurance Testing

Pengujian *Terminable Middleware* membutuhkan ketelitian karena metode `terminate()` seringkali diabaikan dalam panggilan API *dummy* (*Feature Test*) biasa tanpa pembungkus Kernel secara menyeluruh.

```php
namespace Tests\Feature\Middleware;

use Tests\TestCase;
use App\Http\Middleware\TerminableAuditLogger;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use App\Services\Audit\TelemetryClient;
use Mockery\MockInterface;

class TerminableAuditLoggerTest extends TestCase
{
    public function test_terminate_method_records_telemetry_for_mutating_requests(): void
    {
        $this->mock(TelemetryClient::class, function (MockInterface $mock) {
            $mock->shouldReceive('record')
                 ->once()
                 ->with(\Mockery::on(function ($data) {
                     return $data['status'] === 201 && $data['method'] === 'POST';
                 }));
        });

        $request = Request::create('/api/users', 'POST', ['name' => 'John']);
        $request->attributes->set('start_time', microtime(true));
        
        $response = new Response('', 201);
        
        $middleware = app(TerminableAuditLogger::class);
        $middleware->terminate($request, $response);
    }
}
```

## 5. Anti-Patterns & "When NOT to Use" Matrix

### Anti-Pattern: Melakukan Modifikasi Response di Terminable
Sangat dilarang untuk mencoba menambahkan parameter atau mengubah HTTP Headers pada objek `$response` di dalam metode `terminate()`.

**Mengapa ini fatal?**
- **Pros:** Tidak ada. Ini murni kegagalan pemahaman.
- **Cons (1):** Secara arsitektur, *header* dan konten *response* sudah dikirim ke tumpukan TCP jaringan sebelum `terminate()` dipanggil. Memodifikasi objek memori `$response` di titik ini layaknya mengirim surat tambahan setelah amplop utama masuk ke kotak pos.
- **Cons (2):** Jika Anda menggunakan sistem *Caching* yang mencatat hasil akhir HTTP, modifikasi tak berguna ini bisa menyebabkan anomali sinkronisasi memori lokal.

**Kapan Terminable Middleware TIDAK Boleh Digunakan:**
- **Mengirim Email Konfirmasi:** Durasi pengiriman SMTP seringkali tidak menentu dan berpotensi memblokir *FPM Worker*. Lempar ke *Queue*.
- **Integrasi Webhook Pihak Ketiga:** Jika memanggil REST API server luar (seperti Stripe atau Slack), latensi tidak bisa diprediksi. Selalu gunakan `dispatch(new SendSlackNotification($data))`.
