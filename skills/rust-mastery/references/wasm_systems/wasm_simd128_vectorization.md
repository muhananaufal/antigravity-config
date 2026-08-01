# WebAssembly SIMD128 Vectorization di Rust

## Konsep Utama & Arsitektur
WebAssembly Single Instruction Multiple Data (WASM SIMD128) memungkinkan pengeksekusian instruksi yang memproses beberapa elemen data sekaligus dalam register 128-bit (misalnya: 4x 32-bit float, atau 16x 8-bit integer) dalam satu putaran clock (cycle). Di lingkungan browser modern (V8, SpiderMonkey) atau runtime WASM mandiri (Wasmtime), SIMD sangat krusial untuk rendering grafis, physics engine, kriptografi, dan pemrosesan audio/video in-browser.

Rust menyediakan akses ke intrinsik WASM SIMD melalui `core::arch::wasm32`. Menggunakan SIMD di Rust menghasilkan output `.wasm` yang sangat optimal tanpa overhead panggilan FFI ke JavaScript.

### Diagram Arsitektur: 4x Float32 SIMD Vectorization
```text
  [Array Input A]            [Array Input B]
 [A0, A1, A2, A3]           [B0, B1, B2, B3]
        |                          |
        v                          v
[v128 Register: A]         [v128 Register: B]
        |                          |
        +------- (f32x4.add) ------+
                 |
                 v
[v128 Register: Result (A0+B0, A1+B1, ...)]
                 |
                 v
          [Array Output]
```

## Kode Produksi Rust WASM SIMD
Di bawah ini adalah kode produksi yang memproses penjumlahan array dari titik 3D atau kalkulasi warna piksel dengan aman, memanfaatkan instruksi `f32x4`.

```rust
#[cfg(target_arch = "wasm32")]
use core::arch::wasm32::*;
use std::slice;

/// Menambahkan dua array f32 besar dengan SIMD 128-bit (4x f32 sekaligus).
/// Parameter `a`, `b`, dan `out` diasumsikan memiliki ukuran yang tepat sama.
#[cfg(target_arch = "wasm32")]
pub fn vector_add_simd(a: &[f32], b: &[f32], out: &mut [f32]) {
    assert_eq!(a.len(), b.len(), "Array lengths must match");
    assert_eq!(a.len(), out.len(), "Output length must match inputs");

    let len = a.len();
    let mut i = 0;

    // Proses 4 elemen f32 sekaligus dengan register v128
    while i + 4 <= len {
        unsafe {
            // Load 128-bit blocks dari memory
            let va = v128_load(a.as_ptr().add(i) as *const v128);
            let vb = v128_load(b.as_ptr().add(i) as *const v128);
            
            // Tambahkan f32x4
            let v_res = f32x4_add(va, vb);
            
            // Simpan kembali 128-bit block ke output memory
            v128_store(out.as_mut_ptr().add(i) as *mut v128, v_res);
        }
        i += 4;
    }

    // Tangani sisa elemen (tail elements) yang tidak habis dibagi 4
    while i < len {
        out[i] = a[i] + b[i];
        i += 1;
    }
}

// Fallback untuk non-WASM targets (untuk local testing host OS)
#[cfg(not(target_arch = "wasm32"))]
pub fn vector_add_simd(a: &[f32], b: &[f32], out: &mut [f32]) {
    assert_eq!(a.len(), b.len());
    assert_eq!(a.len(), out.len());
    for i in 0..a.len() {
        out[i] = a[i] + b[i];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vector_add_simd() {
        let a = [1.0, 2.0, 3.0, 4.0, 5.0];
        let b = [10.0, 20.0, 30.0, 40.0, 50.0];
        let mut out = [0.0; 5];
        
        vector_add_simd(&a, &b, &mut out);
        
        assert_eq!(out, [11.0, 22.0, 33.0, 44.0, 55.0]);
    }
}
```

## Anti-Patterns

### 1. Hardcoding Load Tanpa Boundary Check / Tail Handling
**Penjelasan:** Memaksa loop melompat sebanyak 4 elemen (contoh: `(0..len).step_by(4)`) tanpa memedulikan sisa dari sisa pembagian array modulo 4.
**Bahaya:** Jika array `a` panjangnya 15 (sisa 3), memuat `v128_load` dari ujung array akan menyentuh out-of-bounds memory. Pada Wasm, ini menyebabkan `Memory access out of bounds` trap dan langsung mematikan modul (fatal crash).

### 2. Kehilangan Aligment Optimization
**Penjelasan:** Melempar pointer tidak selaras (unaligned pointers) tanpa menggunakan intrinsik yang aman. Meski wasm32 tidak se-strict x86_64 terkait alignment fault, performa bisa drop parah (cache-line split) di V8 engine jika memori tidak di-align (misalnya ke kelipatan 16 byte untuk `v128`).
**Bahaya:** Botleneck CPU tak terlihat pada lingkungan browser production akibat unaligned load stall. Gunakan struktur data ber-alignment benar, atau alokasikan dengan `std::alloc::alloc` dengan layout `16` byte.

## Edge Cases & Defensive Programming

1. **Feature-Flag Compiler Requirements**:
   Instruksi SIMD tidak akan terkompilasi kecuali flag LLVM diaktifkan. Anda HARUS meng-compile modul Rust dengan `RUSTFLAGS="-C target-feature=+simd128"`. Jika tidak, `core::arch::wasm32` modul tidak akan tersedia atau error di tingkat LLVM.
2. **Handling `NaN` dan Denormals dalam SIMD Math**:
   Float di WASM SIMD f32x4 mematuhi IEEE-754. Jika salah satu angka adalah `NaN`, hasilnya `NaN`. Berbeda dengan CPU spesifik tertentu (seperti DAZ/FTZ pada SSE), Wasm SIMD tidak menge-flush denormals ke nol secara otomatis secara default, sehingga operasi kalkulasi pada angka mendekati nol absolut bisa sangat lambat (microcode stalls).
3. **Peringatan Pointers `as *const v128` dari Tipe Lain**:
   Menge-cast langsung slice `&[f32]` ke `*const v128` sah di unsafe Rust, namun perhatikan strict aliasing. Jika Anda mentransmutasikan pointer bolak-balik antara tipe, perhatikan tata letak endianness (Wasm itu always Little-Endian, dan SIMD lanes dievaluasi secara Little-Endian).
