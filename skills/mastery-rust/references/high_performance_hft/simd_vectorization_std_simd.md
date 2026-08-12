# SIMD Vectorization & `std::simd`

Single Instruction, Multiple Data (SIMD) adalah fitur esensial pada arsitektur prosesor modern (seperti AVX-512 di x86_64 atau NEON di ARM) yang memungkinkan eksekusi matematika paralel terhadap *vector* memori pada satu siklus jam (clock cycle). Di High-Frequency Trading (HFT) dan analisis kuantitatif, menggunakan SIMD dapat melipatgandakan throughput pemrosesan data hingga 4x, 8x, atau bahkan 16x lipat.

Rust menawarkan Portable SIMD (`std::simd`) di versi nightly yang menyediakan abstraksi cross-platform yang indah, tanpa harus merangkai kode assembly atau *vendor-specific intrinsics* (`std::arch`) yang sulit dikelola.

## Arsitektur Eksekusi SIMD

```ascii
[ Scalar Execution ] (Non-SIMD)
+-------+       +-------+
| Reg A |   +   | Reg B | = [ Add Operation ] = +-------+
+-------+       +-------+                       | Res C |
  (1x)            (1x)                          +-------+

[ SIMD Execution ] (AVX256 / 8x f32)
+-------+-------+-------+-------+-------+-------+-------+-------+
|  A0   |  A1   |  A2   |  A3   |  A4   |  A5   |  A6   |  A7   | Vector Reg A (YMM)
+-------+-------+-------+-------+-------+-------+-------+-------+
    +       +       +       +       +       +       +       +
+-------+-------+-------+-------+-------+-------+-------+-------+
|  B0   |  B1   |  B2   |  B3   |  B4   |  B5   |  B6   |  B7   | Vector Reg B (YMM)
+-------+-------+-------+-------+-------+-------+-------+-------+
  [ 8 Paralel Additions dalam 1 CPU Cycle! ]
    =       =       =       =       =       =       =       =
+-------+-------+-------+-------+-------+-------+-------+-------+
|  C0   |  C1   |  C2   |  C3   |  C4   |  C5   |  C6   |  C7   | Vector Reg C (YMM)
+-------+-------+-------+-------+-------+-------+-------+-------+
```

## Produksi-Ready Code: Moving Average Cepat menggunakan `std::simd`

Untuk kompilasi program ini di Production, kita butuh fitur `portable_simd`.

```rust
#![feature(portable_simd)]

use std::simd::prelude::*;

/// Menghitung dot product dari dua buah slice (misalnya weights dan features)
/// Menggunakan SIMD (f32x8 = 256 bit vector register AVX2).
/// Meng-handle elemen-elemen di bagian ekor (scalar fallback) yang sisa pembagian 8.
#[inline(always)]
pub fn dot_product_simd(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len(), "Slice dimensions must match");
    
    // Tipe vector untuk 8 elemen f32 sekaligus
    const LANES: usize = 8;
    type SimdVector = f32x8;
    
    let mut sum_vec = SimdVector::splat(0.0);
    
    // 1. Eksekusi loop ter-vectorisasi (chunks of 8)
    let chunks_a = a.chunks_exact(LANES);
    let chunks_b = b.chunks_exact(LANES);
    
    let remainder_a = chunks_a.remainder();
    let remainder_b = chunks_b.remainder();

    for (chunk_a, chunk_b) in chunks_a.zip(chunks_b) {
        // SAFETY: Panjang chunk dipastikan oleh chunks_exact
        let va = SimdVector::from_slice(chunk_a);
        let vb = SimdVector::from_slice(chunk_b);
        
        // Fused Multiply-Add (FMA) sering kali digunakan oleh kompilator
        sum_vec += va * vb;
    }
    
    // Menjumlahkan register vector menjadi 1 nilai skalar (horizontal reduction)
    let mut total = sum_vec.reduce_sum();
    
    // 2. Eksekusi fallback skalar untuk sisa elemen yang tidak muat di register (tail)
    for (rem_a, rem_b) in remainder_a.iter().zip(remainder_b.iter()) {
        total += rem_a * rem_b;
    }
    
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dot_product_simd_exact() {
        // Tepat 8 elemen
        let a = vec![1.0, 2.0, 3.0, 4.0, 1.0, 2.0, 3.0, 4.0];
        let b = vec![2.0, 2.0, 2.0, 2.0, 3.0, 3.0, 3.0, 3.0];
        // Sum: (1*2 + 2*2 + 3*2 + 4*2) + (1*3 + 2*3 + 3*3 + 4*3)
        // = (2 + 4 + 6 + 8) + (3 + 6 + 9 + 12) = 20 + 30 = 50.0
        assert_eq!(dot_product_simd(&a, &b), 50.0);
    }
    
    #[test]
    fn test_dot_product_simd_with_tail() {
        // 11 elemen (8 elemen SIMD, 3 elemen scalar)
        let a = vec![1.0; 11];
        let b = vec![2.0; 11];
        assert_eq!(dot_product_simd(&a, &b), 22.0);
    }
}
```

## Anti-Patterns

1. **Loop Autovectorization tanpa `target-cpu=native`**
   **Mengapa berbahaya:** Jika Anda menulis kode map/reduce skalar di Rust dan berharap LLVM melakukan auto-vectorization, LLVM *hanya* akan mengompilasi set instruksi yang kompatibel dengan standar dasar (misal SSE2) secara default. Instruksi AVX/AVX512 Anda diabaikan karena kompilator butuh target arsitektur yang pasti.
   **Solusi:** Harus men-set flag `RUSTFLAGS="-C target-cpu=native"` atau fitur intrinsik secara eksplisit.
   
2. **Kondisional `if` di dalam iterasi vektor**
   **Mengapa berbahaya:** SIMD dirancang untuk mengeksekusi operasi yang sama pada semua data secara linear. Menaruh blok `if/else` akan menggagalkan register load karena tidak ada instruksi CPU untuk "Tambahkan A+B, tapi hanya jika B>0 pada satu lane tertentu" tanpa manipulasi bitwise masking rumit. Kompilator akan menolak melakukana auto-vectorisasi.

## Edge Cases dan Defensive Programming

1. **Memory Alignment Fault (Segfault di Intrinsics):**
   Fungsi load SIMD tertentu mensyaratkan pointer memori sejajar (aligned) pada batas memori yang ketat (misal 32-byte atau 64-byte untuk AVX512). Menggunakan `std::arch::x86_64::_mm256_load_ps` pada slice yang tidak di-align akan memicu Segmentation Fault langsung (SIGSEGV). Portable SIMD di Rust menangani masalah ini lewat `.from_slice()`, tetapi menyalin secara laten memori (unaligned loads sering sedikit lebih lambat di CPU lama).

2. **Pengurangan Float Horizontal (NaN Propagation):**
   Saat kita melakukan `sum_vec.reduce_sum()`, jika satu register lane memiliki nilai `NaN`, maka `NaN` ini akan merusak seluruh penjumlahan menjadi `NaN`. Validasi pipeline data sebelumnya atau gunakan fallback aman jika berurusan dengan data eksternal kotor.

3. **CPU Throttling di AVX-512:**
   Di banyak arsitektur x86 Intel, jika vektor 512-bit (AVX-512) ditarik dalam loop secara berat, CPU merendahkan frekuensi clock-nya (downclocking) untuk mengurangi konsumsi listrik dan suhu. Sering kali, kode AVX-256 berjalan lebih *cepat* daripada AVX-512 secara keseluruhan di dalam aplikasi server campuran karena terhindar dari frekuensi throttling ini.
