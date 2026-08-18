# ICU Intl: Mutasi & Format Timezone & Currency

Dokumen ini menjelaskan strategi konversi zona waktu secara dinamis berdasarkan preferensi pengguna, menggunakan standar `IntlDateFormatter` dan `NumberFormatter` dari PHP (modul ext-intl). Semua timestamp harus tersimpan secara mutlak dalam `UTC` di database. Presentasi data ke zona waktu dan format mata uang lokal diserahkan ke *layer* presentasi dengan presisi tanpa kebocoran numerik (*zero numeric precision loss*).

## Alur Konversi UTC -> Zona Waktu Lokal

```ascii
[Database MySQL/PostgreSQL] 
(Menyimpan timestamp murni UTC: 2026-08-01 10:00:00)
             |
             v
[Eloquent Model (Accessors / Casts)]
(Membaca UTC menjadi instance Carbon murni)
             |
             v
[Localization Middleware]
(Menangkap zona waktu user dari tabel Users / IP Geo / Header)
(Menyetel $request->attributes->set('user_timezone', 'Asia/Jakarta'))
             |
             v
[PHP IntlDateFormatter Service / View Helper]
(Mengubah Carbon UTC -> representasi string lokal sesuai locale user)
             |
             v
[Client UI]
(Ditampilkan: "1 Agustus 2026, 17.00 WIB" untuk user di Jakarta)
```

## Spesifikasi Teknis

### 1. Eloquent Custom Cast (UTC ke User Timezone)

Kita membuat cast khusus untuk tanggal yang perlu dikonversi ke zona waktu pengguna ketika diakses sebagai string atau array JSON.

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Localization\Casts;

use Carbon\Carbon;
use Illuminate\Contracts\Database\Eloquent\CastsAttributes;
use Illuminate\Database\Eloquent\Model;

final readonly class UserTimezoneCast implements CastsAttributes
{
    /**
     * Membaca dari DB (UTC) dan mengubah zona waktunya.
     *
     * @param array<string, mixed> $attributes
     */
    public function get(Model $model, string $key, mixed $value, array $attributes): ?Carbon
    {
        if ($value === null) {
            return null;
        }

        $date = Carbon::parse($value, 'UTC');

        // Anggap app() memiliki service penyedia timezone dari user yang login
        $userTimezone = app('user.timezone') ?? config('app.timezone', 'UTC');
        
        $date->setTimezone($userTimezone);

        return $date;
    }

    /**
     * Menyimpan ke DB selalu dalam UTC.
     *
     * @param array<string, mixed> $attributes
     */
    public function set(Model $model, string $key, mixed $value, array $attributes): ?string
    {
        if ($value === null) {
            return null;
        }

        if (!$value instanceof Carbon) {
            $value = Carbon::parse($value);
        }

        // Paksa konversi kembali ke UTC sebelum masuk DB
        return $value->setTimezone('UTC')->format('Y-m-d H:i:s');
    }
}
```

### 2. Formatter PHP `Intl` untuk Currency (Precision Loss Prevention)

Hindari penggunaan `number_format()` bawaan PHP untuk mata uang, karena memiliki presisi loss pada float (IEEE 754) dan kurang adaptif dengan format mata uang internasional.

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Localization\Services;

use NumberFormatter;
use InvalidArgumentException;

final class CurrencyFormatter
{
    /**
     * @param string|int $amountInCents (Gunakan string untuk presisi tak terhingga, contoh "5000" untuk 50.00 USD)
     * @param string $currencyCode (e.g., 'USD', 'IDR')
     * @param string $locale (e.g., 'en_US', 'id_ID')
     */
    public static function format(string|int $amountInCents, string $currencyCode, string $locale): string
    {
        // 1. Tangani loss precision. Selalu bagi dengan library bcmath untuk big integers
        // Misal: 5000 cents -> "50.00"
        $amount = bcdiv((string) $amountInCents, '100', 2);

        $formatter = new NumberFormatter($locale, NumberFormatter::CURRENCY);
        
        // Atur agar formatter tidak memaksa desimal jika mata uang tidak memiliki subunit (seperti JPY, IDR)
        if (in_array(strtoupper($currencyCode), ['JPY', 'IDR', 'KRW'], true)) {
            $formatter->setAttribute(NumberFormatter::FRACTION_DIGITS, 0);
        }

        $result = $formatter->formatCurrency((float) $amount, strtoupper($currencyCode));
        
        if ($result === false) {
            throw new InvalidArgumentException("Format mata uang gagal untuk locale: {$locale}");
        }

        return $result;
    }
}
```

### 3. Service IntlDateFormatter (Waktu dan Kalender Lokal)

Memanfaatkan `IntlDateFormatter` untuk melokalisasi nama bulan, hari, dan susunan karakter sesuai bahasa/negara tujuan.

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Localization\Services;

use Carbon\CarbonInterface;
use IntlDateFormatter;

final class DateLocalization
{
    /**
     * @param CarbonInterface $date
     * @param string $locale (e.g. 'id_ID')
     * @param string $timezone (e.g. 'Asia/Jakarta')
     */
    public static function formatLong(CarbonInterface $date, string $locale, string $timezone): string
    {
        $formatter = new IntlDateFormatter(
            $locale,
            IntlDateFormatter::LONG, // Date: 1 Agustus 2026
            IntlDateFormatter::SHORT, // Time: 17.00
            $timezone,
            IntlDateFormatter::GREGORIAN
        );

        $result = $formatter->format($date->getTimestamp());
        
        return $result ?: $date->toDateTimeString();
    }
}
```

## Anti-Patterns Kritis

#### ❌ 1. Konversi Zona Waktu secara Hardcode di Query SQL (Meninggalkan UTC)
Menggunakan fungsi SQL seperti `CONVERT_TZ` di tingkat ORM/Builder atau menyimpan timestamp di DB dengan zona waktu lokal pengguna.

```sql
-- SALAH: Database di-setup ke 'Asia/Jakarta' atau query konversi manual.
-- Saat backup dipindah region, semua timestamp bergeser kacau.
SELECT CONVERT_TZ(created_at, 'UTC', 'Asia/Jakarta') FROM orders;
```

```php
// BENAR: DB murni di 'UTC'. Semua cast/pergeseran offset terjadi di aplikasi (PHP layer).
// Ini juga membebaskan indeks MySQL (seperti indeks pada rentang waktu) agar tetap cepat.
$model->created_at->setTimezone('Asia/Jakarta'); 
```

#### ❌ 2. Float Math untuk Transaksi Uang (Precision Leak)
Menerima payload uang sebagai `float` dan menghitung perpajakan secara langsung. PHP `float` bersifat *imprecise* dan mengakibatkan perbedaan cent/rupiah di skala besar.

```php
// SALAH: 0.1 + 0.2 di sistem float akan menghasilkan 0.30000000000000004
$total = (float)$request->price + (float)$request->tax; 
```

```php
// BENAR: Gunakan string/integer cents, dan gunakan ekstensi BCMath (Binary Calculator) untuk kalkulasi.
$totalCents = bcadd((string)$request->price_cents, (string)$request->tax_cents, 0);
```

## Production Edge Cases

1. **Format Zona Waktu Ilegal (Invalid Timezone Bypass):**
   - *Masalah:* Hacker dapat menyuntikkan payload string zona waktu tak valid (seperti `'Africa/Wakanda'`) via API headers, lalu ketika dilempar ke `new DateTimeZone()`, aplikasi crash dengan `Fatal Error`.
   - *Solusi:* Validasi input zona waktu dengan strict checking `in_array($input, timezone_identifiers_list(), true)` sebelum menyimpannya ke atribut atau database.

2. **Perubahan DST (Daylight Saving Time) di Masa Lalu:**
   - *Masalah:* Anda ingin memformat ulang invoice lama dari tahun 2010. Tapi Anda menggunakan offset hardcode (`+07:00`) atau menganggap DST statis, sehingga jam faktur tersebut bergeser 1 jam.
   - *Solusi:* Selalu andalkan database bawaan IANA *Time Zone Database* milik PHP/Carbon. Jangan pernah menyimpan `+07:00` di DB. Simpan string `Asia/Jakarta` dan biarkan lib `Intl` mengurai kapan pergeseran DST terjadi di tahun 2010.

3. **Masalah Subunit Mata Uang Aneh:**
   - *Masalah:* Aplikasi beranggapan semua mata uang bisa dibagi 100 (*cents*). Namun, mata uang Dinar Bahrain (BHD) dibagi *1.000* subunit (fils), sedangkan Yen Jepang (JPY) tidak memiliki subunit (dibagi 1).
   - *Solusi:* Hindari *hardcode* `bcdiv($amount, '100', 2)`. Implementasikan kamus rasio subunit per mata uang atau gunakan *Money Pattern* (library pihak ketiga yang solid seperti `moneyphp/money` sangat direkomendasikan untuk Enterprise level).

## Testing Terpadu (Pest v3)

```php
<?php

declare(strict_types=1);

use App\Infrastructure\Localization\Services\CurrencyFormatter;
use App\Infrastructure\Localization\Services\DateLocalization;
use Carbon\Carbon;

covers(CurrencyFormatter::class);
covers(DateLocalization::class);

test('currency formatter handles precision and non-fraction currencies correctly', function () {
    // 5000 cents in USD -> $50.00
    $usd = CurrencyFormatter::format(5000, 'USD', 'en_US');
    
    // Note: Some systems output $50.00, some US$50.00 depending on ICU version, we check contains.
    expect($usd)->toContain('50.00')->toContain('$');
    
    // 5000 IDR doesn't use subunits, so dividing by 100 means Rp 50
    $idr = CurrencyFormatter::format(50000, 'IDR', 'id_ID');
    
    // Harus Rp500 tanpa pecahan
    $cleanedIdr = preg_replace('/[^\d]/', '', $idr);
    expect($cleanedIdr)->toBe('500'); // 50000 / 100 = 500
});

test('date localization formats UTC carbon to specific timezone strings', function () {
    $date = Carbon::parse('2026-08-01 10:00:00', 'UTC');
    
    // Jakarta is UTC+7 -> 17:00
    $jakartaFormatted = DateLocalization::formatLong($date, 'id_ID', 'Asia/Jakarta');
    
    // String output bergantung ICU di server, tetapi angka dan jam mutlak
    expect($jakartaFormatted)->toContain('1')->toContain('Agustus')->toContain('17');
    
    // New York is UTC-4 (DST on August) -> 06:00
    $newYorkFormatted = DateLocalization::formatLong($date, 'en_US', 'America/New_York');
    
    expect($newYorkFormatted)->toContain('August 1')->toContain('6');
});
```
