# Cargo-Asm & Disassembly di Rust

## Deskripsi Konsep
Menulis kode high-performance tidak lepas dari inspeksi atas hasil kompilasi tingkat rendah. Tooling ekosistem seperti `cargo-asm` (atau `cargo-show-asm`) memungkinkan engineer mengamati (disassemble) kode assembly (biasanya x86_64, aarch64) yang dihasilkan oleh *backend* LLVM, pasca optimisasi akhir.

Pengamatan disassembly berguna untuk:
1. Menentukan apakah inlining benar-benar terjadi.
2. Memverifikasi optimisasi *auto-vectorization* (penggunaan instruksi SIMD/AVX seperti `vaddps`).
3. Mengidentifikasi instruksi branching berlebih atau pengecekan batas array (*bounds check*) yang tidak berhasil dihilangkan LLVM.

Dalam optimasi tingkat lanjut, flag `RUSTFLAGS="-C target-cpu=native"` digunakan untuk memerintahkan LLVM menggunakan semua fitur dan instruksi spesifik yang tersedia pada CPU mesin saat proses kompilasi berjalan (misalnya AVX-512).

## Diagram ASCII: Workflow Disassembly

```text
[ Rust Source ]
      │
      ▼ cargo build --release
      │
[ Optimized Target Object File ]
      │
      ▼ cargo asm --lib my_crate::my_function
      │
[ x86_64 Disassembly ]
  mov rax, rdi
  add rsi, rdx
  ret
```

## Kode Rust Production-Ready

```rust
// Kode ini dimaksudkan untuk dikompilasi dengan release profile.
// Perintah inspeksi: `cargo asm my_crate::math::compute_sum`

pub mod math {
    /// Penjumlahan slice biasa. 
    /// Jika target-cpu diset, kita akan melihat instruksi vektor (vaddps/vpaddd) di assembly.
    #[no_mangle] // Mencegah symbol name mangling agar mudah dicari di disassembly
    pub fn compute_sum(data: &[u32]) -> u32 {
        // Iterator chaining di Rust umumnya sangat dioptimisasi (zero-cost abstraction)
        // LLVM akan mengubah sum() ini menjadi sebuah tight loop
        data.iter().sum()
    }

    /// Fungsi ini mendemonstrasikan penghindaran bounds-checking.
    #[no_mangle]
    #[inline(never)] // Paksa agar tetap sebagai fungsi independen dalam assembly
    pub fn safe_array_access(slice: &[u8], index: usize) -> u8 {
        // Jika kita menggunakan slice[index], assembly akan menampilkan
        // sebuah kondisi "cmp" dan "ja" menuju panic handler.
        // Dengan get(), branch dipaksa menjadi kondisional biasa (atau terhindar sama sekali)
        match slice.get(index) {
            Some(&val) => val,
            None => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::math::*;

    #[test]
    fn test_compute_sum() {
        let arr = [1, 2, 3, 4, 5];
        assert_eq!(compute_sum(&arr), 15);
    }

    #[test]
    fn test_safe_array_access() {
        let arr = [10, 20, 30];
        assert_eq!(safe_array_access(&arr, 1), 20);
        assert_eq!(safe_array_access(&arr, 9), 0); // Out of bounds
    }
}
```

## Anti-Patterns

1. **Asumsi Optimisasi Tanpa Verifikasi Profiling / ASM**
   - **Contoh Buruk**: Memilih tipe data abstrak atau pola algoritmik kompleks karena "katanya zero-cost abstraction" tanpa pernah mengecek hasil perakitan akhirnya.
   - **Mengapa berbahaya**: LLVM memiliki keterbatasan ("optimization barriers") seperti trait objects (`dyn Trait`), indirect jumps, atau complex memory aliasing. "Zero-cost" hanya berlaku jika LLVM mampu membuktikannya statis. Jika gagal, overhead *runtime* akan muncul dalam assembly.

2. **Mendistribusikan Binary `target-cpu=native` secara Global**
   - **Contoh Buruk**: Mengonfigurasi `.cargo/config.toml` dengan `rustflags = ["-C", "target-cpu=native"]` lalu merilis dan mendistribusikan *binary* (executable) hasil *build* tersebut ke publik/klien.
   - **Mengapa berbahaya**: Kode dikompilasi *hanya* untuk arsitektur instruksi spesifik mesin build Anda (misal AVX2). Klien dengan CPU yang tidak mendukung instruksi tersebut akan mengalami *SIGILL* (Illegal Instruction) crash secara instan saat program dijalankan. `native` hanya aman untuk kompilasi lokal (seperti server in-house).

## Edge Cases & Defensive Programming
- **Codegen Units (CGU)**: Semakin banyak modul yang dikompilasi (CGU tinggi), LLVM semakin kehilangan visibilitas kontekstual global. Jika `cargo asm` menunjukkan pemanggilan fungsi (`call`) yang aneh padahal Anda mengharapkan inlining, turunkan `codegen-units = 1`.
- **`black_box` untuk Benchmark**: Saat memeriksa *disassembly* untuk fungsi sederhana (misal, untuk *microbenchmarking*), selalu gunakan `std::hint::black_box` pada input atau output. Ini mencegah compiler LLVM terlalu pandai mengoptimisasi (menghilangkan evaluasi jika konstanta sudah diketahui di waktu kompilasi).
