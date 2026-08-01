# HTTP Cache-Control & CDN Edge Invalidation via Model Events

Dokumen ini mendeskripsikan integrasi kasta tertinggi (Tier 1) antara sistem backend API Laravel dengan Edge CDN tier (Cloudflare, Fastly, AWS CloudFront). Alih-alih melayani *read requests* langsung dari server Laravel, kita mengalihkan (offload) 99% HTTP GET requests ke server Edge di seluruh dunia via header `Cache-Control` agresif, dengan sistem *webhook invalidation* atau *API Purging* otomatis setiap kali ada entitas Eloquent yang berubah (`saved`, `deleted`).

## Diagram ASCII: CDN Edge Caching & Purge Flow

```ascii
[ User di Tokyo ]        [ User di New York ]
        |                         |
        v                         v
(CDN Edge Tokyo)          (CDN Edge New York)
        |                         |
        +------------+------------+ (99% Hit rate dilayani oleh CDN: Latency 10ms)
                     |
            (Miss / Purged)
                     |
                     v
             [ Laravel Server API ]
           (Generate JSON + ETag)
                     |
   -------------------------------------------------
  | EVENT TRIGGER: Model Post::updated()            |
  | Eloquent Observer berjalan secara Asinkron      |
  | Queue: POST https://api.cloudflare.com/purge    |
  | CDN Nodes membersihkan (Purge) cache terkait    |
   -------------------------------------------------
```

## Implementasi Kode Produksi (PHP 8.3 / Laravel 11)

### 1. Middleware HTTP Response Headers

Middleware ini menyuntikkan header cache `stale-while-revalidate` (mengizinkan CDN mengirim data usang sesaat selagi mengambil data baru di background), dan ETag.

```php
<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Applies aggressive Edge caching directives to public API responses.
 * Enforces strict types.
 */
final class ApplyEdgeCacheHeaders
{
    private const int MAX_AGE_SECONDS = 3600; // 1 Hour in browser
    private const int S_MAXAGE_SECONDS = 86400; // 24 Hours in CDN Edge
    private const int STALE_WHILE_REVALIDATE = 600; // 10 Minutes grace period

    /**
     * Handle an incoming request.
     *
     * @param Closure(Request): (Response) $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);

        // Hanya terapkan cache pada GET requests dengan Response sukses (200 OK)
        if (! $request->isMethodSafe() || $response->getStatusCode() !== 200) {
            return $response;
        }

        $content = $response->getContent();
        if ($content === false) {
            return $response;
        }

        // Generate ETag for conditional requests (If-None-Match)
        $etag = md5($content);
        $response->setEtag($etag);

        // If client sent valid ETag, abort sending body and return 304 Not Modified
        if ($request->getETags() !== [] && in_array('"' . $etag . '"', $request->getETags(), true)) {
            $response->setNotModified();
            return $response;
        }

        // Apply Edge directives
        // public: allows any CDN/proxy to cache
        // max-age: client browser caching
        // s-maxage: shared cache (CDN) caching override
        // stale-while-revalidate: async background refresh gracefully
        $response->setCache([
            'public' => true,
            'max_age' => self::MAX_AGE_SECONDS,
            's_maxage' => self::S_MAXAGE_SECONDS,
            'stale_while_revalidate' => self::STALE_WHILE_REVALIDATE,
        ]);
        
        // Custom header to map CDN Surrogate Keys (used for targeted purging)
        // e.g. Surrogate-Key: catalog, category-5, product-10
        $response->headers->set('Surrogate-Key', $this->extractSurrogateKeys($request));

        return $response;
    }

    private function extractSurrogateKeys(Request $request): string
    {
        // Contoh logika: jika routing ke /api/products, attach tag 'products'
        $path = $request->path();
        return str_replace('/', '-', $path); 
    }
}
```

### 2. Job Queue Purge CDN via Eloquent Observer

Saat model diubah, kita melempar Job ke antrean untuk melakukan purge pada API Cloudflare / Fastly.

```php
<?php

declare(strict_types=1);

namespace App\Jobs\Cdn;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Asynchronously purges Cloudflare CDN edge nodes using Cache-Tags / Surrogate-Keys.
 */
final class PurgeCdnCacheJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 3;

    /**
     * @param array<string> $tags Array of surrogate keys to purge (e.g. ['product-5', 'catalog'])
     */
    public function __construct(private readonly array $tags)
    {
    }

    public function handle(): void
    {
        $zoneId = config('services.cloudflare.zone_id');
        $apiToken = config('services.cloudflare.token');

        if (! is_string($zoneId) || ! is_string($apiToken)) {
            Log::warning('Cloudflare credentials not configured. Purge skipped.');
            return;
        }

        $response = Http::withToken($apiToken)
            ->post("https://api.cloudflare.com/client/v4/zones/{$zoneId}/purge_cache", [
                'tags' => $this->tags,
            ]);

        if ($response->failed()) {
            throw new \RuntimeException("CDN Purge failed: " . $response->body());
        }

        Log::info("CDN successfully purged for tags: " . implode(', ', $this->tags));
    }
}
```

## Anti-Patterns & Best Practices

❌ **Anti-Pattern 1: Mengatur `Cache-Control: public` pada Route yang memiliki Data User Spesifik**
**Salah:** Rute `/api/profile` direturn dengan `max-age=3600, public`.
**Bahaya:** Data rahasia user A yang pertama kali meminta API akan dicache oleh CDN Cloudflare. Saat User B membuka URL yang sama, Cloudflare mengirimkan profil User A! Kebocoran privasi fatal!
✅ **Benar:** Hanya gunakan `public` dan Edge Caching untuk data umum tanpa autentikasi (katalog, artikel blog, daftar kategori). Untuk route personalisasi (auth route), gunakan `Cache-Control: private`.

❌ **Anti-Pattern 2: Sinkronisasi Purge ke API Eksternal di dalam Observers**
**Salah:** Melakukan `Http::post(...)` langsung di dalam event `Model::saved()`.
**Bahaya:** Memblokir latensi HTTP response ke klien saat proses save. Terlebih jika API Cloudflare sedang lambat, *request* save akan timeout.
✅ **Benar:** CDN Invalidation API HTTP request WAJIB dibungkus di dalam Asynchronous Job/Queue (seperti `PurgeCdnCacheJob`).

## Production Edge Cases

1. **Volume Purge yang Membludak (Rate Limiting CDN):**
   *Skenario:* Fitur "Update Massal Harga" mengubah 10.000 produk. Eloquent me-dispatch 10.000 Queue Purge API. API Cloudflare menolak dengan HTTP 429 Rate Limit.
   *Mitigasi:* Implementasikan batching. Kumpulkan tags yang akan dipurge di suatu cache storage sementara selama 5 detik, lalu jalankan 1 single Job yang mengirimkan array berisi maksimum 30 tag (batas Cloudflare) per HTTP POST.

2. **Dilema Tagging Cache (Granular vs General Purge):**
   *Skenario:* Membersihkan cache tag global `catalog` mengakibatkan *seluruh* daftar pencarian hilang dan me-rebuild cache dari database secara drastis, memicu CPU Spike.
   *Mitigasi:* Gunakan Surrogate-Key secermat mungkin (granular). Misal: `catalog-category-5` daripada sekedar `catalog`.

3. **HTTP `ETag` Generasi CPU Overhead:**
   *Skenario:* Menghitung `md5()` untuk response JSON berukuran 10MB membebani CPU.
   *Mitigasi:* Jangan mengenerate ETag di level response Laravel jika payload sangat besar. Biarkan Nginx atau CDN edge yang secara otomatis memproduksi ETag di layer proxy mereka.

## Unit / Arch Testing (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Http\Middleware\ApplyEdgeCacheHeaders;
use App\Jobs\Cdn\PurgeCdnCacheJob;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use Illuminate\Support\Facades\Http;

it('attaches proper edge caching headers and surrogate keys on successful get request', function () {
    $middleware = new ApplyEdgeCacheHeaders();
    $request = Request::create('/api/catalog', 'GET');
    
    // Mock response closure
    $next = fn() => new Response('{"data":"test"}', 200);

    /** @var Response $response */
    $response = $middleware->handle($request, $next);

    expect($response->headers->get('Cache-Control'))->toContain('public', 's-maxage=86400', 'stale-while-revalidate=600')
        ->and($response->headers->get('Surrogate-Key'))->toBe('api-catalog')
        ->and($response->headers->get('ETag'))->not->toBeNull();
});

it('returns 304 Not Modified if client sends matching ETag', function () {
    $middleware = new ApplyEdgeCacheHeaders();
    $request = Request::create('/api/catalog', 'GET');
    
    // The md5 of '{"data":"test"}' is 66a3cc460593b49911e3b618cfed3f37
    $request->headers->set('If-None-Match', '"66a3cc460593b49911e3b618cfed3f37"');
    
    $next = fn() => new Response('{"data":"test"}', 200);

    /** @var Response $response */
    $response = $middleware->handle($request, $next);

    expect($response->getStatusCode())->toBe(304) // HTTP 304
        ->and($response->getContent())->toBeEmpty(); // Empty body
});

it('dispatches http purge request correctly', function () {
    Http::fake([
        'api.cloudflare.com/*' => Http::response(['success' => true], 200),
    ]);

    // Setup config dummy
    config(['services.cloudflare.zone_id' => 'abc', 'services.cloudflare.token' => 'xyz']);

    $job = new PurgeCdnCacheJob(['catalog-1']);
    $job->handle();

    // Assert request format
    Http::assertSent(function ($request) {
        return $request->hasHeader('Authorization', 'Bearer xyz') &&
               $request->data()['tags'][0] === 'catalog-1';
    });
});
```
