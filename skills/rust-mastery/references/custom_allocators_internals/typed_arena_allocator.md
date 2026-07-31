# Typed Arena Allocator

Arena alokator (atau region-based allocator) mengalokasikan sekumpulan objek dari tipe yang sama atau berbeda (tergantung implementasi) di blok memori berukuran besar, dan yang krusial, *mendealokasi* semuanya secara bersamaan saat arena dijatuhkan (`drop`). Konsep ini dikelola di Rust menggunakan *lifetime* `'arena`. Crate `typed-arena` secara spesifik mengamankan arena untuk satu tipe tunggal `T`.

Pola ini lazim pada Compiler (AST generation) dan Game Engine (per-frame allocation) di mana objek tidak perlu berumur lebih panjang dari sebuah _phase_ atau _frame_.

## Arsitektur & Alur Kerja

```text
       Typed Arena <T>
       |-- Chunk 1 (T, T, T, T) -> Full
       |-- Chunk 2 (T, T, _, _) -> Active
```
*Ketika `alloc(T)` dipanggil, ia mengembalikan `&'arena mut T`. Arena mengambil kepemilikan struktur data (drop akan dipanggil di akhir) tetapi meminjamkan pointer mutable.*

## Implementasi Production-Ready

```rust
use std::cell::UnsafeCell;
use std::ptr::NonNull;

/// Arena sangat sederhana untuk tipe T (ilustrasi internal)
pub struct SimpleTypedArena<T> {
    // Menyimpan list of chunks
    chunks: UnsafeCell<Vec<Vec<T>>>,
}

impl<T> SimpleTypedArena<T> {
    pub fn new() -> Self {
        Self {
            chunks: UnsafeCell::new(vec![Vec::with_capacity(64)]),
        }
    }

    /// Mengalokasikan nilai T dan mengembalikan referensi dengan
    /// lifetime yang terikat pada eksistensi arena ini.
    pub fn alloc(&self, value: T) -> &mut T {
        unsafe {
            let chunks = &mut *self.chunks.get();
            let mut last = chunks.last_mut().unwrap();
            
            if last.len() == last.capacity() {
                chunks.push(Vec::with_capacity(last.capacity() * 2));
                last = chunks.last_mut().unwrap();
            }
            
            last.push(value);
            // Mengambil elemen terakhir sebagai referensi.
            // AMAN KARENA: Elemen dalam Vec yang tidak pernah me-reallocate (kita kontrol)
            // tidak akan berpindah di memori. (CATATAN: vec bisa realloc! Itulah mengapa 
            // typed-arena sejati menggunakan struktur yang lebih rumit/custom block atau 
            // menjamin elemen tidak pindah dengan membatasi mutasi Vec).
            
            // Implementasi di sini adalah pendekatan naif yang AMAN asalkan 
            // realloc pada capacity == len dilakukan dengan PUSH KE VEC BARU.
            // Karena chunk lama (Vec) tidak lagi disentuh panjangnya, 
            // pointernya tetap stabil sampai arena didrop.
            let ptr = last.as_mut_ptr().add(last.len() - 1);
            &mut *ptr
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq)]
    struct AstNode<'a> {
        val: i32,
        next: Option<&'a AstNode<'a>>,
    }

    #[test]
    fn test_arena_ast_creation() {
        let arena = SimpleTypedArena::new();
        
        let node1 = arena.alloc(AstNode { val: 1, next: None });
        let node2 = arena.alloc(AstNode { val: 2, next: Some(node1) });
        
        assert_eq!(node2.val, 2);
        assert_eq!(node2.next.unwrap().val, 1);
    } // Di sini memori seluruh arena didealokasi O(1).
}
```

## Anti-Pattern Terlarang

1. **Lifetime Elision yang Menipu pada Arena:**
   *Mengapa berbahaya:* Mencoba menyimpan pointer/reference `&'a T` dari arena ke dalam struktur data berumur statik (global). Rust borrow checker akan memblokir ini. Jangan gunakan `transmute` untuk memperpanjang `'arena` menjadi `'static`, itu jaminan *Use-After-Free* (UAF) ketika arena di-drop.
2. **Reallocation Memori di Internal Storage:**
   *Mengapa berbahaya:* Menyimpan objek di dalam `Vec` dan membiarkan `Vec` itu melakukan "grow" (realloc). Realloc akan memindahkan memori ke alamat baru, membuat semua reference `&mut T` yang pernah dikeluarkan arena menjadi dangling. *Selalu alokasikan chunk baru alih-alih me-resize chunk lama.*

## Edge Cases & Defensive Programming

- **Drop Semantics (`Drop` trait pada `T`):** Arena harus memanggil method `.drop()` dari semua elemen `T` di dalamnya jika `T` mengimplementasikan `Drop` (misal `T` memiliki `String` di dalamnya). Jika tidak, memory leak (atau resource leak) pada *nested allocations* akan terjadi.
- **Cycles in Graphs:** Referensi antar node di arena sering kali membuat *cycle* (misal Graph berarah bolak-balik). Jika Anda menggunakan `RefCell` dan arena, cycle tidak membocorkan memori selama arena itu sendiri didrop di akhir. Arena menyelamatkan Anda dari cycle berbasis `Rc`/`Arc`.
