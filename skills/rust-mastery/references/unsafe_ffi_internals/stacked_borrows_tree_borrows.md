# Stacked Borrows & Tree Borrows Aliasing Models

## Konsep Utama
Rust menjamin memori yang bebas dari *data race* dengan aturan ketat: Anda boleh memiliki banyak referensi _immutable_ (`&T`), ATAU tepat satu referensi _mutable_ (`&mut T`), tetapi tidak keduanya.

Di bawah kap, untuk `unsafe` code yang menggunakan *raw pointers*, kompilator menggunakan model formal seperti **Stacked Borrows (SB)** atau penerusnya, **Tree Borrows (TB)**, untuk memvalidasi *aliasing*. Setiap alokasi memori melacak "tumpukan" pointer yang berhak membaca/menulis memori tersebut.
Jika sebuah pointer di bawah tumpukan ditimpa / dicabut haknya oleh pointer di atasnya (misal referensi mutable baru tercipta), menggunakan pointer lama memicu Undefined Behavior (UB).

**Kapan Digunakan:**
- Interoperabilitas kompleks FFI.
- *Memory allocators* kustom atau pool manager.
- Struktur data dengan banyak pointer mutabel bersamaan (Trees, Graphs).

## Arsitektur & Aliran: Stacked Borrows
```ascii
[ Alokasi X ]
  |
  +-- [ &mut X ] (Tag 1, Status: Unique)  <-- Pointer Utama (Akar)
        |
        +-- [ *mut X ] (Tag 2, Status: Shared Read/Write) <-- Raw Pointer 1
        |
        +-- [ *mut X ] (Tag 3, Status: Shared Read/Write) <-- Raw Pointer 2
        |
        +-- [ &mut X ] (Tag 4, Status: Unique) <-- Referensi Mutabel Baru
            (Mematikan Tag 2 dan 3 karena mensyaratkan Uniqueness!)
```

## Kode Production-Ready
Contoh cara mendesain iterasi _raw pointer_ secara berdampingan tanpa melanggar *Stacked Borrows*, yang dapat diuji dengan `cargo miri test`.

```rust
pub struct RawIter<'a, T> {
    current: *mut T,
    end: *mut T,
    _marker: std::marker::PhantomData<&'a mut [T]>,
}

impl<'a, T> RawIter<'a, T> {
    pub fn new(slice: &'a mut [T]) -> Self {
        // Ambil pointer base.
        // Slice diubah ke raw pointer (Tag dialihkan ke Raw).
        let ptr = slice.as_mut_ptr();
        let len = slice.len();
        
        // SAFETY: Pointer tidak melewati memori + 1
        let end = unsafe { ptr.add(len) };

        Self {
            current: ptr,
            end,
            _marker: std::marker::PhantomData,
        }
    }
}

impl<'a, T> Iterator for RawIter<'a, T> {
    type Item = &'a mut T;

    fn next(&mut self) -> Option<Self::Item> {
        if self.current == self.end {
            None
        } else {
            let old_curr = self.current;
            // SAFETY: Iterasi maju tidak melanggar batasan ujung
            unsafe {
                self.current = self.current.add(1);
            }
            // SAFETY: Tag dipinjam dari slice original secara terpisah
            // dan tidak saling menimpa karena referensi unik menunjuk item berbeda.
            Some(unsafe { &mut *old_curr })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_raw_iter() {
        let mut data = vec![1, 2, 3];
        let mut iter = RawIter::new(&mut data);
        
        let a = iter.next().unwrap();
        let b = iter.next().unwrap();
        
        *a = 10;
        *b = 20;
        
        assert_eq!(*a, 10);
        assert_eq!(*b, 20);
    }
}
```

## Anti-Patterns

### 1. Overlapping `&mut` lewat Raw Pointers
**Bahaya:** Mengambil satu pointer memori, me-cast-nya menjadi DUA `&mut T` yang independen pada scope yang sama. Kompilator Rust mengoptimalkan dengan asumsi bahwa setiap `&mut` adalah mutlak milik pribadi. Jika hal ini dilanggar, UB langsung terjadi.
**Solusi:** Batasi konversi `*mut` ke `&mut` sesingkat mungkin.

```rust
// ANTI-PATTERN
let mut x = 42;
let p = &mut x as *mut i32;
// unsafe {
//     let mut1 = &mut *p;
//     let mut2 = &mut *p; // UB! Melanggar keunikan mutable reference.
//     *mut1 = 1;
//     *mut2 = 2;
// }
```

### 2. Memanipulasi Raw Pointer melewati Reference
**Bahaya:** Menciptakan Raw Pointer dari sebuah *binding*, tetapi secara berbarengan mengubah atau meminjam binding aslinya secara langsung. Stacked Borrows akan mencabut hak pointer mentah begitu data diakses lagi secara mutabel.

```rust
// ANTI-PATTERN
let mut val = 0;
let ptr = &mut val as *mut i32;

val = 10; // Ini menegaskan ulang kepemilikan. Stacked Borrows membuang hak `ptr`.

// unsafe { *ptr = 20; } // UB! `ptr` sudah invalid (dangling tag).
```

## Edge Cases & Defensive Engineering
- **Interior Mutability:** Jika Anda membutuhkan aliasing legal, selalu bungkus dalam `UnsafeCell<T>`. Tipe ini secara eksplisit memberi tahu *compiler* (dan Stacked Borrows) bahwa _pointer aliasing_ dapat diekspektasikan pada blok memori tersebut, dan menonaktifkan optimasi berbasis keunikan. Semua primitive seperti `Mutex` atau `RefCell` dibangun dari `UnsafeCell`.
