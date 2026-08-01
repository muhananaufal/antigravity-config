# Typed Arena Allocator

Dalam manipulasi graf data yang intensif seperti Abstract Syntax Tree (AST) Compiler atau Tree DOM HTML, Rust's ownership system konvensional (`Box`, `Rc`, `RefCell`) mengenalkan masalah masif berupa **overhead siklus referensi (Reference Cycles)** dan cost dari pointer atomic yang memperlambat traversasi hierarkis node (misalnya `Rc` cache-line bouncing).

Sistem **Typed Arena Allocator** (via crate seperti `typed-arena` atau implementasi kustom) menyingkirkan siklus alokasi individu dengan cara menampung koleksi node di blok besar terpusat (Bump Pointer). Karena semua elemen *dialokasikan di arena, dan dihapus ketika arena mati secara bersamaan (Zero-Deallocation overhead)*, ini memungkinkan perujukan referensi konvensional (cycles) lewat reference lifetime biasa tanpa memerlukan `Rc` atau `RefCell`.

## Arsitektur Typed Arena & Graph Referencing

```ascii
[ Standard Rc/RefCell Graph ]
    (Node 1) <----(Rc)----> (Node 2)
       ^                       | (Memory Leak Risk / Cycle)
       +---------(Rc)----------+

[ Arena Graph dengan Referensi Native `&` ]
   +---------------------------------------------+
   |  Arena Allocator (Lifetime 'a)              |
   |                                             |
   |  (Node 1) <----(&'a)----> (Node 2)          |
   |     ^                        | (No cycle    |
   |     +-----------(&'a)--------+  leak risk!) |
   |                                             |
   +---------------------------------------------+
    (Arena Drop -> Seluruh node dihapus seketika)
```

## Produksi-Ready Code: Graph Terarah menggunakan Typed Arena

Kode ini menunjukkan struktur Directed Graph (Graph Berarah) yang memungkinkan referensi cyclic dengan cara elegan (menggunakan `Cell` interior mutability) dalam ekosistem arena-allocated, sangat cepat dan 100% aman memori (safe).

```rust
use std::cell::Cell;
// Kita meng-mock typed_arena untuk keperluan standar produksi referensi
// Pada Production Cargo.toml: `typed-arena = "2.0"`
pub mod mock_typed_arena {
    use std::cell::RefCell;
    pub struct Arena<T> {
        // Implementasi sederhana untuk simulasi
        chunks: RefCell<Vec<Box<T>>>,
    }
    impl<T> Arena<T> {
        pub fn new() -> Self {
            Self { chunks: RefCell::new(Vec::new()) }
        }
        // Fungsi kunci Typed Arena:
        // Menerima nilai, mengembalikan referensi dengan lifetime yang terikat ke Arena.
        pub fn alloc(&self, value: T) -> &mut T {
            let mut boxed = Box::new(value);
            // SAFETY: Konversi pointer ke mut ref, aman karena nilai dijamin eksis
            // sepanjang Arena eksis dan tidak di-reallokasi.
            let ptr: *mut T = &mut *boxed;
            self.chunks.borrow_mut().push(boxed);
            unsafe { &mut *ptr }
        }
    }
}
use mock_typed_arena::Arena;

/// Node dalam graph kita
pub struct Node<'a> {
    pub name: &'static str,
    // Kita gunakan rentetan referensi lifetime 'a yang terhubung kembali ke parent atau anak
    pub children: Cell<Vec<&'a Node<'a>>>,
    pub parent: Cell<Option<&'a Node<'a>>>,
}

impl<'a> Node<'a> {
    pub fn new(name: &'static str) -> Self {
        Self {
            name,
            children: Cell::new(Vec::new()),
            parent: Cell::new(None),
        }
    }

    pub fn add_child(&'a self, child: &'a Node<'a>) {
        let mut kids = self.children.take();
        kids.push(child);
        self.children.set(kids);
        child.parent.set(Some(self));
    }
}

/// Mensimulasikan pipeline pembangunan Graph dalam Arena
pub fn build_cyclic_graph() {
    // 1. Inisiasi arena memory pool
    let arena = Arena::new();

    // 2. Alokasikan node-node (semua dikembalikan sebagai &'a Node)
    let root = arena.alloc(Node::new("Root"));
    let child1 = arena.alloc(Node::new("Child_1"));
    let child2 = arena.alloc(Node::new("Child_2"));

    // 3. Bangun graph
    root.add_child(child1);
    root.add_child(child2);

    // Bikin referensi cyclic: child2 adalah anak dari child1 (misal Tree graph ruwet)
    child1.add_child(child2); 
    
    assert_eq!(root.name, "Root");
    let c1_kids = child1.children.take();
    assert_eq!(c1_kids[0].name, "Child_2");
    
    // Semua memory clean up otomatis, tidak ada leak, tidak ada drop iteratif lambat
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_graph_arena_building() {
        build_cyclic_graph();
    }
}
```

## Anti-Patterns

1. **Mencampur Memory Types dalam Arena (Struct Arena Polymorphic/Dynamic)**
   **Mengapa berbahaya:** Jika Anda menggunakan tipe `Arena<Box<dyn Trait>>` atau mencoba mengalokasikan tipe `String` ukuran acak dalam `typed-arena` statis, allocator ini akan mengalokasikan pointer-nya di Arena (super cepat), namun nilai dinamis *sebenarnya* tetap di global heap via `malloc` (lambat). Ini *false sense of security*, dan saat Arena drop, kompilator tetap harus memanggil puluhan ribu destruktor `Drop::drop` pada `String`, menghilangkan utilitas nol-deallokasi dari arena.
   **Solusi:** Gunakan string statis `&str` (seperti contoh `&'static str` atau Bumpalo string allocator).

2. **Memaksakan `RefCell` pada Node Arena**
   **Mengapa berbahaya:** Banyak developer menggunakan pola `RefCell<ArenaNode>` di dalam Arena. Namun, `RefCell` menambah overhead *runtime borrow checking* integer per node. Di graph jutaan node, iterasi DFS/BFS akan melambat 30-40% karena branch prediction CPU hancur akibat pengecekan runtime RefCell.
   **Solusi:** Gunakan `Cell` untuk memodifikasi field-field simpel interior tanpa cost (zero-cost abstraction di CPU), seperti pointer atau boolean flags, sehingga traversal murni baca.

## Edge Cases dan Defensive Programming

1. **Miskalkulasi Drop dan Lifetime Mismatch:**
   Typed-arena menjamin referensi Anda (`&'a T`) valid selama struct Arena eksis. Namun jika instance Arena dan Graph (yang menyimpan referensi `&'a`) diletakkan berbarengan dalam struct yang *sama* tanpa berhati-hati dengan drop order Rust, kompilator akan membentak Anda: *Cannot borrow self.arena while it is owned*. Anda harus mendefinisikan *self-referencing struct* yang butuh trik Unsafe atau macro Ouroboros.

2. **Panik saat Iterator `take()` Interior Mutability:**
   Dalam contoh di atas `Cell<Vec<&'a Node>>`, metode `.take()` memindahkan (move) data keluar dari `Cell`, meninggalkan state "kosong" sementara. Jika saat data tersebut diproses terjadi kepanikan (Panic/Unwind) atau error awal return, modifikasi iteratif gagal di-set kembali ke node. Node itu menjadi korup di graph logic.

3. **Memory Pegging karena Ketiadaan Deallokasi:**
   Arena allocator **TIDAK PERNAH** membebaskan memori sebelum Arena-nya di-drop. Jika Anda memiliki web socket connection yang berjalan 7 hari, dan mere-parsing pesan masuk serta menaruhnya di dalam satu *Long-Lived Arena*, proses Anda akan OOM dalam satu malam. Gunakan arena secara generasional (buat arena baru per request atau per frame batching), dan hancurkan sesegera mungkin.
