# Merkle Patricia Trie (MPT) dalam Rust

## Konsep Utama & Arsitektur
Merkle Patricia Trie (MPT) adalah fondasi kriptografis untuk manajemen state di Ethereum dan blockchain berbasis EVM lainnya. Struktur ini menggabungkan "Patricia Trie" (Radix Tree) untuk kompresi prefix yang efisien, dengan "Merkle Tree" untuk pembuktian data (proofs) secara kriptografis menggunakan *hash pointers*. 

Setiap interaksi dengan global state dikalkulasi hingga ke satu representasi Hash absolut (`state_root`). MPT secara brilian membagi node menjadi tiga tipe:
1. **Leaf Node**: Berisi `[Key_Suffix, Value]`. Node akhir yang menyimpan nilai data sesungguhnya.
2. **Extension Node**: Berisi `[Shared_Prefix, Hash_Pointer]`. Digunakan untuk memampatkan cabang rute key yang panjang dan tunggal menjadi satu node untuk hemat ruang.
3. **Branch Node**: Berisi 17 elemen: `[Hash_Pointers 0-15] + [Value_Here]`. Membagi pencarian ke 16 cabang (hexadecimal digit) selanjutnya.

### Diagram Arsitektur: MPT Compression
```text
Root Hash: 0xA1...

          [ Extension Node ]
          Path: 'a7' (Hex)
          Target: BranchNodeHash
                  |
         +--------+---------+
         |                  |
[ Branch Node ]             |
(0) (1)..(f) [Value]        v
 |                    [ Leaf Node ]
 |                    Path Suffix: 'f3'
 v                    Value: "Bob Balance"
[ Leaf Node ]
Path Suffix: '113b'
Value: "Alice Balance"
```
*Jika tidak ada kompresi extension, key "a7f3" akan membutuhkan 4 branch node kosong berturut-turut!*

## Kode Produksi Rust MPT (Simplified Node Structure)
Di bawah ini mendemonstrasikan implementasi state dari node MPT dalam Rust. 

```rust
use sha3::{Digest, Keccak256};

#[derive(Debug, PartialEq, Clone)]
pub enum TrieNode {
    /// Branch memegang pointer (hashes) ke 16 kemungkinan anak (hex nibbles) dan opsi data di level tersebut
    Branch {
        children: [Option<Vec<u8>>; 16],
        value: Option<Vec<u8>>,
    },
    /// Extension untuk jalan pintas jika hanya ada satu child valid pada kedalaman tertentu
    Extension {
        prefix: Vec<u8>,
        child_hash: Vec<u8>,
    },
    /// Akhir dari tree, memegang value sebenarnya
    Leaf {
        path_suffix: Vec<u8>,
        value: Vec<u8>,
    },
    /// Leaf yang tidak ada
    Empty,
}

impl TrieNode {
    /// Mengkalkulasi Keccak256 hash representasi sebuah Node (RLP Serialization di dunia nyata)
    pub fn compute_hash(&self) -> Vec<u8> {
        let mut hasher = Keccak256::new();
        
        match self {
            TrieNode::Empty => {
                hasher.update(&[]);
            }
            TrieNode::Leaf { path_suffix, value } => {
                // Di dunia EVM, ini harus di-serialize pakai RLP (Recursive Length Prefix)
                // Di sini disederhanakan dengan concat langsung
                hasher.update(b"L"); 
                hasher.update(path_suffix);
                hasher.update(value);
            }
            TrieNode::Extension { prefix, child_hash } => {
                hasher.update(b"E");
                hasher.update(prefix);
                hasher.update(child_hash);
            }
            TrieNode::Branch { children, value } => {
                hasher.update(b"B");
                for child in children.iter() {
                    if let Some(hash) = child {
                        hasher.update(hash);
                    } else {
                        hasher.update(&[0u8; 32]); // empty pointer
                    }
                }
                if let Some(val) = value {
                    hasher.update(val);
                }
            }
        }
        
        hasher.finalize().to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_leaf_node_hashing() {
        let leaf1 = TrieNode::Leaf {
            path_suffix: vec![0x1, 0x2], // nibbles
            value: vec![0xFF, 0xAA],
        };
        
        let leaf2 = TrieNode::Leaf {
            path_suffix: vec![0x1, 0x2],
            value: vec![0xFF, 0xAA],
        };

        assert_eq!(leaf1.compute_hash(), leaf2.compute_hash());
    }

    #[test]
    fn test_empty_hash_is_distinct() {
        let empty = TrieNode::Empty;
        let result = empty.compute_hash();
        assert_eq!(result.len(), 32);
    }
}
```

## Anti-Patterns

### 1. Key tanpa Packing "Nibble" (Setengah-Byte)
**Penjelasan:** MPT mengurutkan berdasarkan karakter Heksadesimal (4 bit / 1 nibble). Banyak developer keliru menyimpan `String` atau `[u8]` utuh sebagai kunci path, bukannya mengekstrak dan mem-packing 2 nibble per 1 byte.
**Bahaya:** Ini menghancurkan struktur radix tree dan membengkakkan database penyimpanan di chain (merusak performa lookup O(log N)). Ethereum menggunakan algoritma *Hex-Prefix (HP) Encoding* khusus untuk memisahkan nibble ganjil dan genap di Extension/Leaf node.

### 2. Meng-update Parent Tanpa Memperbarui Pointer Hash
**Penjelasan:** Merkle Tree bersifat immutable di level struktur (Functional Data Structure). Jika Anda mengubah nilai di `Leaf`, Anda **TIDAK BOLEH** hanya memperbarui isi Leaf tersebut di dalam storage.
**Bahaya:** Root hash tidak akan berubah, membahayakan konsensus network. Anda wajib mengalokasikan Leaf BARU, menghitung hash baru, lalu membuat node Extension/Branch parent BARU yang menunjuk ke Hash tersebut, hingga menjalar (bubble up) memproduksi Root Hash baru.

## Edge Cases & Defensive Programming

1. **Delete Operation Collision**: Menghapus value di MPT sangat *tricky*. Jika dari sebuah Branch Node (punya 2 anak) satu anaknya dihapus, Branch Node itu mendadak menjadi invalid secara aturan optimalitas MPT. Node ini harus "diruntuhkan" dan dimerge dengan anak yang tersisa menjadi Extension Node tunggal (Path Compression). Gagal melakukan ini menyebabkan tree tidak deterministik.
2. **Database Key-Value (RocksDB) Persistence**: Node hash yang dikalkulasi bertindak sebagai `Key` dalam database KV engine seperti RocksDB, sedangkan struktur node yang diserialisasikan via RLP adalah `Value`-nya. Hindari serangan *hash collision* dan *garbage collection memory leak*: gunakan reference counting (Trie Pruning) pada hash key yang usang setiap kali transaksi block difinalisasi, bila tidak state size akan meledak dari Gigabytes menjadi Terabytes.
3. **Bukti Cabang Palsu (Fraud Proofs)**: Dalam arsitektur Light Client (Rollups), validasi bukti memerlukan konstruksi parsial MPT (hanya subset sibling hashes yang diberikan). Jangan mudah percaya pada `value` yang disuplai di ujung array; pastikan komputasi ulan dari bawah hingga menghasilkan root hash yang diverifikasi sama secara matematis (O(log 16 N) verifications).
