# WebAssembly SIMD128 Vectorization

## Konsep Utama
WebAssembly memiliki ekstensi SIMD 128-bit tetap yang didukung secara natif oleh engine browser (V8, SpiderMonkey) dan runtime (Wasmtime, Wasmer). Di Rust, ini diakses menggunakan intrinsics di `core::arch::wasm32::*` yang mengekspos tipe `v128`. Ini memungkinkan kita memproses 16 bytes (atau 4 floats) sekaligus, mempercepat algoritma grafis, matematika, dan kriptografi di lingkungan Wasm.

## Arsitektur & Flow
```text
[ Data Array (f32) ] = [ A0, A1, A2, A3, A4, A5 ... ]
                         \___  ___/
                             \/
[ SIMD Load (v128) ] ----> [ A0, A1, A2, A3 ]
                                +
[ SIMD Load (v128) ] ----> [ B0, B1, B2, B3 ]
                                =
[ SIMD Add (v128) ]  ----> [ A0+B0, A1+B1, A2+B2, A3+B3 ] ---> [ SIMD Store ]
```

## Production-Ready Code
```rust
#[cfg(target_arch = "wasm32")]
use core::arch::wasm32::*;

/// Menambahkan dua array float (A + B) dengan kecepatan tinggi menggunakan SIMD 128.
/// Data diproses dalam chunk berukuran 4 float (128 bit = 16 byte).
pub fn simd_add_arrays(a: &[f32], b: &[f32], out: &mut [f32]) {
    assert_eq!(a.len(), b.len());
    assert_eq!(a.len(), out.len());

    let mut i = 0;
    let chunks = a.len() / 4; // Berapa banyak v128 yang bisa dibentuk

    #[cfg(target_arch = "wasm32")]
    unsafe {
        while i < chunks * 4 {
            // Load 4 elemen f32 (128 bits) dari memori ke dalam register SIMD
            let vec_a = v128_load(a.as_ptr().add(i) as *const v128);
            let vec_b = v128_load(b.as_ptr().add(i) as *const v128);
            
            // Lakukan penjumlahan paralel: [a0+b0, a1+b1, a2+b2, a3+b3]
            let vec_result = f32x4_add(vec_a, vec_b);
            
            // Simpan kembali 128 bit dari register ke memori output
            v128_store(out.as_mut_ptr().add(i) as *mut v128, vec_result);
            
            i += 4;
        }
    }

    // Tangani sisa elemen (tail) yang tidak genap kelipatan 4
    while i < a.len() {
        out[i] = a[i] + b[i];
        i += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simd_add() {
        let a = vec![1.0, 2.0, 3.0, 4.0, 5.0];
        let b = vec![5.0, 4.0, 3.0, 2.0, 1.0];
        let mut out = vec![0.0; 5];
        
        simd_add_arrays(&a, &b, &mut out);
        
        assert_eq!(out, vec![6.0, 6.0, 6.0, 6.0, 6.0]);
    }
}
```

## Anti-Patterns

1. **Lupa Memeriksa Target CPU Flag**
   - *Mengapa berbahaya:* Instruksi Wasm SIMD tidak didukung di engine lama atau target Wasm lawas. Meng-compile tanpa `-C target-feature=+simd128` (dideklarasikan via `.cargo/config.toml` atau `RUSTFLAGS`) akan gagal.
   - *Solusi:* Gunakan cfg gates `#[cfg(target_feature = "simd128")]` jika memungkinkan fitur fallback ke non-SIMD untuk kompatibilitas ke belakang.

2. **Unaligned Memory Access via Pointer Raw**
   - *Mengapa berbahaya:* Meskipun instruksi memori v128 Wasm mentolerir unaligned load, overhead-nya sangat parah. Terlebih, cast dari `*const f32` ke `*const v128` dengan offset manual rentan error `unreachable` jika panjang tidak dicek.
   - *Solusi:* Proses selalu berdasarkan kelipatan batch ukuran SIMD (chunks_exact) sebelum masuk ke pointer loading.

## Edge Cases & Defensive Programming
- **Tail Processing:** Seperti pada kode di atas, pastikan Anda menulis logika serial untuk memproses elemen sisa (tail) ketika panjang iterasi tidak habis dibagi kelipatan elemen vektor (misalnya sisa pembagian 4). Jika tidak, akan terjadi memory corruption atau panic.
- **Portability:** Jika kode di-build untuk target native (non-Wasm), `core::arch::wasm32` tidak tersedia. Gunakan abstrasi auto-vectorization dari compiler Rust atau crate `std::simd` (portable SIMD) jika ingin share logic.
