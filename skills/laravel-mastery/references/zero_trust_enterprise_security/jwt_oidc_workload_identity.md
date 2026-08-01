# mTLS Workload Identity & JWT OIDC di Laravel

Dalam sistem microservices modern, autentikasi antar-layanan (Service-to-Service) tidak boleh lagi mengandalkan "Network Trust" atau API Key statis. Dokumen ini merincikan protokol keamanan berlapis ganda: verifikasi sertifikat mTLS (Mutual TLS) untuk otentikasi identitas mesin (Workload Identity mirip SPIFFE/SPIRE) dipadukan dengan verifikasi kriptografi RS256 JWT OIDC yang *stateless*.

## Arsitektur Zero Trust Service-to-Service (ASCII Diagram)

```text
[Service A (Order)]                                    [Service B (Payment)]
+---------------------------+                          +-------------------------------+
| 1. Generate JWT           |                          | 4. TLS Handshake (mTLS)       |
|    Sign dengan Private Key|                          |    Verifikasi Client Cert     |
| 2. Guzzle HTTP Client     | ====== HTTPS/mTLS =====> | 5. API Gateway / Nginx        |
|    Load Client.crt + key  |      (Port 443)          |    (Forward X-Client-Verify)  |
| 3. Kirim Request          |                          | 6. Laravel Middleware         |
|    Auth: Bearer {jwt}     |                          |    - Cek mTLS Header          |
+---------------------------+                          |    - Fetch OIDC jwks.json     |
                                                       |    - Verifikasi JWT RS256     |
                                                       |    - Cek Klaim (iss, aud, exp)|
                                                       +-------------------------------+
```

## 1. Verifikasi mTLS (Mutual TLS) di Laravel

Guzzle dapat diatur untuk mengirim sertifikat klien pada setiap request. Di sisi penerima (Service B), Nginx/Ingress yang mengatur terminasi mTLS dan meneruskan status ke Laravel.

### Guzzle HTTP Client (Sisi Pengirim - Service A)

```php
<?php

declare(strict_types=1);

namespace App\Services\Api;

use Illuminate\Support\Facades\Http;
use Illuminate\Http\Client\PendingRequest;

final class SecurePaymentClient
{
    public function getClient(): PendingRequest
    {
        return Http::withOptions([
            // mTLS: Menyertakan sertifikat identitas klien
            'cert' => [config('services.workload.cert_path'), config('services.workload.cert_password')],
            // mTLS: Menyertakan private key
            'ssl_key' => config('services.workload.key_path'),
            // Verifikasi CA Server
            'verify' => config('services.workload.ca_path'),
            // Timeout agresif untuk mitigasi slowloris
            'timeout' => 5.0, 
        ])->withToken($this->generateOidcToken());
    }

    private function generateOidcToken(): string
    {
        // Dalam implementasi nyata, ini men-generate JWT yang di-sign menggunakan RS256 Private Key
        return 'ey...'; 
    }
}
```

### Middleware mTLS Verifier (Sisi Penerima - Service B)

Server web (Nginx) memverifikasi mTLS dan meneruskan header ke aplikasi Laravel. Kita wajib memvalidasinya secara ketat.

```php
<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use Illuminate\Auth\AuthenticationException;

final class RequireMutualTls
{
    public function handle(Request $request, Closure $next): Response
    {
        // Nginx/Envoy harus diset untuk mengirim header ini BUKAN dari input user
        $mtlsStatus = $request->server('HTTP_X_CLIENT_VERIFY');
        $clientDn = $request->server('HTTP_X_CLIENT_DN');

        if ($mtlsStatus !== 'SUCCESS') {
            throw new AuthenticationException('mTLS Certificate Verification Failed.');
        }

        // Cek apakah sertifikat milik workload yang diizinkan (SPIFFE ID equivalent)
        $allowedWorkloads = ['CN=order-service.internal', 'CN=auth-service.internal'];
        
        $isAuthorized = false;
        foreach ($allowedWorkloads as $allowed) {
            if (str_contains((string)$clientDn, $allowed)) {
                $isAuthorized = true;
                break;
            }
        }

        if (!$isAuthorized) {
            throw new AuthenticationException('Workload Identity tidak dikenali.');
        }

        return $next($request);
    }
}
```

## 2. JWT OIDC Stateless Federation (RS256)

Selain mTLS, muatan (payload) diotorisasi melalui JWT terenkripsi asimetris (RS256). Service B memverifikasi token dari Service A dengan mendownload `jwks.json` publik dari Service A, *tanpa pernah memanggil DB*.

```php
<?php

declare(strict_types=1);

namespace App\Services\Auth;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use Firebase\JWT\CachedKeySet;
use GuzzleHttp\Client;
use GuzzleHttp\Psr7\HttpFactory;
use Illuminate\Support\Facades\Cache;
use Illuminate\Auth\AuthenticationException;
use Psr\Cache\CacheItemPoolInterface;

final class StatelessJwtValidator
{
    public function validate(string $jwt): array
    {
        // 1. URL OIDC JWKS (JSON Web Key Set) Endpoint dari Identity Provider / Service A
        $jwksUri = 'https://auth-service.internal/.well-known/jwks.json';

        // 2. Gunakan PSR-6 Cache bawaan atau bridge Laravel agar tidak fetch HTTP terus menerus
        // Di sini kita asumsikan ketersediaan $cachePool (PSR-6)
        $httpClient = new Client(['verify' => config('services.workload.ca_path')]);
        $httpFactory = new HttpFactory();
        
        // Memanfaatkan CachedKeySet library php-jwt
        /** @var CacheItemPoolInterface $psr6Cache */
        $psr6Cache = app(CacheItemPoolInterface::class);

        try {
            $keySet = new CachedKeySet(
                $jwksUri,
                $httpClient,
                $httpFactory,
                $psr6Cache,
                3600, // Expires 1 jam
                true  // Rate limit fetcher
            );

            // 3. Verifikasi signature asimetris dan cek Expired
            $decoded = JWT::decode($jwt, $keySet);

            // 4. Verifikasi klaim audiens dan issuer (SANGAT KRUSIAL)
            if ($decoded->iss !== 'urn:auth-service' || $decoded->aud !== 'urn:payment-service') {
                throw new AuthenticationException('Invalid JWT Claims (iss/aud mismatch).');
            }

            return (array) $decoded;

        } catch (\Exception $e) {
            throw new AuthenticationException('JWT Verification Failed: ' . $e->getMessage());
        }
    }
}
```

## 🧪 Unit / Arch Tests (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Http\Middleware\RequireMutualTls;
use Illuminate\Http\Request;
use Illuminate\Auth\AuthenticationException;

test('mtls middleware rejects request without valid success header', function () {
    $request = Request::create('/api/secure', 'POST');
    $request->server->set('HTTP_X_CLIENT_VERIFY', 'FAILED');

    $middleware = new RequireMutualTls();

    expect(fn() => $middleware->handle($request, fn() => null))
        ->toThrow(AuthenticationException::class, 'mTLS Certificate Verification Failed.');
});

test('mtls middleware rejects unauthorized workload dn', function () {
    $request = Request::create('/api/secure', 'POST');
    $request->server->set('HTTP_X_CLIENT_VERIFY', 'SUCCESS');
    $request->server->set('HTTP_X_CLIENT_DN', 'CN=malicious-service.internal');

    $middleware = new RequireMutualTls();

    expect(fn() => $middleware->handle($request, fn() => null))
        ->toThrow(AuthenticationException::class, 'Workload Identity tidak dikenali.');
});
```

## ❌ Anti-Patterns & ✅ Best Practices

### 1. Hardcoded API Keys di antar-service (Anti-Pattern)
❌ **Salah:** Menggunakan `env('SERVICE_API_KEY')` statis di microservice. Kunci tidak pernah dirotasi, jika bocor, sistem hancur.
```php
Http::withToken('STATIC-FOREVER-KEY-123')->post('/payment');
```
✅ **Benar:** Gunakan Workload Identity JWT yang memiliki masa aktif pendek (TTL < 5 menit) dan ditandatangani oleh RS256 key pair yang dirotasi (via OIDC).

### 2. Mempercayai Header Klien tanpa Validasi Gateway (Anti-Pattern)
❌ **Salah:** Langsung percaya pada header HTTP di Laravel tanpa mengatur Gateway (Nginx/Envoy) untuk menimpa header tersebut.
```php
// Hacker bisa injeksi header "X-Client-Verify: SUCCESS" via Postman!
$status = $request->header('X-Client-Verify'); 
```
✅ **Benar:** Konfigurasikan Ingress/Nginx untuk MENGHAPUS header tersebut dari request luar, dan hanya menambahkannya berdasarkan hasil mTLS layer proxy yang valid, lalu gunakan `$request->server('HTTP_...`) di PHP (CGI vars).

## ⚠️ Production Edge Cases

1. **Edge Case: OIDC JWKS Endpoint Tidak Dapat Diakses (Network Partition)**
   *Skenario:* Saat Service B mencoba mengambil `jwks.json` untuk verifikasi kunci, koneksi ke Auth Service putus. Akibatnya semua request dengan token baru akan gagal.
   *Solusi:* Konfigurasikan cache `CachedKeySet` dengan *stale-while-revalidate* atau pastikan cache TTL yang cukup panjang (misal 24 jam) sehingga Service B bisa bertahan selama pemadaman jaringan lokal, serta pastikan arsitektur deployment menempatkan file jwks pada S3/CDN yang sangat scalable.

2. **Edge Case: Serangan JWT `alg: none` atau Downgrade Attack (HS256 vs RS256)**
   *Skenario:* Penyerang memodifikasi token dan mengubah algoritma di header menjadi `none`, atau menggunakan kunci publik (yang didapat dari JWKS) sebagai secret HS256 untuk memalsukan signature (CVE-2015-9235).
   *Solusi:* Library `firebase/php-jwt` versi modern sudah memitigasi ini dengan memaksa tipe algoritma yang diizinkan lewat argument keys array atau `CachedKeySet`. Selalu pastikan library terupdate.

3. **Edge Case: Kebocoran Private Key dan Tidak Ada CRL (Certificate Revocation List)**
   *Skenario:* Sertifikat mTLS milik `order-service` bocor ke pihak luar, hacker bisa masuk ke jaringan. Nginx masih memverifikasinya karena expired-nya 1 tahun lagi.
   *Solusi:* Terapkan mekanisme OCSP Stapling atau otomatisasi SPIRE yang mana umur sertifikat workload hanyalah 1-4 jam (Short-Lived Certificates). Dengan sertifikat berumur 1 jam, Anda tidak butuh pusing mengatur CRL/OCSP.
