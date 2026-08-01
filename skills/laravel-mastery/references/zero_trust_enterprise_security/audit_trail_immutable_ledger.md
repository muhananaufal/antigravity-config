# Immutable Audit Trail & Hash-Chained Ledger di Laravel

Untuk memenuhi standar kepatuhan (compliance) seperti SOC2, ISO27001, atau PCI-DSS, sistem pencatatan aktivitas (Audit Log) tidak boleh dapat diubah diam-diam oleh Database Administrator (DBA) nakal atau penyerang yang sudah masuk ke server database. Dokumen ini membahas penerapan *Hash-Chained Audit Ledger* (Mirip blockchain sederhana) di atas Laravel Eloquent.

## Arsitektur Cryptographic Hash Chain (ASCII Diagram)

```text
[Transaction Event: User Updated] ---> [Laravel Eloquent Observer]
                                                 |
                                                 v
+-----------------------------------------------------------------------------------------+
| Audit Ledger Table (Append-Only)                                                        |
+----+-----------+---------------+-----------------------+--------------------------------+
| ID | Model     | Action        | Payload (JSON)        | Cryptographic Hash Chain       |
+----+-----------+---------------+-----------------------+--------------------------------+
| 1  | User:99   | created       | {"name":"John"}       | HASH(1 + ... + APP_KEY + NULL) |
| 2  | User:99   | updated       | {"name":"John Doe"}   | HASH(2 + ... + APP_KEY + [H1]) | <-- Terhubung!
| 3  | Order:5   | deleted       | {"amount":5000}       | HASH(3 + ... + APP_KEY + [H2]) | <-- Terhubung!
+----+-----------+---------------+-----------------------+--------------------------------+
                                                 |
                                                 v
[Audit Auditor Command] ---> (Memvalidasi rantai HASH dari ID 1 ke N untuk deteksi manipulasi)
```

## 1. Implementasi Audit Ledger Model (Immutable)

Tabel `audit_logs` menyimpan record secara *append-only*. Kita buat kolom hash untuk menyimpan signature cryptographic.

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

final class AuditLog extends Model
{
    public $timestamps = true;
    protected $guarded = ['*'];

    /**
     * Mencegah modifikasi data. Table ini APPEND-ONLY.
     */
    protected static function booted(): void
    {
        static::updating(function () {
            throw new \RuntimeException('Audit logs are IMMUTABLE. Updates are strictly forbidden.');
        });

        static::deleting(function () {
            throw new \RuntimeException('Audit logs are IMMUTABLE. Deletions are strictly forbidden.');
        });
    }

    /**
     * Menghitung nilai HMAC Hash Chain
     */
    public static function generateHash(
        int $id, 
        string $modelClass, 
        string $action, 
        string $payload, 
        ?string $previousHash
    ): string {
        $dataStr = sprintf(
            '%d|%s|%s|%s|%s',
            $id,
            $modelClass,
            $action,
            $payload,
            $previousHash ?? 'GENESIS'
        );

        // Kunci rahasia khusus ledger (pisahkan dari APP_KEY untuk ekstra keamanan)
        $secret = config('app.audit_ledger_key');
        
        return hash_hmac('sha256', $dataStr, (string) $secret);
    }
}
```

## 2. Observer untuk Menangkap Mutasi Data

Kita menggunakan trait atau global observer untuk menangkap operasi `created`, `updated`, dan `deleted`.

```php
<?php

declare(strict_types=1);

namespace App\Observers;

use Illuminate\Database\Eloquent\Model;
use App\Models\AuditLog;
use Illuminate\Support\Facades\DB;

final class ImmutableAuditObserver
{
    public function created(Model $model): void
    {
        $this->recordAudit('created', $model);
    }

    public function updated(Model $model): void
    {
        $this->recordAudit('updated', $model);
    }

    public function deleted(Model $model): void
    {
        $this->recordAudit('deleted', $model);
    }

    private function recordAudit(string $action, Model $model): void
    {
        $payload = json_encode([
            'old' => $action === 'updated' ? $model->getOriginal() : null,
            'new' => $action !== 'deleted' ? $model->getAttributes() : null,
            'actor_id' => auth()->id() ?? 'SYSTEM',
            'ip' => request()->ip() ?? 'CLI'
        ], JSON_THROW_ON_ERROR);

        // Gunakan lock untuk menjamin urutan (consistency) rantai hash!
        DB::transaction(function () use ($model, $action, $payload) {
            
            // Dapatkan hash terakhir yang valid dengan FOR UPDATE lock untuk mencegah race condition
            $lastAudit = AuditLog::lockForUpdate()->latest('id')->first();
            $previousHash = $lastAudit ? $lastAudit->chain_hash : null;

            // Generate auto-increment ID berikutnya secara manual (karena kita butuh ID di dalam hash)
            // Atau insert blank record lalu update hash-nya (jika RDBMS allow). 
            // Untuk PostgreSQL, kita bisa fetch nextval('audit_logs_id_seq').
            $nextId = ($lastAudit ? $lastAudit->id : 0) + 1;

            $hash = AuditLog::generateHash($nextId, $model::class, $action, $payload, $previousHash);

            $log = new AuditLog();
            $log->id = $nextId; // Memaksa ID jika memungkinkan, pastikan DB support
            $log->model_type = $model::class;
            $log->model_id = (string) $model->getKey();
            $log->action = $action;
            $log->payload = $payload;
            $log->chain_hash = $hash;
            $log->saveQuietly(); // Bypass observer trigger pada audit log itu sendiri
        });
    }
}
```

## 🧪 Unit / Arch Tests (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Models\AuditLog;

test('audit log model completely rejects updates and deletions to guarantee immutability', function () {
    // Setup initial record manually bypass observers
    $log = new AuditLog();
    $log->model_type = 'Test';
    $log->action = 'created';
    $log->payload = '{}';
    $log->chain_hash = 'hash123';
    $log->saveQuietly();

    // Coba Update -> Harus Error
    expect(function () use ($log) {
        $log->action = 'updated';
        $log->save();
    })->toThrow(\RuntimeException::class, 'Audit logs are IMMUTABLE.');

    // Coba Delete -> Harus Error
    expect(function () use ($log) {
        $log->delete();
    })->toThrow(\RuntimeException::class, 'Audit logs are IMMUTABLE.');
});

test('hash chain calculates correctly based on previous hash', function () {
    $hash = AuditLog::generateHash(1, 'User', 'created', '{"a":1}', null);
    
    // Hash tidak boleh kosong dan harus format hex (64 chars sha256)
    expect($hash)->toHaveLength(64)
                 ->and(ctype_xdigit($hash))->toBeTrue();
                 
    $hash2 = AuditLog::generateHash(2, 'User', 'updated', '{"a":2}', $hash);
    expect($hash2)->not->toBe($hash);
});
```

## ❌ Anti-Patterns & ✅ Best Practices

### 1. Silent Database Tampering (Anti-Pattern)
❌ **Salah:** Hanya menyimpan log sederhana ke tabel tanpa Cryptographic Signatures.
```php
// Jika Hacker/DBA masuk, mereka bisa mengedit ini dengan query SQL:
// UPDATE audit_logs SET payload = '...' WHERE id = 50;
Audit::create(['action' => 'login', 'user' => 1]); 
```
✅ **Benar:** Gunakan mekanisme chaining HMAC atau Digital Signatures (RSA) sehingga ketika baris diubah, hash pada baris tersebut dan baris-baris setelahnya akan rusak (invalid).

### 2. Infinite Loop Observer (Anti-Pattern)
❌ **Salah:** Menggunakan `save()` biasa pada model Audit tanpa flag bypass, sehingga model audit men-trigger observer audit dirinya sendiri tanpa henti.
```php
$auditModel->save(); // Men-trigger Observer -> insert audit -> men-trigger observer -> (Memory Exhausted)
```
✅ **Benar:** Gunakan `$model->saveQuietly()` (Laravel 10+) atau hapus dispatch event secara manual pada kelas Audit.

## ⚠️ Production Edge Cases

1. **Edge Case: Kerusakan Rantai (Chain Break) Akibat Race Condition Parah**
   *Skenario:* Pada sistem High Frequency Trading, 100 request memicu audit bersamaan. Transaksi database berebut `lockForUpdate()`, dan jika terjadi timeout lock, insert gagal tapi record lain masuk, mengacaukan urutan ID dan hash.
   *Solusi:* Alih-alih melakukan perhitungan hash sinkron secara synchronous (yang menyebabkan bottleneck database write-lock parah), Anda harus mengirim event mutasi mentah ke Kafka/Redis Stream, dan *satu* worker background sekuensial (singleton consumer) yang secara perlahan menulis secara berurutan dan menghitung chain hash ke database Ledger.

2. **Edge Case: Kegagalan Verifikasi Akibat Rotasi Key `audit_ledger_key`**
   *Skenario:* Perusahaan memutar secret key yang dipakai oleh `hash_hmac()`. Tiba-tiba validator audit report mendeteksi "Ledger Tampered" karena kunci baru menghasilkan hash beda dari data historis.
   *Solusi:* Sistem harus menerapkan rotasi kunci berversi. Tabel konfigurasi kunci (misal `key_version = v1`). Di data ledger, tambahkan kolom `key_version`. Saat validasi hash, gunakan versi kunci yang tertera di baris tersebut. Kunci-kunci lama harus tetap tersimpan aman di KMS (Key Management Service).

3. **Edge Case: Pertumbuhan Data Ledger (Storage Exhaustion) vs Retensi Compliance**
   *Skenario:* Tabel audit bengkak hingga 2 Terabyte dalam 6 bulan. Anda tidak bisa mendelete tabel karena melanggar aturan immutability dan memecah Hash Chain, tapi disk DB penuh.
   *Solusi:* Terapkan arsitektur *Checkpointing & Archiving*. Di hari terakhir tahun berjalan, buat "Snapshot Hash". Export data historis 1 tahun tersebut menjadi file `.csv.gz`, sign file tersebut menggunakan RSA/GPG Private Key institusi. Simpan di AWS S3 Glacier WORM (Write Once Read Many), hapus data lama dari DB (potong rantai), dan mulai "Genesis Hash" baru di tanggal 1 Januari untuk chain DB tahun berikutnya.
