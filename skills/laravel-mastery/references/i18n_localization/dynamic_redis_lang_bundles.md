# Dynamic Redis Language Bundles & Missing Key Tracker

Dokumen ini mendemonstrasikan arsitektur pelokalan (*localization*) tingkat lanjut untuk aplikasi Laravel berskala enterprise. Sistem ini menggantikan file terjemahan statis `.php`/`.json` dengan repository database terpusat yang di-cache menggunakan Redis, mendeteksi secara otomatis *string* (kunci bahasa) yang hilang, serta menerapkan sistem *fallback locale* secara berjenjang (*cascading*).

## Arsitektur Kaskade Bahasa & Missing Key Tracker

```ascii
[Trans() / __()] 
       |
       v
 [Custom Translator (extends Illuminate\Translation\Translator)]
       |
       +---> Cek locale saat ini (contoh: id_ID)
       |
       v
  [Redis Cache Layer] ---> Ada? --> Return Translation
       | (Miss)
       v
 [Database Translations Table] 
       |---> Ada? --> Cache ke Redis & Return
       | (Miss)
       v
 [Fallback Cascade]
  Coba ms_MY -> Coba en_US
       |
       v
  Jika semua gagal? ---> Dispatch [MissingKeyFound Event] ---> (Queue) -> Simpan ke DB sbg "missing"
       |
       v
 Return Key String ("messages.greeting")
```

## Spesifikasi Teknis

### 1. Database Model & Migration

Struktur tabel untuk menyimpan terjemahan dinamis.

```php
<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('language_lines', function (Blueprint $table) {
            $table->id();
            $table->string('group')->index(); // e.g. 'messages', 'validation'
            $table->string('key');            // e.g. 'welcome_user'
            $table->json('text');             // e.g. {"en": "Welcome", "id": "Selamat datang"}
            $table->boolean('is_missing')->default(false)->index();
            $table->timestamps();
            
            $table->unique(['group', 'key']);
        });
    }
    
    public function down(): void
    {
        Schema::dropIfExists('language_lines');
    }
};
```

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Localization\Models;

use Illuminate\Database\Eloquent\Model;

final class LanguageLine extends Model
{
    protected $table = 'language_lines';
    
    protected $fillable = ['group', 'key', 'text', 'is_missing'];
    
    protected $casts = [
        'text' => 'array',
        'is_missing' => 'boolean',
    ];
}
```

### 2. Kustom Loader & Redis Cache

Class ini menggantikan file loader bawaan Laravel. Ia memuat data dari Redis atau Database.

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Localization;

use App\Infrastructure\Localization\Models\LanguageLine;
use Illuminate\Contracts\Translation\Loader;
use Illuminate\Support\Facades\Cache;

final class DatabaseTranslationLoader implements Loader
{
    /**
     * @param string $locale
     * @param string $group
     * @param string|null $namespace
     * @return array<string, string>
     */
    public function load($locale, $group, $namespace = null): array
    {
        if ($namespace !== null && $namespace !== '*') {
            return [];
        }

        $cacheKey = "translations.{$locale}.{$group}";

        /** @var array<string, string> $translations */
        $translations = Cache::tags(['translations'])->rememberForever($cacheKey, function () use ($locale, $group): array {
            return LanguageLine::query()
                ->where('group', $group)
                ->get()
                ->mapWithKeys(function (LanguageLine $line) use ($locale): array {
                    $text = is_array($line->text) ? $line->text : [];
                    return [$line->key => $text[$locale] ?? null];
                })
                ->filter()
                ->toArray();
        });

        return $translations;
    }

    public function addNamespace($namespace, $hint): void
    {
        // Not used in DB approach
    }

    public function addJsonPath($path): void
    {
        // Not used in DB approach
    }

    public function namespaces(): array
    {
        return [];
    }
}
```

### 3. Kustom Translator (Kaskade Fallback & Missing Tracker)

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Localization;

use App\Infrastructure\Localization\Models\LanguageLine;
use Illuminate\Translation\Translator as BaseTranslator;
use Illuminate\Support\Facades\Log;

final class DynamicTranslator extends BaseTranslator
{
    /**
     * @var array<string, string[]>
     */
    private const CASCADE_RULES = [
        'id_ID' => ['ms_MY', 'en_US'],
        'fr_FR' => ['fr_CA', 'en_US'],
    ];

    /**
     * Get the translation for the given key, with cascading fallback.
     */
    public function get($key, array $replace = [], $locale = null, $fallback = true): string|array
    {
        $requestedLocale = $locale ?: $this->locale;
        
        // 1. Coba locale utama
        $translation = parent::get($key, $replace, $requestedLocale, false);
        
        if ($translation !== $key) {
            return $translation;
        }

        // 2. Coba cascading fallbacks (jika ada)
        if ($fallback && isset(self::CASCADE_RULES[$requestedLocale])) {
            foreach (self::CASCADE_RULES[$requestedLocale] as $fallbackLocale) {
                $fallbackTrans = parent::get($key, $replace, $fallbackLocale, false);
                if ($fallbackTrans !== $key) {
                    return $fallbackTrans;
                }
            }
        }
        
        // 3. Fallback sistem default Laravel (misal: 'en')
        if ($fallback && $requestedLocale !== $this->fallback) {
            $systemFallback = parent::get($key, $replace, $this->fallback, false);
            if ($systemFallback !== $key) {
                return $systemFallback;
            }
        }

        // 4. Track Missing Key
        $this->recordMissingKey($key);

        return $key;
    }

    private function recordMissingKey(string $key): void
    {
        // Prevent recursive loops for validation rules etc.
        if (str_contains($key, 'validation.') || count(explode('.', $key)) !== 2) {
            return;
        }

        [$group, $item] = explode('.', $key, 2);

        // Jangan blok request user, idealnya dispatch event ke antrian Queue
        try {
            LanguageLine::firstOrCreate(
                ['group' => $group, 'key' => $item],
                ['text' => [], 'is_missing' => true]
            );
        } catch (\Throwable $e) {
            Log::warning('Failed to record missing translation key', ['key' => $key, 'err' => $e->getMessage()]);
        }
    }
}
```

### 4. Service Provider Registration

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Localization;

use Illuminate\Translation\TranslationServiceProvider as BaseProvider;

final class TranslationServiceProvider extends BaseProvider
{
    protected function registerLoader(): void
    {
        $this->app->singleton('translation.loader', function () {
            return new DatabaseTranslationLoader();
        });
    }

    public function register(): void
    {
        $this->registerLoader();

        $this->app->singleton('translator', function ($app) {
            $loader = $app['translation.loader'];
            $locale = $app['config']['app.locale'];

            $trans = new DynamicTranslator($loader, $locale);
            $trans->setFallback($app['config']['app.fallback_locale']);

            return $trans;
        });
    }
}
```

## Anti-Patterns Kritis

#### ❌ 1. N+1 Redis Calls per View Render
Memuat terjemahan satu per satu secara individual membebani Redis. Jika sebuah halaman me-render tabel dengan 50 baris dan setiap baris memiliki 3 key terjemahan, ini akan menghasilkan 150 panggilan jaringan ke Redis.

```php
// SALAH: Loader meminta Redis (atau DB) untuk satu key setiap kali Translator::get dipanggil.
$text = Redis::get("trans.{$locale}.{$key}");
```

```php
// BENAR: Loader memuat satu `group` (misal seluruh `messages.php`) sekaligus dan dicache bersamaan.
Cache::remember("translations.{$locale}.{$group}", fn() => ...);
```

#### ❌ 2. Sync DB Writes untuk Missing Keys
Menulis baris ke database untuk mencatat "missing key" secara sinkron saat merender halaman (seperti contoh blok `#4` di dalam Translator).

```php
// SALAH: Jika ribuan user membuka page dengan 5 missing keys, DB akan di-hammer dengan ribuan INSERT syncs. Ini menyebabkan tabel locking dan page latency yang sangat lambat.
LanguageLine::firstOrCreate(...);
```

```php
// BENAR: Dispatch sebuah Queueable Event secara asinkron atau kirim data via UDP (statsD/Datadog) untuk diolah secara background, menghindari block pada request utama.
MissingTranslationFound::dispatch($group, $item);
```

## Production Edge Cases

1. **Cache Stampede saat Cache Clear:**
   - *Masalah:* Ketika tim translasi mereset cache Redis (setelah update translasi), ratusan request PHP-FPM secara bersamaan menemui *cache miss* dan semuanya mengeksekusi kueri `LanguageLine::get()`, menumpuk beban pada database.
   - *Solusi:* Gunakan lock mekanisme. Implementasikan `$lock = Cache::lock()` atau regenerasi cache di background lewat cron job / artisan command (`artisan trans:warm-cache`) tanpa pernah membersihkan cache yang lama.

2. **JSON Data Bloat pada Kolom `text`:**
   - *Masalah:* Seiring aplikasi mendukung 50 bahasa, JSON pada kolom `text` membesar. Ketika di-*decode* oleh PHP dan dimasukkan ke array cache per bahasa, alokasi memori berlebihan terjadi.
   - *Solusi:* Daripada menyimpan semua bahasa pada 1 kolom JSON, normalisasi struktur (tabel `language_line_translations` relasi `1:M`), atau pastikan Loader hanya meng-*fetch* JSON property yang relevan lewat SQL JSON path (`WHERE text->'$.en'`).

3. **Fallback Looping Infinite Recursive:**
   - *Masalah:* Jika logika *cascading fallback* tidak terjaga batasnya, ia dapat mengalami loop abadi. Contoh: `id_ID` fallback ke `ms_MY`, tapi sebuah bug di config me-route balik `ms_MY` ke `id_ID`.
   - *Solusi:* Selalu validasi bahwa stack yang diakses dalam array cascade tidak mengandung locale yang sedang diproses. Batasi kedalaman iterasi maksimum.

## Testing Terpadu (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Infrastructure\Localization\DynamicTranslator;
use App\Infrastructure\Localization\DatabaseTranslationLoader;
use App\Infrastructure\Localization\Models\LanguageLine;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Event;

uses(RefreshDatabase::class);

covers(DynamicTranslator::class);
covers(DatabaseTranslationLoader::class);

beforeEach(function () {
    Cache::flush();
});

test('it loads translation from database and caches it', function () {
    LanguageLine::create([
        'group' => 'messages',
        'key' => 'welcome',
        'text' => ['id_ID' => 'Selamat Datang', 'en_US' => 'Welcome']
    ]);

    $loader = new DatabaseTranslationLoader();
    $translator = new DynamicTranslator($loader, 'id_ID');
    $translator->setFallback('en_US');

    expect($translator->get('messages.welcome'))->toBe('Selamat Datang');
    
    // Ensure it was cached
    expect(Cache::tags(['translations'])->has('translations.id_ID.messages'))->toBeTrue();
});

test('it cascades down to fallback languages', function () {
    LanguageLine::create([
        'group' => 'messages',
        'key' => 'only_ms',
        'text' => ['ms_MY' => 'Selamat Datang (MS)'] // Not in id_ID
    ]);

    $loader = new DatabaseTranslationLoader();
    // Test cascading rule: id_ID -> ms_MY
    $translator = new DynamicTranslator($loader, 'id_ID');
    $translator->setFallback('en_US');

    expect($translator->get('messages.only_ms'))->toBe('Selamat Datang (MS)');
});

test('it tracks missing translation keys dynamically', function () {
    $loader = new DatabaseTranslationLoader();
    $translator = new DynamicTranslator($loader, 'id_ID');
    $translator->setFallback('en_US');

    $result = $translator->get('frontend.unknown_key');

    expect($result)->toBe('frontend.unknown_key');
    
    $missingLine = LanguageLine::where('group', 'frontend')->where('key', 'unknown_key')->first();
    
    expect($missingLine)->not->toBeNull()
        ->and($missingLine->is_missing)->toBeTrue();
});
```
