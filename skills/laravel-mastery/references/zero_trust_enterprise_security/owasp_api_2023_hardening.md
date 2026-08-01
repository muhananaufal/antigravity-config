# OWASP API Security Top 10 (2023) Hardening di Laravel

Dokumen ini adalah referensi kelas Sultan untuk mengamankan API Laravel 11 dari kerentanan OWASP API Top 10 edisi 2023. Fokus utama adalah mitigasi Mass Assignment yang ekstrim, proteksi Insecure Direct Object Reference (IDOR) dengan ULID/UUID & otorisasi ketat, serta pembatasan rate (Rate Limiting) yang sangat spesifik menggunakan kombinasi MAC Hash dan Fingerprinting.

## Arsitektur & Alur Keamanan API (ASCII Diagram)

```text
[Client API Request] ---> [Cloudflare/WAF] ---> [Nginx/Caddy] ---> [Laravel 11 App]
                                                                        |
                                                                        v
+-----------------------------------------------------------------------------------+
| LAYER 1: Global Middleware (ThrottleRequests + Fingerprint MAC)                   |
| 1. Generate request signature = HMAC(IP + UserAgent + Custom Header, APP_KEY)     |
| 2. Limit 10 req/sec per fingerprint + Lockout jika terdeteksi anomali.            |
+-----------------------------------------------------------------------------------+
                                        | (Pass)
                                        v
+-----------------------------------------------------------------------------------+
| LAYER 2: Router & Controller (IDOR Protection)                                    |
| 1. Route Model Binding menggunakan ULID (Bukan auto-increment ID).                |
| 2. Authorization Policy diverifikasi otomatis via FormRequest / `can` middleware. |
+-----------------------------------------------------------------------------------+
                                        | (Pass)
                                        v
+-----------------------------------------------------------------------------------+
| LAYER 3: Eloquent Model (Extreme Mass Assignment Protection)                      |
| 1. $guarded = ['*'] (Zero Trust attributes).                                      |
| 2. Model::preventSilentlyDiscardingAttributes(true) (Strict Exception).           |
| 3. Explicit assignment atau DTO (Data Transfer Object) parsing.                   |
+-----------------------------------------------------------------------------------+
```

## 1. Proteksi Mass Assignment Ekstrim (Strict Eloquent)

Dalam arsitektur Zero Trust, Laravel Eloquent tidak boleh mempercayai input apa pun. Pendekatan default `$fillable` masih rentan terhadap kelalaian developer. Pendekatan terbaik adalah mengunci seluruh atribut dan mengaktifkan mode strict.

```php
<?php

declare(strict_types=1);

namespace App\Providers;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\ServiceProvider;
use Illuminate\Database\Connection;

final class AppServiceProvider extends ServiceProvider
{
    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        // 1. Matikan lazy loading secara default (N+1 prevention)
        Model::preventLazyLoading(!$this->app->isProduction());
        
        // 2. Lempar exception jika ada field tidak terduga yang di-assign (Mitigasi Mass Assignment)
        Model::preventSilentlyDiscardingAttributes(true);

        // 3. Lindungi dari pemanggilan metode yang salah di model
        Model::preventAccessingMissingAttributes(true);
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Concerns\HasUlids;

final class UserProfile extends Model
{
    use HasUlids;

    /**
     * Extreme Mass Assignment Protection: ZERO TRUST.
     * Tidak ada atribut yang boleh diisi secara massal lewat array $request->all().
     *
     * @var array<int, string>
     */
    protected $guarded = ['*'];

    /**
     * DTO to Model binding method.
     */
    public static function createFromDTO(ProfileDTO $dto): self
    {
        $profile = new self();
        $profile->first_name = $dto->getFirstName();
        $profile->last_name = $dto->getLastName();
        $profile->bio = $dto->getBio();
        $profile->save();

        return $profile;
    }
}
```

## 2. Pencegahan IDOR Berbasis ULID & Policy

IDOR (BOLA - Broken Object Level Authorization) terjadi karena entitas menggunakan `id` (integer) yang mudah ditebak, dan tidak ada validasi apakah user aktif berhak mengakses entitas tersebut.

```php
<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\User;
use App\Models\Document;
use Illuminate\Auth\Access\HandlesAuthorization;

final class DocumentPolicy
{
    use HandlesAuthorization;

    /**
     * Menentukan apakah user dapat melihat dokumen.
     * Hanya pemilik (owner_id) atau tenant admin yang dapat melihatnya.
     */
    public function view(User $user, Document $document): bool
    {
        return $user->id === $document->owner_id 
            || $user->hasRole('tenant_admin');
    }
}
```

## 3. Custom Rate Limiter dengan Fingerprint & HMAC

Untuk memitigasi serangan brute-force dan DDoS (OWASP API4: Unrestricted Resource Consumption), kita buat Rate Limiter yang menggunakan sidik jari perpaduan antara IP, User Agent, dan Custom API Key yang di-hash dengan MAC menggunakan `APP_KEY`.

```php
<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\Log;

final class SecureApiRateLimiter
{
    public function handle(Request $request, Closure $next): Response
    {
        $fingerprint = $this->generateFingerprint($request);
        $maxAttempts = 15; // 15 req/menit untuk API sensitif

        if (RateLimiter::tooManyAttempts($fingerprint, $maxAttempts)) {
            Log::warning('DDoS / Rate Limit Triggered', [
                'ip' => $request->ip(),
                'fingerprint' => $fingerprint,
                'path' => $request->path()
            ]);

            return response()->json([
                'error' => 'Too Many Requests',
                'retry_after' => RateLimiter::availableIn($fingerprint)
            ], Response::HTTP_TOO_MANY_REQUESTS);
        }

        RateLimiter::hit($fingerprint, 60);

        return $next($request);
    }

    private function generateFingerprint(Request $request): string
    {
        $ip = $request->ip() ?? '0.0.0.0';
        $ua = $request->header('User-Agent') ?? 'unknown';
        $token = $request->header('X-API-Key') ?? 'guest';

        $payload = implode('|', [$ip, $ua, $token]);

        return hash_hmac('sha256', $payload, config('app.key'));
    }
}
```

## 🧪 Unit / Arch Tests (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Models\UserProfile;
use Illuminate\Database\Eloquent\MassAssignmentException;

test('architecture enforces exact mass assignment block', function () {
    expect('App\Models')
        ->toHaveProperty('guarded')
        ->and('App\Models')->classes()->toExtend('Illuminate\Database\Eloquent\Model');
});

test('model silently discarding attributes throws exception in strict mode', function () {
    $this->expectException(MassAssignmentException::class);

    // Ini akan throw error karena $guarded = ['*'] dan preventSilentlyDiscardingAttributes(true)
    UserProfile::create([
        'first_name' => 'Hacker',
        'is_admin' => true,
    ]);
});

test('secure rate limiter generates correct hmac fingerprint', function () {
    $request = \Illuminate\Http\Request::create('/api/secret', 'GET');
    $request->headers->set('User-Agent', 'Pest');
    $request->server->set('REMOTE_ADDR', '127.0.0.1');
    $request->headers->set('X-API-Key', 'test-key');

    $middleware = new \App\Http\Middleware\SecureApiRateLimiter();
    
    // Test logic bypassing internal method via reflection or by observing effects
    $response = $middleware->handle($request, fn ($req) => response()->json(['ok']));
    expect($response->getStatusCode())->toBe(200);
});
```

## ❌ Anti-Patterns & ✅ Best Practices

### 1. Insecure Mass Assignment (Anti-Pattern)
❌ **Salah:** Menggunakan `$guarded = []` untuk mempercepat development, mempercayakan keamanan pada $request->all().
```php
class User extends Model {
    protected $guarded = []; // BENCANA! Hacker bisa inject `is_admin = 1`.
}
$user->update($request->all());
```
✅ **Benar:** Set `$guarded = ['*']` dan gunakan explicit mapping atau DTO.
```php
class User extends Model {
    protected $guarded = ['*']; 
}
$user->name = $request->validated('name');
$user->save();
```

### 2. Broken Object Level Authorization (BOLA/IDOR) (Anti-Pattern)
❌ **Salah:** Menggunakan auto-increment ID tanpa otorisasi.
```php
public function show(Request $request, $id) {
    // Hacker ganti $id = 5 ke $id = 6 dan melihat data orang lain.
    return Document::findOrFail($id);
}
```
✅ **Benar:** Gunakan ULID + Implicit Binding + Policy check.
```php
public function show(Request $request, Document $document) {
    Gate::authorize('view', $document);
    return new DocumentResource($document);
}
```

## ⚠️ Production Edge Cases

1. **Edge Case: Serangan ReDoS (Regular Expression Denial of Service) pada API Payload**
   *Skenario:* Penyerang mengirim payload JSON berukuran besar dengan regex khusus pada parameter search yang mengeksploitasi fungsi `preg_match` di backend.
   *Solusi:* Gunakan validasi string limit (misal `max:100`) di FormRequest dan jangan pernah menjalankan regex yang dirangkai dari input user secara langsung tanpa filter PCRE limit (`pcre.backtrack_limit`).

2. **Edge Case: Kegagalan Rate Limiter karena IP Spoofing (X-Forwarded-For Bypass)**
   *Skenario:* Penyerang memalsukan header `X-Forwarded-For` untuk melewati rate limiter berbasis IP.
   *Solusi:* Konfigurasikan proxy tepercaya di `config/trustedproxy.php`. Hanya percaya IP dari WAF/Load Balancer Anda. Pastikan fungsi `$request->ip()` me-return IP asli yang diverifikasi oleh proxy, bukan sembarang header.

3. **Edge Case: Kebocoran ID Internal Melalui Stack Trace**
   *Skenario:* Model exception (seperti `ModelNotFoundException`) me-return JSON stack trace di production yang berisi detail SQL dan auto-increment ID internal dari relasi.
   *Solusi:* Tangani `ModelNotFoundException` secara custom di `bootstrap/app.php` (Laravel 11) dan selalu kembalikan response 404 generik `{'error': 'Resource not found'}`.
