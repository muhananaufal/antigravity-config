# Procedural Macros: Attribute & Derive Internals

## Deskripsi Konsep
Procedural macros (proc macros) di Rust bertindak sebagai fungsi meta-programming kompilasi (compiler plugins) yang menerima Abstract Syntax Tree (AST) berupa `TokenStream` sebagai input, mentransformasikannya, dan menghasilkan `TokenStream` baru sebagai output kode.

Ada tiga jenis proc macro:
1. **Function-like** (`foo!(...)`): Seperti deklarasi macro biasa, menggantikan kode di mana makro dipanggil.
2. **Derive** (`#[derive(CustomTrait)]`): Menganalisis *struct*, *enum*, atau *union* dan menambahkan kode *di samping* (mendampingi) deklarasi aslinya.
3. **Attribute** (`#[custom_attr]`): Membungkus seluruh deklarasi (struct, function, impl block) dan *menggantikannya* secara total dengan hasil stream.

Toolchain dominan dalam pengembangan ini meliputi:
- `proc-macro2`: Wrapper yang memampukan pengujian (testing) dan abstraksi tipe lintas batasan macro.
- `syn`: Parser tangguh yang mengubah stream token mentah menjadi struktur data AST (seperti `ItemFn`, `DeriveInput`).
- `quote`: Sistem templating macro (`quote! { ... }`) untuk mengubah struktur Rust kembali menjadi `TokenStream`.

Pemeliharaan **Span** sangat penting. *Span* adalah metadata yang melekat pada setiap token yang merepresentasikan lokasi baris/kolom pada file kode sumber asli. Mempertahankan atau menetapkan *Span* yang tepat akan memberikan pesan error (error reporting) compiler yang tepat jatuh di garis kode pengembang, bukan pada hasil generate macro.

## Diagram ASCII: Proc Macro Pipeline

```text
[ TokenStream Input ] (mentah dari rustc)
        │
        ▼ (syn::parse_macro_input!)
[ AST (Abstract Syntax Tree) ] (tipe data berstruktur tinggi)
        │
        ▼ (Manipulasi/Analisis di kode macro Rust)
[ Modifikasi AST / Generasi logika baru ]
        │
        ▼ (quote! { ... })
[ TokenStream Output ]
        │
        ▼ (kembali ke compiler)
[ Masuk ke proses resolusi dan kompilasi utama rustc ]
```

## Kode Rust Production-Ready

```rust
// Kode ini disimulasikan sebagai library khusus proc-macro 
// (membutuhkan di Cargo.toml: `proc-macro = true`, `syn`, `quote`, `proc-macro2`)

extern crate proc_macro;

use proc_macro::TokenStream;
// Disimulasikan: di dunia nyata, gunakan proc_macro2::TokenStream untuk testing
// dan sinkronisasi.

// use quote::quote;
// use syn::{parse_macro_input, DeriveInput, Error, Data, Fields};

/// Mengabaikan macro import untuk environment yang bukan crate "proc-macro".
/// #[proc_macro_derive(MyBuilder)]
pub fn derive_my_builder(input: TokenStream) -> TokenStream {
    /* 
    IMPLEMENTASI NYATA MENGGUNAKAN SYN & QUOTE:

    let input = parse_macro_input!(input as DeriveInput);
    let name = &input.ident;

    // Memastikan makro hanya berlaku untuk struct dengan named fields
    let fields = match &input.data {
        Data::Struct(data_struct) => match &data_struct.fields {
            Fields::Named(fields) => fields,
            _ => return Error::new_spanned(name, "Hanya berlaku untuk named fields")
                .to_compile_error()
                .into(),
        },
        _ => return Error::new_spanned(name, "MyBuilder hanya mendukung struct")
            .to_compile_error()
            .into(),
    };

    let builder_name = syn::Ident::new(&format!("{}Builder", name), name.span());

    // Membangkitkan list field yang dibungkus dengan Option<T>
    let optionized_fields = fields.named.iter().map(|f| {
        let name = &f.ident;
        let ty = &f.ty;
        quote! { #name: std::option::Option<#ty> }
    });

    let expanded = quote! {
        pub struct #builder_name {
            #(#optionized_fields,)*
        }
    };

    TokenStream::from(expanded)
    */
    
    // Kode dummy untuk lolos kompilasi tanpa dependensi penuh syn/quote dalam contoh
    input
}

/// Menangani pelaporan error idiomatic dengan syn::Error
pub fn report_error_example() -> proc_macro2::TokenStream {
    // Pada production, kita melaporkan kesalahan persis di lokasi deklarasi yang salah
    // let err = syn::Error::new(span_dari_token_salah, "Pesan error spesifik");
    // err.to_compile_error()
    
    proc_macro2::TokenStream::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_handling_stub() {
        let stream = report_error_example();
        assert!(stream.is_empty()); // Stubbed
    }
}
```

## Anti-Patterns

1. **Menghancurkan Informasi Span (*Span Erasure*)**
   - **Contoh Buruk**: Membuat *identifier* baru menggunakan `Ident::new("Var", Span::call_site())` secara membabi buta tanpa mengambil referensi dari span identifier aslinya.
   - **Mengapa berbahaya**: `Span::call_site()` merujuk ke lokasi di mana makro *dipanggil*. Jika ada *type mismatch* atau kesalahan lint di kode yang digenerate dari macro, *error linting* editor atau log error rustc akan menyorot keseluruhan anotasi makro `#[derive(MyMacro)]`, dan tidak memberi petunjuk spesifik atribut/field spesifik mana yang menyebabkan kesalahan.

2. **Panicking sebagai Pelaporan Error**
   - **Contoh Buruk**: Menggunakan `.unwrap()`, `panic!("Format salah")`, atau `expect()` saat proses parsing AST di makro.
   - **Mengapa berbahaya**: Ketika macro mengalami *panic*, proses kompilasi rustc akan terhenti seketika secara kasar. Pengembang tidak mendapatkan *nice compiler error* yang idiomatik di terminal IDE mereka. Gunakan `syn::Error::new_spanned(target_token, "Pesan")` dan kembalikan hasil metode `.to_compile_error()` ke dalam token stream.

## Edge Cases & Defensive Programming
- **Attribute Macros Destruktif**: *Attribute macros* me-*replace* total fungsi aslinya. Jika makro tersebut dipanggil di sebuah fungsi dokumentasi, dan anda tidak men-generate ulang (passing-through) token atribut `#[doc]`, maka dokumentasi (Rustdoc) fungsi aslinya akan hilang sama sekali. Defensif selalu re-emit token-token original atau atribut-atribut asli secara beruntun.
- **Higiene Macro (Macro Hygiene)**: Proc-macro saat ini (secara default) tidak 100% higienis untuk path eksternal. Jika macro membangkitkan pemanggilan fungsi `Vec::new()`, dan modul pemanggil memiliki struct lokal bernama `Vec`, kompilasi akan hancur. Selalu *fully-qualify* *paths* seperti `::std::vec::Vec::new()` di dalam macro `quote!`.
