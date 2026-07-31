# Laravel Precognition: The Definitive Top 1% Guide

**Laravel Precognition** adalah fitur revolusioner yang diperkenalkan sejak Laravel 10 (dan disempurnakan di Laravel 11/12) yang memungkinkan pengembang untuk menjalankan validasi form *backend* secara *real-time* di *frontend* tanpa benar-benar mengeksekusi logika bisnis atau menyimpan data. Fitur ini menjembatani kesenjangan antara validasi UX frontend yang cepat dan keamanan serta konsistensi aturan validasi backend.

Dokumen ini adalah panduan komprehensif, arsitektur-sentris, dan dioptimalkan untuk PHP 8.3/8.4 serta Laravel 11/12, memastikan implementasi Precognition Anda berada pada level Top 1% industri perangkat lunak.

---

## 1. Bagaimana Precognition Bekerja?

Secara konseptual, Precognition memanfaatkan HTTP request headers untuk memberi sinyal kepada framework Laravel:
1. **Frontend mengirim request** dengan header `Precognition: true` (biasanya dipicu saat event `blur` atau `change` pada input).
2. **Laravel menerima request**, menjalankan middleware `HandlePrecognitiveRequests`.
3. **Form Request divalidasi.**
4. Jika header precognition terdeteksi, Laravel **langsung mengembalikan HTTP 204 No Content** (jika valid) atau **HTTP 422 Unprocessable Entity** (jika tidak valid) *sebelum* request mencapai method pada Controller.
5. Logika bisnis (menyimpan ke database, mengirim email) **tidak akan pernah dieksekusi** pada mode Precognition.

---

## 2. Setup & Registrasi Middleware

Untuk mengaktifkan Precognition, middleware `HandlePrecognitiveRequests` harus ditambahkan ke route yang bersangkutan.

```php
<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\Api\V1\UserRegistrationController;
use Illuminate\Foundation\Http\Middleware\HandlePrecognitiveRequests;

Route::post('/api/v1/users', [UserRegistrationController::class, 'store'])
    ->middleware([HandlePrecognitiveRequests::class])
    ->name('api.v1.users.store');
```

---

## 3. Implementasi Clean Architecture

Dalam sistem enterprise, kita harus memisahkan tanggung jawab (Separation of Concerns). Validasi harus tetap berada di FormRequest, sedangkan logika eksekusi dipisah dalam Action.

### 3.1. Model

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Concerns\HasUuids;

final class User extends Model
{
    use HasFactory, HasUuids;

    protected $fillable = [
        'name',
        'email',
        'password',
        'username',
    ];

    protected $hidden = [
        'password',
    ];

    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
        ];
    }
}
```

### 3.2. FormRequest dengan Rule Precognition-Aware

Seringkali, validasi tertentu (seperti memverifikasi OTP pihak ketiga atau *heavy database query*) terlalu berat untuk dijalankan berulang kali saat user hanya mengetik (precognition). Kita dapat mem-bypass rule berat tersebut ketika dalam mode precognition.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Api\V1;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rules\Password;

final class StoreUserRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        $rules = [
            'name' => ['required', 'string', 'max:255'],
            'username' => ['required', 'string', 'min:3', 'max:50', 'unique:users,username'],
            'email' => ['required', 'string', 'email', 'max:255', 'unique:users,email'],
            'password' => ['required', 'confirmed', Password::defaults()],
        ];

        // Jika dalam mode precognition, abaikan rule yang memakan resource berat
        // Contoh: validasi ke pihak ketiga (fraud detection API)
        if (! $this->isPrecognitive()) {
            $rules['email'][] = 'app_custom_fraud_check'; 
        }

        return $rules;
    }
}
```

### 3.3. Action (Bussiness Logic)

Action class bersifat murni dan tidak mengetahui apapun tentang HTTP atau Request. Ia hanya menerima DTO (Data Transfer Object) atau parameter tervalidasi.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Users;

use App\Models\User;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\DB;
use RuntimeException;

final readonly class RegisterUserAction
{
    /**
     * @param array<string, mixed> $data
     * @throws RuntimeException
     */
    public function execute(array $data): User
    {
        return DB::transaction(function () use ($data): User {
            $user = User::create([
                'name' => $data['name'],
                'username' => $data['username'],
                'email' => $data['email'],
                'password' => Hash::make($data['password']),
            ]);

            if (! $user instanceof User) {
                throw new RuntimeException('Gagal membuat user baru.');
            }

            return $user;
        });
    }
}
```

### 3.4. Controller

Controller hanya bertanggung jawab untuk menerima request, memanggil Action, dan mengembalikan response terstruktur. Precognition ditangani otomatis oleh middleware dan FormRequest, sehingga Controller tetap bersih.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\Api\V1\StoreUserRequest;
use App\Actions\Users\RegisterUserAction;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final class UserRegistrationController extends Controller
{
    public function store(
        StoreUserRequest $request,
        RegisterUserAction $action
    ): JsonResponse {
        // Pada titik ini, jika request adalah precognition,
        // framework sudah memotong siklus eksekusi dan mereturn HTTP 204.
        // Baris kode di bawah HANYA dieksekusi pada request final (Submit).

        $user = $action->execute($request->validated());

        return response()->json([
            'message' => 'User berhasil didaftarkan.',
            'data' => [
                'id' => $user->id,
                'email' => $user->email,
            ],
        ], Response::HTTP_CREATED);
    }
}
```

---

## 4. Anti-Patterns & Best Practices

Berikut adalah kesalahan umum yang harus dihindari saat menggunakan Laravel Precognition.

### 4.1. Memeriksa Precognition di Controller

❌ **KODE SALAH (Anti-Pattern):**
Mengendalikan alur precognition secara manual di dalam Controller adalah pelanggaran terhadap prinsip middleware dan DRY. Controller menjadi kotor dan bertanggung jawab atas HTTP logic.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Validator;
use Illuminate\Http\JsonResponse;

final class BadUserController extends Controller
{
    public function store(Request $request): JsonResponse
    {
        $validator = Validator::make($request->all(), [
            'email' => 'required|email|unique:users',
        ]);

        if ($request->header('Precognition') === 'true') {
            if ($validator->fails()) {
                return response()->json(['errors' => $validator->errors()], 422);
            }
            return response()->json([], 204);
        }

        // Logic lanjutan
    }
}
```

✅ **KODE BENAR (Best Practice):**
Gunakan `HandlePrecognitiveRequests` middleware dan pindahkan aturan validasi ke Form Request yang didedikasikan (seperti contoh Clean Architecture di atas). Biarkan framework yang mengurus respons precognition.

### 4.2. Menjalankan Heavy Operations saat Precognitive Validation

❌ **KODE SALAH (Anti-Pattern):**
Memiliki Custom Rule di FormRequest yang melakukan HTTP Request ke server pihak ke-3 (seperti API pengecekan spam atau DNS lookup) dan menjalankannya pada setiap ketukan keyboard pengguna (karena Precognition dikirim *per-field* atau *on-blur*). Ini menyebabkan Rate Limiting pihak ke-3 akan terkuras dan memperlambat UX frontend secara drastis.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class BadFormRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'email' => [
                'required',
                'email',
                // Rule ini membuat HTTP request keluar secara sinkron.
                // Sangat buruk jika dieksekusi setiap user mengetik 1 huruf di input email.
                new \App\Rules\ValidateEmailAgainstExternalSpamApi(), 
            ],
        ];
    }
}
```

✅ **KODE BENAR (Best Practice):**
Filter atau kecualikan validasi berat jika metode yang dipanggil masuk dalam request precognitive, dengan menggunakan `$this->isPrecognitive()`. Rule berat hanya akan dieksekusi saat tombol *Submit* ditekan (request final).

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class GoodFormRequest extends FormRequest
{
    public function rules(): array
    {
        $rules = [
            'email' => ['required', 'email'],
        ];

        // Heavy rule HANYA jalan saat bukan Precognition
        if (! $this->isPrecognitive()) {
            $rules['email'][] = new \App\Rules\ValidateEmailAgainstExternalSpamApi();
        }

        return $rules;
    }
}
```

---

## 5. Front-End Integration

Meskipun fokus kita di backend, memahami bagaimana frontend mengkonsumsi ini adalah krusial. Laravel menyediakan library NPM `@laravel/precognition-vue` (atau react, alpine, dll).

Contoh menggunakan Vanilla JS / Axios:

```javascript
import axios from 'axios';
import { client } from 'laravel-precognition-core';

// Setup client
const validator = client.use(axios).validate('post', '/api/v1/users', {
    name: '',
    email: '',
    username: '',
    password: '',
});

// Bind ke event input
document.getElementById('email').addEventListener('blur', function (e) {
    validator.setData('email', e.target.value);
    
    validator.validate('email').then(() => {
        console.log('Email Valid!');
    }).catch(errors => {
        console.log('Error Validasi:', errors.email);
    });
});
```

Atau menggunakan Vue 3:

```vue
<script setup>
import { useForm } from 'laravel-precognition-vue';

const form = useForm('post', '/api/v1/users', {
    name: '',
    email: '',
});

const submit = () => form.submit()
    .then(response => { form.reset(); alert('Success'); })
    .catch(error => { console.log('Error on submit'); });
</script>

<template>
    <form @submit.prevent="submit">
        <input v-model="form.name" @change="form.validate('name')">
        <div v-if="form.invalid('name')">{{ form.errors.name }}</div>

        <input v-model="form.email" @change="form.validate('email')">
        <div v-if="form.invalid('email')">{{ form.errors.email }}</div>
        
        <button :disabled="form.processing">Submit</button>
    </form>
</template>
```

---

## 6. Testing (Pest v3)

Sebuah implementasi Top 1% harus didukung oleh pengujian yang mendalam. Kita akan menggunakan Pest v3 untuk melakukan Unit Test pada sistem Precognition dan Architecture Test untuk menjamin kepatuhan struktur Clean Architecture.

### 6.1. Endpoint Feature Testing

Kita perlu menguji 3 skenario utama: Precognition gagal (422), Precognition berhasil (204), dan Final Request sukses (201).

```php
<?php

declare(strict_types=1);

use function Pest\Laravel\postJson;
use App\Models\User;

test('precognition fails and returns 422 for invalid data', function () {
    $response = postJson('/api/v1/users', [
        'email' => 'invalid-email',
    ], [
        'Precognition' => 'true',
    ]);

    $response->assertStatus(422)
        ->assertJsonValidationErrors(['email']);
        
    // Pastikan tidak ada user yang terbuat (Logika bisnis tidak dieksekusi)
    expect(User::count())->toBe(0);
});

test('precognition succeeds and returns 204 for valid data', function () {
    $response = postJson('/api/v1/users', [
        'name' => 'John Doe',
        'email' => 'john.doe@example.com',
        'username' => 'johndoe',
        'password' => 'Password123!',
        'password_confirmation' => 'Password123!',
    ], [
        'Precognition' => 'true',
    ]);

    // 204 No Content untuk validasi precognition yang sukses
    $response->assertStatus(204);
    
    // Pastikan logis bisnis TIDAK DILANJUTKAN!
    expect(User::count())->toBe(0);
});

test('final request saves the user to database', function () {
    $response = postJson('/api/v1/users', [
        'name' => 'John Doe',
        'email' => 'john.doe@example.com',
        'username' => 'johndoe',
        'password' => 'Password123!',
        'password_confirmation' => 'Password123!',
    ]);

    // Final submission tanpa header precognition mengeksekusi controller action
    $response->assertStatus(201)
        ->assertJsonPath('message', 'User berhasil didaftarkan.');
        
    expect(User::where('email', 'john.doe@example.com')->exists())->toBeTrue();
});
```

### 6.2. Architecture Testing

Pastikan FormRequest kita selalu memisahkan validasi dan tidak ada Controller yang melakukan hal kotor.

```php
<?php

declare(strict_types=1);

arch('controllers must not contain validation logic')
    ->expect('App\Http\Controllers')
    ->not->toUse('Illuminate\Support\Facades\Validator')
    ->not->toUse('Illuminate\Http\Request') // Controllers should use FormRequests
    ->ignoring('App\Http\Controllers\Controller');

arch('actions must be final and readonly')
    ->expect('App\Actions')
    ->toBeFinal()
    ->toBeReadonly();

arch('controllers only use actions and return json responses')
    ->expect('App\Http\Controllers')
    ->toUse('App\Actions')
    ->not->toUse('App\Models') // Controllers shouldn't directly touch models
    ->toUse('Illuminate\Http\JsonResponse');
```

---

## 7. Kesimpulan
Laravel Precognition, dipadukan dengan Clean Architecture, Form Requests yang disiplin, dan pengujian dengan Pest v3, memungkinkan Anda membangun antarmuka web modern dengan kecepatan umpan balik *Single Page Application* tanpa mengorbankan integritas dan keamanan backend. Menulis pengecualian `$this->isPrecognitive()` secara strategis pada validasi berat akan mencegah bottleneck performa dan potensi serangan DoS ringan dari interaksi pengguna yang sangat cepat.
