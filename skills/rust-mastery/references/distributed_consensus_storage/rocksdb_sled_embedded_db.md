# RocksDB & Embedded Database (Sled)

## Konsep Utama
Dalam banyak sistem terdistribusi (TiKV, CockroachDB), diperlukan local storage engine (embedded DB) dengan performa ekstrim. `rocksdb` (via C++ FFI) adalah raja de-facto, mendukung Column Families (CF) yang memisahkan storage internal untuk tuning terpisah. `sled` adalah alternatif native Rust murni bergaya Bw-Tree (meski perkembangannya terhenti).

## Arsitektur & Diagram Alur (ASCII)
```text
[App Process]
   |  (Put/Get/Iter)
   v
[RocksDB / Embedded DB Engine]
   |
   +--> CF "default" (Main Data)
   +--> CF "write"   (Raft/MVCC Metadata)
   +--> CF "lock"    (Transaction Locks)
```

## Kode Rust Production-Ready
```rust
// Tambahkan depedensi ke Cargo.toml: rocksdb = "0.21.0"
use rocksdb::{DB, Options, ColumnFamilyDescriptor, WriteBatch};
use std::path::Path;

pub struct StorageEngine {
    db: DB,
}

impl StorageEngine {
    pub fn new<P: AsRef<Path>>(path: P) -> Result<Self, rocksdb::Error> {
        let mut db_opts = Options::default();
        db_opts.create_if_missing(true);
        db_opts.create_missing_column_families(true);

        // Tuning sederhana untuk performa
        db_opts.set_max_background_jobs(4);
        db_opts.set_bytes_per_sync(1048576 * 2); // 2MB

        let cf_default = ColumnFamilyDescriptor::new("default", Options::default());
        let cf_meta = ColumnFamilyDescriptor::new("metadata", Options::default());

        let db = DB::open_cf_descriptors(&db_opts, path, vec![cf_default, cf_meta])?;
        Ok(Self { db })
    }

    pub fn put_atomic(&self, key: &[u8], val: &[u8], meta_val: &[u8]) -> Result<(), rocksdb::Error> {
        let cf_default = self.db.cf_handle("default").unwrap();
        let cf_meta = self.db.cf_handle("metadata").unwrap();

        // Menggunakan WriteBatch untuk atomicity (all-or-nothing cross CFs)
        let mut batch = WriteBatch::default();
        batch.put_cf(&cf_default, key, val);
        batch.put_cf(&cf_meta, key, meta_val);
        
        self.db.write(batch)
    }

    pub fn scan_prefix(&self, prefix: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
        let mut iter = self.db.prefix_iterator(prefix);
        let mut results = Vec::new();
        
        while let Some(Ok((k, v))) = iter.next() {
            if !k.starts_with(prefix) {
                break;
            }
            results.push((k.to_vec(), v.to_vec()));
        }
        results
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_rocksdb_atomic_write_and_scan() {
        let dir = tempdir().unwrap();
        let engine = StorageEngine::new(dir.path()).unwrap();

        engine.put_atomic(b"user:1", b"alice", b"v1").unwrap();
        engine.put_atomic(b"user:2", b"bob", b"v2").unwrap();
        engine.put_atomic(b"post:1", b"hello", b"v1").unwrap();

        let users = engine.scan_prefix(b"user:");
        assert_eq!(users.len(), 2);
        assert_eq!(users[0].0, b"user:1");
        assert_eq!(users[1].0, b"user:2");
    }
}
```

## Anti-Patterns
1. **Meninggalkan Iterator terbuka terlalu lama (Iterator Leaking)**
   *Mengapa berbahaya:* Iterator di RocksDB secara implisit mengambil *snapshot* (pinning) dari SSTables dan MemTables pada titik waktu tersebut. Jika iterator dibiarkan hidup, file SSTable yang sudah tidak relevan tidak dapat dihapus oleh proses *compaction*, menyebabkan pembengkakan disk (Space Amplification).
2. **Tidak menggunakan Column Families untuk workload berbeda**
   *Mengapa berbahaya:* Mencampur payload data besar dengan log/metadata yang sering berubah dalam CF yang sama akan memicu pemborosan I/O compaction besar-besaran (Write Amplification). Isolasi tabel log di CF terpisah agar *compaction threshold*-nya bisa dituning independen.

## Edge Cases & Defensive Programming
- **Disk Full (No Space Left on Device):**
  RocksDB akan panic (atau mengembalikan Err) saat flush/compaction gagal karena disk penuh. Pastikan membungkus call ke `db.write()` dengan *circuit breaker* atau rate limiter, serta memonitor metric disk di level *application layer* agar service bisa beralih ke state *Read-Only* secara *graceful* (bukan *hard crash*).
- **ReadOptions & Snapshot Isolation:**
  Saat melakukan query panjang yang mengandalkan konsistensi titik waktu, wajib gunakan `Snapshot` API secara eksplisit, jangan mengandalkan iterator lepas yang tidak sinkron antar CF.
