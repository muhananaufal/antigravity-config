# Laravel API Endpoint Testing with Pest PHP v3 (Top 1% Mastery)

Dalam pengembangan API skala enterprise menggunakan Laravel 11/12 (PHP 8.3/8.4), pengujian (testing) bukanlah opsional, melainkan pondasi utama dari stabilitas, keamanan, dan *maintainability*. Dokumen ini membahas strategi komprehensif untuk menguji *API endpoints* menggunakan **Pest PHP v3**, mengadopsi prinsip *Clean Architecture* (FormRequest -> Controller -> Action/Service -> Repository -> Model), dan menjamin kualitas tingkat tinggi.

---

## 1. Filosofi Pengujian API (The Testing Pyramid)

Sebuah API yang tangguh membutuhkan keseimbangan antara berbagai level pengujian, untuk memisahkan domain logic (inti bisnis) dengan infrastruktur (HTTP routing, database):

1. **Unit Tests (Cepat, Terisolasi):** Menguji *Actions*, *Services*, *Repositories*, dan *Value Objects* secara mandiri tanpa menyentuh *database*, file system, atau API eksternal. Biasanya membutuhkan implementasi dari abstraksi *Mocking*.
2. **Integration Tests (Menengah, Terhubung):** Menguji bagaimana *Actions* berinteraksi dengan *Database* (Eloquent/SQL) atau sistem internal lain seperti Redis *Cache* dan Queue.
3. **Feature/Endpoint Tests (Lambat, Komprehensif):** Menguji end-to-end simulasi *HTTP layer*, mulai dari *Middleware*, *FormRequests*, *Controllers*, hingga *API Resources*, memverifikasi struktur dan kontrak JSON *payload* yang diterima *client*.
4. **Architecture Tests:** Memastikan seluruh *codebase* mematuhi aturan desain sistem *Clean Architecture* agar terhindar dari keterikatan (coupling) tingkat tinggi antar lapisan.

---

## 2. Struktur Direktori Pengujian Berbasis Domain (Pest)

Dalam arsitektur modern (Modular/Domain-Driven), struktur *test* harus mencerminkan domain atau lapisan fungsionalitas:

```text
tests/
├── Arch/                   # Architecture Testing
│   └── ArchitectureTest.php
├── Feature/                # Endpoint/HTTP Testing (End to End Layer)
│   └── Api/
│       └── V1/
│           └── Users/
│               ├── CreateUserEndpointTest.php
│               └── GetUserProfileEndpointTest.php
└── Unit/                   # Domain Logic Testing (Business Core)
    ├── Actions/
    │   └── CreateUserActionTest.php
    └── Requests/
        └── StoreUserRequestTest.php
```

---

## 3. Menguji Lapisan Arsitektur (Clean Architecture)

Pengujian harus dipecah berdasarkan tanggung jawab per *layer*. Memisahkan validasi (FormRequest) dan logika bisnis (Action/Service) dari HTTP layer (Controller) mempercepat proses debug dan eksekusi tes.

### A. Menguji FormRequest (Unit/Integration Test)

Menguji aturan validasi langsung pada objek `FormRequest` ribuan kali lebih efisien secara komputasi dibandingkan dengan memicu *HTTP request* penuh. Kita memanfaatkan *Datasets* bawaan Pest untuk mendefinisikan *Data Provider*.

```php
<?php

declare(strict_types=1);

use App\Http\Requests\Api\V1\StoreUserRequest;
use Illuminate\Support\Facades\Validator;

it('validates strictly the store user request', function (array $data, bool $shouldPass): void {
    $request = new StoreUserRequest();
    $validator = Validator::make($data, $request->rules());

    expect($validator->passes())->toBe($shouldPass);
})->with([
    'valid payload' => [
        ['name' => 'Valid Name', 'email' => 'valid@test.com', 'password' => 'P@ssw0rd123!', 'password_confirmation' => 'P@ssw0rd123!'],
        true,
    ],
    'missing email' => [
        ['name' => 'Valid Name', 'password' => 'P@ssw0rd123!', 'password_confirmation' => 'P@ssw0rd123!'],
        false,
    ],
    'invalid email format' => [
        ['name' => 'Valid Name', 'email' => 'not-an-email', 'password' => 'P@ssw0rd123!', 'password_confirmation' => 'P@ssw0rd123!'],
        false,
    ],
    'password too short (security standard)' => [
        ['name' => 'Valid Name', 'email' => 'valid@test.com', 'password' => 'short', 'password_confirmation' => 'short'],
        false,
    ],
]);
```

### B. Menguji Action / Service Layer (Integration Test)

*Action/Service* menangani logika bisnis (*Business Core*). *Controller* di *Clean Architecture* hanya berfungsi sebagai proksi HTTP. Pengujian di sini berfokus pada integrasi database (Eloquent) dan pengiriman *Event/Job*.

```php
<?php

declare(strict_types=1);

use App\Actions\Users\CreateUserAction;
use App\DTOs\Users\CreateUserDTO;
use App\Models\User;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Event;
use App\Events\UserCreatedEvent;

it('creates a user via action and dispatches event successfully', function (): void {
    // 1. Fake events to prevent actual listeners from executing
    Event::fake();

    $action = app(CreateUserAction::class);
    
    // Gunakan DTO (Data Transfer Object) untuk strict typing
    $dto = new CreateUserDTO(
        name: 'Jane Doe',
        email: 'jane@example.com',
        password: 'Password123!',
    );

    // 2. Eksekusi logika bisnis murni
    $user = $action->execute($dto);

    // 3. Verifikasi kondisi database & state akhir
    expect($user)
        ->toBeInstanceOf(User::class)
        ->name->toBe('Jane Doe')
        ->email->toBe('jane@example.com');

    // Verifikasi bahwa password telah di-hash
    expect(Hash::check('Password123!', $user->password))->toBeTrue();

    // Verifikasi pemanggilan Event yang memicu notifikasi email, dsb.
    Event::assertDispatched(UserCreatedEvent::class, function (UserCreatedEvent $event) use ($user): bool {
        return $event->user->id === $user->id;
    });
});
```

---

## 4. Endpoint/Feature Testing (Pest v3 HTTP)

Fokus utama adalah memverifikasi *Contract / API Signature* yang diekspos ke *client*. Termasuk pengecekan otorisasi Middleware, HTTP Status Code, validitas format JSON, dan Response Header.

### Contoh Implementasi Endpoint Testing Tingkat Enterprise

```php
<?php

declare(strict_types=1);

use App\Models\User;
use Laravel\Sanctum\Sanctum;
use Symfony\Component\HttpFoundation\Response;
use Illuminate\Testing\Fluent\AssertableJson;

use function Pest\Laravel\assertDatabaseHas;
use function Pest\Laravel\postJson;

it('creates a new user successfully and returns exact API JSON contract', function (): void {
    // 1. Arrange: Setup Otorisasi via Sanctum
    $admin = User::factory()->admin()->create();
    Sanctum::actingAs($admin, ['users:create']); // Scope-based authorization

    $payload = [
        'name' => 'John Doe',
        'email' => 'john.doe@example.com',
        'password' => 'SecureP@ssw0rd123!',
        'password_confirmation' => 'SecureP@ssw0rd123!',
    ];

    // 2. Act: Eksekusi request ke HTTP endpoint
    $response = postJson('/api/v1/users', $payload);

    // 3. Assert: Memverifikasi kode status dan kontrak JSON menggunakan Fluent Assertions
    $response->assertStatus(Response::HTTP_CREATED)
        ->assertJson(fn (AssertableJson $json) =>
            $json->has('data', fn (AssertableJson $data) =>
                $data->whereType('id', 'integer')
                     ->where('name', 'John Doe')
                     ->where('email', 'john.doe@example.com')
                     ->has('created_at')
                     ->has('updated_at')
                     ->etc()
            )->has('meta', fn (AssertableJson $meta) =>
                $meta->whereType('api_version', 'string')->etc()
            )
        );

    // Verifikasi state Database pasca-request HTTP
    assertDatabaseHas('users', [
        'email' => 'john.doe@example.com',
    ]);
});

it('rejects unauthorized users from performing user creation', function (): void {
    $guest = User::factory()->create();
    Sanctum::actingAs($guest, ['users:view']); // Token tidak punya hak akses scope 'create'

    $payload = [
        'name' => 'John Doe',
        'email' => 'john.doe@example.com',
        'password' => 'password',
    ];

    $response = postJson('/api/v1/users', $payload);

    $response->assertStatus(Response::HTTP_FORBIDDEN);
});
```

---

## 5. Menguji Edge-Cases & Performance

### A. Pencegahan N+1 Query (Performance)

API yang cepat adalah API yang tidak terjebak masalah lambatnya eksekusi kueri *database* ganda. Laravel 11 mengizinkan kita menangkap masalah *Lazy Loading* secara otomatis dalam *Testing Environment*.

```php
<?php

declare(strict_types=1);

use Illuminate\Database\Eloquent\Model;
use App\Models\Post;
use function Pest\Laravel\getJson;

it('prevents lazy loading and N+1 queries when fetching a collection of posts', function (): void {
    // Memaksa exception dilempar jika developer lupa melampirkan Eager Load (->with())
    Model::preventLazyLoading(true);

    Post::factory()->count(10)->create(); 

    // Jika API Resource atau Controller secara naif memanggil $post->author tanpa eager load, tes ini akan gagal
    $response = getJson('/api/v1/posts');

    $response->assertOk()
        ->assertJsonCount(10, 'data');
});
```

### B. Mocking Pemanggilan API Pihak Ketiga (Third-Party Providers)

API sering berinteraksi dengan API eksternal (Payment Gateway, SMS, AI Service). *Testing* wajib dijalankan secara lokal (terisolasi) dan tidak boleh bergantung pada jaringan nyata.

```php
<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Http;
use Symfony\Component\HttpFoundation\Response;
use function Pest\Laravel\postJson;

it('processes checkout transaction seamlessly mocking the external payment gateway', function (): void {
    // 1. Arrange: Mencegat dan mensimulasikan respons 200 OK dari Stripe
    Http::fake([
        'api.stripe.com/*' => Http::response(['status' => 'succeeded', 'id' => 'ch_987654321'], Response::HTTP_OK),
    ]);

    $payload = [
        'amount' => 5000,
        'currency' => 'IDR',
        'token' => 'tok_abc',
    ];

    // 2. Act
    $response = postJson('/api/v1/checkout', $payload);

    // 3. Assert: Cek respons ke client lokal kita
    $response->assertStatus(Response::HTTP_OK)
        ->assertJsonPath('data.payment_status', 'succeeded');

    // 4. Assert: Verifikasi bahwa kode Controller membingkai parameter Stripe dengan sempurna
    Http::assertSent(function (Illuminate\Http\Client\Request $request) {
        return $request->url() === 'https://api.stripe.com/v1/charges' &&
               $request['amount'] === 5000 &&
               $request['currency'] === 'IDR';
    });
});
```

---

## 6. Architecture Testing (Pest Arch)

*Pest Arch* mengamankan aturan *Clean Architecture*. Alat statik ini mencegah tim secara tidak sengaja melanggar batas (boundaries) domain antar modul.

```php
<?php

declare(strict_types=1);

arch('controllers should never interact directly with eloquently models')
    ->expect('App\Http\Controllers')
    ->not->toUse('App\Models')
    ->ignoring('App\Models\User'); // Pengecualian misal untuk logika auth standar

arch('domain actions must be suffixed with Action and placed in Action namespace')
    ->expect('App\Actions')
    ->toHaveSuffix('Action')
    ->toBeClasses();

arch('controllers must enforce JSON standardized responses for API')
    ->expect('App\Http\Controllers\Api')
    ->toUse(['Illuminate\Http\JsonResponse', 'Illuminate\Http\Resources\Json\JsonResource']);

arch('prevent usage of rogue debugging functions in production codebase')
    ->expect(['dd', 'dump', 'ray', 'env', 'die', 'var_dump'])
    ->not->toBeUsed();
```

---

## 7. Anti-Patterns dalam Pengujian API (Red Flags)

Berikut adalah contoh fatal dari kurangnya pemahaman desain pengujian API, lengkap dengan solusi perbaikannya.

### Anti-Pattern 1: Menguji "Multiple States" dalam Satu Pengujian Tunggal ("The God Test")

Seorang pengembang pemula cenderung merangkum seluruh skenario sukses, kegagalan validasi, dan otentikasi di satu blok tes raksasa demi kecepatan eksekusi. 

❌ **KODE SALAH (God Test)**
```php
<?php
declare(strict_types=1);
use function Pest\Laravel\postJson;

it('handles entire user creation lifecycle', function (): void {
    // 1. Uji guest terblokir (401)
    postJson('/api/users', [])->assertStatus(401);

    // 2. Uji validasi error (422)
    $user = \App\Models\User::factory()->create();
    \Laravel\Sanctum\Sanctum::actingAs($user);
    postJson('/api/users', [])->assertStatus(422);

    // 3. Uji sukses dibuat (201)
    postJson('/api/users', ['name'=>'A', 'email'=>'b@c.com', 'password'=>'123123'])->assertStatus(201);
});
```

**Penjelasan ❌:** Test ini gagal memenuhi prinsip SRP (*Single Responsibility Principle*). Apabila baris pengujian guest (401) gagal/error (misalnya server mengembalikan HTTP 500), pengujian validasi (422) dan kesuksesan (201) tidak akan pernah dieksekusi. Feedback log menjadi tidak relevan bagi developer.

✅ **KODE BENAR (Isolasi Tanggung Jawab Test / Focused Test)**
```php
<?php
declare(strict_types=1);
use function Pest\Laravel\postJson;
use Illuminate\Http\Response;

it('requires authentication to access user creation endpoint', function (): void {
    postJson('/api/v1/users', [])->assertStatus(Response::HTTP_UNAUTHORIZED);
});

it('enforces validation rules returning unprocessable entity on empty payload', function (): void {
    authenticate(); // Helper fungsi kustom untuk login Sanctum
    postJson('/api/v1/users', [])->assertStatus(Response::HTTP_UNPROCESSABLE_ENTITY);
});

it('successfully creates a user returning created http status code', function (): void {
    authenticate();
    postJson('/api/v1/users', getValidUserPayload())->assertStatus(Response::HTTP_CREATED);
});
```
**Penjelasan ✅:** Dengan mengisolasi pengujian, sistem pelaporan (CI/CD Pipeline) dapat memberikan visualisasi tepat fitur mana yang gagal. Mengisolasi tes juga mempermudah pembacaan deskripsi Pest yang menyerupai dokumentasi spesifikasi (*Behavior Driven Development*).

---

### Anti-Pattern 2: Hardcoding Assertion Teks untuk Respons JSON

Penggunaan teknik mencocokkan "string murni" terhadap luaran JSON (seperti fungsi lawas `assertSee`) sangat rapuh. 

❌ **KODE SALAH (Fragile String Assertions)**
```php
<?php
declare(strict_types=1);
use function Pest\Laravel\getJson;

it('fetches exact user profile', function (): void {
    $user = authenticate();
    $response = getJson('/api/profile');

    // RAPUH: Spasi ekstra, format urutan JSON, atau properti tambahan baru akan merusak tes ini.
    $response->assertSee('{"id": 1, "name": "John Doe", "created_at": "2023-01-01T00:00:00.000000Z"}');
});
```
**Penjelasan ❌:** Nilai pada database (khususnya tipe tanggal dinamis atau urutan JSON *properties*) sewaktu-waktu bisa bergeser. Pendekatan semacam ini (string matching) mengubah pengujian yang seharusnya dinamis menjadi beban berat pemeliharaan (technical debt test suite).

✅ **KODE BENAR (Fluent JSON Assertable)**
```php
<?php
declare(strict_types=1);
use function Pest\Laravel\getJson;
use Illuminate\Testing\Fluent\AssertableJson;

it('returns robust user profile asserting exact data types and keys', function (): void {
    $user = authenticate();
    $response = getJson('/api/v1/profile');

    $response->assertOk()
        ->assertJson(fn (AssertableJson $json) =>
            $json->has('data', fn (AssertableJson $data) =>
                $data->where('id', $user->id)
                     ->where('name', $user->name)
                     ->whereType('email', 'string')
                     ->has('created_at')
                     ->etc() // Future-proofing: Abaikan atribut tambahan lainnya yang akan datang
            )->has('meta')
        );
});
```
**Penjelasan ✅:** Fitur *Fluent JSON* (`AssertableJson`) yang didukung Laravel memungkinkan developer memvalidasi presisi dan akurasi tanpa memedulikan urutan atribut dan mengamankan fleksibilitas (dengan `etc()`) di masa depan jika *Resource API* ditambahkan kolom metrik/data opsional baru.

---

## 8. Ultimate Checklist: Production-Ready API Test

Validasi *checklist* berikut sebelum kode digabungkan ke cabang utama (main/master) dan dideploy ke tahap rilis CI/CD:

- [ ] **Validasi Respons Sukses (HTTP 20X):** Tes memastikan JSON payload, nilai *headers*, status response dan sinkronisasi ke DB *(assertDatabaseHas)* selesai secara semantik.
- [ ] **Penolakan Permintaan Gagal (HTTP 422):** FormRequest/Validasi mencegah *Bad Payload* dan memberikan error array standar spesifik (*per-field keys*).
- [ ] **Proteksi Otentikasi & Otorisasi (HTTP 401/403):** API menolak Guest (401) sekaligus memblokir *Role/Scope* yang tidak memiliki izin (403) menggunakan Gate/Policy.
- [ ] **Data Absen (HTTP 404):** Sistem tidak membuang jejak (*stack trace*) fatal/Exception rahasia ke klien. *ModelNotFoundException* dibungkus rapi melalui fitur *Exception Handler* ke bentuk JSON API.
- [ ] **Rate Limiting (HTTP 429):** Proteksi Anti-Bruteforce Throttle diuji, mengembalikan balasan header *Retry-After* yang sesuai dengan standar keamanan web global.
- [ ] **N+1 Strict Guard:** Model *preventLazyLoading* dipastikan menyala, mencegah tim tidak sengaja me-return 10.000 SQL kueri dari satu *Endpoint* list data.
- [ ] **Integrasi API Eksternal Kosong (Zero Real Outbound HTTP):** Seluruh layanan eksternal *(AWS, Stripe, Algolia)* 100% dipalsukan via faking (Mock/Http Fake) demi reliabilitas stabilitas CI/CD.
- [ ] **Pest Architecture Rules:** *Pest Arch* mengamankan batas hierarki desain (*Clean Architecture boundaries*) secara statis tanpa negosiasi manual melalui ulasan kode (Code Review).
