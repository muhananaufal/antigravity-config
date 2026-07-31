# Enterprise SAML2 Keycloak Integration in Laravel 11/12

## 1. Konsep Arsitektur SAML2 Enterprise & Keycloak

SAML2 (Security Assertion Markup Language) merupakan standar otentikasi enterprise yang banyak digunakan institusi pemerintahan, perbankan, dan korporat skala besar untuk Single Sign-On (SSO). Dalam arsitektur berskala besar, sistem beroperasi dalam bentuk terpusat di mana:
- **Keycloak** bertindak sebagai Identity Provider (IdP).
- **Aplikasi Laravel** bertindak sebagai Service Provider (SP).

Integrasi SAML2 memerlukan validasi yang ketat terhadap signature (Assertion Signature Validation), manajemen replay attack (Assertion ID tracking), perlindungan terhadap XML External Entities (XXE), dan pemetaan attribute roles dari token SAML ke Domain Model aplikasi.

### Alur Kerja Autentikasi SAML2 secara Teknis:
1. **User Request**: User mencoba mengakses resource `/dashboard` yang dilindungi *auth middleware*.
2. **SP to IdP Redirect**: Laravel membangkitkan `AuthnRequest` XML (secara opsional dienkripsi dan ditandatangani) menggunakan sertifikat lokal, kemudian mengalihkan browser user ke halaman login Keycloak via metode HTTP-Redirect atau HTTP-POST.
3. **IdP Authentication**: User melakukan autentikasi di Keycloak (bisa mencakup 2FA/MFA).
4. **IdP to SP Response**: Setelah sukses, Keycloak mengirim HTTP POST yang berisi payload `SAMLResponse` (dokumen XML yang di-sign dan dienkripsi) ke endpoint *Assertion Consumer Service (ACS)* Laravel.
5. **SP Validation**: Laravel memvalidasi XML Signature menggunakan Public Certificate IDP, mengekstrak identitas utama (NameID) dan *User Attributes* (roles, email), membuat atau memperbarui entity user lokal, memitigasi replay attack, dan menerbitkan Session lokal.

---

## 2. Implementasi Clean Architecture (Strongly Typed)

Pendekatan ini memisahkan layer HTTP dari logika bisnis pengelolaan otentikasi SSO. File ini mencontohkan PHP 8.3+ menggunakan constructor property promotion dan tipe data ketat.

### A. Domain Model (`app/Models/User.php`)

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;

final class User extends Authenticatable
{
    use HasUuids;
    use Notifiable;

    /**
     * @var list<string>
     */
    protected $fillable = [
        'sso_id',
        'name',
        'email',
        'roles_payload',
        'last_login_at',
    ];

    /**
     * @var list<string>
     */
    protected $hidden = [
        'remember_token',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'roles_payload' => 'array',
            'last_login_at' => 'datetime',
        ];
    }

    public function hasRole(string $role): bool
    {
        return in_array($role, $this->roles_payload ?? [], true);
    }
}
```

### B. Repository Layer (`app/Repositories/UserRepository.php`)

Repository bertugas menyembunyikan detail pemanggilan Eloquent.

```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Models\User;
use Illuminate\Support\Carbon;

final readonly class UserRepository
{
    /**
     * @param array<int, string> $roles
     */
    public function firstOrCreateFromSaml(
        string $ssoId,
        string $email,
        string $name,
        array $roles
    ): User {
        return User::updateOrCreate(
            ['sso_id' => $ssoId],
            [
                'email'         => $email,
                'name'          => $name,
                'roles_payload' => $roles,
                'last_login_at' => Carbon::now(),
            ]
        );
    }
}
```

### C. Data Transfer Object (`app/DTOs/SamlAssertionDTO.php`)

DTO memastikan data payload divalidasi dan di-bundle dengan rapi sebelum masuk ke Application Layer.

```php
<?php

declare(strict_types=1);

namespace App\DTOs;

final readonly class SamlAssertionDTO
{
    /**
     * @param array<int, string> $roles
     */
    public function __construct(
        public string $ssoId,
        public string $email,
        public string $name,
        public array $roles,
        public string $assertionId,
    ) {}
}
```

### D. Action / Use Case (`app/Actions/Auth/ProcessSamlResponseAction.php`)

Aksi ini meng-handle Single-Responsibility (SRP): Mencegah replay attacks, dan menyimpan user SAML.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Auth;

use App\DTOs\SamlAssertionDTO;
use App\Models\User;
use App\Repositories\UserRepository;
use Illuminate\Support\Facades\Cache;
use Illuminate\Auth\AuthenticationException;
use Psr\Log\LoggerInterface;

final readonly class ProcessSamlResponseAction
{
    public function __construct(
        private UserRepository $userRepository,
        private LoggerInterface $logger,
    ) {}

    /**
     * @throws AuthenticationException
     */
    public function execute(SamlAssertionDTO $dto): User
    {
        // Cegah Replay Attack menggunakan Assertion ID tracking secara Atomik
        $cacheKey = "saml_assertion_{$dto->assertionId}";
        
        // Penggunaan add() menjamin thread-safety untuk mencegah race condition
        if (!Cache::add($cacheKey, true, 900)) {
            $this->logger->alert("SAML Replay Attack Detected", [
                'assertion_id' => $dto->assertionId,
                'sso_id'       => $dto->ssoId,
            ]);
            throw new AuthenticationException('Invalid SAML Assertion: Replay detected.');
        }

        $user = $this->userRepository->firstOrCreateFromSaml(
            ssoId: $dto->ssoId,
            email: $dto->email,
            name: $dto->name,
            roles: $dto->roles
        );

        $this->logger->info("User authenticated via SAML SSO", [
            'user_id' => $user->id,
            'sso_id'  => $dto->ssoId,
        ]);

        return $user;
    }
}
```

### E. Http Request Validation (`app/Http/Requests/Auth/SamlAcsRequest.php`)

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Auth;

use Illuminate\Foundation\Http\FormRequest;

final class SamlAcsRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            // SAMLResponse selalu berupa XML Base64Encoded.
            'SAMLResponse' => ['required', 'string'],
            'RelayState'   => ['nullable', 'string'],
        ];
    }
}
```

### F. Controller (`app/Http/Controllers/Auth/SamlController.php`)

Controller murni menangani injeksi framework dan integrasi external library OneLogin SAML toolkit.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Auth;

use App\Actions\Auth\ProcessSamlResponseAction;
use App\DTOs\SamlAssertionDTO;
use App\Http\Requests\Auth\SamlAcsRequest;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\Auth;
use OneLogin\Saml2\Auth as SamlAuth;
use OneLogin\Saml2\Error as SamlError;
use Psr\Log\LoggerInterface;

final readonly class SamlController
{
    public function __construct(
        private SamlAuth $samlAuth,
        private ProcessSamlResponseAction $processSamlResponseAction,
        private LoggerInterface $logger
    ) {}

    public function login(): RedirectResponse
    {
        // Build dan redirect AuthnRequest. Parameter terakhri (true) memaksa set returnTo session.
        $loginUrl = $this->samlAuth->login(null, [], false, false, true);
        return redirect()->away($loginUrl);
    }

    public function acs(SamlAcsRequest $request): RedirectResponse
    {
        try {
            // Melakukan dekripsi XML, memvalidasi Certificate Signature, mencegah XXE otomatis.
            $this->samlAuth->processResponse();
            $errors = $this->samlAuth->getErrors();

            if (!empty($errors)) {
                $reason = $this->samlAuth->getLastErrorReason();
                throw new SamlError("SAML Validation Error: " . implode(', ', $errors) . " - " . $reason);
            }

            if (!$this->samlAuth->isAuthenticated()) {
                throw new SamlError("Not authenticated via SAML.");
            }

            $attributes = $this->samlAuth->getAttributes();
            
            $dto = new SamlAssertionDTO(
                ssoId: $this->samlAuth->getNameId(),
                email: $attributes['email'][0] ?? '',
                name: $attributes['name'][0] ?? 'Unknown User',
                roles: $attributes['roles'] ?? [],
                assertionId: $this->samlAuth->getLastAssertionId()
            );

            $user = $this->processSamlResponseAction->execute($dto);

            // Log user in using session
            Auth::login($user);

            $relayState = $request->validated('RelayState');
            
            return redirect()->intended(
                $relayState !== null && filter_var($relayState, FILTER_VALIDATE_URL)
                    ? $relayState 
                    : config('app.frontend_url') . '/dashboard'
            );

        } catch (\Throwable $e) {
            $this->logger->critical("SAML ACS Failure", ['error' => $e->getMessage()]);
            return redirect(config('app.frontend_url') . '/login')->withErrors(['sso' => 'Authentication failed. Please contact administrator.']);
        }
    }
}
```

---

## 3. Konfigurasi Keycloak (Client Scopes & Mappers)

Agar attribute SAML dapat diterjemahkan dengan baik oleh Service Provider (SP), di Keycloak Anda wajib memetakan Client Attributes menjadi SAML Assertions.

1.  **Client Signature & Encryption**:
    *   `Sign Documents`: **ON**
    *   `Sign Assertions`: **ON** (Wajib di enterprise untuk menghindari pemalsuan body)
    *   `Client Signature Required`: **ON** (Bagus jika SP melakukan sign pada AuthnRequest)
2.  **Mappers (SAML Attribute Mappers)**:
    *   NameID: Dipetakan ke UUID / sub Keycloak (`urn:oasis:names:tc:SAML:2.0:nameid-format:persistent`).
    *   User Property `email` -> SAML Attribute Name: `email`
    *   User Property `firstName` + `lastName` -> SAML Attribute Name: `name`
    *   Role list -> SAML Attribute Name: `roles` (Single Attribute / Array of strings).

---

## 4. Anti-Patterns (Security & Memory Risks)

### ❌ Anti-Pattern 1: Mengabaikan Validasi XML External Entity (XXE) dan "Signature Wrapping Attacks"
Saat memproses payload `SAMLResponse` yang berupa XML Base64, beberapa developer mencoba menggunakan library XML parser bawaan PHP (`simplexml_load_string`) secara naif.

```php
// ❌ BAD: Mem-parse XML secara manual tanpa mengamankan external entities.
$decoded = base64_decode($request->input('SAMLResponse'));
$xml = simplexml_load_string($decoded); // MEMORY EXHAUSTION & XXE RISK
$email = $xml->Assertion->AttributeStatement->Attribute[0]->AttributeValue;

$user = User::where('email', $email)->first(); // KREDENSIAL DAPAT DIPALSUKAN
Auth::login($user);
```
**Risiko Security & Memory Risk:**
*   **XML External Entities (XXE) Injection:** Attacker dapat mengirim payload SAML XML khusus yang memaksa server membaca file internal (misal `/etc/shadow` atau `.env` Laravel) atau menyebabkan SSRF (Server-Side Request Forgery).
*   **Billion Laughs Attack (Memory OOM):** Parsing entitas rekursif tanpa `libxml_disable_entity_loader()` yang ketat dapat menyebabkan server kehabisan RAM (Memory Leak/OOM), mematikan PHP-FPM pool.
*   **Signature Wrapping (XML Signature Spoofing):** Membaca elemen tanpa memvalidasi digest Kriptografi memungkinkan hacker mengirim SAMLResponse palsu tanpa memiliki sertifikat Keycloak Private Key.

**✅ Cara Benar:**
Hanya gunakan library komprehensif bersertifikasi enterprise (misal: `onelogin/php-saml` atau toolkit `lightsaml`) yang secara internal men-disable libxml entities, memvalidasi Certificate Digest `ds:Signature`, dan mem-blokir XML bomb attacks.
```php
// ✅ GOOD: Disertai validasi kriptografi strict (onelogin/php-saml secara native aman)
$this->samlAuth->processResponse();
if (!$this->samlAuth->isAuthenticated()) {
    throw new SecurityException("Invalid Signature / Fake SAML Payload");
}
```

### ❌ Anti-Pattern 2: Menjadikan Email sebagai Primary Mapping Key (Shadow Account Takeover)
Banyak developer menganggap `email` dari SAML adalah identifier absolut tanpa memastikan integritas SSO ID (Subject NameID).

```php
// ❌ BAD: Rentan terhadap Account Takeover.
$attributes = $this->samlAuth->getAttributes();
$email = $attributes['email'][0];

// Apabila email diubah oleh Hacker di Keycloak menjadi email admin,
// Laravel otomatis login sebagai SuperAdmin lokal.
$user = User::firstOrCreate(['email' => $email]);
Auth::login($user);
```
**Risiko Security:**
*   **Account Takeover / Privilege Escalation:** Jika attacker berhasil mendaftarkan atau mengambil alih akun SSO dan merubah profile email-nya (bila Keycloak tidak di-lock), mereka bisa mencocokkan email mereka dengan Admin aplikasi Laravel (`admin@company.com`), dan secara instan meretas akun Admin di lokal.
*   **Shadow Account Collision:** Pengguna dari entitas / realm yang berbeda bisa bentrok jika mereka (secara tidak sengaja) menggunakan alamat email yang sama.

**✅ Cara Benar:**
Selalu gunakan `sso_id` (NameID Subjek `urn:oasis:names:tc:SAML:2.0:nameid-format:persistent` dari SAML payload) sebagai kunci utama (Primary Key) untuk binding. Kolom email dan name hanya berfungsi sebagai data meta tampilan.
```php
// ✅ GOOD: Identifikasi absolut berbasis SSO NameID (Immutable UID Keycloak)
$user = User::updateOrCreate(
    ['sso_id' => $this->samlAuth->getNameId()],
    [
        'email' => $attributes['email'][0], 
        'name'  => $attributes['name'][0]
    ]
);
```

### ❌ Anti-Pattern 3: Race Condition pada Replay Attack Validation
SAML Response bisa ditangkap (intercept) lalu dikirim ulang (replay) dalam hitungan milidetik secara paralel.

```php
// ❌ BAD: Race condition saat mengecek assertion ID. Cache::has dan Cache::put terpisah
if (Cache::has("saml_" . $assertionId)) {
    throw new Exception("Replay!");
}
// Jendela jeda 50ms disini bisa dimanfaatkan hacker mengirim payload beruntun.
Cache::put("saml_" . $assertionId, true, 900);
```

**✅ Cara Benar:**
Gunakan fungsi Atomic `add()` pada memcached/redis yang akan menjamin operasi perlakuan hanya sukses sekali.
```php
// ✅ GOOD: Atomic Operation Cache via Redis/Memcached. Thread-safe!
if (!Cache::add("saml_" . $assertionId, true, 900)) {
    throw new AuthenticationException('Replay detected.');
}
```

---

## 5. Pest v3 Testing (Unit & Arch)

### A. Architecture Testing (`tests/ArchTest.php`)
Memastikan layer isolasi SAML dan DTO berjalan sesuai prinsip Clean Architecture, mencegah *Spaghetti Code* di Controller.

```php
<?php

declare(strict_types=1);

arch('DTOs should be readonly and not interact with Databases')
    ->expect('App\DTOs')
    ->toBeReadonly()
    ->toBeFinal()
    ->toUseNothingFrom('Illuminate\Database');

arch('SAML Controllers should only use Actions, Requests, and DTOs')
    ->expect('App\Http\Controllers\Auth\SamlController')
    ->toUse([
        'App\Actions',
        'App\DTOs',
        'App\Http\Requests',
        'OneLogin\Saml2',
        'Psr\Log\LoggerInterface',
    ])
    ->not->toUse('App\Models'); // Controller dilarang memanggil Model secara langsung
```

### B. Unit Testing Action (`tests/Unit/Actions/ProcessSamlResponseActionTest.php`)
Mengetes fungsionalitas SAML State Validation secara isolated tanpa HTTP Request.

```php
<?php

declare(strict_types=1);

use App\Actions\Auth\ProcessSamlResponseAction;
use App\DTOs\SamlAssertionDTO;
use App\Models\User;
use App\Repositories\UserRepository;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Support\Facades\Cache;
use Psr\Log\LoggerInterface;

it('creates a user from SAML assertion successfully and sets atomic cache', function () {
    // 1. Arrange
    $repository = Mockery::mock(UserRepository::class);
    $logger = Mockery::mock(LoggerInterface::class);
    
    $dto = new SamlAssertionDTO(
        ssoId: 'usr-12345678-uuid',
        email: 'admin@enterprise.com',
        name: 'Admin',
        roles: ['super_admin'],
        assertionId: 'assertion-abc-123'
    );
    
    $user = new User(['sso_id' => 'usr-12345678-uuid']);
    
    $repository->shouldReceive('firstOrCreateFromSaml')
        ->once()
        ->with('usr-12345678-uuid', 'admin@enterprise.com', 'Admin', ['super_admin'])
        ->andReturn($user);
        
    $logger->shouldReceive('info')->once();
    
    $action = new ProcessSamlResponseAction($repository, $logger);
    
    // 2. Act
    $result = $action->execute($dto);
    
    // 3. Assert
    expect($result->sso_id)->toBe('usr-12345678-uuid');
    expect(Cache::get('saml_assertion_assertion-abc-123'))->toBeTrue();
});

it('prevents SAML replay attacks securely and throws AuthenticationException', function () {
    // 1. Arrange
    $repository = Mockery::mock(UserRepository::class);
    $logger = Mockery::mock(LoggerInterface::class);
    
    $dto = new SamlAssertionDTO(
        ssoId: 'usr-123',
        email: 'hacker@enterprise.com',
        name: 'Hacker',
        roles: [],
        assertionId: 'assertion-duplicate'
    );
    
    // Simulate previous login (Replay attack simulation)
    Cache::add('saml_assertion_assertion-duplicate', true, 900);
    
    $logger->shouldReceive('alert')->once();
    
    $action = new ProcessSamlResponseAction($repository, $logger);
    
    // 2. Act & Assert
    expect(fn () => $action->execute($dto))
        ->toThrow(AuthenticationException::class, 'Invalid SAML Assertion: Replay detected.');
});
```
