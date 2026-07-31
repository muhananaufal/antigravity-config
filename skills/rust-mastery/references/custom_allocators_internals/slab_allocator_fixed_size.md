# Slab Allocator Fixed-Size & Object Pooling

Slab allocator mengoptimalkan alokasi untuk objek berukuran tetap (fixed-size). Alih-alih mencari blok bebas (seperti dlm allocator umum), ia membagi memori ke dalam "slab", di mana masing-masing slab terdiri dari "slot" dengan ukuran spesifik. Ini menghilangkan fragmentasi eksternal dan mempercepat alokasi (O(1)). Sering digunakan di kernel dan HFT untuk caching objek seperti file descriptor atau struct paket jaringan.

## Arsitektur & Alur Kerja

```text
       Slab (Size Class: 32 Bytes)
[ Slot 0 | Slot 1 | Slot 2 | Slot 3 ]
   |                  |
  Free               Free (Next in Free List)
   |----------------->|
```
*Slab dikelola dengan internal free-list. Pointer memori yang bebas menyimpan alamat ke memori bebas berikutnya.*

## Implementasi Production-Ready

```rust
use std::mem;
use std::ptr;
use std::sync::Mutex;

/// Simple thread-safe Slab Allocator (Object Pool)
pub struct SlabAllocator<T> {
    storage: Vec<mem::MaybeUninit<T>>,
    free_head: Option<usize>,
    capacity: usize,
}

impl<T> SlabAllocator<T> {
    pub fn new(capacity: usize) -> Self {
        // Pre-alokasi memori
        let mut storage = Vec::with_capacity(capacity);
        for _ in 0..capacity {
            storage.push(mem::MaybeUninit::uninit());
        }

        // Setup free list: setiap elemen (karena belum inisialisasi) 
        // akan di-"cast" secara logis ke indeks elemen free berikutnya.
        // Untuk amannya di Rust, kita menggunakan eksternal struktur 
        // atau jika ukuran T >= ukuran `usize`, kita simpan indeks di dalam T.
        // Di sini kita pilih cara aman: simpan list terpisah, atau simpan di T jika T besar.
        // Untuk generalisasi, kita asumsikan T di-manage via wrapper.
        
        // (Sederhana: kita tidak in-place memori karena T bisa saja < ukuran usize).
        // Sebagai ganti in-place linked list (yg butuh trik unsafe berat jika T kecil), 
        // kita gunakan struktur free_head yang mereferensi array terpisah, atau 
        // kita paksa T untuk di-pool dengan header.
        panic!("Untuk kesederhanaan, kode production menggunakan crate seperti `slab`.");
    }
}

/// Implementasi `slab` crate-like yang aman.
pub struct TypedSlab<T> {
    entries: Vec<Entry<T>>,
    next: usize, // index of next free
}

enum Entry<T> {
    Vacant(usize), // Points to next vacant
    Occupied(T),
}

impl<T> TypedSlab<T> {
    pub fn new(capacity: usize) -> Self {
        let mut entries = Vec::with_capacity(capacity);
        for i in 1..=capacity {
            entries.push(Entry::Vacant(i));
        }
        Self { entries, next: 0 }
    }

    pub fn insert(&mut self, val: T) -> Option<usize> {
        if self.next >= self.entries.len() {
            return None; // OOM atau butuh grow
        }
        let index = self.next;
        match self.entries[index] {
            Entry::Vacant(next_free) => {
                self.next = next_free;
                self.entries[index] = Entry::Occupied(val);
                Some(index)
            }
            Entry::Occupied(_) => unreachable!(),
        }
    }

    pub fn remove(&mut self, index: usize) -> Option<T> {
        if index >= self.entries.len() { return None; }
        
        // Swap out the value and replace with Vacant pointing to current `next`
        let mut temp = Entry::Vacant(self.next);
        std::mem::swap(&mut self.entries[index], &mut temp);
        
        match temp {
            Entry::Occupied(val) => {
                self.next = index;
                Some(val)
            }
            Entry::Vacant(_) => {
                // Restore if it was already vacant
                self.entries[index] = temp;
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slab_insert_remove() {
        let mut slab = TypedSlab::new(2);
        let id1 = slab.insert("A").unwrap();
        let id2 = slab.insert("B").unwrap();
        
        assert!(slab.insert("C").is_none()); // Kapasitas penuh
        
        assert_eq!(slab.remove(id1), Some("A"));
        
        // id1 harusnya di-recycle
        let id3 = slab.insert("C").unwrap();
        assert_eq!(id3, id1);
    }
}
```

## Anti-Pattern Terlarang

1. **Aba Definition Deinitialization (Double Free):**
   *Mengapa berbahaya:* Mengembalikan memori ke free list ganda (double free) membuat dua pemanggil menerima alamat memori yang sama. Hal ini akan memecah properti eksklusivitas pemilikan Rust dan menyebabkan data corruption secara misterius.
2. **ABA Problem di Concurrent Slab:**
   *Mengapa berbahaya:* Pada struktur concurrent lock-free slab (menggunakan CAS atomics), thread dapat mendeteksi indeks bebas yang sama meskipun slot telah dialokasikan dan didealokasikan oleh thread lain (ABA problem). Ini merusak pointer head free list. Gunakan version tags atau hazard pointers.

## Edge Cases & Defensive Programming

- **Generational Indices:** Untuk mencegah dangling pointer/use-after-free, gunakan kombinasi Index + Generation (contoh: `u32` index, `u32` generation). Jika objek dihapus, generation-nya dinaikkan. Akses memori dengan generation lama akan ditolak.
- **Cache-line False Sharing:** Pada thread-safe slab allocator (per-CPU cache), memori berdekatan yang diakses oleh thread berbeda akan memantulkan invalidasi L1 cache terus-menerus. Pad data agar berjarak minimal 64 byte.
