# Struct Memory Layout & Alignment di Rust

## Deskripsi Konsep
Dalam pemrograman sistem, pemahaman mendalam tentang tata letak memori (memory layout) dan penyelarasan (alignment) sangat penting. Secara default, Rust tidak menjamin urutan field di dalam `struct` (disebut `repr(Rust)`). Rust compiler (rustc) secara aktif mengoptimalkan ukuran struktur memori dengan menyusun ulang (reordering) field untuk meminimalkan *padding* (ruang kosong akibat aturan alignment CPU). 

Namun, saat berinteraksi dengan bahasa C, memory-mapped I/O (MMIO), atau jaringan, kita sering butuh kontrol pasti terhadap memori. Rust menyediakan anotasi `#[repr(...)]` untuk mengontrol layout secara presisi:
- `#[repr(C)]`: Memaksa layout mengikuti standar ABI (Application Binary Interface) bahasa C. Urutan field *pasti* tidak diubah.
- `#[repr(packed)]` atau `#[repr(packed(N))]`: Menghilangkan padding. Alignment diatur menjadi 1 (atau N). Sangat hemat ruang tapi bisa menyebabkan undefined behavior (UB) jika membaca referensi (*unaligned read*).
- `#[repr(align(N))]`: Memaksa *alignment* struktur ke kelipatan N bytes. Sering digunakan pada buffer DMA atau memori vektor SIMD.

## Diagram ASCII: Memory Layout & Reordering

```text
Deklarasi (Logical):
struct Foo { a: u8, b: u32, c: u16 }

#[repr(C)] Layout (Tidak di-reorder):
+---+---+---+---+---+---+---+---+---+---+---+---+
| a | p | p | p | b   (4 bytes) | c   (2) | p | p |
+---+---+---+---+---+---+---+---+---+---+---+---+
 0   1   2   3   4   5   6   7   8   9   10  11
(p = padding, Size: 12 bytes, Align: 4)

#[repr(Rust)] Layout (Reordered untuk optimalisasi):
+---+---+---+---+---+---+---+---+
| b   (4 bytes) | c   (2) | a | p |
+---+---+---+---+---+---+---+---+
 0   1   2   3   4   5   6   7
(p = padding, Size: 8 bytes, Align: 4)

#[repr(packed)] Layout (Tanpa Padding):
+---+---+---+---+---+---+---+
| a | b   (4 bytes) | c (2) |
+---+---+---+---+---+---+---+
 0   1   2   3   4   5   6
(Size: 7 bytes, Align: 1)
```

## Kode Rust Production-Ready

```rust
use std::mem;
use std::ptr;

/// Representasi struktur standar Rust (optimasi diaktifkan)
#[derive(Debug, Default)]
struct OptimizedLayout {
    a: u8,
    b: u64,
    c: u16,
}

/// Representasi kompatibel dengan C ABI
#[repr(C)]
#[derive(Debug, Default)]
struct CCompatibleLayout {
    a: u8,
    b: u64,
    c: u16,
}

/// Representasi packed untuk protokol jaringan
#[repr(packed)]
#[derive(Debug, Default)]
struct NetworkPacket {
    header: u8,
    payload: u32,
    footer: u16,
}

/// Buffer yang sejajar ke cache-line CPU (umumnya 64 bytes)
#[repr(C, align(64))]
#[derive(Debug, Default)]
struct CacheAlignedBuffer {
    data: [u8; 32],
}

/// Menghitung offset field dalam struktur yang dijamin layout-nya
macro_rules! offset_of {
    ($Struct:path, $field:ident) => {{
        // Dapatkan pointer basis fiktif, pastikan tidak dereference
        let dummy = ::std::mem::MaybeUninit::<$Struct>::uninit();
        let base_ptr = dummy.as_ptr();
        // Dapatkan pointer ke field menggunakan penambahan pointer (*const T)
        let field_ptr = unsafe { ::std::ptr::addr_of!((*base_ptr).$field) };
        (field_ptr as usize) - (base_ptr as usize)
    }};
}

pub fn analyze_layouts() -> Result<(), &'static str> {
    // 1. Cek ukuran dan alignment (Rust vs C)
    let opt_size = mem::size_of::<OptimizedLayout>();
    let c_size = mem::size_of::<CCompatibleLayout>();
    
    // Rust reorders: b (8) + c (2) + a (1) + padding(5) = 16 (Align: 8)
    // C doesn't reorder: a (1) + padding(7) + b (8) + c (2) + padding(6) = 24 (Align: 8)
    if opt_size >= c_size {
        return Err("Optimized size should be strictly less than or equal to C size in this case");
    }

    // 2. Akses memori secara aman pada tipe packed
    let mut pkt = NetworkPacket {
        header: 1,
        payload: 0xDEADBEEF,
        footer: 0xFFFF,
    };

    // AMAN: Membaca dengan ptr::read_unaligned
    // TIDAK AMAN: let x = &pkt.payload; (Bisa panic pada CPU tertentu jika unaligned)
    let payload_val = unsafe { ptr::read_unaligned(ptr::addr_of!(pkt.payload)) };
    assert_eq!(payload_val, 0xDEADBEEF);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_layout_sizes() {
        assert_eq!(mem::size_of::<OptimizedLayout>(), 16);
        assert_eq!(mem::align_of::<OptimizedLayout>(), 8);

        assert_eq!(mem::size_of::<CCompatibleLayout>(), 24);
        assert_eq!(mem::align_of::<CCompatibleLayout>(), 8);

        assert_eq!(mem::size_of::<NetworkPacket>(), 7);
        assert_eq!(mem::align_of::<NetworkPacket>(), 1);

        assert_eq!(mem::size_of::<CacheAlignedBuffer>(), 64);
        assert_eq!(mem::align_of::<CacheAlignedBuffer>(), 64);
    }

    #[test]
    fn test_offset_macro() {
        assert_eq!(offset_of!(CCompatibleLayout, a), 0);
        assert_eq!(offset_of!(CCompatibleLayout, b), 8);
        assert_eq!(offset_of!(CCompatibleLayout, c), 16);
    }
}
```

## Anti-Patterns

1. **Membuat Referensi ke Field dalam `#[repr(packed)]`**
   - **Contoh Buruk**: `let r: &u32 = &my_packed_struct.field;`
   - **Mengapa berbahaya**: Pada arsitektur tertentu (seperti ARM versi lama), membaca pointer yang tidak selaras (unaligned read) akan menghasilkan *hardware fault* (SIGBUS) atau memuat nilai yang cacat (silent corruption). Rust menganggap semua referensi `&T` ter-align secara valid. Melanggar ini adalah Undefined Behavior.

2. **Asumsi Urutan Field di `repr(Rust)`**
   - **Contoh Buruk**: Melakukan pointer arithmetic menggunakan `offset_of!` pada struct tanpa `#[repr(C)]`, atau membaca file biner langsung ke struct `repr(Rust)`.
   - **Mengapa berbahaya**: Versi compiler Rust yang berbeda dapat dan akan mengubah algoritma pengurutan memori. Kode yang berfungsi hari ini mungkin *break* (gagal) pada pembaruan compiler berikutnya, menyebabkan korupsi data tanpa peringatan.

## Edge Cases & Defensive Programming
- **Union Layouts**: `union` di Rust berukuran sama dengan varian terbesarnya, dan keselarasan (`align`) mengikuti varian dengan alignment terbesar. Saat menggunakan `union` untuk *type punning* (C-style), berhati-hatilah dengan initialization padding.
- **`std::mem::offset_of!` (Rust 1.77+)**: Selalu gunakan makro standar dari standar pustaka ini ketimbang membangun macro secara manual untuk mencegah masalah terkait pointer *null*.
- **SIMD / DMA Vector Types**: Pada tipe data SIMD (contoh `<f32, 4>`), perhatikan bahwa alignment bisa dipaksa ke kelipatan lebih besar dari ukuran komponen (misal: 16 bytes). Gunakan `#[repr(align(16))]` jika mendefinisikan array primitif untuk diproses oleh *intrinsics* SIMD.
