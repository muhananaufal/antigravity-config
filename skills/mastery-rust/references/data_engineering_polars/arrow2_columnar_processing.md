# Panduan Mendalam: Pemrosesan Array Kolumnar dengan Arrow2 (Apache Arrow)

## 1. Konsep Utama & Arsitektur
*Apache Arrow* adalah format memori *in-memory* mutakhir yang dikonstruksi secara spesifik untuk analitik data besar (*data warehouse*, *dataframe tools* seperti Polars). Alih-alih tata letak *row-based* tradisional (misalnya struktur array-of-structs: `[ {id, name}, {id, name} ]`), Arrow menggunakan model memori kolom (*struct-of-arrays*: `ids: [...], names: [...]`).
Desain *columnar* dipadukan dengan kepatuhan tata letak yang ketat memungkinkan transmisi antar bahasa/proses via IPC secara **zero-copy** (tanpa penyalinan serialisasi lambat). Crate `arrow2` (dan iterasi terintegrasinya di proyek *arrow*) memberikan implementasi *safety-first* di Rust, mendukung kalkulasi matriks dengan injeksi instruksi *SIMD computational kernels*.

### 1.1 Diagram Alur Tata Letak Kolom dan Bitmap
```ascii
[ Data Primer: u32 (10 elemen) ]
(Aligned to 64-byte boundaries for cache-line and SIMD efficiency)

Values Array (Memori kontinu berurut):
[ 10 | 25 | 0 (null) | 99 | 12 | ... ]

Validity Bitmap (Memori padat bit-wise - L1 Cache friendly):
[ 1 | 1 | 0 | 1 | 1 | ... ]  <-- '0' berarti index-2 adalah Nil/Null
  ^ bit ke-0 = true (elemen ke-1 valid)
```

## 2. Implementasi Produksi (Zero-Clippy Warnings, Fully Tested)
Berikut cara mendelegasikan konstruksi Array Arrow *primitive*, dengan pelacakan bit *null* (*nullability tracking*) dan konversi murni *memory safe*.

```rust
// Cargo.toml
// arrow = { version = "50.0", features = ["simd"] } 
// (Catatan: arrow2 secara bertahap dilebur kembali ke upstream `arrow-rs`. 
// Kita mendemonstrasikan API standar `arrow-rs` modern berbasis memori buffer.)

use arrow::array::{Array, PrimitiveArray};
use arrow::datatypes::UInt32Type;
use arrow::buffer::Buffer;
use arrow::buffer::NullBuffer;

/// Mengonversi sekumpulan elemen menjadi format memori Apache Arrow.
/// Termasuk optimasi pembentukan *bitmap nulls*.
pub fn build_arrow_primitive(data: &[Option<u32>]) -> PrimitiveArray<UInt32Type> {
    // Membangun array menggunakan Mutable pattern builder primitif panah
    let mut values = Vec::with_capacity(data.len());
    let mut null_bitmap = Vec::with_capacity(data.len()); // Boolean flags sementara

    for &item in data {
        match item {
            Some(val) => {
                values.push(val);
                null_bitmap.push(true);
            }
            None => {
                values.push(0); // Representasi dummy untuk ruang yang hilang
                null_bitmap.push(false);
            }
        }
    }

    // Mengkonversi memori standard Rust menjadi Arrow Buffers.
    // Transisi di sini secara internal sangat ramah karena memori disejajarkan.
    let values_buffer = Buffer::from_iter(values.into_iter());
    let nulls = NullBuffer::from_iter(null_bitmap.into_iter());

    PrimitiveArray::<UInt32Type>::new(values_buffer, Some(nulls))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_arrow_alignment_and_null_tracking() {
        let raw_data = vec![Some(42), None, Some(99)];
        let arr = build_arrow_primitive(&raw_data);
        
        assert_eq!(arr.len(), 3);
        assert_eq!(arr.null_count(), 1);
        
        // Memastikan akses memori
        assert!(arr.is_valid(0)); // Indeks 0 valid
        assert!(arr.is_null(1));  // Indeks 1 null
        assert_eq!(arr.value(2), 99);
    }
}
```

## 3. Anti-Patterns Kritis

### 3.1. Iterasi Baris Demi Baris via Abstraksi Level Tinggi
**Buruk:** Mengeksekusi filter pada Dataframe Arrow (seperti dalam Polars atau Datafusion) dengan melooping `for row in array { ... }` memanggil fungsi Rust biasa.
**Alasan:** Iterasi dinamis mengorbankan keuntungan fundamental Arrow—*SIMD Vectorization*—dan sangat bergantung pada percabangan CPU (*branch prediction*) pada iterasi status *null*. Arrow dirancang untuk diterjang oleh *kernels* kalkulasi utuh (seperti `arrow::compute::add(arr_a, arr_b)`), yang melakukan chunk loop menggunakan *SIMD intrinsics* pada block bit/vektor 512-bit serentak.
**Solusi:** Ekspresikan logika aplikasi Anda sebagai komposisi *primitive arrays kernel computations* (penjumlahan kolom vertikal, mask filtering array bitmap) daripada iterasi horizontal *row iterators*.

### 3.2. Kesalahan Penjajaran (Unaligned Memory Copies)
**Buruk:** Membuang data paket TCP jaringan langsung (*raw bytes*) ke representasi slice `&[f64]` dan membungkusnya sebagai Arrow Array tanpa memastikan penjajaran (*alignment*).
**Alasan:** Memori instruksi x86_64 AVX memerlukan address yang merupakan kelipatan dari 32 atau 64 bytes (*aligned access*). Jika Arrow array dibentuk (*zero-copy*) pada byte jaringan yang acak, operasi kernel *arrow::compute* di dalam CPU akan memicu SIGBUS atau *Hardware Exception* ketika *SIMD Load instructions* dieksekusi, membuat server aplikasi meledak (crash seketika).
**Solusi:** Gunakan API buffer IPC dari `arrow` yang menangani pembacaan blok memori yang aman, menggunakan *padding allocations* kustom dari spesifikasi IPC Arrow resmi untuk mematuhi penjajaran memori mutlak.

## 4. Edge Cases dalam Skala Produksi

### 4.1. Pemangkasan (Slicing) Array Meninggalkan Null-Bitmap Garbage
Dalam format Arrow, `Slice` pada array besar beroperasi dengan O(1) (tanpa copy). Slicing array `data.slice(offset=3, length=5)` hanya menggeser metadata internal (Pointer Offset).
Namun, data *Null Bitmap* Arrow direpresentasikan per bit di dalam satu `u8`. Mulai iterasi bit di offset tertentu secara tidak sengaja dapat mengakses bit sampah (garbage bits) yang berada sebelum data potong (slice start) pada blok *byte offset* yang sama. Developer Rust yang mem-bypass API tinggi dan beroperasi pada akses primitif bit-array sering kali lupa memperhitungkan modulos/padding offset bit ini dan secara keliru menerjemahkan elemen solid sebagai `null`.

### 4.2. Ketidaksesuaian Endianness (Byte-Order pada IPC)
Zero-copy read merupakan anugerah, tetapi format memori Arrow mensyaratkan arsitektur data bergantung pada format *Endianness* OS/CPU (biasanya *Little Endian*). Menerima stream Array IPC yang dialokasikan di prosesor mainframe Big Endian lama ke dalam mesin Linux x86 akan membuat semua rentang integer dan format memori float terbalik, menghasilkan korupsi nilai logis tanpa error runtime teknis. Dalam skala produksi, *IPC Header validation* perlu menegaskan byte-order pada jembatan protokol Anda.

### 4.3. Panik *Out-Of-Bounds* pada Null Indexing Akses Kasar
Dalam *PrimitiveArray*, ketika *Validity Bitmap* bernilai 0 (elemen itu *null*), data *Values Array* di offset yang berkoresponden tidak secara memori dijamin *kosong*. Itu berisikan sampah biner atau nilai nol (0) tiruan. Developer yang memaksakan *array.value(i)* tanpa terlebih dahulu mengecek *array.is_null(i)* akan mencabut data sampah kalkulatif. Karena *arrow* menghindari *overhead checks*, keracunan matematis menyebar melintasi logika *machine learning* selanjutnya tanpa disadari.
