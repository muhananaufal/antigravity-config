# Mastery Guide: KMS Envelope Encryption di Laravel 11/12

Dokumen ini adalah panduan top 1% *engineering* untuk mengimplementasikan **KMS (Key Management Service) Envelope Encryption** pada aplikasi Laravel berarsitektur *Clean Architecture*. Pendekatan ini dirancang untuk sistem kritikal (seperti PII, rekam medis, data finansial) dengan standar keamanan Enterprise.

---

## 1. Konsep Inti Envelope Encryption

Dalam sistem basis data berskala besar, mengenkripsi ribuan hingga jutaan baris data secara langsung menggunakan sebuah Master Key dari penyedia KMS (seperti AWS KMS, Google Cloud KMS, atau HashiCorp Vault) adalah **malpraktik**. Memanggil API eksternal per baris data untuk enkripsi/dekripsi akan menghancurkan performa sistem (*latency bottleneck*) dan menguras kuota API KMS.

**Envelope Encryption** memecahkan masalah ini dengan konsep enkripsi berlapis:
1. **Data Encryption Key (DEK):** Aplikasi membuat kunci acak lokal (simetris, misal 256-bit AES-GCM) untuk mengenkripsi *payload* aktual. Proses enkripsi payload terjadi 100% lokal di memori server.
2. **Key Encryption Key (KEK):** DEK yang dihasilkan kemudian dikirim ke KMS. KMS menggunakan KEK (Master Key) untuk mengenkripsi DEK tersebut.
3. **Penyimpanan:** Aplikasi menyimpan `encrypted_payload` (data yang dienkripsi oleh DEK) **bersamaan** dengan `encrypted_dek` (DEK yang dienkripsi oleh KMS) ke dalam database.

Saat mendekripsi:
1. Ambil `encrypted_payload` dan `encrypted_dek` dari database.
2. Kirim `encrypted_dek` ke KMS untuk didekripsi kembali menjadi DEK dalam bentuk *plaintext*.
3. Gunakan DEK *plaintext* di memori lokal untuk mendekripsi `encrypted_payload`.
4. Hapus DEK *plaintext* dari memori sesegera mungkin (`sodium_memzero`).

**Kelebihan utama:**
- **Performa Ekstrim:** Payload raksasa dienkripsi secara lokal (Cepat). KMS hanya memproses data kecil (Kunci DEK 32-byte).
- **Key Rotation Sempurna:** Anda dapat melakukan rotasi Master KEK di KMS kapan saja tanpa perlu menyentuh atau mengenkripsi ulang Terabyte data di database. Cukup dekripsi `encrypted_dek` dengan KEK lama, dan re-enkripsi dengan KEK baru.

---

## 2. Arsitektur Domain & Interface (Clean Architecture)

Kita akan memisahkan *concern* melalui *Clean Architecture*: *Request* -> *Controller* -> *Action* -> *Repository* -> *Model*.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Security\Contracts;

interface KmsProviderInterface
{
    /**
     * Meminta KMS untuk meng-generate Data Encryption Key (DEK).
     * Mengembalikan array berisi plaintext_dek dan encrypted_dek.
     *
     * @return array{plaintext_dek: string, encrypted_dek: string}
     */
    public function generateDataKey(string $keyId, array $encryptionContext = []): array;

    /**
     * Mendekripsi encrypted_dek menggunakan KMS.
     *
     * @return string Plaintext DEK
     */
    public function decryptDataKey(string $encryptedDek, array $encryptionContext = []): string;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Domain\Security\DataTransferObjects;

final readonly class EncryptedPayloadDto
{
    public function __construct(
        public string $ciphertext,
        public string $encryptedDek,
        public string $nonce
    ) {}
}
```

---

## 3. Infrastruktur & Core Logic

### A. KMS Service Implementation (AWS KMS)

Menggunakan AWS SDK untuk PHP. Kita menginjeksi kredensial secara aman.

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Security\Providers;

use App\Domain\Security\Contracts\KmsProviderInterface;
use Aws\Kms\KmsClient;
use Aws\Exception\AwsException;
use Illuminate\Support\Facades\Log;
use RuntimeException;

final readonly class AwsKmsProvider implements KmsProviderInterface
{
    public function __construct(
        private KmsClient $client
    ) {}

    public function generateDataKey(string $keyId, array $encryptionContext = []): array
    {
        try {
            $result = $this->client->generateDataKey([
                'KeyId' => $keyId,
                'KeySpec' => 'AES_256',
                'EncryptionContext' => $encryptionContext,
            ]);

            return [
                'plaintext_dek' => $result['Plaintext'],
                'encrypted_dek' => base64_encode($result['CiphertextBlob']),
            ];
        } catch (AwsException $exception) {
            Log::critical('KMS Generate Data Key Failed', ['error' => $exception->getMessage()]);
            throw new RuntimeException('Failed to generate KMS data key.', 0, $exception);
        }
    }

    public function decryptDataKey(string $encryptedDek, array $encryptionContext = []): string
    {
        try {
            $result = $this->client->decrypt([
                'CiphertextBlob' => base64_decode($encryptedDek),
                'EncryptionContext' => $encryptionContext,
            ]);

            return (string) $result['Plaintext'];
        } catch (AwsException $exception) {
            Log::critical('KMS Decrypt Data Key Failed', ['error' => $exception->getMessage()]);
            throw new RuntimeException('Failed to decrypt KMS data key.', 0, $exception);
        }
    }
}
```

### B. Action Layer: Core Encryption Logic (AEAD)

Menggunakan `sodium_crypto_aead_xchacha20poly1305_ietf_encrypt` untuk *Authenticated Encryption with Associated Data* (AEAD) demi mencegah serangan manipulasi *ciphertext*.

```php
<?php

declare(strict_types=1);

namespace App\Application\Actions\Security;

use App\Domain\Security\Contracts\KmsProviderInterface;
use App\Domain\Security\DataTransferObjects\EncryptedPayloadDto;
use Illuminate\Support\Facades\Config;
use RuntimeException;

final readonly class EnvelopeEncryptAction
{
    public function __construct(
        private KmsProviderInterface $kmsProvider
    ) {}

    /**
     * @param array<string, mixed> $payload Data yang akan dienkripsi
     * @param string $tenantId ID Tenant sebagai AAD (Additional Authenticated Data) untuk mencegah Confused Deputy Attack
     */
    public function execute(array $payload, string $tenantId): EncryptedPayloadDto
    {
        $keyId = Config::get('services.kms.master_key_id');
        if (!is_string($keyId) || $keyId === '') {
            throw new RuntimeException('KMS Master Key ID is not configured properly.');
        }

        // 1. Generate DEK dari KMS (Mengikat kunci dengan Tenant ID via Encryption Context)
        $encryptionContext = ['tenant_id' => $tenantId];
        $keyData = $this->kmsProvider->generateDataKey($keyId, $encryptionContext);

        $plaintextDek = $keyData['plaintext_dek'];
        $encryptedDek = $keyData['encrypted_dek'];

        // 2. Persiapkan lokal enkripsi (XChaCha20-Poly1305)
        $nonce = random_bytes(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES);
        $plaintextData = json_encode($payload, JSON_THROW_ON_ERROR);

        // 3. Enkripsi lokal menggunakan DEK plaintext
        // Menjadikan tenant_id sebagai Associated Data, jika diubah oleh attacker, dekripsi akan gagal/tamper-evident
        $ciphertext = sodium_crypto_aead_xchacha20poly1305_ietf_encrypt(
            $plaintextData,
            $tenantId, // AAD
            $nonce,
            $plaintextDek
        );

        // 4. Secure Erase DEK plaintext dari Memory RAM (Penting untuk keamanan memory!)
        sodium_memzero($plaintextDek);

        return new EncryptedPayloadDto(
            ciphertext: base64_encode($ciphertext),
            encryptedDek: $encryptedDek,
            nonce: base64_encode($nonce)
        );
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Application\Actions\Security;

use App\Domain\Security\Contracts\KmsProviderInterface;
use App\Domain\Security\DataTransferObjects\EncryptedPayloadDto;
use RuntimeException;

final readonly class EnvelopeDecryptAction
{
    public function __construct(
        private KmsProviderInterface $kmsProvider
    ) {}

    /**
     * @return array<string, mixed>
     */
    public function execute(EncryptedPayloadDto $dto, string $tenantId): array
    {
        // 1. Dekripsi DEK via KMS
        $encryptionContext = ['tenant_id' => $tenantId];
        $plaintextDek = $this->kmsProvider->decryptDataKey($dto->encryptedDek, $encryptionContext);

        // 2. Dekripsi Payload Lokal
        $ciphertext = base64_decode($dto->ciphertext, true);
        $nonce = base64_decode($dto->nonce, true);

        if ($ciphertext === false || $nonce === false) {
            sodium_memzero($plaintextDek);
            throw new RuntimeException('Invalid base64 payload encoding.');
        }

        $plaintextData = sodium_crypto_aead_xchacha20poly1305_ietf_decrypt(
            $ciphertext,
            $tenantId, // Harus persis sama dengan AAD saat enkripsi
            $nonce,
            $plaintextDek
        );

        // 3. Clean up memori
        sodium_memzero($plaintextDek);

        if ($plaintextData === false) {
            throw new RuntimeException('Decryption failed or data integrity compromised (MAC mismatch).');
        }

        return json_decode($plaintextData, true, 512, JSON_THROW_ON_ERROR);
    }
}
```

---

## 4. Layer Penyimpanan (Model & Repository)

### Eloquent Model

```php
<?php

declare(strict_types=1);

namespace App\Domain\Sensors\Models;

use Illuminate\Database\Eloquent\Model;

final class SensitiveSensorData extends Model
{
    protected $table = 'sensitive_sensor_data';

    protected $fillable = [
        'tenant_id',
        'encrypted_payload',
        'encrypted_dek',
        'nonce',
    ];

    /**
     * Pastikan data rahasia tidak pernah terekspos ketika model di-serialize ke JSON.
     */
    protected $hidden = [
        'encrypted_dek',
    ];
}
```

### Repository

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Sensors\Repositories;

use App\Domain\Sensors\Models\SensitiveSensorData;
use App\Domain\Security\DataTransferObjects\EncryptedPayloadDto;
use Illuminate\Database\Eloquent\Collection;

final readonly class SensorDataRepository
{
    public function storeSecurely(string $tenantId, EncryptedPayloadDto $dto): SensitiveSensorData
    {
        return SensitiveSensorData::create([
            'tenant_id' => $tenantId,
            'encrypted_payload' => $dto->ciphertext,
            'encrypted_dek' => $dto->encryptedDek,
            'nonce' => $dto->nonce,
        ]);
    }

    public function findByTenant(string $tenantId): Collection
    {
        return SensitiveSensorData::where('tenant_id', $tenantId)->get();
    }
}
```

---

## 5. HTTP Layer (Controller & Request)

### Form Request

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Sensors;

use Illuminate\Foundation\Http\FormRequest;

final class StoreSecureSensorRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user() !== null; // Contoh otorisasi sederhana
    }

    public function rules(): array
    {
        return [
            'tenant_id' => ['required', 'uuid'],
            'sensor_metrics' => ['required', 'array'],
            'sensor_metrics.temperature' => ['required', 'numeric'],
            'sensor_metrics.humidity' => ['required', 'numeric'],
        ];
    }
}
```

### Controller

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Sensors;

use App\Application\Actions\Security\EnvelopeEncryptAction;
use App\Http\Requests\Sensors\StoreSecureSensorRequest;
use App\Infrastructure\Sensors\Repositories\SensorDataRepository;
use Illuminate\Http\JsonResponse;

final class SensorDataController
{
    public function __construct(
        private readonly EnvelopeEncryptAction $encryptAction,
        private readonly SensorDataRepository $repository
    ) {}

    public function store(StoreSecureSensorRequest $request): JsonResponse
    {
        $validated = $request->validated();
        $tenantId = $validated['tenant_id'];
        $payload = $validated['sensor_metrics'];

        // Eksekusi Enkripsi
        $encryptedDto = $this->encryptAction->execute($payload, $tenantId);

        // Persistensi ke Database
        $this->repository->storeSecurely($tenantId, $encryptedDto);

        return new JsonResponse([
            'status' => 'success',
            'message' => 'Sensor data encrypted and stored securely.',
        ], 201);
    }
}
```

---

## 6. Anti-Patterns & Security Risks

### ❌ Anti-Pattern 1: Menggunakan Master Key yang Sama (Static DEK) untuk Semua Baris Data
Banyak developer pemula mengambil Master Key dari variabel lingkungan (`.env`) lalu menggunakannya sebagai kunci AES untuk mengenkripsi setiap baris data di seluruh tabel.

```php
// ❌ SANGAT BERBAHAYA (ANTI-PATTERN)
$masterKey = env('APP_ENCRYPTION_KEY'); 
$ciphertext = openssl_encrypt($data, 'aes-256-cbc', $masterKey, 0, $staticIv);
```

**Security & Memory Risks:**
- **Key Blast Radius Sempurna:** Jika `$masterKey` bocor (misal melalui *Directory Traversal* membaca file `.env` atau serangan eksfiltrasi memori/RCE), *attacker* langsung mendapatkan akses *plaintext* ke 100% database Anda seketika. Tidak ada pertahanan berlapis.
- **IV/Nonce Reuse Attack:** Dalam banyak kasus, developer juga me-reuse Initialization Vector (IV). Dalam algoritma stream cipher / CTR / GCM, re-use Nonce akan menghancurkan kerahasiaan enkripsi (serangan XOR).
- **Compliance Violation:** Tidak memenuhi standar PCI-DSS atau HIPAA yang mewajibkan isolasi kunci per record (DEK) dan sentralisasi rotasi KEK via Hardware Security Module (HSM).

**✅ Solusi (KMS Envelope):**
Setiap baris data memiliki kuncinya (DEK) masing-masing yang unik secara kriptografis. Kunci baris tersebut kemudian dibungkus (*wrapped*) oleh Master KEK di KMS. Jika satu DEK bocor dari memori *dump*, kerusakan hanya terbatas pada **satu baris data**, bukan seluruh tabel.

### ❌ Anti-Pattern 2: Tidak Memanfaatkan Associated Data (AAD) di AEAD dan Menjalankan Enkripsi Tanpa Integritas
Mengenikripsi data dengan AES-CBC atau algoritma simetris yang tidak mendukung validasi integritas (MAC - Message Authentication Code), serta mengabaikan konteks (seperti siapa pemilik data tersebut).

```php
// ❌ SANGAT BERBAHAYA (ANTI-PATTERN) - Enkripsi Non-Authenticated (AES-CBC)
$ciphertext = openssl_encrypt($payload, 'aes-256-cbc', $dek, 0, $iv);
// Attacker dapat memanipulasi bit pada $ciphertext di database (Bit-Flipping Attack/Padding Oracle Attack).
```

**Security Risks:**
- **Padding Oracle & Malleability:** AES-CBC *tanpa* validasi HMAC sangat rentan terhadap manipulasi modifikasi *ciphertext* di dalam database (*Bit-Flipping Attack*). Attacker bisa mengubah `role: user` menjadi `role: admin` dengan membalik beberapa bit *ciphertext*, lalu sistem mendekripsinya sebagai instruksi valid.
- **Confused Deputy Attack (Akses Lintas Tenant):** Jika DEK bisa didekripsi, apa yang menghentikan Tenant A untuk menyuapkan `encrypted_payload` milik Tenant B? Sistem akan buta dan mendekripsinya karena kuncinya cocok.

**✅ Solusi (XChaCha20-Poly1305 + KMS Encryption Context):**
1. **AEAD (Poly1305 MAC):** Menggunakan otentikasi. Setiap modifikasi *ciphertext* walau 1 bit akan menyebabkan pengecekan MAC gagal di fungsi `sodium_crypto_aead_xchacha20poly1305_ietf_decrypt`, melempar error `false` dan menolak dekripsi.
2. **KMS Encryption Context & AAD:** Menambahkan `tenant_id` sebagai konteks saat membuat DEK dari KMS, dan menyuapkannya sebagai parameter `$additional_data` pada *Sodium*. Kunci menjadi terikat (*cryptographically bound*) ke identitas Tenant. Dekripsi data Tenant A tidak akan bisa dieksekusi dalam *request lifecycle* milik Tenant B.

---

## 7. Pest v3 Testing (Unit & Architecture Test)

### Architecture Testing (Arch Test)

Pastikan dependensi Clean Architecture tetap ketat dan fungsi berbahaya tidak digunakan.

```php
<?php

declare(strict_types=1);

use App\Domain\Security\Contracts\KmsProviderInterface;

// tests/ArchTest.php

test('strict types are enforced across the codebase')
    ->expect('App')
    ->toUseStrictTypes();

test('domain layer does not depend on infrastructure layer')
    ->expect('App\Domain')
    ->not->toUse('App\Infrastructure');

test('action layer should only depend on domain contracts, not implementations')
    ->expect('App\Application\Actions')
    ->not->toUse('App\Infrastructure');

test('avoid insecure crypto functions')
    ->expect(['md5', 'sha1', 'openssl_encrypt', 'mcrypt_encrypt'])
    ->not->toBeUsed();
```

### Unit Testing dengan Mock KMS

Menguji *Action* enkripsi tanpa perlu menembak API AWS KMS yang sebenarnya.

```php
<?php

declare(strict_types=1);

use App\Application\Actions\Security\EnvelopeEncryptAction;
use App\Application\Actions\Security\EnvelopeDecryptAction;
use App\Domain\Security\Contracts\KmsProviderInterface;
use App\Domain\Security\DataTransferObjects\EncryptedPayloadDto;
use Illuminate\Support\Facades\Config;

// tests/Unit/Actions/EnvelopeEncryptionTest.php

beforeEach(function () {
    Config::set('services.kms.master_key_id', 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012');

    // Buat Dummy DEK 32 bytes
    $this->dummyDek = random_bytes(32);
    $this->dummyEncryptedDek = base64_encode('ENCRYPTED_VERSION_OF_DEK_FROM_KMS');

    // Mock Provider KMS (Inversion of Control)
    $this->mockKmsProvider = Mockery::mock(KmsProviderInterface::class);
});

test('EnvelopeEncryptAction encrypts data and binds to tenant_id correctly', function () {
    $tenantId = 'tenant-uuid-123';
    $payload = ['sensor' => 'temperature', 'value' => 42.5];

    $this->mockKmsProvider
        ->shouldReceive('generateDataKey')
        ->once()
        ->with('arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012', ['tenant_id' => $tenantId])
        ->andReturn([
            'plaintext_dek' => $this->dummyDek,
            'encrypted_dek' => $this->dummyEncryptedDek,
        ]);

    $action = new EnvelopeEncryptAction($this->mockKmsProvider);
    $result = $action->execute($payload, $tenantId);

    expect($result)->toBeInstanceOf(EncryptedPayloadDto::class)
        ->and($result->encryptedDek)->toBe($this->dummyEncryptedDek)
        ->and(base64_decode($result->ciphertext))->not->toBeEmpty()
        ->and(base64_decode($result->nonce))->toHaveLength(24); // Ukuran XChaCha20 Nonce
});

test('EnvelopeDecryptAction successfully decrypts back to original payload', function () {
    $tenantId = 'tenant-uuid-123';
    $payload = ['sensor' => 'temperature', 'value' => 42.5];

    // Simulasikan enkripsi manual
    $nonce = random_bytes(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES);
    $ciphertext = sodium_crypto_aead_xchacha20poly1305_ietf_encrypt(
        json_encode($payload),
        $tenantId, // AAD
        $nonce,
        $this->dummyDek
    );

    $dto = new EncryptedPayloadDto(
        ciphertext: base64_encode($ciphertext),
        encryptedDek: $this->dummyEncryptedDek,
        nonce: base64_encode($nonce)
    );

    $this->mockKmsProvider
        ->shouldReceive('decryptDataKey')
        ->once()
        ->with($this->dummyEncryptedDek, ['tenant_id' => $tenantId])
        ->andReturn($this->dummyDek);

    $action = new EnvelopeDecryptAction($this->mockKmsProvider);
    $decryptedPayload = $action->execute($dto, $tenantId);

    expect($decryptedPayload)->toBeArray()
        ->and($decryptedPayload['sensor'])->toBe('temperature')
        ->and($decryptedPayload['value'])->toBe(42.5);
});

test('EnvelopeDecryptAction fails when Tenant ID (AAD) does not match', function () {
    $tenantId = 'tenant-uuid-123';
    $attackerTenantId = 'tenant-uuid-999'; // BEDA!
    $payload = ['sensor' => 'temperature', 'value' => 42.5];

    $nonce = random_bytes(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES);
    $ciphertext = sodium_crypto_aead_xchacha20poly1305_ietf_encrypt(
        json_encode($payload),
        $tenantId, // Enkripsi pakai AAD tenant-uuid-123
        $nonce,
        $this->dummyDek
    );

    $dto = new EncryptedPayloadDto(
        ciphertext: base64_encode($ciphertext),
        encryptedDek: $this->dummyEncryptedDek,
        nonce: base64_encode($nonce)
    );

    $this->mockKmsProvider
        ->shouldReceive('decryptDataKey')
        ->once()
        ->with($this->dummyEncryptedDek, ['tenant_id' => $attackerTenantId])
        ->andReturn($this->dummyDek);

    $action = new EnvelopeDecryptAction($this->mockKmsProvider);
    
    // Expectation: error dilempar karena validasi MAC AAD akan gagal.
    $this->expectException(RuntimeException::class);
    $this->expectExceptionMessage('Decryption failed or data integrity compromised');

    $action->execute($dto, $attackerTenantId);
});
```

---

## 8. Ringkasan Eksekutif

- **Zero-Trust Memory:** DEK `plaintext` wajib dibersihkan menggunakan `sodium_memzero` sesegera mungkin di memori untuk mitigasi celah kebocoran RAM/Dump (Spectre, Memory Leak).
- **Associated Data (AAD):** Jadikan referensi konseptual *Tenant ID*, *User ID*, atau *Sensor ID* sebagai AAD agar *ciphertext* terkunci dengan konteks identitasnya (*Mitigating Confused Deputy Attacks*).
- **Skalabilitas Data Raksasa:** Basis data timeseries (*Time-Scale*) dapat dirotasi keamanannya dengan merotasi KMS Master Key, lalu menjalankan job asinkron lambat untuk *merotasi* file kunci DEK yang kecil, tanpa perlu membaca atau merotasi keseluruhan Terabytes *Payload*. 
- **Separation of Duties:** Clean Architecture memisahkan urusan enkripsi ke tingkat `Action` (Domain Business Rules) sementara `Model` (Infrastructure layer Eloquent) hanya menyimpan representasi string. Controller tidak boleh tahu menahu *kapan* dan *bagaimana* payload dienkripsi.
