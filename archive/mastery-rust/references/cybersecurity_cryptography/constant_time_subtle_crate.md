# Timing Side-Channels: `subtle` Crate & Constant-Time Operations

## Konsep Utama
*Timing Side-Channel Attacks* adalah serangan kriptografi yang mengeksploitasi variasi waktu komputasi (milidetik hingga nanodetik). Komputer standar mengoptimalkan instruksi, melakukan *short-circuit* pada percabangan (`if/else`), atau keluar lebih cepat saat menemukan kesalahan (`==` operator berhenti di byte pertama yang salah). Penyerang yang cerdik dapat mengukur variasi waktu ini dari jarak jauh untuk "menebak" kunci rahasia atau MAC byte-demi-byte.
Crate `subtle` dalam Rust menyediakan primitif wajib untuk menulis logika perbandingan memori dan matematika yang *constant-time* (waktu eksekusi seragam tanpa memedulikan nilai operand).

Kapan digunakan:
- Memverifikasi otentikasi kustom (seperti HMAC, JWT Signatures manual, API Key comparison).
- Operasi kriptografi tingkat rendah pada data rahasia (enkripsi, dekripsi pad, derivasi kunci).
- Melindungi *business logic* rahasia (seperti pengecekan OTP atau PIN bank).

## Arsitektur & Flow (Vulnerable vs Constant-Time Comparison)

```text
  [ Attacker measures Response Time ]

  VULNERABLE (==):
  Comparing: "S-E-C-R-E-T"
  Guess 1  : "A-X-X-X-X-X" -> Fails at 'A' -> Takes 10ms
  Guess 2  : "S-X-X-X-X-X" -> Fails at 'X' -> Takes 12ms (Aha! First byte is 'S')
  Guess 3  : "S-E-X-X-X-X" -> Fails at 'X' -> Takes 14ms (Aha! Second byte is 'E')

  CONSTANT-TIME (subtle::ConstantTimeEq):
  Comparing: "S-E-C-R-E-T"
  Guess 1  : "A-X-X-X-X-X" -> Fully evaluates -> Takes 20ms
  Guess 2  : "S-X-X-X-X-X" -> Fully evaluates -> Takes 20ms
  Guess 3  : "S-E-C-R-E-T" -> Fully evaluates -> Takes 20ms (Attacker is blind!)
```

## Production-Ready Code

```rust
use subtle::{ConstantTimeEq, Choice, ConditionallySelectable};
use sha2::{Sha256, Digest};

/// Struct representasi API Key atau Token yang sensitif
pub struct SecureApiKey {
    key: Vec<u8>,
}

impl SecureApiKey {
    pub fn new(key: &[u8]) -> Self {
        Self { key: key.to_vec() }
    }

    /// CARA BENAR: Memverifikasi dua byte slice dalam waktu konstan (Constant-Time).
    pub fn verify_token_secure(&self, provided_token: &[u8]) -> bool {
        // PERINGATAN: Pengecekan panjang (*length check*) biasanya membocorkan panjang array.
        // Jika panjang API key rahasia harus dirahasiakan, kita harus melakukan hash terlebih dahulu.
        // Namun, jika panjang kunci sudah fix (misal 32 byte), cek ini aman.
        if self.key.len() != provided_token.len() {
            return false;
        }

        // ct_eq() mereturn `subtle::Choice` yang bernilai 1 jika sama, 0 jika beda
        // Operasi ini terjamin tidak akan dioptimasi (short-circuit) oleh LLVM.
        let is_equal: Choice = self.key.ct_eq(provided_token);
        
        // Konversi secara aman menjadi boolean
        is_equal.unwrap_u8() == 1
    }

    /// CARA TEPAT UNTUK STRING PANJANG VARIABEL: HMAC-like constant time.
    /// Double HMAC/Hash comparison (Digunakan agar length dari input tidak bocor)
    pub fn verify_variable_length_secure(&self, provided_token: &[u8]) -> bool {
        let mut hasher1 = Sha256::new();
        hasher1.update(&self.key);
        let hash_expected = hasher1.finalize();

        let mut hasher2 = Sha256::new();
        hasher2.update(provided_token);
        let hash_provided = hasher2.finalize();

        // Bandingkan dua hash fix-sized (32 bytes) secara constant-time
        let is_equal: Choice = hash_expected.ct_eq(&hash_provided);
        is_equal.unwrap_u8() == 1
    }
}

/// Contoh operasi bersyarat dalam waktu konstan (menghindari branch predictor timing)
pub fn constant_time_select_message(condition_is_true: Choice, a: u32, b: u32) -> u32 {
    // Jika `condition_is_true` bernilai 1, mereturn b, jika 0 mereturn a.
    // Dijalankan TANPA instruksi `jump` atau `branch` (menggunakan operasi bitwise ALU mask).
    u32::conditional_select(&a, &b, condition_is_true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_secure_api_key_verification() {
        let secret = SecureApiKey::new(b"SuperSecretKey2025");

        // Valid
        assert!(secret.verify_token_secure(b"SuperSecretKey2025"));
        
        // Invalid but same length
        assert!(!secret.verify_token_secure(b"SuperSecretKey9999"));
        
        // Invalid length
        assert!(!secret.verify_token_secure(b"Short"));
    }

    #[test]
    fn test_conditional_select() {
        let choice_true = Choice::from(1u8);
        let choice_false = Choice::from(0u8);

        // conditional_select(a, b, choice) 
        // choice_true => memilih b
        assert_eq!(constant_time_select_message(choice_true, 10, 99), 99);
        
        // choice_false => memilih a
        assert_eq!(constant_time_select_message(choice_false, 10, 99), 10);
    }
}
```

## Anti-Patterns Spesifik

1. **Menggunakan `std::hint::black_box` untuk Kriptografi**
   - **Apa yang terjadi:** Developer mengira `black_box` dapat memaksa compiler untuk mencegah *short-circuiting*, lalu menulis loop kustom untuk membandingkan array di dalam `black_box`.
   - **Mengapa berbahaya:** Dokumentasi Rust secara eksplisit menyatakan bahwa `black_box` **tidak boleh digunakan untuk keamanan/constant-time execution**. LLVM (backend compiler Rust) terus berkembang dan dapat menembus `black_box` dalam *optimization pass* yang lebih agresif di masa depan. Hanya operasi bitwise matematika tanpa branch (seperti dalam crate `subtle`) yang secara arsitektur terjamin aman.

2. **Memaparkan *Length Side-Channel***
   - **Apa yang terjadi:** Kode mereturn *Early Exit* atau error instan (misal `400 Bad Request`) jika ukuran token/API Key input tidak persis dengan yang ada di server.
   - **Mengapa berbahaya:** Ini membocorkan **panjang sebenarnya** dari API Key atau Password sistem yang sedang ditebak oleh *attacker*. Aturan utamanya: Untuk data rahasia dengan panjang variabel, jangan lakukan *early reject* berdasarkan *length array*. Terapkan strategi *Double Hash* (seperti contoh `verify_variable_length_secure` di atas) dan bandingkan hasilnya secara *constant-time*.

## Edge Cases & Defensive Programming

- **Padding Oracles dalam Operasi Dekripsi:** Jika dekripsi melibatkan *padding* (seperti PKCS#7 pada mode CBC lawas), memastikan pengecekan *padding* berjalan dalam *constant-time* adalah mimpi buruk (mengarah pada *Padding Oracle Attack*). Praktik terbaik: Selalu hindari dekripsi bersyarat secara manual; gunakan selalu skema AEAD terotentikasi (ChaCha20Poly1305 / GCM) karena validasi MAC berjalan secara konstan tanpa mengekspos letak error pada *ciphertext*.
- **Memory Caches (Side-Channel CPU L1/L2):** `subtle` melindungi dari serangan berbasis waktu CPU biasa. Namun serangan agresif (seperti *Spectre/Meltdown* atau serangan *Cache-Timing*) tidak diselesaikan hanya dengan *software-based constant-time ALU*. Solusi mendalam melibatkan mitigasi kernel OS dan penghindaran *Lookup Tables (S-Boxes)* memori dalam algoritma kriptografi (menggunakan kalkulasi *Bitsliced*).
