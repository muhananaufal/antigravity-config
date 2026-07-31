# Raft Consensus & State Machine

## Konsep Utama
Raft adalah algoritma konsensus terdistribusi yang dirancang agar mudah dipahami. Raft memecah konsensus menjadi tiga sub-masalah independen: **Leader Election**, **Log Replication**, dan **Safety**. Dalam implementasi *production*, sering digunakan bersama *State Machine* di mana log yang sudah di-commit diaplikasikan (apply) secara deterministik untuk mengubah state aplikasi. `raft-rs` (digunakan oleh TiKV) adalah implementasi standar industri di ekosistem Rust.

## Arsitektur & Diagram Alur (ASCII)
```text
      +-----------------+
      |                 |
      v                 |
+----------+        +---+-------+
| Follower | -----> | Candidate |
+----------+        +---+-------+
      ^                 |
      |                 v
      |            +----------+
      +----------- |  Leader  |
                   +----------+

[Client] -> [Leader] -> (AppendEntries) -> [Followers]
               |
               v (Jika Quorum tercapai)
         [Commit Index] -> [Apply Index] -> [State Machine]
```

## Kode Rust Production-Ready
```rust
use raft::{
    prelude::*,
    Config,
    storage::MemStorage,
};
use slog::{Logger, Drain, o};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;

/// State machine sederhana (Key-Value Store)
#[derive(Default, Clone)]
pub struct KvStateMachine {
    store: HashMap<String, String>,
}

impl KvStateMachine {
    pub fn apply(&mut self, key: String, value: String) {
        self.store.insert(key, value);
    }
    
    pub fn get(&self, key: &str) -> Option<String> {
        self.store.get(key).cloned()
    }
}

pub struct RaftNode {
    pub raw_node: RawNode<MemStorage>,
    pub state_machine: Arc<Mutex<KvStateMachine>>,
}

impl RaftNode {
    pub fn new(id: u64, peers: Vec<u64>, logger: Logger) -> Self {
        let config = Config {
            id,
            election_tick: 10,
            heartbeat_tick: 3,
            max_size_per_msg: 1024 * 1024 * 1024,
            max_inflight_msgs: 256,
            applied: 0,
            ..Default::default()
        };
        config.validate().expect("Raft config is invalid");

        let storage = MemStorage::new();
        // Inisialisasi peer (hanya dilakukan di node awal)
        let mut snapshot = Snapshot::default();
        snapshot.mut_metadata().index = 1;
        snapshot.mut_metadata().term = 1;
        snapshot.mut_metadata().mut_conf_state().voters = peers;
        storage.wl().apply_snapshot(snapshot).unwrap();

        let raw_node = RawNode::new(&config, storage, &logger).unwrap();
        let state_machine = Arc::new(Mutex::new(KvStateMachine::default()));

        Self {
            raw_node,
            state_machine,
        }
    }

    pub fn tick(&mut self) {
        self.raw_node.tick();
    }

    pub fn process_ready(&mut self) {
        if !self.raw_node.has_ready() {
            return;
        }
        let mut ready = self.raw_node.ready();

        // 1. Simpan pesan ke storage (HardState, Entries)
        let store = self.raw_node.mut_store();
        store.wl().append(ready.entries());
        if let Some(hs) = ready.hs() {
            store.wl().set_hardstate(hs.clone());
        }

        // 2. Kirim pesan ke peer (diabaikan dalam contoh ini untuk kesederhanaan)
        // send_messages(ready.take_messages());

        // 3. Aplikasikan log yang sudah di-commit ke state machine
        if let Some(committed_entries) = ready.take_committed_entries() {
            for entry in committed_entries {
                if entry.get_data().is_empty() {
                    continue; // Log kosong biasanya dari leader election
                }
                
                // Parsing sederhana "KEY=VALUE"
                let data_str = String::from_utf8_lossy(entry.get_data());
                if let Some((k, v)) = data_str.split_once('=') {
                    let mut sm = self.state_machine.lock().unwrap();
                    sm.apply(k.to_string(), v.to_string());
                }
            }
        }

        // 4. Advance
        self.raw_node.advance(ready);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use slog::o;

    fn get_logger() -> Logger {
        let plain = slog_term::PlainSyncDecorator::new(std::io::stdout());
        Logger::root(slog_term::FullFormat::new(plain).build().fuse(), o!())
    }

    #[test]
    fn test_raft_node_init() {
        let logger = get_logger();
        let mut node = RaftNode::new(1, vec![1, 2, 3], logger);
        assert_eq!(node.raw_node.raft.id, 1);
        
        // Memastikan state machine bisa dimodifikasi
        node.state_machine.lock().unwrap().apply("test".into(), "value".into());
        assert_eq!(node.state_machine.lock().unwrap().get("test"), Some("value".to_string()));
    }
}
```

## Anti-Patterns
1. **Sync I/O di dalam thread `apply` State Machine**
   *Mengapa berbahaya:* Log yang di-commit harus diaplikasikan dengan sangat cepat. Melakukan I/O sinkron atau blocking akan menunda `apply_index` maju, menyebabkan penumpukan antrean memori, timeout dari leader, dan akhirnya kegagalan node (OOM atau dikeluarkan dari cluster).
2. **Mengabaikan idempotency saat re-apply log pasca restart**
   *Mengapa berbahaya:* Jika node *crash* setelah mengaplikasikan log ke state machine tapi sebelum sempat menyimpan snapshot `apply_index`, saat restart ia mungkin akan mengaplikasikan log yang sama. Jika state machine tidak deterministik atau non-idempotent (misal increment counter), data akan rusak.

## Edge Cases & Defensive Programming
- **Split Brain (Network Partition):**
  Raft secara inheren tahan terhadap *split brain* karena membutuhkan *majority quorum*. Namun, leader lama bisa saja mengira dirinya masih leader sebelum timeout heartbeat terdeteksi. Gunakan `CheckQuorum` untuk segera me-*step down* leader yang terisolasi.
- **Log Compaction & Snapshots:**
  Seiring berjalannya waktu, log Raft akan tumbuh tak terbatas. Terapkan log compaction secara berkala (misal tiap 100k entri) dengan memotong log dan menyimpan snapshot terbaru dari state machine ke disk. Pastikan operasi ini berjalan secara *asinkron*.
