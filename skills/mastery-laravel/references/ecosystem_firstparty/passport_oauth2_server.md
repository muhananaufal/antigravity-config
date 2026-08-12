# Laravel Passport: Top 1% Engineering Guide (OAuth2 Server)

**Laravel Passport** adalah implementasi native OAuth2 server untuk Laravel, dibangun di atas The PHP League OAuth2 Server. Dokumen ini adalah panduan komprehensif, arsitektural, dan *production-ready* untuk mengimplementasikan Passport pada Laravel 11/12 (PHP 8.3+) dengan prinsip **Clean Architecture** dan standar kualitas **Top 1%**.

---

## 1. OAuth2 Grant Types & Passport

Memahami OAuth2 *Grant Types* adalah krusial untuk keamanan arsitektur:
- **Authorization Code Grant (dengan PKCE)**: Standar de-facto untuk otentikasi SPA (Single Page Application) dan Native Mobile Apps. PKCE (Proof Key for Code Exchange) menggantikan Client Secret.
- **Client Credentials Grant**: Digunakan untuk komunikasi *machine-to-machine* (M2M) seperti microservices.
- **Password Grant**: *Deprecated* di spesifikasi OAuth2.1, namun didukung Passport untuk legacy migration. **JANGAN GUNAKAN UNTUK APLIKASI BARU**.
- **Personal Access Tokens (PAT)**: Token berumur panjang untuk developer (seperti API Keys GitHub).
- **Implicit Grant**: *Deprecated* sepenuhnya. Gantikan dengan Auth Code + PKCE.

---

## 2. Arsitektur Clean & Domain-Driven Design (DDD)

Dalam sistem *enterprise*, manajemen Client dan Token seringkali berada di domain *Identity and Access Management (IAM)*.

### 2.1. Form Request (Input Validation & DTO)

```php
<?php

declare(strict_types=1);

namespace App\Domains\IAM\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class IssueClientTokenRequest extends FormRequest
{
    /**
     * Determine if the user is authorized to make this request.
     */
    public function authorize(): bool
    {
        return true; // Autorisasi biasanya dilakukan via middleware Client Credentials
    }

    /**
     * Get the validation rules that apply to the request.
     *
     * @return array<string, \Illuminate\Contracts\Validation\ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'client_id' => ['required', 'string', 'exists:oauth_clients,id'],
            'client_secret' => ['required', 'string'],
            'grant_type' => ['required', 'string', 'in:client_credentials'],
            'scope' => ['nullable', 'string'],
        ];
    }
    
    /**
     * Parse valid string scope into array.
     *
     * @return array<int, string>
     */
    public function getScopes(): array
    {
        if (empty($this->validated('scope'))) {
            return [];
        }
        
        return explode(' ', (string) $this->validated('scope'));
    }
}
```

### 2.2. Service / Action (Business Logic)

Kita mengabstraksi pemanggilan ke Laravel Passport server, memisahkan lapisan infrastruktur HTTP dari *use case*.

```php
<?php

declare(strict_types=1);

namespace App\Domains\IAM\Actions;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use App\Domains\IAM\Exceptions\TokenIssuanceException;
use InvalidArgumentException;
use Throwable;

final readonly class IssueMachineToMachineTokenAction
{
    /**
     * @param string $clientId
     * @param string $clientSecret
     * @param array<int, string> $scopes
     * @return array<string, mixed>
     * 
     * @throws TokenIssuanceException
     */
    public function execute(string $clientId, string $clientSecret, array $scopes = []): array
    {
        if (empty($clientId) || empty($clientSecret)) {
            throw new InvalidArgumentException('Client ID and Secret cannot be empty.');
        }

        try {
            $response = Http::asForm()->post(config('app.url') . '/oauth/token', [
                'grant_type' => 'client_credentials',
                'client_id' => $clientId,
                'client_secret' => $clientSecret,
                'scope' => implode(' ', $scopes),
            ]);

            if ($response->failed()) {
                throw TokenIssuanceException::fromOAuthError(
                    (string) $response->json('message', 'Unknown OAuth2 error'),
                    (int) $response->status()
                );
            }

            $data = $response->json();
            
            return [
                'access_token' => $data['access_token'] ?? '',
                'expires_in' => $data['expires_in'] ?? 0,
                'token_type' => $data['token_type'] ?? 'Bearer',
            ];
            
        } catch (Throwable $exception) {
            if ($exception instanceof TokenIssuanceException) {
                throw $exception;
            }
            
            throw TokenIssuanceException::fromSystemError($exception);
        }
    }
}
```

### 2.3. Repository / Model

Untuk berinteraksi dengan Passport Model (misalnya untuk kustomisasi Payload atau Client Repository).

```php
<?php

declare(strict_types=1);

namespace App\Domains\IAM\Models;

use Laravel\Passport\Client as PassportClient;

final class OAuthClient extends PassportClient
{
    /**
     * Determine if the client should skip the authorization prompt.
     */
    public function skipsAuthorization(): bool
    {
        return $this->firstParty();
    }
    
    /**
     * Relasi ke entitas spesifik seperti Tenant.
     */
    public function tenant(): \Illuminate\Database\Eloquent\Relations\BelongsTo
    {
        return $this->belongsTo(Tenant::class, 'tenant_id');
    }
}
```

### 2.4. Controller (HTTP Layer)

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\IAM;

use App\Http\Controllers\Controller;
use App\Domains\IAM\Requests\IssueClientTokenRequest;
use App\Domains\IAM\Actions\IssueMachineToMachineTokenAction;
use Illuminate\Http\JsonResponse;

final class M2MTokenController extends Controller
{
    public function __construct(
        private readonly IssueMachineToMachineTokenAction $issueTokenAction,
    ) {}

    public function __invoke(IssueClientTokenRequest $request): JsonResponse
    {
        $payload = $this->issueTokenAction->execute(
            clientId: (string) $request->validated('client_id'),
            clientSecret: (string) $request->validated('client_secret'),
            scopes: $request->getScopes()
        );

        return response()->json($payload, 200);
    }
}
```

---

## 3. Anti-Patterns & Best Practices

### 3.1. Anti-Pattern: Mengabaikan Validasi Scope (Security Risk)

❌ **KODE SALAH (Berbahaya - Escalation of Privilege)**

Pendekatan ini membiarkan token yang sudah terotentikasi mengakses resource tanpa mengecek scope yang diberikan.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use App\Models\Invoice;

final class InvoiceController extends Controller
{
    // Rute hanya dilindungi middleware 'auth:api'
    public function destroy(Request $request, Invoice $invoice): JsonResponse
    {
        // ❌ BAHAYA: Token M2M mungkin hanya punya read-only access
        // Namun karena tidak dicek, mereka bisa menghapus invoice!
        $invoice->delete();
        
        return response()->json(['message' => 'Deleted']);
    }
}
```

**Kenapa Berbahaya:**
Jika token dikeluarkan untuk pihak ketiga dengan scope `invoices.read`, mereka bisa menggunakan token tersebut ke endpoint `DELETE` jika tidak ada proteksi scope. Ini adalah celah *Broken Access Control* (OWASP Top 10).

✅ **KODE BENAR (Scope-Based Authorization)**

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use App\Models\Invoice;

final class InvoiceController extends Controller
{
    public function destroy(Request $request, Invoice $invoice): JsonResponse
    {
        // ✅ BENAR: Validasi secara eksplisit tokenHasScope
        if (! $request->user()->tokenCan('invoices.delete')) {
            abort(403, 'Your token lacks the invoices.delete scope.');
        }

        $invoice->delete();
        
        return response()->json(['message' => 'Deleted successfully']);
    }
}
```

*Atau lebih baik, definisikan middleware di route:*
`Route::delete('/invoices/{invoice}', [InvoiceController::class, 'destroy'])->middleware(['auth:api', 'scopes:invoices.delete']);`

### 3.2. Anti-Pattern: Tidak Menerapkan PKCE untuk SPA / Mobile (Security Risk)

❌ **KODE SALAH (Implicit Grant atau Auth Code + Static Secret)**

Banyak developer SPA mengimplementasikan Auth Code dengan meletakkan `client_secret` di frontend code (Vue/React).

```js
// ❌ BAHAYA: Frontend code (Vue.js / React)
const login = async () => {
    const response = await axios.post('https://api.example.com/oauth/token', {
        grant_type: 'authorization_code',
        client_id: '969a5...',
        client_secret: 'secret-hardcoded-in-frontend', // ❌ Secret is public!
        code: '12345code'
    });
}
```

**Kenapa Berbahaya:**
Semua yang ada di frontend JavaScript dapat diekstraksi. Attacker bisa menyalin `client_secret` untuk melakukan *token impersonation*.

✅ **KODE BENAR (Menggunakan PKCE)**

Laravel Passport native support PKCE. Jangan berikan `client_secret` ke public client. Sebagai gantinya, generate `code_verifier` dan `code_challenge`.

```php
<?php

declare(strict_types=1);

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Laravel\Passport\ClientRepository;

final class CreatePublicClientCommand extends Command
{
    protected $signature = 'passport:client:public {name} {redirect}';
    
    public function handle(ClientRepository $clients): int
    {
        // ✅ BENAR: Buat public client, BUKAN confidential client
        $client = $clients->create(
            userId: null,
            name: (string) $this->argument('name'),
            redirect: (string) $this->argument('redirect'),
            provider: null,
            personalAccess: false,
            password: false,
            confidential: false // <-- PENTING UNTUK PKCE CLIENTS
        );

        $this->info("Public client created! ID: {$client->id}");
        // Tidak ada secret yang di-generate atau dibutuhkan oleh public client
        return self::SUCCESS;
    }
}
```

---

## 4. Testing Komprehensif (Pest v3)

Validasi arsitektur, sekuritas, dan fungsionalitas dengan Pest v3.

### 4.1. Architecture Test (`tests/ArchTest.php`)

```php
<?php

declare(strict_types=1);

uses()->group('architecture');

test('controllers should not use Passport Facades directly')
    ->expect('App\Http\Controllers')
    ->not->toUse('Laravel\Passport\Passport')
    ->because('Controllers must delegate Passport operations to Domain Actions for clean architecture.');

test('IAM actions should be final and strictly typed')
    ->expect('App\Domains\IAM\Actions')
    ->toBeFinal()
    ->toHaveMethod('execute');

test('all files must use strict types')
    ->expect('App')
    ->toUseStrictTypes();
```

### 4.2. Feature Test (Token Issuance & Scope Authorization)

```php
<?php

declare(strict_types=1);

uses(
    \Illuminate\Foundation\Testing\RefreshDatabase::class,
    \Tests\TestCase::class
)->in('Feature');

use Laravel\Passport\ClientRepository;
use Illuminate\Support\Facades\Http;
use App\Models\User;
use Laravel\Passport\Passport;

beforeEach(function () {
    // Generate Passport encryption keys in memory untuk testing
    $this->artisan('passport:keys');
});

it('issues m2m token correctly via clean architecture controller', function () {
    $clients = app(ClientRepository::class);
    $client = $clients->create(null, 'Test M2M', 'http://localhost');

    // Fake HTTP request to our own oauth/token endpoint as passport handles it natively
    $response = $this->postJson('/api/m2m/token', [
        'client_id' => $client->id,
        'client_secret' => $client->secret,
        'grant_type' => 'client_credentials',
        'scope' => 'invoices.read invoices.delete'
    ]);

    $response->assertStatus(200)
             ->assertJsonStructure(['access_token', 'expires_in', 'token_type']);
});

it('prevents access if token lacks required scope', function () {
    // Membuat pengguna
    $user = User::factory()->create();

    // Otentikasi user dengan scope TERBATAS
    Passport::actingAs(
        $user,
        ['invoices.read'] // ❌ Tidak ada invoices.delete
    );

    // Hit route yang dilindungi oleh middleware: ['scopes:invoices.delete']
    $response = $this->deleteJson('/api/invoices/1');

    // HTTP 403 Forbidden
    $response->assertStatus(403);
});

it('allows access if token has required scope', function () {
    $user = User::factory()->create();

    // Otentikasi user dengan scope YANG TEPAT
    Passport::actingAs(
        $user,
        ['invoices.delete', 'invoices.read'] // ✅ Ada invoices.delete
    );

    // Misalkan API mengembalikan 200 JSON pada Delete
    $response = $this->deleteJson('/api/invoices/1');

    $response->assertStatus(200)
             ->assertJson(['message' => 'Deleted successfully']);
});
```

---

## 5. Security Checklist (Production Ready)

1. **Token Pruning:** Jalankan command `passport:purge` via Task Scheduler harian untuk menghapus token yang expired/revoked, mencegah table bloating (Memory/DB Risk).
   ```php
   // routes/console.php
   Schedule::command('passport:purge')->daily();
   ```
2. **Key Rotation:** Selalu simpan file `oauth-private.key` dan `oauth-public.key` di luar webroot, idealnya rotasi periodik dan mapping via Environment Variables.
3. **Passport Client Cache:** Gunakan command `passport:client:cache` pada deployment script untuk meminimalisir Database query hits (Performance optimization).
4. **Custom Claims:** Hindari memasukkan *sensitive data* (PII) langsung ke dalam token Payload jika tidak dienkripsi dengan asimetris yang ketat (gunakan JWE, bukan sekedar JWS default).
5. **Rate Limiting:** Terapkan rate limiter ketat pada route `oauth/token` (misal 5 requests per menit per IP) untuk mencegah Brute-force credentials.

---
*End of Document. Designed for Top 1% Laravel Engineers building resilient Identity & Access Management (IAM) systems.*
