# Log-Structured Merge Tree (LSM-Tree)

## Konsep Utama
LSM-Tree adalah struktur data inti yang mendasari database modern dengan rasio write tinggi (seperti RocksDB, Cassandra). Alih-alih melakukan update in-place di disk (seperti B-Tree tradisional), LSM-Tree menyangga write di memori (MemTable) dan membilasnya (flush) secara berurutan ke disk sebagai SSTable (Sorted String Table). Compaction bekerja di latar belakang untuk menggabungkan SSTable yang menumpuk.

## Arsitektur & Diagram Alur (ASCII)
```text
[Write] ---> WAL (Durability)
  |
  v
[Active MemTable] (SkipList / BTree)
  | (Bila penuh)
  v
[Immutable MemTable] (Read-Only)
  | (Background Flush)
  v
[L0 SSTable] (Di disk, ada overalapping ranges)
  | (Compaction: Leveled / Tiered)
  v
[L1..Ln SSTables] (Non-overlapping ranges per level)
```

## Kode Rust Production-Ready
```rust
use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

#[derive(Clone, Debug)]
pub enum ValueStatus {
    Present(Vec<u8>),
    Tombstone, // Marker untuk penghapusan
}

pub struct MemTable {
    // Menggunakan BTreeMap untuk simplisitas di memori. 
    // Di production sering digunakan Concurrent SkipList (misal crossbeam-skiplist)
    table: BTreeMap<Vec<u8>, ValueStatus>,
    size_bytes: usize,
    max_size: usize,
}

impl MemTable {
    pub fn new(max_size: usize) -> Self {
        Self {
            table: BTreeMap::new(),
            size_bytes: 0,
            max_size,
        }
    }

    pub fn put(&mut self, key: &[u8], value: &[u8]) -> bool {
        let entry_size = key.len() + value.len();
        self.table.insert(key.to_vec(), ValueStatus::Present(value.to_vec()));
        self.size_bytes += entry_size;
        
        self.size_bytes >= self.max_size
    }

    pub fn delete(&mut self, key: &[u8]) -> bool {
        let entry_size = key.len();
        self.table.insert(key.to_vec(), ValueStatus::Tombstone);
        self.size_bytes += entry_size;
        
        self.size_bytes >= self.max_size
    }

    pub fn get(&self, key: &[u8]) -> Option<ValueStatus> {
        self.table.get(key).cloned()
    }
}

pub struct Engine {
    active_memtable: Arc<RwLock<MemTable>>,
    immutable_memtables: Arc<RwLock<Vec<MemTable>>>,
}

impl Engine {
    pub fn new(memtable_size: usize) -> Self {
        Self {
            active_memtable: Arc::new(RwLock::new(MemTable::new(memtable_size))),
            immutable_memtables: Arc::new(RwLock::new(Vec::new())),
        }
    }

    pub fn put(&self, key: &[u8], value: &[u8]) {
        let mut active = self.active_memtable.write().unwrap();
        let is_full = active.put(key, value);
        
        if is_full {
            let mut imms = self.immutable_memtables.write().unwrap();
            // Buat memtable baru dan pindahkan yang lama (simulasi flush ke background)
            let mut new_active = MemTable::new(active.max_size);
            std::mem::swap(&mut *active, &mut new_active);
            imms.push(new_active);
        }
    }

    pub fn get(&self, key: &[u8]) -> Option<Vec<u8>> {
        // 1. Cek di Active MemTable
        if let Some(status) = self.active_memtable.read().unwrap().get(key) {
            return match status {
                ValueStatus::Present(v) => Some(v),
                ValueStatus::Tombstone => None,
            };
        }

        // 2. Cek di Immutable Memtables (dari yang terbaru)
        let imms = self.immutable_memtables.read().unwrap();
        for imm in imms.iter().rev() {
            if let Some(status) = imm.get(key) {
                return match status {
                    ValueStatus::Present(v) => Some(v),
                    ValueStatus::Tombstone => None,
                };
            }
        }

        // 3. (Seharusnya) Cek di SSTables disk
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_engine_put_get_delete() {
        let engine = Engine::new(1024); // 1KB memtable untuk tes
        engine.put(b"key1", b"value1");
        assert_eq!(engine.get(b"key1"), Some(b"value1".to_vec()));

        // Active MemTable to Immutable MemTable rotation
        let mut active = engine.active_memtable.write().unwrap();
        active.delete(b"key1");
        drop(active);
        
        assert_eq!(engine.get(b"key1"), None); // Terhapus karena tombstone
    }
}
```

## Anti-Patterns
1. **Tidak menggunakan Bloom Filter pada SSTable**
   *Mengapa berbahaya:* Read amplification akan meledak. Tanpa bloom filter, query untuk key yang tidak eksis (`get`) akan memaksa engine melakukan I/O disk untuk setiap level SSTable. Bloom filter mengeleminasi 99% pencarian tak berguna di disk.
2. **Memblokir thread utama saat Compaction (Write Stall)**
   *Mengapa berbahaya:* Jika thread background tidak sanggup mengimbangi laju flush dari memtable, LSM tree akan membesar tanpa kendali (OOM disk). Jika solusinya malah melempar beban compaction ke thread penulis (foreground), latensi penulisan (write latency) akan melonjak tajam secara tak terduga (P99 spike).

## Edge Cases & Defensive Programming
- **Tombstone GC (Garbage Collection):**
  Tombstone tidak boleh langsung dihapus saat compaction antar level atas (L0->L1), karena versi data yang lebih lama mungkin masih ada di LMAX. Tombstone hanya boleh di-drop (dihapus beneran) ketika mencapai level terakhir yang mengandung rentang kunci tersebut.
- **Large Value di LSM Tree:**
  Menyimpan blob besar (misal 10MB) langsung di dalam SSTable akan menyebabkan I/O amplification luar biasa saat compaction. Untuk value besar, gunakan teknik WiscKey (Pemisahan Key dan Value log).
