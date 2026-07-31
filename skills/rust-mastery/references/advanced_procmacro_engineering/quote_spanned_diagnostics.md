# Quote Spanned Diagnostics & Error Handling

Dalam *procedural macros*, hal yang membedakan makro produksi dengan mainan adalah **kualitas pesan error**. Compiler Rust memiliki *span* (informasi posisi file, baris, dan kolom). Menggunakan `quote_spanned!` dan `syn::Error`, Anda dapat memaksa compiler menunjuk *tepat ke kode yang salah* di IDE milik pengguna, bukan malah menunjuk ke pemanggilan makronya secara general.

## Arsitektur Diagnostics Spanned

```text
[ Developer Code ]
#[my_macro]
struct Data {
  id: u32,
  #[invalid_attr] <--- IDE memunculkan garis merah TEPAT DI SINI
  name: String,
}
```
*Span informasi mengikat Token (syntax) ke source file aslinya.*

## Implementasi Production-Ready

```rust
use proc_macro2::{Span, TokenStream};
use quote::{quote, quote_spanned};
use syn::spanned::Spanned;
use syn::{DeriveInput, Error, Result};

/// Logika pemrosesan macro yang mengembalikan `syn::Result`
fn process_macro(input: DeriveInput) -> Result<TokenStream> {
    let struct_name = &input.ident;

    // Memastikan input adalah struct
    let fields = match input.data {
        syn::Data::Struct(ref data) => &data.fields,
        _ => {
            // Mengirim error menunjuk langsung ke IDENTIFIER enum/union (Bukan seluruh item)
            return Err(Error::new_spanned(
                &input.ident,
                "Macro ini hanya mendukung Struct, bukan Enum atau Union",
            ));
        }
    };

    let mut generated_checks = Vec::new();

    for field in fields {
        let field_name = &field.ident;
        let field_ty = &field.ty;

        // Mengecek atribut custom (misal dilarang menggunakan tipe Option)
        let type_str = quote!(#field_ty).to_string();
        if type_str.contains("Option") {
            // Kita ingin garis merah compiler diletakkan di TIPE-nya (field_ty)
            return Err(Error::new(
                field_ty.span(), 
                "Tipe Option tidak didukung pada field ini."
            ));
        }

        // Generate kode dengan span terkait untuk tipe tersebut
        // Jika ada error kompilasi internal, ia menunjuk ke field aslinya
        let check = quote_spanned! {field.span()=>
            // Pastikan tipe field mengimplementasikan trait tertentu
            let _ = <#field_ty as std::fmt::Debug>::fmt;
        };
        generated_checks.push(check);
    }

    Ok(quote! {
        impl #struct_name {
            fn debug_check() {
                #(#generated_checks)*
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use syn::parse_quote;

    #[test]
    fn test_error_span() {
        let input: DeriveInput = parse_quote! {
            enum NotStruct { A, B }
        };

        let result = process_macro(input);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.to_string(), "Macro ini hanya mendukung Struct, bukan Enum atau Union");
    }
}
```

## Anti-Pattern Terlarang

1. **`panic!` dalam Proc Macro:**
   *Mengapa berbahaya:* Menggunakan `panic!` atau `.unwrap()` langsung pada atribut user akan menghentikan kompilasi secara paksa (compiler error generik). User hanya melihat "proc macro panicked", sehingga IDE tidak bisa memberikan petunjuk perbaikan, merusak *Developer Experience* (DX). Selalu convert menjadi `syn::Error::to_compile_error()`.
2. **Kehilangan Span di `TokenStream::from_str`:**
   *Mengapa berbahaya:* Jika Anda membangun output token stream dari parsing String (`syn::parse_str`), semua token dalam string tersebut akan di-assign ke `Span::call_site()`. Ketika error terjadi, compiler akan menyoroti seluruh pemanggilan macro, membingungkan pengguna.

## Edge Cases & Defensive Programming

- **Propagasi Multi-Error:** Seringkali lebih baik menampilkan *semua* error yang ada sekaligus daripada berhenti di error pertama. Anda bisa mengakumulasi error dengan method `combine(other_error)` pada `syn::Error`, lalu mengkonversinya di akhir menggunakan `err.to_compile_error()`. Ini menghemat siklus kompilasi user.
- **Crate `proc-macro-error`:** Untuk diagnostic lebih kompleks,crate pihak ketiga ini (atau `diagnostic` nightly feature) direkomendasikan karena menyediakan format ala compiler warning/error (contoh: *Help*, *Note*, dll.).
