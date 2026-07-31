# Ethereum Merkle Patricia Trie

## Konsep Utama
Merkle Patricia Trie (MPT) adalah tulang punggung struktur kriptografis state, transaksi, dan receipt Ethereum. Ia menggabungkan Radix Trie (untuk pencarian optimisasi string/hash secara efisien dan deterministik) dengan struktur Merkle Tree (dimana parent node meng-hash child node). Ini memungkinkan validasi *Light Client Proof* super efisien tanpa harus menyimpan keseluruhan milyaran baris basis data state layer.

## Arsitektur & Flow
```ascii
      [ Root Node (Hash State) ]
             /          \
[ Branch Node (0..15 array pointer + Val) ]
         |
[ Extension Node (Shared prefix path) ]
         |
[ Leaf Node (Key Path End + RLP Encoded Data) ]
```

## Production-Ready Code
```rust
use ethereum_types::{H256, U256};
use rlp::{RlpStream, Encodable};
use sha3::{Digest, Keccak256};

// Simulasi Leaf Node RLP Encodable
#[derive(Debug, Clone, PartialEq)]
pub struct AccountState {
    pub nonce: U256,
    pub balance: U256,
    pub storage_root: H256,
    pub code_hash: H256,
}

impl Encodable for AccountState {
    fn rlp_append(&self, s: &mut rlp::RlpStream) {
        s.begin_list(4);
        s.append(&self.nonce);
        s.append(&self.balance);
        s.append(&self.storage_root);
        s.append(&self.code_hash);
    }
}

// Fungsi komputasi keccak256 layaknya Ethereum native
pub fn keccak256(data: &[u8]) -> H256 {
    let mut hasher = Keccak256::new();
    hasher.update(data);
    H256::from_slice(&hasher.finalize())
}

pub fn generate_account_leaf_hash(state: &AccountState) -> H256 {
    let mut stream = RlpStream::new();
    state.rlp_append(&mut stream);
    let rlp_bytes = stream.out();
    
    // Hash hasil RLP encoding (Leaf Data Representation)
    keccak256(&rlp_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rlp_hash_determinism() {
        let state = AccountState {
            nonce: U256::zero(),
            balance: U256::from(100),
            storage_root: H256::zero(), // Asumsikan Trie Kosong
            code_hash: keccak256(b""), // EOA Account
        };

        let hash_1 = generate_account_leaf_hash(&state);
        let hash_2 = generate_account_leaf_hash(&state);
        
        // Mutlak harus deterministik
        assert_eq!(hash_1, hash_2);
    }
}
```

## Anti-Patterns
1. **Modifikasi Node di Memori Tanpa Copy-on-Write (CoW)**: 
   *Mengapa Berbahaya:* Mengubah sebuah *Leaf Node* di MPT merubah seluruh alur hash menuju root. Jika anda menimpa objek node di heap tanpa mempertahankan refensi masa lalu secara konstan, struktur tree historikal menjadi korup, menghancurkan akses API RPC blok sebelumnya (Archive Node breakdown).
2. **Tidak menangani Nibble Odd-Length (Hex Path)**:
   *Mengapa Berbahaya:* MPT mengemas key (path) berdasarkan karakter hex 4-bit (Nibble). Mengonversi string path sembarangan tanpa meng-inject prefix khusus (HP encoding - 1 byte indikator odd/even) akan merusak decoding rute pembacaan branch/extension dari sisi client/light-node sinkronisasi.

## Edge Cases & Defensive Programming
- **Storage Root Collision (Empty State)**: Root hash untuk MPT kosong BUKAN array of zeros. Dalam Ethereum, hashing nilai _NULL_ rlp string berujung pada nilai konstan `0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421`. Jangan hardcode nol pada field `storage_root` di verifikasi proof, gunakan konstanta ini.
- **Deep Proof Verification Memory Exhaustion**: Validasi proof dapat menyebabkan iterasi node dalam list besar bersarang. Pelaku siber bisa meracik *fake merkle proof* dengan kedalaman ribuan loop tak hingga yang menghancurkan node parser RAM (`OOM Crash`). Tetapkan batas maksimun kedalaman tree secara eksplisit saat traversing branch.
