# Interior Mutability & Cell Types

## Konsep Utama
Interior Mutability adalah pola desain di Rust yang memungkinkan mutasi data melalui reference *immutable* (`&T`). Ini mem-bypass aturan compiler yang mengharuskan `&mut T` untuk mutasi, namun memindahkan pengecekan dari waktu kompilasi (compile-time) ke waktu jalan (runtime).
- `UnsafeCell<T>`: Blok pembangun dasar semua tipe interior mutability. Tidak aman (unsafe).
- `Cell<T>`: Untuk tipe yang mengimplementasikan `Copy`. Meng-copy nilai masuk/keluar. Tidak ada panic.
- `RefCell<T>`: Melacak peminjaman dinamis (dynamic borrow) saat runtime. Bisa panic jika aturan dilanggar.
- `Mutex<T>` / `RwLock<T>`: Ekivalen `RefCell` yang aman untuk multi-threading (thread-safe).
- `OnceCell` / `OnceLock`: Untuk inisialisasi tertunda (lazy initialization) sekali jalan.

**Kapan Digunakan:**
Mutasi logikal saat immutability struktural diwajibkan (misalnya dalam trait objects `&self`), cache memoization, dan memanipulasi graph/DOM trees di thread yang sama atau berbeda.

## Arsitektur / Flow
```text
Borrow State (RefCell):
[ Unborrowed (0) ] <--- borrow() ---> [ Shared (>0) ]
       |                                   |
    borrow_mut()                        borrow_mut() (PANICS/FAILS)
       v                                   v
[ Exclusive (-1) ] <--- borrow() --->   (PANICS/FAILS)
```

## Implementasi Production-Ready

```rust
use std::cell::{RefCell, Cell};
use std::sync::{OnceLock, Mutex};
use std::rc::Rc;

/// Cache sistem yang menggunakan RefCell untuk interior mutability.
pub struct MemoizedCache {
    // Cell untuk statistik sederhana (Copy data)
    hits: Cell<usize>,
    // RefCell untuk koleksi dinamis (Non-copy data)
    store: RefCell<std::collections::HashMap<String, String>>,
}

impl MemoizedCache {
    pub fn new() -> Self {
        Self {
            hits: Cell::new(0),
            store: RefCell::new(std::collections::HashMap::new()),
        }
    }

    /// Perhatikan: signature menerima `&self`, BUKAN `&mut self`
    pub fn get_or_insert(&self, key: &str, compute: impl FnOnce() -> String) -> String {
        // Defensive: try_borrow() daripada borrow() untuk menghindari runtime panics
        if let Ok(store) = self.store.try_borrow() {
            if let Some(val) = store.get(key) {
                self.hits.set(self.hits.get() + 1); // Mutasi via Cell
                return val.clone();
            }
        }
        
        let new_val = compute();
        if let Ok(mut store) = self.store.try_borrow_mut() {
            store.insert(key.to_string(), new_val.clone());
        }
        new_val
    }

    pub fn get_hits(&self) -> usize {
        self.hits.get()
    }
}

// Global thread-safe OnceLock
static GLOBAL_CONFIG: OnceLock<Mutex<String>> = OnceLock::new();

pub fn init_config(val: String) {
    let _ = GLOBAL_CONFIG.set(Mutex::new(val));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_memoized_cache() {
        let cache = MemoizedCache::new();
        let val1 = cache.get_or_insert("key1", || "value1".to_string());
        assert_eq!(val1, "value1");
        assert_eq!(cache.get_hits(), 0);

        let val2 = cache.get_or_insert("key1", || "value2".to_string());
        assert_eq!(val2, "value1"); // Harus mengembalikan dari cache
        assert_eq!(cache.get_hits(), 1);
    }
}
```

## Anti-Patterns

1. **Menahan `RefMut` Terlalu Lama:**
   Memanggil `borrow_mut()` dan menyimpannya ke dalam variabel untuk digunakan melintasi operasi yang kompleks atau panggilan fungsi lain.
   *Mengapa Berbahaya:* Meningkatkan risiko tinggi panggilan `borrow()` atau `borrow_mut()` lain di tempat yang sama, yang akan menyebabkan aplikasi *Panic* di runtime.

2. **Menggunakan `RefCell` di Multi-Threaded Context (atau `Mutex` jika Single-Threaded):**
   *Mengapa Berbahaya:* `RefCell` tidak mengimplementasikan `Sync`. Jika dipaksa, akan menyebabkan data race. Sebaliknya, menggunakan `Mutex` di aplikasi single-threaded membuang resource karena overhead syscall untuk locking.

## Edge Cases & Defensive Engineering
- **Poisoning pada Mutex:** Jika sebuah thread *panic* saat memegang lock `Mutex`, Mutex menjadi "poisoned". Pemanggilan `lock()` berikutnya akan mengembalikan `Err`. Gunakan defensif `.lock().unwrap_or_else(|poisoned| poisoned.into_inner())` jika Anda tahu data parsial masih aman digunakan.
- **Deadlocks:** `RwLock` memungkinkan multiple readers. Namun, memanggil `read()` dua kali di thread yang sama dengan penulis (writer) menunggu lock dapat memicu deadlock pada sistem operasi tertentu. Selalu batasi scope lock (`{ let lock = ...; }`).
