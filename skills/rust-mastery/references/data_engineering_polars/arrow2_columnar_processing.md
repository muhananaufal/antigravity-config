# Arrow2 Columnar Processing

## Konsep Utama
Apache Arrow menentukan tata letak memori (memory format) columnar yang menjadi standar industri. Crate `arrow2` (ditulis ulang oleh Jorge Leitao) menawarkan API aman bebas transmute untuk memanipulasi format buffer ini di Rust. Dengan Arrow, struktur data disimpan dalam array berbasis kolom sehingga transfer data antar mesin/bahasa bersifat *Zero-Copy* dan caching CPU dimaksimalkan untuk agregasi.

## Arsitektur & Flow
```text
Row-based (OOP): 
[{id: 1, val: A}, {id: 2, val: B}, {id: 3, val: C}] -> Cache Miss!

Column-based (Arrow):
[1, 2, 3]       -> CPU Vectorized Add (Cache Hit!)
["A", "B", "C"] -> Dictionary Encoded
```

## Production-Ready Code
```rust
use arrow2::array::{Int32Array, Utf8Array, DictionaryArray, DictionaryKey};
use arrow2::datatypes::{DataType, Field, Schema};
use arrow2::chunk::Chunk;
use std::sync::Arc;

pub fn create_columnar_chunk() -> Chunk<Box<dyn arrow2::array::Array>> {
    // 1. Primitive Array (Contiguous memory, zero-copy ready)
    let id_array = Int32Array::from_slice([100, 101, 102, 103, 104]);

    // 2. Dictionary Encoded Array untuk String kardinalitas rendah
    // Alih-alih menyimpan "NEW YORK" berkali-kali, simpan Index (key) + Values
    let keys = Int32Array::from_slice([0, 1, 0, 1, 2]); // 0=NY, 1=LA, 2=TX
    let values = Utf8Array::<i32>::from_slice(["NEW YORK", "LOS ANGELES", "TEXAS"]);
    
    let dict_array = DictionaryArray::<i32>::try_new(
        DataType::Dictionary(
            IntegerType::Int32,
            Box::new(DataType::Utf8),
            false,
        ),
        keys,
        Box::new(values),
    ).expect("Valid dictionary format");

    // 3. Merakit menjadi Chunk (RecordBatch setara)
    Chunk::new(vec![
        Box::new(id_array) as Box<dyn arrow2::array::Array>,
        Box::new(dict_array) as Box<dyn arrow2::array::Array>,
    ])
}

pub fn filter_chunk_simd(chunk: &Chunk<Box<dyn arrow2::array::Array>>) -> Chunk<Box<dyn arrow2::array::Array>> {
    use arrow2::compute::filter::filter_chunk;
    use arrow2::compute::comparison::eq_scalar;
    
    // Ambil kolom ID
    let id_col = chunk.arrays()[0].as_any().downcast_ref::<Int32Array>().unwrap();
    
    // SIMD-accelerated mask generation
    let mask = eq_scalar(id_col, &102);
    
    // Terapkan boolean mask (Predicate) ke seluruh Chunk
    filter_chunk(chunk, &mask).expect("Filtering failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_arrow2_filter() {
        let chunk = create_columnar_chunk();
        let filtered = filter_chunk_simd(&chunk);
        
        assert_eq!(filtered.len(), 1);
        
        let filtered_id = filtered.arrays()[0].as_any().downcast_ref::<Int32Array>().unwrap();
        assert_eq!(filtered_id.value(0), 102);
    }
}
```

## Anti-Patterns

1. **Iterasi Row per Row Secara Manual**
   - *Mengapa berbahaya:* Mengubah Arrow array ke vektor struct struct biasa (`Vec<MyRow>`) menghilangkan semua keunggulan caching dan SIMD. Ini merupakan overhead instansiasi memori masif.
   - *Solusi:* Selalu gunakan fungsi di `arrow2::compute::*` (seperti `cast`, `filter`, `sort`, `aggregate`) yang beroperasi pada *Bitmap* dan *Buffer* array secara massal.

2. **String Array untuk Data Kategorikal**
   - *Mengapa berbahaya:* Array `Utf8Array` yang berisi string panjang berulang membutuhkan O(N) memori dan mahal saat difilter.
   - *Solusi:* Enkode menjadi `DictionaryArray` (seperti di atas) sejak dari layer ekstraksi. Komparasi string panjang akan berubah menjadi integer comparison.

## Edge Cases & Defensive Programming
- **Alignment Mismatch (IPC/FFI):** Saat menerima data Arrow mentah dari proses eksternal (C/Python via FFI), pointer-nya mungkin tidak di-align (terutama di arsitektur non-x86). Arrow2 secara ketat memeriksa padding/alignment sebelum memproses transmute, pastikan IPC zero-copy sudah dipadding 8 atau 64-byte.
- **Null Bitmap Validity:** Selalu asumsikan elemen data mengandung null. Operasi mentah pada buffer data akan mengacuhkan masking (validity bitmap). Selalu periksa array `.validity()` saat membuat fungsi custom compute.
