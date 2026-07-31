# LLVM IR & Optimization Passes di Rust

## Deskripsi Konsep
Rust berutang performanya yang setingkat C/C++ pada integrasinya dengan LLVM. Kode Rust dikompilasi menjadi representasi menengah internal (MIR), lalu diterjemahkan ke LLVM IR (Intermediate Representation). LLVM kemudian menjalankan pipeline "passes" (langkah-langkah optimisasi) untuk menganalisis dan merombak IR menjadi kode mesin yang sangat cepat.

Beberapa optimisasi LLVM paling kritikal yang dimanfaatkan Rust:
- **Inlining**: Menyisipkan isi fungsi langsung ke caller-nya, menghilangkan overhead *function call* (instruksi call/ret) dan membuka jalan bagi optimisasi lain.
- **SROA (Scalar Replacement of Aggregates)**: Menguraikan variabel struct/tuple lokal menjadi variabel individual (scalar), memungkinkan alokasi ke register CPU daripada stack.
- **GVN (Global Value Numbering)**: Mengeliminasi redundansi perhitungan (Common Subexpression Elimination).
- **Loop Vectorization**: Mengonversi operasi loop per-elemen menjadi instruksi SIMD (Single Instruction, Multiple Data).
- **LTO (Link-Time Optimization)**: Memungkinkan optimisasi *across crate boundaries* (lintas crate). *Thin LTO* lebih cepat namun jangkauan terbatas, sedangkan *Fat LTO* menganalisis keseluruhan program dengan biaya waktu kompilasi yang tinggi.

## Diagram ASCII: LLVM Pass Pipeline

```text
Rust Source
   │
   ▼ rustc (Frontend)
   │
[ MIR (Mid-level IR) ] ---> (Borrow checking, Monomorphization)
   │
   ▼ rustc (Codegen Backend)
   │
[ LLVM IR (*.ll) ]
   │
   ├─► Inliner Pass ───────────┐
   │                           │
   ├─► SROA Pass ──────────────┼──► (IR Semakin efisien & kecil)
   │                           │
   ├─► Loop Vectorizer Pass ───┘
   │
   ▼ LLVM LLD / System Linker
   │
[ Native Binary (*.exe/ELF) ]
```

## Kode Rust Production-Ready

```rust
use std::hint::black_box;

/// Contoh struct untuk demonstrasi SROA.
/// Meskipun dibungkus dalam struct, LLVM (via SROA) akan menyimpan 
/// `x` dan `y` langsung dalam register, menghilangkan alokasi struct di memori.
pub struct Point {
    x: f32,
    y: f32,
}

impl Point {
    /// #[inline] memberi *hint* kepada LLVM bahwa fungsi ini sebaiknya
    /// di-inline. Berguna untuk operasi matematis sederhana atau getter lintas crate.
    #[inline]
    pub fn distance_squared(&self, other: &Point) -> f32 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        dx * dx + dy * dy
    }
}

/// #[inline(always)] memaksa LLVM (sekeras mungkin) untuk selalu inline fungsi.
/// Hanya gunakan jika sangat krusial di hot path (HFT/Game Engine).
#[inline(always)]
pub fn fast_multiply(a: u32, b: u32) -> u32 {
    a.wrapping_mul(b)
}

/// #[inline(never)] melarang inlining. Berguna untuk *cold paths*
/// (misalnya fungsi penanganan error) agar cache instruksi (I-Cache) CPU
/// tidak tercemar oleh kode yang jarang dieksekusi.
#[inline(never)]
#[cold]
pub fn handle_error_cold_path(code: u32) -> ! {
    panic!("Critical system failure: error code {}", code);
}

/// Demonstrasi loop vectorization. 
/// LLVM secara otomatis dapat me-vectorize ini (SIMD) jika tipe primitif.
pub fn add_vectors(a: &[f32], b: &[f32], out: &mut [f32]) {
    // Assert length to help LLVM eliminate bounds checks inside the loop,
    // which significantly helps loop vectorization passes.
    let len = a.len();
    assert!(b.len() >= len && out.len() >= len);
    
    for i in 0..len {
        // Tanpa assert di atas, ini bisa melahirkan `panic` branches,
        // mencegah optimisasi SIMD yang efektif.
        out[i] = a[i] + b[i];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_point_distance() {
        let p1 = Point { x: 0.0, y: 0.0 };
        let p2 = Point { x: 3.0, y: 4.0 };
        assert_eq!(p1.distance_squared(&p2), 25.0);
    }

    #[test]
    fn test_add_vectors() {
        let a = vec![1.0, 2.0, 3.0, 4.0];
        let b = vec![4.0, 3.0, 2.0, 1.0];
        let mut out = vec![0.0; 4];
        add_vectors(&a, &b, &mut out);
        assert_eq!(out, vec![5.0, 5.0, 5.0, 5.0]);
    }
}
```

## Anti-Patterns

1. **Penyalahgunaan `#[inline(always)]`**
   - **Contoh Buruk**: Memberi atribut `#[inline(always)]` pada fungsi besar yang dipanggil di ratusan tempat.
   - **Mengapa berbahaya**: Inlining secara paksa menduplikasi seluruh *body* fungsi di setiap titik pemanggilan (call site). Ini mengakibatkan program membesar drastis (binary bloat) dan performa merosot karena memori cache instruksi CPU (I-cache misses) terkuras. Serahkan inlining kepada heuristik compiler.

2. **Menggagalkan SROA dengan Borrowing (Referensi)**
   - **Contoh Buruk**: Mengembalikan referensi (`&T`) lokal atau melakukan passing banyak struct kecil via referensi di mana nilai (`by value`) lebih masuk akal.
   - **Mengapa berbahaya**: SROA hanya bisa memecah dan menempatkan komponen dalam register jika LLVM yakin *address* dari memori tersebut tidak diakses dari tempat lain (tidak teraliaskan). Saat kita membuat pointer atau reference ke sebagian dari tuple/struct lokal, LLVM harus mem-spill variabel tersebut ke stack.

## Edge Cases & Defensive Programming
- **Codegen Units**: Secara default pada rilis (`cargo build --release`), Cargo menggunakan `codegen-units = 16` untuk mempercepat kompilasi (paralelisasi). Namun, memisahkan modul mengurangi informasi yang bisa dilihat inliner LLVM. Ubah profil rilis dengan `codegen-units = 1` dan `lto = "fat"` untuk mengizinkan LLVM mengoptimasi lintas batas kompilasi dengan maksimal (mengorbankan waktu kompilasi).
- **Bounds Checking dalam Loop**: *Loop Vectorizer* sering gagal beraksi jika mendeteksi *branch* untuk bound checks dalam iterasi. Gunakan asersi sebelum loop (defensive programming) atau iterator (mis. `.zip()`) karena abstraksi tersebut menjamin tidak ada bound checking di dalam badan loop, membebaskan LLVM untuk menghasilkan instruksi AVX/SIMD.
