# Vtable & Fat Pointer Internals di Rust

## Deskripsi Konsep
Di Rust, *dynamic dispatch* dicapai melalui Trait Objects (`dyn Trait`). Berbeda dengan C++ yang meletakkan penunjuk vtable (Virtual Method Table) secara *inline* di dalam alokasi objek struktur memori, Rust memisahkan vtable pointer ke dalam *pointer itu sendiri*. 

Inilah alasan mengapa pointer ke Trait Object seperti `&dyn Trait` atau `Box<dyn Trait>` disebut **Fat Pointers**. Mereka berukuran ganda dari pointer standar (2 * `usize` atau 16 bytes pada 64-bit).

Fat Pointer ini terdiri dari:
1. **Data Pointer**: Menunjuk ke blok memori objek sebenarnya.
2. **Vtable Pointer**: Menunjuk ke struktur tabel fungsi virtual statis khusus untuk pasangan tipe data konkret dan trait-nya.

Struktur vtable di memori (meski merupakan detail implementasi yang bisa berubah secara teoretis) umumnya memuat:
- Pointer fungsi dekonstruksi (Destructor / Drop).
- Ukuran alokasi memori (size) objek.
- Persyaratan penyelarasan (alignment) objek.
- Deretan pointer-pointer fungsi metod dari trait bersangkutan.

## Diagram ASCII: Trait Object & Vtable Memory Layout

```text
Fat Pointer (&dyn Animal)
+-----------------------+     Alokasi Memori Objek (Contoh: Struct Dog)
| Data Pointer (ptr)  --+---> [ ... field dari struct Dog ... ]
| Vtable Pointer      --+--┐
+-----------------------+  │  Tabel Vtable Statis (Untuk Dog impl Animal)
                           │  +---------------------------+
                           └->| size: 8                   | (ukuran obj)
                              | align: 8                  | (alignment)
                              | destructor (drop_in_place)| (pointer ke fungsi drop)
                              | method: Animal::speak()   | (pointer ke fungsi trait)
                              | method: Animal::move()    |
                              +---------------------------+
```

## Kode Rust Production-Ready

```rust
use std::mem;
use std::ptr;

/// Trait sampel untuk Trait Object
pub trait Animal {
    fn speak(&self) -> String;
}

pub struct Dog {
    pub name: String,
}

impl Animal for Dog {
    fn speak(&self) -> String {
        format!("Woof! My name is {}", self.name)
    }
}

/// Struktur manual untuk membedah Fat Pointer (Representasi `std::raw::TraitObject` deprecation replacement).
/// HARAP PERHATIKAN: Ini mengandalkan detail implementasi ABI compiler.
#[repr(C)]
pub struct TraitObjectComponents {
    pub data: *mut (),
    pub vtable: *mut (),
}

pub unsafe fn inspect_fat_pointer(animal: &dyn Animal) -> TraitObjectComponents {
    // Transmutasi dari &dyn Animal (Fat Pointer) ke struct 2 pointer.
    // Transmute AMAN ukurannya sama persis.
    mem::transmute::<&dyn Animal, TraitObjectComponents>(animal)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fat_pointer_size() {
        // Pointer statis standar ukurannya 1 kata mesin
        assert_eq!(mem::size_of::<&Dog>(), mem::size_of::<usize>());
        
        // Fat Pointer ukurannya 2 kata mesin
        assert_eq!(mem::size_of::<&dyn Animal>(), mem::size_of::<usize>() * 2);
        assert_eq!(mem::size_of::<Box<dyn Animal>>(), mem::size_of::<usize>() * 2);
    }

    #[test]
    fn test_vtable_inspection() {
        let dog1 = Dog { name: "Rex".to_string() };
        let dog2 = Dog { name: "Max".to_string() };

        let dyn_dog1: &dyn Animal = &dog1;
        let dyn_dog2: &dyn Animal = &dog2;

        unsafe {
            let comp1 = inspect_fat_pointer(dyn_dog1);
            let comp2 = inspect_fat_pointer(dyn_dog2);

            // Data pointer pastinya berbeda
            assert_ne!(comp1.data, comp2.data);
            
            // NAMUN, Vtable pointer SAMA PERSIS karena keduanya bertipe `Dog`
            assert_eq!(comp1.vtable, comp2.vtable);
        }
    }
}
```

## Anti-Patterns

1. **Asumsi Transmute Fat Pointer Stabil**
   - **Contoh Buruk**: Melakukan `mem::transmute` dari `*mut dyn Trait` ke tuple `(*mut (), *mut ())` untuk FFI (Foreign Function Interface) C dan mengirimnya melintasi batas sistem operasi/jaringan.
   - **Mengapa berbahaya**: Layout pasti dari Fat Pointer (apakah Data duluan atau Vtable duluan) adalah *detail implementasi* internal Rust, tidak ter-standardisasi secara mutlak. Meski `std::ptr::DynMetadata` memberikan cara legal mengakses vtable, mencoba menduplikasi layout struct vtable secara manual dapat memicu UB pada versi compiler baru.

2. **Memaksa Trait Menjadi Object-Safe**
   - **Contoh Buruk**: Membuat banyak metode mengembalikan `Self` atau memiliki tipe generic di dalam Trait, lalu mati-matian menambahkan batasan trait agar trait menjadi object-safe.
   - **Mengapa berbahaya**: Sebuah trait hanya bisa dijadikan `dyn Trait` (Object-safe) jika compiler dapat membangkitkan (generate) sebuah vtable untuknya. Metode dengan generics (`fn generic<T>(&self)`) memerlukan instansiasi per-tipe tanpa batas, dan ukuran Vtable akan menjadi infinit, sehingga compiler akan melarangnya.

## Edge Cases & Defensive Programming
- **Pointer Downcasting (Any)**: Trait `std::any::Any` menempatkan metode `type_id()` dalam vtable-nya, memungkinkan *downcasting* aman di runtime. Vtable secara internal membawa `TypeId` unik.
- **Multiple Traits (Auto Traits)**: Sebuah Trait Object bisa terdiri dari Trait utama + *Auto Traits* (contoh: `Box<dyn Write + Send + Sync>`). Pointer fat ini tetap hanya berupa dua pointer, Vtable yang di-generate adalah vtable komposit khusus di belakang layar.
- **Upcasting**: Pada fitur masa depan, upcasting (`&dyn SubTrait` ke `&dyn SuperTrait`) memerlukan Vtable untuk membawa informasi (vtable supertrait pointer). Ini menyebabkan struktur Vtable secara internal berubah menjadi *tree-like structure*.
