# Smart Pointers & Memory Layout

## Konsep Utama
Smart Pointers adalah struktur data yang tidak hanya menyimpan memori (seperti pointer biasa), tetapi memiliki metadata tambahan dan kemampuan (seperti alokasi heap, reference counting, dan manajemen siklus hidup via `Drop`). 
- `Box<T>`: Single ownership di heap.
- `Rc<T>` / `Arc<T>`: Shared ownership via reference counting (single / multi-threaded).
- `Weak<T>`: Non-owning reference untuk memecah siklus `Rc`/`Arc`.
- `Deref` / `DerefMut`: Mengizinkan smart pointer bertindak seperti reference biasa melalui coercion.
- `#[repr(transparent)]`: Menjamin struct memiliki representasi memori yang sama persis dengan field tunggalnya, vital untuk FFI dan custom smart pointers.

**Kapan Digunakan:**
Membangun struktur data rekursif (mis. Trees, Graphs), berbagi state di seluruh thread (Arc), dan FFI interop.

## Arsitektur / Flow
```text
Arc<T> Memory Layout di Heap:
+-------------------+
| strong_count: 2   |  <-- Arc 1
| weak_count: 1     |  <-- Arc 2
| data: T           |  <-- Weak 1
+-------------------+
```

## Implementasi Production-Ready

```rust
use std::sync::{Arc, Weak, Mutex};
use std::ops::{Deref, DerefMut};

/// Custom Smart Pointer dengan #[repr(transparent)]
/// Berguna untuk FFI atau Zero-cost abstraction wrappers
#[repr(transparent)]
pub struct SafeString(String);

impl Deref for SafeString {
    type Target = String;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for SafeString {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

/// Contoh manajemen Graph dengan Arc dan Weak untuk menghindari Memory Leak
#[derive(Debug)]
pub struct Node {
    pub value: i32,
    pub parent: Mutex<Option<Weak<Node>>>,
    pub children: Mutex<Vec<Arc<Node>>>,
}

impl Node {
    pub fn new(value: i32) -> Arc<Node> {
        Arc::new(Node {
            value,
            parent: Mutex::new(None),
            children: Mutex::new(vec![]),
        })
    }

    pub fn add_child(parent: &Arc<Node>, child: &Arc<Node>) {
        let mut children = parent.children.lock().unwrap();
        let mut child_parent = child.parent.lock().unwrap();
        *child_parent = Some(Arc::downgrade(parent));
        children.push(Arc::clone(child));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_transparent_deref() {
        let mut s = SafeString(String::from("Hello"));
        s.push_str(" World"); // DerefMut coercion
        assert_eq!(s.len(), 11); // Deref coercion
    }

    #[test]
    fn test_arc_weak_cycle() {
        let parent = Node::new(1);
        let child = Node::new(2);
        
        Node::add_child(&parent, &child);
        
        assert_eq!(Arc::strong_count(&parent), 1);
        assert_eq!(Arc::strong_count(&child), 2); // 1 dari variable, 1 dari parent.children
        
        // Memastikan weak reference parent bisa di-upgrade
        let p_lock = child.parent.lock().unwrap();
        let upgraded_parent = p_lock.as_ref().unwrap().upgrade().unwrap();
        assert_eq!(upgraded_parent.value, 1);
    }
}
```

## Anti-Patterns

1. **Membuat Cycle dengan `Rc`/`Arc`:**
   Menghubungkan dua objek `Arc` secara langsung satu sama lain.
   *Mengapa Berbahaya:* Reference count tidak akan pernah mencapai 0. Ini adalah memory leak absolut di Rust, karena `Drop` tidak akan pernah dipanggil.

2. **Clone berlebihan pada `Box<T>`:**
   Melakukan `Box::clone` alih-alih memberikan reference `&T`.
   *Mengapa Berbahaya:* `Box::clone` melakukan deep copy dan alokasi heap baru, menghancurkan performa. Gunakan `Arc` jika shared ownership benar-benar diperlukan, atau gunakan `&T`.

## Edge Cases & Defensive Engineering
- **Drop Order:** Variabel di-drop dalam urutan terbalik dari deklarasi (LIFO), dan field struct di-drop dalam urutan deklarasi (FIFO). Jika smart pointer bergantung pada urutan drop (misal mengunci/melepas resource), perhatikan urutan deklarasi.
- **Deref Coercion Chain:** Rust akan terus memanggil `deref()` sampai menemukan metode yang cocok. Namun, jika Anda memiliki tipe bersarang panjang seperti `Arc<Mutex<Box<T>>>`, coercion mungkin lambat atau gagal menebak metode dengan benar. Gunakan pemanggilan eksplisit jika ambigu.
