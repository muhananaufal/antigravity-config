# Vector Clocks & CRDTs

## Konsep Utama
Dalam sistem master-less (DynamoDB-style, Riak), update data bisa terjadi secara konstan dan *concurrent* di berbagai node. Vector Clock melacak kausalitas kejadian (event ordering). CRDT (Conflict-free Replicated Data Type) melangkah lebih jauh: tipe data ini dapat dimanipulasi secara independen dan asinkron di node yang berbeda, lalu di-*merge* tanpa konflik secara deterministik.

## Arsitektur & Diagram Alur (ASCII)
```text
Node A (A:1) --------------> Node B (A:1, B:1)
  |                             |
  v (Write)                     v (Merge)
Node A (A:2) --------------> Node C (A:2, B:1, C:1)
```

## Kode Rust Production-Ready
```rust
use std::collections::HashMap;
use std::cmp::Ordering;

/// Vector Clock untuk mendeteksi kausalitas Update
#[derive(Clone, Debug, Default, PartialEq)]
pub struct VectorClock {
    clocks: HashMap<String, u64>,
}

impl VectorClock {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn increment(&mut self, node_id: &str) {
        let count = self.clocks.entry(node_id.to_string()).or_insert(0);
        *count += 1;
    }

    pub fn merge(&mut self, other: &VectorClock) {
        for (node_id, &clock_val) in &other.clocks {
            let my_val = self.clocks.entry(node_id.clone()).or_insert(0);
            *my_val = std::cmp::max(*my_val, clock_val);
        }
    }

    // Partial Ord implementation behavior
    pub fn compare(&self, other: &VectorClock) -> Option<Ordering> {
        let mut self_is_greater = false;
        let mut other_is_greater = false;

        let all_keys: std::collections::HashSet<_> = self.clocks.keys().chain(other.clocks.keys()).collect();

        for key in all_keys {
            let self_val = self.clocks.get(key).unwrap_or(&0);
            let other_val = other.clocks.get(key).unwrap_or(&0);

            if self_val > other_val {
                self_is_greater = true;
            } else if other_val > self_val {
                other_is_greater = true;
            }
        }

        match (self_is_greater, other_is_greater) {
            (true, false) => Some(Ordering::Greater),
            (false, true) => Some(Ordering::Less),
            (false, false) => Some(Ordering::Equal),
            (true, true) => None, // Concurrent (Conflict)
        }
    }
}

/// LWW (Last-Write-Wins) Register CRDT sederhana
#[derive(Clone, Debug)]
pub struct LWWRegister<T> {
    value: T,
    timestamp: i64, // Physical Time (Sebaiknya HLC)
    node_id: String,
}

impl<T: Clone> LWWRegister<T> {
    pub fn new(value: T, timestamp: i64, node_id: String) -> Self {
        Self { value, timestamp, node_id }
    }

    pub fn get(&self) -> T {
        self.value.clone()
    }

    pub fn merge(&mut self, other: &Self) {
        if other.timestamp > self.timestamp 
            || (other.timestamp == self.timestamp && other.node_id > self.node_id) {
            self.value = other.value.clone();
            self.timestamp = other.timestamp;
            self.node_id = other.node_id.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vector_clock_causality() {
        let mut v1 = VectorClock::new();
        v1.increment("A");

        let mut v2 = v1.clone();
        v2.increment("B"); // B melihat A

        let mut v3 = VectorClock::new();
        v3.increment("C"); // C independen, concurrent dengan A dan B

        assert_eq!(v1.compare(&v2), Some(Ordering::Less));
        assert_eq!(v2.compare(&v1), Some(Ordering::Greater));
        assert_eq!(v2.compare(&v3), None); // Concurrent!
        
        v2.merge(&v3);
        assert_eq!(v2.compare(&v3), Some(Ordering::Greater)); // Setelah merge, v2 causal terhadap v3
    }
}
```

## Anti-Patterns
1. **Tidak membatasi ukuran (Unbounded) Vector Clock**
   *Mengapa berbahaya:* Jika client ID dinamis dimasukkan sebagai identifier vector clock per operasi (misalnya ID session user), ukuran Hash Map dari Vector Clock akan tumbuh tanpa batas. Akibatnya, payload meta-data jauh melebihi ukuran data itu sendiri dan menyebabkan OOM. Identitas harus dibatasi pada ranah Node ID server.
2. **Menggunakan Local NTP Timestamp murni untuk Last-Write-Wins**
   *Mengapa berbahaya:* "Clock Drift" di mana server A 5 milidetik lebih cepat dari server B. Data valid dari server B bisa ditimpa (dihapus diam-diam) oleh data basi dari server A karena dianggap "lebih baru". Gunakan Hybrid Logical Clock (HLC) yang menggabungkan waktu fisik dengan *logical counter*.

## Edge Cases & Defensive Programming
- **Identical Concurrent Updates (Ties):**
  Dalam tipe LWW-Register, sering kali terjadi `timestamp` yang benar-benar persis sama. Selalu terapkan mekanisme `tie-breaker` deterministik fallback, misalnya melakukan perbandingan leksikografis pada `Node ID` (`other.node_id > self.node_id`), agar hasil merge *commutative*.
- **Tombstone di OR-Set (Observed-Removed Set):**
  Dalam Set CRDT, menghapus elemen berarti menambahkan entri "Tombstone". Hal ini membuat data secara monolitik membesar (tidak pernah benar-benar terhapus). Diperlukan mekanisme "Garbage Collection" berbasis epoch/vector clock pruning saat semua node dikonfirmasi telah melihat penghapusan.
