# Multi-Region SEO Routing & URL Persistence

Dokumen ini menjelaskan strategi Enterprise dalam menangani struktur *Routing* lintas negara dan bahasa. Arsitektur berfokus pada optimasi mesin pencari (SEO) melalui *Hreflang*, serta persistensi (penyimpanan berkelanjutan) preferensi bahasa pengguna (seperti dari HTTP URL ber-prefiks `/id-id/`) hingga ke dalam sistem pekerja asinkron (*Background Jobs Payload*).

## Arsitektur Alur Routing Multi-Namespace & Propagasi

```ascii
[Request Masuk] -> `https://www.toko.com/id-id/katalog`
                           |
                           v
          [Route Group dengan Prefix `{locale}`]
                           |
                           v
               [Locale Identification Middleware]
          1. Ekstrak `id-id` (Language: id, Region: ID)
          2. Set `App::setLocale('id')`
          3. Simpan state user timezone & region
                           |
                           v
                   [Controller / View]
          Men-generate tag SEO: <link rel="alternate" hreflang="en-sg" href="...">
                           |
                           v
           [Membuat Job: ProcessOrder::dispatch()] 
    (Trait InteractsWithLocale -> Menyerap `App::getLocale()` otomatis)
                           |
                           v
              [Redis Queue (Background Worker)]
    (Worker restore locale `id-id` sebelum execute Job di terminal/Daemon)
```

## Spesifikasi Teknis

### 1. Registrasi Prefix Route Dinamis (Multi-Region)

Menempatkan *locale* sebagai segmen pertama URL adalah praktik terbaik SEO global. Hal ini memastikan setiap variasi bahasa/wilayah memiliki URL uniknya sendiri yang dapat diindeks Google.

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Routing;

use Illuminate\Support\Facades\Route;

final class RouteRegistrar
{
    /**
     * Daftar locale region resmi yang didukung (Format: {lang}-{region}).
     */
    public const SUPPORTED_LOCALES = ['id-id', 'en-sg', 'en-my', 'ms-my'];

    public static function register(): void
    {
        $regex = implode('|', self::SUPPORTED_LOCALES);

        // Group route ini memaksa argumen pertama URL menjadi locale
        Route::prefix('{locale}')
            ->where(['locale' => $regex])
            ->middleware([\App\Http\Middleware\SetRegionLocale::class])
            ->group(function () {
                
                Route::get('/catalog', [\App\Http\Controllers\CatalogController::class, 'index'])
                    ->name('catalog.index');
                    
                // Route lainnya...
            });
            
        // Fallback root `/` ke default region (Redirect)
        Route::get('/', function () {
            return redirect('/id-id/catalog', 301);
        });
    }
}
```

### 2. Middleware Preservasi Bahasa (`SetRegionLocale`)

Menangkap parameter rute `{locale}`, mengekstrak bahasa dan wilayah, lalu menetapkannya ke dalam aplikasi (*Service Container*). Penting: Jangan lupa menghilangkan parameter `{locale}` agar metode *Controller* tidak secara tidak sengaja perlu menerima `$locale` sebagai argumen pertamanya.

```php
<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\App;
use Illuminate\Support\Facades\URL;
use Symfony\Component\HttpFoundation\Response;

final class SetRegionLocale
{
    public function handle(Request $request, Closure $next): Response
    {
        /** @var string $localeParam */
        $localeParam = $request->route('locale');

        // Pisahkan format "id-id" menjadi "id" (language)
        $parts = explode('-', $localeParam);
        $language = $parts[0] ?? 'id';
        
        App::setLocale($language);
        
        // Simpan region ke container agar bisa diakses layanan harga/pajak
        app()->instance('app.region', strtoupper($parts[1] ?? 'ID'));

        // Hilangkan parameter locale dari request agar tidak diteruskan ke method Controller
        $request->route()->forgetParameter('locale');

        // Pastikan setiap URL helper () Laravel otomatis menyisipkan `{locale}` ini 
        // saat membangun link (contoh: route('catalog.index'))
        URL::defaults(['locale' => $localeParam]);

        return $next($request);
    }
}
```

### 3. Propagasi Locale ke Job Queue (`HasLocalePreference`)

Jika user melakukan pemesanan via `/id-id/checkout`, pekerja latar belakang (*worker queue*) yang memproses email atau PDF *invoice* asinkron HARUS berjalan di zona waktu dan *locale* tersebut. Laravel memiliki fitur bawaan untuk ini (melalui kontrak `HasLocalePreference`), tapi sering dilupakan.

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Auth\Models;

use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Contracts\Translation\HasLocalePreference;

final class User extends Authenticatable implements HasLocalePreference
{
    /**
     * Memaksa seluruh Job, Notifications, & Mails untuk dikirim
     * menggunakan preferensi bahasa user ini, meskipun Worker Daemon 
     * berjalan pada setting EN (default server).
     */
    public function preferredLocale(): string
    {
        // Pastikan kolom DB 'locale' (misal: "id") tersimpan saat pendaftaran
        return $this->locale ?? 'en'; 
    }
}
```

Jika job di-*dispatch* bukan oleh entitas User (contoh: job reguler anonim dari form), gunakan sifat ini.

```php
<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;

// Job ini akan mengingat App::getLocale() secara mandiri
class SendReportJob implements ShouldQueue
{
    use Dispatchable, Queueable;
    
    public string $locale;
    
    public function __construct()
    {
        // Tangkap dari state request saat job dipanggil!
        $this->locale = app()->getLocale();
    }
    
    public function handle(): void
    {
        app()->setLocale($this->locale);
        // Teruskan pekerjaan yang spesifik bahasa
    }
}
```

## Anti-Patterns Kritis

#### ❌ 1. Mengandalkan `Accept-Language` Header Saja
Mengandalkan HTTP Header `Accept-Language` atau *Cookie* (tanpa memutasi segmen URL) untuk mengubah konten bahasa di satu endpoint yang sama (contoh `/catalog`).

```php
// SALAH: Satu URL, dua konten berbeda. Bot Googlebot tidak mengirim "Accept-Language: id".
// Google hanya akan melihat versi default (inggris) dan gagal mengindeks versi Indonesia.
public function handle(Request $request, Closure $next) {
    App::setLocale($request->header('Accept-Language')); 
}
```

```php
// BENAR: Pisahkan secara absolut via segmentasi URL (/id/catalog, /en/catalog).
// Header digunakan HANYA saat request pertama kali masuk ke / root, lalu redirect 301/302.
```

#### ❌ 2. Mengabaikan Generasi Hreflang Tags di View
Memiliki *multiple region* tanpa menautkan mereka. Mesin pencari dapat menghukum aplikasi sebagai duplikasi konten (*Duplicate Content Penalty*).

```html
<!-- SALAH: Tidak ada indikasi keterkaitan antar wilayah web -->
<title>Katalog Kami</title>
```

```html
<!-- BENAR: Hreflang Tag dipasang pada `<head>` setiap halaman perutean -->
<link rel="alternate" hreflang="id-ID" href="https://toko.com/id-id/catalog" />
<link rel="alternate" hreflang="en-SG" href="https://toko.com/en-sg/catalog" />
<link rel="alternate" hreflang="x-default" href="https://toko.com/en-sg/catalog" />
```

## Production Edge Cases

1. **Locale URL Params Bentrok dengan Resource Controller ID:**
   - *Masalah:* Karena `URL::defaults(['locale'])` menyisipkan *locale* ke setiap argumen route secara implisit, controller yang menampung ID terkadang tergeser injeksinya (misal param pertama `locale`, parameter kedua `id`).
   - *Solusi:* Tindakan `$request->route()->forgetParameter('locale');` di middleware (poin 2) wajib dilakukan agar pemetaan parameter ID dan objek injeksi Model Binding Laravel tidak patah/bergeser urutannya.

2. **Downtime Cache Route:**
   - *Masalah:* Menggunakan Regex dinamis dalam definisi `where(['locale'])` dengan nilai array/konstanta. Jika array tersebut disedot dari Database secara dinamis, command `php artisan route:cache` akan *crash* saat server dijalankan (karena DB belum terkoneksi saat compile cache).
   - *Solusi:* Konstanta *supported locales* HARUS bersifat *hardcoded* di Config file atau Class konstanta (statik) agar route dapat ter-cache (seperti `SUPPORTED_LOCALES` di atas).

3. **Duplikat Slug untuk Entitas Translasional:**
   - *Masalah:* Anda memiliki URL `/id-id/katalog/sepeda-merah` (ID) dan `/en-sg/catalog/red-bike` (EN). Bagaimana sistem tahu kalau keduanya menunjuk produk yang sama tanpa menebak-nebak (SQL lambat)?
   - *Solusi:* Buat tabel Pivot untuk Slug (misal tabel `product_slugs` dengan kolom `product_id, locale, slug`). Query yang mencari produk menggunakan korelasi spesifik `locale` tersebut.

## Testing Terpadu (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Http\Middleware\SetRegionLocale;
use Illuminate\Http\Request;
use Illuminate\Routing\Route;
use Illuminate\Support\Facades\App;
use Illuminate\Support\Facades\URL;

covers(SetRegionLocale::class);

test('middleware extracts locale and region correctly from route', function () {
    $request = Request::create('/id-id/catalog');
    
    // Bind mock route with parameter
    $route = new Route(['GET'], '/{locale}/catalog', []);
    $route->bind($request);
    $route->setParameter('locale', 'id-id');
    
    $request->setRouteResolver(fn() => $route);
    
    $middleware = new SetRegionLocale();
    
    $middleware->handle($request, function ($req) {
        // Assert locale parameter is forgotten from route to avoid controller argument injection mess
        expect($req->route()->hasParameter('locale'))->toBeFalse();
        return new \Symfony\Component\HttpFoundation\Response();
    });
    
    // Assert Application language is mutated
    expect(App::getLocale())->toBe('id')
        // Assert Region context is saved
        ->and(app('app.region'))->toBe('ID')
        // Assert URL generator defaults to id-id for future links
        ->and(URL::getDefaultParameters()['locale'] ?? null)->toBe('id-id');
});

test('middleware defaults safely on malformed locale formats', function () {
    $request = Request::create('/en/catalog');
    
    $route = new Route(['GET'], '/{locale}/catalog', []);
    $route->bind($request);
    $route->setParameter('locale', 'en'); // missing region suffix
    
    $request->setRouteResolver(fn() => $route);
    
    $middleware = new SetRegionLocale();
    
    $middleware->handle($request, fn($r) => new \Symfony\Component\HttpFoundation\Response());
    
    expect(App::getLocale())->toBe('en')
        ->and(app('app.region'))->toBe('ID'); // Fallback default region
});
```
