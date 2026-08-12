# Higher-Ranked Trait Bounds (HRTB) & GATs

## Konsep Utama
GATs (*Generic Associated Types*) ditambahkan pada Rust 1.65+ untuk mengizinkan tipe terasosiasi dalam trait agar dapat memiliki tipe generik atau parameter masa hidup (*lifetime*) mereka sendiri. Sebelumnya, Rust kurang mendanai fungsionalitas mirip HKT (*Higher-Kinded Types*) ini. 
Dengan GAT, Anda bisa mendefinisikan *Lending Iterator*, di mana item yang dikembalikan oleh iterator hanya hidup sepanjang rentang waktu iterator itu sendiri (mengembalikan referensi yang dipinjam dari iterator, bukan data terpisah). 
Untuk mendukung tipe yang bergantung pada masa hidup dinamis ini, kita menggunakan sintaks HRTB (`for<'a>`), yang memberi tahu compiler bahwa trait tersebut berlaku untuk **SEMUA** masa hidup yang memungkinkan.

**Penggunaan di Proyek Nyata:**
Memproses streaming array (*windowing/chunks*) yang berjalan zero-copy di mana buffer yang sama digunakan secara berulang (misalnya iterasi pembacaan file dari disk, parsing data network streaming), dan abstraction library untuk *smart pointers*.

## Arsitektur GAT & Lending Iterator
```text
 Standar Iterator                       Lending Iterator (GAT)
 trait Iterator {                       trait LendingIterator {
    type Item;                             type Item<'a> where Self: 'a;
    fn next(&mut self)                     fn next<'a>(&'a mut self) 
      -> Option<Self::Item>;                 -> Option<Self::Item<'a>>;
 }                                      }

 [Buffer: Vec]                          [Buffer: Vec]
   \                                      \
    \-- Item 1 (Owned)                     \-- &Item 1 (Meminjam buffer)
    \-- Item 2 (Owned)                     \-- &Item 2 (Meminjam buffer)
```

## Production-Ready Rust Code

```rust
/// Trait ini meniru iterator namun meminjam dari struktur internal
/// dengan menggunakan Generic Associated Type (GAT).
pub trait LendingIterator {
    // Parameter masa hidup '<'a>' melekat pada Tipe Asosiasi!
    type Item<'a>
    where
        Self: 'a; // Syarat: Iterator harus hidup minimal sepanjang 'a

    // Metode next() memberikan lifetime 'a yang terkait langsung
    // dengan referensi mutable `&'a mut self`.
    fn next<'a>(&'a mut self) -> Option<Self::Item<'a>>;
}

// ---------------------------------------------------------
// Implementasi: Buffer Pembacaan Window 
// (Streaming zero-copy)
// ---------------------------------------------------------
pub struct WindowsMut<'slice, T> {
    slice: &'slice mut [T],
    window_size: usize,
    start: usize,
}

impl<'slice, T> WindowsMut<'slice, T> {
    pub fn new(slice: &'slice mut [T], window_size: usize) -> Self {
        assert!(window_size > 0, "Window size must be greater than 0");
        Self { slice, window_size, start: 0 }
    }
}

// Implementasi GAT
impl<'slice, T> LendingIterator for WindowsMut<'slice, T> {
    // 'a mengikat masa hidup item pada panggilan `next()` tertentu
    type Item<'a> = &'a mut [T] where Self: 'a;

    fn next<'a>(&'a mut self) -> Option<Self::Item<'a>> {
        if self.start + self.window_size > self.slice.len() {
            return None;
        }

        // Pointer cast/transmute aman karena iterasi ini dijamin
        // tidak akan merilis referensi aliasing secara bersamaan.
        // Di Rust 1.70+, ini umum dipakai di arsitektur sistem.
        let slice = unsafe {
            let ptr = self.slice.as_mut_ptr().add(self.start);
            std::slice::from_raw_parts_mut(ptr, self.window_size)
        };
        
        self.start += 1;
        Some(slice)
    }
}

// ---------------------------------------------------------
// HRTB (for<'a>) - Higher-Ranked Trait Bounds
// ---------------------------------------------------------
/// Menerima tipe apapun yang mematuhi LendingIterator di semua lifetimes!
pub fn process_lender<L>(mut lender: L)
where
    // Ini berarti "Untuk setiap lifetime 'a, L harus memiliki LendingIterator"
    L: for<'a> LendingIterator<Item<'a> = &'a mut [i32]>,
{
    while let Some(window) = lender.next() {
        // Melakukan mutasi pada buffer yang dipinjam secara bergilir
        window[0] *= 2; 
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gat_lending_iterator() {
        let mut data = vec![1, 2, 3, 4];
        {
            let iter = WindowsMut::new(&mut data, 2);
            process_lender(iter);
        }
        
        // Elemen index 0, 1, 2 ter-mutasi masing-masing dua kali 
        // selama iterasi sliding window
        assert_eq!(data, vec![2, 4, 6, 4]);
    }
}
```

## Anti-Patterns Spesifik
1. **Lifetime Parameter Leakage ke Trait Level**: Mendeklarasikan trait seperti `trait Iterator<'a> { type Item = &'a str; }` bukan sebagai GAT `type Item<'a> = &'a str;`.
   - *Mengapa berbahaya:* Mengikat lifetime `'a` pada Trait berarti *keseluruhan* objek struct terikat pada satu peminjaman *immutable* di awal, sehingga Anda tidak dapat memanggil `next()` dalam loop (karena `&mut self` eksklusif diblokir). Ini menghancurkan pola streaming mutabel.
2. **Missing `where Self: 'a`**: Menggunakan `type Item<'a>;` pada definisi trait tanpa klausul bound ke `Self`.
   - *Mengapa berbahaya:* Kompiler akan protes/menolak (*GAT lifetime bounds missing*) karena ini secara teoritis mengizinkan Item yang memiliki masa hidup tak terikat yang hidup melampaui referensi internal Iterator, membahayakan sistem keamanan memori dan menjebol analisis *borrow checker*.

## Edge Cases & Defensive Engineering
- **Associated Type Defaults**: Ketika merancang library yang kuat, Anda bisa memberikan *default* pada GAT: `type Error<'a> = std::io::Error where Self: 'a;`. Ini membantu kompabilitas rilis API sehingga implementor lama tidak patah saat API internal Anda berkembang.
- **Batasan Koleksi**: Iterator yang meminjam state (Lending Iterators) *TIDAK BISA* digunakan pada metode konvensional seperti `.collect::<Vec<_>>()` karena tidak mungkin memiliki Vec berisi referensi memori mutable (`&mut`) yang ber-overlap (overlapping mutable references) dalam satu waktu.
