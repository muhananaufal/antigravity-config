# Drop Check (Dropck) & PhantomData di Rust

## Deskripsi Konsep
Dalam Rust, memastikan keamanan memori (memory safety) berarti memastikan bahwa objek yang dihancurkan (*dropped*) tidak mengakses memori atau referensi yang sudah lebih dulu kadaluwarsa (didealokasi). Mekanisme compiler yang menegakkan aturan tata tertib *destruction* ini disebut **Drop Check** (atau `dropck`).

Secara default, jika tipe generic `struct MyStruct<T>` memiliki implementasi `Drop`, compiler akan berasumsi yang terburuk: Metode `drop` mungkin mengakses elemen bertipe `T`. Karenanya, `dropck` memaksa bahwa *umur* (lifetime) elemen `T` harus lebih panjang secara ketat (`strictly outlive`) daripada umur `MyStruct` itu sendiri.

Terkadang, asumsi ini terlalu ketat, misalnya dalam alokasi koleksi memori mentah seperti `Vec<T>`. Vektor tersebut memang *mengandung* `T`, namun rutinitas drop-nya hanya mendealokasikan buffer dan menghancurkan elemen; jika elemen tersebut tidak diakses *selama* proses dealokasi (hanya di-drop secara linear), aturan `dropck` dapat dilonggarkan. Hal ini dilakukan melalui atribut `#[may_dangle]`, yang menginstruksikan `dropck` bahwa "saya meyakinkan Anda bahwa tipe atau lifetime tertentu mungkin menjuntai (dangling) di dalam drop, tetapi saya berjanji tidak akan mengakses nilainya."

`PhantomData<T>` digunakan sebagai pemberi sinyal (marker) ke sistem peminjam (*borrow checker*) dan `dropck` mengenai *niat* relasi kepemilikan. `Vec<T>` mengandung pointer mentah `*mut T`. Karena `*mut T` tidak terikat aturan `dropck` biasa, `Vec<T>` menyertakan `PhantomData<T>` untuk memberi tahu compiler: "Berpura-puralah tipe ini secara logis mem-miliki (own) sebuah instance `T`", sehingga *Drop Check* tetap menjaga integritas.

## Diagram ASCII: Drop Check Flow

```text
Misal struct A mengandung referensi ke B.

[ B dialokasikan ] <─────┐
   │                     │
[ A dialokasikan ]       │ Lifetime A
   │  A { b_ref: &B }    │ A harus mati lebih dulu!
   │                     │
[ A di-Drop (A::drop) ] <┘ (A::drop mungkin mencoba deref b_ref)
   │                       (Jika B mati duluan, ini memicu Use-After-Free)
[ B di-Drop ]
```

## Kode Rust Production-Ready

```rust
#![feature(dropck_eyepatch)]
// Catatan: #[may_dangle] memerlukan fitur nightly `dropck_eyepatch` saat ini.
// Karena kita menargetkan standar production, simulasi konsepnya sering digunakan pada stdlib.

use std::ptr::NonNull;
use std::marker::PhantomData;

/// Koleksi heap buatan sendiri untuk mendemonstrasikan PhantomData dan manajemen Drop.
pub struct MyVec<T> {
    ptr: NonNull<T>,
    cap: usize,
    len: usize,
    // PhantomData beritahu Drop Check bahwa kita secara logis "memiliki" nilai T.
    // Jika tidak ada ini, `T` yang memiliki lifetime referensi mungkin dihancurkan
    // sebelum struktur MyVec, mengakibatkan UB jika drop-nya diakses.
    _marker: PhantomData<T>,
}

impl<T> MyVec<T> {
    pub fn new() -> Self {
        assert!(std::mem::size_of::<T>() != 0, "ZST (Zero-Sized Type) tidak ditangani");
        MyVec {
            ptr: NonNull::dangling(),
            cap: 0,
            len: 0,
            _marker: PhantomData,
        }
    }
}

// Simulasi penggunaan `#[may_dangle]` secara konseptual.
// Secara default, compiler Rust menerapkan Strict Drop Check.
// Implementasi stdlib `Vec` menggunakan `unsafe impl<#[may_dangle] T> Drop for Vec<T>`
// yang mengizinkan `T` kadaluwarsa lebih awal asalkan Drop `Vec` tidak dereferensinya.
impl<T> Drop for MyVec<T> {
    fn drop(&mut self) {
        if self.cap != 0 {
            // Kita harus secara manual menghancurkan elemen satu per satu
            // jika len > 0, LALU mendealokasikan buffer `ptr`.
            // Jika kita gagal menyediakan `PhantomData` di MyVec, 
            // `dropck` tidak akan mengecek relasi jika `T` memiliki referensi menjuntai.
            
            // (Logika dealokasi manual dilewati demi keringkasan)
        }
    }
}

pub struct Inspector<'a>(&'a u32);

impl<'a> Drop for Inspector<'a> {
    fn drop(&mut self) {
        println!("Inspeksi: {}", self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_phantom_data_size() {
        // PhantomData berukuran nol
        assert_eq!(std::mem::size_of::<PhantomData<String>>(), 0);
        // Struct yang menyertakannya tidak terkena overhead alokasi memori
        assert_eq!(std::mem::size_of::<MyVec<u32>>(), std::mem::size_of::<usize>() * 3);
    }
}
```

## Anti-Patterns

1. **Struktur Pointer Mentah Tanpa `PhantomData`**
   - **Contoh Buruk**: Membangun custom arena allocator atau smart pointer menggunakan `*mut T` tanpa menambahkan penanda `PhantomData<T>`.
   - **Mengapa berbahaya**: `*mut T` memberi tahu compiler bahwa Anda "mungkin atau mungkin tidak" memiliki objek tersebut. Sistem *borrow checker* dan *drop checker* akan *berhenti* mencoba memvalidasi dan mem-bound lifetime `T`. Jika struktur Anda kemudian menghancurkan (drop) objek `T` di dalam blok `drop`-nya, hal ini bisa mengakibatkan *Use-After-Free* jika instance referensinya telah dijatuhkan lebih dulu.

2. **Penyalahgunaan `#[may_dangle]` pada Tipe yang Dereference Parameter**
   - **Contoh Buruk**: Memberikan `#[may_dangle]` pada implementasi `Drop` di mana fungsi drop tersebut memanggil `self.t.be_inspected()`.
   - **Mengapa berbahaya**: Atribut `may_dangle` adalah *janji buta (unsafe)* kepada compiler bahwa Anda tidak akan mengevaluasi atau mengakses nilai (atau memanggil fungsi virtual) dari parameter tersebut. Jika janji ini dilanggar, Anda akan menyentuh memori yang sudah di-invalidasi (Dangling Pointer / Segfault).

## Edge Cases & Defensive Programming
- **Drop Elaboration**: Kompiler LLVM / rustc memiliki fase *Drop Elaboration* di mana ia memasukkan "Drop Flags" statis. Jika variabel dipindahkan (moved) sebagian di blok kontrol *if/else* yang kompleks, compiler secara otomatis akan melacak "apakah elemen ini sudah dijatuhkan atau belum". Jangan pernah mencoba membypass ini dengan menebak state memori.
- **`ManuallyDrop<T>`**: Saat menulis abstraksi *Unsafe*, alih-alih mengandalkan pembacaan pointer mentah `ptr::read` bolak-balik yang rentan double-free UB, bungkus tipe sensitif dengan `std::mem::ManuallyDrop<T>`. Ini menghentikan drop implisit seketika, dan memberikan kontrol mutlak tentang kapan (dan jika) drop dipanggil melalui `ManuallyDrop::drop()`.
