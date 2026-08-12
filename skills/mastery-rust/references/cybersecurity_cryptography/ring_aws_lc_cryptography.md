# Kriptografi Low-Level: `ring` dan `aws-lc-rs`

## Konsep Utama
Dalam ekosistem Rust, `ring` telah lama menjadi *de facto standard* untuk primitif kriptografi (seperti hashing, AEAD, ECDH, dan tanda tangan digital) berbasis assembly BoringSSL/OpenSSL. Namun, karena keterbatasan dukungan platform (seperti ketiadaan support WebAssembly murni yang stabil atau arsitektur langka), `aws-lc-rs` (AWS Libcrypto untuk Rust) muncul sebagai alternatif yang lebih kuat, dimaintain langsung oleh AWS, didukung *formal verification*, dan kompatibel secara API dengan `ring`.

Kapan digunakan:
- Membangun protokol kriptografi kustom.
- Implementasi sistem enkripsi berkas (AEAD seperti AES-256-GCM atau ChaCha20-Poly1305).
- Key Agreement (ECDH) antar *peers* dalam jaringan desentralisasi atau sistem *Hardware Security Module* (HSM).
- HMAC untuk validasi integritas pesan berkecepatan tinggi, seperti di ranah *High-Frequency Trading* (HFT).

## Arsitektur & Flow (ECDH + HKDF + AEAD)

```text
Alice                                                     Bob
  |                                                        |
  |-- 1. Generate P-256 Key Pair (A_priv, A_pub)           |
  |-- 2. Send A_pub -------------------------------------->|
  |                                                        |
  |<-------------------------------------- 3. Send B_pub --|
  |                                                        |
  |-- 4. Compute ECDH(A_priv, B_pub) => Shared Secret (S)  |
  |                                                        |
  |-- 5. HKDF-Extract-and-Expand(S, "info") => AES Key (K) |
  |                                                        |
  |-- 6. Encrypt AES-GCM(K, Nonce, Msg) => Ciphertext (C)  |
  |-- 7. Send C, Nonce ----------------------------------->|
  |                                                        |
  |                        8. Decrypt AES-GCM(K, Nonce, C)-|
```

## Production-Ready Code

```rust
use aws_lc_rs::{
    aead::{AeadInPlace, Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM},
    agreement::{self, EphemeralPrivateKey, PublicKey},
    hkdf,
    rand::{SecureRandom, SystemRandom},
};
use std::error::Error;

/// Fungsi bantuan untuk Key Exchange dan Enkripsi
pub struct SecureChannel {
    symmetric_key: [u8; 32], // AES-256 key
}

impl SecureChannel {
    /// Alice menerima Public Key Bob dan membuat derived key menggunakan HKDF
    pub fn establish(
        alice_priv: EphemeralPrivateKey,
        bob_pub_bytes: &[u8],
    ) -> Result<Self, Box<dyn Error>> {
        let bob_pub = PublicKey::new(
            &aws_lc_rs::agreement::ECDH_P256,
            bob_pub_bytes,
        )?;

        let mut symmetric_key = [0u8; 32];
        
        // 1. ECDH Agreement
        agreement::agree_ephemeral(
            alice_priv,
            &bob_pub,
            // 2. KDF (Key Derivation Function) menggunakan HKDF
            |key_material| {
                let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, &[]);
                let prk = salt.extract(key_material);
                
                let info = [b"secure-channel-v1"];
                let okm = prk.expand(&info, &aws_lc_rs::aead::AES_256_GCM)?;
                
                okm.fill(&mut symmetric_key)?;
                Ok(())
            },
        ).map_err(|_| "Key agreement failed")?;

        Ok(Self { symmetric_key })
    }

    /// Enkripsi data menggunakan AES-256-GCM
    pub fn encrypt(&self, nonce_bytes: &[u8; 12], plaintext: &mut Vec<u8>) -> Result<(), Box<dyn Error>> {
        let unbound_key = UnboundKey::new(&AES_256_GCM, &self.symmetric_key)?;
        let less_safe_key = LessSafeKey::new(unbound_key);
        let nonce = Nonce::try_assume_unique_for_key(nonce_bytes)?;

        // Enkripsi in-place: ciphertext + tag akan menimpa/ditambahkan ke dalam vec
        less_safe_key.seal_in_place_append_tag(nonce, Aad::empty(), plaintext)
            .map_err(|_| "Encryption failed")?;
        
        Ok(())
    }

    /// Dekripsi data menggunakan AES-256-GCM
    pub fn decrypt(&self, nonce_bytes: &[u8; 12], ciphertext: &mut [u8]) -> Result<usize, Box<dyn Error>> {
        let unbound_key = UnboundKey::new(&AES_256_GCM, &self.symmetric_key)?;
        let less_safe_key = LessSafeKey::new(unbound_key);
        let nonce = Nonce::try_assume_unique_for_key(nonce_bytes)?;

        // Dekripsi in-place, mengembalikan slice plaintext yang sudah dipotong dari MAC tag
        let plaintext_len = less_safe_key.open_in_place(nonce, Aad::empty(), ciphertext)
            .map_err(|_| "Decryption/Authentication failed")?.len();
            
        Ok(plaintext_len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ecdh_and_aead_flow() {
        let rng = SystemRandom::new();
        
        // Setup Alice
        let alice_priv = EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
        let alice_pub = alice_priv.compute_public_key().unwrap();
        
        // Setup Bob
        let bob_priv = EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
        let bob_pub = bob_priv.compute_public_key().unwrap();

        // Alice derive key
        let alice_channel = SecureChannel::establish(alice_priv, bob_pub.as_ref()).unwrap();
        // Bob derive key (Bob uses Alice's pub)
        let bob_channel = SecureChannel::establish(bob_priv, alice_pub.as_ref()).unwrap();

        // Ensure keys match (Not exposed in API usually, but valid for test behavior check)
        assert_eq!(alice_channel.symmetric_key, bob_channel.symmetric_key);

        // Encryption
        let nonce = [1u8; 12];
        let mut msg = b"Top Secret Intelligence".to_vec();
        alice_channel.encrypt(&nonce, &mut msg).unwrap();
        
        // Decryption
        let plaintext_len = bob_channel.decrypt(&nonce, &mut msg).unwrap();
        assert_eq!(&msg[..plaintext_len], b"Top Secret Intelligence");
    }
}
```

## Anti-Patterns Spesifik

1. **Menggunakan `LessSafeKey` Tanpa Manajemen Nonce yang Benar**
   - **Apa yang terjadi:** Developer meng-instantiate `LessSafeKey` dari *unbound key* dan men-generate *nonce* menggunakan RNG sembarangan, atau mereset *nonce* ke `[0u8; 12]` secara berulang untuk key yang sama.
   - **Mengapa berbahaya:** Dalam AES-GCM atau ChaCha20, jika kunci dan *nonce* yang sama digunakan lebih dari sekali (*nonce reuse*), *attacker* bisa mendekripsi seluruh aliran data (XOR dari dua ciphertext menghasilkan XOR dari dua plaintext) dan menghancurkan integritas otentikasi (Galois MAC key akan terekspos, memungkinkan forgensi ciphertext arbitrary).

2. **Tidak Melakukan "Domain Separation" di HKDF**
   - **Apa yang terjadi:** Saat mengekstrak/expand *shared secret* ECDH, parameter `info` di HKDF dibiarkan kosong (`&[]`) atau menggunakan string statis yang sama untuk berbagai tujuan (misalnya digunakan untuk kunci enkripsi DAN kunci MAC secara bersamaan di sistem lama).
   - **Mengapa berbahaya:** Jika kunci turunan bocor di satu konteks, semua *layer* yang menggunakan derivasi yang sama tanpa *domain separation* ikut bocor. Selalu gunakan `info` spesifik seperti `b"app-v1-client-to-server-encryption"` atau `b"app-v1-mac-key"`.

## Edge Cases & Defensive Programming

- **Ephemeral Keys Re-use:** `EphemeralPrivateKey` (seperti namanya) dirancang untuk penggunaan SEKALI. *Ring* dan *aws-lc-rs* mengkonsumsi (`self`) *private key* saat `agree_ephemeral` dipanggil agar tipe data tidak bisa digunakan dua kali secara *compiler-level* (*Move Semantics*). Jangan mencoba menyimpan private key ephemeral di state persisten.
- **Side-Channel Timing:** Saat membandingkan MAC hasil HMAC kustom (jika tidak menggunakan primitif AEAD bawaan), penggunaan `==` (Equality operator standar) akan bocor terhadap *timing attacks*. Selalu gunakan fungsi *constant-time comparison* seperti yang disematkan di dalam `ring::constant_time::verify_slices_are_equal`.
- **Zeroization Memory:** Kunci kriptografi mentah (`symmetric_key`) berada di stack atau heap. Pertimbangkan untuk menggunakan crate `zeroize` pada struct `SecureChannel` dengan macro `#[derive(Zeroize, ZeroizeOnDrop)]` agar jejak kunci dihapus dari RAM ketika di-drop, melindungi dari memory-dump pada environment *High-Frequency Trading* atau daemon *long-running*.
