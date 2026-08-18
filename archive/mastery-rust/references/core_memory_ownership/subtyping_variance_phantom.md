# Subtyping, Variance & PhantomData

## Konsep Utama
Rust tidak memiliki subtipe objek-orientasi klasik (seperti class inheritance). Namun, Rust memiliki *lifetime subtyping*. Misalnya, `'static` adalah subtipe dari setiap lifetime `'a` (karena ia hidup lebih lama atau sama dengan `'a`).
Variance mendeskripsikan bagaimana subtyping parameter tipe mempengaruhi subtyping struct yang menyimpannya:
- **Covariant (Sejalan):** Jika `'a` subtipe dari `'b`, maka `Struct<'a>` adalah subtipe dari `Struct<'b>`.
- **Contravariant (Terbalik):** Jika `'a` subtipe `'b`, maka `Struct<'a>` adalah *supertipe* `Struct<'b>`. (Umumnya terjadi di argumen fungsi `fn(&'a T)`).
- **Invariant (Kaku):** Tidak ada hubungan subtipe. Anda wajib menyocokkan tipe tepat. (Misalnya `&mut T` dan `Cell<T>`).
- `PhantomData<T>` adalah zero-sized type (ZST) yang memberi tahu compiler, "Bertingkahlah seolah-olah tipe ini menyimpan `T`, demi perhitungan rules Variance, Drop, dan Send/Sync".

**Kapan Digunakan:**
Membuat Typestates pattern (State Machine di compile time), menulis custom collections, unsafe pointers wrappers, dan FFI abstraction.

## Arsitektur / Flow
```text
State Machine dgn Typestate:

  Builder<State1>  ---.transition()---> Builder<State2>
     (PhantomData)                        (PhantomData)
```
Tipe State hanya ada di compile time, tidak memakan memori di runtime.

## Implementasi Production-Ready

```rust
use std::marker::PhantomData;

// --- Marker Types (Zero-sized) ---
pub struct Disconnected;
pub struct Connected;

/// Struct koneksi yang mendemonstrasikan Typestate pattern via PhantomData
/// dan memastikan variance yang benar (Invariant terhadap T dan Covariant terhadap State).
#[derive(Debug)]
pub struct Connection<'a, State, T> {
    id: u32,
    buffer: &'a [T],
    // Memberitahu compiler bahwa struct ini "memiliki" State (compile-time only)
    _state: PhantomData<State>,
}

impl<'a, T> Connection<'a, Disconnected, T> {
    pub fn new(id: u32, buffer: &'a [T]) -> Self {
        Self {
            id,
            buffer,
            _state: PhantomData,
        }
    }

    /// Transisi State: Disconnected -> Connected
    pub fn connect(self) -> Connection<'a, Connected, T> {
        Connection {
            id: self.id,
            buffer: self.buffer,
            _state: PhantomData,
        }
    }
}

impl<'a, T> Connection<'a, Connected, T> {
    pub fn send_data(&self) -> usize {
        // Logika mengirim data dari buffer
        self.buffer.len()
    }

    /// Transisi State: Connected -> Disconnected
    pub fn disconnect(self) -> Connection<'a, Disconnected, T> {
        Connection {
            id: self.id,
            buffer: self.buffer,
            _state: PhantomData,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_typestate_transition() {
        let buf = vec![1, 2, 3];
        let conn: Connection<Disconnected, i32> = Connection::new(1, &buf);
        
        // conn.send_data(); // COMPILE ERROR: Method tidak ada di State Disconnected
        
        let connected_conn = conn.connect();
        assert_eq!(connected_conn.send_data(), 3); // Valid!
        
        let _disconnected_again = connected_conn.disconnect();
    }
}
```

## Anti-Patterns

1. **PhantomData yang Salah pada Custom Pointers:**
   Misal membuat struct `struct MyVec<T> { ptr: *mut T }`. Karena pointer primitif (`*mut T`) bersifat invariant secara default terhadap `T`, menggunakan `PhantomData<T>` membuatnya Invariant.
   *Mengapa Berbahaya:* Koleksi yang Invariant sangat kaku dan menolak dikirimkan/diproses dalam argumen fungsi trait generik, merusak ergonomi (seperti merusak polimorfisme lifetime pada element). Solusi standar: Gunakan `NonNull<T>` yang covariant.

2. **Menggunakan `PhantomData<&'a T>` untuk "Drop Check":**
   Menggunakan bentuk referensi karena merasa ini menyimpan pinjaman. 
   *Mengapa Berbahaya:* Ini merubah aturan Drop Check. Compiler mungkin akan melarang Anda mendealokasi objek tertentu karena meniru siklus pinjaman yang salah. Gunakan `PhantomData<T>` secara langsung (Owned) jika Anda mengalokasikan / membuang tipe tersebut.

## Edge Cases & Defensive Engineering
- **Send dan Sync Traits:** `PhantomData<T>` secara otomatis mengadopsi trait `Send` dan `Sync` berdasarkan `T`. Jika `T` Anda adalah `Rc<String>`, tipe pembungkus Anda akan kehilangan `Send`. Jika Anda menulis FFI raw pointer dan ingin tipe itu bisa dikirim lintas thread, Anda perlu secara eksplisit mengimplementasikan `unsafe impl Send for MyWrapper {}`.
- **Ghost Type Variance:** PhantomData fungsi `fn() -> T` bersifat *Covariant* terhadap `T`. PhantomData `fn(T)` bersifat *Contravariant*. Pahami tabel rules variance jika membuat macro FFI tingkat lanjut.
