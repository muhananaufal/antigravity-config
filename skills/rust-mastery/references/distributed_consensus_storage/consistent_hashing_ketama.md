# Consistent Hashing & Ketama

## Konsep Utama
Dalam caching (Memcached, Redis) atau partisi data Dynamo-style, menambahkan atau menghapus server akan mengacaukan skema partisi klasik (`hash(key) % N`). Consistent hashing menyelesaikan ini dengan memetakan node dan kunci ke sebuah "Ring" (misal modulo `2^32`). Algoritma Ketama menyebarkan virtual nodes di sekitar ring untuk memastikan distribusi data yang merata dan mereduksi pergerakan data minimal menjadi `1/N` jika node mati.

## Arsitektur & Diagram Alur (ASCII)
```text
           [Virtual Node B2]
         /                   \
[Node A1]                     [Key X] --> (Mapped to B1)
    |                           |
[Key Y]                       [Node C1]
    \                       /
      [Virtual Node B1] --- 
```

## Kode Rust Production-Ready
```rust
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::collections::hash_map::DefaultHasher;

#[derive(Clone)]
pub struct HashRing {
    /// Peta dari Posisi Hash -> Node Name
    ring: BTreeMap<u64, String>,
    replicas: usize,
}

impl HashRing {
    pub fn new(replicas: usize) -> Self {
        Self {
            ring: BTreeMap::new(),
            replicas,
        }
    }

    fn hash<T: Hash>(key: &T) -> u64 {
        let mut hasher = DefaultHasher::new();
        key.hash(&mut hasher);
        hasher.finish()
    }

    pub fn add_node(&mut self, node: &str) {
        for i in 0..self.replicas {
            let vnode_key = format!("{}#{}", node, i);
            let position = Self::hash(&vnode_key);
            self.ring.insert(position, node.to_string());
        }
    }

    pub fn remove_node(&mut self, node: &str) {
        for i in 0..self.replicas {
            let vnode_key = format!("{}#{}", node, i);
            let position = Self::hash(&vnode_key);
            self.ring.remove(&position);
        }
    }

    pub fn get_node(&self, key: &str) -> Option<String> {
        if self.ring.is_empty() {
            return None;
        }

        let hash_pos = Self::hash(&key);
        
        // Cari node yang posisinya >= hash kunci. (Searah jarum jam)
        if let Some((_, node)) = self.ring.range(hash_pos..).next() {
            Some(node.clone())
        } else {
            // Wraparound ke awal ring
            self.ring.values().next().cloned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_ring_distribution() {
        let mut ring = HashRing::new(100); // 100 vnodes per node
        ring.add_node("redis-1");
        ring.add_node("redis-2");
        ring.add_node("redis-3");

        let target = ring.get_node("session:12345");
        assert!(target.is_some());
        
        // Memastikan distribusi tetap stabil
        assert_eq!(ring.get_node("session:12345"), target);

        // Jika redis-3 down, hash untuk kunci yang jatuh ke sana akan dialihkan,
        // tapi kunci di redis-1 dan redis-2 sebagian besar tidak berubah.
        ring.remove_node("redis-3");
        let new_target = ring.get_node("session:12345");
        assert!(new_target.is_some());
    }
}
```

## Anti-Patterns
1. **Virtual Node Count (Replicas) terlalu kecil (Misal: 3)**
   *Mengapa berbahaya:* Node tidak akan tersebar merata di sepanjang rentang Hash Ring. Akibatnya, saat satu server ditambahkan, "Data Hotspotting" akan terjadi dimana satu server menerima 80% beban trafik sementara yang lain nyaris kosong. Rekomendasi di production adalah 100-250 vnodes per node fisik.
2. **Standard Hashing saat degradasi node**
   *Mengapa berbahaya:* Apabila Anda fallback ke `hash(key) % N_terbaru` saat satu node mati, seluruh penempatan data akan berubah (*Thundering Herd cache invalidation*). Ini akan meledakkan database relasional backend seketika (karena cache miss global). Wajib gunakan *Consistent Hashing*.

## Edge Cases & Defensive Programming
- **Flapping Node & Cascading Failures:**
  Jika node A mengalami CPU overload lambat merespons health check, sistem akan me-remove node A dari Ring, mengalihkan semua bebannya ke node B dan C. Karena spike beban tak terduga, node B dan C mati (OOM). Terapkan perlindungan berupa *Ring Freeze* atau *Rate Limiting Rebalancing* agar evakuasi data tidak meruntuhkan cluster.
- **Weighted Nodes:**
  Tidak semua server fisik memiliki memori/CPU yang identik. `HashRing` yang robust (seperti di C Ketama asli) memungkinkan *weighting* untuk menambah replikator proporsional per-node (misal: mesin 64GB mendapat 200 vnode, mesin 16GB mendapat 50 vnode).
