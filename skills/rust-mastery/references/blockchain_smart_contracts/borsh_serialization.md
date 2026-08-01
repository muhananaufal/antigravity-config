# Borsh Serialization untuk Smart Contracts (Solana/NEAR)

## Konsep Utama & Arsitektur
Borsh (Binary Object Representation Serializer for Hashing) adalah standar serialisasi deterministik tinggi yang didesain secara spesifik untuk aplikasi keamanan-kritis seperti Smart Contracts (Blockchain). Borsh berfokus pada kecepatan, footprint biner minimum, dan yang paling krusial: menjamin keamanan secara kriptografis (deterministic encoding).

Berbeda dengan JSON, MessagePack, atau Bincode:
1. **Deterministik**: Struktur data X hanya dapat direpresentasikan oleh *satu dan satu-satunya* bentuk urutan byte valid. Ini vital untuk kalkulasi Hash block dan signature payload.
2. **Tanpa Tagging/Overhead Meta-data**: Borsh tidak menyimpan nama field tipe data di byte-stream, sangat menghemat biaya "Gas" di smart contract.
3. **Aman dari Serangan**: Panjang string dan vektor ditangani dengan hati-hati (menggunakan u32 prefix) untuk menghindari serangan out-of-memory (OOM) deserialization.

### Diagram Arsitektur: Borsh Determinsitic Layout
```text
Rust Struct: 
User { age: u8, name: String }

Data:
User { age: 30, name: "Bob" }

Borsh Byte-Stream:
[ 0x1E ]                    <- u8 (30)
[ 0x03, 0x00, 0x00, 0x00 ]  <- u32 Little-Endian String Length (3)
[ 0x42, 0x6F, 0x62 ]        <- UTF-8 Bytes ("Bob")

Total: 8 Bytes. Strict, No padding, No tags.
```

## Kode Produksi Rust Smart Contract dengan Borsh
Kode berikut adalah representasi state untuk DEX (Decentralized Exchange) di smart contract (menggunakan `borsh` 1.0+).

```rust
use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshSerialize, BorshDeserialize, PartialEq, Debug, Clone)]
pub struct SwapInstruction {
    pub token_in_amount: u64,
    pub min_token_out: u64,
}

#[derive(BorshSerialize, BorshDeserialize, PartialEq, Debug)]
pub struct DexPoolState {
    pub is_initialized: bool,
    pub liquidity_a: u128,
    pub liquidity_b: u128,
    pub admin_pubkey: [u8; 32],
}

impl DexPoolState {
    /// Aman mem-proses payload Borsh dari client network
    pub fn unpack(input: &[u8]) -> Result<Self, std::io::Error> {
        // Melakukan deserialisasi dari buffer stream
        Self::try_from_slice(input)
    }

    /// Serialisasi state baru ke buffer untuk disimpan di on-chain storage
    pub fn pack(&self) -> Result<Vec<u8>, std::io::Error> {
        borsh::to_vec(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_serialization_determinism() {
        let state = DexPoolState {
            is_initialized: true,
            liquidity_a: 1_000_000_000,
            liquidity_b: 500_000,
            admin_pubkey: [1; 32],
        };

        let encoded = state.pack().expect("Failed to serialize");
        
        // Exact size: 1 (bool) + 16 (u128) + 16 (u128) + 32 (array) = 65 bytes
        assert_eq!(encoded.len(), 65);

        let decoded = DexPoolState::unpack(&encoded).expect("Failed to deserialize");
        assert_eq!(state, decoded);
    }
}
```

## Anti-Patterns

### 1. Menggunakan Tipe Data Tak Deterministik (`f32`, `f64`, atau `HashMap`)
**Penjelasan:** Angka desimal floating-point tidak deterministik antar CPU architecture dan runtime compiler (adanya state NaN dan konversi tidak presisi). `HashMap` di Rust tidak menjamin urutan (order) dari iteration keys-nya secara default karena `SipHash` menggunakan random seed.
**Bahaya:** Jika smart contract mengembalikan hash yang berbeda pada validator yang berbeda, akan terjadi konsensus failure ("Fork" pada node network). Gunakan integer basis (`u64`, `u128`) untuk mewakili pecahan desimal (seperti wei/satoshi) dan `BTreeMap` sebagai pengganti `HashMap`.

### 2. Menggunakan `usize` atau `isize` dalam Struct Payload
**Penjelasan:** Borsh tidak memperbolehkan `usize` atau `isize` diserialisasikan karena ukurannya bergantung pada arsitektur node yang melakukan kompilasi (32-bit atau 64-bit).
**Bahaya:** Kontrak yang sama jika di-compile dan dijalankan di dua node berbeda dapat menghasilkan payload dengan layout bytes berlainan. Gunakan eksplisit `u32` atau `u64`.

## Edge Cases & Defensive Programming

1. **Integer Overflow & Attack Vector (Gas Exhaustion)**:
   Penyerang mungkin mengirim struct array dengan field `length: u32::MAX`. Borsh aman dari ini jika validator membatasi *maximum bytes allocatable* per transaksi on-chain. Selalu batasi panjang array pada logika instruksi Anda (misal `assert!(accounts.len() <= 10)`).
2. **Schema Upgrade & Backward Compatibility**:
   Jika Anda menambah field baru ke `DexPoolState` (contoh: `pub is_frozen: bool`), deserialize state lama on-chain akan gagal (EOF error). Gunakan Enum bervariasi (`V1(PoolStateV1), V2(PoolStateV2)`) sebagai root tipe di Borsh untuk migrasi data on-chain secara elegan.
3. **Sisa Buffer Mengandung Sampah (Trailing Garbage)**:
   Gunakan `BorshDeserialize::try_from_slice(input)` secara ekslusif (jangan `BorshDeserialize::deserialize(&mut buffer)`) karena `try_from_slice` akan error jika terdapat *unconsumed bytes* di ekor stream input. Mengabaikan byte sisa membuka vektor serangan di Solana/NEAR di mana hacker menyisipkan opcode jahat yang tak terbaca oleh payload utama Anda.
