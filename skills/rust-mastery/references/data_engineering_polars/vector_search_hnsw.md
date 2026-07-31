# Vector Search & HNSW in Rust

## Konsep Utama
HNSW (Hierarchical Navigable Small World) adalah algoritma state-of-the-art untuk Approximate Nearest Neighbor (ANN) search dalam Vector Database. HNSW merepresentasikan data embeddings ML sebagai graph multilapis. Di Rust, integrasi yang lazim digunakan (selain build mandiri, misalnya Qdrant/Milvus core) adalah memanggil engine super-cepat seperti `usearch` (melalui FFI) untuk komputasi Cosine Similarity atau Euclidean (L2) yang diakselerasi via SIMD (AVX512/NEON).

## Arsitektur & Flow
```text
Layer 2:         [ A ] ------------------------> [ E ]
                   |                               |
Layer 1:     [ A ] -- [ B ] -----------------> [ E ]
               |        |                        |
Layer 0: [ A ] -- [ B ] -- [ C ] -- [ D ] -- [ E ]

Search Query -> Entry Point (L2) -> greedy routing ke E -> Drop ke L1 -> routing -> L0 (Nearest neighbors!)
```

## Production-Ready Code
*(Diasumsikan menggunakan Crate ekosistem ringan `hnsw_rs` atau simulasi struktur dasar untuk HNSW usage pattern)*

```rust
use std::sync::Arc;
// Simulasi library `hnsw_rs` atau bindings `usearch`
// struct Hnsw<T, Dist>...

/// Metric jarak: Euclidean (L2 Squared)
pub fn l2_squared(v1: &[f32], v2: &[f32]) -> f32 {
    debug_assert_eq!(v1.len(), v2.len());
    // Auto-vectorized oleh compiler dengan RUSTFLAGS="-C target-feature=+avx2"
    v1.iter()
      .zip(v2.iter())
      .map(|(a, b)| {
          let diff = a - b;
          diff * diff
      })
      .sum()
}

/// Metric jarak: Cosine Similarity Distance ( 1.0 - Cosine Similarity )
pub fn cosine_distance(v1: &[f32], v2: &[f32]) -> f32 {
    let mut dot = 0.0;
    let mut norm1 = 0.0;
    let mut norm2 = 0.0;
    
    for (a, b) in v1.iter().zip(v2.iter()) {
        dot += a * b;
        norm1 += a * a;
        norm2 += b * b;
    }
    
    if norm1 == 0.0 || norm2 == 0.0 {
        return 1.0; 
    }
    
    1.0 - (dot / (norm1.sqrt() * norm2.sqrt()))
}

// Simulasi Graph Insert/Search Wrapper
pub struct VectorIndexer {
    dim: usize,
    data: Vec<Vec<f32>>, // Menyimpan raw vektor (Pada production: Memory-mapped mmap)
}

impl VectorIndexer {
    pub fn new(dim: usize) -> Self {
        Self { dim, data: Vec::new() }
    }
    
    pub fn add_vector(&mut self, vec: Vec<f32>) -> usize {
        assert_eq!(vec.len(), self.dim);
        self.data.push(vec);
        self.data.len() - 1 // Return ID index
    }
    
    pub fn search_naive_top1(&self, query: &[f32]) -> Option<(usize, f32)> {
        let mut best_dist = f32::MAX;
        let mut best_idx = None;
        
        for (i, v) in self.data.iter().enumerate() {
            let d = l2_squared(query, v);
            if d < best_dist {
                best_dist = d;
                best_idx = Some(i);
            }
        }
        
        best_idx.map(|idx| (idx, best_dist))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cosine() {
        let v1 = vec![1.0, 0.0, 0.0];
        let v2 = vec![1.0, 0.0, 0.0];
        let v3 = vec![0.0, 1.0, 0.0];
        
        assert!(cosine_distance(&v1, &v2) < 1e-6); // identik
        assert!((cosine_distance(&v1, &v3) - 1.0).abs() < 1e-6); // tegak lurus
    }
    
    #[test]
    fn test_naive_indexer() {
        let mut idx = VectorIndexer::new(2);
        idx.add_vector(vec![0.0, 0.0]); // ID 0
        idx.add_vector(vec![10.0, 10.0]); // ID 1
        
        let (id, dist) = idx.search_naive_top1(&[1.0, 1.0]).unwrap();
        assert_eq!(id, 0);
    }
}
```

## Anti-Patterns

1. **Jarak Tanpa Normalisasi (Pada Cosine)**
   - *Mengapa berbahaya:* Dot product sering diasumsikan sebagai cosine similarity jika vektor sudah dinormalisasi (panjang/magnitude = 1.0). Jika tidak dinormalisasi sebelumnya, dot product berpotensi membengkak ke infinity atau error.
   - *Solusi:* Pre-normalize semua embeddings AI/ML Anda pada layer ingestion dengan `L2 Normalization` (membagi dengan length vector) agar saat query kita hanya perlu melakukan dot_product cepat daripada formula *cosine* yang menggunakan `sqrt()` mahal.

2. **Tradeoff Recall vs Latency (M Parameter HNSW)**
   - *Mengapa berbahaya:* Menggunakan nilai Edge Max HNSW (`M`) dan `ef_construction` yang terlalu besar memang akan memastikan Recall (akurasi) mendekati 100%, tapi waktu pembuatan index (build time) melambat drastis (N log N) dan memori membengkak.
   - *Solusi:* Konfigurasi default umumnya M=16 hingga 64, ef=100-200. Tolerir kehilangan ~2% recall demi 50x kecepatan.

## Edge Cases & Defensive Programming
- **NaN / Infinity Embeddings:** Jika model ML pipeline crash dan mengirimkan NaN float vektor, fungsi math distance akan return NaN dan merusak logika sorting min-heap di HNSW traversal, membuat seluruh index corrupt. Validasi vector float bebas NaN sebelum disimpan.
- **Cache Locality:** Vektor yang bersebelahan di Graph harus idealnya diletakkan berdekatan dalam RAM. Akses random (pointer chasing) ke alokasi raw `Vec<Box<[f32]>>` akan memicu Cache Misses ekstrim. Gunakan allocator memori kontigu (`Vec<f32>` datar + stride) dan `mmap` backing file.
