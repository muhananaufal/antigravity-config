# Attribute Macro Transformer

Attribute macro memungkinkan manipulasi ekstrim (penambahan argumen, wrapping kode, pengubahan return type) pada AST. Contoh paling umum di industri adalah `#[tokio::main]`, yang secara otomatis memutarbelokkan `async fn main()` menjadi `fn main()` blok blocking synchronous yang membungkus inisialisasi Tokio runtime.

## Arsitektur Transformasi Token

```text
#[my_attribute(config = "value")]
fn my_func() -> u32 { 1 }

 1. Macro menerima DUA parameter TokenStream:
    a. `attr` (config = "value")
    b. `item` (fn my_func() ...)
 2. `item` diparsing ke syn::ItemFn.
 3. Output token stream MENGGANTIKAN kode asli secara keseluruhan.
```

## Implementasi Production-Ready

```rust
use proc_macro2::TokenStream;
use quote::quote;
use syn::{parse_quote, ItemFn, Result};

/// Transformasi macro yang membungkus isi body fungsi dengan
/// blok timing yang mencetak durasi eksekusi.
pub fn expand_timing_decorator(_attr: TokenStream, item: TokenStream) -> Result<TokenStream> {
    // 1. Parse input menjadi AST fungsi (ItemFn)
    let mut func: ItemFn = syn::parse2(item)?;

    // 2. Ekstrak properti fungsi yang ada
    let sig = &func.sig;
    let block = &func.block; // Isi kode dari fungsi asli

    // 3. Bangun AST baru untuk wrapper
    // Menggunakan fungsi block dalam closure lokal
    // agar dapat mengembalikan return type yang benar
    let new_block = quote! {
        {
            let __start = std::time::Instant::now();
            
            // Evaluasi kode original
            let __result = (|| #block )();
            
            println!(
                "Fungsi dieksekusi dalam: {:?}", 
                __start.elapsed()
            );
            
            __result
        }
    };

    // 4. Ubah block pada AST struct yang dipegang dengan yang baru
    func.block = Box::new(syn::parse2(new_block).expect("Gagal mem-parsing block baru"));

    // 5. Kembalikan fungsi yang termodifikasi
    Ok(quote!(#func))
}

#[cfg(test)]
mod tests {
    use super::*;
    use syn::parse_quote;

    #[test]
    fn test_timing_decorator() {
        let original_code: TokenStream = quote! {
            fn compute(a: i32, b: i32) -> i32 {
                a + b
            }
        };

        let result = expand_timing_decorator(TokenStream::new(), original_code).unwrap();
        let code = result.to_string();
        
        // Memastikan signature bertahan
        assert!(code.contains("fn compute"));
        // Memastikan inject-kode waktu ada
        assert!(code.contains("std :: time :: Instant :: now ()"));
    }
}
```

## Anti-Pattern Terlarang

1. **Pemanggilan `macro_rules!` di Dalam Token Transformer Tanpa Import yang Benar:**
   *Mengapa berbahaya:* Jika attribute macro menghasilkan kode yang menggunakan `println!` atau macro crate eksternal, Anda HARUS menyertakan fully-qualified path (`::std::println!`) dalam `quote!`. Jika tidak, kode user di modul yang tidak mengimport makro itu tidak akan compile.
2. **Menghapus Atribut User Secara Tidak Sengaja:**
   *Mengapa berbahaya:* Atribut fungsi (seperti `#[inline]`, `#[doc(hidden)]`) disimpan di dalam `func.attrs`. Jika Anda merestrukturisasi AST secara manual tanpa mem-pass atribut ini ke output `TokenStream`, informasi metadata vital dari program akan hilang, merusak dokumentasi dan performa.

## Edge Cases & Defensive Programming

- **Async Functions & Return Tipe:** Menyisipkan kode wrapper ke fungsi `async` memerlukan perhatian. Kode `|| #block` di atas mensimulasikan closure, tapi jika `block` mengandung keyword `.await`, Anda harus membungkusnya dalam async block `async { #block }.await`. Validasi melalui `func.sig.asyncness.is_some()` sebelum memutuskan logika wrapper.
- **Generics dan Lifetimes pada Fungsi:** Pastikan manipulasi tidak menyembunyikan atau memutuskan koneksi lifetime argumen dengan tipe balikan (return type elision). Selalu copy bulat-bulat properti dari `func.sig` ke output tanpa dipilah-pilah.
