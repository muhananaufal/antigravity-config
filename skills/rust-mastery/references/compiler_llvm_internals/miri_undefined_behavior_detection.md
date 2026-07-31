# Miri & Deteksi Undefined Behavior di Rust

## Deskripsi Konsep
**Miri (Mid-level Intermediate Representation Interpreter)** adalah interpreter eksperimental resmi (di bawa rustup) untuk menguji *executable* dan *test suite* dari kode Rust. Bukan mengeksekusi langsung sebagai binary pada CPU, Miri secara harfiah mensimulasikan virtual machine Rust yang melacak setiap bit dan alokasi memori untuk menangkap *Undefined Behavior* (UB) secara pasti.

Model peminjaman memori mematikan Miri ditenagai oleh **Stacked Borrows** (dan lebih baru, Tree Borrows). Model abstrak yang sangat tegas ini menetapkan "tumpukan" (stack) ijin *tag* terhadap alamat memori spesifik. Jika sebuah penunjuk (*pointer*) diakses (read/write) tetapi tag peminjamannya tidak aktif atau telah "dicabut" (popped) dari stack (karena referensi tumpukan di atasnya diaktifkan eksklusif), Miri seketika berteriak memberikan diagnosis kesalahan peminjaman memori secara run-time, terlepas kode itu `unsafe`.

Miri mendeteksi (dengan sempurna):
- **Use-after-free** dan double-free memori.
- **Data Races** (Kondisi balapan pararel antara instruksi read-write memori).
- **Invalid Alignment** dan *Unaligned pointer reads*.
- Pelanggaran validitas *mutability* (Memodifikasi `&T` yang diklaim imutabel).
- Mengembalikan / membaca memori tak terinisialisasi (Uninitialized reads).

## Diagram ASCII: Stacked Borrows (Miri Memory Model)

```text
Deklarasi: let mut x = 42; 
Memori [ x (Alamat 0x1000) ]
Tag Stack: [ (Root: Unique, Mut) ]

Operasi 1: let p1 = &mut x;
Memori [ 0x1000 ]
Tag Stack: [ (Root), (p1: Unique, Mut) ]

Operasi 2: let p2 = &mut *p1;
Memori [ 0x1000 ]
Tag Stack: [ (Root), (p1), (p2: Unique, Mut) ]

Operasi 3 (Pelanggaran!): *p1 = 10; 
  -> p1 digunakan! Stack "di-pop" sampai p1 di puncak.
  -> Tag (p2) dicabut / mati (invalidated).
  Tag Stack: [ (Root), (p1: Unique, Mut) ]

Operasi 4: *p2 = 10;
  -> ERROR (MIRI): Pointer p2 tidak lagi valid pada Stack 0x1000! 
     Undefined Behavior tercegah.
```

## Kode Rust Production-Ready

```rust
use std::ptr;
use std::mem::MaybeUninit;

/// Sebuah fungsi yang secara tidak sengaja melanggar aturan aliasing pointer.
/// Kode ini dapat dikompilasi (bahkan run) di hardware tertentu secara "kebetulan",
/// namun `cargo miri test` akan secara instan menjebak dan merusak eksekusinya.
pub unsafe fn dangerous_aliasing_example() -> i32 {
    let mut data = 10;
    
    // Mendapatkan dua pointer mutable ke sumber data yang sama secara ilegal.
    let ptr1 = &mut data as *mut i32;
    let ptr2 = &mut data as *mut i32;

    // Memodifikasi dari pointer pertama (ini melegitimasi ptr1, menganulir p2 pada stacked borrows)
    *ptr1 = 20;

    // Memodifikasi dari pointer ke-dua.
    // MIRI ERROR: pointer ini telah usang karena ptr1 telah di-akses
    *ptr2 = 30;

    *ptr1
}

/// Praktik aman menginisialisasi buffer dengan Miri.
pub fn safe_buffer_initialization() -> [u32; 5] {
    // Memori murni tidak terinisialisasi (bisa berisi 'garbage')
    let mut uninit_array: [MaybeUninit<u32>; 5] = unsafe {
        MaybeUninit::uninit().assume_init() 
        // Note: Array dari tipe MaybeUninit valid tidak diinisialisasi
    };

    for i in 0..5 {
        // Aman, kita hanya menulis nilai
        uninit_array[i].write(i as u32 * 10);
    }

    // Hanya jika KITA YAKIN SELURUH memori array (0 sampai 4) telah terisi secara solid,
    // kita melakukan casting transmutasi, Miri akan setuju.
    // Miri akan panic jika ada satu index saja yang belum tertulis, mencegah uninitialized read.
    unsafe { std::mem::transmute::<[MaybeUninit<u32>; 5], [u32; 5]>(uninit_array) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_safe_initialization() {
        let result = safe_buffer_initialization();
        assert_eq!(result, [0, 10, 20, 30, 40]);
    }

    // Abaikan ini dari general test run agar tidak crash secara global.
    // Jika dijalankan secara spesifik pada cargo miri test, akan mendeteksi pelanggaran SB.
    #[test]
    #[ignore]
    fn test_unsafe_aliasing_for_miri() {
        unsafe { dangerous_aliasing_example() };
    }
}
```

## Anti-Patterns

1. **Mengabaikan Peringatan Miri untuk Blok "Berjalan Lancar"**
   - **Contoh Buruk**: Eksekusi program berhasil mencetak output yang benar, namun `cargo miri test` mengeluhkan *Stacked Borrows violation*. Engineer berdalih "Miri terlalu bawel" dan tidak memperbaikinya.
   - **Mengapa berbahaya**: UB dalam Rust bukan berarti kode "langsung crash". LLVM optimizer berasumsi keras pada Model Memori Rust. Jika Miri mendeteksi pelanggaran aliasing pointer, pada masa depan LLVM *inliner* atau *SROA optimizer* bisa merombak urutan komputasi operasi memori (instruction reordering), membuahkan bug korupsi memori yang mustahil untuk di-*debug* dan sangat bergantung pada versi compiler *host*.

2. **Memaksa `assume_init` secara Sembrono**
   - **Contoh Buruk**: Menggunakan `let x: T = MaybeUninit::uninit().assume_init();` untuk tipe `T` berstruktur normal sebelum kolom *field*-nya terisi data dengan sengaja.
   - **Mengapa berbahaya**: Menciptakan tipe `T` yang "hidup" dengan referensi padding (garbage) internal atau enum variant tak sah *Seketika* merupakan Undefined Behavior. Miri secara khusus memindai *invalid values* seperti menciptakan byte boolean yang nilainya "3".

## Edge Cases & Defensive Programming
- **FFI Eksternal**: Miri tidak dapat mengeksekusi (*simulate*) bahasa assembly langsung atau memanggil library `.dll`/`.so` (C FFI eksternal). Untuk menguji modul kode ber-FFI di Miri, Anda harus menggunakan isolasi modul bersyarat `#[cfg(miri)]` untuk memalsukan (mock) pemanggilan *syscall* OS luar, atau mengisolasi abstraksi ke modul murni Rust.
- **Tree Borrows**: Karena "Stacked Borrows" dianggap terlalu restriktif untuk beberapa skenario yang diizinkan (misalnya *interior mutability* pada FFI dua arah), Rust perlahan beralih ke eksperimen *Tree Borrows*. Menjalankan Miri dengan flag `MIRIFLAGS="-Zmiri-tree-borrows"` dapat menjadi pengecekan reaktif jika model ketat SB gagal dan anda ingin mengevaluasi perilaku alternatif pointer hirarki.
