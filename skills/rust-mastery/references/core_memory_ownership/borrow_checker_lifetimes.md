# Borrow Checker, Lifetimes & Variance

## Konsep Utama
Borrow Checker dan Lifetimes adalah fondasi keamanan memori Rust tanpa garbage collector. Mereka memastikan bahwa referensi selalu valid (tidak ada dangling pointers) dan aturan aliasing ditegakkan (hanya satu mutable reference ATAU beberapa immutable references). Non-Lexical Lifetimes (NLL) memungkinkan lifetimes berakhir segera setelah penggunaan terakhir, bukan di akhir scope leksikal. Variance (Covariant, Contravariant, Invariant) menentukan bagaimana subtyping bekerja dengan lifetimes, penting saat membangun koleksi atau struktur data kompleks. `dyn Trait + 'a` digunakan untuk mendefinisikan batas lifetime pada trait objects.

**Kapan Digunakan:**
Di seluruh kode Rust, khususnya saat parsing zero-copy, caching sistem, dan mendesain API library yang aman dan ergonomis.

## Arsitektur / Flow
```text
[ Scope A ]
  |-- let x = String::new();      <-- 'a starts
  |
  |-- [ Scope B ]
  |     |-- let y = &x;           <-- 'b starts, 'b: 'a ('b outlives 'a is FALSE, 'a outlives 'b is TRUE)
  |     |-- use(y);               <-- 'b ends (NLL)
  |     |-- let z = &mut x;       <-- OK because 'b has ended!
  |
  |-- drop(x)                     <-- 'a ends
```

## Implementasi Production-Ready

```rust
#![allow(dead_code)]

/// Sebuah struktur yang menyimpan referensi dengan lifetime eksplisit.
/// Ini mendemonstrasikan lifetime subtyping dan variance.
#[derive(Debug)]
pub struct Context<'ctx> {
    data: &'ctx str,
}

impl<'ctx> Context<'ctx> {
    pub fn new(data: &'ctx str) -> Self {
        Self { data }
    }

    /// Lifetime elision: `&self` -> `&'a self`, mengembalikan `&'a str`
    pub fn get_data(&self) -> &str {
        self.data
    }
}

/// Menunjukkan bounds trait object dengan lifetime.
pub trait Processor {
    fn process(&self) -> String;
}

pub struct StringProcessor<'a> {
    ctx: &'a Context<'a>,
}

impl<'a> Processor for StringProcessor<'a> {
    fn process(&self) -> String {
        format!("Processed: {}", self.ctx.get_data())
    }
}

/// Menggunakan trait object dengan bound lifetime.
pub fn process_dynamic<'a>(processor: Box<dyn Processor + 'a>) -> String {
    processor.process()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nll_in_action() {
        let mut text = String::from("Rust Mastery");
        
        let r1 = &text; // r1 lifetime starts
        assert_eq!(r1, "Rust Mastery"); // r1 lifetime ends here (NLL)
        
        let r2 = &mut text; // Valid, because r1 is no longer used
        r2.push_str("!");
        assert_eq!(r2, "Rust Mastery!");
    }

    #[test]
    fn test_trait_object_lifetime() {
        let text = String::from("Temp");
        let ctx = Context::new(&text);
        let processor = StringProcessor { ctx: &ctx };
        
        let boxed: Box<dyn Processor + '_> = Box::new(processor);
        assert_eq!(process_dynamic(boxed), "Processed: Temp");
    }
}
```

## Anti-Patterns

1. **Self-Referential Structs tanpa `Pin`:**
   Mencoba membuat struct yang menyimpan owned data dan referensi ke data tersebut.
   *Mengapa Berbahaya:* Jika struct dipindahkan (moved), alamat memori data berubah, membuat referensi menjadi dangling.
   ```rust
   // ANTI-PATTERN
   struct Bad<'a> {
       data: String,
       ref_data: Option<&'a str>, // Akan menyebabkan error saat dipindahkan
   }
   ```

2. **Memaksakan Lifetime `'static` Secara Global:**
   Seringkali developer pemula menambahkan `'static` saat compiler mengeluh tentang lifetimes pada thread atau trait object, menyebabkan memory leak (jika menggunakan `Box::leak`) atau membatasi API secara berlebihan.
   *Mengapa Berbahaya:* Mengurangi fleksibilitas fungsi dan bisa memicu kebocoran memori jika data dinamis dikonversi ke `'static` berulang kali.

## Edge Cases & Defensive Engineering
- **Contravariance pada Function Pointers:** `fn(T)` bersifat contravariant terhadap `T`. Jika fungsi membutuhkan `fn(&'static str)`, Anda bisa memberikan fungsi yang menerima `fn(&'a str)` (lifetime apa saja), bukan sebaliknya. Ini sering menjebak desainer API callback.
- **Invariance pada Mutable References:** `&mut T` bersifat invariant terhadap `T`. Anda tidak bisa mengkonversi `&mut &'static str` menjadi `&mut &'a str`. Ini mencegah modifikasi memori yang bisa merusak jaminan lifetime asal.
- **Defensive:** Gunakan lifetime elision sebanyak mungkin agar API bersih. Hanya deklarasikan lifetime eksplisit jika ada lebih dari satu input reference dan Anda perlu mengikat salah satu reference ke return type.
