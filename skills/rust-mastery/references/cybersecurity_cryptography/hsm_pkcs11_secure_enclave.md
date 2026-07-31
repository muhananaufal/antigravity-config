# HSM, KMS & PKCS#11 Secure Enclave

## Konsep Utama
Ketika *Private Keys* tidak boleh berada dalam memori CPU server di bawah kondisi apa pun, *Hardware Security Modules* (HSM), Enclaves (seperti AWS Nitro atau Intel SGX), atau KMS (*Key Management Service*) digunakan. Operasi kriptografis dilakukan DENGAN CARA mengirimkan data (hash atau pesan) ke perangkat keras eksternal, dan perangkat keras mereturn hasil (tanda tangan, ciphertext) tanpa mengekspos kunci.

Dalam Rust:
- **`cryptoki`**: Membungkus API PKCS#11 (standar industri untuk berkomunikasi dengan HSM/Smartcard fisik, seperti YubiKey, Thales, atau SoftHSM).
- **`aws-sdk-kms`**: Digunakan untuk berinteraksi dengan AWS KMS untuk pola *Envelope Encryption* secara *cloud-native*.

Kapan digunakan:
- CA (*Certificate Authority*) Internal yang menandatangani sertifikat klien.
- Tanda tangan *Smart Contract* kriptokurensi, Dompet Kustodian Bappebti/OJK.
- Kepatuhan PCI-DSS atau regulasi HIPAA tingkat tinggi.

## Arsitektur & Flow (Envelope Encryption Pattern)

```text
       [ Rust Application ]                         [ AWS KMS / HSM ]
               |                                            |
               | 1. GenerateDataKey() Request               |
               |------------------------------------------->|  <-- Master Key (CMK)
               |                                            |
               |<------- 2. Returns (PlainKey, CipherKey) --|
               |
  3. Encrypt Data with PlainKey (AES-GCM locally)
               |
  4. Discard PlainKey from RAM (Zeroize)
               |
  5. Store (CipherKey + EncryptedData) to Database

       [ Decryption Flow ]
  6. Fetch (CipherKey + EncryptedData) from DB
               |
               | 7. DecryptRequest(CipherKey)               |
               |------------------------------------------->|
               |                                            |
               |<------- 8. Returns (PlainKey) -------------|
               |
  9. Decrypt EncryptedData with PlainKey locally
```

## Production-Ready Code (AWS KMS Envelope Encryption)

```rust
use aws_sdk_kms::Client as KmsClient;
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce
};
use rand::RngCore;
use std::error::Error;
use zeroize::Zeroize;

/// Struktur yang merepresentasikan payload terenkripsi yang siap disimpan di DB
pub struct EncryptedRecord {
    pub encrypted_data_key: Vec<u8>, // Data Key yang terenkripsi oleh KMS (Kek)
    pub ciphertext: Vec<u8>,         // Data aktual (terenkripsi)
    pub nonce: Vec<u8>,              // XNonce AEAD (24 bytes)
}

/// Layanan Kriptografi Cloud-Native
pub struct EnvelopeCryptoService {
    kms_client: KmsClient,
    master_key_id: String, // ARN atau Alias KMS
}

impl EnvelopeCryptoService {
    pub fn new(kms_client: KmsClient, master_key_id: String) -> Self {
        Self { kms_client, master_key_id }
    }

    /// Enkripsi data besar lokal, amankan kunci datanya ke KMS
    pub async fn encrypt_data(&self, plaintext: &[u8]) -> Result<EncryptedRecord, Box<dyn Error>> {
        // 1. Minta KMS men-generate Data Key simetris 256-bit (32 bytes)
        let resp = self.kms_client
            .generate_data_key()
            .key_id(&self.master_key_id)
            .key_spec(aws_sdk_kms::types::DataKeySpec::Aes256)
            .send()
            .await?;

        // 2. Ekstrak Kunci Teks Terang & Kunci Terenkripsi (Cipher blob)
        let mut plain_key_blob = resp.plaintext()
            .ok_or("No plaintext key returned")?
            .as_ref()
            .to_vec();
            
        let encrypted_data_key = resp.ciphertext_blob()
            .ok_or("No ciphertext blob returned")?
            .as_ref()
            .to_vec();

        // 3. Lakukan enkripsi lokal dengan XChaCha20Poly1305
        let cipher = XChaCha20Poly1305::new_from_slice(&plain_key_blob)?;
        
        let mut nonce_bytes = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);

        let ciphertext = cipher.encrypt(nonce, Payload { msg: plaintext, aad: b"" })
            .map_err(|_| "Local AEAD encryption failed")?;

        // 4. HANCURKAN Kunci Teks Terang dari memori! (Zeroize)
        plain_key_blob.zeroize();

        Ok(EncryptedRecord {
            encrypted_data_key,
            ciphertext,
            nonce: nonce_bytes.to_vec(),
        })
    }

    /// Dekripsi Data: Kirim Kunci Terenkripsi ke KMS, lalu gunakan untuk dekripsi lokal
    pub async fn decrypt_data(&self, record: &EncryptedRecord) -> Result<Vec<u8>, Box<dyn Error>> {
        let ciphertext_blob = aws_smithy_types::Blob::new(record.encrypted_data_key.clone());

        // 1. Minta KMS membongkar (decrypt) kunci datanya
        let resp = self.kms_client
            .decrypt()
            .ciphertext_blob(ciphertext_blob)
            .send()
            .await?;

        let mut plain_key_blob = resp.plaintext()
            .ok_or("No plaintext key returned from KMS")?
            .as_ref()
            .to_vec();

        // 2. Gunakan kunci terbongkar untuk dekripsi lokal
        let cipher = XChaCha20Poly1305::new_from_slice(&plain_key_blob)?;
        let nonce = XNonce::from_slice(&record.nonce);

        let plaintext = cipher.decrypt(nonce, Payload { msg: &record.ciphertext, aad: b"" })
            .map_err(|_| "Local AEAD decryption failed (Authentication failed)")?;

        // 3. Hancurkan Kunci dari memori
        plain_key_blob.zeroize();

        Ok(plaintext)
    }
}
```

## Anti-Patterns Spesifik

1. **Meminta KMS Mengenkripsi Payload Secara Langsung (tanpa Envelope)**
   - **Apa yang terjadi:** Daripada menggunakan fungsi `GenerateDataKey`, developer memanggil `kms_client.encrypt(data)` dan mengirimkan seluruh file PDF sebesar 10MB ke KMS AWS.
   - **Mengapa berbahaya:** API KMS (seperti AWS atau HSM PKCS#11) memiliki batas ukuran transfer payload yang sangat ketat (KMS maks 4KB, HSM kadang hanya panjang hash algoritma seperti 32 bytes). Mengirim data besar menghancurkan performa jaringan, melanggar batas API, dan memakan biaya astronomis (billed per request call) dalam tagihan *cloud*.

2. **Gagal Menerapkan *Session Management* (di HSM Fisik)**
   - **Apa yang terjadi:** Dalam implementasi library `cryptoki`, membuka `Session` ke HSM untuk *setiap* operasi enkripsi/tanda tangan dan tidak menutupnya, atau membagi satu *Session* melintasi ratusan thread *Tokio* secara *lock-free*.
   - **Mengapa berbahaya:** *Smart cards* dan perangkat keras kriptografi memiliki memori OS yang sangat terbatas. Jika *Session* tidak ditutup, HSM akan mengalami *Out of Session (C_OpenSession error)* dan mogok. Jika 1 session dibagi multithread tanpa *Mutex* ketat, terjadi *Data Race* di state hardware, menghasilkan tanda tangan yang korup.

## Edge Cases & Defensive Programming

- **Fail-Open pada Gangguan Jaringan KMS:** Jika aplikasi tidak bisa menghubungi AWS KMS (jaringan mati sementara), proses dekripsi harus **Gagal (Fail-Closed)**. Jangan pernah menyimpan *Plaintext Key Cache* dalam *plain text* di Redis atau Disk sebagai mekanisme *fallback*! Jika caching terpaksa dilakukan (untuk menghemat latensi dan biaya KMS), kunci harus tetap diamankan di memori tersendiri dengan *TTL (Time to Live)* terbatas, menggunakan prinsip arsitektur *KMS Data Key Caching* resmi.
- **Vendor Lock-In di API Kripto:** Menautkan *business logic* Anda secara langsung ke tipe dari `aws_sdk_kms`. Di sistem skalabilitas global, Anda mungkin harus beralih dari AWS ke modul HSM on-premise (via PKCS#11) secara mendadak karena alasan kepatuhan regulasi wilayah. **Gunakan Trait Abstraction (Hexagonal Architecture):** Bangun trait `trait MasterKeyProvider { fn decrypt_key(&self, encrypted: &[u8]) -> Result<Vec<u8>>; }` sehingga implementasi AWS dan Cryptoki HSM bisa di-swap di *runtime*.
