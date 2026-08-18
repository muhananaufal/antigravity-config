# Formatting Finansial & Waktu: Zero-Copy di Lintas Zona Waktu ICU

## 1. Menjaga Integritas Akuntansi Moneter dan Konversi Zona Waktu
Representasi mata uang, tanggal, dan nilai presisi di level korporasi internasional membutuhkan perlindungan lapis ganda dari bahaya pembulatan (floating point errors) dan penyajian (string allocation). Solusi pamungkas untuk menangani ini melahirkan perkawinan tipe data presisi arbitrer (seperti `rust_decimal`) dengan mesin pelokalan ICU (seperti `icu_datetime` dan penempatan format desimal `icu_decimal`).
Mengubah zona waktu yang patuh dengan *IANA Time Zone Database* (mempertimbangkan DST, Daylights Saving Time) adalah langkah wajib, bersama dengan pelokalan tanggal agar hari "Minggu" bisa tampil otentik sebagai "Senin" di region Indonesia.

## 2. Diagram Alur Konversi Decimal Zero-Copy dan Waktu Global
Alur di bawah memastikan format presisi melintas batas bahasa (komma sebagai desimal di Eropa vs titik di USA).

```ascii
+-----------------------------------------------------------------------+
|                       Data Internal Backend                           |
|  - Timestamp: 1722421990 (UTC)                                        |
|  - Value: Decimal("1500000.55")  [Bukan float64!]                     |
+-----------------------------------------------------------------------+
                                   |
           +-----------------------+------------------------+
           |                                                |
           v                                                v
+-----------------------------+               +-----------------------------+
|    Konversi IANA Timezone   |               |     Formatting Finansial    |
| (icu_timezone, icu_datetime)|               |  (icu_decimal + FixedFixed) |
|                             |               |                             |
| 1. Load TZ (Asia/Jakarta)   |               | 1. Locale (de-DE)           |
| 2. Map UTC ke DST           |               | 2. Ambil Desimal Pemisah    |
| 3. Render format sesuai     |               | 3. Render "1.500.000,55 €"  |
|    Locale ("1 Agu 2026")    |               |                             |
+-----------------------------+               +-----------------------------+
           |                                                |
           +-----------------------+------------------------+
                                   |
                                   v
+-----------------------------------------------------------------------+
|                   Response Format (Zero-Copy Buffer)                  |
|                   Teks tersusun tanpa realokasi heap                  |
+-----------------------------------------------------------------------+
```

## 3. Implementasi Kasta Sultan: Integrasi `rust_decimal` & ICU Waktu
Contoh demonstrasi mematut penggunaan waktu melintasi presisi desimal tanpa campur tangan tipe numerik native F32/F64.

```rust
use rust_decimal::Decimal;
use std::str::FromStr;

// Modul utilitas tiruan yang mendemonstrasikan keandalan Decimal untuk keuangan
// dan simulasi pembentukan waktu. Dalam skenario asli, Anda akan melibatkan 
// paket `icu_datetime::TypedZonedDateTimeFormatter` dari modul icu.

/// Struktur yang merepresentasikan saldo moneter anti-rounding
#[derive(Debug, Clone, PartialEq)]
pub struct SecureCurrency {
    amount: Decimal,
    currency_code: String, // Contoh: "IDR", "EUR"
}

impl SecureCurrency {
    /// Inisialisasi mata uang hanya dengan *string parsing*,
    /// mencegah inisialisasi menggunakan f64 secara mutlak!
    pub fn try_new(amount_str: &str, currency: &str) -> Result<Self, rust_decimal::Error> {
        let amount = Decimal::from_str(amount_str)?;
        Ok(Self {
            amount,
            currency_code: currency.to_string(),
        })
    }

    /// Menambahkan nominal finansial dengan aman (type-safe rounding/overflow protection).
    pub fn add(&mut self, amount: Decimal) {
        self.amount += amount;
    }
    
    /// Menyediakan nilai string untuk dirender oleh pemformat UI / ICU.
    pub fn to_string_exact(&self) -> String {
        self.amount.to_string()
    }
}

/// Mensimulasikan pemformatan dengan tipe locale statis berdasarkan prinsip
/// penggantian karakter radiks titik dan koma.
pub fn format_financial_amount(currency: &SecureCurrency, locale: &str) -> String {
    let raw_val = currency.to_string_exact();
    
    // Simulasikan pemformatan ICU
    // Untuk 'de-DE' (Jerman) atau 'id-ID' (Indonesia), koma adalah tanda desimal
    // Untuk 'en-US' (AS), titik adalah tanda desimal
    if locale == "de-DE" || locale == "id-ID" {
        // Manipulasi kasar mock-up. Secara produksi gunakan `icu_decimal::FixedDecimalFormatter`
        raw_val.replace(".", ",")
    } else {
        raw_val
    }
}
```

## 4. Unit & Integration Testing
Memverifikasi perlindungan terhadap kelalaian kalkulasi *floating point* (IEEE-754) serta pengujian penyusunan *string* pembatas (radix).

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn test_currency_precision_no_float_errors() {
        // Skenario kritis: 0.1 + 0.2 di floating point menghasilkan 0.30000000000000004
        // Kita membuktikan Decimal mencegah anomali korporat ini
        let mut balance = SecureCurrency::try_new("0.1", "USD").unwrap();
        balance.add(dec!(0.2));
        
        // Hasil pasti 0.3, tidak ada penyimpangan
        assert_eq!(balance.to_string_exact(), "0.3");
    }

    #[test]
    fn test_formatting_radix_by_locale() {
        let balance = SecureCurrency::try_new("1500000.55", "EUR").unwrap();
        
        let us_format = format_financial_amount(&balance, "en-US");
        assert_eq!(us_format, "1500000.55"); // Menggunakan pemisah titik
        
        let german_format = format_financial_amount(&balance, "de-DE");
        assert_eq!(german_format, "1500000,55"); // Menggunakan pemisah koma
    }
}
```

## 5. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menyimpan dan Menghitung Mata Uang Pakai `f64`
Pengembang tergoda menggunakan variabel *floating-point* (f32, f64) karena cepat dan terintegrasi secara _native_.
```rust
// SALAH: Sistem perbankan akan bocor pelan-pelan karena presisi IEEE-754.
let price_a = 0.1_f64;
let price_b = 0.2_f64;
let total = price_a + price_b; // = 0.30000000000000004
let display = format!("Rp {:.2}", total); 
```
**✅ Benar:** Selalu, **TANPA PENGECUALIAN**, beralih ke representasi integer 100-basis (contoh Rp1 = 100 sen) atau mengadopsi _crate_ arbitrer presisi seperti `rust_decimal::Decimal`.

### ❌ Anti-Pattern 2: Merakit Waktu Manual dengan Opsi Timezone Bodong
Menambah atau mengurangkan nilai offset tetap (misalnya menambah angka statis +7 *hours*) tanpa memanfaatkan pustaka pembatas IANA Time Zone (Chrono-TZ / ICU Timezone).
```rust
// SALAH: Tidak mengindahkan DST (Daylight Saving Time) dan tahun kabisat (leap year).
let jakarta_time_wrong = utc_timestamp_seconds + (7 * 3600);
```
**✅ Benar:** Resolusi Zona Waktu melengkung (melompat mundur atau maju) secara politis. Selalu lemparkan stempel waktu (timestamp UTC `i64`) menyeberangi objek `ZonedDateTime` atau ekuivalennya agar DST dihitung berdasarkan tanggal yang spesifik *(tz-database resolution)*.

## 6. Production Edge Cases

1. **Aturan DST Melompat di Tengah Malam:**
   - **Skenario:** Pembayaran berlangganan (*subscription*) diregistrasi untuk menagih setiap tanggal 10. Pada bulan tertentu di zona waktu USA (seperti `America/New_York`), waktu jam 2:00 pagi melompat menjadi jam 3:00 (Spring Forward) atau berputar ulang dari 2:00 menjadi 1:00 (Fall Back). Akibatnya, durasi selisih "24 jam statis" salah posisi, bisa memicu lonjakan tagihan atau melewati batas jatuh tempo sistem perbankan.
   - **Mitigasi:** Eksekusi mesin tagihan (cron job) dalam ruang lingkup waktu UTC murni, jangan menggunakan kalkulasi di level regional untuk logika bisnis. Hanya terapkan zona waktu IANA untuk tampilan presentasi kepada mata klien (rendering UI).
2. **Representasi Format Negatif yang Unik Antar Negara:**
   - **Skenario:** Saldo defisit sebesar `-100.50` direpresentasikan ke web browser. Kita menduga membiarkan tanda minus di depan cukup. Faktanya, Amerika acap membungkus bilangan negatif menggunakan kurung bulat: `($100.50)` ketimbang minus di depan `-100.50 $`.
   - **Mitigasi:** Libatkan fungsionalitas pemformatan `icu_decimal::FixedDecimalFormatter`. Fungsi di sana mematuh kriteria spesifik wilayah yang menyadari keberadaan tanda (*sign*) positif-negatif dan penempatan letak simbol mata uang (sebelum versus sesudah angka, serta butuh spasi atau tidak).
3. **Simbol Mata Uang Bersandar pada Konteks Kedaerahan (Symbol Ambiguity):**
   - **Skenario:** Kita melemparkan "USD" atau sekadar string "$" ke seluruh dunia. Jika di Australia, "$" bisa berkonotasi dengan AUD (Dolar Australia), bukan Dolar AS.
   - **Mitigasi:** Pada aplikasi global tingkat korporat, panggil spesifikasi *currency formatter* untuk mendeteksi *narrow vs wide symbols*. Dalam kondisi semantik rancu, render selalu kombinasi simbol luas (contoh `US$ 15.00` atau `AUD 15.00`), bukan sekadar simbol mentah `$`.
