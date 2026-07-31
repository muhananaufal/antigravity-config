# Password Hashing: Argon2id Parameter Tuning & Konfigurasi Aman

## Konsep Utama
Argon2 (pemenang Password Hashing Competition 2015) adalah algoritma *Key Derivation Function* (KDF) yang dirancang secara khusus untuk melawan serangan peretasan pasca-pencurian basis data. Terdapat 3 varian:
- **Argon2d**: Tahan terhadap serangan GPU, namun rentan terhadap *side-channel timing attacks*. (Cocok untuk kriptokurensi, BUKAN password).
- **Argon2i**: Aman dari *timing attacks*, tapi lebih lemah terhadap serangan ASIC/GPU.
- **Argon2id**: *Hybrid*. Aman dari *timing attacks* sekaligus memaksimalkan ketahanan terhadap GPU/ASIC. Ini adalah varian yang **wajib digunakan** untuk *password hashing*.

Kapan digunakan:
- Sistem otentikasi user modern.
- Migrasi dari fungsi hash lawas (MD5, SHA256) atau fungsi KDF lama (PBKDF2, bcrypt, scrypt) yang mulai rentan terhadap serangan perangkat keras berakselerasi (ASIC/GPU).

## Arsitektur & Flow (Argon2id Hashing Pipeline)

```text
User Password ("p@ssword!") 
       +                     ======> Argon2id Engine <======
Unique Random Salt (16 bytes)           |   |   |
                                        v   v   v
[ Parameter Tuning ]               (Mem-Hardness)
- Memory Size (m)   -------------> Requires X MB of RAM per hash
- Iterations (t)    -------------> CPU time required
- Parallelism (p)   -------------> Thread lanes (multi-core resistance)
                                        |   |   |
                                        v   v   v
    [ Resulting PHC String format ]
    $argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$R01L...
```

## Production-Ready Code

```rust
use argon2::{
    password_hash::{
        rand_core::OsRng,
        PasswordHash, PasswordHasher, PasswordVerifier, SaltString
    },
    Argon2, Params, Algorithm, Version
};
use subtle::ConstantTimeEq;
use std::error::Error;

/// Konfigurasi Argon2id spesifik sesuai rekomendasi OWASP
/// M = 64MB, T = 3, P = 4 (Untuk sistem modern)
fn get_argon2_config() -> Result<Argon2<'static>, argon2::password_hash::Error> {
    let params = Params::new(
        65536, // m: Memory in KiB (64 MB)
        3,     // t: Iterations (Time cost)
        4,     // p: Parallelism (Thread/Lane cost)
        Some(Params::DEFAULT_OUTPUT_LEN),
    )?;

    Ok(Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        params,
    ))
}

/// Menghasilkan hash (PHC string) dari raw password
pub fn hash_password(password: &str) -> Result<String, Box<dyn Error>> {
    let argon2 = get_argon2_config()?;
    
    // Generate salt random (128-bit) aman (CSPRNG)
    let salt = SaltString::generate(&mut OsRng);

    // Proses hashing password + salt
    let password_hash = argon2.hash_password(password.as_bytes(), &salt)?
        .to_string(); // Mengembalikan format standar PHC

    Ok(password_hash)
}

/// Memverifikasi password terhadap PHC hash string yang tersimpan di database
pub fn verify_password(password: &str, phc_hash: &str) -> Result<bool, Box<dyn Error>> {
    // Parse the hash back into a PasswordHash struct
    let parsed_hash = PasswordHash::new(phc_hash)?;
    
    // Gunakan verifikasi dari Argon2 bawaan (sudah menggunakan constant-time comparisons)
    // NOTE: `verify_password` akan otomatis mengenali parameter m, t, p dari string PHC!
    let is_valid = Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok();
        
    Ok(is_valid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_argon2id_hashing_and_verification() {
        let password = "SuperSecretPassword123!";
        
        let hash = hash_password(password).unwrap();
        
        // Cek bahwa formatnya benar
        assert!(hash.starts_with("$argon2id$"));
        
        // Valid password
        assert!(verify_password(password, &hash).unwrap());
        
        // Invalid password
        assert!(!verify_password("wrongpassword", &hash).unwrap());
    }
}
```

## Anti-Patterns Spesifik

1. **Parameter "Cepat" untuk Menghemat Server Resources**
   - **Apa yang terjadi:** Mengurangi memori (misal `m = 4096` / 4MB) atau iterasi (`t = 1`) agar server dapat menangani ribuan permintaan login per detik tanpa beban CPU.
   - **Mengapa berbahaya:** Jika database bocor, penyerang yang menggunakan GPU *farm* dapat memecahkan hash dalam hitungan menit (karena *memory-hardness* diabaikan, GPU yang memiliki core kecil namun sangat banyak bisa berjalan sangat efisien). *Rule of thumb*: Hashing **harus** membutuhkan waktu sekitar ~500ms di sisi server per kalkulasi hash. Jika server tidak kuat, *scale out* infrastruktur otentikasi, jangan turunkan keamanan kriptografi.

2. **Membandingkan Hash Secara Manual menggunakan `==`**
   - **Apa yang terjadi:** Daripada menggunakan trait `PasswordVerifier::verify_password`, developer mengekstrak output raw hash dan melakukan `if stored_hash == computed_hash`.
   - **Mengapa berbahaya:** Operator `==` di Rust bersifat *short-circuiting* (berhenti seketika saat menemukan byte yang berbeda). Hal ini membuka celah terhadap **Timing Side-Channel Attacks**. Penyerang dapat mengukur seberapa lama respons server untuk menebak *byte* per *byte* dari *hash*. Crate `argon2` sudah melakukan *constant-time comparison* di dalam layernya via crate `subtle`.

## Edge Cases & Defensive Programming

- **Denial of Service (DoS) via Login Endpoint:** Karena komputasi Argon2 berat secara desain, attacker bisa melakukan *flooding* pada endpoint login dengan password yang sangat panjang. Ini akan menyebabkan CPU Exhaustion. **Pertahanan:** Batasi panjang maksimal password input (misal max 128 bytes) di *middleware validation*, serta terapkan *Rate Limiting* yang ketat khusus untuk endpoint otentikasi.
- **Downgrade Attacks pada String PHC:** Karena string hash menyimpan versinya (seperti `$argon2id$v=19...`), attacker bisa mencoba memodifikasi database untuk mendowngrade algoritma hash ke versi rentan. Saat mem-parsing `PasswordHash::new`, pastikan *business logic* Anda secara eksplisit menolak algoritma kuno jika terdeteksi, dan memaksa user untuk *reset password* jika hash yang tersimpan berformat `bcrypt` atau Argon2 parameter lama.
