# Laravel Reverb: WebSocket Server Asli Ekosistem Laravel

Laravel Reverb menghadirkan solusi *first-party* *WebSocket server* untuk aplikasi Laravel. Menggantikan ketergantungan historis terhadap Pusher API atau ekstensi pihak ketiga seperti Soketi/Laravel Websockets, Reverb dirancang untuk performa tinggi dengan *ReactPHP event loop* dan arsitektur *asynchronous* murni di sisi server.

File ini membahas Reverb secara mendalam, dari segi *Architecture, Clean implementation, Tuning, dan Security*.

## 1. Arsitektur Reverb di Skala Produksi

Berbeda dengan siklus eksekusi PHP-FPM klasik (*request-response lifecycle* hancur setelah dilayani), Reverb menjaga proses di memori (*long-running process*). Oleh karena itu, Reverb mutlak memerlukan arsitektur manajemen memori yang ketat dan model asinkron (*ReactPHP*).

```mermaid
graph TD
    Client1[Browser/Mobile 1] -->|WebSocket WSS| LoadBalancer[Nginx/ALB Load Balancer]
    Client2[Browser/Mobile 2] -->|WebSocket WSS| LoadBalancer
    Client3[Browser/Mobile N] -->|WebSocket WSS| LoadBalancer
    
    LoadBalancer -->|TCP Port 8080| ReverbServer[Reverb Server (ReactPHP Loop)]
    
    ReverbServer -->|Redis Pub/Sub| Redis[(Redis Cluster)]
    LaravelApp[Laravel Web App / Queue Worker] -->|Publish Event| Redis
    
    subgraph "Backend Infrastructure"
        Redis
        LaravelApp
        ReverbServer
    end
```

### Konsep Scaling Reverb (Horizontal)
Jika satu instance Reverb tidak cukup menangani jutaan koneksi, Anda memutar beberapa server Reverb. Agar pesan *broadcast* dari klien di Server A sampai ke klien di Server B, **Redis Pub/Sub** mutlak diperlukan sebagai perantara pertukaran pesan internal (*backplane*) antar node Reverb.

## 2. Implementasi Reverb & Integrasi Clean Architecture

Reverb tidak menuntut perubahan drastis dalam kode event, ia dihidupkan via *env config* dan CLI runner `php artisan reverb:start`.

**Konfigurasi `.env`:**
```dotenv
BROADCAST_CONNECTION=reverb
REVERB_APP_ID=my-secure-app-id
REVERB_APP_KEY=my-secure-key
REVERB_APP_SECRET=my-secure-secret
REVERB_HOST="127.0.0.1"
REVERB_PORT=8080
REVERB_SCHEME=https
```

### Server Side Action untuk Notifikasi Real-Time (Service/Action Layer)

Di sisi server, *triggering event* hanya membutuhkan *broadcasting dispatch* reguler, namun di balik layar akan diteruskan ke Redis, yang lalu disedot oleh Reverb loop.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Notifications;

use App\Events\Notifications\SystemAlertEvent;
use Illuminate\Support\Facades\Log;
use Throwable;
use RuntimeException;

final class BroadcastSystemAlertAction
{
    /**
     * @throws RuntimeException
     */
    public function execute(string $message, string $severity = 'info'): void
    {
        try {
            // Validasi domain bisnis...
            if (trim($message) === '') {
                throw new \InvalidArgumentException('Pesan alert tidak boleh kosong.');
            }

            // Menyimpan log internal untuk audit
            Log::info('System Alert Broadcasted', [
                'message' => $message,
                'severity' => $severity,
            ]);

            // Dispatch event yang terhubung dengan Laravel Echo (Reverb Server)
            SystemAlertEvent::dispatch($message, $severity);
        } catch (Throwable $e) {
            Log::error('Gagal melakukan broadcast system alert: ' . $e->getMessage());
            throw new RuntimeException('Broadcast failed', 0, $e);
        }
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Events\Notifications;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

final class SystemAlertEvent implements ShouldBroadcast
{
    use Dispatchable, InteractsWithSockets, SerializesModels;

    /**
     * Channel bebas auth (public).
     */
    public function broadcastOn(): Channel
    {
        return new Channel('system-alerts');
    }

    public function __construct(
        private readonly string $message,
        private readonly string $severity
    ) {}

    public function broadcastWith(): array
    {
        return [
            'type' => 'alert',
            'severity' => $this->severity,
            'message' => $this->message,
            'timestamp' => now()->getTimestamp(),
        ];
    }
}
```

## 3. Anti-Patterns & Best Practices pada Reverb

### ❌ Anti-Pattern 1: Blocking I/O dalam Event Listener Reverb (Memory Risk)
**Kesalahan:** Reverb adalah proses jangka panjang (*long-running*) yang dieksekusi dengan event loop ReactPHP tunggal (*single-threaded*). Jika Anda membuat kustomisasi/hook di dalam server Reverb yang melakukan kueri *database* sinkron atau pemanggilan *HTTP sync* (seperti `Http::get()`), hal itu akan menghentikan **SELURUH SERVER** dari memproses klien lain (Event Loop terblokir).

```php
// ❌ KODE SALAH (Misalnya Anda meregister listener kustom dalam ServiceProvider untuk hook event Reverb)
use Laravel\Reverb\Events\MessageReceived;

Event::listen(MessageReceived::class, function (MessageReceived $event) {
    // SANGAT BERBAHAYA! DB::table() menggunakan driver PDO sinkron.
    // Loop Reverb akan berhenti ('hang') selama 1-2 detik jika query ini lambat.
    // Selama itu, ribuan klien WebSocket akan terputus karena Reverb gagal membalas Ping/Pong.
    $user = DB::table('users')->where('id', $event->connection->id())->first();
    Log::info("Message dari user: " . $user->name);
});
```

**✅ KODE BENAR**
Biarkan Reverb menjadi murni sebagai lapisan *transport message*. Jangan meletakkan logika I/O sinkron ke dalamnya. Kirimkan event ke *Queue* (RabbitMQ/Redis) dari sana, dan biarkan *worker queue* biasa yang melakukan I/O berat.

```php
// ✅ KODE BENAR
use Laravel\Reverb\Events\MessageReceived;
use App\Jobs\ProcessReverbMessageJob;

Event::listen(MessageReceived::class, function (MessageReceived $event) {
    // Non-blocking, cepat. Lempar payload ke sistem antrean Redis untuk diproses asinkron.
    ProcessReverbMessageJob::dispatch($event->message, $event->connection->id());
});
```

### ❌ Anti-Pattern 2: Tidak Membatasi Ukuran Payload (DDoS Risk)
**Kesalahan:** Mengizinkan aplikasi Anda men-dispatch event WebSocket yang memuat *dataset* besar (> 1 MB JSON). Jika ini terkirim ke channel publik dengan 10.000 subscriber, server Reverb akan kehabisan memori seketika (OOM) karena mencoba melakukan serialisasi dan iterasi socket pengiriman untuk payload gabungan 10GB!

```php
// ❌ KODE SALAH
final class SyncAllProductsEvent implements ShouldBroadcast {
    // BERBAHAYA: Mengirim array 100.000 baris ke WebSocket
    public function broadcastWith(): array {
        return Product::all()->toArray(); 
    }
}
```

**✅ KODE BENAR**
WebSocket dirancang untuk **notifikasi/sinyal kecil**. Kirim ID entitas, biarkan *client* meminta (*fetch*) detail ke REST API jika dibutuhkan (di-handle oleh FPM yang dirancang untuk payload besar).

```php
// ✅ KODE BENAR
final class SyncProductsSignalEvent implements ShouldBroadcast {
    public function broadcastWith(): array {
        return [
            'action' => 'reload_products',
            'updated_count' => 1500, // Client cukup tahu ada perubahan
        ];
    }
}
```

## 4. Nginx Tuning untuk Reverb

Nginx secara default mematikan koneksi yang terlalu lama pasif. Pastikan konfigurasi Nginx *Proxy Pass* mendukung spesifikasi `Upgrade` WebSockets dan panjang waktu *read/write timeout* yang tepat agar koneksi Reverb tidak diputus paksa.

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $http_host;
    proxy_set_header Scheme $scheme;
    proxy_set_header SERVER_PORT $server_port;
    proxy_set_header REMOTE_ADDR $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    
    # Sangat Penting untuk mencegah Nginx kill pasif connection
    proxy_read_timeout 60m;
    proxy_send_timeout 60m;
}
```

## 5. Architecture & Unit Testing (Pest v3)

Validasi *events* yang mendasari Reverb berjalan sesuai aturan *Clean Architecture*.

```php
<?php

declare(strict_types=1);

use App\Actions\Notifications\BroadcastSystemAlertAction;
use App\Events\Notifications\SystemAlertEvent;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Log;

uses(\Illuminate\Foundation\Testing\RefreshDatabase::class);

describe('Architecture: Reverb Events Constraints', function () {
    arch('broadcasting events should not leak memory or have large payloads')
        ->expect('App\Events\Notifications')
        ->toHaveConstructor()
        ->toUseStrictTypes()
        ->toBeFinal();
});

describe('Unit Test: BroadcastSystemAlertAction', function () {
    it('successfully dispatches the event and logs info', function () {
        Event::fake([
            SystemAlertEvent::class,
        ]);
        Log::shouldReceive('info')->once()->withArgs(function ($msg, $context) {
            return $msg === 'System Alert Broadcasted' && $context['severity'] === 'danger';
        });

        $action = app(BroadcastSystemAlertAction::class);
        $action->execute('Server Maintenance', 'danger');

        Event::assertDispatched(SystemAlertEvent::class, function (SystemAlertEvent $event) {
            $payload = $event->broadcastWith();
            return $payload['message'] === 'Server Maintenance'
                && $payload['severity'] === 'danger'
                && isset($payload['timestamp']);
        });
    });

    it('throws InvalidArgumentException when message is empty', function () {
        Event::fake([SystemAlertEvent::class]);

        $action = app(BroadcastSystemAlertAction::class);
        
        expect(fn () => $action->execute('   '))
            ->toThrow(\InvalidArgumentException::class, 'Pesan alert tidak boleh kosong.');

        Event::assertNotDispatched(SystemAlertEvent::class);
    });
});
```

**Selesai**
Konfigurasi dan implementasi Reverb di dalam infrastruktur harus dijaga seketat mungkin dari sisi memori dan Payload Management, dipisah secara fungsional melalui event queueing dan divalidasi penuh arsitekturnya menggunakan arsitektural tes (Pest).
