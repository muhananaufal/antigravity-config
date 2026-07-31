---
title: Kriptografi dan Manajemen Rahasia di Laravel 11+
description: Panduan mendalam tentang praktik terbaik enkripsi, hashing, dan manajemen data sensitif menggunakan ekosistem Laravel modern (PHP 8.3/8.4+).
author: Antigravity
---

# Kriptografi dan Manajemen Rahasia di Laravel (PHP 8.3/8.4+)

Kriptografi adalah salah satu pilar utama dalam membangun aplikasi web yang aman. Kesalahan kecil dalam mengelola data sensitif dapat berakibat fatal, mulai dari kebocoran data pengguna hingga pengambilalihan sistem. Laravel menyediakan pustaka kriptografi yang kuat dan mudah digunakan melalui facade `Crypt` dan `Hash`, yang dibungkus di atas OpenSSL dan fungsi hashing bawaan PHP. Dokumen ini akan membahas praktik terbaik, implementasi *Clean Architecture*, dan anti-pattern yang sering terjadi di dunia nyata.

## Konsep Dasar Kriptografi di Laravel

Dalam ekosistem Laravel modern (versi 11 dan 12), terdapat dua mekanisme utama untuk mengamankan data:
1.  **Encryption (Enkripsi):** Mengubah *plaintext* menjadi *ciphertext* yang tidak dapat dibaca tanpa kunci dekripsi yang valid. Enkripsi bersifat dua arah (dapat dikembalikan ke bentuk asal). Laravel menggunakan AES-256-CBC atau AES-128-CBC dengan Message Authentication Code (MAC) untuk mendeteksi modifikasi *ciphertext*.
2.  **Hashing (Pemerasan):** Mengubah data menjadi representasi string berukuran tetap. Hashing bersifat satu arah (tidak dapat dikembalikan). Ini digunakan untuk menyimpan password. Laravel mendukung algoritma Bcrypt dan Argon2 (Argon2i dan Argon2id).

---

## Anti-Pattern 1: Menyimpan Data Sensitif Tanpa Enkripsi Tersertifikasi (Homebrew Crypto)

Kesalahan paling umum adalah mencoba membuat algoritma enkripsi sendiri atau menggunakan fungsi usang seperti `md5()` atau `base64_encode()` dengan asumsi data tersebut aman. Ini sangat berbahaya karena tidak memberikan keamanan kriptografis yang valid dan rentan terhadap berbagai serangan (misalnya, *dictionary attack* atau analisis frekuensi).

### ❌ KODE SALAH: Homebrew "Encryption"
```php
<?php

declare(strict_types=1);

namespace App\Services;

class InsecureDataService
{
    /**
     * Menyimpan data dengan "enkripsi" palsu menggunakan Base64.
     * Ini BUKAN enkripsi, melainkan encoding biasa.
     */
    public function storeSensitiveData(string $userId, string $creditCardNumber): void
    {
        // BAHAYA: base64_encode dapat didekode oleh siapa saja dengan seketika.
        $obfuscatedCard = base64_encode($creditCardNumber);
        
        // BAHAYA: md5 sudah lama dianggap usang dan rentan terhadap tabrakan (collisions).
        $token = md5($userId . time());
        
        // Simpan ke database...
        // DB::table('user_cards')->insert(['user_id' => $userId, 'card' => $obfuscatedCard, 'token' => $token]);
    }
}
```
**Mengapa Berbahaya / Security Risk:**
- `base64_encode` bukanlah algoritma kriptografi. Ini hanya mengubah representasi biner menjadi teks ASCII yang aman untuk ditransmisikan. Siapa pun yang mendapatkan string ini dapat mengembalikannya menjadi nomor kartu kredit dalam hitungan milidetik menggunakan `base64_decode`.
- `md5` adalah fungsi hash yang sangat lemah. Hash MD5 dapat diretas menggunakan *rainbow tables* atau dibongkar melalui kekuatan komputasi modern dengan sangat cepat, yang mengorbankan integritas data.

### ✅ KODE BENAR: Menggunakan Facade `Crypt` Laravel
Gunakan pustaka bawaan Laravel yang telah teruji (AES-256-CBC) dengan Message Authentication Code (MAC) untuk memastikan keamanan dan integritas terhadap modifikasi (*tamper-proof*).

```php
<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\Crypt;
use Illuminate\Contracts\Encryption\EncryptException;
use Illuminate\Contracts\Encryption\DecryptException;

final readonly class SecureDataService
{
    /**
     * Enkripsi data sensitif menggunakan algoritma standar industri (AES-256-CBC).
     * 
     * @throws EncryptException Jika proses enkripsi gagal.
     */
    public function encryptCreditCard(string $creditCardNumber): string
    {
        // Crypt::encryptString() menghasilkan payload yang terenkripsi dan 
        // dilindungi oleh MAC (Message Authentication Code) untuk mencegah tamper.
        return Crypt::encryptString($creditCardNumber);
    }
    
    /**
     * Dekripsi data sensitif kembali ke bentuk aslinya.
     * 
     * @throws DecryptException Jika payload rusak atau dimodifikasi oleh penyerang.
     */
    public function decryptCreditCard(string $encryptedPayload): string
    {
        return Crypt::decryptString($encryptedPayload);
    }
}
```

---

## Anti-Pattern 2: Menangani Hash Password Secara Manual dan Lemah

Di era komputasi modern, menggunakan `sha1()` atau `md5()` untuk hashing password adalah tiket menuju bencana. Bahkan penggunaan `bcrypt` dengan parameter `cost` yang rendah bisa menjadi kelemahan jika penyerang menggunakan *hardware* khusus (seperti GPU atau ASIC). Kesalahan kritis lainnya adalah membandingkan hash menggunakan operator `==` atau `===` standar, yang rentan terhadap *Timing Attacks*.

### ❌ KODE SALAH: Hashing Rentan dan Perbandingan Waktu-Variabel (Timing Attack)
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;

class InsecureAuthController
{
    public function login(Request $request): JsonResponse
    {
        $user = User::where('email', $request->input('email'))->first();

        // BAHAYA 1: Menggunakan fungsi hash usang (SHA-256 tanpa salt individual).
        $hashedPassword = hash('sha256', $request->input('password'));

        // BAHAYA 2: Operator perbandingan biasa rentan terhadap Timing Attacks.
        // String comparison akan berhenti (return false) saat karakter pertama yang berbeda ditemukan,
        // memungkinkan penyerang menebak karakter satu per satu melalui observasi waktu respons HTTP.
        if ($user && $user->password === $hashedPassword) {
            return response()->json(['status' => 'success', 'token' => 'dummy_token']);
        }

        return response()->json(['status' => 'failed'], 401);
    }
}
```
**Mengapa Berbahaya / Memory & Security Risk:**
- **SHA-256 Tanpa Salt:** Hash ini dihitung terlalu cepat, memungkinkan penyerang melakukan serangan *brute-force* miliaran hash per detik menggunakan rig GPU modern. Selain itu ketiadaan random *salt* membuat password identik menghasilkan hash yang identik.
- **Timing Attack:** Operator perbandingan string (`===`) dalam PHP akan melakukan pengecekan per-karakter (*byte-by-byte*). Jika huruf pertama salah, eksekusi selesai lebih cepat. Jika huruf ke-10 yang salah, eksekusi selesai sedikit lebih lama. Ini membocorkan informasi sekuensial kepada penyerang yang memantau waktu latensi request (*side-channel attack*).

### ✅ KODE BENAR: Hashing Menggunakan `Hash::make()` dan `Hash::check()`
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Hash;

final class SecureAuthController
{
    /**
     * Autentikasi pengguna menggunakan verifikasi hash yang tahan terhadap Timing Attack.
     */
    public function login(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'email' => ['required', 'email'],
            'password' => ['required', 'string'],
        ]);

        $user = User::where('email', $validated['email'])->first();

        // AMAN: Hash::check() menggunakan fungsi hash_equals() di bawah kap, 
        // yang melakukan perbandingan waktu-konstan (constant-time comparison) 
        // untuk memastikan waktu komputasi selalu seragam guna mencegah Timing Attacks.
        if (!$user || !Hash::check($validated['password'], $user->password)) {
            // Gunakan pesan error umum agar penyerang tidak tahu persis 
            // apakah email yang tidak terdaftar, atau password yang salah (Mencegah Enumerasi Akun).
            return response()->json([
                'message' => 'Kredensial yang diberikan tidak valid.'
            ], 401);
        }

        // AMAN: Periksa apakah password perlu di-hash ulang dengan algoritma 
        // atau work-factor (cost) terbaru tanpa memaksa user reset password.
        if (Hash::needsRehash($user->password)) {
            $user->password = Hash::make($validated['password']);
            $user->save();
        }

        // Proses login...
        return response()->json([
            'message' => 'Login berhasil.',
            'token' => $user->createToken('api-token')->plainTextToken,
        ]);
    }
}
```

---

## Implementasi Clean Architecture: Sistem Rekam Medis Terenkripsi

Untuk mendemonstrasikan implementasi keamanan dengan standar Top 1%, kita akan merancang sistem penyimpanan data rekam medis di mana data pasien wajib dienkripsi di *Database* (Encryption At Rest) namun diolah menggunakan prinsip pemisahan tanggung jawab (*Clean Architecture*).

### 1. Eloquent Model & Data Transfer Object (DTO)

Model tidak menangani enkripsi secara manual, namun mendefinisikan struktur database. DTO memastikan *type safety* komunikasi antar layer.

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

final class MedicalRecord extends Model
{
    /**
     * Pastikan kolom 'diagnosis_data' di database bertipe TEXT atau LONGTEXT.
     * Enkripsi AES-256 dengan MAC base64 akan melipatgandakan panjang string asli.
     */
    protected $fillable = [
        'user_id',
        'record_number',
        'diagnosis_data', 
    ];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\DTOs;

/**
 * Membungkus payload input yang sudah divalidasi ke dalam DTO yang strongly-typed.
 */
final readonly class StoreMedicalRecordDTO
{
    public function __construct(
        public int $userId,
        public string $recordNumber,
        public array $diagnosisDetails
    ) {}
}
```

### 2. Form Request Validation (Pertahanan Baris Depan)

Validasi input wajib dilakukan sebelum data menyentuh layanan kriptografi guna mencegah *payload injection* atau data yang cacat yang dapat merusak integritas algoritma.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class StoreMedicalRecordRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // Asumsi: Authorization ditangani via Middleware Guard & Policies.
    }

    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'user_id' => ['required', 'integer', 'exists:users,id'],
            'record_number' => ['required', 'string', 'max:50', 'unique:medical_records,record_number'],
            'diagnosis_details' => ['required', 'array'],
            'diagnosis_details.condition' => ['required', 'string', 'max:255'],
            'diagnosis_details.notes' => ['nullable', 'string', 'max:2000'],
        ];
    }
}
```

### 3. Action Layer (Core Business Logic)

Layer inilah yang secara independen bertanggung jawab untuk melakukan proses serialisasi dan kriptografi, mengisolasinya dari Controller dan Infrastructure DB.

```php
<?php

declare(strict_types=1);

namespace App\Actions\Medical;

use App\DTOs\StoreMedicalRecordDTO;
use App\Models\MedicalRecord;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Contracts\Encryption\EncryptException;
use RuntimeException;
use JsonException;

final readonly class StoreEncryptedMedicalRecordAction
{
    /**
     * Memproses data rekam medis menjadi JSON yang dienkripsi aman.
     * 
     * @throws RuntimeException Jika konversi JSON atau proses enkripsi terhenti.
     */
    public function execute(StoreMedicalRecordDTO $dto): MedicalRecord
    {
        try {
            // Serialisasi data berstruktur tinggi ke format JSON literal secara strik
            $jsonPayload = json_encode($dto->diagnosisDetails, JSON_THROW_ON_ERROR);
            
            // Enkripsi Payload ke Ciphertext
            $encryptedData = Crypt::encryptString($jsonPayload);
            
            return MedicalRecord::create([
                'user_id' => $dto->userId,
                'record_number' => $dto->recordNumber,
                'diagnosis_data' => $encryptedData,
            ]);
        } catch (JsonException | EncryptException $e) {
            // Tangkap exception low-level dan lempar sebagai RuntimeException yang terkendali
            throw new RuntimeException('Gagal memproses dan mengenkripsi rekam medis: ' . $e->getMessage(), 0, $e);
        }
    }
}
```

### 4. Controller Layer (Entry Point)

Controller di Clean Architecture sangat ramping. Ia tidak tahu menahu mengenai AES, Hashing, ataupun struktur JSON. Ia hanya merakit DTO dan mendelegasikan perintah.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreMedicalRecordRequest;
use App\DTOs\StoreMedicalRecordDTO;
use App\Actions\Medical\StoreEncryptedMedicalRecordAction;
use Illuminate\Http\JsonResponse;

final class MedicalRecordController extends Controller
{
    public function store(
        StoreMedicalRecordRequest $request,
        StoreEncryptedMedicalRecordAction $action
    ): JsonResponse {
        $dto = new StoreMedicalRecordDTO(
            userId: (int) $request->validated('user_id'),
            recordNumber: (string) $request->validated('record_number'),
            diagnosisDetails: (array) $request->validated('diagnosis_details')
        );

        $record = $action->execute($dto);

        return response()->json([
            'message' => 'Rekam medis berhasil disimpan dan dienkripsi secara aman (Encryption-At-Rest).',
            'data' => [
                'id' => $record->id,
                'record_number' => $record->record_number,
                // Mencegah kebocoran ciphertext langsung ke respon JSON HTTP
            ]
        ], 201);
    }
}
```

---

## Pest v3 Testing: Architecture & Unit

Keandalan sistem keamanan ini akan dipastikan secara otomatis menggunakan Test Framework modern Pest v3.

### 1. Architecture Testing (`tests/ArchTest.php`)

Kita memberlakukan larangan (*guardrails*) ketat di seluruh kode dasar aplikasi, memastikan tidak ada pemanggilan kriptografi liar dari Controller.

```php
<?php

declare(strict_types=1);

uses()->group('architecture');

arch('controllers_must_not_use_cryptography_facades_directly')
    ->expect('App\Http\Controllers')
    ->not->toUse([
        'Illuminate\Support\Facades\Crypt',
        'Illuminate\Support\Facades\Hash',
    ])
    ->ignoring('App\Http\Controllers\Api\SecureAuthController'); // Pengecualian sadar untuk Auth controller

arch('actions_layer_must_be_final_and_readonly')
    ->expect('App\Actions')
    ->toBeClasses()
    ->toBeFinal()
    ->toBeReadonly();

arch('strict_types_are_strictly_enforced_everywhere')
    ->expect('App')
    ->toUseStrictTypes();
```

### 2. Unit Testing & Integration (`tests/Feature/MedicalRecordEncryptionTest.php`)

```php
<?php

declare(strict_types=1);

use App\Models\User;
use App\Models\MedicalRecord;
use App\Actions\Medical\StoreEncryptedMedicalRecordAction;
use App\DTOs\StoreMedicalRecordDTO;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Contracts\Encryption\EncryptException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use RuntimeException;

uses(RefreshDatabase::class);

it('successfully stores an encrypted medical record and verifies decryption integrity', function () {
    // 1. Arrange: Siapkan entitas dan DTO
    $user = User::factory()->create();
    $dto = new StoreMedicalRecordDTO(
        userId: $user->id,
        recordNumber: 'MR-2026-X01',
        diagnosisDetails: [
            'condition' => 'Tuberculosis',
            'notes' => 'Pasien butuh observasi lanjutan.',
        ]
    );

    $action = app(StoreEncryptedMedicalRecordAction::class);

    // 2. Act: Eksekusi aksi utama
    $record = $action->execute($dto);

    // 3. Assert: Pastikan instansi DB terbentuk dengan valid
    expect($record)->toBeInstanceOf(MedicalRecord::class)
        ->and($record->record_number)->toBe('MR-2026-X01');

    // 4. Assert Security: Validasi data di dalam tabel DB (Ciphertext)
    $dbRecord = MedicalRecord::find($record->id);
    
    // Pastikan kata 'Tuberculosis' tidak bocor sebagai Plaintext
    expect($dbRecord->diagnosis_data)->not->toContain('Tuberculosis')
        ->and($dbRecord->diagnosis_data)->toBeString()
        ->and(strlen($dbRecord->diagnosis_data))->toBeGreaterThan(50); // Minimal ukuran payload AES + MAC

    // 5. Assert Decryption: Memastikan Ciphertext dapat dikonversi kembali ke state asli secara presisi
    $decryptedPayload = Crypt::decryptString($dbRecord->diagnosis_data);
    $decodedData = json_decode($decryptedPayload, true, 512, JSON_THROW_ON_ERROR);
    
    expect($decodedData['condition'])->toBe('Tuberculosis')
        ->and($decodedData['notes'])->toBe('Pasien butuh observasi lanjutan.');
});

it('gracefully throws a strict runtime exception when encryption service fails', function () {
    // 1. Arrange
    $user = User::factory()->create();
    $dto = new StoreMedicalRecordDTO(
        userId: $user->id,
        recordNumber: 'MR-2026-X02',
        diagnosisDetails: ['condition' => 'Fever']
    );

    $action = app(StoreEncryptedMedicalRecordAction::class);

    // Mencekik Facade untuk mensimulasikan Error Hardware/Library OpenSSL
    Crypt::shouldReceive('encryptString')
        ->once()
        ->andThrow(new EncryptException('Mocked OpenSSL encryption failure.'));

    // 2. Act & Assert: Mengekspektasikan sistem akan gagal tertutup (fail-closed)
    expect(fn() => $action->execute($dto))
        ->toThrow(RuntimeException::class, 'Gagal memproses dan mengenkripsi rekam medis: Mocked OpenSSL encryption failure.');
});
```

---

## Praktik Terbaik Lanjutan: Manajemen Siklus Hidup Kunci (`APP_KEY`)

Rahasia tertinggi yang menjaga semua kriptografi Anda adalah `APP_KEY` yang tersembunyi di `.env`. 

1. **Konsekuensi Kebocoran:** Jika `APP_KEY` bocor, seluruh baris data terenkripsi di *Database* (termasuk session, cookie terenkripsi, dll) menjadi *compromised*.
2. **Rotasi Kunci Berkala (Graceful Key Rotation di Laravel 11+):**
   Memaksa pembaruan kunci (`php artisan key:generate`) tanpa pedoman akan mematahkan semua data (Invalid MAC Exception) saat data lama mencoba dibaca.
   Di Laravel 11+, terdapat mekanisme **Graceful Key Rotation** menggunakan variabel `APP_PREVIOUS_KEYS`.

Implementasi yang benar di lingkungan *Production*:
```dotenv
# Kunci baru yang akan digunakan secara eksklusif untuk MENGENKRIPSI data baru
APP_KEY=base64:NEW_GENERATED_KEY_HERE=

# Kunci usang yang akan digunakan sebagai FALLBACK untuk MENDEKRIPSI data lampau
APP_PREVIOUS_KEYS=base64:OLD_KEY_ONE_HERE=,base64:OLD_KEY_TWO_HERE=
```
Ketika Laravel gagal mendekripsi data dengan kunci saat ini, ia akan mencoba kunci lawas yang ada dalam senarai `APP_PREVIOUS_KEYS`. Jika berhasil, Anda dapat mendesain background Job (Queue) secara bertahap untuk membaca data terenkripsi lama dan menyimpannya kembali (Re-encrypt) memakai `APP_KEY` baru.

Kesalahan dalam memahami fungsi Kriptografi pada ekosistem web bukan hanya sekedar "bug teknis", namun ancaman asimetris yang melanggar standar privasi (GDPR / HIPAA / PDP). Implementasi *type-safety*, *constant-time comparison*, dan *Graceful Rotation* merupakan bukti sistem Anda berkapabilitas skala *Enterprise*.
