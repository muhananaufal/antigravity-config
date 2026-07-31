# Pin, Unpin & Self-Referential Structs

## Konsep Utama
Di Rust, objek secara default dapat dipindahkan secara bebas di memori (movable). Namun, beberapa struktur (seperti state machine `async/await` atau FFI interop) memerlukan alamat memorinya tetap (fixed) untuk mencegah invalidasi pointer. 
- `Pin<P>`: Wrapper untuk pointer `P` yang menegakkan jaminan bahwa data yang ditunjuk tidak akan dipindahkan (moved) di memori selama memori tersebut belum di-dealokasi (Drop).
- `Unpin`: Auto-trait yang diimplementasikan untuk tipe-tipe yang boleh dipindahkan (movable). Untuk tipe `Unpin`, `Pin<P>` tidak memiliki efek apa-apa.
- `PhantomPinned`: Marker type untuk membuat sebuah struct tidak mengimplementasikan `Unpin` (membuatnya menjadi tipe !Unpin).

**Kapan Digunakan:**
Async programming (menyimpan state variables antar yield points), Self-Referential Structs, FFI C++ (di mana C++ mengharapkan alamat memori tidak berubah).

## Arsitektur / Flow
```text
Stack                  Heap
[ Pin<Box<SelfRef>> ] ---> [ data: String ]
                           [ ptr: *const String ] --+
                             ^                      |
                             +----------------------+ (Self-Reference)
* Jika Box dipindahkan di Stack, memori Heap tetap sama. Pin memastikan kita tidak memindahkan data keluar dari Box.
```

## Implementasi Production-Ready

```rust
use std::marker::PhantomPinned;
use std::pin::Pin;
use std::ptr::NonNull;

/// Struct self-referential yang menyimpan data dan pointer ke data tersebut.
pub struct SelfReferential {
    data: String,
    // Pointer yang merujuk ke field `data`.
    // Kita gunakan NonNull untuk bypassing borrow checker rules sementara
    self_ptr: Option<NonNull<String>>,
    // Marker yang meniadakan trait Unpin
    _pin: PhantomPinned,
}

impl SelfReferential {
    pub fn new(data: String) -> Pin<Box<Self>> {
        let res = Self {
            data,
            self_ptr: None,
            _pin: PhantomPinned,
        };
        // Masukkan ke heap dan buat pinned pointer
        let mut boxed = Box::pin(res);

        // Aman memodifikasi struktur pinned via pointer unsafe jika kita
        // menjamin kita tidak akan memindahkan (move) struct tersebut setelah ini.
        let ptr = NonNull::from(&boxed.data);
        
        // Pin::as_mut memberikan Pin<&mut T>
        // Kita bypass Pin memakai unsafe untuk inisialisasi pointer
        unsafe {
            let mut_ref: Pin<&mut Self> = Pin::as_mut(&mut boxed);
            Pin::get_unchecked_mut(mut_ref).self_ptr = Some(ptr);
        }

        boxed
    }

    pub fn read_via_pointer(self: Pin<&Self>) -> &str {
        // Menggunakan reference pointer yang dibuat saat inisialisasi
        unsafe {
            self.self_ptr
                .expect("ptr uninitialized")
                .as_ref()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pinned_self_ref() {
        let data = String::from("PinnedData");
        let pinned_struct = SelfReferential::new(data.clone());
        
        assert_eq!(pinned_struct.as_ref().read_via_pointer(), "PinnedData");
        // Struct ini TIDAK BISA di-move dengan cara swap atau replace. 
        // std::mem::swap(&mut pinned_struct, ...) akan compile-error!
    }
}
```

## Anti-Patterns

1. **Membuat API `&mut T` untuk Pinned Data:**
   Menyediakan fungsi `.get_mut(self: Pin<&mut Self>) -> &mut Self` untuk tipe `!Unpin`.
   *Mengapa Berbahaya:* Ini merusak jaminan Pin! Jika pengguna mendapatkan `&mut Self`, mereka bisa menggunakan `std::mem::replace` atau `std::mem::swap` untuk mengeluarkan nilai tersebut dari alamat memorinya yang di-pin, menyebabkan self-references menunjuk ke memori garbage. Gunakan struktural pinning yang benar (seperti via crate `pin-project`).

2. **Melupakan `PhantomPinned` pada Self-Referential Struct:**
   Membuat struct dengan pointer internal tanpa marker `PhantomPinned`.
   *Mengapa Berbahaya:* Struct tersebut akan secara otomatis mendapatkan auto-trait `Unpin`. Jika `Unpin` ada, wrapper `Pin` membolehkan mendapatkan `&mut Self` melalui `Pin::into_inner()`, mengizinkan user untuk memindahkan memori secara sembarangan.

## Edge Cases & Defensive Engineering
- **Structural vs Non-Structural Pinning:** Saat Anda menulis struct yang fields-nya perlu di-pin bersamaan dengan struct utamanya, Anda melakukan *structural pinning*. Sangat disarankan untuk menghindari macro unsafe buatan sendiri dan selalu gunakan crate macro `pin-project` atau `pin-project-lite` untuk menghasilkan kode proyeksi yang 100% sound menurut rules Rust compiler terkini.
