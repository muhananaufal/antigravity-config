# AEAD: ChaCha20-Poly1305 vs AES-GCM

## Konsep Utama
*Authenticated Encryption with Associated Data* (AEAD) adalah standar emas untuk enkripsi modern. Ini menjamin dua hal: **Kerahasiaan (Confidentiality)** dari teks terang dan **Integritas (Authenticity)** dari data enkripsi. 
Dalam Rust, crate `chacha20poly1305` mengimplementasikan algoritma ini. Berbeda dengan AES-256-GCM yang bergantung pada dukungan *hardware acceleration* (instruksi AES-NI pada CPU), ChaCha20Poly1305 sangat cepat pada arsitektur *software-only* (seperti ARM versi lama, mikrokontroler, atau WebAssembly).

Kapan digunakan:
- Enkripsi pesan asinkron (Message Queues) atau komunikasi P2P.
- Perangkat IoT atau *mobile devices* tanpa instruksi kriptografi hardware khusus.
- XChaCha20Poly1305 (Extended Nonce) digunakan ketika *nonce* dibuat secara acak murni, mencegah tabrakan (collision) yang berakibat fatal.

## Arsitektur & Flow (XChaCha20Poly1305)

```text
    [ Plaintext ]        [ Associated Data (AAD) ] ---> Tidak dienkripsi, namun di-otentikasi
          |                           |
          v                           |
+-------------------+                 |
|                   |                 v
| ChaCha20 (Cipher) |======> Poly1305 (MAC)
|  + Key (32B)      |                 |
|  + XNonce (24B)   |                 |
+-------------------+                 |
          |                           |
          v                           v
   [ Ciphertext ] + [ MAC/Authentication Tag (16B) ]
```

## Production-Ready Code

```rust
use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
    XChaCha20Poly1305, XNonce, Key
};
use std::error::Error;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Wrapper yang mengamankan memori kunci saat dijatuhkan (Drop)
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct SecureAeadEnv {
    key: [u8; 32],
}

impl SecureAeadEnv {
    /// Generate kunci random secara aman
    pub fn generate_new() -> Self {
        let mut key = [0u8; 32];
        let random_key = XChaCha20Poly1305::generate_key(&mut OsRng);
        key.copy_from_slice(random_key.as_slice());
        Self { key }
    }

    /// Membuat instance dari byte key yang sudah ada (misal dari HKDF/KMS)
    pub fn from_bytes(bytes: &[u8; 32]) -> Self {
        Self { key: *bytes }
    }

    /// Mengenkripsi pesan. Mengembalikan Tuple (Ciphertext+Tag, XNonce)
    pub fn encrypt(&self, plaintext: &[u8], associated_data: &[u8]) -> Result<(Vec<u8>, Vec<u8>), Box<dyn Error>> {
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&self.key));
        
        // XChaCha20Poly1305 memiliki 192-bit (24 byte) nonce. 
        // Menggunakan random nonce aman karena probabilitas collision sangat kecil (Birthday Bound).
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng); // 24 bytes

        let payload = Payload {
            msg: plaintext,
            aad: associated_data, // Data publik tambahan yang akan ditandatangani
        };

        let ciphertext_with_tag = cipher.encrypt(&nonce, payload)
            .map_err(|e| format!("Encryption failed: {}", e))?;

        Ok((ciphertext_with_tag, nonce.to_vec()))
    }

    /// Mendekripsi pesan, memvalidasi otentisitas secara simultan
    pub fn decrypt(
        &self,
        ciphertext_with_tag: &[u8],
        nonce: &[u8],
        associated_data: &[u8],
    ) -> Result<Vec<u8>, Box<dyn Error>> {
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&self.key));
        let xnonce = XNonce::from_slice(nonce); // Pastikan panjang 24 bytes

        let payload = Payload {
            msg: ciphertext_with_tag,
            aad: associated_data,
        };

        // Decrypt otomatis mengecek Poly1305 MAC. Jika gagal (termutilasi), me-return Error.
        let plaintext = cipher.decrypt(xnonce, payload)
            .map_err(|_| "Decryption/Authentication failure: Data corrupted or forged")?;

        Ok(plaintext)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_xchacha20poly1305_aead() {
        let env = SecureAeadEnv::generate_new();
        
        let secret_msg = b"Transaction Payload: 1M USD";
        let context_aad = b"Routing ID: 889922"; // Must not be altered

        // Encrypt
        let (encrypted, nonce) = env.encrypt(secret_msg, context_aad).unwrap();

        // Decrypt successfully
        let decrypted = env.decrypt(&encrypted, &nonce, context_aad).unwrap();
        assert_eq!(decrypted, secret_msg);

        // Attempt Decryption with altered AAD (will fail authentication)
        let altered_aad = b"Routing ID: 999999";
        let result = env.decrypt(&encrypted, &nonce, altered_aad);
        assert!(result.is_err());

        // Attempt Decryption with altered Ciphertext/Tag (will fail authentication)
        let mut corrupted = encrypted.clone();
        corrupted[0] ^= 1; // Flip 1 bit
        let result_corrupted = env.decrypt(&corrupted, &nonce, context_aad);
        assert!(result_corrupted.is_err());
    }
}
```

## Anti-Patterns Spesifik

1. **Nonce Reuse pada ChaCha20Poly1305 Standar**
   - **Apa yang terjadi:** Menggunakan varian `ChaCha20Poly1305` (nonce 96-bit/12-byte) dan membuat nonce secara *random* (`OsRng`) untuk sistem throughput tinggi.
   - **Mengapa berbahaya:** Nonce 96-bit terlalu kecil untuk di-generate secara acak. Risiko *Collision* (tabrakan nonce) meningkat tajam setelah miliaran pesan karena *Birthday Paradox*. Jika satu *nonce* dipakai dua kali dengan kunci yang sama, Poly1305 Authentication Key bocor, memungkinkan penyerang memalsukan pesan. **Solusi:** Selalu gunakan `XChaCha20Poly1305` (192-bit/24-byte nonce) jika Anda men-generate nonce secara acak.

2. **Unauthenticated Malleability Bypass (Mengabaikan AAD)**
   - **Apa yang terjadi:** Data meta terkait sistem (seperti `Sender_ID`, `Timestamp`, atau `Database_Row_ID`) dikirim bersama *ciphertext* secara terpisah, tanpa di-embed ke dalam parameter `AAD` (Associated Data).
   - **Mengapa berbahaya:** Serangan *Ciphertext Swapping*. Penyerang bisa mengambil *ciphertext* valid dari *Row_ID A* dan menyalinnya ke *Row_ID B*. Karena tidak ada pengikatan *context* ke MAC, operasi dekripsi akan sukses, yang menyebabkan kerentanan logika bisnis (contoh: memindahkan saldo valid antara *users*).

## Edge Cases & Defensive Programming

- **OOM (Out Of Memory) pada Pesan Besar:** Crate standar melakukan enkripsi ke dalam satu vektor `Vec<u8>`. Jika mengenkripsi file video 5GB secara langsung, RAM akan meledak. Gunakan `aead::stream` (seperti *STREAM* protocol yang dimandatkan libsodium) atau implementasi Chunking AEAD untuk melakukan dekripsi blok per blok (biasanya blok 64KB - 1MB) secara aman dan menolak *streaming* lebih lanjut jika tag gagal per blok.
- **Timing Attacks pada Length / Ukuran Ciphertext:** Enkripsi AEAD tidak menyembunyikan ukuran/panjang pesan asli. *Observer* jaringan bisa menebak isi pesan dari ukurannya. Tambahkan mekanisme *Padding* seragam di dalam *Plaintext* sebelum mengenkripsi (menjadikan semua blok ukuran *fixed* misal 1024 bytes) jika privasi dari *traffic analysis* dibutuhkan.
