# MaybeUninit & Inisialisasi Memori

## Konsep Utama
Tipe `std::mem::MaybeUninit<T>` adalah abstraksi aman untuk menangani memori yang **belum diinisialisasi**. Rust di masa lalu menggunakan `mem::uninitialized()`, namun ini ditandai usang (*deprecated*) karena menciptakan nilai dari tipe apa pun seketika itu memicu UB untuk sebagian besar tipe (termasuk referensi).

`MaybeUninit` berfungsi seperti `union` yang berisi satu varian, menghentikan *compiler* membuat asumsi apa pun tentang bit-pattern di dalamnya. Pengguna harus secara manual menginisialisasi nilainya (lewat pointer) dan hanya setelah itu diizinkan memanggil `assume_init()`.

**Kapan Digunakan:**
- Mengalokasikan array / buffer statis di *stack* untuk diproses per-elemen atau dibaca melalui sistem I/O (seperti `read` syscall) tanpa harus di-nol-kan (*zeroed*) terlebih dahulu demi performa absolut.
- Membangun struktur data kompleks berurutan (misal: vector, queues).

## Arsitektur & Aliran: Status Inisialisasi
```ascii
[ MaybeUninit<T> ] 
Status: Uninitialized (Berisi Garbage Data)
      |
      | (Dilarang memanggil assume_init!)
      v
[ *mut T ] ptr = uninit.as_mut_ptr()
      |
      | (Tulis data lewat pointer: ptr::write(ptr, data))
      v
[ MaybeUninit<T> ] 
Status: Initialized
      |
      | (Aman memanggil assume_init())
      v
[ T ] 
```

## Kode Production-Ready
Contoh nyata: Membuat array statis dan menginisialisasinya elemen-per-elemen secara aman tanpa menginisialisasi nilai default di awal.

```rust
use std::mem::MaybeUninit;
use std::ptr;

/// Struct contoh berat yang kita tidak ingin inisialisasi default-nya.
#[derive(Debug, PartialEq, Clone)]
pub struct HeavyData {
    id: usize,
    buffer: [u8; 100],
}

impl HeavyData {
    pub fn new(id: usize) -> Self {
        Self { id, buffer: [id as u8; 100] }
    }
}

pub fn create_heavy_array(count: usize) -> Vec<HeavyData> {
    // Kita menginginkan buffer uninitialized sebesar 10 elemen maksimum.
    const MAX_SIZE: usize = 10;
    
    let mut array: [MaybeUninit<HeavyData>; MAX_SIZE] = unsafe {
        MaybeUninit::uninit().assume_init()
    };
    
    let actual_count = count.min(MAX_SIZE);
    
    // Inisialisasi elemen satu per satu
    for i in 0..actual_count {
        let item = HeavyData::new(i);
        let ptr = array[i].as_mut_ptr();
        unsafe {
            ptr::write(ptr, item);
        }
    }

    let mut result = Vec::with_capacity(actual_count);
    
    for i in 0..actual_count {
        // SAFETY: Kita hanya membaca indeks yang telah kita inisialisasi di loop atas.
        let init_val = unsafe { array[i].assume_init_read() };
        result.push(init_val);
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_uninit_array() {
        let arr = create_heavy_array(3);
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[0].id, 0);
        assert_eq!(arr[2].id, 2);
    }
}
```

## Anti-Patterns

### 1. `assume_init` Prematur
**Bahaya:** Memanggil `assume_init()` sebelum memori benar-benar ditulis. Kompilator (LLVM) akan mengira nilai berisi *garbage* dari memori sebagai nilai sah dari tipe `T`. Jika `T` adalah referensi atau tipe boolean, hal ini seketika menyebabkan aplikasi memori panik atau rusak.
**Solusi:** Pisahkan secara tegas phase Uninit dan Phase Write sebelum memanggil `assume_init()`.

```rust
// ANTI-PATTERN
let mut x = std::mem::MaybeUninit::<bool>::uninit();
// unsafe { let bad = x.assume_init(); } // UB!
```

### 2. Mengisi Data menggunakan Operator Assignment (=)
**Bahaya:** Melakukan iterasi atau *assignment* menggunakan `uninit_array[0] = ...`. Hal ini salah jika `T` merepresentasikan tipe yang implement `Drop`. Ketika *assignment* normal terjadi, Rust akan secara diam-diam memanggil fungsi `drop` dari nilai lama (yang masih *garbage*). Mendrop memori acak dapat menyebabkan *segfault*!
**Solusi:** Selalu gunakan `ptr::write(ptr, data)` pada *raw pointer*.

## Edge Cases & Defensive Engineering
- **Zeroed Memory:** Terkadang struktur FFI C menuntut struct yang isinya `0` di awal. Alih-alih membuat `MaybeUninit::uninit` dan menge-nol-kan secara manual, gunakan `MaybeUninit::zeroed()`.
- **Leak Memory on Panic:** Jika inisialisasi pada elemen iterasi ke-N menyebabkan *panic*, elemen dari 0 hingga N-1 yang telah sukses dialokasikan harus secara sadar di-drop dalam *Drop guard custom*.
