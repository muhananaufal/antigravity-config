# Derive Macro: Struct Fields Iteration

Derive macros (seperti `#[derive(Serialize)]`) adalah tulang punggung meta-programming di Rust. Membedah komponen `DeriveInput` (khususnya struct fields, enum variants) dan berinteraksi dengannya adalah keterampilan fundamental yang melibatkan handling `NamedFields`, `UnnamedFields` (tuple structs), atau Unit structs.

## Arsitektur Derive Decomposer

```text
 DeriveInput (Pohon AST)
  |-- ident (Nama Struct)
  |-- generics (Lifetimes, Type Params, Where Clause)
  |-- data: syn::Data
       |-- Struct(syn::DataStruct)
            |-- fields: syn::Fields
                 |-- Named (Struct normal: { x: i32 })
                 |-- Unnamed (Tuple struct: (i32, String))
                 |-- Unit (Unit struct: struct Foo;)
```

## Implementasi Production-Ready

```rust
use proc_macro2::TokenStream;
use quote::quote;
use syn::{Data, DeriveInput, Error, Fields, Result};

/// Generate implementasi trait custom `InspectFields` untuk struct
pub fn expand_inspect_fields(input: DeriveInput) -> Result<TokenStream> {
    let name = &input.ident;
    let (impl_generics, ty_generics, where_clause) = input.generics.split_for_impl();

    let fields = match &input.data {
        Data::Struct(data_struct) => &data_struct.fields,
        _ => return Err(Error::new_spanned(&input, "Hanya mendukung struct.")),
    };

    let inspection_code = match fields {
        Fields::Named(named) => {
            let fields_iter = named.named.iter().map(|f| {
                let fname = &f.ident;
                // Ambil string representasi nama field
                let fname_str = fname.as_ref().unwrap().to_string();
                quote! {
                    println!("{}: {:?}", #fname_str, &self.#fname);
                }
            });
            quote! { #(#fields_iter)* }
        }
        Fields::Unnamed(unnamed) => {
            let fields_iter = unnamed.unnamed.iter().enumerate().map(|(i, _f)| {
                let index = syn::Index::from(i);
                quote! {
                    println!("Tuple[{}]: {:?}", #i, &self.#index);
                }
            });
            quote! { #(#fields_iter)* }
        }
        Fields::Unit => {
            quote! { println!("Unit struct (no fields)."); }
        }
    };

    let expanded = quote! {
        impl #impl_generics InspectFields for #name #ty_generics #where_clause {
            fn inspect(&self) {
                #inspection_code
            }
        }
    };

    Ok(expanded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use syn::parse_quote;

    #[test]
    fn test_derive_named_fields() {
        let input: DeriveInput = parse_quote! {
            struct User<T> where T: Default {
                id: u32,
                payload: T,
            }
        };

        let result = expand_inspect_fields(input).unwrap();
        let code = result.to_string();
        assert!(code.contains("impl < T > InspectFields for User < T > where T : Default"));
        assert!(code.contains("id"));
        assert!(code.contains("payload"));
    }
}
```

## Anti-Pattern Terlarang

1. **Mengabaikan Generics dan Where Clause:**
   *Mengapa berbahaya:* Jika Anda menulis `impl Trait for #name` tanpa `#ty_generics` dan `#where_clause`, derive macro akan gagal kompilasi jika user menggunakan tipe generic (`struct Foo<T>`). **SELALU** panggil `split_for_impl()` dari struct generics.
2. **Tidak Menangani Tuple Struct (UnnamedFields):**
   *Mengapa berbahaya:* Banyak developer mengasumsikan struct selalu memiliki `.ident` di field-nya (NamedFields). Jika Anda melakukan `.unwrap()` pada `field.ident` saat menemui tuple struct, macro akan panic. Gunakan pola `syn::Index` (seperti 0, 1) untuk pengaksesan tuple.

## Edge Cases & Defensive Programming

- **Attributes di dalam Field:** User dapat meletakkan custom attribute (contoh: `#[inspect(skip)]`) di field. Anda harus mengakses iterasi `field.attrs` dan memparsing apakah identitas atribut cocok, lalu skip pemrosesan logik agar macro Anda dapat disesuaikan (customizable).
- **Keyword sebagai Identifier:** Di Rust `r#type` adalah keyword escaping valid. Ident (variabel) di AST `syn` secara otomatis merepresentasikan escape ini dengan tepat (tanpa `r#` internalnya). Jangan gunakan parsing string `.to_string()` secara kaku kecuali untuk pencetakan akhir, tetap kelola sebagai token/Ident saat generate.
