# Panduan Komprehensif Server-Sent Events (SSE) di Laravel & PHP 8.4

Server-Sent Events (SSE) adalah teknologi web standar yang memungkinkan server mengirim pembaruan otomatis (push) ke klien melalui satu koneksi HTTP yang berjalan lama (long-lived connection). Berbeda dengan WebSockets yang bersifat dua arah (bidirectional), SSE bersifat satu arah (unidirectional) dari server ke klien. Ini sangat ideal untuk kasus penggunaan seperti feed berita langsung, ticker saham, pembaruan skor olahraga, atau log streaming, di mana klien hanya perlu menerima data secara terus-menerus tanpa perlu mengirim banyak pesan kembali ke server.

Dokumen ini adalah panduan "Top 1%" untuk mengimplementasikan SSE di PHP 8.3/8.4 dan Laravel 11/12 dengan prinsip Clean Architecture, tipe yang ketat, dan pengelolaan koneksi yang tangguh.

---

## 1. Anatomi dan Protokol Server-Sent Events

SSE beroperasi di atas protokol HTTP standar. Kunci dari SSE adalah header HTTP tertentu dan format aliran data.

### Header HTTP yang Diperlukan

Untuk memulai koneksi SSE, server harus merespons dengan header berikut:

```http
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no (Khusus Nginx)
```

### Format Data (Event Stream)

Data dikirim dalam format teks biasa, dengan setiap event dipisahkan oleh dua baris baru (`\n\n`). Setiap event dapat memiliki beberapa field opsional:

*   `id`: Pengidentifikasi unik untuk event. Berguna untuk klien agar dapat melacak pesan mana yang telah diterima (memungkinkan pemulihan menggunakan header `Last-Event-ID`).
*   `event`: Jenis event kustom (misal: `stock_update`, `user_joined`). Jika tidak ditentukan, tipe default adalah `message`.
*   `data`: Payload dari event. Bisa berupa string biasa atau JSON yang diserialisasi.
*   `retry`: Waktu (dalam milidetik) bagi klien untuk menunggu sebelum mencoba menyambung kembali jika koneksi terputus.

Format pesan yang sah:

```text
id: 12345
event: price_update
data: {"symbol": "AAPL", "price": 175.50}
retry: 5000

```

---

## 2. Tantangan SSE di PHP Tradisional (PHP-FPM)

Secara bawaan, eksekusi PHP (khususnya PHP-FPM) tidak dirancang untuk koneksi yang berjalan tanpa batas (long-polling/streaming). PHP-FPM mengalokasikan satu proses pekerja (worker) untuk setiap permintaan HTTP. Jika Anda memiliki 100 klien yang terhubung ke endpoint SSE, Anda akan menghabiskan 100 proses pekerja PHP-FPM. Jika batas proses tercapai, server tidak dapat melayani permintaan HTTP reguler lainnya.

### Mengatasi Limitasi PHP-FPM
Jika Anda harus menggunakan PHP-FPM, Anda perlu mengelola timeout dan memastikan bahwa output buffer tidak mencegah data dikirim langsung ke klien. Fungsi `flush()` dan `ob_flush()` sering digunakan untuk memaksa PHP mengirim chunk data ke web server, dan web server harus dikonfigurasi untuk meneruskan chunk tersebut segera ke klien tanpa melakukan buffering mandiri.

Namun, cara terbaik menjalankan SSE di Laravel modern adalah **Laravel Octane**.

---

## 3. Infrastruktur: Konfigurasi Laravel Octane & Nginx

Laravel Octane (menggunakan mesin seperti Swoole atau FrankenPHP) menyimpan kerangka kerja di memori dan menangani koneksi secara asinkron (menggunakan coroutines atau event loops). Ini secara radikal mengubah kemampuan PHP untuk menangani ribuan koneksi SSE secara simultan dengan overhead memori yang rendah.

### Konfigurasi Nginx untuk SSE

Bahkan jika aplikasi Anda bisa melakukan streaming, proxy Nginx di depannya mungkin saja menahan respons untuk optimasi. Untuk SSE, kita wajib mematikan buffering agar pesan langsung sampai ke klien.

Berikut adalah contoh blok konfigurasi server Nginx untuk endpoint SSE:

```nginx
location /api/v1/streams/ {
    proxy_pass http://127.0.0.1:8000;
    
    # Menonaktifkan buffering proxy dari sisi Nginx
    proxy_buffering off;
    proxy_cache off;
    chunked_transfer_encoding on;
    
    # Memastikan koneksi HTTP/1.1 yang dibutuhkan untuk keep-alive panjang
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    
    # Menghindari timeout standar Nginx (default 60s)
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    
    # Header yang diteruskan ke upstream
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

---

## 4. Implementasi Clean Architecture: Real-time Stock Ticker

Dalam contoh ini, kita akan membuat sistem Ticker Saham secara real-time yang memancarkan harga secara konstan kepada pengguna web.

### A. Domain Layer (Entity & Value Objects)

```php
<?php

declare(strict_types=1);

namespace App\Domain\Stocks\ValueObjects;

use InvalidArgumentException;

final readonly class StockSymbol
{
    public function __construct(private string $value)
    {
        if (preg_match('/^[A-Z]{1,5}$/', $this->value) !== 1) {
            throw new InvalidArgumentException("Format simbol saham tidak valid: {$this->value}");
        }
    }

    public function toString(): string
    {
        return $this->value;
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Domain\Stocks\Entities;

use App\Domain\Stocks\ValueObjects\StockSymbol;
use DateTimeImmutable;
use JsonSerializable;

final readonly class StockTick implements JsonSerializable
{
    public function __construct(
        public string $id,
        public StockSymbol $symbol,
        public float $price,
        public DateTimeImmutable $timestamp,
    ) {}

    public function jsonSerialize(): array
    {
        return [
            'id' => $this->id,
            'symbol' => $this->symbol->toString(),
            'price' => $this->price,
            'timestamp' => $this->timestamp->format(DateTimeImmutable::ATOM),
        ];
    }
}
```

### B. Application Layer (Use Cases / Contracts)

Kita membutuhkan sebuah _streamer_ abstrak yang dapat memberikan data ke klien.

```php
<?php

declare(strict_types=1);

namespace App\Application\Stocks\Contracts;

use App\Domain\Stocks\Entities\StockTick;
use Closure;

interface StockTickStreamerInterface
{
    /**
     * Memulai stream dan mengeksekusi callback setiap kali tick baru tersedia.
     *
     * @param Closure(StockTick): void $onTickCallback
     * @return void
     */
    public function stream(Closure $onTickCallback): void;
}
```

### C. Infrastructure Layer (Implementation & Streaming Logic)

Di lapisan infrastruktur, kita menghubungkan streamer ke sistem publikasi, seperti Redis Pub/Sub, untuk mendapatkan pergerakan nilai dari worker eksternal. Namun, untuk contoh kode mandiri (standalone), kita akan mensimulasikan data yang berjalan dengan random generator dan deteksi koneksi.

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Stocks\Streamers;

use App\Application\Stocks\Contracts\StockTickStreamerInterface;
use App\Domain\Stocks\Entities\StockTick;
use App\Domain\Stocks\ValueObjects\StockSymbol;
use Closure;
use DateTimeImmutable;
use Illuminate\Support\Str;
use Random\Randomizer;

final class SimulatedStockStreamer implements StockTickStreamerInterface
{
    public function stream(Closure $onTickCallback): void
    {
        $executionCount = 0;
        $maxSimulatedExecutions = 100;
        $randomizer = new Randomizer();

        while (true) {
            if (connection_aborted() === 1) {
                break;
            }

            $symbol = new StockSymbol($randomizer->getInt(0, 1) === 0 ? 'AAPL' : 'GOOGL');
            $price = $randomizer->getInt(10000, 20000) / 100.0;

            $tick = new StockTick(
                id: Str::uuid()->toString(),
                symbol: $symbol,
                price: $price,
                timestamp: new DateTimeImmutable(),
            );

            $onTickCallback($tick);

            $executionCount++;
            if ($executionCount >= $maxSimulatedExecutions) {
                break;
            }

            sleep(1);
        }
    }
}
```

### D. Presentation Layer (Laravel Controller & Streaming Response)

Laravel menyediakan mekanisme untuk melakukan streaming HTTP menggunakan `Symfony\Component\HttpFoundation\StreamedResponse`. Ini memungkinkan kita menjaga koneksi tetap hidup dan mengirimkan buffer data sedikit demi sedikit.

```php
<?php

declare(strict_types=1);

namespace App\Presentation\Http\Controllers;

use App\Application\Stocks\Contracts\StockTickStreamerInterface;
use App\Domain\Stocks\Entities\StockTick;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;

final readonly class StreamStockController
{
    public function __construct(
        private StockTickStreamerInterface $streamer
    ) {}

    public function __invoke(Request $request): StreamedResponse
    {
        $response = new StreamedResponse(function () {
            if (ob_get_level() > 0) {
                ob_end_clean();
            }

            $this->streamer->stream(function (StockTick $tick) {
                $payload = json_encode($tick, JSON_THROW_ON_ERROR);
                
                echo "id: {$tick->id}\n";
                echo "event: price_update\n";
                echo "data: {$payload}\n\n";

                flush();
            });
        });

        $response->headers->set('Content-Type', 'text/event-stream');
        $response->headers->set('Cache-Control', 'no-cache');
        $response->headers->set('Connection', 'keep-alive');
        $response->headers->set('X-Accel-Buffering', 'no');

        return $response;
    }
}
```

---

## 5. Skalabilitas Lanjutan: Redis Pub/Sub dan Laravel Octane Worker

Untuk beban perusahaan yang sesungguhnya (Enterprise Load), generator simulasi di atas diganti dengan pemantauan Redis Channel. Worker latar belakang mengirim harga ke Redis, dan setiap endpoint SSE akan mendengarkan (subscribe) channel ini dan menyalurkannya kepada browser yang meminta.

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Stocks\Streamers;

use App\Application\Stocks\Contracts\StockTickStreamerInterface;
use App\Domain\Stocks\Entities\StockTick;
use App\Domain\Stocks\ValueObjects\StockSymbol;
use Closure;
use DateTimeImmutable;
use Illuminate\Support\Facades\Redis;
use RuntimeException;
use Throwable;
use Illuminate\Support\Facades\Log;

final class RedisPubSubStockStreamer implements StockTickStreamerInterface
{
    private const REDIS_CHANNEL = 'stocks_realtime_updates';

    public function stream(Closure $onTickCallback): void
    {
        set_time_limit(0);
        ignore_user_abort(false);

        try {
            Redis::connection('pubsub')->subscribe([self::REDIS_CHANNEL], function (string $message) use ($onTickCallback) {
                if (connection_aborted() === 1) {
                    Log::info('Klien memutus koneksi SSE, menghentikan langganan Redis.');
                    return false; 
                }

                try {
                    $decoded = json_decode($message, true, 512, JSON_THROW_ON_ERROR);
                    
                    $tick = new StockTick(
                        id: (string) ($decoded['id'] ?? uniqid('evt_', true)),
                        symbol: new StockSymbol((string) $decoded['symbol']),
                        price: (float) $decoded['price'],
                        timestamp: new DateTimeImmutable((string) $decoded['timestamp']),
                    );

                    $onTickCallback($tick);
                    
                } catch (Throwable $e) {
                    Log::error('Kesalahan parsing data event Redis.', [
                        'message' => $message,
                        'exception' => $e->getMessage()
                    ]);
                }
            });
        } catch (Throwable $e) {
            Log::critical('Koneksi streaming Redis Pub/Sub gagal.', [
                'exception' => $e->getMessage()
            ]);
            throw new RuntimeException('Gagal menyambung ke data stream saham.', 0, $e);
        }
    }
}
```

> **CATATAN AHLI TENTANG BLOCKING REDIS:** 
> Saat menggunakan `Redis::subscribe` dengan ekstensi PhpRedis secara blocking (sinkron), pengecekan `connection_aborted()` hanya akan terjadi ketika ada pesan baru yang masuk. Jika tidak ada pergerakan saham selama satu jam, proses worker FPM akan tertahan dan aborsi koneksi tidak terdeteksi hingga ada data berikutnya. Di ekosistem Laravel Octane (Swoole), masalah ini ditangani dengan baik melalui Coroutine Channels (`Swoole\Coroutine\Channel`) dan Asynchronous Redis client di mana multiplexing terjadi secara non-blocking di belakang layar, memungkinkan timeout rutin untuk memeriksa kesehatan koneksi klien tanpa menunggu interupsi data.

---

## 6. Anti-Patterns dalam Server-Sent Events (SSE)

### Anti-Pattern 1: Mengabaikan Deteksi Koneksi Klien (Zombie Workers)

❌ **KODE SALAH (Memicu Memory Leak & Zombie Process):**
Membuat infinite loop tanpa pernah memeriksa apakah klien yang menerima data telah menutup koneksinya (menutup browser browser).

```php
<?php

declare(strict_types=1);

namespace App\Presentation\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Redis;

final class BadStreamController 
{
    public function __invoke(Request $request)
    {
        while (true) {
            $data = Redis::lpop('stock_queue');
            if ($data !== null) {
                echo "data: {$data}\n\n";
                flush();
            }
            sleep(1);
        }
    }
}
```

✅ **KODE BENAR (Graceful Disconnect):**
Memeriksa status aborsi koneksi sebelum melakukan perulangan berat. 

```php
<?php

declare(strict_types=1);

namespace App\Presentation\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Facades\Log;

final class GoodStreamController 
{
    public function __invoke(Request $request)
    {
        ignore_user_abort(false);

        while (true) {
            if (connection_aborted() === 1) {
                Log::info('Client disconnected dari SSE stream.');
                break;
            }

            $data = Redis::lpop('stock_queue');
            if ($data !== null) {
                echo "data: {$data}\n\n";
                flush();
            }
            sleep(1);
        }
    }
}
```
**Penjelasan:** Fungsi `connection_aborted()` hanya akan terbarui jika server telah mencoba mengirimkan sesuatu (seperti melakukan *echo* & *flush*), sehingga sangat krusial memanggilnya dalam blok siklus hidup worker. Ini menjaga thread agar dapat dihentikan secara wajar (graceful) dan membebaskan RAM.

---

### Anti-Pattern 2: Format Payload dan Manajemen Output Buffer yang Serampangan

❌ **KODE SALAH (Tidak Mengikuti Standar W3C SSE):**
Format data tidak sesuai, karakter pindah baris salah, atau mencoba menumpuk JSON secara cacat tanpa membersihkan buffer sampah PHP di awal request.

```php
<?php

declare(strict_types=1);

namespace App\Presentation\Http\Controllers;

use Illuminate\Http\Request;

final class BadFormattingController 
{
    public function __invoke(Request $request)
    {
        while (true) {
            $user = ['name' => 'John', 'status' => 'online'];
            $payload = json_encode($user, JSON_THROW_ON_ERROR);
            
            echo "data " . $payload . "\n";
            
            sleep(2);
        }
    }
}
```

✅ **KODE BENAR (Standard-Compliant SSE Stream):**
Memastikan kebersihan level eksekusi buffer, dan menggunakan konvensi penulisan event yang sempurna sesuai spesifikasi Web API.

```php
<?php

declare(strict_types=1);

namespace App\Presentation\Http\Controllers;

use Illuminate\Http\Request;

final class GoodFormattingController 
{
    public function __invoke(Request $request)
    {
        if (ob_get_level() > 0) {
            ob_end_clean(); 
        }

        while (true) {
            if (connection_aborted() === 1) { break; }
            
            $payload = json_encode(['name' => 'John', 'status' => 'online'], JSON_THROW_ON_ERROR);
            $eventId = uniqid('evt_', true);
            
            echo "id: {$eventId}\n";
            echo "event: status_update\n";
            echo "data: {$payload}\n\n"; 
            
            if (ob_get_level() > 0) {
                ob_flush();
            }
            flush();
            
            sleep(2);
        }
    }
}
```
**Penjelasan:** Web browser secara pakem mengandalkan string `\n\n` (dua karakter line feed) sebagai terminator parsial dari sebuah rentetan event streaming (Satu blok HTTP SSE). Kegagalan merangkai tag `data: `, `event: `, dan karakter `\n\n` akan mengakibatkan event handler Javascript `EventSource.onmessage()` diam seolah tidak terjadi apa-apa, membuat aplikasi frontend terlihat macet total.

---

## 7. Pest v3 Testing (Unit & Architecture)

Kita perlu menegaskan kualitas kode dan arsitektur Ticker Saham agar tahan banting dengan memanfaatkan Pest versi ketiga.

### A. Architecture Test (`tests/ArchTest.php`)

```php
<?php

declare(strict_types=1);

arch('Domain lapisan tidak boleh bergantung pada infrastruktur atau framework')
    ->expect('App\Domain')
    ->toUseNothing()
    ->ignoring(['InvalidArgumentException', 'DateTimeImmutable', 'JsonSerializable', 'Exception']);

arch('Domain Value Objects harus readonly final')
    ->expect('App\Domain\Stocks\ValueObjects')
    ->toBeFinal()
    ->toBeReadonly();

arch('Semua kelas PHP harus mendeskripsikan strict types')
    ->expect('App')
    ->toUseStrictTypes();
```

### B. Unit Test untuk Value Object (`tests/Unit/Domain/Stocks/ValueObjects/StockSymbolTest.php`)

```php
<?php

declare(strict_types=1);

use App\Domain\Stocks\ValueObjects\StockSymbol;

it('membuat instance untuk simbol saham yang formatnya valid', function () {
    $symbol = new StockSymbol('AAPL');
    
    expect($symbol->toString())->toBe('AAPL');
});

it('melemparkan exception InvalidArgumentException untuk format huruf yang tidak valid', function (string $invalidSymbol) {
    expect(fn () => new StockSymbol($invalidSymbol))
        ->toThrow(InvalidArgumentException::class, "Format simbol saham tidak valid: {$invalidSymbol}");
})->with([
    'huruf kecil semua' => ['aapl'],
    'karakter kepanjangan' => ['ABCDEF'],
    'mengandung kombinasi angka numerik' => ['AAPL1'],
    'string sangat kosong tak berisi' => [''],
]);
```

### C. Feature Test untuk Controller Streaming (`tests/Feature/Http/Controllers/StreamStockControllerTest.php`)

Menguji endpoint HTTP yang mengembalikan `StreamedResponse` sedikit rumit karena respons tersebut berusaha menguasai waktu eksekusi proses server seutuhnya. Solusinya, kita memok komponen Streamer agar hanya berjalan satu transisi pemanggilan callback lalu berhenti.

```php
<?php

declare(strict_types=1);

use App\Application\Stocks\Contracts\StockTickStreamerInterface;
use App\Domain\Stocks\Entities\StockTick;
use App\Domain\Stocks\ValueObjects\StockSymbol;
use Illuminate\Support\Str;
use Mockery\MockInterface;

it('mengembalikan response header dan data SSE format w3c event yang tepat', function () {
    $dummyId = Str::uuid()->toString();
    $dummyTick = new StockTick(
        id: $dummyId,
        symbol: new StockSymbol('GOOGL'),
        price: 150.25,
        timestamp: new DateTimeImmutable('2026-07-31T10:00:00+00:00'),
    );

    $this->mock(StockTickStreamerInterface::class, function (MockInterface $mock) use ($dummyTick) {
        $mock->shouldReceive('stream')
            ->once()
            ->andReturnUsing(function (Closure $callback) use ($dummyTick) {
                $callback($dummyTick);
            });
    });

    $response = $this->get('/api/v1/stocks/stream');

    $response->assertStatus(200);
    $response->assertHeader('Content-Type', 'text/event-stream');
    $response->assertHeader('Cache-Control', 'no-cache');
    $response->assertHeader('Connection', 'keep-alive');
    $response->assertHeader('X-Accel-Buffering', 'no');

    ob_start();
    $response->baseResponse->sendContent();
    $streamContent = ob_get_clean();

    $payloadJson = json_encode($dummyTick, JSON_THROW_ON_ERROR);
    $expectedOutput = "id: {$dummyId}\n" .
                      "event: price_update\n" .
                      "data: {$payloadJson}\n\n";

    expect($streamContent)->toBe($expectedOutput);
});
```

## Kesimpulan

Mekanisme Server-Sent Events membuktikan kemampuannya sebagai pendekatan mutakhir untuk menayangkan pasokan data sepihak dari arsitektur backend secara terus-menerus ke aplikasi antarmuka. Melalui adaptasi Laravel Octane untuk meleburkan beban RAM per pekerja eksekusi sinkron dan arsitektur modular yang memutus ikatan ketat antar elemen, Anda dapat menciptakan aliran riwayat bursa saham berkecepatan tinggi bagi ratusan ribu sesi aktif pengguna serentak. Perlindungan berlapis terhadap peretasan isolasi proses (menghindari penumpukan koneksi usang) serta penyesuaian lalu-lintas data proxy di tataran web server seperti Nginx adalah kunci utama pencapaian rekayasa piranti lunak berstandar global.
