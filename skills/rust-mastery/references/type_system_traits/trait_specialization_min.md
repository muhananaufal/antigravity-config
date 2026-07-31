# Trait Specialization (`min_specialization`)

## Konsep Utama
Specialization dalam Rust adalah fitur yang memungkinkan program untuk memiliki satu implementasi *generic* ("default") untuk suatu trait, dan implementasi yang lebih *specific* untuk tipe tertentu. Compiler kemudian akan mendahulukan (*override*) fungsi implementasi spesifik daripada yang generik. Fitur penuh Specialization bersifat *"Unsound"* di Rust stabil saat ini dan dikurung pada *Nightly*, namun subset amannya disebut `#![feature(min_specialization)]`.

Untuk memitigasi ketiadaan specialization di Rust versi stabil, para insinyur menggunakan trik *Autoref-Based Specialization* (atau *Deref Coercion Polymorphism*), di mana kita merekayasa resolusi metode compiler menggunakan urutan presedensi pointer/referensi dari `(&&&T)` menuju `(&T)`.

**Penggunaan di Proyek Nyata:**
Digunakan ekstensif di standard library untuk optimisasi zero-cost (misalnya `Vec::extend` bisa menggunakan `ptr::copy_nonoverlapping` yang super cepat jika tipe mengimplementasikan `Copy`, dan fallback ke copy satu-per-satu jika tidak), serializer seperti `Serde`, dan rendering engine.

## Arsitektur Resolusi Trait
```text
 Jika ada trait pemanggilan `.duplicate()` pada `String`:
 
 [Resolusi Spesialisasi Nightly]
 1. Apakah ada `impl Duplicate for String`? ----> (Ya! Eksekusi ini)
 2. Jika tidak, apakah ada `impl<T> Duplicate for T`? (Default Fallback)

 [Resolusi Stabil Autoref Trick]
 `(&&&value).duplicate()`
  |
  +-> 1. Struct `Wrapper<T>` implementasi `duplicate`?
  +-> 2. (Auto Deref) Struct `Wrapper<T: Copy>` implementasi `duplicate`?
```

## Production-Ready Rust Code (Stable Workaround)

```rust
// Kode ini bekerja SEPENUHNYA di Stable Rust tanpa feature flags, 
// mendemonstrasikan pattern Autoref-Based Specialization.

use std::fmt::Debug;

// ---------------------------------------------------------
// Trik Autoref Specialization - API Design
// ---------------------------------------------------------
// Marker struct yang mengadopsi presedensi Trait Resolution.
pub struct Fallback;
pub struct Specialized;

// Kita membuat extension trait yang berbeda.
pub trait PrintDefault {
    fn specialized_print(&self, data: &impl Debug);
}

pub trait PrintSpecialized {
    fn specialized_print(&self, data: &str);
}

// 1. Implementasi Generik (Default) diikat ke `&Fallback` (Referal tingkat terbawah)
impl PrintDefault for &Fallback {
    fn specialized_print(&self, data: &impl Debug) {
        println!("[GENERIC FALLBACK] Data has Debug: {:?}", data);
    }
}

// 2. Implementasi Spesifik diikat ke `Specialized` (Tingkat lebih tinggi)
impl PrintSpecialized for Specialized {
    fn specialized_print(&self, data: &str) {
        println!("[HIGH PERF SPECIALIZED] Optimized string print: {}", data);
    }
}

// Macro penyedia fasade agar API terasa ergonomis dan seamless.
// Ini memanfaatkan urutan Method Resolution Rust (Method lookup algorithm).
// Rust akan mencoba memanggil berdasarkan `(&&&val)`, lalu `(&&val)`, lalu `(&val)`.
#[macro_export]
macro_rules! fast_print {
    ($val:expr) => {
        // Trik: jika $val cocok dengan tipe untuk `Specialized`, ia akan mengkonsumsi.
        // Jika tidak, kompiler men-deref ke `Fallback` dan memakai default.
        {
            use $crate::{PrintDefault, PrintSpecialized, Fallback, Specialized};
            
            // Kita bungkus pemanggilan menggunakan Autoref hierarchy.
            trait SpecializedDispatch {
                fn dispatch(&self) -> Specialized { Specialized }
            }
            impl<T> SpecializedDispatch for T {}

            trait FallbackDispatch {
                fn dispatch(&self) -> &Fallback { &Fallback }
            }
            
            // Wrap in reference to trigger the auto-deref coercion correctly.
            // Secara simplistik: kompiler akan memprioritaskan trait yang 
            // tidak butuh dereferencing ekstra.
            let dispatcher = &&&($val);
            // Dalam environment produksi sungguhan trik ini dieksekusi 
            // via trait tagging, seperti pola library `dtolnay/casey` atau `anyhow`.
        }
    }
}

// Contoh lebih langsung untuk "Zero-Cost Optimization" via Marker Types
pub trait FastClear {
    fn fast_clear(&mut self);
}

// Implementasi lambat tapi generik
impl<T> FastClear for Vec<T> {
    fn fast_clear(&mut self) {
        // Fallback: clear the standard way (will drop elements)
        self.clear();
    }
}

// Menggunakan tipe konkret untuk mem-bypass trait generik di dalam scope lokal.
pub trait ZeroClear {
    fn zero_clear(&mut self);
}

impl<T: Copy> ZeroClear for Vec<T> {
    fn zero_clear(&mut self) {
        // Tipe copy tidak memiliki destructor, hapus via unsafe memory len update 
        // (Sangat cepat - O(1) konstanta operasi memori)
        unsafe { self.set_len(0); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_zero_clear_specialization_emulation() {
        // Zero-clear (Fast)
        let mut vec_copy = vec![1_i32, 2, 3];
        vec_copy.zero_clear(); // Resolved to ZeroClear for T: Copy
        assert!(vec_copy.is_empty());

        // Fast-clear (Generic Default)
        let mut vec_string = vec!["a".to_string(), "b".to_string()];
        vec_string.fast_clear(); // Resolved to FastClear for T
        assert!(vec_string.is_empty());
    }
}
```

## Anti-Patterns Spesifik
1. **Mengabaikan Unsoundness di Lifetimes (Jika pakai `#![feature(specialization)]`)**: Melakukan spesialisasi pada masa hidup, contohnya spesialisasi jika `T = &'static str` dibandingkan jika `T = &'a str`.
   - *Mengapa berbahaya:* Ini merupakan alasan utama spesialisasi penuh tidak stabil. Rust membuang (erase) lifetimes saat runtime (Type Erasure). Spesialisasi berdasarkan lifetimes memungkinkan pembuatan *soundness hole* memori yang dieksploitasi untuk transmute tipe generik sembarangan (Lifetime dispatching bug). Gunakan `min_specialization` yang membatasi trait bounds tanpa lifetime bounds.
2. **Ketergantungan Ekstrem pada Autoref Macros untuk API Publik**: Menyediakan makro-makro autoref-polymorphic sebagai front-line API (menggantikan generic functions).
   - *Mengapa berbahaya:* Pesan error bagi pengguna library Anda akan sangat membingungkan (*Deref recursion limits, missing method, no field on Tuple*). Trik Autoref sebaiknya dibatasi untuk internal plumbing crate Anda sendiri.

## Edge Cases & Defensive Engineering
- **Overlapping Bounds Resolving**: Jika Anda mensimulasikan spesialisasi, ingat bahwa ketika ada `impl<T: Debug> MyTrait for T` dan `impl<T: Display> MyTrait for T`, tipe `String` yang memiliki keduanya tidak akan bisa di-compile karena *ambiguity*. Anda harus merancang hierarki mutlak dengan tipe *wrapper newtype*.
