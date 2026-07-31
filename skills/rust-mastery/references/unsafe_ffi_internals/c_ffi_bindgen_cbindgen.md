# C-FFI, Bindgen, Cbindgen, & ABI Boundaries

## Konsep Utama
Rust mendukung penuh Foreign Function Interface (FFI) untuk memanggil dan dipanggil oleh bahasa sistem lain, khususnya C. Karena Rust dan C memiliki konvensi pemanggilan (*calling convention*) dan tata letak memori (*memory layout*) yang berbeda, kita membutuhkan jembatan. 

- `extern "C"`: Memaksa fungsi atau blok menggunakan ABI (Application Binary Interface) standar C.
- `#[repr(C)]`: Memaksa *struct* memiliki tata letak memori persis seperti kompilator C (tanpa *field reordering*).
- `#[no_mangle]`: Mencegah *compiler* Rust merusak (mangling) nama simbol fungsi sehingga linker C dapat menemukannya.
- **Bindgen**: Alat untuk otomatis menghasilkan C-to-Rust *bindings* dari *header* C.
- **Cbindgen**: Alat sebaliknya, menghasilkan Rust-to-C *headers* agar kode Rust bisa diakses oleh C.

**Kapan Digunakan:**
- Memanggil C library bawaan sistem (contoh: *OpenSSL*, *zlib*).
- Menulis *plugin* untuk aplikasi berbasis C/C++.
- Menyediakan *shared library* (`.so`, `.dll`) berkinerja tinggi dari Rust ke bahasa tingkat tinggi (Python, Node.js, dll. lewat C ABI).

## Arsitektur & Aliran: FFI Boundary
```ascii
[ RUST DOMAIN ]                 |                 [ C DOMAIN ]
String, Vec, Box                |                 char*, malloc pointer
Result<T, E>                    |                 int error_code
      |                         |                      |
      v                         |                      v
[ FFI WRAPPER (Rust) ]          |               [ C HEADER (foo.h) ]
#[repr(C)] struct               |               struct Foo { ... }
extern "C" fn do_work() --------|------------>  void do_work()
                                |               
    Batas Aman (Panic dilarang, memory ownership ditransfer secara eksplisit)
```

## Kode Production-Ready
Berikut adalah contoh struktur data `Matrix` yang diekspos dari Rust ke C dengan aman, menyertakan konstruksi, penghancuran, dan error handling C-style.

```rust
use std::os::raw::{c_int, c_double};
use std::ptr;

// 1. Definisikan tipe yang aman dilintasi lewat batas FFI
#[repr(C)]
pub struct Matrix {
    data: *mut c_double,
    rows: usize,
    cols: usize,
}

// 2. Fungsi konstruktor dipanggil dari C
#[no_mangle]
pub extern "C" fn matrix_new(rows: usize, cols: usize, out_ptr: *mut *mut Matrix) -> c_int {
    // Definisi Error Codes (0 = Sukses, -1 = Error/Nullptr)
    if out_ptr.is_null() || rows == 0 || cols == 0 {
        return -1;
    }

    let size = rows * cols;
    // Gunakan Vec sebagai allocator
    let mut data_vec = vec![0.0_f64; size];
    data_vec.shrink_to_fit(); // Pastikan capacity == len
    
    // Transfer ownership data ke raw pointer
    let data_ptr = data_vec.as_mut_ptr();
    std::mem::forget(data_vec); // Bocorkan ke heap agar C bisa mengakses

    let matrix = Box::new(Matrix {
        data: data_ptr,
        rows,
        cols,
    });

    // SAFETY: out_ptr telah dicek null.
    unsafe {
        *out_ptr = Box::into_raw(matrix);
    }
    
    0 // Success
}

// 3. Destructor Wajib. Memory yang dialokasikan di Rust (Box, Vec) 
//    HARUS didealokasikan di Rust, bukan C `free()`.
#[no_mangle]
pub extern "C" fn matrix_free(ptr: *mut Matrix) {
    if ptr.is_null() {
        return;
    }

    // Ambil alih ownership
    unsafe {
        let matrix = Box::from_raw(ptr);
        // Konstruksi kembali Vec agar data yang di-forget sebelumnya didrop
        let _data_vec = Vec::from_raw_parts(matrix.data, matrix.rows * matrix.cols, matrix.rows * matrix.cols);
        // Box & Vec didrop di akhir scope fungsi ini
    }
}

// 4. Mencegah panik menyeberangi FFI
#[no_mangle]
pub extern "C" fn matrix_get(
    ptr: *const Matrix, 
    row: usize, 
    col: usize, 
    out_val: *mut c_double
) -> c_int {
    // Tangkap potensi panic (opsional jika kita menjamin fungsi kita tidak panik, tapi sangat baik untuk FFI)
    let result = std::panic::catch_unwind(|| {
        if ptr.is_null() || out_val.is_null() {
            return -1;
        }

        unsafe {
            let matrix = &*ptr;
            if row >= matrix.rows || col >= matrix.cols {
                return -2; // Out of bounds
            }
            let idx = row * matrix.cols + col;
            *out_val = *matrix.data.add(idx);
            0
        }
    });

    result.unwrap_or(-99) // -99 menandakan Rust Panicked
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_matrix_ffi() {
        let mut mat_ptr: *mut Matrix = ptr::null_mut();
        
        let res = matrix_new(2, 2, &mut mat_ptr);
        assert_eq!(res, 0);
        assert!(!mat_ptr.is_null());
        
        let mut val = 100.0;
        let res2 = matrix_get(mat_ptr, 1, 1, &mut val);
        assert_eq!(res2, 0);
        assert_eq!(val, 0.0);
        
        matrix_free(mat_ptr);
    }
}
```

## Anti-Patterns

### 1. Panik Melintasi Batas FFI (Panic across FFI boundary)
**Bahaya:** Jika kode Rust di dalam fungsi `extern "C"` melakukan `panic!` (misalnya karena out-of-bounds array, unwrap(), dll) dan proses unwinding stack melintasi kode C yang memanggilnya, ini murni **Undefined Behavior**.
**Solusi:** Selalu tangkap panik dengan `std::panic::catch_unwind`, ubah status panic menjadi kode error integer yang dipahami C, atau kompilasi seluruh projek dengan `panic = "abort"`.

```rust
// ANTI-PATTERN
#[no_mangle]
pub extern "C" fn do_risky_task() {
    let list = vec![1];
    let val = list[10]; // PANIC di FFI! UB!
}
```

### 2. Mencampur Allocator Rust & C (`free` pointer Rust)
**Bahaya:** Memberikan string C (`*mut c_char`) hasil konversi `CString::into_raw()` ke program C, dan kemudian mengizinkan program C memanggil `free()` pada pointer tersebut. Allocator Rust dan Allocator C (libc) tidak dijamin satu instance yang sama (contoh, jika Rust menggunakan `jemalloc` dan C pakai `glibc malloc`). Ini akan menyebabkan _segfault_.
**Solusi:** Ekspor fungsi `my_lib_free_string(ptr: *mut c_char)` dari Rust yang membungkus `CString::from_raw(ptr)` agar didealokasi secara sah oleh Rust.

## Edge Cases & Defensive Engineering
- **Opaque Types:** Terkadang kita tak ingin C tahu isi struct kita. Di Rust, export struct tanpa mendefinisikan layoutnya di file header C (`typedef struct Foo Foo;`). Pointer ke struct ini bisa dioper balik dan maju.
- **Null Pointers & Option:** Rust menjamin bahwa `Option<&T>` dan `Option<extern "C" fn()>` secara representasi FFI setara dengan `*const T` nullable dan *function pointer* C yang nullable. Fitur "Null-pointer optimization" ini sangat efisien untuk membuang pengecekan manual null.
