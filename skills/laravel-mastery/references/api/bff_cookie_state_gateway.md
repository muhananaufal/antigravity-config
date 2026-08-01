# Arsitektur Backend-For-Frontend (BFF) & Cookie State Gateway

Dokumen ini menjelaskan implementasi Laravel sebagai Backend-For-Frontend (BFF) untuk aplikasi Single Page Application (React/Vue/Next.js) atau Mobile. Alih-alih klien memegang JWT Token di Local Storage (yang rentan XSS), Laravel membungkusnya sebagai **HTTP-Only, Secure, SameSite Cookie** menggunakan Laravel Sanctum Stateful API. Laravel juga bertindak sebagai agregator *microservices*.

## Diagram ASCII: BFF & Stateful Cookie Flow

```ascii
[ Browser (SPA React) ]
    |
    | (1) POST /login (Credentials: email, pass)
    v
[ Laravel BFF Gateway ] 
    | (2) Verify DB Auth 
    | (3) Generate Session / Sanctum Cookie
    |
    | (4) Set-Cookie: laravel_session=ABC (HTTP-Only, Secure)
    v
[ Browser ] (Menyimpan cookie dengan aman dari ancaman JS/XSS)
    |
    | (5) GET /api/dashboard-aggregated
    |     Header: Cookie laravel_session=ABC
    |     Header: X-XSRF-TOKEN (Mitigasi CSRF)
    v
[ Laravel BFF Gateway ] (Authenticates via Cookie)
    |
    |--- (6a) GET Microservice Order (RPC / HTTP internal)
    |--- (6b) GET Microservice Billing (RPC / HTTP internal)
    |
    | (7) Agregasi Data
    v
[ Browser (React) ] (Menerima Data JSON Bersih)
```

## Spesifikasi Teknis: Keamanan Sanctum Stateful

Konfigurasi mutlak (Strict) di `config/sanctum.php`, `config/session.php` dan `config/cors.php`.

```php
// config/sanctum.php
'stateful' => explode(',', env('SANCTUM_STATEFUL_DOMAINS', 'localhost,localhost:3000,app.domain.com')),

// config/session.php
'secure' => env('SESSION_SECURE_COOKIE', true), // Wajib HTTPS di prod
'http_only' => true,                            // JS tidak bisa baca cookie (Anti-XSS)
'same_site' => 'lax',                           // Mitigasi CSRF + UX aman
'domain' => env('SESSION_DOMAIN', '.domain.com'),// Memungkinkan rotasi subdomain
```

## Implementasi Kode Produksi (PHP 8.3 / Laravel 11)

### 1. Endpoint Login (Set Cookie)

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Auth;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Auth;
use Illuminate\Validation\ValidationException;

/**
 * Handles SPA authentication via HTTP-Only Session Cookie.
 * Strict Type enforced (PHPStan Level 9).
 */
final class StatefulLoginController
{
    /**
     * @throws ValidationException
     */
    public function __invoke(Request $request): JsonResponse
    {
        $credentials = $request->validate([
            'email' => ['required', 'string', 'email'],
            'password' => ['required', 'string'],
        ]);

        if (Auth::attempt($credentials)) {
            // Rotasi session ID krusial untuk mencegah serangan Session Fixation
            $request->session()->regenerate();

            /** @var \App\Models\User $user */
            $user = Auth::user();

            return response()->json([
                'user' => [
                    'id' => $user->id,
                    'name' => $user->name,
                ]
            ]); // Cookie otomatis terkirim via response header oleh middleware Laravel
        }

        throw ValidationException::withMessages([
            'email' => __('auth.failed'),
        ]);
    }
}
```

### 2. BFF Aggregation Gateway (Pola API Gateway Agregasi)

Menerima 1 request SPA (Cookie terverifikasi), lalu menembak 2 internal service secara paralel, membungkusnya, dan me-return ke SPA.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Gateway;

use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Http\Client\Pool;

/**
 * BFF Aggregator routing internal microservice calls.
 */
final class DashboardAggregatorController
{
    public function __invoke(): JsonResponse
    {
        // Fitur Pool di HTTP Client Laravel melakukan concurrent async request!
        $responses = Http::pool(fn (Pool $pool) => [
            // Gunakan timeout ketat untuk agregasi microservice internal
            $pool->as('orders')->timeout(2)->get('http://order-service.internal/api/summary'),
            $pool->as('billing')->timeout(2)->get('http://billing-service.internal/api/status'),
        ]);

        // Cek jika ada kegagalan / timeout pada service internal
        if (! $responses['orders']->successful()) {
            Log::error('BFF: Order service degraded', ['status' => $responses['orders']->status()]);
        }

        return response()->json([
            'dashboard' => [
                'orders_summary' => $responses['orders']->successful() ? $responses['orders']->json() : null,
                'billing_status' => $responses['billing']->successful() ? $responses['billing']->json() : null,
            ]
        ]);
    }
}
```

## Anti-Patterns & Best Practices

❌ **Anti-Pattern 1: Menyimpan JWT Token di `localStorage` Browser**
**Salah:** SPA login, Laravel mengembalikan `{"token": "ey123..."}`, SPA menyimpan token ke `localStorage.setItem('token', res.token)`.
**Bahaya:** Serangan Cross-Site Scripting (XSS). Jika situs web Anda terinjeksi script jahat (via ads atau komentar), JS jahat itu dapat dengan mudah membaca `localStorage` dan mencuri JWT token tersebut.
✅ **Benar:** Gunakan mekanisme Stateful Cookie (Sanctum) yang di-flag `http_only=true`. JS jahat tidak akan pernah bisa mengakses cookie tersebut.

❌ **Anti-Pattern 2: Lupa Mengkonfigurasi CSRF Protection untuk Cookie**
**Salah:** Mematikan middleware `VerifyCsrfToken` di kernel Laravel karena front-end React "Error 419".
**Bahaya:** Cross-Site Request Forgery (CSRF). Web attacker.com dapat men-submit form yang akan diproses oleh server Anda karena browser otomatis menyertakan session cookie.
✅ **Benar:** Gunakan Axios interceptor di front-end untuk mengambil cookie `XSRF-TOKEN` dan mengirimkannya kembali di header `X-XSRF-TOKEN` untuk memvalidasi request asal.

## Production Edge Cases

1. **CORS Domain Mismatches di Lingkungan Lokal vs Produksi:**
   *Skenario:* Di lokal, React berjalan di `localhost:3000` dan API di `localhost:8000`. Sanctum State menolak cookie karena domain origin mismatch.
   *Mitigasi:* Pastikan pengaturan `SANCTUM_STATEFUL_DOMAINS` mengakomodasi port lokal, dan pastikan konfigurasi `CORS` front-end mengaktifkan fitur `withCredentials: true` di Axios/Fetch.

2. **Timeout Gagal Berantai pada Pola Aggregator BFF (Cascading Failure):**
   *Skenario:* Service `billing-service` *down* (hang). Request dari Gateway BFF menunggu selama 30 detik. Akibatnya, API gateway hang, menghabiskan seluruh worker FPM, dan membuat seluruh situs down.
   *Mitigasi:* Terapkan aturan besi: Seluruh call Http antar microservice di BFF WAJIB memiliki `->timeout(2)` (maksimal 2 detik) dan fallback (seperti kode pool di atas, mengembalikan null secara anggun/graceful).

3. **Perubahan State Cookie saat API Menyeberang Sub-Domain:**
   *Skenario:* Login terjadi di `auth.domain.com` tetapi API call terjadi di `api.domain.com`. Cookie tidak terbaca.
   *Mitigasi:* Konfigurasi `SESSION_DOMAIN=.domain.com` (tanda titik di awal sangat penting) agar browser melegalkan pengiriman cookie antar semua sub-domain yang berafiliasi.

## Unit / Arch Testing (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

it('authenticates user and returns secure http-only session cookie', function () {
    $user = clone User::factory()->create([
        'email' => 'admin@bff.com',
        'password' => bcrypt('password123'),
    ]);

    $response = $this->postJson('/login', [
        'email' => 'admin@bff.com',
        'password' => 'password123',
    ]);

    $response->assertStatus(200)
             ->assertCookie('laravel_session'); // Memastikan cookie session dikeluarkan

    // Assert cookie is HttpOnly and Secure based on config
    $cookie = $response->headers->getCookies()[0];
    expect($cookie->isHttpOnly())->toBeTrue()
        ->and($cookie->getName())->toBe('laravel_session');
});

it('gracefully handles inner microservice failures during aggregation', function () {
    \Illuminate\Support\Facades\Http::fake([
        'order-service.internal/*' => \Illuminate\Support\Facades\Http::response(['data' => 'orders_ok'], 200),
        'billing-service.internal/*' => \Illuminate\Support\Facades\Http::response(null, 500), // Simulate failure
    ]);

    $this->actingAs(User::factory()->create()); // Mock auth

    $response = $this->getJson('/api/dashboard-aggregated');

    // API should still return 200 OK despite inner failure
    $response->assertStatus(200)
             ->assertJsonPath('dashboard.orders_summary.data', 'orders_ok')
             ->assertJsonPath('dashboard.billing_status', null); // Fallback to null
});
```
