# Borsh Serialization

## Konsep Utama
Borsh (Binary Object Representation Serializer for Hashing) adalah spesifikasi format data memori yang murni dirancang untuk determinisme mutlak dan kecepatan tinggi. Format ini mendominasi ekosistem web3 Rust (khususnya Solana dan NEAR) karena ketiadaan overhead skema nama variabel di dalamnya. Sangat ringan namun ketat; ukurannya pas satu banding satu dengan penempatan byte (endian) C/Rust.

## Arsitektur & Flow
```ascii
    [ Rust Struct T (In-Memory) ]
              |
      (BorshSerialize Trait)
              |
[ Raw Byte Array (Little Endian, No Metada) ]
              |
   [ Keccak / SHA Hash Verification ] ATAU [ Network / Storage Layer ]
              |
      (BorshDeserialize Trait)
              |
[ Validation Result / Reconstructed Struct ]
```

## Production-Ready Code
```rust
use borsh::{BorshDeserialize, BorshSerialize};
use std::io::{Error, Write};

#[derive(BorshSerialize, BorshDeserialize, PartialEq, Debug, Clone)]
pub struct UserProfile {
    pub id: u64,
    pub username: String, // Dynamic length, dicode sebagai: length (u32 LE) + UTF-8 bytes
    pub tokens_balance: u128,
    pub is_active: bool,
}

pub fn encode_profile(profile: &UserProfile) -> Result<Vec<u8>, std::io::Error> {
    // try_to_vec secara otomatis memanggil alokator dan BorshSerialize internal
    profile.try_to_vec()
}

pub fn decode_profile(data: &[u8]) -> Result<UserProfile, std::io::Error> {
    // Borsh memastikan panjang bit valid, jika truncate maka akan panic / error safe
    UserProfile::try_from_slice(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_serialize_deserialize_consistency() {
        let profile = UserProfile {
            id: 9942,
            username: "Satoshi_N".to_string(),
            tokens_balance: 50_000_000,
            is_active: true,
        };

        // 1. Serialize 
        let encoded = encode_profile(&profile).unwrap();
        
        // 2. Format borsh untuk bool (1 byte), string (4 byte len + chars)
        // Panjang pastinya adalah: 8 (u64) + 4 (u32 len) + 9 (chars) + 16 (u128) + 1 (bool) = 38 bytes
        assert_eq!(encoded.len(), 38);

        // 3. Deserialize 
        let decoded = decode_profile(&encoded).unwrap();
        
        assert_eq!(profile, decoded);
    }
}
```

## Anti-Patterns
1. **Mengganti urutan / tipe field secara sewenang-wenang (Schema Break)**: 
   *Mengapa Berbahaya:* Berbeda dengan JSON (Serde) yang memiliki mapping berbasis text key (K-V), Borsh mem-parse hanya lewat byte index array mentah. Jika v1 memiliki `(u32, bool)` dan v2 anda merevisinya jadi `(bool, u32)`, seluruh data riwayat di jaringan blockchain yang lama akan dianggap invalid (Crash deserialisasi).
2. **Serialisasi Enum Dinamis Tanpa Versi Tagging**:
   *Mengapa Berbahaya:* Enum di-encoding oleh Borsh dengan 1 byte (u8) diskriminator (tag) awalan. Jika anda menyisipkan field di "Tengah" struktur Enum, semua tag setelah itu bergeser digitnya (off-by-one). Selalu tambahkan data variant di akhir atau gunakan macro spesifik versi.

## Edge Cases & Defensive Programming
- **Batasan Memori Besar (BOM)**: Serangan vector DoS terjadi ketika parser membaca field string atau `Vec`. Panjang slice ditampung di `u32` (hingga 4 GB alokasi memori buffer!). Jika data corrupt dan menginjeksikan header len max, node anda bisa OOM (Out Of Memory). Selalu bungkus batas buffer deserialize di dalam wrapper reader limit memori max.
- **Kecocokan Serde vs Borsh**: Borsh bukanlah pengganti Serde. Untuk API web REST standar/JSON config (dimana keleluasaan manusia membaca dituntut), Serde jauh lebih superior. Borsh mutlak diisolasikan hanya pada zona transmisi P2P/Blockchain disk storage dan perhitungan hash on-chain (merkle tree).
