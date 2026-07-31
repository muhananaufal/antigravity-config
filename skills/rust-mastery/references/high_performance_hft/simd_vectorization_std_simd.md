# SIMD Vectorization dengan `std::simd`

## Konsep Utama dan Penggunaan
Single Instruction, Multiple Data (SIMD) adalah teknik arsitektur CPU untuk mengeksekusi operasi yang sama pada beberapa titik data secara bersamaan. Rust mendukung SIMD portabel melalui modul `std::simd` (saat ini di *nightly*), yang memberikan abstraksi tingkat tinggi di atas instruksi spesifik hardware seperti AVX2, AVX-512, atau NEON.

Dalam High-Frequency Trading (HFT) dan Machine Learning, `std::simd` digunakan untuk kalkulasi matematis intensif seperti menghitung *dot product* untuk sinyal inferensi, pemrosesan log matriks harga, atau agregasi tick data tanpa bergantung pada *loop unrolling* manual atau auto-vectorization compiler yang tidak dapat diprediksi.

## Arsitektur SIMD Lanes
```text
Scalar (Normal) Processing:
[ a1 ] + [ b1 ] = [ c1 ]   (1 clock cycle)
[ a2 ] + [ b2 ] = [ c2 ]   (1 clock cycle)
[ a3 ] + [ b3 ] = [ c3 ]   (1 clock cycle)
[ a4 ] + [ b4 ] = [ c4 ]   (1 clock cycle)

SIMD (Vectorized) Processing (f32x4):
[ a1, a2, a3, a4 ] 
        +          = [ c1, c2, c3, c4 ] (1 clock cycle)
[ b1, b2, b3, b4 ]
```

## Kode Production-Ready: SIMD Dot Product
```rust
#![feature(portable_simd)]

use std::simd::prelude::*;
use std::simd::{f32x8, SimdFloat};

/// Menghitung dot product dari dua slice `f32` menggunakan SIMD f32x8.
/// Slice tidak harus berukuran kelipatan 8, fungsi ini akan menangani sisa elemen.
pub fn simd_dot_product(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len(), "Slices must have equal length for dot product");

    let mut sum = f32x8::splat(0.0);
    let chunks_a = a.chunks_exact(8);
    let chunks_b = b.chunks_exact(8);
    let remainder_a = chunks_a.remainder();
    let remainder_b = chunks_b.remainder();

    for (chunk_a, chunk_b) in chunks_a.zip(chunks_b) {
        // Menggunakan from_slice untuk memuat data ke dalam vector register
        let vec_a = f32x8::from_slice(chunk_a);
        let vec_b = f32x8::from_slice(chunk_b);
        sum += vec_a * vec_b;
    }

    // Horizontal reduction: menjumlahkan semua elemen (lanes) di dalam vektor `sum`
    let mut total = sum.reduce_sum();

    // Proses sisa elemen secara skalar
    for i in 0..remainder_a.len() {
        total += remainder_a[i] * remainder_b[i];
    }

    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simd_dot_product() {
        let a = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0];
        let b = vec![1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
        // Sum(1..9) = 45
        assert_eq!(simd_dot_product(&a, &b), 45.0);
    }
    
    #[test]
    #[should_panic(expected = "Slices must have equal length")]
    fn test_simd_dot_product_panic() {
        let a = vec![1.0, 2.0];
        let b = vec![1.0];
        simd_dot_product(&a, &b);
    }
}
```

## Anti-Patterns

1. **Mengasumsikan Data Selalu Ter-align**
   - *Bahaya*: Memuat dari alamat memori yang tidak memiliki alignment yang benar (misalnya `_mm256_load_ps` pada unaligned memory) pada beberapa arsitektur dapat menyebabkan `SIGSEGV`.
   - *Solusi*: Gunakan safe abstractions seperti `from_slice` atau pastikan alignment manual (`align_to::<f32x8>()`).

2. **SIMD pada Data Kecil tanpa Memperhitungkan Overhead**
   - *Bahaya*: Menggunakan instruksi SIMD untuk array dengan ukuran < 16 elemen bisa lebih lambat daripada operasi skalar karena overhead pergerakan data dari/ke register vektor.
   - *Solusi*: Selalu profiling. Fallback ke operasi skalar jika ukuran data sangat kecil.

## Edge Cases & Defensive Engineering
- **Floating-Point Non-Determinism (NaN & Infinity):** Ketika melakukan *horizontal reduction*, urutan operasi secara matematis mengubah hasil akumulasi float yang berpotensi memiliki error *precision* atau NaN *propagation*.
- **Runtime CPU Feature Detection:** Portable SIMD di Rust mencoba meng-abstraksi ini, namun jika mengandalkan *intrinsics* spesifik (`core::arch::x86_64`), Anda harus membungkus inisialisasi menggunakan `is_x86_feature_detected!("avx2")` sebelum mengeksekusi instruksi tertentu untuk menghindari *Illegal Instruction* crash pada CPU lawas.
