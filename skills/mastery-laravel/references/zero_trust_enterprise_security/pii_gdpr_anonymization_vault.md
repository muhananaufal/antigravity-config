# PII GDPR Anonymization & Tokenization Vault di Laravel

Dalam sistem enterprise, data Personally Identifiable Information (PII) seperti nomor KTP, kartu kredit, dan nomor telepon tidak boleh disimpan dalam plain text di database utama. Dokumen ini menjelaskan implementasi Laravel Encrypted Casts yang ekstrim, arsitektur Tokenization Vault, dan mekanisme otomatis pemenuhan regulasi GDPR "Right to be Forgotten".

## Arsitektur Tokenization Vault & PII Encryption (ASCII Diagram)

```text
[Main Application DB]                 [Tokenization Vault DB (Isolated)]
+---------------------------+         +-------------------------------------+
| Users Table               |         | Vault Table (Strictly Monitored)    |
| - id: ULID                | ===>    | - user_id: ULID                     |
| - vault_token: UUID       | <===    | - vault_token: UUID (Index)         |
| - email: HASH(SHA256)     |         | - email_encrypted: AES-256-CBC      |
| - profile_data_enc: TEXT  |         | - ssn_encrypted: AES-256-CBC        |
| - is_anonymized: BOOLEAN  |         | - credit_card_encrypted: AES-256-CBC|
+---------------------------+         +-------------------------------------+
        ^                                      ^
        | (Kueri relasional lambat/tidak ada)  | (Koneksi DB terpisah, IAM ketat)
        +--------------------------------------+
                 [Laravel Eloquent Model via DB Connection Splitting]
```

## 1. Implementasi Encrypted Casts (Data At-Rest)

Kita menggunakan fitur bawaan Laravel `encrypted:array` dan `encrypted:object` untuk secara otomatis mengenkripsi data saat disimpan, dan dekripsi saat ditarik. Untuk index pencarian (seperti email), kita menggunakan teknik *Blind Index* (hash deterministic).

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Builder;

final class UserIdentity extends Model
{
    /**
     * Koneksi terpisah untuk database Vault yang sangat aman.
     * Hanya aplikasi tertentu dan service role khusus yang bisa mengakses.
     */
    protected $connection = 'vault_db';
    protected $table = 'secure_identities';

    /**
     * Cast attributes ke tipe encrypted.
     * Laravel akan menggunakan APP_KEY (atau key khusus) untuk AES-256-GCM enkripsi.
     */
    protected $casts = [
        'full_name' => 'encrypted',
        'address_details' => 'encrypted:array', // Enkripsi JSON array
        'medical_records' => 'encrypted:object',
    ];

    /**
     * Setter untuk menggenerate Blind Index Email
     * Berguna jika kita perlu fitur "Cari user berdasarkan email" tanpa 
     * mendekripsi seluruh tabel (karena AES itu non-deterministic).
     */
    public function setEmailAttribute(string $value): void
    {
        $this->attributes['email_encrypted'] = encrypt($value);
        
        // HMAC SHA-256 deterministic hash untuk pencarian
        $this->attributes['email_bindex'] = hash_hmac('sha256', strtolower($value), config('app.bindex_key'));
    }

    /**
     * Scope pencarian email menggunakan Blind Index
     */
    public function scopeWhereEmail(Builder $query, string $email): void
    {
        $bindex = hash_hmac('sha256', strtolower($email), config('app.bindex_key'));
        $query->where('email_bindex', $bindex);
    }
}
```

## 2. Automated GDPR "Right to be Forgotten" (Anonymization)

Regulasi GDPR mensyaratkan data pribadi harus dihapus (atau dianomimkan) saat user memintanya atau retensi habis. Karena referensi database mungkin rumit untuk dihapus (merusak foreign key statistik), kita melakukan *hard anonymization*.

```php
<?php

declare(strict_types=1);

namespace App\Jobs;

use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\DB;
use App\Models\UserIdentity;
use Illuminate\Support\Str;

final class ProcessGdprAnonymization implements ShouldQueue
{
    use Queueable;

    public function __construct(
        private readonly string $userId
    ) {}

    /**
     * Execute the job. Hard mask the PII.
     */
    public function handle(): void
    {
        DB::transaction(function () {
            $identity = UserIdentity::where('user_id', $this->userId)->firstOrFail();
            
            // Masking & overwrite data asli dengan salt acak
            $identity->full_name = 'ANONYMIZED_' . Str::random(10);
            $identity->email = Str::random(16) . '@anonymized.local';
            $identity->address_details = ['status' => 'purged_gdpr'];
            $identity->medical_records = (object) ['status' => 'purged_gdpr'];
            
            // Tandai telah dihapus secara regulasi
            $identity->is_anonymized = true;
            $identity->anonymized_at = now();
            
            $identity->save();
        });
    }
}
```

## 3. Masking Log PII via Monolog Processor

Log system sering kali membocorkan data PII (seperti token, password, no HP) secara tidak sengaja. Kita buat processor Monolog custom.

```php
<?php

declare(strict_types=1);

namespace App\Logging;

use Monolog\LogRecord;
use Monolog\Processor\ProcessorInterface;

final class PiiScrubberProcessor implements ProcessorInterface
{
    public function __invoke(LogRecord $record): LogRecord
    {
        $context = $record->context;

        // Masking field sensitif di context array log
        $sensitiveKeys = ['password', 'credit_card', 'ssn', 'phone_number', 'auth_token'];

        array_walk_recursive($context, function (&$value, $key) use ($sensitiveKeys) {
            if (in_array(strtolower((string)$key), $sensitiveKeys, true)) {
                $value = '******** [REDACTED]';
            }
        });

        // Masking regex untuk string pesan log (contoh: nomor kartu kredit)
        $message = $record->message;
        $message = preg_replace('/\b(?:\d[ -]*?){13,16}\b/', '****-****-****-**** [REDACTED CC]', $message);

        return $record->with(message: $message, context: $context);
    }
}
```

## 🧪 Unit / Arch Tests (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Models\UserIdentity;
use App\Logging\PiiScrubberProcessor;
use Monolog\LogRecord;
use Monolog\Level;

test('model correctly encrypts and generates deterministic bindex for email', function () {
    $model = new UserIdentity();
    $email = 'test@example.com';
    $model->email = $email;

    // Database attribute harus beda dari plain text
    expect($model->getAttributes()['email_encrypted'])->not->toBe($email)
        ->and($model->getAttributes()['email_bindex'])->toHaveLength(64); // SHA-256 length
});

test('pii scrubber redacts sensitive log context and messages', function () {
    $processor = new PiiScrubberProcessor();
    $record = new LogRecord(
        message: 'User paid with 4111-1111-1111-1111',
        context: ['password' => 'secret123', 'user' => 'John'],
        level: Level::Info,
        channel: 'test'
    );

    $processed = $processor($record);

    expect($processed->context['password'])->toBe('******** [REDACTED]')
        ->and($processed->context['user'])->toBe('John')
        ->and($processed->message)->toContain('[REDACTED CC]');
});
```

## ❌ Anti-Patterns & ✅ Best Practices

### 1. Insecure PII Storage (Anti-Pattern)
❌ **Salah:** Menyimpan kredensial atau data kartu kredit langsung di kolom `VARCHAR` tanpa enkripsi.
```php
$user->credit_card = $request->input('cc'); // DATA LEAK jika DB jebol!
$user->save();
```
✅ **Benar:** Gunakan Tokenization Vault (menyimpan token referensi Stripe/Midtrans) atau Laravel Encrypted Casts untuk field internal.

### 2. Log Injection & PII Leakage (Anti-Pattern)
❌ **Salah:** Melog `$request->all()` secara mentah-mentah ke DataDog / CloudWatch.
```php
Log::info('Incoming Request', $request->all()); // Menulis password & token ke log server plaintext!
```
✅ **Benar:** Filter log dengan Monolog Processor atau menggunakan `$request->except(['password', 'token'])`.

## ⚠️ Production Edge Cases

1. **Edge Case: Kegagalan Dekripsi Saat Rotasi `APP_KEY`**
   *Skenario:* Perusahaan mengubah `APP_KEY` akibat kebocoran kunci. Semua data `encrypted:array` tidak dapat dibuka dan melempar `DecryptException`.
   *Solusi:* Konfigurasi `config/app.php` dengan `previous_keys` array (fitur baru Laravel 11). Laravel otomatis akan mencoba mendekripsi dengan kunci lama jika kunci baru gagal, lalu Anda dapat menjadwalkan command untuk me-re-enkripsi data ke kunci baru secara background.

2. **Edge Case: Serangan Tabrakan Hash (Collision) pada Blind Index**
   *Skenario:* Hacker mencoba mencari input spesifik dengan brute-force local hash yang sama pada `email_bindex` jika salt-nya statis atau bocor.
   *Solusi:* Gunakan *Pepper* yang kuat (key independen di luar DB) untuk HMAC. Jangan gunakan MD5/SHA1. Gunakan HMAC-SHA256 untuk memastikan index tidak dapat dibalik.

3. **Edge Case: Race Condition Saat Anonymization Job Berjalan**
   *Skenario:* User meminta GDPR deletion, job `ProcessGdprAnonymization` sedang berjalan, namun ada transaksi payment masuk secara konkuren yang mencoba memperbarui data PII user tersebut, menyebabkan data lama tertimpa ulang (resurrected PII).
   *Solusi:* Gunakan `DB::table()->where('user_id', $id)->sharedLock()` di awal transaksi anonymization, atau tambahkan flag `is_purging` di Redis untuk memblokir transaksi tulis ke profile tersebut selama proses berjalan.
