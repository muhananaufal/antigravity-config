---
name: libvips_avif_image_engine
description: Panduan pemrosesan jutaan gambar dengan performa ultra-cepat menggunakan libvips (Intervention Image v3), kompresi AVIF, dan mekanisme edge caching di Laravel 11.
---

# Libvips & AVIF Image Engine untuk Skala Jutaan Aset

Dokumen ini mendefinisikan standar produksi untuk pemrosesan gambar di Laravel. Kita akan meninggalkan *PHP GD / Imagick* yang tua dan boros RAM. Sebaliknya, kita menerapkan **libvips** melalui `ext-vips` (atau Intervention Image v3 vips driver) untuk kecepatan JIT (*Just-In-Time*) dan efisiensi memori yang ekstrem.

## 1. Arsitektur JIT Image Processing & Edge Caching

Diagram di bawah menunjukkan alur manipulasi gambar secara instan (on-the-fly) yang dipadukan dengan CDN (seperti Cloudflare).

```text
+--------------+    Request Gambar (/img/300x300/avif/logo.jpg)    +---------------------+
|              | ------------------------------------------------> |  Cloudflare (Edge)  |
|  End Client  |                                                   |  Cache HIT?         |
|  (Browser)   | <------------------------------------------------ |                     |
+--------------+      Response Gambar dari Edge                    +----------+----------+
                                                                              | (Cache MISS)
                                                                              v
+-----------------------+   Baca Gambar Asli  +--------------------+  Req +---------------------+
|  Object Storage (S3)  | <------------------ | Laravel 11 (App)   | <--- | Nginx / Load Bal.   |
|  (Master Image)       |                     | (Glide / JIT Ctrl) |      +---------------------+
+-----------------------+ ------------------> +---------+----------+
                                                        | Manipulasi via libvips
                                                        v
                                              +--------------------+
                                              | ext-vips (Vips)    |
                                              | - Crop / Resize    |
                                              | - Convert ke AVIF  |
                                              | - Watermarking     |
                                              +---------+----------+
                                                        | Simpan ke cache lokal / CDN origin
                                                        v
                                                  (Response Stream)
```

## 2. Implementasi Produksi (PHP 8.3 + Laravel 11 + PHPStan Level 9)

### 2.1. Kelas Layanan Pemroses Gambar (ImageProcessor)

Pastikan dependensi `intervention/image` v3 diinstal dengan *driver* vips.

```php
<?php

declare(strict_types=1);

namespace App\Services\Media;

use Intervention\Image\ImageManager;
use Intervention\Image\Drivers\Vips\Driver;
use Intervention\Image\Encoders\AvifEncoder;
use Intervention\Image\Interfaces\ImageInterface;
use Illuminate\Support\Facades\Storage;
use RuntimeException;
use Throwable;

final class VipsImageProcessor
{
    private ImageManager $manager;

    public function __construct()
    {
        // Instansiasi manager dengan driver Vips
        $this->manager = new ImageManager(new Driver());
    }

    /**
     * Optimasi dan resize gambar, konversi ke AVIF.
     *
     * @param string $sourcePath Path ke file asli (contoh: storage lokal atau s3)
     * @param int $width Lebar target
     * @param int $height Tinggi target
     * @return string Konten byte gambar hasil
     * @throws RuntimeException Jika gagal memproses
     */
    public function createOptimizedAvif(string $sourcePath, int $width, int $height): string
    {
        try {
            $sourceData = Storage::disk('s3')->get($sourcePath);
            
            if ($sourceData === null) {
                throw new RuntimeException("Source image not found: {$sourcePath}");
            }

            /** @var ImageInterface $image */
            $image = $this->manager->read($sourceData);

            // Resize and crop intelligently (fit)
            $image->cover($width, $height);

            // Watermark opsional
            // $watermark = $this->manager->read(Storage::get('watermark.png'));
            // $image->place($watermark, 'bottom-right', 10, 10);

            // Encode to AVIF dengan kualitas 80
            return (string) $image->encode(new AvifEncoder(quality: 80));
            
        } catch (Throwable $exception) {
            throw new RuntimeException(
                "Image processing failed for [{$sourcePath}]: " . $exception->getMessage(),
                (int) $exception->getCode(),
                $exception
            );
        }
    }
}
```

### 2.2. JIT Controller (On-the-fly Image Delivery)

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Services\Media\VipsImageProcessor;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Http\Request;

final class ImageDeliveryController
{
    public function __construct(
        private readonly VipsImageProcessor $processor
    ) {}

    public function show(Request $request, int $width, int $height, string $path): Response
    {
        // Proteksi dimensi ekstrem untuk mencegah DDoS berbasis resize
        if ($width > 2000 || $height > 2000) {
            abort(400, 'Dimensions too large');
        }

        $cacheKey = "img_{$width}_{$height}_{$path}";

        // Simpan hasil resize di Redis/Lokal selama 1 bulan
        $imageData = Cache::remember($cacheKey, now()->addDays(30), function () use ($width, $height, $path) {
            return $this->processor->createOptimizedAvif($path, $width, $height);
        });

        return response($imageData, 200, [
            'Content-Type' => 'image/avif',
            'Cache-Control' => 'public, max-age=31536000, immutable', // Instruksi CDN edge caching
        ]);
    }
}
```

## 3. Pest v3 Tests (Architecture & Unit)

```php
<?php

use App\Services\Media\VipsImageProcessor;
use Illuminate\Support\Facades\Storage;
use Intervention\Image\Exception\DecoderException;

test('it successfully converts image to avif and resizes using vips', function () {
    Storage::fake('s3');
    // Asumsikan ada dummy jpg valid untuk tes (dalam riil gunakan dummy bytes valid)
    $dummyImage = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');
    Storage::disk('s3')->put('original/logo.png', $dummyImage);

    $processor = new VipsImageProcessor();
    $result = $processor->createOptimizedAvif('original/logo.png', 100, 100);

    expect($result)->not->toBeEmpty();
    // Bisa tambahkan asersi mime type / format
});

test('it throws exception on invalid source', function () {
    Storage::fake('s3');
    Storage::disk('s3')->put('original/bad.jpg', 'not-an-image');

    $processor = new VipsImageProcessor();
    
    // Ekspektasi runtime exception karena gagal decoding
    $processor->createOptimizedAvif('original/bad.jpg', 100, 100);
})->throws(RuntimeException::class);
```

## 4. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menggunakan GD/Imagick untuk Gambar Skala Besar
Menggunakan GD (`imagecreatefromjpeg`) akan membengkakkan memori (bisa memakan 200MB+ per gambar untuk resolusi 4K).
```php
// ❌ SALAH: Memori akan cepat habis (OOM)
$img = imagecreatefromjpeg('large-4k.jpg'); 
```
**✅ SOLUSI:** Gunakan `ext-vips`. Libvips menggunakan pemrosesan *streaming* yang membatasi RAM hingga hitungan belasan MB saja terlepas dari ukuran dimensi input.

### ❌ Anti-Pattern 2: Dynamic Resize Tanpa Whitelisting/Proteksi
Mengekspos endpoint `/img/{width}x{height}/{path}` secara terbuka.
```php
// ❌ SALAH: Attacker dapat memanggil script ini 1.000 kali dengan resolusi acak (1x1, 1x2, 1x3, dst.)
Route::get('/img/{width}/{height}/{path}', [ImageCtrl::class, 'show']);
```
**✅ SOLUSI:** Terapkan pembatasan dimensi maksimum (misal max 2000px) dan gunakan *URL Signature* (HMAC hash) untuk memastikan parameter tidak dapat diubah-ubah oleh klien sesuka hati (mencegah *Cache poisoning* / *CPU exhaustion*).

## 5. Production Edge Cases

1. **Fallback Format:**
   Meskipun AVIF memiliki kompresi luar biasa (30% lebih kecil dari WebP), browser lama (Safari lama, IE) tidak mendukungnya. Gunakan `<picture>` tag di HTML dan HTTP header `Accept` sniffing untuk melakukan *fallback* otomatis ke WebP atau JPEG di level Nginx / Controller.

2. **File Descriptor Limits (Too many open files):**
   Libvips sangat agresif memproses gambar paralel secara multithread. Pada trafik tinggi, proses PHP (FPM/Octane) dapat kehabisan *file descriptor*. Pastikan `ulimit -n` pada OS Linux di set sangat tinggi (misal `65535` atau `1000000`).

3. **Memory Leaks pada Daemon Berjalan Lama (Octane):**
   Meskipun vips hemat, dalam arsitektur Laravel Octane (Swoole/FrankenPHP), ekstensi C kadang bisa menahan memori *(memory drift)*. Konfigurasikan `max_requests` di Octane (misal di angka 500) agar *worker* di-*respawn* secara berkala untuk membersihkan alokasi memori *native*.
