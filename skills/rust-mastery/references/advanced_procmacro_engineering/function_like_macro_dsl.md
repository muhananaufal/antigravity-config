# Function-like Macro DSL Parsing

Function-like procedural macro dipanggil mirip dengan `macro_rules!` reguler (misal: `sql!("SELECT * FROM table")`). Keunggulannya adalah ia mampu memparsing Domain Specific Language (DSL) sewenang-wenang (seperti syntax HTML, syntax SQL) melalui implementasi `syn::parse::Parse` secara custom.

## Arsitektur Parse Stream

```text
[ TokenStream ] => syn::parse::ParseStream
 |-> parse::<Ident>() -> token pertama (Identifier)
 |-> parse::<Token![,]>() -> token kedua (Koma)
 |-> lookahead1() -> Intip token selanjutnya tanpa konsumsi
```

## Implementasi Production-Ready

```rust
use proc_macro2::TokenStream;
use quote::quote;
use syn::parse::{Parse, ParseStream};
use syn::{Ident, LitInt, Result, Token};

/// Struktur AST DSL kita, contoh syntax:
/// `route GET "/home" => home_handler;`
pub struct RouteDsl {
    pub method: Ident,
    pub path: syn::LitStr,
    pub _arrow: Token![=>],
    pub handler: Ident,
}

impl Parse for RouteDsl {
    fn parse(input: ParseStream) -> Result<Self> {
        let _route_kw: Ident = input.parse()?; 
        // Anda bisa cek apakah _route_kw benar-benar string "route" di sini
        
        let method: Ident = input.parse()?;
        let path: syn::LitStr = input.parse()?;
        let _arrow: Token![=>] = input.parse()?;
        let handler: Ident = input.parse()?;

        // Memastikan tidak ada sisa token yang tidak ter-parse
        if !input.is_empty() {
            return Err(input.error("Diharapkan EOF setelah handler endpoint"));
        }

        Ok(RouteDsl {
            method,
            path,
            _arrow,
            handler,
        })
    }
}

pub fn expand_route_dsl(input: proc_macro2::TokenStream) -> Result<TokenStream> {
    let route: RouteDsl = syn::parse2(input)?;

    let method_str = route.method.to_string();
    let path_str = route.path.value();
    let handler = route.handler;

    // Generate Rust code pendaftaran handler yang valid
    Ok(quote! {
        Server::register(
            #method_str, 
            #path_str, 
            #handler
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use quote::quote;

    #[test]
    fn test_parse_route_dsl() {
        let input = quote! { route GET "/api" => my_handler };
        let result = expand_route_dsl(input).unwrap();
        
        let out_str = result.to_string();
        assert!(out_str.contains("Server :: register"));
        assert!(out_str.contains("\"GET\""));
        assert!(out_str.contains("\"/api\""));
        assert!(out_str.contains("my_handler"));
    }
}
```

## Anti-Pattern Terlarang

1. **Proc Macro Alih-alih Declarative (`macro_rules!`) saat Tidak Dibutuhkan:**
   *Mengapa berbahaya:* Pemanggilan file eksternal/Parsing sederhana yang bisa dikerjakan dengan `macro_rules!` menggunakan `$e:expr` atau `$i:ident`, tidak disarankan dibuat via proc macro. Waktu kompilasi (compile time) proc macro sangat lama karena harus mem-build `syn` dan `quote` di pre-build.
2. **Tidak Menggunakan `lookahead1` di Cabang Percabangan:**
   *Mengapa berbahaya:* Jika DSL Anda mensupport dua variant dan Anda melakukan `if input.peek(...)` kustom tanpa memanfaatkan mekanisme `Lookahead1`, bila user memasukkan syntax yang salah, pesan error tidak akan menjelaskan "expected X atau Y". `lookahead1().error()` memberikan feedback error yang presisi kepada developer pengguna.

## Edge Cases & Defensive Programming

- **Recursive Parsing (Grup):** Rust token direpresentasikan dalam bentuk Tree. Jika DSL Anda menerima `{ ... }`, Anda tidak bisa menggunakan stream biasa. Anda harus menggunakan sekumpulan macro parsing grup milik `syn` (contoh: `syn::group::parse_braces`). Token di dalam kurung kurawal memiliki stream mereka sendiri.
- **Handling Keywords:** `syn::Ident` me-reject Rust keywords (seperti `match`, `if`). Jika DSL Anda menggunakan ini, parsifikasi akan gagal. Anda harus mengizinkan keyword via parser khusus (contoh: memanggil `.call(Ident::parse_any)` jika Anda mengekstrak crate `ext` dari syn).
