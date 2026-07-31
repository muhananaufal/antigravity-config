# Pinning & Structural Projections

## Konsep Utama
Di Rust, tipe secara default dapat dipindahkan (*movable*) dengan bebas di memori. Namun, beberapa tipe sangat mengandalkan fakta bahwa lokasinya di memori **tidak boleh berubah**. Contohnya adalah *self-referential structs* (seperti state machine pada `async/await`), yang menyimpan referensi ke *field* di dalam dirinya sendiri. Jika memori tersebut dipindahkan, referensi internal tersebut akan menjadi *dangling pointer*. 

Crate `std::pin` menyediakan tipe pintar `Pin<P>`. Ketika `P` mengimplementasikan `Deref<Target = T>`, `Pin` memastikan bahwa `T` tidak akan pernah pindah dari lokasinya saat ini (kecuali ia mengimplementasikan trait marker `Unpin`).

- **Structural Pinning**: Akses pin untuk mendapatkan nilai pin dari field (e.g. `Pin<&mut Struct>` -> `Pin<&mut Field>`).
- **Non-Structural Pinning**: Akses biasa tanpa pin (e.g. `Pin<&mut Struct>` -> `&mut Field`).

**Kapan Digunakan:**
- Implementasi `Future` manual (State Machine asinkron).
- Struktur Intrusive Doubly Linked Lists atau Graph node.

## Arsitektur & Aliran: Pin vs Move Semantics
```ascii
[ State Machine Future ]          | [ Pinned State Machine ]
x: [ Data = 42 ] <-+              | x: [ Data = 42 ] <-+
y: [ &x ] ---------+              | y: [ &x ] ---------+
      |                           |       |
    (Move / assignment)           |     (Move DILARANG oleh API Pin)
      v                           |
[ Lokasi Memori Baru ]            |
x: [ Data = 42 ]                  |
y: [ &x ] ---> Menunjuk ke memori |
               LAMA (Dangling!)   |
```

## Kode Production-Ready
Di *production*, makro `pin-project` digunakan untuk membuat *structural pinning* dengan aman secara otomatis. Berikut adalah cara menulisnya dengan API `unsafe` murni untuk memahami *under-the-hood*.

```rust
use std::pin::Pin;
use std::marker::PhantomPinned;
use std::ptr::NonNull;

/// Node untuk Intrusive Linked List (Self-Referential).
/// Tidak boleh dipindahkan setelah dipin.
pub struct Node {
    data: usize,
    next: Option<NonNull<Node>>,
    // Memaksa struct ini menjadi !Unpin (unmovable)
    _pin: PhantomPinned,
}

impl Node {
    pub fn new(data: usize) -> Self {
        Self {
            data,
            next: None,
            _pin: PhantomPinned,
        }
    }

    /// Structural projection kustom yang aman:
    /// Menghasilkan referensi mutable BUKAN ter-pin pada data.
    /// Ini aman karena `data` bukan merupakan bagian dari self-referential graph.
    pub fn project_data(self: Pin<&mut Self>) -> &mut usize {
        // SAFETY: Node data tidak mengandalkan alamat pin untuk validitasnya.
        unsafe {
            let mut_ref: &mut Node = Pin::get_unchecked_mut(self);
            &mut mut_ref.data
        }
    }

    /// Menghubungkan node ini dengan node lain.
    pub fn set_next(self: Pin<&mut Self>, next_node: Pin<&mut Node>) {
        let next_ptr = NonNull::from(unsafe { Pin::get_unchecked_mut(next_node) });
        // SAFETY: Memodifikasi state internal dari pointer.
        unsafe {
            let mut_ref: &mut Node = Pin::get_unchecked_mut(self);
            mut_ref.next = Some(next_ptr);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::boxed::Box;

    #[test]
    fn test_pinned_nodes() {
        // Alokasikan ke heap dan Pin
        let mut node1 = Box::pin(Node::new(1));
        let mut node2 = Box::pin(Node::new(2));

        // Panggil metode pada tipe ter-pin
        node1.as_mut().set_next(node2.as_mut());

        // Mengubah data tanpa melanggar pin
        let data1 = node1.as_mut().project_data();
        *data1 = 100;
        
        assert_eq!(node1.data, 100);
    }
}
```

## Anti-Patterns

### 1. Memanggil `get_unchecked_mut` pada Tipe yang Bisa Dimove
**Bahaya:** Mengambil `&mut T` dari `Pin<&mut T>` menggunakan `unsafe { Pin::get_unchecked_mut() }`, kemudian memindahkan atau menukar isinya dengan `std::mem::swap`. Ini menghancurkan seluruh garansi memori.
**Solusi:** Hanya panggil `get_unchecked_mut` saat mengimplementasikan API internal yang menjamin objek tak akan pindah, atau gunakan crate `pin-project`.

```rust
// ANTI-PATTERN
use std::pin::Pin;

fn destroy_pin<T>(pinned: Pin<&mut T>, new_val: &mut T) {
    // unsafe {
    //     let mut_ref = Pin::get_unchecked_mut(pinned);
    //     std::mem::swap(mut_ref, new_val); // PIN TERLANGGAR! UB jika tipe self-referential.
    // }
}
```

### 2. Implementasi Manual `Unpin` pada Tipe Berbahaya
**Bahaya:** Secara sadar/ceroboh mengimplementasikan trait `Unpin` pada struct yang berisi data *self-referential*. `Unpin` memberikan hak legal bagi *caller* untuk mengubah lokasi.

## Edge Cases & Defensive Engineering
- **Drop Guarantee:** Saat membuat tipe `!Unpin`, Anda harus sangat berhati-hati pada saat `Drop`. Jika objek di-*drop*, referensi yang bergantung padanya akan tidak valid. Jika Anda menulis *custom* `Drop` untuk tipe ter-pin, `&mut self` yang diterima drop **bisa saja* sudah dipindahkan jika pin-nya diciptakan secara sewenang-wenang (namun pin guarantee memastikan ia dipin *sampai hancur*). Hindari membuat `Pin` pada stack secara manual via `Pin::new_unchecked`; gunakan makro `pin_mut!` standar.
