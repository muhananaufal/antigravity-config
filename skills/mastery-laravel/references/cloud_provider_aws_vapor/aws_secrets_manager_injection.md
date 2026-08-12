# AWS Secrets Manager Runtime Injection di Laravel

## Arsitektur & Motivasi
Menyimpan kredensial produksi yang sensitif (DB Password, API Keys Stripe/Payment) di file statis `.env` pada container image, EC2, atau ECS Task Definition adalah celah keamanan tingkat tinggi. Solusi Enterprise Kubernetes / Laravel Vapor adalah menarik rahasia secara dinamis saat aplikasi *booting* menggunakan AWS Secrets Manager, dengan strategi cache untuk latensi.

### Diagram Alur Injeksi Secrets Manager
```text
[Laravel Bootstrapper (AppServiceProvider)]
      |
      | 1. Memeriksa Cache (Redis/APCu) untuk Secret
      |-----------------------------------------------------(Hit)-----> [Cache] --> Lanjut Booting
      | (Miss/Expired)
      |
      | 2. Panggil AWS Secrets Manager API via SDK (IAM Role Task)
      |-------------------------------------------------------------> [AWS Secrets Manager]
      |                                                                       |
      | 3. Kembalikan JSON (DB_PASSWORD, STRIPE_SECRET)                       |
      |<----------------------------------------------------------------------|
      |
      | 4. Update config() runtime (`config(['database.connections.mysql.password' => $secret])`)
      |
      V
[Aplikasi Berjalan dengan Koneksi Database yang Aman]
```

## Implementasi PHP 8.3 / Laravel 11 (PHPStan Level 9)

```php
<?php

declare(strict_types=1);

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;
use Aws\SecretsManager\SecretsManagerClient;
use RuntimeException;
use Throwable;

final class SecretsManagerServiceProvider extends ServiceProvider
{
    /**
     * @var int Cache TTL for secrets in seconds.
     */
    private const SECRET_TTL = 3600; 

    public function register(): void
    {
        if (!$this->app->environment('production', 'staging')) {
            return;
        }

        $this->injectSecrets();
    }

    private function injectSecrets(): void
    {
        $secretName = config('services.aws.secrets_manager_name');
        
        if (!is_string($secretName) || $secretName === '') {
            Log::warning('Secrets Manager name not configured.');
            return;
        }

        try {
            $secretsJson = Cache::store('apc')->remember(
                "aws_secret:{$secretName}",
                self::SECRET_TTL,
                fn () => $this->fetchSecretFromAws($secretName)
            );

            /** @var array<string, string> $secrets */
            $secrets = json_decode($secretsJson, true, 512, JSON_THROW_ON_ERROR);

            if (isset($secrets['DB_PASSWORD'])) {
                config(['database.connections.mysql.password' => $secrets['DB_PASSWORD']]);
            }
            if (isset($secrets['STRIPE_SECRET_KEY'])) {
                config(['services.stripe.secret' => $secrets['STRIPE_SECRET_KEY']]);
            }

        } catch (Throwable $e) {
            Log::emergency('CRITICAL: Failed to load AWS Secrets: ' . $e->getMessage(), ['exception' => $e]);
            throw new RuntimeException('Secret manager injection failed during boot.', 0, $e);
        }
    }

    private function fetchSecretFromAws(string $secretName): string
    {
        $client = new SecretsManagerClient([
            'region' => config('services.aws.region', 'us-east-1'),
            'version' => 'latest',
        ]);

        $result = $client->getSecretValue([
            'SecretId' => $secretName,
        ]);

        $secretString = $result->get('SecretString');
        
        if (!is_string($secretString)) {
            throw new RuntimeException("Secret {$secretName} is not a valid string.");
        }

        return $secretString;
    }
}
```

## Pest v3 Tests

```php
<?php

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Config;

test('injects secrets from cache to config during boot', function () {
    $mockedSecret = json_encode([
        'DB_PASSWORD' => 'super-secret-db',
        'STRIPE_SECRET_KEY' => 'sk_live_123',
    ]);
    
    Cache::store('apc')->shouldReceive('remember')
        ->once()
        ->andReturn($mockedSecret);
        
    config()->set('services.aws.secrets_manager_name', 'prod/app/secrets');
    config()->set('database.connections.mysql.password', 'old-password');
    
    $provider = new \App\Providers\SecretsManagerServiceProvider(app());
    $provider->register();
    
    expect(Config::get('database.connections.mysql.password'))->toBe('super-secret-db')
        ->and(Config::get('services.stripe.secret'))->toBe('sk_live_123');
});
```

## Anti-Patterns & Edge Cases

### ❌ Anti-Pattern 1: Menyimpan .env di Git atau Docker Image
```bash
# SALAH: File .env production dibakar langsung ke image `COPY .env.production .env`.
```
✅ **Benar:** Kredensial ditarik *at runtime* lewat AWS Secrets Manager & Task IAM Role.

### ❌ Anti-Pattern 2: Sinkronisasi API AWS pada Setiap Request PHP
```php
// SALAH: Memanggil AWS Secrets Manager API di dalam setiap Controller/Middleware.
$password = (new SecretsManagerClient())->getSecretValue(['SecretId' => 'db'])->get('SecretString');
```
✅ **Benar:** Cache secret di APCu (in-memory per EC2 instance/Container) atau Redis dengan TTL (Time To Live).

### Production Edge Cases
1. **AWS Secrets Manager Rate Limiting:** AWS membatasi TPS untuk `GetSecretValue`. Jika ratusan node up, akan terkena Throttling. **Mitigasi:** Terapkan Cache Layer (APCu lokal) dan exponential backoff.
2. **Secret Rotation Downtime:** DBA melakukan rotasi password DB, tapi Cache aplikasi masih menyimpan password lama. **Mitigasi:** Tangkap event AWS EventBridge "SecretRotated", kirim SQS untuk melakukan Cache Invalidation.
3. **Availability Prevails over Consistency (APB Fallback):** Jika AWS Secrets down, jangan reset cache yang expired jika tidak bisa ambil baru. Gunakan `Stale While Revalidate`.
